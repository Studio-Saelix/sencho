import { useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import ErrorBoundary from '../ErrorBoundary';
import StackAnatomyPanel from '../StackAnatomyPanel';
import { MobileComposeEditor } from './MobileComposeEditor';
import { StackIdentityHeader, ContainersHealth, StackLogsSection } from './editor-view-blocks';
import { RecoveryPanel } from './RecoveryPanel';
import { StackOperationBanner } from './StackOperationBanner';
import { retryHandlerFor } from './recovery-retry';
import type { EditorViewProps } from './EditorView';

const SEGMENTS = [
    { id: 'health', label: 'Health' },
    { id: 'logs', label: 'Logs' },
    { id: 'compose', label: 'Compose' },
] as const;

type Segment = (typeof SEGMENTS)[number]['id'];

// Full-screen stack detail for the mobile shell (below md). The desktop
// two-pane grid does not fit a phone, so the same identity header, container
// health, logs, and anatomy are reorganized into a tracked-mono segmented
// control. Logs is the default segment (first-read, without copying Dockge's
// layout). From the Compose segment, an editor with stack:edit can open the
// full-screen MobileComposeEditor for small, safe compose/.env edits.
export function MobileStackDetail(props: EditorViewProps) {
    const {
        stackName,
        activeNode,
        containers,
        containerStats,
        containerStatsError,
        content,
        envContent,
        envExists,
        envFiles,
        selectedEnvFile,
        isFileLoading,
        gitSourcePendingMap,
        notifications,
        copiedDigest,
        loadingAction,
        stackMisconfigScanning,
        can,
        isAdmin,
        trivy,
        backupInfo,
        logsMode,
        activeTab,
        editingCompose,
        copiedDigestTimerRef,
        deployStack,
        restartStack,
        stopStack,
        updateStack,
        rollbackStack,
        scanStackConfig,
        requestSave,
        requestSaveAndDeploy,
        setContent,
        setEnvContent,
        changeEnvFile,
        openLogViewer,
        openBashModal,
        serviceAction,
        setLogsMode,
        setActiveTab,
        setEditingCompose,
        setGitSourceOpen,
        setCopiedDigest,
        requestDeleteStack,
        onMobileBack,
        onCloseEditor,
        hasUnsavedChanges,
        headerActions,
        recoveryResult,
        onRefreshState,
        onDismissRecovery,
        panelStartedAt,
    } = props;

    const [segment, setSegment] = useState<Segment>('logs');

    const safeContainers = containers || [];
    const isRunning = safeContainers.some(c => c.State === 'running');
    const canEditStack = can('stack:edit', 'stack', stackName);

    // The writable editor layer renders only for an editor; a stale editingCompose
    // while the user lacks stack:edit falls back to the read-only Compose segment.
    if (editingCompose && canEditStack) {
        return (
            <ErrorBoundary>
                <MobileComposeEditor
                    content={content}
                    envContent={envContent}
                    setContent={setContent}
                    setEnvContent={setEnvContent}
                    activeTab={activeTab}
                    setActiveTab={setActiveTab}
                    envExists={envExists}
                    envFiles={envFiles}
                    selectedEnvFile={selectedEnvFile}
                    changeEnvFile={changeEnvFile}
                    isFileLoading={isFileLoading}
                    loadingAction={loadingAction}
                    canEdit={canEditStack}
                    requestSave={requestSave}
                    requestSaveAndDeploy={requestSaveAndDeploy}
                    onClose={onCloseEditor}
                    hasUnsavedChanges={hasUnsavedChanges}
                />
            </ErrorBoundary>
        );
    }

    return (
        <ErrorBoundary>
            <div className="flex h-full min-h-0 flex-col">
                {/* Detail header: back to list + identity + action bar */}
                <div className="shrink-0 border-b border-hairline px-4 pb-3 pt-3">
                    <div className="mb-1 flex items-center justify-between gap-2">
                        <button
                            type="button"
                            onClick={onMobileBack}
                            aria-label="Back to stacks"
                            className="inline-flex min-h-11 items-center gap-1 pr-3 font-mono text-xs text-brand"
                        >
                            <ChevronLeft className="h-4 w-4" strokeWidth={1.6} />
                            Stacks
                        </button>
                        {headerActions ? <div className="shrink-0">{headerActions}</div> : null}
                    </div>
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
                    />
                </div>

                <StackOperationBanner
                    stackName={stackName}
                    activeNode={activeNode}
                    panelStartedAt={panelStartedAt}
                    variant="card"
                    className="mx-4 mt-3 shrink-0"
                />

                {recoveryResult && loadingAction == null && (
                    <div className="shrink-0 px-4 pt-3">
                        <RecoveryPanel
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

                {/* Segmented control: Health · Logs · Compose */}
                <div className="shrink-0 px-4 pt-3">
                    <div
                        role="tablist"
                        aria-label="Stack detail sections"
                        className="flex gap-1 rounded-lg border border-card-border bg-well p-1 shadow-[var(--shadow-well)]"
                    >
                        {SEGMENTS.map(seg => {
                            const on = seg.id === segment;
                            return (
                                <button
                                    key={seg.id}
                                    type="button"
                                    role="tab"
                                    aria-selected={on}
                                    onClick={() => setSegment(seg.id)}
                                    className={cn(
                                        'flex-1 rounded-md py-2 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors',
                                        on
                                            ? 'bg-card text-stat-value shadow-card-bevel'
                                            : 'text-stat-subtitle hover:text-foreground',
                                    )}
                                >
                                    {seg.label}
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* Active segment */}
                <div className="flex flex-1 min-h-0 flex-col overflow-hidden p-4">
                    {segment === 'health' && (
                        <div className="min-h-0 flex-1 overflow-y-auto">
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
                        </div>
                    )}
                    {segment === 'logs' && (
                        <StackLogsSection stackName={stackName} logsMode={logsMode} setLogsMode={setLogsMode} />
                    )}
                    {segment === 'compose' && (
                        <div className="min-h-0 flex-1">
                            <StackAnatomyPanel
                                stackName={stackName}
                                content={content}
                                envContent={envContent}
                                selectedEnvFile={selectedEnvFile}
                                gitSourcePending={Boolean(gitSourcePendingMap[stackName])}
                                onEditCompose={() => { setActiveTab('compose'); setEditingCompose(true); }}
                                onOpenGitSource={() => setGitSourceOpen(true)}
                                onApplyUpdate={() => { void updateStack(); }}
                                applying={loadingAction === 'update'}
                                canEdit={canEditStack}
                                notifications={notifications}
                            />
                        </div>
                    )}
                </div>
            </div>
        </ErrorBoundary>
    );
}
