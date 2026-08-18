import type { Request, Response } from 'express';
import { DatabaseService } from '../services/DatabaseService';
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
import type { GitOpsApplicationRow, GitOpsHistoryRow } from '../services/gitops/types';

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
 * front. Re-running the row classifier there would hide that stack's own
 * entries from the operator who just proved they may read it, for instance
 * while the stack is still being created. It therefore also shows entries from
 * an earlier application on the same stack name; only `per_row` treats name
 * reuse as unprovable.
 */
export type HistoryScope =
  | { kind: 'per_row' }
  | { kind: 'authorized_stack'; stackName: string };

export type GitOpsHistoryPageItem = GitOpsHistoryItem & { stackResourcePresent: boolean };

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
  // A pinned scope filters nothing, so it never needs to look past the page it
  // is filling. Only the per-row scope can discard rows and must scan ahead.
  const scanLimit = scope.kind === 'per_row' ? HISTORY_SCAN_CAP : limit + 1;
  const rows = queryHistoryRows(DatabaseService.getInstance().getDb(), filters, cursor, scanLimit);

  const store = GitOpsStore.getInstance();
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
    if (scope.kind === 'per_row') {
      const requirement = classifyHistoryRow({
        stackName: row.stack_name,
        applicationLifecycleStatus: applicationFor(row.application_id)?.lifecycle_status,
        stackResourcePresent,
      });
      if (!satisfiesGitOpsRead(req, requirement)) continue;
    }
    items.push({ ...toHistoryItem(row), stackResourcePresent });
  }

  // A full scan window means the table may hold more beyond it, so the caller
  // is handed a cursor even when this page came back short.
  const moreMayFollow = !exhausted || rows.length === scanLimit;
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
  const filters = scope.kind === 'authorized_stack'
    ? { ...parsed.filters, stackName: scope.stackName }
    : parsed.filters;
  const present = await stackResourceSet(req.nodeId);
  res.json(buildHistoryPage(req, filters, parseLimit(req.query.limit), cursor, present, scope));
}
