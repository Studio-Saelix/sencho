import { useCallback, useEffect, useRef, useState } from 'react';
import { useNodes } from '@/context/NodeContext';
import { apiFetch } from '@/lib/api';
import { liveSourceFacet } from '@/lib/gitopsState';
import type { GitOpsRevisionCarrier, GitOpsSourceStatus } from '@/types/gitops';

/** Trailing-edge window for a burst of GitOps transitions, as elsewhere on this card. */
const INVALIDATE_DEBOUNCE_MS = 250;

/** Stack name to the source state of its GitOps application. A miss is a stack with none. */
export type GitOpsSourceStateMap = Record<string, GitOpsSourceStatus | undefined>;

/**
 * A Git source row as this hook needs it.
 *
 * `gitopsRevision` is optional because `/git-sources` is proxied and a node
 * that predates the revision model answers rows without one. Typing it as
 * required is what once made a whole map freeze behind a swallowed throw.
 */
type GitSourceRow = { stack_name: string } & Partial<GitOpsRevisionCarrier>;

/**
 * Source state per stack, for the surfaces that list many stacks at once.
 *
 * Keyed on stack name because that is what the dashboards have: they are built
 * from container status, which knows nothing about application ids.
 *
 * A stack is absent from the map unless the model has something to say about
 * it. A row without a revision, a Blueprint-owned application (whose source
 * facet is `not_applicable`, since naming a Git state there would be a claim
 * the model never made), and a projection fault all resolve to absent, so the
 * badge simply does not render rather than showing a state nobody derived.
 */
export function useGitOpsSourceStates(): GitOpsSourceStateMap {
  const { activeNode } = useNodes();
  const nodeId = activeNode?.id;

  const [states, setStates] = useState<GitOpsSourceStateMap>({});
  /**
   * Bumped by anything that invalidates an in-flight answer. Stack names repeat
   * across nodes, so a slow response for the node the operator just left would
   * otherwise land as this node's state, labelling the wrong stacks.
   */
  const generation = useRef(0);

  const fetchStates = useCallback(async () => {
    const current = ++generation.current;
    try {
      const res = await apiFetch('/git-sources');
      if (!res.ok) return;
      const rows = await res.json() as GitSourceRow[];
      const next: GitOpsSourceStateMap = {};
      for (const row of rows) {
        const source = row.gitopsRevision ? liveSourceFacet(row.gitopsRevision) : null;
        if (source) next[row.stack_name] = source.status;
      }
      if (current !== generation.current) return;
      setStates(next);
    } catch {
      // Non-critical decoration. Leave the previous map rather than blanking
      // every badge on one failed poll.
    }
  }, []);

  // Blank on a node switch so no stale badge survives into the new node's list,
  // then ask the node that is now active.
  useEffect(() => {
    generation.current += 1;
    setStates({});
    void fetchStates();
  }, [nodeId, fetchStates]);

  // GitOps state changes on transitions, not on a clock, so there is no poll
  // here: the announcement is the trigger. Debounced because one operation
  // commits several transitions in a row.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onInvalidate = (e: Event) => {
      const detail = (e as CustomEvent<{ scope?: string }>).detail;
      if (detail?.scope !== 'gitops') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void fetchStates();
      }, INVALIDATE_DEBOUNCE_MS);
    };
    window.addEventListener('sencho:state-invalidate', onInvalidate);
    return () => {
      window.removeEventListener('sencho:state-invalidate', onInvalidate);
      if (timer) clearTimeout(timer);
    };
  }, [fetchStates]);

  return states;
}
