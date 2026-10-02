import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { Trash2, RefreshCw, Save, Pause, Play, GitBranch, Pencil } from 'lucide-react';
import { ConfirmModal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { openGitOpsWorkplace } from '@/components/gitops/portfolio/portfolioNavigation';
import { Skeleton } from '@/components/ui/skeleton';
import { SystemSheet, SheetSection, type SystemSheetAction, type SystemSheetTab } from '@/components/ui/system-sheet';
import { apiFetch } from '@/lib/api';
import { runSourceControllerAction } from '@/lib/gitSourceControllerAction';
import { isSupportedGitRepoUrl, UNSUPPORTED_GIT_REPO_URL_MESSAGE } from '@/lib/gitRepoUrl';
import { useDeployFeedback } from '@/context/DeployFeedbackContext';
import { useNodes } from '@/context/NodeContext';
import { toast } from '@/components/ui/toast-store';
import { GitSourceDiffDialog, type PullResult, type PublicPendingPlan } from './GitSourceDiffDialog';
import { GitSourceFields, type ApplyMode, type GitSourceFieldsPart } from './GitSourceFields';
import { GitSourceSummary } from './GitSourceSummary';
import GitOpsDriftRow from '@/components/gitops/GitOpsDriftRow';
import { GitSourceSecretsSection } from './GitSourceSecretsSection';
import { GitManifestSummary, type ManifestSummary } from './GitManifestSummary';
import type { GitBrowseResult } from './GitComposeFilePicker';
import { AdoptBlueprintDialog } from '@/components/blueprints/AdoptBlueprintDialog';
import GitOpsStateCard from '@/components/gitops/GitOpsStateCard';
import { GitOpsStatus } from '@/components/gitops/GitOpsStatus';
import { buildGitOpsStatus } from '@/lib/gitopsStatus';
import { BusyButton } from '@/components/ui/busy-button';
import { GitProviderHooksCard } from './GitProviderHooksCard';
import { SOURCE_STATE_LOOKUP, absentFault, liveSourceFacet, type LiveSourceFacet } from '@/lib/gitopsState';
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
  /** The tri-state policy the source runs under. The booleans below cannot express `manual`. */
  source_policy: 'manual' | 'review' | 'automatic';
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

type GitSourceTab = 'overview' | 'source' | 'automation' | 'secrets' | 'drift';

interface GitSourcePanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stackName: string;
  canEdit: boolean;
  isDarkMode: boolean;
  /** Called after any change that may affect the sidebar pending-badge. */
  onSourceChanged?: () => void;
  canDeploy?: boolean;
  /** Node the panel reads and writes; omitted means the active node. */
  nodeId?: number | null;
  /** Breadcrumb override for hosts outside the stack view. */
  crumb?: string[];
  /** Hide the link back to the GitOps workplace when the panel is already hosted there. */
  showPortfolioLink?: boolean;
  /** Pull the waiting update and open its diff once the sheet has loaded, when one is waiting. */
  autoReview?: boolean;
}

/**
 * What the stored settings mean as a mode.
 *
 * The policy is read first because it is the field that carries all three
 * values. The two booleans cannot express `manual` at all, since a manual source
 * also has `auto_apply_on_webhook` false, which is exactly what a review source
 * reports; the policy is the only thing that tells those two apart.
 */
function deriveApplyMode(source: GitSource | null, pendingMode: ApplyMode | null): ApplyMode {
  if (pendingMode) return pendingMode;
  if (!source) return 'review';
  if (source.source_policy === 'manual') return 'manual';
  if (source.source_policy === 'review') return 'review';
  if (!source.auto_apply_on_webhook) return 'review';
  return source.auto_deploy_on_apply ? 'auto-deploy' : 'auto-write';
}

function storedComposePaths(source: GitSource): string[] {
  return source.compose_paths?.length ? source.compose_paths : [source.compose_path];
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
  canDeploy = canEdit,
  onSourceChanged,
  nodeId,
  crumb,
  showPortfolioLink = true,
  autoReview = false,
}: GitSourcePanelProps) {
  const [loading, setLoading] = useState(true);
  // A failed open is not "no source": it needs its own state so the sheet can say it could not read.
  const [loadError, setLoadError] = useState<string | null>(null);
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
  const [tab, setTab] = useState<GitSourceTab>('overview');
  // The Source tab reads as a summary until the operator chooses to edit it.
  const [editing, setEditing] = useState(false);

  const { runWithLog } = useDeployFeedback();
  const { activeNode, hasCapability, nodeMeta, nodes } = useNodes();
  // The node this panel acts on: an explicit host node, else the active one.
  const panelNodeId = nodeId !== undefined ? nodeId : activeNode?.id ?? null;
  // An explicit node answers from its own meta, optimistic while unknown,
  // exactly as hasCapability does for the active node.
  const nodeHasCapability = (cap: typeof GITOPS_SOURCE_CONTROLLER_CAPABILITY): boolean => {
    if (nodeId === undefined || nodeId === null) return hasCapability(cap);
    const meta = nodeMeta.get(nodeId);
    return meta ? meta.capabilities.includes(cap) : true;
  };
  const applyMode = deriveApplyMode(source, applyModeOverride);

  const sourceFacet = liveSourceFacet(revision);
  // Whatever the revision has to say (a Blueprint-claimed source has no source stage but still has placement, rollout, and caveats).
  const statusModel = buildGitOpsStatus(revision);
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

  // The form mirrors the stored source; secrets are never read back, so they start empty.
  const fillForm = useCallback((data: GitSource) => {
    setRepoUrl(data.repo_url);
    setBranch(data.branch);
    setComposePaths(storedComposePaths(data));
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
  }, []);

  // Only the latest request may touch state, so a slow answer for the stack the
  // sheet just left cannot overwrite the one it is now showing.
  const loadSeq = useRef(0);
  const loadedForOpen = useRef(false);

  /**
   * Read the source and its status.
   *
   * `open` is a fresh look: it shows the skeleton, refills the form, and on
   * failure clears everything and says so, because the panel is reused across
   * stacks and a source left behind would sit under another stack's header.
   * `save` and `refresh` follow a write the server already accepted: they keep
   * what is on screen on failure instead of turning a linked stack into an empty
   * form, and `refresh` leaves unsaved edits alone, so a pull or a suspend does
   * not throw away a change the operator is still making.
   */
  const load = useCallback(async (mode: 'open' | 'save' | 'refresh' = 'open') => {
    const seq = ++loadSeq.current;
    const current = () => seq === loadSeq.current;
    const fresh = mode === 'open';
    if (fresh) {
      setLoading(true);
      setLoadError(null);
      loadedForOpen.current = false;
    }
    const fail = (message: string) => {
      if (!fresh) {
        toast.error('Could not refresh the sheet. Reopen it to see the current state.');
        return;
      }
      resetToUnlinked();
      setRevision(null);
      setLoadError(message);
      toast.error(message);
    };
    try {
      const res = await apiFetch(`/stacks/${encodeURIComponent(stackName)}/git-source`, { nodeId });
      if (!current()) return;
      if (res.ok) {
        const data: GitSourceRead | GitSourceUnlinked = await res.json();
        if (!current()) return;
        setRevision(data.gitopsRevision);
        // An existing stack with no Git source attached answers 200 { linked: false }.
        if ('linked' in data) {
          resetToUnlinked();
        } else {
          setSource(data);
          if (mode !== 'refresh') fillForm(data);
        }
      } else if (res.status === 404) {
        resetToUnlinked();
        setRevision(null);
      } else if (res.status === 403) {
        fail('You do not have permission to view this stack\'s Git source.');
      } else {
        const err = await res.json().catch(() => ({}));
        if (!current()) return;
        fail(err?.error || 'Failed to load Git source.');
      }
    } catch (e) {
      if (!current()) return;
      fail((e as Error)?.message || 'Network error.');
    } finally {
      if (current() && fresh) {
        loadedForOpen.current = true;
        setLoading(false);
      }
    }
  }, [stackName, nodeId, resetToUnlinked, fillForm]);

  useEffect(() => {
    if (open) {
      setTab('overview');
      setEditing(false);
      // Drop whatever the sheet held for another stack or an earlier visit before reading afresh.
      resetToUnlinked();
      setRevision(null);
      void load('open');
    }
  }, [open, load, resetToUnlinked]);

  const buildSaveBody = useCallback(() => {
    const autoApply = applyMode === 'auto-write' || applyMode === 'auto-deploy';
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
      source_policy: applyMode === 'manual'
        ? 'manual'
        : applyMode === 'review' ? 'review' : 'automatic',
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
      nodeId,
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
    await load('save');
    return true;
  }, [load, onSourceChanged, stackName, nodeId]);

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
      if (await persistGitSource(buildSaveBody(), 'Git source saved.')) setEditing(false);
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
        nodeId,
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
        nodeId,
        method: 'DELETE',
      });
      if (res.ok) {
        toast.success('Git source removed.');
        // Detaching is a stronger invalidation than a save: the projection now
        // describes a source that is gone, and the pending card is derived from
        // the revision alone, so leaving it would advertise a waiting commit on
        // a stack Git no longer manages. The form goes too, so the removed
        // source's URL is not left prefilled in the empty form.
        resetToUnlinked();
        setRevision(null);
        setEditing(false);
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
    try {
      const res = await apiFetch(`/stacks/${encodeURIComponent(stackName)}/git-source/pull`, {
        nodeId,
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
      setPulling(false);
    }
  };

  const applyPull = async (commitSha: string, deploy: boolean, planFingerprint: string) => {
    setApplying(true);
    const loadingId = toast.loading(deploy ? 'Applying and deploying...' : 'Applying changes...');
    // Snapshot the node once so the apply (and any deploy it triggers) stays
    // bound to it even if the active node changes while the operation runs.
    const opNodeId = panelNodeId;
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
          await load('refresh');
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
        nodeId,
        method: 'POST',
      });
      if (res.ok) {
        toast.success('Pending update dismissed.');
        setDiffOpen(false);
        setPull(null);
        await load('refresh');
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
    if (!(await runSourceControllerAction(stackName, nodeId, action, body))) return false;
    onSourceChanged?.();
    await load('refresh');
    return true;
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

  // The header names what is applied. A commit that is only waiting is the status's to announce.
  const sha7 = source?.last_applied_commit_sha?.slice(0, 7) ?? 'never applied';
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
    && nodeHasCapability(GITOPS_SOURCE_CONTROLLER_CAPABILITY)
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
  // The one verb the status offers: retry when the controller is holding the source back and allows it, else review the waiting commit.
  let statusAction: ReactNode;
  if (showControllerCard && offerRetry) {
    statusAction = (
      <BusyButton
        size="sm"
        variant="outline"
        className="h-7"
        pending={retrying}
        busyLabel="Retrying"
        onClick={() => { void retrySource(); }}
      >
        Retry
      </BusyButton>
    );
  } else if (showControllerCard && offerResume && sourceFacet?.status === 'source_suspended') {
    statusAction = (
      <BusyButton
        size="sm"
        variant="outline"
        className="h-7"
        pending={resuming}
        busyLabel="Resuming"
        onClick={() => { void resumeSource(); }}
      >
        Resume
      </BusyButton>
    );
  } else if (showPendingReview) {
    statusAction = (
      <BusyButton
        size="sm"
        variant="outline"
        className="h-7"
        pending={pulling}
        busyLabel="Reviewing"
        onClick={() => { void pullNow(); }}
      >
        Review update
      </BusyButton>
    );
  }

  // "Review update" from outside the sheet: do what its button would, once per opening.
  const autoReviewed = useRef(false);
  useEffect(() => {
    if (!open) {
      autoReviewed.current = false;
      return;
    }
    // loadedForOpen: the state read for THIS opening, never what a reopened sheet still held.
    if (!autoReview || loading || !loadedForOpen.current || autoReviewed.current || !showPendingReview) return;
    autoReviewed.current = true;
    void pullNow();
    // pullNow is a fresh closure each render; the ref makes this run once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoReview, open, loading, showPendingReview]);

  const toolbarLive = !loading && loadError === null;
  const offerPull = toolbarLive && !claimedByBlueprint && source !== null && sourceFacet?.status !== 'source_suspended';
  const secondaryActions: SystemSheetAction[] | undefined = offerPull
    ? [{
        label: pulling ? 'Pulling' : 'Pull now',
        onClick: () => { void pullNow(); },
        disabled: saving,
        pending: pulling,
        icon: RefreshCw,
      }]
    : undefined;
  // Adoption always runs on the hub, so a panel hosted for another node's stack
  // must not offer it: the call would land on the hub's same-named stack.
  const adoptReachable = nodeId === undefined || nodes.some(n => n.id === nodeId && n.type === 'local');
  const canAdopt = canEdit && canDeploy && adoptReachable && source !== null && revision?.targetMode === 'direct';

  // Unsaved changes anywhere in the form, on either tab that edits it.
  const dirty = source !== null && (
    repoUrl.trim() !== source.repo_url
    || branch.trim() !== source.branch
    || composePaths.join('\n') !== storedComposePaths(source).join('\n')
    || contextDir.trim() !== (source.context_dir ?? '')
    || syncEnv !== source.sync_env
    || authType !== source.auth_type
    || token !== '' || deployKey !== '' || caBundle !== '' || removeCaBundle
    || sshKnownHostsEntry !== '' || sshHostKeyFingerprint !== ''
    || applyMode !== deriveApplyMode(source, null)
  );
  const cancelEdit = () => {
    // Cancel backs out of the connection edit only; an apply behavior chosen on
    // the Automation tab is a separate unsaved change and stays.
    const chosenMode = applyModeOverride;
    if (source) fillForm(source);
    setApplyModeOverride(chosenMode);
    setEditing(false);
  };

  const driftItems = revision && revision.targetMode !== 'not_applicable' ? revision.drift : [];
  const tabs: SystemSheetTab[] | undefined = source
    ? [
        { id: 'overview', label: 'Overview' },
        { id: 'source', label: 'Source' },
        { id: 'automation', label: 'Automation' },
        { id: 'secrets', label: 'Secrets' },
        ...(driftItems.length > 0 ? [{ id: 'drift', label: 'Drift', count: driftItems.length }] : []),
      ]
    : undefined;
  // A drift tab that has gone (the drift cleared while it was open) falls back to the overview.
  const activeTab: GitSourceTab = tab === 'drift' && driftItems.length === 0 ? 'overview' : tab;

  const renderFields = (part: GitSourceFieldsPart) => (
    <GitSourceFields
      variant="edit"
      part={part}
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
      nodeId={nodeId}
    />
  );

  const claimedNotice = (
    <div className="space-y-2 rounded-lg border border-card-border bg-card p-3" data-testid="git-source-claimed">
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-icon">Bound to a Blueprint</p>
      <p className="text-xs text-stat-subtitle leading-relaxed">
        This Git source belongs to a Git-managed Blueprint. Save, Detach, and Pull now are blocked here. Use Detach Git on that Blueprint to restore stack-owned editing.
      </p>
    </div>
  );

  const overviewTab = (
    <div className="space-y-3">
      {statusModel && (
        <GitOpsStatus
          revision={revision}
          focus={statusAction ? 'source' : undefined}
          action={statusAction}
        />
      )}
      {!statusModel && showPendingReview && pending && (
        // No projection answered but a commit is waiting: the flat pointer is all there is.
        <GitOpsStateCard
          data-testid="git-pending"
          stateKey={pending.status}
          state={SOURCE_STATE_LOOKUP[pending.status]}
          action={statusAction}
        >
          {pending.sha && (
            <div className="mt-1 font-mono text-[11px] text-stat-subtitle">
              Commit <span className="tabular-nums text-foreground/80">{pending.sha.slice(0, 7)}</span>
            </div>
          )}
        </GitOpsStateCard>
      )}
      {showPortfolioLink && source && panelNodeId !== null && (
        // The portfolio view of this one application, next to every
        // other GitOps application and its attention queue.
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs"
          onClick={() => {
            onOpenChange(false);
            openGitOpsWorkplace({ nodeId: panelNodeId, stack: stackName });
          }}
        >
          Open in GitOps portfolio
        </Button>
      )}
    </div>
  );

  let sourceConfiguration: ReactNode;
  if (claimedByBlueprint) {
    sourceConfiguration = claimedNotice;
  } else if (editing) {
    sourceConfiguration = (
      <div className="space-y-4">
        {renderFields('connection')}
        <Button variant="ghost" size="sm" onClick={cancelEdit} disabled={saving}>
          Cancel
        </Button>
      </div>
    );
  } else {
    sourceConfiguration = (
      <div className="space-y-3">
        {source && <GitSourceSummary source={source} />}
        <div className="flex flex-wrap items-center gap-2">
          {canMutateSource && (
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setEditing(true)}>
              <Pencil className="h-3.5 w-3.5" strokeWidth={1.5} />
              Edit
            </Button>
          )}
          {canAdopt && (
            <Button variant="outline" size="sm" className="gap-1.5" disabled={saving} onClick={() => setAdoptOpen(true)}>
              <GitBranch className="h-3.5 w-3.5" strokeWidth={1.5} />
              Adopt onto Blueprint
            </Button>
          )}
        </div>
      </div>
    );
  }

  const sourceTab = (
    <>
      <SheetSection title="Configuration">{sourceConfiguration}</SheetSection>
      {source && (
        <SheetSection title="Manifest">
          <GitManifestSummary
            stackName={stackName}
            nodeId={nodeId}
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
  );

  const automationTab = (
    <>
      <SheetSection title="Apply behavior">
        {claimedByBlueprint ? claimedNotice : renderFields('apply')}
      </SheetSection>
      {!claimedByBlueprint && (offerSuspend || offerResume) && (
        <SheetSection title="Reconciliation">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-stat-subtitle">
              {offerResume
                ? 'Suspended: polling, webhooks, and automatic apply are stopped until you resume.'
                : 'Active: Sencho polls this source and acts on webhooks according to the apply behavior.'}
            </p>
            {offerSuspend ? (
              <Button variant="outline" size="sm" className="gap-1.5" disabled={suspending || saving} onClick={() => setSuspendConfirmOpen(true)}>
                <Pause className="h-3.5 w-3.5" strokeWidth={1.5} />
                {suspending ? 'Suspending' : 'Suspend'}
              </Button>
            ) : (
              <BusyButton variant="outline" size="sm" pending={resuming} busyLabel="Resuming" disabled={saving} onClick={() => { void resumeSource(); }}>
                <Play className="h-3.5 w-3.5" strokeWidth={1.5} />
                Resume
              </BusyButton>
            )}
          </div>
        </SheetSection>
      )}
      <SheetSection title="Provider hooks">
        <GitProviderHooksCard stackName={stackName} canEdit={canEdit} nodeId={nodeId} />
      </SheetSection>
    </>
  );

  const secretsTab = (
    <SheetSection title="Repository secrets">
      <GitSourceSecretsSection
        stackName={stackName}
        canEdit={canMutateSource}
        linked
        disabled={saving || loading}
        nodeId={nodeId}
      />
    </SheetSection>
  );

  const driftTab = (
    <SheetSection title="Drift">
      <div className="rounded-lg border border-muted bg-card/40 px-3 py-1">
        {driftItems.map((d, i) => <GitOpsDriftRow key={`${d.class}-${d.owner}-${i}`} item={d} />)}
      </div>
    </SheetSection>
  );

  const tabBodies: Record<GitSourceTab, ReactNode> = {
    overview: overviewTab,
    source: sourceTab,
    automation: automationTab,
    secrets: secretsTab,
    drift: driftTab,
  };

  let sheetBody: ReactNode;
  if (loading) {
    sheetBody = (
      <div className="space-y-3">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  } else if (loadError !== null) {
    sheetBody = (
      <div
        role="alert"
        data-testid="git-source-load-error"
        className="space-y-3 rounded-lg border border-destructive/40 bg-destructive/[0.06] px-3 py-3"
      >
        <p className="font-mono text-[11px] text-destructive">{loadError}</p>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => { void load('open'); }}>
          <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.5} />
          Retry
        </Button>
      </div>
    );
  } else if (source) {
    sheetBody = tabBodies[activeTab];
  } else {
    sheetBody = (
      <>
        {statusModel && overviewTab}
        <SheetSection title="Repository">{claimedByBlueprint ? claimedNotice : renderFields('all')}</SheetSection>
      </>
    );
  }

  return (
    <>
      <SystemSheet
        open={open}
        onOpenChange={onOpenChange}
        crumb={crumb ?? ['Stack', stackName, 'Git source']}
        name="Git source"
        meta={sheetMeta}
        size="lg"
        // A linked source offers Update only when something differs from what is stored. The
        // toolbar is inert while the sheet is reading or could not read, so nothing acts on a
        // source that is not the one on screen.
        primaryAction={toolbarLive && canMutateSource && (!source || dirty) ? {
          label: saving ? (source ? 'Updating' : 'Saving') : (source ? 'Update' : 'Save'),
          onClick: () => { void save(); },
          pending: saving,
          icon: Save,
        } : undefined}
        secondaryActions={secondaryActions}
        destructiveAction={toolbarLive && canMutateSource && source ? {
          label: 'Detach',
          onClick: () => setRemoveConfirmOpen(true),
          disabled: deleting || saving,
          icon: Trash2,
        } : undefined}
        tabs={tabs}
        activeTab={source ? activeTab : undefined}
        onTabChange={id => setTab(id as GitSourceTab)}
        footerContext={footerContext}
      >
        {sheetBody}
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
        onAdopted={() => { void load('refresh'); onSourceChanged?.(); }}
      />
    </>
  );
}
