import type { FleetTab } from '@/lib/events';
import type { SectionId } from '@/components/settings/types';
import { getSettingsItem } from '@/components/settings/registry';
import type { ActiveView } from '@/lib/router/routeTypes';
import { HUB_ONLY_VIEWS } from '@/lib/router/routeTypes';

export type ReadinessStatus = 'loading' | 'ready' | 'error';

export interface ReachabilityContext {
  isAdmin: boolean;
  isPaid: boolean;
  can: (action: string) => boolean;
  isRemote: boolean;
  hasFleetCapability: boolean;
  containerLabelsEnabled: boolean;
  permissionsStatus: ReadinessStatus;
  licenseStatus: ReadinessStatus;
  /** Gateway SENCHO_EXPERIMENTAL discovery flag. */
  experimental: boolean;
  /** True once /meta experimental has settled (success or fail-closed). */
  experimentalReady: boolean;
}

/** RBAC/tier gates apply only when permission and license metadata are ready. */
export function authzReady(ctx: ReachabilityContext): boolean {
  return ctx.permissionsStatus === 'ready' && ctx.licenseStatus === 'ready';
}

/**
 * Experimental discovery gates apply only after /meta settles. Before that,
 * treat surfaces as not-yet-hidden so URL sync does not rewrite enabled
 * deep links during cold load.
 */
export function experimentalDiscoveryReady(ctx: ReachabilityContext): boolean {
  return ctx.experimentalReady;
}

/** Role/tier hidden views normalize away only when permission and license metadata are ready. */
export function isViewHidden(view: ActiveView, ctx: ReachabilityContext): boolean {
  if (!authzReady(ctx)) return false;
  if (ctx.isRemote && HUB_ONLY_VIEWS.has(view)) return true;
  if (!ctx.isAdmin && view === 'global-observability') return true;
  if (!ctx.isAdmin && (view === 'auto-updates' || view === 'scheduled-ops')) return true;
  if (!ctx.can('node:read') && view === 'fleet') return true;
  if (view === 'host-console') {
    // Defer experimental hide until ready so enabled deep links survive cold load.
    if (experimentalDiscoveryReady(ctx) && !ctx.experimental) return true;
    if (!ctx.isPaid) return true;
    if (!ctx.isAdmin) return true;
    return false;
  }
  if (!ctx.isPaid) {
    if (view === 'audit-log') return true;
  } else {
    if (view === 'audit-log' && !ctx.can('system:audit')) return true;
  }
  return false;
}

/** Capability-locked views stay reachable but render a lock card. */
export function isViewCapabilityLocked(view: ActiveView, ctx: ReachabilityContext): boolean {
  if (!authzReady(ctx)) return false;
  if (view === 'fleet') return !ctx.hasFleetCapability;
  return false;
}

export function isFleetTabHidden(tab: FleetTab, ctx: ReachabilityContext): boolean {
  if (!authzReady(ctx)) return false;
  if (tab === 'container-labels' && !ctx.containerLabelsEnabled) return true;
  // Defer experimental hide until ready (same cold-load contract as host-console).
  if ((tab === 'routing' || tab === 'secrets') && experimentalDiscoveryReady(ctx) && !ctx.experimental) {
    return true;
  }
  return false;
}

export function isSettingsSectionHidden(section: SectionId, ctx: ReachabilityContext): boolean {
  if (!authzReady(ctx)) return false;
  const item = getSettingsItem(section);
  if (!item) return true;
  if (ctx.isRemote && item.hiddenOnRemote) return true;
  if (item.adminOnly && !ctx.isAdmin) return true;
  if (item.tier === 'paid' && !ctx.isPaid) return true;
  // fleet-mesh stays reachable: snapshot_documentation lives there even when
  // Mesh discovery is off.
  return false;
}

/** Normalize a hidden view to dashboard on the active node. */
export function normalizeHiddenView(view: ActiveView, ctx: ReachabilityContext): ActiveView {
  return isViewHidden(view, ctx) ? 'dashboard' : view;
}
