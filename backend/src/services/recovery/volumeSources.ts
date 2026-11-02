import type Docker from 'dockerode';
import { FileSystemService } from '../FileSystemService';
import { ComposeService } from '../ComposeService';
import DockerController from '../DockerController';
import { parseEffectiveModel } from '../preflight/effectiveModel';
import SelfIdentityService from '../SelfIdentityService';
import { errorMessageForLog, sanitizeForLog } from '../../utils/safeLog';
import { RecoveryError } from './redaction';
import { deriveStorageKey, isDockerVolumeName, StorageIdentityStore } from './storageIdentity';
import { getRecoveryAuthorityId } from './recoveryDb';
import { HELPER_LABEL_REPOSITORY, RecoveryHelperRunner } from './restic/helperRunner';
import { RECOVERY_RESERVED_PREFIX } from './reservedNames';
import { RECOVERY_HELPER_PROBE_PATH } from './restic/helperImage';
import type { HelperProfile } from './restic/helperRunner';
import type { StorageDependent } from './types';

/**
 * Which volumes this node may protect, which stacks depend on one, and whether
 * anything is using it right now.
 *
 * Phase A protects named volumes only: a Docker-managed volume with the `local`
 * driver and no driver options. Everything else is refused with a reason rather
 * than quietly skipped, because "not listed" and "listed as refused" mean
 * different things to an operator.
 *
 * Dependents are resolved from three sources, because any one of them can miss:
 * containers that are running now, the volume's own Compose project label, and
 * every stack on this node whose rendered model names the volume. A stack that
 * cannot be rendered makes the answer unknowable, and an unknowable answer never
 * narrows an authorization decision: the caller is held to a global check.
 */

export type IneligibleReason =
  | 'volume_missing'
  | 'reserved_name'
  | 'repository_volume'
  | 'sencho_volume'
  | 'anonymous_volume'
  | 'non_local_driver'
  | 'driver_options';

export interface VolumeSource {
  volumeName: string;
  driver: string;
  eligible: boolean;
  ineligibleReason: IneligibleReason | null;
  /** Docker's `CreatedAt` for the volume, part of the generation token. */
  createdAt: string | null;
  labels: Record<string, string>;
}

/** Docker names an anonymous volume with the container's 64-hex id. */
const ANONYMOUS_VOLUME_NAME = /^[0-9a-f]{64}$/;

export interface EligibilityInput {
  name: string;
  driver: string | undefined;
  options: Record<string, string> | undefined;
  labels: Record<string, string> | undefined;
  isOwnVolume: (name: string) => boolean;
}

/**
 * Why this volume cannot hold recovery points, in the order the reasons matter.
 * The repository label comes first so the repository volume says what it is
 * (its name carries the reserved prefix too), and a volume whose name Sencho
 * reserves is refused whatever else is true of it, so a repository volume can
 * never be offered as a source even if its label were missing.
 */
export function classifyVolumeEligibility(input: EligibilityInput): IneligibleReason | null {
  if (input.labels && input.labels[HELPER_LABEL_REPOSITORY]) return 'repository_volume';
  if (!isDockerVolumeName(input.name)) return 'reserved_name';
  if (input.name.startsWith(RECOVERY_RESERVED_PREFIX)) return 'reserved_name';
  if (input.isOwnVolume(input.name)) return 'sencho_volume';
  if (ANONYMOUS_VOLUME_NAME.test(input.name)) return 'anonymous_volume';
  if ((input.driver ?? 'local') !== 'local') return 'non_local_driver';
  if (input.options && Object.keys(input.options).length > 0) return 'driver_options';
  return null;
}

interface ListedVolume {
  Name: string;
  Driver?: string;
  Options?: Record<string, string> | null;
  Labels?: Record<string, string> | null;
  CreatedAt?: string;
}

/** Every volume on the node with its verdict. Never omits a volume. */
export async function listVolumeSources(
  docker: Pick<Docker, 'listVolumes'>,
  isOwnVolume: (name: string) => boolean = (name) => SelfIdentityService.getInstance().isOwnVolume(name),
): Promise<VolumeSource[]> {
  const listed = await docker.listVolumes();
  const volumes = (listed?.Volumes ?? []) as ListedVolume[];
  return volumes.map((volume) => {
    const labels = volume.Labels ?? {};
    const reason = classifyVolumeEligibility({
      name: volume.Name,
      driver: volume.Driver,
      options: volume.Options ?? undefined,
      labels,
      isOwnVolume,
    });
    return {
      volumeName: volume.Name,
      driver: volume.Driver ?? 'local',
      eligible: reason === null,
      ineligibleReason: reason,
      createdAt: typeof volume.CreatedAt === 'string' && volume.CreatedAt !== '0001-01-01T00:00:00Z'
        ? volume.CreatedAt
        : null,
      labels,
    };
  });
}

/** The same list, for one volume: null when Docker has no such volume. */
export async function inspectVolumeSource(
  docker: Pick<Docker, 'getVolume'>,
  volumeName: string,
  isOwnVolume: (name: string) => boolean = (name) => SelfIdentityService.getInstance().isOwnVolume(name),
): Promise<VolumeSource | null> {
  try {
    const inspected = await docker.getVolume(volumeName).inspect() as ListedVolume;
    const labels = inspected.Labels ?? {};
    const reason = classifyVolumeEligibility({
      name: inspected.Name ?? volumeName,
      driver: inspected.Driver,
      options: inspected.Options ?? undefined,
      labels,
      isOwnVolume,
    });
    return {
      volumeName: inspected.Name ?? volumeName,
      driver: inspected.Driver ?? 'local',
      eligible: reason === null,
      ineligibleReason: reason,
      createdAt: typeof inspected.CreatedAt === 'string' && inspected.CreatedAt !== '0001-01-01T00:00:00Z'
        ? inspected.CreatedAt
        : null,
      labels,
    };
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return null;
    throw err;
  }
}

// --- Generation token -------------------------------------------------------

export interface ProbeReport {
  dev: number;
  ino: number;
  uid: number;
  gid: number;
  mode: number;
}

/** Parse the probe's one JSON line. Anything else is not a report. */
export function parseProbeReport(line: string): ProbeReport | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    const nums = ['dev', 'ino', 'uid', 'gid', 'mode'] as const;
    for (const key of nums) {
      if (typeof record[key] !== 'number' || !Number.isSafeInteger(record[key])) return null;
    }
    return {
      dev: record.dev as number,
      ino: record.ino as number,
      uid: record.uid as number,
      gid: record.gid as number,
      mode: record.mode as number,
    };
  } catch {
    // Anything that is not one JSON object of integers is not a probe report.
    return null;
  }
}

/**
 * The adapter's generation token: the volume's creation time plus the root's
 * device and inode. CreatedAt alone has one-second resolution, so a `down -v`
 * and `up` inside the same second keeps it; a recreated volume gets a new inode.
 *
 * Nothing is written into the volume: the probe only reads metadata.
 */
export async function probeGenerationToken(input: {
  runner: RecoveryHelperRunner;
  operationId: string;
  volumeName: string;
  createdAt: string | null;
  profile?: HelperProfile;
}): Promise<string> {
  const lines: string[] = [];
  const result = await input.runner.run({
    profile: input.profile ?? 'probe',
    operationId: input.operationId,
    cmd: [RECOVERY_HELPER_PROBE_PATH, '/data'],
    mounts: { source: input.volumeName },
    onStdoutLine: (line) => {
      if (lines.length === 0) lines.push(line);
    },
  });
  if (result.exitCode !== 0) {
    throw new RecoveryError(result.exitCode === null ? 'capability_unavailable' : 'identity_unknown');
  }
  const report = parseProbeReport(lines[0] ?? '');
  if (!report) throw new RecoveryError('identity_unknown');
  return `${input.createdAt ?? 'unknown'}|${report.dev}:${report.ino}`;
}

/**
 * Whether Docker's creation time for a volume still matches the one a generation
 * token was minted from. A token the adapter did not make (no `|`) is not
 * evidence of a change, so it matches. Same-second recreation keeps the time and
 * is only caught by the inode the next capture's probe reads.
 */
export function generationTokenMatchesVolume(token: string, createdAt: string | null): boolean {
  const separator = token.lastIndexOf('|');
  if (separator < 0) return true;
  const recorded = token.slice(0, separator);
  const live = createdAt ?? 'unknown';
  if (recorded === live) return true;
  // Docker prints the time in the daemon's zone; the same instant in another
  // zone is the same volume.
  const recordedMs = Date.parse(recorded);
  const liveMs = Date.parse(live);
  return Number.isFinite(recordedMs) && Number.isFinite(liveMs) && recordedMs === liveMs;
}

// --- In-use observation ------------------------------------------------------

/** Container states that mean the storage is being written while a capture runs. */
const IN_USE_STATES: ReadonlySet<string> = new Set(['running', 'paused', 'restarting']);

interface ListedContainer {
  Id: string;
  State?: string;
  Labels?: Record<string, string>;
  Mounts?: Array<{ Type?: string; Name?: string }>;
}

export interface InUseObservation {
  inUse: boolean;
  /** Names of the containers that had the volume mounted and were live. */
  liveContainers: string[];
}

/**
 * Whether anything is using the volume right now. A container that mounts it and
 * is running, paused or restarting counts; a stopped one does not. This is the
 * only basis for the consistency label, and Sencho never stops a container to
 * make a capture quieter.
 */
export async function observeVolumeInUse(
  docker: Pick<Docker, 'listContainers'>,
  volumeName: string,
): Promise<InUseObservation> {
  const containers = await docker.listContainers({ all: true }) as ListedContainer[];
  const liveContainerIds: string[] = [];
  for (const container of containers) {
    const mounts = container.Mounts ?? [];
    const mountsVolume = mounts.some((m) => m.Type === 'volume' && m.Name === volumeName);
    if (!mountsVolume) continue;
    const state = String(container.State ?? '').toLowerCase();
    if (IN_USE_STATES.has(state)) liveContainerIds.push(container.Id);
  }
  return { inUse: liveContainerIds.length > 0, liveContainers: liveContainerIds };
}

/** The consistency label a capture gets, from the checks before and after it. */
export function consistencyFromObservations(
  before: InUseObservation | null,
  after: InUseObservation | null,
): 'crash_consistent_live' | 'crash_consistent_stopped' | 'unknown' {
  if (!before || !after) return 'unknown';
  if (before.inUse || after.inUse) return 'crash_consistent_live';
  // Observed with nothing running at either check. Sencho stopped nothing; the
  // label says what was seen, not what the application guaranteed.
  return 'crash_consistent_stopped';
}

// --- Dependents --------------------------------------------------------------

export type DependentResolution =
  | {
      kind: 'resolved';
      dependents: StorageDependent[];
      /** True when a container currently mounts the volume, whatever its state. */
      mountedByContainer: boolean;
    }
  /** A stack's model could not be rendered, so the full set is unknown. */
  | {
      kind: 'unrenderable';
      stackName: string;
      /** What is known: recorded dependents, containers and the volume's own label. */
      dependents: StorageDependent[];
      mountedByContainer: boolean;
    };

/** How many stack models to render at once. Rendering shells out to Compose. */
const RENDER_CONCURRENCY = 4;

async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Every stack that depends on a volume.
 *
 * `render` is false for a listing read, which may not pay for a Compose render
 * per stack; the recorded dependents, the containers and the volume's own label
 * still describe the volume. A mutating route passes `true`, because it is about
 * to change the data and must cover an `external` volume that a stopped stack
 * still owns.
 */
export async function resolveVolumeDependents(input: {
  nodeId: number;
  ownerNodeKey: string;
  knownStackNames: readonly string[];
  volumeName: string;
  volumeLabels: Record<string, string>;
  render: boolean;
  docker: Pick<Docker, 'listContainers'>;
}): Promise<DependentResolution> {
  const found = new Map<string, StorageDependent>();
  const add = (stackName: string, serviceName: string | null): void => {
    if (!stackName) return;
    found.set(`${stackName}\u0000${serviceName ?? ''}`, { stackName, serviceName });
  };

  // Recorded dependents: the last observation's view, so a stack that dropped the
  // volume recently still appears once more.
  const storageKey = deriveStorageKey(getRecoveryAuthorityId(), input.ownerNodeKey, 'named_volume', input.volumeName);
  for (const dependent of StorageIdentityStore.getInstance().listDependents(storageKey)) {
    add(dependent.stackName, dependent.serviceName);
  }

  // Containers that mount it now.
  const containers = await input.docker.listContainers({ all: true }) as ListedContainer[];
  const projectToStack = await DockerController.resolveProjectNameMap([...input.knownStackNames]);
  let mountedByContainer = false;
  for (const container of containers) {
    const mounts = container.Mounts ?? [];
    if (!mounts.some((m) => m.Type === 'volume' && m.Name === input.volumeName)) continue;
    mountedByContainer = true;
    const project = container.Labels?.['com.docker.compose.project'];
    if (!project) continue;
    const stack = projectToStack.get(project) ?? (input.knownStackNames.includes(project) ? project : null);
    if (stack) add(stack, container.Labels?.['com.docker.compose.service'] ?? null);
  }

  // The volume's own Compose project label.
  const volumeProject = input.volumeLabels['com.docker.compose.project'];
  if (volumeProject) {
    const stack = projectToStack.get(volumeProject)
      ?? (input.knownStackNames.includes(volumeProject) ? volumeProject : null);
    if (stack) add(stack, null);
  }

  if (input.render) {
    const rendered = await mapLimited([...input.knownStackNames], RENDER_CONCURRENCY, async (stackName) => {
      const model = await renderStackModel(input.nodeId, stackName);
      return { stackName, model };
    });
    for (const entry of rendered) {
      if (entry.model === 'unrenderable') {
        return {
          kind: 'unrenderable',
          stackName: entry.stackName,
          dependents: [...found.values()],
          mountedByContainer,
        };
      }
      if (entry.model === null) continue;
      for (const resource of Object.values(entry.model.volumes)) {
        if (resource.name === input.volumeName) add(entry.stackName, null);
      }
    }
  }

  return { kind: 'resolved', dependents: [...found.values()], mountedByContainer };
}

type RenderResult = ReturnType<typeof parseEffectiveModel> | 'unrenderable' | null;

/**
 * One stack's effective model, or `unrenderable` when Compose could not produce
 * it and `null` when the stack has no readable Compose file at all (which is not
 * a claim about this volume).
 */
async function renderStackModel(nodeId: number, stackName: string): Promise<RenderResult> {
  try {
    const result = await ComposeService.getInstance(nodeId).renderConfig(stackName);
    if (result.rendered === null) {
      if (result.timedOut) return 'unrenderable';
      // A stack with no compose file is not a stack that could not be rendered.
      if (/no such file|not found|no configuration file/i.test(result.stderr ?? '')) return null;
      console.warn('[Recovery] Could not render stack %s:', sanitizeForLog(stackName));
      return 'unrenderable';
    }
    try {
      return parseEffectiveModel(JSON.parse(result.rendered), stackName);
    } catch (err) {
      console.warn('[Recovery] Could not parse the model of stack %s:', sanitizeForLog(stackName), errorMessageForLog(err));
      return 'unrenderable';
    }
  } catch (err) {
    console.warn('[Recovery] Could not render stack %s:', sanitizeForLog(stackName), errorMessageForLog(err));
    return 'unrenderable';
  }
}

/** Known stack names on a node, for the dependent resolution. */
export async function knownStacksFor(nodeId: number): Promise<string[]> {
  try {
    return await FileSystemService.getInstance(nodeId).getStacks();
  } catch (err) {
    // A node whose compose directory cannot be listed has an unknown dependent
    // set, which the caller treats as fail closed.
    console.warn('[Recovery] Could not list stacks:', errorMessageForLog(err));
    throw new RecoveryError('identity_unknown');
  }
}

/** What a volume's name means before anyone has observed it. */
export interface VolumeLocatorDescription {
  storageKey: string;
  createdAt: string | null;
  labels: Record<string, string>;
  eligible: boolean;
  ineligibleReason: IneligibleReason | null;
}

/**
 * Describe a volume by name without recording an observation: its storage key,
 * when Docker made it, and its labels. Used for the authorization check (which
 * needs the key before any row exists) and to fetch the creation time the
 * generation token includes. A volume Docker does not have is `invalid_request`:
 * a capture has nothing to read. Work on a point that already exists uses
 * `describeStoredLocator` instead.
 */
export async function describeVolumeLocator(input: {
  docker: Pick<Docker, 'getVolume'>;
  ownerNodeKey: string;
  volumeName: string;
}): Promise<VolumeLocatorDescription> {
  if (!isDockerVolumeName(input.volumeName)) throw new RecoveryError('invalid_request');
  const source = await inspectVolumeSource(input.docker, input.volumeName);
  if (!source) throw new RecoveryError('invalid_request');
  return {
    storageKey: deriveStorageKey(getRecoveryAuthorityId(), input.ownerNodeKey, 'named_volume', source.volumeName),
    createdAt: source.createdAt,
    labels: source.labels,
    eligible: source.eligible,
    ineligibleReason: source.ineligibleReason,
  };
}

/**
 * Describe the volume behind a stored storage identity. Listing, verifying and
 * restoring a point, and releasing a lock, act on what was recorded, not on the
 * live volume, and the volume is routinely gone by then (`docker compose down
 * -v`, a prune, a rebuilt host): that is the case recovery exists for. A missing
 * volume is therefore described as absent, with no labels, and the recorded
 * dependents carry the authorization decision.
 */
export async function describeStoredLocator(input: {
  docker: Pick<Docker, 'getVolume'>;
  ownerNodeKey: string;
  locator: string;
}): Promise<VolumeLocatorDescription> {
  const source = await inspectVolumeSource(input.docker, input.locator);
  if (!source) {
    return {
      storageKey: deriveStorageKey(getRecoveryAuthorityId(), input.ownerNodeKey, 'named_volume', input.locator),
      createdAt: null,
      labels: {},
      eligible: false,
      ineligibleReason: 'volume_missing',
    };
  }
  return {
    storageKey: deriveStorageKey(getRecoveryAuthorityId(), input.ownerNodeKey, 'named_volume', source.volumeName),
    createdAt: source.createdAt,
    labels: source.labels,
    eligible: source.eligible,
    ineligibleReason: source.ineligibleReason,
  };
}

/** A volume's eligibility, one line, for an API response. */
export function describeIneligible(reason: IneligibleReason | null): string | null {
  switch (reason) {
    case null:
      return null;
    case 'volume_missing':
      return 'This volume does not exist on this node yet.';
    case 'reserved_name':
      return 'Sencho reserves this name for its own recovery infrastructure.';
    case 'repository_volume':
      return 'This volume holds a recovery repository.';
    case 'sencho_volume':
      return 'This volume belongs to Sencho itself.';
    case 'anonymous_volume':
      return 'This is an anonymous volume with no stable identity.';
    case 'non_local_driver':
      return 'Only volumes using the local driver can be protected.';
    case 'driver_options':
      return 'This volume has driver options (a bind, NFS or tmpfs mount), which this release does not capture.';
  }
}
