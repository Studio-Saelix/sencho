import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BootstrapServerDialog } from '../BootstrapServerDialog';
import {
  BootstrapApiError,
  FALLBACK_CAPABILITIES,
  checkBootstrapHostKey,
  fetchBootstrapCapabilities,
  runBootstrapPreflight,
} from '../bootstrapApi';
import type { BootstrapHostKeyResult, BootstrapPreflightResult } from '../types';

vi.mock('../bootstrapApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../bootstrapApi')>();
  return {
    ...actual,
    fetchBootstrapCapabilities: vi.fn(),
    checkBootstrapHostKey: vi.fn(),
    runBootstrapPreflight: vi.fn(),
  };
});

const CHANGED_KEY: BootstrapHostKeyResult = {
  host: 'server.example.com',
  port: 22,
  address: '192.168.1.50',
  algorithm: 'ssh-ed25519',
  fingerprint: 'SHA256:observednewkey000000000000000000000000',
  knownHostsLine: 'server.example.com ssh-ed25519 AAAA',
  trust: 'changed',
  pinnedFingerprint: 'SHA256:pinnedoldkey00000000000000000000000000',
};

const BLOCKED_RESULT: BootstrapPreflightResult = {
  inspection: {
    observedAt: Date.now(),
    target: { host: 'server.example.com', port: 22, username: 'ubuntu', address: '192.168.1.50' },
    hostKey: { algorithm: 'ssh-ed25519', fingerprint: CHANGED_KEY.fingerprint, knownHostsLine: 'line' },
    paths: {
      composeDir: {
        input: '/opt/docker/sencho', normalized: '/opt/docker/sencho', realPath: '/opt/docker/sencho', exists: true,
        isDirectory: true, isFinalSymlink: false, hasSymlinkAncestor: false, owner: 'ubuntu', group: 'ubuntu', mode: '755',
        readableByUser: true, writableByUser: true, writableBySudo: true, parentWritableByUser: true,
        nearestExistingAncestor: null, filesystem: { type: 'ext4', source: '/dev/sda1', mountPoint: '/' },
        freeBytes: 1, probeError: null, stackCount: 0, stackNames: [], inventoryTruncated: false,
        inventoryError: null, rootComposeFile: false,
      },
      agentDir: {
        input: '/opt/sencho-agent', normalized: '/opt/sencho-agent', realPath: '/opt/sencho-agent', exists: false,
        isDirectory: false, isFinalSymlink: false, hasSymlinkAncestor: false, owner: null, group: null, mode: null,
        readableByUser: false, writableByUser: false, writableBySudo: false, parentWritableByUser: true,
        nearestExistingAncestor: '/opt', filesystem: { type: 'ext4', source: '/dev/sda1', mountPoint: '/' },
        freeBytes: 1, probeError: null, entries: [], entriesTruncated: false, inventoryError: null,
        hasComposeFile: false, hasCaFile: false, hasMarker: false, markerProject: null, markerComposeDir: null, markerAgentDir: null,
      },
    },
    agent: { projectContainers: [], dataVolumeExists: false, dataVolumeNames: [], defaultDirHasComposeFile: false },
    dockerRoot: { path: '/var/lib/docker', freeBytes: 1, filesystemType: 'ext4' },
    checks: [],
    blockers: 0,
    warnings: 0,
  },
  plan: null,
  blocked: true,
};

async function fillTarget() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Node name'), 'media-server');
  await user.type(screen.getByLabelText('Host'), 'server.example.com');
  await user.clear(screen.getByLabelText('SSH port'));
  await user.type(screen.getByLabelText('SSH port'), '22');
  await user.clear(screen.getByLabelText('SSH user'));
  await user.type(screen.getByLabelText('SSH user'), 'ubuntu');
  await user.type(screen.getByLabelText('Private key'), '-----BEGIN OPENSSH PRIVATE KEY-----key');
  return user;
}

beforeEach(() => {
  vi.mocked(fetchBootstrapCapabilities).mockResolvedValue(FALLBACK_CAPABILITIES);
  vi.mocked(checkBootstrapHostKey).mockResolvedValue(CHANGED_KEY);
  vi.mocked(runBootstrapPreflight).mockResolvedValue(BLOCKED_RESULT);
});

describe('BootstrapServerDialog new host trust decision', () => {
  it('shows the compare command and the public key line before the host is trusted', async () => {
    vi.mocked(checkBootstrapHostKey).mockResolvedValue({
      ...CHANGED_KEY,
      trust: 'unknown',
      pinnedFingerprint: null,
      knownHostsLine: 'server.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexample',
    });
    render(<BootstrapServerDialog open onOpenChange={() => {}} />);
    const user = await fillTarget();
    await user.click(screen.getByRole('button', { name: 'Check host key' }));

    const trust = await screen.findByLabelText(/I trust this host key/);
    expect(trust).not.toBeChecked();
    expect(screen.getByText(/ssh-keygen -lf \/etc\/ssh\/ssh_host_ed25519_key\.pub/)).toBeInTheDocument();
    // The line is what a .pub file holds: algorithm and key, without the host.
    expect(screen.getByTestId('host-key-line')).toHaveTextContent('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexample');
    expect(screen.getByTestId('host-key-line')).not.toHaveTextContent('server.example.com');
  });

  it('points an RSA host key at the RSA key file', async () => {
    vi.mocked(checkBootstrapHostKey).mockResolvedValue({
      ...CHANGED_KEY,
      trust: 'unknown',
      pinnedFingerprint: null,
      algorithm: 'ssh-rsa',
      knownHostsLine: 'server.example.com ssh-rsa AAAAB3NzaC1yc2E',
    });
    render(<BootstrapServerDialog open onOpenChange={() => {}} />);
    const user = await fillTarget();
    await user.click(screen.getByRole('button', { name: 'Check host key' }));

    await screen.findByLabelText(/I trust this host key/);
    expect(screen.getByText(/ssh_host_rsa_key\.pub/)).toBeInTheDocument();
    expect(screen.queryByText(/ssh_host_ed25519_key\.pub/)).not.toBeInTheDocument();
  });

  it('shows the compare command with the observed key when the pin was changed', async () => {
    render(<BootstrapServerDialog open onOpenChange={() => {}} />);
    const user = await fillTarget();
    await user.click(screen.getByRole('button', { name: 'Check host key' }));

    await screen.findByLabelText(/I understand this replaces the pinned key/);
    expect(screen.getByText(/ssh-keygen -lf \/etc\/ssh\/ssh_host_ed25519_key\.pub/)).toBeInTheDocument();
    expect(screen.getByTestId('host-key-line')).toHaveTextContent('ssh-ed25519 AAAA');
  });
});

describe('BootstrapServerDialog live host-key mismatch', () => {
  it('shows the pin and observed key and requires confirmation before another run', async () => {
    vi.mocked(checkBootstrapHostKey).mockResolvedValue({ ...CHANGED_KEY, trust: 'trusted', pinnedFingerprint: CHANGED_KEY.fingerprint });
    vi.mocked(runBootstrapPreflight).mockRejectedValueOnce(new BootstrapApiError(
      'The host key changed before the preflight connected.',
      'HOST_KEY_UNTRUSTED',
      null,
      {
        pinnedFingerprint: CHANGED_KEY.fingerprint,
        expectedFingerprint: CHANGED_KEY.fingerprint,
        observedFingerprint: 'SHA256:livechangedkey0000000000000000000000000',
      },
    ));
    render(<BootstrapServerDialog open onOpenChange={() => {}} />);
    const user = await fillTarget();
    await user.click(screen.getByRole('button', { name: 'Check host key' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run preflight' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Run preflight' }));

    await waitFor(() => expect(screen.getByText(/The host key changed before the preflight connected/)).toBeInTheDocument());
    // The live observation carries no public key line, only the fingerprint.
    expect(screen.queryByTestId('host-key-line')).not.toBeInTheDocument();
    expect(screen.getAllByText(/ssh-keygen -lf/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(new RegExp(CHANGED_KEY.fingerprint)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/SHA256:livechangedkey/).length).toBeGreaterThan(0);
    const run = screen.getByRole('button', { name: 'Run preflight' });
    expect(run).toBeDisabled();
    await user.click(screen.getByLabelText(/I understand this replaces the pinned key/));
    expect(run).toBeEnabled();
  });
});

describe('BootstrapServerDialog live key change on a host with no pin', () => {
  const REVIEWED = 'SHA256:reviewedkey0000000000000000000000000';
  const LIVE = 'SHA256:livechangedkey0000000000000000000000000';

  it('shows both keys, asks for first trust of the new one, and pins it without a replacement', async () => {
    vi.mocked(checkBootstrapHostKey).mockResolvedValue({
      ...CHANGED_KEY, trust: 'unknown', pinnedFingerprint: null, fingerprint: REVIEWED,
    });
    vi.mocked(runBootstrapPreflight).mockRejectedValueOnce(new BootstrapApiError(
      'The host key changed before the preflight connected.',
      'HOST_KEY_UNTRUSTED',
      null,
      { pinnedFingerprint: null, expectedFingerprint: REVIEWED, observedFingerprint: LIVE, observedAlgorithm: 'ssh-ed25519' },
    ));
    render(<BootstrapServerDialog open onOpenChange={() => {}} />);
    const user = await fillTarget();
    await user.click(screen.getByRole('button', { name: 'Check host key' }));
    await user.click(await screen.findByLabelText('I trust this host key.'));
    await user.click(screen.getByRole('button', { name: 'Run preflight' }));

    const notice = await screen.findByTestId('host-key-changed-since-review');
    expect(notice).toHaveTextContent(`Reviewed: ${REVIEWED}`);
    expect(notice).toHaveTextContent(`Observed now: ${LIVE}`);
    expect(notice).toHaveTextContent('No key is pinned for this host yet');
    // Nothing is pinned, so nothing may be described as replaced.
    expect(screen.queryByText(/replaces the pinned key/)).not.toBeInTheDocument();
    expect(screen.queryByText(/differs from the pinned key/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Pinned:/)).not.toBeInTheDocument();

    // The earlier consent covered the reviewed key, so a fresh one is required.
    const run = screen.getByRole('button', { name: 'Run preflight' });
    expect(run).toBeDisabled();
    const consent = screen.getByLabelText('I trust the new host key and want it pinned for this host.');
    expect(consent).not.toBeChecked();
    await user.click(consent);
    expect(run).toBeEnabled();
    await user.click(run);

    await waitFor(() => expect(runBootstrapPreflight).toHaveBeenCalledTimes(2));
    expect(vi.mocked(runBootstrapPreflight).mock.calls[1][0]).toMatchObject({
      expectedFingerprint: LIVE,
      replacePinnedFingerprint: null,
      reviewedPinnedFingerprint: null,
    });
    // A trusted key is pinned, so the prompt and its notice are gone.
    await waitFor(() => expect(screen.queryByLabelText(/I trust the new host key/)).not.toBeInTheDocument());
    expect(screen.queryByTestId('host-key-changed-since-review')).not.toBeInTheDocument();
    expect(await screen.findByText('This key matches the pin for this host.')).toBeInTheDocument();
  });
});

describe('BootstrapServerDialog preflight pin mismatch', () => {
  it('keeps the keyscan fingerprint, shows the pin, and sends the confirmed replacement', async () => {
    vi.mocked(checkBootstrapHostKey).mockResolvedValue({ ...CHANGED_KEY, trust: 'trusted', pinnedFingerprint: CHANGED_KEY.fingerprint });
    vi.mocked(runBootstrapPreflight).mockRejectedValueOnce(new BootstrapApiError(
      'The host key does not match the pinned key.',
      'HOST_KEY_MISMATCH',
      null,
      {
        pinnedFingerprint: 'SHA256:pinnedchanged0000000000000000000000000',
        expectedFingerprint: CHANGED_KEY.fingerprint,
      },
    ));
    render(<BootstrapServerDialog open onOpenChange={() => {}} />);
    const user = await fillTarget();
    await user.click(screen.getByRole('button', { name: 'Check host key' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run preflight' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Run preflight' }));

    await waitFor(() => expect(screen.getAllByText(/SHA256:pinnedchanged/).length).toBeGreaterThan(0));
    expect(screen.getAllByText(new RegExp(CHANGED_KEY.fingerprint)).length).toBeGreaterThan(0);
    const run = screen.getByRole('button', { name: 'Run preflight' });
    expect(run).toBeDisabled();
    await user.click(screen.getByLabelText(/I understand this replaces the pinned key/));
    expect(run).toBeEnabled();
    await user.click(run);
    await waitFor(() => expect(runBootstrapPreflight).toHaveBeenCalledTimes(2));
    // The confirmation names the pin the server reported as current, not the stale scan.
    expect(vi.mocked(runBootstrapPreflight).mock.calls[1][0]).toMatchObject({
      expectedFingerprint: CHANGED_KEY.fingerprint,
      replacePinnedFingerprint: CHANGED_KEY.fingerprint,
      reviewedPinnedFingerprint: 'SHA256:pinnedchanged0000000000000000000000000',
    });
  });
});

describe('BootstrapServerDialog changed host key', () => {
  it('shows both fingerprints and requires an explicit replacement before the preflight runs', async () => {
    render(<BootstrapServerDialog open onOpenChange={() => {}} />);
    const user = await fillTarget();

    await user.click(screen.getByRole('button', { name: 'Check host key' }));
    await waitFor(() => expect(screen.getByText(new RegExp(CHANGED_KEY.pinnedFingerprint!))).toBeInTheDocument());
    expect(screen.getAllByText(new RegExp(CHANGED_KEY.fingerprint)).length).toBeGreaterThan(0);

    const run = screen.getByRole('button', { name: 'Run preflight' });
    expect(run).toBeDisabled();

    await user.click(screen.getByLabelText(/I understand this replaces the pinned key/));
    expect(run).toBeEnabled();
    await user.click(run);

    await waitFor(() => expect(runBootstrapPreflight).toHaveBeenCalledTimes(1));
    expect(vi.mocked(runBootstrapPreflight).mock.calls[0][0]).toMatchObject({
      expectedFingerprint: CHANGED_KEY.fingerprint,
      replacePinnedFingerprint: CHANGED_KEY.fingerprint,
      reviewedPinnedFingerprint: CHANGED_KEY.pinnedFingerprint,
    });
  });
});

describe('BootstrapServerDialog stale-result banner', () => {
  async function reachResult() {
    vi.mocked(checkBootstrapHostKey).mockResolvedValue({ ...CHANGED_KEY, trust: 'trusted', pinnedFingerprint: CHANGED_KEY.fingerprint });
    render(<BootstrapServerDialog open onOpenChange={() => {}} />);
    const user = await fillTarget();
    await user.click(screen.getByRole('button', { name: 'Check host key' }));
    await user.click(await screen.findByRole('button', { name: 'Run preflight' }));
    await waitFor(() => expect(runBootstrapPreflight).toHaveBeenCalledTimes(1));
    await user.click(await screen.findByRole('button', { name: 'Back' }));
    return user;
  }

  it('says the SSH target changed, not the paths, after the host is edited', async () => {
    const user = await reachResult();
    await user.type(screen.getByLabelText('Host'), 'x');
    expect(await screen.findByText(/The SSH target changed\. The previous host key check, preflight and plan no longer apply/)).toBeInTheDocument();
    expect(screen.queryByText(/Paths changed/)).not.toBeInTheDocument();
  });

  it('drops the SSH target banner once the host key was checked again', async () => {
    const user = await reachResult();
    await user.type(screen.getByLabelText('Host'), 'x');
    expect(await screen.findByText(/The SSH target changed\./)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Host'), '{Backspace}');
    await user.click(screen.getByRole('button', { name: 'Check host key' }));
    expect(await screen.findByRole('button', { name: 'Run preflight' })).toBeInTheDocument();
    expect(screen.queryByText(/The SSH target changed\./)).not.toBeInTheDocument();
  });

  it('shows the key banner again after the host key check when the key was edited before the host', async () => {
    const user = await reachResult();
    await user.type(screen.getByLabelText('Private key'), 'x');
    await user.type(screen.getByLabelText('Host'), 'x');
    expect(await screen.findByText(/The SSH target changed\./)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Host'), '{Backspace}');
    await user.click(screen.getByRole('button', { name: 'Check host key' }));
    expect(await screen.findByText(/The SSH key changed\. The previous preflight and plan no longer apply/)).toBeInTheDocument();
    expect(screen.queryByText(/The SSH target changed\./)).not.toBeInTheDocument();
  });

  it('says the SSH key changed after the private key is edited', async () => {
    const user = await reachResult();
    await user.type(screen.getByLabelText('Private key'), 'x');
    expect(await screen.findByText(/The SSH key changed\./)).toBeInTheDocument();
    expect(screen.queryByText(/Paths changed/)).not.toBeInTheDocument();
  });

  it('keeps the paths wording for a directory edit', async () => {
    const user = await reachResult();
    await user.type(screen.getByLabelText('Compose stacks directory'), '2');
    expect(await screen.findByText(/Paths changed\. The previous preflight and plan no longer apply/)).toBeInTheDocument();
  });
});
