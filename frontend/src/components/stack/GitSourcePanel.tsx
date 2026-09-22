import { useState, useEffect, useCallback } from 'react';
import { Loader2, Trash2, RefreshCw, Save, Pause, Play, GitBranch } from 'lucide-react';
import { ConfirmModal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SystemSheet, SheetSection, type SystemSheetAction } from '@/components/ui/system-sheet';
import { apiFetch } from '@/lib/api';
import { isSupportedGitRepoUrl, UNSUPPORTED_GIT_REPO_URL_MESSAGE } from '@/lib/gitRepoUrl';
import { useDeployFeedback } from '@/context/DeployFeedbackContext';
import { useNodes } from '@/context/NodeContext';
import { toast } from '@/components/ui/toast-store';
import { GitSourceDiffDialog, type PullResult, type PublicPendingPlan } from './GitSourceDiffDialog';
import { GitSourceFields, type ApplyMode } from './GitSourceFields';
import { GitSourceSecretsSection } from './GitSourceSecretsSection';
import { GitManifestSummary, type ManifestSummary } from './GitManifestSummary';
import type { GitBrowseResult } from './GitComposeFilePicker';
import { AdoptBlueprintDialog } from '@/components/blueprints/AdoptBlueprintDialog';
import GitOpsStateCard, { GitOpsFaultCard } from '@/components/gitops/GitOpsStateCard';
import { GitProviderHooksCard } from './GitProviderHooksCard';
import GitOpsCaveats from '@/components/gitops/GitOpsCaveats';
import GitOpsApprovalChips from '@/components/gitops/GitOpsApprovalChips';
import { ARTIFACT_STATE_LOOKUP, ROLLOUT_STATE_LOOKUP, SOURCE_STATE_LOOKUP, absentFault, liveArtifactFacet, livePlacementFacet, liveRolloutFacet, liveSourceFacet, placementStateMeta, type LiveSourceFacet } from '@/lib/gitopsState';
import { GITOPS_SOURCE_CONTROLLER_CAPABILITY } from '@/lib/capabilities';
import type {
  GitOpsAvailableAction,
  GitOpsRevisionCarrier,
  GitOpsRevisionProjection,
  GitOpsSourceStatus,
} from '@/types/gitops';

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
  auth_type: 'none' | 'token' | 'deploy_key';
  has_token: boolean;
  has_deploy_key: boolean;
  has_ca_bundle: boolean;
  ssh_host_key_fingerprint: string | null;
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
  canDeploy?: boolean;
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

function formatRetryWait(retryAt: number): string {
  const ms = retryAt - Date.now();
  if (ms <= 0) return 'Retry due';
  const secs = Math.ceil(ms / 1000);
  if (secs < 60) return `Retry in ${secs}s`;
  return `Retry in ${Math.ceil(secs / 60)}m`;
}

export function GitSourcePanel({
  open,
  onOpenChange,
  stackName,
  canEdit,
  canDeploy = canEdit,
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
  const [authType, setAuthType] = useState<'none' | 'token' | 'deploy_key'>('none');
  const [token, setToken] = useState('');
  const [deployKey, setDeployKey] = useState('');
  const [caBundle, setCaBundle] = useState('');
  // Set true when the operator clicks "Remove stored CA". The next save
  // sends remove_ca_bundle: true alongside the empty caBundle value, so
  // the backend clears the stored PEM even though the field is empty.
  const [removeCaBundle, setRemoveCaBundle] = useState(false);
  const [sshKnownHostsEntry, setSshKnownHostsEntry] = useState('');
  const [sshHostKeyFingerprint, setSshHostKeyFingerprint] = useState('');
  const [applyModeOverride, setApplyModeOverride] = useState<ApplyMode | null>(null);

  const [pull, setPull] = useState<PullResult | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false);
  const [suspendConfirmOpen, setSuspendConfirmOpen] = useState(false);
  const [suspendReason, setSuspendReason] = useState('');
  const [suspending, setSuspending] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [adoptOpen, setAdoptOpen] = useState(false);

  const { runWithLog } = useDeployFeedback();
  const { activeNode, hasCapability } = useNodes();
  const applyMode = deriveApplyMode(source, applyModeOverride);

  const sourceFacet = liveSourceFacet(revision);
  const artifactFacet = liveArtifactFacet(revision);
  const placementFacet = livePlacementFacet(revision);
  const rolloutFacet = liveRolloutFacet(revision);
  const approvals = revision && revision.targetMode !== 'not_applicable' ? revision.approvals : null;
  const artifactIdentity = artifactFacet?.expected?.identity ?? null;
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
    setDeployKey('');
    setCaBundle('');
    setRemoveCaBundle(false);
    setSshKnownHostsEntry('');
    setSshHostKeyFingerprint('');
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
          setDeployKey('');
          setCaBundle('');
          setRemoveCaBundle(false);
          setSshKnownHostsEntry('');
          setSshHostKeyFingerprint('');
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

  const buildSaveBody = useCallback(() => {
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
      source_policy: applyMode === 'review' ? 'review' : 'automatic',
    };
    if (authType === 'token' && token !== '') {
      body.token = token;
    }
    if (authType === 'deploy_key') {
      if (deployKey !== '') body.deploy_key = deployKey;
      if (sshKnownHostsEntry !== '') body.ssh_known_hosts_entry = sshKnownHostsEntry;
      if (sshHostKeyFingerprint !== '') body.ssh_host_key_fingerprint = sshHostKeyFingerprint;
    }
    if (caBundle !== '') body.ca_bundle = caBundle;
    if (removeCaBundle) body.remove_ca_bundle = true;
    return body;
  }, [
    applyMode,
    authType,
    branch,
    caBundle,
    composePaths,
    contextDir,
    deployKey,
    removeCaBundle,
    repoUrl,
    sshHostKeyFingerprint,
    sshKnownHostsEntry,
    syncEnv,
    token,
  ]);

  const persistGitSource = useCallback(async (body: Record<string, unknown>, successMessage: string) => {
    const res = await apiFetch(`/stacks/${encodeURIComponent(stackName)}/git-source`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast.error(err?.error || 'Failed to save Git source.');
      return false;
    }
    setToken('');
    setDeployKey('');
    setCaBundle('');
    setRemoveCaBundle(false);
    setSshKnownHostsEntry('');
    setSshHostKeyFingerprint('');
    setApplyModeOverride(null);
    toast.success(successMessage);
    onSourceChanged?.();
    await load();
    return true;
  }, [load, onSourceChanged, stackName]);

  const save = async () => {
    if (!repoUrl.trim() || !branch.trim() || composePaths.length === 0) {
      toast.error('Repository URL, ref, and at least one compose file are required.');
      return;
    }
    const trimmedUrl = repoUrl.trim();
    if (!isSupportedGitRepoUrl(trimmedUrl)) {
      toast.error(UNSUPPORTED_GIT_REPO_URL_MESSAGE);
      return;
    }
    setSaving(true);
    const loadingId = toast.loading('Verifying repository access...');
    try {
      await persistGitSource(buildSaveBody(), 'Git source saved.');
    } catch (e) {
      toast.error((e as Error)?.message || 'Network error.');
    } finally {
      toast.dismiss(loadingId);
      setSaving(false);
    }
  };

  const browseRepo = async (): Promise<GitBrowseResult | null> => {
    if (!repoUrl.trim() || !branch.trim()) {
      toast.error('Enter a repository URL and ref first.');
      return null;
    }
    try {
      const body: Record<string, unknown> = {
        repo_url: repoUrl.trim(),
        branch: branch.trim(),
        auth_type: authType,
      };
      if (authType === 'token' && token !== '') body.token = token;
      if (authType === 'deploy_key') {
        if (deployKey !== '') body.deploy_key = deployKey;
        if (sshKnownHostsEntry !== '') body.ssh_known_hosts_entry = sshKnownHostsEntry;
      }
      if (caBundle !== '') body.ca_bundle = caBundle;
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
        toast.success('Pending update dismissed.');
        setDiffOpen(false);
        setPull(null);
        await load();
        onSourceChanged?.();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err?.error || 'Failed to dismiss the pending update.');
      }
    } catch (e) {
      toast.error((e as Error)?.message || 'Network error.');
    }
  };

  const postControllerAction = async (
    action: 'suspend' | 'resume' | 'retry',
    body?: Record<string, unknown>,
  ): Promise<boolean> => {
    try {
      const res = await apiFetch(`/stacks/${encodeURIComponent(stackName)}/git-source/${action}`, {
        method: 'POST',
        body: JSON.stringify(body ?? {}),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        toast.error(err.error || `Could not ${action} this Git source.`);
        return false;
      }
      toast.success(
        action === 'suspend'
          ? 'Reconciliation suspended.'
          : action === 'resume'
            ? 'Reconciliation resumed.'
            : 'Retry started.',
      );
      onSourceChanged?.();
      await load();
      return true;
    } catch (e) {
      toast.error((e as Error)?.message || 'Network error.');
      return false;
    }
  };

  const suspendSource = async () => {
    setSuspending(true);
    try {
      const reason = suspendReason.trim();
      const ok = await postControllerAction('suspend', reason ? { reason } : {});
      if (ok) {
        setSuspendConfirmOpen(false);
        setSuspendReason('');
      }
    } finally {
      setSuspending(false);
    }
  };

  const resumeSource = async () => {
    setResuming(true);
    try {
      await postControllerAction('resume');
    } finally {
      setResuming(false);
    }
  };

  const retrySource = async () => {
    setRetrying(true);
    try {
      await postControllerAction('retry');
    } finally {
      setRetrying(false);
    }
  };

  const sha7 = source?.last_applied_commit_sha?.slice(0, 7)
    ?? source?.pending_commit_sha?.slice(0, 7)
    ?? null;
  const stateLabel = sourceFacet
    ? (SOURCE_STATE_LOOKUP[sourceFacet.status]?.label ?? sourceFacet.status)
    : null;
  const sheetMeta = source
    ? [sha7, stateLabel, source.branch || branch].filter(Boolean).join(' · ')
    : 'Not linked';
  const footerContext = source && source.updated_at
    ? `Updated ${new Date(source.updated_at).toLocaleString()}`
    : undefined;

  const claimedByBlueprint = revision?.targetMode === 'blueprint';
  const canMutateSource = canEdit && !claimedByBlueprint;
  const availableActions: readonly GitOpsAvailableAction[] =
    revision && revision.targetMode !== 'not_applicable' ? revision.availableActions : [];
  const offersController = (action: GitOpsAvailableAction): boolean => (
    canEdit
    && hasCapability(GITOPS_SOURCE_CONTROLLER_CAPABILITY)
    && availableActions.includes(action)
  );
  const offerSuspend = offersController('suspend');
  const offerResume = offersController('resume');
  const offerRetry = offersController('retry');
  const showControllerCard = Boolean(
    sourceFacet
    && (
      sourceFacet.status === 'source_failed'
      || sourceFacet.status === 'source_retry_scheduled'
      || sourceFacet.status === 'source_suspended'
    ),
  );
  const showPendingReview = Boolean(pending && !showControllerCard && !claimedByBlueprint);

  const secondaryActions: SystemSheetAction[] = [];
  if (!claimedByBlueprint) {
    if (source && sourceFacet?.status !== 'source_suspended') {
      secondaryActions.push({
        label: pulling ? 'Pulling' : 'Pull now',
        onClick: () => { void pullNow(); },
        disabled: pulling || saving,
        icon: pulling ? Loader2 : RefreshCw,
      });
    }
    if (offerSuspend) {
      secondaryActions.push({
        label: suspending ? 'Suspending' : 'Suspend',
        onClick: () => setSuspendConfirmOpen(true),
        disabled: suspending || saving,
        icon: Pause,
      });
    } else if (offerResume) {
      secondaryActions.push({
        label: resuming ? 'Resuming' : 'Resume',
        onClick: () => { void resumeSource(); },
        disabled: resuming || saving,
        icon: Play,
      });
    }
  }
  if (canEdit && canDeploy && source && revision?.targetMode === 'direct') {
    secondaryActions.push({
      label: 'Adopt onto Blueprint',
      onClick: () => setAdoptOpen(true),
      disabled: saving,
      icon: GitBranch,
    });
  }

  return (
    <>
      <SystemSheet
        open={open}
        onOpenChange={onOpenChange}
        crumb={['Stack', stackName, 'Git source']}
        name="Git source"
        meta={sheetMeta}
        size="lg"
        primaryAction={canMutateSource ? {
          label: saving ? (source ? 'Updating' : 'Saving') : (source ? 'Update' : 'Save'),
          onClick: () => { void save(); },
          disabled: saving,
          icon: saving ? Loader2 : Save,
        } : undefined}
        secondaryActions={secondaryActions.length > 0 ? secondaryActions : undefined}
        destructiveAction={canMutateSource && source ? {
          label: 'Remove',
          onClick: () => setRemoveConfirmOpen(true),
          disabled: deleting || saving,
          icon: Trash2,
        } : undefined}
        footerContext={footerContext}
      >
        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : (
          <>
            <SheetSection title="Status">
              {faults.length > 0 && <GitOpsFaultCard message={faults[0].message} />}

              <GitOpsApprovalChips approvals={approvals} placement={placementFacet} rollout={rolloutFacet} />

              {showPendingReview && pending && (
                <GitOpsStateCard
                  data-testid="git-pending"
                  stateKey={pending.status}
                  state={SOURCE_STATE_LOOKUP[pending.status]}
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

              {artifactFacet && (
                <GitOpsStateCard
                  data-testid="git-artifact-state"
                  stateKey={artifactFacet.status}
                  state={ARTIFACT_STATE_LOOKUP[artifactFacet.status]}
                >
                  {artifactIdentity && (
                    <div className="mt-1 font-mono text-[11px] text-stat-subtitle break-all max-md:text-[10px]">
                      {artifactIdentity.slice(0, 19)}
                    </div>
                  )}
                </GitOpsStateCard>
              )}

              {placementFacet && (
                <GitOpsStateCard
                  data-testid="git-placement-state"
                  stateKey={placementFacet.status}
                  state={placementStateMeta(placementFacet)}
                />
              )}

              {rolloutFacet && (
                <GitOpsStateCard
                  data-testid="git-rollout-state"
                  stateKey={rolloutFacet.status}
                  state={ROLLOUT_STATE_LOOKUP[rolloutFacet.status]}
                >
                  {rolloutFacet.status === 'rollout_paused' && rolloutFacet.pauseReason && (
                    <div className="mt-1 font-mono text-[11px] text-stat-subtitle">
                      {rolloutFacet.pauseReason}
                    </div>
                  )}
                </GitOpsStateCard>
              )}

              {showControllerCard && sourceFacet && (
                <GitOpsStateCard
                  data-testid="git-controller-state"
                  stateKey={sourceFacet.status}
                  state={SOURCE_STATE_LOOKUP[sourceFacet.status]}
                  action={offerRetry ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7"
                      onClick={() => { void retrySource(); }}
                      disabled={retrying}
                    >
                      {retrying ? 'Retrying' : 'Retry'}
                    </Button>
                  ) : undefined}
                >
                  {sourceFacet.status === 'source_failed' && (
                    <div className="mt-1 font-mono text-[11px] text-stat-subtitle">
                      {sourceFacet.failureClass}
                      {sourceFacet.retryAt ? ` · ${formatRetryWait(sourceFacet.retryAt)}` : ''}
                    </div>
                  )}
                  {sourceFacet.status === 'source_retry_scheduled' && (
                    <div className="mt-1 font-mono text-[11px] text-stat-subtitle">
                      {formatRetryWait(sourceFacet.retryAt)}
                    </div>
                  )}
                  {sourceFacet.status === 'source_suspended' && sourceFacet.suspendedReason && (
                    <div className="mt-1 font-mono text-[11px] text-stat-subtitle">
                      {sourceFacet.suspendedReason}
                    </div>
                  )}
                </GitOpsStateCard>
              )}

              <GitOpsCaveats revision={revision} />

              {source && (
                <div className="text-[11px] text-stat-subtitle space-y-0.5">
                  <div className="flex justify-between gap-2">
                    <span>Last applied commit</span>
                    <span className="font-mono tabular-nums">
                      {source.last_applied_commit_sha ? source.last_applied_commit_sha.slice(0, 7) : 'never'}
                    </span>
                  </div>
                  {sourceFacet && (
                    <div className="flex justify-between gap-2">
                      <span>Source state</span>
                      <span data-testid="git-source-state">{SOURCE_STATE_LOOKUP[sourceFacet.status]?.label ?? sourceFacet.status}</span>
                    </div>
                  )}
                </div>
              )}
            </SheetSection>

            <SheetSection title="Repository">
              {claimedByBlueprint ? (
                <div className="space-y-2 rounded-lg border border-card-border bg-card p-3" data-testid="git-source-claimed">
                  <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-icon">Bound to a Blueprint</p>
                  <p className="text-xs text-stat-subtitle leading-relaxed">
                    This Git source belongs to a Git-managed Blueprint. Save, Remove, and Pull now are blocked here. Use Detach Git on that Blueprint to restore stack-owned editing.
                  </p>
                </div>
              ) : (
              <GitSourceFields
                variant="edit"
                stackName={stackName}
                disabled={!canEdit || saving}
                repoUrl={repoUrl}
                branch={branch}
                composePaths={composePaths}
                contextDir={contextDir}
                syncEnv={syncEnv}
                authType={authType}
                token={token}
                deployKey={deployKey}
                caBundle={caBundle}
                removeCaBundle={removeCaBundle}
                sshKnownHostsEntry={sshKnownHostsEntry}
                sshHostKeyFingerprint={sshHostKeyFingerprint}
                hasStoredToken={source?.has_token ?? false}
                hasStoredDeployKey={source?.has_deploy_key ?? false}
                hasStoredCaBundle={source?.has_ca_bundle ?? false}
                storedHostKeyFingerprint={source?.ssh_host_key_fingerprint ?? null}
                applyMode={applyMode}
                onRepoUrlChange={setRepoUrl}
                onBranchChange={setBranch}
                onComposePathsChange={setComposePaths}
                onContextDirChange={setContextDir}
                onSyncEnvChange={setSyncEnv}
                onAuthTypeChange={setAuthType}
                onTokenChange={setToken}
                onDeployKeyChange={setDeployKey}
                onCaBundleChange={(value) => {
                    setCaBundle(value);
                    if (removeCaBundle) setRemoveCaBundle(false);
                }}
                onRemoveCaBundle={() => setRemoveCaBundle(true)}
                onSshKnownHostsEntryChange={setSshKnownHostsEntry}
                onSshHostKeyFingerprintChange={setSshHostKeyFingerprint}
                onApplyModeChange={setApplyModeOverride}
                onBrowse={browseRepo}
              />
              )}
            </SheetSection>

            {source && (
              <SheetSection title="Provider hooks">
                <GitProviderHooksCard stackName={stackName} canEdit={canEdit} />
              </SheetSection>
            )}

            {source && (
              <SheetSection title="Repository secrets">
                <GitSourceSecretsSection
                  stackName={stackName}
                  canEdit={canMutateSource}
                  linked
                  disabled={saving || loading}
                />
              </SheetSection>
            )}

            {source && (
              <SheetSection title="Manifest">
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
              </SheetSection>
            )}
          </>
        )}
      </SystemSheet>

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

      <ConfirmModal
        open={suspendConfirmOpen}
        onOpenChange={(open) => {
          setSuspendConfirmOpen(open);
          if (!open) setSuspendReason('');
        }}
        kicker={`${stackName.toUpperCase()} · GIT · SUSPEND`}
        title="Suspend reconciliation"
        confirmLabel={suspending ? 'Suspending...' : 'Suspend'}
        confirming={suspending}
        onConfirm={suspendSource}
      >
        <p className="text-sm text-stat-subtitle">
          Stops polling, webhooks, and automatic apply for this source until you resume. Save stays available; resume before pulling again.
        </p>
        <label className="mt-3 block text-sm font-medium text-stat-value" htmlFor="git-suspend-reason">
          Reason (optional)
        </label>
        <textarea
          id="git-suspend-reason"
          value={suspendReason}
          onChange={(event) => setSuspendReason(event.target.value)}
          rows={3}
          className="mt-1 w-full rounded-md border border-card-border bg-card px-3 py-2 font-mono text-sm text-stat-value"
        />
      </ConfirmModal>

      <AdoptBlueprintDialog
        open={adoptOpen}
        onOpenChange={setAdoptOpen}
        stackName={stackName}
        onAdopted={() => { void load(); onSourceChanged?.(); }}
      />
    </>
  );
}
