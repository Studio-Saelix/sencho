import { FileSystemService } from '../FileSystemService';
import { buildSecurityOverview } from '../securityOverview';
import { buildStackStatusesEvidence } from '../stackStatusesEvidence';
import { STACK_STATUSES_CACHE_TTL_MS } from '../../helpers/constants';
import { errorMessageForLog } from '../../utils/safeLog';
import type {
  NodeReadinessEvidence,
  NodeSecurityEvidence,
  NodeWorkloadEvidence,
  NodeWorkloadProblem,
} from './types';

/**
 * This node's workload facts, from the same read and cache entry that
 * `GET /api/stacks/statuses` serves.
 *
 * The payload's timestamp is the freshness source rather than the cache outcome,
 * for the reason the `stale` field documents: the outcome is not truthful for
 * every reader of the same bytes. The read's own doc covers the mechanism.
 */
async function computeWorkloadEvidence(nodeId: number): Promise<NodeWorkloadEvidence | null> {
  try {
    const { evidence } = await buildStackStatusesEvidence(nodeId);
    const counts: NodeWorkloadEvidence['counts'] = {};
    const problems: NodeWorkloadProblem[] = [];
    for (const [stack, info] of Object.entries(evidence.data)) {
      counts[info.status] = (counts[info.status] ?? 0) + 1;
      if (info.status !== 'running') problems.push({ stack, status: info.status });
    }
    // Compared against the TTL this read is cached under, which makes it the
    // cache's own expiry condition rather than a second guess at one: the read
    // stamps `generatedAt` when it finishes and the cache starts the entry's
    // clock when the fetch returns. Sound only while this key has one writer
    // using this constant; a second writer with a different TTL would have to
    // carry its own expiry in the value.
    const ageMs = Date.now() - evidence.generatedAt;
    const stale = ageMs >= STACK_STATUSES_CACHE_TTL_MS;
    // `CacheService` swallows the fetch error when it serves an expired entry,
    // so a failed refresh shows up in this response nowhere but here: the caller
    // gets a 200 carrying old bytes either way. Only a failure on a cold cache
    // reaches the catch below, and the serve is still counted under the
    // namespace's stale tally, which `GET /api/system/cache-stats` reports.
    if (stale) {
      console.warn(
        `Readiness evidence: serving an expired stack status read for node ${nodeId} (age ${ageMs}ms, window ${STACK_STATUSES_CACHE_TTL_MS}ms)`,
      );
    }
    // Confirmed against the node's own strict listing on every request, not just
    // when the payload is empty. The status read swallows a listing failure into
    // an empty result, so a count mismatch is what separates "this node has no
    // stacks" from "this node's stacks were not read". Reading the listing only
    // for an empty payload would leave the partial drop, which looks like a
    // small node rather than a broken one, reported as a complete tally.
    //
    // The reach of that comparison has a floor. Both reads share one per-entry
    // compose-file probe, and its access check collapses every errno into "no
    // compose file", so a directory the probe cannot open is dropped from both
    // lists alike: the counts agree and that stack stays invisible here. Closing
    // it belongs in the probe, which would have to tell ENOENT apart from the
    // rest without changing what an unreadable directory means elsewhere.
    //
    // A mismatch marks the payload `degraded` rather than nulling the domain: it
    // never reports healthy either way, and the payload's own age is what
    // distinguishes a listing that could not be read from a cached pass that
    // landed before a stack appeared. A listing read that throws instead goes to
    // the catch below and nulls the domain, whichever branch served the payload
    // behind it: an unconfirmed tally is what this step exists to keep out of
    // the response, so the stale branch has nothing to keep either. The test
    // suite pins that interaction.
    const reported = Object.keys(evidence.data).length;
    const listed = (await FileSystemService.getInstance(nodeId).getStacksStrict()).length;
    const listingMismatch = listed !== reported;
    if (listingMismatch) {
      console.warn(
        `Readiness evidence: stack listing for node ${nodeId} reports ${listed} stacks against a payload of ${reported} (age ${ageMs}ms, window ${STACK_STATUSES_CACHE_TTL_MS}ms)`,
      );
    }
    return {
      generatedAt: evidence.generatedAt,
      counts,
      degraded: evidence.degraded || listingMismatch,
      stale,
      problems,
    };
  } catch (error) {
    // Server-side log only; the response carries a null.
    console.error(
      `Readiness evidence: workload facts failed for node ${nodeId}:`,
      errorMessageForLog(error),
    );
    return null;
  }
}

/**
 * This node's security facts, taken from the canonical posture derivation.
 *
 * No caching layer of its own, and the trade that records: the posture pass runs
 * once per hub poll per node, so an entry here would amortize it, but the pass
 * is synchronous, row-capped, and makes no network call, and
 * `GET /api/security/overview` already pays it uncached on each load of that
 * page, so the fan-out is not where its cost needs bounding.
 */
function computeSecurityEvidence(nodeId: number): NodeSecurityEvidence | null {
  try {
    const overview = buildSecurityOverview(nodeId);
    return {
      generatedAt: Date.now(),
      posture: overview.posture,
      posturePartial: overview.posturePartial,
      scannerAvailable: overview.scanner.available,
      staleScans: overview.staleScans,
      failedScans: overview.failedScans,
      lastSuccessfulScanAt: overview.lastSuccessfulScanAt,
    };
  } catch (error) {
    console.error(
      `Readiness evidence: security facts failed for node ${nodeId}:`,
      errorMessageForLog(error),
    );
    return null;
  }
}

/**
 * This node's readiness evidence: the two domains `GET /api/readiness/evidence`
 * serves, and the payload the hub reads during its fan-out.
 *
 * Each domain settles on its own and degrades to `null` rather than failing the
 * call, because a thrown error would erase the domain that did answer as well:
 * the hub renders a `domain_error` cell for the null and keeps the other
 * domain's evidence. The caller therefore receives a payload even when both
 * computes fail, and the logs above are where that shows up server-side.
 *
 * `generatedAt` is stamped after both domains have settled rather than before
 * the first one is awaited, so it is a completion instant for the payload and an
 * upper bound on each domain's own. Stamped first it would predate the workload
 * read by however long that read takes, and would age the security evidence by
 * time that had not elapsed when it was computed.
 *
 * Exported as a function rather than living in the route so that the hub's local
 * fast path reads this node through the same code a remote node runs behind the
 * HTTP route: the two paths have to agree, and a second implementation of this
 * assembly is how they would drift.
 */
export async function buildNodeReadinessEvidence(nodeId: number): Promise<NodeReadinessEvidence> {
  const workloads = await computeWorkloadEvidence(nodeId);
  const security = computeSecurityEvidence(nodeId);
  return { generatedAt: Date.now(), workloads, security };
}
