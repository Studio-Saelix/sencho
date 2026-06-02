import { Suspense, useRef, useEffect } from 'react';
import { Editor } from '@/lib/monacoLoader';
import {
    RotateCw,
    Play,
    Square,
    Save,
    Terminal,
    CloudDownload,
    Pencil,
    X,
    MoreVertical,
    Rocket,
    Trash2,
    ScrollText,
    Undo2,
    Loader2,
    Check,
    ChevronDown,
    GitBranch,
    ShieldCheck,
    ArrowUpRight,
    Copy,
    FolderOpen,
} from 'lucide-react';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import {
    Tabs,
    TabsList,
    TabsTrigger,
    TabsHighlight,
    TabsHighlightItem,
} from '../ui/tabs';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Sparkline } from '../ui/sparkline';
import { springs } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { copyToClipboard } from '@/lib/clipboard';
import ErrorBoundary from '../ErrorBoundary';
import TerminalComponent from '../Terminal';
import StructuredLogViewer from '../StructuredLogViewer';
import StackAnatomyPanel from '../StackAnatomyPanel';
import { StackFileExplorer } from '@/components/files/StackFileExplorer';
import type { NotificationItem } from '../dashboard/types';
import type { Node } from '@/context/NodeContext';
import type { useAuth } from '@/context/AuthContext';

export interface ContainerInfo {
    Id: string;
    Names: string[];
    Service?: string;
    State: string;
    Status?: string;
    Ports?: { PrivatePort: number; PublicPort: number }[];
    healthStatus?: 'healthy' | 'unhealthy' | 'starting' | 'none';
    Image?: string;
    ImageID?: string;
}

export type StackAction =
    | 'deploy'
    | 'stop'
    | 'restart'
    | 'update'
    | 'delete'
    | 'rollback';

export interface ContainerStatsEntry {
    cpu: string;
    ram: string;
    net: string;
    lastRx?: number;
    lastTx?: number;
    history: { cpu: number[]; mem: number[]; netIn: number[]; netOut: number[] };
}

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
    if (health === 'healthy') return 'healthcheck passing';
    if (health === 'unhealthy') return 'healthcheck failing';
    return 'healthcheck starting';
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

export interface EditorViewProps {
    // Identity
    stackName: string;
    isDarkMode: boolean;

    // Stack data (raw; safe-wrapped locally for backwards-compat with prior idiom)
    containers: ContainerInfo[];
    containerStats: Record<string, ContainerStatsEntry>;
    containerStatsError: string | null;
    content: string;
    envContent: string;
    envExists: boolean;
    envFiles: string[];
    selectedEnvFile: string;
    isFileLoading: boolean;
    backupInfo: { exists: boolean; timestamp: number | null };
    gitSourcePendingMap: Record<string, boolean>;
    notifications: NotificationItem[];

    // Editor mode
    activeTab: 'compose' | 'env' | 'files';
    isEditing: boolean;
    editingCompose: boolean;
    logsMode: 'structured' | 'raw';
    copiedDigest: string | null;
    loadingAction: StackAction | null;
    stackMisconfigScanning: boolean;

    // Permissions / tier / context
    can: ReturnType<typeof useAuth>['can'];
    isAdmin: boolean;
    isPaid: boolean;
    trivy: { available: boolean };
    activeNode: Node | null;

    // Refs
    copiedDigestTimerRef: React.MutableRefObject<number | null>;

    // Stack actions
    deployStack: (e: React.MouseEvent) => Promise<void>;
    restartStack: (e: React.MouseEvent) => Promise<void>;
    stopStack: (e: React.MouseEvent) => Promise<void>;
    updateStack: (e?: React.MouseEvent) => Promise<void>;
    rollbackStack: () => Promise<void>;
    scanStackConfig: () => Promise<void>;

    // Edit lifecycle
    enterEditMode: () => void;
    requestSave: () => void;
    requestSaveAndDeploy: (e: React.MouseEvent) => void;
    discardChanges: () => void;
    setContent: (next: string) => void;
    setEnvContent: (next: string) => void;
    changeEnvFile: (file: string) => Promise<void>;

    // Container / service actions
    openLogViewer: (containerId: string, containerName: string) => void;
    openBashModal: (containerId: string, containerName: string) => void;
    serviceAction: (
        action: 'start' | 'stop' | 'restart',
        serviceName: string,
    ) => Promise<void>;

    // UI state setters
    setActiveTab: (tab: 'compose' | 'env' | 'files') => void;
    setLogsMode: (mode: 'structured' | 'raw') => void;
    setEditingCompose: (open: boolean) => void;
    setGitSourceOpen: (open: boolean) => void;
    setCopiedDigest: React.Dispatch<React.SetStateAction<string | null>>;

    // Composed action — wraps setStackToDelete + setDeleteDialogOpen
    requestDeleteStack: () => void;
}

export function EditorView({
    stackName,
    isDarkMode,
    containers,
    containerStats,
    containerStatsError,
    content,
    envContent,
    envExists,
    envFiles,
    selectedEnvFile,
    isFileLoading,
    backupInfo,
    gitSourcePendingMap,
    notifications,
    activeTab,
    isEditing,
    editingCompose,
    logsMode,
    copiedDigest,
    loadingAction,
    stackMisconfigScanning,
    can,
    isAdmin,
    isPaid,
    trivy,
    activeNode,
    copiedDigestTimerRef,
    deployStack,
    restartStack,
    stopStack,
    updateStack,
    rollbackStack,
    scanStackConfig,
    enterEditMode,
    requestSave,
    requestSaveAndDeploy,
    discardChanges,
    setContent,
    setEnvContent,
    changeEnvFile,
    openLogViewer,
    openBashModal,
    serviceAction,
    setActiveTab,
    setLogsMode,
    setEditingCompose,
    setGitSourceOpen,
    setCopiedDigest,
    requestDeleteStack,
}: EditorViewProps) {
    const monacoEditorRef = useRef<import('monaco-editor').editor.IStandaloneCodeEditor | null>(null);

    // Dispose the underlying Monaco model when EditorView unmounts. The
    // @monaco-editor/react wrapper reuses a single model per editor instance
    // (we do not pass a `path`), so this catches the unmount case rather than
    // a per-stack-switch leak.
    useEffect(() => {
        return () => {
            const editor = monacoEditorRef.current;
            if (!editor) return;
            try {
                editor.getModel()?.dispose();
            } catch {
                // Editor already torn down by Monaco; nothing to do.
            }
        };
    }, []);

    // Force Monaco to re-measure its container after the tab switch DOM settles.
    // Monaco's internal child is position:static with an explicit pixel height that
    // creates a circular CSS dependency (Monaco drives card height -> grid height -> Monaco).
    // Fix: reset Monaco to 0x0 first (breaks the cycle), then trigger a forced synchronous
    // reflow so the container has its CSS-correct size before Monaco re-measures.
    useEffect(() => {
        const id = requestAnimationFrame(() => {
            const editor = monacoEditorRef.current;
            if (!editor) return;
            editor.layout({ width: 0, height: 0 }); // collapse -> breaks CSS circular dependency
            editor.layout();                          // forced reflow -> measures correct container size
        });
        return () => cancelAnimationFrame(id);
    }, [activeTab]);

    const safeContainers = containers || [];
    const safeContent = content || '';
    const safeEnvContent = envContent || '';
    const isRunning = safeContainers.some(c => c.State === 'running');
    const canRead = can('stack:read', 'stack', stackName);

    useEffect(() => {
        if (activeTab === 'files' && !canRead) {
            setActiveTab('compose');
        }
    }, [activeTab, canRead, setActiveTab]);

    return (
        <ErrorBoundary>
            <div className="grid gap-6 grid-cols-1 lg:grid-cols-2 min-h-[600px] h-[calc(100vh-160px)] max-h-[1040px]">
                {/* Left column: identity + health strip + logs, stacked */}
                <div className="flex flex-col gap-6 min-h-0">
                    {/* Command Center Card (identity + health strip) */}
                    <Card className="rounded-xl border-muted bg-card shrink-0">
                        <CardHeader className="p-4 pb-2">
                            <div className="flex flex-col gap-3">
                                {/* Identity block */}
                                <div className="flex flex-col gap-1.5">
                                    <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-stat-subtitle">
                                        {(activeNode?.name || 'local')} <span className="text-muted-foreground/60">›</span> stacks <span className="text-muted-foreground/60">›</span> {stackName}
                                    </div>
                                    <div className="flex items-center gap-3 flex-wrap">
                                        <CardTitle className="font-display italic text-3xl leading-none tracking-tight">{stackName}</CardTitle>
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
                                    {(() => {
                                        const first = safeContainers[0];
                                        if (!first?.Image) return null;
                                        const digest = first.ImageID ? first.ImageID.replace(/^sha256:/, '').slice(0, 12) : '';
                                        return (
                                            <div className="flex items-center gap-1.5 font-mono text-[11px] text-stat-subtitle">
                                                <span>image <span className="text-muted-foreground/60">·</span> <span className="text-foreground/90">{first.Image}</span></span>
                                                {digest && first.ImageID && (
                                                    <>
                                                        <span className="text-muted-foreground/60">·</span>
                                                        <span>digest <span className="text-foreground/90">{digest}</span></span>
                                                        <button
                                                            type="button"
                                                            aria-label={copiedDigest === first.ImageID ? 'Copied' : 'Copy digest'}
                                                            onClick={() => {
                                                                const id = first.ImageID as string;
                                                                void copyToClipboard(id).then(() => {
                                                                    setCopiedDigest(id);
                                                                    if (copiedDigestTimerRef.current !== null) {
                                                                        window.clearTimeout(copiedDigestTimerRef.current);
                                                                    }
                                                                    copiedDigestTimerRef.current = window.setTimeout(() => {
                                                                        setCopiedDigest(prev => (prev === id ? null : prev));
                                                                        copiedDigestTimerRef.current = null;
                                                                    }, 1500);
                                                                }).catch(() => { /* clipboard unavailable */ });
                                                            }}
                                                            className="inline-flex h-4 w-4 items-center justify-center rounded text-stat-subtitle hover:text-foreground hover:bg-muted/60 transition-colors"
                                                        >
                                                            {copiedDigest === first.ImageID ? (
                                                                <Check className="h-3 w-3" strokeWidth={2} />
                                                            ) : (
                                                                <Copy className="h-3 w-3" strokeWidth={1.5} />
                                                            )}
                                                        </button>
                                                    </>
                                                )}
                                            </div>
                                        );
                                    })()}
                                </div>
                                {/* Action Bar — deploy / delete affordances render against
                                    their own backend permissions so a delete-only or
                                    deploy-only persona sees exactly what they can act on. */}
                                {(() => {
                                    const canDeploy = can('stack:deploy', 'stack', stackName);
                                    const canDelete = can('stack:delete', 'stack', stackName);
                                    const canRollback = canDeploy && isPaid && backupInfo.exists;
                                    const canScan = trivy.available && isAdmin;
                                    const hasOverflowExtras = canRollback || canScan;
                                    const hasOverflow = hasOverflowExtras || canDelete;
                                    if (!canDeploy && !hasOverflow) return null;
                                    return (
                                        <div className="flex items-center gap-2 flex-wrap">
                                            {canDeploy && (
                                                <>
                                                    {isRunning ? (
                                                        <Button type="button" size="sm" data-testid="stack-deploy-button" className="rounded-lg bg-brand text-brand-foreground hover:bg-brand/90" onClick={restartStack} disabled={loadingAction !== null}>
                                                            <RotateCw className="w-4 h-4 mr-2" strokeWidth={1.5} />
                                                            {loadingAction === 'restart' ? 'Restarting...' : 'Restart'}
                                                        </Button>
                                                    ) : (
                                                        <Button type="button" size="sm" data-testid="stack-deploy-button" className="rounded-lg bg-brand text-brand-foreground hover:bg-brand/90" onClick={deployStack} disabled={loadingAction !== null}>
                                                            <Play className="w-4 h-4 mr-2" strokeWidth={1.5} />
                                                            {loadingAction === 'deploy' ? 'Starting...' : 'Start'}
                                                        </Button>
                                                    )}
                                                    {isRunning && (
                                                        <Button type="button" size="sm" variant="outline" className="rounded-lg" onClick={stopStack} disabled={loadingAction !== null}>
                                                            <Square className="w-4 h-4 mr-2" strokeWidth={1.5} />
                                                            {loadingAction === 'stop' ? 'Stopping...' : 'Stop'}
                                                        </Button>
                                                    )}
                                                    <Button type="button" size="sm" variant="outline" className="rounded-lg" onClick={updateStack} disabled={loadingAction !== null}>
                                                        <CloudDownload className="w-4 h-4 mr-2" strokeWidth={1.5} />
                                                        {loadingAction === 'update' ? 'Updating...' : 'Update'}
                                                    </Button>
                                                </>
                                            )}
                                            {hasOverflow && (
                                                <DropdownMenu>
                                                    <DropdownMenuTrigger asChild>
                                                        <Button type="button" size="sm" variant="ghost" className="rounded-lg h-8 w-8 p-0" disabled={loadingAction !== null} aria-label="More actions">
                                                            <MoreVertical className="w-4 h-4" strokeWidth={1.5} />
                                                        </Button>
                                                    </DropdownMenuTrigger>
                                                    <DropdownMenuContent align="end" className="w-48">
                                                        {canRollback && (
                                                            <DropdownMenuItem onClick={rollbackStack} disabled={loadingAction !== null}>
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
                                                        {hasOverflowExtras && canDelete && <DropdownMenuSeparator />}
                                                        {canDelete && (
                                                            <DropdownMenuItem
                                                                className="text-destructive focus:text-destructive focus:bg-destructive/10"
                                                                disabled={loadingAction !== null}
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
                        </CardHeader>
                        <CardContent className="p-4 pt-2">
                            {/* Per-container health strip */}
                            <div className="mt-4">
                                <div className="flex items-center justify-between mb-3">
                                    <h4 className="text-sm font-medium text-muted-foreground">CONTAINERS</h4>
                                    {containerStatsError && safeContainers.length > 0 && (
                                        <span
                                            className="text-[10px] uppercase tracking-wider font-mono text-warning-foreground bg-warning/10 border border-warning/30 rounded-md px-2 py-0.5"
                                            title={containerStatsError}
                                        >
                                            Stats unavailable
                                        </span>
                                    )}
                                </div>
                                {safeContainers.length === 0 ? (
                                    <div className="text-muted-foreground text-sm">No containers running for this stack.</div>
                                ) : (
                                    <div className="flex flex-col gap-2">
                                        {safeContainers.map(container => {
                                            let mainPort: number | undefined;
                                            let mainPortPrivate: number | undefined;
                                            let mainPortProto: string | undefined;
                                            if (container.Ports && container.Ports.length > 0) {
                                                const WEB_UI_PORTS = [32400, 8989, 7878, 9696, 5055, 8080, 80, 443, 3000, 9000];
                                                const IGNORE_PORTS = [1900, 53, 22];
                                                let match = container.Ports.find(p => WEB_UI_PORTS.includes(p.PrivatePort));
                                                if (!match) match = container.Ports.find(p => WEB_UI_PORTS.includes(p.PublicPort));
                                                if (!match) match = container.Ports.find(p => !IGNORE_PORTS.includes(p.PrivatePort) && !IGNORE_PORTS.includes(p.PublicPort));
                                                const chosen = match || container.Ports[0];
                                                mainPort = chosen.PublicPort;
                                                mainPortPrivate = chosen.PrivatePort;
                                                mainPortProto = 'tcp';
                                            }

                                            const containerName = container?.Names?.[0]?.replace(/^\//, '') || container?.Id?.slice(0, 12) || 'container';
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
                                                                <div className="truncate font-mono text-sm text-foreground">{containerName}</div>
                                                                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] text-stat-subtitle">
                                                                    {uptime ? <span>{uptime}</span> : <span>{(container.State || 'unknown').toLowerCase()}</span>}
                                                                    {hcLabel ? <><span>·</span><span>{hcLabel}</span></> : null}
                                                                    {mainPort && mainPortPrivate ? (
                                                                        <>
                                                                            <span>·</span>
                                                                            <span>{mainPort} → {mainPortPrivate}/{mainPortProto}</span>
                                                                            <button
                                                                                type="button"
                                                                                onClick={() => {
                                                                                    const host = activeNode?.type === 'remote' && activeNode?.api_url
                                                                                        ? new URL(activeNode.api_url).hostname
                                                                                        : window.location.hostname;
                                                                                    window.open(`http://${host}:${mainPort}`, '_blank');
                                                                                }}
                                                                                className="inline-flex items-center gap-1 text-brand hover:underline"
                                                                            >
                                                                                open <ArrowUpRight className="h-3 w-3" strokeWidth={1.5} />
                                                                            </button>
                                                                        </>
                                                                    ) : null}
                                                                </div>
                                                            </div>
                                                        </div>
                                                        <div className="flex shrink-0 items-center gap-1">
                                                            <Button
                                                                size="icon"
                                                                variant="ghost"
                                                                className="h-7 w-7 rounded-md"
                                                                onClick={() => openLogViewer(container?.Id, containerName)}
                                                                disabled={!isActive}
                                                                aria-label="View logs"
                                                            >
                                                                <ScrollText className="h-3.5 w-3.5" strokeWidth={1.5} />
                                                            </Button>
                                                            {isAdmin && (
                                                                <Button
                                                                    size="icon"
                                                                    variant="ghost"
                                                                    className="h-7 w-7 rounded-md"
                                                                    onClick={() => openBashModal(container?.Id, containerName)}
                                                                    disabled={!isActive}
                                                                    aria-label="Open bash shell"
                                                                >
                                                                    <Terminal className="h-3.5 w-3.5" strokeWidth={1.5} />
                                                                </Button>
                                                            )}
                                                            {container.Service && (
                                                                <DropdownMenu>
                                                                    <DropdownMenuTrigger asChild>
                                                                        <Button
                                                                            size="icon"
                                                                            variant="ghost"
                                                                            className="h-7 w-7 rounded-md"
                                                                            aria-label="Service actions"
                                                                        >
                                                                            <MoreVertical className="h-3.5 w-3.5" strokeWidth={1.5} />
                                                                        </Button>
                                                                    </DropdownMenuTrigger>
                                                                    <DropdownMenuContent align="end">
                                                                        {isActive ? (
                                                                            <>
                                                                                <DropdownMenuItem onSelect={() => serviceAction('restart', container.Service!)}>
                                                                                    Restart service
                                                                                </DropdownMenuItem>
                                                                                <DropdownMenuItem onSelect={() => serviceAction('stop', container.Service!)}>
                                                                                    Stop service
                                                                                </DropdownMenuItem>
                                                                            </>
                                                                        ) : (
                                                                            <DropdownMenuItem onSelect={() => serviceAction('start', container.Service!)}>
                                                                                Start service
                                                                            </DropdownMenuItem>
                                                                        )}
                                                                    </DropdownMenuContent>
                                                                </DropdownMenu>
                                                            )}
                                                        </div>
                                                    </div>
                                                    {isActive ? (
                                                        <div className="mt-2 grid grid-cols-3 gap-2">
                                                            <div className="flex items-center gap-2 rounded-md bg-background/60 px-2 py-1.5">
                                                                <div className="flex flex-col">
                                                                    <span className="font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-stat-subtitle">cpu</span>
                                                                    <span className="font-mono text-xs tabular-nums text-foreground">{stats?.cpu ?? '-'}</span>
                                                                </div>
                                                                <div className="ml-auto h-5 w-16">
                                                                    <Sparkline points={history?.cpu ?? []} stroke={sparkStroke} fill={sparkStroke} showPeak={false} />
                                                                </div>
                                                            </div>
                                                            <div className="flex items-center gap-2 rounded-md bg-background/60 px-2 py-1.5">
                                                                <div className="flex flex-col">
                                                                    <span className="font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-stat-subtitle">mem</span>
                                                                    <span className="font-mono text-xs tabular-nums text-foreground">{stats?.ram ?? '-'}</span>
                                                                </div>
                                                                <div className="ml-auto h-5 w-16">
                                                                    <Sparkline points={history?.mem ?? []} stroke={sparkStroke} fill={sparkStroke} showPeak={false} />
                                                                </div>
                                                            </div>
                                                            <div className="flex items-center gap-2 rounded-md bg-background/60 px-2 py-1.5">
                                                                <div className="flex flex-col">
                                                                    <span className="font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-stat-subtitle">net i/o</span>
                                                                    <span className="font-mono text-xs tabular-nums text-foreground">{stats?.net ?? '-'}</span>
                                                                </div>
                                                                <div className="ml-auto h-5 w-16">
                                                                    <Sparkline points={history?.netIn ?? []} stroke={sparkStroke} fill={sparkStroke} showPeak={false} />
                                                                </div>
                                                            </div>
                                                        </div>
                                                    ) : null}
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        </CardContent>
                    </Card>

                    {/* Logs Section (fills remaining left-column height) */}
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
                                <StructuredLogViewer stackName={stackName} />
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
                </div>

                {/* Right column: anatomy panel by default, Monaco editor when editing */}
                {editingCompose ? (
                    <Card className="rounded-xl border-muted overflow-hidden flex flex-col h-full min-h-0 bg-card">
                        <div className="p-4 border-b border-muted flex items-center justify-between shrink-0">
                            <div className="flex items-center gap-4">
                                <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as 'compose' | 'env' | 'files')}>
                                    <TabsList>
                                        <TabsHighlight className="rounded-md bg-glass-highlight" transition={springs.snappy}>
                                            <TabsHighlightItem value="compose">
                                                <TabsTrigger value="compose">compose.yaml</TabsTrigger>
                                            </TabsHighlightItem>
                                            <TabsHighlightItem value="env">
                                                <TabsTrigger value="env" disabled={!envExists}>.env</TabsTrigger>
                                            </TabsHighlightItem>
                                            {canRead && (
                                                <TabsHighlightItem value="files">
                                                    <TabsTrigger value="files">
                                                        <FolderOpen className="w-3.5 h-3.5 mr-1" strokeWidth={1.5} />
                                                        Files
                                                    </TabsTrigger>
                                                </TabsHighlightItem>
                                            )}
                                        </TabsHighlight>
                                    </TabsList>
                                </Tabs>

                                {activeTab === 'env' && envFiles.length > 1 && (
                                    <Select value={selectedEnvFile} onValueChange={changeEnvFile} disabled={isEditing || isFileLoading}>
                                        <SelectTrigger className="h-9 text-xs bg-muted border-none min-w-[200px]">
                                            <SelectValue placeholder="Select environment file" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {envFiles.map((file) => (
                                                <SelectItem key={file} value={file} className="text-xs">
                                                    {file.split('/').pop()}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                )}
                            </div>
                            <div className="flex items-center gap-2">
                                {activeTab !== 'files' && can('stack:edit', 'stack', stackName) && (
                                    <>
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            className="rounded-lg relative"
                                            onClick={() => setGitSourceOpen(true)}
                                        >
                                            <GitBranch className="w-4 h-4 mr-2" strokeWidth={1.5} />
                                            Git Source
                                            {gitSourcePendingMap[stackName] && (
                                                <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-brand animate-pulse" />
                                            )}
                                        </Button>
                                        {!isEditing ? (
                                            <Button size="sm" variant="default" className="rounded-lg" onClick={enterEditMode}>
                                                <Pencil className="w-4 h-4 mr-2" />
                                                Edit
                                            </Button>
                                        ) : (
                                            <div className="flex items-center">
                                                <Button size="sm" variant="default" className="rounded-l-lg rounded-r-none" onClick={requestSaveAndDeploy} disabled={loadingAction === 'deploy'}>
                                                    <Rocket className="w-4 h-4 mr-2" strokeWidth={1.5} />
                                                    Save & Deploy
                                                </Button>
                                                <DropdownMenu modal={false}>
                                                    <DropdownMenuTrigger asChild>
                                                        <Button size="sm" variant="default" className="rounded-r-lg rounded-l-none border-l border-primary-foreground/20 px-1.5" disabled={loadingAction === 'deploy'}>
                                                            <ChevronDown className="w-3.5 h-3.5" />
                                                        </Button>
                                                    </DropdownMenuTrigger>
                                                    <DropdownMenuContent align="end">
                                                        <DropdownMenuItem onClick={requestSave}>
                                                            <Save className="w-4 h-4 mr-2" strokeWidth={1.5} />
                                                            Save Only
                                                        </DropdownMenuItem>
                                                        <DropdownMenuItem onClick={discardChanges} className="text-destructive/80 focus:text-destructive">
                                                            <X className="w-4 h-4 mr-2" strokeWidth={1.5} />
                                                            Discard Changes
                                                        </DropdownMenuItem>
                                                    </DropdownMenuContent>
                                                </DropdownMenu>
                                            </div>
                                        )}
                                    </>
                                )}
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    className="rounded-lg h-8 w-8 p-0"
                                    onClick={() => {
                                        if (isEditing) {
                                            discardChanges();
                                        }
                                        setEditingCompose(false);
                                    }}
                                    aria-label="Close editor"
                                >
                                    <X className="w-4 h-4" strokeWidth={1.5} />
                                </Button>
                            </div>
                        </div>
                        <div className="flex-1 min-h-0 flex flex-col">
                            {activeTab === 'files' && canRead ? (
                                <StackFileExplorer
                                    stackName={stackName}
                                    canEdit={can('stack:edit', 'stack', stackName)}
                                    isDarkMode={isDarkMode}
                                    onNavigateToCompose={() => setActiveTab('compose')}
                                    onNavigateToEnv={() => setActiveTab('env')}
                                />
                            ) : (
                                <>
                                    {activeTab === 'env' && (
                                        <div className="bg-brand/8 border-b border-brand/20 px-4 py-2 flex items-center gap-2 text-xs text-brand">
                                            <span>
                                                Variables defined here are automatically available for substitution in your compose.yaml (e.g., <code className="bg-background px-1 rounded text-[10px]">${'{}'}VAR</code>). To pass them directly into your container, you must add <code className="bg-background px-1 rounded text-[10px]">env_file: - .env</code> to your service definition.
                                            </span>
                                        </div>
                                    )}
                                    <div className="flex-1 min-h-0 overflow-hidden">
                                        {!isFileLoading && (
                                            <Suspense fallback={<div className="w-full h-full" aria-busy="true" />}>
                                                <Editor
                                                    height="100%"
                                                    language={activeTab === 'compose' ? 'yaml' : 'plaintext'}
                                                    theme={isDarkMode ? 'vs-dark' : 'vs'}
                                                    value={activeTab === 'compose' ? safeContent : safeEnvContent}
                                                    onMount={(editor) => { monacoEditorRef.current = editor; }}
                                                    onChange={(value) => {
                                                        if (!isEditing) return; // Prevent changes in view mode
                                                        if (activeTab === 'compose') {
                                                            setContent(value || '');
                                                        } else {
                                                            setEnvContent(value || '');
                                                        }
                                                    }}
                                                    options={{
                                                        minimap: { enabled: false },
                                                        fontFamily: "'Geist Mono', monospace",
                                                        fontSize: 14,
                                                        padding: { top: 10 },
                                                        scrollBeyondLastLine: false,
                                                        readOnly: !isEditing || !can('stack:edit', 'stack', stackName),
                                                    }}
                                                />
                                            </Suspense>
                                        )}
                                        {isFileLoading && (
                                            <div className="flex items-center justify-center h-full text-muted-foreground">
                                                Loading...
                                            </div>
                                        )}
                                    </div>
                                </>
                            )}
                        </div>
                    </Card>
                ) : (
                    <StackAnatomyPanel
                        stackName={stackName}
                        content={content}
                        envContent={envContent}
                        selectedEnvFile={selectedEnvFile}
                        gitSourcePending={Boolean(gitSourcePendingMap[stackName])}
                        onEditCompose={() => { setEditingCompose(true); setActiveTab('compose'); }}
                        onOpenFiles={canRead ? () => { setEditingCompose(true); setActiveTab('files'); } : undefined}
                        onOpenGitSource={() => setGitSourceOpen(true)}
                        onApplyUpdate={() => { void updateStack(); }}
                        applying={loadingAction === 'update'}
                        canEdit={can('stack:edit', 'stack', stackName)}
                        notifications={notifications}
                    />
                )}
            </div>
        </ErrorBoundary>
    );
}
