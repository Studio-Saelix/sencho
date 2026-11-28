import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
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
import { announceNotificationsConnection } from '@/lib/notificationsConnection';
import { BootstrapApiError } from '../bootstrapApi';
import { operationAnswer, operationStages, operationStateWord } from '../operationStatus';
import { BootstrapRunStep } from '../BootstrapRunStep';
import { OPERATION_POLL_MS, READINESS_REFRESH_DELAY_MS, SETTLE_POLL_MS, useBootstrapOperation } from '../useBootstrapOperation';
import type {
  NodeReadiness,
  BootstrapHostKeyResult,
  BootstrapOperation,
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
    nodeExists: false,
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
  // The notification socket's last announced state outlives a test; leave it up.
  announceNotificationsConnection(true);
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
    render(<BootstrapRunStep operation={op} busy={null} onCancel={vi.fn()} onRetry={vi.fn()} onRelease={vi.fn()} onRefresh={async () => op} onVerify={vi.fn()} />);
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
    render(<BootstrapRunStep operation={op} busy={null} onCancel={vi.fn()} onRetry={vi.fn()} onRelease={vi.fn()} onRefresh={async () => op} onVerify={onVerify} />);
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
    const { rerender } = render(<BootstrapRunStep operation={provisional} busy={null} onCancel={vi.fn()} onRetry={vi.fn()} onRelease={vi.fn()} onRefresh={async () => provisional} onVerify={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Verify now' })).toBeInTheDocument();
    const verifying = { ...provisional, readiness: readiness('verifying'), actions: { ...provisional.actions, verify: false } };
    rerender(<BootstrapRunStep operation={verifying} busy={null} onCancel={vi.fn()} onRetry={vi.fn()} onRelease={vi.fn()} onRefresh={async () => verifying} onVerify={vi.fn()} />);
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
    expect(confirm).not.toHaveTextContent(/node record/);
    await user.click(within(confirm).getByRole('button', { name: 'Release server' }));
    await waitFor(() => expect(releaseBootstrapOperation).toHaveBeenCalledWith(STOPPED.id));
  });

  it('reads the run again before Release so a node deleted meanwhile is named correctly', async () => {
    const viewed = { ...STOPPED, nodeId: 4, nodeExists: true };
    const deleted = { ...viewed, nodeExists: false };
    vi.mocked(listBootstrapOperations).mockResolvedValue({ operations: [viewed], nextCursor: null });
    vi.mocked(fetchBootstrapOperation).mockResolvedValueOnce(viewed).mockResolvedValueOnce(deleted);
    const user = userEvent.setup();
    render(<BootstrapServerDialog open onOpenChange={() => {}} />);
    const row = await screen.findByTestId(`bootstrap-run-${viewed.id}`);
    await user.click(within(row).getByRole('button', { name: 'View' }));
    const answer = await screen.findByTestId('bootstrap-run-answer');
    await user.click(within(answer).getByRole('button', { name: 'Release server' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent(/node record is no longer in Fleet/);
    expect(confirm).not.toHaveTextContent(/stays in Fleet/);
  });

  it.each([
    ['still exists', true, /node record stays in Fleet/],
    ['was deleted', false, /node record is no longer in Fleet/],
  ])('names the node record correctly when it %s', async (_label, nodeExists, expected) => {
    const stopped = { ...STOPPED, nodeId: 4, nodeExists };
    vi.mocked(listBootstrapOperations).mockResolvedValue({ operations: [stopped], nextCursor: null });
    vi.mocked(fetchBootstrapOperation).mockResolvedValue(stopped);
    const user = userEvent.setup();
    render(<BootstrapServerDialog open onOpenChange={() => {}} />);
    const row = await screen.findByTestId(`bootstrap-run-${stopped.id}`);
    await user.click(within(row).getByRole('button', { name: 'View' }));
    const answer = await screen.findByTestId('bootstrap-run-answer');
    await user.click(within(answer).getByRole('button', { name: 'Release server' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent(expected);
    expect(confirm).not.toHaveTextContent(nodeExists ? /no longer in Fleet/ : /stays in Fleet/);
  });

  it('does not open the Release confirmation when the run cannot be read again or is no longer releasable', async () => {
    const op = operation({
      state: 'partial',
      nodeId: 4,
      nodeExists: true,
      actions: { cancel: false, retry: true, release: true, verify: false },
    });
    const user = userEvent.setup();
    const renderStep = (refresh: () => Promise<BootstrapOperationDetail | null>) => render(
      <BootstrapRunStep operation={op} busy={null} onCancel={vi.fn()} onRetry={vi.fn()} onRelease={vi.fn()} onRefresh={refresh} onVerify={vi.fn()} />,
    );
    const { unmount } = renderStep(async () => null);
    await user.click(screen.getByRole('button', { name: 'Release server' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    unmount();

    renderStep(async () => ({ ...op, actions: { ...op.actions, release: false } }));
    await user.click(screen.getByRole('button', { name: 'Release server' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
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
    await act(async () => { await result.current.release(stopped.id); });
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
    const connection = (connected: boolean) => act(() => { announceNotificationsConnection(connected); });
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

  it('reads the shown run when the socket returns from a drop that began before the dialog opened', async () => {
    vi.useFakeTimers();
    // The socket is already down (backing off) when the dialog mounts, so this listener never sees the close.
    act(() => { announceNotificationsConnection(false); });
    const { result } = renderHook(() => useBootstrapOperation({ open: true }));
    act(() => result.current.show(enrolled('ready')));
    vi.mocked(fetchBootstrapOperation).mockResolvedValueOnce(enrolled('provisional'));
    act(() => { announceNotificationsConnection(true); });
    await settle(0);
    expect(fetchBootstrapOperation).toHaveBeenCalledTimes(1);
    expect(result.current.operation?.readiness?.state).toBe('provisional');

    // One return is one read: a later connection that never dropped adds none.
    act(() => { announceNotificationsConnection(true); });
    await settle();
    expect(fetchBootstrapOperation).toHaveBeenCalledTimes(1);
  });

  it('reads a dialog that was closed and reopened during the outage once the socket returns', async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ open }) => useBootstrapOperation({ open }), { initialProps: { open: true } });
    act(() => result.current.show(enrolled('ready')));
    rerender({ open: false });
    act(() => { announceNotificationsConnection(false); });
    rerender({ open: true });
    vi.mocked(fetchBootstrapOperation).mockResolvedValueOnce(enrolled('provisional'));
    act(() => { announceNotificationsConnection(true); });
    await settle(0);
    expect(fetchBootstrapOperation).toHaveBeenCalledTimes(1);
    expect(result.current.operation?.readiness?.state).toBe('provisional');
  });

  it('does not read a run when the socket returns while the dialog is closed', async () => {
    vi.useFakeTimers();
    act(() => { announceNotificationsConnection(false); });
    const { result } = renderHook(() => useBootstrapOperation({ open: false }));
    act(() => result.current.show(enrolled('ready')));
    act(() => { announceNotificationsConnection(true); });
    await settle();
    expect(fetchBootstrapOperation).not.toHaveBeenCalled();
  });

  it('reads a run opened from the list again when a readiness change arrived while its first read was out', async () => {
    vi.useFakeTimers();
    let answerFirst: (detail: BootstrapOperationDetail) => void = () => {};
    vi.mocked(fetchBootstrapOperation)
      .mockImplementationOnce(() => new Promise((resolve) => { answerFirst = resolve; }))
      .mockResolvedValueOnce(enrolled('provisional'));
    const { result } = renderHook(() => useBootstrapOperation({ open: true }));
    let opened: Promise<unknown> = Promise.resolve();
    act(() => { opened = result.current.openOperation('op-1'); });
    // The hub demotes the node after it answered, and the announcement reaches the dialog before the answer does.
    announce();
    await settle();
    await act(async () => { answerFirst(enrolled('ready')); await opened; });
    await settle(0);
    expect(fetchBootstrapOperation).toHaveBeenCalledTimes(2);
    expect(result.current.operation?.readiness?.state).toBe('provisional');
  });

  it('reads a run opened from the list again when the socket returned while its first read was out', async () => {
    vi.useFakeTimers();
    act(() => { announceNotificationsConnection(false); });
    let answerFirst: (detail: BootstrapOperationDetail) => void = () => {};
    vi.mocked(fetchBootstrapOperation)
      .mockImplementationOnce(() => new Promise((resolve) => { answerFirst = resolve; }))
      .mockResolvedValueOnce(enrolled('provisional'));
    const { result } = renderHook(() => useBootstrapOperation({ open: true }));
    let opened: Promise<unknown> = Promise.resolve();
    act(() => { opened = result.current.openOperation('op-1'); });
    act(() => { announceNotificationsConnection(true); });
    await act(async () => { answerFirst(enrolled('ready')); await opened; });
    await settle(0);
    expect(fetchBootstrapOperation).toHaveBeenCalledTimes(2);
    expect(result.current.operation?.readiness?.state).toBe('provisional');
  });

  it('does not read a run opened from the list again when no readiness change arrived while it was read', async () => {
    vi.useFakeTimers();
    vi.mocked(fetchBootstrapOperation).mockResolvedValue(enrolled('ready'));
    const { result } = renderHook(() => useBootstrapOperation({ open: true }));
    await act(async () => { await result.current.openOperation('op-1'); });
    await settle(SETTLE_POLL_MS * 3);
    expect(fetchBootstrapOperation).toHaveBeenCalledTimes(1);
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

    it('reads the listed runs when the socket returns from a drop that began before the dialog opened', async () => {
      vi.useFakeTimers();
      act(() => { announceNotificationsConnection(false); });
      vi.mocked(listBootstrapOperations)
        .mockResolvedValueOnce({ operations: [row('a', 'ready'), row('b', 'ready', { nodeId: 7 })], nextCursor: null })
        .mockResolvedValueOnce({ operations: [row('a', 'provisional'), row('b', 'ready', { nodeId: 7 })], nextCursor: null })
        .mockResolvedValue({ operations: [row('a', 'ready'), row('b', 'ready', { nodeId: 7 })], nextCursor: null });
      const { result } = renderHook(() => useBootstrapOperation({ open: true }));
      await settle(0);
      expect(result.current.operations.map((entry) => operationStateWord(entry).word)).toEqual(['Ready', 'Ready']);
      // The hub demoted the first node and announced it into the dead socket; nothing polls a Ready row.
      await settle(SETTLE_POLL_MS * 3);
      expect(listBootstrapOperations).toHaveBeenCalledTimes(1);
      act(() => { announceNotificationsConnection(true); });
      await settle(0);
      expect(result.current.operations.map((entry) => operationStateWord(entry).word)).toEqual(['Unverified', 'Ready']);
    });

    it('reads the list again when a readiness change arrived while its first read was out', async () => {
      vi.useFakeTimers();
      let answerFirst: (page: { operations: BootstrapOperationDetail[]; nextCursor: string | null }) => void = () => {};
      vi.mocked(listBootstrapOperations)
        .mockImplementationOnce(() => new Promise((resolve) => { answerFirst = resolve; }))
        .mockResolvedValueOnce({ operations: [row('a', 'provisional')], nextCursor: null });
      const { result } = renderHook(() => useBootstrapOperation({ open: true }));
      // The hub demotes the node after the list was read, and the announcement reaches the dialog before the answer does.
      announce();
      await settle();
      await act(async () => { answerFirst({ operations: [row('a', 'ready')], nextCursor: null }); });
      await settle(0);
      expect(listBootstrapOperations).toHaveBeenCalledTimes(2);
      expect(operationStateWord(result.current.operations[0]).word).toBe('Unverified');
    });

    it('reads the list again when the socket returned while its first read was out', async () => {
      vi.useFakeTimers();
      act(() => { announceNotificationsConnection(false); });
      let answerFirst: (page: { operations: BootstrapOperationDetail[]; nextCursor: string | null }) => void = () => {};
      vi.mocked(listBootstrapOperations)
        .mockImplementationOnce(() => new Promise((resolve) => { answerFirst = resolve; }))
        .mockResolvedValueOnce({ operations: [row('a', 'provisional')], nextCursor: null });
      const { result } = renderHook(() => useBootstrapOperation({ open: true }));
      act(() => { announceNotificationsConnection(true); });
      await act(async () => { answerFirst({ operations: [row('a', 'ready')], nextCursor: null }); });
      await settle(0);
      expect(listBootstrapOperations).toHaveBeenCalledTimes(2);
      expect(operationStateWord(result.current.operations[0]).word).toBe('Unverified');
    });

    it('does not read the list when the socket connects without having dropped', async () => {
      vi.useFakeTimers();
      vi.mocked(listBootstrapOperations).mockResolvedValue({ operations: [row('a', 'ready')], nextCursor: null });
      renderHook(() => useBootstrapOperation({ open: true }));
      await settle(0);
      act(() => { announceNotificationsConnection(true); });
      await settle(SETTLE_POLL_MS * 3);
      expect(listBootstrapOperations).toHaveBeenCalledTimes(1);
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

    it('reads the list again when an older read answers after a newer one failed', async () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const answers: Array<(page: { operations: BootstrapOperationDetail[]; nextCursor: string | null }) => void> = [];
      vi.mocked(listBootstrapOperations)
        .mockResolvedValueOnce({ operations: [row('a', 'ready')], nextCursor: null })
        .mockImplementationOnce(() => new Promise((resolve) => { answers.push(resolve); }))
        .mockRejectedValueOnce(new Error('network down'))
        .mockResolvedValue({ operations: [row('a', 'provisional')], nextCursor: null });
      const { result } = renderHook(() => useBootstrapOperation({ open: true }));
      await settle(0);
      announce();
      await settle();
      announce();
      await settle();
      expect(listBootstrapOperations).toHaveBeenCalledTimes(3);
      // The older read answers with the verdict from before the change, after the newer one failed.
      await act(async () => { answers[0]({ operations: [row('a', 'ready')], nextCursor: null }); });
      await settle(SETTLE_POLL_MS * 2);
      expect(operationStateWord(result.current.operations[0]).word).toBe('Unverified');
      warn.mockRestore();
    });

    it('keeps reading the list when a settle read that started after an announcement answers after the read it started failed', async () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const answers: Array<(page: { operations: BootstrapOperationDetail[]; nextCursor: string | null }) => void> = [];
      vi.mocked(listBootstrapOperations)
        .mockResolvedValueOnce({ operations: [row('a', 'ready')], nextCursor: null })
        // The first announcement's read fails, which leaves the list owed a read.
        .mockRejectedValueOnce(new Error('network down'))
        // The settle read starts after the second announcement and before that announcement's own read, so it finds no change
        // since it began; it is slow.
        .mockImplementationOnce(() => new Promise((resolve) => { answers.push(resolve); }))
        // The second announcement's read fails.
        .mockRejectedValueOnce(new Error('network down'))
        .mockResolvedValue({ operations: [row('a', 'provisional')], nextCursor: null });
      const { result } = renderHook(() => useBootstrapOperation({ open: true }));
      await settle(0);
      announce();
      await settle();
      expect(listBootstrapOperations).toHaveBeenCalledTimes(2);
      await settle(SETTLE_POLL_MS - 100);
      announce();
      await settle(100);
      expect(answers).toHaveLength(1);
      await settle(READINESS_REFRESH_DELAY_MS);
      expect(listBootstrapOperations).toHaveBeenCalledTimes(4);
      // The settle read answers with the verdict from before the change, after the newer read failed: it is shown, and it does not end the retries.
      await act(async () => { answers[0]({ operations: [row('a', 'ready')], nextCursor: null }); });
      await settle(0);
      expect(operationStateWord(result.current.operations[0]).word).toBe('Ready');
      await settle(SETTLE_POLL_MS * 2);
      expect(listBootstrapOperations).toHaveBeenCalledTimes(5);
      expect(operationStateWord(result.current.operations[0]).word).toBe('Unverified');
      warn.mockRestore();
    });

    it('keeps reading the list when a settle read that started before the socket returned answers after the read it started failed', async () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const answers: Array<(page: { operations: BootstrapOperationDetail[]; nextCursor: string | null }) => void> = [];
      vi.mocked(listBootstrapOperations)
        .mockResolvedValueOnce({ operations: [row('a', 'ready')], nextCursor: null })
        .mockRejectedValueOnce(new Error('network down'))
        // The settle read is slow.
        .mockImplementationOnce(() => new Promise((resolve) => { answers.push(resolve); }))
        // The read the socket's return starts fails.
        .mockRejectedValueOnce(new Error('network down'))
        .mockResolvedValue({ operations: [row('a', 'provisional')], nextCursor: null });
      const { result } = renderHook(() => useBootstrapOperation({ open: true }));
      await settle(0);
      announce();
      await settle();
      await settle(SETTLE_POLL_MS);
      expect(answers).toHaveLength(1);
      act(() => { announceNotificationsConnection(false); });
      act(() => { announceNotificationsConnection(true); });
      await settle(0);
      expect(listBootstrapOperations).toHaveBeenCalledTimes(4);
      await act(async () => { answers[0]({ operations: [row('a', 'ready')], nextCursor: null }); });
      await settle(0);
      expect(operationStateWord(result.current.operations[0]).word).toBe('Ready');
      await settle(SETTLE_POLL_MS * 2);
      expect(operationStateWord(result.current.operations[0]).word).toBe('Unverified');
      warn.mockRestore();
    });

    it('keeps reading the list when a full read that started before a failed readiness read answers after it', async () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const answers: Array<(page: { operations: BootstrapOperationDetail[]; nextCursor: string | null }) => void> = [];
      vi.mocked(listBootstrapOperations)
        .mockResolvedValueOnce({ operations: [row('a', 'ready')], nextCursor: null })
        // A full read (after an action elsewhere) is slow.
        .mockImplementationOnce(() => new Promise((resolve) => { answers.push(resolve); }))
        // The announcement's read fails while it is out.
        .mockRejectedValueOnce(new Error('network down'))
        .mockResolvedValue({ operations: [row('a', 'provisional')], nextCursor: null });
      const { result } = renderHook(() => useBootstrapOperation({ open: true }));
      await settle(0);
      // The announcement comes first, so the full read starts after it and finds no change since it began.
      announce();
      act(() => { void result.current.refreshList(); });
      await settle();
      expect(listBootstrapOperations).toHaveBeenCalledTimes(3);
      await act(async () => { answers[0]({ operations: [row('a', 'ready')], nextCursor: null }); });
      await settle(0);
      expect(operationStateWord(result.current.operations[0]).word).toBe('Ready');
      await settle(SETTLE_POLL_MS * 2);
      expect(listBootstrapOperations).toHaveBeenCalledTimes(4);
      expect(operationStateWord(result.current.operations[0]).word).toBe('Unverified');
      warn.mockRestore();
    });

    it('ends the retries when the read that answers began after the failed one', async () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(listBootstrapOperations)
        .mockResolvedValueOnce({ operations: [row('a', 'ready')], nextCursor: null })
        .mockRejectedValueOnce(new Error('network down'))
        .mockResolvedValue({ operations: [row('a', 'ready')], nextCursor: null });
      renderHook(() => useBootstrapOperation({ open: true }));
      await settle(0);
      announce();
      await settle();
      await settle(SETTLE_POLL_MS);
      expect(listBootstrapOperations).toHaveBeenCalledTimes(3);
      await settle(SETTLE_POLL_MS * 3);
      expect(listBootstrapOperations).toHaveBeenCalledTimes(3);
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

  describe('a readiness change that overtakes a read', () => {
    const TRIGGERS: Array<{ name: string; fire: () => void | Promise<void>; waitMs: number }> = [
      { name: 'an announcement', fire: () => announce(), waitMs: READINESS_REFRESH_DELAY_MS },
      { name: 'the socket returning', fire: () => { act(() => { announceNotificationsConnection(false); }); act(() => { announceNotificationsConnection(true); }); }, waitMs: 0 },
    ];
    const row = (id: string, state: NodeReadiness['state'], extra: Partial<BootstrapOperationDetail> = {}) => enrolled(state, { id, targetName: id, ...extra });
    const stoppedRow = (id: string) => ({ ...STOPPED, id, nodeId: 4, agentStarted: false, targetName: id });
    const words = (entries: BootstrapOperation[]) => entries.map((entry) => `${entry.id}:${operationStateWord(entry).word}`);

    for (const trigger of TRIGGERS) {
      describe(trigger.name, () => {
        it('reads a loaded later page\'s row again, without another event, when its first re-read failed', async () => {
          vi.useFakeTimers();
          const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
          const page1 = { operations: [row('first', 'ready'), stoppedRow('held-1')], nextCursor: 'c1' };
          vi.mocked(listBootstrapOperations)
            .mockResolvedValueOnce(page1)
            .mockResolvedValueOnce({ operations: [row('later', 'ready', { nodeId: 8 })], nextCursor: null })
            .mockResolvedValue(page1);
          let laterReads = 0;
          vi.mocked(fetchBootstrapOperation).mockImplementation(async (id: string) => {
            if (id !== 'later') return row(id, 'ready');
            laterReads += 1;
            if (laterReads === 1) throw new Error('network down');
            return row('later', 'not_ready', { nodeId: 8, readiness: readiness('not_ready', NOT_READY_GATES) });
          });
          const { result } = renderHook(() => useBootstrapOperation({ open: true }));
          await settle(0);
          await act(async () => { await result.current.loadMore(); });
          expect(words(result.current.operations)).toEqual(['first:Ready', 'held-1:Stopped partway', 'later:Ready']);

          await trigger.fire();
          await settle(trigger.waitMs);
          // The page-one read answered, the later row's read failed: it still says Ready, and the list is owed a read.
          expect(laterReads).toBe(1);
          expect(words(result.current.operations)).toEqual(['first:Ready', 'held-1:Stopped partway', 'later:Ready']);
          await settle(SETTLE_POLL_MS);
          expect(laterReads).toBe(2);
          expect(words(result.current.operations)).toEqual(['first:Ready', 'held-1:Stopped partway', 'later:Unverified']);
          // Once the row was read the list stops reading, and the pages are as they were.
          const lists = vi.mocked(listBootstrapOperations).mock.calls.length;
          await settle(SETTLE_POLL_MS * 6);
          expect(vi.mocked(listBootstrapOperations).mock.calls.length).toBeLessThanOrEqual(lists + 3);
          expect(laterReads).toBe(2);
          expect(result.current.hasMoreOperations).toBe(false);
          warn.mockRestore();
        });

        it('reads a row on a later page that was still on its way when the change arrived', async () => {
          vi.useFakeTimers();
          const page1 = { operations: [row('first', 'ready'), stoppedRow('held-1')], nextCursor: 'c1' };
          let answerPage: (page: { operations: BootstrapOperationDetail[]; nextCursor: string | null }) => void = () => {};
          vi.mocked(listBootstrapOperations).mockImplementation((_signal, cursor) => (cursor
            ? new Promise((resolve) => { answerPage = resolve; })
            : Promise.resolve(page1)));
          vi.mocked(fetchBootstrapOperation).mockImplementation(async (id: string) => (id === 'later'
            ? row('later', 'provisional', { nodeId: 8 })
            : row(id, 'ready')));
          const { result } = renderHook(() => useBootstrapOperation({ open: true }));
          await settle(0);
          let loading: Promise<void> = Promise.resolve();
          act(() => { loading = result.current.loadMore(); });
          // The hub demotes the node; the read of the loaded rows follows and finishes before the page answers with the older verdict.
          await trigger.fire();
          await settle(trigger.waitMs);
          await act(async () => { answerPage({ operations: [row('later', 'ready', { nodeId: 8 })], nextCursor: null }); await loading; });
          expect(words(result.current.operations)).toEqual(['first:Ready', 'held-1:Stopped partway', 'later:Ready']);
          await settle(SETTLE_POLL_MS);
          expect(words(result.current.operations)).toEqual(['first:Ready', 'held-1:Stopped partway', 'later:Unverified']);
          expect(result.current.hasMoreOperations).toBe(false);
        });

        it('does not put a Verify answer from before the change back on screen', async () => {
          vi.useFakeTimers();
          let answerVerify: (detail: BootstrapOperationDetail) => void = () => {};
          const verify = vi.fn(() => new Promise<BootstrapOperationDetail>((resolve) => { answerVerify = resolve; }));
          vi.mocked(fetchBootstrapOperation).mockResolvedValue(enrolled('provisional'));
          const { result } = renderHook(() => useBootstrapOperation({
            open: true,
            api: { get: fetchBootstrapOperation, list: listBootstrapOperations, cancel: cancelBootstrapOperation, release: releaseBootstrapOperation, verify },
          }));
          act(() => result.current.show(enrolled('not_ready', { readiness: readiness('not_ready', NOT_READY_GATES) })));
          act(() => { void result.current.verify(); });
          // The check passed, then the Pilot disconnected and the hub put the node back to unverified before the answer got here.
          await trigger.fire();
          await settle(trigger.waitMs);
          expect(result.current.operation?.readiness?.state).toBe('provisional');
          await act(async () => { answerVerify(enrolled('ready')); });
          await settle(0);
          expect(result.current.operation?.readiness?.state).toBe('provisional');
          expect(result.current.busy).toBeNull();
          // The shown run is still followed to its next verdict.
          vi.mocked(fetchBootstrapOperation).mockResolvedValue(enrolled('ready'));
          // The poll that straddled the answer is dropped once by design; the next one lands.
          for (let tick = 0; tick < 6; tick += 1) await settle(SETTLE_POLL_MS);
          expect(result.current.operation?.readiness?.state).toBe('ready');
        });

        it('keeps reading the run when the read that replaced a discarded Verify answer fails, until the newest verdict lands', async () => {
          vi.useFakeTimers();
          const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
          let answerVerify: (detail: BootstrapOperationDetail) => void = () => {};
          const verify = vi.fn(() => new Promise<BootstrapOperationDetail>((resolve) => { answerVerify = resolve; }));
          vi.mocked(fetchBootstrapOperation)
            .mockResolvedValueOnce(enrolled('provisional'))
            .mockRejectedValueOnce(new Error('network down'))
            .mockResolvedValue(enrolled('not_ready', { readiness: readiness('not_ready', NOT_READY_GATES) }));
          const { result } = renderHook(() => useBootstrapOperation({
            open: true,
            api: { get: fetchBootstrapOperation, list: listBootstrapOperations, cancel: cancelBootstrapOperation, release: releaseBootstrapOperation, verify },
          }));
          act(() => result.current.show(enrolled('not_ready', { readiness: readiness('not_ready', NOT_READY_GATES) })));
          act(() => { void result.current.verify(); });
          await trigger.fire();
          await settle(trigger.waitMs);
          await act(async () => { answerVerify(enrolled('ready')); });
          await settle(0);
          // The answer was not shown and its replacement read failed: the run says what the last read said, not Ready.
          expect(result.current.operation?.readiness?.state).not.toBe('ready');
          for (let tick = 0; tick < 6; tick += 1) await settle(SETTLE_POLL_MS);
          expect(result.current.operation?.readiness?.state).toBe('not_ready');
          warn.mockRestore();
        });

        const FAILURES: Array<{ name: string; error: () => Error }> = [
          { name: 'a network error', error: () => new TypeError('Failed to fetch') },
          { name: 'an HTTP 502', error: () => new BootstrapApiError('Bad gateway', 'HTTP_502', null) },
          { name: 'an undecodable body', error: () => new SyntaxError('Unexpected token < in JSON') },
        ];
        for (const failure of FAILURES) {
          it(`keeps reading the shown run when an older read answers after a newer one failed with ${failure.name}`, async () => {
            vi.useFakeTimers();
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const answers: Array<(detail: BootstrapOperationDetail) => void> = [];
            // Read 1 is slow and holds the verdict from before the change; read 2 (started by the next change) fails; later reads say not ready.
            vi.mocked(fetchBootstrapOperation)
              .mockImplementationOnce(() => new Promise((resolve) => { answers.push(resolve); }))
              .mockRejectedValueOnce(failure.error())
              .mockResolvedValue(enrolled('not_ready', { readiness: readiness('not_ready', NOT_READY_GATES) }));
            const { result } = renderHook(() => useBootstrapOperation({ open: true }));
            act(() => result.current.show(enrolled('ready')));
            await trigger.fire();
            await settle(trigger.waitMs);
            expect(answers).toHaveLength(1);
            await trigger.fire();
            await settle(trigger.waitMs);
            expect(fetchBootstrapOperation).toHaveBeenCalledTimes(2);
            await act(async () => { answers[0](enrolled('ready')); });
            await settle(0);
            // The late answer is the newest the hub gave, so it is shown, but it does not end the recovery.
            expect(result.current.operation?.readiness?.state).toBe('ready');
            // Nothing newer has answered, and no further event comes: the run is read again on its own until one read lands.
            for (let tick = 0; tick < 3; tick += 1) await settle(SETTLE_POLL_MS);
            expect(vi.mocked(fetchBootstrapOperation).mock.calls.length).toBeGreaterThanOrEqual(3);
            expect(result.current.operation?.readiness?.state).toBe('not_ready');
            // Once a read that began after the failed one answered, it stops.
            const reads = vi.mocked(fetchBootstrapOperation).mock.calls.length;
            await settle(SETTLE_POLL_MS * 4);
            expect(vi.mocked(fetchBootstrapOperation).mock.calls.length).toBe(reads);
            warn.mockRestore();
          });
        }

        it('does not keep reading the run when an older read fails after a newer one answered', async () => {
          vi.useFakeTimers();
          const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
          const fails: Array<(error: Error) => void> = [];
          vi.mocked(fetchBootstrapOperation)
            .mockImplementationOnce(() => new Promise((_resolve, reject) => { fails.push(reject); }))
            .mockResolvedValue(enrolled('not_ready', { readiness: readiness('not_ready', NOT_READY_GATES) }));
          const { result } = renderHook(() => useBootstrapOperation({ open: true }));
          act(() => result.current.show(enrolled('ready')));
          await trigger.fire();
          await settle(trigger.waitMs);
          await trigger.fire();
          await settle(trigger.waitMs);
          expect(fetchBootstrapOperation).toHaveBeenCalledTimes(2);
          expect(result.current.operation?.readiness?.state).toBe('not_ready');
          await act(async () => { fails[0](new TypeError('Failed to fetch')); });
          await settle(SETTLE_POLL_MS * 4);
          // The newer read already answered, so the older failure leaves nothing to recover.
          expect(fetchBootstrapOperation).toHaveBeenCalledTimes(2);
          warn.mockRestore();
        });

        it('reads a run again when its poll was answered after the change, before the run was enrolled', async () => {
          vi.useFakeTimers();
          let answerPoll: (detail: BootstrapOperationDetail) => void = () => {};
          vi.mocked(fetchBootstrapOperation)
            .mockImplementationOnce(() => new Promise((resolve) => { answerPoll = resolve; }))
            .mockResolvedValue(enrolled('provisional'));
          const { result } = renderHook(() => useBootstrapOperation({ open: true }));
          act(() => result.current.show(operation({ state: 'running' })));
          await settle(OPERATION_POLL_MS);
          expect(fetchBootstrapOperation).toHaveBeenCalledTimes(1);
          // The run is not enrolled, so the change finds nothing to read; the poll then answers with a verdict from before it.
          await trigger.fire();
          await settle(trigger.waitMs);
          expect(fetchBootstrapOperation).toHaveBeenCalledTimes(1);
          await act(async () => { answerPoll(enrolled('ready')); });
          await settle(0);
          expect(result.current.operation?.readiness?.state).toBe('provisional');
        });
      });
    }

    it('keeps reading the run when a progress poll that started after an announcement answers after the read it started failed', async () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const answers: Array<(detail: BootstrapOperationDetail) => void> = [];
      // The announcement lands just before the poll starts, so the poll's own check finds no change since it began and starts no
      // read; the announcement's read (half a second later) fails. The poll then answers Ready: that answer is shown, but the poll
      // began before the failed read, so it does not end the recovery, and the run is read again until a read that began after the failure answers.
      vi.mocked(fetchBootstrapOperation)
        .mockImplementationOnce(() => new Promise((resolve) => { answers.push(resolve); }))
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValue(enrolled('not_ready', { readiness: readiness('not_ready', NOT_READY_GATES) }));
      const { result } = renderHook(() => useBootstrapOperation({ open: true }));
      act(() => result.current.show(enrolled('provisional')));
      await settle(SETTLE_POLL_MS - 100);
      announce();
      await settle(100);
      expect(answers).toHaveLength(1);
      await settle(READINESS_REFRESH_DELAY_MS);
      expect(fetchBootstrapOperation).toHaveBeenCalledTimes(2);
      await act(async () => { answers[0](enrolled('ready')); });
      await settle(0);
      for (let tick = 0; tick < 3; tick += 1) await settle(SETTLE_POLL_MS);
      expect(result.current.operation?.readiness?.state).toBe('not_ready');
      warn.mockRestore();
    });

    it('does not keep reading a later page\'s row whose run is gone or whose session ended', async () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const page1 = { operations: [row('first', 'ready'), stoppedRow('held-1')], nextCursor: 'c1' };
      vi.mocked(listBootstrapOperations)
        .mockResolvedValueOnce(page1)
        .mockResolvedValueOnce({ operations: [row('later', 'ready', { nodeId: 8 })], nextCursor: null })
        .mockResolvedValue(page1);
      vi.mocked(fetchBootstrapOperation).mockImplementation(async (id: string) => {
        if (id === 'later') throw new BootstrapApiError('The run does not exist.', 'OPERATION_NOT_FOUND', null);
        return row(id, 'ready');
      });
      const { result } = renderHook(() => useBootstrapOperation({ open: true }));
      await settle(0);
      await act(async () => { await result.current.loadMore(); });
      announce();
      await settle();
      const reads = vi.mocked(fetchBootstrapOperation).mock.calls.length;
      expect(reads).toBe(1);
      // Nothing is owed: a run that is gone will not answer on the next tick either.
      await settle(SETTLE_POLL_MS * 4);
      expect(vi.mocked(fetchBootstrapOperation).mock.calls.length).toBe(reads);
      expect(words(result.current.operations)).toEqual(['first:Ready', 'held-1:Stopped partway', 'later:Ready']);
      warn.mockRestore();
    });

    it('puts a Verify answer on screen when no readiness change arrived while the check ran', async () => {
      vi.useFakeTimers();
      const verify = vi.fn().mockResolvedValue(enrolled('ready'));
      const { result } = renderHook(() => useBootstrapOperation({
        open: true,
        api: { get: fetchBootstrapOperation, list: listBootstrapOperations, cancel: cancelBootstrapOperation, release: releaseBootstrapOperation, verify },
      }));
      act(() => result.current.show(enrolled('not_ready', { readiness: readiness('not_ready', NOT_READY_GATES) })));
      await act(async () => { await result.current.verify(); });
      expect(result.current.operation?.readiness?.state).toBe('ready');
      expect(fetchBootstrapOperation).not.toHaveBeenCalled();
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

describe('release confirmation binding', () => {
  const held = (id: string, targetName: string, host: string, nodeId: number) => operation({
    id,
    targetName,
    host,
    nodeId,
    nodeExists: true,
    state: 'partial',
    error: { code: 'STEP_FAILED', message: '"Install the missing Docker packages" failed (exit 100).' },
    finishedAt: Date.now(),
    agentStarted: false,
    actions: { cancel: false, retry: true, release: true, verify: false },
  });

  it('cannot submit a delayed Release read from an earlier session to a later confirmation', async () => {
    const A = held('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'server-a', 'a.example.com', 11);
    const B = held('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'server-b', 'b.example.com', 12);
    let answerA: (detail: BootstrapOperationDetail) => void = () => undefined;
    let aReads = 0;
    vi.mocked(fetchBootstrapOperation).mockImplementation((id: string) => {
      if (id === A.id) {
        aReads += 1;
        // The second read is the Release refresh; it stays out across the close and the next run.
        if (aReads === 2) return new Promise((resolve) => { answerA = resolve; });
        return Promise.resolve(A);
      }
      return Promise.resolve(B);
    });
    vi.mocked(listBootstrapOperations)
      .mockResolvedValueOnce({ operations: [A], nextCursor: null })
      .mockResolvedValueOnce({ operations: [A, B], nextCursor: null });
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open bootstrap</button>
          <BootstrapServerDialog open={open} onOpenChange={setOpen} />
        </>
      );
    }
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(within(await screen.findByTestId(`bootstrap-run-${A.id}`)).getByRole('button', { name: 'View' }));
    await user.click(within(await screen.findByTestId('bootstrap-run-answer')).getByRole('button', { name: 'Release server' }));
    expect(aReads).toBe(2);

    // The read is still out when the operator closes the dialog, reopens it, and checks run B.
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Open bootstrap' }));
    await user.click(within(await screen.findByTestId(`bootstrap-run-${B.id}`)).getByRole('button', { name: 'View' }));
    await user.click(within(await screen.findByTestId('bootstrap-run-answer')).getByRole('button', { name: 'Release server' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent('b.example.com');

    // A's answer lands last. It cannot replace B's confirmation or its target.
    await act(async () => { answerA(A); });
    expect(screen.getByRole('alertdialog')).toHaveTextContent('b.example.com');
    expect(screen.getByRole('alertdialog')).not.toHaveTextContent('a.example.com');

    vi.mocked(releaseBootstrapOperation).mockResolvedValueOnce({ ...B, active: false, actions: { cancel: false, retry: false, release: false, verify: false } });
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Release server' }));
    await waitFor(() => expect(releaseBootstrapOperation).toHaveBeenCalledWith(B.id));
    expect(releaseBootstrapOperation).not.toHaveBeenCalledWith(A.id);
  });

  it('drops an older Release read that a newer settle read of the same run overtook', async () => {
    vi.useFakeTimers();
    const stopped = { ...held('11111111-1111-4111-8111-111111111111', 'server-a', 'a.example.com', 11), agentStarted: true };
    const enrolled = {
      ...stopped,
      state: 'enrolled' as const,
      active: false,
      error: null,
      actions: { cancel: false, retry: false, release: false, verify: false },
    };
    let answerRelease: (detail: BootstrapOperationDetail) => void = () => undefined;
    let reads = 0;
    vi.mocked(fetchBootstrapOperation).mockImplementation(() => {
      reads += 1;
      // View, the Release refresh (kept out), then the settle poll.
      if (reads === 2) return new Promise((resolve) => { answerRelease = resolve; });
      return Promise.resolve(reads >= 3 ? enrolled : stopped);
    });
    vi.mocked(listBootstrapOperations).mockResolvedValue({ operations: [stopped], nextCursor: null });
    render(<BootstrapServerDialog open onOpenChange={() => {}} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(within(screen.getByTestId(`bootstrap-run-${stopped.id}`)).getByRole('button', { name: 'View' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(within(screen.getByTestId('bootstrap-run-answer')).getByRole('button', { name: 'Release server' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(reads).toBe(2);

    // The settle poll answers first and the run is enrolled; the older Release read must not undo that.
    await act(async () => { await vi.advanceTimersByTimeAsync(SETTLE_POLL_MS); });
    expect(reads).toBe(3);
    expect(screen.getByTestId('bootstrap-run-answer')).toHaveTextContent('Enrolled');
    expect(screen.queryByRole('button', { name: 'Release server' })).not.toBeInTheDocument();
    await act(async () => { answerRelease(stopped); });
    expect(screen.getByTestId('bootstrap-run-answer')).toHaveTextContent('Enrolled');
    expect(screen.queryByRole('button', { name: 'Release server' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('opens the Release confirmation from the newest answer when a settle poll overtook the click', async () => {
    vi.useFakeTimers();
    const stopped = { ...held('11111111-1111-4111-8111-111111111111', 'server-a', 'a.example.com', 11), agentStarted: true };
    // The settle poll answers with the same releasable run and a node that is gone; the click's
    // older answer must not drop the click, and the confirmation must use the poll's newer copy.
    const afterPoll = { ...stopped, nodeExists: false };
    let answerRelease: (detail: BootstrapOperationDetail) => void = () => undefined;
    let reads = 0;
    vi.mocked(fetchBootstrapOperation).mockImplementation(() => {
      reads += 1;
      // View, the Release refresh (kept out), then the settle poll.
      if (reads === 2) return new Promise((resolve) => { answerRelease = resolve; });
      return Promise.resolve(reads >= 3 ? afterPoll : stopped);
    });
    vi.mocked(listBootstrapOperations).mockResolvedValue({ operations: [stopped], nextCursor: null });
    render(<BootstrapServerDialog open onOpenChange={() => {}} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(within(screen.getByTestId(`bootstrap-run-${stopped.id}`)).getByRole('button', { name: 'View' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(within(screen.getByTestId('bootstrap-run-answer')).getByRole('button', { name: 'Release server' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(reads).toBe(2);

    // The settle poll starts after the click's read and answers first with the newer state.
    await act(async () => { await vi.advanceTimersByTimeAsync(SETTLE_POLL_MS); });
    expect(reads).toBe(3);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await act(async () => { answerRelease(stopped); });

    // The click still opens the confirmation, from the poll's newer answer.
    const confirm = screen.getByRole('alertdialog');
    expect(confirm).toHaveTextContent('a.example.com');
    expect(confirm).toHaveTextContent(/node record is no longer in Fleet/);
    expect(screen.getByTestId('bootstrap-run-answer')).toHaveTextContent('Stopped partway');
  });

  it('hands an overtaken open read the newest answer for its run instead of dropping it', async () => {
    vi.useFakeTimers();
    const stopped = { ...held('11111111-1111-4111-8111-111111111111', 'server-a', 'a.example.com', 11), agentStarted: true };
    const afterPoll = { ...stopped, nodeExists: false };
    const answers: Array<(detail: BootstrapOperationDetail) => void> = [];
    vi.mocked(fetchBootstrapOperation).mockImplementation(() => new Promise((resolve) => { answers.push(resolve); }));
    vi.mocked(listBootstrapOperations).mockResolvedValue({ operations: [], nextCursor: null });
    const { result } = renderHook(() => useBootstrapOperation({ open: true }));
    act(() => result.current.show(stopped));
    let read: Promise<BootstrapOperationDetail | null> = Promise.resolve(null);
    act(() => { read = result.current.openOperation(stopped.id); });
    expect(result.current.busy).toBe('open');

    // The settle poll starts after the click's read and answers first with the newer state.
    await act(async () => { await vi.advanceTimersByTimeAsync(SETTLE_POLL_MS); });
    expect(answers).toHaveLength(2);
    await act(async () => { answers[1](afterPoll); });
    expect(result.current.operation?.nodeExists).toBe(false);

    let answered: BootstrapOperationDetail | null = null;
    await act(async () => { answers[0](stopped); answered = await read; });
    expect(answered).toMatchObject({ id: stopped.id, nodeExists: false });
    expect(result.current.operation?.nodeExists).toBe(false);
    expect(result.current.busy).toBeNull();
  });

  it('drops a late open read that a newer open overtook, so View cannot land on another run', async () => {
    const a = held('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'server-a', 'a.example.com', 11);
    const b = held('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'server-b', 'b.example.com', 12);
    const answers = new Map<string, (detail: BootstrapOperationDetail) => void>();
    vi.mocked(fetchBootstrapOperation).mockImplementation((id: string) => new Promise((resolve) => { answers.set(id, resolve); }));
    vi.mocked(listBootstrapOperations).mockResolvedValue({ operations: [], nextCursor: null });
    const { result, rerender } = renderHook(({ open }) => useBootstrapOperation({ open }), { initialProps: { open: true } });
    let readA: Promise<BootstrapOperationDetail | null> = Promise.resolve(null);
    act(() => { readA = result.current.openOperation(a.id); });
    rerender({ open: false });
    rerender({ open: true });
    let readB: Promise<BootstrapOperationDetail | null> = Promise.resolve(null);
    act(() => { readB = result.current.openOperation(b.id); });
    let resultA: BootstrapOperationDetail | null = null;
    let resultB: BootstrapOperationDetail | null = null;
    await act(async () => { answers.get(b.id)?.(b); resultB = await readB; });
    expect(resultB).toMatchObject({ id: b.id });
    expect(result.current.operation?.id).toBe(b.id);
    await act(async () => { answers.get(a.id)?.(a); resultA = await readA; });
    expect(resultA).toBeNull();
    expect(result.current.operation?.id).toBe(b.id);
  });

  it('drops an open read when the dialog closes, before any other run is opened', async () => {
    const a = held('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'server-a', 'a.example.com', 11);
    let answerA: (detail: BootstrapOperationDetail) => void = () => undefined;
    vi.mocked(fetchBootstrapOperation).mockImplementationOnce(() => new Promise((resolve) => { answerA = resolve; }));
    const { result, rerender } = renderHook(({ open }) => useBootstrapOperation({ open }), { initialProps: { open: true } });
    let readA: Promise<BootstrapOperationDetail | null> = Promise.resolve(null);
    act(() => { readA = result.current.openOperation(a.id); });
    expect(result.current.busy).toBe('open');
    rerender({ open: false });
    let resultA: BootstrapOperationDetail | null = a;
    await act(async () => { answerA(a); resultA = await readA; });
    expect(resultA).toBeNull();
    expect(result.current.operation).toBeNull();
    expect(result.current.busy).toBeNull();
  });

  it('does not show an older open while a newer one is still out, and leaves the busy state with the newer one', async () => {
    const a = held('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'server-a', 'a.example.com', 11);
    const b = held('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'server-b', 'b.example.com', 12);
    const answers = new Map<string, (detail: BootstrapOperationDetail) => void>();
    vi.mocked(fetchBootstrapOperation).mockImplementation((id: string) => new Promise((resolve) => { answers.set(id, resolve); }));
    vi.mocked(listBootstrapOperations).mockResolvedValue({ operations: [], nextCursor: null });
    const { result } = renderHook(() => useBootstrapOperation({ open: true }));
    let readA: Promise<BootstrapOperationDetail | null> = Promise.resolve(null);
    let readB: Promise<BootstrapOperationDetail | null> = Promise.resolve(null);
    act(() => { readA = result.current.openOperation(a.id); });
    act(() => { readB = result.current.openOperation(b.id); });
    let resultA: BootstrapOperationDetail | null = null;
    await act(async () => { answers.get(a.id)?.(a); resultA = await readA; });
    expect(resultA).toBeNull();
    expect(result.current.operation).toBeNull();
    // A's answer did not clear the busy state the newer read owns.
    expect(result.current.busy).toBe('open');
    let resultB: BootstrapOperationDetail | null = null;
    await act(async () => { answers.get(b.id)?.(b); resultB = await readB; });
    expect(resultB).toMatchObject({ id: b.id });
    expect(result.current.operation?.id).toBe(b.id);
    expect(result.current.busy).toBeNull();
  });

  it('keeps a view opened during an action, and leaves the busy state with that view', async () => {
    const a = held('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'server-a', 'a.example.com', 11);
    const b = held('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'server-b', 'b.example.com', 12);
    let answerCancel: (detail: BootstrapOperationDetail) => void = () => undefined;
    let answerB: (detail: BootstrapOperationDetail) => void = () => undefined;
    vi.mocked(cancelBootstrapOperation).mockImplementationOnce(() => new Promise((resolve) => { answerCancel = resolve; }));
    vi.mocked(fetchBootstrapOperation).mockImplementationOnce(() => new Promise((resolve) => { answerB = resolve; }));
    vi.mocked(listBootstrapOperations).mockResolvedValue({ operations: [], nextCursor: null });
    const { result, rerender } = renderHook(({ open }) => useBootstrapOperation({ open }), { initialProps: { open: true } });
    act(() => result.current.show(a));
    let cancel: Promise<void> = Promise.resolve();
    act(() => { cancel = result.current.cancel(); });
    expect(result.current.busy).toBe('cancel');
    rerender({ open: false });
    act(() => result.current.show(null));
    rerender({ open: true });
    let readB: Promise<BootstrapOperationDetail | null> = Promise.resolve(null);
    act(() => { readB = result.current.openOperation(b.id); });
    expect(result.current.busy).toBe('open');
    // The cancel answer for A lands while B is still being read.
    await act(async () => { answerCancel(a); await cancel; });
    expect(result.current.operation).toBeNull();
    expect(result.current.busy).toBe('open');
    let resultB: BootstrapOperationDetail | null = null;
    await act(async () => { answerB(b); resultB = await readB; });
    expect(resultB).toMatchObject({ id: b.id });
    expect(result.current.operation?.id).toBe(b.id);
  });

  it('keeps an action busy state when an older open read answers', async () => {
    const a = held('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'server-a', 'a.example.com', 11);
    let answerOpen: (detail: BootstrapOperationDetail) => void = () => undefined;
    vi.mocked(fetchBootstrapOperation).mockImplementationOnce(() => new Promise((resolve) => { answerOpen = resolve; }));
    vi.mocked(cancelBootstrapOperation).mockImplementationOnce(() => new Promise(() => undefined));
    const { result } = renderHook(() => useBootstrapOperation({ open: true }));
    act(() => result.current.show(a));
    let read: Promise<BootstrapOperationDetail | null> = Promise.resolve(null);
    act(() => { read = result.current.openOperation(a.id); });
    act(() => { void result.current.cancel(); });
    expect(result.current.busy).toBe('cancel');
    await act(async () => { answerOpen(a); await read; });
    expect(result.current.busy).toBe('cancel');
  });

  it('does not release a run other than the one on screen', async () => {
    const a = held('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'server-a', 'a.example.com', 11);
    const b = held('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'server-b', 'b.example.com', 12);
    const { result } = renderHook(() => useBootstrapOperation({ open: true }));
    act(() => result.current.show(a));
    await act(async () => { await result.current.release(b.id); });
    expect(releaseBootstrapOperation).not.toHaveBeenCalled();
    expect(result.current.operation?.id).toBe(a.id);
  });

  it('closes the confirmation when the run is replaced or stops offering Release', async () => {
    const op = held('11111111-1111-4111-8111-111111111111', 'server-a', 'a.example.com', 11);
    const onRelease = vi.fn();
    const step = (shown: BootstrapOperationDetail) => (
      <BootstrapRunStep operation={shown} busy={null} onCancel={vi.fn()} onRetry={vi.fn()} onRelease={onRelease} onRefresh={async () => shown} onVerify={vi.fn()} />
    );
    const user = userEvent.setup();
    const { rerender } = render(step(op));
    await user.click(screen.getByRole('button', { name: 'Release server' }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('a.example.com');

    rerender(step({ ...op, actions: { ...op.actions, release: false } }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());

    // A later answer that offers Release again does not reopen the old confirmation.
    rerender(step(op));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    // A fresh click checks the run again and opens a new confirmation.
    await user.click(screen.getByRole('button', { name: 'Release server' }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('a.example.com');
    rerender(step({ ...op, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', targetName: 'server-b', host: 'b.example.com' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(onRelease).not.toHaveBeenCalled();
  });

  it('updates the Fleet sentence when the node leaves Fleet while the confirmation is open', async () => {
    const op = held('11111111-1111-4111-8111-111111111111', 'server-a', 'a.example.com', 11);
    const step = (shown: BootstrapOperationDetail) => (
      <BootstrapRunStep operation={shown} busy={null} onCancel={vi.fn()} onRetry={vi.fn()} onRelease={vi.fn()} onRefresh={async () => shown} onVerify={vi.fn()} />
    );
    const user = userEvent.setup();
    const { rerender } = render(step(op));
    await user.click(screen.getByRole('button', { name: 'Release server' }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(/node record stays in Fleet/);
    rerender(step({ ...op, nodeExists: false }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent(/node record is no longer in Fleet/);
  });

  it('does not call unknown Fleet membership a deletion, and still offers Release', async () => {
    const unknown = { ...STOPPED, nodeId: 4, nodeExists: null };
    vi.mocked(listBootstrapOperations).mockResolvedValue({ operations: [unknown], nextCursor: null });
    vi.mocked(fetchBootstrapOperation).mockResolvedValue(unknown);
    const user = userEvent.setup();
    render(<BootstrapServerDialog open onOpenChange={() => {}} />);
    await user.click(within(await screen.findByTestId(`bootstrap-run-${unknown.id}`)).getByRole('button', { name: 'View' }));
    await user.click(within(await screen.findByTestId('bootstrap-run-answer')).getByRole('button', { name: 'Release server' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent(/hub did not report whether the node record is still in Fleet/);
    expect(confirm).not.toHaveTextContent(/stays in Fleet/);
    expect(confirm).not.toHaveTextContent(/no longer in Fleet/);
    await user.click(within(confirm).getByRole('button', { name: 'Release server' }));
    await waitFor(() => expect(releaseBootstrapOperation).toHaveBeenCalledWith(unknown.id));
  });
});
