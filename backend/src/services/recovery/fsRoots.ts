import path from 'path';
import { promises as fsPromises } from 'fs';
import type Docker from 'dockerode';
import DockerController from '../DockerController';
import { FileSystemService } from '../FileSystemService';
import SelfIdentityService from '../SelfIdentityService';
import {
  StackFileRootsService,
  isDangerousHostPath,
  type FsRootDeclaration,
  type FsRootListing,
  type RootMount,
} from '../StackFileRootsService';
import { resolveHostBindPath, type BindPathMapping } from '../../utils/composePathMapping';
import { errorMessageForLog, sanitizeForLog } from '../../utils/safeLog';
import { ProvenHostRoot, UnprovenHostPath } from './hostRoots';
import { recoveryDb } from './recoveryDb';
import { RecoveryError } from './redaction';
import { RECOVERY_HELPER_PROBE_PATH } from './restic/helperImage';
import { HELPER_SOURCE_MOUNT, type RecoveryHelperRunner } from './restic/helperRunner';
import { StorageIdentityStore } from './storageIdentity';
import { parseFsTargetPaths } from './fsTargets';
import type { DependentResolution, InUseObservation } from './volumeSources';
import type { PointExclusion, StorageDependent } from './types';

/**
 * Host directories as recovery storage: a stack's bind sources and its own
 * source directory.
 *
 * Nothing here takes a path from a caller. The only source of candidate roots is
 * `StackFileRootsService`, the same derivation the Files & Volumes explorer uses,
 * and a route names a root by the id that service minted.
 *
 * Two namespaces matter. `senchoPath` is the directory as Sencho sees it.
 * `hostPath` is the path the Docker daemon resolves when a helper binds it.
 * They differ when Sencho runs in a container whose mounts are not 1:1, which is
 * common for a Pilot agent, so the translation is never trusted on its own: a
 * helper binds `hostPath` and reports its device and inode, and only when they
 * equal Sencho's own `stat` of `senchoPath` is the root proven. Every helper run
 * that then reads or writes the root starts through the probe's guard, which
 * checks the same identity inside that container.
 */

export type FsRootRole = 'stack_source' | 'bind';

/** Why a directory a stack declares cannot hold points. Listed, never omitted. */
export type FsRootIneligibleReason =
  /** Sencho cannot reach the path (not bound into its container, or absent). */
  | 'host_path_unreachable'
  /** An OS directory, the host root, or the Docker socket. */
  | 'protected_host_path'
  /** Overlaps the compose base, the data directory, the application or the temporary credential files. */
  | 'sencho_managed_path'
  /** The bind names a single file. */
  | 'not_a_directory'
  /** No mount of Sencho's own container covers the path, so the daemon's path for it is unknown. */
  | 'path_mapping_unknown'
  /** Inside Docker's data root, which holds named volumes and the recovery repository. */
  | 'docker_data_path'
  /** The stack directory resolves outside the compose base (a symlink out of it). */
  | 'outside_compose_base';

/** Declared source strings that differ from the host path and are probed, at most. */
export const MAX_DECLARED_ALIASES = 16;
/** Mount points below a root the probe reports at most (`maxReportedMounts` in the probe). */
export const MAX_NESTED_MOUNTS = 64;

/** A derived root. Never built from client input. */
export interface FsRootCandidate {
  stackName: string;
  rootId: string;
  role: FsRootRole;
  label: string;
  /** The directory as Sencho sees it. */
  senchoPath: string;
  /** The daemon's path for it, a textual translation that the proof still has to confirm. Null when unknown. */
  hostPath: string | null;
  /** Declared source strings that differ from `hostPath`, each probed at capture. */
  aliases: string[];
  /** True when at least one declaration may write the directory. */
  writable: boolean;
  mounts: RootMount[];
  ineligibleReason: FsRootIneligibleReason | null;
  /** Sencho's own mounts could not be read just now, so the mapping is unknown until they can (retryable). */
  mappingUnreadable: boolean;
}

/** One stack's candidates, with how its model was read. */
export interface FsRootCandidates {
  outcome: FsRootListing['outcome'];
  candidates: FsRootCandidate[];
}

export { fsTargetKey, isFsTargetKey, parseFsTargetPaths, type FsTargetPaths } from './fsTargets';

// --- Namespace translation ---------------------------------------------------

/**
 * Sencho's own bind mounts: `null` when Sencho is not in a container (both
 * namespaces are one), the list otherwise. Throws `identity_unknown` when Sencho
 * is containerized and its mounts cannot be read now.
 */
export type OwnMounts = ReadonlyArray<BindPathMapping> | null;

export async function readOwnMounts(): Promise<OwnMounts> {
  try {
    return await SelfIdentityService.getInstance().getBindMounts();
  } catch (err) {
    console.warn('[Recovery] Could not read Sencho\'s own mounts:', errorMessageForLog(err));
    throw new RecoveryError('identity_unknown', {
      reason: 'path_mapping_unproven',
      detail: 'Sencho could not read its own container mounts, so it cannot tell which host path holds this directory. Try again shortly.',
    });
  }
}

/** The daemon's path for a directory Sencho sees, or null when no own mount covers it. */
export function senchoToHostPath(senchoPath: string, mounts: OwnMounts): string | null {
  if (mounts === null) return normalizeAbsolute(senchoPath);
  const translated = resolveHostBindPath(senchoPath, mounts);
  return translated === null ? null : normalizeAbsolute(translated);
}

/** Sencho's path for a host path, the inverse of the translation, or null when no own mount covers it. */
export function hostToSenchoPath(hostPath: string, mounts: OwnMounts): string | null {
  if (mounts === null) return normalizeAbsolute(hostPath);
  const inverse = mounts.map((mount) => ({ source: mount.destination, destination: mount.source }));
  const translated = resolveHostBindPath(hostPath, inverse);
  return translated === null ? null : normalizeAbsolute(translated);
}

/** POSIX-normalized absolute path without a trailing slash, or null for anything else. */
export function normalizeAbsolute(value: string): string | null {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0')) return null;
  const normalized = path.posix.normalize(value);
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

// --- Path relations ----------------------------------------------------------

export type PathRelation = 'equal' | 'inside' | 'ancestor' | 'unrelated';

/** How `candidate` sits relative to `root`, lexically, after normalization. */
export function relatePath(candidate: string, root: string): PathRelation {
  const a = normalizeAbsolute(candidate);
  const b = normalizeAbsolute(root);
  if (a === null || b === null) return 'unrelated';
  if (a === b) return 'equal';
  if (b === '/' || a.startsWith(`${b}/`)) return 'inside';
  if (a === '/' || b.startsWith(`${a}/`)) return 'ancestor';
  return 'unrelated';
}

/**
 * The dependency rule. A declaration or mount of a path equal to or inside the
 * root holds the root's data, whatever its mode; an ancestor holds it only when
 * it can write it. A read-only ancestor (a monitoring agent that binds `/`) is an
 * observer: it is shown, never fenced, and never part of the access check.
 */
export function dependsOnRoot(relation: PathRelation, writable: boolean): boolean {
  return relation === 'equal' || relation === 'inside' || (relation === 'ancestor' && writable);
}

/** True when two host paths overlap (equal, or one inside the other). */
export function pathsOverlap(a: string, b: string): boolean {
  return relatePath(a, b) !== 'unrelated';
}

// --- Candidates ---------------------------------------------------------------

/** Docker's data root, or null when the daemon does not say. */
export async function dockerDataRoot(docker: Pick<Docker, 'info'>): Promise<string | null> {
  try {
    const info = await docker.info() as { DockerRootDir?: unknown };
    return typeof info?.DockerRootDir === 'string' ? normalizeAbsolute(info.DockerRootDir) : null;
  } catch (err) {
    console.warn('[Recovery] Could not read Docker\'s data root:', errorMessageForLog(err));
    return null;
  }
}

/** The eligibility a declaration has before translation. */
function declarationReason(root: FsRootDeclaration): FsRootIneligibleReason | null {
  if (!root.accessible) return 'host_path_unreachable';
  if (root.managedSourceOverlap) return 'sencho_managed_path';
  if (root.dangerous) return 'protected_host_path';
  if (!root.isDirectory) return 'not_a_directory';
  return null;
}

async function canonicalOrSelf(target: string): Promise<string> {
  try {
    return await fsPromises.realpath(target);
  } catch {
    // An unreachable path keeps its lexical form; the declaration's own
    // accessibility verdict already says it cannot be read.
    return path.resolve(target);
  }
}

/**
 * Turn one stack's declarations into candidates: the explorer's verdicts, the
 * stack source guards, the translation to the daemon's namespace and the
 * host-side guards. `ownMounts` and `dockerRoot` are read once per request by
 * the caller and passed in.
 */
export async function candidatesFromListing(input: {
  stackName: string;
  listing: FsRootListing;
  composeBaseDir: string;
  ownMounts: OwnMounts | 'unreadable';
  dockerRoot: string | null;
}): Promise<FsRootCandidate[]> {
  const composeBase = await canonicalOrSelf(input.composeBaseDir);
  const candidates: FsRootCandidate[] = [];
  for (const root of input.listing.roots) {
    let reason = declarationReason(root);
    if (root.role === 'stack_source' && reason === null) {
      // The stack source root is synthetic in the explorer, so its guards are
      // applied here: it must stay strictly inside the compose base once
      // symlinks are resolved.
      const inside = relatePath(root.senchoPath, composeBase) === 'inside';
      if (!inside) reason = 'outside_compose_base';
    }
    let hostPath: string | null = null;
    let mappingUnreadable = false;
    if (input.ownMounts === 'unreadable') {
      mappingUnreadable = true;
    } else {
      hostPath = senchoToHostPath(root.senchoPath, input.ownMounts);
      if (hostPath === null && reason === null) reason = 'path_mapping_unknown';
    }
    if (hostPath !== null && reason === null) {
      if (hostPath === '/' || isDangerousHostPath(hostPath)) reason = 'protected_host_path';
      else if (input.dockerRoot && pathsOverlap(hostPath, input.dockerRoot)) reason = 'docker_data_path';
    }
    const aliases = root.declaredSources
      .map((declared) => normalizeAbsolute(declared))
      .filter((declared): declared is string => declared !== null && declared !== hostPath);
    candidates.push({
      stackName: input.stackName,
      rootId: root.rootId,
      role: root.role,
      label: root.label,
      senchoPath: root.senchoPath,
      hostPath,
      aliases: [...new Set(aliases)].sort(),
      writable: root.role === 'stack_source' ? true : !root.readonly,
      mounts: root.mounts,
      ineligibleReason: reason,
      mappingUnreadable,
    });
  }
  return candidates;
}

/** Everything a request needs to derive candidates, read once. */
export interface FsRootEnvironment {
  composeBaseDir: string;
  ownMounts: OwnMounts | 'unreadable';
  dockerRoot: string | null;
}

export async function readFsRootEnvironment(nodeId: number, docker: Pick<Docker, 'info'>): Promise<FsRootEnvironment> {
  let ownMounts: OwnMounts | 'unreadable';
  try {
    ownMounts = await readOwnMounts();
  } catch {
    ownMounts = 'unreadable';
  }
  return {
    composeBaseDir: FileSystemService.getInstance(nodeId).getBaseDir(),
    ownMounts,
    dockerRoot: await dockerDataRoot(docker),
  };
}

/** One stack's candidates. `fresh` bypasses the roots cache, for a caller about to change data. */
export async function listStackFsRootCandidates(input: {
  nodeId: number;
  stackName: string;
  fresh: boolean;
  environment: FsRootEnvironment;
}): Promise<FsRootCandidates> {
  const listing = await StackFileRootsService.getInstance(input.nodeId).listFsRoots(input.stackName, { fresh: input.fresh });
  const candidates = await candidatesFromListing({
    stackName: input.stackName,
    listing,
    composeBaseDir: input.environment.composeBaseDir,
    ownMounts: input.environment.ownMounts,
    dockerRoot: input.environment.dockerRoot,
  });
  return { outcome: listing.outcome, candidates };
}

// --- The identity proof -------------------------------------------------------

/** What the probe reports about a host directory, with exact identity strings. */
export interface FsProbeReport {
  dev: string;
  ino: string;
  /** `<seconds>.<nanoseconds>`, or null when the filesystem reports no birth time. */
  btime: string | null;
  free: number | null;
  /** Mount points strictly below the root, relative to it; null unless asked for. */
  mounts: string[] | null;
  mountsTruncated: boolean;
}

const DECIMAL = /^[0-9]+$/;
const BIRTH_TIME = /^[0-9]+\.[0-9]{9}$/;

/** Parse the probe's line for a host directory. Anything else is not a report. */
export function parseFsProbeReport(line: string): FsProbeReport | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not one JSON object: not a report.
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.dev_s !== 'string' || !DECIMAL.test(record.dev_s)) return null;
  if (typeof record.ino_s !== 'string' || !DECIMAL.test(record.ino_s)) return null;
  const btime = record.btime;
  if (btime !== undefined && (typeof btime !== 'string' || !BIRTH_TIME.test(btime))) return null;
  const free = record.free;
  const mounts = record.mounts;
  if (mounts !== undefined && (!Array.isArray(mounts) || mounts.some((m) => typeof m !== 'string'))) return null;
  return {
    dev: record.dev_s,
    ino: record.ino_s,
    btime: typeof btime === 'string' ? btime : null,
    free: typeof free === 'number' && Number.isSafeInteger(free) && free >= 0 ? free : null,
    mounts: Array.isArray(mounts) ? (mounts as string[]) : null,
    mountsTruncated: record.mounts_truncated === true,
  };
}

/** The probe's `{"error": ...}` line, for the log only. */
function probeErrorOf(line: string | undefined): string | null {
  if (!line) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    const message = parsed && typeof parsed === 'object' ? (parsed as { error?: unknown }).error : undefined;
    return typeof message === 'string' ? message : null;
  } catch {
    return null;
  }
}

const MAPPING_UNPROVEN_DETAIL =
  'Sencho could not prove that the host path the Docker daemon uses is the directory this stack declares, so nothing was recorded.';

function mappingUnproven(cause?: string): RecoveryError {
  const error = new RecoveryError('identity_unknown', { reason: 'path_mapping_unproven', detail: MAPPING_UNPROVEN_DETAIL });
  if (cause) error.cause = new Error(cause);
  return error;
}

/** Run the probe against one host path and read its report. */
async function probeHostPath(input: {
  runner: RecoveryHelperRunner;
  operationId: string;
  source: UnprovenHostPath | ProvenHostRoot;
  mounts?: boolean;
  signal?: AbortSignal;
}): Promise<FsProbeReport> {
  const lines: string[] = [];
  let result;
  try {
    result = await input.runner.run({
      profile: 'probe',
      operationId: input.operationId,
      cmd: input.mounts
        ? [RECOVERY_HELPER_PROBE_PATH, HELPER_SOURCE_MOUNT, '--mounts']
        : [RECOVERY_HELPER_PROBE_PATH, HELPER_SOURCE_MOUNT],
      mounts: { source: input.source, recursiveSource: input.mounts === true },
      signal: input.signal,
      onStdoutLine: (line) => {
        if (lines.length === 0) lines.push(line);
      },
    });
  } catch (err) {
    // A missing helper image or a socket proxy that refuses the call is the
    // node's capability; anything else (a bind source the daemon refuses, for
    // one) leaves the mapping unproven.
    if (err instanceof RecoveryError && err.errorClass === 'capability_unavailable') throw err;
    throw mappingUnproven(errorMessageForLog(err));
  }
  if (result.guardRefused) throw mappingUnproven('the guard refused the root');
  if (result.exitCode !== 0) throw mappingUnproven(probeErrorOf(lines[0]) ?? `probe exit ${String(result.exitCode)}`);
  const report = parseFsProbeReport(lines[0] ?? '');
  if (!report) throw mappingUnproven('the probe answered without a report');
  return report;
}

/** Sencho's own view of a directory: its device and inode as exact strings. */
export async function statSenchoView(senchoPath: string): Promise<{ dev: string; ino: string }> {
  let stat;
  try {
    stat = await fsPromises.stat(senchoPath, { bigint: true });
  } catch (err) {
    throw mappingUnproven(`stat failed: ${(err as NodeJS.ErrnoException).code ?? 'unknown'}`);
  }
  if (!stat.isDirectory()) throw mappingUnproven('not a directory');
  return { dev: stat.dev.toString(), ino: stat.ino.toString() };
}

export interface ProvenFsRoot {
  root: ProvenHostRoot;
  report: FsProbeReport;
  generationToken: string;
}

/**
 * Prove that the daemon's `hostPath` is the directory Sencho sees at
 * `senchoPath`, and that every declared alias resolves to it too, then mint the
 * root a helper may bind. Runs at every capture and every overwrite admission;
 * the answer is never cached.
 */
export async function proveHostRoot(input: {
  runner: RecoveryHelperRunner;
  operationId: string;
  senchoPath: string;
  hostPath: string;
  aliases?: readonly string[];
  signal?: AbortSignal;
}): Promise<ProvenFsRoot> {
  const aliases = input.aliases ?? [];
  if (aliases.length > MAX_DECLARED_ALIASES) {
    throw new RecoveryError('identity_unknown', {
      reason: 'path_mapping_unproven',
      detail: `This directory is declared under more than ${MAX_DECLARED_ALIASES} different paths, which is more than Sencho proves. Declare it under fewer paths.`,
    });
  }
  const view = await statSenchoView(input.senchoPath);
  const report = await probeHostPath({
    runner: input.runner,
    operationId: input.operationId,
    source: UnprovenHostPath.of(input.hostPath),
    signal: input.signal,
  });
  if (report.dev !== view.dev || report.ino !== view.ino) {
    console.warn(
      '[Recovery] The host path for %s is not the directory Sencho sees (daemon %s:%s, Sencho %s:%s)',
      sanitizeForLog(input.senchoPath), report.dev, report.ino, view.dev, view.ino,
    );
    throw mappingUnproven('identity mismatch');
  }
  // A declared path that differs from the host path is what the workload's
  // container actually binds. Data Sencho would call protected must be the data
  // the workload sees, so each one must resolve to the same directory.
  for (const alias of aliases) {
    const aliasReport = await probeHostPath({
      runner: input.runner,
      operationId: input.operationId,
      source: UnprovenHostPath.of(alias),
      signal: input.signal,
    });
    if (aliasReport.dev !== view.dev || aliasReport.ino !== view.ino) {
      console.warn('[Recovery] A declared path for %s resolves to a different directory on the host', sanitizeForLog(input.senchoPath));
      throw mappingUnproven('alias mismatch');
    }
  }
  return {
    root: ProvenHostRoot.mint(input.hostPath, view.dev, view.ino),
    report,
    generationToken: fsGenerationToken(report),
  };
}

/**
 * The mount points below a proven root, as `nested_mount` exclusions. The
 * capture reads the root without following mounts, so each one is recorded and
 * the point is stored `partial`. A list the probe truncated or could not read
 * fails the capture: an unknown mount set cannot be described.
 */
export async function nestedMountExclusions(input: {
  runner: RecoveryHelperRunner;
  operationId: string;
  root: ProvenHostRoot;
  signal?: AbortSignal;
}): Promise<PointExclusion[]> {
  const report = await probeHostPath({ ...input, source: input.root, mounts: true });
  if (report.mounts === null || report.mountsTruncated) {
    throw new RecoveryError('identity_unknown', {
      detail: 'Sencho could not list every mount below this directory, so it cannot say what a point of it would leave out.',
    });
  }
  const exclusions: PointExclusion[] = [];
  for (const mount of report.mounts) {
    const normalized = path.posix.normalize(mount).replace(/^\/+/, '').replace(/\/+$/, '');
    if (normalized === '' || normalized === '.' || normalized.split('/').includes('..')) continue;
    exclusions.push({ path: normalized, reason: 'nested_mount' });
  }
  return exclusions;
}

// --- Generation -------------------------------------------------------------

/**
 * The generation token of a host directory. With a real birth time it is
 * `fs|<ino>|<btime>`: the device is left out because btrfs, ZFS and NFS hand
 * out a new anonymous device number at every mount, and a token must survive a
 * reboot. Without one it is `fs|<dev>:<ino>`, and the residual risk (a directory
 * recreated on the same inode) is documented.
 */
export function fsGenerationToken(report: Pick<FsProbeReport, 'dev' | 'ino' | 'btime'>): string {
  return report.btime ? `fs|${report.ino}|${report.btime}` : `fs|${report.dev}:${report.ino}`;
}

/**
 * Whether a stored token no longer describes the directory, from Sencho's own
 * `stat` alone (a listing starts no helper). The inode is compared, and the
 * device too when the token carries it. A directory that cannot be read is a
 * change: its old points must stop reading Protected.
 */
export async function fsGenerationChanged(token: string, senchoPath: string): Promise<boolean> {
  const parsed = /^fs\|(?:([0-9]+)\|[0-9]+\.[0-9]{9}|([0-9]+):([0-9]+))$/.exec(token);
  if (!parsed) return true;
  let view: { dev: string; ino: string };
  try {
    view = await statSenchoView(senchoPath);
  } catch {
    return true;
  }
  if (parsed[1] !== undefined) return parsed[1] !== view.ino;
  return parsed[2] !== view.dev || parsed[3] !== view.ino;
}

// --- Dependents -------------------------------------------------------------

/** The paths one root is known by, for matching. */
export interface FsRootLocation {
  senchoPath: string;
  hostPath: string;
  aliases: readonly string[];
}

interface ListedContainer {
  Id: string;
  Names?: string[];
  State?: string;
  Labels?: Record<string, string>;
  Mounts?: Array<{ Type?: string; Source?: string; Destination?: string; RW?: boolean }>;
}

/** How one container's mounts reach a root. */
export interface ContainerRootMatch {
  depends: boolean;
  /** A read-only ancestor: it can see the data but not change it. */
  observes: boolean;
}

/**
 * Match one container's bind mounts against a root. A bind source is a host
 * path: it is compared with the host path and the declared aliases, and it is
 * also mapped into Sencho's namespace and canonicalized there when Sencho can
 * reach it, so a symlinked spelling of the root is still recognised.
 */
export async function matchContainerToRoot(
  container: Pick<ListedContainer, 'Mounts'>,
  root: FsRootLocation,
  ownMounts: OwnMounts,
): Promise<ContainerRootMatch> {
  let depends = false;
  let observes = false;
  for (const mount of container.Mounts ?? []) {
    if (mount.Type !== 'bind' || typeof mount.Source !== 'string') continue;
    const writable = mount.RW !== false;
    const relations: PathRelation[] = [root.hostPath, ...root.aliases].map((spelling) => relatePath(mount.Source as string, spelling));
    const senchoView = hostToSenchoPath(mount.Source, ownMounts);
    if (senchoView !== null) relations.push(relatePath(await canonicalOrSelf(senchoView), root.senchoPath));
    for (const relation of relations) {
      if (dependsOnRoot(relation, writable)) depends = true;
      else if (relation === 'ancestor') observes = true;
    }
  }
  return { depends, observes: observes && !depends };
}

/** The dependent resolution of a host directory, with what only it can say. */
export type FsDependentResolution = DependentResolution & {
  /** Containers that can read the root through a read-only ancestor, for the overwrite preview. */
  observers: string[];
  /** A container no known stack owns depends on the root: the caller is held to the node-wide check. */
  unownedContainer: boolean;
};

const IN_USE_STATES: ReadonlySet<string> = new Set(['running', 'paused', 'restarting']);

/**
 * Every stack and container that depends on a root, by the rule in
 * `dependsOnRoot`. Sources: the recorded dependents of the storage, the
 * containers that bind it now, and every known stack's declared roots (fresh
 * with `render`, from the 15-second roots cache without). Sencho's own container
 * is never a dependent: it mounts the compose base, which is an ancestor of every
 * stack source.
 *
 * `onlyStacks` limits the declared-roots pass to the named stacks (a listing
 * for one stack); the recorded rows and the containers are still read.
 */
export async function resolveFsRootDependents(input: {
  nodeId: number;
  storageKey: string | null;
  knownStackNames: readonly string[];
  root: FsRootLocation;
  render: boolean;
  onlyStacks?: readonly string[];
  docker: Pick<Docker, 'listContainers'>;
  environment: FsRootEnvironment;
}): Promise<FsDependentResolution> {
  const found = new Map<string, StorageDependent>();
  const current = new Map<string, StorageDependent>();
  const record = (stackName: string, serviceName: string | null, into: Map<string, StorageDependent>): void => {
    if (!stackName) return;
    into.set(`${stackName}\u0000${serviceName ?? ''}`, { stackName, serviceName });
  };
  const add = (stackName: string, serviceName: string | null): void => {
    record(stackName, serviceName, found);
    record(stackName, serviceName, current);
  };
  if (input.storageKey) {
    for (const dependent of StorageIdentityStore.getInstance().listDependents(input.storageKey)) {
      record(dependent.stackName, dependent.serviceName, found);
    }
  }

  const ownMounts = input.environment.ownMounts === 'unreadable' ? null : input.environment.ownMounts;
  const self = SelfIdentityService.getInstance();
  const containers = await input.docker.listContainers({ all: true }) as ListedContainer[];
  const projectToStack = await DockerController.resolveProjectNameMap([...input.knownStackNames]);
  let mountedByContainer = false;
  let unownedContainer = false;
  const observers: string[] = [];
  for (const container of containers) {
    if (self.isOwnContainer(container.Id)) continue;
    const match = await matchContainerToRoot(container, input.root, ownMounts);
    if (match.observes) {
      observers.push((container.Names?.[0] ?? container.Id).replace(/^\//, ''));
      continue;
    }
    if (!match.depends) continue;
    mountedByContainer = true;
    const project = container.Labels?.['com.docker.compose.project'];
    const stack = project
      ? projectToStack.get(project) ?? (input.knownStackNames.includes(project) ? project : null)
      : null;
    if (stack) add(stack, container.Labels?.['com.docker.compose.service'] ?? null);
    else unownedContainer = true;
  }

  const stacks = input.onlyStacks ?? input.knownStackNames;
  for (const stackName of stacks) {
    if (!input.knownStackNames.includes(stackName)) continue;
    let listed: FsRootCandidates;
    try {
      listed = await listStackFsRootCandidates({
        nodeId: input.nodeId,
        stackName,
        fresh: input.render,
        environment: input.environment,
      });
    } catch (err) {
      console.warn('[Recovery] Could not list the roots of stack %s:', sanitizeForLog(stackName), errorMessageForLog(err));
      return unrenderable(stackName);
    }
    if (listed.outcome === 'unrenderable') return unrenderable(stackName);
    for (const candidate of listed.candidates) {
      if (dependsOnRoot(relatePath(candidate.senchoPath, input.root.senchoPath), candidate.writable)) {
        add(stackName, null);
        break;
      }
    }
  }

  return {
    kind: 'resolved',
    dependents: [...found.values()],
    current: [...current.values()],
    mountedByContainer,
    observers: observers.sort(),
    unownedContainer,
  };

  function unrenderable(stackName: string): FsDependentResolution {
    return {
      kind: 'unrenderable',
      stackName,
      dependents: [...found.values()],
      current: [...current.values()],
      mountedByContainer,
      observers: observers.sort(),
      unownedContainer,
    };
  }
}

/**
 * Whether anything is using the root right now, by the same rule: a live
 * container that depends on it. This is the only basis for the consistency
 * label. Sencho's own editor writes to a stack source are not observed here,
 * and the operator page says so.
 */
export async function observeFsRootInUse(input: {
  docker: Pick<Docker, 'listContainers'>;
  root: FsRootLocation;
  ownMounts: OwnMounts;
}): Promise<InUseObservation> {
  const self = SelfIdentityService.getInstance();
  const containers = await input.docker.listContainers({ all: true }) as ListedContainer[];
  const live: string[] = [];
  for (const container of containers) {
    if (self.isOwnContainer(container.Id)) continue;
    const state = String(container.State ?? '').toLowerCase();
    if (!IN_USE_STATES.has(state)) continue;
    if ((await matchContainerToRoot(container, input.root, input.ownMounts)).depends) live.push(container.Id);
  }
  return { inUse: live.length > 0, liveContainers: live };
}

// --- Stored roots ---------------------------------------------------------------

/**
 * Where a stored host-directory identity lives in both namespaces. The stored
 * locator is the host path; Sencho's path is its inverse translation. Throws
 * `identity_unknown` when Sencho's mounts cannot be read or no longer cover it.
 */
export async function locateStoredFsRoot(locator: string): Promise<FsRootLocation> {
  const hostPath = normalizeAbsolute(locator);
  if (hostPath === null) throw new RecoveryError('identity_unknown');
  const senchoPath = hostToSenchoPath(hostPath, await readOwnMounts());
  if (senchoPath === null) throw mappingUnproven('no own mount covers the stored host path');
  return { senchoPath, hostPath, aliases: [] };
}

/** Sencho's path for a stored root without throwing, for a listing. */
export async function storedFsRootSenchoPath(locator: string, environment: FsRootEnvironment): Promise<string | null> {
  if (environment.ownMounts === 'unreadable') return null;
  return hostToSenchoPath(locator, environment.ownMounts);
}

// --- Overlap ----------------------------------------------------------------

/**
 * Refuse a capture or an overwrite of a host directory while work holds an
 * overlapping one. Parent and child directories have different storage keys,
 * so the storage lock alone would let a parent capture read a child mid-swap.
 * Runs inside the admission transaction, so it cannot race another admission.
 */
export function assertNoOverlappingFsWork(hostPath: string, ownStorageKey: string): void {
  const db = recoveryDb();
  const locked = db.prepare(`
    SELECT i.locator AS locator, i.storage_key AS storage_key
    FROM recovery_locks l
    JOIN recovery_storage_identities i ON i.storage_key = l.resource_key AND i.state = 'current'
    WHERE l.scope = 'storage' AND i.kind = 'bind_root'
  `).all() as Array<{ locator: string; storage_key: string }>;
  for (const row of locked) {
    if (row.storage_key === ownStorageKey) continue;
    if (pathsOverlap(row.locator, hostPath)) throw overlapRefusal();
  }
  const intents = db.prepare(`
    SELECT target_paths_json AS paths FROM recovery_restore_intents
    WHERE target_mode = 'staged_overwrite'
      AND target_paths_json IS NOT NULL
      AND (phase NOT IN ('committed','rolled_back','completion_unknown') OR fence_state IN ('held','release_failed'))
  `).all() as Array<{ paths: string }>;
  for (const row of intents) {
    const paths = parseFsTargetPaths(row.paths);
    if (paths && pathsOverlap(paths.hostPath, hostPath)) throw overlapRefusal();
  }
}

function overlapRefusal(): RecoveryError {
  return new RecoveryError('lock_held', {
    detail: 'Another recovery operation holds a directory that contains this one or is inside it. Wait for it to finish, then try again.',
  });
}

/** A short description of an ineligible root, for an API answer. */
export function describeFsIneligible(reason: FsRootIneligibleReason | null): string | null {
  switch (reason) {
    case null:
      return null;
    case 'host_path_unreachable':
      return 'Sencho cannot reach this directory. Bind it into the Sencho container to protect it.';
    case 'protected_host_path':
      return 'This directory is a protected host path and cannot be protected.';
    case 'sencho_managed_path':
      return 'This directory overlaps an area Sencho manages and cannot be protected.';
    case 'not_a_directory':
      return 'This bind mount targets a single file, not a directory.';
    case 'path_mapping_unknown':
      return 'No mount of the Sencho container covers this directory, so Sencho cannot tell which host path holds it.';
    case 'docker_data_path':
      return 'This directory is inside Docker\'s data root, which holds named volumes and the recovery repository.';
    case 'outside_compose_base':
      return 'This stack directory resolves outside the compose directory, so it is not protected as a stack source.';
  }
}
