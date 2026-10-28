/**
 * The scope reader behind both consequential confirmations.
 *
 * The property that matters is that an unproven scope reads as unproven. Each
 * sentence is asserted for every state, because the failure this guards against
 * is a sentence that claims a destination the surface never read: "approved for"
 * followed by nothing, or "a rollout to" followed by an apology. Rendering the
 * component proves the sentence appears; this proves it never claims more than
 * the evidence supports on its own.
 */
import { describe, expect, it } from 'vitest';
import { absentRevision, liveRevision } from '@/__tests__/gitopsFixtures';
import {
  acceptScopeSentence,
  pullScopeSentence,
  readApprovedScope,
} from './gitopsApprovedScope';
import type { ApprovedRolloutScope, GitOpsRevisionProjection } from '@/types/gitops';

const nodes = [{ id: 1, name: 'local' }, { id: 3, name: 'edge' }];

function projection(scope?: ApprovedRolloutScope): GitOpsRevisionProjection {
  const live = liveRevision({ targetMode: 'blueprint' });
  if (scope === undefined) delete live.approvedRolloutScope;
  return { ...live, ...(scope === undefined ? {} : { approvedRolloutScope: scope }) };
}

describe('readApprovedScope', () => {
  it('resolves approved node ids to names', () => {
    expect(readApprovedScope(projection({ status: 'approved', approvalRef: 'p1', nodeIds: [1, 3] }), nodes))
      .toEqual({ status: 'approved', names: ['local', 'edge'] });
  });

  it('names an unknown node by id rather than dropping it from the scope', () => {
    // A roster read that came back partial must not make the scope look
    // narrower than what was approved, which would read as a smaller rollout.
    expect(readApprovedScope(projection({ status: 'approved', approvalRef: 'p1', nodeIds: [1, 9] }), nodes))
      .toEqual({ status: 'approved', names: ['local', 'node 9'] });
  });

  it('keeps an approved empty scope distinct from no approval', () => {
    expect(readApprovedScope(projection({ status: 'approved', approvalRef: 'p1', nodeIds: [] }), nodes))
      .toEqual({ status: 'approved', names: [] });
  });

  it.each([
    ['no approval', { status: 'unapproved' } as const],
    ['no placement model', { status: 'not_applicable' } as const],
    ['an approval that does not resolve', { status: 'unresolved', approvalRef: 'p1', reason: 'approval_does_not_resolve' } as const],
    ['no candidate behind the approval', { status: 'unresolved', approvalRef: 'p1', reason: 'no_candidate' } as const],
    ['unreadable required targets', { status: 'unresolved', approvalRef: 'p1', reason: 'unreadable_required_targets' } as const],
  ])('does not report a proven scope for %s', (_label, scope) => {
    expect(readApprovedScope(projection(scope), nodes).status).not.toBe('approved');
  });

  it('does not report a proven scope when the field is absent', () => {
    // A remote running a build that predates the field. Unproven is the only
    // honest reading, and it is what keeps a mixed fleet truthful.
    expect(readApprovedScope(projection(), nodes)).toEqual({ status: 'unverified' });
  });

  it('does not report a proven scope for an absent projection', () => {
    expect(readApprovedScope(absentRevision(), nodes)).toEqual({ status: 'unverified' });
  });

  it('does not report a proven scope for a shape it cannot read', () => {
    // A future backend variant reaching an older frontend. Degrading to
    // unverified is the safe direction; "approved" naming no nodes is not.
    const malformed = { status: 'approved', approvalRef: 'p1' } as unknown as ApprovedRolloutScope;
    expect(readApprovedScope(projection(malformed), nodes)).toEqual({ status: 'unverified' });
  });
});

describe('the scope sentences', () => {
  it('names the approved nodes in both confirmations', () => {
    const reading = readApprovedScope(projection({ status: 'approved', approvalRef: 'p1', nodeIds: [1, 3] }), nodes);
    expect(acceptScopeSentence(reading)).toBe('Placement is approved for local, edge.');
    expect(pullScopeSentence(reading)).toBe('The next commit goes to the approved nodes: local, edge.');
  });

  it('never claims approval in either confirmation when the scope is unproven', () => {
    const reading = readApprovedScope(projection(), nodes);
    for (const sentence of [acceptScopeSentence(reading), pullScopeSentence(reading)]) {
      expect(sentence).toContain('cannot be read');
      expect(sentence).not.toContain('approved for');
      expect(sentence).not.toContain('approved nodes');
      // The dangerous shape: "a rollout can start to <apology>".
      expect(sentence).not.toMatch(/rollout to .*cannot/);
    }
  });

  it('says an approved empty scope approves no nodes, in both confirmations', () => {
    const reading = readApprovedScope(projection({ status: 'approved', approvalRef: 'p1', nodeIds: [] }), nodes);
    expect(acceptScopeSentence(reading)).toBe('Placement is approved, but for no nodes.');
    expect(pullScopeSentence(reading)).toBe('The placement approves no nodes, so this cannot deploy anything.');
  });

  it('distinguishes never-approved from unreadable in both confirmations', () => {
    const unapproved = readApprovedScope(projection({ status: 'unapproved' }), nodes);
    const unverified = readApprovedScope(projection(), nodes);
    expect(acceptScopeSentence(unapproved)).toContain('not approved yet');
    expect(acceptScopeSentence(unverified)).toContain('cannot be read');
    expect(pullScopeSentence(unapproved)).toContain('not approved yet');
    expect(pullScopeSentence(unverified)).toContain('cannot be read');
    expect(acceptScopeSentence(unapproved)).not.toBe(acceptScopeSentence(unverified));
  });

  it('produces a full sentence for every state, so neither template can leave a dangling clause', () => {
    const readings = [
      readApprovedScope(projection({ status: 'approved', approvalRef: 'p1', nodeIds: [1] }), nodes),
      readApprovedScope(projection({ status: 'approved', approvalRef: 'p1', nodeIds: [] }), nodes),
      readApprovedScope(projection({ status: 'unapproved' }), nodes),
      readApprovedScope(projection(), nodes),
    ];
    for (const reading of readings) {
      for (const sentence of [acceptScopeSentence(reading), pullScopeSentence(reading)]) {
        expect(sentence.endsWith('.')).toBe(true);
        expect(sentence.length).toBeGreaterThan(20);
      }
    }
  });
});
