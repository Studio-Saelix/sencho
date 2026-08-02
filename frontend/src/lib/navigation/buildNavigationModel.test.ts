import { describe, it, expect } from 'vitest';
import { buildNavigationModel } from './buildNavigationModel';
import type { ReachabilityContext } from '@/lib/routing/reachability';

function makeCtx(overrides: Partial<ReachabilityContext> = {}): ReachabilityContext {
  return {
    isAdmin: true,
    isPaid: true,
    can: () => true,
    isRemote: false,
    hasFleetCapability: true,
    containerLabelsEnabled: true,
    permissionsStatus: 'ready',
    licenseStatus: 'ready',
    experimental: true,
    experimentalReady: true,
    scheduledOpsAccessible: true,
    ...overrides,
  };
}

describe('buildNavigationModel', () => {
  it('returns exact Classic page order including Networking after Resources', () => {
    const model = buildNavigationModel(makeCtx());
    expect(model.allPageItems.map((item) => item.value)).toEqual([
      'dashboard',
      'fleet',
      'resources',
      'networking',
      'security',
      'templates',
      'global-observability',
      'auto-updates',
      'scheduled-ops',
      'host-console',
      'audit-log',
    ]);
    expect(model.allPageItems.some((item) => item.value === 'settings')).toBe(false);
  });

  it('partitions Smart primary and overflow disjointly covering all page destinations', () => {
    const model = buildNavigationModel(makeCtx());
    const primary = model.primaryItems.map((item) => item.value);
    const overflow = model.overflowGroups.flatMap((g) => g.items.map((i) => i.value));
    expect(primary).toEqual([
      'dashboard',
      'fleet',
      'resources',
      'networking',
      'security',
      'templates',
    ]);
    expect(primary.filter((v) => overflow.includes(v))).toEqual([]);
    expect(new Set([...primary, ...overflow])).toEqual(
      new Set(model.allPageItems.map((item) => item.value)),
    );
  });

  it('includes Settings only in launcher groups', () => {
    const model = buildNavigationModel(makeCtx());
    const launcherValues = model.launcherGroups.flatMap((g) => g.items.map((i) => i.value));
    expect(launcherValues).toContain('settings');
    expect(model.allPageItems.map((i) => i.value)).not.toContain('settings');
    expect(model.primaryItems.map((i) => i.value)).not.toContain('settings');
  });

  it('keeps Networking reachable on a remote node while dropping hub-only pages', () => {
    const model = buildNavigationModel(makeCtx({ isRemote: true }));
    const values = model.allPageItems.map((item) => item.value);
    expect(values).toContain('networking');
    expect(values).toContain('resources');
    expect(values).toContain('security');
    expect(values).toContain('templates');
    expect(values).not.toContain('fleet');
    expect(values).not.toContain('global-observability');
    expect(values).not.toContain('auto-updates');
    expect(values).not.toContain('scheduled-ops');
    expect(values).not.toContain('audit-log');
  });

  it('includes Console for system:console regardless of experimental discovery', () => {
    const canConsole = (a: string) => a === 'system:console' || a === 'node:read';
    for (const experimentalReady of [true, false]) {
      const values = buildNavigationModel(
        makeCtx({ experimentalReady, experimental: false, isPaid: false, can: canConsole }),
      ).allPageItems.map((i) => i.value);
      expect(values).toContain('host-console');
    }
  });

  it('includes Audit for system:audit on Community', () => {
    const values = buildNavigationModel(
      makeCtx({ isPaid: false, can: (a) => a === 'system:audit' || a === 'node:read' }),
    ).allPageItems.map((i) => i.value);
    expect(values).toContain('audit-log');
  });

  it('omits Audit without system:audit', () => {
    const values = buildNavigationModel(
      makeCtx({ isPaid: true, can: (a) => a === 'node:read' }),
    ).allPageItems.map((i) => i.value);
    expect(values).not.toContain('audit-log');
  });

  it('omits Console without system:console', () => {
    const values = buildNavigationModel(
      makeCtx({ can: () => false, isAdmin: false }),
    ).allPageItems.map((i) => i.value);
    expect(values).not.toContain('host-console');
  });

  it('excludes hidden views from quick-link candidates', () => {
    const model = buildNavigationModel(makeCtx({ isRemote: true, isPaid: false }));
    const values = model.quickLinkCandidates.map((i) => i.value);
    expect(values).toContain('networking');
    expect(values).not.toContain('fleet');
    expect(values).not.toContain('settings');
  });
});
