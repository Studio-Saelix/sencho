import { randomUUID } from 'crypto';
import DockerController from './DockerController';
import { DatabaseService, type HealthGateRunRow } from './DatabaseService';
import { AutoHealService } from './AutoHealService';
import { sanitizeForLog } from '../utils/safeLog';
import { getErrorMessage } from '../utils/errors';
import { withTimeout } from '../utils/withTimeout';
import type { HealthGateContainer, HealthGateReport } from './updateGuard/types';
import { getComposeCommandTimeoutMs } from './ComposeService';

const POLL_INTERVAL_MS = 5_000;
// A prepared-but-never-begun token (prepare called, mutation then failed before
// beginPrepared) is dropped after this long. Swept lazily on each prepare/
// attach/beginPrepared call rather than on a timer, so the service leaves no
// standing interval (the observation poll timers are the only timers it arms).
// Must outlive the longest Compose mutation (compose timeout + 5m buffer).
function prepareTtlMs(): number {
  return Math.max(getComposeCommandTimeoutMs(), 30 * 60_000) + 5 * 60_000;
}
// Per-observe ceiling so a hung Docker socket cannot leave a poll pending
// forever. Above POLL_INTERVAL_MS so a slow-but-live probe is not cut short; a
// timeout counts as a poll error and three in a row resolve the gate unknown.
const OBSERVE_TIMEOUT_MS = 8_000;
// A stack whose containers never appear gives up after this long.
const EMPTY_GRACE_MS = 15_000;
const DEFAULT_WINDOW_SECONDS = 90;
const MIN_WINDOW_SECONDS = 15;
const MAX_WINDOW_SECONDS = 600;
// Backstop against runaway concurrency (a burst of webhook or scheduled
// updates). Gates past the cap finalize immediately as unknown.
const MAX_CONCURRENT_GATES = 25;

type GateRole = 'primary' | 'collateral';

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
  /** `com.docker.compose.service` label, when present (service gates only). */
  service: string | null;
  /** Image id the container is running (service gates check convergence on it). */
  imageId: string;
}

interface ActiveGate {
  runId: string;
  nodeId: number;
  stackName: string;
  windowSeconds: number;
  startedAt: number;
  /** Self-scheduling poll timer, armed only between settled poll cycles. */
  timer: ReturnType<typeof setTimeout> | null;
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
  /** 'stack' for the legacy post-mutation gate, 'service' for prepared gates. */
  targetScope: 'stack' | 'service';
  /** Named trigger persisted on the row. */
  trigger: 'update' | 'deploy' | 'service_update' | 'service_restore';
  /** Service gates only. */
  serviceName: string | null;
  /** Single image id every primary replica must converge on (service gates). */
  expectedImageId: string | null;
  /** Expected primary replica count from the effective model (service gates; may be 0). */
  expectedReplicas: number;
  /** Sibling names eligible for regression evaluation (service gates). */
  collateralEligibleNames: Set<string>;
  /** Role of each expected container (service gates), for failure attribution. */
  roleByName: Map<string, GateRole>;
}

/** A pre-mutation baseline container captured at prepare time. */
interface PreparedBaseline {
  id: string;
  name: string;
  service: string | null;
  state: string;
  health: string | null;
  restartCount: number;
  startedAt: string | null;
  imageId: string;
}

function isRegressionEligibleSibling(baseline: PreparedBaseline): boolean {
  return baseline.state === 'running' && (baseline.health === null || baseline.health === 'healthy');
}

/** An in-memory prepare snapshot awaiting attachExpectedImage + beginPrepared. */
interface PreparedGate {
  token: string;
  nodeId: number;
  stackName: string;
  serviceName: string;
  trigger: 'service_update' | 'service_restore';
  windowSeconds: number;
  expiresAt: number;
  expectedReplicas: number;
  expectedImageId: string | null;
  collateralEligibleNames: Set<string>;
  primaryBaseline: PreparedBaseline[];
  collateralBaseline: PreparedBaseline[];
}

export interface PrepareInput {
  nodeId: number;
  stackName: string;
  target: { scope: 'service'; serviceName: string };
  trigger: 'service_update' | 'service_restore';
  /**
   * Expected primary replica count from the effective model (may be 0). Passed
   * by the orchestrator, which already rendered the model, so the gate stays a
   * pure observer and does not run a second `docker compose config`.
   */
  expectedReplicas: number;
}

export interface BeginPreparedResult {
  runId: string | null;
  observing: boolean;
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
  /** Prepare tokens awaiting beginPrepared (service update/restore only). */
  private readonly prepared = new Map<string, PreparedGate>();
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
    this.prepared.clear();
  }

  private gateKey(nodeId: number, stackName: string, scope: 'stack' | 'service', serviceName: string | null): string {
    return `${nodeId}:${stackName}:${scope}:${serviceName ?? '_'}`;
  }

  /**
   * Finalize every in-flight gate for one stack as superseded, regardless of
   * scope or service, before a newer operation begins. A stack gate supersedes
   * an in-flight service gate and vice versa; the per-stack lock means only one
   * begins at a time in practice.
   */
  private supersedeGatesForStack(nodeId: number, stackName: string): void {
    for (const gate of [...this.active.values()]) {
      if (gate.nodeId === nodeId && gate.stackName === stackName) {
        this.finalize(gate, 'unknown', 'superseded by a newer operation', []);
      }
    }
  }

  /** Drop prepare tokens whose TTL elapsed without a beginPrepared (lazy, no standing timer). */
  private sweepExpiredPrepared(now: number): void {
    for (const [token, prep] of this.prepared) {
      if (now >= prep.expiresAt) this.prepared.delete(token);
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
  public beginStack(
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

      // A newer operation supersedes any in-flight gate for the same stack
      // (stack supersedes service and vice versa).
      const key = this.gateKey(nodeId, stackName, 'stack', null);
      this.supersedeGatesForStack(nodeId, stackName);

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
        target_scope: 'stack',
        service_name: null,
        failure_source: null,
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
        timer: null,
        expected: null,
        consecutivePollErrors: 0,
        missingLastPoll: new Set(),
        restartingLastPoll: new Set(),
        finalized: false,
        targetScope: 'stack',
        trigger,
        serviceName: null,
        expectedImageId: null,
        expectedReplicas: 0,
        collateralEligibleNames: new Set(),
        roleByName: new Map(),
      };
      this.active.set(key, gate);
      this.scheduleNextPoll(gate);
      return runId;
    } catch (error) {
      // The gate is an observer; its failure must never fail the operation.
      console.error(
        '[HealthGate] beginStack (%s) failed for %s on node %d:',
        trigger, sanitizeForLog(stackName), nodeId, error,
      );
      return null;
    }
  }

  /** @deprecated Prefer beginStack; retained as a one-PR alias for callers under migration. */
  public begin(
    nodeId: number,
    stackName: string,
    trigger: 'update' | 'deploy',
    actor: string | null,
  ): string | null {
    return this.beginStack(nodeId, stackName, trigger, actor);
  }

  /**
   * Pre-mutation snapshot for a service-scoped update/restore. Captures the
   * selected service's primary replicas and the sibling collateral set (marking
   * only currently-running, healthy or healthcheck-less siblings as
   * regression-eligible), and returns an opaque token the orchestrator carries
   * through attachExpectedImage and beginPrepared. Never throws: a Docker read
   * failure yields snapshotOk=false so the orchestrator can skip observation
   * rather than claim a gate with an empty baseline.
   */
  public async prepare(input: PrepareInput): Promise<{ prepareToken: string; expiresAt: number; snapshotOk: boolean }> {
    const now = Date.now();
    this.sweepExpiredPrepared(now);
    const { nodeId, stackName, trigger } = input;
    const serviceName = input.target.serviceName;
    const settings = this.readSettings();

    let baselines: PreparedBaseline[] = [];
    let snapshotOk = true;
    try {
      baselines = await this.snapshotBaselines(nodeId, stackName);
    } catch (error) {
      snapshotOk = false;
      console.warn('[HealthGate] prepare snapshot failed for %s/%s:',
        sanitizeForLog(stackName), sanitizeForLog(serviceName), getErrorMessage(error, 'unknown'));
    }

    const primaryBaseline = baselines.filter(b => b.service === serviceName);
    const collateralBaseline = baselines.filter(b => b.service !== serviceName);
    const collateralEligibleNames = new Set(
      collateralBaseline.filter(isRegressionEligibleSibling).map(b => b.name),
    );

    const token = randomUUID();
    const expiresAt = now + prepareTtlMs();
    this.prepared.set(token, {
      token,
      nodeId,
      stackName,
      serviceName,
      trigger,
      windowSeconds: settings.windowSeconds,
      expiresAt,
      expectedReplicas: input.expectedReplicas,
      expectedImageId: null,
      collateralEligibleNames,
      primaryBaseline,
      collateralBaseline,
    });
    return { prepareToken: token, expiresAt, snapshotOk };
  }

  /** Record the single image id every primary replica must converge on. No-op for an unknown/expired token. */
  public attachExpectedImage(prepareToken: string, expectedImageId: string): void {
    this.sweepExpiredPrepared(Date.now());
    const prep = this.prepared.get(prepareToken);
    if (!prep) {
      console.warn('[HealthGate] attachExpectedImage: unknown or expired prepare token');
      return;
    }
    prep.expectedImageId = expectedImageId;
  }

  /**
   * Begin observing a prepared service gate after its mutation. Mirrors
   * beginStack's nullability: returns a null runId (and observing:false) when
   * the service is not started, gating is disabled, or the insert fails; a
   * non-null runId with observing:false past the concurrency cap; and a non-null
   * runId with observing:true once the poll is armed. The prepare token is
   * consumed either way. Never throws.
   */
  public beginPrepared(input: { prepareToken: string; actor: string | null }): BeginPreparedResult {
    const now = Date.now();
    this.sweepExpiredPrepared(now);
    const prep = this.prepared.get(input.prepareToken);
    // Always consume the token so a caller cannot begin twice off one prepare.
    if (prep) this.prepared.delete(input.prepareToken);

    if (!this.started || !prep) return { runId: null, observing: false };

    try {
      const db = DatabaseService.getInstance();
      const settings = this.readSettings();
      if (!settings.enabled) return { runId: null, observing: false };

      const key = this.gateKey(prep.nodeId, prep.stackName, 'service', prep.serviceName);
      this.supersedeGatesForStack(prep.nodeId, prep.stackName);

      const runId = randomUUID();
      const startedAt = Date.now();
      const row: HealthGateRunRow = {
        id: runId,
        node_id: prep.nodeId,
        stack_name: prep.stackName,
        trigger_action: prep.trigger,
        status: 'observing',
        reason: null,
        window_seconds: prep.windowSeconds,
        containers_json: '[]',
        started_at: startedAt,
        ended_at: null,
        created_by: input.actor,
        target_scope: 'service',
        service_name: prep.serviceName,
        failure_source: null,
      };

      if (this.active.size >= MAX_CONCURRENT_GATES) {
        db.insertHealthGateRun({ ...row, status: 'unknown', reason: 'too many concurrent observations', ended_at: startedAt });
        return { runId, observing: false };
      }

      db.insertHealthGateRun(row);
      const gate: ActiveGate = {
        runId,
        nodeId: prep.nodeId,
        stackName: prep.stackName,
        windowSeconds: prep.windowSeconds,
        startedAt,
        timer: null,
        expected: null,
        consecutivePollErrors: 0,
        missingLastPoll: new Set(),
        restartingLastPoll: new Set(),
        finalized: false,
        targetScope: 'service',
        trigger: prep.trigger,
        serviceName: prep.serviceName,
        expectedImageId: prep.expectedImageId,
        expectedReplicas: prep.expectedReplicas,
        collateralEligibleNames: prep.collateralEligibleNames,
        roleByName: new Map(),
      };
      this.active.set(key, gate);
      this.scheduleNextPoll(gate);
      return { runId, observing: true };
    } catch (error) {
      console.error('[HealthGate] beginPrepared failed for %s/%s:',
        sanitizeForLog(prep.stackName), sanitizeForLog(prep.serviceName), error);
      return { runId: null, observing: false };
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
        targetScope: 'stack', serviceName: null, failureSource: null,
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
      targetScope: row.target_scope ?? 'stack',
      serviceName: row.service_name ?? null,
      failureSource: row.failure_source ?? null,
    };
  }

  /**
   * Orchestrate one poll cycle and arm the next. Polls are single-flight: the
   * next timer is scheduled only after this cycle fully settles (the finally
   * below), so a slow or timed-out observe can never overlap the following poll
   * or corrupt the restart/missing accounting that assumes one poll at a time.
   */
  private async poll(gate: ActiveGate): Promise<void> {
    const key = this.gateKey(gate.nodeId, gate.stackName, gate.targetScope, gate.serviceName);
    // A late timer fire after supersede, stop, or finalize must do nothing.
    if (gate.finalized || this.active.get(key) !== gate) return;
    try {
      if (gate.targetScope === 'service') {
        await this.runServicePollCycle(gate, key);
      } else {
        await this.runPollCycle(gate, key);
      }
    } finally {
      if (!gate.finalized && this.active.get(key) === gate) {
        this.scheduleNextPoll(gate);
      }
    }
  }

  /** Arm the next poll. No-op once the gate is finalized. */
  private scheduleNextPoll(gate: ActiveGate): void {
    if (gate.finalized) return;
    gate.timer = setTimeout(() => { void this.poll(gate); }, POLL_INTERVAL_MS);
  }

  private async runPollCycle(gate: ActiveGate, key: string): Promise<void> {
    let observed: ObservedContainer[];
    try {
      observed = await withTimeout(
        this.observeContainers(gate), OBSERVE_TIMEOUT_MS, 'health gate observe',
      );
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

  /**
   * Poll cycle for a prepared service gate. Observes the selected service's
   * primary replicas (image convergence, replica count, health/restart) and the
   * regression-eligible collateral siblings, attributing a failure to
   * 'primary' or 'collateral'. Unrelated containers that appear after prepare do
   * not expand the observed set.
   */
  private async runServicePollCycle(gate: ActiveGate, key: string): Promise<void> {
    let observed: ObservedContainer[];
    try {
      observed = await withTimeout(
        this.observeContainers(gate), OBSERVE_TIMEOUT_MS, 'health gate observe',
      );
    } catch (error) {
      gate.consecutivePollErrors += 1;
      console.warn(
        '[HealthGate] service poll error %d for %s/%s:',
        gate.consecutivePollErrors, sanitizeForLog(gate.stackName),
        sanitizeForLog(gate.serviceName ?? ''), getErrorMessage(error, 'unknown'),
      );
      if (gate.consecutivePollErrors >= 3) {
        this.finalize(gate, 'unknown', 'Docker became unreachable during observation', []);
      }
      return;
    }
    if (gate.finalized || this.active.get(key) !== gate) return;
    gate.consecutivePollErrors = 0;

    const elapsedMs = Date.now() - gate.startedAt;
    const serviceName = gate.serviceName ?? '';

    // Arm the expected set once from post-mutation primary replicas plus the
    // regression-eligible collateral siblings. Scale-0 arms immediately with an
    // empty primary set; scale>0 waits (up to the empty grace) for replicas.
    if (gate.expected === null) {
      const primary = observed.filter(c => c.service === serviceName);
      if (gate.expectedReplicas > 0 && primary.length === 0) {
        if (elapsedMs >= EMPTY_GRACE_MS) {
          this.finalize(gate, 'failed', `service ${serviceName} has no running replicas to observe`, [], 'primary');
        }
        return;
      }
      const expected = new Map<string, ObservedContainer>();
      for (const c of primary) {
        gate.roleByName.set(c.name, 'primary');
        expected.set(c.name, c);
      }
      for (const c of observed) {
        if (gate.collateralEligibleNames.has(c.name) && !gate.roleByName.has(c.name)) {
          gate.roleByName.set(c.name, 'collateral');
          expected.set(c.name, c);
        }
      }
      gate.expected = expected;
      return;
    }

    const byName = new Map(observed.map(c => [c.name, c]));

    for (const [name, baseline] of gate.expected) {
      const current = byName.get(name);
      if (!current) continue;
      const restarted =
        current.id !== baseline.id ||
        current.restartCount > baseline.restartCount ||
        (current.startedAt !== null && baseline.startedAt !== null && current.startedAt !== baseline.startedAt);
      current.restarts = baseline.restarts + (restarted ? 1 : 0);
    }
    const summary = this.summarizeService(gate, byName);

    // Primary image convergence: a primary replica on any image id other than
    // the single attached expected id fails the gate.
    if (gate.expectedImageId) {
      const wrongImage = observed.find(
        c => c.service === serviceName && c.imageId && c.imageId !== gate.expectedImageId,
      );
      if (wrongImage) {
        this.finalize(gate, 'failed', `service ${serviceName} replica ${wrongImage.name} is running an unexpected image`, summary, 'primary');
        return;
      }
    }

    for (const [name, baseline] of gate.expected) {
      const role = gate.roleByName.get(name) ?? 'collateral';
      const noun = role === 'primary' ? 'replica' : 'sibling';
      const current = byName.get(name);
      if (!current) {
        if (gate.missingLastPoll.has(name)) {
          this.finalize(gate, 'failed', `${noun} ${name} disappeared during observation`, summary, role);
          return;
        }
        gate.missingLastPoll.add(name);
        continue;
      }
      gate.missingLastPoll.delete(name);

      if (current.state === 'exited' && baseline.restarts === current.restarts) {
        this.finalize(gate, 'failed', `${noun} ${name} exited during observation`, summary, role);
        return;
      }
      if (current.health === 'unhealthy') {
        this.finalize(gate, 'failed', `${noun} ${name} reported unhealthy`, summary, role);
        return;
      }
      if (current.restarts >= 2) {
        this.finalize(gate, 'failed', `${noun} ${name} is restart looping`, summary, role);
        return;
      }
      if (current.state === 'restarting') {
        if (gate.restartingLastPoll.has(name)) {
          this.finalize(gate, 'failed', `${noun} ${name} is stuck restarting`, summary, role);
          return;
        }
        gate.restartingLastPoll.add(name);
      } else {
        gate.restartingLastPoll.delete(name);
      }
      gate.expected.set(name, current);
    }

    if (elapsedMs < gate.windowSeconds * 1000) return;

    const stillStarting = observed.filter(
      c => c.health === 'starting' && (c.service === serviceName || gate.collateralEligibleNames.has(c.name)),
    );
    if (stillStarting.length > 0) {
      this.finalize(gate, 'unknown', 'a healthcheck was still starting when the observation window ended', summary);
      return;
    }
    const runningPrimary = observed.filter(c => c.service === serviceName && c.state === 'running');
    if (runningPrimary.length !== gate.expectedReplicas) {
      this.finalize(
        gate, 'failed',
        `service ${serviceName} has ${runningPrimary.length} running replica(s), expected ${gate.expectedReplicas}`,
        summary, 'primary',
      );
      return;
    }
    const collateralNotRunning = [...gate.expected.keys()]
      .filter(name => gate.roleByName.get(name) === 'collateral')
      .filter(name => byName.get(name)?.state !== 'running');
    if (collateralNotRunning.length > 0) {
      this.finalize(gate, 'failed', `sibling(s) not running at the end of the window: ${collateralNotRunning.join(', ')}`, summary, 'collateral');
      return;
    }
    this.finalize(gate, 'passed', null, summary);
  }

  private summarizeService(
    gate: ActiveGate,
    current: Map<string, ObservedContainer>,
  ): HealthGateContainer[] {
    if (!gate.expected) return [];
    return [...gate.expected.values()].map(baseline => {
      const now = current.get(baseline.name);
      return {
        name: baseline.name,
        state: now?.state ?? 'missing',
        health: now?.health ?? null,
        restarts: now?.restarts ?? baseline.restarts,
        service: (now ?? baseline).service ?? gate.serviceName,
        role: gate.roleByName.get(baseline.name) ?? null,
      };
    });
  }

  private async observeContainers(gate: ActiveGate): Promise<ObservedContainer[]> {
    return this.listStackContainers(gate.nodeId, gate.stackName);
  }

  /** List and inspect a stack's containers into the gate's observation shape. */
  private async listStackContainers(nodeId: number, stackName: string): Promise<ObservedContainer[]> {
    const docker = DockerController.getInstance(nodeId).getDocker();
    const listed = await docker.listContainers({
      all: true,
      filters: { label: [`com.docker.compose.project=${stackName}`] },
    });
    const observed = await Promise.all(
      listed.map(async (info): Promise<ObservedContainer | null> => {
        try {
          const inspect = await docker.getContainer(info.Id).inspect();
          const labels = (info.Labels ?? inspect.Config?.Labels ?? {}) as Record<string, string>;
          return {
            id: info.Id,
            name: info.Names?.[0]?.replace(/^\//, '') ?? info.Id.slice(0, 12),
            startedAt: inspect.State?.StartedAt ?? null,
            restartCount: typeof inspect.RestartCount === 'number' ? inspect.RestartCount : 0,
            restarts: 0,
            state: inspect.State?.Status ?? info.State ?? 'unknown',
            health: inspect.State?.Health?.Status ?? null,
            service: labels['com.docker.compose.service'] ?? null,
            imageId: inspect.Image ?? '',
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

  /** Snapshot the current per-container facts for prepare's primary/collateral partition. */
  private async snapshotBaselines(nodeId: number, stackName: string): Promise<PreparedBaseline[]> {
    const observed = await withTimeout(
      this.listStackContainers(nodeId, stackName), OBSERVE_TIMEOUT_MS, 'health gate prepare snapshot',
    );
    return observed.map(c => ({
      id: c.id,
      name: c.name,
      service: c.service,
      state: c.state,
      health: c.health,
      restartCount: c.restartCount,
      startedAt: c.startedAt,
      imageId: c.imageId,
    }));
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
    failureSource: 'primary' | 'collateral' | null = null,
  ): void {
    if (gate.finalized) return;
    gate.finalized = true;
    if (gate.timer) clearTimeout(gate.timer);
    const key = this.gateKey(gate.nodeId, gate.stackName, gate.targetScope, gate.serviceName);
    if (this.active.get(key) === gate) this.active.delete(key);

    // A service gate owns its service's Auto-Heal suppression while observing;
    // release it here so a failed/superseded/stopped gate never leaves auto-heal
    // muted for that service.
    if (gate.targetScope === 'service' && gate.serviceName) {
      try {
        AutoHealService.getInstance().clearSuppress(gate.nodeId, gate.stackName, gate.serviceName);
      } catch (error) {
        console.warn('[HealthGate] Failed to clear auto-heal suppression for %s/%s:',
          sanitizeForLog(gate.stackName), sanitizeForLog(gate.serviceName), getErrorMessage(error, 'unknown'));
      }
    }

    try {
      DatabaseService.getInstance().finalizeHealthGateRun(
        gate.runId, status, reason, Date.now(), JSON.stringify(containers), failureSource,
      );
    } catch (error) {
      // The verdict is lost from the DB (the startup sweep will later rewrite
      // the row as unknown), so log everything needed to reconstruct it.
      console.error(
        '[HealthGate] Failed to persist verdict %s (%s) for run %s, stack %s:',
        status, sanitizeForLog(reason ?? 'no reason'), gate.runId, sanitizeForLog(gate.stackName),
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
