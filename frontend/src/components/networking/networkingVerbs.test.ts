import { describe, expect, it } from 'vitest';
import { resolveNetworkingVerbs } from './networkingVerbs';
import type { NetworkingFinding, NetworkingRecommendedAction } from '@/types/networking';

function finding(actions: NetworkingRecommendedAction[], overrides: Partial<NetworkingFinding> = {}): NetworkingFinding {
  return {
    id: 'f', kind: 'external-network-missing', severity: 'high', title: 't', message: 'm', stack: 'web',
    evidence: [], recommendedActions: actions, sources: ['live'], doctorFindings: [],
    fingerprint: 'fp', count: 1, dismissPolicy: 'any', ...overrides,
  };
}

const ADMIN = { isAdmin: true, canEditStack: () => true };
const VIEWER = { isAdmin: false, canEditStack: () => false };

const create: NetworkingRecommendedAction = { kind: 'create-network', label: 'Create network', networkName: 'n', requiresAdmin: true };
const copy: NetworkingRecommendedAction = { kind: 'copy-docker-command', label: 'Copy Docker command', commandKind: 'network-create', networkName: 'n' };
const editor: NetworkingRecommendedAction = { kind: 'open-stack-editor', label: 'Open stack editor', stack: 'web' };
const intent: NetworkingRecommendedAction = { kind: 'set-exposure-intent', label: 'Set exposure intent', stack: 'web', service: 'app' };

describe('resolveNetworkingVerbs', () => {
  it('makes Create network a two-click verb for an admin and keeps Copy in the overflow', () => {
    const { primary, more } = resolveNetworkingVerbs(finding([create, copy, editor]), ADMIN);
    expect(primary).toMatchObject({ label: 'Create network', clicks: 2 });
    expect(more.map(verb => verb.label)).toEqual(['Copy Docker command', 'Open stack editor']);
  });

  it('falls back to the named navigation when the account cannot run the first verb', () => {
    const { primary, more } = resolveNetworkingVerbs(finding([create, copy, editor]), VIEWER);
    expect(primary).toMatchObject({ label: 'Open stack editor', clicks: 1 });
    expect(more.map(verb => verb.label)).toEqual(['Copy Docker command']);
  });

  it('hides Set exposure intent from an account that cannot edit the stack', () => {
    expect(resolveNetworkingVerbs(finding([intent]), ADMIN).primary).toMatchObject({ clicks: 2 });
    expect(resolveNetworkingVerbs(finding([intent]), VIEWER).primary).toBeNull();
  });

  it('acknowledges a Doctor-only card in Doctor, in two clicks, only for someone who can edit the stack', () => {
    const doctorOnly = finding([{ kind: 'open-stack-doctor', label: 'Open Doctor', stack: 'web' }], { sources: ['doctor'], dismissPolicy: 'none' });
    expect(resolveNetworkingVerbs(doctorOnly, ADMIN).primary).toEqual({ label: 'Acknowledge in Doctor', clicks: 2, action: { kind: 'acknowledge-in-doctor' } });
    expect(resolveNetworkingVerbs(doctorOnly, VIEWER).primary).toBeNull();
  });

  it('never makes Open Doctor the headline verb of a live card', () => {
    const { primary, more } = resolveNetworkingVerbs(
      finding([{ kind: 'open-stack-doctor', label: 'Open Doctor', stack: 'web' }, editor]),
      ADMIN,
    );
    expect(primary).toMatchObject({ label: 'Open stack editor' });
    expect(more.map(verb => verb.label)).toEqual(['Open Doctor']);
  });
});
