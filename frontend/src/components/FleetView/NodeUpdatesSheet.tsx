import { useState } from 'react';
import {
    Search, Loader2, Check, CircleCheck, CircleAlert, AlertTriangle,
    Download, RefreshCw, Monitor, Globe,
} from 'lucide-react';
import { SystemSheet, SheetSection } from '@/components/ui/system-sheet';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { formatVersion } from '@/lib/version';
import { UpdateStatusBadge } from './UpdateStatusBadge';
import type { NodeUpdateStatus } from './types';

interface NodeUpdatesSheetProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    checkingUpdates: boolean;
    updateStatuses: NodeUpdateStatus[];
    updatingNodeId: number | null;
    /** Mutating affordances (update, update-all, retry, dismiss, recheck) render
     *  only for admins, matching the requireAdmin guard on the fleet routes they
     *  call. Non-admins still see the read-only status table. */
    isAdmin: boolean;
    fetchUpdateStatus: () => Promise<void>;
    triggerNodeUpdate: (nodeId: number) => void;
    retryNodeUpdate: (nodeId: number) => void;
    dismissNodeUpdate: (nodeId: number) => void;
    triggerUpdateAll: () => Promise<void>;
}

export function NodeUpdatesSheet({
    open, onOpenChange, checkingUpdates, updateStatuses, updatingNodeId, isAdmin,
    fetchUpdateStatus, triggerNodeUpdate, retryNodeUpdate, dismissNodeUpdate, triggerUpdateAll,
}: NodeUpdatesSheetProps) {
    const [search, setSearch] = useState('');
    const [recheckingUpdates, setRecheckingUpdates] = useState(false);

    const handleOpenChange = (next: boolean) => {
        onOpenChange(next);
        if (!next) setSearch('');
    };

    const handleRecheck = async () => {
        setRecheckingUpdates(true);
        try {
            const res = await apiFetch('/fleet/update-status?recheck=true', { method: 'DELETE', localOnly: true });
            if (res.ok) {
                // The server throttles the upstream version lookup; `rechecked:false`
                // means a forced refresh ran too recently and the cached value stands.
                const data = await res.json().catch(() => ({}));
                if (data?.rechecked === false) {
                    toast.info('Already checked for the latest version recently.');
                }
            } else {
                // apiFetch only throws on 401/network, so HTTP errors (e.g. a 500
                // from the upstream lookup) land here, not in the catch below.
                console.warn('[Fleet] Recheck returned HTTP', res.status);
                toast.error('Could not recheck for updates. Try again shortly.');
            }
            await fetchUpdateStatus();
        } catch (err) {
            // Recheck is an explicit user click, so a thrown network/auth failure
            // gets a toast, not just a console breadcrumb.
            console.warn('[Fleet] Recheck failed:', err);
            toast.error('Could not recheck for updates. Try again shortly.');
        } finally {
            setRecheckingUpdates(false);
        }
    };

    const upToDate = updateStatuses.filter(s => !s.updateAvailable && (!s.updateStatus || s.updateStatus === 'completed')).length;
    const available = updateStatuses.filter(s => s.updateAvailable && !s.updateStatus).length;
    const updating = updateStatuses.filter(s => s.updateStatus === 'updating').length;
    const failed = updateStatuses.filter(s => s.updateStatus === 'failed' || s.updateStatus === 'timeout').length;
    const updatableRemoteCount = updateStatuses.filter(s => s.updateAvailable && !s.updateStatus && s.type === 'remote').length;
    const q = search.toLowerCase();
    const filtered = q
        ? updateStatuses.filter(s => s.name.toLowerCase().includes(q) || s.type.includes(q))
        : updateStatuses;
    const localEntry = updateStatuses.find(s => s.type === 'local') ?? updateStatuses[0];
    const gatewayLabel = formatVersion(localEntry?.latestVersion);

    const meta = updateStatuses.length === 0
        ? 'No nodes'
        : `${updateStatuses.length} nodes · ${available} update${available === 1 ? '' : 's'} available`;

    const footerContext = updateStatuses.length === 0
        ? undefined
        : (gatewayLabel ? `Latest version ${gatewayLabel}` : `${available} update${available === 1 ? '' : 's'} available`);

    const secondaryActions = isAdmin && updatableRemoteCount > 0
        ? [{
            label: `Update all (${updatableRemoteCount})`,
            icon: Download,
            onClick: () => { void triggerUpdateAll(); },
        }]
        : undefined;

    return (
        <SystemSheet
            open={open}
            onOpenChange={handleOpenChange}
            crumb={['Fleet', 'Updates']}
            name="Node updates"
            meta={meta}
            primaryAction={isAdmin ? {
                label: 'Recheck',
                icon: recheckingUpdates ? Loader2 : RefreshCw,
                onClick: () => { void handleRecheck(); },
                disabled: recheckingUpdates || checkingUpdates,
            } : undefined}
            secondaryActions={secondaryActions}
            footerContext={footerContext}
            size="lg"
        >
            {checkingUpdates ? (
                <div className="flex items-center justify-center py-12 text-muted-foreground text-sm gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Checking for updates...
                </div>
            ) : updateStatuses.length === 0 ? (
                <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
                    No nodes found.
                </div>
            ) : (
                <>
                    <SheetSection title="Summary">
                        <div className="grid grid-cols-4 gap-x-4 divide-x divide-card-border/40 text-center">
                            <div className="px-2">
                                <div className="text-lg font-medium tabular-nums tracking-tight text-stat-value">{upToDate}</div>
                                <div className="text-[10px] text-stat-subtitle flex items-center justify-center gap-1">
                                    <CircleCheck className="w-3 h-3 text-success" strokeWidth={1.5} /> Up to date
                                </div>
                            </div>
                            <div className="px-2">
                                <div className="text-lg font-medium tabular-nums tracking-tight text-stat-value">{available}</div>
                                <div className="text-[10px] text-stat-subtitle flex items-center justify-center gap-1">
                                    <CircleAlert className="w-3 h-3 text-warning" strokeWidth={1.5} /> Available
                                </div>
                            </div>
                            <div className="px-2">
                                <div className="text-lg font-medium tabular-nums tracking-tight text-stat-value">{updating}</div>
                                <div className="text-[10px] text-stat-subtitle flex items-center justify-center gap-1">
                                    <Loader2 className="w-3 h-3 text-brand" strokeWidth={1.5} /> Updating
                                </div>
                            </div>
                            <div className="px-2">
                                <div className="text-lg font-medium tabular-nums tracking-tight text-stat-value">{failed}</div>
                                <div className="text-[10px] text-stat-subtitle flex items-center justify-center gap-1">
                                    <AlertTriangle className="w-3 h-3 text-destructive/70" strokeWidth={1.5} /> Failed
                                </div>
                            </div>
                        </div>
                    </SheetSection>

                    <SheetSection title={`Nodes · ${updateStatuses.length}`}>
                        <div className="relative mb-3">
                            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                            <Input
                                placeholder="Filter nodes..."
                                value={search}
                                onChange={e => setSearch(e.target.value)}
                                className="h-8 pl-8 text-xs"
                            />
                        </div>

                        <div className="grid grid-cols-[1fr_80px_100px_100px_120px] gap-2 px-3 pb-1 text-[10px] leading-3 font-mono text-stat-subtitle uppercase tracking-[0.18em]">
                            <span>Node</span>
                            <span>Type</span>
                            <span>Current</span>
                            <span>Latest</span>
                            <span className="text-right">Status</span>
                        </div>

                        <div className="divide-y divide-card-border/40">
                            {filtered.map(s => (
                                <div key={s.nodeId} className="grid grid-cols-[1fr_80px_100px_100px_120px] gap-2 items-center px-3 py-2">
                                    <div className="flex items-center gap-2.5 min-w-0">
                                        <div className={`flex items-center justify-center w-6 h-6 rounded-md shrink-0 ${s.updateAvailable && !s.updateStatus ? 'bg-warning/10' : 'bg-muted'}`}>
                                            {s.type === 'local'
                                                ? <Monitor className={`w-3 h-3 ${s.updateAvailable && !s.updateStatus ? 'text-warning' : 'text-muted-foreground'}`} strokeWidth={1.5} />
                                                : <Globe className={`w-3 h-3 ${s.updateAvailable && !s.updateStatus ? 'text-warning' : 'text-muted-foreground'}`} strokeWidth={1.5} />
                                            }
                                        </div>
                                        <span className="text-sm font-medium truncate">{s.name}</span>
                                    </div>
                                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 w-fit">
                                        {s.type}
                                    </Badge>
                                    <span className="text-xs font-mono tabular-nums text-muted-foreground">
                                        {formatVersion(s.version) ?? <span className="text-muted-foreground/50 italic text-[10px]">unknown</span>}
                                    </span>
                                    <span className="text-xs font-mono tabular-nums">
                                        {formatVersion(s.latestVersion) ?? <span className="text-muted-foreground/50 italic text-[10px]">unknown</span>}
                                    </span>
                                    <div className="flex justify-end">
                                        {s.updateStatus && (
                                            <UpdateStatusBadge
                                                status={s.updateStatus}
                                                error={s.error}
                                                onRetry={isAdmin ? () => retryNodeUpdate(s.nodeId) : undefined}
                                                onDismiss={isAdmin ? () => dismissNodeUpdate(s.nodeId) : undefined}
                                            />
                                        )}
                                        {!s.updateStatus && !s.updateAvailable && (
                                            <Badge className="text-[10px] px-1.5 py-0 h-5 bg-success-muted text-success border-success/30">
                                                <Check className="w-2.5 h-2.5 mr-0.5" /> Up to date
                                            </Badge>
                                        )}
                                        {s.updateAvailable && !s.updateStatus && isAdmin && (
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                className="h-6 text-[11px] px-2.5"
                                                onClick={() => triggerNodeUpdate(s.nodeId)}
                                                disabled={updatingNodeId === s.nodeId}
                                            >
                                                {updatingNodeId === s.nodeId ? (
                                                    <><Loader2 className="w-3 h-3 mr-1 animate-spin" />Updating</>
                                                ) : (
                                                    <><Download className="w-3 h-3 mr-1" strokeWidth={1.5} />Update</>
                                                )}
                                            </Button>
                                        )}
                                        {s.updateAvailable && !s.updateStatus && !isAdmin && (
                                            <Badge className="text-[10px] px-1.5 py-0 h-5 bg-warning/15 text-warning border-warning/30">
                                                <CircleAlert className="w-2.5 h-2.5 mr-0.5" /> Available
                                            </Badge>
                                        )}
                                    </div>
                                </div>
                            ))}
                            {filtered.length === 0 && (
                                <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
                                    No nodes match &ldquo;{search}&rdquo;
                                </div>
                            )}
                        </div>
                    </SheetSection>
                </>
            )}
        </SystemSheet>
    );
}
