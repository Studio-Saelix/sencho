import { describe, it, expect } from 'vitest';
import {
  authzReady,
  isViewHidden,
  normalizeHiddenView,
  type ReachabilityContext,
} from './reachability';

function ctx(over: Partial<ReachabilityContext> = {}): ReachabilityContext {
  return {
    isAdmin: true,
    isPaid: true,
    can: () => true,
    isRemote: false,
    hasFleetCapability: true,
    containerLabelsEnabled: true,
    permissionsStatus: 'ready',
    licenseStatus: 'ready',
    ...over,
  };
}

describe('reachability', () => {
  it('does not hide views while authz is loading', () => {
    const loading = ctx({ permissionsStatus: 'loading' });
    expect(authzReady(loading)).toBe(false);
    expect(isViewHidden('audit-log', loading)).toBe(false);
  });

  it('hides hub-only views on remote nodes when ready', () => {
    const remote = ctx({ isRemote: true });
    expect(isViewHidden('audit-log', remote)).toBe(true);
    expect(normalizeHiddenView('audit-log', remote)).toBe('dashboard');
  });

  it('hides admin-only operator views for non-admins when ready', () => {
    const viewer = ctx({ isAdmin: false });
    expect(isViewHidden('global-observability', viewer)).toBe(true);
    expect(isViewHidden('auto-updates', viewer)).toBe(true);
    expect(isViewHidden('scheduled-ops', viewer)).toBe(true);
  });

  it('hides fleet without node:read when ready', () => {
    const noFleet = ctx({ can: () => false });
    expect(isViewHidden('fleet', noFleet)).toBe(true);
  });

  it('preserves paid views when license metadata failed', () => {
    const licenseError = ctx({ licenseStatus: 'error' });
    expect(isViewHidden('host-console', licenseError)).toBe(false);
  });
});
