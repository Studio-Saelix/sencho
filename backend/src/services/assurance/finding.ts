/**
 * The normalized assurance finding: what every surface reports, whatever
 * engine produced it.
 *
 * Identity rules:
 * - `fingerprint` is sha256 over (ruleId, stack, service, subject kind, subject
 *   key). It deliberately excludes the node id (node ids are local per instance
 *   and differ across transports), and never includes title, message, severity,
 *   or any evidence value. Cross-node consumers pair `(nodeId, fingerprint)`.
 * - `subjectKey` is the same hash without the rule id. It is the
 *   rule-independent join key that lets Security, Networking, and Doctor agree
 *   they refer to the same fact, with no title-based joins.
 * - A legacy row (stored before `rule_version` and the subject columns existed)
 *   gets `basis: 'legacy'`. Consumers must never deduplicate on a legacy
 *   identity.
 *
 * Acknowledgements stay scoped to one rule: a `decision` on a finding never
 * suppresses a finding under another rule id, even for the same subject.
 */
import { createHash } from 'crypto';

import type { PreflightAckExpiryMode, PreflightFindingRow } from '../DatabaseService';
import type { RuleHit, PreflightFinding } from '../preflight/types';
import { getAssuranceRule } from './ruleRegistry';
import type {
  AliasRelation, AssuranceRule, AssuranceSeverity, CanonicalRuleId, EvidenceLayer, ExternalRuleId,
  FindingClass, FindingConfidence, IdentityBasis, SubjectKind,
} from './types';
import { redactSensitiveText } from '../../utils/safeLog';

export interface AssuranceScope {
  nodeId: number;
  stack: string;
  service?: string;
}

export interface AssuranceSubject {
  kind: SubjectKind;
  key: string;
}

export interface AssuranceLocation {
  file?: string;
  path?: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

export interface AssuranceEvidenceRef {
  layer: EvidenceLayer;
  provider: 'compose-doctor' | 'trivy' | 'exposure-context' | 'docker';
  /** The scanner's own severity label, kept as evidence (never as the grade). */
  externalSeverity?: string;
}

export interface AssuranceDecision {
  kind: 'acknowledged';
  id: number;
  reason: string;
  expiry: { mode: PreflightAckExpiryMode; expiresAt?: number };
}

export interface AssuranceFinding {
  ruleId: CanonicalRuleId | ExternalRuleId;
  /** `null` marks a legacy row stored before rule versions existed. */
  ruleVersion: number | null;
  severity: AssuranceSeverity;
  findingClass: FindingClass;
  affectsVerdict: boolean;
  scope: AssuranceScope;
  subject: AssuranceSubject;
  identity: { fingerprint: string; subjectKey: string; basis: IdentityBasis };
  location?: AssuranceLocation;
  evidence: readonly AssuranceEvidenceRef[];
  /** Secret-free copy. Redacted again on read. */
  title: string;
  message: string;
  remediation?: string;
  confidence: FindingConfidence;
  completeness: 'complete' | 'partial';
  decision?: AssuranceDecision;
  fixProposalRef?: { provider: string; id: string };
  externalAlias?: { scanner: 'trivy'; id: string; relation: AliasRelation };
}

function hash(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

/** Stable across runs; independent of node identity and of any free text. */
export function findingFingerprint(
  ruleId: string,
  scope: AssuranceScope,
  subject: AssuranceSubject,
): string {
  return hash([ruleId, scope.stack, scope.service ?? '', subject.kind, subject.key]);
}

/** The fields of a finding that say what it reports, compared to tell two facts
 *  apart. Not compared: what the fingerprint already fixes (rule, scope,
 *  subject), what is constant within one run of one rule (rule version, node),
 *  and the evidence, decision, external alias, and fix reference, which describe
 *  where a finding came from or what was done about it, not what it reports. */
function observableContent(finding: AssuranceFinding): string {
  const wire = serializeFinding(finding);
  return JSON.stringify([
    wire.severity, wire.findingClass, wire.affectsVerdict, wire.title, wire.message,
    wire.remediation ?? null, wire.location ?? null, wire.confidence, wire.completeness,
  ]);
}

/**
 * Rule ids with two different findings under one fingerprint in a single run.
 * A rule that emits several hits for one source path, service, or stack must
 * give each hit a distinct `subject` (or `sourcePath`); otherwise the hits are
 * indistinguishable to any consumer that pairs or dedupes on identity. Findings
 * that agree on every field `observableContent` compares are one fact reported
 * twice (a port published on both an IPv4 and an IPv6 address): a consumer
 * reading what the finding reports could not tell them apart, so they are not a
 * collision. A pair that differs in any of those fields is two facts under one
 * identity. Legacy rows are skipped: their identity is documented as not
 * dedupable.
 */
export function findFingerprintCollisions(findings: readonly AssuranceFinding[]): string[] {
  const byFingerprint = new Map<string, { ruleId: string; contents: Set<string> }>();
  for (const finding of findings) {
    if (finding.identity.basis === 'legacy') continue;
    const content = observableContent(finding);
    const seen = byFingerprint.get(finding.identity.fingerprint);
    if (seen) seen.contents.add(content);
    else byFingerprint.set(finding.identity.fingerprint, { ruleId: finding.ruleId, contents: new Set([content]) });
  }
  const colliding = new Set<string>();
  for (const { ruleId, contents } of byFingerprint.values()) {
    if (contents.size > 1) colliding.add(ruleId);
  }
  return [...colliding].sort();
}

/** The rule-independent correlation key for one fact. */
export function findingSubjectKey(scope: AssuranceScope, subject: AssuranceSubject): string {
  return hash([scope.stack, scope.service ?? '', subject.kind, subject.key]);
}

/**
 * The wire object, built from an explicit field allowlist. There is no
 * free-form metadata bag, so an unexpected property on a finding cannot leak
 * into a response, a log, or an export.
 */
export interface SerializedAssuranceFinding {
  ruleId: string;
  ruleVersion: number | null;
  severity: AssuranceSeverity;
  findingClass: FindingClass;
  affectsVerdict: boolean;
  scope: { nodeId: number; stack: string; service?: string };
  subject: { kind: SubjectKind; key: string };
  identity: { fingerprint: string; subjectKey: string; basis: IdentityBasis };
  location?: AssuranceLocation;
  evidence: AssuranceEvidenceRef[];
  title: string;
  message: string;
  remediation?: string;
  confidence: FindingConfidence;
  completeness: 'complete' | 'partial';
  decision?: AssuranceDecision;
  fixProposalRef?: { provider: string; id: string };
  externalAlias?: { scanner: 'trivy'; id: string; relation: AliasRelation };
}

export function serializeFinding(finding: AssuranceFinding): SerializedAssuranceFinding {
  const location = finding.location;
  const serializedLocation: AssuranceLocation | undefined = location
    ? {
      ...(location.file !== undefined ? { file: location.file } : {}),
      ...(location.path !== undefined ? { path: location.path } : {}),
      ...(location.line !== undefined ? { line: location.line } : {}),
      ...(location.column !== undefined ? { column: location.column } : {}),
      ...(location.endLine !== undefined ? { endLine: location.endLine } : {}),
      ...(location.endColumn !== undefined ? { endColumn: location.endColumn } : {}),
    }
    : undefined;
  return {
    ruleId: finding.ruleId,
    ruleVersion: finding.ruleVersion,
    severity: finding.severity,
    findingClass: finding.findingClass,
    affectsVerdict: finding.affectsVerdict,
    scope: {
      nodeId: finding.scope.nodeId,
      stack: finding.scope.stack,
      ...(finding.scope.service !== undefined ? { service: finding.scope.service } : {}),
    },
    subject: { kind: finding.subject.kind, key: finding.subject.key },
    identity: {
      fingerprint: finding.identity.fingerprint,
      subjectKey: finding.identity.subjectKey,
      basis: finding.identity.basis,
    },
    ...(serializedLocation ? { location: serializedLocation } : {}),
    evidence: finding.evidence.map(ref => ({
      layer: ref.layer,
      provider: ref.provider,
      ...(ref.externalSeverity !== undefined ? { externalSeverity: ref.externalSeverity } : {}),
    })),
    title: finding.title,
    message: finding.message,
    ...(finding.remediation !== undefined ? { remediation: finding.remediation } : {}),
    confidence: finding.confidence,
    completeness: finding.completeness,
    ...(finding.decision ? { decision: decisionForSerialize(finding.decision) } : {}),
    ...(finding.fixProposalRef
      ? { fixProposalRef: { provider: finding.fixProposalRef.provider, id: finding.fixProposalRef.id } }
      : {}),
    ...(finding.externalAlias
      ? { externalAlias: { scanner: finding.externalAlias.scanner, id: finding.externalAlias.id, relation: finding.externalAlias.relation } }
      : {}),
  };
}

function decisionForSerialize(decision: AssuranceDecision): AssuranceDecision {
  return {
    kind: decision.kind,
    id: decision.id,
    // Operator-entered free text, so it is redacted at the serialization boundary.
    reason: redactSensitiveText(decision.reason),
    expiry: {
      mode: decision.expiry.mode,
      ...(decision.expiry.expiresAt !== undefined ? { expiresAt: decision.expiry.expiresAt } : {}),
    },
  };
}

/** The subject a rule's hit carries, falling back to the registry kind plus the
 *  most specific value the hit names: its source path, else its service, else
 *  the stack. A rule that emits several hits sharing that value must set
 *  `hit.subject`; `findFingerprintCollisions` flags such a rule when the hits
 *  that share the subject also differ in what they report. */
export function subjectForHit(rule: AssuranceRule, stackName: string, hit: RuleHit): AssuranceSubject {
  if (hit.subject) return hit.subject;
  return { kind: rule.subject, key: hit.sourcePath ?? hit.service ?? stackName };
}

/** Normalize one runner hit into the contract. */
export function normalizeDoctorHit(
  nodeId: number,
  stackName: string,
  hit: RuleHit,
  rule: AssuranceRule,
): AssuranceFinding {
  const scope: AssuranceScope = {
    nodeId,
    stack: stackName,
    ...(hit.service !== undefined ? { service: hit.service } : {}),
  };
  const subject = subjectForHit(rule, stackName, hit);
  return {
    ruleId: rule.id,
    ruleVersion: rule.version,
    severity: hit.severity,
    findingClass: rule.findingClass,
    affectsVerdict: rule.affectsVerdict,
    scope,
    subject,
    identity: {
      fingerprint: findingFingerprint(rule.id, scope, subject),
      subjectKey: findingSubjectKey(scope, subject),
      basis: 'structured',
    },
    ...(hit.sourcePath !== undefined ? { location: { path: hit.sourcePath } } : {}),
    evidence: rule.evidenceLayers.map(layer => ({ layer, provider: 'compose-doctor' as const })),
    title: hit.title,
    message: hit.message,
    ...(hit.remediation !== undefined ? { remediation: hit.remediation } : {}),
    confidence: rule.defaultConfidence,
    completeness: 'complete',
  };
}

function storedEvidenceLayers(rule: AssuranceRule | undefined): readonly EvidenceLayer[] {
  return rule?.evidenceLayers ?? ['authored'];
}

/** Attach the read-time acknowledgement decision to a normalized finding. */
export function withDecision(finding: AssuranceFinding, projected: PreflightFinding): AssuranceFinding {
  if (projected.acknowledged !== true || typeof projected.acknowledgementId !== 'number') return finding;
  return {
    ...finding,
    decision: {
      kind: 'acknowledged',
      id: projected.acknowledgementId,
      reason: projected.acknowledgementReason ?? '',
      expiry: {
        mode: projected.acknowledgementExpiry ?? 'forever',
        ...(projected.acknowledgementExpiresAt !== undefined
          ? { expiresAt: projected.acknowledgementExpiresAt }
          : {}),
      },
    },
  };
}

const SUBJECT_KINDS: ReadonlySet<string> = new Set<SubjectKind>([
  'stack', 'service', 'port', 'bind', 'network', 'volume',
  'env-var', 'env-file', 'container-name', 'image',
]);

/** Stored subject kinds are free text, so parse them at the boundary. */
function storedSubjectKind(value: string | null | undefined): SubjectKind | undefined {
  return value !== null && value !== undefined && SUBJECT_KINDS.has(value) ? value as SubjectKind : undefined;
}

/**
 * Read a stored row through the contract. Legacy rows (no rule version, no
 * subject columns) get `basis: 'legacy'`; a stored rule id that is no longer in
 * the registry maps to the information class instead of throwing. Every free
 * text field is redacted on read, so a URL credential stored by an older rule
 * never reaches a consumer.
 */
export function normalizeStoredFinding(row: PreflightFindingRow, nodeId: number, stackName: string): AssuranceFinding {
  const rule = getAssuranceRule(row.rule_id);
  const sourcePath = row.source_path === null ? undefined : redactSensitiveText(row.source_path);
  const service = row.service ?? undefined;
  const subjectKind = storedSubjectKind(row.subject_kind) ?? rule?.subject ?? 'stack';
  const subjectKey = row.subject_key ?? sourcePath ?? service ?? stackName;
  const subject: AssuranceSubject = { kind: subjectKind, key: subjectKey };
  const scope: AssuranceScope = {
    nodeId,
    stack: stackName,
    ...(service !== undefined ? { service } : {}),
  };
  const structured = row.rule_version !== null && row.subject_kind !== null && row.subject_key !== null;
  return {
    // Kept verbatim: a row stored before this contract can carry an id the
    // registry no longer knows. `ruleVersion: null` and `basis: 'legacy'` mark it.
    ruleId: row.rule_id as CanonicalRuleId | ExternalRuleId,
    ruleVersion: row.rule_version ?? null,
    severity: row.severity as AssuranceSeverity,
    findingClass: rule?.findingClass ?? 'information',
    affectsVerdict: rule?.affectsVerdict ?? true,
    scope,
    subject,
    identity: {
      fingerprint: findingFingerprint(row.rule_id, scope, subject),
      subjectKey: findingSubjectKey(scope, subject),
      basis: structured ? 'structured' : 'legacy',
    },
    ...(sourcePath !== undefined ? { location: { path: sourcePath } } : {}),
    evidence: storedEvidenceLayers(rule).map(layer => ({ layer, provider: 'compose-doctor' as const })),
    title: redactSensitiveText(row.title),
    message: redactSensitiveText(row.message),
    ...(row.remediation !== null ? { remediation: redactSensitiveText(row.remediation) } : {}),
    confidence: structured ? (rule?.defaultConfidence ?? 'unverified') : 'unverified',
    completeness: structured ? 'complete' : 'partial',
  };
}
