import { decodeGitOpsJson, encodeGitOpsJson, isRecord } from './json';
import { isNotifiableGitOpsStage, type NotifiableGitOpsStage } from './notifications';

export const SETTLED_ATTEMPT_PAYLOAD_VERSION = 1;

export type SettledAttemptPayloadV1 = {
  version: 1;
  settledHistoryId: string;
  applicationId: string;
  operationId: string;
  stackName: string | null;
  nodeId: number | null;
  outcome: string;
  nextAction: string;
  reason: string | null;
  trigger: string;
  actor: string | null;
  at: number;
};

export type SettledAttemptPayload = SettledAttemptPayloadV1;

export type SettledAttemptDecode =
  | { ok: true; payload: SettledAttemptPayload }
  | { ok: false; limitation: string };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function encodeSettledAttemptPayload(payload: SettledAttemptPayload): string {
  return encodeGitOpsJson(payload);
}

/**
 * Unknown versions and unparseable bodies fail closed as a limitation.
 * Callers must not invent evidence from a payload they could not prove.
 */
export function decodeSettledAttemptPayload(raw: string, version: number): SettledAttemptDecode {
  if (version !== SETTLED_ATTEMPT_PAYLOAD_VERSION) {
    return { ok: false, limitation: `settled_attempt_payload_version_unsupported:${version}` };
  }
  let decoded: unknown;
  try {
    decoded = decodeGitOpsJson(raw);
  } catch {
    return { ok: false, limitation: 'settled_attempt_payload_unparseable' };
  }
  if (!isRecord(decoded) || decoded.version !== SETTLED_ATTEMPT_PAYLOAD_VERSION) {
    return { ok: false, limitation: 'settled_attempt_payload_invalid' };
  }
  if (
    !isNonEmptyString(decoded.settledHistoryId)
    || !isNonEmptyString(decoded.applicationId)
    || !isNonEmptyString(decoded.operationId)
    || !isNonEmptyString(decoded.outcome)
    || !isNonEmptyString(decoded.nextAction)
    || !isNonEmptyString(decoded.trigger)
    || typeof decoded.at !== 'number'
  ) {
    return { ok: false, limitation: 'settled_attempt_payload_invalid' };
  }
  if (decoded.stackName !== null && typeof decoded.stackName !== 'string') {
    return { ok: false, limitation: 'settled_attempt_payload_invalid' };
  }
  if (decoded.nodeId !== null && typeof decoded.nodeId !== 'number') {
    return { ok: false, limitation: 'settled_attempt_payload_invalid' };
  }
  if (decoded.reason !== null && typeof decoded.reason !== 'string') {
    return { ok: false, limitation: 'settled_attempt_payload_invalid' };
  }
  if (decoded.actor !== null && typeof decoded.actor !== 'string') {
    return { ok: false, limitation: 'settled_attempt_payload_invalid' };
  }
  return {
    ok: true,
    payload: {
      version: 1,
      settledHistoryId: decoded.settledHistoryId,
      applicationId: decoded.applicationId,
      operationId: decoded.operationId,
      stackName: decoded.stackName,
      nodeId: decoded.nodeId,
      outcome: decoded.outcome,
      nextAction: decoded.nextAction,
      reason: decoded.reason,
      trigger: decoded.trigger,
      actor: decoded.actor,
      at: decoded.at,
    },
  };
}

export const GITOPS_EVENT_PAYLOAD_VERSION = 2;

/**
 * Payload of a v2 outbox row: one notifiable authority, lifecycle, or
 * stateful-confirmation decision.
 *
 * Carries identities and the recorded operator reason only. Source content,
 * diffs, digests, and secret values never reach this payload, and the drain
 * composes the notification message from the stage mapping rather than from
 * free text here, so a rewritten payload cannot inject a message the mapping
 * does not produce.
 */
export type GitOpsEventPayloadV2 = {
  version: 2;
  historyId: string;
  applicationId: string;
  operationId: string;
  stage: NotifiableGitOpsStage;
  stackName: string | null;
  nodeId: number | null;
  actor: string | null;
  reason: string | null;
  at: number;
};

export type GitOpsEventPayload = GitOpsEventPayloadV2;

export type GitOpsEventDecode =
  | { ok: true; payload: GitOpsEventPayload }
  | { ok: false; limitation: string };

export function encodeGitOpsEventPayload(payload: GitOpsEventPayload): string {
  return encodeGitOpsJson(payload);
}

/**
 * Decode one v2 outbox row, failing closed on anything the writer could not
 * have produced.
 *
 * A stage that is no longer in the notifiable set stays undrained rather than
 * being dropped or mapped to a guess, which is the same bargain the v1 decoder
 * makes for unknown versions: a payload nobody can prove is a payload nobody
 * notifies from.
 */
export function decodeGitOpsEventPayload(raw: string, version: number): GitOpsEventDecode {
  if (version !== GITOPS_EVENT_PAYLOAD_VERSION) {
    return { ok: false, limitation: `gitops_event_payload_version_unsupported:${version}` };
  }
  let decoded: unknown;
  try {
    decoded = decodeGitOpsJson(raw);
  } catch {
    return { ok: false, limitation: 'gitops_event_payload_unparseable' };
  }
  if (!isRecord(decoded) || decoded.version !== GITOPS_EVENT_PAYLOAD_VERSION) {
    return { ok: false, limitation: 'gitops_event_payload_invalid' };
  }
  if (
    !isNonEmptyString(decoded.historyId)
    || !isNonEmptyString(decoded.applicationId)
    || !isNonEmptyString(decoded.operationId)
    || typeof decoded.stage !== 'string'
    || !isNotifiableGitOpsStage(decoded.stage)
    || typeof decoded.at !== 'number'
  ) {
    return { ok: false, limitation: 'gitops_event_payload_invalid' };
  }
  if (decoded.stackName !== null && typeof decoded.stackName !== 'string') {
    return { ok: false, limitation: 'gitops_event_payload_invalid' };
  }
  if (decoded.nodeId !== null && typeof decoded.nodeId !== 'number') {
    return { ok: false, limitation: 'gitops_event_payload_invalid' };
  }
  if (decoded.actor !== null && typeof decoded.actor !== 'string') {
    return { ok: false, limitation: 'gitops_event_payload_invalid' };
  }
  if (decoded.reason !== null && typeof decoded.reason !== 'string') {
    return { ok: false, limitation: 'gitops_event_payload_invalid' };
  }
  return {
    ok: true,
    payload: {
      version: 2,
      historyId: decoded.historyId,
      applicationId: decoded.applicationId,
      operationId: decoded.operationId,
      stage: decoded.stage,
      stackName: decoded.stackName,
      nodeId: decoded.nodeId,
      actor: decoded.actor,
      reason: decoded.reason,
      at: decoded.at,
    },
  };
}
