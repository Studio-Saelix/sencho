import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  DOCKER_LOCAL_ENDPOINT,
  PATH_FACTS_SCRIPT,
  PILOT_DATA_VOLUME_CANONICAL,
  assembleFacts,
  buildProbeCatalog,
  isReadOnlyProbeCommand,
  parseAgentInventory,
  parseAptPolicy,
  parseBootstrapMarker,
  parseComposeInventory,
  parseContainers,
  parseDfFreeBytes,
  parseDockerInfo,
  buildDockerRepoScript,
  parseDockerRepo,
  parseFstabMountPoints,
  parseHubHealth,
  parsePathFacts,
  parseVolumeNames,
} from '../services/nodeBootstrap/probes';
import { scrubCommandOutput, type SshCommandResult } from '../services/nodeBootstrap/sshProbeClient';
import { DEFAULT_SOURCE_LOCATIONS, DOCKER_ASC_PATH, dockerAscBlock, keyBlock as keyBlockOf } from './__helpers__/dockerRepoFixtures';

const PATH_SCRIPT_OUTPUT = [
  'P_INPUT=/opt/docker/sencho',
  'P_EXISTS=1',
  'P_ISDIR=1',
  'P_FINAL_LINK=0',
  'P_REAL=/opt/docker/sencho',
  'P_ANCESTOR_LINK=0',
  'P_OWNER=ubuntu',
  'P_GROUP=ubuntu',
  'P_MODE=755',
  'P_USER_R=1',
  'P_USER_W=1',
  'P_SUDO_R=1',
  'P_SUDO_W=1',
  'P_NEAREST=/opt/docker/sencho',
  'P_PARENT_W=1',
  'P_FSTYPE=ext4',
  'P_FSSOURCE=/dev/sda1',
  'P_FSTARGET=/',
  'P_DF=/dev/sda1 102400000 20480000 81920000 20% /',
].join('\n');

function result(id: string, stdout: string, exitCode = 0): SshCommandResult {
  return { id, stdout, stderr: '', exitCode, truncated: false, timedOut: false, error: null };
}

describe('bootstrap probe catalog', () => {
  const catalog = buildProbeCatalog({
    composeDir: '/opt/docker/sencho',
    agentDir: '/opt/sencho-agent',
    hubUrl: 'https://sencho.example.com',
  });

  it('contains every command the client sends, and all of them are read-only', () => {
    expect(catalog.length).toBeGreaterThan(20);
    for (const probe of catalog) {
      expect(isReadOnlyProbeCommand(probe.command), `probe ${probe.id}: ${probe.command}`).toBe(true);
    }
  });

  it('never contains a mutating verb or a write redirection', () => {
    const joined = catalog.map((probe) => probe.command).join('\n');
    expect(joined).not.toMatch(/\bmkdir\b/);
    expect(joined).not.toMatch(/\bchmod\b/);
    expect(joined).not.toMatch(/\bchown\b/);
    expect(joined).not.toMatch(/\brm\b/);
    expect(joined).not.toMatch(/docker compose up/);
    expect(joined).not.toMatch(/>>/);
  });

  it('refuses to inventory a resolved path under a denied root', () => {
    for (const id of ['compose_inventory', 'agent_inventory', 'agent_marker']) {
      const command = catalog.find((probe) => probe.id === id)?.command ?? '';
      expect(command, id).toContain('realpath -m');
      expect(command, id).toContain('/etc|/etc/*');
      expect(command, id).toContain('/root|/root/*');
    }
  });

  it('separates repository file contents from the end marker even without a trailing newline', () => {
    const script = buildDockerRepoScript(['/etc/apt/sources.list'], ['/etc/apt/sources.list.d'], []);
    expect(script).toContain("printf '\\nSOURCE_END=%s\\n'");
    expect(script).toContain("printf '\\nSOURCE_UNREADABLE=1\\n'");
  });

  it('quotes both paths once, into the fixed path script', () => {
    const compose = catalog.find((probe) => probe.id === 'path_compose');
    expect(compose?.command).toContain("'/opt/docker/sencho'");
    const agent = catalog.find((probe) => probe.id === 'path_agent');
    expect(agent?.command).toContain("'/opt/sencho-agent'");
  });
});

describe('bootstrap probe parsers', () => {
  it('parses path facts, including owner, mode and free space', () => {
    const facts = parsePathFacts(PATH_SCRIPT_OUTPUT, '/opt/docker/sencho');
    expect(facts.exists).toBe(true);
    expect(facts.isDirectory).toBe(true);
    expect(facts.owner).toBe('ubuntu');
    expect(facts.mode).toBe('755');
    expect(facts.filesystem).toEqual({ type: 'ext4', source: '/dev/sda1', mountPoint: '/' });
    expect(facts.freeBytes).toBe(81920000 * 1024);
    expect(facts.probeError).toBeNull();
  });

  it('distinguishes a missing path from a failed probe', () => {
    const missing = parsePathFacts('P_EXISTS=0\nP_ISDIR=0\nP_REAL=/opt/sencho-agent\nP_NEAREST=/opt\nP_PARENT_W=1', '/opt/sencho-agent');
    expect(missing.exists).toBe(false);
    expect(missing.probeError).toBeNull();
    expect(missing.nearestExistingAncestor).toBe('/opt');

    const failed = parsePathFacts('', '/opt/sencho-agent');
    expect(failed.probeError).toMatch(/no facts/i);

    const denied = parsePathFacts('P_EXISTS=0\nP_ERROR=stat:stat: cannot statx: Permission denied', '/opt/sencho-agent');
    expect(denied.probeError).toMatch(/Permission denied/i);
  });

  it('counts every stack and caps only the displayed names', () => {
    const entries = Array.from({ length: 505 }, (_, index) => `/opt/docker/sencho/stack-${index}/compose.yaml`);
    const summary = parseComposeInventory(entries.join('\0'), '/opt/docker/sencho');
    expect(summary.stackCount).toBe(505);
    expect(summary.truncated).toBe(false);
    expect(summary.stackNames).toHaveLength(50);
  });

  it('parses NUL-delimited stacks at depth 1 and 2 and flags a root compose file', () => {
    const text = [
      '/opt/docker/sencho/media/compose.yaml',
      '/opt/docker/sencho/tools/docker-compose.yml',
      '/opt/docker/sencho/nested/web/compose.yaml',
      '/opt/docker/sencho/compose.yaml',
    ].join('\0');
    const summary = parseComposeInventory(text, '/opt/docker/sencho');
    expect(summary.stackCount).toBe(3);
    expect(summary.stackNames).toEqual(['media', 'nested', 'tools']);
    expect(summary.rootComposeFile).toBe(true);
  });

  it('handles names with spaces and a truncated NUL tail', () => {
    const text = '/opt/docker/sencho/my stack/compose.yaml\0/opt/docker/se';
    const summary = parseComposeInventory(text, '/opt/docker/sencho');
    expect(summary.stackNames).toEqual(['my stack']);
  });

  it('reports a capped output stream as a truncated inventory even under the entry cap', () => {
    const summary = parseComposeInventory('/opt/docker/sencho/media/compose.yaml\0', '/opt/docker/sencho', true);
    expect(summary.truncated).toBe(true);
    expect(summary.stackCount).toBe(1);
    const agent = parseAgentInventory('compose.yaml\0', true);
    expect(agent.entriesTruncated).toBe(true);
  });

  it('parses agent directory entries and the bootstrap marker', () => {
    const inventory = parseAgentInventory('compose.yaml\0sencho-bootstrap.json\0sencho-hub-ca.pem\0');
    expect(inventory.hasComposeFile).toBe(true);
    expect(inventory.hasCaFile).toBe(true);
    const marker = parseBootstrapMarker(JSON.stringify({ project: 'sencho-agent', composeDir: '/opt/docker/sencho', agentDir: '/opt/sencho-agent' }));
    expect(marker.hasMarker).toBe(true);
    expect(marker.markerProject).toBe('sencho-agent');
    expect(parseBootstrapMarker('{not json').hasMarker).toBe(false);
    expect(parseBootstrapMarker('').hasMarker).toBe(false);
  });

  it('parses docker info, apt policy and docker repo state', () => {
    expect(parseDockerInfo('27.3.1|/var/lib/docker')).toEqual({ serverVersion: '27.3.1', rootDir: '/var/lib/docker' });
    expect(parseDockerInfo('garbage')).toBeNull();

    const policy = [
      'docker-ce:',
      '  Installed: (none)',
      '  Candidate: 5:27.3.1-1~ubuntu.24.04~noble',
      'docker-compose-plugin:',
      '  Installed: 2.29.7-1~ubuntu.24.04~noble',
      '  Candidate: 2.29.7-1~ubuntu.24.04~noble',
    ].join('\n');
    const packages = parseAptPolicy(policy);
    expect(packages.find((pkg) => pkg.name === 'docker-ce')).toMatchObject({
      installedVersion: null,
      candidateVersion: '5:27.3.1-1~ubuntu.24.04~noble',
    });
    expect(packages.find((pkg) => pkg.name === 'docker-compose-plugin')?.installedVersion).toBe('2.29.7-1~ubuntu.24.04~noble');

    expect(parseDockerRepo('', '', '')).toEqual({
      probeComplete: true,
      sourceLocations: 'unknown',
      dockerSourceConfigured: false,
      keyringPresent: false,
      sourceVerified: false,
      keyringVerified: false,
      candidateSourceVerified: null,
      problem: 'the locations apt reads its sources from could not be established',
    });
  });

  it('parses containers with missing compose labels', () => {
    const text = [
      'web\tnginx:latest\tweb\t/opt/docker/sencho/web\tUp 2 hours',
      'orphan\tbusybox\t\t\tExited (0)',
    ].join('\n');
    const { rows } = parseContainers(text);
    expect(rows).toHaveLength(2);
    expect(rows[0].project).toBe('web');
    expect(rows[1].project).toBeNull();
  });

  it('parses df output with a mount point that contains a space', () => {
    expect(parseDfFreeBytes('/dev/sdb1 100 50 10485760 1% /mnt/my disk')).toBe(10485760 * 1024);
    expect(parseDfFreeBytes('garbage')).toBeNull();
  });

  it('parses fstab mount points and skips comments', () => {
    const text = ['# comment', 'UUID=abc / ext4 defaults 0 1', '/dev/sdb1 /mnt/data ext4 defaults 0 2'].join('\n');
    expect(parseFstabMountPoints(text)).toEqual(['/', '/mnt/data']);
  });

  it('maps hub health outcomes without treating a TLS failure as a connection failure', () => {
    expect(parseHubHealth(result('hub_health', '200'))).toEqual({ reachable: true, statusCode: 200, tlsTrusted: true });
    expect(parseHubHealth({ ...result('hub_health', '', 60), stderr: 'curl: (60) SSL certificate problem' })).toEqual({
      reachable: true,
      statusCode: null,
      tlsTrusted: false,
    });
    expect(parseHubHealth({ ...result('hub_health', '', 127), stderr: 'curl: not found' }).reachable).toBeNull();
    expect(parseHubHealth(result('hub_health', '', 6)).reachable).toBe(false);
  });
});

describe('bootstrap fact assembly', () => {
  it('assembles a healthy host from the probe output', () => {
    const facts = assembleFacts({
      target: { host: 'server.example.com', port: 22, username: 'ubuntu', address: '192.168.1.50' },
      hostKey: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:abc', knownHostsLine: 'line' },
      hubUrl: 'https://sencho.example.com',
      composeDir: '/opt/docker/sencho',
      agentDir: '/opt/sencho-agent',
      results: [
        result('os_release', 'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\nPRETTY_NAME="Ubuntu 24.04.1 LTS"'),
        result('uname', 'x86_64\n6.8.0-45-generic'),
        result('user', 'ubuntu\n1000\nubuntu'),
        result('sudo', ''),
        result('docker_cli', '/usr/bin/docker'),
        result('docker_info', '27.3.1|/var/lib/docker'),
        result('compose_version', '2.29.7'),
        result('docker_service_active', 'active'),
        result('docker_service_enabled', 'enabled'),
        result('docker_repo', ''),
        result('apt_policy', 'docker-ce:\n  Installed: 1\n  Candidate: 1'),
        result('containers', 'web\tnginx:latest\tweb\t/opt/docker/sencho/web\tUp'),
        result('agent_volume', ''),
        result('clock', String(Math.floor(Date.now() / 1000))),
        result('hub_health', '200'),
        result('path_compose', PATH_SCRIPT_OUTPUT),
        result('path_agent', 'P_EXISTS=0\nP_ISDIR=0\nP_REAL=/opt/sencho-agent\nP_NEAREST=/opt\nP_PARENT_W=1\nP_FSTYPE=ext4\nP_FSTARGET=/'),
        result('compose_inventory', '/opt/docker/sencho/media/compose.yaml\0'),
        result('agent_inventory', ''),
        result('agent_marker', '', 1),
        result('default_agent_path', 'no'),
        result('docker_root_disk', 'D_SOURCE=daemon\nD_ROOT=/var/lib/docker\nD_DF=/dev/sda1 1 1 123456789 1% /'),
        result('fstab', 'UUID=abc / ext4 defaults 0 1'),
      ],
      fstabMountPoints: ['/'],
      now: Date.now(),
    });
    expect(facts.os?.versionId).toBe('24.04');
    expect(facts.user?.sudoNonInteractive).toBe(true);
    expect(facts.docker.serverVersion).toBe('27.3.1');
    expect(facts.paths.composeDir.stackCount).toBe(1);
    expect(facts.paths.agentDir.exists).toBe(false);
    expect(facts.agent.dataVolumeExists).toBe(false);
    expect(facts.dockerRoot.freeBytes).toBe(123456789 * 1024);
    expect(facts.containers.total).toBe(1);
  });
});

function probe(id: string, stdout: string, overrides: Partial<SshCommandResult> = {}): SshCommandResult {
  return { id, stdout, stderr: '', exitCode: 0, truncated: false, timedOut: false, error: null, ...overrides };
}

function minimalAssembly(results: SshCommandResult[]) {
  return assembleFacts({
    target: { host: 'server.example.com', port: 22, username: 'ubuntu', address: '192.168.1.50' },
    hostKey: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:abc', knownHostsLine: 'line' },
    hubUrl: 'https://sencho.example.com',
    composeDir: '/opt/docker/sencho',
    agentDir: '/opt/sencho-agent',
    results,
    fstabMountPoints: ['/'],
    now: 1_762_300_000_000,
  });
}

describe('bootstrap inventory completeness', () => {
  it('finds a Pilot container beyond row 200 and keeps the full count', () => {
    const rows = Array.from({ length: 250 }, (_, index) => {
      const project = index === 220 ? 'sencho-agent' : 'other';
      const name = index === 220 ? 'sencho-agent' : `container-${index}`;
      return `${name}\tnginx:latest\t${project}\t/opt/docker/sencho/${project}\tUp`;
    });
    const facts = minimalAssembly([
      probe('docker_info', '27.3.1|/var/lib/docker'),
      probe('containers', rows.join('\n')),
    ]);
    expect(facts.containers.total).toBe(250);
    expect(facts.containers.complete).toBe(true);
    expect(facts.agent.projectContainers.map((row) => row.name)).toEqual(['sencho-agent']);
  });

  it('marks a truncated container inventory incomplete instead of claiming absence', () => {
    const facts = minimalAssembly([
      probe('docker_info', '27.3.1|/var/lib/docker'),
      probe('containers', 'container-1\tnginx\tother\t/opt/docker/sencho/other\tUp', { truncated: true }),
    ]);
    expect(facts.containers.complete).toBe(false);
    expect(facts.containers.error).toMatch(/truncated/i);
  });

  it('keeps a failed volume inspection unknown instead of reporting no volume', () => {
    const facts = minimalAssembly([
      probe('docker_info', '27.3.1|/var/lib/docker'),
      probe('agent_volume', '', { exitCode: 1 }),
    ]);
    expect(facts.agent.dataVolumeExists).toBeNull();
  });

  it('recognises the canonical project-qualified data volume', () => {
    const facts = minimalAssembly([
      probe('docker_info', '27.3.1|/var/lib/docker'),
      probe('agent_volume', `${PILOT_DATA_VOLUME_CANONICAL}\nsencho-agent-data`),
    ]);
    expect(facts.agent.dataVolumeExists).toBe(true);
    expect(facts.agent.dataVolumeNames).toEqual(['sencho-agent-data', PILOT_DATA_VOLUME_CANONICAL]);
    expect(parseVolumeNames('sencho-agent_other\nsencho-agent_sencho-agent-data')).toEqual([PILOT_DATA_VOLUME_CANONICAL]);
  });

  it('does not turn a failed Compose inventory into an empty stacks root', () => {
    const pathFacts = [
      'P_EXISTS=1', 'P_ISDIR=1', 'P_REAL=/opt/docker/sencho', 'P_FSTYPE=ext4', 'P_FSTARGET=/',
      'P_USER_R=1', 'P_USER_W=1', 'P_PARENT_W=1', 'P_DF=/dev/sda1 1 1 104857600 1% /',
    ].join('\n');
    const facts = minimalAssembly([
      probe('path_compose', pathFacts),
      probe('compose_inventory', '', { exitCode: 1 }),
    ]);
    expect(facts.paths.composeDir.exists).toBe(true);
    expect(facts.paths.composeDir.stackCount).toBeNull();
    expect(facts.paths.composeDir.inventoryError).toMatch(/exited 1/);
  });

  it('uses a successful sudo inventory when the direct one is denied', () => {
    const pathFacts = [
      'P_EXISTS=1', 'P_ISDIR=1', 'P_REAL=/opt/docker/sencho', 'P_FSTYPE=ext4', 'P_FSTARGET=/',
      'P_USER_R=1', 'P_USER_W=1', 'P_PARENT_W=1', 'P_SUDO_R=1', 'P_SUDO_W=1',
    ].join('\n');
    const facts = minimalAssembly([
      probe('path_compose', pathFacts),
      probe('compose_inventory', '', { exitCode: 1 }),
      probe('compose_inventory_sudo', '/opt/docker/sencho/media/compose.yaml\0'),
    ]);
    expect(facts.paths.composeDir.inventoryError).toBeNull();
    expect(facts.paths.composeDir.stackCount).toBe(1);
  });

  it('treats partial and timed-out inventories as incomplete', () => {
    const pathFacts = [
      'P_EXISTS=1', 'P_ISDIR=1', 'P_REAL=/opt/docker/sencho', 'P_FSTYPE=ext4', 'P_FSTARGET=/',
      'P_USER_R=1', 'P_USER_W=1', 'P_PARENT_W=1',
    ].join('\n');
    for (const failure of [{ truncated: true }, { timedOut: true }]) {
      const facts = minimalAssembly([
        probe('path_compose', pathFacts),
        probe('compose_inventory', '/opt/docker/sencho/known/compose.yaml\0', failure),
      ]);
      expect(facts.paths.composeDir.inventoryError).toBeTruthy();
      expect(facts.paths.composeDir.stackCount).toBeNull();
    }
  });

  it('does not turn an unreadable Agent directory into an empty one', () => {
    const pathFacts = [
      'P_EXISTS=1', 'P_ISDIR=1', 'P_REAL=/opt/sencho-agent', 'P_MODE=300', 'P_USER_W=1',
      'P_FSTYPE=ext4', 'P_FSTARGET=/', 'P_PARENT_W=1',
    ].join('\n');
    const facts = minimalAssembly([
      probe('path_agent', pathFacts),
      probe('agent_inventory', '', { exitCode: 1 }),
    ]);
    expect(facts.paths.agentDir.exists).toBe(true);
    expect(facts.paths.agentDir.readableByUser).toBe(false);
    expect(facts.paths.agentDir.inventoryError).toMatch(/exited 1/);
  });

  it('detects every stack before the display-name cap', () => {
    const entries = Array.from({ length: 80 }, (_, index) => `/opt/docker/sencho/stack-${index}/compose.yaml`);
    const summary = parseComposeInventory(entries.join('\0'), '/opt/docker/sencho');
    expect(summary.stackCount).toBe(80);
    expect(summary.stackNames).toHaveLength(50);
    expect(summary.truncated).toBe(false);
  });

  it('preserves NUL-delimited inventory records through transport sanitation', () => {
    const compose = '/opt/docker/sencho/media/compose.yaml\0/opt/docker/sencho/tools/compose.yaml\0';
    const sanitized = scrubCommandOutput(compose);
    expect(sanitized).toBe(compose);
    expect(parseComposeInventory(sanitized, '/opt/docker/sencho').stackNames).toEqual(['media', 'tools']);

    const agent = scrubCommandOutput('compose.yaml\0sencho-bootstrap.json\0sencho-hub-ca.pem\0');
    expect(parseAgentInventory(agent).entries).toEqual(['compose.yaml', 'sencho-bootstrap.json', 'sencho-hub-ca.pem']);
  });
});

describe('bootstrap Docker endpoint pinning', () => {
  it('binds every Docker probe to the local socket and default context', () => {
    const catalog = buildProbeCatalog({
      composeDir: '/opt/docker/sencho',
      agentDir: '/opt/sencho-agent',
      hubUrl: 'https://sencho.example.com',
    });
    const dockerIds = [
      'docker_info', 'docker_info_sudo', 'compose_version', 'compose_version_sudo',
      'containers', 'containers_sudo', 'agent_volume', 'agent_volume_sudo', 'docker_root_disk',
    ];
    for (const id of dockerIds) {
      const command = catalog.find((entry) => entry.id === id)?.command ?? '';
      expect(command, id).toContain(`DOCKER_HOST=${DOCKER_LOCAL_ENDPOINT}`);
      expect(command, id).toContain('DOCKER_CONTEXT=default');
      expect(command, id).toContain('-u DOCKER_HOST');
      expect(command, id).toContain('-u DOCKER_CONTEXT');
      expect(command, id).toContain('-u DOCKER_CONFIG');
      if (id.endsWith('_sudo')) expect(command, id).toContain('sudo -n env ');
      else expect(command, id).toContain('env -u DOCKER_HOST');
    }
    const volume = catalog.find((entry) => entry.id === 'agent_volume')?.command ?? '';
    expect(volume).toContain('[ "$ok" = 1 ]');
    expect(volume).not.toContain('|| true');
  });

  it('reports an unsearchable path as an inspection error, not a missing directory', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sencho-bootstrap-denied-'));
    const blocked = path.join(dir, 'blocked');
    const child = path.join(blocked, 'child');
    try {
      mkdirSync(blocked);
      chmodSync(blocked, 0o400);
      const output = execFileSync('sh', ['-c', PATH_FACTS_SCRIPT, 'sencho-probe', child], { encoding: 'utf8' });
      expect(output).toContain('P_EXISTS=0');
      expect(output).toMatch(/P_ERROR=stat:/);
      expect(parsePathFacts(output, child).probeError).toMatch(/Permission denied/i);
    } finally {
      chmodSync(blocked, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads filesystem facts from the nearest existing ancestor for a missing path', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sencho-bootstrap-path-'));
    try {
      const missing = path.join(dir, 'missing', 'child');
      const output = execFileSync('sh', ['-c', PATH_FACTS_SCRIPT, 'sencho-probe', missing], { encoding: 'utf8' });
      expect(output).toContain('P_EXISTS=0');
      expect(output).toContain(`P_NEAREST=${dir}`);
      expect(parsePathFacts(output, missing).probeError).toBeNull();
      expect(output).toMatch(/P_FSTYPE=\S+/);
      expect(output).toMatch(/P_FSTARGET=\S+/);
      expect(output).toMatch(/P_DF=\S+\s+\d+\s+\d+\s+\d+/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('bootstrap volume and no-Docker facts', () => {
  it('uses the sudo volume inventory when direct Docker access is denied', () => {
    const facts = minimalAssembly([
      probe('docker_cli', '/usr/bin/docker'),
      probe('docker_info_sudo', '27.3.1|/var/lib/docker'),
      probe('agent_volume', '', { exitCode: 1 }),
      probe('agent_volume_sudo', PILOT_DATA_VOLUME_CANONICAL),
    ]);
    expect(facts.docker.socketAccess).toBe('sudo');
    expect(facts.agent.dataVolumeExists).toBe(true);
    expect(facts.agent.dataVolumeNames).toEqual([PILOT_DATA_VOLUME_CANONICAL]);
  });

  it('knows a host without Docker has no Docker volume', () => {
    const facts = minimalAssembly([
      probe('docker_cli', '', { exitCode: 1 }),
      probe('agent_volume', '', { exitCode: 1 }),
    ]);
    expect(facts.docker.cliInstalled).toBe(false);
    expect(facts.agent.dataVolumeExists).toBe(false);
  });

  it('does not infer a missing Docker CLI from a failed probe', () => {
    const facts = minimalAssembly([
      probe('docker_cli', '', { error: 'COMMAND_ERROR' }),
    ]);
    expect(facts.docker.cliProbeUnknown).toBe(true);
    expect(facts.agent.dataVolumeExists).toBeNull();
  });

  it('marks an absent inventory probe as not run', () => {
    const pathFacts = [
      'P_EXISTS=1', 'P_ISDIR=1', 'P_REAL=/opt/docker/sencho', 'P_FSTYPE=ext4', 'P_FSTARGET=/',
      'P_USER_R=1', 'P_USER_W=1', 'P_PARENT_W=1',
    ].join('\n');
    const facts = minimalAssembly([probe('path_compose', pathFacts)]);
    expect(facts.paths.composeDir.inventoryError).toMatch(/not run/i);
    expect(facts.paths.composeDir.stackCount).toBeNull();
  });

  it('marks a truncated repository probe incomplete', () => {
    const facts = minimalAssembly([
      probe('docker_repo', 'SOURCE_BEGIN=/etc/apt/sources.list.d/docker.list\n', { truncated: true }),
    ]);
    expect(facts.repo.probeComplete).toBe(false);
    expect(facts.repo.sourceVerified).toBeNull();
  });
});

describe('bootstrap volume probe execution', () => {
  function runVolumeProbe(dockerBody: string): void {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sencho-volume-probe-'));
    try {
      const bin = path.join(dir, 'bin');
      mkdirSync(bin);
      writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\n${dockerBody}\n`, { mode: 0o755 });
      const catalog = buildProbeCatalog({
        composeDir: '/opt/docker/sencho',
        agentDir: '/opt/sencho-agent',
        hubUrl: 'https://sencho.example.com',
      });
      const command = catalog.find((probe) => probe.id === 'agent_volume')?.command ?? '';
      execFileSync('sh', ['-c', command], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('exits non-zero when Docker cannot be reached', () => {
    expect(() => runVolumeProbe('exit 1')).toThrow();
  });

  it('exits zero when the daemon answers even with no matching volume', () => {
    expect(() => runVolumeProbe('case "$*" in *"volume ls"*) exit 0;; *) exit 1;; esac')).not.toThrow();
  });
});

describe('bootstrap Docker repository provenance', () => {
  const keyBlock = (keyPath = DOCKER_ASC_PATH) => dockerAscBlock(keyPath);
  const listBlock = (sourcePath: string, content: string) => [
    DEFAULT_SOURCE_LOCATIONS,
    `SOURCE_BEGIN=${sourcePath}`,
    content,
    `SOURCE_END=${sourcePath}`,
  ].join('\n');

  it('verifies an official debian .list source and its keyring', () => {
    const output = [
      listBlock('/etc/apt/sources.list.d/docker.list', 'deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable'),
      keyBlock(),
    ].join('\n');
    expect(parseDockerRepo(output, 'noble', 'amd64')).toMatchObject({
      dockerSourceConfigured: true,
      keyringPresent: true,
      sourceVerified: true,
      keyringVerified: true,
    });
  });

  it('verifies an official deb822 .sources source', () => {
    const output = [
      listBlock('/etc/apt/sources.list.d/docker.sources', [
        'Types: deb',
        'URIs: https://download.docker.com/linux/ubuntu',
        'Suites: noble',
        'Components: stable',
        'Signed-By: /etc/apt/keyrings/docker.asc',
      ].join('\n')),
      keyBlock(),
    ].join('\n');
    expect(parseDockerRepo(output, 'noble', 'amd64')).toMatchObject({ sourceVerified: true, keyringVerified: true });
  });

  it('rejects an arbitrary URL and a mismatched suite', () => {
    const arbitrary = parseDockerRepo([
      listBlock('/etc/apt/sources.list.d/docker.list', 'deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://example.com/linux/ubuntu noble stable'),
      keyBlock(),
    ].join('\n'), 'noble', 'amd64');
    expect(arbitrary.sourceVerified).toBe(false);
    expect(arbitrary.problem).toContain('not https://download.docker.com');

    const mismatch = parseDockerRepo([
      listBlock('/etc/apt/sources.list.d/docker.list', 'deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu jammy stable'),
      keyBlock(),
    ].join('\n'), 'noble', 'amd64');
    expect(mismatch.sourceVerified).toBe(false);
    expect(mismatch.problem).toContain('suite');
  });

  it('keeps an unreadable source unknown and rejects a non-key keyring', () => {
    const unreadable = parseDockerRepo([
      'SOURCE_BEGIN=/etc/apt/sources.list.d/docker.list',
      'SOURCE_UNREADABLE=1',
      'SOURCE_END=/etc/apt/sources.list.d/docker.list',
      keyBlock(),
    ].join('\n'), 'noble', 'amd64');
    expect(unreadable.sourceVerified).toBeNull();

    const badKey = parseDockerRepo([
      listBlock('/etc/apt/sources.list.d/docker.list', 'deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable'),
      keyBlockOf(DOCKER_ASC_PATH, Buffer.from('not a pgp key')),
    ].join('\n'), 'noble', 'amd64');
    expect(badKey.keyringVerified).toBe(false);
    expect(badKey.keyringPresent).toBe(true);
  });

  it('rejects a lookalike candidate archive URL', () => {
    const facts = minimalAssembly([
      probe('docker_info', '27.3.1|/var/lib/docker'),
      probe('apt_policy', [
        'docker-ce:',
        '  Installed: 5:27.3.1-1',
        '  Candidate: 5:27.3.1-1\n  Version table:\n     5:27.3.1-1 500',
        '        500 https://download.docker.com.evil.example/linux/ubuntu noble/stable amd64 Packages',
      ].join('\n')),
    ]);
    expect(facts.repo.candidateSourceVerified).toBe(false);
  });

  it('records which archive serves the candidate version', () => {
    const packages = parseAptPolicy([
      'docker-ce:',
      '  Installed: 5:27.3.1-1',
      '  Candidate: 5:27.3.1-1',
      '  Version table:',
      '     5:27.3.1-1 500',
      '        500 https://download.docker.com/linux/ubuntu noble/stable amd64 Packages',
    ].join('\n'));
    expect(packages.find((pkg) => pkg.name === 'docker-ce')?.candidateSources)
      .toEqual([{ uri: 'https://download.docker.com/linux/ubuntu', release: 'noble/stable' }]);
  });
});

describe('bootstrap repository signed-by verification', () => {
  it('rejects a source whose signed-by key is invalid even when another keyring is valid', () => {
    const output = [
      'SOURCE_BEGIN=/etc/apt/sources.list.d/docker.list',
      'deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable',
      'SOURCE_END=/etc/apt/sources.list.d/docker.list',
      keyBlockOf('/etc/apt/keyrings/docker.asc', Buffer.from('not a pgp key')),
      dockerAscBlock('/usr/share/keyrings/docker-archive-keyring.asc'),
    ].join('\n');
    const result = parseDockerRepo(output, 'noble', 'amd64');
    expect(result.keyringPresent).toBe(true);
    expect(result.keyringVerified).toBe(true);
    expect(result.sourceVerified).toBe(false);
  });
});
