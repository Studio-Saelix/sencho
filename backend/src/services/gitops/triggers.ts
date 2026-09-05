/**
 * Normalized reconciliation triggers for the GitOps source controller.
 *
 * A trigger only authorizes evaluation; it is not proof anything changed.
 * `manual`, `api`, `webhook`, `poll`, `retry`, `config_change`, `startup`,
 * and `resume` have real producers. `provider_event`, `schedule`, and
 * `binding_change` are typed here ahead of the producers that will emit
 * them, so a later change extends this union instead of inventing a
 * parallel one.
 */
export type ReconcileTrigger =
  | 'manual'
  | 'api'
  | 'webhook'
  | 'poll'
  | 'retry'
  | 'config_change'
  | 'startup'
  | 'resume'
  | 'provider_event'
  | 'schedule'
  | 'binding_change';

/**
 * One normalized submission to the controller. `dismiss` is deliberately
 * not a reconcile intent: it changes candidate state but does not
 * authorize source evaluation.
 */
export type ReconcileRequest =
  | {
      intent: 'fetch';
      applicationId: string;
      stackName: string;
      trigger: ReconcileTrigger;
      actor: string;
      deliveryId?: string;
    }
  | {
      intent: 'apply';
      applicationId: string;
      stackName: string;
      trigger: ReconcileTrigger;
      actor: string;
      commitSha: string;
      planFingerprint: string;
      deploy: boolean;
      deliveryId?: string;
    };

/**
 * The in-process joining key for concurrent evaluations of the same work.
 * A fetch has only one live outcome per application regardless of trigger,
 * so any two fetch submissions for the same application and stack join. An
 * apply is identified by exactly what it would do: two applies join only
 * when they target the same commit, the same plan fingerprint, and the
 * same deploy choice. Two applies that differ in any of those must never
 * join, or one request could silently receive another request's result.
 *
 * Both the fetch and the apply form carry the stack name alongside the
 * applicationId, so a caller that pairs a live applicationId with the
 * wrong stackName can never join a leader evaluating the right one.
 */
export function coalesceKey(request: ReconcileRequest): string {
  if (request.intent === 'fetch') {
    return `${request.applicationId}:${request.stackName}:fetch`;
  }
  return `${request.applicationId}:${request.stackName}:apply:${request.commitSha}:${request.planFingerprint}:${request.deploy}`;
}

/**
 * A producer-namespaced key for an external delivery, so the same delivery
 * id from two different trigger sources is never treated as one delivery.
 * Also namespaced by intent: a webhook that both fetches and applies under
 * one delivery id must reserve two distinct attempts, not have the apply's
 * reservation collide with the fetch's and silently never run.
 */
export function deliveryKey(trigger: ReconcileTrigger, intent: ReconcileRequest['intent'], deliveryId: string): string {
  return `${trigger}:${intent}:${deliveryId}`;
}
