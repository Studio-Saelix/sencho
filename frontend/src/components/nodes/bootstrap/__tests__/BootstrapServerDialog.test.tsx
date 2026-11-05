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
    expect(screen.getAllByText(new RegExp(CHANGED_KEY.fingerprint)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/SHA256:livechangedkey/).length).toBeGreaterThan(0);
    const run = screen.getByRole('button', { name: 'Run preflight' });
    expect(run).toBeDisabled();
    await user.click(screen.getByLabelText(/I understand this replaces the pinned key/));
    expect(run).toBeEnabled();
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
    });
  });
});
