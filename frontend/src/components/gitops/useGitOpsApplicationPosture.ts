/**
 * The canonical posture for one application, read from the portfolio.
 *
 * The Drift tab already loads a node-local revision from
 * `GET /stacks/:name/drift`, and that revision is the right answer to "what does
 * the state on this node say". It is not an answer about the application. The
 * posture is computed once in the portfolio aggregator over every node holding a
 * target, and it accounts for evidence that is unknown, stale, or missing
 * entirely, none of which a single node's projection can see. Reading the
 * portfolio rather than deriving a second answer here is what keeps this tab
 * from calling an application settled while the portfolio reports it unsettled.
 *
 * Read by application id rather than filtered by stack name, for two reasons.
 * A Blueprint application has no stack name of its own (its deploy stack is
 * derived per target and the projection leaves the per-target name unset), so a
 * stack filter cannot reach one at all. And two applications can share a deploy
 * stack, in which case a name filter would return whichever came first, which is
 * a different question from the one this tab is asking.
 *
 * `localOnly`, like every other portfolio read: the aggregator is hub-owned, so
 * proxying this to the active node would ask a build that cannot compute the
 * posture to answer for it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { apiFetch } from '@/lib/api';
import type { GitOpsPortfolioRow } from '@/types/gitopsPortfolio';

/** Trailing-edge window for a burst of GitOps transitions, as on the dashboards. */
const INVALIDATE_DEBOUNCE_MS = 250;

/**
 * What the read produced.
 *
 * `unreadable` is deliberately distinct from `absent`. A stack with no GitOps
 * application has no posture to show and that is a complete answer; a read that
 * failed is an unknown one, and reporting it as "no application" would let this
 * tab imply an application is unremarkable at the exact moment Sencho cannot
 * tell the operator anything about it.
 */
export type GitOpsApplicationPosture =
  | { kind: 'loading' }
  | { kind: 'absent' }
  | { kind: 'unreadable' }
  | { kind: 'row'; row: GitOpsPortfolioRow };

type PortfolioDetailResponse = {
  application?: GitOpsPortfolioRow;
};

/** A settled read, tagged with the id it answered so a switch cannot show a stale result. */
type PostureRead = {
  portfolioId: string;
  result: { kind: 'absent' } | { kind: 'unreadable' } | { kind: 'row'; row: GitOpsPortfolioRow };
};

export function useGitOpsApplicationPosture(portfolioId: string | null): GitOpsApplicationPosture {
  const [read, setRead] = useState<PostureRead | null>(null);
  /**
   * Bumped by anything that invalidates an in-flight answer. The same stack can
   * exist on two nodes, so a slow response for the node the operator just left
   * must not land as this node's posture.
   */
  const generation = useRef(0);

  const fetchPosture = useCallback(async (id: string) => {
    const current = ++generation.current;
    try {
      const res = await apiFetch(`/gitops/applications/${encodeURIComponent(id)}`, { localOnly: true });
      if (current !== generation.current) return;
      if (!res.ok) {
        // Says which kind of refusal it was, because a 403 and a 500 look
        // identical on screen and mean different things to an operator.
        console.error(`[GitOps] application-posture read HTTP ${res.status} for ${id}`);
        setRead({ portfolioId: id, result: { kind: 'unreadable' } });
        return;
      }
      const body = await res.json() as PortfolioDetailResponse;
      if (current !== generation.current) return;
      const row = body.application;
      setRead({ portfolioId: id, result: row ? { kind: 'row', row } : { kind: 'absent' } });
    } catch (e) {
      if (current !== generation.current) return;
      console.error('[GitOps] application-posture read failed:', e);
      setRead({ portfolioId: id, result: { kind: 'unreadable' } });
    }
  }, []);

  useEffect(() => {
    if (portfolioId === null) return;
    void fetchPosture(portfolioId);
  }, [fetchPosture, portfolioId]);

  // The posture changes when a transition commits, which is what the
  // announcement carries, so that is the trigger rather than a poll. A poll
  // would also be wrong here: it would re-ask the aggregator about evidence
  // freshness it has already decided, on a clock, for a tab the operator may
  // have open for an hour.
  useEffect(() => {
    if (portfolioId === null) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onInvalidate = (e: Event) => {
      const detail = (e as CustomEvent<{ scope?: string }>).detail;
      if (detail?.scope !== 'gitops') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void fetchPosture(portfolioId);
      }, INVALIDATE_DEBOUNCE_MS);
    };
    window.addEventListener('sencho:state-invalidate', onInvalidate);
    return () => {
      window.removeEventListener('sencho:state-invalidate', onInvalidate);
      if (timer) clearTimeout(timer);
    };
  }, [fetchPosture, portfolioId]);

  // Derived during render rather than stored, so a null id and an unanswered
  // question are both a value the caller can read without a state write. A
  // read for a different id is discarded here, which is what keeps a slow
  // answer for the previous node from flashing as this node's posture.
  if (portfolioId === null) return { kind: 'absent' };
  if (read === null || read.portfolioId !== portfolioId) return { kind: 'loading' };
  return read.result;
}
