import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, FileBox } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';

/** Backend projections of the managed-project manifest (types/gitProjectManifest.ts). */
export interface ManifestSummary {
  state: 'none' | 'migrated' | 'active' | 'partial' | 'unsupported' | 'migration_required' | 'absent';
  manifestVersion: number;
  resolvedCommitSha: string | null;
  managedCount: number;
  unmanagedCount: number;
  refusedCount: number;
  refused: Array<{ sourcePath: string | null; kind: string; reason: string; actionable: boolean }>;
  hasBuildContexts: boolean;
  generatedAt: number | null;
}

/** Public manifest projection served by the manifest endpoint (no hashes, sensitive paths redacted). */
interface ManifestInput {
  /** Display label; null for high-sensitivity inputs whose path is redacted. */
  path: string | null;
  role: string;
  dependencyKind: string;
  ownership: 'managed' | 'unmanaged';
  sensitivity: 'high' | 'medium' | 'low';
  state: 'present' | 'tombstoned';
  note: string | null;
}

interface GitManifest {
  manifestVersion: number;
  state: string;
  inputs: ManifestInput[];
}

const LIST_CAP = 200;

const STATE_LABEL: Record<string, string> = {
  none: 'Unmanaged',
  migrated: 'Migrated',
  active: 'Active',
  partial: 'Partial',
  unsupported: 'Unsupported',
  migration_required: 'Migration required',
  absent: 'Not materialized',
};

function stateVariant(state: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (state === 'migration_required' || state === 'unsupported') return 'destructive';
  if (state === 'active' || state === 'migrated') return 'default';
  return 'secondary';
}

interface GitManifestSummaryProps {
  stackName: string;
  summary: ManifestSummary | null;
}

/**
 * Managed-project manifest summary for a Git-sourced stack: pinned revision,
 * input counts, and the materialized-file inventory. The full manifest is
 * fetched lazily, only when the section is expanded, to keep the panel light.
 */
export function GitManifestSummary({ stackName, summary }: GitManifestSummaryProps) {
  const [expanded, setExpanded] = useState(false);
  const [manifest, setManifest] = useState<GitManifest | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One fetch attempt per mount: a failed request must not re-trigger the
  // effect (loading flipping false would otherwise loop forever). The attempt
  // flag flips only in the fetch's finally, so the effect never refires on the
  // loading state; retrying is an explicit user action.
  const [attempted, setAttempted] = useState(false);

  useEffect(() => {
    if (!expanded || manifest !== null || attempted) return;
    setLoading(true);
    setError(null);
    apiFetch(`/stacks/${encodeURIComponent(stackName)}/git-source/manifest`)
      .then(async (res) => {
        if (res.ok) {
          const data = (await res.json()) as { manifest: GitManifest };
          setManifest(data.manifest);
        } else {
          setError('Could not load the managed-project manifest.');
        }
      })
      .catch(() => setError('Could not load the managed-project manifest.'))
      .finally(() => {
        setLoading(false);
        setAttempted(true);
      });
  }, [expanded, manifest, attempted, stackName]);

  if (!summary) return null;

  const state = summary.state;
  const shownInputs = manifest ? manifest.inputs.slice(0, LIST_CAP) : [];
  const visibleCount = manifest?.inputs.length ?? 0;

  return (
    <div className="rounded-md border border-glass-border bg-muted/30 shadow-card-bevel">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[11px] text-stat-subtitle"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="flex items-center gap-1.5 font-medium text-foreground/80">
          {expanded ? <ChevronDown className="w-3.5 h-3.5" strokeWidth={1.5} /> : <ChevronRight className="w-3.5 h-3.5" strokeWidth={1.5} />}
          <FileBox className="w-3.5 h-3.5" strokeWidth={1.5} />
          Managed project
        </span>
        <span className="flex items-center gap-2">
          {summary.resolvedCommitSha && (
            <span className="font-mono tabular-nums">{summary.resolvedCommitSha.slice(0, 7)}</span>
          )}
          <Badge variant={stateVariant(state)} className="px-1.5 py-0 text-[10px]">
            {STATE_LABEL[state] ?? state}
          </Badge>
        </span>
      </button>

      {expanded && (
        <div className="border-t border-glass-border px-3 py-2.5 space-y-2.5 text-[11px]">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-stat-subtitle">
            <span>
              <span className="font-medium text-foreground/80">{summary.managedCount}</span> managed
            </span>
            <span>
              <span className="font-medium text-foreground/80">{summary.unmanagedCount}</span> unmanaged
            </span>
            <span>
              <span className="font-medium text-foreground/80">{summary.refusedCount}</span> refused
            </span>
            {summary.hasBuildContexts && <span>build contexts</span>}
            <span>
              manifest v{summary.manifestVersion}
            </span>
          </div>

          {state === 'migrated' && (
            <p className="text-stat-subtitle">
              This project was adopted from the previous Git-source format. Pull once to rebuild the
              complete inventory from the repository.
            </p>
          )}
          {state === 'migration_required' && (
            <p className="text-destructive/90">
              The managed-project manifest cannot be trusted. Pull now to rebuild it before applying changes.
            </p>
          )}

          {loading && <p className="text-stat-subtitle">Loading inventory...</p>}
          {error && !loading && (
            <div className="flex items-center justify-between gap-2">
              <p className="text-destructive/90">{error}</p>
              <button
                type="button"
                className="text-[11px] font-medium text-primary underline-offset-2 hover:underline"
                onClick={() => {
                  setAttempted(false);
                  setError(null);
                }}
              >
                Retry
              </button>
            </div>
          )}

          {manifest && (
            <>
              <div className="space-y-1">
                {shownInputs.map((input, i) => (
                  <div key={i} className="flex items-center justify-between gap-2">
                    <span className="font-mono truncate" title={input.note ?? undefined}>
                      {input.path ?? input.dependencyKind}
                    </span>
                    <span className="flex items-center gap-1.5 shrink-0">
                      <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal">
                        {input.dependencyKind}
                      </Badge>
                      <Badge
                        variant={input.ownership === 'managed' ? 'secondary' : 'outline'}
                        className={cn('px-1.5 py-0 text-[10px] font-normal', input.state === 'tombstoned' && 'opacity-50 line-through')}
                      >
                        {input.state === 'tombstoned' ? 'removed' : input.ownership}
                      </Badge>
                    </span>
                  </div>
                ))}
              </div>
              {visibleCount > LIST_CAP && (
                <p className="text-stat-subtitle">Showing {LIST_CAP} of {visibleCount} inputs.</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
