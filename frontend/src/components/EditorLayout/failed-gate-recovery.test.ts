import { describe, it, expect } from 'vitest';
import { classifyFailedGate } from './failed-gate-recovery';
import type { HealthGateUiState } from '@/context/DeployFeedbackContext';

type Gate = Pick<HealthGateUiState, 'status' | 'nodeId' | 'stackName'>;
const gate = (over: Partial<Gate> = {}): Gate => ({ status: 'failed', nodeId: null, stackName: 'web', ...over });

describe('classifyFailedGate', () => {
  it('skips when there is no gate', () => {
    expect(classifyFailedGate(null, null, null, ['web.yml'])).toEqual({ kind: 'skip' });
  });

  it('skips a gate that has not failed', () => {
    expect(classifyFailedGate(gate({ status: 'observing' }), null, null, ['web.yml'])).toEqual({ kind: 'skip' });
    expect(classifyFailedGate(gate({ status: 'passed' }), null, null, ['web.yml'])).toEqual({ kind: 'skip' });
  });

  it('records on the local node when the gate ran locally and a file matches', () => {
    expect(classifyFailedGate(gate({ nodeId: null }), null, null, ['web.yml'])).toEqual({ kind: 'record', stackFile: 'web.yml' });
  });

  it('records on a remote node when the gate, the active node, and the file list all match', () => {
    expect(classifyFailedGate(gate({ nodeId: 3 }), 3, 3, ['web.yaml'])).toEqual({ kind: 'record', stackFile: 'web.yaml' });
  });

  it('skips when the gate ran on a different node than the active one', () => {
    // Remote gate, active node is local: must not attach to a same-named local stack.
    expect(classifyFailedGate(gate({ nodeId: 3 }), null, null, ['web.yml'])).toEqual({ kind: 'skip' });
    // Local gate, active node is remote.
    expect(classifyFailedGate(gate({ nodeId: null }), 3, 3, ['web.yml'])).toEqual({ kind: 'skip' });
    // Two different remote nodes.
    expect(classifyFailedGate(gate({ nodeId: 2 }), 5, 5, ['web.yml'])).toEqual({ kind: 'skip' });
  });

  it('skips when the active node matches but the loaded file list is still another node\'s', () => {
    // Switch-back gap: active node is the gate's node again, but files (and its
    // filesNodeId) have not refreshed yet, so the list belongs to the node we
    // just left. A same-named stack there must not capture the recovery entry.
    expect(classifyFailedGate(gate({ nodeId: 3 }), 3, 2, ['web.yml'])).toEqual({ kind: 'skip' });
    expect(classifyFailedGate(gate({ nodeId: null }), null, 2, ['web.yml'])).toEqual({ kind: 'skip' });
  });

  it('reports no-file when the node and file list match but no stack file matches the name yet', () => {
    expect(classifyFailedGate(gate({ nodeId: 3, stackName: 'web' }), 3, 3, ['other.yml'])).toEqual({ kind: 'no-file' });
  });
});
