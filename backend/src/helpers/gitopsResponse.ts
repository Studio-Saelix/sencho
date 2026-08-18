import { DatabaseService } from '../services/DatabaseService';
import { FileSystemService } from '../services/FileSystemService';
import { GitOpsStore } from '../services/gitops/store';
import { NOT_APPLICABLE_REVISION, projectApplication } from '../services/gitops/derive';
import type { GitOpsRevisionProjection } from '../services/gitops/types';

export { NOT_APPLICABLE_REVISION };

/**
 * Whether the health gate is switched off for this instance.
 *
 * Only the explicit `'0'` disables it, matching HealthGateService. The setting
 * is seeded to `'1'` at schema init, so an absent row means a database whose
 * seed did not run; reading that as enabled matches the seeded default.
 */
function healthGateDisabled(): boolean {
  return DatabaseService.getInstance().getGlobalSettings()['health_gate_enabled'] === '0';
}

/**
 * The revision projection for a stack's live Direct application.
 *
 * A stack with no live application projects `not_applicable` rather than
 * throwing, so the list route gets a uniform shape across rows whether or not
 * a given stack has Git attached.
 */
export function projectStackRevision(stackName: string): GitOpsRevisionProjection {
  const app = GitOpsStore.getInstance().getLiveDirectApplication(stackName);
  if (!app) return NOT_APPLICABLE_REVISION;
  return projectApplication(app.id, healthGateDisabled());
}

/**
 * Stack directories that exist on this instance right now.
 *
 * Read once per request. The list and history routes share one probe across
 * every row; the per-stack route pays a full listing to answer a single
 * membership test, which is the same cost its existence check already paid.
 *
 * Deliberately the strict listing. This set is the evidence behind
 * `stackResourcePresent`, which decides whether a row can be authorized by a
 * stack grant and which travels to other instances as a positive claim about
 * the filesystem. The lenient variant answers a failed directory read with an
 * empty list, which here would read as "every stack is gone": every row would
 * silently fall to Admin and a scoped operator would receive an empty list and
 * an empty audit trail, indistinguishable from having none. A read failure is
 * raised so the caller can report it instead.
 */
export async function stackResourceSet(nodeId: number | undefined): Promise<Set<string>> {
  return new Set(await FileSystemService.getInstance(nodeId).getStacksStrict());
}
