/**
 * Drill-down navigation for the GitOps portfolio rows.
 *
 * A row opens its application view inside the workplace: the full canonical
 * state for one application, read-only. Operator action still happens on the
 * owning surface, so the application view hands off from there: Direct
 * applications to their stack's Git source panel, Blueprint applications to
 * the Blueprint deployments surface that owns rollout decisions.
 *
 * The open application lives in the `application` query parameter of the
 * GitOps path, a parameter the view owns (see VIEW_OWNED_QUERY in useUrlSync),
 * so an application view is a shareable link and Back returns to the list.
 */
import { openBlueprintIntent } from '@/lib/blueprintIntent';
import {
  SENCHO_NAVIGATE_EVENT,
  SENCHO_OPEN_STACK_EVENT,
  type SenchoNavigateDetail,
  type SenchoOpenStackDetail,
} from '@/lib/events';
import type { GitOpsAttentionReason, GitOpsPortfolioRow } from '@/types/gitopsPortfolio';

export const APPLICATION_QUERY_PARAM = 'application';

/** Fired after the open application changes without a popstate (open, or a close that replaced history). */
export const GITOPS_APPLICATION_EVENT = 'sencho:gitops-application';

/** Marks a history entry this module pushed, so closing can pop it instead of stacking another. */
const PUSHED_MARKER = 'senchoGitOpsApplication';

/** A generous cap well above any real portfolio id (`bp:<n>`, `<node>:<uuid>`, `<node>:legacy:<stack>`); longer values are rejected as malformed. */
const MAX_APPLICATION_ID_LEN = 512;

/** The application id encoded in a search string, or null when none (or a malformed one) is present. */
export function applicationIdFromSearch(search: string): string | null {
  const id = new URLSearchParams(search).get(APPLICATION_QUERY_PARAM);
  if (!id || id.length > MAX_APPLICATION_ID_LEN) return null;
  return id;
}

function notifyApplicationChanged(): void {
  window.dispatchEvent(new Event(GITOPS_APPLICATION_EVENT));
}

function historyStateObject(): Record<string, unknown> {
  const state: unknown = window.history.state;
  return state && typeof state === 'object' ? { ...(state as Record<string, unknown>) } : {};
}

/**
 * Open one application's view. Pushes a history entry on the current path
 * that copies the router's `senchoIdx`, so the router sees Back and Forward
 * across this entry as a delta of 0 and does not treat it as a route change.
 */
export function openGitOpsApplication(id: string): void {
  const params = new URLSearchParams();
  params.set(APPLICATION_QUERY_PARAM, id);
  window.history.pushState(
    { ...historyStateObject(), [PUSHED_MARKER]: true },
    '',
    `${window.location.pathname}?${params.toString()}`,
  );
  notifyApplicationChanged();
}

/**
 * Return from an application view to the portfolio list. When the view was
 * opened from the list, this pops that entry so the list's own URL (and its
 * filters) come back; a view reached by a direct link has no list entry
 * behind it, so the parameter is dropped in place instead.
 */
export function closeGitOpsApplication(): void {
  if (historyStateObject()[PUSHED_MARKER] === true) {
    window.history.back();
    return;
  }
  const params = new URLSearchParams(window.location.search);
  params.delete(APPLICATION_QUERY_PARAM);
  const qs = params.toString();
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
  notifyApplicationChanged();
}

/**
 * Return to the portfolio list if an application view is open; otherwise do
 * nothing. For entry points that mean "take me to GitOps" (the nav item, the
 * contextual indicators), which change nothing when GitOps is already active.
 */
export function closeGitOpsApplicationIfOpen(): void {
  if (applicationIdFromSearch(window.location.search) !== null) closeGitOpsApplication();
}

/**
 * Open a Direct application's owning stack on its node, landing on the Git
 * panel. The shell consumes the event; a missing node or stack leaves the
 * operator wherever they were (the caller survives navigation failure).
 */
function openDirectStack(row: GitOpsPortfolioRow, destination: 'stack' | 'git'): void {
  if (row.nodeId === null || row.stackName === null) return;
  window.dispatchEvent(new CustomEvent<SenchoOpenStackDetail>(SENCHO_OPEN_STACK_EVENT, {
    detail: { nodeId: row.nodeId, stackName: row.stackName, destination },
  }));
}

/** Open the Blueprint-backed application's own Blueprint detail on the Fleet view. */
function openBlueprint(row: GitOpsPortfolioRow): void {
  if (row.blueprintId === null) return;
  openBlueprintIntent({ kind: 'open', blueprintId: row.blueprintId });
}

export interface OwningSurfaceHandoff {
  label: string;
  open: () => void;
}

/**
 * The owning surface for an application, by target mode, or null when the
 * row carries no identity that surface could open, or the caller cannot
 * reach it (a Blueprint lives in Fleet, which needs the fleet read grant and
 * has no Blueprints tab on a phone).
 */
export function owningSurfaceHandoff(row: GitOpsPortfolioRow, opts: { canOpenBlueprint: boolean }): OwningSurfaceHandoff | null {
  switch (row.targetMode) {
    case 'direct':
      if (row.nodeId === null || row.stackName === null) return null;
      return { label: 'Open Git source', open: () => openDirectStack(row, 'git') };
    case 'blueprint':
    case 'inline_blueprint':
      if (row.blueprintId === null || !opts.canOpenBlueprint) return null;
      return { label: 'Open Blueprint', open: () => openBlueprint(row) };
    default: {
      const unhandled: never = row.targetMode;
      return unhandled;
    }
  }
}

/** Carries a stack scope to a workplace that is already mounted. */
export const GITOPS_PORTFOLIO_SCOPE_EVENT = 'sencho:gitops-portfolio-scope';

/**
 * A question another surface can open the workplace on: one Direct
 * application (a stack's Git indicator), one Blueprint application (its detail
 * sheet), or the applications needing attention on one node (a Fleet card).
 */
export type GitOpsPortfolioScope =
  | { nodeId: number; stack: string }
  | { blueprintId: number }
  | { nodeId: number; attention: true };

/**
 * How long a requested scope waits for the workplace to mount. The view is
 * lazy-loaded, so the mount can trail the click by a chunk fetch; a navigation
 * that never lands (GitOps is hub-only, so a remote node cannot show it) must
 * not leave the scope behind to narrow a later, unrelated visit.
 */
const PENDING_SCOPE_TTL_MS = 10_000;

let pendingScope: { scope: GitOpsPortfolioScope; at: number } | null = null;

/**
 * The scope a just-requested navigation carries, for a workplace mounting
 * because of it. Read-only so a double-invoked state initializer stays pure;
 * the mounted hook clears it with `clearPendingPortfolioScope`.
 */
export function peekPendingPortfolioScope(): GitOpsPortfolioScope | null {
  if (pendingScope === null || Date.now() - pendingScope.at > PENDING_SCOPE_TTL_MS) return null;
  return pendingScope.scope;
}

export function clearPendingPortfolioScope(): void {
  pendingScope = null;
}

/**
 * Where every contextual GitOps indicator (dashboard badge, sidebar pending
 * icon) leads. With a scope, the workplace opens filtered to that one stack on
 * that node; without one, it opens on whatever question it last held.
 *
 * The scope travels two ways because the workplace may or may not be mounted:
 * a mounted hook hears the event, a mounting one reads the pending value.
 */
export function openGitOpsWorkplace(scope?: GitOpsPortfolioScope): void {
  pendingScope = scope ? { scope, at: Date.now() } : null;
  window.dispatchEvent(new CustomEvent<SenchoNavigateDetail>(SENCHO_NAVIGATE_EVENT, {
    detail: { view: 'gitops' },
  }));
  if (scope) {
    window.dispatchEvent(new CustomEvent<GitOpsPortfolioScope>(GITOPS_PORTFOLIO_SCOPE_EVENT, { detail: scope }));
  }
}

export interface PortfolioRowAction {
  label: string;
  run: () => void;
}

/**
 * Every place a row can take the operator, for its action menu. All are
 * navigations: decisions (accept, approve, authorize) stay in the application
 * view, where the authority actions own their permission and confirmation.
 */
export function portfolioRowActions(row: GitOpsPortfolioRow, opts: { canOpenFleet: boolean }): PortfolioRowAction[] {
  const actions: PortfolioRowAction[] = [{ label: 'Open application', run: () => openPortfolioApplication(row) }];
  if (row.targetMode === 'direct' && row.nodeId !== null && row.stackName !== null) {
    actions.push({ label: 'Open stack', run: () => openDirectStack(row, 'stack') });
    actions.push({ label: 'Open Git source', run: () => openDirectStack(row, 'git') });
  }
  if (row.targetMode !== 'direct' && row.blueprintId !== null && opts.canOpenFleet) {
    actions.push({ label: 'Open Blueprint', run: () => openBlueprint(row) });
  }
  return actions;
}

/** Reasons that wait on an operator decision the application view's authority actions record. */
const DECISION_REASONS: ReadonlySet<GitOpsAttentionReason> = new Set<GitOpsAttentionReason>([
  'source_review_pending',
  'source_conflict_blocker',
  'source_reconcile_required',
  'placement_review_pending',
  'stateful_confirmation_required',
  'rollout_authorization_pending',
  'rollout_authorization_stale',
  'rollout_paused',
  'recovery_required',
]);

/** Failures best investigated on the stack itself (containers, logs, health). */
const RUNTIME_FAILURE_REASONS: ReadonlySet<GitOpsAttentionReason> = new Set<GitOpsAttentionReason>([
  'deploy_failed',
  'health_failed',
  'recovery_failed',
  'rollback_failed',
]);

/** Failures of the Git source itself (fetch, auth, suspension). */
const SOURCE_FAILURE_REASONS: ReadonlySet<GitOpsAttentionReason> = new Set<GitOpsAttentionReason>([
  'source_failed',
  'source_unknown_outcome',
  'source_suspended',
]);

/**
 * The single most useful next step for one attention entry. A decision goes
 * to the application view (the authority actions live there); a Direct
 * application's runtime or source failure goes straight to the stack or its
 * Git source; everything else opens the application view.
 */
export function attentionNextStep(reason: GitOpsAttentionReason, row: GitOpsPortfolioRow): PortfolioRowAction {
  const review = { label: 'Review', run: () => openPortfolioApplication(row) };
  if (DECISION_REASONS.has(reason)) return review;
  const direct = row.targetMode === 'direct' && row.nodeId !== null && row.stackName !== null;
  if (direct && RUNTIME_FAILURE_REASONS.has(reason)) return { label: 'Open stack', run: () => openDirectStack(row, 'stack') };
  if (direct && SOURCE_FAILURE_REASONS.has(reason)) return { label: 'Open Git source', run: () => openDirectStack(row, 'git') };
  return { label: 'Open', run: () => openPortfolioApplication(row) };
}

/** The drill-down for one row: its application view, keyed by the row's portfolio id. */
export function openPortfolioApplication(row: GitOpsPortfolioRow): void {
  openGitOpsApplication(row.id);
}
