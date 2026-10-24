/**
 * Drill-down navigation for the GitOps portfolio rows.
 *
 * Opening an application never leaves the workplace. A Direct application is
 * its Git source, so its sheet opens in place over the list (the host listens
 * for GITOPS_GIT_SOURCE_EVENT); any other application opens its own sheet, keyed
 * by the `application` query parameter of the GitOps path, a parameter the view
 * owns (see VIEW_OWNED_QUERY in useUrlSync), so it is a shareable link and Back
 * returns to the list. A step that resolves a source problem runs right there
 * when the server offers it, and only otherwise opens a surface.
 */
import { openBlueprintIntent, type BlueprintIntent } from '@/lib/blueprintIntent';
import {
  SENCHO_NAVIGATE_EVENT,
  SENCHO_OPEN_STACK_EVENT,
  type SenchoNavigateDetail,
  type SenchoOpenStackDetail,
} from '@/lib/events';
import { runSourceControllerAction, type SourceControllerAction } from '@/lib/gitSourceControllerAction';
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
 * Open a Direct application's owning stack on its node. The shell consumes the
 * event; a missing node or stack leaves the operator wherever they were (the
 * caller survives navigation failure).
 */
function openDirectStack(row: GitOpsPortfolioRow): void {
  if (row.nodeId === null || row.stackName === null) return;
  window.dispatchEvent(new CustomEvent<SenchoOpenStackDetail>(SENCHO_OPEN_STACK_EVENT, {
    detail: { nodeId: row.nodeId, stackName: row.stackName, destination: 'stack' },
  }));
}

/** Asks the workplace's Git source host to open a Direct application's sheet in place. */
export const GITOPS_GIT_SOURCE_EVENT = 'sencho:gitops-git-source';

export interface GitOpsGitSourceTarget {
  nodeId: number;
  stackName: string;
  applicationName: string;
  /** `review` pulls and opens the diff when a fetched update is waiting; otherwise the sheet just opens. */
  intent?: 'review';
}

/** Whether a row is a Direct application whose stack and node are known, so its Git source sheet can open. */
export function hasGitSourceSheet(row: GitOpsPortfolioRow): row is GitOpsPortfolioRow & { nodeId: number; stackName: string } {
  return row.targetMode === 'direct' && row.nodeId !== null && row.stackName !== null;
}

/** Open a Direct application's Git source sheet over the workplace, on the application's own node. */
export function openGitSourceInPlace(row: GitOpsPortfolioRow, intent?: 'review'): void {
  if (!hasGitSourceSheet(row)) return;
  window.dispatchEvent(new CustomEvent<GitOpsGitSourceTarget>(GITOPS_GIT_SOURCE_EVENT, {
    detail: { nodeId: row.nodeId, stackName: row.stackName, applicationName: row.name, ...(intent ? { intent } : {}) },
  }));
}

/** Asks the workplace's Blueprint host to open a Blueprint's sheet or the create dialog in place. */
export const GITOPS_BLUEPRINT_EVENT = 'sencho:gitops-blueprint';

export interface GitOpsBlueprintRequest {
  intent: BlueprintIntent;
  /** Set by a host that took the request; without one, the Fleet Blueprints tab opens instead. */
  handled: boolean;
}

/**
 * Open a Blueprint's detail or the create dialog over the workplace. Where no host
 * is mounted to take it, it falls back to the Fleet Blueprints tab, which can.
 */
export function openBlueprintInPlace(intent: BlueprintIntent): void {
  const request: GitOpsBlueprintRequest = { intent, handled: false };
  window.dispatchEvent(new CustomEvent<GitOpsBlueprintRequest>(GITOPS_BLUEPRINT_EVENT, { detail: request }));
  if (!request.handled) openBlueprintIntent(intent);
}

/** Open the Blueprint-backed application's own Blueprint detail, in place when the workplace can host it. */
function openBlueprint(row: GitOpsPortfolioRow): void {
  if (row.blueprintId === null) return;
  openBlueprintInPlace({ kind: 'open', blueprintId: row.blueprintId });
}

export interface OwningSurfaceHandoff {
  label: string;
  open: () => void;
}

/**
 * The owning surface for an application, by target mode, or null when the
 * row carries no identity that surface could open, or the caller cannot
 * reach it (opening a Blueprint needs the fleet read grant and is not offered
 * on a phone).
 */
export function owningSurfaceHandoff(row: GitOpsPortfolioRow, opts: { canOpenBlueprint: boolean }): OwningSurfaceHandoff | null {
  switch (row.targetMode) {
    case 'direct':
      if (row.nodeId === null || row.stackName === null) return null;
      return { label: 'Open Git source', open: () => openGitSourceInPlace(row) };
    case 'blueprint':
    case 'inline_blueprint':
      if (row.nodeId !== null || row.blueprintId === null || !opts.canOpenBlueprint) return null;
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
 * navigations: decisions (accept, approve, authorize) stay on the Git source
 * sheet or the application sheet, which own their permission and confirmation.
 */
export function portfolioRowActions(row: GitOpsPortfolioRow, opts: { canOpenFleet: boolean }): PortfolioRowAction[] {
  const actions: PortfolioRowAction[] = [];
  if (hasGitSourceSheet(row)) {
    // A Direct application and its Git source are one object, so there is one way in.
    actions.push({ label: 'Open Git source', run: () => openGitSourceInPlace(row) });
    actions.push({ label: 'Open stack', run: () => openDirectStack(row) });
  } else {
    actions.push({ label: 'Open application', run: () => openPortfolioApplication(row) });
  }
  if (row.targetMode !== 'direct' && row.nodeId === null && row.blueprintId !== null && opts.canOpenFleet) {
    actions.push({ label: 'Open Blueprint', run: () => openBlueprint(row) });
  }
  return actions;
}

/** Reasons that wait on an operator decision the Git source or application sheet records. */
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
  // The node applied something the application has moved past, so the next step
  // is a decision about that rollout rather than an investigation of the stack.
  'rollout_stale_acknowledgement',
]);

/** Failures best investigated on the stack itself (containers, logs, health). */
const RUNTIME_FAILURE_REASONS: ReadonlySet<GitOpsAttentionReason> = new Set<GitOpsAttentionReason>([
  'deploy_failed',
  'health_failed',
  'recovery_failed',
  'rollback_failed',
]);

/** The controller verbs the queue can run without opening the sheet. */
type SourceVerb = Exclude<SourceControllerAction, 'suspend'>;

/** Failures of the Git source itself (fetch, auth, suspension), each with the verb that clears it. */
const SOURCE_FAILURE_VERB: Partial<Record<GitOpsAttentionReason, SourceVerb>> = {
  source_failed: 'retry',
  source_unknown_outcome: 'retry',
  source_retry_scheduled: 'retry',
  source_suspended: 'resume',
};

/** A fetched commit waiting on the operator: the verb is reviewing the update. */
const UPDATE_REVIEW_REASONS: ReadonlySet<GitOpsAttentionReason> = new Set<GitOpsAttentionReason>([
  'source_review_pending',
  'source_conflict_blocker',
  'source_reconcile_required',
]);

/** What this session may do to a Direct application's Git source without opening anything. */
export interface SourceControl {
  can: (action: SourceVerb) => boolean;
}

/** A step either opens a surface (synchronously) or acts in place and settles when the server answers. */
export interface AttentionStep {
  label: string;
  run: () => void | Promise<void>;
}

/**
 * The single most useful next step for one attention entry, as a verb that runs
 * where the operator already is.
 *
 * A Direct application's failed or suspended source is retried or resumed in
 * place when the server offers it and the session may; its waiting update opens
 * the Git source sheet, which pulls straight into the diff when an update is
 * waiting; a runtime failure goes to the stack, where the logs are. A Blueprint
 * decision opens the application sheet, whose authority actions own permission
 * and confirmation, and any other Direct reason opens that application's Git
 * source sheet. A retry or resume the server does not offer to this session
 * falls back to opening the Git source, so those verbs never promise something
 * that would be refused.
 */
export function attentionNextStep(reason: GitOpsAttentionReason, row: GitOpsPortfolioRow, control?: SourceControl): AttentionStep {
  const open = (label: string): AttentionStep => ({ label, run: () => openPortfolioApplication(row) });
  if (!hasGitSourceSheet(row)) {
    const remoteBlueprint = row.targetMode !== 'direct' && row.nodeId !== null;
    if (DECISION_REASONS.has(reason)) return open(remoteBlueprint ? 'Inspect' : 'Review');
    return open('Open');
  }
  if (RUNTIME_FAILURE_REASONS.has(reason)) return { label: 'Open stack', run: () => openDirectStack(row) };
  if (UPDATE_REVIEW_REASONS.has(reason)) {
    return { label: 'Review update', run: () => openGitSourceInPlace(row, 'review') };
  }
  const verb = SOURCE_FAILURE_VERB[reason];
  if (verb) {
    if (control?.can(verb)) {
      return {
        label: verb === 'resume' ? 'Resume' : 'Retry',
        run: async () => { await runSourceControllerAction(row.stackName, row.nodeId, verb); },
      };
    }
    return { label: 'Open Git source', run: () => openGitSourceInPlace(row) };
  }
  return open(DECISION_REASONS.has(reason) ? 'Review' : 'Open');
}

/**
 * The drill-down for one row. A Direct application is its Git source, so it
 * opens that sheet in place; any other application opens its own sheet, keyed
 * by the row's portfolio id in the address.
 */
export function openPortfolioApplication(row: GitOpsPortfolioRow): void {
  if (hasGitSourceSheet(row)) {
    openGitSourceInPlace(row);
    return;
  }
  openGitOpsApplication(row.id);
}
