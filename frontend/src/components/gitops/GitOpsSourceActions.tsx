import { useState } from 'react';
import { CheckCheck, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ConfirmModal } from '@/components/ui/modal';
import { toast } from '@/components/ui/toast-store';
import { useNodes } from '@/context/NodeContext';
import { acceptGitOpsSource, fetchGitOpsSource, type GitOpsSourceFetchResult } from '@/lib/gitopsAuthorityApi';
import {
  acceptScopeSentence,
  pullScopeSentence,
  readApprovedScope,
} from '@/lib/gitopsApprovedScope';
import { policyReadFor } from '@/lib/gitopsAuthorityPolicy';
import { liveSourceFacet } from '@/lib/gitopsState';
import { acceptSourceVisible, pullSourceVisible, type SourceActionCan } from '@/components/gitops/sourceActionVisibility';
import type { GitOpsRevisionProjection } from '@/types/gitops';

const FETCH_SETTLED = new Set([
  'no_source_change',
  'candidate_already_fetched',
  'pending_review',
  'superseded',
]);

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

/** Manual and review pulls only fetch. An automatic source can accept, and may start a rollout. */
function pullConfirms(projection: GitOpsRevisionProjection): boolean {
  if (projection.targetMode === 'not_applicable') return false;
  return policyReadFor(projection.authorityPolicies, 'source')?.configured === 'automatic';
}

function rolloutStartsOnPull(projection: GitOpsRevisionProjection): boolean {
  if (projection.targetMode === 'not_applicable') return false;
  return policyReadFor(projection.authorityPolicies, 'rollout_authorization')?.configured === 'automatic';
}

/**
 * The commit, the approved rollout scope, and whether acceptance can start a
 * rollout. Frozen when the confirm opens.
 *
 * The scope comes from the placement approval, never from the observed target
 * rows. They disagree whenever placement has moved since the last rollout ran,
 * and a confirmation naming the wrong nodes is worse than no confirmation. A
 * scope that cannot be read is said to be unreadable rather than named, so the
 * confirmation never claims a destination it did not read.
 */
function acceptPreview(projection: GitOpsRevisionProjection, nodes: readonly { id: number; name: string }[]): string {
  const source = liveSourceFacet(projection);
  const sha = source?.fetchedCommitSha?.slice(0, 7) ?? null;
  const commit = sha ? `Accept ${sha}.` : 'Accept the waiting commit.';
  const scope = acceptScopeSentence(readApprovedScope(projection, nodes));
  const rollout = rolloutStartsOnPull(projection)
    ? 'Rollout authorization can start that rollout. Starting a rollout is not the same as it finishing.'
    : 'The rollout stays waiting for you.';
  return `${commit} ${scope} ${rollout}`;
}

/**
 * What Pull source can do to a source that authorizes itself.
 *
 * The next commit is not knowable before the fetch, which is no reason to hide
 * the placement scope the operator already approved: this request can record
 * the commit and start a rollout in one call, so its destination is the part
 * the operator cannot check afterwards.
 */
function pullConfirmDescription(
  projection: GitOpsRevisionProjection,
  nodes: readonly { id: number; name: string }[],
): string {
  if (!rolloutStartsOnPull(projection)) {
    return 'Pull source fetches the next commit. This source accepts a new commit on its own. The rollout stays waiting for you.';
  }
  const scope = pullScopeSentence(readApprovedScope(projection, nodes));
  return `Pull source fetches the next commit. This source accepts a new commit on its own, and rollout authorization can start a rollout from it. ${scope} Starting a rollout is not the same as it finishing.`;
}

function pullFeedback(result: GitOpsSourceFetchResult): { tone: 'success' | 'warning' | 'error'; message: string } {
  if (!FETCH_SETTLED.has(result.outcome)) {
    return { tone: 'error', message: result.reason.length > 0 ? result.reason : 'Failed to pull the source' };
  }
  const pulled = result.outcome !== 'no_source_change';
  if (result.authority.status === 'held') {
    const note = result.authority.note ?? 'The candidate was not accepted.';
    return { tone: 'warning', message: pulled ? `Source pulled. ${note}` : note };
  }
  if (result.authority.status === 'accepted' && result.authority.rollout === 'started') {
    return { tone: 'success', message: 'Source revision accepted and the rollout started' };
  }
  if (result.authority.status === 'accepted' && result.authority.rollout !== 'started') {
    const note = result.authority.note ?? 'The rollout did not start.';
    return { tone: 'warning', message: `Source revision accepted. ${note}` };
  }
  if (!pulled) return { tone: 'success', message: 'No newer commit.' };
  const sha = result.commitSha ? result.commitSha.slice(0, 7) : null;
  return { tone: 'success', message: sha ? `Pulled ${sha}` : 'Source pulled' };
}

interface GitOpsSourceActionsProps {
  applicationId: string;
  projection: GitOpsRevisionProjection;
  can?: SourceActionCan;
  sourceNodeId: number | null;
  onChanged: () => void;
  onPendingChange?: (pending: boolean) => void;
}

/**
 * Pull source and Accept source, the two verbs that move a Git-managed
 * Blueprint's commit. Shared by the authority row and the claimed Git
 * source sheet so both call the same routes.
 */
export default function GitOpsSourceActions({
  applicationId,
  projection,
  can,
  sourceNodeId,
  onChanged,
  onPendingChange,
}: GitOpsSourceActionsProps) {
  const { nodes } = useNodes();
  const [pending, setPending] = useState<'pull' | 'accept' | null>(null);
  const [confirmPull, setConfirmPull] = useState(false);
  const [acceptReview, setAcceptReview] = useState<{ generationId: string; description: string } | null>(null);
  const showPull = pullSourceVisible(projection, can, sourceNodeId);
  const confirmsPull = pullConfirms(projection);
  const source = liveSourceFacet(projection);
  const candidateGenerationId = source && (source.status === 'candidate_ready' || source.status === 'source_review_pending')
    ? source.candidateGenerationId
    : null;
  const showAccept = acceptSourceVisible(projection, can);

  if (!showPull && !showAccept) return null;

  function setBusy(next: 'pull' | 'accept' | null): void {
    setPending(next);
    onPendingChange?.(next !== null);
  }

  async function handlePull(): Promise<void> {
    setBusy('pull');
    try {
      const result = await fetchGitOpsSource(applicationId);
      const feedback = pullFeedback(result);
      toast[feedback.tone](feedback.message);
      onChanged();
    } catch (error) {
      toast.error(errorMessage(error, 'Failed to pull the source'));
    } finally {
      setBusy(null);
      setConfirmPull(false);
    }
  }

  async function handleAccept(generationId: string): Promise<void> {
    setBusy('accept');
    try {
      const result = await acceptGitOpsSource(applicationId, generationId);
      if (result.note) {
        toast.warning(`Source revision accepted. ${result.note}`);
      } else if (result.dispatched) {
        toast.success('Source revision accepted and the rollout started');
      } else {
        toast.success('Source revision accepted');
      }
      onChanged();
    } catch (error) {
      toast.error(errorMessage(error, 'Failed to accept the source revision'));
    } finally {
      setBusy(null);
      setAcceptReview(null);
    }
  }

  return (
    <>
      {showPull && (
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 max-md:min-h-11"
          onClick={() => {
            if (confirmsPull) setConfirmPull(true);
            else void handlePull();
          }}
          disabled={pending !== null}
          data-testid="gitops-action-pull-source"
        >
          <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.5} />
          {pending === 'pull' ? 'Pulling…' : 'Pull source'}
        </Button>
      )}
      {confirmsPull && (
        <ConfirmModal
          open={confirmPull}
          onOpenChange={setConfirmPull}
          kicker="SOURCE"
          title="Pull source"
          description={pullConfirmDescription(projection, nodes)}
          confirmLabel="Pull source"
          busyConfirmLabel="Pulling…"
          confirming={pending === 'pull'}
          onConfirm={() => handlePull()}
        />
      )}
      {showAccept && (
        <Button
          size="sm"
          className="gap-1.5 max-md:min-h-11"
          onClick={() => {
            if (!candidateGenerationId) return;
            setAcceptReview({
              generationId: candidateGenerationId,
              description: acceptPreview(projection, nodes),
            });
          }}
          disabled={pending !== null}
          data-testid="gitops-action-accept-source"
        >
          <CheckCheck className="h-3.5 w-3.5" strokeWidth={1.5} />
          {pending === 'accept' ? 'Accepting…' : 'Accept source'}
        </Button>
      )}
      {acceptReview && (
        <ConfirmModal
          open
          onOpenChange={(open) => {
            if (!open) setAcceptReview(null);
          }}
          kicker="SOURCE"
          title="Accept source"
          description={acceptReview.description}
          confirmLabel="Accept source"
          busyConfirmLabel="Accepting…"
          confirming={pending === 'accept'}
          onConfirm={() => handleAccept(acceptReview.generationId)}
        />
      )}
    </>
  );
}
