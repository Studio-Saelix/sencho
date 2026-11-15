/** Minimal container shape the runtime-mode predicate reads. */
export interface RuntimeModeContainer {
  State?: string;
}

/**
 * How a stack is spending its runtime, as the identity header and lifecycle
 * menus need to know it.
 *
 * - `running`: at least one container is up.
 * - `looping`: nothing is up but at least one container is in Docker's
 *   `restarting` state, which is where a crash loop spends its downtime.
 * - `stopped`: everything else, including a stack with no containers at all.
 *
 * A looping stack is not a running one: `compose up` leaves its containers
 * alone and Restart races the restart policy, so the only useful verbs are Stop
 * and Take down.
 */
export type StackRuntimeMode = 'running' | 'looping' | 'stopped';

export function getStackRuntimeMode(containers: RuntimeModeContainer[] | undefined): StackRuntimeMode {
  if (!containers || containers.length === 0) return 'stopped';
  if (containers.some(c => c.State === 'running')) return 'running';
  if (containers.some(c => c.State === 'restarting')) return 'looping';
  return 'stopped';
}

/**
 * Whether a service's lifecycle menu should offer Restart/Stop rather than
 * Start. A restarting container is already under Docker's control, so it counts
 * as active for the menu even though the card keeps its failed badge.
 */
export function isServiceStoppable(containers: RuntimeModeContainer[] | undefined): boolean {
  if (!containers || containers.length === 0) return false;
  return containers.some(c => c.State === 'running' || c.State === 'paused' || c.State === 'restarting');
}
