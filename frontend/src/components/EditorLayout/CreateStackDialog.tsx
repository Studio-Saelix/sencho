import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Plus, GitBranch, FileCode2, FolderSearch, Loader2, type LucideIcon } from 'lucide-react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '../ui/modal';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { ScrollArea } from '../ui/scroll-area';
import { Checkbox } from '../ui/checkbox';
import { GitSourceFields, type ApplyMode } from '../stack/GitSourceFields';
import type { GitBrowseResult } from '../stack/GitComposeFilePicker';
import { ImportStackPanel } from './ImportStackPanel';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { useNodes } from '@/context/NodeContext';
import { cn } from '@/lib/utils';

export interface CreateStackDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    // sourceNodeId is the active node ID captured at the moment the user clicked
    // Create. Parent compares against the current active node before navigating
    // so a mid-flight node switch does not land the user on a 404.
    onStackCreated: (stackName: string, sourceNodeId: number | null | undefined) => void | Promise<void>;
    onStacksChanged: () => void | Promise<void>;
    // Mode the dialog opens on. The empty-state entry opens directly on 'import';
    // the toolbar Create button opens on 'empty'.
    initialMode?: CreateMode;
}

export type CreateMode = 'import' | 'empty' | 'git' | 'docker-run';

const MODES: ReadonlyArray<{ id: CreateMode; label: string; icon: LucideIcon }> = [
    { id: 'import', label: 'Import', icon: FolderSearch },
    { id: 'empty', label: 'Empty', icon: Plus },
    { id: 'git', label: 'From Git', icon: GitBranch },
    { id: 'docker-run', label: 'From Docker Run', icon: FileCode2 },
];

const tabId = (m: CreateMode) => `create-stack-tab-${m}`;
const panelId = (m: CreateMode) => `create-stack-panel-${m}`;

export function CreateStackDialog({ open, onOpenChange, onStackCreated, onStacksChanged, initialMode = 'empty' }: CreateStackDialogProps) {
    const { activeNode } = useNodes();
    const [createMode, setCreateMode] = useState<CreateMode>(initialMode);
    // Reset to the requested starting mode each time the dialog opens (empty for
    // the toolbar button, import for the empty-state entry). Tracked during render
    // via a previous-open sentinel rather than an effect, the pattern React
    // recommends for resetting state in response to a prop change.
    const [prevOpen, setPrevOpen] = useState(open);
    if (open !== prevOpen) {
        setPrevOpen(open);
        if (open) setCreateMode(initialMode);
    }
    const [newStackName, setNewStackName] = useState('');
    // Synchronous guard. The disabled-button + setState pair can race a rapid
    // second click that lands before React has committed the disabled state,
    // re-entering the handler with a stale closure value of creatingEmpty and
    // firing a second POST. The ref check is read/written synchronously inside
    // the handler so the second invocation bails before issuing another POST.
    const creatingEmptyRef = useRef(false);
    const [creatingEmpty, setCreatingEmpty] = useState(false);
    const [dockerRunInput, setDockerRunInput] = useState('');
    const [convertedYaml, setConvertedYaml] = useState<string | null>(null);
    const [isConverting, setIsConverting] = useState(false);
    const [creatingFromDockerRun, setCreatingFromDockerRun] = useState(false);
    const [gitRepoUrl, setGitRepoUrl] = useState('');
    const [gitBranch, setGitBranch] = useState('main');
    const [gitComposePaths, setGitComposePaths] = useState<string[]>(['compose.yaml']);
    const [gitContextDir, setGitContextDir] = useState('');
    const [gitSyncEnv, setGitSyncEnv] = useState(false);
    const [gitAuthType, setGitAuthType] = useState<'none' | 'token'>('none');
    const [gitToken, setGitToken] = useState('');
    const [gitApplyMode, setGitApplyMode] = useState<ApplyMode>('review');
    const [gitDeployNow, setGitDeployNow] = useState(false);
    const [creatingFromGit, setCreatingFromGit] = useState(false);

    const resetCreateFromGitForm = () => {
        setNewStackName('');
        setGitRepoUrl('');
        setGitBranch('main');
        setGitComposePaths(['compose.yaml']);
        setGitContextDir('');
        setGitSyncEnv(false);
        setGitAuthType('none');
        setGitToken('');
        setGitApplyMode('review');
        setGitDeployNow(false);
    };

    const browseGitRepo = async (): Promise<GitBrowseResult | null> => {
        if (!gitRepoUrl.trim() || !gitBranch.trim()) {
            toast.error('Enter a repository URL and branch first.');
            return null;
        }
        try {
            const body: Record<string, unknown> = {
                repo_url: gitRepoUrl.trim(),
                branch: gitBranch.trim(),
                auth_type: gitAuthType,
            };
            if (gitAuthType === 'token' && gitToken !== '') body.token = gitToken;
            const res = await apiFetch('/git-sources/browse', {
                method: 'POST',
                body: JSON.stringify(body),
            });
            if (res.ok) {
                const data = await res.json();
                return { files: data.files ?? [], truncated: data.truncated ?? false };
            }
            const err = await res.json().catch(() => ({}));
            toast.error(err?.error || 'Failed to browse repository.');
            return null;
        } catch (e) {
            toast.error((e as Error)?.message || 'Network error.');
            return null;
        }
    };

    const resetCreateFromDockerRunForm = () => {
        setDockerRunInput('');
        setConvertedYaml(null);
        setIsConverting(false);
        setCreatingFromDockerRun(false);
    };

    const handleCreateStack = async () => {
        if (creatingEmptyRef.current) return;
        if (!newStackName.trim()) return;
        const stackName = newStackName.trim();
        const sourceNodeId = activeNode?.id;
        creatingEmptyRef.current = true;
        setCreatingEmpty(true);
        try {
            const response = await apiFetch('/stacks', {
                method: 'POST',
                body: JSON.stringify({ stackName }),
            });
            if (!response.ok) {
                if (response.status === 409) {
                    throw new Error('Stack already exists.');
                }
                if (response.status === 400) {
                    throw new Error('Invalid stack name (use alphanumeric characters and hyphens only).');
                }
                const body = await response.json().catch(() => ({}));
                const backendError = (body as { error?: string })?.error;
                if (response.status === 403) {
                    throw new Error(backendError || 'You do not have permission to create stacks.');
                }
                throw new Error(backendError || 'Failed to create stack.');
            }
            onOpenChange(false);
            setNewStackName('');
            setCreateMode('empty');
            toast.success(`Stack "${stackName}" created.`);
            await onStackCreated(stackName, sourceNodeId);
        } catch (error) {
            console.error('Failed to create stack:', error);
            toast.error((error as Error).message || 'Failed to create stack.');
        } finally {
            creatingEmptyRef.current = false;
            setCreatingEmpty(false);
        }
    };

    const handleEmptyFormSubmit = (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        void handleCreateStack();
    };

    const handleCreateStackFromGit = async () => {
        const stackName = newStackName.trim();
        if (!stackName) {
            toast.error('Stack name is required.');
            return;
        }
        if (!gitRepoUrl.trim() || !gitBranch.trim() || gitComposePaths.length === 0) {
            toast.error('Repository URL, branch, and at least one compose file are required.');
            return;
        }
        if (!/^https:\/\//i.test(gitRepoUrl.trim())) {
            toast.error('Only HTTPS repository URLs are supported.');
            return;
        }
        const sourceNodeId = activeNode?.id;
        setCreatingFromGit(true);
        const loadingId = toast.loading(gitDeployNow ? 'Fetching, creating, and deploying...' : 'Fetching and creating stack...');
        try {
            const autoApply = gitApplyMode !== 'review';
            const autoDeploy = gitApplyMode === 'auto-deploy';
            const body: Record<string, unknown> = {
                stack_name: stackName,
                repo_url: gitRepoUrl.trim(),
                branch: gitBranch.trim(),
                compose_paths: gitComposePaths,
                context_dir: gitContextDir.trim() || null,
                sync_env: gitSyncEnv,
                auth_type: gitAuthType,
                auto_apply_on_webhook: autoApply,
                auto_deploy_on_apply: autoDeploy,
                deploy_now: gitDeployNow,
            };
            if (gitAuthType === 'token' && gitToken !== '') {
                body.token = gitToken;
            }
            const response = await apiFetch('/stacks/from-git', {
                method: 'POST',
                body: JSON.stringify(body),
            });
            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                if (response.status === 409) {
                    throw new Error(err?.error || 'Stack already exists.');
                }
                throw new Error(err?.error || 'Failed to create stack from Git.');
            }
            const data: {
                deployed?: boolean;
                deployError?: string;
                commitSha?: string;
                warnings?: string[];
            } = await response.json();
            const shortSha = typeof data.commitSha === 'string' ? data.commitSha.slice(0, 7) : '';
            const shaSuffix = shortSha ? ` @ ${shortSha}` : '';
            if (gitDeployNow && data.deployError) {
                toast.warning(`Stack created${shaSuffix}, but deploy failed: ${data.deployError}`);
            } else if (gitDeployNow && data.deployed) {
                toast.success(`Stack created and deployed from Git${shaSuffix}.`);
            } else {
                toast.success(`Stack created from Git${shaSuffix}.`);
            }
            if (Array.isArray(data.warnings) && data.warnings.length > 0) {
                toast.warning(data.warnings.join(' '));
            }
            onOpenChange(false);
            resetCreateFromGitForm();
            await onStackCreated(stackName, sourceNodeId);
        } catch (error) {
            console.error('Failed to create stack from Git:', error);
            toast.error((error as Error)?.message || 'Failed to create stack from Git.');
        } finally {
            toast.dismiss(loadingId);
            setCreatingFromGit(false);
        }
    };

    const handleConvertDockerRun = async () => {
        const command = dockerRunInput.trim();
        if (!command) {
            toast.error('Paste a docker run command first.');
            return;
        }
        setIsConverting(true);
        try {
            const response = await apiFetch('/convert', {
                method: 'POST',
                body: JSON.stringify({ dockerRun: command }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(data?.error || 'Could not parse command.');
            }
            if (typeof data?.yaml !== 'string' || data.yaml.length === 0) {
                throw new Error('Converter returned an empty result.');
            }
            setConvertedYaml(data.yaml);
            toast.success('Converted to compose YAML.');
        } catch (error) {
            setConvertedYaml(null);
            const err = error as { message?: string; error?: string; data?: { error?: string } };
            toast.error(
                err?.message ||
                    err?.error ||
                    err?.data?.error ||
                    'Failed to convert docker run command.',
            );
        } finally {
            setIsConverting(false);
        }
    };

    const handleCreateStackFromDockerRun = async () => {
        const stackName = newStackName.trim();
        if (!stackName) {
            toast.error('Stack name is required.');
            return;
        }
        if (!convertedYaml) {
            toast.error('Convert the command before creating the stack.');
            return;
        }
        const sourceNodeId = activeNode?.id;
        setCreatingFromDockerRun(true);
        const loadingId = toast.loading('Creating stack from converted YAML...');
        let createdStack = false;
        try {
            const createResponse = await apiFetch('/stacks', {
                method: 'POST',
                body: JSON.stringify({ stackName }),
            });
            if (!createResponse.ok) {
                if (createResponse.status === 409) {
                    throw new Error('Stack already exists.');
                }
                if (createResponse.status === 400) {
                    throw new Error('Invalid stack name (use alphanumeric characters and hyphens only).');
                }
                throw new Error('Failed to create stack.');
            }
            createdStack = true;

            const saveResponse = await apiFetch(`/stacks/${encodeURIComponent(stackName)}`, {
                method: 'PUT',
                body: JSON.stringify({ content: convertedYaml }),
            });
            if (!saveResponse.ok) {
                // Roll back the empty stack we just created so we don't leave an orphan.
                await apiFetch(`/stacks/${encodeURIComponent(stackName)}`, { method: 'DELETE' }).catch((cleanupError) => {
                    console.error('Failed to roll back orphan stack after save failure:', cleanupError);
                });
                createdStack = false;
                throw new Error('Could not save the converted YAML. Please try again.');
            }

            toast.success(`Stack "${stackName}" created from docker run.`);
            onOpenChange(false);
            resetCreateFromDockerRunForm();
            setNewStackName('');
            await onStackCreated(stackName, sourceNodeId);
        } catch (error) {
            console.error('Failed to create stack from docker run:', error);
            const err = error as { message?: string; error?: string; data?: { error?: string } };
            toast.error(
                err?.message ||
                    err?.error ||
                    err?.data?.error ||
                    'Failed to create stack from docker run.',
            );
            // If we bailed before the createdStack flag got reset, surface that the stack still exists.
            if (createdStack) {
                await Promise.resolve(onStacksChanged()).catch(() => undefined);
            }
        } finally {
            toast.dismiss(loadingId);
            setCreatingFromDockerRun(false);
        }
    };

    const busy = creatingEmpty || creatingFromGit || creatingFromDockerRun;

    return (
        <Modal
            size="xl"
            open={open}
            onOpenChange={(o) => {
                onOpenChange(o);
                if (!o) {
                    setCreateMode(initialMode);
                    resetCreateFromGitForm();
                    resetCreateFromDockerRunForm();
                    // Intentionally NOT resetting creatingEmptyRef / creatingEmpty
                    // here: the in-flight POST owns its own lifecycle and clears
                    // both flags in finally. Resetting on close would let an
                    // Escape-then-reopen sequence slip past the guard and fire a
                    // second POST before the first request settled.
                }
            }}
        >
            <ModalHeader
                kicker="STACKS · NEW"
                title="New stack"
                description="Import a compose file you already have, or create one: empty, cloned from a Git repository, or converted from a docker run command."
            />
            <ModeRail mode={createMode} onModeChange={setCreateMode} disabled={busy} />

            {createMode === 'import' && (
                <div role="tabpanel" id={panelId('import')} aria-labelledby={tabId('import')}>
                    <ImportStackPanel
                        onClose={() => onOpenChange(false)}
                        onImported={() => { void onStacksChanged(); }}
                    />
                </div>
            )}

            {createMode === 'empty' && (
                <div role="tabpanel" id={panelId('empty')} aria-labelledby={tabId('empty')}>
                    <form onSubmit={handleEmptyFormSubmit}>
                        <ModalBody>
                            <div className="space-y-2">
                                <Label htmlFor="create-stack-name">Stack Name</Label>
                                <Input
                                    id="create-stack-name"
                                    placeholder="Stack name (e.g., myapp)"
                                    value={newStackName}
                                    onChange={(e) => setNewStackName(e.target.value)}
                                    disabled={creatingEmpty}
                                    autoFocus
                                />
                            </div>
                        </ModalBody>
                        <ModalFooter
                            hint="ALPHANUMERIC · HYPHENS"
                            secondary={
                                <Button
                                    type="button"
                                    variant="ghost"
                                    onClick={() => onOpenChange(false)}
                                    disabled={creatingEmpty}
                                >
                                    Cancel
                                </Button>
                            }
                            primary={
                                <Button type="submit" disabled={creatingEmpty || !newStackName.trim()}>
                                    {creatingEmpty ? (
                                        <><Loader2 className="w-4 h-4 mr-1.5 animate-spin" strokeWidth={1.5} />Creating</>
                                    ) : (
                                        <><Plus className="w-4 h-4 mr-1.5" strokeWidth={1.5} />Create</>
                                    )}
                                </Button>
                            }
                        />
                    </form>
                </div>
            )}

            {createMode === 'git' && (
                <div role="tabpanel" id={panelId('git')} aria-labelledby={tabId('git')}>
                    <ScrollArea block className="max-h-[60vh]">
                        <ModalBody>
                            <div className="space-y-2">
                                <Label htmlFor="create-git-stack-name">Stack Name</Label>
                                <Input
                                    id="create-git-stack-name"
                                    placeholder="Stack name (e.g., myapp)"
                                    value={newStackName}
                                    onChange={(e) => setNewStackName(e.target.value)}
                                    disabled={creatingFromGit}
                                />
                            </div>

                            <GitSourceFields
                                variant="create"
                                disabled={creatingFromGit}
                                repoUrl={gitRepoUrl}
                                branch={gitBranch}
                                composePaths={gitComposePaths}
                                contextDir={gitContextDir}
                                syncEnv={gitSyncEnv}
                                authType={gitAuthType}
                                token={gitToken}
                                hasStoredToken={false}
                                applyMode={gitApplyMode}
                                onRepoUrlChange={setGitRepoUrl}
                                onBranchChange={setGitBranch}
                                onComposePathsChange={setGitComposePaths}
                                onContextDirChange={setGitContextDir}
                                onSyncEnvChange={setGitSyncEnv}
                                onAuthTypeChange={setGitAuthType}
                                onTokenChange={setGitToken}
                                onApplyModeChange={setGitApplyMode}
                                onBrowse={browseGitRepo}
                            />

                            <div className="flex items-center gap-2">
                                <Checkbox
                                    id="create-git-deploy-now"
                                    checked={gitDeployNow}
                                    onCheckedChange={(c) => setGitDeployNow(c === true)}
                                    disabled={creatingFromGit}
                                />
                                <Label htmlFor="create-git-deploy-now" className="text-xs cursor-pointer">
                                    Deploy after create
                                </Label>
                            </div>
                        </ModalBody>
                    </ScrollArea>
                    <ModalFooter
                        hint="HTTPS REPOS ONLY"
                        secondary={
                            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={creatingFromGit}>
                                Cancel
                            </Button>
                        }
                        primary={
                            <Button onClick={handleCreateStackFromGit} disabled={creatingFromGit}>
                                {creatingFromGit ? (
                                    <><Loader2 className="w-4 h-4 mr-1.5 animate-spin" strokeWidth={1.5} />Creating</>
                                ) : (
                                    <><GitBranch className="w-4 h-4 mr-1.5" strokeWidth={1.5} />Create from Git</>
                                )}
                            </Button>
                        }
                    />
                </div>
            )}

            {createMode === 'docker-run' && (
                <div role="tabpanel" id={panelId('docker-run')} aria-labelledby={tabId('docker-run')}>
                    <ScrollArea block className="max-h-[60vh]">
                        <ModalBody>
                            <div className="space-y-2">
                                <Label htmlFor="create-dr-stack-name">Stack Name</Label>
                                <Input
                                    id="create-dr-stack-name"
                                    placeholder="Stack name (e.g., myapp)"
                                    value={newStackName}
                                    onChange={(e) => setNewStackName(e.target.value)}
                                    disabled={creatingFromDockerRun}
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="create-dr-command">Paste your docker run command</Label>
                                <textarea
                                    id="create-dr-command"
                                    spellCheck={false}
                                    className="flex w-full rounded-md border border-glass-border bg-input px-3 py-2 text-sm font-mono shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 min-h-[120px] resize-y"
                                    placeholder="docker run -d --name nginx -p 8080:80 nginx:latest"
                                    value={dockerRunInput}
                                    onChange={(e) => {
                                        setDockerRunInput(e.target.value);
                                        if (convertedYaml !== null) setConvertedYaml(null);
                                    }}
                                    disabled={creatingFromDockerRun}
                                />
                                <div className="flex justify-end">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={handleConvertDockerRun}
                                        disabled={isConverting || creatingFromDockerRun || !dockerRunInput.trim()}
                                    >
                                        {isConverting ? (
                                            <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" strokeWidth={1.5} />Converting</>
                                        ) : (
                                            <><FileCode2 className="w-3.5 h-3.5 mr-1.5" strokeWidth={1.5} />Convert</>
                                        )}
                                    </Button>
                                </div>
                            </div>
                            {convertedYaml !== null && (
                                <div className="space-y-2">
                                    <Label>compose.yaml preview</Label>
                                    <ScrollArea block className="max-h-[240px] rounded-md border border-card-border border-t-card-border-top bg-card shadow-card-bevel">
                                        <pre className="px-3 py-2 text-xs font-mono whitespace-pre leading-relaxed">
                                            {convertedYaml}
                                        </pre>
                                    </ScrollArea>
                                </div>
                            )}
                        </ModalBody>
                    </ScrollArea>
                    <ModalFooter
                        hint={convertedYaml ? 'YAML READY' : 'CONVERT FIRST'}
                        hintAccent={convertedYaml ? `${convertedYaml.split('\n').length} LINES` : undefined}
                        secondary={
                            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={creatingFromDockerRun}>
                                Cancel
                            </Button>
                        }
                        primary={
                            <Button
                                onClick={handleCreateStackFromDockerRun}
                                disabled={creatingFromDockerRun || !convertedYaml || !newStackName.trim()}
                            >
                                {creatingFromDockerRun ? (
                                    <><Loader2 className="w-4 h-4 mr-1.5 animate-spin" strokeWidth={1.5} />Creating</>
                                ) : (
                                    <><Plus className="w-4 h-4 mr-1.5" strokeWidth={1.5} />Create Stack</>
                                )}
                            </Button>
                        }
                    />
                </div>
            )}
        </Modal>
    );
}

function ModeRail({
    mode,
    onModeChange,
    disabled,
}: {
    mode: CreateMode;
    onModeChange: (m: CreateMode) => void;
    disabled: boolean;
}) {
    const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const activeIndex = MODES.findIndex((m) => m.id === mode);

    const focusTab = (index: number) => {
        const target = tabRefs.current[index];
        if (target) {
            target.focus();
            onModeChange(MODES[index].id);
        }
    };

    const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        if (disabled) return;
        if (e.key === 'ArrowRight') {
            e.preventDefault();
            focusTab((activeIndex + 1) % MODES.length);
        } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            focusTab((activeIndex - 1 + MODES.length) % MODES.length);
        } else if (e.key === 'Home') {
            e.preventDefault();
            focusTab(0);
        } else if (e.key === 'End') {
            e.preventDefault();
            focusTab(MODES.length - 1);
        }
    };

    return (
        <div
            role="tablist"
            aria-label="Stack source"
            className="grid grid-cols-4 border-b border-card-border/60"
            onKeyDown={handleKeyDown}
        >
            {MODES.map((m, i) => {
                const isActive = mode === m.id;
                const Icon = m.icon;
                return (
                    <button
                        key={m.id}
                        ref={(el) => { tabRefs.current[i] = el; }}
                        type="button"
                        role="tab"
                        id={tabId(m.id)}
                        aria-selected={isActive}
                        aria-controls={panelId(m.id)}
                        tabIndex={isActive ? 0 : -1}
                        disabled={disabled}
                        onClick={() => onModeChange(m.id)}
                        className={cn(
                            'relative flex items-center justify-center gap-2 px-4 py-2.5',
                            'font-mono text-[10px] uppercase tracking-[0.18em]',
                            'transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand focus-visible:ring-inset',
                            i < MODES.length - 1 && 'border-r border-card-border/60',
                            isActive ? 'text-brand' : 'text-stat-subtitle hover:text-brand',
                        )}
                    >
                        <Icon className="h-3.5 w-3.5" strokeWidth={1.5} />
                        <span>{m.label}</span>
                        {isActive && (
                            <span aria-hidden className="absolute inset-x-3 bottom-0 h-[2px] bg-brand" />
                        )}
                    </button>
                );
            })}
        </div>
    );
}
