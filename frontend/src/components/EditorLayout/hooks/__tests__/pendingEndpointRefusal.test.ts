import { describe, expect, it } from 'vitest';
import { loadedEndpointRefusal, type PendingEndpointRefusal } from '../pendingEndpointRefusal';

const refusal = { message: 'refused', reason: 'provider' as const, service: 'socket-proxy' };
const pending = (over: Partial<PendingEndpointRefusal> = {}): PendingEndpointRefusal => ({
  nodeId: 2,
  stackName: 'shared',
  refusal,
  ...over,
});

describe('loadedEndpointRefusal', () => {
  it('opens only for the node and stack the refusal named, once loaded', () => {
    expect(loadedEndpointRefusal(pending(), 2, ['shared.yml'], 'shared.yml', false))
      .toEqual({ nodeId: 2, stackFile: 'shared.yml' });
  });

  it('rejects the same stack name on another node', () => {
    expect(loadedEndpointRefusal(pending(), 1, ['shared.yml'], 'shared.yml', false)).toBeNull();
  });

  it('rejects while another stack is selected or the file is still loading', () => {
    expect(loadedEndpointRefusal(pending(), 2, ['shared.yml', 'other.yml'], 'other.yml', false)).toBeNull();
    expect(loadedEndpointRefusal(pending(), 2, ['shared.yml'], 'shared.yml', true)).toBeNull();
  });

  it('rejects a stack that is not in the loaded file list', () => {
    expect(loadedEndpointRefusal(pending(), 2, ['other.yml'], 'other.yml', false)).toBeNull();
  });
});
