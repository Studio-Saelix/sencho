import type { Request, Response } from 'express';
import { DatabaseService } from '../services/DatabaseService';
import { NodeRegistry } from '../services/NodeRegistry';
import { GitOpsStore } from '../services/gitops/store';
import {
  HISTORY_DEFAULT_LIMIT,
  HISTORY_MAX_LIMIT,
  HISTORY_SCAN_CAP,
  decodeHistoryCursor,
  encodeHistoryCursor,
  queryHistoryRows,
  toHistoryItem,
  type GitOpsHistoryCursor,
  type GitOpsHistoryFilters,
  type GitOpsHistoryItem,
  type HistoryOutcome,
} from '../services/gitops/history';
import { classifyHistoryRow, satisfiesGitOpsRead } from '../services/gitops/readAuth';
import { stackResourceSet } from './gitopsResponse';
import type {
  GitOpsApplicationRow,
  GitOpsHistoryRow,
  GitOpsHistoryEvidenceFields,
} from '../services/gitops/types';

/**
 * Accepted `outcome` values.
 *
 * Source of truth is the `gitops_history.outcome` CHECK constraint in
 * `services/gitops/schema.ts`. Typed as `HistoryOutcome[]` so adding a value
 * there and forgetting it here fails the build rather than making the new
 * outcome quietly unfilterable.
 */
const OUTCOMES: readonly HistoryOutcome[] = [
  'committed', 'failed', 'skipped', 'superseded', 'recovered', 'unknown',
];

function isOutcome(value: string): value is HistoryOutcome {
  return (OUTCOMES as readonly string[]).includes(value);
}

/**
 * How a request's rows are authorized.
 *
 * A union rather than a flag because skipping the row classifier is only sound
 * when the query is pinned to the exact resource the caller already proved.
 * Carrying the stack name in the scope means the page builder derives that
 * filter itself, so the unsafe combination (skip the classifier, do not pin the
 * query) cannot be written.
 *
 * `authorized_stack` is for a route that proved `stack:read` on one stack up
 * front. That grant exempts the rows of the application holding the name *now*,
 * which is what keeps a stack's own entries visible to the operator who just
 * proved they may read it, including while the stack is still being created and
 * the row classifier would refuse it. Every other row on that name still goes
 * through the classifier: a stack name outlives the applications that held it,
 * and a grant on the current one is not evidence about an earlier one.
 *
 * What that closes, precisely: every predecessor needs `system:audit`, whether
 * it was `deleted`, `detached`, still `creating`, or has lost its stack
 * resource. So the classifier partitions a stack name between the application
 * holding it now, whose rows the grant covers, and everyone who held it before,
 * whose rows belong to the audit audience. `classifyHistoryRow` says why
 * `detached` is in that second group rather than riding its files.
 */
export type HistoryScope =
  | { kind: 'per_row' }
  | { kind: 'authorized_stack'; stackName: string };

/**
 * One history entry as the API returns it.
 *
 * The two extra fields are the owning instance's answers to questions only it
 * can settle, and they exist so a hub can authorize this entry without holding
 * the instance's database: whether the stack is really on disk, and what its
 * application's lifecycle currently is. Both are validated fail-closed by the
 * reader rather than trusted outright.
 */
export type GitOpsHistoryPageItem = GitOpsHistoryItem & GitOpsHistoryEvidenceFields;

export type GitOpsHistoryPage = {
  items: GitOpsHistoryPageItem[];
  nextCursor: string | null;
};

type FilterParse =
  | { ok: true; filters: GitOpsHistoryFilters }
  | { ok: false; message: string };

function stringParam(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Read the caller's filters off the query string.
 *
 * A recognized filter carrying an unusable value is rejected rather than
 * dropped. Silently ignoring it would answer "show me the failures" with the
 * entire trail under a 200, and on an audit surface a superset reads as an
 * answer rather than as a non-answer.
 *
 * `stackName` is intentionally absent: it is route-fixed by the per-stack
 * scope and never caller-supplied.
 */
export function parseHistoryFilters(query: Request['query']): FilterParse {
  const filters: GitOpsHistoryFilters = {
    applicationId: stringParam(query.applicationId),
    repoIdentity: stringParam(query.repoIdentity),
    configuredRef: stringParam(query.configuredRef),
    commitSha: stringParam(query.commitSha),
    generationId: stringParam(query.generationId),
    artifactSetId: stringParam(query.artifactSetId),
    rolloutCandidateId: stringParam(query.rolloutCandidateId),
    rolloutGenerationId: stringParam(query.rolloutGenerationId),
    trigger: stringParam(query.trigger),
    actor: stringParam(query.actor),
  };

  for (const key of ['blueprintId', 'nodeId'] as const) {
    const raw = stringParam(query[key]);
    if (raw === undefined) continue;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed)) {
      return { ok: false, message: `${key} must be an integer` };
    }
    filters[key] = parsed;
  }

  const outcome = stringParam(query.outcome);
  if (outcome !== undefined) {
    if (!isOutcome(outcome)) {
      return { ok: false, message: `outcome must be one of: ${OUTCOMES.join(', ')}` };
    }
    filters.outcome = outcome;
  }

  return { ok: true, filters };
}

/**
 * Resolve the node filter a hub asked this instance to apply.
 *
 * A hub cannot name this instance's node ids, so when it wants history for the
 * node it is talking to it sends `gitopsLocalTarget=1` and this instance
 * resolves that to its own default node.
 *
 * Refused rather than ignored when it arrives without a proxied hop. Dropping
 * it would answer a request for one node's rows with every node's rows under a
 * 200, the same superset-reads-as-an-answer problem the filter parser refuses
 * by name. It is worse here: the hub stamps one node id onto every row it
 * rewrites, so rows belonging to another node would come back positively
 * claiming to belong to this one. No legitimate caller sets it, since the hub
 * strips any caller-supplied value before forwarding.
 */
export function resolveLocalTargetNodeId(
  req: Request,
): { ok: true; nodeId: number | undefined } | { ok: false; message: string } {
  if (stringParam(req.query.gitopsLocalTarget) !== '1') return { ok: true, nodeId: undefined };
  const proxied = req.machineAuthScope === 'node_proxy' || req.machineAuthScope === 'pilot_tunnel';
  if (!proxied) {
    console.warn(
      `[GitOps] Refused gitopsLocalTarget on a direct request (scope=${req.machineAuthScope ?? 'none'}).`,
    );
    return { ok: false, message: 'gitopsLocalTarget is not accepted on a direct request' };
  }
  return { ok: true, nodeId: NodeRegistry.getInstance().getDefaultNodeId() };
}

export function parseLimit(value: unknown): number {
  const raw = stringParam(value);
  if (raw === undefined) return HISTORY_DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return HISTORY_DEFAULT_LIMIT;
  return Math.min(parsed, HISTORY_MAX_LIMIT);
}

/**
 * Build one authorized page of history.
 *
 * Rows are authorized individually after the query, so the cursor advances past
 * every row *examined* rather than every row kept. A caller whose grants filter
 * out most of a scan window still makes forward progress instead of re-reading
 * the same rejected rows on the next request. The cursor therefore names a row
 * the caller may not be able to read; it carries that row's timestamp and id
 * and nothing else about it.
 */
function buildHistoryPage(
  req: Request,
  filters: GitOpsHistoryFilters,
  limit: number,
  cursor: GitOpsHistoryCursor | null,
  present: Set<string>,
  scope: HistoryScope,
): GitOpsHistoryPage {
  // Either scope can discard rows now, so both have to scan ahead of the page
  // they are filling rather than stopping at it.
  const rows = queryHistoryRows(DatabaseService.getInstance().getDb(), filters, cursor, HISTORY_SCAN_CAP);

  const store = GitOpsStore.getInstance();
  // The application a stack-read grant on this name covers, read from the store
  // here beside the rows it authorizes rather than accepted from the route.
  //
  // The live lookup spans `active` and `creating`, which is the whole point: a
  // create still in flight has no other way to show the operator its own
  // history. Any predecessor is absent from it, so a predecessor's rows go to
  // the classifier, which refuses every one of them on a stack grant.
  //
  // Direct mode only, which is all `getLiveDirectApplication` returns. A
  // Blueprint-delivered stack therefore resolves to null here and has every row
  // classified. That is fail-closed and correct while it is `active`, since the
  // classifier grants those rows on the same `stack:read`.
  const scopedApplicationId = scope.kind === 'authorized_stack'
    ? store.getLiveDirectApplication(scope.stackName)?.id ?? null
    : null;
  // One lookup per application, not per row: a busy stack contributes many
  // rows that all resolve to the same application.
  const applications = new Map<string, GitOpsApplicationRow | undefined>();
  const applicationFor = (id: string): GitOpsApplicationRow | undefined => {
    if (!applications.has(id)) applications.set(id, store.getApplication(id));
    return applications.get(id);
  };

  const items: GitOpsHistoryPageItem[] = [];
  let lastExamined: GitOpsHistoryRow | null = null;
  let exhausted = true;

  for (const row of rows) {
    if (items.length === limit) {
      exhausted = false;
      break;
    }
    lastExamined = row;
    const stackResourcePresent = row.stack_name !== null && present.has(row.stack_name);
    const applicationLifecycleStatus = applicationFor(row.application_id)?.lifecycle_status ?? null;
    // Only the application the caller's grant actually names is exempt. A row
    // from an earlier application on the same stack name is a different
    // resource, and is classified like any other.
    const coveredByScope = scopedApplicationId !== null && row.application_id === scopedApplicationId;
    if (!coveredByScope) {
      const requirement = classifyHistoryRow({
        stackName: row.stack_name,
        applicationLifecycleStatus,
        stackResourcePresent,
      });
      if (!satisfiesGitOpsRead(req, requirement)) continue;
    }
    items.push({ ...toHistoryItem(row), stackResourcePresent, applicationLifecycleStatus });
  }

  // A full scan window means the table may hold more beyond it, so the caller
  // is handed a cursor even when this page came back short.
  const moreMayFollow = !exhausted || rows.length === HISTORY_SCAN_CAP;
  return {
    items,
    nextCursor: moreMayFollow && lastExamined
      ? encodeHistoryCursor({ createdAt: lastExamined.created_at, id: lastExamined.id })
      : null,
  };
}

/** Answer a history request under the given scope. */
export async function respondWithHistory(
  req: Request,
  res: Response,
  scope: HistoryScope,
): Promise<void> {
  const parsed = parseHistoryFilters(req.query);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.message });
    return;
  }
  const cursorRaw = stringParam(req.query.cursor);
  const cursor = cursorRaw === undefined ? null : decodeHistoryCursor(cursorRaw);
  if (cursorRaw !== undefined && cursor === null) {
    res.status(400).json({ error: 'Invalid page cursor. Restart from the first page.' });
    return;
  }
  const localTarget = resolveLocalTargetNodeId(req);
  if (!localTarget.ok) {
    res.status(400).json({ error: localTarget.message });
    return;
  }
  const filters: GitOpsHistoryFilters = {
    ...parsed.filters,
    ...(localTarget.nodeId === undefined ? {} : { nodeId: localTarget.nodeId }),
    ...(scope.kind === 'authorized_stack' ? { stackName: scope.stackName } : {}),
  };
  const present = await stackResourceSet(req.nodeId);
  res.json(buildHistoryPage(req, filters, parseLimit(req.query.limit), cursor, present, scope));
}
