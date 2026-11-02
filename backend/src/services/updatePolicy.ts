import crypto from 'crypto';
import { DatabaseService } from './DatabaseService';
import { ComposeService } from './ComposeService';
import {
  resolveSenchoLabels,
  SENCHO_UPDATE_LABEL,
  type SenchoLabelResolution,
  type UpdatePolicyLabel,
} from '../helpers/senchoLabels';
import { getErrorMessage } from '../utils/errors';
import { sanitizeForLog } from '../utils/safeLog';

/**
 * The one update-policy evaluator. `io.sencho.update` decides whether an image
 * refresh may touch a service; this module turns the rendered Compose model into
 * a decision, and every image-refresh executor requires that decision before it
 * mutates anything.
 *
 * Two rules make the contract hold:
 *  - the result is branded, so only this module can mint one that authorizes an
 *    execution (a remote node's answer is unbranded and authorizes nothing);
 *  - a decision is all-or-nothing. Sencho never narrows a whole-stack refresh to
 *    the eligible services, because that would silently change what the operator
 *    asked for.
 */

export type UpdatePolicyValue = 'default' | 'auto' | 'manual' | 'disabled' | 'invalid';
export type UpdateTriggerClass = 'manual' | 'unattended';

export type UpdateTarget =
  | { scope: 'stack' }
  | { scope: 'service'; serviceName: string };

export type UpdateTrigger =
  | 'manual' | 'scheduled' | 'automatic' | 'blueprint' | 'webhook' | 'bulk';

export interface ServiceUpdatePolicy {
  service: string;
  policy: UpdatePolicyValue;
  eligible: boolean;
  /** Fixed text that never contains the label value. */
  reason?: string;
}

export interface PolicyRequest {
  stack: string;
  target: UpdateTarget;
  trigger: UpdateTrigger;
}

export interface RemoteUpdatePolicy {
  contract: 1;
  stack: string;
  target: UpdateTarget;
  trigger: UpdateTrigger;
  evaluation: 'unrenderable' | 'evaluated';
  decision: 'allow' | 'block' | 'skip';
  services?: ServiceUpdatePolicy[];
  fingerprint?: string;
  reason: string | null;
}

/** Branded so only this module can produce a result that authorizes an execution. */
declare const evaluatedBrand: unique symbol;

export type UpdatePolicyResult = PolicyRequest & { contract: 1; [evaluatedBrand]: true } & (
  | { evaluation: 'unrenderable'; decision: 'block' | 'skip'; reason: string }
  | {
      evaluation: 'evaluated';
      decision: 'allow' | 'block' | 'skip';
      /** The services this operation refreshes. */
      services: ServiceUpdatePolicy[];
      /** Fingerprint of the per-service policies, for the pre-`up` re-check. */
      fingerprint: string;
      /** null only when decision === 'allow'. */
      reason: string | null;
    }
);

/** Thrown on the stack branch so a refusal can never be read as success. */
export class UpdatePolicyRefusedError extends Error {
  public constructor(public readonly result: UpdatePolicyResult) {
    super(result.reason ?? 'Refused by the update policy.');
    this.name = 'UpdatePolicyRefusedError';
  }
}

/** A policy that changed between evaluation and `up`. */
export class UpdatePolicyChangedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'UpdatePolicyChangedError';
  }
}

export function isUpdatePolicyRefusedError(error: unknown): error is UpdatePolicyRefusedError {
  return error instanceof UpdatePolicyRefusedError;
}

const UNRENDERABLE_REASON =
  `Compose could not be rendered, so Sencho cannot evaluate ${SENCHO_UPDATE_LABEL}.`;

/** The trigger class of an update. Only the operator's own click is manual. */
export function triggerClassOf(trigger: UpdateTrigger): UpdateTriggerClass {
  return trigger === 'manual' ? 'manual' : 'unattended';
}

function ineligibleReason(policy: UpdatePolicyValue): string | undefined {
  switch (policy) {
    case 'manual':
      return 'set to manual';
    case 'disabled':
      return 'set to disabled';
    case 'invalid':
      return 'the value is not recognized';
    default:
      return undefined;
  }
}

function eligibleFor(policy: UpdatePolicyValue, triggerClass: UpdateTriggerClass): boolean {
  if (policy === 'disabled') return false;
  if (triggerClass === 'unattended' && (policy === 'manual' || policy === 'invalid')) return false;
  return true;
}

/** The per-service policy from the rendered model, with `default` for an absent label. */
function policyOf(labels: { update: UpdatePolicyLabel | 'invalid' | null } | undefined): UpdatePolicyValue {
  return labels?.update ?? 'default';
}

/** The services a request refreshes, or null when the model cannot answer for the target. */
function requestedServices(
  resolution: Extract<SenchoLabelResolution, { renderable: true }>,
  request: PolicyRequest,
): string[] | null {
  if (request.target.scope === 'stack') return Object.keys(resolution.services).sort();
  const name = request.target.serviceName;
  return Object.prototype.hasOwnProperty.call(resolution.services, name) ? [name] : null;
}

function fingerprintOf(services: ServiceUpdatePolicy[]): string {
  const material = services
    .map(s => `${s.service}\u0000${s.policy}`)
    .sort()
    .join('\u0001');
  return crypto.createHash('sha1').update(material).digest('hex');
}

function describeIneligible(services: ServiceUpdatePolicy[]): string {
  return services
    .map(s => `"${s.service}" is ${s.reason ?? 'not eligible'}`)
    .join(', ');
}

type PolicyBody =
  | { evaluation: 'unrenderable'; decision: 'block' | 'skip'; reason: string }
  | {
      evaluation: 'evaluated';
      decision: 'allow' | 'block' | 'skip';
      services: ServiceUpdatePolicy[];
      fingerprint: string;
      reason: string | null;
    };

function mint(request: PolicyRequest, body: PolicyBody): UpdatePolicyResult {
  // The only place a branded result is created: the brand exists to make
  // "nobody else can authorize an execution" true in the type system.
  return { contract: 1, ...request, ...body } as UpdatePolicyResult;
}

function unrenderable(request: PolicyRequest, reason: string): UpdatePolicyResult {
  const decision = triggerClassOf(request.trigger) === 'manual' ? 'block' : 'skip';
  return mint(request, { evaluation: 'unrenderable', decision, reason });
}

/**
 * Pure. Turns a resolution and a request into a decision. Unit tested over the
 * whole matrix; never reads anything but the rendered model.
 */
export function evaluateUpdatePolicy(
  resolution: SenchoLabelResolution,
  request: PolicyRequest,
): UpdatePolicyResult {
  if (!resolution.renderable) return unrenderable(request, UNRENDERABLE_REASON);
  const names = requestedServices(resolution, request);
  if (!names) {
    return unrenderable(
      request,
      request.target.scope === 'service'
        ? `Service "${request.target.serviceName}" is not in the rendered Compose model.`
        : UNRENDERABLE_REASON,
    );
  }
  const triggerClass = triggerClassOf(request.trigger);
  const services: ServiceUpdatePolicy[] = names.map(service => {
    const policy = policyOf(resolution.services[service]);
    const eligible = eligibleFor(policy, triggerClass);
    const reason = eligible ? undefined : ineligibleReason(policy);
    return { service, policy, eligible, ...(reason ? { reason } : {}) };
  });
  const ineligible = services.filter(s => !s.eligible);
  const decision = ineligible.length === 0
    ? 'allow'
    : triggerClass === 'manual' ? 'block' : 'skip';
  return mint(request, {
    evaluation: 'evaluated',
    decision,
    services,
    fingerprint: fingerprintOf(services),
    reason: decision === 'allow' ? null : describeIneligible(ineligible),
  });
}

/** The services an operation may not touch. Derived, never stored. */
export function ineligibleServices(result: UpdatePolicyResult): ServiceUpdatePolicy[] {
  return result.evaluation === 'evaluated' ? result.services.filter(s => !s.eligible) : [];
}

/**
 * Refuse a result that does not allow this exact request. Executors call this
 * so a result for another stack, target, trigger, or a non-allowing decision
 * can never authorize a mutation.
 */
export function assertPolicyAllows(policy: UpdatePolicyResult, request: PolicyRequest): void {
  const sameTarget = policy.target.scope === request.target.scope
    && (policy.target.scope !== 'service'
      || (request.target.scope === 'service' && policy.target.serviceName === request.target.serviceName));
  if (policy.evaluation !== 'evaluated' || policy.decision !== 'allow'
    || policy.stack !== request.stack || policy.trigger !== request.trigger || !sameTarget) {
    throw new UpdatePolicyRefusedError(policy);
  }
}

const RENDER_TIMEOUT_MS = 25_000;

/**
 * One render, parsed into the registry's resolution. Null when the model cannot
 * be read: a failed, timed-out, capped, or unparseable render.
 */
async function renderResolution(nodeId: number, stackName: string): Promise<SenchoLabelResolution | null> {
  let rendered: Awaited<ReturnType<ComposeService['renderConfig']>>;
  try {
    rendered = await ComposeService.getInstance(nodeId).renderConfig(stackName);
  } catch (error) {
    console.warn(
      '[UpdatePolicy] Render failed for %s: %s',
      sanitizeForLog(stackName),
      sanitizeForLog(getErrorMessage(error, 'unknown')),
    );
    return null;
  }
  if (rendered.timedOut || rendered.code !== 0 || !rendered.rendered) return null;
  try {
    return resolveSenchoLabels(JSON.parse(rendered.rendered));
  } catch {
    return null;
  }
}

/**
 * Node-local evaluation: one render, the registry's resolver, then the pure
 * evaluator. A render that fails, times out, or does not parse fails closed.
 */
export async function resolveUpdatePolicy(
  nodeId: number,
  request: PolicyRequest,
): Promise<UpdatePolicyResult> {
  const resolution = await renderResolution(nodeId, request.stack);
  if (!resolution) return unrenderable(request, UNRENDERABLE_REASON);
  return evaluateUpdatePolicy(resolution, request);
}

/** Both trigger classes from a single render, for the readiness surface. */
export interface UpdatePolicyPair {
  manual: UpdatePolicyResult;
  unattended: UpdatePolicyResult;
}

/**
 * Evaluate the manual and unattended decisions for one target from one render.
 * Null when the model cannot be read, so the caller reports an unknown rather
 * than guessing which class would have applied.
 */
export async function resolveUpdatePolicyPair(
  nodeId: number,
  stackName: string,
  target: UpdateTarget,
): Promise<UpdatePolicyPair | null> {
  const resolution = await renderResolution(nodeId, stackName);
  if (!resolution) return null;
  return {
    manual: evaluateUpdatePolicy(resolution, { stack: stackName, target, trigger: 'manual' }),
    unattended: evaluateUpdatePolicy(resolution, { stack: stackName, target, trigger: 'scheduled' }),
  };
}

/** Bound the whole re-check so a hung render cannot hold the stack lock open. */
function withRenderTimeout<T>(work: Promise<T>, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>(resolve => {
    timer = setTimeout(() => resolve(onTimeout()), RENDER_TIMEOUT_MS);
    timer.unref?.();
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Re-render and refuse when the decision or the per-service policies changed.
 * Called immediately before `up`, so a Compose save that landed between
 * evaluation and recreation cannot be recreated under a policy the operator
 * never saw.
 */
export async function assertUpdatePolicyUnchanged(
  nodeId: number,
  allowed: UpdatePolicyResult,
): Promise<void> {
  const fresh = await withRenderTimeout(
    resolveUpdatePolicy(nodeId, { stack: allowed.stack, target: allowed.target, trigger: allowed.trigger }),
    () => unrenderable({ stack: allowed.stack, target: allowed.target, trigger: allowed.trigger }, UNRENDERABLE_REASON),
  );
  if (fresh.evaluation !== 'evaluated' || allowed.evaluation !== 'evaluated') {
    throw new UpdatePolicyChangedError(
      'The update policy could not be confirmed immediately before the stack was recreated.',
    );
  }
  if (fresh.decision !== allowed.decision || fresh.fingerprint !== allowed.fingerprint) {
    throw new UpdatePolicyChangedError(
      `The update policy changed while the update was running: ${fresh.reason ?? 'the stack is no longer eligible'}.`,
    );
  }
}

const WIRE_LIMIT = 64;

function readTarget(raw: unknown): UpdateTarget | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.scope === 'stack') return { scope: 'stack' };
  if (value.scope === 'service' && typeof value.serviceName === 'string' && value.serviceName.length <= 256) {
    return { scope: 'service', serviceName: value.serviceName };
  }
  return null;
}

function readTrigger(raw: unknown): UpdateTrigger | null {
  return raw === 'manual' || raw === 'scheduled' || raw === 'automatic'
    || raw === 'blueprint' || raw === 'webhook' || raw === 'bulk'
    ? raw
    : null;
}

function readServices(raw: unknown): ServiceUpdatePolicy[] | null {
  if (!Array.isArray(raw) || raw.length > 512) return null;
  const out: ServiceUpdatePolicy[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const value = item as Record<string, unknown>;
    const policy = value.policy;
    if (typeof value.service !== 'string' || value.service.length === 0 || value.service.length > 256) return null;
    if (policy !== 'default' && policy !== 'auto' && policy !== 'manual' && policy !== 'disabled' && policy !== 'invalid') return null;
    if (typeof value.eligible !== 'boolean') return null;
    if (value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.length > WIRE_LIMIT * 4)) return null;
    out.push({
      service: value.service,
      policy,
      eligible: value.eligible,
      ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    });
  }
  return out;
}

/**
 * Rebuild a remote node's policy answer field by field. Unbranded on purpose: a
 * remote copy reports what that node decided, and can never authorize a local
 * execution. A malformed answer returns null so the caller fails closed.
 */
export function readRemoteUpdatePolicy(raw: unknown): RemoteUpdatePolicy | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.contract !== 1) return null;
  if (typeof value.stack !== 'string' || value.stack.length === 0 || value.stack.length > 256) return null;
  const target = readTarget(value.target);
  const trigger = readTrigger(value.trigger);
  if (!target || !trigger) return null;
  if (value.evaluation === 'unrenderable') {
    if (value.decision !== 'block' && value.decision !== 'skip') return null;
    if (typeof value.reason !== 'string' || value.reason.length === 0) return null;
    return { contract: 1, stack: value.stack, target, trigger, evaluation: 'unrenderable', decision: value.decision, reason: value.reason };
  }
  if (value.evaluation !== 'evaluated') return null;
  if (value.decision !== 'allow' && value.decision !== 'block' && value.decision !== 'skip') return null;
  const services = readServices(value.services);
  if (!services) return null;
  if (typeof value.fingerprint !== 'string' || !/^[a-f0-9]{40}$/.test(value.fingerprint)) return null;
  if (value.reason !== null && typeof value.reason !== 'string') return null;
  if (value.decision !== 'allow' && (typeof value.reason !== 'string' || value.reason.length === 0)) return null;
  return {
    contract: 1,
    stack: value.stack,
    target,
    trigger,
    evaluation: 'evaluated',
    decision: value.decision,
    services,
    fingerprint: value.fingerprint,
    reason: value.reason as string | null,
  };
}

/** The wire projection of a result: the same fields, without the brand. */
export function toUpdatePolicyWire(result: UpdatePolicyResult): RemoteUpdatePolicy {
  if (result.evaluation === 'unrenderable') {
    return {
      contract: 1,
      stack: result.stack,
      target: result.target,
      trigger: result.trigger,
      evaluation: 'unrenderable',
      decision: result.decision,
      reason: result.reason,
    };
  }
  return {
    contract: 1,
    stack: result.stack,
    target: result.target,
    trigger: result.trigger,
    evaluation: 'evaluated',
    decision: result.decision,
    services: result.services,
    fingerprint: result.fingerprint,
    reason: result.reason,
  };
}

type PolicyOutcome = Pick<RemoteUpdatePolicy, 'evaluation' | 'decision' | 'services'>;

/**
 * The one run-history sentence for a skipped unattended update, for example
 * `skipped by update policy (db: manual)`. Built from fixed text plus service
 * names and policies, never from a label value. Works on a local result and on
 * a remote node's re-validated answer.
 */
export function describePolicySkip(result: PolicyOutcome): string {
  const detail = result.evaluation === 'evaluated'
    ? (result.services ?? []).filter(s => !s.eligible).map(s => `${s.service}: ${s.policy}`).join(', ')
    : 'Compose could not be rendered';
  return `${result.decision === 'skip' ? 'skipped' : 'blocked'} by update policy (${detail || 'no service is eligible'})`;
}

/** The failure line for an unattended update aimed at a node too old to evaluate the label. */
export function unsupportedNodeMessage(nodeName: string, stackName: string | null): string {
  const reason = `node "${nodeName}" does not evaluate ${SENCHO_UPDATE_LABEL}; update Sencho on that node.`;
  // A wildcard run has no roster to name, so it fails once at the node.
  return stackName === null
    ? `Node "${nodeName}" failed: it does not evaluate ${SENCHO_UPDATE_LABEL}; update Sencho on that node.`
    : `Stack "${stackName}" failed: ${reason}`;
}

const DECISION_MESSAGE: Record<'block' | 'skip', string> = {  block: 'Update blocked',
  skip: 'Update skipped',
};

const TRIGGER_LABEL: Record<UpdateTrigger, string> = {
  manual: 'a manual update',
  scheduled: 'a scheduled update',
  automatic: 'an automatic update',
  webhook: 'a webhook update',
  bulk: 'a bulk update',
  blueprint: 'a blueprint deploy',
};

function utcDate(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Record a block or skip as a deduplicated, history-only activity row plus one
 * sanitized log line. At most one row per stack, decision, reason and UTC day;
 * written already read so it never inflates the bell's unread count. The row
 * carries names and decisions only, never a label value.
 */
export function recordUpdatePolicyDecision(
  nodeId: number,
  result: UpdatePolicyResult,
  actor: string | null,
): void {
  if (result.decision === 'allow') return;
  const requested = result.evaluation === 'evaluated'
    ? result.services.map(s => s.service)
    : [];
  const ineligible = ineligibleServices(result);
  const detail = ineligible.length > 0
    ? ineligible.map(s => `${s.service} (${s.policy})`).join(', ')
    : 'the Compose model could not be rendered';
  const message = `${DECISION_MESSAGE[result.decision]} by ${SENCHO_UPDATE_LABEL}: ${detail}. `
    + `Triggered by ${TRIGGER_LABEL[result.trigger]}${actor ? ` from ${actor}` : ''}`
    + `${requested.length > 0 ? `; requested services: ${requested.join(', ')}` : ''}.`;

  console.log(
    '[UpdatePolicy] %s %s',
    sanitizeForLog(result.decision),
    sanitizeForLog(JSON.stringify({
      stack: result.stack,
      nodeId,
      trigger: result.trigger,
      actor,
      target: result.target,
      ineligible: ineligible.map(s => ({ service: s.service, policy: s.policy })),
      evaluation: result.evaluation,
    })),
  );

  const reasonKey = crypto.createHash('sha1').update(result.reason ?? '').digest('hex').slice(0, 12);
  const dedupeKey = `update-policy:${result.stack}:${result.decision}:${reasonKey}:${utcDate(Date.now())}`;
  try {
    DatabaseService.getInstance().addNotificationHistory(nodeId, {
      level: 'warning',
      category: 'update_policy',
      message,
      timestamp: Date.now(),
      stack_name: result.stack,
      actor_username: actor,
      dedupe_key: dedupeKey,
      read: true,
    });
  } catch (error) {
    console.error(
      '[UpdatePolicy] Could not record the decision for %s: %s',
      sanitizeForLog(result.stack),
      sanitizeForLog(getErrorMessage(error, 'unknown')),
    );
  }
}
