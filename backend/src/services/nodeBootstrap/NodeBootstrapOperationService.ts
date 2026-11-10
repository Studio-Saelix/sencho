import crypto from 'crypto';
import { buildPilotEnrollmentCompose } from '../../helpers/pilotEnrollmentCompose';
import { mintPilotEnrollmentToken } from '../../helpers/pilotEnrollment';
import { PilotCloseCode } from '../../pilot/protocol';
import { getErrorMessage } from '../../utils/errors';
import { sanitizeForLog } from '../../utils/safeLog';
import {
  DatabaseService,
  type NodeBootstrapEventStatus,
  type NodeBootstrapOperation,
  type NodeBootstrapOperationState,
  type NodeBootstrapOperationTransition,
} from '../DatabaseService';
import { NodeRegistry } from '../NodeRegistry';
import { PilotTunnelManager } from '../PilotTunnelManager';
import { recordBootstrapAudit, type BootstrapAuditContext } from './audit';
import {
  BootstrapError,
  NodeBootstrapService,
  validateInstallPaths,
  type BootstrapPreflightRequest,
} from './NodeBootstrapService';
import { canonicalJson, sha256Hex } from './planBuilder';
import { DEFAULT_AGENT_DIR, DEFAULT_COMPOSE_DIR } from './pathPolicy';
import { sshExecClient, type BootstrapExecTransport, type ExecSession } from './sshExecClient';
import { SshTransportError } from './sshProbeClient';
import {
  COMPOSE_STEP_ID,
  RunCancelled,
  StepFailure,
  TOKEN_PLACEHOLDER,
  lastDockerStage,
  runPlanStep,
  verifyAgentContainer,
  verifyDockerReady,
  verifyDockerService,
  type StepContext,
} from './stepRunner';
import { validateTarget } from './targetPolicy';
import type { BootstrapPlan, BootstrapPreflightResult } from './types';

/**
 * Durable execution of an approved bootstrap plan.
 *
 * An admin approves one plan by its digest. The operation row is the durable
 * record: approval (actor, digest, host key), the lifecycle state, the step it
 * reached and a bounded event log. Its `active` flag is the per-target lock,
 * enforced by unique indexes on the target and on the host key, so a second
 * operation for the same server cannot start until this one ends or is
 * released, across restarts.
 *
 * The run itself belongs to this process, not the browser. It first rebuilds
 * the plan from a fresh inspection and refuses to change anything unless the
 * result is the approved plan. The SSH key is held in memory for that run
 * only and never stored, so a hub restart cannot resume a run: it records the
 * run as interrupted, and a retry needs the key again and a newly approved plan.
 */

export const APPROVAL_TTL_MS = 10 * 60_000;
export const MAX_PENDING_APPROVALS = 32;
export const ENROLL_WAIT_MS = 5 * 60_000;
export const OPERATION_LIST_LIMIT = 20;

const RUNNING_STATES: readonly NodeBootstrapOperationState[] = ['rechecking', 'running', 'enrolling'];
const RETRYABLE_STATES: readonly NodeBootstrapOperationState[] = [
  'blocked', 'failed', 'partial', 'cancelled', 'outcome_unknown', 'recovery_required',
];
/** States that can resolve on their own once the Pilot connects. */
const RECONCILABLE_STATES: readonly NodeBootstrapOperationState[] = ['partial', 'outcome_unknown', 'cancelled'];

interface PendingApproval {
  plan: BootstrapPlan;
  actor: string;
  storedAt: number;
  operationId: string | null;
}

export interface OperationEventView {
  at: number;
  attempt: number;
  stage: string | null;
  step: string | null;
  status: NodeBootstrapEventStatus;
  message: string;
  detail: string | null;
}

export interface OperationView {
  id: string;
  targetName: string;
  host: string;
  port: number;
  username: string;
  address: string;
  hostKeyFingerprint: string;
  composeDir: string;
  agentDir: string;
  planDigest: string;
  approvedBy: string;
  approvedAt: number;
  attempt: number;
  state: NodeBootstrapOperationState;
  stage: string | null;
  step: string | null;
  nodeId: number | null;
  changesMade: boolean;
  active: boolean;
  cancelRequested: boolean;
  error: { code: string; message: string } | null;
  enrollmentExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  actions: { cancel: boolean; retry: boolean; release: boolean };
}

export interface OperationDetail extends OperationView {
  plan: BootstrapPlan;
  events: OperationEventView[];
}

export interface ExecuteRequest extends BootstrapPreflightRequest {
  planDigest: string;
}

interface TunnelPort {
  hasActiveTunnel(nodeId: number): boolean;
  closeTunnel(nodeId: number, code?: number, reason?: string): void;
  on(event: 'tunnel-up', listener: (nodeId: number) => void): unknown;
  off(event: 'tunnel-up', listener: (nodeId: number) => void): unknown;
}

interface OperationDeps {
  db: DatabaseService;
  preflight: Pick<NodeBootstrapService, 'preflight'>;
  exec: BootstrapExecTransport;
  tunnels: TunnelPort;
  now: () => number;
  mintToken: (nodeId: number) => { token: string; expiresAt: number };
  registerNode: (name: string, composeDir: string) => number;
  enrollWaitMs: number;
  /** How long the package metadata refresh is retried while another apt job holds its lock. */
  aptLockRetry?: { intervalMs: number; totalMs: number };
}

/** Who records rows nobody requested: restart recovery and late reconciliation. */
const SYSTEM_AUDIT: BootstrapAuditContext = { username: 'system', ip: 'local', method: 'RECOVERY', path: 'node_bootstrap_operations' };

function defaultRegisterNode(name: string, composeDir: string): number {
  const id = DatabaseService.getInstance().addNode({
    name,
    type: 'remote',
    compose_dir: composeDir,
    is_default: false,
    api_url: '',
    api_token: '',
    mode: 'pilot_agent',
  });
  NodeRegistry.getInstance().notifyNodeAdded(id);
  return id;
}

/**
 * The plan digest without the evidence digest. The evidence digest covers
 * every observed fact (clock skew, free space, the container sample), so it
 * changes between any two inspections; the plan itself must not.
 */
export function stablePlanDigest(plan: BootstrapPlan): string {
  const { generatedAt: _generatedAt, digest: _digest, evidenceDigest: _evidence, ...rest } = plan;
  return sha256Hex(canonicalJson(rest));
}

function finalStateFor(kind: StepFailure['kind'], changesMade: boolean): NodeBootstrapOperationState {
  if (kind === 'unknown') return 'outcome_unknown';
  if (kind === 'recovery') return 'recovery_required';
  return changesMade ? 'partial' : 'failed';
}

/** An operation keeps the target lock while the host may hold its changes, until it enrolls or is released. */
function holdsLock(state: NodeBootstrapOperationState, changesMade: boolean): boolean {
  if (state === 'enrolled') return false;
  if (state === 'outcome_unknown' || state === 'recovery_required' || state === 'partial') return true;
  return changesMade;
}

/** Effects a step can leave behind partly even when it exits with an error. */
const PARTIAL_EFFECTS: ReadonlySet<string> = new Set(['package-install', 'service-change', 'container-start']);

interface RunContext {
  hubUrl: string;
  audit: BootstrapAuditContext;
}

export class NodeBootstrapOperationService {
  private static instance: NodeBootstrapOperationService | null = null;
  private readonly deps: OperationDeps;
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly runs = new Map<string, { abort: AbortController; done: Promise<void> }>();

  public constructor(deps: Partial<OperationDeps> = {}) {
    this.deps = {
      db: DatabaseService.getInstance(),
      preflight: NodeBootstrapService.getInstance(),
      exec: sshExecClient,
      tunnels: PilotTunnelManager.getInstance(),
      now: () => Date.now(),
      mintToken: mintPilotEnrollmentToken,
      registerNode: defaultRegisterNode,
      enrollWaitMs: ENROLL_WAIT_MS,
      ...deps,
    };
  }

  public static getInstance(): NodeBootstrapOperationService {
    if (!NodeBootstrapOperationService.instance) NodeBootstrapOperationService.instance = new NodeBootstrapOperationService();
    return NodeBootstrapOperationService.instance;
  }

  /** Test hook: settle every run this instance started. */
  public async settled(): Promise<void> {
    await Promise.all([...this.runs.values()].map((run) => run.done));
  }

  // --- approval -------------------------------------------------------------

  /**
   * Remember a plan the operator was shown, so it can be approved by digest.
   * Pending approvals live in memory for ten minutes; a restart forgets them,
   * which only means the preflight has to run again.
   */
  public rememberPlan(result: BootstrapPreflightResult, actor: string, operationId: string | null): void {
    if (!result.plan || result.blocked) return;
    const now = this.deps.now();
    for (const [digest, pending] of this.approvals) {
      if (now - pending.storedAt > APPROVAL_TTL_MS) this.approvals.delete(digest);
    }
    while (this.approvals.size >= MAX_PENDING_APPROVALS) {
      const oldest = this.approvals.keys().next().value;
      if (oldest === undefined) break;
      this.approvals.delete(oldest);
    }
    this.approvals.set(result.plan.digest, { plan: result.plan, actor, storedAt: now, operationId });
  }

  private assertRetryable(op: NodeBootstrapOperation): void {
    if (!op.active || !RETRYABLE_STATES.includes(op.state) || this.runs.has(op.id)) {
      throw new BootstrapError(409, 'OPERATION_NOT_RETRYABLE', 'This bootstrap cannot be retried in its current state.');
    }
  }

  /**
   * What a retry preflight may treat as this operation's own: its node and,
   * once it reached the start step, its Pilot. Only a stopped operation that
   * still holds its target can be retried.
   */
  public retryOwnership(id: string, host: string, port: number): { nodeId: number | null; agentStarted: boolean } {
    const op = this.reconcile(this.requireOperation(id));
    this.assertRetryable(op);
    if (op.target_key !== `${host.toLowerCase()}:${port}`) {
      throw new BootstrapError(409, 'OPERATION_NOT_RETRYABLE', 'A retry must inspect the same server as the bootstrap it retries.');
    }
    return { nodeId: op.node_id, agentStarted: op.agent_started === 1 };
  }

  /** Refuse a new preflight while a run holds the same target. */
  public assertTargetIdle(host: string, port: number, exceptOperationId: string | null = null): void {
    const targetKey = `${host.toLowerCase()}:${port}`;
    const busy = this.deps.db.listNodeBootstrapOperationsInStates(RUNNING_STATES)
      .find((op) => op.target_key === targetKey && op.id !== exceptOperationId);
    if (busy) {
      throw new BootstrapError(409, 'BOOTSTRAP_IN_PROGRESS', 'A bootstrap is running on this host. Open it to follow its progress.', {
        details: { operationId: busy.id },
      });
    }
  }

  /**
   * Check a pending approval against this request. The approval is bound to
   * the operator who saw the plan, the target, both directories and the host
   * key; any difference refuses before an operation exists. It is consumed
   * only once the operation holds its target (`consumeApproval`), so a refusal
   * on the lock leaves it usable.
   */
  private peekApproval(request: ExecuteRequest, actor: string, operationId: string | null): BootstrapPlan {
    const pending = this.approvals.get(request.planDigest);
    const now = this.deps.now();
    if (!pending || now - pending.storedAt > APPROVAL_TTL_MS) {
      if (pending) this.approvals.delete(request.planDigest);
      throw new BootstrapError(409, 'PLAN_NOT_CURRENT', 'This plan is no longer current. Run the preflight again and review the new plan.');
    }
    if (pending.actor !== actor) {
      throw new BootstrapError(409, 'PLAN_NOT_CURRENT', 'This plan was prepared for another administrator. Run the preflight yourself and review the plan.');
    }
    if (pending.operationId !== operationId) {
      throw new BootstrapError(409, 'PLAN_NOT_CURRENT', 'This plan was prepared for a different bootstrap. Run the preflight again.');
    }
    const target = validateTarget({ host: request.host, port: request.port, username: request.username, targetName: request.targetName });
    const paths = validateInstallPaths(request.composeDir ?? DEFAULT_COMPOSE_DIR, request.agentDir ?? DEFAULT_AGENT_DIR);
    const plan = pending.plan;
    const matches = plan.target.host === target.host
      && plan.target.port === target.port
      && plan.target.username === target.username
      && plan.targetName === target.targetName
      && plan.paths.composeDir.input === paths.composeDir
      && plan.paths.agentDir.input === paths.agentDir
      && plan.hostKeyFingerprint === (request.expectedFingerprint?.trim() ?? '');
    if (!matches) {
      throw new BootstrapError(409, 'PLAN_NOT_CURRENT', 'The request does not match the reviewed plan. Run the preflight again.');
    }
    return plan;
  }

  /** An approval runs once: a second request with the same digest is refused. */
  private consumeApproval(digest: string): void {
    this.approvals.delete(digest);
  }

  // --- lifecycle ------------------------------------------------------------

  public start(request: ExecuteRequest, context: RunContext): OperationDetail {
    const actor = context.audit.username;
    const plan = this.peekApproval(request, actor, null);
    const now = this.deps.now();
    const op: NodeBootstrapOperation = {
      id: crypto.randomUUID(),
      target_key: `${plan.target.host}:${plan.target.port}`,
      host: plan.target.host,
      port: plan.target.port,
      username: plan.target.username,
      address: plan.target.address,
      target_name: plan.targetName,
      host_key_fingerprint: plan.hostKeyFingerprint,
      compose_dir: plan.paths.composeDir.input,
      agent_dir: plan.paths.agentDir.input,
      plan_json: JSON.stringify(plan),
      plan_digest: plan.digest,
      approved_by: actor,
      approved_at: now,
      attempt: 1,
      state: 'rechecking',
      stage: null,
      step: null,
      node_id: null,
      changes_made: 0,
      agent_started: 0,
      active: 1,
      cancel_requested: 0,
      error_code: null,
      error_message: null,
      enrollment_expires_at: null,
      created_at: now,
      updated_at: now,
      finished_at: null,
    };
    try {
      this.deps.db.insertNodeBootstrapOperation(op);
    } catch (error: unknown) {
      if ((error as { code?: string }).code === 'BOOTSTRAP_LOCK_HELD') {
        const holder = this.deps.db.getActiveNodeBootstrapOperation(op.target_key, op.host_key_fingerprint);
        throw new BootstrapError(409, 'BOOTSTRAP_OPERATION_ACTIVE', 'Another bootstrap holds this server. Open it to continue, retry or release it.', {
          details: { operationId: holder?.id ?? null },
        });
      }
      throw error;
    }
    this.consumeApproval(plan.digest);
    this.audit(context.audit, 'bootstrap.execute.approved', op, { digest: plan.digest });
    this.event(op, 'info', `Approved by ${actor}. Plan sha256:${plan.digest}.`);
    this.launch(op.id, request, plan, context);
    return this.detail(op.id);
  }

  public retry(id: string, request: ExecuteRequest, context: RunContext): OperationDetail {
    const op = this.requireOperation(id);
    if (this.reconcile(op).state === 'enrolled') {
      throw new BootstrapError(409, 'OPERATION_NOT_RETRYABLE', 'The Pilot for this bootstrap has connected. There is nothing to retry.');
    }
    this.assertRetryable(op);
    const plan = this.peekApproval(request, context.audit.username, id);
    if (plan.hostKeyFingerprint !== op.host_key_fingerprint || `${plan.target.host}:${plan.target.port}` !== op.target_key
      || plan.targetName !== op.target_name || plan.paths.composeDir.input !== op.compose_dir || plan.paths.agentDir.input !== op.agent_dir) {
      throw new BootstrapError(409, 'PLAN_NOT_CURRENT', 'A retry must target the same server, host key, node name and directories.');
    }
    const now = this.deps.now();
    const moved = this.deps.db.transitionNodeBootstrapOperation(id, RETRYABLE_STATES, {
      state: 'rechecking',
      attempt: op.attempt + 1,
      plan_json: JSON.stringify(plan),
      plan_digest: plan.digest,
      approved_by: context.audit.username,
      approved_at: now,
      stage: null,
      step: null,
      cancel_requested: 0,
      enrollment_expires_at: null,
      error_code: null,
      error_message: null,
      finished_at: null,
      active: 1,
    }, now);
    if (!moved) {
      throw new BootstrapError(409, 'OPERATION_NOT_RETRYABLE', 'This bootstrap changed state. Refresh it and try again.');
    }
    this.consumeApproval(plan.digest);
    const updated = this.requireOperation(id);
    this.audit(context.audit, 'bootstrap.execute.retry', updated, { digest: plan.digest, attempt: updated.attempt });
    this.event(updated, 'info', `Retry approved by ${context.audit.username}. Plan sha256:${plan.digest}.`);
    this.launch(id, request, plan, context);
    return this.detail(id);
  }

  public cancel(id: string, audit: BootstrapAuditContext): OperationDetail {
    const op = this.requireOperation(id);
    const run = this.runs.get(id);
    if (!run || !RUNNING_STATES.includes(op.state)) {
      throw new BootstrapError(409, 'OPERATION_NOT_RUNNING', 'This bootstrap is not running.');
    }
    this.deps.db.updateNodeBootstrapOperation(id, { cancel_requested: 1 }, this.deps.now());
    run.abort.abort();
    this.audit(audit, 'bootstrap.execute.cancel', op, {});
    this.event(op, 'info', `Cancellation requested by ${audit.username}. The current command finishes first, a wait for another apt job ends at once, and nothing already changed is undone.`);
    return this.detail(id);
  }

  /** Release the target lock without touching the host. The record and its node stay. */
  public release(id: string, audit: BootstrapAuditContext): OperationDetail {
    const op = this.requireOperation(id);
    if (!op.active || RUNNING_STATES.includes(op.state) || this.runs.has(id)) {
      throw new BootstrapError(409, 'OPERATION_NOT_RELEASABLE', 'Only a stopped bootstrap that still holds its server can be released.');
    }
    const now = this.deps.now();
    if (!this.deps.db.transitionNodeBootstrapOperation(id, [op.state], { active: 0, finished_at: op.finished_at ?? now }, now)) {
      throw new BootstrapError(409, 'OPERATION_NOT_RELEASABLE', 'This bootstrap changed state. Refresh it and try again.');
    }
    this.audit(audit, 'bootstrap.execute.release', op, {});
    this.event(op, 'info', `Released by ${audit.username}. Nothing on the host was changed or removed${op.node_id !== null ? ', and the node record stays in Fleet' : ''}.`);
    return this.detail(id);
  }

  public list(): OperationView[] {
    return this.deps.db.listNodeBootstrapOperations(OPERATION_LIST_LIMIT).map((op) => this.view(this.reconcile(op)));
  }

  public get(id: string): OperationDetail {
    this.reconcile(this.requireOperation(id));
    return this.detail(id);
  }

  /**
   * A hub restart ends every run this process held. A run that had not
   * reached a mutating step changed nothing; any other may have, so its
   * outcome is unknown until the host is inspected again.
   */
  public recoverOnStartup(): void {
    for (const op of this.deps.db.listNodeBootstrapOperationsInStates(RUNNING_STATES)) {
      // One row that cannot be written must not leave the others looking live.
      try {
        this.recordInterrupted(op);
      } catch (error: unknown) {
        console.error(`[Bootstrap] Operation ${op.id} could not be marked interrupted:`, sanitizeForLog(getErrorMessage(error, 'unknown')));
      }
    }
    for (const op of this.deps.db.listNodeBootstrapOperationsInStates(RECONCILABLE_STATES)) {
      try {
        this.reconcile(op);
      } catch (error: unknown) {
        console.error(`[Bootstrap] Operation ${op.id} could not be reconciled:`, sanitizeForLog(getErrorMessage(error, 'unknown')));
      }
    }
  }

  private recordInterrupted(op: NodeBootstrapOperation, cause: 'restart' | 'aborted' = 'restart'): void {
    const now = this.deps.now();
    const state: NodeBootstrapOperationState = op.state === 'rechecking' ? 'blocked' : 'outcome_unknown';
    const what = cause === 'restart' ? 'The hub restarted' : 'The run stopped on an internal error';
    const message = op.state === 'rechecking'
      ? `${what} before this attempt changed anything.`
      : op.state === 'enrolling'
        ? `${what} while it waited for the Pilot to connect. Every step had run; the Pilot can still connect on its own.`
        : `${what} during this attempt. Steps already run stay on the host, and the step in progress may or may not have completed.`;
    const moved = this.deps.db.transitionNodeBootstrapOperation(op.id, [op.state], {
      state,
      active: holdsLock(state, op.changes_made === 1) ? 1 : 0,
      cancel_requested: 0,
      error_code: cause === 'restart' ? 'HUB_RESTARTED' : 'RUN_ABORTED',
      error_message: message,
      finished_at: now,
    }, now);
    if (!moved) return;
    this.event(op, state === 'blocked' ? 'info' : 'unknown', message);
    this.audit(SYSTEM_AUDIT, 'bootstrap.execute.finished', op, { state, code: cause === 'restart' ? 'HUB_RESTARTED' : 'RUN_ABORTED', attempt: op.attempt, nodeId: op.node_id }, 500);
    console.warn(`[Bootstrap] Operation ${op.id} for ${sanitizeForLog(op.host)} was interrupted (${cause}, ${state}).`);
  }

  // --- run ------------------------------------------------------------------

  private launch(id: string, request: ExecuteRequest, plan: BootstrapPlan, context: RunContext): void {
    const abort = new AbortController();
    const done = this.execute(id, request, plan, context, abort.signal)
      .catch((error: unknown) => {
        // The run's own error path failed (a database write, most likely).
        // Leave the row stopped rather than looking live with no run behind it.
        console.error(`[Bootstrap] Operation ${id} ended unexpectedly:`, sanitizeForLog(getErrorMessage(error, 'unknown')));
        try {
          const op = this.deps.db.getNodeBootstrapOperation(id);
          if (op && RUNNING_STATES.includes(op.state)) this.recordInterrupted(op, 'aborted');
        } catch (fallbackError: unknown) {
          console.error(`[Bootstrap] Operation ${id} could not be marked interrupted:`, sanitizeForLog(getErrorMessage(fallbackError, 'unknown')));
        }
      })
      .finally(() => {
        this.runs.delete(id);
      });
    this.runs.set(id, { abort, done });
  }

  private async execute(
    id: string,
    request: ExecuteRequest,
    plan: BootstrapPlan,
    context: RunContext,
    signal: AbortSignal,
  ): Promise<void> {
    const secrets = [request.privateKey, request.passphrase ?? null].filter((value): value is string => Boolean(value));
    let session: ExecSession | null = null;
    try {
      await this.recheck(id, request, plan, context, signal);
      if (signal.aborted) throw new RunCancelled();
      let op = this.requireOperation(id);
      session = await this.deps.exec.open(
        { host: op.host, address: op.address, port: op.port, username: op.username, privateKey: request.privateKey, passphrase: request.passphrase ?? null },
        { expectedFingerprint: op.host_key_fingerprint, signal },
      );
      this.transition(id, ['rechecking'], { state: 'running' });
      let composeWithToken: string | null = null;
      const ctx: StepContext = {
        session,
        secrets,
        signal,
        note: (message) => {
          const current = this.requireOperation(id);
          this.event(current, 'info', message, current.stage, current.step);
        },
        aptLockRetry: this.deps.aptLockRetry,
        composeWithToken: () => {
          if (composeWithToken === null) throw new StepFailure('failed', 'PLAN_INVALID', 'The enrollment was not prepared before the compose file step.');
          return composeWithToken;
        },
      };
      const dockerVerifyStage = lastDockerStage(plan);
      for (const stage of plan.stages) {
        for (const step of stage.steps) {
          if (signal.aborted || this.requireOperation(id).cancel_requested === 1) throw new RunCancelled();
          this.deps.db.updateNodeBootstrapOperation(id, { stage: stage.id, step: step.id }, this.deps.now());
          if (step.id === COMPOSE_STEP_ID) {
            const enrollment = this.prepareEnrollment(id, plan, context);
            composeWithToken = enrollment.compose;
            secrets.push(enrollment.token);
          }
          op = this.requireOperation(id);
          // The start step is recorded before it runs: from then on the Pilot
          // container may exist, which a retry has to recognize as its own.
          if (step.effect === 'container-start') this.deps.db.updateNodeBootstrapOperation(id, { agent_started: 1 }, this.deps.now());
          this.event(op, 'started', step.title, stage.id, step.id);
          let outcome: Awaited<ReturnType<typeof runPlanStep>>;
          try {
            outcome = await runPlanStep(step, ctx, plan);
          } catch (error: unknown) {
            // A step whose outcome is unknown, or that may have done part of
            // its work before failing, counts as a change; a clean refusal, or a
            // cancel taken while the step waited between attempts, does not.
            const refusedCleanly = (error instanceof StepFailure && error.changedNothing) || error instanceof RunCancelled;
            const mayHaveChanged = !refusedCleanly
              && (!(error instanceof StepFailure) || error.kind !== 'failed' || PARTIAL_EFFECTS.has(step.effect));
            if (mayHaveChanged) this.deps.db.updateNodeBootstrapOperation(id, { changes_made: 1 }, this.deps.now());
            throw error;
          }
          if (outcome.status === 'done') this.deps.db.updateNodeBootstrapOperation(id, { changes_made: 1 }, this.deps.now());
          this.event(op, outcome.status, outcome.message, stage.id, step.id);
        }
        const verified: string[] = [];
        if (stage.id === 'docker_service') verified.push(await verifyDockerService(ctx, plan));
        if (stage.id === dockerVerifyStage) verified.push(await verifyDockerReady(ctx, plan));
        if (stage.id === 'agent_start') verified.push(await verifyAgentContainer(ctx, plan));
        for (const message of verified) this.event(this.requireOperation(id), 'done', message, stage.id, null);
      }
      session.close();
      session = null;
      await this.awaitEnrollment(id, signal, context);
    } catch (error: unknown) {
      this.finishWithError(id, error, signal, context);
    } finally {
      session?.close();
      secrets.length = 0;
    }
  }

  /** Rebuild the plan from a fresh inspection; anything but the approved plan stops the run before it changes anything. */
  private async recheck(
    id: string,
    request: ExecuteRequest,
    plan: BootstrapPlan,
    context: RunContext,
    signal: AbortSignal,
  ): Promise<void> {
    const op = this.requireOperation(id);
    this.event(op, 'started', 'Re-checking the host against the approved plan.', 'recheck', null);
    let fresh: BootstrapPreflightResult;
    try {
      fresh = await this.deps.preflight.preflight({
        ...request,
        expectedFingerprint: op.host_key_fingerprint,
        replacePinnedFingerprint: null,
        reviewedPinnedFingerprint: null,
      }, {
        hubUrl: context.hubUrl,
        audit: context.audit,
        signal,
        planNow: plan.generatedAt,
        pinnedAddress: op.address,
        ownership: { nodeId: op.node_id, agentStarted: op.agent_started === 1 },
      });
    } catch (error: unknown) {
      if (signal.aborted) throw new RunCancelled();
      const message = error instanceof BootstrapError || error instanceof SshTransportError
        ? error.message
        : 'The host could not be inspected again.';
      throw new StepFailure('failed', 'RECHECK_FAILED', `The host could not be re-checked, so nothing was changed. ${message}`.trim(), null);
    }
    if (fresh.blocked || !fresh.plan) {
      const blockers = fresh.inspection.checks
        .filter((check) => check.status === 'blocked' || check.status === 'unknown')
        .slice(0, 3)
        .map((check) => check.summary);
      throw new StepFailure('failed', 'PRECONDITION_CHANGED', `The host no longer passes the preflight, so nothing was changed. ${blockers.join(' ')}`.trim());
    }
    if (stablePlanDigest(fresh.plan) !== stablePlanDigest(plan)) {
      throw new StepFailure('failed', 'PLAN_STALE', 'The host changed since the plan was approved, so nothing was changed. Run the preflight again and review the new plan.');
    }
    this.event(this.requireOperation(id), 'done', 'The host still matches the approved plan.', 'recheck', null);
  }

  /**
   * Register the node (or reuse the one an earlier attempt registered) and
   * mint its one-use enrollment just before the compose file is written: the
   * long package steps are behind it, so the 15-minute window is spent on the
   * agent's start and first connection.
   */
  private prepareEnrollment(id: string, plan: BootstrapPlan, context: RunContext): { token: string; compose: string } {
    const caPem = plan.stages.flatMap((stage) => stage.steps).find((step) => step.id === 'agent-hub-ca')?.file?.content;
    const composeFor = (token: string) => buildPilotEnrollmentCompose({
      primaryUrl: plan.hubUrl,
      token,
      composeDir: plan.paths.composeDir.input,
      caPem,
    });
    // Checked before anything is registered or minted, so a mismatch leaves no live credential behind.
    const reviewed = plan.stages.flatMap((stage) => stage.steps).find((step) => step.id === COMPOSE_STEP_ID)?.file?.content;
    if (composeFor(TOKEN_PLACEHOLDER) !== reviewed) {
      throw new StepFailure('failed', 'PLAN_INVALID', 'The Pilot compose file no longer matches the reviewed plan, so nothing was written.', null, { changedNothing: true });
    }
    const op = this.requireOperation(id);
    const existing = op.node_id !== null ? this.deps.db.getNode(op.node_id) : undefined;
    let nodeId: number;
    // The node an earlier attempt registered is reused by id, even if it was
    // renamed since, so a rename does not create a second node. A node that was
    // deleted meanwhile is registered again below.
    if (existing && existing.type === 'remote' && existing.mode === 'pilot_agent') {
      nodeId = existing.id;
      // As the manual regenerate route does: an open tunnel would outlive the new credential.
      this.deps.tunnels.closeTunnel(nodeId, PilotCloseCode.EnrollmentRegenerated, 'enrollment regenerated');
    } else {
      if (this.deps.db.getNodes().some((node) => node.name === op.target_name)) {
        throw new StepFailure('failed', 'NODE_NAME_TAKEN', `A node named ${op.target_name} was added while this bootstrap ran. Docker work already done stays on the host.`);
      }
      nodeId = this.deps.registerNode(op.target_name, plan.paths.composeDir.input);
      // A registered node is a change: the run keeps its target, so a retry
      // reuses this node instead of meeting it as a name already taken.
      this.deps.db.updateNodeBootstrapOperation(id, { node_id: nodeId, changes_made: 1 }, this.deps.now());
      this.audit(context.audit, 'bootstrap.node.created', op, { nodeId });
    }
    const { token, expiresAt } = this.deps.mintToken(nodeId);
    this.deps.db.updateNodeBootstrapOperation(id, { enrollment_expires_at: expiresAt }, this.deps.now());
    this.event(this.requireOperation(id), 'info', `Enrollment minted for node ${nodeId}; it expires at ${new Date(expiresAt).toISOString()}.`, 'agent_project', COMPOSE_STEP_ID);
    return { token, compose: composeFor(token) };
  }

  private async awaitEnrollment(id: string, signal: AbortSignal, context: RunContext): Promise<void> {
    const op = this.transition(id, ['running'], { state: 'enrolling', stage: 'enroll', step: null });
    const nodeId = op.node_id;
    if (nodeId === null) throw new StepFailure('recovery', 'NODE_MISSING', 'The Pilot started, but no node was registered for it.');
    this.event(op, 'started', 'Waiting for the Pilot to connect with its enrollment.', 'enroll', null);
    const deadline = Math.min(this.deps.now() + this.deps.enrollWaitMs, op.enrollment_expires_at ?? Number.POSITIVE_INFINITY);
    const outcome = await new Promise<'connected' | 'timeout' | 'cancelled'>((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      const onUp = (upId: number) => {
        if (upId === nodeId) finish('connected');
      };
      const onAbort = () => finish('cancelled');
      const finish = (value: 'connected' | 'timeout' | 'cancelled') => {
        if (timer) clearTimeout(timer);
        this.deps.tunnels.off('tunnel-up', onUp);
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      this.deps.tunnels.on('tunnel-up', onUp);
      signal.addEventListener('abort', onAbort, { once: true });
      if (this.deps.tunnels.hasActiveTunnel(nodeId)) {
        finish('connected');
        return;
      }
      if (signal.aborted) {
        finish('cancelled');
        return;
      }
      timer = setTimeout(() => finish(this.deps.tunnels.hasActiveTunnel(nodeId) ? 'connected' : 'timeout'), Math.max(0, deadline - this.deps.now()));
    });
    if (outcome === 'cancelled') throw new RunCancelled();
    if (outcome === 'timeout') {
      throw new StepFailure(
        'failed',
        'ENROLLMENT_NOT_CONNECTED',
        'The Pilot started but did not connect before the wait ended. Check that the host can reach the hub URL, then retry; a retry mints a new enrollment.',
      );
    }
    this.finish(id, 'enrolled', null, context, 'The Pilot connected. The node is enrolled; its readiness has not been verified yet.');
  }

  // --- state ----------------------------------------------------------------

  private finishWithError(id: string, error: unknown, signal: AbortSignal, context: RunContext): void {
    const op = this.requireOperation(id);
    const changesMade = op.changes_made === 1;
    // A cancel ends the run as cancelled when it is what stopped the run: the
    // run saw it at a step boundary, or it aborted the connect or the recheck.
    // A step failure keeps its own outcome, so an unknown or broken step is
    // never relabelled as a clean cancel.
    const abortedTransport = signal.aborted && (error instanceof SshTransportError || error instanceof BootstrapError);
    if (error instanceof RunCancelled || abortedTransport) {
      this.finish(id, 'cancelled', { code: 'CANCELLED', message: changesMade
        ? 'Cancelled. Steps that already ran stay on the host; nothing was undone.'
        : 'Cancelled before anything was changed.' }, context);
      return;
    }
    // Until the run leaves `rechecking`, this attempt has changed nothing on the
    // host, so whatever stopped it is a block (earlier attempts' changes still hold the lock).
    const beforeMutation = op.state === 'rechecking';
    if (error instanceof StepFailure) {
      const state = beforeMutation ? 'blocked' : finalStateFor(error.kind, changesMade);
      this.finish(id, state, { code: error.code, message: error.message }, context, null, error.detail);
      return;
    }
    if (error instanceof SshTransportError || error instanceof BootstrapError) {
      const state: NodeBootstrapOperationState = beforeMutation ? 'blocked' : 'outcome_unknown';
      this.finish(id, state, { code: error.code, message: error.message }, context);
      return;
    }
    console.error(`[Bootstrap] Operation ${id} failed:`, sanitizeForLog(getErrorMessage(error, 'unknown error')));
    const state: NodeBootstrapOperationState = beforeMutation ? 'blocked' : 'recovery_required';
    this.finish(id, state, { code: 'INTERNAL_ERROR', message: 'The bootstrap stopped on an unexpected error. Check the hub logs.' }, context);
  }

  private finish(
    id: string,
    state: NodeBootstrapOperationState,
    error: { code: string; message: string } | null,
    context: RunContext,
    note: string | null = null,
    detail: string | null = null,
  ): void {
    const op = this.requireOperation(id);
    const now = this.deps.now();
    const changesMade = op.changes_made === 1;
    const moved = this.deps.db.transitionNodeBootstrapOperation(id, RUNNING_STATES, {
      state,
      active: holdsLock(state, changesMade) ? 1 : 0,
      cancel_requested: 0,
      error_code: error?.code ?? null,
      error_message: error?.message ?? null,
      finished_at: now,
    }, now);
    if (!moved) {
      console.warn(`[Bootstrap] Operation ${id} was no longer running when it ended (${state}); its record was left as it is.`);
      return;
    }
    const status: NodeBootstrapEventStatus = state === 'enrolled' ? 'done' : state === 'outcome_unknown' ? 'unknown' : state === 'cancelled' || state === 'blocked' ? 'info' : 'failed';
    this.event(op, status, note ?? error?.message ?? state, op.stage, op.step, detail);
    this.audit(context.audit, 'bootstrap.execute.finished', op, {
      state,
      code: error?.code ?? null,
      attempt: op.attempt,
      nodeId: op.node_id,
    }, state === 'enrolled' || state === 'cancelled' || state === 'blocked' ? 200 : 500);
    console.log(`[Bootstrap] Operation ${id} for ${sanitizeForLog(op.host)} ended: ${state}${error ? ` (${error.code})` : ''}`);
  }

  private transition(id: string, from: readonly NodeBootstrapOperationState[], updates: NodeBootstrapOperationTransition): NodeBootstrapOperation {
    if (!this.deps.db.transitionNodeBootstrapOperation(id, from, updates, this.deps.now())) {
      throw new StepFailure('unknown', 'STATE_CONFLICT', 'The operation changed state while it was running.');
    }
    return this.requireOperation(id);
  }

  /**
   * A stopped operation whose Pilot has since connected is enrolled: the
   * agent kept its enrollment and dialed in after the run gave up waiting or
   * was interrupted. Checked when the operation is read, so no timer polls.
   */
  private reconcile(op: NodeBootstrapOperation): NodeBootstrapOperation {
    if (!RECONCILABLE_STATES.includes(op.state) || op.node_id === null || op.agent_started !== 1 || this.runs.has(op.id)) return op;
    const node = this.deps.db.getNode(op.node_id);
    const connected = this.deps.tunnels.hasActiveTunnel(op.node_id)
      || (node?.pilot_last_seen != null && node.pilot_last_seen >= op.approved_at);
    if (!connected) return op;
    const now = this.deps.now();
    if (!this.deps.db.transitionNodeBootstrapOperation(op.id, RECONCILABLE_STATES, {
      state: 'enrolled', active: 0, error_code: null, error_message: null, finished_at: now,
    }, now)) {
      return this.requireOperation(op.id);
    }
    this.event(op, 'done', 'The Pilot connected after the run stopped. The node is enrolled; its readiness has not been verified yet.', 'enroll', null);
    this.audit(SYSTEM_AUDIT, 'bootstrap.execute.finished', op, { state: 'enrolled', code: null, attempt: op.attempt, nodeId: op.node_id });
    return this.requireOperation(op.id);
  }

  private requireOperation(id: string): NodeBootstrapOperation {
    const op = this.deps.db.getNodeBootstrapOperation(id);
    if (!op) throw new BootstrapError(404, 'OPERATION_NOT_FOUND', 'Bootstrap operation not found.');
    return op;
  }

  private event(
    op: NodeBootstrapOperation,
    status: NodeBootstrapEventStatus,
    message: string,
    stage: string | null = op.stage,
    step: string | null = op.step,
    detail: string | null = null,
  ): void {
    this.deps.db.appendNodeBootstrapEvent({
      operation_id: op.id,
      attempt: op.attempt,
      at: this.deps.now(),
      stage,
      step,
      status,
      message,
      detail,
    });
  }

  private audit(context: BootstrapAuditContext, action: string, op: NodeBootstrapOperation, facts: Record<string, unknown>, statusCode = 200): void {
    recordBootstrapAudit(this.deps.db, this.deps.now(), context, action, {
      operation: op.id,
      target: op.target_name,
      host: op.host,
      port: op.port,
      fingerprint: op.host_key_fingerprint,
      ...facts,
    }, statusCode);
  }

  private view(op: NodeBootstrapOperation): OperationView {
    const running = RUNNING_STATES.includes(op.state) && this.runs.has(op.id);
    const stopped = !RUNNING_STATES.includes(op.state) && !this.runs.has(op.id);
    return {
      id: op.id,
      targetName: op.target_name,
      host: op.host,
      port: op.port,
      username: op.username,
      address: op.address,
      hostKeyFingerprint: op.host_key_fingerprint,
      composeDir: op.compose_dir,
      agentDir: op.agent_dir,
      planDigest: op.plan_digest,
      approvedBy: op.approved_by,
      approvedAt: op.approved_at,
      attempt: op.attempt,
      state: op.state,
      stage: op.stage,
      step: op.step,
      nodeId: op.node_id,
      changesMade: op.changes_made === 1,
      active: op.active === 1,
      cancelRequested: op.cancel_requested === 1,
      error: op.error_code ? { code: op.error_code, message: op.error_message ?? '' } : null,
      enrollmentExpiresAt: op.enrollment_expires_at,
      createdAt: op.created_at,
      updatedAt: op.updated_at,
      finishedAt: op.finished_at,
      actions: {
        cancel: running && op.cancel_requested !== 1,
        retry: stopped && op.active === 1 && RETRYABLE_STATES.includes(op.state),
        release: stopped && op.active === 1,
      },
    };
  }

  private detail(id: string): OperationDetail {
    const op = this.requireOperation(id);
    return {
      ...this.view(op),
      plan: JSON.parse(op.plan_json) as BootstrapPlan,
      events: this.deps.db.listNodeBootstrapEvents(id).map((event) => ({
        at: event.at,
        attempt: event.attempt,
        stage: event.stage,
        step: event.step,
        status: event.status,
        message: event.message,
        detail: event.detail,
      })),
    };
  }
}
