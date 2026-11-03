/**
 * The canonical registry: ids, metadata completeness, ordering against the
 * runner, alias resolution, and the frontend note copy that mirrors it.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import {
  ASSURANCE_RULES, COMPOSE_DOCTOR_RULES, PREFLIGHT_NOTE_RULES, EXTERNAL_ALIASES,
  assuranceRuleOrder, canonicalRuleForExternalAlias, canonicalRuleForPolicyPackAlias,
  getAssuranceRule, policyPackIdForRule,
} from '../services/assurance/ruleRegistry';
import {
  PREFLIGHT_RULES, PREFLIGHT_NOTE_RULE_IDS, RULE_IDS, RENDER_FAILED_RULE_ID, SEVERITY_RANK,
} from '../services/preflight/rules';
import { DEFAULT_POLICY_PACKS } from '../services/policy-packs';
import { normalizeTrivyMisconfig, dedupeKey } from '../services/assurance/externalAliases';

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

describe('canonical ids', () => {
  it('are kebab-case', () => {
    for (const rule of ASSURANCE_RULES) {
      expect(rule.id, rule.id).toMatch(ID_PATTERN);
    }
  });

  it('are unique across rules, policy-pack aliases, and external aliases', () => {
    const ids = new Set<string>();
    for (const rule of ASSURANCE_RULES) {
      expect(ids.has(rule.id), `duplicate id ${rule.id}`).toBe(false);
      ids.add(rule.id);
    }
    const aliases = ASSURANCE_RULES.flatMap(rule => rule.aliases.policyPack);
    for (const alias of aliases) {
      expect(ID_PATTERN.test(alias), alias).toBe(true);
      expect(ids.has(alias), `policy-pack alias ${alias} collides with a canonical id`).toBe(false);
      ids.add(alias);
    }
    const external = EXTERNAL_ALIASES.map(alias => `${alias.scanner}:${alias.id}`);
    expect(new Set(external).size).toBe(external.length);
  });

  it('never name an alias twice', () => {
    const seen = new Map<string, string>();
    for (const rule of ASSURANCE_RULES) {
      for (const alias of rule.aliases.policyPack) {
        expect(seen.has(alias), `${alias} is claimed by ${seen.get(alias)} and ${rule.id}`).toBe(false);
        seen.set(alias, rule.id);
      }
    }
  });
});

describe('metadata completeness', () => {
  it.each(ASSURANCE_RULES.map(rule => [rule.id, rule] as const))('%s is complete', (_id, rule) => {
    expect(rule.title.trim().length).toBeGreaterThan(0);
    expect(rule.description.trim().length).toBeGreaterThan(0);
    expect(rule.version).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(rule.version)).toBe(true);
    expect(rule.severities).toContain(rule.defaultSeverity);
    expect(rule.evidenceLayers.length).toBeGreaterThan(0);
    expect(rule.composeModes.length).toBeGreaterThan(0);
    expect(rule.standards.every(ref => ref.framework && ref.version && ref.control)).toBe(true);
    if (rule.status === 'active') {
      expect(rule.engine, `${rule.id} is active but has no engine`).not.toBeNull();
    } else {
      expect(rule.engine).toBeNull();
    }
    if (rule.status === 'deprecated') {
      expect(rule.deprecation?.reason.length).toBeGreaterThan(0);
    }
    if (rule.status === 'catalog') {
      // A catalog rule is declared but not evaluated: it must never change a verdict.
      expect(rule.affectsVerdict).toBe(false);
    }
  });

  it('marks notes as not affecting the verdict and offers no acknowledgement for them', () => {
    for (const rule of ASSURANCE_RULES) {
      expect(rule.capabilities.acknowledge).toBe(rule.affectsVerdict);
      expect(rule.capabilities.enforce).toBe(false);
      expect(rule.capabilities.remediate).toBe(false);
    }
  });
});

describe('registry order', () => {
  it('ranks ids in Doctor evaluation order, with unknown ids last', () => {
    const first = RULE_IDS[0];
    const last = RULE_IDS[RULE_IDS.length - 1];
    expect(assuranceRuleOrder(first)).toBe(0);
    expect(assuranceRuleOrder(last)).toBe(RULE_IDS.length - 1);
    expect(assuranceRuleOrder('privileged')).toBeLessThan(assuranceRuleOrder('image-latest'));
    expect(assuranceRuleOrder('a-rule-that-was-retired')).toBe(Number.MAX_SAFE_INTEGER);
    // The comparator that consumes it is severity first, then this order.
    const sorted = [
      { severity: 'warning' as const, ruleId: 'image-latest' },
      { severity: 'high' as const, ruleId: 'image-latest' },
      { severity: 'high' as const, ruleId: 'render-failed' },
    ].sort((a, b) => (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
      || (assuranceRuleOrder(a.ruleId) - assuranceRuleOrder(b.ruleId)));
    expect(sorted.map(entry => `${entry.severity}:${entry.ruleId}`)).toEqual([
      'high:render-failed', 'high:image-latest', 'warning:image-latest',
    ]);
  });

  it('matches the Compose Doctor runner exactly', () => {
    const registryDoctorIds = ASSURANCE_RULES
      .filter(rule => rule.status === 'active' && rule.engine === 'compose-doctor')
      .map(rule => rule.id);
    expect(registryDoctorIds).toEqual([...RULE_IDS]);
    expect(PREFLIGHT_RULES.map(rule => rule.id)).toEqual([...RULE_IDS]);
    expect(RENDER_FAILED_RULE_ID).toBe('render-failed');
  });

  it('derives the note set from affectsVerdict', () => {
    const derived = COMPOSE_DOCTOR_RULES.filter(rule => !rule.affectsVerdict).map(rule => rule.id);
    expect([...PREFLIGHT_NOTE_RULE_IDS].sort()).toEqual([...derived].sort());
    expect(derived.sort()).toEqual(['compose-version-mismatch', 'docker-socket-proxy-client', 'healthcheck-inherited', 'tunnel-exposure']);
    expect(PREFLIGHT_NOTE_RULES.map(rule => rule.id).sort()).toEqual([...derived].sort());
  });
});

describe('policy-pack aliases', () => {
  it('resolves every pack rule to exactly one canonical rule', () => {
    for (const pack of DEFAULT_POLICY_PACKS) {
      for (const packRule of pack.rules) {
        expect(canonicalRuleForPolicyPackAlias(packRule.id), `${pack.id}/${packRule.id}`).toBe(packRule.canonicalRuleId);
        expect(getAssuranceRule(packRule.canonicalRuleId), packRule.canonicalRuleId).toBeDefined();
        expect(policyPackIdForRule(packRule.canonicalRuleId)).toBe(packRule.id);
      }
    }
  });

  it('maps every alias in the registry, and nothing else', () => {
    const aliased = ASSURANCE_RULES.filter(rule => rule.aliases.policyPack.length > 0);
    const packIds = new Set(DEFAULT_POLICY_PACKS.flatMap(pack => pack.rules.map(rule => rule.id)));
    expect(new Set(aliased.flatMap(rule => rule.aliases.policyPack))).toEqual(packIds);
  });
});

describe('external aliases', () => {
  it('resolves every registered Trivy id to its canonical rule', () => {
    for (const alias of EXTERNAL_ALIASES) {
      expect(canonicalRuleForExternalAlias('trivy', alias.id)).toEqual({ ruleId: alias.ruleId, relation: alias.relation });
    }
  });

  it('keeps a related alias out of deduplication', () => {
    const finding = normalizeTrivyMisconfig({
      nodeId: 1,
      stack: 'proj',
      id: 'DS002',
      title: 'Image user should not be root',
      message: 'Add a USER line',
      severity: 'HIGH',
    });
    expect(finding.ruleId).toBe('external:trivy:DS002');
    expect(finding.externalAlias?.relation).toBe('related');
    expect(finding.severity).toBe('high');
    expect(dedupeKey(finding)).toBeNull();
    // The scanner's own grade is kept as evidence, not as the finding's grade.
    expect(finding.evidence[0].externalSeverity).toBe('HIGH');
  });
});

describe('frontend note copy', () => {
  it('matches the backend note set derived from the registry', () => {
    const file = path.resolve(__dirname, '../../../frontend/src/lib/preflightNotes.ts');
    const source = fs.readFileSync(file, 'utf8');
    const ids = new Set([...source.matchAll(/'([a-z][a-z0-9-]*)'/g)].map(match => match[1]));
    expect([...ids].sort()).toEqual([...PREFLIGHT_NOTE_RULE_IDS].sort());
  });
});
