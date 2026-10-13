import { useState } from 'react';
import { CheckCheck, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast-store';
import { acceptGitOpsSource, fetchGitOpsSource } from '@/lib/gitopsAuthorityApi';
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
  const [pending, setPending] = useState<'pull' | 'accept' | null>(null);
  const showPull = pullSourceVisible(projection, can, sourceNodeId);
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
      if (FETCH_SETTLED.has(result.outcome)) {
        const sha = result.commitSha ? result.commitSha.slice(0, 7) : null;
        toast.success(sha ? `Pulled ${sha}` : 'Source pulled');
      } else {
        toast.error(result.reason.length > 0 ? result.reason : 'Failed to pull the source');
      }
      onChanged();
    } catch (error) {
      toast.error(errorMessage(error, 'Failed to pull the source'));
    } finally {
      setBusy(null);
    }
  }

  async function handleAccept(): Promise<void> {
    if (!candidateGenerationId) return;
    setBusy('accept');
    try {
      const result = await acceptGitOpsSource(applicationId, candidateGenerationId);
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
    }
  }

  return (
    <>
      {showPull && (
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 max-md:min-h-11"
          onClick={() => void handlePull()}
          disabled={pending !== null}
          data-testid="gitops-action-pull-source"
        >
          <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.5} />
          {pending === 'pull' ? 'Pulling…' : 'Pull source'}
        </Button>
      )}
      {showAccept && (
        <Button
          size="sm"
          className="gap-1.5 max-md:min-h-11"
          onClick={() => void handleAccept()}
          disabled={pending !== null}
          data-testid="gitops-action-accept-source"
        >
          <CheckCheck className="h-3.5 w-3.5" strokeWidth={1.5} />
          {pending === 'accept' ? 'Accepting…' : 'Accept source'}
        </Button>
      )}
    </>
  );
}
