/**
 * Drill-down navigation for the GitOps portfolio rows.
 *
 * The portfolio owns the aggregate picture; operator action happens on the
 * owning surface, so every drill-down is a hand-off, never an in-place edit:
 * Direct applications open their stack's Git source panel, Blueprint
 * applications land on the Blueprint deployments surface that owns rollout
 * decisions.
 */
import {
  SENCHO_NAVIGATE_EVENT,
  SENCHO_OPEN_STACK_EVENT,
  type SenchoNavigateDetail,
  type SenchoOpenStackDetail,
} from '@/lib/events';
import type { GitOpsPortfolioRow } from '@/types/gitopsPortfolio';

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

/** Where every contextual GitOps indicator (dashboard badge, sidebar pending icon) leads. */
export function openGitOpsWorkplace(): void {
  window.dispatchEvent(new CustomEvent<SenchoNavigateDetail>(SENCHO_NAVIGATE_EVENT, {
    detail: { view: 'gitops' },
  }));
}

/** The drill-down for one row, by target mode. Returns false when nothing can open it. */
export function openPortfolioApplication(row: GitOpsPortfolioRow): boolean {
  if (row.targetMode === 'direct') {
    if (row.nodeId === null || row.stackName === null) return false;
    openDirectGitApplication(row);
    return true;
  }
  if (row.blueprintId === null) return false;
  openBlueprintGitApplication(row);
  return true;
}
