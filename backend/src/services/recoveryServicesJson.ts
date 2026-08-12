/**
 * Structural validation for stack-update recovery services_json payloads.
 * Fail closed on any unexpected shape so eligibility, compensate, and probe
 * share one authoritative parser.
 */
import type { ImageReferenceKind } from './composeProjectContext';

export interface StackRecoveryReplicaCapture {
  containerId: string | null;
  imageId: string | null;
  repoDigest: string | null;
  state: 'running' | 'stopped' | 'none';
  rollbackTag: string | null;
}

export interface StackRecoveryServiceCapture {
  serviceName: string;
  /** Observed running replica count at capture (supported restore scale). */
  scale: number;
  hasBuild: boolean;
  declaredImageRef: string | null;
  referenceKind: ImageReferenceKind;
  replicas: StackRecoveryReplicaCapture[];
}

export type ParsedServicesJson =
  | { ok: true; services: StackRecoveryServiceCapture[] }
  | { ok: false };

const REPLICA_STATES = new Set(['running', 'stopped', 'none']);
const REFERENCE_KINDS = new Set<ImageReferenceKind>(['moving_tag', 'digest_pinned', 'none']);

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Accepts null/undefined/string; rejects any other type. */
function isNullableString(v: unknown): v is string | null | undefined {
  return v === null || v === undefined || typeof v === 'string';
}

function asNullableString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function parseReplicaCapture(raw: unknown): StackRecoveryReplicaCapture | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isNullableString(r.containerId)
    || !isNullableString(r.imageId)
    || !isNullableString(r.repoDigest)
    || !isNullableString(r.rollbackTag)) {
    return null;
  }
  if (typeof r.state !== 'string' || !REPLICA_STATES.has(r.state)) return null;

  const state = r.state as StackRecoveryReplicaCapture['state'];
  const imageId = asNullableString(r.imageId);
  // Running/stopped replicas must carry a protectable image identity.
  if ((state === 'running' || state === 'stopped') && !imageId?.trim()) {
    return null;
  }
  return {
    containerId: asNullableString(r.containerId),
    imageId,
    repoDigest: asNullableString(r.repoDigest),
    state,
    rollbackTag: asNullableString(r.rollbackTag),
  };
}

function parseServiceCapture(raw: unknown): StackRecoveryServiceCapture | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (!isNonEmptyString(s.serviceName)) return null;
  if (typeof s.scale !== 'number' || !Number.isInteger(s.scale) || s.scale < 0) return null;
  if (typeof s.hasBuild !== 'boolean') return null;
  if (!isNullableString(s.declaredImageRef)) return null;
  if (typeof s.referenceKind !== 'string' || !REFERENCE_KINDS.has(s.referenceKind as ImageReferenceKind)) {
    return null;
  }
  if (!Array.isArray(s.replicas)) return null;

  const replicas: StackRecoveryReplicaCapture[] = [];
  for (const item of s.replicas) {
    const replica = parseReplicaCapture(item);
    if (!replica) return null;
    replicas.push(replica);
  }
  return {
    serviceName: s.serviceName,
    scale: s.scale,
    hasBuild: s.hasBuild,
    declaredImageRef: asNullableString(s.declaredImageRef),
    referenceKind: s.referenceKind as ImageReferenceKind,
    replicas,
  };
}

/** Strict structural validation for recovery services_json (fail closed). */
export function parseServicesJsonStrict(raw: string): ParsedServicesJson {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { ok: false };
    const services: StackRecoveryServiceCapture[] = [];
    for (const item of parsed) {
      const svc = parseServiceCapture(item);
      if (!svc) return { ok: false };
      services.push(svc);
    }
    return { ok: true, services };
  } catch {
    return { ok: false };
  }
}

/** Lenient parse for callers that treat empty as no services (legacy). Prefer strict. */
export function parseServicesJson(raw: string): StackRecoveryServiceCapture[] {
  const parsed = parseServicesJsonStrict(raw);
  return parsed.ok ? parsed.services : [];
}

export function collectImageIds(services: StackRecoveryServiceCapture[]): string[] {
  const ids = new Set<string>();
  for (const svc of services) {
    for (const replica of svc.replicas) {
      if (replica.imageId?.trim()) ids.add(replica.imageId);
    }
  }
  return [...ids];
}

export function collectImageIdsFromServicesJson(servicesJson: string): string[] {
  return collectImageIds(parseServicesJson(servicesJson));
}

export function collectRollbackTags(services: StackRecoveryServiceCapture[]): string[] {
  const tags = new Set<string>();
  for (const svc of services) {
    for (const replica of svc.replicas) {
      if (replica.rollbackTag?.trim()) tags.add(replica.rollbackTag);
    }
  }
  return [...tags];
}

/**
 * Best-effort rollbackTag scrape for cleanup paths. Prefer strict parse; on
 * structural failure walk nested objects for string rollbackTag fields so
 * opaque holds are still removed when possible.
 */
export function scrapeRollbackTagsLenient(raw: string): string[] {
  const strict = parseServicesJsonStrict(raw);
  if (strict.ok) return collectRollbackTags(strict.services);
  try {
    const parsed: unknown = JSON.parse(raw);
    const tags = new Set<string>();
    const walk = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
        return;
      }
      const obj = value as Record<string, unknown>;
      if (typeof obj.rollbackTag === 'string' && obj.rollbackTag.trim()) {
        tags.add(obj.rollbackTag);
      }
      for (const nested of Object.values(obj)) walk(nested);
    };
    walk(parsed);
    return [...tags];
  } catch {
    return [];
  }
}
