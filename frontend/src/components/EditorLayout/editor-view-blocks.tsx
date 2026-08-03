// Shared building blocks for the stack detail view. Extracted from EditorView so
// the desktop two-pane layout and the mobile segmented layout render the exact
// same identity header, container health list, and logs pane from one source.
import {
    RotateCw,
    Play,
    Square,
    Terminal,
    MoreVertical,
    Trash2,
    ScrollText,
    Undo2,
    Loader2,
    Check,
    ShieldCheck,
    ArrowUpRight,
    Copy,
    CloudDownload,
    ArrowDownToLine,
    Layers,
    List,
    Maximize2,
    Minimize2,
    AlertCircle,
    RefreshCw,
    HeartPulse,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../ui/button';
import { Skeleton } from '../ui/skeleton';
import { CardTitle } from '../ui/card';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { StackMuteSubmenu } from '@/components/mute/MuteMenuItems';
import type { useStackMuteActions } from '@/hooks/useMuteRuleActions';
import { Sparkline } from '../ui/sparkline';
import { ImageSourceMenu } from '../ImageSourceMenu';
import { cn } from '@/lib/utils';
import { copyToClipboard } from '@/lib/clipboard';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { buildServiceUrl } from '@/lib/serviceUrl';
import ErrorBoundary from '../ErrorBoundary';
import TerminalComponent from '../Terminal';
import StructuredLogViewer from '../StructuredLogViewer';
import type { Node } from '@/context/NodeContext';
import type { useAuth } from '@/context/AuthContext';
import type { ContainerInfo, ContainerStatsEntry, StackAction } from './EditorView';
import type { EffectiveServiceSpec } from '@/types/effectiveServices';
import type { StackServiceUpdateStatus } from '@/types/imageUpdates';
import { isConfirmedServiceUpdate } from '@/types/imageUpdates';

const extractUptime = (status: string | undefined): string | null => {
    if (!status) return null;
    const match = status.match(/^\s*Up\s+(.+?)(?:\s*\(.*\))?\s*$/i);
    if (!match) return null;
    return `up ${match[1].trim()}`;
};

const healthcheckLabel = (
    health?: 'healthy' | 'unhealthy' | 'starting' | 'none',
): string | null => {
    if (!health || health === 'none') return null;
    return health;
};

type StackPill = {
    label: string;
    dotClass: string;
    className: string;
    pulse: boolean;
};

const getStackStatePill = (containers: ContainerInfo[]): StackPill | null => {
    if (!containers || containers.length === 0) return null;
    const running = containers.some(c => c.State === 'running');
    if (!running) {
        return {
            label: 'exited',
            dotClass: 'bg-destructive',
            className: 'border-destructive/40 bg-destructive/10 text-destructive',
            pulse: false,
        };
    }
    const anyUnhealthy = containers.some(c => c.healthStatus === 'unhealthy');
    const anyStarting = containers.some(c => c.healthStatus === 'starting');
    const anyHealthy = containers.some(c => c.healthStatus === 'healthy');
    if (anyUnhealthy) {
        return {
            label: 'running · unhealthy',
            dotClass: 'bg-destructive',
            className: 'border-destructive/40 bg-destructive/10 text-destructive',
            pulse: true,
        };
    }
    if (anyStarting) {
        return {
            label: 'running · starting',
            dotClass: 'bg-warning',
            className: 'border-warning/40 bg-warning/10 text-warning',
            pulse: true,
        };
    }
    if (anyHealthy) {
        return {
            label: 'running · healthy',
            dotClass: 'bg-success',
            className: 'border-success/40 bg-success/10 text-success',
            pulse: true,
        };
    }
    return {
        label: 'running',
        dotClass: 'bg-success',
        className: 'border-success/40 bg-success/10 text-success',
        pulse: true,
    };
};

export interface StackIdentityHeaderProps {
    stackName: string;
    activeNode: Node | null;
    safeContainers: ContainerInfo[];
    isRunning: boolean;
    can: ReturnType<typeof useAuth>['can'];
    trivy: { available: boolean };
    backupInfo: { exists: boolean; timestamp: number | null };
    loadingAction: StackAction | null;
    stackMisconfigScanning: boolean;
    deployStack: (e: React.MouseEvent) => Promise<void>;
    restartStack: (e: React.MouseEvent) => Promise<void>;
    stopStack: (e: React.MouseEvent) => Promise<void>;
    updateStack: (e?: React.MouseEvent) => Promise<void>;
    rollbackStack: () => Promise<void>;
    scanStackConfig: () => Promise<void>;
    requestDeleteStack: () => void;
    requestTakeDownStack: (stackName: string) => void;
    showTakeDown: boolean;
    /** True when this stack is the running Sencho instance on the active node. */
    isSelfStack?: boolean;
    stackMuteActions?: ReturnType<typeof useStackMuteActions>;
    /** Opens the stack Monitor sheet on the Alerts tab. */
    onOpenMonitor?: () => void;
}

// Breadcrumb + serif title + state pill + action bar. The action buttons grow
// to a 44px touch target below md without changing desktop.
export function StackIdentityHeader({
    stackName,
    activeNode,
    safeContainers,
    isRunning,
    can,
    trivy,
    backupInfo,
    loadingAction,
    stackMisconfigScanning,
    deployStack,
    restartStack,
    stopStack,
    updateStack,
    rollbackStack,
    scanStackConfig,
    requestDeleteStack,
    requestTakeDownStack,
    showTakeDown,
    isSelfStack = false,
    stackMuteActions,
    onOpenMonitor,
}: StackIdentityHeaderProps) {
    const selfProtected = isSelfStack;
    return (
        <div className="flex flex-col gap-3">
            {/* Identity block */}
            <div className="flex flex-col gap-1.5">
                <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-stat-subtitle">
                    {(activeNode?.name || 'local')} <span className="text-muted-foreground/60">›</span> stacks <span className="text-muted-foreground/60">›</span> {stackName}
                </div>
                <div className="flex items-center gap-3 flex-wrap">
                    <CardTitle className="font-heading text-3xl leading-none tracking-tight">{stackName}</CardTitle>
                    {(() => {
                        const pill = getStackStatePill(safeContainers);
                        if (!pill) return null;
                        return (
                            <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 ${pill.className}`}>
                                <span
                                    aria-hidden="true"
                                    className={`h-1.5 w-1.5 rounded-full ${pill.dotClass} ${pill.pulse ? 'animate-[pulse_2.4s_ease-in-out_infinite]' : ''}`}
                                />
                                <span className="font-mono text-[10px] uppercase tracking-[0.18em]">{pill.label}</span>
                            </span>
                        );
                    })()}
                </div>
            </div>
            {/* Action Bar: deploy and delete affordances render against their own
                backend permissions so a delete-only or deploy-only persona sees
                exactly what they can act on. */}
            {(() => {
                const canDeploy = can('stack:deploy', 'stack', stackName, activeNode?.id);
                const canDelete = can('stack:delete', 'stack', stackName, activeNode?.id);
                const canRollback = canDeploy && backupInfo.exists;
                const canScan = trivy.available && canDeploy;
                const canMute = stackMuteActions?.canMute ?? false;
                const hasOverflowExtras = canRollback || canScan;
                const hasOverflow = hasOverflowExtras || canDelete || canMute || onOpenMonitor;
                if (!canDeploy && !hasOverflow) return null;
                return (
                    <div className="flex items-center gap-2 flex-wrap">
                        {canDeploy && (
                            <>
                                {isRunning ? (
                                    <Button type="button" size="sm" data-testid="stack-deploy-button" className="rounded-lg max-md:h-11 bg-brand text-brand-foreground hover:bg-brand/90" onClick={restartStack} disabled={loadingAction !== null}>
                                        <RotateCw className="w-4 h-4 mr-2" strokeWidth={1.5} />
                                        {loadingAction === 'restart' ? 'Restarting...' : 'Restart'}
                                    </Button>
                                ) : (
                                    <Button type="button" size="sm" data-testid="stack-deploy-button" className="rounded-lg max-md:h-11 bg-brand text-brand-foreground hover:bg-brand/90" onClick={deployStack} disabled={loadingAction !== null || selfProtected}>
                                        <Play className="w-4 h-4 mr-2" strokeWidth={1.5} />
                                        {loadingAction === 'deploy' ? 'Starting...' : 'Start'}
                                    </Button>
                                )}
                                {isRunning && (
                                    <Button type="button" size="sm" variant="outline" className="rounded-lg max-md:h-11" onClick={stopStack} disabled={loadingAction !== null || selfProtected}>
                                        <Square className="w-4 h-4 mr-2" strokeWidth={1.5} />
                                        {loadingAction === 'stop' ? 'Stopping...' : 'Stop'}
                                    </Button>
                                )}
                                {isRunning && showTakeDown && (
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        data-testid="stack-take-down-button"
                                        className="rounded-lg max-md:h-11 border-warning/40 text-warning hover:bg-warning/10"
                                        onClick={() => requestTakeDownStack(stackName)}
                                        disabled={loadingAction !== null || selfProtected}
                                    >
                                        <ArrowDownToLine className="w-4 h-4 mr-2" strokeWidth={1.5} />
                                        {loadingAction === 'down' ? 'Taking down...' : 'Take down'}
                                    </Button>
                                )}
                                <Button type="button" size="sm" variant="outline" className="rounded-lg max-md:h-11" onClick={updateStack} disabled={loadingAction !== null || selfProtected}>
                                    <CloudDownload className="w-4 h-4 mr-2" strokeWidth={1.5} />
                                    {loadingAction === 'update' ? 'Updating...' : 'Update'}
                                </Button>
                            </>
                        )}
                        {hasOverflow && (
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button type="button" size="sm" variant="ghost" className="rounded-lg h-8 w-8 p-0 max-md:h-11 max-md:w-11" disabled={loadingAction !== null} aria-label="More actions">
                                        <MoreVertical className="w-4 h-4" strokeWidth={1.5} />
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="w-48">
                                    {canRollback && (
                                        <DropdownMenuItem onClick={rollbackStack} disabled={loadingAction !== null || selfProtected}>
                                            <Undo2 className="w-4 h-4 mr-2" strokeWidth={1.5} />
                                            <div className="flex flex-col gap-0.5">
                                                <span>{loadingAction === 'rollback' ? 'Rolling back...' : 'Rollback'}</span>
                                                {backupInfo.timestamp && (
                                                    <span className="text-[10px] text-stat-subtitle font-mono">{new Date(backupInfo.timestamp).toLocaleString()}</span>
                                                )}
                                            </div>
                                        </DropdownMenuItem>
                                    )}
                                    {canScan && (
                                        <DropdownMenuItem onClick={scanStackConfig} disabled={loadingAction !== null || stackMisconfigScanning}>
                                            {stackMisconfigScanning ? (
                                                <Loader2 className="w-4 h-4 mr-2 animate-spin" strokeWidth={1.5} />
                                            ) : (
                                                <ShieldCheck className="w-4 h-4 mr-2" strokeWidth={1.5} />
                                            )}
                                            {stackMisconfigScanning ? 'Scanning...' : 'Scan config'}
                                        </DropdownMenuItem>
                                    )}
                                    {onOpenMonitor && (
                                        <DropdownMenuItem onClick={onOpenMonitor}>
                                            <HeartPulse className="w-4 h-4 mr-2" strokeWidth={1.5} />
                                            Monitor
                                        </DropdownMenuItem>
                                    )}
                                    {stackMuteActions && <StackMuteSubmenu actions={stackMuteActions} />}
                                    {(canRollback || canScan || onOpenMonitor || stackMuteActions?.canMute) && canDelete && <DropdownMenuSeparator />}
                                    {canDelete && (
                                        <DropdownMenuItem
                                            className="text-destructive focus:text-destructive focus:bg-destructive/10"
                                            disabled={loadingAction !== null || selfProtected}
                                            onClick={requestDeleteStack}
                                        >
                                            <Trash2 className="w-4 h-4 mr-2" strokeWidth={1.5} />
                                            {loadingAction === 'delete' ? 'Deleting...' : 'Delete'}
                                        </DropdownMenuItem>
                                    )}
                                </DropdownMenuContent>
                            </DropdownMenu>
                        )}
                    </div>
                );
            })()}
        </div>
    );
}

/** Optional per-card Update/Rebuild affordance for flattened single-container
 *  multi-service rows. Pass only from that call site; leave undefined on
 *  multi-replica nested children and the single-service flat path. */
export interface ServiceUpdateAffordance {
    hasUpdate: boolean;
    mode: 'update' | 'rebuild';
    showUpdateAction: boolean;
    busy: boolean;
    replicaCopy: string;
    onRequest: () => void;
}

export interface ContainersHealthProps {
    safeContainers: ContainerInfo[];
    containerStats: Record<string, ContainerStatsEntry>;
    containerStatsError: string | null;
    isAdmin: boolean;
    activeNode: Node | null;
    openLogViewer: (containerId: string, containerName: string) => void;
    openBashModal: (containerId: string, containerName: string) => void;
    /** Opens Monitor (Alerts tab); preselects the Compose service in add forms when listed. */
    onOpenServiceMonitor?: (serviceName: string) => void;
    serviceAction: (action: 'start' | 'stop' | 'restart', serviceName: string) => Promise<void>;
    // Declared Compose services from the effective model. Multi-service
    // headers (owning Update/Rebuild + badge + Start/Stop/Restart) render only
    // when this has more than one entry; empty/single leaves the flat
    // container-card layout below untouched. Optional so callers that never
    // deal in services (and existing tests) can omit them.
    effectiveServices?: EffectiveServiceSpec[];
    serviceUpdateStatuses?: StackServiceUpdateStatus[];
    serviceUpdateInProgress?: { service: string; mode: 'update' | 'rebuild' } | null;
    onRequestServiceUpdate?: (serviceName: string, mode: 'update' | 'rebuild') => void;
    containersExpanded?: boolean;
    onToggleContainersExpand?: () => void;
    containersLoadStatus?: 'idle' | 'loading' | 'success' | 'error';
    containersLoadError?: string | null;
    onRetryContainersLoad?: () => void;
    /**
     * Soft live-refresh failures exhausted. Shown only when container cards are
     * visible (containersLoadStatus === 'success'). When status is 'error', the
     * existing error card Retry is sufficient and this chip is suppressed.
     */
    syncStale?: boolean;
    onRetrySync?: () => void;
}

// Per-container health strip: status badge, uptime, ports, and CPU/Mem/Net
// sparklines. Row action buttons grow to a 44px touch target below md.
export function ContainersHealth({
    safeContainers,
    containerStats,
    containerStatsError,
    isAdmin,
    activeNode,
    openLogViewer,
    openBashModal,
    onOpenServiceMonitor,
    serviceAction,
    effectiveServices = [],
    serviceUpdateStatuses = [],
    serviceUpdateInProgress = null,
    onRequestServiceUpdate,
    containersExpanded,
    onToggleContainersExpand,
    containersLoadStatus = 'success',
    containersLoadError = null,
    onRetryContainersLoad,
    syncStale = false,
    onRetrySync,
}: ContainersHealthProps) {
    // Multi-service only: a single-service stack keeps the existing flat layout
    // untouched, including its per-container Start/Stop/Restart kebab.
    const isMultiService = effectiveServices.length > 1;
    const [copiedUrlId, setCopiedUrlId] = useState<string | null>(null);
    const copiedUrlTimerRef = useRef<number | null>(null);
    // Compact mode hides sparkline grids across all containers for a denser
    // list. Detailed mode (default) shows CPU / Mem / Net per container.
    const [density, setDensity] = useState<'compact' | 'detailed'>(
        safeContainers.length > 1 ? 'compact' : 'detailed',
    );
    useEffect(() => () => {
        if (copiedUrlTimerRef.current !== null) window.clearTimeout(copiedUrlTimerRef.current);
    }, []);
    const copyServiceUrl = useCallback((id: string | undefined, url: string) => {
        void copyToClipboard(url).then(() => {
            if (!id) return;
            setCopiedUrlId(id);
            if (copiedUrlTimerRef.current !== null) window.clearTimeout(copiedUrlTimerRef.current);
            copiedUrlTimerRef.current = window.setTimeout(() => {
                setCopiedUrlId(prev => (prev === id ? null : prev));
                copiedUrlTimerRef.current = null;
            }, 1500);
        }).catch(() => { /* clipboard unavailable */ });
    }, []);

    // Summary strip + density/expand toggles: multi-container stacks only,
    // whether the body is flat or grouped by declared service.
    const total = safeContainers.length;
    const running = safeContainers.filter(c => c.State === 'running').length;
    const unhealthy = safeContainers.filter(c => c.healthStatus === 'unhealthy').length;
    const paused = safeContainers.filter(c => c.State === 'paused').length;
    const densityToolbar = total > 1 ? (
        <div className="flex items-center justify-between mb-1 px-1">
            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-stat-subtitle">
                <span>{total} container{total !== 1 ? 's' : ''}</span>
                <span className="text-success/80">{running} up</span>
                {paused > 0 && <span className="text-warning/80">{paused} paused</span>}
                {unhealthy > 0 && <span className="text-destructive/80">{unhealthy} unhealthy</span>}
            </div>
            <div className="flex items-center gap-1">
                <div className="inline-flex rounded-md border border-muted bg-muted/30 p-0.5">
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={() => setDensity('compact')}
                            className={`rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide transition-colors ${density === 'compact' ? 'bg-brand/15 text-brand' : 'text-stat-subtitle hover:text-foreground'}`}
                            aria-pressed={density === 'compact'}
                            aria-label="Compact view"
                          >
                            <List className="h-3 w-3" strokeWidth={1.5} />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>Compact view</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={() => setDensity('detailed')}
                            className={`rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide transition-colors ${density === 'detailed' ? 'bg-brand/15 text-brand' : 'text-stat-subtitle hover:text-foreground'}`}
                            aria-pressed={density === 'detailed'}
                            aria-label="Detailed view"
                          >
                            <Layers className="h-3 w-3" strokeWidth={1.5} />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>Detailed view</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                    {onToggleContainersExpand && (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                onClick={onToggleContainersExpand}
                                className={`rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide transition-colors ${containersExpanded ? 'bg-brand/15 text-brand' : 'text-stat-subtitle hover:text-foreground'}`}
                                aria-pressed={containersExpanded}
                                aria-label={containersExpanded ? 'Collapse containers' : 'Expand containers'}
                              >
                                {containersExpanded
                                  ? <Minimize2 className="h-3 w-3" strokeWidth={1.5} />
                                  : <Maximize2 className="h-3 w-3" strokeWidth={1.5} />}
                              </button>
                            </TooltipTrigger>
                            <TooltipContent>{containersExpanded ? 'Collapse containers' : 'Expand containers'}</TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                    )}
                </div>
            </div>
        </div>
    ) : null;

    // One container card. `hideServiceMenu` drops the per-container
    // Start/Stop/Restart kebab on multi-replica nested children; the
    // declared-service header above owns lifecycle actions there. Flattened
    // single-container multi-service rows pass updateAffordance and keep the
    // kebab (`hideServiceMenu=false`). Single-service flat rows leave
    // updateAffordance undefined.
    const renderServiceUpdateButton = (affordance: ServiceUpdateAffordance) => {
        if (!affordance.showUpdateAction) return null;
        return (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 rounded-md px-2 max-md:h-11"
                    onClick={affordance.onRequest}
                    disabled={affordance.busy}
                  >
                    <CloudDownload className="h-3.5 w-3.5 mr-1.5" strokeWidth={1.5} />
                    {affordance.busy
                        ? (affordance.mode === 'rebuild' ? 'Rebuilding...' : 'Updating...')
                        : (affordance.mode === 'rebuild' ? 'Rebuild' : 'Update')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{affordance.replicaCopy}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
        );
    };

    const renderServiceLifecycleMenu = (serviceName: string, isServiceActive: boolean) => (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 rounded-md max-md:h-11 max-md:w-11"
                    aria-label="Service actions"
                >
                    <MoreVertical className="h-3.5 w-3.5" strokeWidth={1.5} />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                {isServiceActive ? (
                    <>
                        <DropdownMenuItem onSelect={() => serviceAction('restart', serviceName)}>
                            Restart service
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => serviceAction('stop', serviceName)}>
                            Stop service
                        </DropdownMenuItem>
                    </>
                ) : (
                    <DropdownMenuItem onSelect={() => serviceAction('start', serviceName)}>
                        Start service
                    </DropdownMenuItem>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );

    const renderContainerCard = (
        container: ContainerInfo,
        hideServiceMenu: boolean,
        updateAffordance?: ServiceUpdateAffordance,
    ) => {
                        let mainPort: number | undefined;
                        let mainPortPrivate: number | undefined;
                        let mainPortProto: string | undefined;
                        // UDP ports are not browser-openable, so they never back a link.
                        const tcpPorts = (container.Ports ?? []).filter(p => p.Type !== 'udp');
                        if (tcpPorts.length > 0) {
                            const WEB_UI_PORTS = [32400, 8989, 7878, 9696, 5055, 8080, 80, 443, 3000, 9000];
                            const IGNORE_PORTS = [1900, 53, 22];
                            let match = tcpPorts.find(p => WEB_UI_PORTS.includes(p.PrivatePort));
                            if (!match) match = tcpPorts.find(p => WEB_UI_PORTS.includes(p.PublicPort));
                            if (!match) match = tcpPorts.find(p => !IGNORE_PORTS.includes(p.PrivatePort) && !IGNORE_PORTS.includes(p.PublicPort));
                            const chosen = match || tcpPorts[0];
                            mainPort = chosen.PublicPort;
                            mainPortPrivate = chosen.PrivatePort;
                            mainPortProto = 'tcp';
                        }

                        const serviceUrl = mainPort && mainPortPrivate
                            ? buildServiceUrl({ node: activeNode, publicPort: mainPort, privatePort: mainPortPrivate })
                            : null;
                        const portLabel = mainPort && mainPortPrivate
                            ? `${mainPort} → ${mainPortPrivate}/${mainPortProto}`
                            : '';

                        const containerName = container?.Names?.[0]?.replace(/^\//, '') || container?.Id?.slice(0, 12) || 'container';
                        const composeService = container.Service;
                        const isActive = container.State === 'running' || container.State === 'paused';
                        const health = container.healthStatus;
                        const uptime = isActive ? extractUptime(container.Status) : null;
                        const hcLabel = healthcheckLabel(health);
                        const stats = containerStats[container?.Id];
                        const history = stats?.history;

                        const badgeClass = health === 'unhealthy' || !isActive
                            ? 'bg-destructive text-destructive-foreground'
                            : health === 'starting'
                                ? 'bg-warning text-warning-foreground'
                                : 'bg-success text-success-foreground';
                        const badgeGlyph = health === 'unhealthy' || !isActive ? '✗' : health === 'starting' ? '…' : '✓';
                        const sparkStroke = health === 'unhealthy' ? 'var(--destructive)' : health === 'starting' ? 'var(--warning)' : 'var(--chart-1)';

                        return (
                            <div key={container?.Id || Math.random()} className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel px-3 py-2.5">
                                <div className="flex items-start justify-between gap-4">
                                    <div className="flex items-start gap-3 min-w-0 flex-1">
                                        <div className={cn('mt-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold', badgeClass)}>
                                            {badgeGlyph}
                                        </div>
                                        <div className="flex min-w-0 flex-col gap-0.5">
                                            <div className="flex min-w-0 items-center gap-2">
                                                <div className="truncate font-mono text-sm text-foreground">{containerName}</div>
                                                {updateAffordance?.hasUpdate && (
                                                    <span className="shrink-0 rounded-full border border-brand/30 bg-brand/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-brand">
                                                        Update
                                                    </span>
                                                )}
                                            </div>
                                            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] text-stat-subtitle">
                                                {uptime ? <span>{uptime}</span> : <span>{(container.State || 'unknown').toLowerCase()}</span>}
                                                {hcLabel ? <><span>·</span><span>{hcLabel}</span></> : null}
                                                {mainPort && mainPortPrivate ? (
                                                    <>
                                                        <span>·</span>
                                                        {serviceUrl ? (
                                                            <>
                                                                <a
                                                                    href={serviceUrl}
                                                                    target="_blank"
                                                                    rel="noopener noreferrer"
                                                                    className="inline-flex items-center gap-1 text-brand hover:underline"
                                                                >
                                                                    {portLabel} <ArrowUpRight className="h-3 w-3" strokeWidth={1.5} />
                                                                </a>
                                                                <TooltipProvider>
                                                                  <Tooltip>
                                                                    <TooltipTrigger asChild>
                                                                      <button
                                                                        type="button"
                                                                        aria-label={copiedUrlId === container?.Id ? 'Copied' : 'Copy service URL'}
                                                                        onClick={() => copyServiceUrl(container?.Id, serviceUrl)}
                                                                        className="inline-flex h-4 w-4 items-center justify-center rounded text-stat-subtitle hover:text-foreground hover:bg-muted/60 transition-colors"
                                                                      >
                                                                    {copiedUrlId === container?.Id ? (
                                                                        <Check className="h-3 w-3" strokeWidth={2} />
                                                                    ) : (
                                                                        <Copy className="h-3 w-3" strokeWidth={1.5} />
                                                                    )}
                                                                </button>
                                                                    </TooltipTrigger>
                                                                    <TooltipContent>Copy service URL</TooltipContent>
                                                                  </Tooltip>
                                                                </TooltipProvider>
                                                            </>
                                                        ) : (
                                                            <span>{portLabel}</span>
                                                        )}
                                                    </>
                                                ) : null}
                                            </div>
                                        </div>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-1">
                                        {updateAffordance ? renderServiceUpdateButton(updateAffordance) : null}
                                        <ImageSourceMenu
                                            imageRef={container.Image}
                                            imageId={container.ImageID}
                                            className="h-7 w-7 rounded-md max-md:h-11 max-md:w-11"
                                        />
                                        <TooltipProvider>
                                          <Tooltip>
                                            <TooltipTrigger asChild>
                                              <Button
                                                size="icon"
                                                variant="ghost"
                                                className="h-7 w-7 rounded-md max-md:h-11 max-md:w-11"
                                                onClick={() => openLogViewer(container?.Id, containerName)}
                                                disabled={!isActive}
                                                aria-label="View logs"
                                              >
                                                <ScrollText className="h-3.5 w-3.5" strokeWidth={1.5} />
                                              </Button>
                                            </TooltipTrigger>
                                            <TooltipContent>View logs</TooltipContent>
                                          </Tooltip>
                                        </TooltipProvider>
                                        {onOpenServiceMonitor && composeService && (
                                          <TooltipProvider>
                                            <Tooltip>
                                              <TooltipTrigger asChild>
                                                <Button
                                                  size="icon"
                                                  variant="ghost"
                                                  className="h-7 w-7 rounded-md max-md:h-11 max-md:w-11"
                                                  onClick={() => onOpenServiceMonitor(composeService)}
                                                  aria-label={`Monitor ${composeService}`}
                                                >
                                                  <HeartPulse className="h-3.5 w-3.5" strokeWidth={1.5} />
                                                </Button>
                                              </TooltipTrigger>
                                              <TooltipContent>Monitor {composeService}</TooltipContent>
                                            </Tooltip>
                                          </TooltipProvider>
                                        )}
                                        {isAdmin && (
                                          <TooltipProvider>
                                            <Tooltip>
                                              <TooltipTrigger asChild>
                                                <Button
                                                  size="icon"
                                                  variant="ghost"
                                                  className="h-7 w-7 rounded-md max-md:h-11 max-md:w-11"
                                                  onClick={() => openBashModal(container?.Id, containerName)}
                                                  disabled={!isActive}
                                                  aria-label="Open bash shell"
                                                >
                                                  <Terminal className="h-3.5 w-3.5" strokeWidth={1.5} />
                                                </Button>
                                              </TooltipTrigger>
                                              <TooltipContent>Open bash shell</TooltipContent>
                                            </Tooltip>
                                          </TooltipProvider>
                                        )}
                                        {!hideServiceMenu && container.Service && (
                                            renderServiceLifecycleMenu(
                                                container.Service,
                                                isActive,
                                            )
                                        )}
                                    </div>
                                </div>
                                {isActive && density === 'detailed' ? (
                                    <div className="mt-2 grid grid-cols-[minmax(0,0.85fr)_minmax(0,0.85fr)_minmax(0,1.3fr)] gap-2">
                                        {[
                                            { label: 'cpu', value: stats?.cpu ?? '-', points: history?.cpu ?? [] },
                                            { label: 'mem', value: stats?.ram ?? '-', points: history?.mem ?? [] },
                                            { label: 'net i/o', value: stats?.net ?? '-', points: history?.netIn ?? [] },
                                        ].map(({ label, value, points }) => (
                                            <div
                                                key={label}
                                                className="flex min-w-0 items-center gap-2 rounded-md bg-background/60 px-2 py-1.5"
                                            >
                                                <div className="min-w-0 flex flex-col">
                                                    <span className="font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-stat-subtitle">{label}</span>
                                                    <span
                                                        className="font-mono text-xs tabular-nums truncate text-foreground"
                                                        title={value === '-' ? undefined : value}
                                                    >
                                                        {value}
                                                    </span>
                                                </div>
                                                <div className="ml-auto h-5 w-16 shrink min-w-8">
                                                    <Sparkline points={points} stroke={sparkStroke} fill={sparkStroke} showPeak={false} />
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                ) : null}
                            </div>
                        );
    };

    const showConfirmedEmpty = containersLoadStatus === 'success' && safeContainers.length === 0;

    if (containersLoadStatus === 'idle' || containersLoadStatus === 'loading') {
        return (
            <div className="space-y-2">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
            </div>
        );
    }

    if (containersLoadStatus === 'error') {
        return (
            <div className="rounded-lg border border-card-border bg-card/40 p-4 text-center">
                <AlertCircle className="mx-auto mb-2 h-8 w-8 text-muted-foreground" aria-hidden />
                <p className="mb-3 text-sm text-muted-foreground">
                    {containersLoadError ?? 'Could not load containers.'}
                </p>
                {onRetryContainersLoad && (
                    <Button type="button" variant="outline" size="sm" onClick={onRetryContainersLoad}>
                        <RefreshCw className="h-4 w-4" />
                        Retry
                    </Button>
                )}
            </div>
        );
    }

    return (
        <div>
            {containerStatsError && safeContainers.length > 0 && (
                <div className="mb-3 flex items-center justify-end">
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="text-[10px] uppercase tracking-wider font-mono text-warning-foreground bg-warning/10 border border-warning/30 rounded-md px-2 py-0.5">
                            Stats unavailable
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>{containerStatsError}</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                </div>
            )}
            {syncStale && onRetrySync && (
                <div className="mb-3 flex items-center justify-between gap-2 rounded-md border border-warning/30 bg-warning/10 px-2 py-1.5">
                    <span className="text-[10px] uppercase tracking-wider font-mono text-warning-foreground">
                        Container state may be stale
                    </span>
                    <Button type="button" variant="outline" size="sm" className="h-7" onClick={onRetrySync}>
                        <RefreshCw className="h-3.5 w-3.5" />
                        Retry
                    </Button>
                </div>
            )}
            {densityToolbar}
            {isMultiService ? (
                <div className="flex flex-col gap-3">
                    {effectiveServices.map(spec => {
                        const group = safeContainers.filter(c => c.Service === spec.name);
                        const status = serviceUpdateStatuses.find(s => s.service === spec.name);
                        const busy = serviceUpdateInProgress?.service === spec.name;
                        const hasUpdate = status ? isConfirmedServiceUpdate(status) : false;
                        const mode: 'update' | 'rebuild' = !hasUpdate && spec.hasBuild ? 'rebuild' : 'update';
                        // Registry Update only when a check confirmed a pending
                        // image update (clears after a successful recheck). Rebuild
                        // stays available for build-backed services without one.
                        // Stack-level Update in the identity header remains the
                        // always-on full-stack pull path.
                        const showUpdateAction = hasUpdate || spec.hasBuild;
                        const isServiceActive = group.some(c => c.State === 'running' || c.State === 'paused');
                        const runningCount = group.filter(c => c.State === 'running').length;
                        const replicaWord = spec.expectedReplicas === 1 ? 'replica' : 'replicas';
                        const replicaCopy = mode === 'rebuild'
                            ? `Rebuilds all ${spec.expectedReplicas} ${replicaWord}`
                            : `Updates all ${spec.expectedReplicas} ${replicaWord}`;
                        const updateAffordance: ServiceUpdateAffordance = {
                            hasUpdate,
                            mode,
                            showUpdateAction,
                            busy,
                            replicaCopy,
                            onRequest: () => onRequestServiceUpdate?.(spec.name, mode),
                        };

                        // Single-container declared service: one flat card with
                        // Update left of ImageSourceMenu and the lifecycle kebab.
                        if (group.length === 1) {
                            return (
                                <div key={spec.name}>
                                    {renderContainerCard(group[0], false, updateAffordance)}
                                </div>
                            );
                        }

                        // Zero containers: compact row (name + Update + kebab),
                        // not renderContainerCard (no ContainerInfo).
                        if (group.length === 0) {
                            return (
                                <div
                                    key={spec.name}
                                    className="flex items-center justify-between gap-3 rounded-lg border border-card-border bg-muted/40 px-3 py-2"
                                >
                                    <div className="flex min-w-0 items-center gap-2">
                                        <span className="truncate font-mono text-sm font-medium text-foreground">{spec.name}</span>
                                        {hasUpdate && (
                                            <span className="rounded-full border border-brand/30 bg-brand/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-brand">
                                                Update
                                            </span>
                                        )}
                                    </div>
                                    <div className="flex shrink-0 items-center gap-1">
                                        {renderServiceUpdateButton(updateAffordance)}
                                        {renderServiceLifecycleMenu(spec.name, false)}
                                    </div>
                                </div>
                            );
                        }

                        // Multi-replica: keep header + nested children (no
                        // updateAffordance on child cards).
                        return (
                            <div key={spec.name} className="flex flex-col gap-2">
                                <div className="flex items-center justify-between gap-3 rounded-lg border border-card-border bg-muted/40 px-3 py-2">
                                    <div className="flex min-w-0 items-center gap-2">
                                        <span className="truncate font-mono text-sm font-medium text-foreground">{spec.name}</span>
                                        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-stat-subtitle">
                                            {runningCount}/{spec.expectedReplicas} running
                                        </span>
                                        {hasUpdate && (
                                            <span className="rounded-full border border-brand/30 bg-brand/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-brand">
                                                Update
                                            </span>
                                        )}
                                    </div>
                                    <div className="flex shrink-0 items-center gap-1">
                                        {renderServiceUpdateButton(updateAffordance)}
                                        {renderServiceLifecycleMenu(spec.name, isServiceActive)}
                                    </div>
                                </div>
                                <div className="ml-2 flex flex-col gap-2 border-l border-hairline pl-3">
                                    {group.map(container => renderContainerCard(container, true))}
                                </div>
                            </div>
                        );
                    })}
                </div>
            ) : showConfirmedEmpty ? (
                <div className="text-muted-foreground text-sm">No containers running for this stack.</div>
            ) : (
                <div className="flex flex-col gap-2">
                    {safeContainers.map(container => renderContainerCard(container, false))}
                </div>
            )}

        </div>
    );
}

export interface StackLogsSectionProps {
    stackName: string;
    logsMode: 'structured' | 'raw';
    setLogsMode: (mode: 'structured' | 'raw') => void;
    /** True when the stack has more than one service or container; gates log chips. */
    showServiceChips: boolean;
    /** When set, the structured viewer shows an expand control that collapses
     *  the Command Center to give the logs more vertical room. */
    logsExpanded?: boolean;
    onToggleLogsExpand?: () => void;
}

// Logs pane: structured / raw-terminal toggle + the live viewer.
export function StackLogsSection({ stackName, logsMode, setLogsMode, showServiceChips, logsExpanded, onToggleLogsExpand }: StackLogsSectionProps) {
    return (
        <div className="flex-1 min-h-0 flex flex-col gap-2 overflow-hidden">
            <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-stat-subtitle">Logs</h3>
                <div className="inline-flex rounded-md border border-muted bg-muted/30 p-0.5">
                    <button
                        type="button"
                        onClick={() => setLogsMode('structured')}
                        className={cn(
                            'rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide transition-colors',
                            logsMode === 'structured' ? 'bg-brand/15 text-brand' : 'text-stat-subtitle hover:text-foreground',
                        )}
                    >
                        Structured
                    </button>
                    <button
                        type="button"
                        onClick={() => setLogsMode('raw')}
                        className={cn(
                            'rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide transition-colors',
                            logsMode === 'raw' ? 'bg-brand/15 text-brand' : 'text-stat-subtitle hover:text-foreground',
                        )}
                    >
                        Raw terminal
                    </button>
                </div>
            </div>
            {logsMode === 'structured' ? (
                <ErrorBoundary>
                    <StructuredLogViewer stackName={stackName} showServiceChips={showServiceChips} expanded={logsExpanded} onToggleExpand={onToggleLogsExpand} />
                </ErrorBoundary>
            ) : (
                <div className="flex-1 rounded-xl overflow-hidden border border-muted bg-black p-3 shadow-[inset_0_2px_4px_0_oklch(0_0_0/0.4)]">
                    <div className="h-full">
                        <ErrorBoundary>
                            <TerminalComponent stackName={stackName} />
                        </ErrorBoundary>
                    </div>
                </div>
            )}
        </div>
    );
}
