import { describe, it, expect } from 'vitest';
import { resolveNodeSettleAction } from './resolveNodeSettleAction';

const base = { settledNodeId: 2, isRealSwitch: true, pendingStack: null, pendingNodeIntent: null, pendingNetworkingNodeId: null };
const run = () => {};

describe('resolveNodeSettleAction', () => {
  it('opens a queued stack ahead of a queued Home destination', () => {
    expect(resolveNodeSettleAction({ ...base, pendingStack: 'web', pendingNodeIntent: run })).toEqual({ kind: 'load-stack', stackName: 'web' });
  });

  it('runs a queued Home destination instead of returning to Home', () => {
    expect(resolveNodeSettleAction({ ...base, pendingNodeIntent: run })).toEqual({ kind: 'run-intent', run });
  });

  it('prefers a queued Home destination over a Networking request', () => {
    expect(resolveNodeSettleAction({ ...base, pendingNodeIntent: run, pendingNetworkingNodeId: 2 })).toMatchObject({ kind: 'run-intent' });
  });

  it('opens Networking only for the node that settled', () => {
    expect(resolveNodeSettleAction({ ...base, pendingNetworkingNodeId: 2 })).toEqual({ kind: 'open-networking' });
    expect(resolveNodeSettleAction({ ...base, pendingNetworkingNodeId: 3 })).toEqual({ kind: 'go-home' });
  });

  it('returns to Home on a real switch with nothing queued, and does nothing otherwise', () => {
    expect(resolveNodeSettleAction(base)).toEqual({ kind: 'go-home' });
    expect(resolveNodeSettleAction({ ...base, isRealSwitch: false })).toEqual({ kind: 'none' });
  });
});
