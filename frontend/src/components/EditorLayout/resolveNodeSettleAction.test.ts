import { describe, it, expect } from 'vitest';
import { resolveNodeSettleAction } from './resolveNodeSettleAction';

const base = { settledNodeId: 2, isRealSwitch: true, pendingStack: null, pendingNodeIntent: null, pendingNodeView: null };
const run = () => {};

describe('resolveNodeSettleAction', () => {
  it('opens a queued stack ahead of a queued Home destination', () => {
    expect(resolveNodeSettleAction({ ...base, pendingStack: 'web', pendingNodeIntent: run })).toEqual({ kind: 'load-stack', stackName: 'web' });
  });

  it('runs a queued Home destination instead of returning to Home', () => {
    expect(resolveNodeSettleAction({ ...base, pendingNodeIntent: run })).toEqual({ kind: 'run-intent', run });
  });

  it('prefers a queued Home destination over a node-scoped view request', () => {
    expect(resolveNodeSettleAction({ ...base, pendingNodeIntent: run, pendingNodeView: { nodeId: 2, open: () => {} } })).toMatchObject({ kind: 'run-intent' });
  });

  it('opens a node-scoped view only for the node that settled', () => {
    const open = () => {};
    expect(resolveNodeSettleAction({ ...base, pendingNodeView: { nodeId: 2, open } })).toEqual({ kind: 'open-node-view', open });
    expect(resolveNodeSettleAction({ ...base, pendingNodeView: { nodeId: 3, open: () => {} } })).toEqual({ kind: 'go-home' });
  });

  it('returns to Home on a real switch with nothing queued, and does nothing otherwise', () => {
    expect(resolveNodeSettleAction(base)).toEqual({ kind: 'go-home' });
    expect(resolveNodeSettleAction({ ...base, isRealSwitch: false })).toEqual({ kind: 'none' });
  });
});
