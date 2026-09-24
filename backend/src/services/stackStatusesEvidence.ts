import { CacheService, type CacheFetchOutcome } from './CacheService';
import DockerController, { type BulkStackInfo } from './DockerController';
import { FileSystemService } from './FileSystemService';
import { GitSourceService } from './GitSourceService';
import {
  isSelfStackByIdentity,
  resolveSelfStackIdentity,
  UNRESOLVED_SELF_STACK_IDENTITY,
} from '../helpers/selfStackGuard';
import { STACK_STATUSES_CACHE_TTL_MS } from '../helpers/constants';

/** Per-stack status enriched with its compose source and self-identity flag. */
export interface StackStatusInfo extends BulkStackInfo {
  source: 'local' | 'git';
  isSelf: boolean;
}

export interface StackStatusesEvidence {
  /** Keyed by stack name, the compose directory under `COMPOSE_DIR`. */
  data: Record<string, StackStatusInfo>;
  /** True when an enrichment source failed, so the labels may be wrong. */
  degraded: boolean;
  /**
   * Epoch ms the read behind this payload finished, so a caller can report the
   * age of the evidence instead of the age of the cache entry serving it. The
   * snapshot is complete as of this instant, though individual container reads
   * inside the pass may be marginally older. `GET /api/stacks/statuses` serves
   * `data` alone, so adding a field here does not change that route's shape;
   * the readiness evidence route re-serves this stamp, so a field meant to stay
   * internal has to be kept out of that payload too.
   *
   * Stamped at completion rather than at the start of the pass on purpose:
   * `CacheService` starts an entry's TTL clock when the fetcher returns, so a
   * caller comparing this stamp against that same TTL is asking the cache's own
   * question and getting its answer. Stamped at the start, the comparison would
   * be true for the last fetch-duration milliseconds of every entry's life and
   * would call a read that had just succeeded stale.
   */
  generatedAt: number;
}

export interface StackStatusesEvidenceResult {
  evidence: StackStatusesEvidence;
  cacheOutcome: CacheFetchOutcome;
  dockerMs: number | null;
  enrichmentMs: number | null;
}

/**
 * Read every stack's status on one node, enriched with its compose source
 * (`local` / `git`) and whether it is the Sencho stack itself.
 *
 * The whole enriched payload is cached under `stack-statuses:<nodeId>` so that
 * enrichment (git-source labels, self identity) runs on a miss and not per
 * request. A non-empty payload flagged degraded is served but immediately
 * evicted, so a mislabeled result cannot persist for a full TTL.
 */
export async function buildStackStatusesEvidence(nodeId: number): Promise<StackStatusesEvidenceResult> {
  let dockerMs: number | null = null;
  let enrichmentMs: number | null = null;
  // Enrichment (git-source labels, self identity) is part of the cached
  // payload so cache hits serve fully decorated statuses with no per-request
  // work. The git label lookup failure still falls back to 'local' and must
  // not take down the primary status payload.
  const { value: evidence, outcome: cacheOutcome } = await CacheService.getInstance().getOrFetchWithMeta(
    `stack-statuses:${nodeId}`,
    STACK_STATUSES_CACHE_TTL_MS,
    async (): Promise<StackStatusesEvidence> => {
      const stacks = await FileSystemService.getInstance(nodeId).getStacks();
      const stackNames = stacks.map((s: string) => s.replace(/\.(yml|yaml)$/, ''));
      const dockerController = DockerController.getInstance(nodeId);
      const dockerStartedAt = Date.now();
      const bulkInfo = await dockerController.getBulkStackStatuses(stackNames);
      dockerMs = Date.now() - dockerStartedAt;
      const data: Record<string, BulkStackInfo> = {};
      for (const stack of stacks) {
        const name = stack.replace(/\.(yml|yaml)$/, '');
        data[stack] = bulkInfo[name] ?? { status: 'unknown' };
      }
      const enrichmentStartedAt = Date.now();
      let gitStackNames = new Set<string>();
      let gitSourcesDegraded = false;
      try {
        gitStackNames = new Set(GitSourceService.getInstance().list().map((s) => s.stack_name));
      } catch (sourceError) {
        console.error(`Failed to load git sources for status labels on node ${nodeId}; defaulting to local:`, sourceError);
        gitSourcesDegraded = true;
      }
      // Self-stack identity is resolved once per request instead of once per
      // stack, so cache misses pay a single container-list call, not N.
      const selfIdentity = stackNames.length > 0
        ? await resolveSelfStackIdentity()
        : UNRESOLVED_SELF_STACK_IDENTITY;
      const withSource: Record<string, StackStatusInfo> = {};
      const composeDir = FileSystemService.getInstance(nodeId).getBaseDir();
      for (const [stack, info] of Object.entries(data)) {
        const name = stack.replace(/\.(yml|yaml)$/, '');
        withSource[stack] = {
          ...info,
          source: gitStackNames.has(name) ? 'git' : 'local',
          isSelf: isSelfStackByIdentity(selfIdentity, name, composeDir),
        };
      }
      enrichmentMs = Date.now() - enrichmentStartedAt;
      // The payload is flagged degraded when any enrichment source failed
      // (Docker socket unreachable, git-source scan failure) so the caller
      // can refuse to let a mislabeled payload persist.
      return {
        generatedAt: Date.now(),
        data: withSource,
        degraded: selfIdentity.degraded || gitSourcesDegraded,
      };
    },
  );
  // A degraded identity resolution (Docker socket unreachable) cannot be
  // trusted to classify every stack, which un-gates destructive UI
  // affordances on the Sencho stack itself, and a failed git-source scan
  // mislabels every source badge as 'local'. Never let either mislabel
  // persist for a full TTL: return the live result, drop the cache entry,
  // and let the next request re-resolve. Everything between the fetch and
  // this invalidate is synchronous, so no concurrent reader can observe
  // the degraded entry. Running outside Docker is not degraded (both
  // identity sources legitimately resolve to null there), and an empty
  // fleet skips resolution entirely; both are cached as-is.
  if (cacheOutcome === 'computed' && Object.keys(evidence.data).length > 0 && evidence.degraded) {
    CacheService.getInstance().invalidate(`stack-statuses:${nodeId}`);
  }
  return { evidence, cacheOutcome, dockerMs, enrichmentMs };
}
