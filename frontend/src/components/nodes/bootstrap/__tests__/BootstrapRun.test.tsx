import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BOOTSTRAP_SCOPE } from '../scope';
import { BootstrapServerDialog } from '../BootstrapServerDialog';
import {
  FALLBACK_CAPABILITIES,
  cancelBootstrapOperation,
  checkBootstrapHostKey,
  fetchBootstrapCapabilities,
  fetchBootstrapOperation,
  listBootstrapOperations,
  releaseBootstrapOperation,
  retryBootstrapOperation,
  runBootstrapPreflight,
  startBootstrapOperation,
} from '../bootstrapApi';
import { operationAnswer, operationStages, operationStateWord } from '../operationStatus';
import { BootstrapRunStep } from '../BootstrapRunStep';
import { OPERATION_POLL_MS, READINESS_REFRESH_DELAY_MS, SETTLE_POLL_MS, useBootstrapOperation } from '../useBootstrapOperation';
import type {
  NodeReadiness,
  BootstrapHostKeyResult,
  BootstrapOperationDetail,
  BootstrapPlan,
  BootstrapPreflightResult,
} from '../types';

vi.mock('../bootstrapApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../bootstrapApi')>();
  return {
    ...actual,
    fetchBootstrapCapabilities: vi.fn(),
    checkBootstrapHostKey: vi.fn(),
    runBootstrapPreflight: vi.fn(),
    startBootstrapOperation: vi.fn(),
    retryBootstrapOperation: vi.fn(),
    fetchBootstrapOperation: vi.fn(),
    listBootstrapOperations: vi.fn(),
    cancelBootstrapOperation: vi.fn(),
    releaseBootstrapOperation: vi.fn(),
  };
});

const KEY: BootstrapHostKeyResult = {
  host: 'server.example.com',
  port: 22,
  address: '192.168.1.50',
  algorithm: 'ssh-ed25519',
  fingerprint: 'SHA256:trustedkey0000000000000000000000000000000',
  knownHostsLine: 'server.example.com ssh-ed25519 AAAA',
  trust: 'trusted',
  pinnedFingerprint: 'SHA256:trustedkey0000000000000000000000000000000',
};

const DIGEST = 'b'.repeat(64);

function step(id: string, title: string, command: string | null = `run ${id}`) {
  return {
    id, title, rationale: 'because', effect: 'file-write', privilege: 'sudo' as const, command,
    disruptive: false, reversible: 'yes', pointOfNoReturn: false, timeoutMs: 10_000,
  };
}

const PLAN: BootstrapPlan = {
  version: 1,
  generatedAt: 1_762_300_000_000,
  target: { host: 'server.example.com', port: 22, username: 'ubuntu', address: '192.168.1.50' },
  targetName: 'media-server',
  hostKeyFingerprint: KEY.fingerprint,
  hubUrl: 'https://sencho.example.com',
  paths: {
    composeDir: { input: '/opt/docker/sencho', realPath: '/opt/docker/sencho', exists: true, created: false, stackCount: 0 },
    agentDir: { input: '/opt/sencho-agent', realPath: null, exists: false, created: true },
  },
  projectName: 'sencho-agent',
  containerName: 'sencho-agent',
  dataVolume: 'sencho-agent-data',
  image: { ref: 'saelix/sencho:latest', digest: null, resolvedAt: 'execution' },
  stages: [
    { id: 'docker_packages', title: 'Docker packages', steps: [step('install-docker-packages', 'Install the missing Docker packages')] },
    { id: 'agent_dir', title: 'Pilot Agent installation directory', steps: [step('create-agent-dir', 'Create the Agent installation directory')] },
    { id: 'agent_project', title: 'Agent files', steps: [step('agent-compose-file', 'Write the Pilot compose file', null)] },
    { id: 'agent_start', title: 'Start the Pilot agent', steps: [step('start-agent', 'Start the sencho-agent project')] },
  ],
  skipped: [],
  sources: [],
  versions: {},
  redactions: [],
  verification: [],
  notices: [],
  evidenceDigest: 'e'.repeat(64),
  digest: DIGEST,
};

function preflightResult(plan: BootstrapPlan | null): BootstrapPreflightResult {
  return {
    inspection: {
      observedAt: Date.now(),
      target: PLAN.target,
      hostKey: { algorithm: KEY.algorithm, fingerprint: KEY.fingerprint, knownHostsLine: KEY.knownHostsLine },
      paths: {
        composeDir: {
          input: '/opt/docker/sencho', normalized: '/opt/docker/sencho', realPath: '/opt/docker/sencho', exists: true,
          isDirectory: true, isFinalSymlink: false, hasSymlinkAncestor: false, owner: 'ubuntu', group: 'ubuntu', mode: '755',
          readableByUser: true, writableByUser: true, writableBySudo: true, parentWritableByUser: true,
          nearestExistingAncestor: null, filesystem: { type: 'ext4', source: '/dev/sda1', mountPoint: '/' },
          freeBytes: 10 * 1024 ** 3, probeError: null, stackCount: 0, stackNames: [], inventoryTruncated: false,
          inventoryError: null, rootComposeFile: false,
        },
        agentDir: {
          input: '/opt/sencho-agent', normalized: '/opt/sencho-agent', realPath: '/opt/sencho-agent', exists: false,
          isDirectory: false, isFinalSymlink: false, hasSymlinkAncestor: false, owner: null, group: null, mode: null,
          readableByUser: false, writableByUser: false, writableBySudo: false, parentWritableByUser: true,
          nearestExistingAncestor: '/opt', filesystem: { type: 'ext4', source: '/dev/sda1', mountPoint: '/' },
          freeBytes: 10 * 1024 ** 3, probeError: null, entries: [], entriesTruncated: false, inventoryError: null,
          hasComposeFile: false, hasCaFile: false, hasMarker: false, markerProject: null, markerComposeDir: null, markerAgentDir: null,
        },
      },
      agent: { projectContainers: [], dataVolumeExists: false, dataVolumeNames: [], defaultDirHasComposeFile: false },
      dockerRoot: { path: '/var/lib/docker', freeBytes: 10 * 1024 ** 3, filesystemType: 'ext4' },
      checks: [],
      blockers: 0,
      warnings: 0,
    },
    plan,
    blocked: plan === null,
  };
}

function operation(overrides: Partial<BootstrapOperationDetail> = {}): BootstrapOperationDetail {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    targetName: 'media-server',
    host: 'server.example.com',
    port: 22,
    username: 'ubuntu',
    address: '192.168.1.50',
    hostKeyFingerprint: KEY.fingerprint,
    composeDir: '/opt/docker/sencho',
    agentDir: '/opt/sencho-agent',
    planDigest: DIGEST,
    approvedBy: 'admin',
    approvedAt: Date.now(),
    attempt: 1,
    state: 'running',
    stage: 'docker_packages',
    step: 'install-docker-packages',
    nodeId: null,
    changesMade: true,
    agentStarted: true,
    active: true,
    cancelRequested: false,
    error: null,
    enrollmentExpiresAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    finishedAt: null,
    actions: { cancel: true, retry: false, release: false, verify: false },
    readiness: null,
    plan: PLAN,
    events: [{ at: Date.now(), attempt: 1, stage: 'docker_packages', step: 'install-docker-packages', status: 'started', message: 'Install the missing Docker packages', detail: null }],
    ...overrides,
  };
}

const STOPPED = operation({
  state: 'partial',
  error: { code: 'STEP_FAILED', message: '"Install the missing Docker packages" failed (exit 100).' },
  actions: { cancel: false, retry: true, release: true, verify: false },
  finishedAt: Date.now(),
});

beforeEach(() => {
  vi.mocked(fetchBootstrapCapabilities).mockResolvedValue(FALLBACK_CAPABILITIES);
  vi.mocked(checkBootstrapHostKey).mockResolvedValue(KEY);
  vi.mocked(runBootstrapPreflight).mockResolvedValue(preflightResult(PLAN));
  vi.mocked(listBootstrapOperations).mockResolvedValue({ operations: [], nextCursor: null });
  vi.mocked(startBootstrapOperation).mockResolvedValue(operation({ state: 'rechecking', stage: null, step: null }));
  vi.mocked(retryBootstrapOperation).mockResolvedValue(operation({ state: 'rechecking', stage: null, step: null, attempt: 2 }));
  vi.mocked(fetchBootstrapOperation).mockResolvedValue(operation());
  vi.mocked(cancelBootstrapOperation).mockResolvedValue(operation({ cancelRequested: true, actions: { cancel: false, retry: false, release: false, verify: false } }));
  vi.mocked(releaseBootstrapOperation).mockResolvedValue({ ...STOPPED, active: false, actions: { cancel: false, retry: false, release: false, verify: false } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function reachPlan() {
  const user = userEvent.setup();
  render(<BootstrapServerDialog open onOpenChange={() => {}} />);
  await user.type(screen.getByLabelText('Node name'), 'media-server');
  await user.type(screen.getByLabelText('Host'), 'server.example.com');
  await user.type(screen.getByLabelText('Private key'), '-----BEGIN OPENSSH PRIVATE KEY-----key');
  await user.click(screen.getByRole('button', { name: 'Check host key' }));
  await user.click(await screen.findByRole('button', { name: 'Run preflight' }));
  await screen.findByRole('button', { name: 'Approve and run' });
  return user;
}

describe('operation status mapping', () => {
  it('speaks for the running step and keeps later phases pending', () => {
    const op = operation();
    expect(operationAnswer(op)).toMatchObject({ tone: 'brand', title: 'Running', line: 'Running: Install the missing Docker packages.' });
    expect(operationStages(op).map((stage) => [stage.id, stage.word])).toEqual([
      ['recheck', 'done'], ['docker', 'running'], ['files', 'pending'], ['start', 'pending'], ['enroll', 'pending'], ['verify', 'pending'],
    ]);
  });

  it('omits the Docker phase when the plan has no Docker stage', () => {
    const op = operation({ plan: { ...PLAN, stages: PLAN.stages.slice(1) }, stage: 'agent_dir' });
    expect(operationStages(op).map((stage) => stage.id)).toEqual(['recheck', 'files', 'start', 'enroll', 'verify']);
  });

  it('says an enrolled node is not verified yet, and a stopped run that changed things undid nothing', () => {
    const enrolled = operation({ state: 'enrolled', stage: 'enroll', readiness: readiness('provisional') });
    expect(operationAnswer(enrolled)).toMatchObject({ title: 'Unverified', status: 'provisional' });
    expect(operationAnswer(enrolled).line).toContain('checks it for readiness once its tunnel is up');
    const stages = operationStages(enrolled);
    expect(stages.filter((stage) => stage.id !== 'verify').every((stage) => stage.tone === 'success')).toBe(true);
    expect(stages.find((stage) => stage.id === 'verify')).toMatchObject({ word: 'pending', tone: 'neutral' });
    expect(operationAnswer(STOPPED)).toMatchObject({ tone: 'warning', title: 'Stopped partway', detail: 'Steps that ran stay on the host. Nothing was undone.' });
    expect(operationStages(STOPPED).find((stage) => stage.id === 'docker')).toMatchObject({ word: 'stopped', tone: 'warning' });
    expect(operationStages(STOPPED).find((stage) => stage.id === 'enroll')?.word).toBe('not run');
  });
});

function readiness(state: NodeReadiness['state'], gates: NodeReadiness['gates'] = []): NodeReadiness {
  return { state, operationId: 'op-1', checkedAt: state === 'provisional' ? null : Date.now(), agentVersion: state === 'provisional' ? null : '0.98.2', gates };
}

describe('readiness of an enrolled run', () => {
  const FAILED_GATES: NodeReadiness['gates'] = [
    { id: 'tunnel', label: 'Pilot tunnel', status: 'pass', summary: 'Connected.' },
    { id: 'docker_compose', label: 'Docker Compose', status: 'unknown', summary: 'The Pilot did not report this check.', remediation: 'Install the Docker Compose v2 plugin.' },
    { id: 'compose_dir', label: 'Compose directory', status: 'fail', summary: 'The Pilot manages /srv/other.', remediation: 'Set COMPOSE_DIR in the sencho-agent project.' },
  ];

  it('never reads a connected tunnel as ready: only a passed check does', () => {
    const verifying = operation({ state: 'enrolled', stage: 'enroll', readiness: readiness('verifying') });
    expect(operationAnswer(verifying)).toMatchObject({ tone: 'brand', title: 'Verifying', status: 'verifying' });
    expect(operationStages(verifying).find((stage) => stage.id === 'verify')).toMatchObject({ word: 'checking', tone: 'brand' });
    const ready = operation({ state: 'enrolled', stage: 'enroll', readiness: readiness('ready') });
    expect(operationAnswer(ready)).toMatchObject({ tone: 'success', title: 'Ready', status: 'ready' });
    expect(operationAnswer(ready).line).toContain('ready for deployments');
    expect(operationStages(ready).every((stage) => stage.tone === 'success')).toBe(true);
  });

  it('leads a failed check with the first failed gate and its remediation', () => {
    const op = operation({ state: 'enrolled', stage: 'enroll', readiness: readiness('not_ready', FAILED_GATES) });
    expect(operationAnswer(op)).toMatchObject({
      tone: 'warning',
      title: 'Not ready',
      line: 'Compose directory: The Pilot manages /srv/other.',
      detail: 'Set COMPOSE_DIR in the sencho-agent project. 1 more check failed.',
    });
    expect(operationStages(op).find((stage) => stage.id === 'verify')).toMatchObject({ word: 'unverified', tone: 'warning' });
    expect(operationStateWord(op)).toEqual({ tone: 'warning', word: 'Unverified' });
  });

  it('titles a Pilot that could not be reached as not connected, and names warnings on a ready node', () => {
    const offline = operation({ state: 'enrolled', stage: 'enroll', readiness: readiness('not_ready', [
      { id: 'tunnel', label: 'Pilot tunnel', status: 'fail', summary: 'The Pilot is not connected to the hub.', remediation: 'Check the sencho-agent container.' },
    ]) });
    expect(operationAnswer(offline)).toMatchObject({ title: 'Not connected', line: 'Pilot tunnel: The Pilot is not connected to the hub.' });
    const timedOut = operation({ state: 'enrolled', stage: 'enroll', readiness: readiness('not_ready', [
      { id: 'tunnel', label: 'Pilot tunnel', status: 'unknown', summary: 'The readiness request did not complete: the Pilot answered HTTP 500.', remediation: 'Check the hub logs.' },
    ]) });
    expect(operationAnswer(timedOut).title).toBe('Not ready');
    const warned = operation({ state: 'enrolled', stage: 'enroll', readiness: readiness('ready', [
      { id: 'tunnel', label: 'Pilot tunnel', status: 'pass', summary: 'Connected.' },
      { id: 'transport', label: 'Tunnel transport', status: 'warn', summary: 'Plain HTTP.', remediation: 'Serve the hub over HTTPS.' },
    ]) });
    expect(operationAnswer(warned).line).toMatch(/passed the readiness check.*, with 1 warning\. It is ready for deployments\./);
  });

  it('does not show the previous check\'s gates while a new check is pending', async () => {
    const op = operation({
      state: 'enrolled', stage: 'enroll', active: false, finishedAt: Date.now(),
      readiness: readiness('verifying', FAILED_GATES),
      actions: { cancel: false, retry: false, release: false, verify: false },
    });
    const user = userEvent.setup();
    render(<BootstrapRunStep operation={op} busy={null} onCancel={vi.fn()} onRetry={vi.fn()} onRelease={vi.fn()} onVerify={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Activity/ }));
    expect(screen.queryAllByTestId('bootstrap-readiness-gate')).toHaveLength(0);
  });

  it('says so when this run no longer speaks for the node', () => {
    const op = operation({ state: 'enrolled', stage: 'enroll', readiness: null });
    expect(operationAnswer(op)).toMatchObject({ tone: 'neutral', title: 'Enrolled' });
    expect(operationStages(op).find((stage) => stage.id === 'verify')).toMatchObject({ word: 'not recorded' });
  });

  it('shows each gate with its remediation and verifies again from the Answer', async () => {
    const onVerify = vi.fn();
    const op = operation({
      state: 'enrolled', stage: 'enroll', active: false, finishedAt: Date.now(),
      readiness: readiness('not_ready', FAILED_GATES),
      actions: { cancel: false, retry: false, release: false, verify: true },
    });
    const user = userEvent.setup();
    render(<BootstrapRunStep operation={op} busy={null} onCancel={vi.fn()} onRetry={vi.fn()} onRelease={vi.fn()} onVerify={onVerify} />);
    await user.click(screen.getByRole('button', { name: 'Verify again' }));
    expect(onVerify).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: /Activity/ }));
    const gates = screen.getAllByTestId('bootstrap-readiness-gate');
    expect(gates.map((gate) => gate.getAttribute('data-state'))).toEqual(['pass', 'unknown', 'fail']);
    expect(gates[2]).toHaveTextContent('Set COMPOSE_DIR in the sencho-agent project.');
    expect(gates[0]).not.toHaveTextContent('Install');
  });

  it('offers Verify now before the first check, and no verb while one runs', () => {
    const provisional = operation({ state: 'enrolled', stage: 'enroll', readiness: readiness('provisional'), actions: { cancel: false, retry: false, release: false, verify: true } });
    const { rerender } = render(<BootstrapRunStep operation={provisional} busy={null} onCancel={vi.fn()} onRetry={vi.fn()} onRelease={vi.fn()} onVerify={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Verify now' })).toBeInTheDocument();
    const verifying = { ...provisional, readiness: readiness('verifying'), actions: { ...provisional.actions, verify: false } };
    rerender(<BootstrapRunStep operation={verifying} busy={null} onCancel={vi.fn()} onRetry={vi.fn()} onRelease={vi.fn()} onVerify={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Verify/ })).not.toBeInTheDocument();
  });
});

describe('approving a plan', () => {
  it('takes two clicks, names the digest, and sends the reviewed digest with the key', async () => {
    const user = await reachPlan();
    await user.click(screen.getByRole('button', { name: 'Approve and run' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText(`Plan sha256:${DIGEST}`)).toBeInTheDocument();
    expect(within(confirm).getByText(/CHANGES server\.example\.com/)).toBeInTheDocument();
    expect(within(confirm).getByTestId('bootstrap-approve-scope')).toHaveTextContent(BOOTSTRAP_SCOPE);
    expect(startBootstrapOperation).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole('button', { name: 'Approve and run' }));

    await waitFor(() => expect(startBootstrapOperation).toHaveBeenCalledTimes(1));
    expect(vi.mocked(startBootstrapOperation).mock.calls[0][0]).toMatchObject({
      host: 'server.example.com',
      planDigest: DIGEST,
      expectedFingerprint: KEY.fingerprint,
      privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----key',
      targetName: 'media-server',
    });
    expect(await screen.findByTestId('bootstrap-run-answer')).toHaveTextContent('Re-checking');
    expect(screen.getByText('The run continues on the hub after you close this window.')).toBeInTheDocument();
  });

  it('keeps the plan on screen with the reason when the hub refuses the approval', async () => {
    const { BootstrapApiError } = await import('../bootstrapApi');
    vi.mocked(startBootstrapOperation).mockRejectedValueOnce(new BootstrapApiError('This plan is no longer current. Run the preflight again and review the new plan.', 'PLAN_NOT_CURRENT', null));
    const user = await reachPlan();
    await user.click(screen.getByRole('button', { name: 'Approve and run' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Approve and run' }));
    expect(await screen.findByText(/no longer current/)).toBeInTheDocument();
    expect(screen.queryByTestId('bootstrap-run-answer')).not.toBeInTheDocument();
  });
});

describe('coming back to a run', () => {
  it('lists runs on open, follows one, and offers the verbs the hub allows', async () => {
    vi.mocked(listBootstrapOperations).mockResolvedValue({ operations: [STOPPED], nextCursor: null });
    vi.mocked(fetchBootstrapOperation).mockResolvedValue(STOPPED);
    const user = userEvent.setup();
    render(<BootstrapServerDialog open onOpenChange={() => {}} />);
    const row = await screen.findByTestId(`bootstrap-run-${STOPPED.id}`);
    expect(row).toHaveTextContent('Stopped partway');
    await user.click(within(row).getByRole('button', { name: 'View' }));

    const answer = await screen.findByTestId('bootstrap-run-answer');
    expect(answer).toHaveTextContent('failed (exit 100)');
    expect(within(answer).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(within(answer).queryByRole('button', { name: 'Cancel run' })).not.toBeInTheDocument();

    await user.click(within(answer).getByRole('button', { name: 'Release server' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent(/Nothing is removed/);
    await user.click(within(confirm).getByRole('button', { name: 'Release server' }));
    await waitFor(() => expect(releaseBootstrapOperation).toHaveBeenCalledWith(STOPPED.id));
  });

  it('retries with the server and directories filled in and the key entered again', async () => {
    vi.mocked(listBootstrapOperations).mockResolvedValue({ operations: [STOPPED], nextCursor: null });
    const user = userEvent.setup();
    render(<BootstrapServerDialog open onOpenChange={() => {}} />);
    await user.click(within(await screen.findByTestId(`bootstrap-run-${STOPPED.id}`)).getByRole('button', { name: 'Retry' }));

    expect(screen.getByTestId('bootstrap-retry-banner')).toHaveTextContent('Retrying media-server on server.example.com');
    expect(screen.getByLabelText('Host')).toHaveValue('server.example.com');
    expect(screen.getByLabelText('Node name')).toHaveValue('media-server');
    expect(screen.getByLabelText('Private key')).toHaveValue('');

    await user.type(screen.getByLabelText('Private key'), '-----BEGIN OPENSSH PRIVATE KEY-----again');
    await user.click(screen.getByRole('button', { name: 'Check host key' }));
    await user.click(await screen.findByRole('button', { name: 'Run preflight' }));
    await waitFor(() => expect(runBootstrapPreflight).toHaveBeenCalledWith(expect.objectContaining({ operationId: STOPPED.id }), expect.anything()));
    await user.click(await screen.findByRole('button', { name: 'Approve and retry' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Approve and retry' }));
    await waitFor(() => expect(retryBootstrapOperation).toHaveBeenCalledWith(STOPPED.id, expect.objectContaining({ planDigest: DIGEST })));
    expect(startBootstrapOperation).not.toHaveBeenCalled();
  });
});

describe('progress polling', () => {
  it('polls a running operation every two seconds and stops once it has stopped', async () => {
    vi.useFakeTimers();
    vi.mocked(fetchBootstrapOperation)
      .mockResolvedValueOnce(operation({ step: 'create-agent-dir', stage: 'agent_dir' }))
      .mockResolvedValueOnce({ ...STOPPED });
    const { result } = renderHook(() => useBootstrapOperation({ open: true }));
    act(() => result.current.show(operation()));
    expect(fetchBootstrapOperation).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(OPERATION_POLL_MS); });
    expect(fetchBootstrapOperation).toHaveBeenCalledTimes(1);
    expect(result.current.operation?.step).toBe('create-agent-dir');

    await act(async () => { await vi.advanceTimersByTimeAsync(OPERATION_POLL_MS); });
    expect(fetchBootstrapOperation).toHaveBeenCalledTimes(2);
    expect(result.current.operation?.state).toBe('partial');

    await act(async () => { await vi.advanceTimersByTimeAsync(OPERATION_POLL_MS * 5); });
    expect(fetchBootstrapOperation).toHaveBeenCalledTimes(2);
  });

  it.each(['partial', 'outcome_unknown', 'cancelled'] as const)('keeps reading a run stopped as %s until a late Pilot settles it, then stops', async (state) => {
    vi.useFakeTimers();
    const stopped = { ...STOPPED, state, nodeId: 4 };
    vi.mocked(fetchBootstrapOperation)
      .mockResolvedValueOnce({ ...stopped })
      .mockResolvedValueOnce({ ...stopped, state: 'enrolled', active: false, error: null, actions: { cancel: false, retry: false, release: false, verify: false } });
    const { result } = renderHook(() => useBootstrapOperation({ open: true }));
    act(() => result.current.show(stopped));
    expect(result.current.settling).toBe(true);

    await act(async () => { await vi.advanceTimersByTimeAsync(SETTLE_POLL_MS); });
    expect(fetchBootstrapOperation).toHaveBeenCalledTimes(1);
    expect(result.current.operation?.state).toBe(state);
    await act(async () => { await vi.advanceTimersByTimeAsync(SETTLE_POLL_MS); });
    expect(fetchBootstrapOperation).toHaveBeenCalledTimes(2);
    expect(result.current.operation).toMatchObject({ state: 'enrolled', actions: { retry: false, release: false } });
    expect(result.current.settling).toBe(false);

    await act(async () => { await vi.advanceTimersByTimeAsync(SETTLE_POLL_MS * 5); });
    expect(fetchBootstrapOperation).toHaveBeenCalledTimes(2);
  });

  it('keeps reading an enrolled run until the readiness verdict lands, then stops', async () => {
    vi.useFakeTimers();
    const pending = operation({ state: 'enrolled', stage: 'enroll', active: false, nodeId: 4, readiness: readiness('verifying') });
    vi.mocked(fetchBootstrapOperation)
      .mockResolvedValueOnce({ ...pending })
      .mockResolvedValueOnce({ ...pending, readiness: readiness('not_ready', [{ id: 'docker_compose', label: 'Docker Compose', status: 'fail', summary: 'Compose v2 is missing.', remediation: 'Install it.' }]) });
    const { result } = renderHook(() => useBootstrapOperation({ open: true }));
    act(() => result.current.show(pending));

    await act(async () => { await vi.advanceTimersByTimeAsync(SETTLE_POLL_MS); });
    expect(fetchBootstrapOperation).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(SETTLE_POLL_MS); });
    expect(fetchBootstrapOperation).toHaveBeenCalledTimes(2);
    expect(result.current.operation?.readiness?.state).toBe('not_ready');

    await act(async () => { await vi.advanceTimersByTimeAsync(SETTLE_POLL_MS * 5); });
    expect(fetchBootstrapOperation).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a failed run', { state: 'failed' as const, nodeId: 4 }],
    ['a blocked run', { state: 'blocked' as const, nodeId: 4 }],
    ['a run that needs recovery', { state: 'recovery_required' as const, nodeId: 4 }],
    ['a stopped run with no node to connect', { state: 'partial' as const, nodeId: null }],
    ['a stopped run whose Pilot was never started', { state: 'partial' as const, nodeId: 4, agentStarted: false }],
    ['a stopped run that was released', { state: 'partial' as const, nodeId: 4, active: false }],
  ])('does not poll %s: the hub cannot settle it on a read', async (_label, overrides) => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useBootstrapOperation({ open: true }));
    act(() => result.current.show({ ...STOPPED, ...overrides }));
    await act(async () => { await vi.advanceTimersByTimeAsync(SETTLE_POLL_MS * 4); });
    expect(fetchBootstrapOperation).not.toHaveBeenCalled();
    expect(result.current.settling).toBe(false);
  });

  it('drops a read that began before the operator retried, so it cannot put the stopped state back', async () => {
    vi.useFakeTimers();
    const stopped = { ...STOPPED, nodeId: 4 };
    let answer: (detail: BootstrapOperationDetail) => void = () => {};
    vi.mocked(fetchBootstrapOperation).mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const { result } = renderHook(() => useBootstrapOperation({ open: true }));
    act(() => result.current.show(stopped));
    await act(async () => { await vi.advanceTimersByTimeAsync(SETTLE_POLL_MS); });
    expect(fetchBootstrapOperation).toHaveBeenCalledTimes(1);

    // The retry is shown while the read is in flight; the read then answers with the old stopped run.
    act(() => result.current.show({ ...stopped, state: 'rechecking', attempt: 2, actions: { cancel: true, retry: false, release: false, verify: false } }));
    await act(async () => { answer({ ...stopped }); });
    expect(result.current.operation).toMatchObject({ state: 'rechecking', attempt: 2 });
  });

  it('drops a read that began before Release, so Release does not reappear', async () => {
    vi.useFakeTimers();
    const stopped = { ...STOPPED, nodeId: 4 };
    let answer: (detail: BootstrapOperationDetail) => void = () => {};
    vi.mocked(fetchBootstrapOperation).mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    vi.mocked(releaseBootstrapOperation).mockResolvedValueOnce({ ...stopped, active: false, actions: { cancel: false, retry: false, release: false, verify: false } });
    const { result } = renderHook(() => useBootstrapOperation({ open: true }));
    act(() => result.current.show(stopped));
    await act(async () => { await vi.advanceTimersByTimeAsync(SETTLE_POLL_MS); });
    await act(async () => { await result.current.release(); });
    await act(async () => { answer({ ...stopped }); });
    expect(result.current.operation).toMatchObject({ active: false, actions: { release: false } });
  });

  it('reads the list again while a listed stopped run may still be settled, and stops once none may', async () => {
    vi.useFakeTimers();
    const listed = { ...STOPPED, nodeId: 4 };
    vi.mocked(listBootstrapOperations)
      .mockResolvedValueOnce({ operations: [listed], nextCursor: null })
      .mockResolvedValueOnce({ operations: [{ ...listed, state: 'enrolled', active: false, actions: { cancel: false, retry: false, release: false, verify: false } }], nextCursor: null });
    const { result } = renderHook(() => useBootstrapOperation({ open: true }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.operations[0].state).toBe('partial');
    await act(async () => { await vi.advanceTimersByTimeAsync(SETTLE_POLL_MS); });
    expect(listBootstrapOperations).toHaveBeenCalledTimes(2);
    expect(result.current.operations[0]).toMatchObject({ state: 'enrolled', actions: { retry: false } });
    await act(async () => { await vi.advanceTimersByTimeAsync(SETTLE_POLL_MS * 5); });
    expect(listBootstrapOperations).toHaveBeenCalledTimes(2);
  });

  it('keeps the pages "Show more" added when the settle read replaces the first page, and reads their settleable rows', async () => {
    vi.useFakeTimers();
    const row = (id: string, extra: Partial<BootstrapOperationDetail> = {}) => ({ ...STOPPED, id, nodeId: 4, targetName: id, ...extra });
    const first = [row('first-1'), row('first-2')];
    const second = [row('second-1')];
    vi.mocked(listBootstrapOperations)
      .mockResolvedValueOnce({ operations: first, nextCursor: 'c1' })
      .mockResolvedValueOnce({ operations: second, nextCursor: null })
      // The settle read: page one changed (first-1 enrolled), and it still names a further page.
      .mockResolvedValueOnce({ operations: [row('first-1', { state: 'enrolled', active: false }), first[1]], nextCursor: 'c1' });
    vi.mocked(fetchBootstrapOperation).mockResolvedValue(row('second-1', { state: 'enrolled', active: false }));
    const { result } = renderHook(() => useBootstrapOperation({ open: true }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await result.current.loadMore(); });
    expect(result.current.operations.map((entry) => entry.id)).toEqual(['first-1', 'first-2', 'second-1']);

    await act(async () => { await vi.advanceTimersByTimeAsync(SETTLE_POLL_MS); });
    expect(result.current.operations.map((entry) => `${entry.id}:${entry.state}`)).toEqual(['first-1:enrolled', 'first-2:partial', 'second-1:enrolled']);
    expect(fetchBootstrapOperation).toHaveBeenCalledWith('second-1', expect.anything());
    // The settle read did not touch the cursor of the pages already loaded.
    expect(result.current.hasMoreOperations).toBe(false);
  });

  it('does not lose the first page "Show more" is loading when a settle tick lands meanwhile', async () => {
    vi.useFakeTimers();
    const row = (id: string) => ({ ...STOPPED, id, nodeId: 4, targetName: id });
    let answerPage: (page: { operations: BootstrapOperationDetail[]; nextCursor: string | null }) => void = () => {};
    vi.mocked(listBootstrapOperations)
      .mockResolvedValueOnce({ operations: [row('a'), row('b')], nextCursor: 'c1' })
      .mockImplementationOnce(() => new Promise((resolve) => { answerPage = resolve; }))
      .mockResolvedValue({ operations: [row('a'), row('b')], nextCursor: 'c1' });
    const { result } = renderHook(() => useBootstrapOperation({ open: true }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    // "Show more" is asked for; its answer is still on the way when the settle tick reads the first page.
    let loading: Promise<void> = Promise.resolve();
    await act(async () => { loading = result.current.loadMore(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(SETTLE_POLL_MS); });
    await act(async () => { answerPage({ operations: [row('c')], nextCursor: null }); await loading; });
    expect(result.current.operations.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
    expect(result.current.hasMoreOperations).toBe(false);
  });

  it('keeps a run a newer hold pushed off the first page, and drops one that stopped holding its server', async () => {
    vi.useFakeTimers();
    // None of these can settle (no Pilot was started), so only having been on page one makes the hook read them.
    const row = (id: string, extra: Partial<BootstrapOperationDetail> = {}) => ({ ...STOPPED, id, nodeId: 4, agentStarted: true, targetName: id, ...extra });
    const held = (id: string) => row(id, { agentStarted: false });
    vi.mocked(listBootstrapOperations)
      .mockResolvedValueOnce({ operations: [row('a'), row('b', { agentStarted: false })], nextCursor: 'c1' })
      .mockResolvedValueOnce({ operations: [held('c')], nextCursor: null })
      // Two new holds push a and b off page one, and a was released meanwhile.
      .mockResolvedValueOnce({ operations: [held('n'), held('m')], nextCursor: 'c1' });
    vi.mocked(fetchBootstrapOperation).mockImplementation(async (id: string) => (id === 'a' ? row('a', { active: false }) : held(id)));
    const { result } = renderHook(() => useBootstrapOperation({ open: true }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await result.current.loadMore(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(SETTLE_POLL_MS); });
    expect(result.current.operations.map((entry) => entry.id)).toEqual(['n', 'm', 'b', 'c']);
  });

  it('does not read the list while a run is open', async () => {
    vi.useFakeTimers();
    const listed = { ...STOPPED, nodeId: 4 };
    vi.mocked(listBootstrapOperations).mockResolvedValue({ operations: [listed], nextCursor: null });
    vi.mocked(fetchBootstrapOperation).mockResolvedValue({ ...listed });
    const { result } = renderHook(() => useBootstrapOperation({ open: true }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    act(() => result.current.show({ ...listed }));
    vi.mocked(listBootstrapOperations).mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(SETTLE_POLL_MS * 3); });
    expect(listBootstrapOperations).not.toHaveBeenCalled();
    expect(fetchBootstrapOperation).toHaveBeenCalled();
  });

  it('keeps the stopped state on screen through failed settle reads, marks it stale, and stops on a run that is gone', async () => {
    vi.useFakeTimers();
    const { BootstrapApiError } = await import('../bootstrapApi');
    const stopped = { ...STOPPED, nodeId: 4 };
    vi.mocked(fetchBootstrapOperation).mockRejectedValue(new Error('hub unreachable'));
    const { result } = renderHook(() => useBootstrapOperation({ open: true }));
    act(() => result.current.show(stopped));
    for (let tick = 0; tick < 3; tick += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(SETTLE_POLL_MS); });
    }
    expect(fetchBootstrapOperation).toHaveBeenCalledTimes(3);
    expect(result.current.progressStale).toBe(true);
    expect(result.current.operation?.state).toBe('partial');

    vi.mocked(fetchBootstrapOperation).mockReset();
    vi.mocked(fetchBootstrapOperation).mockRejectedValue(new BootstrapApiError('Bootstrap operation not found.', 'OPERATION_NOT_FOUND', null));
    act(() => result.current.show({ ...stopped, id: '33333333-3333-4333-8333-333333333333' }));
    for (let tick = 0; tick < 4; tick += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(SETTLE_POLL_MS); });
    }
    expect(fetchBootstrapOperation).toHaveBeenCalledTimes(1);
    expect(result.current.progressStale).toBe(true);
  });

  it('keeps polling through a step that changes nothing, and never polls while closed', async () => {
    vi.useFakeTimers();
    const same = operation();
    vi.mocked(fetchBootstrapOperation).mockResolvedValue(same);
    const { result, rerender } = renderHook(({ open }) => useBootstrapOperation({ open }), { initialProps: { open: true } });
    act(() => result.current.show(same));
    // One tick per act: React re-arms the timer when each act settles.
    for (let tick = 0; tick < 3; tick += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(OPERATION_POLL_MS); });
    }
    expect(fetchBootstrapOperation).toHaveBeenCalledTimes(3);

    rerender({ open: false });
    for (let tick = 0; tick < 3; tick += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(OPERATION_POLL_MS); });
    }
    expect(fetchBootstrapOperation).toHaveBeenCalledTimes(3);
  });
});

describe('readiness announcements reach the open dialog', () => {
  const NO_ACTIONS = { cancel: false, retry: false, release: false, verify: false };
  const enrolled = (state: NodeReadiness['state'], extra: Partial<BootstrapOperationDetail> = {}) => operation({
    state: 'enrolled', stage: 'enroll', active: false, nodeId: 4, finishedAt: Date.now(), actions: NO_ACTIONS, readiness: readiness(state), ...extra,
  });
  const announce = (scope = 'node-readiness') => act(() => { window.dispatchEvent(new CustomEvent('sencho:state-invalidate', { detail: { scope, nodeId: 4 } })); });
  const settle = async (ms = READINESS_REFRESH_DELAY_MS) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
  const NOT_READY_GATES: NodeReadiness['gates'] = [{ id: 'docker_daemon', label: 'Docker engine', status: 'fail', summary: 'Permission denied.', remediation: 'Fix the socket.' }];

  it('stops calling a node ready when the hub announces it is no longer', async () => {
    vi.useFakeTimers();
    const ready = enrolled('ready');
    const { result } = renderHook(() => useBootstrapOperation({ open: true }));
    act(() => result.current.show(ready));
    // A ready run is not polled: nothing but the announcement can tell the dialog the node left that state.
    await settle(SETTLE_POLL_MS * 3);
    expect(fetchBootstrapOperation).not.toHaveBeenCalled();

    vi.mocked(fetchBootstrapOperation).mockResolvedValueOnce(enrolled('not_ready', { readiness: readiness('not_ready', NOT_READY_GATES) }));
    announce();
    await settle();
    expect(fetchBootstrapOperation).toHaveBeenCalledTimes(1);
    expect(result.current.operation?.readiness?.state).toBe('not_ready');
    expect(operationAnswer(result.current.operation as BootstrapOperationDetail)).toMatchObject({ title: 'Not ready', line: 'Docker engine: Permission denied.' });
  });

  it('follows a node that went back to unverified until its new verdict lands', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useBootstrapOperation({ open: true }));
    act(() => result.current.show(enrolled('ready')));
    vi.mocked(fetchBootstrapOperation)
      .mockResolvedValueOnce(enrolled('provisional'))
      .mockResolvedValueOnce(enrolled('verifying'))
      .mockResolvedValueOnce(enrolled('ready'));
    announce();
    await settle();
    expect(result.current.operation?.readiness?.state).toBe('provisional');
    await settle(SETTLE_POLL_MS);
    expect(result.current.operation?.readiness?.state).toBe('verifying');
    await settle(SETTLE_POLL_MS);
    expect(result.current.operation?.readiness?.state).toBe('ready');
    await settle(SETTLE_POLL_MS * 3);
    expect(fetchBootstrapOperation).toHaveBeenCalledTimes(3);
  });

  it('shows a not ready run as ready when the hub announces the node passed a new check', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useBootstrapOperation({ open: true }));
    act(() => result.current.show(enrolled('not_ready', { readiness: readiness('not_ready', NOT_READY_GATES) })));
    vi.mocked(fetchBootstrapOperation).mockResolvedValueOnce(enrolled('ready'));
    announce();
    await settle();
    expect(operationAnswer(result.current.operation as BootstrapOperationDetail)).toMatchObject({ title: 'Ready' });
  });

  it('reads once for a burst of announcements, and not at all for another kind of announcement or a closed dialog', async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ open }) => useBootstrapOperation({ open }), { initialProps: { open: true } });
    act(() => result.current.show(enrolled('ready')));
    vi.mocked(fetchBootstrapOperation).mockResolvedValue(enrolled('ready'));
    announce('gitops');
    announce('node-readiness');
    announce('node-readiness');
    announce('node-readiness');
    await settle();
    expect(fetchBootstrapOperation).toHaveBeenCalledTimes(1);

    rerender({ open: false });
    announce();
    await settle(SETTLE_POLL_MS);
    expect(fetchBootstrapOperation).toHaveBeenCalledTimes(1);
  });

  it('adds no read for a run that is not enrolled, and reads an enrolled one once for an announcement that changes nothing on screen', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useBootstrapOperation({ open: true }));
    act(() => result.current.show({ ...STOPPED, nodeId: 4 }));
    vi.mocked(fetchBootstrapOperation).mockClear();
    announce();
    await settle();
    // A stopped run that may still settle is polled on its own; the announcement adds no read of its own.
    expect(fetchBootstrapOperation).not.toHaveBeenCalled();

    const ready = enrolled('ready', { nodeId: 9 });
    act(() => result.current.show(ready));
    vi.mocked(fetchBootstrapOperation).mockResolvedValue({ ...ready });
    announce();
    await settle();
    expect(fetchBootstrapOperation).toHaveBeenCalledTimes(1);
    expect(result.current.operation).toMatchObject({ nodeId: 9, readiness: { state: 'ready' } });
  });

  it('reads the shown run again when the notification socket comes back, because announcements sent while it was down are lost', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useBootstrapOperation({ open: true }));
    act(() => result.current.show(enrolled('ready')));
    const connection = (connected: boolean) => act(() => { window.dispatchEvent(new CustomEvent('sencho:notifications-connection', { detail: { connected } })); });
    // A first connection, or one that never dropped, is not a reconnect.
    connection(true);
    await settle();
    expect(fetchBootstrapOperation).not.toHaveBeenCalled();

    vi.mocked(fetchBootstrapOperation).mockResolvedValueOnce(enrolled('provisional'));
    connection(false);
    connection(true);
    await settle(0);
    expect(fetchBootstrapOperation).toHaveBeenCalledTimes(1);
    expect(result.current.operation?.readiness?.state).toBe('provisional');
  });

  it('drops an older read that answers after a newer one, so it cannot bring an earlier verdict back', async () => {
    vi.useFakeTimers();
    const verifying = enrolled('verifying');
    const answers: Array<(detail: BootstrapOperationDetail) => void> = [];
    vi.mocked(fetchBootstrapOperation).mockImplementation(() => new Promise((resolve) => { answers.push(resolve); }));
    const { result } = renderHook(() => useBootstrapOperation({ open: true }));
    act(() => result.current.show(verifying));
    // The slow poll read starts first and is still out when the announcement's read starts.
    await settle(SETTLE_POLL_MS);
    expect(answers).toHaveLength(1);
    announce();
    await settle();
    expect(answers).toHaveLength(2);
    await act(async () => { answers[1](enrolled('ready')); });
    expect(result.current.operation?.readiness?.state).toBe('ready');
    await act(async () => { answers[0](enrolled('verifying')); });
    expect(result.current.operation?.readiness?.state).toBe('ready');
  });

  it('keeps reading a shown run whose announcement read failed, until one answers', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() => useBootstrapOperation({ open: true }));
    act(() => result.current.show(enrolled('ready')));
    vi.mocked(fetchBootstrapOperation)
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(enrolled('not_ready', { readiness: readiness('not_ready', NOT_READY_GATES) }));
    announce();
    await settle();
    expect(result.current.operation?.readiness?.state).toBe('ready');
    await settle(SETTLE_POLL_MS);
    expect(result.current.operation?.readiness?.state).toBe('not_ready');
    await settle(SETTLE_POLL_MS * 3);
    expect(fetchBootstrapOperation).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  describe('listed runs', () => {
    const row = (id: string, state: NodeReadiness['state'], extra: Partial<BootstrapOperationDetail> = {}) => enrolled(state, { id, targetName: id, ...extra });

    it('reads a listed enrolled run again until its first verdict lands, then stops', async () => {
      vi.useFakeTimers();
      vi.mocked(listBootstrapOperations)
        .mockResolvedValueOnce({ operations: [row('a', 'verifying')], nextCursor: null })
        .mockResolvedValueOnce({ operations: [row('a', 'verifying')], nextCursor: null })
        .mockResolvedValueOnce({ operations: [row('a', 'ready')], nextCursor: null });
      const { result } = renderHook(() => useBootstrapOperation({ open: true }));
      await settle(0);
      expect(operationStateWord(result.current.operations[0])).toMatchObject({ word: 'Verifying' });
      await settle(SETTLE_POLL_MS);
      await settle(SETTLE_POLL_MS);
      expect(operationStateWord(result.current.operations[0])).toMatchObject({ word: 'Ready' });
      await settle(SETTLE_POLL_MS * 5);
      expect(listBootstrapOperations).toHaveBeenCalledTimes(3);
    });

    it('reads the list when the hub announces a change, so a ready row that lost its verdict is not still ready', async () => {
      vi.useFakeTimers();
      vi.mocked(listBootstrapOperations)
        .mockResolvedValueOnce({ operations: [row('a', 'ready'), row('b', 'ready', { nodeId: 7 })], nextCursor: null })
        .mockResolvedValueOnce({ operations: [row('a', 'provisional'), row('b', 'ready', { nodeId: 7 })], nextCursor: null })
        .mockResolvedValue({ operations: [row('a', 'ready'), row('b', 'ready', { nodeId: 7 })], nextCursor: null });
      const { result } = renderHook(() => useBootstrapOperation({ open: true }));
      await settle(0);
      await settle(SETTLE_POLL_MS * 3);
      expect(listBootstrapOperations).toHaveBeenCalledTimes(1);
      announce();
      await settle();
      expect(result.current.operations.map((entry) => operationStateWord(entry).word)).toEqual(['Unverified', 'Ready']);
      // The unverified row is followed to its verdict.
      await settle(SETTLE_POLL_MS);
      expect(result.current.operations.map((entry) => operationStateWord(entry).word)).toEqual(['Ready', 'Ready']);
    });

    it('does not read the list for an announcement when no listed run is enrolled, or while a run is open', async () => {
      vi.useFakeTimers();
      vi.mocked(listBootstrapOperations).mockResolvedValue({ operations: [{ ...STOPPED, nodeId: 4, agentStarted: false }], nextCursor: null });
      const { result } = renderHook(() => useBootstrapOperation({ open: true }));
      await settle(0);
      announce();
      await settle();
      expect(listBootstrapOperations).toHaveBeenCalledTimes(1);

      vi.mocked(listBootstrapOperations).mockResolvedValue({ operations: [row('a', 'ready')], nextCursor: null });
      await act(async () => { await result.current.refreshList(); });
      act(() => result.current.show(row('a', 'ready')));
      vi.mocked(listBootstrapOperations).mockClear();
      vi.mocked(fetchBootstrapOperation).mockResolvedValue(row('a', 'ready'));
      announce();
      await settle();
      expect(listBootstrapOperations).not.toHaveBeenCalled();
    });

    it('reads an enrolled row on a page "Show more" added, and keeps the pages', async () => {
      vi.useFakeTimers();
      const stoppedRow = (id: string) => ({ ...STOPPED, id, nodeId: 4, agentStarted: false, targetName: id });
      vi.mocked(listBootstrapOperations)
        .mockResolvedValueOnce({ operations: [row('first', 'ready'), stoppedRow('held-1')], nextCursor: 'c1' })
        .mockResolvedValueOnce({ operations: [row('later', 'ready', { nodeId: 8 })], nextCursor: null })
        // The announcement's read of page one.
        .mockResolvedValueOnce({ operations: [row('first', 'ready'), stoppedRow('held-1')], nextCursor: 'c1' });
      vi.mocked(fetchBootstrapOperation).mockImplementation(async (id: string) => (id === 'later' ? row('later', 'not_ready', { nodeId: 8, readiness: readiness('not_ready', NOT_READY_GATES) }) : row(id, 'ready')));
      const { result } = renderHook(() => useBootstrapOperation({ open: true }));
      await settle(0);
      await act(async () => { await result.current.loadMore(); });
      expect(result.current.operations.map((entry) => entry.id)).toEqual(['first', 'held-1', 'later']);
      announce();
      await settle();
      expect(result.current.operations.map((entry) => `${entry.id}:${operationStateWord(entry).word}`)).toEqual(['first:Ready', 'held-1:Stopped partway', 'later:Unverified']);
      expect(fetchBootstrapOperation).toHaveBeenCalledWith('later', expect.anything());
      expect(fetchBootstrapOperation).not.toHaveBeenCalledWith('held-1', expect.anything());
    });

    it('reads the list again when the announcement read failed, until one applies', async () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(listBootstrapOperations)
        .mockResolvedValueOnce({ operations: [row('a', 'ready')], nextCursor: null })
        .mockRejectedValueOnce(new Error('network down'))
        .mockResolvedValueOnce({ operations: [row('a', 'provisional')], nextCursor: null })
        .mockResolvedValueOnce({ operations: [row('a', 'ready')], nextCursor: null });
      const { result } = renderHook(() => useBootstrapOperation({ open: true }));
      await settle(0);
      announce();
      await settle();
      // The read failed: the row still says Ready, and nothing but the retry can correct it.
      expect(operationStateWord(result.current.operations[0]).word).toBe('Ready');
      await settle(SETTLE_POLL_MS);
      expect(operationStateWord(result.current.operations[0]).word).toBe('Unverified');
      await settle(SETTLE_POLL_MS);
      expect(operationStateWord(result.current.operations[0]).word).toBe('Ready');
      await settle(SETTLE_POLL_MS * 3);
      expect(listBootstrapOperations).toHaveBeenCalledTimes(4);
      warn.mockRestore();
    });

    it('drops a full list read that answers after a newer settle read', async () => {
      vi.useFakeTimers();
      const answers: Array<(page: { operations: BootstrapOperationDetail[]; nextCursor: string | null }) => void> = [];
      vi.mocked(listBootstrapOperations)
        .mockResolvedValueOnce({ operations: [row('a', 'verifying')], nextCursor: null })
        .mockImplementation(() => new Promise((resolve) => { answers.push(resolve); }));
      const { result } = renderHook(() => useBootstrapOperation({ open: true }));
      await settle(0);
      // A full read (after an action elsewhere) starts first and is slow; the settle read starts after it and answers first.
      act(() => { void result.current.refreshList(); });
      await settle(SETTLE_POLL_MS);
      expect(answers).toHaveLength(2);
      await act(async () => { answers[1]({ operations: [row('a', 'provisional')], nextCursor: null }); });
      expect(operationStateWord(result.current.operations[0]).word).toBe('Unverified');
      await act(async () => { answers[0]({ operations: [row('a', 'verifying')], nextCursor: null }); });
      expect(operationStateWord(result.current.operations[0]).word).toBe('Unverified');
    });

    it('drops a list read that answers after a newer one', async () => {
      vi.useFakeTimers();
      const answers: Array<(page: { operations: BootstrapOperationDetail[]; nextCursor: string | null }) => void> = [];
      vi.mocked(listBootstrapOperations)
        .mockResolvedValueOnce({ operations: [row('a', 'verifying')], nextCursor: null })
        .mockImplementation(() => new Promise((resolve) => { answers.push(resolve); }));
      const { result } = renderHook(() => useBootstrapOperation({ open: true }));
      await settle(0);
      // The settle read starts first and is slow; the announcement's read starts after it and answers first.
      await settle(SETTLE_POLL_MS);
      expect(answers).toHaveLength(1);
      announce();
      await settle();
      expect(answers).toHaveLength(2);
      // The newer answer still awaits a verdict, so the older read is not cancelled by the list leaving its settling state.
      await act(async () => { answers[1]({ operations: [row('a', 'provisional')], nextCursor: null }); });
      expect(operationStateWord(result.current.operations[0]).word).toBe('Unverified');
      await act(async () => { answers[0]({ operations: [row('a', 'verifying')], nextCursor: null }); });
      expect(operationStateWord(result.current.operations[0]).word).toBe('Unverified');
    });
  });
});

describe('a run dialog left open on a stopped run', () => {
  it('learns the Pilot connected late: Retry and Release give way to Enrolled', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const stopped = { ...STOPPED, nodeId: 4, error: { code: 'ENROLLMENT_NOT_CONNECTED', message: 'The Pilot did not connect in time.' } };
    vi.mocked(listBootstrapOperations).mockResolvedValue({ operations: [stopped], nextCursor: null });
    vi.mocked(fetchBootstrapOperation)
      .mockResolvedValueOnce({ ...stopped })
      .mockResolvedValue({ ...stopped, state: 'enrolled', active: false, error: null, actions: { cancel: false, retry: false, release: false, verify: false } });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<BootstrapServerDialog open onOpenChange={() => {}} />);
    const row = await screen.findByTestId(`bootstrap-run-${stopped.id}`);
    await user.click(within(row).getByRole('button', { name: 'View' }));
    expect(await screen.findByRole('button', { name: /Release server/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Retry/ })).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(SETTLE_POLL_MS * 2); });
    await waitFor(() => expect(screen.queryByRole('button', { name: /Release server/ })).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /^Retry/ })).not.toBeInTheDocument();
    expect(screen.getByText(/is enrolled/)).toBeInTheDocument();
  });
});

describe('a stopped run whose reads fail', () => {
  it('says the Pilot check could not be made, and keeps Retry and Release', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const stopped = { ...STOPPED, nodeId: 4 };
    vi.mocked(listBootstrapOperations).mockResolvedValue({ operations: [stopped], nextCursor: null });
    vi.mocked(fetchBootstrapOperation).mockResolvedValueOnce({ ...stopped }).mockRejectedValue(new Error('hub unreachable'));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<BootstrapServerDialog open onOpenChange={() => {}} />);
    const row = await screen.findByTestId(`bootstrap-run-${stopped.id}`);
    await user.click(within(row).getByRole('button', { name: 'View' }));
    await screen.findByRole('button', { name: /Release server/ });
    for (let tick = 0; tick < 3; tick += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(SETTLE_POLL_MS); });
    }
    expect(await screen.findByTestId('bootstrap-progress-stale')).toHaveTextContent('Whether the Pilot has connected since could not be checked');
    expect(screen.getByRole('button', { name: /Release server/ })).toBeInTheDocument();
  });
});

describe('run controls and degraded reads', () => {
  it('cancels a running operation from its Answer', async () => {
    const user = await reachPlan();
    vi.mocked(startBootstrapOperation).mockResolvedValueOnce(operation());
    await user.click(screen.getByRole('button', { name: 'Approve and run' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Approve and run' }));
    const answer = await screen.findByTestId('bootstrap-run-answer');
    await user.click(within(answer).getByRole('button', { name: 'Cancel run' }));
    await waitFor(() => expect(cancelBootstrapOperation).toHaveBeenCalledWith(operation().id));
    expect(await screen.findByTestId('bootstrap-run-answer')).toHaveTextContent('The run stops after this step.');
  });

  it('approves once even when the button is pressed twice', async () => {
    let resolve: (value: BootstrapOperationDetail) => void = () => undefined;
    vi.mocked(startBootstrapOperation).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const user = await reachPlan();
    await user.click(screen.getByRole('button', { name: 'Approve and run' }));
    const confirm = await screen.findByRole('alertdialog');
    const button = within(confirm).getByRole('button', { name: 'Approve and run' });
    await user.click(button);
    await user.click(button);
    resolve(operation({ state: 'rechecking', stage: null, step: null }));
    await screen.findByTestId('bootstrap-run-answer');
    expect(startBootstrapOperation).toHaveBeenCalledTimes(1);
  });

  it('says when earlier runs could not be loaded', async () => {
    vi.mocked(listBootstrapOperations).mockRejectedValueOnce(new Error('offline'));
    render(<BootstrapServerDialog open onOpenChange={() => {}} />);
    expect(await screen.findByTestId('bootstrap-runs-unavailable')).toHaveTextContent('Earlier bootstrap runs could not be loaded.');
  });

  it('marks progress stale after three failed reads and stops polling a run that is gone', async () => {
    vi.useFakeTimers();
    const { BootstrapApiError } = await import('../bootstrapApi');
    vi.mocked(fetchBootstrapOperation).mockRejectedValue(new Error('hub unreachable'));
    const { result } = renderHook(() => useBootstrapOperation({ open: true }));
    act(() => result.current.show(operation()));
    for (let tick = 0; tick < 3; tick += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(OPERATION_POLL_MS); });
    }
    expect(result.current.progressStale).toBe(true);
    expect(result.current.operation?.state).toBe('running');

    vi.mocked(fetchBootstrapOperation).mockReset();
    vi.mocked(fetchBootstrapOperation).mockRejectedValue(new BootstrapApiError('Bootstrap operation not found.', 'OPERATION_NOT_FOUND', null));
    act(() => result.current.show(operation({ id: '22222222-2222-4222-8222-222222222222' })));
    await act(async () => { await vi.advanceTimersByTimeAsync(OPERATION_POLL_MS); });
    for (let tick = 0; tick < 3; tick += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(OPERATION_POLL_MS); });
    }
    expect(fetchBootstrapOperation).toHaveBeenCalledTimes(1);
    expect(result.current.progressStale).toBe(true);
  });

  it('shows a state this build does not know as stopped instead of failing', () => {
    const unknown = operation({ state: 'paused' as BootstrapOperationDetail['state'], actions: { cancel: false, retry: false, release: false, verify: false } });
    expect(operationAnswer(unknown)).toMatchObject({ tone: 'neutral', title: 'Stopped' });
    expect(() => operationStages(unknown)).not.toThrow();
  });
});

describe('polling after the session ends', () => {
  it('stops polling on a 401 and keeps the last state with the stale notice', async () => {
    vi.useFakeTimers();
    const { BootstrapApiError } = await import('../bootstrapApi');
    vi.mocked(fetchBootstrapOperation).mockRejectedValue(new BootstrapApiError('Unauthorized', 'HTTP_401', null));
    const { result } = renderHook(() => useBootstrapOperation({ open: true }));
    act(() => result.current.show(operation()));
    for (let tick = 0; tick < 4; tick += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(OPERATION_POLL_MS); });
    }
    expect(fetchBootstrapOperation).toHaveBeenCalledTimes(1);
    expect(result.current.progressStale).toBe(true);
    expect(result.current.operation?.state).toBe('running');
  });
});

describe('held runs arrive a page at a time', () => {
  const held = (index: number) => operation({
    id: `held-${index}`,
    targetName: `server-${index}`,
    state: 'partial',
    actions: { cancel: false, retry: true, release: true, verify: false },
    finishedAt: Date.now(),
  });
  const firstPage = Array.from({ length: 20 }, (_, index) => held(24 - index));
  const secondPage = Array.from({ length: 5 }, (_, index) => held(4 - index));

  it('shows a bounded first page, then reaches the oldest hold and opens it', async () => {
    vi.mocked(listBootstrapOperations)
      .mockResolvedValueOnce({ operations: firstPage, nextCursor: 'cursor-1' })
      .mockResolvedValueOnce({ operations: secondPage, nextCursor: null });
    vi.mocked(fetchBootstrapOperation).mockResolvedValue(held(0));
    const user = userEvent.setup();
    render(<BootstrapServerDialog open onOpenChange={() => {}} />);
    await screen.findByTestId('bootstrap-run-held-24');
    expect(screen.getAllByTestId(/^bootstrap-run-held-/)).toHaveLength(20);
    expect(screen.queryByTestId('bootstrap-run-held-0')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('bootstrap-runs-more'));
    const oldest = await screen.findByTestId('bootstrap-run-held-0');
    expect(screen.getAllByTestId(/^bootstrap-run-held-/)).toHaveLength(25);
    expect(vi.mocked(listBootstrapOperations).mock.calls[1][1]).toBe('cursor-1');
    // The last page ends the button.
    expect(screen.queryByTestId('bootstrap-runs-more')).not.toBeInTheDocument();

    await user.click(within(oldest).getByRole('button', { name: 'View' }));
    expect(fetchBootstrapOperation).toHaveBeenCalledWith('held-0');
  });

  it('keeps its place when a page fails, and tries the same page again', async () => {
    vi.mocked(listBootstrapOperations)
      .mockResolvedValueOnce({ operations: firstPage, nextCursor: 'cursor-1' })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ operations: secondPage, nextCursor: null });
    const user = userEvent.setup();
    render(<BootstrapServerDialog open onOpenChange={() => {}} />);
    await screen.findByTestId('bootstrap-run-held-24');
    await user.click(screen.getByTestId('bootstrap-runs-more'));
    await waitFor(() => expect(listBootstrapOperations).toHaveBeenCalledTimes(2));
    expect(screen.getAllByTestId(/^bootstrap-run-held-/)).toHaveLength(20);
    await user.click(await screen.findByTestId('bootstrap-runs-more'));
    await screen.findByTestId('bootstrap-run-held-0');
    expect(vi.mocked(listBootstrapOperations).mock.calls[2][1]).toBe('cursor-1');
  });

  it('adds a run once when a page repeats one already shown', async () => {
    vi.mocked(listBootstrapOperations)
      .mockResolvedValueOnce({ operations: firstPage, nextCursor: 'cursor-1' })
      .mockResolvedValueOnce({ operations: [firstPage[19], ...secondPage], nextCursor: null });
    const user = userEvent.setup();
    render(<BootstrapServerDialog open onOpenChange={() => {}} />);
    await screen.findByTestId('bootstrap-run-held-24');
    await user.click(screen.getByTestId('bootstrap-runs-more'));
    await screen.findByTestId('bootstrap-run-held-0');
    expect(screen.getAllByTestId(/^bootstrap-run-held-/)).toHaveLength(25);
  });

  it('drops a page that was still on its way when the list was read again', async () => {
    let finishLate: (page: { operations: BootstrapOperationDetail[]; nextCursor: string | null }) => void = () => undefined;
    vi.mocked(listBootstrapOperations)
      .mockResolvedValueOnce({ operations: firstPage, nextCursor: 'cursor-1' })
      .mockReturnValueOnce(new Promise((resolve) => { finishLate = resolve; }))
      .mockResolvedValueOnce({ operations: [held(30)], nextCursor: null });
    const { result } = renderHook(() => useBootstrapOperation({ open: true }));
    await waitFor(() => expect(result.current.operations).toHaveLength(20));
    let more: Promise<void> = Promise.resolve();
    act(() => { more = result.current.loadMore(); });
    await act(async () => { await result.current.refreshList(); });
    expect(result.current.operations.map((entry) => entry.id)).toEqual(['held-30']);
    await act(async () => {
      finishLate({ operations: secondPage, nextCursor: null });
      await more;
    });
    expect(result.current.operations.map((entry) => entry.id)).toEqual(['held-30']);
    expect(result.current.hasMoreOperations).toBe(false);
  });
  it('drops a page asked for while the first page was being read again', async () => {
    type Page = { operations: BootstrapOperationDetail[]; nextCursor: string | null };
    let finishRefresh: (page: Page) => void = () => undefined;
    let finishMore: (page: Page) => void = () => undefined;
    vi.mocked(listBootstrapOperations)
      .mockResolvedValueOnce({ operations: firstPage, nextCursor: 'cursor-1' })
      .mockReturnValueOnce(new Promise((resolve) => { finishRefresh = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { finishMore = resolve; }));
    const { result } = renderHook(() => useBootstrapOperation({ open: true }));
    await waitFor(() => expect(result.current.operations).toHaveLength(20));
    let refresh: Promise<void> = Promise.resolve();
    act(() => { refresh = result.current.refreshList(); });
    // The next page is asked for with the old cursor while the refresh is still on its way.
    let more: Promise<void> = Promise.resolve();
    act(() => { more = result.current.loadMore(); });
    // The refresh answers first, then the page that was read with the old cursor.
    await act(async () => {
      finishRefresh({ operations: [held(30), ...firstPage.slice(0, 19)], nextCursor: 'cursor-2' });
      await refresh;
    });
    await act(async () => {
      finishMore({ operations: secondPage, nextCursor: null });
      await more;
    });
    // The refreshed first page stands with its own cursor; the page read with the old one was not stitched on.
    expect(result.current.operations).toHaveLength(20);
    expect(result.current.operations.map((entry) => entry.id)).not.toContain('held-0');
    expect(result.current.hasMoreOperations).toBe(true);
  });
});
