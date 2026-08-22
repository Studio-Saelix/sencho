import fs from 'fs/promises';
import path from 'path';
import { isPathWithinBase } from '../../utils/validation';
import { GENERATIONS_DIR, isRealPathAtManagedLocation, managedAreaBase } from './managedPaths';

export const CREATE_STAGING_MARKER_FILENAME = '.create-staging.v1.json';

const CANDIDATE_PREFIX = `${GENERATIONS_DIR}/candidate-`;

export type CreateStagingMarker = {
  schemaVersion: 1;
  operationId: string;
  /** True when the managed root already existed before this operation ran. */
  rootPreexisted: boolean;
  /** Never null: the candidate path is computed before any managed-root mutation. */
  candidateRelPath: string;
  /** Diagnostic only. Never deletion authority. */
  createdAt: number;
};

export type ReadStagingMarkerResult =
  | { state: 'valid'; marker: CreateStagingMarker }
  | { state: 'missing' }
  | { state: 'corrupt'; reason: string };

/**
 * The candidate directory this operation will stage, computed the same way the
 * manifest service computes it, before anything touches the managed root.
 *
 * Recording the path up front is what makes crash cleanup exact: a process that
 * dies part-way through building the candidate still left a marker naming the
 * one directory it owned.
 */
export function candidateRelPathForSha(commitSha: string): string {
  return `${CANDIDATE_PREFIX}${commitSha}`;
}

/**
 * The applied directory promotion will move this candidate into.
 *
 * Computed here rather than read from the manifest because the generation row
 * is written before promotion runs, and the manifest carries an empty applied
 * path until then. Storing that empty value would make "not promoted yet"
 * indistinguishable from "nothing to clean up" during teardown.
 *
 * Must stay in step with the promotion path in GitProjectManifestService.
 */
export function appliedRelPathFor(commitSha: string, manifestVersion: number): string {
  return `${GENERATIONS_DIR}/applied-${commitSha}-${manifestVersion}`;
}

function isSafeRelPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (path.isAbsolute(value)) return false;
  const segments = value.split(/[\\/]/);
  return !segments.some((seg) => seg === '..' || seg === '.' || seg === '');
}

/**
 * Validate a candidate path against the stack's own managed root.
 *
 * Every read re-runs this, not just the write, because the marker is a
 * filesystem artifact an operator or a bug could have rewritten between the
 * crash and the sweep. A path that fails any check makes the marker corrupt,
 * and a corrupt marker preserves the root rather than authorizing a delete.
 */
export function validateCandidateRelPath(candidateRelPath: unknown, stackManagedRoot: string): string | null {
  if (!isSafeRelPath(candidateRelPath)) return 'candidateRelPath is not a safe relative path';
  if (!candidateRelPath.startsWith(CANDIDATE_PREFIX)) {
    return `candidateRelPath must start with ${CANDIDATE_PREFIX}`;
  }
  const base = path.resolve(stackManagedRoot);
  const resolved = path.resolve(base, candidateRelPath);
  if (!isPathWithinBase(resolved, base)) return 'candidateRelPath escapes the managed root';
  return null;
}

/** Test-only. Production call sites resolve this path inline at their own sink. */
export function stagingMarkerPath(stackManagedRoot: string): string {
  return path.join(stackManagedRoot, CREATE_STAGING_MARKER_FILENAME);
}

export async function readStagingMarker(stackManagedRoot: string): Promise<ReadStagingMarkerResult> {
  // Inline containment barrier at the read sink (see `managedAreaBase`). A root
  // outside the managed area is treated as corrupt rather than thrown, matching
  // this module's rule that an unreadable claim preserves rather than deletes.
  const areaBase = managedAreaBase();
  const markerPath = path.resolve(stackManagedRoot, CREATE_STAGING_MARKER_FILENAME);
  if (!markerPath.startsWith(areaBase + path.sep)) {
    return { state: 'corrupt', reason: 'managed root escapes the managed area' };
  }
  let raw: string;
  try {
    raw = await fs.readFile(markerPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' };
    return { state: 'corrupt', reason: (error as Error).message };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: 'corrupt', reason: 'marker is not valid JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { state: 'corrupt', reason: 'marker is not an object' };
  }
  const marker = parsed as Record<string, unknown>;
  if (marker.schemaVersion !== 1) return { state: 'corrupt', reason: 'unsupported marker schemaVersion' };
  if (typeof marker.operationId !== 'string' || marker.operationId.length === 0) {
    return { state: 'corrupt', reason: 'marker operationId is missing' };
  }
  if (typeof marker.rootPreexisted !== 'boolean') {
    return { state: 'corrupt', reason: 'marker rootPreexisted is missing' };
  }
  const pathReason = validateCandidateRelPath(marker.candidateRelPath, stackManagedRoot);
  if (pathReason) return { state: 'corrupt', reason: pathReason };
  const createdAt = typeof marker.createdAt === 'number' && Number.isFinite(marker.createdAt)
    ? marker.createdAt
    : 0;
  return {
    state: 'valid',
    marker: {
      schemaVersion: 1,
      operationId: marker.operationId,
      rootPreexisted: marker.rootPreexisted,
      candidateRelPath: marker.candidateRelPath as string,
      createdAt,
    },
  };
}

export class CreateStagingMarkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreateStagingMarkerError';
  }
}

/**
 * Write the marker atomically, refusing to trample another operation's.
 *
 * A live marker for a different operation means a concurrent or abandoned
 * create still owns this managed root. Overwriting it would hand our operation
 * id deletion authority over their staged directory, so we refuse instead.
 */
export async function writeStagingMarker(
  stackManagedRoot: string,
  marker: CreateStagingMarker,
): Promise<void> {
  const reason = validateCandidateRelPath(marker.candidateRelPath, stackManagedRoot);
  if (reason) throw new CreateStagingMarkerError(reason);

  const existing = await readStagingMarker(stackManagedRoot);
  // A marker that exists but cannot be read is still a claim. Overwriting it
  // would hand this operation deletion authority over whatever the last one
  // staged, which is the opposite of what the rest of this module does with a
  // corrupt marker, and it would do so with nothing said about why.
  if (existing.state === 'corrupt') {
    throw new CreateStagingMarkerError(
      `this managed area has an unreadable staging marker (${existing.reason}); refusing to claim it`,
    );
  }
  if (existing.state === 'valid' && existing.marker.operationId !== marker.operationId) {
    throw new CreateStagingMarkerError(
      'another create operation already owns this managed area',
    );
  }

  // Inline containment barrier at each write sink (see `managedAreaBase`).
  const areaBase = managedAreaBase();
  const root = path.resolve(stackManagedRoot);
  const target = path.resolve(stackManagedRoot, CREATE_STAGING_MARKER_FILENAME);
  const temp = path.resolve(stackManagedRoot, `${CREATE_STAGING_MARKER_FILENAME}.${marker.operationId}.tmp`);
  if (
    !root.startsWith(areaBase + path.sep)
    || !target.startsWith(areaBase + path.sep)
    || !temp.startsWith(areaBase + path.sep)
    // Checked on the write and not only on the delete, so a link cannot be
    // written through and then refused by the hardened delete below. That
    // asymmetry would wedge the stack name: a valid marker naming another
    // operation refuses every later create, and nothing could remove it.
    || !await isRealPathAtManagedLocation(root)
  ) {
    throw new CreateStagingMarkerError('managed root links outside its managed location');
  }

  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(temp, JSON.stringify(marker), 'utf8');
  await fs.rename(temp, target);
}

export async function deleteStagingMarker(stackManagedRoot: string): Promise<void> {
  // Inline containment barrier at the removal sink (see `managedAreaBase`).
  const areaBase = managedAreaBase();
  const markerPath = path.resolve(stackManagedRoot, CREATE_STAGING_MARKER_FILENAME);
  if (!markerPath.startsWith(areaBase + path.sep) || !await isRealPathAtManagedLocation(markerPath)) {
    throw new CreateStagingMarkerError('managed root links outside its managed location');
  }
  await fs.rm(markerPath, { force: true });
}
