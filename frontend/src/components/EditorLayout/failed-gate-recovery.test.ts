import { describe, it, expect } from 'vitest';
import { classifyFailedGate } from './failed-gate-recovery';
import type { HealthGateUiState } from '@/context/DeployFeedbackContext';

type Gate = Pick<HealthGateUiState, 'status' | 'nodeId' | 'stackName'>;
const gate = (over: Partial<Gate> = {}): Gate => ({ status: 'failed', nodeId: null, stackName: 'web', ...over });

describe('classifyFailedGate', () => {
  it('skips when there is no gate', () => {
    expect(classifyFailedGate(null, null, ['web.yml'])).toEqual({ kind: 'skip' });
  });

  it('skips a gate that has not failed', () => {
    expect(classifyFailedGate(gate({ status: 'observing' }), null, ['web.yml'])).toEqual({ kind: 'skip' });
    expect(classifyFailedGate(gate({ status: 'passed' }), null, ['web.yml'])).toEqual({ kind: 'skip' });
  });

  it('records on the local node when the gate ran locally and a file matches', () => {
    expect(classifyFailedGate(gate({ nodeId: null }), null, ['web.yml'])).toEqual({ kind: 'record', stackFile: 'web.yml' });
  });

  it('records on a remote node when the gate node matches the active node', () => {
    expect(classifyFailedGate(gate({ nodeId: 3 }), 3, ['web.yaml'])).toEqual({ kind: 'record', stackFile: 'web.yaml' });
  });

  it('skips when the gate ran on a different node than the active one', () => {
    // Remote gate, active node is local: must not attach to a same-named local stack.
    expect(classifyFailedGate(gate({ nodeId: 3 }), null, ['web.yml'])).toEqual({ kind: 'skip' });
    // Local gate, active node is remote.
    expect(classifyFailedGate(gate({ nodeId: null }), 3, ['web.yml'])).toEqual({ kind: 'skip' });
    // Two different remote nodes.
    expect(classifyFailedGate(gate({ nodeId: 2 }), 5, ['web.yml'])).toEqual({ kind: 'skip' });
  });

  it('reports no-file when the node matches but no stack file matches yet', () => {
    expect(classifyFailedGate(gate({ nodeId: 3, stackName: 'web' }), 3, ['other.yml'])).toEqual({ kind: 'no-file' });
  });
});
