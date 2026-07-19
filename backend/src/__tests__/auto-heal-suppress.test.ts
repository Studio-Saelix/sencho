/**
 * Ref-counted Auto-Heal suppression for overlapping service-scoped updates.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AutoHealService } from '../services/AutoHealService';

describe('AutoHealService suppress refcount', () => {
  beforeEach(() => {
    AutoHealService.getInstance().stop();
  });

  it('keeps suppression until every overlapping owner clears', () => {
    const svc = AutoHealService.getInstance();
    svc.suppress(0, 'web', 'api');
    svc.suppress(0, 'web', 'api');
    expect(svc.isSuppressed(0, 'web', 'api')).toBe(true);
    svc.clearSuppress(0, 'web', 'api');
    expect(svc.isSuppressed(0, 'web', 'api')).toBe(true);
    svc.clearSuppress(0, 'web', 'api');
    expect(svc.isSuppressed(0, 'web', 'api')).toBe(false);
  });

  it('scopes suppression per service on the same stack', () => {
    const svc = AutoHealService.getInstance();
    svc.suppress(0, 'web', 'api');
    expect(svc.isSuppressed(0, 'web', 'api')).toBe(true);
    expect(svc.isSuppressed(0, 'web', 'db')).toBe(false);
    svc.clearSuppress(0, 'web', 'api');
    expect(svc.isSuppressed(0, 'web', 'api')).toBe(false);
  });

  it('ignores clearSuppress when nothing is suppressed', () => {
    const svc = AutoHealService.getInstance();
    svc.clearSuppress(0, 'web', 'api');
    expect(svc.isSuppressed(0, 'web', 'api')).toBe(false);
  });
});
