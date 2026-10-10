import { apiFetch, withDeploySession } from '@/lib/api';
import type { FailureClassification } from '@/components/EditorLayout/EditorView';
import type { PolicyBlockPayload } from '@/components/stack/PolicyBlockDialog';

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export type StackActionError = Error & { rolledBack?: boolean; failure?: FailureClassification };

// Fallback classification when the response never reached a Sencho backend
// (proxy 502/504 for a dead remote, or a 503 with no classified body).
const NODE_UNREACHABLE_FAILURE: FailureClassification = {
  reason: 'node_unreachable',
  label: 'Node or Docker unreachable',
  suggestion: 'Check that the node is online and Docker is running, then retry.',
};

const UNREACHABLE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

const SELF_STACK_PROTECTED_CODE = 'self_stack_protected';

export const isSelfStackProtectedResponse = (rawBody: string, status?: number): boolean => {
  if (status !== 409) return false;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    return isRecord(parsed) && parsed.code === SELF_STACK_PROTECTED_CODE;
  } catch {
    return false;
  }
};

const parseFailureClassification = (value: unknown): FailureClassification | undefined => {
  if (
    isRecord(value) &&
    typeof value.reason === 'string' &&
    typeof value.label === 'string' && value.label.trim() &&
    typeof value.suggestion === 'string' && value.suggestion.trim()
  ) {
    return { reason: value.reason, label: value.label, suggestion: value.suggestion };
  }
  if (value !== undefined) {
    // Likely hub/node version skew or a mangled proxy body; the raw error
    // message still renders, only the classification panel is degraded.
    console.warn('Unrecognized failure classification shape in error response:', value);
  }
  return undefined;
};

type StackOpAction =
  | 'deploy'
  | 'down'
  | 'restart'
  | 'stop'
  | 'start'
  | 'update'
  | 'delete'
  | 'image_pull';

interface StackOpInProgressInfo {
  action: StackOpAction;
  startedAt: number;
  user: string;
}

// Covers the lock service's action set (backend/src/services/
// StackOpLockService.ts) except rollback, backup, and git_apply. Those three fail the
// membership check in `parseStackOpInProgress`, so their 409s fall through to
// `parseStackActionError`, which prefers the backend's own body `error`: a complete
// sentence carrying neither the "(started by ...)" suffix nor the trailing period that
// `stackOpInProgressMessage` adds. The union is hand-maintained, so a new backend action
// is not a compile error here; it degrades to the backend sentence rather than failing to
// build.
const STACK_OP_PRESENT_PARTICIPLE: Record<StackOpAction, string> = {
  deploy: 'deploying',
  down: 'taking down',
  restart: 'restarting',
  stop: 'stopping',
  start: 'starting',
  update: 'updating',
  delete: 'deleting',
  image_pull: 'pulling images',
};

const VALID_STACK_OP_ACTIONS: ReadonlySet<string> = new Set(
  Object.keys(STACK_OP_PRESENT_PARTICIPLE),
);

export type UpdateSuccessBody = {
  healthGateId: string | null;
  recheckWarning?: string;
};

/** healthGateId (and optional recheckWarning) from a success body. */
export const parseUpdateSuccessBody = async (response: Response): Promise<UpdateSuccessBody> => {
  try {
    const body: unknown = await response.json();
    if (!isRecord(body)) return { healthGateId: null };
    return {
      healthGateId: typeof body.healthGateId === 'string' ? body.healthGateId : null,
      recheckWarning: typeof body.recheckWarning === 'string' ? body.recheckWarning : undefined,
    };
  } catch (e) {
    // A success body should always parse; the warn surfaces a future
    // double-read bug instead of silently disabling the gate UI.
    console.warn('[HealthGate] could not read the success body:', e);
    return { healthGateId: null };
  }
};

export const parseStackOpInProgress = (rawBody: string): StackOpInProgressInfo | null => {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (!isRecord(parsed) || parsed.code !== 'stack_op_in_progress') return null;
    const inProgress = parsed.inProgress;
    if (
      !isRecord(inProgress) ||
      typeof inProgress.action !== 'string' ||
      typeof inProgress.startedAt !== 'number' ||
      !VALID_STACK_OP_ACTIONS.has(inProgress.action)
    ) {
      return null;
    }
    return {
      action: inProgress.action as StackOpAction,
      startedAt: inProgress.startedAt,
      user: typeof inProgress.user === 'string' ? inProgress.user : '',
    };
  } catch {
    return null;
  }
};

export const stackOpInProgressMessage = (stackName: string, info: StackOpInProgressInfo): string => {
  const verb = STACK_OP_PRESENT_PARTICIPLE[info.action] ?? 'busy';
  const actor = info.user && info.user !== 'system' ? ` (started by ${info.user})` : '';
  return `${stackName} is already ${verb}${actor}.`;
};

export const parseStackActionError = (rawBody: string, fallback: string, status?: number): StackActionError => {
  let message = rawBody || fallback;
  let rolledBack = false;
  let failure: FailureClassification | undefined;
  let parsedCode: string | undefined;
  let bodyWasJson = false;

  try {
    const parsed: unknown = JSON.parse(rawBody);
    bodyWasJson = true;
    if (isRecord(parsed)) {
      if (typeof parsed.error === 'string' && parsed.error.trim()) {
        message = parsed.error;
      }
      rolledBack = parsed.rolledBack === true;
      failure = parseFailureClassification(parsed.failure);
      if (typeof parsed.code === 'string') parsedCode = parsed.code;
    }
  } catch {
    /* not JSON */
  }

  // A gateway-style status with no classified body means the request likely
  // never reached the owning node's backend; surface that as the cause. A 503
  // qualifies only when it is body-less (proxy generated) or the backend's own
  // docker_unavailable shape, so an unrelated future 503 is not mislabeled.
  if (!failure && status !== undefined && UNREACHABLE_STATUSES.has(status)) {
    const qualifies = status !== 503 || !bodyWasJson || parsedCode === 'docker_unavailable';
    if (qualifies) failure = { ...NODE_UNREACHABLE_FAILURE };
  }

  const error = new Error(message) as StackActionError;
  error.rolledBack = rolledBack;
  error.failure = failure;
  return error;
};

/** A stack update's result, classified once so every caller reacts to the same cases. */
export type StackUpdateOutcome =
  | { kind: 'ok'; healthGateId: string | null; recheckWarning?: string }
  | { kind: 'self-stack' }
  | { kind: 'busy'; message: string }
  | { kind: 'policy-blocked'; payload: PolicyBlockPayload; policyName: string }
  | { kind: 'failed'; error: StackActionError };

interface PostStackUpdateParams {
  nodeId: number | null;
  stackName: string;
  /** Streams progress to the deploy-feedback panel when set. */
  deploySessionId?: string;
  ignorePolicy?: boolean;
}

/**
 * The one request that updates a stack, and the one classification of how it
 * ended. The editor, the Auto-updates view and the Fleet readiness verb all
 * call this (the last two through `useStackUpdate`); each decides only how to
 * present the outcome.
 */
export async function postStackUpdate({
  nodeId,
  stackName,
  deploySessionId,
  ignorePolicy = false,
}: PostStackUpdateParams): Promise<StackUpdateOutcome> {
  const path = `/stacks/${encodeURIComponent(stackName)}/update${ignorePolicy ? '?ignorePolicy=true' : ''}`;
  const options = { method: 'POST', nodeId };
  const response = await apiFetch(path, deploySessionId ? withDeploySession(deploySessionId, options) : options);
  if (response.ok) {
    return { kind: 'ok', ...(await parseUpdateSuccessBody(response)) };
  }
  const rawBody = await response.text();
  if (isSelfStackProtectedResponse(rawBody, response.status)) return { kind: 'self-stack' };
  if (response.status === 409) {
    const inProgress = parseStackOpInProgress(rawBody);
    if (inProgress) return { kind: 'busy', message: stackOpInProgressMessage(stackName, inProgress) };
    const payload = parsePolicyBlock(rawBody);
    if (payload?.policy) return { kind: 'policy-blocked', payload, policyName: payload.policy.name };
  }
  return { kind: 'failed', error: parseStackActionError(rawBody, 'update failed', response.status) };
}

/** The policy-gate body of a 409, or null when the body is anything else. */
export function parsePolicyBlock(rawBody: string): PolicyBlockPayload | null {
  try {
    const parsed = JSON.parse(rawBody) as PolicyBlockPayload;
    return parsed.policy && Array.isArray(parsed.violations) ? parsed : null;
  } catch {
    return null;
  }
}
