import { ChevronLeft, Save, Rocket } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '../ui/button';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import type { StackAction } from './EditorView';

interface MobileComposeEditorProps {
    content: string;
    envContent: string;
    setContent: (next: string) => void;
    setEnvContent: (next: string) => void;
    activeTab: 'compose' | 'env' | 'files';
    setActiveTab: (tab: 'compose' | 'env' | 'files') => void;
    envExists: boolean;
    envFiles: string[];
    selectedEnvFile: string;
    changeEnvFile: (file: string) => Promise<void>;
    isFileLoading: boolean;
    loadingAction: StackAction | null;
    canEdit: boolean;
    requestSave: () => void;
    requestSaveAndDeploy: (e: React.MouseEvent) => void;
    onClose: () => void;
    hasUnsavedChanges: () => boolean;
}

// Full-screen phone editing surface for the compose file and the selected .env.
// Deliberately a lightweight monospace textarea, not Monaco: the flow is scoped to
// small, safe edits, and the native keyboard plus reliable touch scrolling matter
// more than syntax highlighting here. Every save protection (ETag conflict, diff
// preview, save-and-deploy, dirty-navigation guard) is reused from useStackActions
// via the shared editor state, so this surface only renders the controls.
export function MobileComposeEditor(props: MobileComposeEditorProps) {
    const {
        content,
        envContent,
        setContent,
        setEnvContent,
        activeTab,
        setActiveTab,
        envExists,
        envFiles,
        selectedEnvFile,
        changeEnvFile,
        isFileLoading,
        loadingAction,
        canEdit,
        requestSave,
        requestSaveAndDeploy,
        onClose,
        hasUnsavedChanges,
    } = props;

    // 'files' never opens on mobile; fall back to compose so the textarea always
    // shows an editable buffer the save handlers can target.
    const tab: 'compose' | 'env' = activeTab === 'env' && envExists ? 'env' : 'compose';
    const value = tab === 'compose' ? content || '' : envContent || '';
    // Switching the env file refetches and overwrites the env buffer, so block it
    // while there are unsaved edits (matches the desktop selector being disabled
    // mid-edit). The compose <-> .env toggle stays free: both buffers persist.
    const envSwitchDisabled = hasUnsavedChanges() || isFileLoading;
    const actionsDisabled = isFileLoading || loadingAction === 'deploy';

    return (
        <div className="flex h-full min-h-0 flex-col">
            {/* Header: close + file selector */}
            <div className="shrink-0 border-b border-hairline px-4 pb-3 pt-3">
                <div className="flex items-center justify-between gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close editor"
                        data-testid="mobile-editor-close"
                        className="inline-flex min-h-11 items-center gap-1 pr-3 font-mono text-xs text-brand"
                    >
                        <ChevronLeft className="h-4 w-4" strokeWidth={1.6} />
                        Cancel
                    </button>
                    {envExists ? (
                        <div
                            role="tablist"
                            aria-label="File to edit"
                            className="flex gap-1 rounded-lg border border-card-border bg-well p-1 shadow-[var(--shadow-well)]"
                        >
                            {(['compose', 'env'] as const).map(id => {
                                const on = tab === id;
                                return (
                                    <button
                                        key={id}
                                        type="button"
                                        role="tab"
                                        aria-selected={on}
                                        onClick={() => setActiveTab(id)}
                                        className={cn(
                                            'rounded-md px-3 py-1.5 font-mono text-[11px] lowercase tracking-[0.08em] transition-colors',
                                            on
                                                ? 'bg-card text-stat-value shadow-card-bevel'
                                                : 'text-stat-subtitle hover:text-foreground',
                                        )}
                                    >
                                        {id === 'compose' ? 'compose' : '.env'}
                                    </button>
                                );
                            })}
                        </div>
                    ) : (
                        <span className="font-mono text-[11px] lowercase tracking-[0.08em] text-stat-subtitle">
                            compose.yaml
                        </span>
                    )}
                </div>

                {tab === 'env' && envFiles.length > 1 && (
                    <Select value={selectedEnvFile} onValueChange={changeEnvFile} disabled={envSwitchDisabled}>
                        <SelectTrigger className="mt-2 h-9 min-h-11 w-full border-card-border bg-input text-xs">
                            <SelectValue placeholder="Select environment file" />
                        </SelectTrigger>
                        <SelectContent>
                            {envFiles.map(file => (
                                <SelectItem key={file} value={file} className="text-xs">
                                    {file.split('/').pop()}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                )}
            </div>

            {/* Editor */}
            <div className="min-h-0 flex-1 overflow-hidden p-3">
                <textarea
                    data-testid="mobile-compose-editor"
                    value={value}
                    onChange={e => {
                        if (!canEdit) return;
                        if (tab === 'compose') setContent(e.target.value);
                        else setEnvContent(e.target.value);
                    }}
                    readOnly={!canEdit}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    autoComplete="off"
                    wrap="off"
                    aria-label={tab === 'compose' ? 'Compose file content' : 'Environment file content'}
                    className="h-full w-full resize-none overflow-auto whitespace-pre rounded-lg border border-card-border bg-input px-3 py-2.5 font-mono text-[13px] leading-relaxed text-foreground shadow-card-bevel focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
            </div>

            {/* Safety note + save actions */}
            <div className="shrink-0 space-y-2.5 border-t border-hairline px-4 py-3">
                <p className="font-mono text-[11px] leading-snug text-stat-subtitle">
                    Mobile editing is for small, safe changes. For large rewrites, open this stack on desktop.
                </p>
                {canEdit && (
                    <div className="flex items-center gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            onClick={requestSave}
                            disabled={actionsDisabled}
                            data-testid="mobile-editor-save"
                            className="h-11 flex-1 rounded-lg"
                        >
                            <Save className="mr-2 h-4 w-4" strokeWidth={1.5} />
                            Save
                        </Button>
                        <Button
                            type="button"
                            variant="default"
                            onClick={requestSaveAndDeploy}
                            disabled={actionsDisabled}
                            data-testid="mobile-editor-save-deploy"
                            className="h-11 flex-1 rounded-lg"
                        >
                            <Rocket className="mr-2 h-4 w-4" strokeWidth={1.5} />
                            Save &amp; Deploy
                        </Button>
                    </div>
                )}
            </div>
        </div>
    );
}
