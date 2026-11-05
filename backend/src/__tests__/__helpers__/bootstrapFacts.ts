import type {
  AgentDirObservation,
  BootstrapFacts,
  ComposeDirObservation,
} from '../../services/nodeBootstrap/types';

/**
 * Realistic fact fixtures for the bootstrap evidence and plan suites. The
 * defaults describe a healthy Ubuntu 24.04 host with Docker installed, a
 * missing agent directory and an existing empty stacks root, so each test
 * overrides only the fact it is about.
 */

export function makeComposeDir(overrides: Partial<ComposeDirObservation> = {}): ComposeDirObservation {
  return {
    input: '/opt/docker/sencho',
    normalized: '/opt/docker/sencho',
    realPath: '/opt/docker/sencho',
    exists: true,
    isDirectory: true,
    isFinalSymlink: false,
    hasSymlinkAncestor: false,
    owner: 'ubuntu',
    group: 'ubuntu',
    mode: '0755',
    readableByUser: true,
    writableByUser: true,
    readableBySudo: true,
    writableBySudo: true,
    parentWritableByUser: true,
    nearestExistingAncestor: null,
    filesystem: { type: 'ext4', source: '/dev/sda1', mountPoint: '/' },
    freeBytes: 100 * 1024 ** 3,
    mountInFstab: true,
    probeError: null,
    stackCount: 0,
    stackNames: [],
    inventoryTruncated: false,
    inventoryError: null,
    rootComposeFile: false,
    ...overrides,
  };
}

export function makeAgentDir(overrides: Partial<AgentDirObservation> = {}): AgentDirObservation {
  return {
    input: '/opt/sencho-agent',
    normalized: '/opt/sencho-agent',
    realPath: '/opt/sencho-agent',
    exists: false,
    isDirectory: false,
    isFinalSymlink: false,
    hasSymlinkAncestor: false,
    owner: null,
    group: null,
    mode: null,
    readableByUser: false,
    writableByUser: false,
    readableBySudo: false,
    writableBySudo: false,
    parentWritableByUser: true,
    nearestExistingAncestor: '/opt',
    filesystem: { type: 'ext4', source: '/dev/sda1', mountPoint: '/' },
    freeBytes: 100 * 1024 ** 3,
    mountInFstab: true,
    probeError: null,
    entries: [],
    entriesTruncated: false,
    inventoryError: null,
    hasComposeFile: false,
    hasCaFile: false,
    hasMarker: false,
    markerProject: null,
    markerComposeDir: null,
    markerAgentDir: null,
    ...overrides,
  };
}

export interface FactsOverrides {
  target?: Partial<BootstrapFacts['target']>;
  hostKey?: Partial<BootstrapFacts['hostKey']>;
  os?: BootstrapFacts['os'];
  user?: BootstrapFacts['user'];
  docker?: Partial<BootstrapFacts['docker']>;
  repo?: Partial<BootstrapFacts['repo']>;
  packages?: BootstrapFacts['packages'];
  packagesComplete?: boolean;
  composeDir?: Partial<ComposeDirObservation>;
  agentDir?: Partial<AgentDirObservation>;
  agent?: Partial<BootstrapFacts['agent']>;
  dockerRoot?: Partial<BootstrapFacts['dockerRoot']>;
  containers?: Partial<BootstrapFacts['containers']>;
  clockSkewMs?: number | null;
  hub?: Partial<BootstrapFacts['hub']>;
}

export function makeFacts(overrides: FactsOverrides = {}): BootstrapFacts {
  return {
    target: {
      host: 'server.example.com',
      port: 22,
      username: 'ubuntu',
      address: '192.168.1.50',
      ...overrides.target,
    },
    hostKey: {
      algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCD',
      knownHostsLine: 'server.example.com ssh-ed25519 AAAA',
      ...overrides.hostKey,
    },
    os: overrides.os === undefined ? {
      id: 'ubuntu',
      versionId: '24.04',
      codename: 'noble',
      prettyName: 'Ubuntu 24.04.1 LTS',
      arch: 'x86_64',
      kernel: '6.8.0-45-generic',
    } : overrides.os,
    user: overrides.user === undefined ? {
      name: 'ubuntu',
      uid: 1000,
      group: 'ubuntu',
      isRoot: false,
      sudoNonInteractive: true,
    } : overrides.user,
    docker: {
      cliInstalled: true,
      cliProbeUnknown: false,
      serverVersion: '27.3.1',
      composeVersion: '2.29.7',
      composeProbeUnknown: false,
      serviceActive: true,
      serviceEnabled: true,
      socketAccess: 'user',
      rootDir: '/var/lib/docker',
      endpoint: 'unix:///var/run/docker.sock',
      ...overrides.docker,
    },
    repo: {
      probeComplete: true,
      dockerSourceConfigured: true,
      keyringPresent: true,
      sourceVerified: true,
      keyringVerified: true,
      candidateSourceVerified: true,
      problem: null,
      ...overrides.repo,
    },
    packagesComplete: overrides.packagesComplete ?? true,
    packages: overrides.packages ?? [
      { name: 'docker-ce', installedVersion: '5:27.3.1-1~ubuntu.24.04~noble', candidateVersion: '5:27.3.1-1~ubuntu.24.04~noble' },
      { name: 'docker-ce-cli', installedVersion: '5:27.3.1-1~ubuntu.24.04~noble', candidateVersion: '5:27.3.1-1~ubuntu.24.04~noble' },
      { name: 'containerd.io', installedVersion: '1.7.22-1', candidateVersion: '1.7.22-1' },
      { name: 'docker-buildx-plugin', installedVersion: '0.17.1-1~ubuntu.24.04~noble', candidateVersion: '0.17.1-1~ubuntu.24.04~noble' },
      { name: 'docker-compose-plugin', installedVersion: '2.29.7-1~ubuntu.24.04~noble', candidateVersion: '2.29.7-1~ubuntu.24.04~noble' },
    ],
    paths: {
      composeDir: makeComposeDir(overrides.composeDir),
      agentDir: makeAgentDir(overrides.agentDir),
    },
    agent: {
      projectContainers: [],
      dataVolumeExists: false,
      dataVolumeNames: [],
      defaultDirHasComposeFile: false,
      defaultDirRealPath: null,
      ...overrides.agent,
    },
    dockerRoot: {
      path: '/var/lib/docker',
      freeBytes: 100 * 1024 ** 3,
      filesystemType: 'ext4',
      ...overrides.dockerRoot,
    },
    containers: {
      total: 0,
      sample: [],
      agentContainer: null,
      complete: true,
      error: null,
      ...overrides.containers,
    },
    clockSkewMs: overrides.clockSkewMs === undefined ? 250 : overrides.clockSkewMs,
    hub: {
      url: 'https://sencho.example.com',
      reachable: true,
      statusCode: 200,
      tlsTrusted: true,
      ...overrides.hub,
    },
  };
}
