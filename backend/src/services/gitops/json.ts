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

export type ArtifactEvidenceJson =
  | { kind: 'unresolved' }
  | { kind: 'exact'; identity: string }
  | { kind: 'qualified'; identity: string }
  | { kind: 'stale'; identity: string | null }
  | { kind: 'unavailable' }
  | { kind: 'local_build_unverified'; identity: string | null };

function requireNonEmptyIdentity(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new GitOpsJsonError('artifact identity must be a non-empty string');
  }
  return value;
}

export function decodeArtifactEvidenceJson(raw: string): ArtifactEvidenceJson {
  const decoded = decodeGitOpsJson(raw);
  if (!isRecord(decoded) || typeof decoded.kind !== 'string') {
    throw new GitOpsJsonError('evidence_json must have a kind');
  }
  const keys = Object.keys(decoded);
  switch (decoded.kind) {
    case 'unresolved':
    case 'unavailable':
      if (keys.length !== 1 || 'identity' in decoded) {
        throw new GitOpsJsonError(`${decoded.kind} evidence forbids identity`);
      }
      return { kind: decoded.kind };
    case 'exact':
    case 'qualified':
      if (keys.length !== 2) {
        throw new GitOpsJsonError(`${decoded.kind} evidence requires identity only`);
      }
      return { kind: decoded.kind, identity: requireNonEmptyIdentity(decoded.identity) };
    case 'stale':
    case 'local_build_unverified':
      if (keys.length !== 2 || !('identity' in decoded)) {
        throw new GitOpsJsonError(`${decoded.kind} evidence requires identity`);
      }
      if (decoded.identity !== null && typeof decoded.identity !== 'string') {
        throw new GitOpsJsonError(`${decoded.kind} identity must be string or null`);
      }
      return { kind: decoded.kind, identity: decoded.identity };
    default:
      throw new GitOpsJsonError('unknown artifact evidence kind');
  }
}

export function encodeArtifactEvidenceJson(value: ArtifactEvidenceJson): string {
  const encoded = encodeGitOpsJson(value);
  // Round-trip through the decoder so an invalid shape throws here rather than
  // reaching SQLite. The decoded value is deliberately discarded.
  decodeArtifactEvidenceJson(encoded);
  return encoded;
}

export type ObservedArtifactIdentity =
  | { kind: 'unknown' }
  | { kind: 'missing' }
  | { kind: 'unavailable' }
  | { kind: 'exact'; identity: string; observedAt: number }
  | { kind: 'qualified'; identity: string; observedAt: number }
  | { kind: 'stale'; identity: string; observedAt: number }
  | { kind: 'local_build_unverified'; identity: string; observedAt: number };

export function decodeObservedArtifactIdentity(raw: string | null): ObservedArtifactIdentity {
  if (raw === null) return { kind: 'unknown' };
  const decoded = decodeGitOpsJson(raw);
  if (!isRecord(decoded) || typeof decoded.kind !== 'string') {
    throw new GitOpsJsonError('observed artifact identity must have a kind');
  }
  const keys = Object.keys(decoded);
  switch (decoded.kind) {
    case 'unknown':
      if (keys.length !== 1) {
        throw new GitOpsJsonError('unknown observation forbids extra fields');
      }
      return { kind: 'unknown' };
    case 'missing':
    case 'unavailable':
      if (keys.length !== 1 || 'identity' in decoded) {
        throw new GitOpsJsonError(`${decoded.kind} observation forbids identity`);
      }
      return { kind: decoded.kind };
    case 'exact':
    case 'qualified':
    case 'stale':
    case 'local_build_unverified':
      if (keys.length !== 3 || !('identity' in decoded) || !('observedAt' in decoded)) {
        throw new GitOpsJsonError(`${decoded.kind} observation requires identity and observedAt`);
      }
      if (typeof decoded.identity !== 'string' || decoded.identity.length === 0) {
        throw new GitOpsJsonError(`${decoded.kind} observation identity must be a non-empty string`);
      }
      if (typeof decoded.observedAt !== 'number' || !Number.isFinite(decoded.observedAt)) {
        throw new GitOpsJsonError(`${decoded.kind} observation observedAt must be a finite number`);
      }
      return { kind: decoded.kind, identity: decoded.identity, observedAt: decoded.observedAt };
    default:
      throw new GitOpsJsonError('unknown observed artifact identity kind');
  }
}
