/**
 * Session-scoped startup and stack-hydration timing store.
 *
 * The store lives for the lifetime of the page (one boot session) and tracks
 * the latest node session on top of that. It is consumed through
 * `useSyncExternalStore` (see `useHydrationTiming`) and copied out as a
 * versioned JSON report from the developer-mode overlay.
 *
 * Design constraints:
 * - Instrumentation only. Recording an event must never throw into a caller
 *   and must never perturb the timing it measures, so emits are coalesced.
 * - Truthful ownership. A milestone committed from a React effect carries the
 *   owning attempt id; a late commit for a superseded or aborted attempt is a
 *   no-op so a stale render can never complete a session it no longer owns.
 * - Degrade safely. `performance` and the User Timing API are optional; a
 *   `Date.now()` fallback keeps durations flowing when they are absent.
 */

/** Commit-aligned lifecycle phases surfaced in the chip, panel, and report. */
export type HydrationPhase =
  | 'boot_start'
  | 'auth_resolved'
  | 'nodes_resolved'
  | 'shell_committed'
  | 'list_visible'
  | 'list_hydrated'
  | 'detail_visible'
  | 'detail_containers_ready'
  | 'detail_hydrated'
  | 'notifications_ready'
  | 'image_updates_ready';

/** Immediate post-setter debug marks, kept distinct from commit-aligned phases. */
export type StateDispatchedMark = `${string}_state_dispatched`;

/** Anything `markMilestone` accepts: a known phase or a debug dispatch mark. */
export type HydrationMark = HydrationPhase | StateDispatchedMark;

/** The subset of phases that are committed via `commitMilestone` (effect-observed). */
export type UiCommitPhase =
  | 'list_visible'
  | 'list_hydrated'
  | 'detail_visible'
  | 'detail_containers_ready'
  | 'detail_hydrated';

/** Instrumented request stages at each `apiFetch` call site. */
export type HydrationStage = 'fetch_headers' | 'body_decode' | 'state_dispatch';

export type HydrationEventKind = 'milestone' | 'span' | 'background';

export type HydrationOutcome = 'ok' | 'error' | 'aborted' | 'superseded';

export type HydrationClock = 'performance.now' | 'date.now-fallback';

export type HydrationDetail = Record<string, unknown>;

export interface HydrationEvent {
  /** Monotonic sequence id, stable for the lifetime of the event. */
  id: number;
  /** The boot or node session that owns this event. */
  sessionId: string;
  attemptId?: string;
  /** Phase name (milestone) or stage name (span). */
  phase: string;
  kind: HydrationEventKind;
  /** Clock start (milestone mark time, or span begin). */
  t0: number;
  /** Clock end for spans; absent for point milestones. */
  t1?: number;
  outcome?: HydrationOutcome;
  detail?: HydrationDetail;
  /** True when the underlying request crossed the remote-node proxy. */
  proxied?: boolean;
  /** True for milestones committed from an effect that observed committed state. */
  commit?: boolean;
  nodeId?: number | null;
}

export interface HydrationSnapshot {
  clock: HydrationClock;
  bootSessionId: string;
  bootStartAt: number | null;
  nodeSessionId: string | null;
  nodeId: number | null;
  /** Clock time when the active node session began; null before the first node resolves. */
  nodeSessionStartAt: number | null;
  /** Resolved foreground list attempt (see `resolveForegroundAttempt`); null
   *  until a list attempt commits `list_visible`. Unversioned by policy: the
   *  snapshot never leaves the process; `HydrationReport` is the versioned,
   *  serialized artifact. */
  lastAttempt: ForegroundAttempt | null;
  events: readonly HydrationEvent[];
}

export interface HydrationReportPhase {
  phase: string;
  kind: HydrationEventKind;
  outcome?: HydrationOutcome;
  /** Elapsed ms from `boot_start` to this event, or null if boot is unknown. */
  offsetMs: number | null;
  /** Span duration in ms (t1 - t0). */
  durationMs?: number;
  /** Elapsed ms from `boot_start` for commit-aligned milestones. */
  uiCommitMs?: number;
  critical: boolean;
  proxied?: boolean;
  attemptId?: string;
  detail?: HydrationDetail;
}

export interface HydrationReport {
  schemaVersion: 2;
  /** Wall-clock capture time (Date.now), only for human reference. */
  capturedAt: number;
  clock: HydrationClock;
  appVersion?: string;
  bootSessionId: string;
  nodeSessionId: string | null;
  nodeId: number | null;
  /** Raw boot-relative elapsed ms from `boot_start` to the most recent
   *  `list_visible`, kept for diagnostic back-compat. The truthful foreground
   *  duration is `lastAttemptListVisibleMs` (attempt-relative). */
  listVisibleMs: number | null;
  /** Page age at capture: `boot_start` to now. */
  bootAgeMs: number | null;
  /** `boot_start` to `auth_resolved`. */
  bootAuthResolvedMs: number | null;
  /** `boot_start` to `nodes_resolved`. */
  bootNodesResolvedMs: number | null;
  /** `boot_start` to `shell_committed`. */
  bootShellCommittedMs: number | null;
  /** Elapsed ms since the active node session began (node-session age). */
  sessionAgeMs: number | null;
  /** `node-session start` to the session's most recent committed `list_visible`. */
  sessionListVisibleMs: number | null;
  /** `node-session start` to the session's most recent committed `list_hydrated`. */
  sessionListHydratedMs: number | null;
  /** Foreground list attempt: the newest committed `list_visible` attempt in
   *  the active node session that is still live (not aborted or superseded). */
  lastAttemptId: string | null;
  /** `attempt start` to its committed `list_visible`. */
  lastAttemptListVisibleMs: number | null;
  /** `attempt start` to its committed `list_hydrated`; null until the foreground attempt hydrates. */
  lastAttemptListHydratedMs: number | null;
  /** `list_visible` to `list_hydrated` for the same foreground attempt. */
  lastAttemptHydrationGapMs: number | null;
  /** Proxy flag from the foreground attempt's own `list_visible` event. */
  lastAttemptProxied: boolean | null;
  /** Node id from the foreground attempt's own `list_visible` event. */
  lastAttemptNodeId: number | null;
  anyProxied: boolean;
  phases: HydrationReportPhase[];
}

export interface MilestoneOptions {
  attemptId?: string;
  outcome?: HydrationOutcome;
  oneShot?: boolean;
  detail?: HydrationDetail;
  proxied?: boolean;
}

export interface CommitOptions {
  outcome?: HydrationOutcome;
  detail?: HydrationDetail;
  proxied?: boolean;
  /** Lets an empty->empty commit still fire once per attempt when committed
   *  state may be referentially equal to the previous render. */
  completionToken?: string;
}

/** Armed by a fetch, flushed from a React effect once committed state is observed. */
export interface PendingCommit {
  attemptId: string;
  token: string;
  proxied: boolean;
}

export interface SpanOptions {
  attemptId?: string;
  detail?: HydrationDetail;
  proxied?: boolean;
  /** Marks the span as belonging to a background refresh rather than the
   *  critical hydration path. */
  background?: boolean;
}

export interface EndSpanOptions {
  outcome?: HydrationOutcome;
  detail?: HydrationDetail;
  proxied?: boolean;
}

/** Opaque handle returned by `beginSpan` and passed back to `endSpan`. */
export type SpanHandle = number;

const MAX_EVENTS = 200;
const MAX_ATTEMPTS = 200;
/** Coalesce emits to at most 4 Hz so the store never perturbs the timings. */
const MIN_EMIT_INTERVAL_MS = 250;
const USER_TIMING_PREFIX = 'sn-hyd';

/** Phases recorded exactly once per boot session (deduped under StrictMode). */
const ONE_SHOT_PHASES: ReadonlySet<string> = new Set([
  'boot_start',
  'auth_resolved',
  'nodes_resolved',
  'shell_committed',
]);

/** Phases that hydrate off the critical path (reported as non-critical). */
const BACKGROUND_PHASES: ReadonlySet<string> = new Set([
  'notifications_ready',
  'image_updates_ready',
]);

const appVersion: string | undefined =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : undefined;

const clockKind: HydrationClock =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? 'performance.now'
    : 'date.now-fallback';

function now(): number {
  return clockKind === 'performance.now' ? performance.now() : Date.now();
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface AttemptRecord {
  sessionId: string;
  /** Clock time when the attempt was created (`newAttemptId`). */
  createdAt: number;
  aborted: boolean;
  superseded: boolean;
}

interface OpenSpan {
  stage: HydrationStage;
  sessionId: string;
  attemptId?: string;
  t0: number;
  kind: HydrationEventKind;
  detail?: HydrationDetail;
  proxied?: boolean;
}

let seq = 0;
function nextId(): number {
  return ++seq;
}
function newSessionId(prefix: string): string {
  return `${prefix}-${nextId()}`;
}

const bootSessionId = newSessionId('boot');
let bootStartAt: number | null = null;
let nodeSessionId: string | null = null;
let nodeSessionStartAt: number | null = null;
let currentNodeId: number | null = null;

let events: HydrationEvent[] = [];
const attempts = new Map<string, AttemptRecord>();
const openSpans = new Map<SpanHandle, OpenSpan>();
/** Boot one-shot dedupe keys (`phase::bootSessionId`). */
const oneShotKeys = new Set<string>();
/** Commit dedupe keys (`phase::attemptId::completionToken`). */
const committedKeys = new Set<string>();

// User Timing helpers. Every entry point tolerates a missing API surface so a
// browser or test environment without `performance`, `mark`, or `measure`
// records durations off the clock fallback without throwing.
function hasPerformance(): boolean {
  return typeof performance !== 'undefined';
}

const userTiming = {
  mark(name: string): void {
    if (!hasPerformance() || typeof performance.mark !== 'function') return;
    try {
      performance.mark(name);
    } catch {
      // User Timing is best-effort diagnostics; never surface a failure.
    }
  },
  measure(name: string, startMark: string, endMark: string): void {
    if (!hasPerformance() || typeof performance.measure !== 'function') return;
    try {
      performance.measure(name, startMark, endMark);
    } catch {
      // A missing start/end mark must not break timing capture.
    }
  },
  clear(name: string): void {
    if (!hasPerformance()) return;
    try {
      performance.clearMarks?.(name);
      performance.clearMarks?.(`${name}:start`);
      performance.clearMarks?.(`${name}:end`);
      performance.clearMeasures?.(name);
    } catch {
      // Clearing stale entries is best-effort.
    }
  },
};

function markName(sessionId: string, attemptId: string | undefined, phase: string): string {
  return `${USER_TIMING_PREFIX}:${sessionId}:${attemptId ?? '-'}:${phase}`;
}

function milestoneKind(phase: string): HydrationEventKind {
  return BACKGROUND_PHASES.has(phase) ? 'background' : 'milestone';
}

/** Boot-scoped one-shots belong to the boot session; everything else to the
 *  active node session (falling back to boot before the first node resolves). */
function phaseSessionId(phase: string): string {
  return ONE_SHOT_PHASES.has(phase) ? bootSessionId : nodeSessionId ?? bootSessionId;
}

function sessionNodeId(sessionId: string): number | null {
  return sessionId === bootSessionId ? null : currentNodeId;
}

function currentSessionId(): string {
  return nodeSessionId ?? bootSessionId;
}

function mergeDetail(a?: HydrationDetail, b?: HydrationDetail): HydrationDetail | undefined {
  if (!a && !b) return undefined;
  return { ...a, ...b };
}

// ---------------------------------------------------------------------------
// Snapshot + emit scheduling (useSyncExternalStore contract)
// ---------------------------------------------------------------------------

let snapshot: HydrationSnapshot;
const listeners = new Set<() => void>();
let flushScheduled = false;
let lastEmitAt = 0;

function rebuildSnapshot(): void {
  const foreground = resolveForegroundAttempt(events, nodeSessionId, attempts);
  snapshot = {
    clock: clockKind,
    bootSessionId,
    bootStartAt,
    nodeSessionId,
    nodeId: currentNodeId,
    nodeSessionStartAt,
    lastAttempt: foreground,
    events: events.slice(),
  };
}

function doEmit(): void {
  flushScheduled = false;
  lastEmitAt = now();
  rebuildSnapshot();
  for (const listener of listeners) listener();
}

function scheduleEmit(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  const run = (): void => {
    const elapsed = now() - lastEmitAt;
    if (elapsed >= MIN_EMIT_INTERVAL_MS) {
      doEmit();
    } else {
      setTimeout(doEmit, MIN_EMIT_INTERVAL_MS - elapsed);
    }
  };
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(run);
  } else {
    setTimeout(run, 16);
  }
}

function pushEvent(event: HydrationEvent): void {
  events.push(event);
  if (events.length > MAX_EVENTS) {
    events.splice(0, events.length - MAX_EVENTS);
  }
  scheduleEmit();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot(): HydrationSnapshot {
  return snapshot;
}

/** Start a fresh node session, superseding the prior one and its attempts. */
export function beginNodeSession(nodeId: number): string {
  if (nodeSessionId) {
    const prior = nodeSessionId;
    for (const attempt of attempts.values()) {
      if (attempt.sessionId === prior && !attempt.aborted) attempt.superseded = true;
    }
    for (const [handle, span] of openSpans) {
      if (span.sessionId === prior) openSpans.delete(handle);
    }
    // Retain only boot markers plus the incoming node session's events.
    events = events.filter((e) => e.sessionId === bootSessionId);
    committedKeys.clear();
  }
  nodeSessionId = newSessionId('node');
  nodeSessionStartAt = now();
  currentNodeId = nodeId;
  scheduleEmit();
  return nodeSessionId;
}

export function newAttemptId(): string {
  const id = newSessionId('attempt');
  attempts.set(id, {
    sessionId: currentSessionId(),
    createdAt: now(),
    aborted: false,
    superseded: false,
  });
  if (attempts.size > MAX_ATTEMPTS) {
    const oldest = attempts.keys().next().value;
    if (oldest !== undefined) attempts.delete(oldest);
  }
  return id;
}

/** Mark an attempt aborted; its in-flight spans finalize as aborted and later
 *  commit milestones for it become no-ops. */
export function abortAttempt(attemptId: string): void {
  const attempt = attempts.get(attemptId);
  if (!attempt) return;
  attempt.aborted = true;
  for (const [handle, span] of openSpans) {
    if (span.attemptId !== attemptId) continue;
    openSpans.delete(handle);
    pushEvent({
      id: handle,
      sessionId: span.sessionId,
      attemptId,
      phase: span.stage,
      kind: span.kind,
      t0: span.t0,
      t1: now(),
      outcome: 'aborted',
      detail: span.detail,
      proxied: span.proxied,
      nodeId: sessionNodeId(span.sessionId),
    });
  }
  // Rebuild the snapshot even when no span was open, so the aborted attempt
  // cannot linger as the resolved foreground attempt until unrelated activity.
  scheduleEmit();
}

export function markMilestone(phase: HydrationMark, opts: MilestoneOptions = {}): void {
  const oneShot = opts.oneShot ?? ONE_SHOT_PHASES.has(phase);
  if (oneShot) {
    const key = `${phase}::${bootSessionId}`;
    if (oneShotKeys.has(key)) return;
    oneShotKeys.add(key);
  }
  const sessionId = phaseSessionId(phase);
  const t = now();
  pushEvent({
    id: nextId(),
    sessionId,
    attemptId: opts.attemptId,
    phase,
    kind: milestoneKind(phase),
    t0: t,
    outcome: opts.outcome ?? 'ok',
    detail: opts.detail,
    proxied: opts.proxied,
    nodeId: sessionNodeId(sessionId),
  });
  userTiming.mark(markName(sessionId, opts.attemptId, phase));
}

/** Record a commit-aligned UI milestone. No-op unless the attempt is still the
 *  current, non-superseded, non-aborted attempt for the active node session. */
export function commitMilestone(
  phase: UiCommitPhase,
  attemptId: string,
  opts: CommitOptions = {},
): void {
  const attempt = attempts.get(attemptId);
  if (!attempt) return;
  if (attempt.aborted || attempt.superseded) return;
  if (attempt.sessionId !== nodeSessionId) return;

  const key = `${phase}::${attemptId}::${opts.completionToken ?? ''}`;
  if (committedKeys.has(key)) return;
  committedKeys.add(key);

  const t = now();
  const detail = opts.completionToken
    ? { ...(opts.detail ?? {}), completionToken: opts.completionToken }
    : opts.detail;
  pushEvent({
    id: nextId(),
    sessionId: attempt.sessionId,
    attemptId,
    phase,
    kind: milestoneKind(phase),
    t0: t,
    outcome: opts.outcome ?? 'ok',
    detail,
    proxied: opts.proxied,
    commit: true,
    nodeId: currentNodeId,
  });
  userTiming.mark(markName(attempt.sessionId, attemptId, phase));
}

/** Commit and clear a pending UI milestone ref. No-op when the ref is empty;
 *  callers still own the readiness guards (selected file, load status, etc.). */
export function flushPendingCommit(
  pendingRef: { current: PendingCommit | null },
  phase: UiCommitPhase,
): void {
  const pending = pendingRef.current;
  if (!pending) return;
  commitMilestone(phase, pending.attemptId, {
    completionToken: pending.token,
    proxied: pending.proxied,
  });
  pendingRef.current = null;
}

export function beginSpan(stage: HydrationStage, opts: SpanOptions = {}): SpanHandle {
  const handle = nextId();
  const sessionId = currentSessionId();
  openSpans.set(handle, {
    stage,
    sessionId,
    attemptId: opts.attemptId,
    t0: now(),
    kind: opts.background ? 'background' : 'span',
    detail: opts.detail,
    proxied: opts.proxied,
  });
  const name = markName(sessionId, opts.attemptId, stage);
  userTiming.clear(name);
  userTiming.mark(`${name}:start`);
  return handle;
}

export function endSpan(handle: SpanHandle, opts: EndSpanOptions = {}): void {
  const span = openSpans.get(handle);
  if (!span) return;
  openSpans.delete(handle);

  const t1 = now();
  const outcome = resolveSpanOutcome(span.attemptId, opts.outcome);
  const name = markName(span.sessionId, span.attemptId, span.stage);
  userTiming.mark(`${name}:end`);
  userTiming.measure(name, `${name}:start`, `${name}:end`);

  pushEvent({
    id: handle,
    sessionId: span.sessionId,
    attemptId: span.attemptId,
    phase: span.stage,
    kind: span.kind,
    t0: span.t0,
    t1,
    outcome,
    detail: mergeDetail(span.detail, opts.detail),
    proxied: opts.proxied ?? span.proxied,
    nodeId: sessionNodeId(span.sessionId),
  });
}

function resolveSpanOutcome(
  attemptId: string | undefined,
  requested: HydrationOutcome | undefined,
): HydrationOutcome {
  if (attemptId) {
    const attempt = attempts.get(attemptId);
    if (attempt?.aborted) return 'aborted';
    if (attempt?.superseded) return 'superseded';
  }
  return requested ?? 'ok';
}

/** True when a phase is on the critical hydration path (not a background fill). */
export function classifyCritical(phase: string): boolean {
  return !BACKGROUND_PHASES.has(phase);
}

/** Newest event in `eventList` matching `predicate`, or null. */
function findLatestEvent(
  eventList: readonly HydrationEvent[],
  predicate: (e: HydrationEvent) => boolean,
): HydrationEvent | null {
  for (let i = eventList.length - 1; i >= 0; i--) {
    if (predicate(eventList[i])) return eventList[i];
  }
  return null;
}

/** Raw boot-relative elapsed ms from `boot_start` to the most recent
 *  `list_visible`, with no session or attempt filtering. Retained as the
 *  compatibility surface; consumers needing a truthful foreground hydration
 *  duration should use `getAttemptListVisibleMsFrom` (attempt-relative) or
 *  `getSessionListVisibleMsFrom` (session-relative). */
export function listVisibleMsFrom(
  eventList: readonly HydrationEvent[],
  bootAt: number | null,
): number | null {
  if (bootAt == null) return null;
  const event = findLatestEvent(eventList, (e) => e.phase === 'list_visible');
  return event == null ? null : round(event.t0 - bootAt);
}

/** Boot-relative compatibility getter: elapsed ms from `boot_start` to the
 *  most recent `list_visible` across all sessions, or null. */
export function getListVisibleMs(): number | null {
  return listVisibleMsFrom(events, bootStartAt);
}

// ---------------------------------------------------------------------------
// Session-correct derivations. The `*From` functions below are pure scans
// over the event list and explicit anchors, so React consumers can derive
// from the snapshot they last read (see `useHydrationTiming`). The no-arg
// getters wrap them with live module state for the report capture, a
// point-in-time read rather than a reactive derivation.
// ---------------------------------------------------------------------------

export interface ForegroundAttempt {
  attemptId: string;
  createdAt: number;
  /** Proxy flag from the foreground `list_visible` event itself. */
  proxied: boolean | null;
  /** Node id from the foreground `list_visible` event itself. */
  nodeId: number | null;
}

/** The foreground list attempt: the newest committed `list_visible` event in
 *  the active node session whose attempt record is still live (exists, not
 *  aborted, not superseded, same session). Selection is anchored on committed
 *  events, so a later stack-detail attempt can never steal the headline; the
 *  attempt map only filters for liveness and supplies `createdAt`. */
export function resolveForegroundAttempt(
  eventList: readonly HydrationEvent[],
  sessionId: string | null,
  attemptRecords: ReadonlyMap<string, AttemptRecord>,
): ForegroundAttempt | null {
  if (sessionId == null) return null;
  for (let i = eventList.length - 1; i >= 0; i--) {
    const event = eventList[i];
    if (event.phase !== 'list_visible' || event.commit !== true) continue;
    if (event.sessionId !== sessionId) continue;
    const attemptId = event.attemptId;
    if (!attemptId) continue;
    const record = attemptRecords.get(attemptId);
    if (!record || record.aborted || record.superseded) continue;
    if (record.sessionId !== sessionId) continue;
    return {
      attemptId,
      createdAt: record.createdAt,
      proxied: event.proxied ?? null,
      nodeId: event.nodeId ?? null,
    };
  }
  return null;
}

/** Elapsed ms from `boot_start` to the most recent `phase` event belonging to
 *  the boot session, or null when the phase has not fired (or was evicted). */
export function getBootMilestoneMsFrom(
  eventList: readonly HydrationEvent[],
  sessionId: string,
  phase: string,
  bootAt: number | null,
): number | null {
  if (bootAt == null) return null;
  const event = findLatestEvent(
    eventList,
    (e) => e.phase === phase && e.sessionId === sessionId,
  );
  return event == null ? null : round(event.t0 - bootAt);
}

/** Elapsed ms from the active node-session start to its most recent committed
 *  `list_visible`, or null before one exists. */
export function getSessionListVisibleMsFrom(
  eventList: readonly HydrationEvent[],
  sessionId: string | null,
  sessionStartAt: number | null,
): number | null {
  if (sessionStartAt == null) return null;
  const event = findLatestEvent(
    eventList,
    (e) => e.phase === 'list_visible' && e.commit === true && e.sessionId === sessionId,
  );
  return event == null ? null : round(event.t0 - sessionStartAt);
}

/** Elapsed ms from the active node-session start to its most recent committed
 *  `list_hydrated`, or null before one exists. */
export function getSessionListHydratedMsFrom(
  eventList: readonly HydrationEvent[],
  sessionId: string | null,
  sessionStartAt: number | null,
): number | null {
  if (sessionStartAt == null) return null;
  const event = findLatestEvent(
    eventList,
    (e) => e.phase === 'list_hydrated' && e.commit === true && e.sessionId === sessionId,
  );
  return event == null ? null : round(event.t0 - sessionStartAt);
}

/** Elapsed ms from the attempt's creation to its committed `list_visible`, or
 *  null. Only commit-aligned events count, matching `resolveForegroundAttempt`
 *  and the session getters; an uncommitted error mark never reads as success. */
export function getAttemptListVisibleMsFrom(
  eventList: readonly HydrationEvent[],
  attemptId: string,
  attemptCreatedAt: number,
): number | null {
  const event = findLatestEvent(
    eventList,
    (e) => e.phase === 'list_visible' && e.attemptId === attemptId && e.commit === true,
  );
  return event == null ? null : round(event.t0 - attemptCreatedAt);
}

/** Elapsed ms from the attempt's creation to its committed `list_hydrated`, or
 *  null until the attempt actually hydrates. Only commit-aligned events count,
 *  so a failed hydration marked via `markMilestone` never reads as completed.
 *  Never borrowed from another attempt. */
export function getAttemptListHydratedMsFrom(
  eventList: readonly HydrationEvent[],
  attemptId: string,
  attemptCreatedAt: number,
): number | null {
  const event = findLatestEvent(
    eventList,
    (e) => e.phase === 'list_hydrated' && e.attemptId === attemptId && e.commit === true,
  );
  return event == null ? null : round(event.t0 - attemptCreatedAt);
}

/** Elapsed ms from committed `list_visible` to committed `list_hydrated` for
 *  the same attempt, or null when either phase has not committed for it (or
 *  when hydration committed before visibility, which is not a valid gap).
 *  Defined only when visible precedes hydrated. */
export function getAttemptHydrationGapMsFrom(
  eventList: readonly HydrationEvent[],
  attemptId: string,
): number | null {
  const visible = findLatestEvent(
    eventList,
    (e) => e.attemptId === attemptId && e.commit === true && e.phase === 'list_visible',
  );
  const hydrated = findLatestEvent(
    eventList,
    (e) => e.attemptId === attemptId && e.commit === true && e.phase === 'list_hydrated',
  );
  if (visible == null || hydrated == null || hydrated.t0 < visible.t0) return null;
  return round(hydrated.t0 - visible.t0);
}

/** Page age at call time: elapsed ms from `boot_start` to now, or null. */
function getBootAgeMs(): number | null {
  return bootStartAt == null ? null : round(now() - bootStartAt);
}

/** Active node-session age at call time: elapsed ms from `beginNodeSession`
 *  to now, or null before the first node resolves. */
function getSessionAgeMs(): number | null {
  return nodeSessionStartAt == null ? null : round(now() - nodeSessionStartAt);
}

/** Session-relative `list_visible` for the active node session, or null. */
function getSessionListVisibleMs(): number | null {
  return getSessionListVisibleMsFrom(events, nodeSessionId, nodeSessionStartAt);
}

/** Session-relative `list_hydrated` for the active node session, or null. */
function getSessionListHydratedMs(): number | null {
  return getSessionListHydratedMsFrom(events, nodeSessionId, nodeSessionStartAt);
}

function toReportPhase(event: HydrationEvent): HydrationReportPhase {
  const offsetMs = bootStartAt == null ? null : round(event.t0 - bootStartAt);
  const durationMs = event.t1 != null ? round(event.t1 - event.t0) : undefined;
  const uiCommitMs = event.commit && offsetMs != null ? offsetMs : undefined;
  return {
    phase: event.phase,
    kind: event.kind,
    outcome: event.outcome,
    offsetMs,
    durationMs,
    uiCommitMs,
    // Background fills already use kind 'background' (see milestoneKind / beginSpan).
    critical: event.kind !== 'background',
    proxied: event.proxied,
    attemptId: event.attemptId,
    detail: event.detail,
  };
}

function bootMilestoneMs(phase: string): number | null {
  return getBootMilestoneMsFrom(events, bootSessionId, phase, bootStartAt);
}

export function getHydrationReport(): HydrationReport {
  const foreground = resolveForegroundAttempt(events, nodeSessionId, attempts);
  return {
    schemaVersion: 2,
    capturedAt: Date.now(),
    clock: clockKind,
    ...(appVersion ? { appVersion } : {}),
    bootSessionId,
    nodeSessionId,
    nodeId: currentNodeId,
    listVisibleMs: getListVisibleMs(),
    bootAgeMs: getBootAgeMs(),
    bootAuthResolvedMs: bootMilestoneMs('auth_resolved'),
    bootNodesResolvedMs: bootMilestoneMs('nodes_resolved'),
    bootShellCommittedMs: bootMilestoneMs('shell_committed'),
    sessionAgeMs: getSessionAgeMs(),
    sessionListVisibleMs: getSessionListVisibleMs(),
    sessionListHydratedMs: getSessionListHydratedMs(),
    lastAttemptId: foreground?.attemptId ?? null,
    lastAttemptListVisibleMs:
      foreground != null
        ? getAttemptListVisibleMsFrom(events, foreground.attemptId, foreground.createdAt)
        : null,
    lastAttemptListHydratedMs:
      foreground != null
        ? getAttemptListHydratedMsFrom(events, foreground.attemptId, foreground.createdAt)
        : null,
    lastAttemptHydrationGapMs:
      foreground != null ? getAttemptHydrationGapMsFrom(events, foreground.attemptId) : null,
    lastAttemptProxied: foreground?.proxied ?? null,
    lastAttemptNodeId: foreground?.nodeId ?? null,
    anyProxied: events.some((e) => e.proxied === true),
    phases: events.map(toReportPhase),
  };
}

/** Clear the current node session's events (and commit dedupe), keeping boot
 *  markers so the boot timeline survives a manual clear. */
export function clearReport(): void {
  events = events.filter((e) => e.sessionId === bootSessionId);
  committedKeys.clear();
  for (const [handle, span] of openSpans) {
    if (span.sessionId !== bootSessionId) openSpans.delete(handle);
  }
  scheduleEmit();
}

// ---------------------------------------------------------------------------
// Boot session init: record boot_start once and seed the initial snapshot
// synchronously so the first `getSnapshot()` read already carries it.
// ---------------------------------------------------------------------------
bootStartAt = now();
oneShotKeys.add(`boot_start::${bootSessionId}`);
events.push({
  id: nextId(),
  sessionId: bootSessionId,
  phase: 'boot_start',
  kind: 'milestone',
  t0: bootStartAt,
  outcome: 'ok',
  nodeId: null,
});
userTiming.mark(markName(bootSessionId, undefined, 'boot_start'));
rebuildSnapshot();
