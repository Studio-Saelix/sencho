/**
 * Preference sync bus. The server write choke point for preference
 * documents: every migration, document write, and reset flows through here as
 * a queued, preconditioned operation with chronological intent. (The sync
 * owner's reconciliation path also issues conditional PUTs directly when it
 * merges a server document; both paths share the same preconditioned wire
 * contract and the reconcile hook closes the loop between them.)
 *
 * Guarantees:
 * - Per-domain serialization: one in-flight operation per domain at a time.
 * - Preconditions: every write carries expectedRevision; migration is
 *   create-if-absent on the server. When the client has no known revision, a
 *   GET first establishes the baseline; an absent row on a PUT falls back to
 *   migration. There is no unguarded write path.
 * - Chronology (this client's own queue only): a reset cancels queued PUTs
 *   enqueued before it; an edit enqueued after a reset is staged behind it as
 *   a conditional PUT against the reset's resulting revision. Cross-browser
 *   chronology is NEVER inferred here; reconciliation orders that by the
 *   observable server revision.
 * - Coalescing: consecutive PUTs collapse to the newest (documents are rebuilt
 *   at send time from current local state); consecutive DELETEs collapse.
 * - Identity: operations capture the userId and identity generation at enqueue
 *   time; sends and retries are refused if either has changed. Identity
 *   transitions reset the whole bus (queue, failures, known revisions).
 * - Visible failure: a failed send raises an unsaved episode (toast with
 *   Retry); retry re-runs the operation preserving its kind (a failed reset
 *   retries as DELETE, never as a PUT).
 */

import { apiFetch } from '@/lib/api';
import {
  clearUnsavedEpisode,
  currentGeneration,
  getSettledEligibility,
  registerCurrentUserIdReader,
  registerQueueReset,
  setUnsavedEpisode,
  subscribeToPreferenceWrites,
  type PreferenceDomain,
} from '@/lib/preferences/preferenceEvents';
import {
  buildAppearanceDocument,
  buildNavigationDocument,
} from '@/lib/preferences/preferencesDocuments';

// ── types ──────────────────────────────────────────────────────────────────

export type OperationKind = 'migrate' | 'put' | 'reset';

interface Envelope {
  schemaVersion: number;
  revision: number;
  updatedAt: number;
  corrupt?: boolean;
  data?: unknown;
}

interface QueuedOperation {
  domain: PreferenceDomain;
  kind: OperationKind;
  capturedUserId: number;
  generation: number;
  seq: number;
  /** Revision this operation is conditional on. Null means "GET a baseline
   *  first"; migrate carries null permanently (create-if-absent needs no
   *  precondition envelope). A resolved baseline of "the row does not exist"
   *  becomes the sentinel 'absent' (reset only: send the create-if-absent
   *  precondition instead of a revision). */
  expectedRevision: number | 'absent' | null;
  episode: number | null;
  /** Set when a 409 CONFLICT re-queued this operation once against the
   *  adopted revision; a second conflict must surface as a failure instead
   *  of looping. */
  conflictRetried?: boolean;
  /** Sent with keepalive when this operation is the pagehide flush, so the
   *  request survives document unload. Resolved when the operation is
   *  dispatched, not per module, because the baseline GET a flush triggers is
   *  itself asynchronous and a module-level flag would already be reset by
   *  the time the actual write goes out. */
  keepalive: boolean;
}

interface DomainSyncState {
  queued: QueuedOperation | null;
  /** A put staged behind a queued reset (chronology: pre-reset edits die,
   *  post-reset edits wait): the reset must run first, then the PUT. Null
   *  when no reset is queued. */
  stagedBehindReset: { op: QueuedOperation; put: QueuedOperation } | null;
  inFlight: boolean;
  knownRevision: number | null;
  failed: QueuedOperation | null;
}

// ── module state ───────────────────────────────────────────────────────────

const PREF_USER_HEADER = 'x-sencho-pref-user';

const domains: Record<PreferenceDomain, DomainSyncState> = {
  appearance: { queued: null, stagedBehindReset: null, inFlight: false, knownRevision: null, failed: null },
  navigation: { queued: null, stagedBehindReset: null, inFlight: false, knownRevision: null, failed: null },
};

let seqCounter = 0;
let currentUserId: number | null = null;
let hydratingDomains: ReadonlySet<PreferenceDomain> = new Set();

// Retry hook installed by the sync owner (useUserPreferencesSync) so the bus
// can ask for reconciliation without importing React code.
type ReconcileFn = (domain: PreferenceDomain) => void;
let reconcileHook: ReconcileFn | null = null;

export function setReconcileHook(fn: ReconcileFn | null): void {
  reconcileHook = fn;
}

/** Mark a domain as hydration-driven: writes dispatched while hydrating are
 *  derived state and must not enqueue server operations. */
export function setHydratingDomains(set: ReadonlySet<PreferenceDomain>): void {
  hydratingDomains = set;
}

export function setCurrentSyncUser(userId: number | null): void {
  currentUserId = userId;
}

// The eligibility ownership check in the events leaf compares accounts, so it
// reads the synced account from here (no circular import at the leaf).
registerCurrentUserIdReader(() => currentUserId);

// Queue reset hook for identity transitions (wired into preferenceEvents).
registerQueueReset(() => {
  for (const domain of ['appearance', 'navigation'] as const) {
    const state = domains[domain];
    state.queued = null;
    state.stagedBehindReset = null;
    state.failed = null;
    state.knownRevision = null;
  }
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
    debounceQueued = false;
  }
});

// ── enqueue ────────────────────────────────────────────────────────────────
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let debounceQueued = false;

function scheduleDebounce(): void {
  if (debounceQueued) return;
  debounceQueued = true;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    debounceQueued = false;
    for (const domain of ['appearance', 'navigation'] as const) {
      if (domains[domain].queued) void pump(domain);
    }
  }, 400);
}

/** Enqueue a user-intent write for a domain. Called by the write listener; a
 *  hydration-side write never reaches here (hydratingDomains guard). */
function enqueue(domain: PreferenceDomain, kind: OperationKind, episode: number | null = null): void {
  if (currentUserId === null) return;
  const state = domains[domain];

  if (kind === 'reset') {
    // A reset cancels any queued PUT enqueued before it, including a PUT
    // staged behind an earlier reset (pre-reset edits are discarded by the
    // user's own explicit reset). A queued reset coalesces.
    state.stagedBehindReset = null;
    state.queued = {
      domain, kind, capturedUserId: currentUserId, generation: currentGeneration(),
      seq: ++seqCounter, expectedRevision: state.knownRevision, episode, keepalive: flushPending,
    };
  } else if (state.queued && state.queued.kind === 'reset') {
    // An edit enqueued after a queued reset is staged behind it: the reset
    // keeps its queue slot (its identity is what the settle handoff checks)
    // and the PUT waits for the reset to settle, targeting its resulting
    // revision (expectedRevision null means "resolve the baseline then").
    // Re-staging coalesces: the document is rebuilt at send time, so the
    // newest values win without re-queueing.
    state.stagedBehindReset = {
      op: state.queued,
      put: state.stagedBehindReset?.put ?? {
        domain, kind: 'put', capturedUserId: currentUserId, generation: currentGeneration(),
        seq: ++seqCounter, expectedRevision: null, episode: null, keepalive: flushPending,
      },
    };
    // The reset's own pump is already running; nothing new to start.
    return;
  } else if (kind === 'put') {
    if (state.queued && state.queued.kind === 'put') {
      // Same-kind coalescing: n PUTs collapse to one, rebuilt at send time.
      const seq = state.queued.seq;
      state.queued = {
        domain, kind: 'put', capturedUserId: currentUserId, generation: currentGeneration(),
        seq, expectedRevision: state.knownRevision, episode: null, keepalive: flushPending,
      };
    } else {
      // A fresh PUT on an empty queue is enqueued as-is.
      state.queued = {
        domain, kind: 'put', capturedUserId: currentUserId, generation: currentGeneration(),
        seq: ++seqCounter, expectedRevision: state.knownRevision, episode: null, keepalive: flushPending,
      };
    }
    scheduleDebounce();
    return;
  } else if (state.queued && state.queued.kind === 'put' && kind === 'migrate') {
    // A queued PUT means the row exists client-side; migration is moot.
    return;
  } else if (kind === 'migrate') {
    // Migration is create-if-absent; a queued migrate coalesces with nothing.
    if (state.queued) return;
    state.queued = {
      domain, kind, capturedUserId: currentUserId, generation: currentGeneration(),
      seq: ++seqCounter, expectedRevision: null, episode: null, keepalive: flushPending,
    };
  }

  void pump(domain);
}

/** User-facing setters notify here (via the events leaf). */
function onPreferenceWrite(domain: PreferenceDomain): void {
  if (hydratingDomains.has(domain)) return;
  enqueue(domain, 'put');
}

subscribeToPreferenceWrites(onPreferenceWrite);

// ── transport ──────────────────────────────────────────────────────────────

interface PrefRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
}

function authedFetch(req: PrefRequest, userId: number, keepalive = false): Promise<Response> {
  return apiFetch(req.path, {
    method: req.method,
    localOnly: true,
    keepalive,
    headers: { [PREF_USER_HEADER]: String(userId) },
    body: req.body === undefined ? undefined : JSON.stringify(req.body),
  });
}

/** Server wire shape for a domain document. The navigation `status` provenance
 *  is frontend-only: the server schema is strict and rejects unknown keys.
 *  Returns null when navigation has no valid document yet (never persisted),
 *  so callers can skip the send instead of posting `{}` and tripping a 400. */
export function documentForDomain(domain: PreferenceDomain): Record<string, unknown> | null {
  if (domain === 'appearance') return { ...buildAppearanceDocument() };
  const doc = buildNavigationDocument();
  if (doc.status !== 'valid') return null;
  return { mode: doc.mode, quickLinks: doc.quickLinks, labels: doc.labels, align: doc.align };
}

async function fetchBaseline(domain: PreferenceDomain, userId: number): Promise<Envelope | null> {
  const response = await authedFetch({ method: 'GET', path: '/user-preferences' }, userId);
  if (!response.ok) return null;
  const payload = (await response.json()) as { preferences?: Record<string, unknown> };
  const row = payload.preferences?.[domain];
  // Only a real envelope establishes a baseline: an absent row (null) means
  // "no document exists" and must be distinguished from a malformed response,
  // which must never store an undefined revision.
  if (!isRowEnvelope(row)) return null;
  domains[domain].knownRevision = row.revision;
  return row;
}

// ── pump ───────────────────────────────────────────────────────────────────

async function pump(domain: PreferenceDomain): Promise<void> {
  const state = domains[domain];
  if (state.inFlight) return;
  const op = state.queued;
  if (!op) return;
  // Identity guard (defense in depth; the server re-verifies authoritatively).
  if (op.capturedUserId !== currentUserId || op.generation !== currentGeneration()) {
    state.queued = null;
    state.stagedBehindReset = null;
    return;
  }
  // Navigation migration defers until quick-link eligibility has settled so a
  // never-seeded pin list is never saved as a derived []. A valid local
  // document (the hook has a real list) does not need the deferral.
  if (op.kind === 'migrate' && domain === 'navigation') {
    const doc = buildNavigationDocument();
    if (doc.status !== 'valid') {
      const eligibility = getSettledEligibility();
      if (!eligibility || eligibility.eligibleIds === null) return;
    }
  }

  state.inFlight = true;
  try {
    await send(op);
  } finally {
    state.inFlight = false;
  }
  // The settle handoff for a staged pair: when the operation that just
  // finished is the reset of a staged pair, either drop both (failure path
  // owns the retry) or hand the queue to the staged PUT, which targets the
  // reset's resulting revision.
  const staged = state.stagedBehindReset;
  if (staged && staged.op === op) {
    if (state.failed === op) {
      state.queued = null;
      state.stagedBehindReset = null;
      return;
    }
    state.queued = staged.put;
    state.stagedBehindReset = null;
    void pump(domain);
    return;
  }
  // Next queued operation proceeds immediately.
  if (state.queued && state.queued !== op) void pump(domain);
}

async function send(op: QueuedOperation): Promise<void> {
  const userId = op.capturedUserId;

  try {
    // Navigation with no valid local document (never persisted) has nothing
    // to write: a PUT or migrate must not post a malformed document. A reset
    // (DELETE) carries no document at all, so it proceeds; skipping it would
    // strand the user's reset in the queue until the next navigation edit.
    if (op.kind !== 'reset' && documentForDomain(op.domain) === null) {
      throw new Error('document-unavailable');
    }
    // Establish the revision baseline when the operation has none. An absent
    // row (null baseline) falls back to the precondition that matches what
    // the GET actually observed: a PUT becomes a migrate (create-if-absent,
    // the row must be created), a reset sends `absent: true` (tombstoning an
    // absent row is still the user's intent). Any other shape is a failure:
    // the operation parks in `failed` and the toast owns the retry.
    if (op.expectedRevision === null && !(op.kind === 'migrate')) {
      const baseline = await fetchBaseline(op.domain, userId);
      if (baseline === null) {
        if (op.kind === 'put') {
          op.kind = 'migrate';
          op.expectedRevision = null;
        } else if (op.kind === 'reset') {
          op.expectedRevision = 'absent';
        } else {
          throw new Error('baseline-unavailable');
        }
      } else {
        op.expectedRevision = baseline.revision;
      }
    }

    let response: Response;
    if (op.kind === 'migrate') {
      response = await authedFetch(
        { method: 'POST', path: `/user-preferences/${op.domain}/migrate`, body: documentForDomain(op.domain) },
        userId,
        op.keepalive,
      );
    } else if (op.kind === 'reset') {
      response = await authedFetch(
        {
          method: 'DELETE',
          path: `/user-preferences/${op.domain}`,
          // 'absent' is the sentinel the baseline fetch resolved to when the
          // row did not exist; it maps to the server's create-if-absent
          // precondition so a reset against a missing row still tombstones.
          body: op.expectedRevision === 'absent'
            ? { absent: true }
            : { expectedRevision: op.expectedRevision },
        },
        userId,
        op.keepalive,
      );
    } else {
      response = await authedFetch(
        {
          method: 'PUT',
          path: `/user-preferences/${op.domain}`,
          body: { expectedRevision: op.expectedRevision, ...documentForDomain(op.domain) },
        },
        userId,
        op.keepalive,
      );
    }

    if (response.ok) {
      onSuccess(op, response);
      return;
    }

    if (response.status === 409) {
      await onConflict(op, response);
      return;
    }
    throw new Error(`http-${response.status}`);
  } catch (error) {
    onFailure(op, error);
  }
}

function isRowEnvelope(value: unknown): value is Envelope {
  return !!value && typeof value === 'object'
    && Number.isSafeInteger((value as Envelope).revision)
    && (value as Envelope).revision >= 1;
}

async function onConflict(op: QueuedOperation, response: Response): Promise<void> {
  const state = domains[op.domain];
  let payload: { error?: string; current?: unknown } = {};
  try {
    payload = (await response.json()) as { error?: string; current?: unknown };
  } catch {
    // Unparseable conflict body: treat as a generic failure below; the
    // machine code is what matters and it never arrived.
  }
  if (payload.error === 'CONFLICT' && isRowEnvelope(payload.current)) {
    const current = payload.current;
    state.knownRevision = current.revision;
    // A reset conflict re-runs the DELETE once against the adopted
    // revision: delegating to reconciliation here would re-hydrate the
    // pre-reset server document and visibly revert the user's reset (the
    // reset path marks nothing dirty, so nothing would re-apply it). The
    // re-queue is a fresh op object so the in-flight pump's trailing check
    // re-fires, and a staged PUT is re-staged behind it; a second conflict
    // is a failure the toast owns.
    if (op.kind === 'reset' && !op.conflictRetried) {
      state.queued = {
        domain: op.domain, kind: 'reset',
        capturedUserId: op.capturedUserId, generation: op.generation, seq: op.seq,
        expectedRevision: current.revision, episode: op.episode, keepalive: op.keepalive,
        conflictRetried: true,
      };
      if (state.stagedBehindReset && state.stagedBehindReset.op === op) {
        state.stagedBehindReset = { op: state.queued, put: state.stagedBehindReset.put };
      }
      // No explicit pump here (the current one is still in flight); its
      // trailing check re-fires because the queued object is new.
      return;
    }
    // Hand reconciliation to the sync owner: server-wins for untouched
    // fields, dirty fields re-applied, retry conditional on the new revision.
    if (reconcileHook) {
      reconcileHook(op.domain);
      state.queued = null;
      return;
    }
  }
  onFailure(op, new Error('conflict'));
}

function onSuccess(op: QueuedOperation, response: Response): void {
  const state = domains[op.domain];
  void response.clone().json().then((payload: {
    revision?: number;
    migrated?: boolean;
    row?: { revision?: number; data?: unknown; schemaVersion?: number; corrupt?: boolean };
  }) => {
    // Mutate responses carry the revision at the top level; migrate responses
    // (201/200) nest it in the row envelope. Adopt whichever is present so the
    // next conditional write targets the server's current revision.
    let revision: number | null = null;
    if (typeof payload.revision === 'number') revision = payload.revision;
    else if (typeof payload.row?.revision === 'number') revision = payload.row.revision;
    if (revision !== null) state.knownRevision = revision;
    // A lost migration race (migrated:false) means another browser's row is
    // the winner: hand it to reconciliation so local dirty edits merge on
    // top of the winner instead of being silently overwritten on next GET.
    // A tombstone winner (schemaVersion 0) also reconciles: the sync owner
    // then discards stale edits and adopts the reset's defaults.
    if (payload.migrated === false && payload.row && isRowEnvelope(payload.row) && reconcileHook) {
      reconcileHook(op.domain);
    }
  }).catch(() => {
    // Revision telemetry only; the operation itself succeeded.
  });
  if (state.queued === op) state.queued = null;
  if (state.failed === op) state.failed = null;
  if (op.episode !== null) clearUnsavedEpisode(op.episode);
}

function onFailure(op: QueuedOperation, error: unknown): void {
  const state = domains[op.domain];
  console.error(`[preferences] ${op.kind} ${op.domain} failed:`, error);
  if (state.queued === op) state.queued = null;
  state.failed = op;
  if (op.episode === null) {
    op.episode = setUnsavedEpisode(op.domain);
  } else {
    // A retry failed again: re-raise with a fresh episode number so the
    // failure surfaces again (error toasts auto-dismiss; a same-number
    // re-emit would be suppressed and the failure would go unseen).
    op.episode = setUnsavedEpisode(op.domain);
  }
}

// ── retry (operation-kind preserving) ──────────────────────────────────────

/** Re-run the failed operation for a domain by kind: PUT re-sends the latest
 *  reconciled document, DELETE re-sends the tombstone, migrate re-sends
 *  migration. Called by the toast Retry action. The failed operation stays
 *  bound to the identity that captured it: a Retry is never replayed under a
 *  different account (identity transitions reset the whole bus instead).
 *  An episode raised by the sync owner's reconciliation path (which issues
 *  conditional PUTs outside this queue) parks nothing here, so Retry asks the
 *  owner to re-reconcile from a fresh GET rather than doing nothing. */
export function retryDomain(domain: PreferenceDomain): void {
  const state = domains[domain];
  const failed = state.failed;
  if (!failed) {
    if (reconcileHook) reconcileHook(domain);
    return;
  }
  if (failed.capturedUserId !== currentUserId) return;
  if (failed.generation !== currentGeneration()) return;
  state.failed = null;
  state.queued = failed;
  void pump(domain);
}

/** Reset flow entry point: optimistic-local defaults are applied by the
 *  caller (via hydrate defaults); this queues the tombstone DELETE and
 *  cancels pre-reset PUTs. */
export function queueReset(domain: PreferenceDomain): void {
  enqueue(domain, 'reset');
}

/** Migration flow entry point (absent row). */
export function queueMigrate(domain: PreferenceDomain): void {
  enqueue(domain, 'migrate');
}

/** Adopt a revision observed by reconciliation (GET/409 current envelopes) so
 *  the next conditional write targets it. */
export function adoptKnownRevision(domain: PreferenceDomain, revision: number): void {
  domains[domain].knownRevision = revision;
}

/** Drop a pending edit for a domain without sending it: reconciliation
 * observed a remote tombstone newer than the edit's baseline, so the edit is
 * discarded and the reset adopted. A failed operation with an unsaved
 * episode is kept: the error surface owns its retry. */
export function discardQueuedEdit(domain: PreferenceDomain): void {
  const state = domains[domain];
  if (state.failed) return;
  state.queued = null;
  state.stagedBehindReset = null;
}

/** Test/observer hook: inspect a domain's queue and in-flight state without
 *  touching transport. `settling` is true while a queued or in-flight
 *  operation may still hit the server; the reset settle logic waits until it
 *  is false so a reload can never cancel an in-flight DELETE. */
export function inspectQueue(domain: PreferenceDomain): { kind: OperationKind | null; failed: OperationKind | null; settling: boolean } {
  const state = domains[domain];
  return {
    kind: state.queued?.kind ?? null,
    failed: state.failed?.kind ?? null,
    settling: state.inFlight || state.queued !== null,
  };
}

// A pagehide flush must survive document unload, so the final send goes out
// with keepalive. The flag marks the operations the flush dispatches; it is
// read when the op object is created, and an async baseline GET it triggers
// still carries the flag on the op itself (a synchronous finally could not
// cover that window).
let flushPending = false;

/** Flush helper used by the sync owner on pagehide/visibilitychange: sends any
 *  queued operation immediately with keepalive semantics. */
export function flushPendingWrites(): void {
  flushPending = true;
  try {
    for (const domain of ['appearance', 'navigation'] as const) {
      const state = domains[domain];
      if (state.queued && !state.inFlight) void pump(domain);
    }
  } finally {
    flushPending = false;
  }
}
