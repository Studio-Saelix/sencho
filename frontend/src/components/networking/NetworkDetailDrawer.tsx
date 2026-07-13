import { useEffect, useState } from 'react';
import { SystemSheet, SheetSection } from '@/components/ui/system-sheet';
import { Badge } from '@/components/ui/badge';
import { Container } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import type { NetworkingEnvelope, SanitizedNetworkInspect } from '@/types/networking';

export function NetworkDetailDrawer({
  networkId,
  onClose,
}: {
  networkId: string | null;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<SanitizedNetworkInspect | null>(null);
  const [loading, setLoading] = useState(false);
  const [runtimeUnavailable, setRuntimeUnavailable] = useState(false);

  useEffect(() => {
    if (!networkId) {
      setDetail(null);
      setRuntimeUnavailable(false);
      return;
    }
    let cancelled = false;
    setDetail(null);
    setRuntimeUnavailable(false);
    const run = async () => {
      setLoading(true);
      try {
        const res = await apiFetch(`/networking/networks/${encodeURIComponent(networkId)}`);
        if (res.status === 503) {
          if (!cancelled) setRuntimeUnavailable(true);
          return;
        }
        if (!res.ok) throw new Error('inspect failed');
        const body = await res.json() as NetworkingEnvelope & { network: Partial<SanitizedNetworkInspect> };
        if (!cancelled) {
          setDetail({
            ...body.network,
            connectedContainers: body.network.connectedContainers ?? [],
          } as SanitizedNetworkInspect);
        }
      } catch {
        if (!cancelled) toast.error('Failed to load network details.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [networkId]);

  const containerCount = detail?.connectedContainers.length ?? detail?.connectedCount ?? 0;
  const meta = detail
    ? `${detail.driver} · ${detail.scope}${detail.subnets[0] ? ` · ${detail.subnets[0]}` : ''} · ${containerCount} container${containerCount === 1 ? '' : 's'}`
    : '';

  return (
    <SystemSheet
      open={networkId !== null}
      onOpenChange={(open) => { if (!open) onClose(); }}
      crumb={['Networking', 'Networks', detail?.name ?? '—']}
      name={detail?.name ?? 'Network'}
      meta={meta}
      size="md"
    >
      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {runtimeUnavailable && (
        <p className="text-sm text-warning">
          Docker runtime is unavailable, so this network cannot be inspected.
        </p>
      )}
      {detail && (
        <>
          <SheetSection title="Overview">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <div>
                <span className="text-xs text-muted-foreground">Driver</span>
                <span className="mt-0.5 block text-xs">
                  <Badge variant="outline" className="h-5 text-[10px]">{detail.driver}</Badge>
                </span>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Scope</span>
                <span className="mt-0.5 block text-xs">
                  <Badge variant="outline" className="h-5 text-[10px]">{detail.scope}</Badge>
                </span>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Internal</span>
                <p className="mt-0.5 text-xs">{detail.internal ? 'Yes' : 'No'}</p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Attachable</span>
                <p className="mt-0.5 text-xs">{detail.attachable ? 'Yes' : 'No'}</p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Stack</span>
                <p className="mt-0.5 text-xs">{detail.stack ?? 'none'}</p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Compose project</span>
                <p className="mt-0.5 text-xs">{detail.composeProject ?? 'none'}</p>
              </div>
              <div className="col-span-2">
                <span className="text-xs text-muted-foreground">Label keys</span>
                <p className="mt-0.5 font-mono text-xs">{detail.labelKeys.length ? detail.labelKeys.join(', ') : 'none'}</p>
              </div>
            </div>
          </SheetSection>

          {(detail.subnets.length > 0 || detail.gateways.length > 0) && (
            <SheetSection title="IPAM configuration">
              <div className="divide-y divide-card-border/40">
                {detail.subnets.map((subnet, i) => (
                  <div key={subnet} className="flex items-center justify-between gap-2 py-2">
                    <span className="text-xs text-muted-foreground">Subnet</span>
                    <span className="font-mono text-xs tabular-nums">{subnet}</span>
                    {detail.gateways[i] && (
                      <>
                        <span className="text-xs text-muted-foreground">Gateway</span>
                        <span className="font-mono text-xs tabular-nums">{detail.gateways[i]}</span>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </SheetSection>
          )}

          <SheetSection title="Connected" meta={`${containerCount} container${containerCount === 1 ? '' : 's'}`}>
            {containerCount === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">No containers connected to this network.</p>
            ) : (
              <div className="divide-y divide-card-border/40">
                {detail.connectedContainers.map((c) => (
                  <div key={c.name} className="space-y-1 py-2">
                    <div className="flex items-center gap-2">
                      <Container className="h-3.5 w-3.5 text-muted-foreground" strokeWidth={1.5} />
                      <span className="truncate text-sm font-medium">{c.name}</span>
                      {c.stack && <Badge variant="outline" className="h-4 px-1 font-mono text-[9px]">{c.stack}</Badge>}
                    </div>
                    <div className="grid grid-cols-2 gap-2 pl-5">
                      <div>
                        <span className="text-[10px] text-muted-foreground">Service</span>
                        <p className="font-mono text-xs">{c.service ?? 'none'}</p>
                      </div>
                      <div>
                        <span className="text-[10px] text-muted-foreground">IPv4</span>
                        <p className="font-mono text-xs tabular-nums">{c.ipv4 ?? 'N/A'}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SheetSection>
        </>
      )}
    </SystemSheet>
  );
}
