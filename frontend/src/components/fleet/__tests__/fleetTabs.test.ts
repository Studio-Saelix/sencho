import { describe, it, expect } from 'vitest';
import { buildFleetTabs, COMPACT_PRIMARY_TABS } from '../fleetTabs';

const ALL = { isAdmin: true, containerLabels: true, routing: true };

describe('buildFleetTabs', () => {
  it('lists every tab for a full-access session, split into Observe and Operate', () => {
    const tabs = buildFleetTabs(ALL);
    expect(tabs.filter(t => t.group === 'observe').map(t => t.value)).toEqual(['overview', 'readiness', 'dependencies', 'container-labels']);
    expect(tabs.filter(t => t.group === 'operate').map(t => t.value)).toEqual(['snapshots', 'deployments', 'routing', 'federation', 'actions', 'secrets']);
  });

  it('omits the admin-only tabs for a non-admin and the gated tabs when they are not available', () => {
    const tabs = buildFleetTabs({ isAdmin: false, containerLabels: false, routing: false });
    expect(tabs.map(t => t.value)).toEqual(['overview', 'readiness', 'dependencies', 'deployments', 'federation', 'actions']);
  });

  it('keeps the existing tab values and labels so deep links and the docs still match', () => {
    const labels = Object.fromEntries(buildFleetTabs(ALL).map(t => [t.value, t.label]));
    expect(labels).toMatchObject({ overview: 'Overview', deployments: 'Blueprints', dependencies: 'Map', 'container-labels': 'Docker Labels' });
  });

  it('keeps five tabs on the compact strip, all of them always available', () => {
    expect(COMPACT_PRIMARY_TABS).toHaveLength(5);
    const values = buildFleetTabs({ isAdmin: false, containerLabels: false, routing: false }).map(t => t.value);
    for (const tab of COMPACT_PRIMARY_TABS) expect(values).toContain(tab);
  });
});
