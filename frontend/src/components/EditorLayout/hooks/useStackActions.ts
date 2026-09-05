import { useRef, useCallback, useEffect, useState } from 'react';
import { apiFetch, withDeploySession } from '@/lib/api';
import {
  newAttemptId,
  abortAttempt,
  beginSpan,
  endSpan,
  flushPendingCommit,
  markMilestone,
  type PendingCommit,
  type SpanHandle,
} from '@/lib/hydrationTiming';
import { toast } from '@/components/ui/toast-store';
import { buildServiceUrl, openServiceUrl } from '@/lib/serviceUrl';
import { requestServiceUpdate as postServiceUpdate, requestServiceRestore as postServiceRestore } from '@/lib/serviceUpdate';
import type { EffectiveServiceModelResult } from '@/types/effectiveServices';
import { absentFault, pendingSourceStatus, type GitSourcePendingMap } from '@/lib/gitopsState';
import type { GitOpsRevisionCarrier } from '@/types/gitops';
import type { useEditorViewState } from './useEditorViewState';
import type { useStackListState } from './useStackListState';
import type { useViewNavigationState } from './useViewNavigationState';
import type { OverlayState, LoadFileOptions } from './useOverlayState';
import type { Node } from '@/context/NodeContext';
import type { RunWithLogParams } from '@/context/DeployFeedbackContext';
import { parsePath } from '@/lib/router/senchoRoute';
import { resolveEnvFilePath } from '@/lib/router/envRoute';
import type { EditorTab, RouteStackLoadResult } from '@/lib/router/routeTypes';
import type { StackAction, RecoverableAction, FailureClassification, ContainerInfo } from '../EditorView';
import type { NotificationItem } from '../../dashboard/types';
import type { PolicyBlockPayload, PolicyBlockableAction } from '../../stack/PolicyBlockDialog';
import type {
  MissingExternalNetworksPayload,
} from '../../stack/MissingExternalNetworksDialog';
import type { PreDeployScanImage } from '@/types/security';
import { resolveStackFileKey } from './resolveStackFileKey';

interface RunResult {
  ok: boolean;
  errorMessage?: string;
  rolledBack?: boolean;
  /** Health gate run id from the success body, when the backend started one. */
  healthGateId?: string | null;
  /**
   * Deploy hit a missing-external-networks gate; the dialog owns deployPendingRef
   * until the operator cancels or continues.
   */
  deferredNetworks?: boolean;
}

type MissingExternalNetworksEnvelope = MissingExternalNetworksPayload & {
  declaredExternalCount: number;
};

type UpdateSuccessBody = {
  healthGateId: string | null;
  recheckWarning?: string;
};

/** healthGateId (and optional recheckWarning) from a success body. */
const parseUpdateSuccessBody = async (response: Response): Promise<UpdateSuccessBody> => {
  try {
    const body: unknown = await response.json();
    if (!isRecord(body)) return { healthGateId: null };
    return {
      healthGateId: typeof body.healthGateId === 'string' ? body.healthGateId : null,
      recheckWarning: typeof body.recheckWarning === 'string' ? body.recheckWarning : undefined,
    };
  } catch (e) {
    // A success body should always parse; the warn surfaces a future
    // double-read bug instead of silently disabling the gate UI.
    console.warn('[HealthGate] could not read the success body:', e);
    return { healthGateId: null };
  }
};

/** healthGateId from a success body, or null when absent or unreadable. */
const parseHealthGateId = async (response: Response): Promise<string | null> => {
  const { healthGateId } = await parseUpdateSuccessBody(response);
  return healthGateId;
};

// Sentinel stored in overlayState.pendingUnsavedLoad to mark that the pending
// confirmation is a node switch (not a stack load). When the user confirms the
// discard, discardAndLoadPending calls setActiveNode(targetNode) and skips the
// stack-load branch.
export const NODE_SWITCH_PENDING_TOKEN = '__node-switch-pending__';

type StackActionError = Error & { rolledBack?: boolean; failure?: FailureClassification };

// Fallback classification when the response never reached a Sencho backend
// (proxy 502/504 for a dead remote, or a 503 with no classified body).
const NODE_UNREACHABLE_FAILURE: FailureClassification = {
  reason: 'node_unreachable',
  label: 'Node or Docker unreachable',
  suggestion: 'Check that the node is online and Docker is running, then retry.',
};

const UNREACHABLE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

// Mirrors ImageUpdateService's post-update warning copy: UPDATE_STILL_PRESENT_WARNING,
// UPDATE_VERIFICATION_INCOMPLETE_WARNING, and UPDATE_DIGEST_UNCHANGED_WARNING. Those
// warnings assume an update was just applied, but checkUpdatesForStack runs before
// any update, so they are replaced with accurate pre-update copy. The set is a
// safety net for pairing changes: today only the verification-incomplete warning
// actually arrives outside the still_present branch, which is intercepted earlier.
// A stack-specific reason (e.g. a compose render failure) is still forwarded as-is.
const GENERIC_POST_UPDATE_WARNINGS: ReadonlySet<string> = new Set([
  'The update command completed, but Sencho still detects an available image update.',
  'The update command completed, but Sencho could not fully verify whether an image update remains.',
  'The update command completed, but the image digest was not updated. Your Docker daemon may cache older content through a registry mirror, or the container may still be pinned to the previous image. Check your daemon configuration or recreate the container with --force-recreate.',
]);

const SELF_STACK_PROTECTED_CODE = 'self_stack_protected';

const isSelfStackProtectedResponse = (rawBody: string, status?: number): boolean => {
  if (status !== 409) return false;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    return isRecord(parsed) && parsed.code === SELF_STACK_PROTECTED_CODE;
  } catch {
    return false;
  }
};

const parseFailureClassification = (value: unknown): FailureClassification | undefined => {
  if (
    isRecord(value) &&
    typeof value.reason === 'string' &&
    typeof value.label === 'string' && value.label.trim() &&
    typeof value.suggestion === 'string' && value.suggestion.trim()
  ) {
    return { reason: value.reason, label: value.label, suggestion: value.suggestion };
  }
  if (value !== undefined) {
    // Likely hub/node version skew or a mangled proxy body; the raw error
    // message still renders, only the classification panel is degraded.
    console.warn('Unrecognized failure classification shape in error response:', value);
  }
  return undefined;
};

type StackOpAction = 'deploy' | 'down' | 'restart' | 'stop' | 'start' | 'update' | 'delete';

interface StackOpInProgressInfo {
  action: StackOpAction;
  startedAt: number;
  user: string;
}

const STACK_OP_PRESENT_PARTICIPLE: Record<StackOpAction, string> = {
  deploy: 'deploying',
  down: 'taking down',
  restart: 'restarting',
  stop: 'stopping',
  start: 'starting',
  update: 'updating',
  delete: 'deleting',
};

const VALID_STACK_OP_ACTIONS: ReadonlySet<string> = new Set(
  Object.keys(STACK_OP_PRESENT_PARTICIPLE),
);

type EditorState = ReturnType<typeof useEditorViewState>;
type StackListState = ReturnType<typeof useStackListState>;
type NavState = ReturnType<typeof useViewNavigationState>;

interface UseStackActionsOptions {
  editorState: EditorState;
  stackListState: StackListState;
  navState: NavState;
  overlayState: OverlayState;
  activeNode: Node | null | undefined;
  setActiveNode: (node: Node) => void;
  nodes: Node[];
  runWithLog: (
    params: RunWithLogParams,
    run: (deployStarted: Promise<void>, deploySessionId: string) => Promise<RunResult>,
  ) => Promise<RunResult>;
  // Last live output line for a stack, but only while a deploy-feedback session
  // is streaming that exact stack; used to enrich failure diagnostics safely.
  getLastDeployOutputLine: (stackName: string) => string | undefined;
  diffPreviewEnabled: boolean;
  // Active node advertises the update-guard capability, so manual updates show
  // the pre-update readiness dialog. Defaults to false: without the
  // capability, updates run directly with no dialog.
  hasUpdateGuard?: boolean;
  // Active node advertises guided external-network preflight. Absent capability
  // keeps legacy deploy (no GET). Advertised-but-broken fails closed.
  hasGuidedExternalNetworkPreflight?: boolean;
  // Active node advertises service-scoped updates. Gates both the
  // effective-services fetch (skipped entirely on an older node, so
  // effectiveServices stays empty and no declared-service headers render)
  // and the manual per-service update/rebuild action.
  hasServiceScopedUpdate?: boolean;
  // Target-aware stack:edit check. Pass the loaded stack identity (folder name
  // or compose path); callers strip extensions when comparing to RBAC stack
  // names. Evaluated against the load target so post-load auto-edit is not
  // gated by a stale previously-selected stack.
  canEditStack: (stackNameOrFilename: string) => boolean;
  /** Fail-closed: true only when active node meta explicitly lists stack-down-remove-volumes. */
  canOfferVolumeRemoval?: boolean;
  /**
   * Mobile (and any shell-owned) cleanup after deleting the stack that is
   * currently open in the editor. EditorLayout clears pending detail and
   * flips to the stack list surface. Required: the sole production caller
   * owns that state, and an optional callback would silently skip it.
   */
  onDeletedOpenStack: () => void;
  /**
   * Drop in-memory notifications for a deleted stack on the active node.
   * Caller must pass the node id and canonical stack basename (no .yml/.yaml).
   * Optional so unit tests that do not exercise delete can omit it.
   */
  removeNotificationsForStack?: (nodeId: number, stackName: string) => void;
  /** Admin role: required together with canReapplyCompose for Save & Reapply. */
  isAdmin?: boolean;
  /** Authoritative canReapplyCompose === true for the active node. */
  canReapplyCompose?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const PRE_DEPLOY_SUMMARY_TIMEOUT_MS = 5000;

/**
 * Fetch the pre-deploy scan advisory for a manual deploy. Returns the image
 * list when the advisory is enabled and the backend answers in time, or null to
 * mean "no advisory, deploy normally" for every other case (setting off,
 * timeout, an older node without the route, or any error). Failing open is
 * deliberate: the advisory is visibility, it must never block a deploy. Bound to
 * the captured node so it targets the same node the deploy will hit.
 */
export async function fetchPreDeployAdvisory(
  stackName: string,
  opNodeId: number | null,
): Promise<PreDeployScanImage[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PRE_DEPLOY_SUMMARY_TIMEOUT_MS);
  try {
    const res = await apiFetch(
      `/security/stacks/${encodeURIComponent(stackName)}/pre-deploy-summary`,
      { nodeId: opNodeId, signal: controller.signal },
    );
    if (!res.ok) return null;
    const data: unknown = await res.json();
    if (!isRecord(data) || data.enabled !== true || !Array.isArray(data.images)) return null;
    return data.images as PreDeployScanImage[];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const MISSING_EXTERNAL_PREFLIGHT_TIMEOUT_MS = 10000;

function parseMissingExternalNetworksPayload(data: unknown): MissingExternalNetworksPayload | null {
  if (!isRecord(data)) return null;
  if (
    data.status !== 'ok'
    && data.status !== 'render_unavailable'
    && data.status !== 'runtime_unavailable'
  ) {
    return null;
  }
  if (typeof data.stackName !== 'string' || typeof data.autoCreateEnabled !== 'boolean') return null;
  if (!Array.isArray(data.networks)) return null;
  return {
    status: data.status,
    autoCreateEnabled: data.autoCreateEnabled,
    stackName: data.stackName,
    networks: data.networks as MissingExternalNetworksPayload['networks'],
    renderError:
      typeof data.renderError === 'string' && data.renderError.length > 0
        ? data.renderError
        : undefined,
  };
}

/**
 * Authoritative missing-external preflight for the captured deploy node.
 * Returns null only when the route is missing or the body is unusable (treat
 * as fail-closed when the capability is advertised).
 */
export async function fetchMissingExternalNetworks(
  stackName: string,
  opNodeId: number | null,
): Promise<MissingExternalNetworksEnvelope | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MISSING_EXTERNAL_PREFLIGHT_TIMEOUT_MS);
  try {
    const res = await apiFetch(
      `/stacks/${encodeURIComponent(stackName)}/missing-external-networks`,
      { nodeId: opNodeId, signal: controller.signal },
    );
    if (!res.ok) return null;
    const data: unknown = await res.json();
    const payload = parseMissingExternalNetworksPayload(data);
    if (!payload || !isRecord(data)) return null;
    const declaredExternalCount = typeof data.declaredExternalCount === 'number'
      ? data.declaredExternalCount
      : 0;
    return { ...payload, declaredExternalCount };
  } catch (error) {
    console.error('Failed to fetch missing external networks:', error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function createSafeExternalNetworks(
  networks: MissingExternalNetworksPayload['networks'],
  opNodeId: number | null,
): Promise<{ ok: boolean; errorMessage?: string }> {
  for (const network of networks.filter((n) => n.safe)) {
    try {
      const res = await apiFetch('/system/networks', {
        method: 'POST',
        nodeId: opNodeId,
        body: JSON.stringify({ name: network.name, driver: 'bridge' }),
      });
      if (res.ok || res.status === 409) continue;
      const body: unknown = await res.json().catch(() => null);
      const message = isRecord(body) && typeof body.error === 'string'
        ? body.error
        : `Failed to create network "${network.name}" (${res.status})`;
      return { ok: false, errorMessage: message };
    } catch (error) {
      console.error('Failed to create external network:', error);
      return {
        ok: false,
        errorMessage: error instanceof Error ? error.message : `Failed to create network "${network.name}"`,
      };
    }
  }
  return { ok: true };
}

function missingExternalBlocksDeploy(
  envelope: MissingExternalNetworksEnvelope,
): string | null {
  if (envelope.status === 'render_unavailable') {
    return envelope.renderError || 'Sencho could not render this stack\'s Compose model to check external networks.';
  }
  if (envelope.status === 'runtime_unavailable' && envelope.declaredExternalCount > 0) {
    return 'Sencho could not read Docker networking state to check external networks.';
  }
  return null;
}

function getResponseCode(rawBody: string): string | undefined {
  try {
    const payload: unknown = JSON.parse(rawBody);
    return isRecord(payload) && typeof payload.code === 'string' ? payload.code : undefined;
  } catch {
    return undefined;
  }
}

const parseStackOpInProgress = (rawBody: string): StackOpInProgressInfo | null => {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (!isRecord(parsed) || parsed.code !== 'stack_op_in_progress') return null;
    const inProgress = parsed.inProgress;
    if (
      !isRecord(inProgress) ||
      typeof inProgress.action !== 'string' ||
      typeof inProgress.startedAt !== 'number' ||
      !VALID_STACK_OP_ACTIONS.has(inProgress.action)
    ) {
      return null;
    }
    return {
      action: inProgress.action as StackOpAction,
      startedAt: inProgress.startedAt,
      user: typeof inProgress.user === 'string' ? inProgress.user : '',
    };
  } catch {
    return null;
  }
};

const stackOpInProgressMessage = (stackName: string, info: StackOpInProgressInfo): string => {
  const verb = STACK_OP_PRESENT_PARTICIPLE[info.action] ?? 'busy';
  const actor = info.user && info.user !== 'system' ? ` (started by ${info.user})` : '';
  return `${stackName} is already ${verb}${actor}.`;
};

const parseStackActionError = (rawBody: string, fallback: string, status?: number): StackActionError => {
  let message = rawBody || fallback;
  let rolledBack = false;
  let failure: FailureClassification | undefined;
  let parsedCode: string | undefined;
  let bodyWasJson = false;

  try {
    const parsed: unknown = JSON.parse(rawBody);
    bodyWasJson = true;
    if (isRecord(parsed)) {
      if (typeof parsed.error === 'string' && parsed.error.trim()) {
        message = parsed.error;
      }
      rolledBack = parsed.rolledBack === true;
      failure = parseFailureClassification(parsed.failure);
      if (typeof parsed.code === 'string') parsedCode = parsed.code;
    }
  } catch {
    /* not JSON */
  }

  // A gateway-style status with no classified body means the request likely
  // never reached the owning node's backend; surface that as the cause. A 503
  // qualifies only when it is body-less (proxy generated) or the backend's own
  // docker_unavailable shape, so an unrelated future 503 is not mislabeled.
  if (!failure && status !== undefined && UNREACHABLE_STATUSES.has(status)) {
    const qualifies = status !== 503 || !bodyWasJson || parsedCode === 'docker_unavailable';
    if (qualifies) failure = { ...NODE_UNREACHABLE_FAILURE };
  }

  const error = new Error(message) as StackActionError;
  error.rolledBack = rolledBack;
  error.failure = failure;
  return error;
};

export function useStackActions(options: UseStackActionsOptions) {
  const {
    editorState,
    stackListState,
    navState,
    overlayState,
    activeNode,
    setActiveNode,
    nodes,
    runWithLog,
    getLastDeployOutputLine,
    diffPreviewEnabled,
    hasUpdateGuard = false,
    hasGuidedExternalNetworkPreflight = false,
    hasServiceScopedUpdate = false,
    canEditStack,
    canOfferVolumeRemoval = false,
    onDeletedOpenStack,
    removeNotificationsForStack,
    isAdmin = false,
    canReapplyCompose = false,
  } = options;

  const pendingStackLoadRef = useRef<string | null>(null);
  const pendingLogsRef = useRef<{ stackName: string; containerName: string } | null>(null);
  // True from a deploy click through the async pre-deploy advisory phase until
  // the deploy starts or is cancelled, so a double-click cannot start two deploys.
  const deployPendingRef = useRef(false);
  // Aborts the most recent loadFile sequence (compose GET, envs GET, env content
  // GET, containers GET, backup GET). A node switch, an unmount, or a second
  // loadFile call before the first finishes all cancel the in-flight fetches so
  // late responses never overwrite freshly-loaded state.
  const loadFileAbortRef = useRef<AbortController | null>(null);

  // Hydration-timing: the current detail (loadFileCore) attempt, the file it is
  // loading, and the commits waiting for React to observe committed state.
  const detailAttemptRef = useRef<string | null>(null);
  const detailFileRef = useRef<string | null>(null);
  const detailVisiblePendingRef = useRef<PendingCommit | null>(null);
  const detailContainersPendingRef = useRef<PendingCommit | null>(null);
  const detailHydratedPendingRef = useRef<PendingCommit | null>(null);
  // Bumped when arming detail_visible so same-file reloads (selectedFile and
  // activeView unchanged) still re-run the commit effect.
  const [detailVisibleEpoch, setDetailVisibleEpoch] = useState(0);

  // Live ownership for container fetches: render-closure comparisons after an
  // await can accept a response for a stack/node that is no longer active.
  const selectedFileRef = useRef(stackListState.selectedFile);
  const activeNodeIdRef = useRef(activeNode?.id);
  const containersRef = useRef(editorState.containers);
  // Same-owner arbitration: soft refresh, Retry, and detail load can overlap
  // for one stack/node; only the newest generation may apply success or failure.
  const containersFetchGenRef = useRef(0);
  useEffect(() => {
    selectedFileRef.current = stackListState.selectedFile;
    activeNodeIdRef.current = activeNode?.id;
    containersRef.current = editorState.containers;
  });

  // Cancel an open Save & Reapply confirmation if the active node or selected
  // stack diverges from the capture (never retarget a pending confirm).
  useEffect(() => {
    const capture = overlayState.composeReapplyCapture;
    if (!capture) return;
    if (
      activeNode?.id !== capture.nodeId
      || stackListState.selectedFile !== capture.stackFile
    ) {
      overlayState.setComposeReapplyCapture(null);
    }
  }, [
    activeNode?.id,
    stackListState.selectedFile,
    overlayState.composeReapplyCapture,
    overlayState.setComposeReapplyCapture,
  ]);

  useEffect(() => {
    return () => {
      loadFileAbortRef.current?.abort();
      containersFetchGenRef.current += 1;
    };
  }, []);

  // Commit-aligned detail milestones. Each fires once React has committed the
  // observed state for the owning attempt; commitMilestone no-ops for a
  // superseded (node switch) or aborted (re-load) attempt so an interrupted
  // load never records a success milestone.
  useEffect(() => {
    if (stackListState.selectedFile !== detailFileRef.current) return;
    if (navState.activeView !== 'editor') return;
    flushPendingCommit(detailVisiblePendingRef, 'detail_visible');
  }, [stackListState.selectedFile, navState.activeView, detailVisibleEpoch]);

  useEffect(() => {
    if (stackListState.selectedFile !== detailFileRef.current) return;
    flushPendingCommit(detailContainersPendingRef, 'detail_containers_ready');
  }, [editorState.containers, stackListState.selectedFile]);

  useEffect(() => {
    // Wait for the load to settle so this reflects the fully hydrated detail.
    if (editorState.isFileLoading) return;
    if (stackListState.selectedFile !== detailFileRef.current) return;
    flushPendingCommit(detailHydratedPendingRef, 'detail_hydrated');
  }, [editorState.isFileLoading, stackListState.selectedFile, editorState.containers]);

  const isAbortError = (err: unknown): boolean =>
    err instanceof Error && err.name === 'AbortError';

  const hasUnsavedChanges = () =>
    editorState.content !== editorState.originalContent ||
    editorState.envContent !== editorState.originalEnvContent;

  const isComposeDirty = () => editorState.content !== editorState.originalContent;
  const isEnvDirty = () => editorState.envContent !== editorState.originalEnvContent;

  const getStackMenuVisibility = (file: string) => {
    // Without authoritative status evidence every lifecycle action fails closed:
    // undefined status must not read as "exited but deployable".
    if (!hydrationReady()) {
      return {
        showDeploy: false,
        showStop: false,
        showRestart: false,
        showUpdate: false,
        showTakeDown: false,
      };
    }
    // A partial stack has running containers, so it shows the running-stack
    // lifecycle actions (stop/restart/update) rather than deploy.
    const raw = stackListState.stackStatuses[file];
    const status = raw === 'partial' ? 'running' : raw;
    const isSelf = stackListState.stackSelfFlags[file] === true;
    return {
      showDeploy: !isSelf && status !== 'running',
      showStop: !isSelf && status === 'running',
      showRestart: status === 'running',
      showUpdate: !isSelf && status === 'running',
      showTakeDown: !isSelf && (raw === 'running' || raw === 'partial' || raw === 'exited'),
    };
  };

  const isSelfStackFile = (file: string | null | undefined): boolean =>
    !!file && stackListState.stackSelfFlags[file] === true;

  // Ref-backed readiness: evaluates the CURRENT node/list/evidence at call
  // time, so a dialog opened while ready cannot bypass a later readiness loss.
  const hydrationReady = stackListState.hydrationReady;

  // Executor-boundary readiness: the evidence must be authoritative for the
  // active node AND that node must still be the node the deferred operation
  // was captured for. A dialog opened on node A cannot dispatch after the
  // operator switched to node B, even once B finishes hydrating. Compares
  // against the existing effect-updated activeNodeIdRef (see above): by the
  // time a dialog is confirmed, the switch effect has long run.
  const hydrationReadyForNode = (opNodeId: number | null): boolean => {
    if (!hydrationReady()) return false;
    if (opNodeId !== (activeNodeIdRef.current ?? null)) return false;
    return true;
  };

  const openSelfStackProtectedIfNeeded = (file: string | null | undefined): boolean => {
    // Without authoritative self identity the frontend must not guess: block
    // without opening the self-stack modal (which would falsely identify an
    // ordinary stack as Sencho). The backend 409 remains the last line.
    if (!hydrationReady()) return true;
    if (!isSelfStackFile(file)) return false;
    overlayState.openSelfStackProtected();
    return true;
  };

  const openStackApp = (file: string) => {
    if (!hydrationReady()) return;
    const port = stackListState.stackPorts[file];
    if (!port) return;
    const url = buildServiceUrl({ node: activeNode, publicPort: port });
    if (url) openServiceUrl(url);
  };

  const resetEditorState = () => {
    // Cancel any in-flight loadFile chain before wiping state; a late response
    // arriving after the reset would otherwise repopulate the editor with the
    // previous node's data.
    loadFileAbortRef.current?.abort();
    loadFileAbortRef.current = null;
    // loadFileCore's finally skips clearing loading when the signal is aborted,
    // so clear it here. Otherwise useUrlSync's writer stays blocked after a
    // delete-leave (or any other reset) that aborts a mid-flight load.
    editorState.setIsFileLoading(false);
    stackListState.setSelectedFile(null);
    editorState.setContent('');
    editorState.setOriginalContent('');
    editorState.setEnvContent('');
    editorState.setOriginalEnvContent('');
    editorState.setEnvFiles([]);
    editorState.setSelectedEnvFile('');
    editorState.setEnvExists(false);
    editorState.setContainers([]);
    editorState.setContainersLoadStatus('idle');
    editorState.setContainersLoadError(null);
    containersFetchGenRef.current += 1;
    editorState.setEffectiveServices([]);
    editorState.setServiceUpdateInProgress(null);
    editorState.setIsEditing(false);
  };

  type ContainersFetchMode = 'foreground' | 'soft';
  type ContainersFetchResult =
    | { ok: true; containers: ContainerInfo[] }
    | { ok: false; reason: 'http' | 'malformed' | 'network' | 'aborted' | 'stale'; error?: string };
  type ContainersFetchOwnership = {
    signal?: AbortSignal;
    attemptId?: string;
    expectedFile: string;
    // The node the fetch was pinned to (null = local). A mid-flight node change
    // elsewhere cannot invalidate (or retarget) it.
    expectedNodeId: number | null;
    generation: number;
  };

  const ownershipStillValid = (
    ownership: ContainersFetchOwnership,
  ): 'ok' | 'aborted' | 'stale' => {
    if (ownership.signal?.aborted) return 'aborted';
    if (selectedFileRef.current !== ownership.expectedFile) return 'stale';
    // Both sides normalize against null: the ref is `number | undefined` (no
    // active node yet) and the ownership field is `number | null` (pinned
    // local target). `undefined !== null` is true in strict equality, so an
    // un-normalized pair would report a false stale for a plain local load.
    if ((activeNodeIdRef.current ?? null) !== ownership.expectedNodeId) return 'stale';
    if (containersFetchGenRef.current !== ownership.generation) return 'stale';
    if (
      ownership.attemptId !== undefined
      && detailAttemptRef.current !== ownership.attemptId
    ) {
      return 'stale';
    }
    return 'ok';
  };

  const applyContainersFetchFailure = (mode: ContainersFetchMode, message: string) => {
    if (mode === 'foreground') {
      editorState.setContainers([]);
      editorState.setContainersLoadStatus('error');
      editorState.setContainersLoadError(message);
      return;
    }
    // Soft: prior non-empty cards stay visible. Prior confirmed-empty becomes a
    // recoverable error so soft failure never keeps "No containers running".
    if (containersRef.current.length === 0) {
      editorState.setContainersLoadStatus('error');
      editorState.setContainersLoadError(message);
    }
  };

  const fetchStackContainers = async (
    stackFile: string,
    mode: ContainersFetchMode,
    ownership: Omit<ContainersFetchOwnership, 'generation'>,
  ): Promise<ContainersFetchResult> => {
    const stackName = stackFile.replace(/\.(yml|yaml)$/, '');
    const owned: ContainersFetchOwnership = {
      ...ownership,
      generation: ++containersFetchGenRef.current,
    };
    let headersSpan: SpanHandle | null = null;
    let bodySpan: SpanHandle | null = null;
    if (mode === 'foreground') {
      editorState.setContainersLoadStatus('loading');
      editorState.setContainersLoadError(null);
    }
    try {
      headersSpan = owned.attemptId
        ? beginSpan('fetch_headers', { attemptId: owned.attemptId })
        : null;
      const containersRes = await apiFetch(`/stacks/${stackName}/containers`, {
        signal: owned.signal,
        nodeId: owned.expectedNodeId ?? null,
      });
      const hopProxied = containersRes.headers.get('x-sencho-proxy') === '1';
      if (headersSpan !== null) {
        endSpan(headersSpan, { proxied: hopProxied, detail: { status: containersRes.status } });
        headersSpan = null;
      }
      const afterHeaders = ownershipStillValid(owned);
      if (afterHeaders !== 'ok') {
        return { ok: false, reason: afterHeaders };
      }
      if (!containersRes.ok) {
        const message = `Could not load containers (${containersRes.status}).`;
        applyContainersFetchFailure(mode, message);
        return { ok: false, reason: 'http', error: message };
      }
      bodySpan = owned.attemptId
        ? beginSpan('body_decode', { attemptId: owned.attemptId, proxied: hopProxied })
        : null;
      const conts: unknown = await containersRes.json();
      if (bodySpan !== null) {
        endSpan(bodySpan);
        bodySpan = null;
      }
      const afterBody = ownershipStillValid(owned);
      if (afterBody !== 'ok') {
        return { ok: false, reason: afterBody };
      }
      if (!Array.isArray(conts)) {
        const message = 'Container list response was invalid.';
        applyContainersFetchFailure(mode, message);
        return { ok: false, reason: 'malformed', error: message };
      }
      const list = conts as ContainerInfo[];
      const dispatchSpan = owned.attemptId
        ? beginSpan('state_dispatch', { attemptId: owned.attemptId, proxied: hopProxied })
        : null;
      editorState.setContainers(list);
      editorState.setContainersLoadStatus('success');
      editorState.setContainersLoadError(null);
      if (dispatchSpan !== null) endSpan(dispatchSpan);
      return { ok: true, containers: list };
    } catch (error) {
      if (headersSpan !== null) endSpan(headersSpan, { outcome: 'error' });
      if (bodySpan !== null) endSpan(bodySpan, { outcome: 'error' });
      if (isAbortError(error) || owned.signal?.aborted) {
        return { ok: false, reason: 'aborted' };
      }
      const afterCatch = ownershipStillValid(owned);
      if (afterCatch !== 'ok') {
        return { ok: false, reason: afterCatch };
      }
      console.error('Failed to load containers:', error);
      const message = 'Could not load containers.';
      applyContainersFetchFailure(mode, message);
      return { ok: false, reason: 'network', error: message };
    }
  };

  // Re-sync the open stack's container list. Used after both successful and
  // failed/stalled operations so the detail never shows containers that no
  // longer reflect reality. Returns 'ok' when the live list was applied,
  // 'skipped' when ownership arbitration dropped the result (stale/aborted or
  // wrong selection), and 'failed' on a real soft fetch error. Callers that
  // only care about a successful apply should check for 'ok'.
  // stackName is kept for call-site clarity; the fetch derives the name from stackFile.
  const refreshSelectedContainers = async (
    _stackName: string,
    stackFile: string,
  ): Promise<'ok' | 'skipped' | 'failed'> => {
    if (selectedFileRef.current !== stackFile) return 'skipped';
    const result = await fetchStackContainers(stackFile, 'soft', {
      expectedFile: stackFile,
      expectedNodeId: activeNodeIdRef.current ?? null,
    });
    if (result.ok) return 'ok';
    if (result.reason === 'stale' || result.reason === 'aborted') return 'skipped';
    return 'failed';
  };

  const retryContainersLoad = async () => {
    const stackFile = selectedFileRef.current;
    if (!stackFile) return;
    await fetchStackContainers(stackFile, 'foreground', {
      expectedFile: stackFile,
      expectedNodeId: activeNodeIdRef.current ?? null,
    });
  };

  const loadContainerState = (
    filename: string,
    signal: AbortSignal | undefined,
    attemptId: string | undefined,
    // Pin the fetch to this node (null = local). Only loadFileCore passes it;
    // the other callers construct the expectation from the current ref.
    expectedNodeId: number | null,
  ): Promise<ContainersFetchResult> =>
    fetchStackContainers(filename, 'foreground', {
      signal,
      attemptId,
      expectedFile: filename,
      expectedNodeId,
    });

  // Stack operations whose failure produces a recovery panel. A failed
  // stop/start/delete is not recoverable through retry/restart/rollback.
  const RECOVERABLE_ACTIONS: readonly StackAction[] = ['deploy', 'update', 'restart', 'rollback'];
  const isRecoverableAction = (action: StackAction): action is RecoverableAction =>
    RECOVERABLE_ACTIONS.includes(action);

  // Store a terminal failure so the in-detail recovery panel can offer next
  // steps. Non-recoverable actions are skipped. Snapshots the last output line
  // only when the deploy-feedback panel is streaming this stack at failure time
  // (see getLastDeployOutputLine); undefined otherwise.
  const recordActionFailureFor = (
    stackFile: string,
    stackName: string,
    action: StackAction,
    startedAt: number,
    errorMessage: string | undefined,
    rolledBack: boolean,
    failure?: FailureClassification,
  ) => {
    if (!isRecoverableAction(action)) return;
    stackListState.recordActionFailure(stackFile, {
      action,
      errorMessage,
      rolledBack,
      startedAt,
      endedAt: Date.now(),
      lastOutputLine: getLastDeployOutputLine(stackName),
      failure,
    });
  };

  const refreshGitSourcePending = async () => {
    try {
      const res = await apiFetch('/git-sources');
      if (!res.ok) return;
      // The revision is optional because this route is proxied: a node that
      // predates the revision model answers rows without one.
      const sources: Array<
        { stack_name: string; pending_commit_sha: string | null } & Partial<GitOpsRevisionCarrier>
      > = await res.json();
      const map: GitSourcePendingMap = {};
      for (const s of sources) {
        const revision = s.gitopsRevision;
        const status = revision ? pendingSourceStatus(revision) : null;
        if (status) {
          map[s.stack_name] = status;
          continue;
        }
        // Nothing answered. Either the row predates the model, or a GitOps write
        // failed and was swallowed while the pending commit still committed. The
        // flat pointer is the only thing left that can answer, and going quiet on
        // a stack that genuinely has an update waiting would be a regression.
        //
        // A projection that reports a fault is excluded: it means an application
        // was expected and could not be read, so the pointer is not evidence that
        // a candidate is ready, and naming a state here would be a guess. The
        // panels surface that fault properly; this indicator only ever claims
        // that an update is waiting.
        const unanswered = !revision
          || (revision.targetMode === 'not_applicable' && absentFault(revision).length === 0);
        if (unanswered && s.pending_commit_sha) {
          map[s.stack_name] = 'candidate_ready';
        }
      }
      editorState.setGitSourcePendingMap(map);
    } catch {
      // Non-critical; leave prior state.
    }
  };

  // loadFile and loadFileOnNode call each other (loadFileOnNode -> loadFile, navigateToNotification
  // -> loadFileOnNode or loadFile). A ref breaks the mutual-recursion hoisting constraint without
  // needing to hoist both functions or restructure the call graph.
  const loadFileRef = useRef<(filename: string, options?: LoadFileOptions) => Promise<void>>(async () => {});

  const loadFileOnNode = async (node: Node, filename: string, options?: LoadFileOptions) => {
    if (!filename) return;
    if (
      !options?.skipUnsavedCheck &&
      stackListState.selectedFile &&
      filename !== stackListState.selectedFile &&
      hasUnsavedChanges()
    ) {
      overlayState.setPendingUnsavedNode(node);
      overlayState.setPendingUnsavedLoad(filename);
      overlayState.setPendingLoadOptions(options ?? null);
      return;
    }
    setActiveNode(node);
    stackListState.setSearchQuery('');
    // Pin the load to the target node explicitly: activeNode has not re-rendered
    // yet, so an unpinned load would read the stale ref (or, once it does render,
    // whatever node another tab made active in the shared localStorage).
    await loadFileRef.current(filename, { ...options, nodeId: node.id });
  };

  const clearEnvState = () => {
    editorState.setEnvFiles([]);
    editorState.setSelectedEnvFile('');
    editorState.setEnvContent('');
    editorState.setOriginalEnvContent('');
    editorState.setEnvExists(false);
    editorState.setEnvEtag(null);
  };

  const loadEnvState = async (filename: string, signal?: AbortSignal, opNodeId?: number | null): Promise<string[]> => {
    try {
      const envsRes = await apiFetch(`/stacks/${filename}/envs`, { signal, nodeId: opNodeId });
      if (signal?.aborted) return [];
      if (!envsRes.ok) {
        clearEnvState();
        return [];
      }
      const { envFiles } = await envsRes.json();
      if (signal?.aborted) return [];
      if (envFiles && envFiles.length > 0) {
        editorState.setEnvFiles(envFiles);
        const firstFile = envFiles[0];
        editorState.setSelectedEnvFile(firstFile);
        editorState.setEnvExists(true);
        const envContentRes = await apiFetch(
          `/stacks/${filename}/env?file=${encodeURIComponent(firstFile)}`,
          { signal, nodeId: opNodeId },
        );
        if (signal?.aborted) return envFiles;
        if (envContentRes.ok) {
          const envText = await envContentRes.text();
          editorState.setEnvContent(envText || '');
          editorState.setOriginalEnvContent(envText || '');
          editorState.setEnvEtag(envContentRes.headers.get('etag'));
        } else {
          editorState.setEnvContent('');
          editorState.setOriginalEnvContent('');
          editorState.setEnvEtag(null);
        }
        return envFiles;
      }
      clearEnvState();
      return [];
    } catch (err) {
      if (isAbortError(err)) return [];
      clearEnvState();
      return [];
    }
  };

  const loadBackupState = async (filename: string, signal?: AbortSignal, opNodeId?: number | null) => {
    try {
      const backupRes = await apiFetch(`/stacks/${filename}/backup`, { signal, nodeId: opNodeId });
      if (signal?.aborted) return;
      if (backupRes.ok) editorState.setBackupInfo(await backupRes.json());
      else editorState.setBackupInfo({ exists: false, timestamp: null });
    } catch (err) {
      if (isAbortError(err)) return;
      editorState.setBackupInfo({ exists: false, timestamp: null });
    }
  };

  // Declared-service facts for the multi-service headers. Skipped entirely
  // without the capability so an older remote node never sees the extra
  // request; a render failure or non-ok response also fails closed to an
  // empty list, which keeps the legacy single-service layout.
  const loadEffectiveServicesState = async (filename: string, signal?: AbortSignal, opNodeId?: number | null) => {
    if (!hasServiceScopedUpdate) {
      editorState.setEffectiveServices([]);
      return;
    }
    const stackName = filename.replace(/\.(yml|yaml)$/, '');
    try {
      const res = await apiFetch(`/stacks/${stackName}/effective-services`, { signal, nodeId: opNodeId });
      if (signal?.aborted) return;
      if (!res.ok) {
        editorState.setEffectiveServices([]);
        return;
      }
      const data = await res.json() as EffectiveServiceModelResult;
      if (signal?.aborted) return;
      editorState.setEffectiveServices(data.renderable ? data.services : []);
    } catch (err) {
      if (isAbortError(err)) return;
      editorState.setEffectiveServices([]);
    }
  };

  const applyEditorRouteState = (tab: EditorTab) => {
    editorState.setActiveTab(tab);
    editorState.setEditingCompose(true);
    editorState.setIsEditing(false);
  };

  const loadFileCore = async (filename: string, options?: LoadFileOptions): Promise<RouteStackLoadResult> => {
    if (!filename) return { ok: false };
    if (
      !options?.skipUnsavedCheck &&
      stackListState.selectedFile &&
      filename !== stackListState.selectedFile &&
      hasUnsavedChanges()
    ) {
      overlayState.setPendingUnsavedLoad(filename);
      overlayState.setPendingLoadOptions(options ?? null);
      return { ok: false };
    }
    loadFileAbortRef.current?.abort();
    // Supersede the previous detail attempt so a late commit from an interrupted
    // load can never record a success milestone.
    if (detailAttemptRef.current) abortAttempt(detailAttemptRef.current);
    detailVisiblePendingRef.current = null;
    detailContainersPendingRef.current = null;
    detailHydratedPendingRef.current = null;
    const controller = new AbortController();
    loadFileAbortRef.current = controller;
    const { signal } = controller;
    const attemptId = newAttemptId();
    detailAttemptRef.current = attemptId;
    detailFileRef.current = filename;

    editorState.setIsFileLoading(true);
    editorState.setIsEditing(false);
    editorState.setEditingCompose(false);
    editorState.setActiveTab('compose');
    // Clear prior stack health before the first request so compose/env hydration
    // never shows another stack's containers or service grouping. Bump the
    // containers fetch generation so an in-flight soft refresh cannot rewrite
    // this cleared state before loadContainerState claims a newer generation.
    editorState.setContainers([]);
    editorState.setEffectiveServices([]);
    editorState.setContainersLoadError(null);
    editorState.setContainersLoadStatus('loading');
    containersFetchGenRef.current += 1;
    let headersSpan: SpanHandle | null = null;
    let bodySpan: SpanHandle | null = null;
    // Node pin for the whole load: an explicit option wins (loadFileOnNode),
    // otherwise the node this tab captured. Captured once here so no request in
    // the chain can follow a node another tab made active mid-load.
    const opNodeId = options?.nodeId !== undefined ? options.nodeId : (activeNode?.id ?? null);
    try {
      headersSpan = beginSpan('fetch_headers', { attemptId });
      const res = await apiFetch(`/stacks/${filename}`, { signal, nodeId: opNodeId });
      const proxied = res.headers.get('x-sencho-proxy') === '1';
      endSpan(headersSpan, { proxied, detail: { status: res.status } });
      headersSpan = null;
      if (signal.aborted) { abortAttempt(attemptId); return { ok: false }; }
      bodySpan = beginSpan('body_decode', { attemptId, proxied });
      const text = await res.text();
      endSpan(bodySpan);
      bodySpan = null;
      if (signal.aborted) { abortAttempt(attemptId); return { ok: false }; }
      if (!res.ok) {
        throw new Error(`Failed to load stack: ${res.status}`);
      }
      const dispatchSpan = beginSpan('state_dispatch', { attemptId, proxied });
      stackListState.setSelectedFile(filename);
      navState.setActiveView('editor');
      editorState.setContent(text || '');
      editorState.setOriginalContent(text || '');
      editorState.setComposeEtag(res.headers.get('etag'));
      endSpan(dispatchSpan);
      detailVisiblePendingRef.current = { attemptId, token: filename, proxied };
      setDetailVisibleEpoch((n) => n + 1);
      const envFiles = await loadEnvState(filename, signal, opNodeId);
      const containersResult = await loadContainerState(filename, signal, attemptId, opNodeId);
      if (!signal.aborted) {
        if (containersResult.ok) {
          detailContainersPendingRef.current = {
            attemptId,
            token: `${filename}:${containersResult.containers.length}`,
            proxied,
          };
        } else if (containersResult.reason !== 'aborted' && containersResult.reason !== 'stale') {
          markMilestone('detail_containers_ready', {
            attemptId,
            outcome: 'error',
            proxied,
            detail: { reason: containersResult.reason },
          });
        }
      }
      await loadBackupState(filename, signal, opNodeId);
      await loadEffectiveServicesState(filename, signal, opNodeId);
      // Post-load auto-edit evaluates permission for the loaded target, not
      // the previously selected stack (selectedFile was just updated above).
      if (options?.startInComposeEdit && canEditStack(filename)) {
        editorState.setEditingCompose(true);
        editorState.setActiveTab('compose');
        editorState.setIsEditing(true);
      }
      if (!signal.aborted) {
        detailHydratedPendingRef.current = { attemptId, token: filename, proxied };
      }
      return { ok: true, envFiles };
    } catch (error) {
      if (headersSpan !== null) endSpan(headersSpan, { outcome: 'error' });
      if (bodySpan !== null) endSpan(bodySpan, { outcome: 'error' });
      if (isAbortError(error) || signal.aborted) { abortAttempt(attemptId); return { ok: false }; }
      console.error('Failed to load file:', error);
      toast.error(`Could not open "${filename.replace(/\.(ya?ml)$/, '')}". Check your connection and try again.`);
      stackListState.setSelectedFile(null);
      editorState.setContent('');
      editorState.setOriginalContent('');
      editorState.setComposeEtag(null);
      editorState.setEnvContent('');
      editorState.setOriginalEnvContent('');
      editorState.setEnvEtag(null);
      editorState.setContainers([]);
      editorState.setContainersLoadStatus('idle');
      editorState.setContainersLoadError(null);
      editorState.setEffectiveServices([]);
      return { ok: false };
    } finally {
      if (!signal.aborted) {
        editorState.setIsFileLoading(false);
      }
    }
  };

  const loadFile = async (filename: string, options?: LoadFileOptions) => {
    await loadFileCore(filename, options);
  };

  const loadFileForRoute = async (filename: string): Promise<RouteStackLoadResult> => {
    return loadFileCore(filename);
  };

  // Keep ref in sync so loadFileOnNode always calls the latest loadFile closure
  loadFileRef.current = loadFile;

  const navigateToNotification = (notif: NotificationItem) => {
    if (!notif.stack_name) return;
    pendingLogsRef.current = notif.container_name
      ? { stackName: notif.stack_name, containerName: notif.container_name }
      : null;
    const targetNode =
      notif.nodeId !== undefined ? nodes.find(n => n.id === notif.nodeId) : activeNode;
    if (targetNode && targetNode.id !== activeNode?.id) {
      void loadFileOnNode(targetNode, notif.stack_name);
    } else {
      void loadFile(notif.stack_name);
    }
  };

  const changeEnvFile = async (file: string) => {
    editorState.setSelectedEnvFile(file);
    editorState.setIsFileLoading(true);
    // Pin the fetch to the node this tab captured; another tab switching the
    // shared active node mid-edit must not retarget this GET.
    const opNodeId = activeNode?.id ?? null;
    try {
      const res = await apiFetch(
        `/stacks/${stackListState.selectedFile}/env?file=${encodeURIComponent(file)}`,
        { nodeId: opNodeId },
      );
      if (!res.ok) {
        editorState.setEnvContent('');
        editorState.setOriginalEnvContent('');
        editorState.setEnvEtag(null);
        toast.error('Could not load env file');
        return;
      }
      const text = await res.text();
      editorState.setEnvContent(text || '');
      editorState.setOriginalEnvContent(text || '');
      editorState.setEnvEtag(res.headers.get('etag'));
    } catch (e) {
      console.error('Failed to switch env file', e);
      editorState.setEnvContent('');
      editorState.setOriginalEnvContent('');
      editorState.setEnvEtag(null);
      toast.error('Failed to load env file');
    } finally {
      editorState.setIsFileLoading(false);
    }
  };

  const saveFile = async (options?: { force?: boolean }): Promise<boolean> => {
    if (editorState.activeTab === 'files') return false;
    if (!stackListState.selectedFile) return false;
    const force = options?.force === true;
    const isCompose = editorState.activeTab === 'compose';
    const currentContent = isCompose
      ? editorState.content || ''
      : editorState.envContent || '';
    const endpoint = isCompose
      ? `/stacks/${stackListState.selectedFile}`
      : `/stacks/${stackListState.selectedFile}/env?file=${encodeURIComponent(editorState.selectedEnvFile)}`;
    const etag = isCompose ? editorState.composeEtag : editorState.envEtag;
    const headers: Record<string, string> = {};
    if (!force && etag) headers['If-Match'] = etag;
    // Pin the PUT to the node this tab captured at the start of the operation.
    // A forced retry re-enters this same closure and reads the same already
    // captured `activeNode` binding, so both PUTs carry one target.
    const opNodeId = activeNode?.id ?? null;
    try {
      const response = await apiFetch(endpoint, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ content: currentContent }),
        nodeId: opNodeId,
      });
      if (response.status === 412) {
        const payload = await response.json().catch(() => null);
        const currentRemoteContent =
          payload && typeof payload.currentContent === 'string' ? payload.currentContent : '';
        const fileName = isCompose
          ? 'compose.yaml'
          : (editorState.selectedEnvFile || '.env').split('/').pop() ?? '.env';
        const confirmed = window.confirm(
          `${fileName} was changed by another tab or process. Overwrite their changes with yours? Click Cancel to discard your local edits and reload the latest version.`,
        );
        if (confirmed) {
          return await saveFile({ force: true });
        }
        if (isCompose) {
          editorState.setContent(currentRemoteContent);
          editorState.setOriginalContent(currentRemoteContent);
          editorState.setComposeEtag(response.headers.get('etag'));
        } else {
          editorState.setEnvContent(currentRemoteContent);
          editorState.setOriginalEnvContent(currentRemoteContent);
          editorState.setEnvEtag(response.headers.get('etag'));
        }
        toast.success('Reloaded the latest version of the file.');
        return false;
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }
      const newEtag = response.headers.get('etag');
      if (isCompose) {
        editorState.setOriginalContent(editorState.content);
        if (newEtag) editorState.setComposeEtag(newEtag);
      } else {
        editorState.setOriginalEnvContent(editorState.envContent);
        if (newEtag) editorState.setEnvEtag(newEtag);
      }
      toast.success('File saved successfully!');
      return true;
    } catch (error) {
      console.error('Failed to save file:', error);
      toast.error(`Failed to save file: ${(error as Error).message}`);
      return false;
    }
  };

  const requestSave = () => {
    const isCompose = editorState.activeTab === 'compose';
    const orig = isCompose ? editorState.originalContent : editorState.originalEnvContent;
    const curr = isCompose ? editorState.content : editorState.envContent;
    if (diffPreviewEnabled && editorState.activeTab !== 'files' && curr !== orig) {
      overlayState.setDiffPreview({
        mode: 'save',
        language: isCompose ? 'yaml' : 'ini',
        original: orig,
        modified: curr,
        fileName: isCompose ? 'compose.yaml' : editorState.selectedEnvFile || '.env',
      });
    } else {
      void saveFile();
    }
  };

  const requestSaveAndDeploy = (e: React.MouseEvent) => {
    const isCompose = editorState.activeTab === 'compose';
    const orig = isCompose ? editorState.originalContent : editorState.originalEnvContent;
    const curr = isCompose ? editorState.content : editorState.envContent;
    if (diffPreviewEnabled && editorState.activeTab !== 'files' && curr !== orig) {
      overlayState.setDiffPreview({
        mode: 'save-and-deploy',
        language: isCompose ? 'yaml' : 'ini',
        original: orig,
        modified: curr,
        fileName: isCompose ? 'compose.yaml' : editorState.selectedEnvFile || '.env',
      });
    } else {
      void handleSaveAndDeploy(e);
    }
  };

  // Parse a 409 body for a scan-policy block. When it is one, record it (with
  // the originating action, file, and the node the operation targeted so the
  // bypass retries the right endpoint on the right node) so PolicyBlockDialog
  // can open, and return the policy name. Returns null when the body is not a
  // policy block (e.g. a stack-op-in-progress 409).
  const tryOpenPolicyBlock = (
    rawBody: string,
    stackName: string,
    stackFile: string,
    action: PolicyBlockableAction,
    opNodeId: number | null,
  ): string | null => {
    let parsed: PolicyBlockPayload | null = null;
    try {
      parsed = JSON.parse(rawBody) as PolicyBlockPayload;
    } catch {
      /* not JSON */
    }
    if (parsed && parsed.policy && Array.isArray(parsed.violations)) {
      overlayState.setPolicyBlock({ stackName, stackFile, action, payload: parsed, nodeId: opNodeId });
      return parsed.policy.name;
    }
    return null;
  };

  const openMissingExternalNetworksDialog = (
    payload: MissingExternalNetworksPayload,
    opNodeId: number | null,
    onContinue: () => void,
  ) => {
    let settled = false;
    const finishCancel = () => {
      if (settled) return;
      settled = true;
      overlayState.setMissingExternalNetworks(null);
      deployPendingRef.current = false;
    };
    overlayState.setMissingExternalNetworks({
      payload,
      creating: false,
      cancel: finishCancel,
      openNetworking: () => {
        finishCancel();
        const node = nodes.find((n) => n.id === opNodeId);
        if (node && activeNode?.id !== opNodeId) setActiveNode(node);
        navState.setActiveView('networking');
      },
      createAndContinue: () => void createAndContinue(),
    });

    function setCreating(creating: boolean, verified?: MissingExternalNetworksPayload): void {
      overlayState.setMissingExternalNetworks((current) => (
        current
          ? { ...current, creating, ...(verified ? { payload: verified } : {}) }
          : current
      ));
    }

    async function createAndContinue(): Promise<void> {
      if (settled) return;
      // Final boundary recheck before ANY mutation: creating Docker networks
      // on the captured node must not proceed after ownership was lost.
      if (!hydrationReadyForNode(opNodeId)) {
        settled = true;
        overlayState.setMissingExternalNetworks(null);
        deployPendingRef.current = false;
        toast.error('Status data unavailable. Refresh and try again.');
        return;
      }
      setCreating(true);

      const created = await createSafeExternalNetworks(payload.networks, opNodeId);
      if (!created.ok) {
        toast.error(created.errorMessage ?? 'Failed to create external networks');
        setCreating(false);
        return;
      }

      const verified = await fetchMissingExternalNetworks(payload.stackName, opNodeId);
      if (!verified || verified.status !== 'ok') {
        toast.error('Could not verify external networks after create.');
        setCreating(false);
        return;
      }

      const stillMissing = payload.networks.some((needed) => (
        verified.networks.some((network) => network.name === needed.name)
      ));
      if (stillMissing) {
        toast.error('Some external networks are still missing after create.');
        setCreating(false, verified);
        return;
      }

      settled = true;
      overlayState.setMissingExternalNetworks(null);
      onContinue();
    }
  };

  const finishSuccessfulDeploy = async (
    response: Response,
    stackName: string,
    stackFile: string,
    ignorePolicy: boolean,
  ): Promise<RunResult> => {
    overlayState.setPolicyBlock(null);
    const healthGateId = await parseHealthGateId(response);
    if (healthGateId) {
      toast.info(ignorePolicy ? 'Stack deployed (policy bypassed). Verifying health...' : 'Stack deployed. Verifying health...');
    } else {
      toast.success(ignorePolicy ? 'Stack deployed (policy bypassed).' : 'Stack deployed successfully!');
    }
    await refreshSelectedContainers(stackName, stackFile);
    try {
      const backupRes = await apiFetch(`/stacks/${stackName}/backup`);
      if (backupRes.ok) editorState.setBackupInfo(await backupRes.json());
    } catch {
      /* ignore */
    }
    stackListState.recordActionSuccess(stackFile);
    return { ok: true, healthGateId };
  };

  const runDeploy = async (
    stackName: string,
    stackFile: string,
    ignorePolicy: boolean,
    started?: Promise<void>,
    deploySessionId?: string,
    opNodeId?: number | null,
  ): Promise<RunResult> => {
    const previousStatus = stackListState.stackStatuses[stackFile];
    const startedAt = Date.now();
    stackListState.setOptimisticStatus(stackFile, 'running');
    try {
      const path = ignorePolicy
        ? `/stacks/${stackName}/deploy?ignorePolicy=true`
        : `/stacks/${stackName}/deploy`;
      if (started) await started;
      const response = await apiFetch(path, withDeploySession(deploySessionId ?? '', { method: 'POST', nodeId: opNodeId }));
      if (!response.ok) {
        const rawBody = await response.text();
        if (isSelfStackProtectedResponse(rawBody, response.status)) {
          overlayState.openSelfStackProtected();
          return { ok: false, errorMessage: 'Sencho instance protected' };
        }
        if (response.status === 409) {
          // Either 409 sub-case (op-in-progress or policy block) leaves the
          // stack in its prior state; undo the optimistic "running" flip once.
          if (previousStatus !== undefined)
            stackListState.setOptimisticStatus(stackFile, previousStatus as 'running' | 'exited');
          const inProgress = parseStackOpInProgress(rawBody);
          if (inProgress) {
            const message = stackOpInProgressMessage(stackName, inProgress);
            toast.error(message);
            return { ok: false, errorMessage: message };
          }
          const blockedBy = tryOpenPolicyBlock(rawBody, stackName, stackFile, 'deploy', opNodeId ?? null);
          if (blockedBy) {
            const message = `Deploy blocked by policy "${blockedBy}"`;
            toast.error(message);
            return { ok: false, errorMessage: message };
          }
          if (
            getResponseCode(rawBody) === 'missing_external_networks'
            && hasGuidedExternalNetworkPreflight
          ) {
            const envelope = await fetchMissingExternalNetworks(stackName, opNodeId ?? null);
            if (!envelope) {
              toast.error('Deploy needs missing external networks, but Sencho could not re-check them.');
              return { ok: false, errorMessage: 'Missing external networks check failed' };
            }
            const blockMessage = missingExternalBlocksDeploy(envelope);
            if (blockMessage) {
              toast.error(blockMessage);
              return { ok: false, errorMessage: blockMessage };
            }
            if (envelope.status === 'ok' && envelope.networks.length === 0) {
              // Networks appeared between gate and refetch; retry once.
              const retry = await apiFetch(
                path,
                withDeploySession(deploySessionId ?? '', { method: 'POST', nodeId: opNodeId }),
              );
              if (retry.ok) {
                return finishSuccessfulDeploy(retry, stackName, stackFile, ignorePolicy);
              }
              throw parseStackActionError(await retry.text(), 'Deploy failed', retry.status);
            }
            openMissingExternalNetworksDialog(envelope, opNodeId ?? null, () => {
              // Final boundary recheck: the reactive retry must not start a
              // deploy on the captured node after ownership was lost.
              if (!hydrationReadyForNode(opNodeId ?? null)) {
                deployPendingRef.current = false;
                toast.error('Status data unavailable. Refresh and try again.');
                return;
              }
              stackListState.setStackAction(stackFile, 'deploy');
              void runWithLog({ stackName, action: 'deploy', nodeId: opNodeId ?? null }, (startedRetry, ds) =>
                runDeploy(stackName, stackFile, ignorePolicy, startedRetry, ds, opNodeId),
              ).finally(() => {
                stackListState.clearStackAction(stackFile);
                stackListState.refreshStacks(true);
                deployPendingRef.current = false;
              });
            });
            return { ok: false, deferredNetworks: true };
          }
        }
        throw parseStackActionError(rawBody, 'Deploy failed', response.status);
      }
      return finishSuccessfulDeploy(response, stackName, stackFile, ignorePolicy);
    } catch (error) {
      console.error('Failed to deploy:', error);
      if (previousStatus !== undefined)
        stackListState.setOptimisticStatus(stackFile, previousStatus as 'running' | 'exited');
      const deployError = error as StackActionError;
      const errorMessage = deployError.message || 'Failed to deploy stack';
      toast.error(
        deployError.rolledBack === true
          ? `${errorMessage} - automatically restored the previous compose and env files.`
          : errorMessage,
      );
      recordActionFailureFor(stackFile, stackName, 'deploy', startedAt, errorMessage, deployError.rolledBack === true, deployError.failure);
      await refreshSelectedContainers(stackName, stackFile);
      return { ok: false, errorMessage, rolledBack: deployError.rolledBack };
    }
  };

  const deployStack = async (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    if (!hydrationReady()) return;
    if (
      !stackListState.selectedFile ||
      stackListState.isStackBusy(stackListState.selectedFile) ||
      deployPendingRef.current
    )
      return;

    const stackFile = stackListState.selectedFile;
    if (isSelfStackFile(stackFile)) {
      if (isAdmin && canReapplyCompose && activeNode) {
        overlayState.setComposeReapplyCapture({
          nodeId: activeNode.id,
          nodeType: activeNode.type === 'local' ? 'local' : 'remote',
          nodeName: activeNode.name,
          stackFile,
        });
        return;
      }
      overlayState.openSelfStackProtected();
      return;
    }

    const stackName = stackFile.replace(/\.(yml|yaml)$/, '');
    // Snapshot the node once so the advisory fetch and the deploy stay bound to
    // it even if the active node changes while the advisory dialog is open.
    const opNodeId = activeNode?.id ?? null;
    deployPendingRef.current = true;

    // The actual deploy, pulled out so the optional pre-deploy advisory can gate
    // it without duplicating the action lifecycle. The stack action is set here
    // (not before the advisory) so cancelling the advisory leaves no stuck state.
    const runDeployFlow = async () => {
      // Final boundary recheck: an advisory or external-network dialog opened
      // while ready must not dispatch after readiness was lost or the active
      // node changed (the operation would target the captured node). Release
      // the pending guard so the UI is not stuck when blocked.
      if (!hydrationReadyForNode(opNodeId)) {
        deployPendingRef.current = false;
        toast.error('Status data unavailable. Refresh and try again.');
        return;
      }
      stackListState.setStackAction(stackFile, 'deploy');
      let deferredNetworks = false;
      try {
        const result = await runWithLog({ stackName, action: 'deploy', nodeId: opNodeId }, (started, ds) =>
          runDeploy(stackName, stackFile, false, started, ds, opNodeId),
        );
        deferredNetworks = result.deferredNetworks === true;
      } finally {
        stackListState.clearStackAction(stackFile);
        stackListState.refreshStacks(true);
        if (!deferredNetworks) {
          deployPendingRef.current = false;
        }
      }
    };

    const continueAfterExternalNetworks = () => {
      void runDeployFlow();
    };

    // Advisory runs before the deploy log opens (fails open: a null result means
    // setting off / timeout / older node / error, so the deploy proceeds).
    const beginDeployAfterAdvisory = async () => {
      if (hasGuidedExternalNetworkPreflight) {
        const envelope = await fetchMissingExternalNetworks(stackName, opNodeId);
        if (!envelope) {
          toast.error('Sencho could not check external networks on this node before deploy.');
          deployPendingRef.current = false;
          return;
        }
        const blockMessage = missingExternalBlocksDeploy(envelope);
        if (blockMessage) {
          toast.error(blockMessage);
          deployPendingRef.current = false;
          return;
        }
        if (envelope.status === 'ok' && envelope.networks.length > 0) {
          const allSafe = envelope.networks.every((n) => n.safe);
          if (!(allSafe && envelope.autoCreateEnabled)) {
            openMissingExternalNetworksDialog(envelope, opNodeId, continueAfterExternalNetworks);
            return;
          }
        }
      }
      await runDeployFlow();
    };

    const advisoryImages = await fetchPreDeployAdvisory(stackName, opNodeId);
    if (advisoryImages && advisoryImages.length > 0) {
      let settled = false;
      overlayState.setPreDeployAdvisory({
        stackName,
        images: advisoryImages,
        proceed: () => {
          if (settled) return;
          settled = true;
          overlayState.setPreDeployAdvisory(null);
          void beginDeployAfterAdvisory();
        },
        cancel: () => {
          if (settled) return;
          settled = true;
          overlayState.setPreDeployAdvisory(null);
          deployPendingRef.current = false;
        },
      });
      return;
    }
    await beginDeployAfterAdvisory();
  };

  const handleSaveAndDeploy = async (e: React.MouseEvent) => {
    // Readiness is rechecked before the PUT so a readiness loss while the file
    // was being edited cannot slip a mutation through.
    if (!hydrationReady()) return;
    const saved = await saveFile();
    if (!saved) return;
    await deployStack(e);
  };

  // Admin "Deploy anyway": re-issue the blocked action with ?ignorePolicy=true.
  // Retries whichever action triggered the block (deploy or update) so an
  // update bypass still re-pulls images, matching the backend bypass on each
  // endpoint. The server ignores the flag unless the caller is an admin.
  const bypassPolicyAndRetry = async () => {
    const policyBlock = overlayState.policyBlock;
    if (!policyBlock) return;
    // The block is bound to the node it was raised against; the bypass may only
    // dispatch if that node is still the active node with authoritative
    // evidence. A switch to another fully-hydrated node must block the retry.
    const { stackName, stackFile, action, nodeId: opNodeId } = policyBlock;
    if (!hydrationReadyForNode(opNodeId)) {
      toast.error('Status data unavailable. Refresh and try again.');
      return;
    }
    const existingFile = stackListState.files.includes(stackFile)
      ? stackFile
      : (stackListState.files.find(f => f.replace(/\.(yml|yaml)$/, '') === stackName) ?? stackFile);
    overlayState.setPolicyBypassing(true);
    try {
      if (action === 'update') {
        await runStackAction(existingFile, 'update', 'update', 'running', 'Stack updated successfully!', true, opNodeId);
      } else if (action === 'rollback') {
        await rollbackStack(true, opNodeId);
      } else {
        stackListState.setStackAction(existingFile, 'deploy');
        try {
          await runWithLog({ stackName, action: 'deploy', nodeId: opNodeId }, (started, ds) =>
            runDeploy(stackName, existingFile, true, started, ds, opNodeId),
          );
        } finally {
          stackListState.clearStackAction(existingFile);
          stackListState.refreshStacks(true);
        }
      }
    } finally {
      overlayState.setPolicyBypassing(false);
    }
  };

  const rollbackStack = async (ignorePolicy = false, opNodeId: number | null = activeNode?.id ?? null) => {
    if (!hydrationReady()) return;
    if (!stackListState.selectedFile || stackListState.isStackBusy(stackListState.selectedFile))
      return;
    const stackFile = stackListState.selectedFile;
    if (openSelfStackProtectedIfNeeded(stackFile)) return;
    const stackName = stackFile.replace(/\.(yml|yaml)$/, '');
    const startedAt = Date.now();
    stackListState.setStackAction(stackFile, 'rollback');
    stackListState.setOptimisticStatus(stackFile, 'running');
    try {
      const path = ignorePolicy
        ? `/stacks/${stackFile}/rollback?ignorePolicy=true`
        : `/stacks/${stackFile}/rollback`;
      const res = await apiFetch(path, { method: 'POST', nodeId: opNodeId });
      if (!res.ok) {
        const rawBody = await res.text();
        if (isSelfStackProtectedResponse(rawBody, res.status)) {
          overlayState.openSelfStackProtected();
          return;
        }
        if (res.status === 409) {
          const inProgress = parseStackOpInProgress(rawBody);
          if (inProgress) {
            const message = stackOpInProgressMessage(stackName, inProgress);
            toast.error(message);
            return;
          }
          const blockedBy = tryOpenPolicyBlock(rawBody, stackName, stackFile, 'rollback', opNodeId);
          if (blockedBy) {
            toast.error(`Rollback blocked by policy "${blockedBy}"`);
            return;
          }
        }
        throw parseStackActionError(rawBody, 'Rollback failed', res.status);
      }
      overlayState.setPolicyBlock(null);
      const body: unknown = await res.json().catch(() => null);
      const message = isRecord(body) && typeof body.message === 'string' ? body.message.trim() : '';
      toast.success(message || 'Stack rolled back from recovery generation.');
      stackListState.recordActionSuccess(stackFile);
      // The rollback already succeeded; a failure of the cosmetic refetches below
      // (containers redeployed by the rollback, restored compose content, backup
      // info) must not be mis-recorded as a rollback failure.
      try {
        await refreshSelectedContainers(stackName, stackFile);
        const contentRes = await apiFetch(`/stacks/${stackFile}`);
        const text = await contentRes.text();
        editorState.setContent(text || '');
        editorState.setOriginalContent(text || '');
        const backupRes = await apiFetch(`/stacks/${stackFile}/backup`);
        if (backupRes.ok) editorState.setBackupInfo(await backupRes.json());
      } catch (refetchError) {
        console.error('Post-rollback refetch failed:', refetchError);
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Rollback failed';
      toast.error(msg);
      recordActionFailureFor(stackFile, stackName, 'rollback', startedAt, msg, false,
        error instanceof Error ? (error as StackActionError).failure : undefined);
      await refreshSelectedContainers(stackName, stackFile);
    } finally {
      stackListState.clearStackAction(stackFile);
      stackListState.refreshStacks(true);
    }
  };

  const discardChanges = () => {
    if (editorState.activeTab === 'files') return;
    if (editorState.activeTab === 'compose') {
      editorState.setContent(editorState.originalContent);
    } else {
      editorState.setEnvContent(editorState.originalEnvContent);
    }
  };

  // Revert both compose and env buffers. Used by closeComposeEditor so a dirty
  // buffer on a non-active tab is not left hidden behind the Anatomy panel.
  // Keep discardChanges for the Save-dropdown current-tab discard.
  const discardAllChanges = () => {
    editorState.setContent(editorState.originalContent);
    editorState.setEnvContent(editorState.originalEnvContent);
  };

  const openComposeEditor = () => {
    const selected = stackListState.selectedFile;
    if (!selected || !canEditStack(selected)) return;
    editorState.setEditingCompose(true);
    editorState.setActiveTab('compose');
    editorState.setIsEditing(true);
  };

  const closeComposeEditor = () => {
    if (hasUnsavedChanges()) {
      discardAllChanges();
    }
    editorState.setEditingCompose(false);
  };

  const scanStackConfig = async () => {
    if (!stackListState.selectedFile || editorState.stackMisconfigScanning) return;
    const stackName = stackListState.selectedFile.replace(/\.(yml|yaml)$/, '');
    editorState.setStackMisconfigScanning(true);
    const loadingId = toast.loading(`Scanning ${stackName} configuration...`);
    try {
      const res = await apiFetch('/security/scan/stack', {
        method: 'POST',
        body: JSON.stringify({ stackName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed to start scan');
      if (data.status === 'failed') {
        throw new Error(data.error || 'Scan failed');
      }
      toast.success(
        `Config scan complete: ${data.misconfig_count ?? 0} misconfigurations found`,
      );
      overlayState.setStackMisconfigScanId(data.id as number);
    } catch (error) {
      const msg = error instanceof Error
        ? error.message
        : ((error as { error?: string })?.error ?? 'Config scan failed');
      toast.error(msg);
    } finally {
      toast.dismiss(loadingId);
      editorState.setStackMisconfigScanning(false);
    }
  };

  const runStackAction = async (
    stackFile: string,
    action: 'stop' | 'restart' | 'update',
    endpoint: string,
    optimisticStatus: 'running' | 'exited',
    successMessage: string,
    ignorePolicy = false,
    // Node the operation targets. Defaults to the live active node for direct
    // callers (toolbar stop/restart); the update path passes the node captured
    // when its readiness dialog opened so a mid-dialog node switch cannot
    // retarget the update.
    opNodeId: number | null = activeNode?.id ?? null,
  ): Promise<void> => {
    if (stackListState.isStackBusy(stackFile)) return;
    const stackName = stackFile.replace(/\.(yml|yaml)$/, '');
    const previousStatus = stackListState.stackStatuses[stackFile];
    const startedAt = Date.now();
    stackListState.setStackAction(stackFile, action);
    stackListState.setOptimisticStatus(stackFile, optimisticStatus);
    try {
      await runWithLog({ stackName, action, nodeId: opNodeId }, async (started, ds) => {
        await started;
        try {
          const url = ignorePolicy
            ? `/stacks/${stackName}/${endpoint}?ignorePolicy=true`
            : `/stacks/${stackName}/${endpoint}`;
          const response = await apiFetch(url, withDeploySession(ds, { method: 'POST', nodeId: opNodeId }));
          if (!response.ok) {
            const errText = await response.text();
            if (isSelfStackProtectedResponse(errText, response.status)) {
              overlayState.openSelfStackProtected();
              return { ok: false as const, errorMessage: 'Sencho instance protected' };
            }
            if (response.status === 409) {
              const inProgress = parseStackOpInProgress(errText);
              if (inProgress) {
                const message = stackOpInProgressMessage(stackName, inProgress);
                toast.error(message);
                return { ok: false as const, errorMessage: message };
              }
              if (action === 'update') {
                const blockedBy = tryOpenPolicyBlock(errText, stackName, stackFile, 'update', opNodeId);
                if (blockedBy) {
                  const message = `Update blocked by policy "${blockedBy}"`;
                  toast.error(message);
                  return { ok: false as const, errorMessage: message };
                }
              }
            }
            const actionError = parseStackActionError(errText, `${action} failed`, response.status);
            recordActionFailureFor(stackFile, stackName, action, startedAt, actionError.message, actionError.rolledBack === true, actionError.failure);
            await refreshSelectedContainers(stackName, stackFile);
            return {
              ok: false as const,
              errorMessage: actionError.message,
              rolledBack: actionError.rolledBack,
            };
          }
          overlayState.setPolicyBlock(null);
          const { healthGateId, recheckWarning } = await parseUpdateSuccessBody(response);
          if (action === 'update') {
            // With a health gate observing, the operation finishing is not the
            // final verdict yet; soften the toast so success is not claimed twice.
            if (healthGateId) {
              toast.info('Stack updated. Verifying health...');
            } else {
              toast.success(successMessage);
            }
            // Same surface as service-scoped Apply / Fleet Apply Now: the backend
            // may explain why a digest rebuild is still detected after Compose.
            if (recheckWarning) toast.info(recheckWarning);
            stackListState.fetchImageUpdates();
          } else {
            toast.success(successMessage);
          }
          await refreshSelectedContainers(stackName, stackFile);
          stackListState.recordActionSuccess(stackFile);
          return { ok: true as const, healthGateId };
        } catch (err) {
          const message = (err as Error).message || `${action} failed`;
          recordActionFailureFor(stackFile, stackName, action, startedAt, message, false);
          await refreshSelectedContainers(stackName, stackFile);
          return { ok: false as const, errorMessage: message };
        }
      });
    } catch (error) {
      console.error(`Failed to ${action}:`, error);
      if (previousStatus !== undefined)
        stackListState.setOptimisticStatus(stackFile, previousStatus as 'running' | 'exited');
      toast.error((error as Error).message || `Failed to ${action} stack`);
    } finally {
      stackListState.clearStackAction(stackFile);
      stackListState.refreshStacks(true);
    }
  };

  const stopStack = async (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    if (!hydrationReady()) return;
    if (!stackListState.selectedFile) return;
    if (openSelfStackProtectedIfNeeded(stackListState.selectedFile)) return;
    await runStackAction(stackListState.selectedFile, 'stop', 'stop', 'exited', 'Stack stopped successfully!');
  };

  const restartStack = async (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    if (!hydrationReady()) return;
    if (!stackListState.selectedFile) return;
    await runStackAction(stackListState.selectedFile, 'restart', 'restart', 'running', 'Stack restarted successfully!');
  };

  const serviceAction = async (
    action: 'start' | 'stop' | 'restart',
    serviceName: string,
  ) => {
    if (!hydrationReady()) return;
    if (!stackListState.selectedFile) return;
    if (action === 'stop' && openSelfStackProtectedIfNeeded(stackListState.selectedFile)) return;
    const stackName = stackListState.selectedFile.replace(/\.(yml|yaml)$/, '');
    try {
      const r = await apiFetch(
        `/stacks/${stackName}/services/${encodeURIComponent(serviceName)}/${action}`,
        { method: 'POST' },
      );
      if (!r.ok) {
        const rawBody = await r.text();
        if (isSelfStackProtectedResponse(rawBody, r.status)) {
          overlayState.openSelfStackProtected();
          return;
        }
        throw new Error(rawBody || `${action} failed`);
      }
      const label =
        action === 'restart' ? 'restarted' : action === 'stop' ? 'stopped' : 'started';
      toast.success(`Service "${serviceName}" ${label}`);
      const selected = selectedFileRef.current;
      if (selected) await refreshSelectedContainers(stackName, selected);
    } catch (e) {
      console.error(`Failed to ${action} service "${serviceName}":`, e);
      toast.error((e as Error).message || `Failed to ${action} service "${serviceName}"`);
    } finally {
      stackListState.refreshStacks(true);
    }
  };

  // Single entry point for every manual update trigger (toolbar, sidebar
  // context menu, recovery retry). With the update-guard capability it opens
  // the readiness dialog first; the dialog's proceed runs the same
  // runWithLog-backed executor either way, so there is exactly one update path.
  const requestStackUpdate = async (stackFile: string): Promise<void> => {
    if (stackListState.isStackBusy(stackFile)) return;
    const stackName = stackFile.replace(/\.(yml|yaml)$/, '');
    // Capture the node now so the readiness fetch and the update both target it
    // even if the active node changes while the readiness dialog is open.
    const opNodeId = activeNode?.id ?? null;
    const run = () => {
      // Final boundary recheck: the readiness dialog's proceed must not dispatch
      // to the captured node after readiness was lost or the active node changed.
      if (!hydrationReadyForNode(opNodeId)) {
        toast.error('Status data unavailable. Refresh and try again.');
        return Promise.resolve();
      }
      return runStackAction(stackFile, 'update', 'update', 'running', 'Stack updated successfully!', false, opNodeId);
    };
    if (hasUpdateGuard) {
      overlayState.setUpdateReadiness({
        stackName,
        stackFile,
        nodeId: opNodeId,
        proceed: () => {
          overlayState.setUpdateReadiness(null);
          void run();
        },
      });
      return;
    }
    await run();
  };

  // Single entry point for a manual service-scoped update/rebuild (declared-
  // service header, Updates view per-service Apply). Uses the same deploy-
  // feedback session as full-stack Update so progress streams and the health
  // gate is polled; siblings are not intentionally recreated.
  const requestServiceUpdate = async (
    stackFile: string,
    serviceName: string,
    mode: 'update' | 'rebuild' = 'update',
  ): Promise<void> => {
    if (!hydrationReady()) return;
    if (stackListState.isStackBusy(stackFile) || editorState.serviceUpdateInProgress) return;
    const stackName = stackFile.replace(/\.(yml|yaml)$/, '');
    const opNodeId = activeNode?.id ?? null;
    const run = async () => {
      // Final boundary recheck: the readiness dialog's proceed must not dispatch
      // to the captured node after readiness was lost or the active node changed.
      if (!hydrationReadyForNode(opNodeId)) {
        toast.error('Status data unavailable. Refresh and try again.');
        return;
      }
      editorState.setServiceUpdateInProgress({ service: serviceName, mode });
      try {
        await runWithLog({ stackName, action: 'update', nodeId: opNodeId, serviceName }, async (started, ds) => {
          await started;
          const result = await postServiceUpdate({
            nodeId: opNodeId,
            stackName,
            serviceName,
            mode,
            deploySessionId: ds,
          });
          if (!result.ok) {
            toast.error(result.error);
            return { ok: false as const, errorMessage: result.error };
          }
          const verb = mode === 'rebuild' ? 'rebuilt' : 'updated';
          if (result.healthGateId && result.observing) {
            toast.info(`Service "${serviceName}" ${verb}. Verifying health...`);
          } else {
            toast.success(`Service "${serviceName}" ${verb} successfully!`);
          }
          if (result.recheckWarning) toast.info(result.recheckWarning);
          stackListState.fetchImageUpdates();
          await refreshSelectedContainers(stackName, stackFile);
          stackListState.recordActionSuccess(stackFile);
          return {
            ok: true as const,
            healthGateId: result.observing ? result.healthGateId : null,
            recoveryId: result.recoveryId,
          };
        });
      } finally {
        editorState.setServiceUpdateInProgress(null);
        stackListState.refreshStacks(true);
      }
    };
    if (hasUpdateGuard) {
      overlayState.setUpdateReadiness({
        stackName,
        stackFile,
        nodeId: opNodeId,
        serviceName,
        mode,
        proceed: () => {
          overlayState.setUpdateReadiness(null);
          void run();
        },
      });
      return;
    }
    await run();
  };

  const requestServiceRestore = async (
    stackFile: string,
    serviceName: string,
    recoveryId: string,
  ): Promise<void> => {
    if (!hydrationReady()) return;
    if (stackListState.isStackBusy(stackFile) || editorState.serviceUpdateInProgress) return;
    const stackName = stackFile.replace(/\.(yml|yaml)$/, '');
    const opNodeId = activeNode?.id ?? null;
    editorState.setServiceUpdateInProgress({ service: serviceName, mode: 'update' });
    try {
      await runWithLog({ stackName, action: 'update', nodeId: opNodeId, serviceName }, async (started, ds) => {
        await started;
        const result = await postServiceRestore({
          nodeId: opNodeId,
          stackName,
          serviceName,
          recoveryId,
          deploySessionId: ds,
        });
        if (!result.ok) {
          toast.error(result.error);
          return { ok: false as const, errorMessage: result.error };
        }
        if (result.healthGateId && result.observing) {
          toast.info(`Service "${serviceName}" restored. Verifying health...`);
        } else {
          toast.success(`Service "${serviceName}" restored successfully!`);
        }
        stackListState.fetchImageUpdates();
        await refreshSelectedContainers(stackName, stackFile);
        stackListState.recordActionSuccess(stackFile);
        return {
          ok: true as const,
          healthGateId: result.observing ? result.healthGateId : null,
          recoveryId: result.recoveryId,
        };
      });
    } finally {
      editorState.setServiceUpdateInProgress(null);
      stackListState.refreshStacks(true);
    }
  };

  const updateStack = async (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    if (!hydrationReady()) return;
    if (!stackListState.selectedFile) return;
    if (openSelfStackProtectedIfNeeded(stackListState.selectedFile)) return;
    await requestStackUpdate(stackListState.selectedFile);
  };

  const deleteStack = async (pruneVolumes: boolean) => {
    // Final confirmation boundary: the dialog is bound to the node it opened
    // on. A switch to another node (even once it fully hydrates) must block the
    // delete rather than mutating the new node with the old dialog's stack name.
    // The dialog stays open and the toast explains why nothing happened.
    const deleteTarget = overlayState.deleteTarget;
    if (!deleteTarget) return;
    if (!hydrationReadyForNode(deleteTarget.nodeId)) {
      toast.error('Status data unavailable. Refresh and try again.');
      return;
    }
    const stackToDelete = deleteTarget.name;
    const deleteKey = resolveStackFileKey(stackListState.files, stackToDelete);
    const canonicalName = deleteKey.replace(/\.(yml|yaml)$/, '');
    if (stackListState.isStackBusy(deleteKey)) return;
    const opNodeId = deleteTarget.nodeId;
    stackListState.setStackAction(deleteKey, 'delete');
    try {
      const url = pruneVolumes
        ? `/stacks/${stackToDelete}?pruneVolumes=true`
        : `/stacks/${stackToDelete}`;
      const response = await apiFetch(url, { method: 'DELETE', nodeId: opNodeId });
      if (!response.ok) {
        const errText = await response.text();
        if (isSelfStackProtectedResponse(errText, response.status)) {
          overlayState.openSelfStackProtected();
          overlayState.closeDeleteDialog();
          return;
        }
        throw parseStackActionError(errText, 'Failed to delete stack', response.status);
      }
      toast.success('Stack deleted successfully!');
      overlayState.closeDeleteDialog();
      const selected = stackListState.selectedFile;
      const nodeId = activeNode?.id;
      if (nodeId != null && removeNotificationsForStack) {
        removeNotificationsForStack(nodeId, canonicalName);
      }
      // Always clear a deleted selection, even when another top-level view is
      // visible (Resources, Networking, etc.). Leaving that view is gated on
      // the editor being the active surface below.
      if (selected != null && selected.replace(/\.(yml|yaml)$/, '') === canonicalName) {
        resetEditorState();
        if (navState.activeView === 'editor') {
          navState.setActiveView('dashboard');
          onDeletedOpenStack();
        }
      }
      await stackListState.refreshStacks();
    } catch (error) {
      console.error('Failed to delete stack:', error);
      toast.error((error as Error).message || 'Failed to delete stack');
    } finally {
      stackListState.clearStackAction(deleteKey);
    }
  };

  const requestTakeDownStack = (stackName: string) => {
    if (!hydrationReady()) return;
    if (openSelfStackProtectedIfNeeded(
      stackListState.files.find(f => f.replace(/\.(yml|yaml)$/, '') === stackName) ?? stackName,
    )) return;
    overlayState.openTakeDownDialog({ name: stackName, nodeId: activeNode?.id ?? null });
  };

  const takeDownStack = async (removeVolumes: boolean) => {
    // Final confirmation boundary: the dialog is bound to the node it opened
    // on; a switch must block the take down rather than mutating the new node.
    const takeDownTarget = overlayState.takeDownTarget;
    if (!takeDownTarget) return;
    if (!hydrationReadyForNode(takeDownTarget.nodeId)) {
      toast.error('Status data unavailable. Refresh and try again.');
      return;
    }
    const stackToTakeDown = takeDownTarget.name;
    if (removeVolumes && !canOfferVolumeRemoval) {
      toast.error('Volume removal is not supported on this node');
      overlayState.closeTakeDownDialog();
      return;
    }
    const stackFile = resolveStackFileKey(stackListState.files, stackToTakeDown);
    if (stackListState.isStackBusy(stackFile)) return;
    if (openSelfStackProtectedIfNeeded(stackFile)) return;

    const previousStatus = stackListState.stackStatuses[stackFile];
    const startedAt = Date.now();
    const opNodeId = activeNode?.id ?? null;
    stackListState.setStackAction(stackFile, 'down');
    stackListState.setOptimisticStatus(stackFile, 'exited');
    try {
      await runWithLog({ stackName: stackToTakeDown, action: 'down', nodeId: opNodeId }, async (started, ds) => {
        await started;
        try {
          const url = removeVolumes
            ? `/stacks/${stackToTakeDown}/down?removeVolumes=true`
            : `/stacks/${stackToTakeDown}/down`;
          const response = await apiFetch(url, withDeploySession(ds, { method: 'POST', nodeId: opNodeId }));
          if (!response.ok) {
            const errText = await response.text();
            if (response.status === 409) {
              const inProgress = parseStackOpInProgress(errText);
              if (inProgress) {
                const message = stackOpInProgressMessage(stackToTakeDown, inProgress);
                toast.error(message);
                return { ok: false as const, errorMessage: message };
              }
            }
            if (isSelfStackProtectedResponse(errText, response.status)) {
              overlayState.openSelfStackProtected();
              overlayState.closeTakeDownDialog();
              return { ok: false as const, errorMessage: 'Protected stack' };
            }
            const actionError = parseStackActionError(errText, 'Take down failed', response.status);
            recordActionFailureFor(stackFile, stackToTakeDown, 'down', startedAt, actionError.message, false, actionError.failure);
            await refreshSelectedContainers(stackToTakeDown, stackFile);
            return { ok: false as const, errorMessage: actionError.message };
          }
          toast.success('Stack taken down successfully!');
          await refreshSelectedContainers(stackToTakeDown, stackFile);
          stackListState.recordActionSuccess(stackFile);
          overlayState.closeTakeDownDialog();
          return { ok: true as const };
        } catch (err) {
          const message = (err as Error).message || 'Take down failed';
          recordActionFailureFor(stackFile, stackToTakeDown, 'down', startedAt, message, false);
          await refreshSelectedContainers(stackToTakeDown, stackFile);
          return { ok: false as const, errorMessage: message };
        }
      });
    } catch (error) {
      console.error('Failed to take down stack:', error);
      if (previousStatus !== undefined) {
        stackListState.setOptimisticStatus(stackFile, previousStatus as 'running' | 'exited');
      }
      toast.error((error as Error).message || 'Failed to take down stack');
    } finally {
      stackListState.clearStackAction(stackFile);
      stackListState.refreshStacks(true);
    }
  };

  // Guard a navigation that would leave (and discard) a dirty editor: back to
  // the list, Home, or any bottom-tab / hamburger / command-palette
  // destination. When the editor is dirty the navigation is stashed and the
  // unsaved-changes dialog opens; discardAndLoadPending runs it on confirm.
  // When clean it runs immediately.
  const attemptLeaveEditor = (perform: () => void, onCancel?: () => void) => {
    if (stackListState.selectedFile && hasUnsavedChanges()) {
      overlayState.setPendingLeaveAction({ run: perform, onCancel });
      return;
    }
    perform();
  };

  const wouldDiscardOnPopstate = (): boolean => {
    if (!stackListState.selectedFile) return false;
    const parsed = parsePath(window.location.pathname, window.location.search);
    const targetStack = parsed.stackName;
    const targetView = parsed.view;

    if (targetView !== 'editor' || !targetStack || targetStack !== stackListState.selectedFile) {
      return isComposeDirty() || isEnvDirty();
    }
    // Leaving Monaco for stack detail on the same stack.
    if (editorState.editingCompose && parsed.editorTab == null) {
      return isComposeDirty() || isEnvDirty();
    }
    if (
      parsed.editorTab === 'env'
      && editorState.activeTab === 'env'
      && parsed.envFile
    ) {
      const resolved = resolveEnvFilePath(parsed.envFile, editorState.envFiles);
      if (resolved && resolved !== editorState.selectedEnvFile) {
        return isEnvDirty();
      }
    }
    return false;
  };

  const attemptPopstateNavigation = (apply: () => void, onCancel: () => void) => {
    if (wouldDiscardOnPopstate()) {
      overlayState.setPendingLeaveAction({ run: apply, onCancel });
      return;
    }
    apply();
  };

  const cancelPendingUnsavedLoad = () => {
    const cancel = overlayState.pendingLeaveAction?.onCancel;
    overlayState.setPendingUnsavedLoad(null);
    overlayState.setPendingLoadOptions(null);
    overlayState.setPendingUnsavedNode(null);
    overlayState.setPendingLeaveAction(null);
    cancel?.();
  };

  const discardAndLoadPending = () => {
    const leave = overlayState.pendingLeaveAction;
    const target = overlayState.pendingUnsavedLoad;
    const targetNode = overlayState.pendingUnsavedNode;
    const loadOptions = overlayState.pendingLoadOptions;
    editorState.setContent(editorState.originalContent);
    editorState.setEnvContent(editorState.originalEnvContent);
    overlayState.setPendingUnsavedLoad(null);
    overlayState.setPendingLoadOptions(null);
    overlayState.setPendingUnsavedNode(null);
    overlayState.setPendingLeaveAction(null);
    // A stashed "leave editor" navigation takes precedence; it already knows
    // how to tear down editor state (resetEditorState) and move the surface.
    if (leave) {
      leave.run();
      return;
    }
    if (target === NODE_SWITCH_PENDING_TOKEN) {
      if (targetNode) setActiveNode(targetNode);
      return;
    }
    if (target) {
      const resumeOptions: LoadFileOptions = {
        ...(loadOptions ?? {}),
        skipUnsavedCheck: true,
      };
      if (targetNode) void loadFileOnNode(targetNode, target, resumeOptions);
      else void loadFile(target, resumeOptions);
    }
  };

  const requestDeleteStack = () => {
    if (openSelfStackProtectedIfNeeded(stackListState.selectedFile)) return;
    overlayState.openDeleteDialog({
      name: stackListState.selectedFile ?? '',
      nodeId: activeNode?.id ?? null,
    });
  };

  const executeStackActionByFile = async (
    stackFile: string,
    action: StackAction,
    endpoint: string,
  ) => {
    if (!hydrationReady()) return;
    if (stackListState.isStackBusy(stackFile)) return;
    if (
      (action === 'deploy' || action === 'update' || action === 'stop' || action === 'delete' || action === 'rollback') &&
      openSelfStackProtectedIfNeeded(stackFile)
    ) {
      return;
    }
    // Updates route through the shared update path so the sidebar gets the
    // readiness dialog, the deploy-feedback modal, and the same failure
    // handling as the toolbar.
    if (action === 'update') {
      await requestStackUpdate(stackFile);
      return;
    }
    const stackName = stackFile.replace(/\.(yml|yaml)$/, '');
    const startedAt = Date.now();
    // Bind this sidebar action to the active node now so a policy-block bypass
    // retries on the same node even if the active node changes meanwhile.
    const opNodeId = activeNode?.id ?? null;
    stackListState.setStackAction(stackFile, action);

    if (action === 'stop') {
      stackListState.setOptimisticStatus(stackFile, 'exited');
    } else if (action === 'deploy' || action === 'restart') {
      stackListState.setOptimisticStatus(stackFile, 'running');
    }

    try {
      const response = await apiFetch(`/stacks/${stackName}/${endpoint}`, { method: 'POST', nodeId: opNodeId });
      if (!response.ok) {
        const errText = await response.text();
        if (isSelfStackProtectedResponse(errText, response.status)) {
          overlayState.openSelfStackProtected();
          return;
        }
        if (response.status === 409) {
          const inProgress = parseStackOpInProgress(errText);
          if (inProgress) {
            toast.error(stackOpInProgressMessage(stackName, inProgress));
            return;
          }
          if (action === 'deploy') {
            const blockedBy = tryOpenPolicyBlock(errText, stackName, stackFile, action, opNodeId);
            if (blockedBy) {
              toast.error(`Deploy blocked by policy "${blockedBy}"`);
              return;
            }
          }
        }
        throw parseStackActionError(errText, `${action} failed`, response.status);
      }
      toast.success(`Stack ${action}ed successfully!`);
      await refreshSelectedContainers(stackName, stackFile);
      if (action === 'deploy') {
        try {
          const backupRes = await apiFetch(`/stacks/${stackName}/backup`);
          if (backupRes.ok) editorState.setBackupInfo(await backupRes.json());
        } catch {
          /* ignore */
        }
      }
      stackListState.recordActionSuccess(stackFile);
    } catch (error) {
      console.error(`Failed to ${action}:`, error);
      const actionError = error as StackActionError;
      const msg = actionError.message || `Failed to ${action} stack`;
      toast.error(
        action === 'deploy' && actionError.rolledBack === true
          ? `${msg} - automatically restored the previous compose and env files.`
          : msg,
      );
      recordActionFailureFor(stackFile, stackName, action, startedAt, msg, actionError.rolledBack === true, actionError.failure);
      await refreshSelectedContainers(stackName, stackFile);
    } finally {
      stackListState.clearStackAction(stackFile);
      stackListState.refreshStacks(true);
    }
  };

  const checkUpdatesForStack = async (stackName: string) => {
    const loadingId = toast.loading(`Checking ${stackName} for image updates...`);
    try {
      const res = await apiFetch(`/image-updates/refresh/${encodeURIComponent(stackName)}`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json().catch(() => ({})) as { outcome?: unknown; warning?: unknown };
        await stackListState.fetchImageUpdates();
        const warning = typeof data.warning === 'string' ? data.warning : undefined;
        if (data.outcome === 'still_present') {
          toast.info(`${stackName} still has an update available.`);
        } else if (warning && GENERIC_POST_UPDATE_WARNINGS.has(warning)) {
          toast.info(`Could not fully verify update status for ${stackName}.`);
        } else if (warning) {
          toast.info(warning);
        } else {
          toast.success('Image update check complete.');
        }
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || 'Failed to check for updates');
      }
    } catch (error) {
      console.error(`Failed to check updates for stack ${stackName}:`, error);
      toast.error('Failed to check for updates');
    } finally {
      toast.dismiss(loadingId);
    }
  };

  const getDisplayName = (stackName: string) => stackName;

  // Adapter wrappers: convert (id, name) signature to overlayState object style
  const openBashModal = useCallback(
    (containerId: string, containerName: string) =>
      overlayState.openBashModal({ id: containerId, name: containerName }),
    [overlayState.openBashModal],
  );
  const closeBashModal = overlayState.closeBashModal;
  const openLogViewer = useCallback(
    (containerId: string, containerName: string) =>
      overlayState.openLogViewer({ id: containerId, name: containerName }),
    [overlayState.openLogViewer],
  );
  const closeLogViewer = overlayState.closeLogViewer;
  const openInspectImage = useCallback(
    (imageId: string, imageRef: string) => {
      const file = stackListState.selectedFile;
      if (!file || activeNode?.id == null) return;
      overlayState.openInspectImage({
        Id: imageId,
        RepoTags: imageRef ? [imageRef] : [],
        usedByStacks: [file.replace(/\.(ya?ml)$/, '')],
        nodeId: activeNode.id,
      });
    },
    [stackListState.selectedFile, activeNode?.id, overlayState.openInspectImage],
  );

  return {
    pendingStackLoadRef,
    pendingLogsRef,
    hasUnsavedChanges,
    getStackMenuVisibility,
    openStackApp,
    resetEditorState,
    refreshSelectedContainers,
    retryContainersLoad,
    refreshGitSourcePending,
    loadFile,
    loadFileForRoute,
    loadFileOnNode,
    applyEditorRouteState,
    navigateToNotification,
    changeEnvFile,
    saveFile,
    requestSave,
    requestSaveAndDeploy,
    handleSaveAndDeploy,
    rollbackStack,
    discardChanges,
    openComposeEditor,
    closeComposeEditor,
    scanStackConfig,
    runDeploy,
    deployStack,
    bypassPolicyAndRetry,
    stopStack,
    restartStack,
    serviceAction,
    updateStack,
    requestStackUpdate,
    requestServiceUpdate,
    requestServiceRestore,
    deleteStack,
    attemptLeaveEditor,
    attemptPopstateNavigation,
    cancelPendingUnsavedLoad,
    discardAndLoadPending,
    requestDeleteStack,
    requestTakeDownStack,
    takeDownStack,
    executeStackActionByFile,
    checkUpdatesForStack,
    getDisplayName,
    openBashModal,
    closeBashModal,
    openLogViewer,
    closeLogViewer,
    openInspectImage,
    isSelfStackFile,
    openSelfStackProtectedIfNeeded,
  };
}

export type StackActionsHook = ReturnType<typeof useStackActions>;
