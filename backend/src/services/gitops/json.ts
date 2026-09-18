import crypto from 'crypto';

export class GitOpsJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitOpsJsonError';
  }
}

export function encodeGitOpsJson(value: unknown): string {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new GitOpsJsonError(`gitops json encode failed: ${message}`);
  }
  // JSON.stringify returns undefined (it does not throw) for undefined, a
  // function, or a symbol. Every JSON column is NOT NULL, so letting that
  // through would bind SQL NULL and lose the row.
  if (typeof encoded !== 'string') {
    throw new GitOpsJsonError('gitops json encode produced no output');
  }
  return encoded;
}

export function decodeGitOpsJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new GitOpsJsonError('gitops json decode failed');
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value);
}

export function isPositiveInteger(value: unknown): value is number {
  return isFiniteInteger(value) && value > 0;
}

export const PREFLIGHT_FINGERPRINT_RE = /^[0-9a-f]{64}$/;

export function isPreflightFingerprint(value: unknown): value is string {
  return typeof value === 'string' && PREFLIGHT_FINGERPRINT_RE.test(value);
}

export type GitOpsRequiredTargetsJson = { nodeIds: number[] };

export function canonicalizeNodeIds(nodeIds: readonly number[]): number[] {
  return Array.from(new Set(nodeIds)).sort((a, b) => a - b);
}

export function decodeGitOpsRequiredTargetsJson(raw: string): GitOpsRequiredTargetsJson {
  const decoded = decodeGitOpsJson(raw);
  if (!isRecord(decoded)) {
    throw new GitOpsJsonError('required_targets_json must be an object');
  }
  const keys = Object.keys(decoded);
  if (keys.length !== 1 || keys[0] !== 'nodeIds') {
    throw new GitOpsJsonError('required_targets_json must have only nodeIds');
  }
  if (!Array.isArray(decoded.nodeIds)) {
    throw new GitOpsJsonError('required_targets_json.nodeIds must be an array');
  }
  const nodeIds: number[] = [];
  for (const item of decoded.nodeIds) {
    if (!isFiniteInteger(item)) {
      throw new GitOpsJsonError('required_targets_json.nodeIds must be integers');
    }
    nodeIds.push(item);
  }
  const canonical = canonicalizeNodeIds(nodeIds);
  if (canonical.length !== nodeIds.length) {
    throw new GitOpsJsonError('required_targets_json.nodeIds must be unique');
  }
  for (let i = 0; i < nodeIds.length; i += 1) {
    if (nodeIds[i] !== canonical[i]) {
      throw new GitOpsJsonError('required_targets_json.nodeIds must be sorted unique');
    }
  }
  return { nodeIds };
}

export function encodeGitOpsRequiredTargetsJson(nodeIds: readonly number[]): string {
  const canonical = canonicalizeNodeIds(nodeIds);
  if (canonical.length !== nodeIds.length) {
    throw new GitOpsJsonError('required_targets_json.nodeIds must be unique');
  }
  for (let i = 0; i < nodeIds.length; i += 1) {
    if (nodeIds[i] !== canonical[i]) {
      throw new GitOpsJsonError('required_targets_json.nodeIds must be sorted unique');
    }
    if (!isFiniteInteger(nodeIds[i])) {
      throw new GitOpsJsonError('required_targets_json.nodeIds must be integers');
    }
  }
  return encodeGitOpsJson({ nodeIds: [...nodeIds] });
}

/**
 * Why a writer could not prove something, recorded on the row it affected.
 *
 * Distinct from the limitations the deriver computes at read time: those are
 * re-derivable from current rows, these are facts only the transition that
 * dropped a pointer knew. Without them a pointer that was cleared because it
 * could not be proven is indistinguishable from one that never existed.
 */
export type GitOpsEvidenceLimitation = { code: string; detail: string | null };

export function decodeGitOpsEvidenceLimitations(raw: string | null): GitOpsEvidenceLimitation[] {
  if (raw === null) return [];
  const decoded = decodeGitOpsJson(raw);
  if (!Array.isArray(decoded)) {
    throw new GitOpsJsonError('evidence_limitations_json must be an array');
  }
  return decoded.map((item) => {
    if (!isRecord(item)) throw new GitOpsJsonError('evidence limitation must be an object');
    const keys = Object.keys(item);
    if (keys.length !== 2 || !('code' in item) || !('detail' in item)) {
      throw new GitOpsJsonError('evidence limitation must have exactly code and detail');
    }
    if (typeof item.code !== 'string' || item.code.length === 0) {
      throw new GitOpsJsonError('evidence limitation code must be a non-empty string');
    }
    if (item.detail !== null && typeof item.detail !== 'string') {
      throw new GitOpsJsonError('evidence limitation detail must be a string or null');
    }
    return { code: item.code, detail: item.detail };
  });
}

/**
 * Replace the limitations for one code, keeping every other code intact.
 *
 * Returns null when nothing remains, so a row that has recovered its evidence
 * stores NULL rather than an empty array.
 */
export function encodeGitOpsEvidenceLimitations(
  existing: GitOpsEvidenceLimitation[],
  code: string,
  next: GitOpsEvidenceLimitation | null,
): string | null {
  const kept = existing.filter((item) => item.code !== code);
  if (next) kept.push(next);
  if (kept.length === 0) return null;
  const encoded = encodeGitOpsJson(kept);
  decodeGitOpsEvidenceLimitations(encoded);
  return encoded;
}

export type GitOpsApprovedTargetEffectJson = Array<{ nodeId: number; outcome: 'place' | 'remove' }>;

export function decodeGitOpsApprovedTargetEffectJson(raw: string): GitOpsApprovedTargetEffectJson {
  const decoded = decodeGitOpsJson(raw);
  if (!Array.isArray(decoded)) {
    throw new GitOpsJsonError('blast_json must be an array');
  }
  const out: GitOpsApprovedTargetEffectJson = [];
  const seen = new Set<number>();
  let lastNodeId = Number.NEGATIVE_INFINITY;
  for (const item of decoded) {
    if (!isRecord(item)) {
      throw new GitOpsJsonError('blast_json entries must be objects');
    }
    const keys = Object.keys(item);
    if (keys.length !== 2 || !('nodeId' in item) || !('outcome' in item)) {
      throw new GitOpsJsonError('blast_json entries must have exactly nodeId and outcome');
    }
    if (!isPositiveInteger(item.nodeId)) {
      throw new GitOpsJsonError('blast_json.nodeId must be a positive integer');
    }
    if (item.outcome !== 'place' && item.outcome !== 'remove') {
      throw new GitOpsJsonError('blast_json.outcome must be place or remove');
    }
    if (seen.has(item.nodeId)) {
      throw new GitOpsJsonError('blast_json node ids must be unique');
    }
    if (item.nodeId <= lastNodeId) {
      throw new GitOpsJsonError('blast_json must be strictly increasing by nodeId');
    }
    seen.add(item.nodeId);
    lastNodeId = item.nodeId;
    out.push({ nodeId: item.nodeId, outcome: item.outcome });
  }
  return out;
}

export function encodeGitOpsApprovedTargetEffectJson(
  effect: GitOpsApprovedTargetEffectJson,
): string {
  const encoded = encodeGitOpsJson(effect);
  // Round-trip through the decoder so an invalid shape throws here rather than
  // reaching SQLite. The decoded value is deliberately discarded.
  decodeGitOpsApprovedTargetEffectJson(encoded);
  return encoded;
}

export type ArtifactServiceSource = 'registry' | 'build' | 'unsupported';

export type ArtifactServiceFailureClass =
  | 'unresolved'
  | 'registry_unavailable'
  | 'credential_failure'
  | 'unsupported_registry'
  | 'platform_ambiguity'
  | 'digest_unavailable'
  | 'stale_resolution';

export interface ServiceArtifactEvidence {
  serviceName: string;
  authoredRef: string | null;
  source: ArtifactServiceSource;
  platform: string | null;
  indexDigest: string | null;
  platformDigest: string | null;
  buildContextFingerprint: string | null;
  producedImageId: string | null;
  failureClass: ArtifactServiceFailureClass | null;
  resolvedAt: number | null;
}

const ARTIFACT_SERVICE_SOURCES = new Set<ArtifactServiceSource>(['registry', 'build', 'unsupported']);
const ARTIFACT_SERVICE_FAILURES = new Set<ArtifactServiceFailureClass>([
  'unresolved',
  'registry_unavailable',
  'credential_failure',
  'unsupported_registry',
  'platform_ambiguity',
  'digest_unavailable',
  'stale_resolution',
]);

function assertArtifactEvidenceKeys(decoded: Record<string, unknown>, allowed: readonly string[]): void {
  const keys = Object.keys(decoded);
  for (const key of keys) {
    if (!allowed.includes(key)) {
      throw new GitOpsJsonError('artifact evidence has unknown keys');
    }
  }
}

function decodeServiceArtifactEvidence(value: unknown): ServiceArtifactEvidence {
  if (!isRecord(value)) {
    throw new GitOpsJsonError('service artifact evidence must be an object');
  }
  const keys = Object.keys(value);
  const allowed = [
    'serviceName',
    'authoredRef',
    'source',
    'platform',
    'indexDigest',
    'platformDigest',
    'buildContextFingerprint',
    'producedImageId',
    'failureClass',
    'resolvedAt',
  ];
  for (const key of keys) {
    if (!allowed.includes(key)) {
      throw new GitOpsJsonError('service artifact evidence has unknown keys');
    }
  }
  if (typeof value.serviceName !== 'string' || value.serviceName.length === 0) {
    throw new GitOpsJsonError('service artifact evidence serviceName must be a non-empty string');
  }
  if (value.authoredRef !== null && typeof value.authoredRef !== 'string') {
    throw new GitOpsJsonError('service artifact evidence authoredRef must be a string or null');
  }
  if (typeof value.source !== 'string' || !ARTIFACT_SERVICE_SOURCES.has(value.source as ArtifactServiceSource)) {
    throw new GitOpsJsonError('service artifact evidence source is invalid');
  }
  if (value.platform !== null && typeof value.platform !== 'string') {
    throw new GitOpsJsonError('service artifact evidence platform must be a string or null');
  }
  if (value.indexDigest !== null && typeof value.indexDigest !== 'string') {
    throw new GitOpsJsonError('service artifact evidence indexDigest must be a string or null');
  }
  if (value.platformDigest !== null && typeof value.platformDigest !== 'string') {
    throw new GitOpsJsonError('service artifact evidence platformDigest must be a string or null');
  }
  if (value.buildContextFingerprint !== null && typeof value.buildContextFingerprint !== 'string') {
    throw new GitOpsJsonError('service artifact evidence buildContextFingerprint must be a string or null');
  }
  if (value.producedImageId !== null && typeof value.producedImageId !== 'string') {
    throw new GitOpsJsonError('service artifact evidence producedImageId must be a string or null');
  }
  if (value.failureClass !== null) {
    if (typeof value.failureClass !== 'string' || !ARTIFACT_SERVICE_FAILURES.has(value.failureClass as ArtifactServiceFailureClass)) {
      throw new GitOpsJsonError('service artifact evidence failureClass is invalid');
    }
  }
  if (value.resolvedAt !== null) {
    if (typeof value.resolvedAt !== 'number' || !Number.isFinite(value.resolvedAt)) {
      throw new GitOpsJsonError('service artifact evidence resolvedAt must be a finite number or null');
    }
  }
  return {
    serviceName: value.serviceName,
    authoredRef: value.authoredRef,
    source: value.source as ArtifactServiceSource,
    platform: value.platform,
    indexDigest: value.indexDigest,
    platformDigest: value.platformDigest,
    buildContextFingerprint: value.buildContextFingerprint,
    producedImageId: value.producedImageId,
    failureClass: value.failureClass as ArtifactServiceFailureClass | null,
    resolvedAt: value.resolvedAt,
  };
}

function decodeServiceArtifactEvidenceList(value: unknown): ServiceArtifactEvidence[] {
  if (!Array.isArray(value)) {
    throw new GitOpsJsonError('artifact evidence services must be an array');
  }
  const services = value.map(decodeServiceArtifactEvidence);
  const sorted = canonicalizeServiceEvidence(services);
  for (let i = 0; i < services.length; i += 1) {
    if (services[i].serviceName !== sorted[i].serviceName) {
      throw new GitOpsJsonError('artifact evidence services must be sorted by serviceName');
    }
  }
  const seen = new Set<string>();
  for (const service of services) {
    if (seen.has(service.serviceName)) {
      throw new GitOpsJsonError('artifact evidence services must be unique by serviceName');
    }
    seen.add(service.serviceName);
  }
  return services;
}

export function canonicalizeServiceEvidence(
  services: readonly ServiceArtifactEvidence[],
): ServiceArtifactEvidence[] {
  return [...services].sort((a, b) => a.serviceName.localeCompare(b.serviceName));
}

export function computeArtifactSetFingerprint(services: readonly ServiceArtifactEvidence[]): string {
  const sorted = canonicalizeServiceEvidence(services);
  const parts = sorted.map((service) => {
    const digest = service.platformDigest ?? service.producedImageId ?? '';
    return digest ? `${service.serviceName}@${digest}` : `${service.serviceName}:unverified`;
  });
  const hex = crypto.createHash('sha256').update(parts.join('|')).digest('hex');
  return `sha256:${hex}`;
}

export type ArtifactEvidenceJson =
  | { kind: 'unresolved'; services?: ServiceArtifactEvidence[] }
  | { kind: 'exact'; identity: string; services?: ServiceArtifactEvidence[] }
  | { kind: 'qualified'; identity: string; services?: ServiceArtifactEvidence[] }
  | { kind: 'stale'; identity: string | null; services?: ServiceArtifactEvidence[] }
  | { kind: 'unavailable'; services?: ServiceArtifactEvidence[] }
  | { kind: 'local_build_unverified'; identity: string | null; services?: ServiceArtifactEvidence[] };

function requireNonEmptyIdentity(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new GitOpsJsonError('artifact identity must be a non-empty string');
  }
  return value;
}

function attachServices<T extends ArtifactEvidenceJson>(
  base: T,
  decoded: Record<string, unknown>,
): T {
  if (!('services' in decoded)) return base;
  const services = decodeServiceArtifactEvidenceList(decoded.services);
  return { ...base, services };
}

export function decodeArtifactEvidenceJson(raw: string): ArtifactEvidenceJson {
  const decoded = decodeGitOpsJson(raw);
  if (!isRecord(decoded) || typeof decoded.kind !== 'string') {
    throw new GitOpsJsonError('evidence_json must have a kind');
  }
  switch (decoded.kind) {
    case 'unresolved':
    case 'unavailable':
      assertArtifactEvidenceKeys(decoded, decoded.kind === 'unresolved' || decoded.kind === 'unavailable'
        ? ['kind', 'services']
        : ['kind', 'services']);
      if ('identity' in decoded) {
        throw new GitOpsJsonError(`${decoded.kind} evidence forbids identity`);
      }
      return attachServices({ kind: decoded.kind }, decoded);
    case 'exact':
    case 'qualified':
      assertArtifactEvidenceKeys(decoded, ['kind', 'identity', 'services']);
      return attachServices({
        kind: decoded.kind,
        identity: requireNonEmptyIdentity(decoded.identity),
      }, decoded);
    case 'stale':
    case 'local_build_unverified':
      assertArtifactEvidenceKeys(decoded, ['kind', 'identity', 'services']);
      if (!('identity' in decoded)) {
        throw new GitOpsJsonError(`${decoded.kind} evidence requires identity`);
      }
      if (decoded.identity !== null && typeof decoded.identity !== 'string') {
        throw new GitOpsJsonError(`${decoded.kind} identity must be string or null`);
      }
      return attachServices({ kind: decoded.kind, identity: decoded.identity }, decoded);
    default:
      throw new GitOpsJsonError('unknown artifact evidence kind');
  }
}

export function encodeArtifactEvidenceJson(value: ArtifactEvidenceJson): string {
  const payload: Record<string, unknown> = { kind: value.kind };
  if ('identity' in value) payload.identity = value.identity;
  if (value.services && value.services.length > 0) {
    payload.services = canonicalizeServiceEvidence(value.services);
  }
  const encoded = encodeGitOpsJson(payload);
  decodeArtifactEvidenceJson(encoded);
  return encoded;
}

export type ObservedArtifactIdentity =
  | { kind: 'unknown' }
  | { kind: 'missing' }
  | { kind: 'unavailable' }
  | { kind: 'exact'; identity: string; observedAt: number; services?: ServiceArtifactEvidence[] }
  | { kind: 'qualified'; identity: string; observedAt: number; services?: ServiceArtifactEvidence[] }
  | { kind: 'stale'; identity: string; observedAt: number; services?: ServiceArtifactEvidence[] }
  | { kind: 'local_build_unverified'; identity: string; observedAt: number; services?: ServiceArtifactEvidence[] };

function attachObservedServices<T extends ObservedArtifactIdentity>(
  base: T,
  decoded: Record<string, unknown>,
): T {
  if (!('services' in decoded)) return base;
  const services = decodeServiceArtifactEvidenceList(decoded.services);
  return { ...base, services };
}

export function decodeObservedArtifactIdentity(raw: string | null): ObservedArtifactIdentity {
  if (raw === null) return { kind: 'unknown' };
  const decoded = decodeGitOpsJson(raw);
  if (!isRecord(decoded) || typeof decoded.kind !== 'string') {
    throw new GitOpsJsonError('observed artifact identity must have a kind');
  }
  switch (decoded.kind) {
    case 'unknown':
      assertArtifactEvidenceKeys(decoded, ['kind']);
      return { kind: 'unknown' };
    case 'missing':
    case 'unavailable':
      assertArtifactEvidenceKeys(decoded, ['kind']);
      if ('identity' in decoded) {
        throw new GitOpsJsonError(`${decoded.kind} observation forbids identity`);
      }
      return { kind: decoded.kind };
    case 'exact':
    case 'qualified':
    case 'stale':
    case 'local_build_unverified':
      assertArtifactEvidenceKeys(decoded, ['kind', 'identity', 'observedAt', 'services']);
      if (!('identity' in decoded) || !('observedAt' in decoded)) {
        throw new GitOpsJsonError(`${decoded.kind} observation requires identity and observedAt`);
      }
      if (typeof decoded.identity !== 'string' || decoded.identity.length === 0) {
        throw new GitOpsJsonError(`${decoded.kind} observation identity must be a non-empty string`);
      }
      if (typeof decoded.observedAt !== 'number' || !Number.isFinite(decoded.observedAt)) {
        throw new GitOpsJsonError(`${decoded.kind} observation observedAt must be a finite number`);
      }
      return attachObservedServices({
        kind: decoded.kind,
        identity: decoded.identity,
        observedAt: decoded.observedAt,
      }, decoded);
    default:
      throw new GitOpsJsonError('unknown observed artifact identity kind');
  }
}

export function encodeObservedArtifactIdentity(value: ObservedArtifactIdentity): string {
  const payload: Record<string, unknown> = { kind: value.kind };
  if ('identity' in value) payload.identity = value.identity;
  if ('observedAt' in value) payload.observedAt = value.observedAt;
  if ('services' in value && value.services && value.services.length > 0) {
    payload.services = canonicalizeServiceEvidence(value.services);
  }
  const encoded = encodeGitOpsJson(payload);
  decodeObservedArtifactIdentity(encoded);
  return encoded;
}
