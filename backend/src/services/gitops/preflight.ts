import { createHash } from 'crypto';
import { encodeGitOpsJson, isPreflightFingerprint } from './json';

export type PreflightSlotStatus = 'unknown' | 'not_required' | 'ready' | 'blocked';

export type RegistryCredentialSourceClass = 'public' | 'node_local' | 'hub_ephemeral';

export type RegistryTargetReadinessClass =
  | 'not_required'
  | 'ready'
  | 'auth_missing'
  | 'auth_invalid'
  | 'auth_expired'
  | 'registry_unreachable'
  | 'tls_trust_failed'
  | 'capability_unsupported'
  | 'unknown';

/**
 * Redacted per-target registry readiness. Never credentials, tokens, or
 * usernames. Hostnames and class enums only.
 */
export type PreflightRegistryTargetEvidence = {
  nodeId: number;
  sourceClass: RegistryCredentialSourceClass;
  readiness: RegistryTargetReadinessClass;
  hosts: readonly string[];
  expired: boolean;
};

/**
 * Redacted preflight evidence for a rollout authorization.
 *
 * Slot values plus optional per-target registry rows. Never credentials,
 * secret material, registry tokens, or source content.
 */
export type PreflightEvidenceBody = {
  capability: PreflightSlotStatus;
  secretReadiness: PreflightSlotStatus;
  registryReadiness: PreflightSlotStatus;
  connectivity: PreflightSlotStatus;
  /** Artifact set the evaluation was computed against. Null when not applicable. */
  artifactSetId: string | null;
  /** Sorted by nodeId. Included in the fingerprint. */
  targets: readonly PreflightRegistryTargetEvidence[];
};

const SLOT_STATUSES: ReadonlySet<PreflightSlotStatus> = new Set([
  'unknown',
  'not_required',
  'ready',
  'blocked',
]);

const SOURCE_CLASSES: ReadonlySet<RegistryCredentialSourceClass> = new Set([
  'public',
  'node_local',
  'hub_ephemeral',
]);

const READINESS_CLASSES: ReadonlySet<RegistryTargetReadinessClass> = new Set([
  'not_required',
  'ready',
  'auth_missing',
  'auth_invalid',
  'auth_expired',
  'registry_unreachable',
  'tls_trust_failed',
  'capability_unsupported',
  'unknown',
]);

const BLOCKING_TARGET_READINESS: ReadonlySet<RegistryTargetReadinessClass> = new Set([
  'unknown',
  'auth_missing',
  'auth_invalid',
  'auth_expired',
  'registry_unreachable',
  'tls_trust_failed',
  'capability_unsupported',
]);

function coerceSlot(value: unknown, fallback: PreflightSlotStatus): PreflightSlotStatus {
  if (typeof value === 'string' && SLOT_STATUSES.has(value as PreflightSlotStatus)) {
    return value as PreflightSlotStatus;
  }
  return fallback;
}

function coerceTarget(value: unknown): PreflightRegistryTargetEvidence | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.nodeId !== 'number' || !Number.isFinite(row.nodeId)) return null;
  if (typeof row.sourceClass !== 'string' || !SOURCE_CLASSES.has(row.sourceClass as RegistryCredentialSourceClass)) {
    return null;
  }
  if (typeof row.readiness !== 'string' || !READINESS_CLASSES.has(row.readiness as RegistryTargetReadinessClass)) {
    return null;
  }
  if (!Array.isArray(row.hosts) || !row.hosts.every((h) => typeof h === 'string')) return null;
  const expired = row.expired === true;
  return {
    nodeId: row.nodeId,
    sourceClass: row.sourceClass as RegistryCredentialSourceClass,
    readiness: row.readiness as RegistryTargetReadinessClass,
    hosts: [...row.hosts].sort((a, b) => a.localeCompare(b)),
    expired,
  };
}

function canonicalizeTargets(
  targets: readonly PreflightRegistryTargetEvidence[] | undefined,
): PreflightRegistryTargetEvidence[] {
  if (!targets || targets.length === 0) return [];
  return [...targets]
    .map((t) => ({
      nodeId: t.nodeId,
      sourceClass: t.sourceClass,
      readiness: t.readiness,
      hosts: [...t.hosts].sort((a, b) => a.localeCompare(b)),
      expired: t.expired === true,
    }))
    .sort((a, b) => a.nodeId - b.nodeId);
}

/** Collapse per-target readiness into the registry aggregate slot. */
export function aggregateRegistryReadiness(
  targets: readonly PreflightRegistryTargetEvidence[],
): PreflightSlotStatus {
  if (targets.length === 0) return 'unknown';
  if (targets.some((t) => BLOCKING_TARGET_READINESS.has(t.readiness))) return 'blocked';
  if (targets.every((t) => t.readiness === 'not_required')) return 'not_required';
  return 'ready';
}

/**
 * Build a redacted preflight body. Defaults are honest unknowns until
 * capability, secret, registry, and connectivity producers exist.
 * When `targets` is provided, `registryReadiness` is derived from them
 * unless an explicit override is also passed.
 */
export function buildPreflightEvidence(
  overrides?: Partial<PreflightEvidenceBody>,
): PreflightEvidenceBody {
  const targets = canonicalizeTargets(overrides?.targets);
  const derivedRegistry = targets.length > 0
    ? aggregateRegistryReadiness(targets)
    : undefined;
  return {
    capability: coerceSlot(overrides?.capability, 'unknown'),
    secretReadiness: coerceSlot(overrides?.secretReadiness, 'unknown'),
    registryReadiness: coerceSlot(
      overrides?.registryReadiness ?? derivedRegistry,
      'unknown',
    ),
    connectivity: coerceSlot(overrides?.connectivity, 'unknown'),
    artifactSetId: typeof overrides?.artifactSetId === 'string'
      ? overrides.artifactSetId
      : overrides?.artifactSetId === null
        ? null
        : null,
    targets,
  };
}

/**
 * Canonical JSON for fingerprinting. Fixed key order, no extra fields, so
 * two equal slot maps always hash the same.
 */
export function encodePreflightEvidenceJson(body: PreflightEvidenceBody): string {
  return encodeGitOpsJson({
    artifactSetId: body.artifactSetId,
    capability: body.capability,
    connectivity: body.connectivity,
    registryReadiness: body.registryReadiness,
    secretReadiness: body.secretReadiness,
    targets: canonicalizeTargets(body.targets).map((t) => ({
      expired: t.expired,
      hosts: t.hosts,
      nodeId: t.nodeId,
      readiness: t.readiness,
      sourceClass: t.sourceClass,
    })),
  });
}

export function decodePreflightEvidenceJson(raw: string): PreflightEvidenceBody {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return buildPreflightEvidence();
  }
  if (!decoded || typeof decoded !== 'object') return buildPreflightEvidence();
  const obj = decoded as Record<string, unknown>;
  const targetsRaw = Array.isArray(obj.targets) ? obj.targets : [];
  const targets = targetsRaw
    .map(coerceTarget)
    .filter((t): t is PreflightRegistryTargetEvidence => t !== null);
  return buildPreflightEvidence({
    capability: coerceSlot(obj.capability, 'unknown'),
    secretReadiness: coerceSlot(obj.secretReadiness, 'unknown'),
    registryReadiness: coerceSlot(obj.registryReadiness, 'unknown'),
    connectivity: coerceSlot(obj.connectivity, 'unknown'),
    artifactSetId: typeof obj.artifactSetId === 'string' ? obj.artifactSetId : null,
    targets,
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
    || body.registryReadiness === 'unknown'
    || body.connectivity === 'blocked';
}

const TRANSIENT_REGISTRY_TARGET_READINESS: ReadonlySet<RegistryTargetReadinessClass> = new Set([
  'registry_unreachable',
  'unknown',
]);

/** True when a blocked evaluation is likely to clear on retry (reachability, timeout). */
export function isRegistryPreflightTransient(body: PreflightEvidenceBody): boolean {
  if (body.targets.some((t) => TRANSIENT_REGISTRY_TARGET_READINESS.has(t.readiness))) {
    return true;
  }
  if (body.registryReadiness === 'unknown') {
    return true;
  }
  return false;
}

/** Operator-facing reason from the worst target class. Never secrets. */
export function registryPreflightBlockReason(body: PreflightEvidenceBody): string {
  const priority: RegistryTargetReadinessClass[] = [
    'capability_unsupported',
    'auth_missing',
    'auth_invalid',
    'auth_expired',
    'tls_trust_failed',
    'registry_unreachable',
    'unknown',
  ];
  for (const cls of priority) {
    const hit = body.targets.find((t) => t.readiness === cls);
    if (!hit) continue;
    switch (cls) {
      case 'capability_unsupported':
        return 'This node cannot accept hub registry credentials.';
      case 'auth_missing':
        return 'Registry credentials are missing for a required private image.';
      case 'auth_invalid':
        return 'Registry credentials are invalid for a required private image.';
      case 'auth_expired':
        return 'Registry credentials have expired for a required private image.';
      case 'tls_trust_failed':
        return 'Registry TLS or trust failed for a required private image.';
      case 'registry_unreachable':
        return 'A required private registry is unreachable.';
      default:
        return 'Private registry readiness could not be proven.';
    }
  }
  if (body.registryReadiness === 'blocked' || body.registryReadiness === 'unknown') {
    return 'Private registry readiness could not be proven.';
  }
  return 'One or more preflight slots are blocked.';
}
