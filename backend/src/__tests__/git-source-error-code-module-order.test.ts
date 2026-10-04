/**
 * The closed git code set must survive every module load order.
 *
 * The set is built from a leaf module, so importing GitSourceService or a
 * route that reaches it before utils/gitSourceHttp must still leave the set
 * populated. Reading the list through the service left it empty under some
 * orders and silently disabled the code relay.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb } from './helpers/setupTestDb';

describe('git source error code set under module load order', () => {
  beforeEach(async () => {
    vi.resetModules();
    await setupTestDb();
  });

  it('stays populated when GitSourceService loads first', async () => {
    await import('../services/GitSourceService');
    const { isGitSourceErrorCode } = await import('../utils/gitSourceHttp');
    expect(isGitSourceErrorCode('AUTH_FAILED')).toBe(true);
    expect(isGitSourceErrorCode('REF_NOT_FOUND')).toBe(true);
  });

  it('stays populated when routes/gitSources loads first', async () => {
    await import('../routes/gitSources');
    const { isGitSourceErrorCode } = await import('../utils/gitSourceHttp');
    expect(isGitSourceErrorCode('AUTH_FAILED')).toBe(true);
    expect(isGitSourceErrorCode('REF_NOT_FOUND')).toBe(true);
  });
});
