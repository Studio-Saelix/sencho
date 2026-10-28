import fs from 'fs/promises';

/** The application uid/gid that should own helper-written handoff files. */
export interface HandoffOwner {
  uid: number;
  gid: number;
}

/** fs calls used to write a handoff file, injectable for tests. */
export interface HandoffFileSystem {
  writeFile(path: string, data: string, options: { mode: number }): Promise<void>;
  chown(path: string, uid: number, gid: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

/**
 * The owner to assign to a helper-written handoff file, or null when the
 * helper is not privileged or the application did not pass a usable uid/gid.
 *
 * The replacement helper runs as root even when Sencho itself runs as
 * `SENCHO_USER`. A root-owned `0600` phase marker or outcome cannot be read by
 * the application, so those files are handed to the application uid while
 * keeping mode `0600`: the rollback snapshot stays private to that user.
 */
export function handoffOwner(env: NodeJS.ProcessEnv, helperUid: number | null | undefined): HandoffOwner | null {
  if (helperUid !== 0) return null;
  const uid = parseOwnerId(env.SENCHO_HANDOFF_UID);
  const gid = parseOwnerId(env.SENCHO_HANDOFF_GID);
  if (uid === null || gid === null) return null;
  return { uid, gid };
}

function parseOwnerId(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Writes one handoff JSON file atomically with owner-only permissions. When an
 * owner is set the temporary file is chowned before the rename, so a reader
 * with the application uid never sees a root-owned final file it cannot open.
 */
export async function writeHandoffJson(
  filePath: string,
  value: unknown,
  owner: HandoffOwner | null,
  ops: HandoffFileSystem = fs,
): Promise<void> {
  const temporary = `${filePath}.${process.pid}.tmp`;
  await ops.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  if (owner) await ops.chown(temporary, owner.uid, owner.gid);
  await ops.rename(temporary, filePath);
}
