import { useEffect, useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
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
        const body = await res.json() as NetworkingEnvelope & { network: SanitizedNetworkInspect };
        if (!cancelled) setDetail(body.network);
      } catch {
        if (!cancelled) toast.error('Failed to load network details.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [networkId]);

  return (
    <Sheet open={networkId !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{detail?.name ?? 'Network'}</SheetTitle>
        </SheetHeader>
        {loading && <p className="mt-4 text-sm text-muted-foreground">Loading…</p>}
        {runtimeUnavailable && (
          <p className="mt-4 text-sm text-warning">
            Docker runtime is unavailable, so this network cannot be inspected.
          </p>
        )}
        {detail && (
          <dl className="mt-4 space-y-3 text-sm">
            <div><dt className="text-stat-subtitle">Driver</dt><dd>{detail.driver}</dd></div>
            <div><dt className="text-stat-subtitle">Scope</dt><dd>{detail.scope}</dd></div>
            <div><dt className="text-stat-subtitle">Connected</dt><dd>{detail.connectedCount}</dd></div>
            <div><dt className="text-stat-subtitle">Stack</dt><dd>{detail.stack ?? 'none'}</dd></div>
            <div><dt className="text-stat-subtitle">Compose project</dt><dd>{detail.composeProject ?? 'none'}</dd></div>
            <div>
              <dt className="text-stat-subtitle">Label keys</dt>
              <dd className="font-mono text-xs">{detail.labelKeys.length ? detail.labelKeys.join(', ') : 'none'}</dd>
            </div>
            <div>
              <dt className="text-stat-subtitle">Subnets</dt>
              <dd className="font-mono text-xs">{detail.subnets.length ? detail.subnets.join(', ') : 'none'}</dd>
            </div>
          </dl>
        )}
      </SheetContent>
    </Sheet>
  );
}
