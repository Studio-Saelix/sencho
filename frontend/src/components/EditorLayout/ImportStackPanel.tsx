import { useCallback, useEffect, useState } from 'react';
import {
  FolderSearch,
  Loader2,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  ArrowUpRight,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react';
import { ModalBody, ModalFooter } from '../ui/modal';
import { Button } from '../ui/button';
import { ScrollArea } from '../ui/scroll-area';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';

interface ServicePreview {
  name: string;
  image?: string;
  ports: string[];
  volumes: string[];
  envFiles: string[];
}

interface ImportCandidate {
  name: string;
  composeFile: string;
  location: string;
  status: 'listed' | 'loose-root' | 'nested';
  services: ServicePreview[];
  warnings: string[];
  parseError?: string;
}

interface ImportScanResponse {
  composeDir: string;
  candidates: ImportCandidate[];
}

export interface ImportStackPanelProps {
  onClose: () => void;
  // Navigate to an already-listed stack (it is already in the sidebar).
  onOpenStack: (name: string) => void;
}

// Join a host compose-dir path with extra segments for display only. The dir is
// the host path as the node reports it, so a plain "/" join reads correctly.
function joinPath(base: string, ...segments: string[]): string {
  const trimmed = base.replace(/[/\\]+$/, '');
  return [trimmed, ...segments].join('/');
}

export function ImportStackPanel({ onClose, onOpenStack }: ImportStackPanelProps) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<ImportScanResponse | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const scan = useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiFetch('/stacks/import/scan');
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error((body as { error?: string })?.error || 'Failed to scan the compose directory.');
      }
      setData((await response.json()) as ImportScanResponse);
    } catch (error) {
      console.error('Failed to scan compose directory:', error);
      toast.error((error as Error).message || 'Failed to scan the compose directory.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void scan();
  }, [scan]);

  const toggle = (location: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(location)) next.delete(location);
      else next.add(location);
      return next;
    });
  };

  const composeDir = data?.composeDir ?? '';
  const candidates = data?.candidates ?? [];

  return (
    <>
      <ScrollArea block className="max-h-[60vh]">
        <ModalBody>
          <div className="rounded-md border border-card-border border-t-card-border-top bg-card/60 px-3 py-2.5 shadow-card-bevel">
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">
              Sencho looks for stacks in
            </div>
            <div className="mt-1 break-all font-mono text-xs text-stat-value">{composeDir || '—'}</div>
            <p className="mt-2 text-xs leading-relaxed text-stat-subtitle">
              Each stack lives in its own subfolder here. Keep the host mount path the same as the
              path inside the container so relative volumes resolve (the 1:1 path rule).{' '}
              <a
                href="https://docs.sencho.io/getting-started/configuration"
                target="_blank"
                rel="noreferrer"
                className="text-brand hover:underline"
              >
                Learn more
              </a>
            </p>
          </div>

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-stat-subtitle">
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} />
              Scanning…
            </div>
          ) : candidates.length === 0 ? (
            <div className="py-10 text-center">
              <FolderSearch className="mx-auto h-6 w-6 text-stat-icon" strokeWidth={1.5} />
              <p className="mt-3 text-sm text-stat-title">No compose files found.</p>
              <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-stat-subtitle">
                Put each stack in its own subfolder inside the compose directory, then rescan. Or
                pick another source above to create one from scratch.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {candidates.map((c) => (
                <CandidateCard
                  key={c.location}
                  candidate={c}
                  composeDir={composeDir}
                  expanded={expanded.has(c.location)}
                  onToggle={() => toggle(c.location)}
                  onOpenStack={(name) => {
                    onClose();
                    onOpenStack(name);
                  }}
                />
              ))}
            </div>
          )}
        </ModalBody>
      </ScrollArea>
      <ModalFooter
        hint="READ ONLY · NO FILES CHANGED"
        secondary={
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        }
        primary={
          <Button onClick={() => void scan()} disabled={loading}>
            {loading ? (
              <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" strokeWidth={1.5} />Scanning</>
            ) : (
              <><RefreshCw className="mr-1.5 h-4 w-4" strokeWidth={1.5} />Rescan</>
            )}
          </Button>
        }
      />
    </>
  );
}

function CandidateCard({
  candidate,
  composeDir,
  expanded,
  onToggle,
  onOpenStack,
}: {
  candidate: ImportCandidate;
  composeDir: string;
  expanded: boolean;
  onToggle: () => void;
  onOpenStack: (name: string) => void;
}) {
  const { name, composeFile, location, status, services, warnings, parseError } = candidate;
  const displayName = name || '<name>';
  const target = joinPath(composeDir, displayName, composeFile);

  return (
    <div className="rounded-md border border-card-border border-t-card-border-top bg-card shadow-card-bevel">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-stat-icon" strokeWidth={1.5} />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-stat-icon" strokeWidth={1.5} />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-sm text-stat-value">{displayName}</span>
          <span className="block truncate font-mono text-[10px] text-stat-subtitle">{location}</span>
        </span>
        <StatusBadge status={status} />
      </button>

      {expanded && (
        <div className="border-t border-card-border/60 px-3 py-2.5 space-y-2.5">
          {status === 'listed' ? (
            <button
              type="button"
              onClick={() => onOpenStack(name)}
              className="inline-flex items-center gap-1.5 text-xs text-brand hover:underline"
            >
              Open in sidebar
              <ArrowUpRight className="h-3 w-3" strokeWidth={1.5} />
            </button>
          ) : (
            <div className="flex gap-2 rounded-md border border-warning/30 bg-warning/5 px-2.5 py-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" strokeWidth={1.5} />
              <div className="text-xs leading-relaxed text-stat-subtitle">
                Not in its own subfolder, so it will not show as a stack. Move it to{' '}
                <span className="break-all font-mono text-stat-value">{target}</span>, then rescan.
              </div>
            </div>
          )}

          {parseError ? (
            <p className="font-mono text-[11px] text-destructive">{parseError}</p>
          ) : (
            <ServiceList services={services} />
          )}

          {warnings.map((w) => (
            <p key={w} className="text-[11px] leading-relaxed text-warning">{w}</p>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: ImportCandidate['status'] }) {
  if (status === 'listed') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[10px] uppercase tracking-[0.12em] text-success">
        <CheckCircle2 className="h-3 w-3" strokeWidth={1.5} />
        In sidebar
      </span>
    );
  }
  return (
    <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-warning">
      Needs move
    </span>
  );
}

function ServiceList({ services }: { services: ServicePreview[] }) {
  if (services.length === 0) {
    return <p className="font-mono text-[11px] text-stat-subtitle">No services to preview.</p>;
  }
  return (
    <div className="space-y-2">
      {services.map((svc) => (
        <div key={svc.name} className="font-mono text-[11px] leading-relaxed">
          <div className="text-stat-value">
            {svc.name}
            {svc.image ? <span className="text-stat-subtitle"> · {svc.image}</span> : null}
          </div>
          <MetaRow label="ports" values={svc.ports} />
          <MetaRow label="volumes" values={svc.volumes} />
          <MetaRow label="env" values={svc.envFiles} />
        </div>
      ))}
    </div>
  );
}

function MetaRow({ label, values }: { label: string; values: string[] }) {
  if (values.length === 0) return null;
  return (
    <div className="flex gap-2 text-stat-subtitle">
      <span className="w-12 shrink-0 text-stat-icon">{label}</span>
      <span className="min-w-0 flex-1 break-all">{values.join('  ·  ')}</span>
    </div>
  );
}
