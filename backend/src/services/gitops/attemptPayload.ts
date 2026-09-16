import { decodeGitOpsJson, encodeGitOpsJson, isRecord } from './json';

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
