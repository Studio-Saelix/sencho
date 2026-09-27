/**
 * Open the Fleet Blueprints surface on one Blueprint's detail, or on the
 * create dialog, from anywhere in the shell (the GitOps workplace's row menu
 * and masthead, for example).
 *
 * The intent travels two ways because the Deployments tab may or may not be
 * mounted: a mounted tab hears the event, a mounting one reads the pending
 * value in its state initializer. The pending value expires, so a navigation
 * that never lands (Fleet hidden for this role) cannot fire later.
 */
import { SENCHO_NAVIGATE_EVENT, type SenchoNavigateDetail } from '@/lib/events';

export type BlueprintIntent = { kind: 'open'; blueprintId: number } | { kind: 'create' };

export const BLUEPRINT_INTENT_EVENT = 'sencho:blueprint-intent';

const PENDING_INTENT_TTL_MS = 10_000;

let pending: { intent: BlueprintIntent; at: number } | null = null;

/** The intent a just-requested navigation carries; read-only so state initializers stay pure. */
export function peekBlueprintIntent(): BlueprintIntent | null {
  if (pending === null || Date.now() - pending.at > PENDING_INTENT_TTL_MS) return null;
  return pending.intent;
}

export function clearBlueprintIntent(): void {
  pending = null;
}

export function openBlueprintIntent(intent: BlueprintIntent): void {
  pending = { intent, at: Date.now() };
  window.dispatchEvent(new CustomEvent<SenchoNavigateDetail>(SENCHO_NAVIGATE_EVENT, {
    detail: { view: 'fleet', fleetTab: 'deployments' },
  }));
  window.dispatchEvent(new CustomEvent<BlueprintIntent>(BLUEPRINT_INTENT_EVENT, { detail: intent }));
}
