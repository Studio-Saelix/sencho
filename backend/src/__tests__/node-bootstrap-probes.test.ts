import { describe, it, expect } from 'vitest';
import {
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
  parseDockerRepo,
  parseFstabMountPoints,
  parseHubHealth,
  parsePathFacts,
} from '../services/nodeBootstrap/probes';
import type { SshCommandResult } from '../services/nodeBootstrap/sshProbeClient';

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
  });

  it('reads a truncated inventory as a lower bound', () => {
    const entries = Array.from({ length: 505 }, (_, index) => `/opt/docker/sencho/stack-${index}/compose.yaml`);
    const summary = parseComposeInventory(entries.join('\0'), '/opt/docker/sencho');
    expect(summary.stackCount).toBe(500);
    expect(summary.truncated).toBe(true);
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
    const summary = parseComposeInventory('/opt/docker/sencho/media/compose.yaml\0', '/opt/docker/sencho', 500, true);
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

    expect(parseDockerRepo('list\nkeyring')).toEqual({ dockerSourceConfigured: true, keyringPresent: true });
    expect(parseDockerRepo('')).toEqual({ dockerSourceConfigured: false, keyringPresent: false });
  });

  it('parses containers with missing compose labels', () => {
    const text = [
      'web\tnginx:latest\tweb\t/opt/docker/sencho/web\tUp 2 hours',
      'orphan\tbusybox\t\t\tExited (0)',
    ].join('\n');
    const rows = parseContainers(text);
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
        result('docker_repo', 'list\nkeyring'),
        result('apt_policy', 'docker-ce:\n  Installed: 1\n  Candidate: 1'),
        result('containers', 'web\tnginx:latest\tweb\t/opt/docker/sencho/web\tUp'),
        result('agent_volume', '', 1),
        result('clock', String(Math.floor(Date.now() / 1000))),
        result('hub_health', '200'),
        result('path_compose', PATH_SCRIPT_OUTPUT),
        result('path_agent', 'P_EXISTS=0\nP_ISDIR=0\nP_REAL=/opt/sencho-agent\nP_NEAREST=/opt\nP_PARENT_W=1\nP_FSTYPE=ext4\nP_FSTARGET=/'),
        result('compose_inventory', '/opt/docker/sencho/media/compose.yaml\0'),
        result('agent_inventory', ''),
        result('agent_marker', '', 1),
        result('default_agent_path', 'no'),
        result('docker_root_disk', '/dev/sda1 1 1 123456789 1% /'),
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
