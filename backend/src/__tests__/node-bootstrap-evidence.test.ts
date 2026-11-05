import { describe, it, expect } from 'vitest';
import { buildBootstrapEvidence, DENIED_FILESYSTEMS } from '../services/nodeBootstrap/evidence';
import { makeFacts } from './__helpers__/bootstrapFacts';
import type { BootstrapCheck, BootstrapFacts } from '../services/nodeBootstrap/types';

function evidence(facts: BootstrapFacts, nodeNameTaken = false) {
  return buildBootstrapEvidence({ facts, nodeNameTaken, targetName: 'media-server' });
}

function check(facts: BootstrapFacts, id: BootstrapCheck['id']): BootstrapCheck {
  const row = evidence(facts).checks.find((entry) => entry.id === id);
  if (!row) throw new Error(`missing check ${id}`);
  return row;
}

describe('bootstrap evidence: healthy host', () => {
  it('returns no blockers and no warnings for a clean host', () => {
    const result = evidence(makeFacts());
    expect(result.blockers).toBe(0);
    expect(result.warnings).toBe(0);
    expect(result.planSuppressed).toBe(false);
    expect(result.checks.find((entry) => entry.id === 'compose_dir')?.status).toBe('pass');
    expect(result.checks.find((entry) => entry.id === 'agent_dir')?.status).toBe('pass');
  });

  it('carries a remediation on every non-pass row', () => {
    const result = evidence(makeFacts({
      composeDir: { rootComposeFile: true, mode: '0777' },
      agentDir: { probeError: 'inventory failed' },
      dockerRoot: { freeBytes: 1024 ** 3 },
      hub: { url: 'http://sencho.example.com', reachable: false },
      clockSkewMs: 120_000,
    }));
    for (const row of result.checks) {
      if (row.status !== 'pass') {
        expect(row.remediation, `${row.id} is ${row.status}`).toBeTruthy();
      }
    }
  });
});

describe('bootstrap evidence: compose directory', () => {
  it('inventories existing stacks and leaves them alone', () => {
    const facts = makeFacts({
      composeDir: { stackCount: 3, stackNames: ['media', 'tools', 'web'] },
    });
    const row = check(facts, 'compose_dir');
    expect(row.status).toBe('pass');
    expect(row.summary).toContain('3 existing stacks');
  });

  it('passes when a missing directory can be created, warns on an ancestor symlink', () => {
    const creatable = makeFacts({ composeDir: { exists: false, isDirectory: false, realPath: '/srv/stacks', nearestExistingAncestor: '/srv' } });
    expect(check(creatable, 'compose_dir').status).toBe('pass');
    const symlinked = makeFacts({ composeDir: { exists: false, isDirectory: false, realPath: '/srv/stacks', hasSymlinkAncestor: true } });
    expect(check(symlinked, 'compose_dir').status).toBe('warn');
  });

  it('blocks when neither the user nor sudo can create it', () => {
    const facts = makeFacts({
      user: { name: 'ubuntu', uid: 1000, group: 'ubuntu', isRoot: false, sudoNonInteractive: false },
      composeDir: { exists: false, isDirectory: false, parentWritableByUser: false },
    });
    expect(check(facts, 'compose_dir').status).toBe('blocked');
  });

  it('blocks a file, a final symlink and a denied resolved path', () => {
    expect(check(makeFacts({ composeDir: { isDirectory: false } }), 'compose_dir').status).toBe('blocked');
    expect(check(makeFacts({ composeDir: { isFinalSymlink: true } }), 'compose_dir').status).toBe('blocked');
    expect(check(makeFacts({ composeDir: { realPath: '/etc/stacks' } }), 'compose_dir').status).toBe('blocked');
  });

  it('blocks an unreadable directory and warns about root-only write or world-writable mode', () => {
    expect(check(makeFacts({ composeDir: { readableByUser: false } }), 'compose_dir').status).toBe('blocked');
    expect(check(makeFacts({ composeDir: { writableByUser: false, writableBySudo: true } }), 'compose_dir').status).toBe('warn');
    expect(check(makeFacts({ composeDir: { writableByUser: false, writableBySudo: false } }), 'compose_dir').status).toBe('blocked');
    expect(check(makeFacts({ composeDir: { mode: '0777' } }), 'compose_dir').status).toBe('warn');
  });

  it('warns when the chosen directory holds a single compose project', () => {
    expect(check(makeFacts({ composeDir: { rootComposeFile: true } }), 'compose_dir').status).toBe('warn');
  });

  it('reports a probe failure as unknown and suppresses the plan', () => {
    const result = evidence(makeFacts({ composeDir: { probeError: 'stat failed' } }));
    expect(result.checks.find((entry) => entry.id === 'compose_dir')?.status).toBe('unknown');
    expect(result.planSuppressed).toBe(true);
  });
});

describe('bootstrap evidence: agent directory', () => {
  it('reuses an empty existing directory', () => {
    const row = check(makeFacts({ agentDir: { exists: true, isDirectory: true, writableByUser: true, readableByUser: true, realPath: '/opt/sencho-agent', entries: [] } }), 'agent_dir');
    expect(row.status).toBe('pass');
  });

  it('recognises our own previous attempt as a warning', () => {
    const facts = makeFacts({
      agentDir: {
        exists: true,
        isDirectory: true,
        writableByUser: true,
        readableByUser: true,
        realPath: '/opt/sencho-agent',
        entries: ['compose.yaml', 'sencho-bootstrap.json'],
        hasMarker: true,
        hasComposeFile: true,
        markerProject: 'sencho-agent',
        markerComposeDir: '/opt/docker/sencho',
        markerAgentDir: '/opt/sencho-agent',
      },
    });
    expect(check(facts, 'agent_dir').status).toBe('warn');
  });

  it('blocks unrelated content and a marker for other paths', () => {
    const unrelated = makeFacts({ agentDir: { exists: true, isDirectory: true, writableByUser: true, entries: ['notes.txt'] } });
    expect(check(unrelated, 'agent_dir').status).toBe('blocked');

    const otherProject = makeFacts({
      agentDir: {
        exists: true,
        isDirectory: true,
        writableByUser: true,
        entries: ['sencho-bootstrap.json'],
        hasMarker: true,
        markerProject: 'another-project',
        markerComposeDir: '/srv/other',
        markerAgentDir: '/opt/sencho-agent',
      },
    });
    expect(check(otherProject, 'agent_dir').status).toBe('blocked');
  });

  it('blocks when unreadable or not writable', () => {
    expect(check(makeFacts({ agentDir: { probeError: 'find failed' } }), 'agent_dir').status).toBe('unknown');
    expect(check(makeFacts({ agentDir: { exists: true, isDirectory: true, entries: [], writableByUser: false } }), 'agent_dir').status).toBe('blocked');
  });
});

describe('bootstrap evidence: separation, persistence and disk', () => {
  it('blocks equal and nested paths', () => {
    const equal = makeFacts({ agentDir: { input: '/opt/docker/sencho', normalized: '/opt/docker/sencho', realPath: '/opt/docker/sencho' } });
    expect(check(equal, 'path_separation').status).toBe('blocked');
    const nested = makeFacts({ agentDir: { input: '/opt/docker/sencho/agent', normalized: '/opt/docker/sencho/agent', realPath: '/opt/docker/sencho/agent' } });
    expect(check(nested, 'path_separation').status).toBe('blocked');
  });

  it('blocks a volatile or network filesystem on either path', () => {
    for (const type of ['tmpfs', 'nfs', 'overlay', 'fuse.sshfs', '9p']) {
      expect(DENIED_FILESYSTEMS.some((denied) => denied.endsWith('.*') ? type.startsWith(denied.slice(0, -2)) : denied === type)).toBe(true);
      const facts = makeFacts({ composeDir: { filesystem: { type, source: 'none', mountPoint: '/mnt' }, mountInFstab: true } });
      expect(check(facts, 'path_persistence').status).toBe('blocked');
    }
  });

  it('warns about a separate mount that is not in fstab and reports unknown when unreadable', () => {
    const separate = makeFacts({
      composeDir: { filesystem: { type: 'ext4', source: '/dev/sdb1', mountPoint: '/mnt/stacks' }, mountInFstab: false },
    });
    expect(check(separate, 'path_persistence').status).toBe('warn');
    const unreadable = makeFacts({ composeDir: { filesystem: null } });
    expect(check(unreadable, 'path_persistence').status).toBe('unknown');
  });

  it('applies the stricter threshold when both paths share a filesystem', () => {
    const facts = makeFacts({
      composeDir: { freeBytes: 3 * 1024 ** 3 },
      agentDir: { freeBytes: 3 * 1024 ** 3 },
    });
    expect(check(facts, 'disk_space').status).toBe('warn');
    const under = makeFacts({
      composeDir: { freeBytes: 1024 ** 3 },
      agentDir: { freeBytes: 1024 ** 3 },
    });
    expect(check(under, 'disk_space').status).toBe('blocked');
  });

  it('checks the agent and Docker root separately', () => {
    const separateAgent = (freeBytes: number) => ({
      agentDir: {
        freeBytes,
        filesystem: { type: 'ext4', source: '/dev/sdc1', mountPoint: '/mnt/agent' },
        mountInFstab: true,
      },
    });
    expect(check(makeFacts(separateAgent(700 * 1024 ** 2)), 'disk_space').status).toBe('warn');
    expect(check(makeFacts(separateAgent(100 * 1024 ** 2)), 'disk_space').status).toBe('blocked');
    expect(check(makeFacts({ dockerRoot: { freeBytes: 1024 ** 3 } }), 'disk_space').status).toBe('blocked');
    expect(check(makeFacts({ dockerRoot: { freeBytes: null } }), 'disk_space').status).toBe('unknown');
  });
});

describe('bootstrap evidence: conflicts and network', () => {
  it('blocks an existing Pilot project or compose file at the default path', () => {
    const project = makeFacts({
      agent: {
        projectContainers: [{ name: 'sencho-agent', workingDir: '/opt/sencho-agent', configFiles: null, image: 'saelix/sencho:latest', status: 'Up' }],
        dataVolumeExists: true,
        defaultDirHasComposeFile: false,
      },
    });
    expect(check(project, 'agent_conflict').status).toBe('blocked');
    expect(check(makeFacts({ agent: { defaultDirHasComposeFile: true } }), 'agent_conflict').status).toBe('blocked');
  });

  it('warns about a data volume without a project and reports unknown when unreadable', () => {
    expect(check(makeFacts({ agent: { dataVolumeExists: true } }), 'agent_conflict').status).toBe('warn');
    expect(check(makeFacts({ agent: { dataVolumeExists: null } }), 'agent_conflict').status).toBe('unknown');
  });

  it('blocks a non-root user without sudo when any planned stage needs it', () => {
    const noSudo = {
      name: 'ubuntu',
      uid: 1000,
      group: 'ubuntu',
      isRoot: false,
      sudoNonInteractive: false,
    };
    const repoMissing = makeFacts({
      user: noSudo,
      docker: { cliInstalled: false, serverVersion: null, composeVersion: null, socketAccess: 'none' },
      repo: { dockerSourceConfigured: false, keyringPresent: false, sourceVerified: false, keyringVerified: false },
    });
    const row = check(repoMissing, 'sudo');
    expect(row.status).toBe('blocked');
    expect(row.summary).toMatch(/administrator privileges/i);

    const packagesMissing = makeFacts({
      user: noSudo,
      docker: { cliInstalled: false, serverVersion: null, composeVersion: null, socketAccess: 'none' },
      packages: [
        { name: 'docker-ce', installedVersion: null, candidateVersion: '1' },
        { name: 'docker-ce-cli', installedVersion: null, candidateVersion: '1' },
        { name: 'containerd.io', installedVersion: null, candidateVersion: '1' },
        { name: 'docker-buildx-plugin', installedVersion: null, candidateVersion: '1' },
        { name: 'docker-compose-plugin', installedVersion: null, candidateVersion: '1' },
      ],
    });
    expect(check(packagesMissing, 'sudo').status).toBe('blocked');

    const serviceStopped = makeFacts({
      user: noSudo,
      docker: { serviceActive: false, serviceEnabled: false },
    });
    expect(check(serviceStopped, 'sudo').status).toBe('blocked');
  });

  it('blocks a taken node name', () => {
    const result = evidence(makeFacts(), true);
    expect(result.checks.find((entry) => entry.id === 'node_name')?.status).toBe('blocked');
    expect(result.blockers).toBeGreaterThan(0);
  });

  it('handles hub URL validity, loopback, plain HTTP and reachability', () => {
    expect(check(makeFacts({ hub: { url: 'http://sencho.example.com' } }), 'hub_url').status).toBe('warn');
    expect(check(makeFacts({ hub: { url: 'http://localhost:1852' } }), 'hub_url').status).toBe('blocked');
    expect(check(makeFacts({ hub: { url: 'not a url' } }), 'hub_url').status).toBe('blocked');
    expect(check(makeFacts({ hub: { reachable: false } }), 'hub_reachable').status).toBe('blocked');
    expect(check(makeFacts({ hub: { tlsTrusted: false } }), 'hub_reachable').status).toBe('warn');
    expect(check(makeFacts({ hub: { reachable: null } }), 'hub_reachable').status).toBe('unknown');
  });

  it('blocks an unsupported OS or architecture and reports unreadable facts as unknown', () => {
    expect(check(makeFacts({ os: { id: 'debian', versionId: '12', codename: 'bookworm', prettyName: 'Debian 12', arch: 'x86_64', kernel: '6.1' } }), 'os_supported').status).toBe('blocked');
    expect(check(makeFacts({ os: { id: 'ubuntu', versionId: '24.04', codename: 'noble', prettyName: '', arch: 'aarch64', kernel: '6.8' } }), 'arch_supported').status).toBe('blocked');
    expect(check(makeFacts({ os: null }), 'os_supported').status).toBe('unknown');
    expect(check(makeFacts({ clockSkewMs: null }), 'clock_skew').status).toBe('unknown');
  });
});

describe('bootstrap evidence: incomplete and unknown facts fail closed', () => {
  it('blocks an unreadable Agent directory even when it is writable', () => {
    const facts = makeFacts({
      agentDir: { exists: true, isDirectory: true, writableByUser: true, readableByUser: false, entries: [] },
    });
    expect(check(facts, 'agent_dir').status).toBe('blocked');
  });

  it('does not treat a failed Compose inventory as an empty directory', () => {
    const result = evidence(makeFacts({ composeDir: { inventoryError: 'exited 1' } }));
    expect(result.checks.find((entry) => entry.id === 'compose_dir')?.status).toBe('unknown');
    expect(result.planSuppressed).toBe(true);
  });

  it('blocks known Agent content from a partial inventory and suppresses an unknown empty result', () => {
    const partial = evidence(makeFacts({ agentDir: { exists: true, isDirectory: true, writableByUser: true, readableByUser: true, inventoryError: 'truncated', entries: ['notes.txt'] } }));
    expect(partial.checks.find((entry) => entry.id === 'agent_dir')?.status).toBe('blocked');

    const unknown = evidence(makeFacts({ agentDir: { exists: true, isDirectory: true, writableByUser: true, readableByUser: true, inventoryError: 'timed out', entries: [] } }));
    expect(unknown.checks.find((entry) => entry.id === 'agent_dir')?.status).toBe('unknown');
    expect(unknown.planSuppressed).toBe(true);
  });

  it('treats an incomplete container inventory as an unknown Pilot conflict', () => {
    const result = evidence(makeFacts({ containers: { complete: false, error: 'output truncated' } }));
    expect(result.checks.find((entry) => entry.id === 'agent_conflict')?.status).toBe('unknown');
    expect(result.checks.find((entry) => entry.id === 'existing_workloads')?.status).toBe('unknown');
    expect(result.planSuppressed).toBe(true);
  });

  it('suppresses the plan when a mandatory platform, privilege, storage or network fact is unknown', () => {
    const cases: BootstrapFacts[] = [
      makeFacts({ os: null }),
      makeFacts({ user: null }),
      makeFacts({ dockerRoot: { freeBytes: null } }),
      makeFacts({ composeDir: { filesystem: null } }),
      makeFacts({ hub: { reachable: null, statusCode: null, tlsTrusted: null } }),
      makeFacts({ clockSkewMs: null }),
    ];
    for (const facts of cases) {
      const result = evidence(facts);
      expect(result.planSuppressed, JSON.stringify(result.checks.filter((entry) => entry.status === 'unknown'))).toBe(true);
    }
  });

  it('does not issue a plan when the Docker daemon cannot be established', () => {
    const result = evidence(makeFacts({
      docker: { cliInstalled: true, serverVersion: null, serviceActive: null, socketAccess: 'none' },
    }));
    expect(result.blockers > 0 || result.planSuppressed).toBe(true);
  });
});

describe('bootstrap evidence: working Docker and repository provenance', () => {
  const missingPackages = [
    { name: 'docker-ce' as const, installedVersion: null, candidateVersion: null },
    { name: 'docker-ce-cli' as const, installedVersion: null, candidateVersion: null },
    { name: 'containerd.io' as const, installedVersion: null, candidateVersion: null },
    { name: 'docker-buildx-plugin' as const, installedVersion: null, candidateVersion: null },
    { name: 'docker-compose-plugin' as const, installedVersion: null, candidateVersion: null },
  ];

  it('preserves a working distribution Docker instead of treating missing official packages as a blocker', () => {
    const result = evidence(makeFacts({
      packages: missingPackages,
      repo: { dockerSourceConfigured: false, keyringPresent: false, sourceVerified: false, keyringVerified: false },
    }));
    const source = result.checks.find((entry) => entry.id === 'apt_source');
    expect(source?.status).toBe('warn');
    expect(source?.summary).toMatch(/preserves the existing installation/i);
    expect(result.blockers).toBe(0);
    expect(result.planSuppressed).toBe(false);
  });

  it('blocks a Docker-named source that points somewhere else', () => {
    const result = evidence(makeFacts({
      docker: { cliInstalled: false, serverVersion: null, composeVersion: null, socketAccess: 'none' },
      repo: {
        dockerSourceConfigured: true,
        keyringPresent: true,
        sourceVerified: false,
        keyringVerified: true,
        candidateSourceVerified: null,
        problem: '/etc/apt/sources.list.d/docker.list: the source points at https://example.com/linux/ubuntu',
      },
    }));
    expect(result.checks.find((entry) => entry.id === 'apt_source')?.status).toBe('blocked');
    expect(result.planSuppressed).toBe(false);
  });

  it('keeps an unreadable source or keyring unknown', () => {
    const result = evidence(makeFacts({
      docker: { cliInstalled: false, serverVersion: null, composeVersion: null, socketAccess: 'none' },
      repo: {
        dockerSourceConfigured: true,
        keyringPresent: false,
        sourceVerified: null,
        keyringVerified: null,
        candidateSourceVerified: null,
        problem: '/etc/apt/sources.list.d/docker.list could not be read',
      },
    }));
    expect(result.checks.find((entry) => entry.id === 'apt_source')?.status).toBe('unknown');
    expect(result.planSuppressed).toBe(true);
  });

  it('names the retained canonical Compose volume', () => {
    const result = evidence(makeFacts({
      agent: { dataVolumeExists: true, dataVolumeNames: ['sencho-agent_sencho-agent-data'] },
    }));
    const row = result.checks.find((entry) => entry.id === 'agent_conflict');
    expect(row?.status).toBe('warn');
    expect(row?.observed).toBe('sencho-agent_sencho-agent-data');
  });
});

describe('bootstrap evidence: fresh hosts and repository probe completeness', () => {
  const missingPackages: BootstrapFacts['packages'] = [
    { name: 'docker-ce', installedVersion: null, candidateVersion: null },
    { name: 'docker-ce-cli', installedVersion: null, candidateVersion: null },
    { name: 'containerd.io', installedVersion: null, candidateVersion: null },
    { name: 'docker-buildx-plugin', installedVersion: null, candidateVersion: null },
    { name: 'docker-compose-plugin', installedVersion: null, candidateVersion: null },
  ];

  it('does not suppress the plan on a fresh host with no Docker and no Docker volume', () => {
    const result = evidence(makeFacts({
      docker: {
        cliInstalled: false,
        serverVersion: null,
        composeVersion: null,
        serviceActive: false,
        serviceEnabled: false,
        socketAccess: 'none',
      },
      packages: missingPackages,
      repo: {
        probeComplete: true,
        dockerSourceConfigured: false,
        keyringPresent: false,
        sourceVerified: false,
        keyringVerified: false,
        candidateSourceVerified: null,
        problem: null,
      },
      agent: { dataVolumeExists: false },
    }));
    expect(result.checks.find((entry) => entry.id === 'agent_conflict')?.status).toBe('pass');
    expect(result.planSuppressed).toBe(false);
  });

  it('suppresses a plan when the repository probe did not complete', () => {
    const result = evidence(makeFacts({
      docker: { cliInstalled: false, serverVersion: null, composeVersion: null, socketAccess: 'none' },
      packages: missingPackages,
      repo: {
        probeComplete: false,
        dockerSourceConfigured: false,
        keyringPresent: false,
        sourceVerified: null,
        keyringVerified: null,
        candidateSourceVerified: null,
        problem: 'the repository probe did not complete',
      },
    }));
    expect(result.checks.find((entry) => entry.id === 'apt_source')?.status).toBe('unknown');
    expect(result.planSuppressed).toBe(true);
  });

  it('reports a symlinked directory with a failed inventory as unknown, not a warning', () => {
    const result = evidence(makeFacts({
      composeDir: { hasSymlinkAncestor: true, inventoryError: 'exited 1' },
    }));
    expect(result.checks.find((entry) => entry.id === 'compose_dir')?.status).toBe('unknown');
    expect(result.planSuppressed).toBe(true);
  });

  it('does not claim candidate provenance when none was observed', () => {
    const result = evidence(makeFacts({
      repo: {
        probeComplete: true,
        dockerSourceConfigured: true,
        keyringPresent: true,
        sourceVerified: true,
        keyringVerified: true,
        candidateSourceVerified: null,
        problem: null,
      },
    }));
    const row = result.checks.find((entry) => entry.id === 'apt_source');
    expect(row?.status).toBe('pass');
    expect(row?.summary).not.toMatch(/candidate provenance/i);
  });
});
