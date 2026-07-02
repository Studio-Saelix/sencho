import { Suspense, useRef, useEffect, useState } from 'react';
import { Editor } from '@/lib/monacoLoader';
import {
    Save,
    Pencil,
    X,
    Rocket,
    ChevronDown,
    GitBranch,
    FolderOpen,
    Maximize2,
    Minimize2,
} from 'lucide-react';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader } from '../ui/card';
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
    DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { springs } from '@/lib/motion';
import ErrorBoundary from '../ErrorBoundary';
import StackAnatomyPanel from '../StackAnatomyPanel';
import { StackFileExplorer } from '@/components/files/StackFileExplorer';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { StackIdentityHeader, ContainersHealth, StackLogsSection } from './editor-view-blocks';
import { MobileStackDetail } from './MobileStackDetail';
import { RecoveryChip } from './RecoveryChip';
import { StackOperationBanner } from './StackOperationBanner';
import { retryHandlerFor } from './recovery-retry';
import type { NotificationItem } from '../dashboard/types';
import type { Node } from '@/context/NodeContext';
import type { useAuth } from '@/context/AuthContext';
import type { useStackMuteActions } from '@/hooks/useMuteRuleActions';

export interface ContainerInfo {
    Id: string;
    Names: string[];
    Service?: string;
    State: string;
    Status?: string;
    Ports?: { PrivatePort: number; PublicPort: number; Type?: string }[];
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

/**
 * Stack operations the recovery panel can offer safe next steps for. A failed
 * stop/start/delete is not "recoverable" through retry/restart/rollback, so it
 * never produces a record; narrowing the type keeps the panel's retry routing
 * exhaustive.
 */
export type RecoverableAction = Extract<StackAction, 'deploy' | 'update' | 'restart' | 'rollback'>;

/**
 * Server-side classification of a failed deploy/update: a cause headline and a
 * suggested next step. `reason` stays a plain string here; the backend owns the
 * category vocabulary and the UI only displays it.
 */
export interface FailureClassification {
    reason: string;
    label: string;
    suggestion: string;
}

/**
 * Terminal record of a failed stack operation, kept in memory per stack so the
 * recovery panel can offer safe next steps after an update/deploy fails or
 * stalls. Cleared when the same stack's next operation succeeds or is dismissed,
 * and on active-node change (the keyed stack filename can repeat across nodes).
 */
export interface StackActionResult {
    action: RecoverableAction;
    rolledBack: boolean;
    errorMessage?: string;
    startedAt: number;
    endedAt: number;
    // Last live output line captured only when a matching deploy-feedback
    // session was streaming this stack at failure time; omitted otherwise so a
    // line from another stack/session never leaks into diagnostics.
    lastOutputLine?: string;
    // Classified cause + suggested next action from the failed response body,
    // when the backend (or the unreachable-node fallback) provided one.
    failure?: FailureClassification;
}

export interface ContainerStatsEntry {
    cpu: string;
    ram: string;
    net: string;
    lastRx?: number;
    lastTx?: number;
    history: { cpu: number[]; mem: number[]; netIn: number[]; netOut: number[] };
}

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

    // Composed action: wraps setStackToDelete + setDeleteDialogOpen
    requestDeleteStack: () => void;

    // Recovery surface for a failed/stalled operation on this stack (undefined
    // when the last op succeeded or none has run). onRefreshState re-syncs
    // container state; onDismissRecovery drops the record.
    recoveryResult?: StackActionResult;
    onRefreshState: () => void;
    onDismissRecovery: () => void;

    // Session start (ms) of the active deploy-feedback op, or null when none, for
    // the inline progress banner's elapsed readout.
    panelStartedAt: number | null;

    // Mobile-only: back affordance in the detail header returns to the stack list.
    onMobileBack?: () => void;
    // Mobile-only (always supplied by renderEditor): close the full-screen
    // compose/.env editor, routed through the unsaved-changes guard so a dirty
    // close prompts before discarding. Required, not optional, because the
    // fallback would silently discard edits; the desktop EditorView ignores it.
    onCloseEditor: () => void;
    // Mobile-only (always supplied by renderEditor): true when the compose or env
    // buffer differs from disk; gates the env-file selector so switching files
    // cannot drop unsaved edits. Required so a wiring gap is a compile error
    // rather than a silently-disabled data-loss guard.
    hasUnsavedChanges: () => boolean;
    // Mobile-only: notifications + more-menu cluster for the detail header right
    // slot (the global TopBar is dropped on the full-screen detail surface).
    headerActions?: React.ReactNode;

    stackMuteActions?: ReturnType<typeof useStackMuteActions>;
}

export function EditorView(props: EditorViewProps) {
    const {
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
        recoveryResult,
        onRefreshState,
        onDismissRecovery,
        panelStartedAt,
        stackMuteActions,
    } = props;
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

    // Fullscreen the file browser + editor by collapsing the left column. Only
    // meaningful on the files tab; reset when leaving it or closing the editor so
    // it can never strand the compose/env panels in a single-column layout.
    const [filesFullscreen, setFilesFullscreen] = useState(false);
    useEffect(() => {
        if (!editingCompose || activeTab !== 'files') setFilesFullscreen(false);
    }, [editingCompose, activeTab]);

    // Expand the logs by collapsing the Command Center card so the logs pane
    // fills the left column. Toggled from the structured log viewer header.
    const [logsExpanded, setLogsExpanded] = useState(false);
    // The expand control lives only in the structured viewer; reset when the
    // raw terminal is selected so the Command Center can't be stranded hidden.
    useEffect(() => {
        if (logsMode === 'raw') setLogsExpanded(false);
    }, [logsMode]);

    // Below md, render the segmented full-screen mobile detail instead of the
    // desktop two-pane grid. All hooks above run unconditionally before this
    // branch so hook order stays stable across breakpoints.
    const isMobile = useIsMobile();
    if (isMobile) {
        return <MobileStackDetail {...props} />;
    }

    return (
        <ErrorBoundary>
            <div className={`grid gap-6 ${filesFullscreen ? 'grid-cols-1' : 'grid-cols-1 lg:grid-cols-2'} min-h-[600px] h-[calc(100vh-160px)] max-h-[1040px]`}>
                {/* Left column: identity + health strip + logs, stacked. Hidden in
                    files fullscreen so the editor card fills the width. */}
                {!filesFullscreen && (
                <div className="flex flex-col gap-6 min-h-0">
                    {/* Command Center Card (identity + health strip). Hidden when
                        the logs are expanded so the logs pane fills the column. */}
                    {!logsExpanded && (
                    <Card className="rounded-xl border-muted bg-card shrink-0">
                        <CardHeader className="p-4 pb-2">
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0 flex-1">
                                    <StackIdentityHeader
                                        stackName={stackName}
                                        activeNode={activeNode}
                                        safeContainers={safeContainers}
                                        isRunning={isRunning}
                                        copiedDigest={copiedDigest}
                                        setCopiedDigest={setCopiedDigest}
                                        copiedDigestTimerRef={copiedDigestTimerRef}
                                        can={can}
                                        isAdmin={isAdmin}
                                        trivy={trivy}
                                        backupInfo={backupInfo}
                                        loadingAction={loadingAction}
                                        stackMisconfigScanning={stackMisconfigScanning}
                                        deployStack={deployStack}
                                        restartStack={restartStack}
                                        stopStack={stopStack}
                                        updateStack={updateStack}
                                        rollbackStack={rollbackStack}
                                        scanStackConfig={scanStackConfig}
                                        requestDeleteStack={requestDeleteStack}
                                        stackMuteActions={stackMuteActions}
                                    />
                                </div>
                                {recoveryResult && loadingAction == null && (
                                    <div className="shrink-0">
                                        <RecoveryChip
                                            stackName={stackName}
                                            result={recoveryResult}
                                            activeNode={activeNode}
                                            backupInfo={backupInfo}
                                            canDeploy={can('stack:deploy', 'stack', stackName)}
                                            onRetry={retryHandlerFor(recoveryResult.action, { deployStack, restartStack, updateStack, rollbackStack })}
                                            onRestart={restartStack}
                                            onRollback={rollbackStack}
                                            onRefreshState={onRefreshState}
                                            onDismiss={onDismissRecovery}
                                        />
                                    </div>
                                )}
                            </div>
                        </CardHeader>
                        <StackOperationBanner
                            stackName={stackName}
                            activeNode={activeNode}
                            panelStartedAt={panelStartedAt}
                            variant="band"
                        />
                        <CardContent className="p-4 pt-2">
                            <ContainersHealth
                                safeContainers={safeContainers}
                                containerStats={containerStats}
                                containerStatsError={containerStatsError}
                                isAdmin={isAdmin}
                                activeNode={activeNode}
                                openLogViewer={openLogViewer}
                                openBashModal={openBashModal}
                                serviceAction={serviceAction}
                            />
                        </CardContent>
                    </Card>
                    )}

                    {/* Logs Section (fills remaining left-column height) */}
                    <StackLogsSection
                        stackName={stackName}
                        logsMode={logsMode}
                        setLogsMode={setLogsMode}
                        logsExpanded={logsExpanded}
                        onToggleLogsExpand={() => setLogsExpanded((v) => !v)}
                    />
                </div>
                )}

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
                                {activeTab === 'files' && (
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        className="rounded-lg h-8 w-8 p-0"
                                        onClick={() => setFilesFullscreen((v) => !v)}
                                        aria-label={filesFullscreen ? 'Exit full screen' : 'Full screen'}
                                        title={filesFullscreen ? 'Exit full screen' : 'Full screen'}
                                    >
                                        {filesFullscreen
                                            ? <Minimize2 className="w-4 h-4" strokeWidth={1.5} />
                                            : <Maximize2 className="w-4 h-4" strokeWidth={1.5} />}
                                    </Button>
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
                                                Variables defined in the project environment file are available for substitution in your compose.yaml (e.g., <code className="bg-background px-1 rounded text-[10px]">${'{}'}VAR</code>). To pass them directly into your container, add <code className="bg-background px-1 rounded text-[10px]">env_file: - .env</code> to your service definition.
                                            </span>
                                        </div>
                                    )}
                                    <div className="flex-1 min-h-0 overflow-hidden">
                                        {!isFileLoading && (
                                            <Suspense fallback={<div className="w-full h-full" aria-busy="true" />}>
                                                <Editor
                                                    height="100%"
                                                    language={activeTab === 'compose' ? 'yaml' : 'ini'}
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
                        stackMuteActions={stackMuteActions}
                    />
                )}
            </div>
        </ErrorBoundary>
    );
}
