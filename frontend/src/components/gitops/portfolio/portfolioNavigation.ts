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
import {
  SENCHO_NAVIGATE_EVENT,
  SENCHO_OPEN_STACK_EVENT,
  type SenchoNavigateDetail,
  type SenchoOpenStackDetail,
} from '@/lib/events';
import type { GitOpsPortfolioRow } from '@/types/gitopsPortfolio';

export const APPLICATION_QUERY_PARAM = 'application';

/** Fired after the open application changes without a popstate (open, or a close that replaced history). */
export const GITOPS_APPLICATION_EVENT = 'sencho:gitops-application';

/** Marks a history entry this module pushed, so closing can pop it instead of stacking another. */
const PUSHED_MARKER = 'senchoGitOpsApplication';

/** A generous cap well above any real portfolio id (`bp:<n>`, `<node>:<uuid>`, `<node>:legacy:<stack>`); longer values are rejected as malformed. */
const MAX_APPLICATION_ID_LEN = 512;

/** The application id encoded in a search string, or null when none (or a malformed one) is present. */
export function applicationIdFromSearch(search: string): string | null {
  const id = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get(APPLICATION_QUERY_PARAM);
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
 * Open a Direct application's owning stack on its node, landing on the Git
 * panel. The shell consumes the event; a missing node or stack leaves the
 * operator wherever they were (the caller survives navigation failure).
 */
export function openDirectGitApplication(row: GitOpsPortfolioRow): void {
  if (row.nodeId === null || row.stackName === null) return;
  window.dispatchEvent(new CustomEvent<SenchoOpenStackDetail>(SENCHO_OPEN_STACK_EVENT, {
    detail: { nodeId: row.nodeId, stackName: row.stackName, destination: 'git' },
  }));
}

/** Open the Blueprint-backed application's rollout surface on the Fleet view. */
export function openBlueprintGitApplication(row: GitOpsPortfolioRow): void {
  if (row.blueprintId === null) return;
  window.dispatchEvent(new CustomEvent<SenchoNavigateDetail>(SENCHO_NAVIGATE_EVENT, {
    detail: { view: 'fleet', fleetTab: 'deployments' },
  }));
}

export interface OwningSurfaceHandoff {
  label: string;
  open: () => void;
}

/**
 * The owning surface for an application, by target mode, or null when the
 * row carries no identity that surface could open.
 */
export function owningSurfaceHandoff(row: GitOpsPortfolioRow): OwningSurfaceHandoff | null {
  switch (row.targetMode) {
    case 'direct':
      if (row.nodeId === null || row.stackName === null) return null;
      return { label: 'Open stack', open: () => openDirectGitApplication(row) };
    case 'blueprint':
    case 'inline_blueprint':
      if (row.blueprintId === null) return null;
      return { label: 'Open Blueprint deployments', open: () => openBlueprintGitApplication(row) };
    default: {
      const unhandled: never = row.targetMode;
      return unhandled;
    }
  }
}

/** Where every contextual GitOps indicator (dashboard badge, sidebar pending icon) leads. */
export function openGitOpsWorkplace(): void {
  window.dispatchEvent(new CustomEvent<SenchoNavigateDetail>(SENCHO_NAVIGATE_EVENT, {
    detail: { view: 'gitops' },
  }));
}

/** The drill-down for one row: its application view, keyed by the row's portfolio id. */
export function openPortfolioApplication(row: GitOpsPortfolioRow): void {
  openGitOpsApplication(row.id);
}
