import { Writable } from 'stream';
import type Docker from 'dockerode';

import { getErrorMessage } from '../../utils/errors';
import { sanitizeForLog } from '../../utils/safeLog';
import { SealedSecretError } from './errors';
import type { SealedSecretPurpose } from './purposes';

/** Same image the volume browser helper uses, so a node pulls nothing new. */
export const SECRET_WRITER_IMAGE = 'alpine:3.20';
const MOUNT = '/v';
const TIMEOUT_MS = 30_000;

/**
 * The writer script. The secret arrives on stdin only. The volume root is reset
 * to root:root 0755 so the consuming user can traverse it and nothing else can
 * write there. A write lands in a temporary file that gets its owner and mode
 * before it is renamed over the live file, so a crash leaves the old secret or
 * none, never a truncated one. Exit codes: 3 empty, 4 too large.
 */
const WRITER_SCRIPT = `set -eu
op="$1"; file="$2"; uid="$3"; gid="$4"; mode="$5"; max="$6"
chown 0:0 ${MOUNT}
chmod 0755 ${MOUNT}
tmp="${MOUNT}/.$file.tmp"
rm -f "$tmp"
if [ "$op" = "remove" ]; then
  rm -f "${MOUNT}/$file"
  sync
  exit 0
fi
umask 077
head -c $((max + 1)) > "$tmp"
size=$(wc -c < "$tmp")
if [ "$size" -eq 0 ]; then rm -f "$tmp"; exit 3; fi
if [ "$size" -gt "$max" ]; then rm -f "$tmp"; exit 4; fi
chown "$uid:$gid" "$tmp"
chmod "$mode" "$tmp"
sync
mv -f "$tmp" "${MOUNT}/$file"
sync`;

export type SecretWriterOp = { kind: 'write'; secret: string } | { kind: 'remove' };

function unavailable(reason: string): SealedSecretError {
  return new SealedSecretError(
    'SECRET_STORE_UNAVAILABLE',
    503,
    `The node could not update its secret store: ${reason}. Retry once the node can run its helper container.`,
  );
}

async function ensureImage(docker: Docker): Promise<void> {
  try {
    await docker.getImage(SECRET_WRITER_IMAGE).inspect();
    return;
  } catch (error: unknown) {
    console.warn('[SealedSecrets] Writer image missing, pulling:', sanitizeForLog(getErrorMessage(error, 'unknown')));
  }
  try {
    await new Promise<void>((resolve, reject) => {
      docker.pull(SECRET_WRITER_IMAGE, (err: Error | null, stream: NodeJS.ReadableStream | null) => {
        if (err || !stream) { reject(err ?? new Error('pull stream missing')); return; }
        docker.modem.followProgress(stream, (finishErr: Error | null) => {
          if (finishErr) reject(finishErr); else resolve();
        });
      });
    });
  } catch (error: unknown) {
    console.error('[SealedSecrets] Writer image pull failed:', sanitizeForLog(getErrorMessage(error, 'unknown')));
    throw unavailable(`the helper image ${SECRET_WRITER_IMAGE} is not present and could not be pulled`);
  }
}

/** Container options for one writer run. Exported for the test that pins the profile. */
export function buildWriterCreateOptions(
  volume: string,
  purpose: SealedSecretPurpose,
  op: SecretWriterOp,
): Docker.ContainerCreateOptions {
  const wantStdin = op.kind === 'write';
  return {
    Image: SECRET_WRITER_IMAGE,
    Cmd: [
      'sh', '-c', WRITER_SCRIPT, 'sh',
      op.kind,
      purpose.file,
      String(purpose.ownerUid),
      String(purpose.ownerGid),
      purpose.mode.toString(8).padStart(4, '0'),
      String(purpose.maxSecretBytes),
    ],
    Tty: false,
    User: '0:0',
    WorkingDir: MOUNT,
    AttachStdout: true,
    AttachStderr: true,
    AttachStdin: wantStdin,
    OpenStdin: wantStdin,
    StdinOnce: wantStdin,
    Labels: { 'io.sencho.helper': 'secret-writer' },
    HostConfig: {
      ReadonlyRootfs: true,
      NetworkMode: 'none',
      CapDrop: ['ALL'],
      CapAdd: ['CHOWN', 'FOWNER'],
      Privileged: false,
      SecurityOpt: ['no-new-privileges:true'],
      PidsLimit: 16,
      Memory: 128 * 1024 * 1024,
      LogConfig: { Type: 'none', Config: {} },
      Mounts: [{ Type: 'volume', Source: volume, Target: MOUNT, ReadOnly: false }],
    },
  };
}

function exitMessage(code: number): string {
  if (code === 3) return 'the secret was empty';
  if (code === 4) return 'the secret is larger than this purpose allows';
  return `the helper container exited with status ${code}`;
}

/**
 * Write or remove the purpose's secret file in its volume with a short-lived,
 * locked-down helper container: uid 0 with only CHOWN and FOWNER, no network,
 * read-only root, logs off. The secret is fed on stdin and never placed in
 * argv, env, a label or a log line.
 */
export async function runSecretWriter(
  docker: Docker,
  volume: string,
  purpose: SealedSecretPurpose,
  op: SecretWriterOp,
): Promise<void> {
  await ensureImage(docker);
  const stderrChunks: Buffer[] = [];
  const sink = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  const stderr = new Writable({ write(chunk, _enc, cb) { stderrChunks.push(chunk); cb(); } });

  let container: Docker.Container;
  try {
    container = await docker.createContainer(buildWriterCreateOptions(volume, purpose, op));
  } catch (error: unknown) {
    console.error('[SealedSecrets] Writer create failed:', sanitizeForLog(getErrorMessage(error, 'unknown')));
    throw unavailable('the helper container could not be created');
  }

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(unavailable('the helper container timed out')), TIMEOUT_MS);
  });

  const run = (async (): Promise<number> => {
    const wantStdin = op.kind === 'write';
    const stream = await container.attach({ stream: true, stdin: wantStdin, stdout: true, stderr: true, hijack: wantStdin });
    const ended = new Promise<void>((resolve) => {
      stream.once('end', () => resolve());
      stream.once('close', () => resolve());
    });
    docker.modem.demuxStream(stream, sink, stderr);
    await container.start();
    if (op.kind === 'write') {
      stream.write(Buffer.from(op.secret, 'utf8'));
      stream.end();
    }
    const exit = await container.wait() as { StatusCode?: number };
    await ended;
    return typeof exit?.StatusCode === 'number' ? exit.StatusCode : 1;
  })();

  try {
    const code = await Promise.race([run, timeout]);
    if (code !== 0) {
      // stderr comes from the script and holds no secret (it never echoes stdin).
      console.error('[SealedSecrets] Writer failed:', code, sanitizeForLog(Buffer.concat(stderrChunks).toString('utf8').slice(0, 500)));
      if (code === 3 || code === 4) {
        throw new SealedSecretError('SEALED_SECRET_REQUEST_INVALID', 400, `The node refused the secret: ${exitMessage(code)}.`);
      }
      throw unavailable(exitMessage(code));
    }
  } catch (error: unknown) {
    if (error instanceof SealedSecretError) throw error;
    console.error('[SealedSecrets] Writer run failed:', sanitizeForLog(getErrorMessage(error, 'unknown')));
    throw unavailable('the helper container did not finish');
  } finally {
    if (timer) clearTimeout(timer);
    try {
      await container.remove({ force: true });
    } catch (error: unknown) {
      console.warn('[SealedSecrets] Writer cleanup failed:', sanitizeForLog(getErrorMessage(error, 'unknown')));
    }
  }
}
