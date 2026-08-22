import { describe, expect, it } from 'vitest';
import { GITOPS_LIMITATION_COPY, limitationCaveat, limitationCaveats } from './gitopsLimitations';
import type { GitOpsLimitation } from '@/types/gitops';

const limitation = (code: string, evidence: unknown = null): GitOpsLimitation => ({
  code,
  message: 'backend wording, not for display',
  evidence,
});

/**
 * Every code the backend can put on the live arm.
 *
 * Kept as a literal list rather than derived, because it is the assertion: the
 * point is to notice when the backend gains a code this map has not been told
 * about. Sources are `derive.ts` (projection time) and the write-time evidence
 * channel that `mergePersistedLimitations` folds in. The two absent-arm codes
 * (`application_row_missing`, `blueprint_application_missing`) and the
 * history-row code (`history_json_invalid`) are deliberately excluded: those
 * are faults and audit-row defects, which other affordances own.
 */
const LIVE_ARM_CODES = [
  'repo_identity_invalid',
  'artifact_pointer_missing',
  'artifact_evidence_json_invalid',
  'connectivity_invalid',
  'lkg_generation_missing',
  'lkg_artifact_invalid',
  'evidence_limitations_invalid',
  'artifact_observation_invalid',
  'artifact_observation_decode_failed',
  'recovery_unproven',
  'lkg_artifact_unprovable',
  'source_acceptance_unprovable',
  'artifact_expectation_unprovable',
  'manifest_absent',
  'manifest_corrupt',
  'manifest_identity_invalid',
  'manifest_commit_unresolved',
  'manifest_commit_mismatch',
  'legacy_pending',
  'blueprint_reapproval_required',
] as const;

describe('gitops limitation copy', () => {
  it('covers every code the live arm can carry', () => {
    const missing = LIVE_ARM_CODES.filter((code) => !(code in GITOPS_LIMITATION_COPY));
    expect(missing).toEqual([]);
  });

  it('carries no copy for a code that is not a live-arm caveat', () => {
    // A fault replaces the state rather than qualifying it, so giving it caveat
    // copy here would invite a surface to render it as the milder thing.
    expect(GITOPS_LIMITATION_COPY).not.toHaveProperty('application_row_missing');
    expect(GITOPS_LIMITATION_COPY).not.toHaveProperty('blueprint_application_missing');
    expect(GITOPS_LIMITATION_COPY).not.toHaveProperty('history_json_invalid');
  });

  it('never shows the backend message', () => {
    // The stored messages are written for a log reader ("repo identity json is
    // invalid") and several are raw decoder errors.
    for (const code of LIVE_ARM_CODES) {
      expect(limitationCaveat(limitation(code))).not.toBe('backend wording, not for display');
    }
  });

  it('names an unrecognised code rather than dropping it', () => {
    // A newer node can send a code this build has never heard of. Saying
    // nothing would report full confidence in a state the backend flagged.
    expect(limitationCaveat(limitation('something_new_entirely')))
      .toBe('Part of this state could not be proven (something_new_entirely).');
  });

  it('states a condition in each sentence, ending it properly', () => {
    for (const code of LIVE_ARM_CODES) {
      const copy = GITOPS_LIMITATION_COPY[code];
      // Narrowed rather than asserted: the coverage case above is what proves
      // every code has copy, so a miss here would otherwise be reported as a
      // property access on undefined instead of as the missing entry it is.
      expect(copy, `no operator copy for ${code}`).toBeDefined();
      if (!copy) continue;
      expect(copy.length).toBeGreaterThan(40);
      expect(copy.endsWith('.')).toBe(true);
      expect(copy).not.toMatch(/—/);
    }
  });

  it('carries no copy for a code the backend cannot emit', () => {
    // The reverse of the coverage case above: a retired code leaving stale
    // wording behind is invisible without this, because the fallback only
    // fires for codes that are missing rather than for ones that linger.
    const documented = Object.keys(GITOPS_LIMITATION_COPY).sort();
    expect(documented).toEqual([...LIVE_ARM_CODES].sort());
  });

  it('collapses the same caveat arriving from several places', () => {
    // One condition can be recorded per target and again per application.
    const caveats = limitationCaveats([
      limitation('lkg_generation_missing', 'gen-a'),
      limitation('lkg_generation_missing', 'gen-b'),
      limitation('legacy_pending'),
    ]);

    expect(caveats).toHaveLength(2);
    expect(caveats[0]).toBe(GITOPS_LIMITATION_COPY.lkg_generation_missing);
    expect(caveats[1]).toBe(GITOPS_LIMITATION_COPY.legacy_pending);
  });

  it('returns nothing for a projection with no caveats', () => {
    expect(limitationCaveats([])).toEqual([]);
  });
});
