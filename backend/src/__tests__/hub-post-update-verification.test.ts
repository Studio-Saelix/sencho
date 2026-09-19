import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ node: vi.fn(), probe: vi.fn() }));
vi.mock('../services/NodeRegistry', () => ({ NodeRegistry: { getInstance: () => ({ getNode: mocks.node, probeRemoteMeta: mocks.probe }) } }));
vi.mock('../services/ImageUpdateService', () => ({ UPDATE_VERIFICATION_INCOMPLETE_WARNING: 'Verification incomplete' }));
import { awaitHubPostUpdateVerification, decorateUpdateResponse } from '../services/hubPostUpdateVerification';

beforeEach(() => {
  mocks.node.mockReturnValue({ type: 'remote' });
  mocks.probe.mockResolvedValue({ kind: 'ok', meta: { capabilities: ['remote-image-inspect-v1', 'remote-auto-update-checked-v1'] } });
});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

const input = { nodeId: 2, stack: 'web', caller: 'coordinator' as const, targetResponse: { status: 200, body: { result: 'applied', applied: true, healthGateId: 'health' } } };

describe('awaited hub verification', () => {
  it('holds caller response until exactly one authoritative recheck completes', async () => {
    let complete!: (value: { warning: null }) => void;
    const recheckRemoteStack = vi.fn(() => new Promise<{ warning: null }>(resolve => { complete = resolve; }));
    let settled = false;
    const operation = awaitHubPostUpdateVerification({ ...input, transport: { recheckRemoteStack } }).then(value => { settled = true; return value; });
    await vi.waitFor(() => expect(recheckRemoteStack).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    complete({ warning: null });
    const verification = await operation;
    expect(verification).toMatchObject({ status: 'verified', source: 'hub_authority' });
    expect(decorateUpdateResponse({ healthGateId: 'health', recheckWarning: 'target warning' }, verification)).toEqual({ healthGateId: 'health', verification });
  });

  it.each([409, 500])('never rechecks a rejected target response (%s)', async status => {
    const recheckRemoteStack = vi.fn();
    const result = await awaitHubPostUpdateVerification({ ...input, targetResponse: { status, body: { applied: false } }, transport: { recheckRemoteStack } });
    expect(result.status).toBe('skipped');
    expect(recheckRemoteStack).not.toHaveBeenCalled();
    expect(mocks.probe).not.toHaveBeenCalled();
  });

  it('preserves target warning and health metadata for mixed versions', async () => {
    mocks.probe.mockResolvedValue({ kind: 'ok', meta: { capabilities: [] } });
    const recheckRemoteStack = vi.fn();
    const verification = await awaitHubPostUpdateVerification({ ...input, transport: { recheckRemoteStack } });
    expect(decorateUpdateResponse({ healthGateId: 'health', recheckWarning: 'target warning' }, verification)).toMatchObject({ healthGateId: 'health', recheckWarning: 'target warning' });
    expect(recheckRemoteStack).not.toHaveBeenCalled();
  });

  it('bounds a non-settling recheck and preserves successful mutation', async () => {
    vi.useFakeTimers();
    const recheckRemoteStack = vi.fn(() => new Promise<{ warning: null }>(() => {}));
    const operation = awaitHubPostUpdateVerification({ ...input, transport: { recheckRemoteStack } });
    await vi.advanceTimersByTimeAsync(30_000);
    const verification = await operation;
    expect(verification.status).toBe('verification_incomplete');
    expect(decorateUpdateResponse(input.targetResponse.body, verification)).toMatchObject({ applied: true, healthGateId: 'health', recheckWarning: 'Verification incomplete' });
    expect(recheckRemoteStack.mock.calls).toHaveLength(1);
  });

  it('reports a failed recheck without converting mutation success into failure', async () => {
    const recheckRemoteStack = vi.fn().mockRejectedValue(new Error('offline'));
    const verification = await awaitHubPostUpdateVerification({ ...input, transport: { recheckRemoteStack } });
    expect(verification.status).toBe('verification_failed');
    expect(decorateUpdateResponse(input.targetResponse.body, verification)).toMatchObject({ applied: true, healthGateId: 'health' });
  });
});
