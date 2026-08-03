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
    scheduledOpsAccessible: false,
    ...over,
  };
}

describe('reachability', () => {
  it('does not hide views while authz is loading or failed', () => {
    const loading = ctx({
      permissionsStatus: 'loading',
      can: () => false,
      isPaid: false,
    });
    expect(authzReady(loading)).toBe(false);
    expect(isViewHidden('audit-log', loading)).toBe(false);

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

  it('hides fleet and networking without node:read when ready', () => {
    const noNodeRead = ctx({ can: () => false });
    expect(isViewHidden('fleet', noNodeRead)).toBe(true);
    expect(isViewHidden('networking', noNodeRead)).toBe(true);
  });

  it('gates host-console on system:console only (any tier, any experimental state)', () => {
    const licenseError = ctx({ licenseStatus: 'error', can: (a) => a === 'system:console' });
    expect(isViewHidden('host-console', licenseError)).toBe(false);

    const noConsole = ctx({ can: () => false, isPaid: false, experimental: false });
    expect(isViewHidden('host-console', noConsole)).toBe(true);
    expect(normalizeHiddenView('host-console', noConsole)).toBe('dashboard');

    const community = ctx({
      isPaid: false,
      experimental: false,
      experimentalReady: true,
    scheduledOpsAccessible: false,
      can: (a) => a === 'system:console',
    });
    expect(isViewHidden('host-console', community)).toBe(false);
  });

  it('gates audit-log on system:audit only (Community and paid)', () => {
    expect(
      isViewHidden('audit-log', ctx({ isPaid: false, can: (a) => a === 'system:audit' })),
    ).toBe(false);

    const noAuditCommunity = ctx({ isPaid: false, can: () => false });
    expect(isViewHidden('audit-log', noAuditCommunity)).toBe(true);
    expect(normalizeHiddenView('audit-log', noAuditCommunity)).toBe('dashboard');

    expect(isViewHidden('audit-log', ctx({ isPaid: true, can: () => false }))).toBe(true);
  });

  it('hides routing fleet tab only after experimentalReady when off; secrets always visible for admin', () => {
    const loading = ctx({ experimental: false, experimentalReady: false });
    expect(isFleetTabHidden('routing', loading)).toBe(false);
    expect(isFleetTabHidden('secrets', loading)).toBe(false);

    const off = ctx({ experimental: false, experimentalReady: true });
    expect(isFleetTabHidden('routing', off)).toBe(true);
    expect(isFleetTabHidden('secrets', off)).toBe(false);
    expect(isFleetTabHidden('deployments', off)).toBe(false);
    expect(isFleetTabHidden('federation', off)).toBe(false);
    expect(isFleetTabHidden('actions', off)).toBe(false);
  });

  it('hides secrets fleet tab for non-admin after authz ready', () => {
    // Cold load: permissions not ready, don't hide yet (deep link survives)
    const loading = ctx({ isAdmin: false, permissionsStatus: 'loading' });
    expect(isFleetTabHidden('secrets', loading)).toBe(false);

    // Permissions settled: non-admin deep link normalizes to overview
    const ready = ctx({ isAdmin: false, permissionsStatus: 'ready' });
    expect(isFleetTabHidden('secrets', ready)).toBe(true);
  });

  it('does not hide fleet-mesh settings for experimental off', () => {
    const off = ctx({ experimental: false, experimentalReady: true,
    scheduledOpsAccessible: false, isAdmin: true });
    expect(isSettingsSectionHidden('fleet-mesh', off)).toBe(false);
  });

  it('defers settings permission hides until authz is ready', () => {
    const loading = ctx({
      permissionsStatus: 'loading',
      isAdmin: false,
      can: () => false,
    });
    expect(isSettingsSectionHidden('webhooks', loading)).toBe(false);
    expect(isSettingsSectionHidden('license', loading)).toBe(false);
  });

  it('hides requiredPermission sections when the operator lacks the permission', () => {
    const nodeAdmin = ctx({
      isAdmin: false,
      can: (a) => a === 'node:read' || a === 'node:manage',
    });
    expect(isSettingsSectionHidden('webhooks', nodeAdmin)).toBe(true);
    expect(isSettingsSectionHidden('license', nodeAdmin)).toBe(true);
    expect(isSettingsSectionHidden('users', nodeAdmin)).toBe(true);
    expect(isSettingsSectionHidden('api-tokens', nodeAdmin)).toBe(true);
    expect(isSettingsSectionHidden('registries', nodeAdmin)).toBe(true);
    expect(isSettingsSectionHidden('nodes', nodeAdmin)).toBe(false);
    expect(isSettingsSectionHidden('host-alerts', nodeAdmin)).toBe(false);
    expect(isSettingsSectionHidden('developer', nodeAdmin)).toBe(true);
    expect(isSettingsSectionHidden('data-retention', nodeAdmin)).toBe(true);
    expect(isSettingsSectionHidden('image-updates', nodeAdmin)).toBe(true);
  });

  it('hides adminOnly settings sections for non-admins', () => {
    const nodeAdmin = ctx({ isAdmin: false, can: () => true });
    expect(isSettingsSectionHidden('sso', nodeAdmin)).toBe(true);
    expect(isSettingsSectionHidden('recovery', nodeAdmin)).toBe(true);
  });
});
