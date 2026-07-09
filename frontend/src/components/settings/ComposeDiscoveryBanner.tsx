import { FolderSearch } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { ComposeDiscovery } from '@/lib/discovery-types';

export interface ComposeDiscoveryBannerProps {
  discovery?: ComposeDiscovery | null;
  composeDir?: string;
  isLoading?: boolean;
  onReview?: () => void;
}

export function ComposeDiscoveryBanner({
  discovery,
  composeDir,
  isLoading = false,
  onReview,
}: ComposeDiscoveryBannerProps) {
  if (isLoading) {
    return <Skeleton className="h-24 w-full" aria-busy="true" />;
  }

  if (!discovery) return null;

  const { stackCount, adoptCandidateCount, adoptCandidatesTruncated } = discovery;
  const total = stackCount + adoptCandidateCount;
  if (total === 0) return null;

  const dir = discovery.composeDir || composeDir || '';
  const stackPart =
    stackCount > 0
      ? `${stackCount} stack${stackCount === 1 ? '' : 's'}`
      : null;
  const adoptPart =
    adoptCandidateCount > 0
      ? `${adoptCandidateCount}${adoptCandidatesTruncated ? '+' : ''} file${adoptCandidateCount === 1 ? '' : 's'} to adopt`
      : null;
  const summary = [stackPart, adoptPart].filter(Boolean).join(' and ');

  return (
    <div className="rounded-md border border-card-border border-t-card-border-top bg-card/60 px-3 py-3 shadow-card-bevel">
      <div className="flex items-start gap-2">
        <FolderSearch className="mt-0.5 h-4 w-4 shrink-0 text-brand" strokeWidth={1.5} />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-stat-title">
            Found {summary} in{' '}
            <span className="break-all font-mono text-xs text-stat-value">{dir}</span>
          </p>
          {adoptCandidateCount > 0 && onReview ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="mt-3"
              onClick={onReview}
            >
              Review discovered files
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
