import { describe, it, expect } from 'vitest';
import {
  authzReady,
  isViewHidden,
  isFleetTabHidden,
  isSettingsSectionHidden,
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
    experimental: false,
    experimentalReady: true,
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
    const licenseError = ctx({ licenseStatus: 'error', experimental: true });
    expect(isViewHidden('host-console', licenseError)).toBe(false);
  });

  it('does not apply experimental hide to host-console until experimentalReady', () => {
    const loading = ctx({ experimental: false, experimentalReady: false, isPaid: true, isAdmin: true });
    expect(isViewHidden('host-console', loading)).toBe(false);
  });

  it('hides host-console when experimental is ready and off even for paid admin', () => {
    const off = ctx({ experimental: false, experimentalReady: true, isPaid: true, isAdmin: true });
    expect(isViewHidden('host-console', off)).toBe(true);
    expect(normalizeHiddenView('host-console', off)).toBe('dashboard');
  });

  it('keeps host-console when experimental is on for paid admin', () => {
    const on = ctx({ experimental: true, experimentalReady: true, isPaid: true, isAdmin: true });
    expect(isViewHidden('host-console', on)).toBe(false);
  });

  it('hides routing and secrets fleet tabs only after experimentalReady when off', () => {
    const loading = ctx({ experimental: false, experimentalReady: false });
    expect(isFleetTabHidden('routing', loading)).toBe(false);
    expect(isFleetTabHidden('secrets', loading)).toBe(false);

    const off = ctx({ experimental: false, experimentalReady: true });
    expect(isFleetTabHidden('routing', off)).toBe(true);
    expect(isFleetTabHidden('secrets', off)).toBe(true);
    expect(isFleetTabHidden('deployments', off)).toBe(false);
    expect(isFleetTabHidden('federation', off)).toBe(false);
    expect(isFleetTabHidden('actions', off)).toBe(false);
  });

  it('does not hide fleet-mesh settings for experimental off', () => {
    const off = ctx({ experimental: false, experimentalReady: true, isAdmin: true });
    expect(isSettingsSectionHidden('fleet-mesh', off)).toBe(false);
  });
});
