import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
import { operationAnswer, operationStages } from '../operationStatus';
import { OPERATION_POLL_MS, useBootstrapOperation } from '../useBootstrapOperation';
import type {
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
    active: true,
    cancelRequested: false,
    error: null,
    enrollmentExpiresAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    finishedAt: null,
    actions: { cancel: true, retry: false, release: false },
    plan: PLAN,
    events: [{ at: Date.now(), attempt: 1, stage: 'docker_packages', step: 'install-docker-packages', status: 'started', message: 'Install the missing Docker packages', detail: null }],
    ...overrides,
  };
}

const STOPPED = operation({
  state: 'partial',
  error: { code: 'STEP_FAILED', message: '"Install the missing Docker packages" failed (exit 100).' },
  actions: { cancel: false, retry: true, release: true },
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
  vi.mocked(cancelBootstrapOperation).mockResolvedValue(operation({ cancelRequested: true, actions: { cancel: false, retry: false, release: false } }));
  vi.mocked(releaseBootstrapOperation).mockResolvedValue({ ...STOPPED, active: false, actions: { cancel: false, retry: false, release: false } });
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
      ['recheck', 'done'], ['docker', 'running'], ['files', 'pending'], ['start', 'pending'], ['enroll', 'pending'],
    ]);
  });

  it('omits the Docker phase when the plan has no Docker stage', () => {
    const op = operation({ plan: { ...PLAN, stages: PLAN.stages.slice(1) }, stage: 'agent_dir' });
    expect(operationStages(op).map((stage) => stage.id)).toEqual(['recheck', 'files', 'start', 'enroll']);
  });

  it('says an enrolled node is not verified yet, and a stopped run that changed things undid nothing', () => {
    const enrolled = operation({ state: 'enrolled', stage: 'enroll' });
    expect(operationAnswer(enrolled).line).toMatch(/has not been verified yet/);
    expect(operationStages(enrolled).every((stage) => stage.tone === 'success')).toBe(true);
    expect(operationAnswer(STOPPED)).toMatchObject({ tone: 'warning', title: 'Stopped partway', detail: 'Steps that ran stay on the host. Nothing was undone.' });
    expect(operationStages(STOPPED).find((stage) => stage.id === 'docker')).toMatchObject({ word: 'stopped', tone: 'warning' });
    expect(operationStages(STOPPED).find((stage) => stage.id === 'enroll')?.word).toBe('not run');
  });
});

describe('approving a plan', () => {
  it('takes two clicks, names the digest, and sends the reviewed digest with the key', async () => {
    const user = await reachPlan();
    await user.click(screen.getByRole('button', { name: 'Approve and run' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText(`Plan sha256:${DIGEST}`)).toBeInTheDocument();
    expect(within(confirm).getByText(/CHANGES server\.example\.com/)).toBeInTheDocument();
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
    const unknown = operation({ state: 'paused' as BootstrapOperationDetail['state'], actions: { cancel: false, retry: false, release: false } });
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
    actions: { cancel: false, retry: true, release: true },
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
});
