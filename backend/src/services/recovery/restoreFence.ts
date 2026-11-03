import type Docker from 'dockerode';
import { errorMessageForLog, sanitizeForLog } from '../../utils/safeLog';
import { DataRestoreFenceError } from '../../helpers/dataRestoreFenceError';
import { recoveryDb } from './recoveryDb';
import { RecoveryError } from './redaction';
import type { RestoreFenceState } from './restoreIntents';

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
 * through `DockerController`, and the Files & Volumes browser. The fence matches
 * containers by what they mount, never by comparing a Compose project label to a
 * stack name: the two can differ (a `name:` key, or case), and an old container
 * from an earlier project would be missed.
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

/** Test seam: allow the warning again. */
export function resetRestoreFenceWarningForTests(): void {
  warnedUnreadable = false;
}

function warnStoreUnreadable(err: unknown): void {
  if (warnedUnreadable) return;
  warnedUnreadable = true;
  console.warn(
    '[Recovery] The restore fence store cannot be read, so Sencho cannot tell which volumes are fenced: %s',
    errorMessageForLog(err),
  );
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
    Mounts?: Array<{ Type?: string; Name?: string }>;
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
 * `DockerController`) and the Files & Volumes helper container. A fence's own
 * release and the recovery helper's containers start without it on purpose, and
 * a Compose lifecycle is held by the stack lock instead.
 */
export function startUnderFence<T>(volumeNames: readonly string[], start: () => Promise<T>): Promise<T> {
  const fenced = RestoreFenceStore.getInstance().liveFencedVolumeNames();
  const hit = volumeNames.find((name) => fenced.includes(name));
  if (hit) return Promise.reject(new DataRestoreFenceError(hit));
  let run: Promise<T>;
  try {
    run = start();
  } catch (err) {
    return Promise.reject(err);
  }
  const settled = run.then(() => undefined, () => undefined);
  startsInFlight.set(settled, Date.now());
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
 * lasts until that call answers or Sencho restarts.
 */
export async function waitForStartsInFlight(timeoutMs = startDrainTimeoutMs): Promise<boolean> {
  const now = Date.now();
  if ([...startsInFlight.values()].some((startedAt) => now - startedAt >= hungStartAfterMs)) return false;
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
  let mounts: Array<{ Type?: string; Name?: string }>;
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
  return startUnderFence(names, start);
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
