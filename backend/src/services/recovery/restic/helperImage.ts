import type Docker from 'dockerode';
import DockerController from '../../DockerController';
import { errorMessageForLog } from '../../../utils/safeLog';

/**
 * Which recovery-helper image this build may start.
 *
 * Each Sencho image carries the digest of the helper built from the same commit
 * (`SENCHO_RECOVERY_HELPER_IMAGE`, set as an `ENV` in the main Dockerfile), and
 * that is the only reference the runtime accepts. A tag could be repointed at
 * different bytes after the pairing was sealed, so a tag is refused rather than
 * followed: the failure is `helper_unavailable`, never a silent upgrade of the
 * program that reads every volume.
 *
 * Two forms are pinned, and nothing else:
 *   - `repo@sha256:<64 hex>`, the normal registry digest;
 *   - `sha256:<64 hex>`, an image id, which is all `docker load` leaves on an
 *     air-gapped host (it drops RepoDigests).
 */

export const RECOVERY_HELPER_IMAGE_ENV = 'SENCHO_RECOVERY_HELPER_IMAGE';

/** Runs inside every helper container; the probe reports a mount root's identity. */
export const RECOVERY_HELPER_PROBE_PATH = '/sencho-recovery-probe';
/** restic inside the helper image. */
export const RECOVERY_HELPER_RESTIC_PATH = '/restic';

const DIGEST = '[0-9a-f]{64}';
const DIGEST_REFERENCE = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:${DIGEST}$`);
const IMAGE_ID = new RegExp(`^sha256:${DIGEST}$`);

export type HelperImageRef =
  | { kind: 'pinned'; ref: string }
  | { kind: 'unpinned'; reason: 'missing' | 'not_digest' };

/** Parse one candidate reference. A blank value reads as `missing`. */
export function parseHelperImageRef(raw: string | undefined | null): HelperImageRef {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '') return { kind: 'unpinned', reason: 'missing' };
  if (DIGEST_REFERENCE.test(value) || IMAGE_ID.test(value)) return { kind: 'pinned', ref: value };
  return { kind: 'unpinned', reason: 'not_digest' };
}

/** The reference this process would start, from the environment only. */
export function resolveHelperImageRef(env: NodeJS.ProcessEnv = process.env): HelperImageRef {
  return parseHelperImageRef(env[RECOVERY_HELPER_IMAGE_ENV]);
}

/** The identity Sencho compares against its own images, without a registry prefix. */
export function helperImageIdentity(ref: string): string {
  return ref;
}

export type HelperImageState =
  | { state: 'present'; ref: string }
  | { state: 'missing'; ref: string }
  | { state: 'unavailable'; reason: 'not_digest' | 'missing' };

/**
 * Inspect the image locally. This is a cheap daemon call and never pulls: a pull
 * is a provisioning step, so a descriptor read cannot start a download.
 */
export async function inspectHelperImage(
  docker: Pick<Docker, 'getImage'>,
  configured: HelperImageRef,
): Promise<HelperImageState> {
  if (configured.kind === 'unpinned') {
    return { state: 'unavailable', reason: configured.reason };
  }
  try {
    await docker.getImage(configured.ref).inspect();
    return { state: 'present', ref: configured.ref };
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 404) return { state: 'missing', ref: configured.ref };
    console.warn('[Recovery] Helper image inspect failed:', errorMessageForLog(err));
    return { state: 'missing', ref: configured.ref };
  }
}

/**
 * Pull the pinned helper. Only provisioning calls this; a read path never does.
 * The reference already carries a digest, so the daemon verifies the bytes it
 * receives against it.
 */
export async function pullHelperImage(docker: Docker, ref: string): Promise<void> {
  if (!DIGEST_REFERENCE.test(ref)) {
    // An image id that is already loaded cannot be pulled, and there is nothing
    // to pull it from: the caller's inspect said it was absent, so this is a
    // missing image on an air-gapped host.
    throw new Error('helper image is an image id and cannot be pulled');
  }
  await new Promise<void>((resolve, reject) => {
    docker.pull(ref, (err: Error | null, stream: NodeJS.ReadableStream | null) => {
      if (err || !stream) {
        reject(err ?? new Error('pull stream missing'));
        return;
      }
      docker.modem.followProgress(stream, (finishErr: Error | null) => {
        if (finishErr) reject(finishErr);
        else resolve();
      });
    });
  });
}

/** The Docker instance for a node, for callers that only have a node id. */
export function helperDocker(nodeId: number): Docker {
  return DockerController.getInstance(nodeId).getDocker();
}
