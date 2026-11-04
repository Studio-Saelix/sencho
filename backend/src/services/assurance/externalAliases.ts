/**
 * External scanner aliases.
 *
 * `trivy config` on a stack directory evaluates Dockerfile checks (DS*) and
 * Compose-native checks, not Sencho's Compose semantics. A Dockerfile check that
 * touches the same hazard therefore correlates with a Sencho rule without
 * evaluating the same fact, so those aliases are `relation: 'related'`:
 *
 * - DS001 (`:latest` tag in FROM) correlates with `image-latest`
 * - DS002 (root USER) correlates with `root-user`
 * - DS026 (no HEALTHCHECK) correlates with `no-healthcheck`
 *
 * Each id above was verified against the trivy-checks source
 * (`checks/docker/<name>.rego` metadata: id, aliases, severity).
 *
 * A `related` alias only correlates. Its finding keeps `external:trivy:<ID>`,
 * its own severity from the table below, and never dedupes. An `equivalent`
 * alias (for future Compose-native checks) resolves onto the canonical rule,
 * takes the registry severity, keeps the scanner severity as evidence, and
 * dedupes on the canonical identity.
 *
 * The grade of an external finding never comes from the scanner and is never
 * `blocker`: `blocker` is reserved for Sencho's own technical blockers.
 */
import { canonicalRuleForExternalAlias, getAssuranceRule } from './ruleRegistry';
import type { AssuranceFinding } from './finding';
import {
  findingFingerprint, findingSubjectKey, type AssuranceScope, type AssuranceSubject,
} from './finding';
import type { AliasRelation, AssuranceRule, AssuranceSeverity, CanonicalRuleId, ExternalRuleId, SubjectKind } from './types';
import { redactSensitiveText } from '../../utils/safeLog';

/** One explicit table for every external misconfiguration grade. */
export const TRIVY_SEVERITY_MAP: Record<string, AssuranceSeverity> = {
  CRITICAL: 'high',
  HIGH: 'high',
  MEDIUM: 'warning',
  LOW: 'info',
  UNKNOWN: 'info',
};

export function externalSeverityFromTrivy(severity: string | null | undefined): AssuranceSeverity {
  return TRIVY_SEVERITY_MAP[(severity ?? '').toUpperCase()] ?? 'info';
}

export function externalRuleId(scanner: 'trivy', id: string): ExternalRuleId {
  return `external:${scanner}:${id}`;
}

export interface TrivyMisconfigInput {
  nodeId: number;
  stack: string;
  service?: string;
  /** Trivy check id, e.g. `DS002`. */
  id: string;
  title: string;
  message: string;
  /** Trivy's own severity label, kept as evidence. */
  severity: string | null | undefined;
  remediation?: string;
  /** File the check ran against, when Trivy reports it. */
  path?: string;
}

/**
 * The subject key for an equivalent alias: the service the scanner names,
 * falling back to the file. Keying on the service is what lets it land on the
 * same fingerprint as the Compose Doctor finding for that service. External
 * findings that cannot dedupe (related or unmapped) key on the file instead, so
 * two files checked for the same rule never collapse into one.
 */
function subjectForEquivalent(
  service: string | undefined,
  path: string | undefined,
  fallback: AssuranceRule['subject'],
): AssuranceSubject {
  return { kind: fallback, key: service ?? path ?? 'stack' };
}

/** Normalize a Trivy misconfiguration finding into the contract. */
export function normalizeTrivyMisconfig(input: TrivyMisconfigInput): AssuranceFinding {
  return resolveExternalFinding(input, canonicalRuleForExternalAlias('trivy', input.id));
}

/**
 * Apply one alias resolution to a scanner finding. Exported so the
 * `equivalent` policy (dedupe onto the canonical rule, take the registry
 * severity, keep the scanner severity as evidence) is provable before the first
 * equivalent Compose-native alias lands.
 */
export function resolveExternalFinding(
  input: TrivyMisconfigInput,
  alias: { ruleId: CanonicalRuleId; relation: AliasRelation } | undefined,
): AssuranceFinding {
  // Every scanner-supplied string is redacted at this boundary. A valid Compose
  // service name is unchanged by redaction, so identifiers stay joinable.
  const service = input.service === undefined ? undefined : redactSensitiveText(input.service);
  const scope: AssuranceScope = {
    nodeId: input.nodeId,
    stack: input.stack,
    ...(service !== undefined ? { service } : {}),
  };
  const rule = alias ? getAssuranceRule(alias.ruleId) : undefined;
  const title = redactSensitiveText(input.title);
  const message = redactSensitiveText(input.message);
  // Scanner free text, so the path is redacted like the title and message before
  // it reaches the subject key or the location.
  const path = input.path === undefined ? undefined : redactSensitiveText(input.path);
  const externalSeverity = input.severity ?? 'UNKNOWN';

  if (alias?.relation === 'equivalent' && rule) {
    const subject = subjectForEquivalent(service, path, rule.subject);
    return {
      ruleId: rule.id,
      ruleVersion: rule.version,
      severity: rule.defaultSeverity,
      findingClass: rule.findingClass,
      affectsVerdict: rule.affectsVerdict,
      scope,
      subject,
      identity: {
        fingerprint: findingFingerprint(rule.id, scope, subject),
        subjectKey: findingSubjectKey(scope, subject),
        basis: 'structured',
      },
      ...(path !== undefined ? { location: { path } } : {}),
      evidence: [{ layer: 'authored', provider: 'trivy', externalSeverity }],
      title,
      message,
      ...(input.remediation !== undefined ? { remediation: redactSensitiveText(input.remediation) } : {}),
      confidence: rule.defaultConfidence,
      completeness: 'complete',
      externalAlias: { scanner: 'trivy', id: input.id, relation: 'equivalent' },
    };
  }

  const ruleId = externalRuleId('trivy', input.id);
  const subjectKind: SubjectKind = 'image';
  const subject: AssuranceSubject = { kind: subjectKind, key: path ?? 'stack' };
  return {
    ruleId,
    ruleVersion: null,
    severity: externalSeverityFromTrivy(externalSeverity),
    findingClass: 'security',
    affectsVerdict: true,
    scope,
    subject,
    identity: {
      fingerprint: findingFingerprint(ruleId, scope, subject),
      subjectKey: findingSubjectKey(scope, subject),
      basis: 'structured',
    },
    ...(path !== undefined ? { location: { path } } : {}),
    evidence: [{ layer: 'authored', provider: 'trivy', externalSeverity }],
    title,
    message,
    ...(input.remediation !== undefined ? { remediation: redactSensitiveText(input.remediation) } : {}),
    confidence: 'confirmed',
    completeness: 'complete',
    ...(alias ? { externalAlias: { scanner: 'trivy' as const, id: input.id, relation: 'related' as const } } : {}),
  };
}

/**
 * The dedup key for a finding, or null when it must not dedupe.
 * A `related` alias never dedupes: it only correlates, so its finding stays
 * beside the canonical rule's finding instead of replacing it.
 */
export function dedupeKey(finding: AssuranceFinding): string | null {
  if (finding.externalAlias?.relation === 'related') return null;
  return finding.identity.fingerprint;
}
