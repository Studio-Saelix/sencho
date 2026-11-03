/**
 * The normalized finding contract: stable identity without node identity or
 * text, rule-scoped acknowledgements, and an allowlist-only, secret-safe
 * serialization.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeDoctorHit, normalizeStoredFinding, serializeFinding, withDecision,
  type AssuranceFinding,
} from '../services/assurance/finding';
import { getAssuranceRule } from '../services/assurance/ruleRegistry';
import {
  dedupeKey, externalSeverityFromTrivy, normalizeTrivyMisconfig, resolveExternalFinding,
} from '../services/assurance/externalAliases';
import { applyPreflightAcknowledgements } from '../utils/preflight-ack-filter';
import type { RuleHit } from '../services/preflight/types';
import type { PreflightFindingRow } from '../services/DatabaseService';
import { runRules } from '../services/preflight/rules';
import { maximalContext } from './helpers/assuranceFixture';

const STACK = 'proj';

function hit(ruleId: RuleHit['ruleId'], over: Partial<RuleHit> = {}): RuleHit {
  return {
    ruleId,
    severity: getAssuranceRule(ruleId)?.defaultSeverity ?? 'info',
    title: 'A finding',
    message: 'Something is wrong',
    ...over,
  };
}

function normalize(source: RuleHit, nodeId = 1, stack = STACK): AssuranceFinding {
  const rule = getAssuranceRule(source.ruleId);
  if (!rule) throw new Error(`missing registry entry for ${source.ruleId}`);
  return normalizeDoctorHit(nodeId, stack, source, rule);
}

function maximalFindings(): AssuranceFinding[] {
  return runRules(maximalContext()).map(source => normalize(source));
}

describe('fingerprints', () => {
  it('are stable across runs and exclude node identity', () => {
    const source = hit('privileged', { service: 'web', sourcePath: 'web' });
    expect(normalize(source, 1).identity.fingerprint).toBe(normalize(source, 7).identity.fingerprint);
    expect(normalize(source, 1).identity.subjectKey).toBe(normalize(source, 7).identity.subjectKey);
  });

  it('do not change with title, message, or severity', () => {
    const base = normalize(hit('privileged', { service: 'web', sourcePath: 'web' }));
    const changed = normalize(hit('privileged', {
      service: 'web',
      sourcePath: 'web',
      severity: 'warning',
      title: 'Reworded headline',
      message: 'Reworded explanation',
      remediation: 'Do something else',
    }));
    expect(changed.identity.fingerprint).toBe(base.identity.fingerprint);
  });

  it('differ by subject', () => {
    const one = normalize(hit('port-exposed-all-interfaces', {
      service: 'web',
      subject: { kind: 'port', key: '8080/tcp' },
    }));
    const two = normalize(hit('port-exposed-all-interfaces', {
      service: 'web',
      subject: { kind: 'port', key: '9090/tcp' },
    }));
    expect(one.identity.fingerprint).not.toBe(two.identity.fingerprint);
    expect(one.identity.subjectKey).not.toBe(two.identity.subjectKey);
  });

  it('are unique within a maximal run', () => {
    const findings = maximalFindings();
    const fingerprints = findings.map(finding => finding.identity.fingerprint);
    expect(fingerprints.length).toBeGreaterThan(30);
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
  });

  it('are not deduplicated when they come from a related external alias', () => {
    const related = normalizeTrivyMisconfig({
      nodeId: 1,
      stack: 'demo',
      id: 'DS002',
      title: 'Image user should not be root',
      message: 'Add a USER line to the Dockerfile',
      severity: 'HIGH',
      path: 'Dockerfile',
    });
    expect(related.externalAlias?.relation).toBe('related');
    expect(related.ruleId).toBe('external:trivy:DS002');
    expect(dedupeKey(related)).toBeNull();
  });
});

describe('subjectKey', () => {
  it('joins two rules that report the same service port', () => {
    const findings = maximalFindings();
    const published = findings.find(finding =>
      finding.ruleId === 'port-exposed-all-interfaces' && finding.scope.service === 'web' && finding.subject.key === '8080/tcp');
    const conflicted = findings.find(finding =>
      finding.ruleId === 'port-conflict-node' && finding.scope.service === 'web' && finding.subject.key === '8080/tcp');
    expect(published).toBeDefined();
    expect(conflicted).toBeDefined();
    expect(published?.identity.subjectKey).toBe(conflicted?.identity.subjectKey);
    expect(published?.identity.fingerprint).not.toBe(conflicted?.identity.fingerprint);
  });
});

describe('acknowledgements stay scoped to one rule', () => {
  it('does not acknowledge a second rule reporting the same subject', () => {
    const privileged = normalize(hit('privileged', { service: 'web', sourcePath: 'web' }));
    const socketMount = normalize(hit('docker-socket-mount', { service: 'web', sourcePath: 'web' }));
    expect(privileged.identity.subjectKey).toBe(socketMount.identity.subjectKey);

    const projected = [privileged, socketMount].map(finding => ({
      ruleId: finding.ruleId,
      severity: finding.severity,
      title: finding.title,
      message: finding.message,
      service: finding.scope.service,
    }));
    const acked = applyPreflightAcknowledgements(
      projected,
      { renderedHash: null, serviceImages: {} },
      [{
        id: 9,
        node_id: 1,
        stack_name: STACK,
        rule_id: 'privileged',
        service: 'web',
        reason: 'intentional',
        expiry_mode: 'forever',
        expires_at: null,
        anchor_rendered_hash: null,
        anchor_image_ref: null,
        created_by: 'tester',
        created_at: Date.now(),
      }],
    );
    expect(acked[0].acknowledged).toBe(true);
    expect(acked[1].acknowledged).toBe(false);

    // The decision rides on the finding it belongs to, and nowhere else.
    expect(withDecision(privileged, acked[0]).decision?.reason).toBe('intentional');
    expect(withDecision(socketMount, acked[1]).decision).toBeUndefined();
  });
});

describe('secret-safe serialization', () => {
  it('drops unknown properties', () => {
    const finding = normalize(hit('privileged', { service: 'web', sourcePath: 'web' }));
    const withExtra = { ...finding, secretBag: { password: 'hunter2' } };
    const serialized = JSON.stringify(serializeFinding(withExtra));
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('secretBag');
  });

  it('redacts a stored row that holds URL credentials and a secret value', () => {
    const row: PreflightFindingRow = {
      id: 'row-1',
      run_id: 'run-1',
      rule_id: 'env-file-missing',
      severity: 'high',
      title: 'Missing env file https://user:pass@host/x.env',
      message: 'The file https://user:pass@host/x.env is absent. PASSWORD=hunter2 was in it.',
      source_path: 'https://user:pass@host/x.env',
      remediation: 'Create https://user:pass@host/x.env',
      service: 'web',
      created_at: 1,
      rule_version: 1,
      subject_kind: 'env-file',
      subject_key: './x.env',
    };
    const finding = normalizeStoredFinding(row, 1, STACK);
    const serialized = JSON.stringify(serializeFinding(finding));
    expect(serialized).not.toContain('user:pass');
    expect(serialized).not.toContain('hunter2');
    expect(finding.identity.basis).toBe('structured');
  });

  it('redacts the acknowledgement reason, which is operator-entered free text', () => {
    const finding = normalize(hit('privileged', { service: 'web', sourcePath: 'web' }));
    const withAck = {
      ...finding,
      decision: {
        kind: 'acknowledged' as const,
        id: 3,
        reason: 'accepted: PASSWORD=hunter2 for https://user:pass@host/x',
        expiry: { mode: 'forever' as const },
      },
    };
    const serialized = JSON.stringify(serializeFinding(withAck));
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('user:pass');
    expect(serialized).toContain('acknowledged');
  });

  it('reads a legacy row as legacy and an unknown rule id without throwing', () => {
    const row: PreflightFindingRow = {
      id: 'row-2',
      run_id: 'run-2',
      rule_id: 'a-rule-that-was-retired',
      severity: 'warning',
      title: 'Old title',
      message: 'Old message',
      source_path: null,
      remediation: null,
      service: null,
      created_at: 1,
      rule_version: null,
      subject_kind: null,
      subject_key: null,
    };
    const finding = normalizeStoredFinding(row, 1, STACK);
    expect(finding.ruleId).toBe('a-rule-that-was-retired');
    expect(finding.ruleVersion).toBeNull();
    expect(finding.findingClass).toBe('information');
    expect(finding.identity.basis).toBe('legacy');
  });
});

describe('external aliases', () => {
  const input = {
    nodeId: 1,
    stack: STACK,
    id: 'DS002',
    title: 'Image user should not be root',
    message: 'Add a USER line to the Dockerfile',
    severity: 'HIGH',
    path: 'Dockerfile',
  };

  it('keeps a related finding under its own id and the table severity', () => {
    const finding = normalizeTrivyMisconfig(input);
    expect(finding.ruleId).toBe('external:trivy:DS002');
    expect(finding.externalAlias).toEqual({ scanner: 'trivy', id: 'DS002', relation: 'related' });
    expect(finding.severity).toBe('high');
    expect(dedupeKey(finding)).toBeNull();
  });

  it('dedupes an equivalent alias onto the canonical rule and takes its severity', () => {
    const finding = resolveExternalFinding(input, { ruleId: 'root-user', relation: 'equivalent' });
    const rule = getAssuranceRule('root-user');
    expect(finding.ruleId).toBe('root-user');
    expect(finding.ruleVersion).toBe(rule?.version);
    expect(finding.severity).toBe(rule?.defaultSeverity);
    expect(finding.externalAlias?.relation).toBe('equivalent');
    expect(finding.evidence[0].externalSeverity).toBe('HIGH');
    expect(dedupeKey(finding)).toBe(finding.identity.fingerprint);
  });

  it('turns an unmapped id into an external rule that is never a blocker', () => {
    const finding = normalizeTrivyMisconfig({
      ...input,
      id: 'DS999',
      title: 'Leaked PASSWORD=hunter2',
      message: 'See https://user:pass@host/x',
      severity: 'CRITICAL',
    });
    expect(finding.ruleId).toBe('external:trivy:DS999');
    expect(finding.severity).toBe('high');
    expect(finding.severity).not.toBe('blocker');
    expect(finding.externalAlias).toBeUndefined();
    const serialized = JSON.stringify(serializeFinding(finding));
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('user:pass');
  });

  it('redacts a scanner path before it reaches the subject or location', () => {
    const finding = normalizeTrivyMisconfig({
      ...input,
      id: 'DS999',
      path: 'https://user:pass@host/deploy/.env',
    });
    expect(finding.subject.key).not.toContain('user:pass');
    expect(finding.location?.path).not.toContain('user:pass');
    expect(JSON.stringify(serializeFinding(finding))).not.toContain('user:pass');
  });

  it('redacts a scanner-supplied service name', () => {
    const finding = normalizeTrivyMisconfig({
      ...input,
      id: 'DS999',
      service: 'web PASSWORD=hunter2',
      path: 'Dockerfile',
    });
    expect(finding.scope.service).not.toContain('hunter2');
    expect(JSON.stringify(serializeFinding(finding))).not.toContain('hunter2');
  });

  it('keeps a file-level external finding keyed on the file, even with a service', () => {
    const finding = normalizeTrivyMisconfig({
      ...input,
      id: 'DS002',
      service: 'web',
      path: 'Dockerfile',
    });
    expect(finding.subject).toEqual({ kind: 'image', key: 'Dockerfile' });
  });

  it('keys an equivalent alias on the service so it can dedupe with the canonical engine', () => {
    const finding = resolveExternalFinding(
      { ...input, service: 'web', path: 'compose.yaml' },
      { ruleId: 'root-user', relation: 'equivalent' },
    );
    expect(finding.subject).toEqual({ kind: 'service', key: 'web' });
  });

  it('uses one explicit severity table', () => {
    expect(externalSeverityFromTrivy('CRITICAL')).toBe('high');
    expect(externalSeverityFromTrivy('HIGH')).toBe('high');
    expect(externalSeverityFromTrivy('MEDIUM')).toBe('warning');
    expect(externalSeverityFromTrivy('LOW')).toBe('info');
    expect(externalSeverityFromTrivy('UNKNOWN')).toBe('info');
    expect(externalSeverityFromTrivy(null)).toBe('info');
    expect(externalSeverityFromTrivy('something-else')).toBe('info');
  });
});
