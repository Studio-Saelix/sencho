import { useCallback, useEffect, useState } from 'react';
import { FolderSearch, Plus, Layers, RefreshCw, Loader2, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import type { StacksDiscoveryResponse } from '@/lib/discovery-types';
import { Skeleton } from '@/components/ui/skeleton';

export interface DiscoveryEmptyStateProps {
  onOpenAdopt?: () => void;
  onOpenCreate?: () => void;
  onScan?: () => void;
  canCreate?: boolean;
  activeNodeId?: number | null;
}

export function DiscoveryEmptyState({
  onOpenAdopt,
  onOpenCreate,
  onScan,
  canCreate = false,
  activeNodeId,
}: DiscoveryEmptyStateProps) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<StacksDiscoveryResponse | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/stacks/discovery');
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string })?.error || 'Failed to load compose discovery.');
      }
      setData((await res.json()) as StacksDiscoveryResponse);
    } catch (e: unknown) {
      console.error('Failed to load compose discovery:', e);
      toast.error((e as Error)?.message || 'Failed to load compose discovery.');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, activeNodeId]);

  if (loading && !data) {
    return (
      <div className="px-3 py-8">
        <Skeleton className="mx-auto h-6 w-6 rounded-full" />
        <Skeleton className="mx-auto mt-3 h-4 w-28" />
        <Skeleton className="mx-auto mt-2 h-3 w-40" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="px-3 py-8 text-center">
        <AlertCircle className="mx-auto h-6 w-6 text-stat-icon" strokeWidth={1.5} />
        <p className="mt-3 text-sm text-stat-title">Discovery unavailable</p>
        <Button size="sm" variant="outline" className="mt-4" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1.5 h-4 w-4" />}
          Retry
        </Button>
      </div>
    );
  }

  const { composeDir, readable, discovery, error } = data;

  if (!readable) {
    return (
      <div className="px-3 py-8 text-center">
        <AlertCircle className="mx-auto h-6 w-6 text-warning" strokeWidth={1.5} />
        <p className="mt-3 text-sm text-stat-title">Could not read compose directory</p>
        <p className="mx-auto mt-1 max-w-[220px] break-all font-mono text-xs text-stat-value">{composeDir}</p>
        {error ? (
          <p className="mx-auto mt-2 max-w-[220px] text-xs leading-relaxed text-stat-subtitle">{error}</p>
        ) : null}
      </div>
    );
  }

  const stackCount = discovery?.stackCount ?? 0;
  const adoptCount = discovery?.adoptCandidateCount ?? 0;
  const truncated = discovery?.adoptCandidatesTruncated ?? false;
  const hasAdopt = adoptCount > 0;

  if (hasAdopt) {
    return (
      <div className="px-3 py-8 text-center">
        <FolderSearch className="mx-auto h-6 w-6 text-brand" strokeWidth={1.5} />
        <p className="mt-3 text-sm text-stat-title">
          {adoptCount}
          {truncated ? '+' : ''} compose file{adoptCount === 1 && !truncated ? '' : 's'} to adopt
        </p>
        <p className="mx-auto mt-1 max-w-[220px] break-all font-mono text-xs text-stat-value">{composeDir}</p>
        {stackCount > 0 ? (
          <p className="mx-auto mt-1 max-w-[220px] text-xs text-stat-subtitle">
            {stackCount} stack{stackCount === 1 ? '' : 's'} already in place
          </p>
        ) : null}
        {onOpenAdopt ? (
          <Button size="sm" className="mt-4 w-full" onClick={onOpenAdopt}>
            <FolderSearch className="mr-1.5 h-4 w-4" strokeWidth={1.5} />
            Adopt existing files
          </Button>
        ) : null}
        {canCreate && onOpenCreate ? (
          <Button size="sm" variant="outline" className="mt-2 w-full" onClick={onOpenCreate}>
            <Plus className="mr-1.5 h-4 w-4" strokeWidth={1.5} />
            New stack
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="px-3 py-8 text-center">
      <Layers className="mx-auto h-6 w-6 text-stat-icon" strokeWidth={1.5} />
      <p className="mt-3 text-sm text-stat-title">No compose projects yet</p>
      <p className="mx-auto mt-1 max-w-[220px] break-all font-mono text-xs text-stat-value">{composeDir}</p>
      <p className="mx-auto mt-1 max-w-[200px] text-xs leading-relaxed text-stat-subtitle">
        Drop compose files here or create a stack from scratch.
      </p>
      <div className="mt-4 flex flex-col gap-2">
        {canCreate && onOpenCreate ? (
          <Button size="sm" className="w-full" onClick={onOpenCreate}>
            <Plus className="mr-1.5 h-4 w-4" strokeWidth={1.5} />
            New stack
          </Button>
        ) : null}
        {onScan ? (
          <Button size="sm" variant="outline" className="w-full" onClick={onScan}>
            <RefreshCw className="mr-1.5 h-4 w-4" strokeWidth={1.5} />
            Scan stacks folder
          </Button>
        ) : null}
      </div>
    </div>
  );
}
