import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/clipboard', () => ({ copyToClipboard: vi.fn(async () => {}) }));
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BootstrapPlanStep } from '../BootstrapPlanStep';
import type { BootstrapInspection, BootstrapPlan } from '../types';

const composeDir = {
  input: '/srv/sencho-stacks', normalized: '/srv/sencho-stacks', realPath: '/srv/sencho-stacks', exists: true,
  isDirectory: true, isFinalSymlink: false, hasSymlinkAncestor: false, owner: 'ubuntu', group: 'ubuntu', mode: '755',
  readableByUser: true, writableByUser: true, writableBySudo: true, parentWritableByUser: true,
  nearestExistingAncestor: null, filesystem: null, freeBytes: null, probeError: null,
  stackCount: 3, stackNames: ['media', 'tools', 'web'], inventoryTruncated: false, inventoryError: null, rootComposeFile: false,
};
const agentDir = {
  input: '/srv/sencho-agent', normalized: '/srv/sencho-agent', realPath: '/srv/sencho-agent', exists: false,
  isDirectory: false, isFinalSymlink: false, hasSymlinkAncestor: false, owner: null, group: null, mode: null,
  readableByUser: false, writableByUser: false, writableBySudo: false, parentWritableByUser: true,
  nearestExistingAncestor: '/srv', filesystem: null, freeBytes: null, probeError: null,
  entries: [], entriesTruncated: false, inventoryError: null, hasComposeFile: false, hasCaFile: false, hasMarker: false,
  markerProject: null, markerComposeDir: null, markerAgentDir: null,
};

const inspection = {
  observedAt: 1,
  target: { host: 'server.example.com', port: 22, username: 'ubuntu', address: '192.168.1.50' },
  hostKey: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:abc', knownHostsLine: 'line' },
  paths: { composeDir, agentDir },
  agent: { projectContainers: [], dataVolumeExists: false, dataVolumeNames: [], defaultDirHasComposeFile: false },
  dockerRoot: { path: '/var/lib/docker', freeBytes: 1, filesystemType: 'ext4' },
  checks: [],
  blockers: 0,
  warnings: 1,
} as BootstrapInspection;

const plan: BootstrapPlan = {
  version: 1,
  generatedAt: 1,
  target: { host: 'server.example.com', port: 22, username: 'ubuntu', address: '192.168.1.50' },
  targetName: 'media-server',
  hostKeyFingerprint: 'SHA256:abc',
  hubUrl: 'https://sencho.example.com',
  paths: {
    composeDir: { input: '/srv/sencho-stacks', realPath: '/srv/sencho-stacks', exists: true, created: false, stackCount: 3 },
    agentDir: { input: '/srv/sencho-agent', realPath: '/srv/sencho-agent', exists: false, created: true },
  },
  projectName: 'sencho-agent',
  containerName: 'sencho-agent',
  dataVolume: 'sencho-agent-data',
  image: { ref: 'saelix/sencho:latest', digest: null, resolvedAt: 'execution' },
  stages: [
    {
      id: 'agent_dir',
      title: 'Pilot Agent installation directory',
      steps: [{
        id: 'create-agent-dir',
        title: 'Create the Agent installation directory',
        rationale: 'The agent keeps its compose file in a dedicated directory.',
        effect: 'directory-create',
        privilege: 'user',
        command: "sh -c 'set -eu ...' sencho-mkdir '/srv/sencho-agent' '0700' 'ubuntu' 'ubuntu' '0' '/srv/sencho-agent' '64768:2:1000:-'",
        target: { path: '/srv/sencho-agent', mode: '0700', owner: 'ubuntu', group: 'ubuntu', preserveExisting: false },
        disruptive: false,
        reversible: 'yes',
        pointOfNoReturn: false,
        timeoutMs: 10_000,
      }],
    },
    {
      id: 'agent_project',
      title: 'Agent files',
      steps: [{
        id: 'agent-compose-file',
        title: 'Write the Pilot compose file',
        rationale: 'The agent runs from this file.',
        effect: 'file-write',
        privilege: 'sudo',
        command: null,
        target: { path: '/srv/sencho-agent/compose.yaml', mode: '0600', owner: 'root', group: 'root', preserveExisting: false },
        file: { path: '/srv/sencho-agent/compose.yaml', mode: '0600', content: 'name: sencho-agent\nSENCHO_ENROLL_TOKEN: {{SENCHO_ENROLL_TOKEN}}', redacted: true },
        disruptive: false,
        reversible: 'yes',
        pointOfNoReturn: false,
        timeoutMs: 10_000,
      }],
    },
    {
      id: 'agent_start',
      title: 'Start the Pilot agent',
      steps: [{
        id: 'start-agent',
        title: 'Start the sencho-agent project',
        rationale: 'Pinned project name.',
        effect: 'container-start',
        privilege: 'sudo',
        command: "env -u DOCKER_HOST docker compose --project-name sencho-agent up -d",
        disruptive: true,
        reversible: 'yes',
        pointOfNoReturn: true,
        timeoutMs: 300_000,
      }],
    },
  ],
  skipped: [
    { id: 'compose_dir', reason: 'Existing directory preserved; 3 stacks found; ownership and mode unchanged.' },
    { id: 'docker_service', reason: 'The Docker service is active and enabled at boot.' },
  ],
  sources: [],
  versions: {},
  redactions: [{ placeholder: '{{SENCHO_ENROLL_TOKEN}}', purpose: 'Minted at execution.' }],
  verification: [{ id: 'project-exists', title: 'The sencho-agent project exists', expected: 'docker compose ls lists it', slice: 'S2' }],
  notices: ['No changes have been made on this server.', '3 existing stack folders in /srv/sencho-stacks will be left untouched.'],
  evidenceDigest: 'a'.repeat(64),
  digest: 'b'.repeat(64),
};

describe('BootstrapPlanStep', () => {
  it('renders both paths and the preserved directory reason', () => {
    render(<BootstrapPlanStep plan={plan} inspection={inspection} />);
    expect(screen.getAllByText('/srv/sencho-stacks').length).toBeGreaterThan(0);
    expect(screen.getAllByText('/srv/sencho-agent').length).toBeGreaterThan(0);
    expect(screen.getByText(/Existing directory preserved; 3 stacks found/)).toBeInTheDocument();
  });

  it('shows stages in execution order and every no-change row', () => {
    render(<BootstrapPlanStep plan={plan} inspection={inspection} />);
    const headings = screen.getAllByRole('heading', { level: 4 }).map((heading) => heading.textContent);
    expect(headings.slice(0, 3)).toEqual([
      '1. Pilot Agent installation directory',
      '2. Agent files',
      '3. Start the Pilot agent',
    ]);
    expect(screen.getByText(/sencho-mkdir '\/srv\/sencho-agent' '0700'/)).toBeInTheDocument();
    expect(screen.getByText(/mode 0700/)).toBeInTheDocument();
    expect(screen.getByText('user · mode 0700 · ubuntu:ubuntu')).toBeInTheDocument();
    expect(screen.getByText(/The Docker service is active and enabled at boot/)).toBeInTheDocument();
  });

  it('shows the evidence digest and generated metadata', () => {
    render(<BootstrapPlanStep plan={plan} inspection={inspection} />);
    expect(screen.getByText(/Evidence digest sha256:a{64}/)).toBeInTheDocument();
    expect(screen.getByText(/hub https:\/\/sencho\.example\.com/)).toBeInTheDocument();
  });

  it('shows the compose file content with the token placeholder', async () => {
    const user = userEvent.setup();
    render(<BootstrapPlanStep plan={plan} inspection={inspection} />);
    await user.click(screen.getByText(/view content/));
    expect(screen.getByText(/SENCHO_ENROLL_TOKEN: \{\{SENCHO_ENROLL_TOKEN\}\}/)).toBeInTheDocument();
  });

  it('shows the start command, digest and the no-change line', () => {
    render(<BootstrapPlanStep plan={plan} inspection={inspection} />);
    expect(screen.getByText(/--project-name sencho-agent/)).toBeInTheDocument();
    expect(screen.getByText(`sha256:${plan.digest}`)).toBeInTheDocument();
    expect(screen.getByText('No changes have been made on this server.')).toBeInTheDocument();
  });

  it('lists the expected checks separately from evidence', () => {
    render(<BootstrapPlanStep plan={plan} inspection={inspection} />);
    expect(screen.getByText('Expected after execution')).toBeInTheDocument();
    expect(screen.getByText('The sencho-agent project exists')).toBeInTheDocument();
    expect(screen.getByText('run')).toBeInTheDocument();
  });

  it('copies the plan to the clipboard', async () => {
    const user = userEvent.setup();
    const { copyToClipboard } = await import('@/lib/clipboard');
    render(<BootstrapPlanStep plan={plan} inspection={inspection} />);
    await user.click(screen.getByRole('button', { name: /Copy plan/ }));
    expect(copyToClipboard).toHaveBeenCalledTimes(1);
    const text = vi.mocked(copyToClipboard).mock.calls[0][0];
    expect(text).toContain(`Plan digest: sha256:${plan.digest}`);
    expect(text).toContain(`Evidence digest: sha256:${plan.evidenceDigest}`);
    expect(text).toContain('Not changed:');
    expect(text).toContain('The Docker service is active and enabled at boot.');
    expect(text).toContain('Existing directory preserved; 3 stacks found; ownership and mode unchanged.');
    expect(text).toContain('name: sencho-agent');
    expect(text).toContain('Image: saelix/sencho:latest (digest resolved at execution)');
    expect(text).not.toMatch(/execution,\s*execution/);
  });
});
