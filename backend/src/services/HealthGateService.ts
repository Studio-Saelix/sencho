import { randomUUID } from 'crypto';
import DockerController from './DockerController';
import { DatabaseService, type HealthGateRunRow } from './DatabaseService';
import { AutoHealService } from './AutoHealService';
import { sanitizeForLog } from '../utils/safeLog';
import { getErrorMessage } from '../utils/errors';
import { withTimeout } from '../utils/withTimeout';
import { isCleanOneShotCompletion } from '../utils/oneShotCompletion';
import { declaredFromEffectiveModel } from '../helpers/effectiveToDeclaredCompose';
import { parseEffectiveModel } from './preflight/effectiveModel';
import type { HealthGateContainer, HealthGateReport } from './updateGuard/types';
import { GitOpsStore } from './gitops/store';
import { GitOpsTransitions } from './gitops/transitions';
import { ComposeService, getComposeCommandTimeoutMs } from './ComposeService';

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
  /** Inspect State.ExitCode; null when unavailable. */
  exitCode: number | null;
  /** HostConfig.RestartPolicy.Name (report/debug only; not used for one-shot intent). */
  restartPolicy: string | null;
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
  trigger: 'update' | 'deploy' | 'service_update' | 'service_restore' | 'recovery';
  /** Service gates only. */
  serviceName: string | null;
  /** Single image id every primary replica must converge on (service gates). */
  expectedImageId: string | null;
  /** Expected primary replica count from the effective model (service gates; may be 0). */
  expectedReplicas: number;
  /** Sibling names eligible for regression evaluation (service gates). */
  collateralEligibleNames: Set<string>;
  /**
   * Pre-mutation baselines for regression-eligible collateral siblings.
   * Used to seed `expected` at arm time so a sibling that vanishes during the
   * mutation gap is still tracked (and can fail) on the first poll.
   */
  collateralBaselineByName: Map<string, ObservedContainer>;
  /** Role of each expected container (service gates), for failure attribution. */
  roleByName: Map<string, GateRole>;
  /**
   * Declared Compose restart intent by service name (normalized). Loaded once
   * per gate; null until the first load attempt completes. Used for one-shot
   * recognition instead of Docker inspect (which cannot distinguish omit vs
   * explicit `restart: "no"`).
   */
  declaredRestartByService: Map<string, string | null> | null;
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
  exitCode: number | null;
  restartPolicy: string | null;
}

function isRegressionEligibleSibling(baseline: PreparedBaseline): boolean {
  return baseline.state === 'running' && (baseline.health === null || baseline.health === 'healthy');
}

function observedFromPreparedBaseline(baseline: PreparedBaseline): ObservedContainer {
  return {
    id: baseline.id,
    name: baseline.name,
    startedAt: baseline.startedAt,
    restartCount: baseline.restartCount,
    restarts: 0,
    state: baseline.state,
    health: baseline.health,
    service: baseline.service,
    imageId: baseline.imageId,
    exitCode: baseline.exitCode,
    restartPolicy: baseline.restartPolicy,
  };
}

/** Running, or a clean one-shot exit (exit 0 + explicit declared restart "no"). */
function isObservedContainerSatisfied(
  gate: ActiveGate,
  current: ObservedContainer | undefined,
): boolean {
  if (!current) return false;
  if (current.state === 'running') return true;
  return isDeclaredCleanOneShot(gate, current);
}

/**
 * One-shot recognition from declared Compose intent only. Unlabeled containers
 * and services missing from the effective model fail closed.
 */
function isDeclaredCleanOneShot(gate: ActiveGate, current: ObservedContainer): boolean {
  const map = gate.declaredRestartByService;
  if (!map || !current.service || !map.has(current.service)) return false;
  return isCleanOneShotCompletion({
    state: current.state,
    exitCode: current.exitCode,
    restartPolicy: map.get(current.service),
  });
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

  /**
   * Sweep runs left observing by a previous process, then accept begin() calls.
   *
   * Each row is finalized on its own rather than swept with one UPDATE, so the
   * revision state hears a verdict for every one of them. A reserved recovery
   * run is finalized here like any other: a reservation is only ever armed by
   * the process that made it, so one that survived a restart has no timer and
   * nothing left to observe.
   */
  public start(): void {
    this.started = true;
    let interrupted: HealthGateRunRow[];
    try {
      interrupted = DatabaseService.getInstance().listObservingHealthGateRuns();
    } catch (error) {
      console.error('[HealthGate] Startup sweep failed:', getErrorMessage(error, 'unknown'));
      return;
    }
    let finalized = 0;
    for (const run of interrupted) {
      // Per row, so one unreadable row cannot leave every later one observing
      // for ever.
      try {
        this.finalizePersistedRun(run, 'Sencho restarted during observation');
        finalized++;
      } catch (error) {
        console.error(
          '[HealthGate] Could not finalize interrupted run %s for %s:',
          run.id, sanitizeForLog(run.stack_name), getErrorMessage(error, 'unknown'),
        );
      }
    }
    if (finalized > 0) {
      console.log(`[HealthGate] Marked ${finalized} interrupted observation(s) as unknown`);
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

  private baselineMapFromPrepared(baselines: PreparedBaseline[]): Map<string, ObservedContainer> {
    const map = new Map<string, ObservedContainer>();
    for (const baseline of baselines) {
      map.set(baseline.name, observedFromPreparedBaseline(baseline));
    }
    return map;
  }

  /**
   * Finalize in-flight gates that a newer operation must replace:
   * - A stack-scoped begin supersedes every gate on the stack.
   * - A service-scoped begin supersedes only the same service's gate and any
   *   stack-scoped gate; other services keep observing independently.
   */
  private supersedeGatesForStack(
    nodeId: number,
    stackName: string,
    options?: { serviceName?: string | null; stackOnly?: boolean },
  ): void {
    const serviceName = options?.serviceName;
    const stackOnly = options?.stackOnly === true;
    for (const gate of [...this.active.values()]) {
      if (gate.nodeId !== nodeId || gate.stackName !== stackName) continue;
      if (serviceName !== undefined) {
        // Service begin: keep other services' gates.
        if (gate.targetScope === 'service' && gate.serviceName !== serviceName) continue;
      } else if (stackOnly) {
        if (gate.targetScope !== 'stack') continue;
      }
      this.finalize(gate, 'unknown', 'superseded by a newer operation', []);
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
  /**
   * Start a stack-scoped health observation.
   *
   * `binding.deployedGenerationId` is the generation the mutation that preceded
   * this call actually deployed, or null when there was none. It is a required
   * argument rather than something this method reads from current state,
   * because a verdict is only meaningful for the generation the run watched:
   * reading it later could bind a run to whatever happens to be deployed by
   * then, and a pass would then promote a generation this run never observed.
   */
  public beginStack(
    nodeId: number,
    stackName: string,
    trigger: 'update' | 'deploy',
    actor: string | null,
    binding: { deployedGenerationId: string | null },
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

      // A newer stack operation supersedes every in-flight gate on this stack
      // (including service gates).
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
        deployed_generation_id: binding.deployedGenerationId,
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
        collateralBaselineByName: new Map(),
        roleByName: new Map(),
        declaredRestartByService: null,
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

  /**
   * Claim a health run for a proven, bound recovery, inside the caller's open
   * transaction.
   *
   * Writes the row and links it to the recovery generation, and touches nothing
   * in memory. Committing the reservation alongside the recovery is the point:
   * a crash between the two would otherwise leave a restored workload that no
   * run was ever recorded against. Arming the timer is the caller's separate
   * step after its transaction commits.
   *
   * Idempotent on the recovery generation's `health_gate_id`, so a replayed
   * recovery reuses its run rather than opening a second one.
   */
  public reserveRecoveryRun(args: {
    recoveryRef: string;
    nodeId: number;
    stackName: string;
    deployedGenerationId: string;
    actor: string | null;
  }): { outcome: 'reserved' | 'replayed' | 'disabled'; runId: string | null } {
    const db = DatabaseService.getInstance();
    if (!this.readSettings().enabled) return { outcome: 'disabled', runId: null };

    const linked = db.getStackUpdateRecoveryGeneration(args.recoveryRef)?.health_gate_id ?? null;
    if (linked) return { outcome: 'replayed', runId: linked };

    const runId = randomUUID();
    db.insertHealthGateRun({
      id: runId,
      node_id: args.nodeId,
      stack_name: args.stackName,
      trigger_action: 'recovery',
      status: 'observing',
      reason: null,
      window_seconds: this.readSettings().windowSeconds,
      containers_json: '[]',
      started_at: Date.now(),
      ended_at: null,
      created_by: args.actor,
      target_scope: 'stack',
      service_name: null,
      failure_source: null,
      deployed_generation_id: args.deployedGenerationId,
    });
    db.updateStackUpdateRecoveryGeneration(args.recoveryRef, { health_gate_id: runId });
    return { outcome: 'reserved', runId };
  }

  /**
   * Start observing a run that was reserved in a committed transaction.
   *
   * Inserts nothing: the row already exists, and creating a second one would
   * give the same recovery two verdicts. Throws on anything unexpected so the
   * caller can finalize the reservation unknown rather than leave an observing
   * row with no timer behind it.
   *
   * Same-process only. A reservation that outlived its process is finalized by
   * `start`, never armed here.
   */
  public armReservedRun(runId: string, nodeId: number, stackName: string): void {
    if (!this.started) throw new Error('health gate service is not started');

    const run = DatabaseService.getInstance().getHealthGateRun(nodeId, stackName, runId);
    if (!run) throw new Error(`reserved health run ${runId} was not found`);
    if (run.status !== 'observing' || run.trigger_action !== 'recovery' || run.target_scope !== 'stack') {
      throw new Error(`health run ${runId} is not a reserved stack recovery observation`);
    }

    const key = this.gateKey(nodeId, stackName, 'stack', null);
    if (this.active.get(key)?.runId === runId) return;
    this.supersedeGatesForStack(nodeId, stackName);
    if (this.active.size >= MAX_CONCURRENT_GATES) {
      throw new Error('too many concurrent observations');
    }

    const gate: ActiveGate = {
      runId,
      nodeId,
      stackName,
      windowSeconds: run.window_seconds,
      startedAt: run.started_at,
      timer: null,
      expected: null,
      consecutivePollErrors: 0,
      missingLastPoll: new Set(),
      restartingLastPoll: new Set(),
      finalized: false,
      targetScope: 'stack',
      trigger: 'recovery',
      serviceName: null,
      expectedImageId: null,
      expectedReplicas: 0,
      collateralEligibleNames: new Set(),
      collateralBaselineByName: new Map(),
      roleByName: new Map(),
      declaredRestartByService: null,
    };
    this.active.set(key, gate);
    this.scheduleNextPoll(gate);
  }

  /**
   * Write off a reservation this process could not arm.
   *
   * Public because the reservation is made inside the recovery transaction and
   * armed after it commits, so the window where arming can fail belongs to the
   * caller, not to this service.
   */
  public abandonReservedRun(runId: string, nodeId: number, stackName: string, reason: string): void {
    try {
      const run = DatabaseService.getInstance().getHealthGateRun(nodeId, stackName, runId);
      if (!run || run.status !== 'observing') return;
      this.finalizePersistedRun(run, reason);
    } catch (error) {
      console.error(
        '[HealthGate] Could not finalize unarmed reservation %s for %s:',
        runId, sanitizeForLog(stackName), getErrorMessage(error, 'unknown'),
      );
    }
  }

  /** @deprecated Prefer beginStack; retained as a one-PR alias for callers under migration. */
  public begin(
    nodeId: number,
    stackName: string,
    trigger: 'update' | 'deploy',
    actor: string | null,
    binding: { deployedGenerationId: string | null },
  ): string | null {
    return this.beginStack(nodeId, stackName, trigger, actor, binding);
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
      // Same-service + stack gates only; sibling service observations continue.
      this.supersedeGatesForStack(prep.nodeId, prep.stackName, { serviceName: prep.serviceName });

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
        collateralBaselineByName: this.baselineMapFromPrepared(
          prep.collateralBaseline.filter(b => prep.collateralEligibleNames.has(b.name)),
        ),
        roleByName: new Map(),
        declaredRestartByService: null,
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

    await this.ensureDeclaredRestartMap(gate);
    if (gate.finalized || this.active.get(key) !== gate) return;

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

      const cleanOneShot = isDeclaredCleanOneShot(gate, current);
      // An exit with no restart attempt is terminal for the window, unless
      // this is an expected one-shot (exit 0 + explicit declared restart "no").
      if (current.state === 'exited' && baseline.restarts === current.restarts && !cleanOneShot) {
        this.finalize(gate, 'failed', `container ${name} exited during observation`, summary);
        return;
      }
      // Residual Docker health on a completed one-shot is not a gate failure;
      // long-running containers still fail on unhealthy.
      if (!cleanOneShot && current.health === 'unhealthy') {
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

    // Window complete: pass requires everything running (or a clean one-shot
    // completion) and healthy wherever a healthcheck exists. A health state
    // still 'starting' is not a pass (except residual health on a clean one-shot).
    const stillStarting = observed.filter(
      c => c.health === 'starting' && !isDeclaredCleanOneShot(gate, c),
    );
    if (stillStarting.length > 0) {
      this.finalize(gate, 'unknown', 'a healthcheck was still starting when the observation window ended', summary);
      return;
    }
    const notRunning = [...gate.expected.keys()].filter(
      name => !isObservedContainerSatisfied(gate, byName.get(name)),
    );
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

    await this.ensureDeclaredRestartMap(gate);
    if (gate.finalized || this.active.get(key) !== gate) return;

    const elapsedMs = Date.now() - gate.startedAt;
    const serviceName = gate.serviceName ?? '';

    // Arm the expected set once from post-mutation primary replicas plus the
    // pre-mutation regression-eligible collateral baselines. Seeding collateral
    // from the prepare baseline (not only from the first post-mutation poll)
    // means a healthy sibling that vanished during the mutation gap is still
    // tracked and can fail the gate. Scale-0 arms immediately with an empty
    // primary set; scale>0 waits (up to the empty grace) for replicas.
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
      const observedByName = new Map(observed.map(c => [c.name, c]));
      for (const [name, baseline] of gate.collateralBaselineByName) {
        if (gate.roleByName.has(name)) continue;
        gate.roleByName.set(name, 'collateral');
        // Prefer the live observation when the sibling is still present; otherwise
        // keep the prepare baseline so a missing sibling enters the miss path.
        expected.set(name, observedByName.get(name) ?? baseline);
      }
      // Also pick up eligible siblings that appeared under a new name after mutation
      // (unusual, but keeps prior behavior for containers still in the eligible set).
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

      const cleanOneShot = isDeclaredCleanOneShot(gate, current);
      if (current.state === 'exited' && baseline.restarts === current.restarts && !cleanOneShot) {
        this.finalize(gate, 'failed', `${noun} ${name} exited during observation`, summary, role);
        return;
      }
      if (!cleanOneShot && current.health === 'unhealthy') {
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
      c => c.health === 'starting'
        && !isDeclaredCleanOneShot(gate, c)
        && (c.service === serviceName || gate.collateralEligibleNames.has(c.name)),
    );
    if (stillStarting.length > 0) {
      this.finalize(gate, 'unknown', 'a healthcheck was still starting when the observation window ended', summary);
      return;
    }
    const satisfiedPrimary = observed.filter(
      c => c.service === serviceName && isObservedContainerSatisfied(gate, c),
    );
    if (satisfiedPrimary.length !== gate.expectedReplicas) {
      this.finalize(
        gate, 'failed',
        `service ${serviceName} has ${satisfiedPrimary.length} satisfied replica(s), expected ${gate.expectedReplicas}`,
        summary, 'primary',
      );
      return;
    }
    const collateralNotRunning = [...gate.expected.keys()]
      .filter(name => gate.roleByName.get(name) === 'collateral')
      .filter(name => !isObservedContainerSatisfied(gate, byName.get(name)));
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

  /**
   * Load declared Compose restart intent once per gate. Fail closed to an empty
   * map on render/parse errors so inspect "no" cannot false-qualify one-shots.
   */
  private async ensureDeclaredRestartMap(gate: ActiveGate): Promise<void> {
    if (gate.declaredRestartByService !== null) return;
    gate.declaredRestartByService = new Map();
    try {
      const result = await ComposeService.getInstance(gate.nodeId).renderConfig(gate.stackName);
      if (result.rendered === null) {
        console.warn(
          '[HealthGate] declared restart map unavailable for %s (compose render failed)',
          sanitizeForLog(gate.stackName),
        );
        return;
      }
      const model = parseEffectiveModel(JSON.parse(result.rendered), gate.stackName);
      const declared = declaredFromEffectiveModel(model);
      gate.declaredRestartByService = new Map(
        declared.services.map((s) => [s.name, s.restart ?? null]),
      );
    } catch (error) {
      console.warn(
        '[HealthGate] declared restart map load failed for %s:',
        sanitizeForLog(gate.stackName), getErrorMessage(error, 'unknown'),
      );
    }
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
            exitCode: typeof inspect.State?.ExitCode === 'number' ? inspect.State.ExitCode : null,
            restartPolicy: inspect.HostConfig?.RestartPolicy?.Name || null,
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
      exitCode: c.exitCode,
      restartPolicy: c.restartPolicy,
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

  /**
   * Hand a finalized verdict to the GitOps state model.
   *
   * The generation is read back from the persisted run row rather than taken
   * from memory, so the verdict is attributed to what this run was recorded as
   * observing. The transition decides whether that is still promotable; this
   * method only reports.
   *
   * Never throws: a health gate is an observer, and a bookkeeping failure must
   * not change the verdict that was just written.
   */
  private recordGitOpsHealthVerdict(
    nodeId: number,
    stackName: string,
    runId: string,
    status: 'passed' | 'failed' | 'unknown',
  ): void {
    try {
      const run = DatabaseService.getInstance().getHealthGateRun(nodeId, stackName, runId);
      if (!run) return;
      const app = GitOpsStore.getInstance().getLiveDirectApplication(stackName);
      if (!app || app.lifecycle_status !== 'active') return;
      if (!GitOpsStore.getInstance().getTarget(app.id, nodeId)) return;
      GitOpsTransitions.getInstance().healthFinalized({
        applicationId: app.id,
        nodeId,
        healthRunId: runId,
        healthStatus: status,
        deployedGenerationId: run.deployed_generation_id ?? null,
        targetScope: run.target_scope,
        envelope: { operationId: runId, actor: 'system:health-gate', trigger: 'health', at: Date.now() },
      });
    } catch (error) {
      console.error(
        '[GitOps] Could not record the health verdict for %s:',
        sanitizeForLog(stackName), getErrorMessage(error, 'unknown'),
      );
    }
  }

  /**
   * Write an unknown verdict for a run this process is not observing.
   *
   * Covers a row a previous process left behind and a reservation this process
   * could not arm. Both are the same situation: an observing row with no timer
   * behind it, which would otherwise sit unresolved for ever.
   */
  private finalizePersistedRun(run: HealthGateRunRow, reason: string): void {
    DatabaseService.getInstance().finalizeHealthGateRun(
      run.id, 'unknown', reason, Date.now(), run.containers_json ?? '[]', null,
    );
    this.recordGitOpsHealthVerdict(run.node_id, run.stack_name, run.id, 'unknown');
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
      this.recordGitOpsHealthVerdict(gate.nodeId, gate.stackName, gate.runId, status);
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
