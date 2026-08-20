import type { Request } from 'express';
import { checkPermission } from '../../middleware/permissions';
import { isRecord } from './json';
import type { GitOpsHistoryEvidenceFields, GitOpsRevisionProjection } from './types';

/**
 * What a caller must hold to read one GitOps row.
 *
 * `stack_read` is the narrow answer, used whenever a row can be tied to a stack
 * the caller may read. The other two are the fail-closed fallbacks for a row
 * whose audience cannot be narrowed, and they differ by what the row *is*:
 *
 * - `audit` for history entries, which are an audit trail. Auditing is what the
 *   `system:audit` permission exists for, and the request audit log is already
 *   gated on it, so an entry nobody can tie to a stack belongs to the same
 *   audience rather than to Admin alone.
 * - `admin` for source rows, which are live Git configuration (repository,
 *   ref, credentials policy, compose paths) rather than a record of events. An
 *   auditing mandate does not imply reading the configuration of stacks that
 *   have been deleted or never finished being created.
 */
export type GitOpsReadRequirement =
  | { readonly kind: 'admin' }
  | { readonly kind: 'audit' }
  | { readonly kind: 'stack_read'; readonly stackName: string };

const ADMIN: GitOpsReadRequirement = Object.freeze({ kind: 'admin' });
const AUDIT: GitOpsReadRequirement = Object.freeze({ kind: 'audit' });

/**
 * The projection field the source-row classifier probes.
 *
 * Tied to the live projection variant so renaming that field fails the build
 * here. Without the tie, a rename would leave the classifier probing a key that
 * no longer exists, and every row would quietly fall to Admin: fail-closed, but
 * invisible, since nothing would error and no test that hand-builds a payload
 * would notice.
 */
const LIFECYCLE_KEY = 'lifecycleStatus' satisfies keyof Extract<
  GitOpsRevisionProjection,
  { lifecycleStatus: unknown }
>;

/**
 * The evidence a history entry must carry to be classified.
 *
 * Values stay `unknown` because they may have crossed an instance boundary and
 * carry no shape guarantee, but the *key names* are bound to the item type the
 * producer emits. Without that tie, renaming a field on the producer would
 * leave this probing keys that no longer exist: every row would degrade to the
 * audit bucket, fail-closed but silent, with nothing failing to compile and no
 * test noticing. The required (`-?`) mapping also makes the call site fail, not
 * just this function.
 */
type Evidence<T> = { [K in keyof T]-?: unknown };
export type HistoryRowEvidence = Evidence<
  Pick<GitOpsHistoryEvidenceFields, 'stackName' | 'applicationLifecycleStatus' | 'stackResourcePresent'>
>;

/**
 * Validate an owning instance's resource-existence claim.
 *
 * Only a real JSON boolean counts. A peer that omits the field, sends null, or
 * sends a string is treated as "not present", so an older or malformed instance
 * degrades to Admin rather than silently widening who may read its rows.
 */
export function normalizeStackResourcePresent(value: unknown): boolean {
  return value === true;
}

function usableStackName(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Lifecycle states whose rows a stack grant can authorize.
 *
 * A deleted application no longer has a stack whose grant could authorize it,
 * and a creating one does not yet have a stack that survived. In both cases a
 * later application may hold the same stack name, so honouring a grant here
 * would let one application's rows be read through another's name. A detached
 * application has the same name-reuse property, and is allowed anyway: its
 * files are still on disk and still the operator's to read.
 */
function lifecycleAllowsStackRead(lifecycleStatus: unknown): boolean {
  return lifecycleStatus === 'active' || lifecycleStatus === 'detached';
}

/**
 * Authorization for one `GET /api/git-sources` row.
 *
 * The projection is typed `unknown` rather than as a projection because the
 * hub will classify rows that arrived from another instance as parsed JSON,
 * which carries no guarantee of shape. No such caller exists yet; every current
 * one passes a locally derived projection.
 *
 * Both `active` and `detached` are reachable. The projection comes from the
 * Direct lookup, which resolves a live application and then a detached one, so
 * a detached source now states its lifecycle instead of collapsing to the
 * not-applicable shape. That realizes the policy `lifecycleAllowsStackRead`
 * already describes rather than widening it: a detached application's files are
 * still on disk and still the operator's to read. `deleted` stays unreachable
 * and would fall to Admin regardless, since the same name-reuse argument bars
 * it on both sides.
 */
export function classifySourceRow(input: {
  stackName: unknown;
  gitopsRevision: unknown;
  stackResourcePresent: unknown;
}): GitOpsReadRequirement {
  const stackName = usableStackName(input.stackName);
  if (!stackName) return ADMIN;
  if (!isRecord(input.gitopsRevision)) return ADMIN;
  if (!lifecycleAllowsStackRead(input.gitopsRevision[LIFECYCLE_KEY])) return ADMIN;
  if (!normalizeStackResourcePresent(input.stackResourcePresent)) return ADMIN;
  return { kind: 'stack_read', stackName };
}

/**
 * Authorization for one history row.
 *
 * Lifecycle comes from the owning application row rather than the entry's
 * `before`/`after`, because those record only the fields a transition moved:
 * most entries never mention lifecycle at all, so decoding them would send
 * nearly every row to Admin and leave operators unable to read the history of
 * their own stacks. Reading the application row also keeps authorization off
 * the audit payload entirely, so a corrupt delta cannot influence who may see
 * it.
 */
export function classifyHistoryRow(input: HistoryRowEvidence): GitOpsReadRequirement {
  const stackName = usableStackName(input.stackName);
  if (!stackName) return AUDIT;
  if (!lifecycleAllowsStackRead(input.applicationLifecycleStatus)) return AUDIT;
  if (!normalizeStackResourcePresent(input.stackResourcePresent)) return AUDIT;
  return { kind: 'stack_read', stackName };
}

/**
 * Whether this caller satisfies a classifier's requirement.
 *
 * Exhaustive on purpose: a requirement this function does not recognize is
 * denied rather than falling through to the narrower stack check.
 */
export function satisfiesGitOpsRead(req: Request, requirement: GitOpsReadRequirement): boolean {
  switch (requirement.kind) {
    case 'admin':
      return req.user?.role === 'admin';
    case 'audit':
      return checkPermission(req, 'system:audit');
    case 'stack_read':
      return checkPermission(req, 'stack:read', 'stack', requirement.stackName);
    default: {
      const unrecognized: never = requirement;
      void unrecognized;
      return false;
    }
  }
}
