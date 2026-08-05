import { useEffect, useState } from 'react';
import { SystemSheet, SheetSection } from '@/components/ui/system-sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/components/ui/toast-store';
import { apiFetch } from '@/lib/api';
import { formatBytes } from '@/lib/utils';
import { copyToClipboard } from '@/lib/clipboard';
import { formatShortDigest } from '@/lib/formatDigest';
import { useAuth } from '@/context/AuthContext';
import { RegistryTagsPanel } from './RegistryTagsPanel';
import { Copy } from 'lucide-react';

interface ImageInspect {
  Id: string;
  RepoTags?: string[] | null;
  RepoDigests?: string[] | null;
  Created: string;
  Size: number;
  Architecture?: string;
  Os?: string;
  Author?: string;
  Config?: {
    Cmd?: string[] | null;
    Entrypoint?: string[] | null;
    WorkingDir?: string;
    User?: string;
    Env?: string[] | null;
    Labels?: Record<string, string> | null;
    ExposedPorts?: Record<string, unknown> | null;
  };
  RootFS?: { Type?: string; Layers?: string[] };
}

interface ImageHistoryEntry {
  Id: string;
  Created: number;
  CreatedBy: string;
  Tags?: string[] | null;
  Size: number;
  Comment?: string;
}

interface ImageDetails {
  inspect: ImageInspect;
  history: ImageHistoryEntry[];
}

/** Node-bound image selection (Resources row or stack-container inspect). */
export interface ClassifiedImageSelection {
  Id: string;
  RepoTags: string[];
  Size?: number;
  Containers?: number;
  usedByStacks: string[];
  managedBy?: string | null;
  managedStatus?: 'managed' | 'unmanaged' | 'unused';
  isSencho?: boolean;
  nodeId: string | number;
}

interface ImageDetailsSheetProps {
  image: ClassifiedImageSelection | null;
  onClose: () => void;
  onOpenStack?: (stack: string) => void;
  /** Optional breadcrumb. Defaults to Resources / Images / {image name}. */
  crumb?: string[];
}

function formatRelativeAge(timestampSec: number): string {
  const now = Date.now() / 1000;
  const diff = now - timestampSec;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))}mo ago`;
  return `${Math.floor(diff / (86400 * 365))}y ago`;
}

export function ImageDetailsSheet({ image, onClose, onOpenStack, crumb }: ImageDetailsSheetProps) {
  const imageId = image?.Id ?? null;
  const { isAdmin } = useAuth();
  const [data, setData] = useState<ImageDetails | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!imageId) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setData(null);

    apiFetch(`/system/images/${encodeURIComponent(imageId)}`)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(res.status === 404 ? 'Image not found.' : 'Failed to load image details.');
        }
        return res.json() as Promise<ImageDetails>;
      })
      .then((details) => {
        if (!cancelled) setData(details);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : 'Failed to load image details.';
        toast.error(msg);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [imageId]);

  const inspect = data?.inspect;
  const history = data?.history ?? [];
  const totalLayers = history.length;

  const name = image?.RepoTags?.[0]
    || inspect?.RepoTags?.[0]
    || (inspect ? formatShortDigest(inspect.Id) : (imageId ? formatShortDigest(imageId) : 'Image details'));
  let meta = '';
  if (inspect) {
    meta = `${formatBytes(inspect.Size)} · ${inspect.Architecture ?? '?'}/${inspect.Os ?? '?'} · ${totalLayers} layers`;
  } else if (loading) {
    meta = 'Loading…';
  } else if (image?.Size != null) {
    meta = formatBytes(image.Size);
  }

  const footerContext = inspect?.Created
    ? `Created ${formatRelativeAge(new Date(inspect.Created).getTime() / 1000)}`
    : undefined;

  return (
    <SystemSheet
      open={!!image}
      onOpenChange={(open) => !open && onClose()}
      crumb={crumb ?? ['Resources', 'Images', name]}
      name={name}
      meta={meta}
      footerContext={footerContext}
      size="md"
    >
      {loading && (
        <div className="space-y-3">
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-3/4" />
        </div>
      )}

      {image && (
        <SheetSection title="Used by">
          {(image.usedByStacks?.length ?? 0) === 0 ? (
            <p className="text-xs text-muted-foreground">
              {image.managedStatus === 'unused' ? 'No containers' : 'Not used by a Sencho stack'}
            </p>
          ) : (
            <div className="flex flex-wrap gap-1">
              {image.usedByStacks.map((stack) => (
                onOpenStack ? (
                  <button
                    key={stack}
                    type="button"
                    className="inline-flex items-center px-1.5 py-0.5 rounded border border-success/25 bg-success/8 text-success text-[10px] font-medium hover:bg-success/15 transition-colors"
                    onClick={() => onOpenStack(stack)}
                  >
                    {stack}
                  </button>
                ) : (
                  <Badge key={stack} variant="outline" className="text-[10px] h-5">{stack}</Badge>
                )
              ))}
            </div>
          )}
        </SheetSection>
      )}

      {!loading && inspect && (
        <>
          <SheetSection title="Overview">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <Field label="ID">
                <p className="font-mono text-xs mt-0.5 flex items-center gap-1.5">
                  {formatShortDigest(inspect.Id)}
                  <button
                    className="text-muted-foreground hover:text-foreground transition-colors"
                    onClick={async () => {
                      try { await copyToClipboard(inspect.Id); toast.success('ID copied'); }
                      catch { toast.error('Copy failed.'); }
                    }}
                    aria-label="Copy image ID"
                  >
                    <Copy className="w-3 h-3" strokeWidth={1.5} />
                  </button>
                </p>
              </Field>
              <Field label="Size">
                <p className="font-mono text-xs mt-0.5 tabular-nums">{formatBytes(inspect.Size)}</p>
              </Field>
              <Field label="Created">
                <p className="text-xs mt-0.5" title={new Date(inspect.Created).toLocaleString()}>
                  {new Date(inspect.Created).toLocaleDateString()}
                </p>
              </Field>
              <Field label="Arch / OS">
                <p className="text-xs mt-0.5">
                  <Badge variant="outline" className="text-[10px] h-5">{inspect.Architecture ?? 'unknown'} / {inspect.Os ?? 'unknown'}</Badge>
                </p>
              </Field>
              {inspect.Author && (
                <Field label="Author" span={2}>
                  <p className="text-xs mt-0.5">{inspect.Author}</p>
                </Field>
              )}
              {inspect.RepoTags && inspect.RepoTags.length > 0 && (
                <Field label="Tags" span={2}>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {inspect.RepoTags.map((t) => (
                      <Badge key={t} variant="outline" className="text-[10px] h-5 font-mono">{t}</Badge>
                    ))}
                  </div>
                </Field>
              )}
            </div>
          </SheetSection>

          {inspect.Config && (
            <SheetSection title="Config">
              <div className="space-y-2 text-sm">
                <ConfigRow label="Cmd" value={inspect.Config.Cmd?.join(' ')} />
                <ConfigRow label="Entrypoint" value={inspect.Config.Entrypoint?.join(' ')} />
                <ConfigRow label="WorkingDir" value={inspect.Config.WorkingDir} />
                <ConfigRow label="User" value={inspect.Config.User} />
                <ConfigRow
                  label="Ports"
                  value={
                    inspect.Config.ExposedPorts
                      ? Object.keys(inspect.Config.ExposedPorts).join(', ')
                      : undefined
                  }
                />
                {inspect.Config.Env && inspect.Config.Env.length > 0 && (
                  <CollapsibleList label="Env" count={inspect.Config.Env.length} items={inspect.Config.Env} />
                )}
                {inspect.Config.Labels && Object.keys(inspect.Config.Labels).length > 0 && (
                  <CollapsibleList
                    label="Labels"
                    count={Object.keys(inspect.Config.Labels).length}
                    items={Object.entries(inspect.Config.Labels).map(([k, v]) => `${k}=${v}`)}
                  />
                )}
              </div>
            </SheetSection>
          )}

          <SheetSection title={`Layers · ${totalLayers}`}>
            {totalLayers === 0 ? (
              <p className="text-xs text-muted-foreground italic">No layer history available.</p>
            ) : (
              <ol className="divide-y divide-card-border/40">
                {history.map((h, idx) => {
                  const empty = h.Size === 0;
                  return (
                    <li
                      key={`${h.Id}-${idx}`}
                      className={`py-2 ${empty ? 'opacity-60' : ''}`}
                    >
                      <div className="flex items-baseline justify-between gap-3 text-[11px] text-muted-foreground tabular-nums">
                        <span>#{totalLayers - idx}</span>
                        <span className="font-mono">{formatBytes(h.Size)}</span>
                        <span>{formatRelativeAge(h.Created)}</span>
                      </div>
                      <p
                        className="font-mono text-[11px] mt-1 break-all"
                        title={h.CreatedBy}
                      >
                        {h.CreatedBy || '(no command)'}
                      </p>
                      {h.Comment && (
                        <p className="text-[11px] text-muted-foreground italic mt-0.5">{h.Comment}</p>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </SheetSection>

          <SheetSection title="Registry tags">
            <RegistryTagsPanel
              repoTags={inspect.RepoTags ?? image?.RepoTags ?? []}
              repoDigests={inspect.RepoDigests ?? []}
              nodeId={image?.nodeId ?? 0}
              isAdmin={isAdmin}
            />
          </SheetSection>
        </>
      )}
    </SystemSheet>
  );
}

function Field({ label, children, span }: { label: string; children: React.ReactNode; span?: 1 | 2 }) {
  return (
    <div className={span === 2 ? 'col-span-2' : undefined}>
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function ConfigRow({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="grid grid-cols-[100px_1fr] gap-3 items-baseline">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-mono text-[11px] break-all">{value}</span>
    </div>
  );
}

function CollapsibleList({ label, count, items }: { label: string; count: number; items: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="grid grid-cols-[100px_1fr] gap-3 items-baseline">
      <span className="text-xs text-muted-foreground">{label} ({count})</span>
      <div>
        <button
          className="text-[11px] text-muted-foreground hover:text-foreground transition-colors underline-offset-2 hover:underline"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? 'Collapse' : 'Expand'}
        </button>
        {open && (
          <ol className="mt-1.5 space-y-0.5">
            {items.map((item, i) => (
              <li key={i} className="font-mono text-[11px] break-all">{item}</li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
