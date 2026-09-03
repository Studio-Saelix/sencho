/**
 * Pure trigger normalization and coalescing-key coverage for the GitOps
 * source controller. No DB, no store: these are the identity/joining rules
 * a controller submission goes through before anything durable happens.
 */
import { describe, it, expect } from 'vitest';
import { coalesceKey, deliveryKey, type ReconcileRequest } from '../services/gitops/triggers';

function fetchRequest(overrides: Partial<Extract<ReconcileRequest, { intent: 'fetch' }>> = {}): ReconcileRequest {
  return {
    intent: 'fetch',
    applicationId: 'app-1',
    stackName: 'web',
    trigger: 'manual',
    actor: 'tester',
    ...overrides,
  };
}

function applyRequest(overrides: Partial<Extract<ReconcileRequest, { intent: 'apply' }>> = {}): ReconcileRequest {
  return {
    intent: 'apply',
    applicationId: 'app-1',
    stackName: 'web',
    trigger: 'manual',
    actor: 'tester',
    commitSha: 'a'.repeat(40),
    planFingerprint: 'fp-1',
    deploy: false,
    ...overrides,
  };
}

describe('coalesceKey', () => {
  it('joins two fetch requests for the same application', () => {
    expect(coalesceKey(fetchRequest())).toBe(coalesceKey(fetchRequest({ trigger: 'poll' })));
  });

  it('does not join fetch requests for different applications', () => {
    expect(coalesceKey(fetchRequest({ applicationId: 'app-1' })))
      .not.toBe(coalesceKey(fetchRequest({ applicationId: 'app-2' })));
  });

  it('joins two apply requests with identical commit, fingerprint, and deploy flag', () => {
    expect(coalesceKey(applyRequest())).toBe(coalesceKey(applyRequest({ trigger: 'webhook' })));
  });

  it('does not join two applies with different plan fingerprints', () => {
    expect(coalesceKey(applyRequest({ planFingerprint: 'fp-1' })))
      .not.toBe(coalesceKey(applyRequest({ planFingerprint: 'fp-2' })));
  });

  it('does not join two applies with different commits', () => {
    expect(coalesceKey(applyRequest({ commitSha: 'a'.repeat(40) })))
      .not.toBe(coalesceKey(applyRequest({ commitSha: 'b'.repeat(40) })));
  });

  it('does not join two applies that differ only in deploy', () => {
    expect(coalesceKey(applyRequest({ deploy: false })))
      .not.toBe(coalesceKey(applyRequest({ deploy: true })));
  });

  it('never joins a fetch and an apply for the same application', () => {
    expect(coalesceKey(fetchRequest())).not.toBe(coalesceKey(applyRequest()));
  });
});

describe('deliveryKey', () => {
  it('namespaces the same delivery id differently per trigger', () => {
    expect(deliveryKey('webhook', 'delivery-1')).not.toBe(deliveryKey('api', 'delivery-1'));
  });

  it('is stable for the same trigger and delivery id', () => {
    expect(deliveryKey('webhook', 'delivery-1')).toBe(deliveryKey('webhook', 'delivery-1'));
  });
});
