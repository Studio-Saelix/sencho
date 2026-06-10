import { useRef, useCallback, useEffect } from 'react';
import { apiFetch, withDeploySession } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import type { useEditorViewState } from './useEditorViewState';
import type { useStackListState } from './useStackListState';
import type { useViewNavigationState } from './useViewNavigationState';
import type { OverlayState } from './useOverlayState';
import type { Node } from '@/context/NodeContext';
import type { ActionVerb } from '@/context/DeployFeedbackContext';
import type { StackAction, RecoverableAction, FailureClassification } from '../EditorView';
import type { NotificationItem } from '../../dashboard/types';
import type { PolicyBlockPayload, PolicyBlockableAction } from '../../stack/PolicyBlockDialog';

interface RunResult {
  ok: boolean;
  errorMessage?: string;
  rolledBack?: boolean;
  /** Health gate run id from the success body, when the backend started one. */
  healthGateId?: string | null;
}

/** healthGateId from a success body, or null when absent or unreadable. */
const parseHealthGateId = async (response: Response): Promise<string | null> => {
  try {
    const body: unknown = await response.json();
    if (isRecord(body) && typeof body.healthGateId === 'string') return body.healthGateId;
  } catch (e) {
    // A success body should always parse; the warn surfaces a future
    // double-read bug instead of silently disabling the gate UI.
    console.warn('[HealthGate] could not read the success body:', e);
  }
  return null;
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

type StackOpAction = 'deploy' | 'down' | 'restart' | 'stop' | 'start' | 'update';

interface StackOpInProgressInfo {
  action: StackOpAction;
  startedAt: number;
  user: string;
}

const STACK_OP_PRESENT_PARTICIPLE: Record<StackOpAction, string> = {
  deploy: 'deploying',
  down: 'stopping',
  restart: 'restarting',
  stop: 'stopping',
  start: 'starting',
  update: 'updating',
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
    params: { stackName: string; action: ActionVerb },
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
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

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
  } = options;

  const pendingStackLoadRef = useRef<string | null>(null);
  const pendingLogsRef = useRef<{ stackName: string; containerName: string } | null>(null);
  const checkUpdatesIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Aborts the most recent loadFile sequence (compose GET, envs GET, env content
  // GET, containers GET, backup GET). A node switch, an unmount, or a second
  // loadFile call before the first finishes all cancel the in-flight fetches so
  // late responses never overwrite freshly-loaded state.
  const loadFileAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      if (checkUpdatesIntervalRef.current !== null) {
        clearInterval(checkUpdatesIntervalRef.current);
      }
      loadFileAbortRef.current?.abort();
    };
  }, []);

  const isAbortError = (err: unknown): boolean =>
    err instanceof Error && err.name === 'AbortError';

  const hasUnsavedChanges = () =>
    editorState.content !== editorState.originalContent ||
    editorState.envContent !== editorState.originalEnvContent;

  const getStackMenuVisibility = (file: string) => {
    const status = stackListState.stackStatuses[file];
    return {
      showDeploy: status !== 'running',
      showStop: status === 'running',
      showRestart: status === 'running',
      showUpdate: status === 'running',
    };
  };

  const openStackApp = (file: string) => {
    const port = stackListState.stackPorts[file];
    if (!port) return;
    const host =
      activeNode?.type === 'remote' && activeNode?.api_url
        ? new URL(activeNode.api_url).hostname
        : window.location.hostname;
    window.open(`http://${host}:${port}`, '_blank');
  };

  const resetEditorState = () => {
    // Cancel any in-flight loadFile chain before wiping state; a late response
    // arriving after the reset would otherwise repopulate the editor with the
    // previous node's data.
    loadFileAbortRef.current?.abort();
    loadFileAbortRef.current = null;
    stackListState.setSelectedFile(null);
    editorState.setContent('');
    editorState.setOriginalContent('');
    editorState.setEnvContent('');
    editorState.setOriginalEnvContent('');
    editorState.setEnvFiles([]);
    editorState.setSelectedEnvFile('');
    editorState.setEnvExists(false);
    editorState.setContainers([]);
    editorState.setIsEditing(false);
  };

  // Re-sync the open stack's container list. Used after both successful and
  // failed/stalled operations so the detail never shows containers that no
  // longer reflect reality. Returns true only when the live list was fetched;
  // false on a non-applicable stack, a non-ok response, or a network error, so
  // callers (e.g. the recovery panel's Refresh) can report the real outcome.
  const refreshSelectedContainers = async (stackName: string, stackFile: string): Promise<boolean> => {
    if (stackListState.selectedFile !== stackFile) return false;
    try {
      const res = await apiFetch(`/stacks/${stackName}/containers`);
      if (!res.ok) return false;
      const conts = await res.json();
      editorState.setContainers(Array.isArray(conts) ? conts : []);
      return true;
    } catch {
      // Non-critical when called from an action's failure path: refreshStacks(true)
      // in the caller's finally still reconciles the sidebar status.
      return false;
    }
  };

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
      const sources: Array<{ stack_name: string; pending_commit_sha: string | null }> =
        await res.json();
      const map: Record<string, boolean> = {};
      for (const s of sources) {
        if (s.pending_commit_sha) map[s.stack_name] = true;
      }
      editorState.setGitSourcePendingMap(map);
    } catch {
      // Non-critical; leave prior state.
    }
  };

  // loadFile and loadFileOnNode call each other (loadFileOnNode -> loadFile, navigateToNotification
  // -> loadFileOnNode or loadFile). A ref breaks the mutual-recursion hoisting constraint without
  // needing to hoist both functions or restructure the call graph.
  const loadFileRef = useRef<(filename: string) => Promise<void>>(async () => {});

  const loadFileOnNode = async (node: Node, filename: string) => {
    if (!filename) return;
    if (
      stackListState.selectedFile &&
      filename !== stackListState.selectedFile &&
      hasUnsavedChanges()
    ) {
      overlayState.setPendingUnsavedNode(node);
      overlayState.setPendingUnsavedLoad(filename);
      return;
    }
    setActiveNode(node);
    stackListState.setSearchQuery('');
    await loadFileRef.current(filename);
  };

  const clearEnvState = () => {
    editorState.setEnvFiles([]);
    editorState.setSelectedEnvFile('');
    editorState.setEnvContent('');
    editorState.setOriginalEnvContent('');
    editorState.setEnvExists(false);
    editorState.setEnvEtag(null);
  };

  const loadEnvState = async (filename: string, signal?: AbortSignal) => {
    try {
      const envsRes = await apiFetch(`/stacks/${filename}/envs`, { signal });
      if (signal?.aborted) return;
      if (!envsRes.ok) {
        clearEnvState();
        return;
      }
      const { envFiles } = await envsRes.json();
      if (signal?.aborted) return;
      if (envFiles && envFiles.length > 0) {
        editorState.setEnvFiles(envFiles);
        const firstFile = envFiles[0];
        editorState.setSelectedEnvFile(firstFile);
        editorState.setEnvExists(true);
        const envContentRes = await apiFetch(
          `/stacks/${filename}/env?file=${encodeURIComponent(firstFile)}`,
          { signal },
        );
        if (signal?.aborted) return;
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
      } else {
        clearEnvState();
      }
    } catch (err) {
      if (isAbortError(err)) return;
      clearEnvState();
    }
  };

  const loadContainerState = async (filename: string, signal?: AbortSignal) => {
    try {
      const containersRes = await apiFetch(`/stacks/${filename}/containers`, { signal });
      if (signal?.aborted) return;
      const conts = await containersRes.json();
      editorState.setContainers(Array.isArray(conts) ? conts : []);
    } catch (error) {
      if (isAbortError(error)) return;
      console.error('Failed to load containers:', error);
      editorState.setContainers([]);
    }
  };

  const loadBackupState = async (filename: string, signal?: AbortSignal) => {
    try {
      const backupRes = await apiFetch(`/stacks/${filename}/backup`, { signal });
      if (signal?.aborted) return;
      if (backupRes.ok) editorState.setBackupInfo(await backupRes.json());
      else editorState.setBackupInfo({ exists: false, timestamp: null });
    } catch (err) {
      if (isAbortError(err)) return;
      editorState.setBackupInfo({ exists: false, timestamp: null });
    }
  };

  const loadFile = async (filename: string) => {
    if (!filename) return;
    if (
      stackListState.selectedFile &&
      filename !== stackListState.selectedFile &&
      hasUnsavedChanges()
    ) {
      overlayState.setPendingUnsavedLoad(filename);
      return;
    }
    // Cancel any in-flight load before starting a new one. A late response
    // from the previous stack must not overwrite the freshly-loaded one.
    loadFileAbortRef.current?.abort();
    const controller = new AbortController();
    loadFileAbortRef.current = controller;
    const { signal } = controller;

    editorState.setIsFileLoading(true);
    editorState.setIsEditing(false);
    editorState.setEditingCompose(false);
    editorState.setActiveTab('compose');
    try {
      const res = await apiFetch(`/stacks/${filename}`, { signal });
      if (signal.aborted) return;
      const text = await res.text();
      if (signal.aborted) return;
      stackListState.setSelectedFile(filename);
      navState.setActiveView('editor');
      editorState.setContent(text || '');
      editorState.setOriginalContent(text || '');
      editorState.setComposeEtag(res.headers.get('etag'));
      await loadEnvState(filename, signal);
      await loadContainerState(filename, signal);
      await loadBackupState(filename, signal);
    } catch (error) {
      if (isAbortError(error) || signal.aborted) return;
      console.error('Failed to load file:', error);
      // Surface the failure so a tap that cannot load (offline, dead remote
      // node, 5xx) is not a silent no-op, especially on mobile where the row
      // tap optimistically opens the detail surface.
      toast.error(`Could not open "${filename.replace(/\.(ya?ml)$/, '')}". Check your connection and try again.`);
      stackListState.setSelectedFile(null);
      editorState.setContent('');
      editorState.setOriginalContent('');
      editorState.setComposeEtag(null);
      editorState.setEnvContent('');
      editorState.setOriginalEnvContent('');
      editorState.setEnvEtag(null);
      editorState.setContainers([]);
    } finally {
      if (!signal.aborted) {
        editorState.setIsFileLoading(false);
      }
    }
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
    try {
      const res = await apiFetch(
        `/stacks/${stackListState.selectedFile}/env?file=${encodeURIComponent(file)}`,
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
    try {
      const response = await apiFetch(endpoint, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ content: currentContent }),
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
        editorState.setIsEditing(false);
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
      editorState.setIsEditing(false);
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
  // the originating action and file so the bypass retries the right endpoint)
  // so PolicyBlockDialog can open, and return the policy name. Returns null
  // when the body is not a policy block (e.g. a stack-op-in-progress 409).
  const tryOpenPolicyBlock = (
    rawBody: string,
    stackName: string,
    stackFile: string,
    action: PolicyBlockableAction,
  ): string | null => {
    let parsed: PolicyBlockPayload | null = null;
    try {
      parsed = JSON.parse(rawBody) as PolicyBlockPayload;
    } catch {
      /* not JSON */
    }
    if (parsed && parsed.policy && Array.isArray(parsed.violations)) {
      overlayState.setPolicyBlock({ stackName, stackFile, action, payload: parsed });
      return parsed.policy.name;
    }
    return null;
  };

  const runDeploy = async (
    stackName: string,
    stackFile: string,
    ignorePolicy: boolean,
    started?: Promise<void>,
    deploySessionId?: string,
  ): Promise<RunResult> => {
    const previousStatus = stackListState.stackStatuses[stackFile];
    const startedAt = Date.now();
    stackListState.setOptimisticStatus(stackFile, 'running');
    try {
      const path = ignorePolicy
        ? `/stacks/${stackName}/deploy?ignorePolicy=true`
        : `/stacks/${stackName}/deploy`;
      if (started) await started;
      const response = await apiFetch(path, withDeploySession(deploySessionId ?? '', { method: 'POST' }));
      if (!response.ok) {
        const rawBody = await response.text();
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
          const blockedBy = tryOpenPolicyBlock(rawBody, stackName, stackFile, 'deploy');
          if (blockedBy) {
            const message = `Deploy blocked by policy "${blockedBy}"`;
            toast.error(message);
            return { ok: false, errorMessage: message };
          }
        }
        throw parseStackActionError(rawBody, 'Deploy failed', response.status);
      }
      overlayState.setPolicyBlock(null);
      const healthGateId = await parseHealthGateId(response);
      // With a health gate observing, the operation finishing is not the
      // final verdict yet; soften the toast so success is not claimed twice.
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
    } catch (error) {
      console.error('Failed to deploy:', error);
      if (previousStatus !== undefined)
        stackListState.setOptimisticStatus(stackFile, previousStatus as 'running' | 'exited');
      const deployError = error as StackActionError;
      const errorMessage = deployError.message || 'Failed to deploy stack';
      toast.error(
        deployError.rolledBack === true
          ? `${errorMessage} - automatically rolled back to previous version.`
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
    if (!stackListState.selectedFile || stackListState.isStackBusy(stackListState.selectedFile))
      return;
    const stackFile = stackListState.selectedFile;
    const stackName = stackFile.replace(/\.(yml|yaml)$/, '');
    stackListState.setStackAction(stackFile, 'deploy');
    try {
      await runWithLog({ stackName, action: 'deploy' }, (started, ds) =>
        runDeploy(stackName, stackFile, false, started, ds),
      );
    } finally {
      stackListState.clearStackAction(stackFile);
      stackListState.refreshStacks(true);
    }
  };

  const handleSaveAndDeploy = async (e: React.MouseEvent) => {
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
    const { stackName, stackFile, action } = policyBlock;
    const existingFile = stackListState.files.includes(stackFile)
      ? stackFile
      : (stackListState.files.find(f => f.replace(/\.(yml|yaml)$/, '') === stackName) ?? stackFile);
    overlayState.setPolicyBypassing(true);
    try {
      if (action === 'update') {
        await runStackAction(existingFile, 'update', 'update', 'running', 'Stack updated successfully!', true);
      } else if (action === 'rollback') {
        await rollbackStack(true);
      } else {
        stackListState.setStackAction(existingFile, 'deploy');
        try {
          await runWithLog({ stackName, action: 'deploy' }, (started, ds) =>
            runDeploy(stackName, existingFile, true, started, ds),
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

  const rollbackStack = async (ignorePolicy = false) => {
    if (!stackListState.selectedFile || stackListState.isStackBusy(stackListState.selectedFile))
      return;
    const stackFile = stackListState.selectedFile;
    const stackName = stackFile.replace(/\.(yml|yaml)$/, '');
    const startedAt = Date.now();
    stackListState.setStackAction(stackFile, 'rollback');
    stackListState.setOptimisticStatus(stackFile, 'running');
    try {
      const path = ignorePolicy
        ? `/stacks/${stackFile}/rollback?ignorePolicy=true`
        : `/stacks/${stackFile}/rollback`;
      const res = await apiFetch(path, { method: 'POST' });
      if (!res.ok) {
        const rawBody = await res.text();
        if (res.status === 409) {
          const inProgress = parseStackOpInProgress(rawBody);
          if (inProgress) {
            const message = stackOpInProgressMessage(stackName, inProgress);
            toast.error(message);
            return;
          }
          const blockedBy = tryOpenPolicyBlock(rawBody, stackName, stackFile, 'rollback');
          if (blockedBy) {
            toast.error(`Rollback blocked by policy "${blockedBy}"`);
            return;
          }
        }
        throw parseStackActionError(rawBody, 'Rollback failed', res.status);
      }
      overlayState.setPolicyBlock(null);
      toast.success('Stack rolled back successfully.');
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
    editorState.setIsEditing(false);
  };

  const enterEditMode = () => {
    editorState.setIsEditing(true);
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
  ): Promise<void> => {
    if (stackListState.isStackBusy(stackFile)) return;
    const stackName = stackFile.replace(/\.(yml|yaml)$/, '');
    const previousStatus = stackListState.stackStatuses[stackFile];
    const startedAt = Date.now();
    stackListState.setStackAction(stackFile, action);
    stackListState.setOptimisticStatus(stackFile, optimisticStatus);
    try {
      await runWithLog({ stackName, action }, async (started, ds) => {
        await started;
        try {
          const url = ignorePolicy
            ? `/stacks/${stackName}/${endpoint}?ignorePolicy=true`
            : `/stacks/${stackName}/${endpoint}`;
          const response = await apiFetch(url, withDeploySession(ds, { method: 'POST' }));
          if (!response.ok) {
            const errText = await response.text();
            if (response.status === 409) {
              const inProgress = parseStackOpInProgress(errText);
              if (inProgress) {
                const message = stackOpInProgressMessage(stackName, inProgress);
                toast.error(message);
                return { ok: false as const, errorMessage: message };
              }
              if (action === 'update') {
                const blockedBy = tryOpenPolicyBlock(errText, stackName, stackFile, 'update');
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
          const healthGateId = await parseHealthGateId(response);
          // With a health gate observing, the operation finishing is not the
          // final verdict yet; soften the toast so success is not claimed twice.
          if (healthGateId && action === 'update') {
            toast.info('Stack updated. Verifying health...');
          } else {
            toast.success(successMessage);
          }
          if (action === 'update') stackListState.fetchImageUpdates();
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
    if (!stackListState.selectedFile) return;
    await runStackAction(stackListState.selectedFile, 'stop', 'stop', 'exited', 'Stack stopped successfully!');
  };

  const restartStack = async (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    if (!stackListState.selectedFile) return;
    await runStackAction(stackListState.selectedFile, 'restart', 'restart', 'running', 'Stack restarted successfully!');
  };

  const serviceAction = async (
    action: 'start' | 'stop' | 'restart',
    serviceName: string,
  ) => {
    if (!stackListState.selectedFile) return;
    const stackName = stackListState.selectedFile.replace(/\.(yml|yaml)$/, '');
    try {
      const r = await apiFetch(
        `/stacks/${stackName}/services/${encodeURIComponent(serviceName)}/${action}`,
        { method: 'POST' },
      );
      if (!r.ok) throw new Error((await r.text()) || `${action} failed`);
      const label =
        action === 'restart' ? 'restarted' : action === 'stop' ? 'stopped' : 'started';
      toast.success(`Service "${serviceName}" ${label}`);
      const cr = await apiFetch(`/stacks/${stackName}/containers`);
      const conts = await cr.json();
      editorState.setContainers(Array.isArray(conts) ? conts : []);
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
    const run = () => runStackAction(stackFile, 'update', 'update', 'running', 'Stack updated successfully!');
    if (hasUpdateGuard) {
      overlayState.setUpdateReadiness({
        stackName,
        stackFile,
        proceed: () => {
          overlayState.setUpdateReadiness(null);
          void run();
        },
      });
      return;
    }
    await run();
  };

  const updateStack = async (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    if (!stackListState.selectedFile) return;
    await requestStackUpdate(stackListState.selectedFile);
  };

  const deleteStack = async (pruneVolumes: boolean) => {
    const stackToDelete = overlayState.stackToDelete;
    if (!stackToDelete) return;
    const deleteKey =
      stackListState.files.find(
        f => f === stackToDelete || f.replace(/\.(yml|yaml)$/, '') === stackToDelete,
      ) ?? stackToDelete;
    if (stackListState.isStackBusy(deleteKey)) return;
    stackListState.setStackAction(deleteKey, 'delete');
    try {
      const url = pruneVolumes
        ? `/stacks/${stackToDelete}?pruneVolumes=true`
        : `/stacks/${stackToDelete}`;
      const response = await apiFetch(url, { method: 'DELETE' });
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(errText || 'Failed to delete stack');
      }
      toast.success('Stack deleted successfully!');
      overlayState.closeDeleteDialog();
      if (stackListState.selectedFile === stackToDelete) {
        resetEditorState();
      }
      await stackListState.refreshStacks();
    } catch (error) {
      console.error('Failed to delete stack:', error);
      toast.error((error as Error).message || 'Failed to delete stack');
    } finally {
      stackListState.clearStackAction(deleteKey);
    }
  };

  // Guard a navigation that would leave (and discard) a dirty editor: back to
  // the list, Home, or any bottom-tab / hamburger / command-palette
  // destination. When the editor is dirty the navigation is stashed and the
  // unsaved-changes dialog opens; discardAndLoadPending runs it on confirm.
  // When clean it runs immediately.
  const attemptLeaveEditor = (perform: () => void) => {
    if (stackListState.selectedFile && hasUnsavedChanges()) {
      overlayState.setPendingLeaveAction({ run: perform });
      return;
    }
    perform();
  };

  const cancelPendingUnsavedLoad = () => {
    overlayState.setPendingUnsavedLoad(null);
    overlayState.setPendingUnsavedNode(null);
    overlayState.setPendingLeaveAction(null);
  };

  const discardAndLoadPending = () => {
    const leave = overlayState.pendingLeaveAction;
    const target = overlayState.pendingUnsavedLoad;
    const targetNode = overlayState.pendingUnsavedNode;
    editorState.setContent(editorState.originalContent);
    editorState.setEnvContent(editorState.originalEnvContent);
    overlayState.setPendingUnsavedLoad(null);
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
      if (targetNode) void loadFileOnNode(targetNode, target);
      else void loadFile(target);
    }
  };

  const requestDeleteStack = () => {
    overlayState.openDeleteDialog(stackListState.selectedFile ?? '');
  };

  const executeStackActionByFile = async (
    stackFile: string,
    action: StackAction,
    endpoint: string,
  ) => {
    if (stackListState.isStackBusy(stackFile)) return;
    // Updates route through the shared update path so the sidebar gets the
    // readiness dialog, the deploy-feedback modal, and the same failure
    // handling as the toolbar.
    if (action === 'update') {
      await requestStackUpdate(stackFile);
      return;
    }
    const stackName = stackFile.replace(/\.(yml|yaml)$/, '');
    const startedAt = Date.now();
    stackListState.setStackAction(stackFile, action);

    if (action === 'stop') {
      stackListState.setOptimisticStatus(stackFile, 'exited');
    } else if (action === 'deploy' || action === 'restart') {
      stackListState.setOptimisticStatus(stackFile, 'running');
    }

    try {
      const response = await apiFetch(`/stacks/${stackName}/${endpoint}`, { method: 'POST' });
      if (!response.ok) {
        const errText = await response.text();
        if (response.status === 409) {
          const inProgress = parseStackOpInProgress(errText);
          if (inProgress) {
            toast.error(stackOpInProgressMessage(stackName, inProgress));
            return;
          }
          if (action === 'deploy') {
            const blockedBy = tryOpenPolicyBlock(errText, stackName, stackFile, action);
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
          ? `${msg} - automatically rolled back to previous version.`
          : msg,
      );
      recordActionFailureFor(stackFile, stackName, action, startedAt, msg, actionError.rolledBack === true, actionError.failure);
      await refreshSelectedContainers(stackName, stackFile);
    } finally {
      stackListState.clearStackAction(stackFile);
      stackListState.refreshStacks(true);
    }
  };

  const checkUpdatesForStack = async () => {
    try {
      const res = await apiFetch('/image-updates/refresh', { method: 'POST' });
      if (res.ok) {
        toast.success('Checking for image updates...');
        let elapsed = 0;
        const poll = setInterval(async () => {
          elapsed += 2000;
          try {
            const statusRes = await apiFetch('/image-updates/status');
            if (statusRes.ok) {
              const { checking } = await statusRes.json();
              if (!checking || elapsed >= 60000) {
                clearInterval(poll);
                checkUpdatesIntervalRef.current = null;
                await stackListState.fetchImageUpdates();
                if (!checking) toast.success('Image update check complete.');
              }
            }
          } catch {
            clearInterval(poll);
            checkUpdatesIntervalRef.current = null;
            await stackListState.fetchImageUpdates();
          }
        }, 2000);
        checkUpdatesIntervalRef.current = poll;
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || 'Failed to check for updates');
      }
    } catch {
      toast.error('Failed to check for updates');
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

  return {
    pendingStackLoadRef,
    pendingLogsRef,
    hasUnsavedChanges,
    getStackMenuVisibility,
    openStackApp,
    resetEditorState,
    refreshSelectedContainers,
    refreshGitSourcePending,
    loadFile,
    loadFileOnNode,
    navigateToNotification,
    changeEnvFile,
    saveFile,
    requestSave,
    requestSaveAndDeploy,
    handleSaveAndDeploy,
    rollbackStack,
    discardChanges,
    enterEditMode,
    scanStackConfig,
    runDeploy,
    deployStack,
    bypassPolicyAndRetry,
    stopStack,
    restartStack,
    serviceAction,
    updateStack,
    requestStackUpdate,
    deleteStack,
    attemptLeaveEditor,
    cancelPendingUnsavedLoad,
    discardAndLoadPending,
    requestDeleteStack,
    executeStackActionByFile,
    checkUpdatesForStack,
    getDisplayName,
    openBashModal,
    closeBashModal,
    openLogViewer,
    closeLogViewer,
  };
}

export type StackActionsHook = ReturnType<typeof useStackActions>;
