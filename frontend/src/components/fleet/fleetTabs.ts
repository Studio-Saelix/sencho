import { Activity, ArrowLeftRight, Camera, KeyRound, Network, Send, Tag, Workflow, Wrench, type LucideIcon } from 'lucide-react';
import type { FleetTab } from '@/lib/events';

export type FleetTabGroup = 'observe' | 'operate';

export interface FleetTabItem {
  value: FleetTab;
  label: string;
  icon?: LucideIcon;
  group: FleetTabGroup;
}

interface FleetTabAvailability {
  isAdmin: boolean;
  containerLabels: boolean;
  routing: boolean;
}

/** Tabs that stay on the strip in the compact layout; the rest sit under More. */
export const COMPACT_PRIMARY_TABS: readonly FleetTab[] = ['overview', 'readiness', 'dependencies', 'deployments', 'actions'];

/** The flat layout's one separator sits between the last Observe tab and the first Operate tab. */
const FLAT_ORDER: readonly FleetTab[] = [
  'overview', 'snapshots', 'readiness', 'dependencies', 'container-labels',
  'deployments', 'routing', 'federation', 'actions', 'secrets',
];

/**
 * The tabs this session can see, grouped by the kind of work. Observe reads the
 * fleet; Operate changes it or holds its fleet-wide controls.
 */
export function buildFleetTabs({ isAdmin, containerLabels, routing }: FleetTabAvailability): FleetTabItem[] {
  const all: (FleetTabItem & { show: boolean })[] = [
    { value: 'overview', label: 'Overview', group: 'observe', show: true },
    { value: 'readiness', label: 'Readiness', icon: Activity, group: 'observe', show: true },
    { value: 'dependencies', label: 'Map', icon: Workflow, group: 'observe', show: true },
    { value: 'container-labels', label: 'Docker Labels', icon: Tag, group: 'observe', show: containerLabels },
    { value: 'snapshots', label: 'Snapshots', icon: Camera, group: 'operate', show: isAdmin },
    { value: 'deployments', label: 'Blueprints', icon: Send, group: 'operate', show: true },
    { value: 'routing', label: 'Routing', icon: ArrowLeftRight, group: 'operate', show: routing },
    { value: 'federation', label: 'Federation', icon: Network, group: 'operate', show: true },
    { value: 'actions', label: 'Actions', icon: Wrench, group: 'operate', show: true },
    { value: 'secrets', label: 'Secrets', icon: KeyRound, group: 'operate', show: isAdmin },
  ];
  return all.filter(t => t.show).map(t => ({ value: t.value, label: t.label, icon: t.icon, group: t.group }));
}

/** The tabs in the flat layout's order (the strip before the groups existed). */
export function flatOrder(tabs: readonly FleetTabItem[]): FleetTabItem[] {
  return FLAT_ORDER.flatMap(value => tabs.filter(t => t.value === value));
}
