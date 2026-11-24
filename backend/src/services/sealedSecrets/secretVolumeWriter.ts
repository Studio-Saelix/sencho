import { Writable } from 'stream';
import type Docker from 'dockerode';

import { SECRET_VOLUME_LABEL } from '../../helpers/secretVolume';
import { getErrorMessage } from '../../utils/errors';
import { sanitizeForLog } from '../../utils/safeLog';
import { SealedSecretError } from './errors';
import type { SealedSecretPurpose } from './purposes';

/** Same image the volume browser helper uses, so a node pulls nothing new. */
export const SECRET_WRITER_IMAGE = 'alpine:3.20';
const MOUNT = '/v';
const TIMEOUT_MS = 30_000;
/** Label value that marks a writer container, so a leftover one can be found and removed. */
export const SECRET_WRITER_HELPER = 'secret-writer';
const HELPER_LABEL = 'io.sencho.helper';

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

/** The volume a writer run mounts, and the purpose its label names. */
export interface SecretWriterVolume {
  name: string;
  purposeId: string;
}

/** Container options for one writer run. Exported for the test that pins the profile. */
export function buildWriterCreateOptions(
  volume: SecretWriterVolume,
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
    Labels: { [HELPER_LABEL]: SECRET_WRITER_HELPER },
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
      // Docker creates a missing named volume when the container is created. The
      // label makes such a volume the store's own, never an unlabelled
      // look-alike the store would then refuse as foreign.
      Mounts: [{
        Type: 'volume',
        Source: volume.name,
        Target: MOUNT,
        ReadOnly: false,
        VolumeOptions: {
          NoCopy: false,
          Labels: { [SECRET_VOLUME_LABEL]: volume.purposeId },
          DriverConfig: { Name: 'local', Options: {} },
        },
      }],
    },
  };
}

function exitMessage(code: number): string {
  if (code === 3) return 'the secret was empty';
  if (code === 4) return 'the secret is larger than this purpose allows';
  return `the helper container exited with status ${code}`;
}

/**
 * Remove writer containers a crashed or killed run left behind on this volume.
 * Each run removes its own container when it ends, so any writer found here
 * belongs to a run that no longer exists. Left in place, it would count as a
 * container that mounts the volume, and starting it again would replay its
 * write or removal.
 */
export async function removeLeftoverWriters(docker: Docker, volumeName: string): Promise<void> {
  let leftovers: Docker.ContainerInfo[];
  try {
    leftovers = await docker.listContainers({
      all: true,
      filters: { label: [`${HELPER_LABEL}=${SECRET_WRITER_HELPER}`], volume: [volumeName] },
    });
  } catch (error: unknown) {
    console.error('[SealedSecrets] Writer sweep failed:', sanitizeForLog(getErrorMessage(error, 'unknown')));
    throw unavailable('the node could not list its helper containers');
  }
  for (const leftover of leftovers) {
    try {
      await docker.getContainer(leftover.Id).remove({ force: true });
    } catch (error: unknown) {
      console.error('[SealedSecrets] Leftover writer removal failed:', sanitizeForLog(getErrorMessage(error, 'unknown')));
      throw unavailable('a helper container from an earlier run could not be removed');
    }
  }
}

/**
 * Write or remove the purpose's secret file in its volume with a short-lived,
 * locked-down helper container: uid 0 with only CHOWN and FOWNER, no network,
 * read-only root, logs off. The secret is fed on stdin and never placed in
 * argv, env, a label or a log line.
 */
export async function runSecretWriter(
  docker: Docker,
  volume: SecretWriterVolume,
  purpose: SealedSecretPurpose,
  op: SecretWriterOp,
): Promise<void> {
  await removeLeftoverWriters(docker, volume.name);
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
    // A socket error (the helper exited before reading stdin, or the daemon
    // connection reset) fails this run instead of escaping as an uncaught error.
    const ended = new Promise<void>((resolve, reject) => {
      stream.once('end', () => resolve());
      stream.once('close', () => resolve());
      // `on`, not `once`: writing to a stream that already failed raises a second error.
      stream.on('error', (error: Error) => reject(error));
    });
    ended.catch(() => undefined);
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
  // When the timeout wins, `run` may still reject later; that outcome is moot.
  run.catch(() => undefined);

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
