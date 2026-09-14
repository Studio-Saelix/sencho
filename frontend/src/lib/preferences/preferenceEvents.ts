/**
 * Preference event bus. The React-free leaf of the preference sync layer:
 * hooks, documents, and the sync bus all import this module, and it imports
 * nothing from them (module graph stays a DAG).
 *
 * Hosts five concerns:
 * 1. Write notification: user-facing setters call notifyPreferenceWrite() so
 *    the sync owner can queue a server write. Hydration-side writes deliberately
 *    do NOT notify (derived state, not user intent).
 * 2. Identity generations: a monotonic counter bumped on every auth identity
 *    transition. Async preference work captures a generation and its result
 *    applies only if the generation is unchanged.
 * 3. Eligibility readiness: a module-level store for the settled quick-link
 *    default eligibility, published by useViewNavigationState (which cannot be
 *    read from the always-mounted sync owner). Publications are bound to the
 *    ownership of the authorization snapshot that produced them so a delayed
 *    publish from a superseded producer cannot appear current.
 * 4. The unsaved-episode failure surface consumed by the toast and the reset
 *    settle logic.
 * 5. The queue-reset hook the sync bus registers at import time (identity
 *    transitions clear its queued/failed state).
 */

export type PreferenceDomain = 'appearance' | 'navigation';

/** The dirty-field names a domain document carries. Setters attribute their
 *  writes to specific fields so a late GET merges server-wins for untouched
 *  fields (a stale cached theme must never overwrite the server's theme). */
export type PreferenceField =
  | 'theme' | 'accent' | 'uiFont' | 'monoFont' | 'visualStyle' | 'headingStyle'
  | 'chartStyle' | 'density' | 'logChipColorMode' | 'borderBoost' | 'glow'
  | 'contrast' | 'typeScale' | 'reducedEffects' | 'reducedMotion' | 'readability'
  | 'mode' | 'quickLinks' | 'labels' | 'align';

export const DOMAIN_FIELDS: Record<PreferenceDomain, readonly PreferenceField[]> = {
  appearance: ['theme', 'accent', 'uiFont', 'monoFont', 'visualStyle', 'headingStyle',
    'chartStyle', 'density', 'logChipColorMode', 'borderBoost', 'glow', 'contrast',
    'typeScale', 'reducedEffects', 'reducedMotion', 'readability'],
  navigation: ['mode', 'quickLinks', 'labels', 'align'],
};

// ── write notification ─────────────────────────────────────────────────────
const writeListeners = new Set<(domain: PreferenceDomain, fields: readonly PreferenceField[]) => void>();

/** Called by user-facing setters after a local write. `fields` names the
 *  document fields the write touched, so a late GET can merge server-wins for
 *  untouched fields (a stale cached theme must never overwrite the server's
 *  theme). Omitting `fields` marks the whole domain (a complete reset). Never
 *  call from hydration/seed paths: those are derived state, not user intent. */
export function notifyPreferenceWrite(domain: PreferenceDomain, fields?: readonly PreferenceField[]): void {
  const touched = fields ?? DOMAIN_FIELDS[domain];
  for (const listener of writeListeners) listener(domain, touched);
}

export function subscribeToPreferenceWrites(
  listener: (domain: PreferenceDomain, fields: readonly PreferenceField[]) => void,
): () => void {
  writeListeners.add(listener);
  return () => {
    writeListeners.delete(listener);
  };
}

// ── identity generations ───────────────────────────────────────────────────
let generation = 0;
const generationListeners = new Set<() => void>();

/** Monotonic identity generation. Captured by async work; results apply only
 *  when currentGeneration() still equals the captured value. */
export function currentGeneration(): number {
  return generation;
}

/** Bump on every identity transition (login, logout, account switch, 401). */
export function bumpGeneration(): void {
  generation += 1;
  for (const listener of generationListeners) listener();
}

export function subscribeToGenerations(listener: () => void): () => void {
  generationListeners.add(listener);
  return () => {
    generationListeners.delete(listener);
  };
}

/** Clear every queued/failed state in the sync bus for the old identity. */
export function resetPreferenceSync(): void {
  resetQueuedOperations();
  resetUnsaved();
}

// ── eligibility readiness (ownership-captured) ─────────────────────────────
/** Ownership of an authorization snapshot: the account and identity generation
 *  under which a producer computed its value. Publications carry it so a
 *  superseded producer cannot publish into the new account. */
export interface EligibilityOwnership {
  userId: number | null;
  generation: number;
}

export interface SettledEligibility {
  ownership: EligibilityOwnership;
  eligibleIds: readonly ActiveView[] | null;
}

let settledEligibility: SettledEligibility | null = null;

function isCurrentOwnership(ownership: EligibilityOwnership): boolean {
  if (generation !== ownership.generation) return false;
  const userId = currentUserIdReader ? currentUserIdReader() : null;
  return userId === ownership.userId;
}

import type { ActiveView } from '@/lib/router/routeTypes';

/**
 * Publish settled quick-link eligibility. Rejected unless the ownership still
 * matches the current generation: a delayed publication from an old producer
 * (account switched, logout, identity bump) must never appear current.
 * Ownership is captured by the producer from its own authorization snapshot,
 * never read from current state here. `null` means eligibility did not settle
 * (permissions still loading); a settled list is `readonly ActiveView[]`.
 */
export function setEligibilitySettled(ownership: EligibilityOwnership, eligibleIds: readonly ActiveView[] | null): void {
  if (!isCurrentOwnership(ownership)) return;
  settledEligibility = { ownership, eligibleIds: eligibleIds === null ? null : [...eligibleIds] };
}

/** Clear the publication only if it still belongs to the given ownership, so
 *  an obsolete producer's teardown cannot erase a newer account's publication. */
export function clearEligibility(ownership: EligibilityOwnership): void {
  if (settledEligibility && isSameOwnership(settledEligibility.ownership, ownership)) {
    settledEligibility = null;
  }
}

/** The settled publication, visible only while its ownership is still current.
 *  A superseded account's publication stays stored (teardown scoping needs it)
 *  but reads as null, so no consumer can act on the previous account's
 *  eligibility after an identity transition. */
export function getSettledEligibility(): SettledEligibility | null {
  if (!settledEligibility || !isCurrentOwnership(settledEligibility.ownership)) return null;
  return settledEligibility;
}

function isSameOwnership(a: EligibilityOwnership, b: EligibilityOwnership): boolean {
  return a.userId === b.userId && a.generation === b.generation;
}

// ── sync bus failure surface ───────────────────────────────────────────────
export interface UnsavedEpisode {
  domain: PreferenceDomain;
  episode: number;
}

const unsavedListeners = new Set<(episode: UnsavedEpisode | null) => void>();
let unsaved: UnsavedEpisode | null = null;
let episodeCounter = 0;

/** The current unsaved episode, or null when everything is persisted. */
export function getUnsavedEpisode(): UnsavedEpisode | null {
  return unsaved;
}

export function subscribeToUnsaved(listener: (episode: UnsavedEpisode | null) => void): () => void {
  unsavedListeners.add(listener);
  return () => {
    unsavedListeners.delete(listener);
  };
}

function emitUnsaved(): void {
  for (const listener of unsavedListeners) listener(unsaved);
}

function resetUnsaved(): void {
  unsaved = null;
  emitUnsaved();
}

// Bus-internal mutators. Kept here (not exported from syncBus) so the leaf
// module stays dependency-free while the bus can still drive the shared state.
export function setUnsavedEpisode(domain: PreferenceDomain): number {
  episodeCounter += 1;
  unsaved = { domain, episode: episodeCounter };
  emitUnsaved();
  return episodeCounter;
}

export function clearUnsavedEpisode(episode: number): void {
  if (unsaved && unsaved.episode === episode) {
    unsaved = null;
    emitUnsaved();
  }
}

// ── queued-operation reset hook (set by syncBus at import time) ────────────
let resetQueuedOperations: () => void = () => {};

export function registerQueueReset(reset: () => void): void {
  resetQueuedOperations = reset;
}

/** The bus-installed reader of the currently synced account. syncBus sets it
 *  at import time so the ownership check can compare accounts without a
 *  circular import. */
let currentUserIdReader: (() => number | null) | null = null;

export function registerCurrentUserIdReader(reader: () => number | null): void {
  currentUserIdReader = reader;
}
