import { useState, useEffect, useCallback } from 'react';
import { GitBranch, Loader2, Trash2, RefreshCw, Save } from 'lucide-react';
import { Modal, ModalHeader, ConfirmModal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { apiFetch } from '@/lib/api';
import { useDeployFeedback } from '@/context/DeployFeedbackContext';
import { useNodes } from '@/context/NodeContext';
import { toast } from '@/components/ui/toast-store';
import { GitSourceDiffDialog, type PullResult, type PublicPendingPlan } from './GitSourceDiffDialog';
import { GitSourceFields, type ApplyMode } from './GitSourceFields';
import { GitManifestSummary, type ManifestSummary } from './GitManifestSummary';
import type { GitBrowseResult } from './GitComposeFilePicker';
import GitOpsStateCard, { GitOpsFaultCard } from '@/components/gitops/GitOpsStateCard';
import GitOpsCaveats from '@/components/gitops/GitOpsCaveats';
import { SOURCE_STATE, absentFault, liveSourceFacet, type LiveSourceFacet } from '@/lib/gitopsState';
import type { GitOpsRevisionCarrier, GitOpsRevisionProjection, GitOpsSourceStatus } from '@/types/gitops';

export interface GitSource {
  id: number;
  stack_name: string;
  repo_url: string;
  branch: string;
  compose_path: string;
  compose_paths: string[];
  context_dir: string | null;
  sync_env: boolean;
  env_path: string | null;
  auth_type: 'none' | 'token';
  has_token: boolean;
  auto_apply_on_webhook: boolean;
  auto_deploy_on_apply: boolean;
  last_applied_commit_sha: string | null;
  pending_commit_sha: string | null;
  pending_fetched_at: number | null;
  pending_plan: PublicPendingPlan | null;
  last_plan_fingerprint: string | null;
  last_plan_outcome: string | null;
  created_at: number;
  updated_at: number;
  manifest_state: ManifestSummary['state'] | null;
  manifest: ManifestSummary | null;
}

// The GET carries the revision on both of its 200 shapes. The PUT does not,
// which is why GitSource itself stays free of it.
type GitSourceRead = GitSource & GitOpsRevisionCarrier;
type GitSourceUnlinked = { linked: false } & GitOpsRevisionCarrier;

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

/** The commit the pending banner announces, or null when there is nothing to announce. */
interface PendingCommit {
  status: GitOpsSourceStatus;
  /** Short-sha detail line; null when the state is known but the commit is not. */
  sha: string | null;
}

/**
 * What the pending banner shows, from the projection when one answered and from
 * the flat pointer when none did.
 *
 * The fallback is reachable when a GitOps write failed and was swallowed while
 * the pending commit still committed, and it is what this banner read before the
 * projection existed. A fault suppresses it: that means an application was
 * expected and could not be read, so the pointer is not evidence a candidate is
 * ready. The sidebar applies the same rule, so the two surfaces cannot disagree.
 */
function derivePendingCommit(
  facet: LiveSourceFacet | null,
  faultCount: number,
  flatPendingSha: string | null,
): PendingCommit | null {
  if (facet) {
    if (facet.candidateGenerationId === null) return null;
    return { status: facet.status, sha: facet.fetchedCommitSha };
  }
  if (faultCount > 0 || !flatPendingSha) return null;
  return { status: 'candidate_ready', sha: flatPendingSha };
}

export function GitSourcePanel({
  open,
  onOpenChange,
  stackName,
  canEdit,
  onSourceChanged,
}: GitSourcePanelProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [applying, setApplying] = useState(false);
  const [source, setSource] = useState<GitSource | null>(null);
  // Kept out of `source` on purpose: the PUT that saves this panel answers with
  // a bare Git source and no revision, so carrying it on that type would make
  // the save path a lie.
  const [revision, setRevision] = useState<GitOpsRevisionProjection | null>(null);

  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [composePaths, setComposePaths] = useState<string[]>(['compose.yaml']);
  const [contextDir, setContextDir] = useState('');
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

  const sourceFacet = liveSourceFacet(revision);
  const faults = revision ? absentFault(revision) : [];
  const pending = derivePendingCommit(sourceFacet, faults.length, source?.pending_commit_sha ?? null);

  const resetToUnlinked = useCallback(() => {
    setSource(null);
    setRepoUrl('');
    setBranch('main');
    setComposePaths(['compose.yaml']);
    setContextDir('');
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
        const data: GitSourceRead | GitSourceUnlinked = await res.json();
        setRevision(data.gitopsRevision);
        // An existing stack with no Git source attached answers 200 { linked: false }.
        if ('linked' in data) {
          resetToUnlinked();
        } else {
          setSource(data);
          setRepoUrl(data.repo_url);
          setBranch(data.branch);
          setComposePaths(data.compose_paths?.length ? data.compose_paths : [data.compose_path]);
          setContextDir(data.context_dir ?? '');
          setSyncEnv(data.sync_env);
          setAuthType(data.auth_type);
          setToken('');
          setApplyModeOverride(null);
        }
      } else if (res.status === 404) {
        resetToUnlinked();
        setRevision(null);
      } else if (res.status === 403) {
        setSource(null);
        setRevision(null);
        toast.error('You do not have permission to view this stack\'s Git source.');
      } else {
        setRevision(null);
        const err = await res.json().catch(() => ({}));
        toast.error(err?.error || 'Failed to load Git source.');
      }
    } catch (e) {
      // Clear alongside the other failure branches: the panel is reused across
      // stacks, so a revision left behind would render one stack's state under
      // another stack's header.
      setRevision(null);
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
    if (!repoUrl.trim() || !branch.trim() || composePaths.length === 0) {
      toast.error('Repository URL, branch, and at least one compose file are required.');
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
        compose_paths: composePaths,
        context_dir: contextDir.trim() || null,
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
        // A material configuration change clears the staged candidate server
        // side, and this response carries no revision to replace the one held
        // here, so drop it rather than keep rendering a state that has moved.
        setRevision(null);
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

  const browseRepo = async (): Promise<GitBrowseResult | null> => {
    if (!repoUrl.trim() || !branch.trim()) {
      toast.error('Enter a repository URL and branch first.');
      return null;
    }
    try {
      const body: Record<string, unknown> = {
        repo_url: repoUrl.trim(),
        branch: branch.trim(),
        auth_type: authType,
      };
      if (authType === 'token' && token !== '') body.token = token;
      const res = await apiFetch(`/stacks/${encodeURIComponent(stackName)}/git-source/browse`, {
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
        // Detaching is a stronger invalidation than a save: the projection now
        // describes a source that is gone, and the pending card is derived from
        // the revision alone, so leaving it would advertise a waiting commit on
        // a stack Git no longer manages.
        setRevision(null);
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
        if (data.warnings && data.warnings.length > 0) {
          toast.warning(data.warnings.join(' '));
        }
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

  const applyPull = async (commitSha: string, deploy: boolean, planFingerprint: string) => {
    setApplying(true);
    const loadingId = toast.loading(deploy ? 'Applying and deploying...' : 'Applying changes...');
    // Snapshot the node once so the apply (and any deploy it triggers) stays
    // bound to it even if the active node changes while the operation runs.
    const opNodeId = activeNode?.id ?? null;
    try {
      const runApply = async (started: Promise<void>) => {
        if (deploy) await started;
        const res = await apiFetch(`/stacks/${encodeURIComponent(stackName)}/git-source/apply`, {
          method: 'POST',
          nodeId: opNodeId,
          body: JSON.stringify({ commitSha, planFingerprint, deploy }),
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
          const err = await res.json().catch(() => ({})) as {
            error?: string;
            code?: string;
            plan?: PullResult['plan'];
            planFingerprint?: string;
          };
          if (res.status === 409 && err.code === 'STALE_PLAN' && err.plan && err.planFingerprint) {
            setPull((prev) => prev
              ? { ...prev, plan: err.plan ?? null, planFingerprint: err.planFingerprint ?? null }
              : prev);
            toast.warning(err.error || 'The change plan is stale. Review the updated plan before applying.');
            return { ok: false, errorMessage: err.error };
          }
          const msg = err.error || 'Failed to apply changes.';
          toast.error(msg);
          return { ok: false, errorMessage: msg };
        }
      };

      if (deploy) {
        await runWithLog({ stackName, action: 'deploy', nodeId: opNodeId }, runApply);
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

          <ScrollArea className="h-[70vh] max-md:h-auto">
            <div className="px-6 py-5 space-y-5">
              {loading ? (
                <div className="space-y-3">
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                </div>
              ) : (
                <>
                  {faults.length > 0 && <GitOpsFaultCard message={faults[0].message} />}

                  {pending && (
                    <GitOpsStateCard
                      data-testid="git-pending"
                      stateKey={pending.status}
                      state={SOURCE_STATE[pending.status]}
                      action={(
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7"
                          onClick={() => pullNow()}
                          disabled={pulling}
                        >
                          Review
                        </Button>
                      )}
                    >
                      {pending.sha && (
                        <div className="mt-1 font-mono text-[11px] text-stat-subtitle">
                          Commit <span className="tabular-nums text-foreground/80">{pending.sha.slice(0, 7)}</span>
                        </div>
                      )}
                    </GitOpsStateCard>
                  )}

                  <GitOpsCaveats revision={revision} />

                  <GitSourceFields
                    variant="edit"
                    disabled={!canEdit || saving}
                    repoUrl={repoUrl}
                    branch={branch}
                    composePaths={composePaths}
                    contextDir={contextDir}
                    syncEnv={syncEnv}
                    authType={authType}
                    token={token}
                    hasStoredToken={source?.has_token ?? false}
                    applyMode={applyMode}
                    onRepoUrlChange={setRepoUrl}
                    onBranchChange={setBranch}
                    onComposePathsChange={setComposePaths}
                    onContextDirChange={setContextDir}
                    onSyncEnvChange={setSyncEnv}
                    onAuthTypeChange={setAuthType}
                    onTokenChange={setToken}
                    onApplyModeChange={setApplyModeOverride}
                    onBrowse={browseRepo}
                  />

                  {source && (
                    <div className="rounded-md border border-glass-border bg-muted/30 px-3 py-2 text-[11px] text-stat-subtitle space-y-0.5 shadow-card-bevel">
                      <div className="flex justify-between gap-2">
                        <span>Last applied commit</span>
                        <span className="font-mono tabular-nums">
                          {source.last_applied_commit_sha ? source.last_applied_commit_sha.slice(0, 7) : 'never'}
                        </span>
                      </div>
                      {sourceFacet && (
                        <div className="flex justify-between gap-2">
                          <span>Source state</span>
                          <span data-testid="git-source-state">{SOURCE_STATE[sourceFacet.status].label}</span>
                        </div>
                      )}
                      <div className="flex justify-between gap-2">
                        <span>Updated</span>
                        <span className="font-mono tabular-nums">
                          {new Date(source.updated_at).toLocaleString()}
                        </span>
                      </div>
                    </div>
                  )}

                  {source && (
                    <GitManifestSummary
                      stackName={stackName}
                      summary={
                        source.manifest ??
                        (source.manifest_state
                          ? {
                              state: source.manifest_state,
                              manifestVersion: 0,
                              resolvedCommitSha: null,
                              managedCount: 0,
                              unmanagedCount: 0,
                              refusedCount: 0,
                              refused: [],
                              hasBuildContexts: false,
                              generatedAt: null,
                            }
                          : null)
                      }
                    />
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
        autoDeployDefault={applyMode === 'auto-deploy'}
        applying={applying}
        onApply={applyPull}
        onDismiss={dismissPending}
      />

      <ConfirmModal
        open={removeConfirmOpen}
        onOpenChange={setRemoveConfirmOpen}
        variant="destructive"
        kicker={`${stackName.toUpperCase()} · GIT · DISCONNECT`}
        title="Detach and export"
        confirmLabel={deleting ? 'Detaching...' : 'Detach'}
        confirming={deleting}
        onConfirm={remove}
      >
        <p className="text-sm text-stat-subtitle">
          Detaches the stack from its Git source. Sencho renders the effective compose model into a single
          compose.yaml, keeps the materialized files, and removes Git tracking. Resolved values are baked into
          the exported file: anything interpolated from .env or env_file files, including credentials, becomes
          readable in compose.yaml. Reconfiguring the source later is always possible.
        </p>
      </ConfirmModal>
    </>
  );
}
