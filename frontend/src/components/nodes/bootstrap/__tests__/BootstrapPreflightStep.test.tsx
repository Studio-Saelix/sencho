import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BootstrapPreflightStep } from '../BootstrapPreflightStep';
import { BootstrapPathSummary } from '../BootstrapPathSummary';
import type { AgentDirFacts, BootstrapCheck, BootstrapInspection, ComposeDirFacts } from '../types';

const composeDir: ComposeDirFacts = {
  input: '/opt/docker/sencho', normalized: '/opt/docker/sencho', realPath: '/opt/docker/sencho', exists: true,
  isDirectory: true, isFinalSymlink: false, hasSymlinkAncestor: false, owner: 'ubuntu', group: 'ubuntu', mode: '755',
  readableByUser: true, writableByUser: true, writableBySudo: true, parentWritableByUser: true,
  nearestExistingAncestor: null, filesystem: null, freeBytes: null, probeError: null,
  stackCount: 3, stackNames: [], inventoryTruncated: false, inventoryError: null, rootComposeFile: false,
};

const agentDir: AgentDirFacts = {
  input: '/opt/sencho-agent', normalized: '/opt/sencho-agent', realPath: '/opt/sencho-agent', exists: true,
  isDirectory: true, isFinalSymlink: false, hasSymlinkAncestor: false, owner: 'ubuntu', group: 'ubuntu', mode: '755',
  readableByUser: true, writableByUser: true, writableBySudo: true, parentWritableByUser: true,
  nearestExistingAncestor: null, filesystem: null, freeBytes: null, probeError: null,
  entries: ['a', 'b'], entriesTruncated: false, inventoryError: null, hasComposeFile: false, hasCaFile: false,
  hasMarker: false, markerProject: null, markerComposeDir: null, markerAgentDir: null,
};

function inspection(checks: BootstrapCheck[], blockers = 0): BootstrapInspection {
  return {
    observedAt: 1,
    target: { host: 'server.example.com', port: 22, username: 'ubuntu', address: '192.168.1.50' },
    hostKey: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:abc', knownHostsLine: 'line' },
    paths: { composeDir, agentDir },
    agent: { projectContainers: [], dataVolumeExists: false, dataVolumeNames: [], defaultDirHasComposeFile: false },
    dockerRoot: { path: '/var/lib/docker', freeBytes: 1, filesystemType: 'ext4' },
    checks,
    blockers,
    warnings: 0,
  };
}

const unknownCheck: BootstrapCheck = {
  id: 'agent_conflict',
  category: 'conflicts',
  label: 'Existing Pilot agent',
  status: 'unknown',
  summary: 'The container inventory could not be completed (timed out).',
  remediation: 'Confirm on the host that no sencho-agent container is running, then run the preflight again.',
} as BootstrapCheck;

function renderStep(props: Partial<React.ComponentProps<typeof BootstrapPreflightStep>> = {}) {
  return render(
    <BootstrapPreflightStep
      inspection={inspection([unknownCheck])}
      blocked
      hostKeyTrust="trusted"
      pinnedFingerprint={null}
      trusted
      onTrustedChange={vi.fn()}
      replacing={false}
      onReplaceRequest={vi.fn()}
      {...props}
    />,
  );
}

describe('BootstrapPreflightStep with facts that could not be established', () => {
  it('lists each unknown fact and its remediation when they alone withhold the plan', () => {
    renderStep();
    expect(screen.getByText(/1 check could not be established, so no plan can be generated/)).toBeInTheDocument();
    const list = screen.getByTestId('bootstrap-unknown-checks');
    expect(list).toHaveTextContent('Existing Pilot agent');
    expect(list).toHaveTextContent('The container inventory could not be completed');
    expect(list).toHaveTextContent('Confirm on the host that no sencho-agent container is running');
    expect(screen.queryByText('Blockers')).not.toBeInTheDocument();
  });

  it('does not repeat the list when the plan is available', () => {
    renderStep({ blocked: false });
    expect(screen.queryByTestId('bootstrap-unknown-checks')).not.toBeInTheDocument();
  });

  it('offers a pin-free wording when the changed key was never pinned', () => {
    renderStep({ hostKeyTrust: 'changed', pinnedFingerprint: null, trusted: false });
    expect(screen.getByText(/differs from the key you reviewed/)).toBeInTheDocument();
    expect(screen.queryByText(/differs from the pinned key/)).not.toBeInTheDocument();
  });

  it('keeps the pinned wording when a pin exists', () => {
    renderStep({ hostKeyTrust: 'changed', pinnedFingerprint: 'SHA256:old', trusted: false });
    expect(screen.getByText(/differs from the pinned key/)).toBeInTheDocument();
    expect(screen.getByText(/Pinned: SHA256:old/)).toBeInTheDocument();
  });
});

describe('BootstrapPathSummary with uninspected directories', () => {
  it('shows unknown instead of a zero count when an inventory failed', () => {
    render(<BootstrapPathSummary
      composeDir={{ ...composeDir, stackCount: null, inventoryError: 'timed out' }}
      agentDir={{ ...agentDir, entries: [], inventoryError: 'exited 1' }}
    />);
    expect(screen.getByText(/stack count unknown/)).toBeInTheDocument();
    expect(screen.getByText(/contents unknown/)).toBeInTheDocument();
    expect(screen.queryByText(/0 stacks/)).not.toBeInTheDocument();
  });

  it('shows the inspection failure instead of a will-be-created claim', () => {
    render(<BootstrapPathSummary
      composeDir={{ ...composeDir, exists: false, probeError: 'stat: Permission denied' }}
      agentDir={{ ...agentDir, probeError: 'realpath' }}
    />);
    expect(screen.getAllByText(/inspection failed/)).toHaveLength(2);
    expect(screen.getAllByText('Unknown')).toHaveLength(2);
    expect(screen.queryByText('Will be created')).not.toBeInTheDocument();
  });

  it('counts known entries and stacks plainly', () => {
    render(<BootstrapPathSummary composeDir={composeDir} agentDir={agentDir} />);
    expect(screen.getByText(/3 stacks/)).toBeInTheDocument();
    expect(screen.getByText(/2 entries/)).toBeInTheDocument();
  });
});
