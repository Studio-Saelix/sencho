import { useState, useEffect, useCallback } from 'react';
import { GitBranch, Loader2, Trash2, RefreshCw, Save, AlertCircle } from 'lucide-react';
import { Modal, ModalHeader, ConfirmModal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { apiFetch } from '@/lib/api';
import { useDeployFeedback } from '@/context/DeployFeedbackContext';
import { useNodes } from '@/context/NodeContext';
import { toast } from '@/components/ui/toast-store';
import { GitSourceDiffDialog, type PullResult } from './GitSourceDiffDialog';
import { GitSourceFields, type ApplyMode } from './GitSourceFields';

export interface GitSource {
  id: number;
  stack_name: string;
  repo_url: string;
  branch: string;
  compose_path: string;
  sync_env: boolean;
  env_path: string | null;
  auth_type: 'none' | 'token';
  has_token: boolean;
  auto_apply_on_webhook: boolean;
  auto_deploy_on_apply: boolean;
  last_applied_commit_sha: string | null;
  pending_commit_sha: string | null;
  pending_fetched_at: number | null;
  created_at: number;
  updated_at: number;
}

interface GitSourcePanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stackName: string;
  canEdit: boolean;
  isDarkMode: boolean;
  /** Called after any change that may affect the sidebar pending-badge. */
  onSourceChanged?: () => void;
}

function deriveApplyMode(source: GitSource | null, pendingMode: ApplyMode | null): ApplyMode {
  if (pendingMode) return pendingMode;
  if (!source) return 'review';
  if (!source.auto_apply_on_webhook) return 'review';
  return source.auto_deploy_on_apply ? 'auto-deploy' : 'auto-write';
}

export function GitSourcePanel({
  open,
  onOpenChange,
  stackName,
  canEdit,
  isDarkMode,
  onSourceChanged,
}: GitSourcePanelProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [applying, setApplying] = useState(false);
  const [source, setSource] = useState<GitSource | null>(null);

  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [composePath, setComposePath] = useState('compose.yaml');
  const [syncEnv, setSyncEnv] = useState(false);
  const [authType, setAuthType] = useState<'none' | 'token'>('none');
  const [token, setToken] = useState('');
  const [applyModeOverride, setApplyModeOverride] = useState<ApplyMode | null>(null);

  const [pull, setPull] = useState<PullResult | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false);

  const { runWithLog } = useDeployFeedback();
  const { activeNode } = useNodes();
  const applyMode = deriveApplyMode(source, applyModeOverride);

  const resetToUnlinked = useCallback(() => {
    setSource(null);
    setRepoUrl('');
    setBranch('main');
    setComposePath('compose.yaml');
    setSyncEnv(false);
    setAuthType('none');
    setToken('');
    setApplyModeOverride(null);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/stacks/${encodeURIComponent(stackName)}/git-source`);
      if (res.ok) {
        const data: GitSource | { linked: false } = await res.json();
        // An existing stack with no Git source attached answers 200 { linked: false }.
        if ('linked' in data) {
          resetToUnlinked();
        } else {
          setSource(data);
          setRepoUrl(data.repo_url);
          setBranch(data.branch);
          setComposePath(data.compose_path);
          setSyncEnv(data.sync_env);
          setAuthType(data.auth_type);
          setToken('');
          setApplyModeOverride(null);
        }
      } else if (res.status === 404) {
        resetToUnlinked();
      } else if (res.status === 403) {
        setSource(null);
        toast.error('You do not have permission to view this stack\'s Git source.');
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err?.error || 'Failed to load Git source.');
      }
    } catch (e) {
      toast.error((e as Error)?.message || 'Network error.');
    } finally {
      setLoading(false);
    }
  }, [stackName, resetToUnlinked]);

  useEffect(() => {
    if (open) {
      void load();
    }
  }, [open, load]);

  const save = async () => {
    if (!repoUrl.trim() || !branch.trim() || !composePath.trim()) {
      toast.error('Repository URL, branch, and compose path are required.');
      return;
    }
    if (!/^https:\/\//i.test(repoUrl.trim())) {
      toast.error('Only HTTPS repository URLs are supported.');
      return;
    }
    setSaving(true);
    const loadingId = toast.loading('Verifying repository access...');
    try {
      const autoApply = applyMode !== 'review';
      const autoDeploy = applyMode === 'auto-deploy';
      const body: Record<string, unknown> = {
        repo_url: repoUrl.trim(),
        branch: branch.trim(),
        compose_path: composePath.trim(),
        sync_env: syncEnv,
        auth_type: authType,
        auto_apply_on_webhook: autoApply,
        auto_deploy_on_apply: autoDeploy,
      };
      if (authType === 'token' && token !== '') {
        body.token = token;
      }
      const res = await apiFetch(`/stacks/${encodeURIComponent(stackName)}/git-source`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data: GitSource = await res.json();
        setSource(data);
        setToken('');
        setApplyModeOverride(null);
        toast.success('Git source saved.');
        onSourceChanged?.();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err?.error || 'Failed to save Git source.');
      }
    } catch (e) {
      toast.error((e as Error)?.message || 'Network error.');
    } finally {
      toast.dismiss(loadingId);
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!source) return;
    setRemoveConfirmOpen(false);
    setDeleting(true);
    try {
      const res = await apiFetch(`/stacks/${encodeURIComponent(stackName)}/git-source`, {
        method: 'DELETE',
      });
      if (res.ok) {
        toast.success('Git source removed.');
        setSource(null);
        onSourceChanged?.();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err?.error || 'Failed to remove Git source.');
      }
    } catch (e) {
      toast.error((e as Error)?.message || 'Network error.');
    } finally {
      setDeleting(false);
    }
  };

  const pullNow = async () => {
    if (!source) return;
    setPulling(true);
    const loadingId = toast.loading('Fetching from Git...');
    try {
      const res = await apiFetch(`/stacks/${encodeURIComponent(stackName)}/git-source/pull`, {
        method: 'POST',
      });
      if (res.ok) {
        const data: PullResult = await res.json();
        setPull(data);
        setDiffOpen(true);
        onSourceChanged?.();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err?.error || 'Pull failed.');
      }
    } catch (e) {
      toast.error((e as Error)?.message || 'Network error.');
    } finally {
      toast.dismiss(loadingId);
      setPulling(false);
    }
  };

  const applyPull = async (commitSha: string, deploy: boolean) => {
    setApplying(true);
    const loadingId = toast.loading(deploy ? 'Applying and deploying...' : 'Applying changes...');
    try {
      const runApply = async (started: Promise<void>) => {
        if (deploy) await started;
        const res = await apiFetch(`/stacks/${encodeURIComponent(stackName)}/git-source/apply`, {
          method: 'POST',
          body: JSON.stringify({ commitSha, deploy }),
        });
        if (res.ok) {
          const data: { applied: boolean; deployed: boolean; deployError?: string } = await res.json();
          if (data.deployError) {
            toast.warning(`Applied, but deploy failed: ${data.deployError}`);
          } else if (deploy && data.deployed) {
            toast.success('Changes applied and deployed.');
          } else {
            toast.success('Changes applied.');
          }
          setDiffOpen(false);
          setPull(null);
          await load();
          onSourceChanged?.();
          return { ok: true };
        } else {
          const err = await res.json().catch(() => ({}));
          const msg = (err as { error?: string }).error || 'Failed to apply changes.';
          toast.error(msg);
          return { ok: false, errorMessage: msg };
        }
      };

      if (deploy) {
        await runWithLog({ stackName, action: 'deploy', nodeId: activeNode?.id ?? null }, runApply);
      } else {
        await runApply(Promise.resolve());
      }
    } catch (e: unknown) {
      toast.error((e as Error)?.message || 'Something went wrong.');
    } finally {
      toast.dismiss(loadingId);
      setApplying(false);
    }
  };

  const dismissPending = async () => {
    try {
      const res = await apiFetch(`/stacks/${encodeURIComponent(stackName)}/git-source/dismiss-pending`, {
        method: 'POST',
      });
      if (res.ok) {
        setDiffOpen(false);
        setPull(null);
        await load();
        onSourceChanged?.();
        toast.success('Pending update dismissed.');
      }
    } catch (e) {
      toast.error((e as Error)?.message || 'Network error.');
    }
  };

  return (
    <>
      <Modal open={open} onOpenChange={onOpenChange} size="xl">
        <ModalHeader
          kicker={`${stackName.toUpperCase()} · GIT SOURCE`}
          title={
            <span className="flex items-center gap-2">
              <GitBranch className="w-5 h-5" strokeWidth={1.5} />
              Git source
            </span>
          }
          description="Link this stack to a Git repository so compose updates can be pulled on demand or via webhook."
        />

          <ScrollArea className="max-h-[70vh]">
            <div className="px-6 py-5 space-y-5">
              {loading ? (
                <div className="space-y-3">
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                </div>
              ) : (
                <>
                  {source?.pending_commit_sha && (
                    <div className="flex items-start gap-2 rounded-md border border-brand/30 bg-brand/5 px-3 py-2 text-xs shadow-card-bevel">
                      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-brand" strokeWidth={1.5} />
                      <div className="flex-1">
                        <p className="font-medium">Pending update</p>
                        <p className="text-stat-subtitle mt-0.5">
                          Commit <span className="font-mono tabular-nums">{source.pending_commit_sha.slice(0, 7)}</span> is ready to review.
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7"
                        onClick={() => pullNow()}
                        disabled={pulling}
                      >
                        Review
                      </Button>
                    </div>
                  )}

                  <GitSourceFields
                    variant="edit"
                    disabled={!canEdit || saving}
                    repoUrl={repoUrl}
                    branch={branch}
                    composePath={composePath}
                    syncEnv={syncEnv}
                    authType={authType}
                    token={token}
                    hasStoredToken={source?.has_token ?? false}
                    applyMode={applyMode}
                    onRepoUrlChange={setRepoUrl}
                    onBranchChange={setBranch}
                    onComposePathChange={setComposePath}
                    onSyncEnvChange={setSyncEnv}
                    onAuthTypeChange={setAuthType}
                    onTokenChange={setToken}
                    onApplyModeChange={setApplyModeOverride}
                  />

                  {source && (
                    <div className="rounded-md border border-glass-border bg-muted/30 px-3 py-2 text-[11px] text-stat-subtitle space-y-0.5 shadow-card-bevel">
                      <div className="flex justify-between gap-2">
                        <span>Last applied commit</span>
                        <span className="font-mono tabular-nums">
                          {source.last_applied_commit_sha ? source.last_applied_commit_sha.slice(0, 7) : 'never'}
                        </span>
                      </div>
                      <div className="flex justify-between gap-2">
                        <span>Updated</span>
                        <span className="font-mono tabular-nums">
                          {new Date(source.updated_at).toLocaleString()}
                        </span>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </ScrollArea>

          <div className="px-6 py-4 border-t border-glass-border flex items-center justify-between gap-2">
            <div>
              {source && canEdit && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setRemoveConfirmOpen(true)}
                  disabled={deleting || saving}
                  className="text-destructive/60 hover:bg-destructive hover:text-destructive-foreground"
                >
                  <Trash2 className="w-4 h-4 mr-1.5" strokeWidth={1.5} />
                  Remove
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2">
              {source && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={pullNow}
                  disabled={pulling || saving}
                >
                  {pulling ? (
                    <><Loader2 className="w-4 h-4 mr-1.5 animate-spin" strokeWidth={1.5} />Pulling</>
                  ) : (
                    <><RefreshCw className="w-4 h-4 mr-1.5" strokeWidth={1.5} />Pull now</>
                  )}
                </Button>
              )}
              {canEdit && (
                <Button size="sm" onClick={save} disabled={saving}>
                  {saving ? (
                    <><Loader2 className="w-4 h-4 mr-1.5 animate-spin" strokeWidth={1.5} />Saving</>
                  ) : (
                    <><Save className="w-4 h-4 mr-1.5" strokeWidth={1.5} />{source ? 'Update' : 'Save'}</>
                  )}
                </Button>
              )}
            </div>
          </div>
      </Modal>

      <GitSourceDiffDialog
        open={diffOpen}
        onOpenChange={setDiffOpen}
        stackName={stackName}
        pull={pull}
        syncEnv={syncEnv}
        autoDeployDefault={applyMode === 'auto-deploy'}
        isDarkMode={isDarkMode}
        applying={applying}
        onApply={applyPull}
        onDismiss={dismissPending}
      />

      <ConfirmModal
        open={removeConfirmOpen}
        onOpenChange={setRemoveConfirmOpen}
        variant="destructive"
        kicker={`${stackName.toUpperCase()} · GIT · DISCONNECT`}
        title="Remove Git source"
        confirmLabel={deleting ? 'Removing...' : 'Remove'}
        confirming={deleting}
        onConfirm={remove}
      >
        <p className="text-sm text-stat-subtitle">
          Disconnects the stack from its Git source. The stack files on disk are left in place and you can reconfigure the source later at any time.
        </p>
      </ConfirmModal>
    </>
  );
}
