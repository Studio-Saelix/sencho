import { describe, it, expect } from 'vitest';
import {
  createAutoUpdateDigestGateState,
  messageWhenDigestApplyBlockedByCheckErrors,
  recordAutoUpdateImageCheck,
} from '../helpers/autoUpdateDigestGate';

describe('autoUpdateDigestGate', () => {
  it('blocks digest apply when sibling check errors exist', () => {
    const state = createAutoUpdateDigestGateState();
    recordAutoUpdateImageCheck(state, 'nginx:latest', {
      hasUpdate: true,
      digestUpdate: true,
      tagUpdate: false,
    });
    recordAutoUpdateImageCheck(state, 'redis:latest', {
      hasUpdate: false,
      digestUpdate: false,
      tagUpdate: false,
      checkStatus: 'failed',
      error: 'registry timeout',
    });

    const msg = messageWhenDigestApplyBlockedByCheckErrors('web', state);
    expect(msg).toContain('image check(s) failed');
    expect(msg).toContain('registry timeout');
  });

  it('does not block when digest update exists without check errors', () => {
    const state = createAutoUpdateDigestGateState();
    recordAutoUpdateImageCheck(state, 'nginx:latest', {
      hasUpdate: true,
      digestUpdate: true,
      tagUpdate: false,
    });
    expect(messageWhenDigestApplyBlockedByCheckErrors('web', state)).toBeNull();
  });
});
