import type Docker from 'dockerode';
import { AsyncLocalStorage } from 'async_hooks';
import { errorMessageForLog, sanitizeForLog } from '../../utils/safeLog';
import { DataRestoreFenceError, type FenceSubject } from '../../helpers/dataRestoreFenceError';
import { recoveryDb } from './recoveryDb';
import { parseFsTargetPaths, type FsTargetPaths } from './fsTargets';
import { RecoveryError } from './redaction';
import type { RestoreFenceState } from './restoreIntents';
import type { OwnMounts } from './fsRoots';

/**
 * The durable restore fence.
 *
 * A staged overwrite stops every container that mounts the target volume. That
 * is only safe if nothing can start one again while the data is half swapped, so
 * three things are recorded before the first Docker call:
 *
 *   - which containers were fenced, with the restart policy each had and whether
 *     it was running;
 *   - the intent that owns the fence, so the fence survives a restart of Sencho
 *     or of the Docker daemon;
 *   - the policy change itself, so a daemon restart cannot bring a container
 *     back on data that is mid-swap.
 *
 * Every Sencho path that can start a workload consults this module: a Compose
 * lifecycle through `StackOpLockService`, a single container start or restart
 * through `DockerController`, and the Files & Volumes browser. The stack file
 * routes register each operation on a host directory here as well, so a fence
 * on a directory waits for (or cuts off) the file work already running on it.
 * The fence matches containers by what they mount, never by comparing a Compose
 * project label to a stack name: the two can differ (a `name:` key, or case),
 * and an old container from an earlier project would be missed.
 *
 * A store this build cannot read (schema `newer`, or a failed migration) makes
 * the checks fail open with one log line. The Docker-level restart policy fence
 * still holds, because it is a daemon fact rather than a Sencho record. That is a
 * documented limit, not a claim that the fence is complete.
 */

export interface RestartPolicy {
  Name?: string;
  MaximumRetryCount?: number;
}

export interface FenceMemberInput {
  containerId: string;
  containerName: string;
  stackName: string | null;
  /** The Compose project label, because a caller can key the stack by it. */
  projectName: string | null;
  restartPolicy: RestartPolicy;
  wasRunning: boolean;
}

export interface FenceMember extends FenceMemberInput {
  intentId: string;
  releasedAt: number | null;
}

interface FenceRow {
  intent_id: string;
  container_id: string;
  container_name: string;
  stack_name: string | null;
  project_name: string | null;
  restart_policy_json: string;
  was_running: number;
  released_at: number | null;
}

function toMember(row: FenceRow): FenceMember {
  let policy: RestartPolicy = { Name: 'no' };
  try {
    const parsed: unknown = JSON.parse(row.restart_policy_json);
    if (parsed && typeof parsed === 'object') policy = parsed as RestartPolicy;
  } catch {
    // A row written by this build is always JSON. An unreadable one is treated
    // as "no policy", which is the safe direction on release: it starts nothing.
  }
  return {
    intentId: row.intent_id,
    containerId: row.container_id,
    containerName: row.container_name,
    stackName: row.stack_name,
    projectName: row.project_name,
    restartPolicy: policy,
    wasRunning: row.was_running === 1,
    releasedAt: row.released_at,
  };
}

/**
 * A fence is live from the moment its state says the workloads were pinned to
 * it, whatever phase the intent has since reached. That is what keeps a start
 * refused after a cleanup failure (`swapped`), after an unknown ending
 * (`completion_unknown`) and after a release that could not restore a policy
 * (`rolled_back` with `release_failed`). A `none` state means the containers were
 * never touched, and the storage lock covers that window instead.
 */
const LIVE_FENCE_STATE = "('held','release_failed')";

/** One log line for an unreadable store, not one per request. */
let warnedUnreadable = false;
/** Fenced restores whose directory paths could not be read, each logged once. */
const warnedUnreadableFsTargets = new Set<string>();

/** Test seam: allow the warnings again. */
export function resetRestoreFenceWarningForTests(): void {
  warnedUnreadable = false;
  warnedUnreadableFsTargets.clear();
}

function warnStoreUnreadable(err: unknown): void {
  if (warnedUnreadable) return;
  warnedUnreadable = true;
  console.warn(
    '[Recovery] The restore fence store cannot be read, so Sencho cannot tell which volumes are fenced: %s',
    errorMessageForLog(err),
  );
}

/** The restore intent whose own work is running in this async context, if any. */
const fenceOwnerScope = new AsyncLocalStorage<string>();

/**
 * Run `work` as the restore `intentId` itself: inside it, that restore's own
 * directory fence is not listed (`liveFencedFsTargets`), so the reads the
 * restore makes of the stacks that depend on its directory (the dependent
 * re-check renders each one's Compose model, before the swap starts) are not
 * refused by the fence the same restore holds. Every other restore's fence
 * still applies, and nothing outside `work` is affected.
 */
export function runAsFenceOwner<T>(intentId: string, work: () => Promise<T>): Promise<T> {
  return fenceOwnerScope.run(intentId, work);
}

export class RestoreFenceStore {
  private static instance: RestoreFenceStore;

  static getInstance(): RestoreFenceStore {
    if (!RestoreFenceStore.instance) RestoreFenceStore.instance = new RestoreFenceStore();
    return RestoreFenceStore.instance;
  }

  /**
   * Write every member before the first Docker mutation. Idempotent on replay.
   *
   * It records who will be fenced, not that the fence is held: the rows exist
   * from admission, so a crash after admission still leaves the exact set to
   * release, while `isStackFenced` stays false until the pipeline advances the
   * intent and actually stops them.
   */
  recordMembers(intentId: string, members: readonly FenceMemberInput[], now = Date.now()): void {
    const db = recoveryDb();
    const insert = db.prepare(`
      INSERT INTO recovery_restore_fence_members
        (intent_id, container_id, container_name, stack_name, project_name, restart_policy_json, was_running)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (intent_id, container_id) DO UPDATE SET
        container_name = excluded.container_name,
        stack_name = COALESCE(excluded.stack_name, recovery_restore_fence_members.stack_name),
        project_name = COALESCE(excluded.project_name, recovery_restore_fence_members.project_name),
        restart_policy_json = excluded.restart_policy_json,
        -- The pipeline refreshes the facts once, before it stops anything, so the
        -- latest observation is the one that describes the fence. A container the
        -- operator stopped between admission and the fence must not be started
        -- again by the release.
        was_running = excluded.was_running
    `);
    db.transaction(() => {
      for (const member of members) {
        insert.run(
          intentId,
          member.containerId,
          member.containerName,
          member.stackName,
          member.projectName,
          JSON.stringify(member.restartPolicy ?? { Name: 'no' }),
          member.wasRunning ? 1 : 0,
        );
      }
      db.prepare('UPDATE recovery_restore_intents SET updated_at = ? WHERE id = ?').run(now, intentId);
    })();
  }

  listMembers(intentId: string): FenceMember[] {
    const rows = recoveryDb().prepare(
      'SELECT * FROM recovery_restore_fence_members WHERE intent_id = ? ORDER BY rowid',
    ).all(intentId) as FenceRow[];
    return rows.map(toMember);
  }

  markMemberReleased(intentId: string, containerId: string, now = Date.now()): void {
    recoveryDb().prepare(
      'UPDATE recovery_restore_fence_members SET released_at = ? WHERE intent_id = ? AND container_id = ?',
    ).run(now, intentId, containerId);
  }

  setFenceState(intentId: string, state: RestoreFenceState, now = Date.now()): void {
    recoveryDb().prepare('UPDATE recovery_restore_intents SET fence_state = ?, updated_at = ? WHERE id = ?')
      .run(state, now, intentId);
  }

  /**
   * The volumes a live overwrite holds. Empty when no overwrite is past its
   * fence, which is the common case, so the Docker lookups behind start and
   * restart pay nothing.
   */
  liveFencedVolumeNames(): string[] {
    try {
      const rows = recoveryDb().prepare(`
        SELECT target_volume AS name FROM recovery_restore_intents
        WHERE target_mode = 'staged_overwrite'
          AND target_volume IS NOT NULL
          AND fence_state IN ${LIVE_FENCE_STATE}
      `).all() as Array<{ name: string }>;
      return rows.map((row) => row.name);
    } catch (err) {
      warnStoreUnreadable(err);
      return [];
    }
  }

  isVolumeFenced(volumeName: string): boolean {
    return this.liveFencedVolumeNames().includes(volumeName);
  }

  /**
   * The host directories a live overwrite holds, with where each lives. Empty in
   * the common case, so the callers that check it pay one query.
   */
  liveFencedFsTargets(): FsTargetPaths[] {
    const owner = fenceOwnerScope.getStore() ?? null;
    try {
      const rows = recoveryDb().prepare(`
        SELECT id, target_paths_json AS paths FROM recovery_restore_intents
        WHERE target_mode = 'staged_overwrite'
          AND target_volume LIKE 'fs:%'
          AND fence_state IN ${LIVE_FENCE_STATE}
      `).all() as Array<{ id: string; paths: string | null }>;
      return rows.filter((row) => row.id !== owner).map((row) => {
        const paths = parseFsTargetPaths(row.paths);
        if (paths) return paths;
        // A fenced directory whose record cannot be read is still fenced. It
        // stands for every host path, so nothing that binds one starts and no
        // file route touches one until the restore is resolved.
        if (!warnedUnreadableFsTargets.has(row.id)) {
          warnedUnreadableFsTargets.add(row.id);
          console.warn('[Recovery] The paths of fenced restore %s cannot be read; refusing every host directory until it is resolved', sanitizeForLog(row.id));
        }
        return { senchoPath: '/', hostPath: '/', aliases: [] };
      });
    } catch (err) {
      warnStoreUnreadable(err);
      return [];
    }
  }

  /**
   * Whether a stack has a container under a live fence. Both the stack directory
   * name and its Compose project name are matched, because callers key by either.
   */
  isStackFenced(stackName: string): boolean {
    if (!stackName) return false;
    try {
      const row = recoveryDb().prepare(`
        SELECT 1 AS found
        FROM recovery_restore_fence_members m
        JOIN recovery_restore_intents i ON i.id = m.intent_id
        WHERE i.target_mode = 'staged_overwrite'
          AND i.fence_state IN ${LIVE_FENCE_STATE}
          AND (m.stack_name = ? OR m.project_name = ?)
        LIMIT 1
      `).get(stackName, stackName) as { found: number } | undefined;
      if (row !== undefined) return true;
      // A stack can declare the volume without running a container right now. The
      // deploy that would start one is exactly what this fence has to refuse, so
      // the recorded dependent set counts as fenced as well.
      const dependent = recoveryDb().prepare(`
        SELECT dependent_stacks_json AS stacks
        FROM recovery_restore_intents
        WHERE target_mode = 'staged_overwrite'
          AND fence_state IN ${LIVE_FENCE_STATE}
          AND dependent_stacks_json IS NOT NULL
      `).all() as Array<{ stacks: string }>;
      return dependent.some((entry) => {
        try {
          const parsed: unknown = JSON.parse(entry.stacks);
          return Array.isArray(parsed) && parsed.includes(stackName);
        } catch {
          return false;
        }
      });
    } catch (err) {
      warnStoreUnreadable(err);
      return false;
    }
  }

  /**
   * The overwrite that owns a volume, or null.
   *
   * An overwrite owns its volume from admission, before the fence exists, until
   * it settles and until its fence is released. Both conditions count: an intent
   * that settled `committed` or `rolled_back` while its release failed still
   * has the workloads stopped with their restart policy pinned to `no`, and a
   * second overwrite admitted then would record that pinned policy as the
   * original.
   */
  liveIntentForVolume(volumeName: string): string | null {
    try {
      const row = recoveryDb().prepare(`
        SELECT id FROM recovery_restore_intents
        WHERE target_mode = 'staged_overwrite'
          AND target_volume = ?
          AND (
            phase NOT IN ('committed','rolled_back','completion_unknown')
            OR fence_state IN ${LIVE_FENCE_STATE}
          )
        LIMIT 1
      `).get(volumeName) as { id: string } | undefined;
      return row?.id ?? null;
    } catch (err) {
      warnStoreUnreadable(err);
      return null;
    }
  }
}

// --- Docker side ------------------------------------------------------------

interface InspectableContainer {
  inspect(): Promise<{
    Id?: string;
    Name?: string;
    State?: { Running?: boolean };
    HostConfig?: { RestartPolicy?: RestartPolicy };
    Mounts?: Array<{ Type?: string; Name?: string; Source?: string; RW?: boolean }>;
  }>;
  update(options: { RestartPolicy: RestartPolicy }): Promise<unknown>;
  stop(options?: { t?: number }): Promise<unknown>;
  start(): Promise<unknown>;
}

type FenceDocker = Pick<Docker, 'getContainer'>;

/** Docker answers 304 for an operation that is already in the asked state. */
function isNotModified(err: unknown): boolean {
  return (err as { statusCode?: number }).statusCode === 304;
}

/**
 * Stop every fenced container and pin its restart policy to `no`.
 *
 * The policy is changed before the stop, so a daemon restart in the middle of
 * the fence cannot bring the container back. A container that is already stopped
 * still gets the policy change, because `docker start` or a daemon restart would
 * otherwise honour `always`.
 */
export async function applyRestoreFence(
  intentId: string,
  docker: FenceDocker,
  members: readonly FenceMember[],
): Promise<void> {
  // Recorded first: every start and deploy from this instant on is refused.
  RestoreFenceStore.getInstance().setFenceState(intentId, 'held');
  // A start that passed its check before that line is still on its way to the
  // daemon. Waiting for it means the stop below finds the container started,
  // instead of the start landing after the stop and on the swap. A start that
  // does not answer in time is not something to stop around: refuse the fence.
  if (!await waitForStartsInFlight()) {
    console.warn('[Recovery] A container start did not answer before the fence was applied; refusing the fence.');
    throw new RecoveryError('fence_unavailable');
  }
  for (const member of members) {
    const container = docker.getContainer(member.containerId) as unknown as InspectableContainer;
    try {
      await container.update({ RestartPolicy: { Name: 'no' } });
      try {
        await container.stop({ t: 30 });
      } catch (err) {
        if (!isNotModified(err)) throw err;
      }
    } catch (err) {
      console.warn(
        '[Recovery] Could not fence container %s:',
        sanitizeForLog(member.containerName),
        errorMessageForLog(err),
      );
      throw new RecoveryError('fence_unavailable');
    }
  }
}

/**
 * Restore every recorded restart policy. `restart` starts only the containers
 * that were running when the fence was taken; a container that was stopped stays
 * stopped, and its policy is still put back exactly as it was.
 */
export async function releaseRestoreFence(
  intentId: string,
  docker: FenceDocker,
  members: readonly FenceMember[],
  options: { restart: boolean },
  now = Date.now(),
): Promise<void> {
  const store = RestoreFenceStore.getInstance();
  let failed = false;
  for (const member of members) {
    if (member.releasedAt !== null) continue;
    const container = docker.getContainer(member.containerId) as unknown as InspectableContainer;
    try {
      await container.update({ RestartPolicy: member.restartPolicy ?? { Name: 'no' } });
      if (options.restart && member.wasRunning) {
        try {
          await container.start();
        } catch (err) {
          if (!isNotModified(err)) throw err;
        }
      }
      store.markMemberReleased(intentId, member.containerId, now);
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) {
        // The container is gone (removed or recreated since the fence): there is
        // no policy to restore and nothing to start, and retrying can never
        // succeed, so it must not hold the volume fenced.
        console.warn('[Recovery] Fenced container %s no longer exists; nothing to release.', sanitizeForLog(member.containerName));
        store.markMemberReleased(intentId, member.containerId, now);
        continue;
      }
      failed = true;
      console.warn(
        '[Recovery] Could not release the fence on container %s:',
        sanitizeForLog(member.containerName),
        errorMessageForLog(err),
      );
    }
  }
  store.setFenceState(intentId, failed ? 'release_failed' : 'released', now);
  if (failed) throw new RecoveryError('fence_unavailable');
}

/**
 * Starts that passed the fence check and have not been answered by the daemon,
 * with the time each began. The entries never reject: only the settling matters.
 */
const startsInFlight = new Map<Promise<void>, number>();

/**
 * The longest a fence waits for a start already in flight. A restart includes the
 * container's stop grace period, so this is minutes, not moments.
 */
let startDrainTimeoutMs = 120_000;

/**
 * A start pending this long is a hung daemon call. A fence does not wait for it
 * again (that would make every fence pay the whole cap), and does not go ahead
 * around it either: it refuses at once, because the start may still land.
 */
let hungStartAfterMs = 10 * 60_000;

/** Test seam: shorten the waits so a hung start can be exercised. */
export function setStartDrainTimeoutForTests(ms: number, hungAfterMs = 10 * 60_000): void {
  startDrainTimeoutMs = ms;
  hungStartAfterMs = hungAfterMs;
}

/**
 * Run a start that must not land on a fenced volume.
 *
 * The check and the registration are one synchronous step with the fence write
 * that closes the other side (`setFenceState` is synchronous too), so a start
 * either sees the fence and is refused, or is registered before the fence exists
 * and is waited for by `applyRestoreFence`. There is no third order. It guards the
 * starts Sencho makes of a single container (the start and restart of
 * `DockerController`) and the Files & Volumes helper container; `subject` words
 * the refusal for whichever asked. A fence's own
 * release and the recovery helper's containers start without it on purpose, and
 * a Compose lifecycle is held by the stack lock instead.
 */
export function startUnderFence<T>(
  volumeNames: readonly string[],
  start: () => Promise<T>,
  subject: FenceSubject = 'container',
  /**
   * A refusal to evaluate in the same synchronous step as the registration. The
   * directory match is asynchronous, so it runs before; this re-reads the
   * fenced directories here and refuses one that appeared after the match.
   */
  recheck?: () => DataRestoreFenceError | null,
): Promise<T> {
  const fenced = RestoreFenceStore.getInstance().liveFencedVolumeNames();
  const hit = volumeNames.find((name) => fenced.includes(name));
  if (hit) return Promise.reject(new DataRestoreFenceError(hit, subject));
  const late = recheck?.() ?? null;
  if (late) return Promise.reject(late);
  let run: Promise<T>;
  try {
    run = start();
  } catch (err) {
    return Promise.reject(err);
  }
  const settled = run.then(() => undefined, () => undefined);
  startsInFlight.set(settled, performance.now());
  void settled.then(() => startsInFlight.delete(settled));
  return run;
}

/**
 * Wait until every start that is in flight now has been answered. False means a
 * start was still unanswered when the cap ran out, so the caller cannot treat the
 * containers it observes as settled and must not stop them as if they were.
 *
 * A start that has itself been pending for ten minutes is a hung daemon call. It
 * is not waited for (one hung call must not make every later fence pay the whole
 * cap), but it is not stepped around either: it may still land on the volume, so
 * the answer is false at once, the same as when the cap runs out. The refusal
 * lasts until that call answers or Sencho restarts, and it is not scoped to the
 * volume: a start registers before anyone knows what it mounts.
 */
export async function waitForStartsInFlight(timeoutMs = startDrainTimeoutMs): Promise<boolean> {
  const now = performance.now();
  const hung = [...startsInFlight.values()].filter((startedAt) => now - startedAt >= hungStartAfterMs);
  if (hung.length > 0) {
    // Not volume-scoped: a start registers before anyone knows which volumes it
    // mounts, so any hung start refuses every fence until it answers.
    console.warn('[Recovery] %d container start(s) have been pending for over %d seconds; refusing the fence.', hung.length, Math.round(hungStartAfterMs / 1000));
    return false;
  }
  const pending = [...startsInFlight.keys()];
  if (pending.length === 0) return true;
  let timer: NodeJS.Timeout | undefined;
  const capped = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([Promise.all(pending).then(() => true), capped]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Wait for the work a fence just recorded must not run under: every container
 * start in flight, and, for a host directory, every stack file operation on it
 * (see `waitForFsWorkOn`). Null when all of it has finished; otherwise which kind
 * did not, and the fence is refused.
 */
export async function waitForWorkBeforeFence(fsTarget: FsTargetPaths | null): Promise<'start' | 'file_operation' | null> {
  if (!await waitForStartsInFlight()) return 'start';
  if (fsTarget && !await waitForFsWorkOn(fsTarget)) return 'file_operation';
  return null;
}

/**
 * Start or restart one container unless a volume it mounts is fenced. Called
 * from `DockerController`, through which every single-container start and
 * restart of the Sencho process passes. The mounts are read only while a fence is live, so
 * the common case costs one query; the registration still happens, because a
 * fence installed a moment later has to find this start.
 */
export async function startContainerUnderFence<T>(
  docker: FenceDocker,
  containerId: string,
  start: () => Promise<T>,
): Promise<T> {
  if (RestoreFenceStore.getInstance().liveFencedVolumeNames().length === 0) return startUnderFence([], start);
  let mounts: Array<{ Type?: string; Name?: string; Source?: string; RW?: boolean }>;
  try {
    const inspected = await (docker.getContainer(containerId) as unknown as InspectableContainer).inspect();
    mounts = inspected.Mounts ?? [];
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return startUnderFence([], start);
    throw err;
  }
  const names = mounts
    .filter((m) => m.Type === 'volume' && m.Name !== undefined)
    .map((m) => m.Name as string);
  // A host directory under a fence is matched by the dependency rule: a bind of
  // it, of a path inside it, or of an ancestor that can write it. A read-only
  // ancestor (a monitoring agent) still starts.
  const fsTargets = RestoreFenceStore.getInstance().liveFencedFsTargets();
  const bindsHostPath = mounts.some((m) => m.Type === 'bind');
  const checked = new Set<string>();
  if (fsTargets.length > 0 && bindsHostPath) {
    const { matchContainerToRoot, readOwnMounts } = await import('./fsRoots');
    // `null` means Sencho is not in a container, so its paths are the host's.
    // Mounts that cannot be read are not that: without them a symlinked or
    // second spelling of the fenced directory cannot be recognised, so a start
    // that binds any host path is refused until they can be read again.
    const ownMounts = await readOwnMounts().catch(() => 'unreadable' as const);
    if (ownMounts === 'unreadable') {
      return Promise.reject(new DataRestoreFenceError(fsTargets[0].hostPath, 'unproven', 'directory'));
    }
    for (const target of fsTargets) {
      const match = await matchContainerToRoot({ Mounts: mounts }, target, ownMounts);
      if (match.depends) {
        return Promise.reject(new DataRestoreFenceError(target.hostPath, 'container', 'directory'));
      }
      // A bind whose relationship to the fenced directory could not be read
      // could be another spelling of it: refused like an unreadable mount table.
      if (match.unproven) {
        return Promise.reject(new DataRestoreFenceError(target.hostPath, 'unproven', 'directory'));
      }
      checked.add(target.hostPath);
    }
  }
  // A directory fenced after the match above was never compared with this
  // container. It is refused at registration, which is synchronous with the
  // fence write, so a fence is either matched or seen here; the caller retries.
  const recheck = (): DataRestoreFenceError | null => {
    if (!bindsHostPath) return null;
    const unchecked = RestoreFenceStore.getInstance().liveFencedFsTargets().find((target) => !checked.has(target.hostPath));
    return unchecked ? new DataRestoreFenceError(unchecked.hostPath, 'recheck', 'directory') : null;
  };
  return startUnderFence(names, start, 'container', recheck);
}

// --- Stack file work under a directory fence --------------------------------

/** How a fenced directory is told apart from another in a `checked` set. */
function fsTargetMatchKey(target: FsTargetPaths): string {
  return `${target.senchoPath}\0${target.hostPath}`;
}

/** The fenced directories a file operation was compared with and found clear of, and its refusal if it was not. */
export interface FsWorkMatch {
  refusal: DataRestoreFenceError | null;
  checked: ReadonlySet<string>;
}

/** The paths one piece of file work is known by: one, or every spelling a link on the way gives it. */
function spellingsOf(senchoPaths: string | readonly string[]): readonly string[] {
  return typeof senchoPaths === 'string' ? [senchoPaths] : senchoPaths;
}

/**
 * How one piece of file work, known by each of `spellings`, sits relative to a
 * fenced directory: `overlap` when any spelling overlaps it, else `unknown`
 * when any spelling cannot be placed, else `unrelated`.
 */
async function relateSpellingsToFencedDirectory(
  spellings: readonly string[],
  target: FsTargetPaths,
  ownMounts: OwnMounts | 'unreadable',
): Promise<'overlap' | 'unrelated' | 'unknown'> {
  const { relateToFencedDirectory } = await import('./fsRoots');
  let unknown = false;
  for (const spelling of spellings) {
    const relation = await relateToFencedDirectory(spelling, target, ownMounts);
    if (relation === 'overlap') return 'overlap';
    if (relation === 'unknown') unknown = true;
  }
  return unknown ? 'unknown' : 'unrelated';
}

/**
 * Compare a file or directory a stack file operation reads or writes, in
 * Sencho's namespace, with every directory a live overwrite holds, by each
 * spelling either has (see `relateToFencedDirectory`). A file reached through
 * links is passed with every spelling the links give it (`linkSpellings`): a
 * link whose target a restore has just moved aside resolves to nothing, so its
 * own path alone would look unrelated to the directory it points into. An
 * overlap by any spelling is refused, and so is a relationship that cannot be
 * proven. One query when nothing is fenced.
 */
export async function matchFsWorkToFences(senchoPaths: string | readonly string[]): Promise<FsWorkMatch> {
  const targets = RestoreFenceStore.getInstance().liveFencedFsTargets();
  const checked = new Set<string>();
  if (targets.length === 0) return { refusal: null, checked };
  const { readOwnMounts } = await import('./fsRoots');
  const ownMounts = await readOwnMounts().catch(() => 'unreadable' as const);
  const spellings = spellingsOf(senchoPaths);
  for (const target of targets) {
    const relation = await relateSpellingsToFencedDirectory(spellings, target, ownMounts);
    if (relation === 'overlap') return { refusal: new DataRestoreFenceError(target.hostPath, 'browse', 'directory'), checked };
    if (relation === 'unknown') return { refusal: new DataRestoreFenceError(target.hostPath, 'unproven', 'directory'), checked };
    checked.add(fsTargetMatchKey(target));
  }
  return { refusal: null, checked };
}

/** A stack file operation admitted against the directory fences, held until it has finished. */
export interface FsWorkLease {
  /**
   * The refusal for a directory fenced since this work was admitted that it has
   * not been proven clear of, or null. Synchronous: work that does more than one
   * step (the items of a bulk operation, an upload after its body arrived) asks
   * before each one, so a fence waiting for it does not wait for the rest.
   */
  recheck(): DataRestoreFenceError | null;
  /**
   * How to cut this work off instead of waiting for it, or null when it must be
   * waited for. A read, or an upload still receiving its body, writes nothing
   * the restore replaces, so a fence ends it at once rather than letting a slow
   * client hold the restore off; a write already under way is waited for.
   */
  setAbort(abort: (() => void) | null): void;
  /** The work has finished. Idempotent. */
  release(): void;
}

interface FsWorkEntry {
  /** Every spelling the work was matched by, so a fence's drain compares the same ones. */
  senchoPaths: readonly string[];
  startedAt: number;
  /** Fenced directories this work is proven clear of; a fence's drain adds to it. */
  checked: Set<string>;
  abort: (() => void) | null;
  done: Promise<void>;
}

/** Stack file operations admitted and not finished. */
const fsWorkInFlight = new Set<FsWorkEntry>();

function uncheckedFsFence(checked: ReadonlySet<string>): DataRestoreFenceError | null {
  const unchecked = RestoreFenceStore.getInstance().liveFencedFsTargets()
    .find((target) => !checked.has(fsTargetMatchKey(target)));
  return unchecked ? new DataRestoreFenceError(unchecked.hostPath, 'files_recheck', 'directory') : null;
}

/**
 * Admit a stack file operation that `matchFsWorkToFences` cleared, or refuse it.
 *
 * The check and the registration are one synchronous step, as for a container
 * start, and the fence write that closes the other side is synchronous too: the
 * work either sees a directory fenced after its match and is refused, or is
 * registered before the fence exists and is waited for by `waitForFsWorkOn`.
 */
export function admitFsWork(
  senchoPaths: string | readonly string[],
  checked: ReadonlySet<string>,
  abort: (() => void) | null = null,
): FsWorkLease | DataRestoreFenceError {
  const late = uncheckedFsFence(checked);
  if (late) return late;
  let settle: () => void = () => undefined;
  const entry: FsWorkEntry = {
    senchoPaths: spellingsOf(senchoPaths),
    startedAt: performance.now(),
    checked: new Set(checked),
    abort,
    done: new Promise<void>((resolve) => { settle = resolve; }),
  };
  fsWorkInFlight.add(entry);
  return {
    recheck: () => (fsWorkInFlight.has(entry) ? uncheckedFsFence(entry.checked) : null),
    setAbort: (next) => { entry.abort = next; },
    release: () => {
      if (!fsWorkInFlight.delete(entry)) return;
      settle();
    },
  };
}

/** Test seam: how many stack file operations are admitted and unfinished. */
export function fsWorkInFlightCountForTests(): number {
  return fsWorkInFlight.size;
}

/**
 * Wait until every stack file operation that overlaps `target`, or whose
 * relationship to it cannot be proven, has finished. One that can be cut off
 * (a read, an upload still receiving its body) is cut off instead, and one
 * whose cut-off fails is waited for. Called after the fence on
 * `target` is recorded, so no operation can be admitted on it from then on and
 * the set looked at here is complete. An operation proven clear of it is marked
 * so, and its rechecks pass. False means one was still running when the cap ran
 * out, or has been running long enough to count as hung: the fence is refused
 * rather than taken under work that may still write.
 */
export async function waitForFsWorkOn(target: FsTargetPaths, timeoutMs = startDrainTimeoutMs): Promise<boolean> {
  const entries = [...fsWorkInFlight];
  if (entries.length === 0) return true;
  const { readOwnMounts } = await import('./fsRoots');
  const ownMounts = await readOwnMounts().catch(() => 'unreadable' as const);
  const key = fsTargetMatchKey(target);
  const pending: FsWorkEntry[] = [];
  for (const entry of entries) {
    if (!fsWorkInFlight.has(entry)) continue;
    if (await relateSpellingsToFencedDirectory(entry.senchoPaths, target, ownMounts) === 'unrelated') entry.checked.add(key);
    else pending.push(entry);
  }
  // Work that writes nothing yet is cut off, not waited for: a client that reads
  // slowly, or sends an upload slowly, cannot hold the restore off that way.
  // One whose cut-off failed is waited for like a write.
  const cutOff = new Set<FsWorkEntry>();
  for (const entry of pending) {
    const abort = entry.abort;
    if (!abort || !fsWorkInFlight.has(entry)) continue;
    try {
      abort();
      cutOff.add(entry);
    } catch (err) {
      console.warn('[Recovery] Could not cut off a file operation on the directory:', errorMessageForLog(err));
    }
  }
  const live = pending.filter((entry) => fsWorkInFlight.has(entry) && !cutOff.has(entry));
  if (live.length === 0) return true;
  const now = performance.now();
  if (live.some((entry) => now - entry.startedAt >= hungStartAfterMs)) {
    console.warn('[Recovery] A file operation on the directory has been running for over %d seconds; refusing the fence.', Math.round(hungStartAfterMs / 1000));
    return false;
  }
  let timer: NodeJS.Timeout | undefined;
  const capped = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([Promise.all(live.map((entry) => entry.done)).then(() => true), capped]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The stack and project names to record for a container. The stack is resolved
 * from the Compose project label through the same map the recovery routes use,
 * and the container's own project label is kept because a caller can key the
 * workload by either spelling.
 */
export function fenceIdentityFor(
  container: { Labels?: Record<string, string> },
  projectToStack: ReadonlyMap<string, string>,
  knownStackNames: readonly string[],
): { stackName: string | null; projectName: string | null } {
  const projectName = container.Labels?.['com.docker.compose.project'] ?? null;
  if (!projectName) return { stackName: null, projectName: null };
  const stackName = projectToStack.get(projectName)
    ?? (knownStackNames.includes(projectName) ? projectName : null);
  return { stackName, projectName };
}
