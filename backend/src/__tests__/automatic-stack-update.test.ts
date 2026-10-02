import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  policy: vi.fn(), execute: vi.fn(), beginStack: vi.fn(), link: vi.fn(),
  recheck: vi.fn(), invalidate: vi.fn(), broadcast: vi.fn(), alert: vi.fn(),
}));
vi.mock('../services/PolicyEnforcement', () => ({ enforcePolicyPreDeploy: mocks.policy }));
vi.mock('../services/StackUpdateOrchestrator', () => ({ StackUpdateOrchestrator: { getInstance: () => ({ execute: mocks.execute }) } }));
vi.mock('../services/HealthGateService', () => ({ HealthGateService: { getInstance: () => ({ beginStack: mocks.beginStack }) } }));
vi.mock('../services/StackUpdateRecoveryService', () => ({ StackUpdateRecoveryService: { getInstance: () => ({ linkGateOrRetain: mocks.link }) } }));
vi.mock('../services/ImageUpdateService', () => ({ ImageUpdateService: { getInstance: () => ({ recheckStack: mocks.recheck }) }, UPDATE_VERIFICATION_INCOMPLETE_WARNING: 'Verification incomplete' }));
vi.mock('../services/NotificationService', () => ({ NotificationService: { getInstance: () => ({ broadcastEvent: mocks.broadcast, dispatchAlert: mocks.alert }) } }));
vi.mock('../helpers/cacheInvalidation', () => ({ invalidateNodeCaches: mocks.invalidate }));
vi.mock('../services/DatabaseService', () => ({ DatabaseService: {} }));

import { applyAutomaticStackUpdate } from '../services/automaticStackUpdate';
import { StackOpLockService } from '../services/StackOpLockService';

beforeEach(() => {
  vi.clearAllMocks();
  StackOpLockService.resetForTests();
  mocks.policy.mockResolvedValue({ ok: true, violations: [] });
  mocks.execute.mockResolvedValue({ kind: 'stack_compose_done', deployedGenerationId: 'generation', recoveryId: 'recovery' });
  mocks.beginStack.mockReturnValue('health');
  mocks.recheck.mockResolvedValue({});
});

const input = { nodeId: 1, stackName: 'web', updatedImages: ['nginx:1'], policyOptions: { bypass: false, actor: 'automatic:test' } };

describe('automatic stack apply pipeline', () => {
  it('alerts with the same prefixed wording the scheduler uses', async () => {
    // Two senders of the same sentence. The scheduler prefixes the action and the
    // stack; dispatching the bare sentence here made one operator-visible message
    // have two shapes depending on which path blocked, so an alert filter written
    // against one silently missed the other.
    mocks.policy.mockResolvedValue({
      ok: false,
      policy: { name: 'prod-gate' },
      violations: [{
        imageRef: 'nginx:1', severity: 'CRITICAL', criticalCount: 1, highCount: 0,
        kevCount: 0, fixableCount: 0, reasons: ['severity'], scanId: 1,
      }],
    });
    const result = await applyAutomaticStackUpdate({ ...input, verificationOwner: 'hub_authority' });

    expect(result.result).toBe('policy_blocked');
    const alert = mocks.alert.mock.calls.find((c) => c[1] === 'scan_finding');
    expect(alert).toBeDefined();
    expect(alert![2]).toBe(
      'Auto-update blocked for "web": Policy "prod-gate" blocked update: 1 image(s) matched severity threshold images=[nginx:1]',
    );
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('verifies before policy and consumes immediately before mutation without target recheck', async () => {
    const order: string[] = [];
    mocks.policy.mockImplementation(async () => { order.push('policy'); return { ok: true, violations: [] }; });
    mocks.execute.mockImplementation(async () => { order.push('mutate'); return { kind: 'stack_compose_done', deployedGenerationId: 'generation', recoveryId: 'recovery' }; });
    const result = await applyAutomaticStackUpdate({ ...input, verificationOwner: 'hub_authority', observation: {
      verify: async () => { expect(StackOpLockService.getInstance().get(1, 'web')).toBeDefined(); order.push('verify'); },
      consume: async () => { order.push('consume'); },
    } });
    expect(order).toEqual(['verify', 'policy', 'consume', 'mutate']);
    expect(result).toMatchObject({ applied: true, healthGateId: 'health', result: 'applied' });
    expect(mocks.recheck).not.toHaveBeenCalled();
    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({ trigger: 'automatic' }), { atomic: true, terminalWs: null });
    expect(mocks.link).toHaveBeenCalledWith('recovery', 'health');
  });

  it('retains local verification and keeps successful mutation on recheck failure', async () => {
    mocks.recheck.mockRejectedValue(new Error('registry unavailable'));
    const result = await applyAutomaticStackUpdate({ ...input, verificationOwner: 'target_local' });
    expect(mocks.recheck).toHaveBeenCalledWith(1, 'web');
    expect(result).toMatchObject({ applied: true, recheckWarning: 'Verification incomplete' });
  });

  it('does not consume or mutate a policy-blocked observation', async () => {
    mocks.policy.mockResolvedValue({ ok: false, violations: [], policy: { name: 'gate' } });
    const consume = vi.fn();
    const result = await applyAutomaticStackUpdate({ ...input, verificationOwner: 'hub_authority', observation: { verify: vi.fn(), consume } });
    expect(result).toMatchObject({ applied: false, result: 'policy_blocked' });
    expect(consume).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.beginStack).not.toHaveBeenCalled();
    expect(mocks.recheck).not.toHaveBeenCalled();
  });

  it('rejects stale facts before policy or any mutation side effect', async () => {
    const verify = vi.fn().mockRejectedValue(new Error('stale'));
    await expect(applyAutomaticStackUpdate({ ...input, verificationOwner: 'hub_authority', observation: { verify, consume: vi.fn() } })).rejects.toThrow('stale');
    expect(mocks.policy).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.alert).not.toHaveBeenCalled();
  });
});
