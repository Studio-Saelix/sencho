import { useCallback, useEffect, useState } from 'react';
import {
  FolderSearch,
  Loader2,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  FolderInput,
} from 'lucide-react';
import { ModalBody, ModalFooter } from '../ui/modal';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { ScrollArea } from '../ui/scroll-area';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { useAuth } from '@/context/AuthContext';

// Mirrors backend isValidStackName so the move button stays disabled until the
// name the backend would accept; the backend remains authoritative.
const VALID_STACK_NAME = /^[a-zA-Z0-9_-]+$/;

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
  status: 'loose-root' | 'nested';
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
  // Refresh the sidebar stack list after a file is moved into place, so the
  // newly imported stack shows up without closing the modal.
  onImported: () => void;
}

// Join a host compose-dir path with extra segments for display only. The dir is
// the host path as the node reports it, so a plain "/" join reads correctly.
function joinPath(base: string, ...segments: string[]): string {
  const trimmed = base.replace(/[/\\]+$/, '');
  return [trimmed, ...segments].join('/');
}

export function ImportStackPanel({ onClose, onImported }: ImportStackPanelProps) {
  const { can } = useAuth();
  const canCreate = can('stack:create');
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<ImportScanResponse | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [movingLocation, setMovingLocation] = useState<string | null>(null);

  // `announce` toasts an empty result. The button-driven rescan keeps the
  // existing list on screen (no full-panel swap), so without this the user has
  // no signal that a scan that found nothing actually ran.
  const scan = useCallback(async (opts?: { announce?: boolean }) => {
    setLoading(true);
    try {
      const response = await apiFetch('/stacks/import/scan');
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error((body as { error?: string })?.error || 'Failed to scan the compose directory.');
      }
      const parsed = (await response.json()) as ImportScanResponse;
      setData(parsed);
      if (opts?.announce && parsed.candidates.length === 0) {
        toast.info('No compose files to import.');
      }
    } catch (error) {
      console.error('Failed to scan compose directory:', error);
      toast.error((error as Error).message || 'Failed to scan the compose directory.');
    } finally {
      setLoading(false);
    }
  }, []);

  const move = useCallback(async (location: string, name: string) => {
    setMovingLocation(location);
    try {
      const response = await apiFetch('/stacks/import/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location, name }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error((body as { error?: string })?.error || 'Failed to move the compose file into place.');
      }
      const result = (await response.json().catch(() => ({}))) as { name?: unknown };
      const importedName = typeof result.name === 'string' ? result.name : name;
      toast.success(`Imported "${importedName}".`);
      // Refresh both surfaces: the import list drops the now-placed file, and the
      // sidebar picks up the new stack.
      onImported();
      await scan();
    } catch (error) {
      console.error('Failed to move compose file into place:', error);
      toast.error((error as Error).message || 'Failed to move the compose file into place.');
    } finally {
      setMovingLocation(null);
    }
  }, [scan, onImported]);

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

          {loading && !data ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-stat-subtitle">
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} />
              Scanning…
            </div>
          ) : candidates.length === 0 ? (
            <div className="py-10 text-center">
              <FolderSearch className="mx-auto h-6 w-6 text-stat-icon" strokeWidth={1.5} />
              <p className="mt-3 text-sm text-stat-title">No compose files to import.</p>
              <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-stat-subtitle">
                Stacks already in their own subfolder show up in the sidebar. Drop a loose compose
                file in the compose directory and rescan, or pick another source above to create one.
              </p>
            </div>
          ) : (
            // Keep the list mounted during a rescan (only the Rescan button
            // animates) so the modal does not change height. aria-busy + the
            // dimmed, click-blocked cue (opacity + pointer-events-none) signal
            // the in-flight scan without a layout swap.
            <div
              className={`space-y-2${loading ? ' pointer-events-none opacity-60' : ''}`}
              aria-busy={loading}
            >
              {candidates.map((c) => (
                <CandidateCard
                  key={c.location}
                  candidate={c}
                  composeDir={composeDir}
                  expanded={expanded.has(c.location)}
                  canCreate={canCreate}
                  moving={movingLocation === c.location}
                  onToggle={() => toggle(c.location)}
                  onMove={(name) => void move(c.location, name)}
                />
              ))}
            </div>
          )}
        </ModalBody>
      </ScrollArea>
      <ModalFooter
        hint="SCAN IS READ ONLY · MOVING ASKS FIRST"
        secondary={
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        }
        primary={
          <Button onClick={() => void scan({ announce: true })} disabled={loading}>
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
  canCreate,
  moving,
  onToggle,
  onMove,
}: {
  candidate: ImportCandidate;
  composeDir: string;
  expanded: boolean;
  canCreate: boolean;
  moving: boolean;
  onToggle: () => void;
  onMove: (name: string) => void;
}) {
  const { name, composeFile, location, status, services, warnings, parseError } = candidate;
  // Prefill the destination name: a nested stack already has a folder name worth
  // keeping; a loose root file has none to derive, so the user supplies one.
  const [destName, setDestName] = useState(status === 'nested' ? name : '');
  const [confirming, setConfirming] = useState(false);
  const trimmedName = destName.trim();
  const nameValid = VALID_STACK_NAME.test(trimmedName);
  const displayName = name || '<name>';
  const target = joinPath(composeDir, trimmedName || displayName, composeFile);

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
        <StatusBadge />
      </button>

      {expanded && (
        <div className="border-t border-card-border/60 px-3 py-2.5 space-y-2.5">
          <div className="flex gap-2 rounded-md border border-warning/30 bg-warning/5 px-2.5 py-2">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" strokeWidth={1.5} />
            <div className="text-xs leading-relaxed text-stat-subtitle">
              Not in its own subfolder, so it will not show as a stack.{' '}
              {canCreate ? (
                'Move it into place below, or arrange it by hand and rescan.'
              ) : (
                <>
                  Move it to <span className="break-all font-mono text-stat-value">{target}</span>, then
                  rescan.
                </>
              )}
            </div>
          </div>

          {canCreate && (
            <div className="space-y-2 rounded-md border border-card-border bg-card/60 px-2.5 py-2.5">
              <Input
                value={destName}
                onChange={(e) => {
                  setDestName(e.target.value);
                  setConfirming(false);
                }}
                placeholder={status === 'nested' ? name : 'Stack name (e.g., myapp)'}
                disabled={moving}
                aria-label="Destination stack name"
                className="font-mono text-xs"
              />
              <div className="break-all font-mono text-[10px] text-stat-subtitle">→ {target}</div>
              {status === 'loose-root' && (
                <p className="text-[10px] leading-relaxed text-stat-subtitle">
                  Only this file moves. Files it references by a relative path (like a root .env) stay
                  put.
                </p>
              )}
              {confirming ? (
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-[11px] text-stat-subtitle">Move it on disk?</span>
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={moving}>
                    Cancel
                  </Button>
                  <Button size="sm" onClick={() => onMove(trimmedName)} disabled={moving || !nameValid}>
                    {moving ? (
                      <>
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" strokeWidth={1.5} />
                        Moving
                      </>
                    ) : (
                      'Confirm move'
                    )}
                  </Button>
                </div>
              ) : (
                <Button size="sm" onClick={() => setConfirming(true)} disabled={moving || !nameValid}>
                  <FolderInput className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.5} />
                  Move into place
                </Button>
              )}
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

function StatusBadge() {
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
