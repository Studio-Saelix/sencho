import { useEffect, useState } from 'react';
import {
  Check, TriangleAlert, Info, MapPin, HelpCircle, HardDrive, type LucideIcon,
} from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast-store';
import { formatTimeAgo } from '@/lib/relativeTime';
import { useNodes } from '@/context/NodeContext';
import { useAuth } from '@/context/AuthContext';
import { SENCHO_NAVIGATE_EVENT, type SenchoNavigateDetail } from '@/components/NodeManager';

// Mirrors the backend /storage payload (the frontend never imports backend).
type PortabilityStatus = 'portable' | 'partially-portable' | 'node-bound' | 'unknown';
type MountType = 'bind' | 'named' | 'anonymous' | 'tmpfs';
type HostPathKind = 'file' | 'directory' | 'socket' | 'symlink' | 'missing' | 'unknown';

interface HostPathProbe {
  lexicalWithinStackDir: boolean;
  withinStackDir: boolean;
  exists: boolean;
  kind: HostPathKind;
  escapes: boolean;
  uid: number | null;
  gid: number | null;
  mode: string | null;
}
interface StorageMount {
  service: string;
  type: MountType;
  source?: string;
  target: string;
  readOnly: boolean;
  probe: HostPathProbe | null;
  externalNamed: boolean;
}
interface StorageInventory {
  stack: string;
  renderable: boolean;
  renderError: string | null;
  stateful: boolean;
  mounts: StorageMount[];
  portability: { status: PortabilityStatus; reasons: string[] };
}

const RECENT_SNAPSHOT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const LABEL_CLASS = 'font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle';
const CARD_CLASS = 'rounded-lg border px-3 py-2.5';
const CHIP_CLASS = 'rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide';

const STATUS_META: Record<PortabilityStatus, { label: string; tone: string; icon: LucideIcon }> = {
  'portable': { label: 'portable', tone: 'border-success/40 bg-success/[0.06] text-success', icon: Check },
  'partially-portable': { label: 'partially portable', tone: 'border-info/40 bg-info/[0.06] text-info', icon: Info },
  'node-bound': { label: 'node-bound', tone: 'border-warning/40 bg-warning/[0.06] text-warning', icon: MapPin },
  'unknown': { label: 'unknown', tone: 'border-muted bg-card/40 text-stat-subtitle', icon: HelpCircle },
};

const isSocketMount = (m: StorageMount): boolean =>
  (m.source?.includes('docker.sock') ?? false) || m.target.includes('docker.sock');

function mountTypeLabel(m: StorageMount): string {
  if (isSocketMount(m)) return 'socket';
  return m.type;
}

/** A short host-path status for a bind, or null for non-bind mounts. */
function bindStatus(m: StorageMount): string | null {
  if (m.type !== 'bind' || !m.probe) return null;
  const p = m.probe;
  if (!p.lexicalWithinStackDir) return 'external';
  if (p.escapes) return 'symlink escapes';
  if (!p.exists) return 'missing';
  return p.kind;
}

function MountRow({ mount }: { mount: StorageMount }) {
  const status = bindStatus(mount);
  const owner = mount.probe && mount.probe.uid !== null
    ? `uid ${mount.probe.uid}${mount.probe.gid !== null ? `:${mount.probe.gid}` : ''}`
    : null;
  return (
    <div className="border-t border-muted py-2 first:border-t-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={cn(CHIP_CLASS, 'bg-brand/15 text-brand')}>{mountTypeLabel(mount)}</span>
        <span className={cn(CHIP_CLASS, mount.readOnly ? 'bg-info/15 text-info' : 'bg-muted text-stat-subtitle')}>
          {mount.readOnly ? 'ro' : 'rw'}
        </span>
        {mount.externalNamed && <span className={cn(CHIP_CLASS, 'bg-warning/15 text-warning')}>external</span>}
        {status && <span className="font-mono text-[10px] text-stat-subtitle">{status}</span>}
        {owner && <span className="font-mono text-[10px] text-stat-subtitle">· {owner}</span>}
      </div>
      <div className="mt-1 min-w-0 font-mono text-[11px] text-foreground/90">
        {mount.source && <span className="text-stat-subtitle">{mount.source} → </span>}
        <span>{mount.target}</span>
      </div>
    </div>
  );
}

export default function StoragePanel({ stackName }: { stackName: string }) {
  const { activeNode } = useNodes();
  const { isAdmin } = useAuth();
  const nodeId = activeNode?.id;

  const [inventory, setInventory] = useState<StorageInventory | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // Recency is computed in the effect (impure `Date.now` belongs there, not in render).
  const [snapshot, setSnapshot] = useState<{ at: number | null; recent: boolean }>({ at: null, recent: false });

  // Load the inventory when the stack or active node changes. Read-only.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoadError(false);
      try {
        const res = await apiFetch(`/stacks/${stackName}/storage`);
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(true);
          toast.error('Failed to load the storage inventory.');
          return;
        }
        setInventory((await res.json()) as StorageInventory);
        setLoadError(false);
      } catch {
        if (!cancelled) {
          setLoadError(true);
          toast.error('Failed to load the storage inventory.');
        }
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [stackName, nodeId, reloadKey]);

  // Snapshot coverage lives only in the hub database (admin-scoped), so it is
  // fetched with localOnly and merged client-side. Non-admins skip it and see
  // the static caveat only.
  useEffect(() => {
    if (!isAdmin || nodeId === undefined || nodeId === null) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await apiFetch(
          `/fleet/snapshots/coverage?nodeId=${nodeId}&stackName=${encodeURIComponent(stackName)}`,
          { localOnly: true, signal: controller.signal },
        );
        if (!res.ok) return;
        const data = await res.json();
        const at = typeof data?.latestAt === 'number' ? data.latestAt : null;
        setSnapshot({ at, recent: at !== null && Date.now() - at < RECENT_SNAPSHOT_WINDOW_MS });
      } catch {
        // Coverage is advisory; a failure simply leaves the warning unshown.
      }
    })();
    return () => controller.abort();
  }, [stackName, nodeId, isAdmin, reloadKey]);

  const showSnapshotWarning = isAdmin && inventory?.stateful === true && !snapshot.recent;

  const services = inventory ? [...new Set(inventory.mounts.map(m => m.service))] : [];

  return (
    <div data-testid="storage-panel" className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col gap-4">
      <span className={LABEL_CLASS}>storage portability</span>

      {loadError ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/[0.06] px-3 py-3">
          <span className="font-mono text-[11px] text-destructive">Could not load the storage inventory.</span>
          <button
            type="button"
            data-testid="storage-retry-btn"
            onClick={() => setReloadKey(k => k + 1)}
            className="font-mono text-[10px] uppercase tracking-wide text-destructive hover:underline"
          >
            retry
          </button>
        </div>
      ) : !inventory ? (
        <div className="py-3 font-mono text-[11px] text-stat-subtitle">Loading storage…</div>
      ) : !inventory.renderable ? (
        <div className={cn(CARD_CLASS, 'border-destructive/40 bg-destructive/[0.06] text-destructive')}>
          <div className="flex items-center gap-2">
            <TriangleAlert className="h-4 w-4 shrink-0" strokeWidth={1.5} />
            <span className="font-mono text-[11px] uppercase tracking-wide">cannot render</span>
          </div>
          <div className="mt-1 font-mono text-[11px] leading-relaxed text-foreground/80">
            {inventory.renderError ?? 'Sencho could not render the effective Compose model.'}
          </div>
        </div>
      ) : (
        <>
          <PortabilityCard portability={inventory.portability} />

          {inventory.mounts.length === 0 ? (
            <div className={cn(CARD_CLASS, 'border-muted bg-card/40 flex items-center gap-2 text-stat-subtitle')}>
              <HardDrive className="h-4 w-4" strokeWidth={1.5} />
              <span className="font-mono text-[11px]">This stack declares no mounts.</span>
            </div>
          ) : (
            services.map(service => (
              <section key={service} data-testid={`storage-service-${service}`}>
                <div className={cn(LABEL_CLASS, 'mb-1.5')}>{service}</div>
                <div className="rounded-lg border border-muted bg-card/40 px-3 py-1">
                  {inventory.mounts.filter(m => m.service === service).map((m, i) => (
                    <MountRow key={`${m.service}-${m.target}-${i}`} mount={m} />
                  ))}
                </div>
              </section>
            ))
          )}

          <section>
            <div className={cn(LABEL_CLASS, 'mb-1.5')}>snapshot coverage</div>
            {showSnapshotWarning && (
              <div data-testid="storage-snapshot-warning" className={cn(CARD_CLASS, 'mb-2 border-warning/40 bg-warning/[0.06] text-warning')}>
                <div className="flex items-center gap-2">
                  <TriangleAlert className="h-4 w-4 shrink-0" strokeWidth={1.5} />
                  <span className="text-[12px] leading-relaxed text-foreground/90">
                    This stack has persistent storage but no fleet snapshot in the last 7 days.
                  </span>
                </div>
                {activeNode?.type !== 'remote' && (
                  <button
                    type="button"
                    onClick={() => window.dispatchEvent(new CustomEvent<SenchoNavigateDetail>(SENCHO_NAVIGATE_EVENT, {
                      detail: { view: 'fleet', fleetTab: 'snapshots' },
                    }))}
                    className="mt-1.5 text-[12px] font-medium text-brand hover:underline"
                  >
                    Take a fleet snapshot →
                  </button>
                )}
              </div>
            )}
            {isAdmin && inventory.stateful && snapshot.recent && snapshot.at && (
              <div className="mb-2 font-mono text-[11px] text-stat-subtitle">
                Last fleet snapshot {formatTimeAgo(snapshot.at)}.
              </div>
            )}
            <div className="flex items-start gap-2 rounded-lg border border-muted bg-card/40 px-3 py-2 text-stat-subtitle">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.5} />
              <span className="text-[11px] leading-relaxed">
                Fleet snapshots capture Compose and env files, not the data inside named volumes or bind mounts. Back up volume data separately before moving or restoring.
              </span>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function PortabilityCard({ portability }: { portability: StorageInventory['portability'] }) {
  const meta = STATUS_META[portability.status] ?? STATUS_META.unknown;
  const Icon = meta.icon;
  return (
    <div data-testid="storage-portability" data-status={portability.status} className={cn(CARD_CLASS, meta.tone)}>
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 shrink-0" strokeWidth={1.5} />
        <span className="font-mono text-[11px] uppercase tracking-wide">{meta.label}</span>
      </div>
      {portability.reasons.length > 0 && (
        <ul className="mt-1.5 flex flex-col gap-1">
          {portability.reasons.map((r, i) => (
            <li key={i} className="text-[12px] leading-relaxed text-foreground/80">· {r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
