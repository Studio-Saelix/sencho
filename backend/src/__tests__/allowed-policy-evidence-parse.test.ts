/**
 * The hub reads a remote node's `policyEvidence` off a response that crossed a
 * network hop, so anything that is not the shape the node sends is ignored
 * rather than passed on to the hub's own caller.
 */
import { describe, it, expect } from 'vitest';
import { parseRemotePolicyEvidence } from '../services/allowedPolicyEvidence';

const valid = {
  policy: { id: 3, name: 'prod-gate' },
  bypassed: false,
  evidence: { outcome: 'allow', summary: 'scanner unavailable', records: [], applications: [] },
};

describe('parseRemotePolicyEvidence', () => {
  it('returns the decision a node sent', () => {
    expect(parseRemotePolicyEvidence({ message: 'ok', policyEvidence: valid })).toEqual(valid);
  });

  it.each([
    ['no body', undefined],
    ['a string body', 'ok'],
    ['no field', { message: 'ok' }],
    ['a null field', { policyEvidence: null }],
    ['a string field', { policyEvidence: 'allowed' }],
    ['no policy', { policyEvidence: { ...valid, policy: undefined } }],
    ['a policy with a string id', { policyEvidence: { ...valid, policy: { id: '3', name: 'x' } } }],
    ['a non-boolean bypassed', { policyEvidence: { ...valid, bypassed: 'no' } }],
    ['no evidence', { policyEvidence: { ...valid, evidence: undefined } }],
    ['evidence without records', { policyEvidence: { ...valid, evidence: { ...valid.evidence, records: undefined } } }],
    ['evidence without an outcome', { policyEvidence: { ...valid, evidence: { ...valid.evidence, outcome: 1 } } }],
    ['evidence with an outcome that is not a decision', { policyEvidence: { ...valid, evidence: { ...valid.evidence, outcome: 'maybe' } } }],
  ])('treats %s as nothing sent', (_name, body) => {
    expect(parseRemotePolicyEvidence(body)).toBeUndefined();
  });
});
