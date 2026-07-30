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

  it('keeps deep links stable when permission metadata fails', () => {
    const failed = ctx({ permissionsStatus: 'error', can: () => false, isAdmin: false });
    expect(authzReady(failed)).toBe(false);
    expect(isViewHidden('fleet', failed)).toBe(false);
    expect(normalizeHiddenView('fleet', failed)).toBe('fleet');
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
    expect(isViewHidden('networking', noFleet)).toBe(true);
  });

  it('preserves host-console when authz is not ready', () => {
    const licenseError = ctx({ licenseStatus: 'error', can: (a) => a === 'system:console' });
    expect(isViewHidden('host-console', licenseError)).toBe(false);
  });

  it('hides host-console without system:console when ready', () => {
    const noConsole = ctx({ can: () => false, isPaid: false, experimental: false });
    expect(isViewHidden('host-console', noConsole)).toBe(true);
    expect(normalizeHiddenView('host-console', noConsole)).toBe('dashboard');
  });

  it('keeps host-console for system:console regardless of tier or experimental', () => {
    const community = ctx({
      isPaid: false,
      experimental: false,
      experimentalReady: true,
      can: (a) => a === 'system:console',
    });
    expect(isViewHidden('host-console', community)).toBe(false);
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
