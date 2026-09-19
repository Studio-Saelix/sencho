import { createHash } from 'crypto';
import { encodeGitOpsJson, isPreflightFingerprint } from './json';

export type PreflightSlotStatus = 'unknown' | 'not_required' | 'ready' | 'blocked';

/**
 * Redacted preflight evidence for a rollout authorization.
 *
 * Slot values only. Never credentials, secret material, registry tokens, or
 * source content. Producers that do not exist yet leave slots as `unknown`
 * or `not_required`.
 */
export type PreflightEvidenceBody = {
  capability: PreflightSlotStatus;
  secretReadiness: PreflightSlotStatus;
  registryReadiness: PreflightSlotStatus;
  connectivity: PreflightSlotStatus;
};

const SLOT_STATUSES: ReadonlySet<PreflightSlotStatus> = new Set([
  'unknown',
  'not_required',
  'ready',
  'blocked',
]);

function coerceSlot(value: unknown, fallback: PreflightSlotStatus): PreflightSlotStatus {
  if (typeof value === 'string' && SLOT_STATUSES.has(value as PreflightSlotStatus)) {
    return value as PreflightSlotStatus;
  }
  return fallback;
}

/**
 * Build a redacted preflight body. Defaults are honest unknowns until
 * capability, secret, registry, and connectivity producers exist.
 */
export function buildPreflightEvidence(
  overrides?: Partial<PreflightEvidenceBody>,
): PreflightEvidenceBody {
  return {
    capability: coerceSlot(overrides?.capability, 'unknown'),
    secretReadiness: coerceSlot(overrides?.secretReadiness, 'unknown'),
    registryReadiness: coerceSlot(overrides?.registryReadiness, 'unknown'),
    connectivity: coerceSlot(overrides?.connectivity, 'unknown'),
  };
}

/**
 * Canonical JSON for fingerprinting. Fixed key order, no extra fields, so
 * two equal slot maps always hash the same.
 */
export function encodePreflightEvidenceJson(body: PreflightEvidenceBody): string {
  return encodeGitOpsJson({
    capability: body.capability,
    connectivity: body.connectivity,
    registryReadiness: body.registryReadiness,
    secretReadiness: body.secretReadiness,
  });
}

export function fingerprintPreflightEvidence(body: PreflightEvidenceBody): string {
  const digest = createHash('sha256').update(encodePreflightEvidenceJson(body)).digest('hex');
  if (!isPreflightFingerprint(digest)) {
    throw new Error('preflight fingerprint must be a 64-char hex digest');
  }
  return digest;
}

export function isPreflightBlocked(body: PreflightEvidenceBody): boolean {
  return body.capability === 'blocked'
    || body.secretReadiness === 'blocked'
    || body.registryReadiness === 'blocked'
    || body.connectivity === 'blocked';
}
