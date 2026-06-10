import { randomUUID } from 'crypto';
import DockerController from './DockerController';
import { DatabaseService, type HealthGateRunRow } from './DatabaseService';
import { sanitizeForLog } from '../utils/safeLog';
import { getErrorMessage } from '../utils/errors';
import type { HealthGateContainer, HealthGateReport } from './updateGuard/types';

const POLL_INTERVAL_MS = 5_000;
// A stack whose containers never appear gives up after this long.
const EMPTY_GRACE_MS = 15_000;
const DEFAULT_WINDOW_SECONDS = 90;
const MIN_WINDOW_SECONDS = 15;
const MAX_WINDOW_SECONDS = 600;
// Backstop against runaway concurrency (a burst of webhook or scheduled
// updates). Gates past the cap finalize immediately as unknown.
const MAX_CONCURRENT_GATES = 25;

interface ObservedContainer {
  id: string;
  name: string;
  startedAt: string | null;
  /** Docker's raw RestartCount at observation time. */
  restartCount: number;
  /** Gate-maintained restart tally since the baseline; 0 on a fresh snapshot,
   *  set by poll()'s accounting pass, at most one increment per poll. */
  restarts: number;
  state: string;
  health: string | null;
}

interface ActiveGate {
  runId: string;
  nodeId: number;
  stackName: string;
  windowSeconds: number;
  startedAt: number;
  timer: ReturnType<typeof setInterval>;
  /** Expected container set, keyed by name; null until the first non-empty poll. */
  expected: Map<string, ObservedContainer> | null;
  consecutivePollErrors: number;
  /** Names missing on the previous poll (two consecutive misses fail the gate). */
  missingLastPoll: Set<string>;
  /** Names in `restarting` state on the previous poll. */
  restartingLastPoll: Set<string>;
  /**
   * Set by finalize so a poll that was mid-await when this gate was superseded
   * or stopped can never overwrite the terminal verdict with a stale one.
   */
  finalized: boolean;
}

/**
 * Post-update health gate: after a deploy/update succeeds, observe the
 * stack's containers for a configurable window and record a passed / failed /
 * unknown verdict plus an activity timeline event. Purely observational: it
 * never restarts, heals, or rolls anything back. AutoHeal needs no special
 * handling: the unhealthy or exited state that triggers it is seen by the
 * gate's own polls and fails the gate, and repeated restarts trip the
 * restart-loop check.
 *
 * begin() is the single shared post-success hook for every gated deploy and
 * update path; excluded paths (rollback, installs, reconciler loops) simply
 * never call it.
 */
export class HealthGateService {
  private static instance: HealthGateService;
  private readonly active = new Map<string, ActiveGate>();
  private started = false;

  public static getInstance(): HealthGateService {
    if (!HealthGateService.instance) {
      HealthGateService.instance = new HealthGateService();
    }
    return HealthGateService.instance;
  }

  /** Sweep runs left observing by a previous process, then accept begin() calls. */
  public start(): void {
    this.started = true;
    try {
      const swept = DatabaseService.getInstance().markInterruptedHealthGateRuns(
        'Sencho restarted during observation', Date.now(),
      );
      if (swept > 0) {
        console.log(`[HealthGate] Marked ${swept} interrupted observation(s) as unknown`);
      }
    } catch (error) {
      console.error('[HealthGate] Startup sweep failed:', getErrorMessage(error, 'unknown'));
    }
  }

  /** Clear every poll timer and finalize in-flight gates as unknown. */
  public stop(): void {
    this.started = false;
    for (const gate of [...this.active.values()]) {
      this.finalize(gate, 'unknown', 'shutdown during observation', []);
    }
  }

  /**
   * Begin observing a stack after a successful deploy/update. Returns the gate
   * run id for response correlation, or null when gating is disabled, the
   * service is not started, or recording fails internally. Inserts the row
   * synchronously so the caller can include the id in its response;
   * observation then runs on a timer. Never throws.
   *
   * Also records the `update_started` activity event for update triggers, so
   * every gated update path gets the timeline marker even when the gate
   * itself is disabled.
   */
  public begin(
    nodeId: number,
    stackName: string,
    trigger: 'update' | 'deploy',
    actor: string | null,
  ): string | null {
    // Refuses work outside the start()/stop() lifecycle so a late call during
    // shutdown cannot leave a dangling poll timer.
    if (!this.started) return null;
    try {
      const db = DatabaseService.getInstance();
      const settings = this.readSettings();

      if (trigger === 'update') {
        this.recordActivity(nodeId, stackName, 'info', 'update_started', `${stackName} update started`, actor);
      }
      if (!settings.enabled) return null;

      // A newer operation supersedes an in-flight gate for the same stack.
      const key = `${nodeId}:${stackName}`;
      const existing = this.active.get(key);
      if (existing) {
        this.finalize(existing, 'unknown', 'superseded by a newer update', []);
      }

      const runId = randomUUID();
      const startedAt = Date.now();
      const row: HealthGateRunRow = {
        id: runId,
        node_id: nodeId,
        stack_name: stackName,
        trigger_action: trigger,
        status: 'observing',
        reason: null,
        window_seconds: settings.windowSeconds,
        containers_json: '[]',
        started_at: startedAt,
        ended_at: null,
        created_by: actor,
      };

      if (this.active.size >= MAX_CONCURRENT_GATES) {
        db.insertHealthGateRun({ ...row, status: 'unknown', reason: 'too many concurrent observations', ended_at: startedAt });
        return runId;
      }

      db.insertHealthGateRun(row);
      const gate: ActiveGate = {
        runId,
        nodeId,
        stackName,
        windowSeconds: settings.windowSeconds,
        startedAt,
        timer: setInterval(() => { void this.poll(gate); }, POLL_INTERVAL_MS),
        expected: null,
        consecutivePollErrors: 0,
        missingLastPoll: new Set(),
        restartingLastPoll: new Set(),
        finalized: false,
      };
      this.active.set(key, gate);
      return runId;
    } catch (error) {
      // The gate is an observer; its failure must never fail the operation.
      console.error(
        `[HealthGate] begin (${trigger}) failed for ${sanitizeForLog(stackName)} on node ${nodeId}:`,
        error,
      );
      return null;
    }
  }

  /** A specific run by id, the latest run, or the never-run sentinel. */
  public getReport(nodeId: number, stackName: string, gateId?: string): HealthGateReport {
    const db = DatabaseService.getInstance();
    const row = gateId
      ? db.getHealthGateRun(nodeId, stackName, gateId)
      : db.getLatestHealthGateRun(nodeId, stackName);
    if (!row) {
      return {
        stack: stackName, id: null, status: 'never-run', trigger: null, reason: null,
        windowSeconds: null, startedAt: null, endedAt: null, containers: [],
      };
    }
    let containers: HealthGateContainer[] = [];
    try {
      const parsed: unknown = JSON.parse(row.containers_json);
      if (Array.isArray(parsed)) containers = parsed as HealthGateContainer[];
    } catch {
      // A corrupt blob only loses the per-container detail, never the verdict.
      console.warn('[HealthGate] Unreadable containers_json for run %s', sanitizeForLog(row.id));
    }
    return {
      stack: stackName,
      id: row.id,
      status: row.status,
      trigger: row.trigger_action,
      reason: row.reason,
      windowSeconds: row.window_seconds,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      containers,
    };
  }

  private async poll(gate: ActiveGate): Promise<void> {
    const key = `${gate.nodeId}:${gate.stackName}`;
    if (this.active.get(key) !== gate) return; // superseded or stopped mid-flight

    let observed: ObservedContainer[];
    try {
      observed = await this.observeContainers(gate);
    } catch (error) {
      gate.consecutivePollErrors += 1;
      console.warn(
        '[HealthGate] poll error %d for %s:',
        gate.consecutivePollErrors, sanitizeForLog(gate.stackName), getErrorMessage(error, 'unknown'),
      );
      if (gate.consecutivePollErrors >= 3) {
        this.finalize(gate, 'unknown', 'Docker became unreachable during observation', []);
      }
      return;
    }
    // The await above can straddle a supersede or stop; never act on a gate
    // that was finalized mid-flight.
    if (gate.finalized || this.active.get(key) !== gate) return;
    gate.consecutivePollErrors = 0;

    const elapsedMs = Date.now() - gate.startedAt;

    if (gate.expected === null) {
      if (observed.length > 0) {
        gate.expected = new Map(observed.map(c => [c.name, c]));
      } else if (elapsedMs >= EMPTY_GRACE_MS) {
        this.finalize(gate, 'unknown', 'no containers found to observe', []);
      }
      return;
    }

    const byName = new Map(observed.map(c => [c.name, c]));

    // First pass: restart accounting for every expected container still
    // present, so the summary below reflects the tallies the checks act on. A
    // restart counts when the container was replaced (new id), relaunched
    // (StartedAt moved), or Docker bumped its RestartCount; at most one
    // restart is tallied per poll regardless of how many occurred in the gap.
    for (const [name, baseline] of gate.expected) {
      const current = byName.get(name);
      if (!current) continue;
      const restarted =
        current.id !== baseline.id ||
        current.restartCount > baseline.restartCount ||
        (current.startedAt !== null && baseline.startedAt !== null && current.startedAt !== baseline.startedAt);
      current.restarts = baseline.restarts + (restarted ? 1 : 0);
    }
    const summary = this.summarize(gate.expected, byName);

    // Second pass: fail fast on a clearly bad state.
    for (const [name, baseline] of gate.expected) {
      const current = byName.get(name);
      if (!current) {
        if (gate.missingLastPoll.has(name)) {
          this.finalize(gate, 'failed', `container ${name} disappeared during observation`, summary);
          return;
        }
        gate.missingLastPoll.add(name);
        continue;
      }
      gate.missingLastPoll.delete(name);

      if (current.state === 'exited' && baseline.restarts === current.restarts) {
        // An exit with no restart attempt is terminal for the window.
        this.finalize(gate, 'failed', `container ${name} exited during observation`, summary);
        return;
      }
      if (current.health === 'unhealthy') {
        this.finalize(gate, 'failed', `container ${name} reported unhealthy`, summary);
        return;
      }
      if (current.restarts >= 2) {
        this.finalize(gate, 'failed', `container ${name} is restart looping`, summary);
        return;
      }
      if (current.state === 'restarting') {
        if (gate.restartingLastPoll.has(name)) {
          this.finalize(gate, 'failed', `container ${name} is stuck restarting`, summary);
          return;
        }
        gate.restartingLastPoll.add(name);
      } else {
        gate.restartingLastPoll.delete(name);
      }
      // Carry the running restart tally forward as the new baseline.
      gate.expected.set(name, current);
    }

    if (elapsedMs < gate.windowSeconds * 1000) return;

    // Window complete: pass requires everything running and healthy wherever a
    // healthcheck exists. A health state still 'starting' is not a pass.
    const stillStarting = observed.filter(c => c.health === 'starting');
    if (stillStarting.length > 0) {
      this.finalize(gate, 'unknown', 'a healthcheck was still starting when the observation window ended', summary);
      return;
    }
    const notRunning = [...gate.expected.keys()].filter(name => byName.get(name)?.state !== 'running');
    if (notRunning.length > 0) {
      this.finalize(gate, 'failed', `not running at the end of the window: ${notRunning.join(', ')}`, summary);
      return;
    }
    this.finalize(gate, 'passed', null, summary);
  }

  private async observeContainers(gate: ActiveGate): Promise<ObservedContainer[]> {
    const docker = DockerController.getInstance(gate.nodeId).getDocker();
    const listed = await docker.listContainers({
      all: true,
      filters: { label: [`com.docker.compose.project=${gate.stackName}`] },
    });
    const observed = await Promise.all(
      listed.map(async (info): Promise<ObservedContainer | null> => {
        try {
          const inspect = await docker.getContainer(info.Id).inspect();
          return {
            id: info.Id,
            name: info.Names?.[0]?.replace(/^\//, '') ?? info.Id.slice(0, 12),
            startedAt: inspect.State?.StartedAt ?? null,
            restartCount: typeof inspect.RestartCount === 'number' ? inspect.RestartCount : 0,
            restarts: 0,
            state: inspect.State?.Status ?? info.State ?? 'unknown',
            health: inspect.State?.Health?.Status ?? null,
          };
        } catch (e: unknown) {
          // Removed between list and inspect; the missing-container logic will
          // see its absence on this or the next poll.
          if ((e as { statusCode?: number })?.statusCode === 404) return null;
          throw e;
        }
      }),
    );
    return observed.filter((c): c is ObservedContainer => c !== null);
  }

  private summarize(
    expected: Map<string, ObservedContainer>,
    current: Map<string, ObservedContainer>,
  ): HealthGateContainer[] {
    return [...expected.values()].map(baseline => {
      const now = current.get(baseline.name);
      return {
        name: baseline.name,
        state: now?.state ?? 'missing',
        health: now?.health ?? null,
        restarts: now?.restarts ?? baseline.restarts,
      };
    });
  }

  private finalize(
    gate: ActiveGate,
    status: 'passed' | 'failed' | 'unknown',
    reason: string | null,
    containers: HealthGateContainer[],
  ): void {
    if (gate.finalized) return;
    gate.finalized = true;
    clearInterval(gate.timer);
    const key = `${gate.nodeId}:${gate.stackName}`;
    if (this.active.get(key) === gate) this.active.delete(key);

    try {
      DatabaseService.getInstance().finalizeHealthGateRun(
        gate.runId, status, reason, Date.now(), JSON.stringify(containers),
      );
    } catch (error) {
      // The verdict is lost from the DB (the startup sweep will later rewrite
      // the row as unknown), so log everything needed to reconstruct it.
      console.error(
        `[HealthGate] Failed to persist verdict ${status} (${sanitizeForLog(reason ?? 'no reason')}) for run ${gate.runId}, stack ${sanitizeForLog(gate.stackName)}:`,
        getErrorMessage(error, 'unknown'),
      );
    }

    if (status === 'passed') {
      this.recordActivity(gate.nodeId, gate.stackName, 'info', 'health_gate_passed',
        `${gate.stackName} health gate passed after ${gate.windowSeconds}s`, 'system');
    } else if (status === 'failed') {
      this.recordActivity(gate.nodeId, gate.stackName, 'warning', 'health_gate_failed',
        `${gate.stackName} health gate failed: ${reason ?? 'unknown reason'}`, 'system');
    }
  }

  private recordActivity(
    nodeId: number,
    stackName: string,
    level: 'info' | 'warning',
    category: 'update_started' | 'health_gate_passed' | 'health_gate_failed',
    message: string,
    actor: string | null,
  ): void {
    try {
      DatabaseService.getInstance().addNotificationHistory(nodeId, {
        level,
        category,
        message,
        timestamp: Date.now(),
        stack_name: stackName,
        actor_username: actor,
      });
    } catch (error) {
      console.warn('[HealthGate] Failed to record activity for %s:', sanitizeForLog(stackName), getErrorMessage(error, 'unknown'));
    }
  }

  private readSettings(): { enabled: boolean; windowSeconds: number } {
    try {
      const settings = DatabaseService.getInstance().getGlobalSettings();
      const windowRaw = parseInt(settings['health_gate_window_seconds'] ?? '', 10);
      const windowSeconds = Number.isFinite(windowRaw)
        ? Math.min(MAX_WINDOW_SECONDS, Math.max(MIN_WINDOW_SECONDS, windowRaw))
        : DEFAULT_WINDOW_SECONDS;
      return { enabled: settings['health_gate_enabled'] !== '0', windowSeconds };
    } catch (error) {
      // Safe default: observing is non-destructive, so a settings read
      // failure keeps the gate on with the default window.
      console.warn('[HealthGate] Settings read failed; using defaults:', getErrorMessage(error, 'unknown'));
      return { enabled: true, windowSeconds: DEFAULT_WINDOW_SECONDS };
    }
  }
}
