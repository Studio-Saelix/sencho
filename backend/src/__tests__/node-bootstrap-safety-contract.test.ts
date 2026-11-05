import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  DEFAULT_AGENT_PATH_SCRIPT,
  DOCKER_ROOT_DISK_SCRIPT,
  assembleFacts,
  buildProbeCatalog,
  isReadOnlyProbeCommand,
  parseAptPolicy,
  parseDockerRepo,
  parseDockerRootDisk,
} from '../services/nodeBootstrap/probes';
import { buildBootstrapEvidence, repoVerified } from '../services/nodeBootstrap/evidence';
import { buildBootstrapPlan } from '../services/nodeBootstrap/planBuilder';
import { DOCKER_RELEASE_KEY_FINGERPRINT, primaryKeyFingerprints } from '../services/nodeBootstrap/openpgpKey';
import type { SshCommandResult } from '../services/nodeBootstrap/sshProbeClient';
import type { BootstrapCheck, BootstrapFacts } from '../services/nodeBootstrap/types';
import { makeFacts } from './__helpers__/bootstrapFacts';
import {
  DOCKER_ASC_PATH,
  DOCKER_KEY_ASC,
  DOCKER_KEY_GPG,
  armor,
  dockerAscBlock,
  keyBlock,
  unrelatedKeyBinary,
} from './__helpers__/dockerRepoFixtures';

/**
 * The preflight's safety contract: capacity, an earlier installation, the
 * packages the plan touches and repository provenance may each be unknown or
 * contradicted, and none of those may end in a plan.
 */

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

function evidence(facts: BootstrapFacts) {
  return buildBootstrapEvidence({ facts, nodeNameTaken: false, targetName: 'media-server' });
}

function check(facts: BootstrapFacts, id: BootstrapCheck['id']): BootstrapCheck {
  const row = evidence(facts).checks.find((entry) => entry.id === id);
  if (!row) throw new Error(`missing check ${id}`);
  return row;
}

function plan(facts: BootstrapFacts) {
  return buildBootstrapPlan({ facts, targetName: 'media-server', hubUrl: 'https://sencho.example.com', caPem: null, now: 1 });
}

function planCommands(facts: BootstrapFacts): string[] {
  return plan(facts).stages.flatMap((stage) => stage.steps.map((step) => step.command ?? ''));
}

function probe(id: string, stdout: string, overrides: Partial<SshCommandResult> = {}): SshCommandResult {
  return { id, stdout, stderr: '', exitCode: 0, truncated: false, timedOut: false, error: null, ...overrides };
}

function assemble(results: SshCommandResult[]) {
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

describe('capacity that cannot be read never ends in a plan (B4-R)', () => {
  type Target = 'compose' | 'agent' | 'dockerRoot';
  const separateAgentFs = { type: 'ext4', source: '/dev/sdb1', mountPoint: '/srv' };
  const roomy = { compose: 100 * GIB, agent: 100 * GIB, dockerRoot: 100 * GIB };
  // Above the block threshold, below the comfortable level, per target.
  const low: Record<Target, number> = { compose: 3 * GIB, agent: 768 * MIB, dockerRoot: 3 * GIB };

  function factsWith(free: Record<Target, number | null>) {
    return makeFacts({
      composeDir: { freeBytes: free.compose },
      agentDir: { freeBytes: free.agent, filesystem: separateAgentFs },
      dockerRoot: { freeBytes: free.dockerRoot },
    });
  }

  const targets: Target[] = ['compose', 'agent', 'dockerRoot'];
  const pairs = targets.flatMap((unreadable) => targets
    .filter((other) => other !== unreadable)
    .map((other) => [unreadable, other] as const));

  it.each(pairs)('keeps %s unreadable as unknown when %s is only low', (unreadable, lowTarget) => {
    const free = { ...roomy, [unreadable]: null, [lowTarget]: low[lowTarget] };
    const facts = factsWith(free);
    const row = check(facts, 'disk_space');
    expect(row.status).toBe('unknown');
    expect(row.summary).toContain('unreadable');
    const result = evidence(facts);
    expect(result.planSuppressed).toBe(true);
  });

  it.each(targets)('keeps %s unknown with every other filesystem healthy', (unreadable) => {
    const facts = factsWith({ ...roomy, [unreadable]: null });
    expect(check(facts, 'disk_space').status).toBe('unknown');
    expect(evidence(facts).planSuppressed).toBe(true);
  });

  it('keeps every unreadable filesystem in the report when two are unreadable and one is low', () => {
    const row = check(factsWith({ compose: null, agent: low.agent, dockerRoot: null }), 'disk_space');
    expect(row.status).toBe('unknown');
    expect(row.observed).toContain('Compose directory: unreadable');
    expect(row.observed).toMatch(/Docker root.*unreadable/);
    expect(row.observed).toContain('Agent directory');
  });

  it('still reports a shortfall as blocked beside an unreadable filesystem', () => {
    const row = check(factsWith({ compose: null, agent: 100 * MIB, dockerRoot: roomy.dockerRoot }), 'disk_space');
    expect(row.status).toBe('blocked');
  });

  it('reads the shared Compose and Agent filesystem once, and its unknown still counts', () => {
    const facts = makeFacts({ composeDir: { freeBytes: null }, agentDir: { freeBytes: 100 * GIB } });
    expect(check(facts, 'disk_space').status).toBe('unknown');
    expect(evidence(facts).planSuppressed).toBe(true);
  });

  it('warns, and still plans, only when every capacity is known and merely low', () => {
    const facts = factsWith(low);
    expect(check(facts, 'disk_space').status).toBe('warn');
    expect(evidence(facts).planSuppressed).toBe(false);
  });

  describe('the Docker root script measures the root the daemon reported', () => {
    function runDiskScript(setup: (bin: string, dir: string) => void): string {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'sencho-root-disk-'));
      try {
        const bin = path.join(dir, 'bin');
        mkdirSync(bin);
        // Only the tools the script needs, so a missing `docker` stays missing.
        for (const tool of ['env', 'df', 'dirname', 'tail']) {
          symlinkSync(execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim(), path.join(bin, tool));
        }
        setup(bin, dir);
        return execFileSync('/bin/sh', ['-c', DOCKER_ROOT_DISK_SCRIPT], { encoding: 'utf8', env: { PATH: bin } });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    const stub = (bin: string, name: string, body: string) => writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });

    it('measures a custom root and reports which root it measured', () => {
      const output = runDiskScript((bin, dir) => {
        stub(bin, 'docker', `echo ${dir}`);
        stub(bin, 'sudo', 'exit 1');
      });
      const parsed = parseDockerRootDisk(output);
      expect(parsed.source).toBe('daemon');
      expect(parsed.root).toMatch(/sencho-root-disk-/);
      expect(parsed.freeBytes).toBeGreaterThan(0);
    });

    it('reports no measurement when a Docker CLI exists but neither query answers', () => {
      const output = runDiskScript((bin) => {
        stub(bin, 'docker', 'exit 1');
        stub(bin, 'sudo', 'exit 1');
      });
      expect(output).toBe('D_SOURCE=unavailable\n');
      expect(parseDockerRootDisk(output)).toEqual({ source: 'unavailable', root: null, freeBytes: null });
    });

    it('falls back to the default root only when no Docker CLI exists', () => {
      const output = runDiskScript(() => undefined);
      expect(parseDockerRootDisk(output)).toMatchObject({ source: 'default', root: '/var/lib/docker' });
    });

    it('reads the sudo answer when the direct query is denied', () => {
      const output = runDiskScript((bin, dir) => {
        stub(bin, 'docker', 'exit 1');
        stub(bin, 'sudo', `[ "$1" = "-n" ] && shift; echo ${dir}`);
      });
      expect(parseDockerRootDisk(output).source).toBe('daemon');
    });
  });

  describe('fact assembly attaches capacity only to the established root', () => {
    const docker = [probe('docker_cli', '/usr/bin/docker'), probe('docker_info', '27.3.1|/data/docker')];
    const df = 'D_DF=/dev/sdb1 1 1 3145728 1% /data';

    it('measures the custom root', () => {
      const facts = assemble([...docker, probe('docker_root_disk', `D_SOURCE=daemon\nD_ROOT=/data/docker\n${df}`)]);
      expect(facts.dockerRoot).toMatchObject({ path: '/data/docker', freeBytes: 3145728 * 1024 });
    });

    it('does not borrow another root when the disk script could not re-query the daemon', () => {
      const unavailable = assemble([...docker, probe('docker_root_disk', 'D_SOURCE=unavailable')]);
      expect(unavailable.dockerRoot).toEqual({ path: '/data/docker', freeBytes: null, filesystemType: null });
      // Capacity of the default root, as the old script printed it after failed queries.
      const wrongRoot = assemble([...docker, probe('docker_root_disk', `D_SOURCE=daemon\nD_ROOT=/var/lib/docker\n${df}`)]);
      expect(wrongRoot.dockerRoot.freeBytes).toBeNull();
      const legacy = assemble([...docker, probe('docker_root_disk', '/dev/sda1 1 1 3145728 1% /')]);
      expect(legacy.dockerRoot.freeBytes).toBeNull();
    });

    it('turns the missing measurement into an unknown that suppresses the plan', () => {
      const facts = assemble([...docker, probe('docker_root_disk', 'D_SOURCE=unavailable')]);
      const merged = makeFacts({ dockerRoot: facts.dockerRoot });
      expect(check(merged, 'disk_space').status).toBe('unknown');
      expect(evidence(merged).planSuppressed).toBe(true);
    });

    it('does not trust a disk measurement when the daemon never answered', () => {
      const facts = assemble([
        probe('docker_cli', '/usr/bin/docker'),
        probe('docker_info', '', { exitCode: 1 }),
        probe('docker_root_disk', `D_SOURCE=default\nD_ROOT=/var/lib/docker\n${df}`),
      ]);
      expect(facts.dockerRoot).toMatchObject({ path: null, freeBytes: null });
    });

    it('measures the default root on a host with no Docker CLI at all', () => {
      const facts = assemble([
        probe('docker_cli', '', { exitCode: 1 }),
        probe('docker_root_disk', `D_SOURCE=default\nD_ROOT=/var/lib/docker\n${df}`),
      ]);
      expect(facts.dockerRoot).toMatchObject({ path: '/var/lib/docker', freeBytes: 3145728 * 1024 });
    });

    it('does not read a default-root measurement as proof when the CLI probe itself failed', () => {
      const facts = assemble([
        probe('docker_cli', '', { error: 'COMMAND_ERROR', exitCode: null }),
        probe('docker_root_disk', `D_SOURCE=default\nD_ROOT=/var/lib/docker\n${df}`),
      ]);
      expect(facts.dockerRoot.freeBytes).toBeNull();
    });
  });
});

describe('an earlier Pilot installation is never missed (B2-R)', () => {
  describe('the default-path script tells absence from an inspection that failed', () => {
    const canDeny = typeof process.getuid === 'function' && process.getuid() !== 0;
    function runScript(file: string): string {
      return execFileSync('sh', ['-c', DEFAULT_AGENT_PATH_SCRIPT, 'sencho-probe', file], { encoding: 'utf8' }).trim();
    }

    it('answers yes for a readable Compose file and no for a readable absence', () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'sencho-default-path-'));
      try {
        writeFileSync(path.join(dir, 'compose.yaml'), 'services: {}\n');
        expect(runScript(path.join(dir, 'compose.yaml'))).toBe('yes');
        expect(runScript(path.join(dir, 'missing.yaml'))).toBe('no');
        expect(runScript(path.join(dir, 'compose.yaml', 'inside'))).toBe('no');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it.skipIf(!canDeny)('answers error, not no, when an ancestor cannot be searched', () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'sencho-default-denied-'));
      const denied = path.join(dir, 'denied');
      try {
        mkdirSync(denied);
        writeFileSync(path.join(denied, 'compose.yaml'), 'services: {}\n');
        chmodSync(denied, 0o000);
        // The real file is there, and the old `test -f ... || echo no` said "no".
        expect(execFileSync('sh', ['-c', `test -f ${path.join(denied, 'compose.yaml')} && echo yes || echo no`], { encoding: 'utf8' }).trim()).toBe('no');
        expect(runScript(path.join(denied, 'compose.yaml'))).toBe('error');
      } finally {
        chmodSync(denied, 0o700);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('the catalog entries are fixed and read-only', () => {
    const catalog = buildProbeCatalog({ composeDir: '/opt/docker/sencho', agentDir: '/opt/sencho-agent', hubUrl: 'https://h.example.com' });
    it.each(['default_agent_path', 'default_agent_path_sudo', 'docker_root_disk', 'docker_repo'])('%s is a read-only command', (id) => {
      const entry = catalog.find((candidate) => candidate.id === id);
      expect(entry, id).toBeDefined();
      expect(isReadOnlyProbeCommand(entry?.command ?? '')).toBe(true);
    });
    it('has a sudo counterpart for the default-path probe', () => {
      expect(catalog.find((entry) => entry.id === 'default_agent_path_sudo')?.command).toMatch(/^sudo -n sh -c /);
    });
  });

  describe('fact assembly', () => {
    const direct = (stdout: string, overrides: Partial<SshCommandResult> = {}) => probe('default_agent_path', stdout, overrides);
    const viaSudo = (stdout: string, overrides: Partial<SshCommandResult> = {}) => probe('default_agent_path_sudo', stdout, overrides);
    const outcome = (...results: SshCommandResult[]) => assemble(results).agent.defaultDirHasComposeFile;

    it.each([
      ['a direct yes', [direct('yes\n')], true],
      ['a direct no', [direct('no\n')], false],
      ['a direct no beside a sudo failure', [direct('no\n'), viaSudo('', { exitCode: 1 })], false],
      ['a denied direct attempt and no sudo answer', [direct('error\n')], null],
      ['a denied direct attempt and a failed sudo attempt', [direct('error\n'), viaSudo('', { exitCode: 1 })], null],
      ['a denied direct attempt and a sudo yes', [direct('error\n'), viaSudo('yes\n')], true],
      ['a denied direct attempt and a sudo no', [direct('error\n'), viaSudo('no\n')], false],
      ['a timed-out direct attempt and a sudo yes', [direct('', { timedOut: true, exitCode: null }), viaSudo('yes\n')], true],
      ['a timed-out direct attempt alone', [direct('', { timedOut: true, exitCode: null })], null],
      ['output the script never prints', [direct('maybe\n')], null],
      ['no probe at all', [], null],
    ] as const)('reads %s', (_label, results, expected) => {
      expect(outcome(...results)).toBe(expected);
    });

    it('suppresses the plan when the default directory could not be inspected', () => {
      const facts = makeFacts({ agent: { defaultDirHasComposeFile: assemble([direct('error\n')]).agent.defaultDirHasComposeFile } });
      expect(check(facts, 'agent_conflict').status).toBe('unknown');
      expect(evidence(facts).planSuppressed).toBe(true);
    });
  });

  describe('a positive default installation conflicts with every other chosen directory', () => {
    const alternate = (overrides: Record<string, unknown>) => makeFacts({
      agent: { defaultDirHasComposeFile: true },
      agentDir: { input: '/srv/sencho-agent', normalized: '/srv/sencho-agent', realPath: '/srv/sencho-agent', ...overrides },
    });
    const emptyExisting = { exists: true, isDirectory: true, readableByUser: true, writableByUser: true, entries: [] };

    it.each([
      ['a missing directory', {}],
      ['an existing empty directory', emptyExisting],
      ['an existing directory holding our own marker', {
        ...emptyExisting,
        entries: ['sencho-bootstrap.json'],
        hasMarker: true,
        markerProject: 'sencho-agent',
        markerComposeDir: '/opt/docker/sencho',
        markerAgentDir: '/srv/sencho-agent',
      }],
    ])('blocks beside %s', (_label, overrides) => {
      const facts = alternate(overrides);
      expect(check(facts, 'agent_conflict').status).toBe('blocked');
      expect(evidence(facts).blockers).toBeGreaterThan(0);
    });

    it('lets agent_dir judge the default directory itself instead of reporting a second installation', () => {
      const selected = makeFacts({
        agent: { defaultDirHasComposeFile: true },
        agentDir: { ...emptyExisting, entries: ['compose.yaml'], hasComposeFile: true },
      });
      expect(check(selected, 'agent_conflict').status).not.toBe('blocked');
      // Compose file without our marker: the directory check blocks it.
      expect(check(selected, 'agent_dir').status).toBe('blocked');
    });

    it('treats a resolved path equal to the default as the default directory', () => {
      const viaLink = makeFacts({
        agent: { defaultDirHasComposeFile: true },
        agentDir: { ...emptyExisting, input: '/srv/link', normalized: '/srv/link', realPath: '/opt/sencho-agent', hasSymlinkAncestor: true },
      });
      expect(check(viaLink, 'agent_conflict').status).not.toBe('blocked');
    });
  });
});

describe('a working Docker engine is never replaced (S4-R)', () => {
  const NOT_INSTALLED = [
    { name: 'docker-ce', installedVersion: null, candidateVersion: '5:27.3.1-1~ubuntu.24.04~noble' },
    { name: 'docker-ce-cli', installedVersion: null, candidateVersion: '5:27.3.1-1~ubuntu.24.04~noble' },
    { name: 'containerd.io', installedVersion: null, candidateVersion: '1.7.22-1' },
    { name: 'docker-buildx-plugin', installedVersion: null, candidateVersion: '0.17.1-1~ubuntu.24.04~noble' },
    { name: 'docker-compose-plugin', installedVersion: null, candidateVersion: '2.29.7-1~ubuntu.24.04~noble' },
  ] as const;
  const OFFICIAL_ENGINE_NO_COMPOSE = [
    { name: 'docker-ce', installedVersion: '5:27.3.1-1~ubuntu.24.04~noble', candidateVersion: '5:27.3.1-1~ubuntu.24.04~noble' },
    { name: 'docker-ce-cli', installedVersion: '5:27.3.1-1~ubuntu.24.04~noble', candidateVersion: '5:27.3.1-1~ubuntu.24.04~noble' },
    { name: 'containerd.io', installedVersion: '1.7.22-1', candidateVersion: '1.7.22-1' },
    { name: 'docker-buildx-plugin', installedVersion: '0.17.1-1~ubuntu.24.04~noble', candidateVersion: '0.17.1-1~ubuntu.24.04~noble' },
    { name: 'docker-compose-plugin', installedVersion: null, candidateVersion: '2.29.7-1~ubuntu.24.04~noble' },
  ] as const;
  const workloads = { total: 4, sample: [{ name: 'web', image: 'nginx', project: 'web' }], agentContainer: null };

  const REPLACEMENT = /docker-ce|containerd\.io|docker-ce-cli|docker\.io/;

  describe.each(['user', 'sudo'] as const)('with the daemon reached through %s access', (socketAccess) => {
    it('stops at a distribution engine that lacks Compose instead of planning a replacement', () => {
      const facts = makeFacts({
        docker: { composeVersion: null, socketAccess },
        packages: NOT_INSTALLED.map((pkg) => ({ ...pkg })),
        repo: { dockerSourceConfigured: false, keyringPresent: false, sourceVerified: false, keyringVerified: false },
        containers: workloads,
      });
      const row = check(facts, 'compose_plugin');
      expect(row.status).toBe('blocked');
      expect('remediation' in row && row.remediation).toBeTruthy();
      expect(evidence(facts).blockers).toBeGreaterThan(0);
      expect(() => plan(facts)).toThrow(/not installed from Docker packages/);
    });

    it('plans only the Compose plugin beside an engine installed from Docker packages', () => {
      const facts = makeFacts({
        docker: { composeVersion: null, socketAccess },
        packages: OFFICIAL_ENGINE_NO_COMPOSE.map((pkg) => ({ ...pkg })),
        containers: workloads,
      });
      expect(check(facts, 'compose_plugin').status).toBe('warn');
      expect(evidence(facts).blockers).toBe(0);
      expect(evidence(facts).planSuppressed).toBe(false);
      const commands = planCommands(facts);
      const install = commands.filter((command) => command.includes('apt-get install'));
      expect(install).toHaveLength(1);
      expect(install[0]).toContain('docker-compose-plugin=2.29.7-1~ubuntu.24.04~noble');
      expect(install[0]).not.toMatch(REPLACEMENT);
      expect(plan(facts).notices.join(' ')).toContain('Only the Compose plugin is installed');
    });
  });

  it('plans nothing beyond the Compose plugin when other optional packages are also absent', () => {
    const facts = makeFacts({
      docker: { composeVersion: null },
      packages: OFFICIAL_ENGINE_NO_COMPOSE.map((pkg) => (
        pkg.name === 'docker-buildx-plugin' ? { ...pkg, installedVersion: null } : { ...pkg }
      )),
    });
    const install = planCommands(facts).filter((command) => command.includes('apt-get install'));
    expect(install).toHaveLength(1);
    expect(install[0]).toContain('docker-compose-plugin');
    expect(install[0]).not.toContain('docker-buildx-plugin');
  });

  it('never gives a working engine with workloads a replacement step, in any package state', () => {
    for (const packages of [NOT_INSTALLED, OFFICIAL_ENGINE_NO_COMPOSE]) {
      const facts = makeFacts({
        docker: { composeVersion: null },
        packages: packages.map((pkg) => ({ ...pkg })),
        containers: workloads,
      });
      let commands: string[] = [];
      try {
        commands = planCommands(facts);
      } catch {
        // A refused plan has no steps to check.
      }
      for (const command of commands.filter((entry) => entry.includes('apt-get install'))) {
        expect(command).not.toMatch(REPLACEMENT);
      }
    }
  });

  it('plans the whole set for a fresh host', () => {
    const facts = makeFacts({
      docker: { cliInstalled: false, serverVersion: null, composeVersion: null, socketAccess: 'none', serviceActive: false, serviceEnabled: false },
      packages: NOT_INSTALLED.map((pkg) => ({ ...pkg })),
      repo: { dockerSourceConfigured: false, keyringPresent: false, sourceVerified: false, keyringVerified: false },
    });
    const install = planCommands(facts).find((command) => command.includes('apt-get install')) ?? '';
    for (const name of ['docker-ce', 'docker-ce-cli', 'containerd.io', 'docker-buildx-plugin', 'docker-compose-plugin']) {
      expect(install).toContain(name);
    }
  });

  it('keeps preserving an engine that has Compose', () => {
    const facts = makeFacts({ packages: NOT_INSTALLED.map((pkg) => ({ ...pkg })), containers: workloads });
    expect(planCommands(facts).some((command) => command.includes('apt-get install'))).toBe(false);
  });

  it('leaves a stopped distribution engine to the daemon check', () => {
    const facts = makeFacts({
      docker: { composeVersion: null, serverVersion: null, socketAccess: 'none', serviceActive: false },
      packages: NOT_INSTALLED.map((pkg) => ({ ...pkg })),
    });
    expect(check(facts, 'docker_daemon').status).toBe('blocked');
    expect(check(facts, 'compose_plugin').status).toBe('warn');
  });

  it('keeps an unreadable package list unknown rather than blocked', () => {
    const facts = makeFacts({
      docker: { composeVersion: null },
      packages: NOT_INSTALLED.map((pkg) => ({ ...pkg })),
      packagesComplete: false,
    });
    expect(check(facts, 'compose_plugin').status).toBe('warn');
    expect(check(facts, 'apt_source').status).toBe('unknown');
    expect(evidence(facts).planSuppressed).toBe(true);
  });
});

describe('repository provenance (S5-R)', () => {
  const OFFICIAL = 'https://download.docker.com/linux/ubuntu';
  const block = (file: string, content: string) => `SOURCE_BEGIN=${file}\n${content}\nSOURCE_END=${file}`;
  const listFile = '/etc/apt/sources.list.d/docker.list';
  const sourcesFile = '/etc/apt/sources.list.d/docker.sources';
  const deb = (options: string, extra = '') => `deb [${options} signed-by=${DOCKER_ASC_PATH}] ${OFFICIAL} noble stable${extra}`;
  const parse = (...parts: string[]) => parseDockerRepo(parts.join('\n'), 'noble');
  const deb822 = (fields: Record<string, string>) => Object.entries(fields).map(([name, value]) => `${name}: ${value}`).join('\n');
  const official822 = { Types: 'deb', URIs: OFFICIAL, Suites: 'noble', Components: 'stable', 'Signed-By': DOCKER_ASC_PATH };

  describe('the key must be Docker\'s', () => {
    it('computes Docker\'s fingerprint from the armored and the binary form', () => {
      expect(primaryKeyFingerprints('/k/docker.asc', Buffer.from(DOCKER_KEY_ASC))).toEqual([DOCKER_RELEASE_KEY_FINGERPRINT]);
      expect(primaryKeyFingerprints('/k/docker.gpg', DOCKER_KEY_GPG)).toEqual([DOCKER_RELEASE_KEY_FINGERPRINT]);
    });

    it('accepts the real armored and binary Docker keys', () => {
      expect(parse(block(listFile, deb('arch=amd64')), dockerAscBlock())).toMatchObject({ keyringVerified: true, sourceVerified: true });
      const gpgPath = '/usr/share/keyrings/docker-archive-keyring.gpg';
      const source = `deb [arch=amd64 signed-by=${gpgPath}] ${OFFICIAL} noble stable`;
      expect(parse(block(listFile, source), keyBlock(gpgPath, DOCKER_KEY_GPG))).toMatchObject({ keyringVerified: true, sourceVerified: true });
    });

    it.each([
      ['a PGP header with no key', keyBlock(DOCKER_ASC_PATH, Buffer.from('-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n-----END PGP PUBLIC KEY BLOCK-----\n'))],
      ['a header and filler', keyBlock(DOCKER_ASC_PATH, Buffer.from('-----BEGIN PGP PUBLIC KEY BLOCK-----\nfixture\n-----END PGP PUBLIC KEY BLOCK-----\n'))],
      ['a valid key that is not Docker\'s, armored', keyBlock(DOCKER_ASC_PATH, Buffer.from(armor(unrelatedKeyBinary())))],
      ['a valid key that is not Docker\'s, binary', keyBlock('/etc/apt/keyrings/docker.gpg', unrelatedKeyBinary())],
      ['Docker\'s key plus a second primary key', keyBlock('/etc/apt/keyrings/docker.gpg', Buffer.concat([DOCKER_KEY_GPG, unrelatedKeyBinary()]))],
      ['a packet prefix only', keyBlock('/etc/apt/keyrings/docker.gpg', Buffer.from([0x99, 0x00, 0x10]))],
      ['binary bytes under an .asc name', keyBlock(DOCKER_ASC_PATH, DOCKER_KEY_GPG)],
      ['armor under a .gpg name', keyBlock('/etc/apt/keyrings/docker.gpg', Buffer.from(DOCKER_KEY_ASC))],
    ])('rejects %s', (_label, keyText) => {
      const keyPath = /KEY_BEGIN=(\S+)/.exec(keyText)?.[1] ?? DOCKER_ASC_PATH;
      const source = `deb [arch=amd64 signed-by=${keyPath}] ${OFFICIAL} noble stable`;
      const result = parse(block(listFile, source), keyText);
      expect(result.keyringVerified).toBe(false);
      expect(result.sourceVerified).toBe(false);
      expect(result.problem).toBeTruthy();
    });

    it('treats a keyring cut off by the read cap as unknown, not as verified', () => {
      const result = parse(block(listFile, deb('arch=amd64')), keyBlock(DOCKER_ASC_PATH, Buffer.from(DOCKER_KEY_ASC).subarray(0, 1000), Buffer.from(DOCKER_KEY_ASC).length));
      expect(result.keyringVerified).toBeNull();
      expect(result.problem).toMatch(/read in full/);
    });

    it('rejects a source that names an unrelated keyring beside Docker\'s', () => {
      const other = '/etc/apt/keyrings/other.gpg';
      const source = `deb [arch=amd64 signed-by=${DOCKER_ASC_PATH},${other}] ${OFFICIAL} noble stable`;
      const result = parse(block(listFile, source), dockerAscBlock(), keyBlock(other, unrelatedKeyBinary()));
      expect(result.sourceVerified).toBe(false);
    });
  });

  describe('source semantics', () => {
    it.each([
      ['trusted=yes', deb('arch=amd64 trusted=yes')],
      ['trusted=true', deb('arch=amd64 trusted=true')],
      ['allow-insecure=yes', deb('arch=amd64 allow-insecure=yes')],
      ['allow-weak=yes', deb('arch=amd64 allow-weak=yes')],
      ['allow-downgrade-to-insecure=yes', deb('arch=amd64 allow-downgrade-to-insecure=yes')],
    ])('rejects a .list entry with %s', (_label, content) => {
      const result = parse(block(listFile, content), dockerAscBlock());
      expect(result.sourceVerified).toBe(false);
      expect(result.problem).toMatch(/weakens signature checking/);
    });

    it('accepts an explicit trusted=no', () => {
      expect(parse(block(listFile, deb('arch=amd64 trusted=no')), dockerAscBlock()).sourceVerified).toBe(true);
    });

    it.each([
      ['Trusted: yes', { ...official822, Trusted: 'yes' }],
      ['Allow-Insecure: yes', { ...official822, 'Allow-Insecure': 'yes' }],
      ['Allow-Weak: yes', { ...official822, 'Allow-Weak': 'yes' }],
    ])('rejects a deb822 stanza with %s', (_label, fields) => {
      expect(parse(block(sourcesFile, deb822(fields)), dockerAscBlock()).sourceVerified).toBe(false);
    });

    it('does not count a deb-src entry as a binary source, in either format', () => {
      const srcOnlyList = parse(block(listFile, `deb-src [arch=amd64 signed-by=${DOCKER_ASC_PATH}] ${OFFICIAL} noble stable`), dockerAscBlock());
      expect(srcOnlyList.sourceVerified).toBe(false);
      expect(srcOnlyList.problem).toMatch(/no binary/);
      const srcOnly822 = parse(block(sourcesFile, deb822({ ...official822, Types: 'deb-src' })), dockerAscBlock());
      expect(srcOnly822.sourceVerified).toBe(false);
      expect(srcOnly822.problem).toMatch(/no enabled binary/);
    });

    it('accepts a deb entry beside its deb-src twin', () => {
      const both = [deb('arch=amd64'), `deb-src [signed-by=${DOCKER_ASC_PATH}] ${OFFICIAL} noble stable`].join('\n');
      expect(parse(block(listFile, both), dockerAscBlock()).sourceVerified).toBe(true);
      expect(parse(block(sourcesFile, deb822({ ...official822, Types: 'deb deb-src' })), dockerAscBlock()).sourceVerified).toBe(true);
    });

    it('ignores a disabled stanza and never verifies a source that is disabled altogether', () => {
      const disabledForeign = [
        deb822(official822),
        deb822({ ...official822, URIs: 'https://example.com/ubuntu', Enabled: 'no' }),
      ].join('\n\n');
      expect(parse(block(sourcesFile, disabledForeign), dockerAscBlock()).sourceVerified).toBe(true);
      const disabled = parse(block(sourcesFile, deb822({ ...official822, Enabled: 'no' })), dockerAscBlock());
      expect(disabled.sourceVerified).toBe(false);
      expect(disabled.problem).toMatch(/no enabled binary/);
    });

    it('still rejects an enabled foreign stanza beside an official one', () => {
      const mixed = [deb822(official822), deb822({ ...official822, URIs: 'https://example.com/ubuntu' })].join('\n\n');
      expect(parse(block(sourcesFile, mixed), dockerAscBlock()).sourceVerified).toBe(false);
    });
  });

  describe('the candidate archive belongs to the candidate version', () => {
    const policy = (lines: string[]) => ['docker-ce:', '  Installed: (none)', ...lines].join('\n');

    it('does not attribute Docker\'s archive to a candidate served from elsewhere', () => {
      // Audit sequence: candidate 1.0 is from another archive; the non-candidate 2.0 listed first is Docker's.
      const text = policy([
        '  Candidate: 1.0',
        '  Version table:',
        '     2.0 500',
        '        500 https://download.docker.com/linux/ubuntu noble/stable amd64 Packages',
        '     1.0 500',
        '        500 http://archive.ubuntu.com/ubuntu noble/universe amd64 Packages',
      ]);
      const ce = parseAptPolicy(text).find((pkg) => pkg.name === 'docker-ce');
      expect(ce?.candidateSources).toEqual([{ uri: 'http://archive.ubuntu.com/ubuntu', release: 'noble/universe' }]);
      const facts = assemble([
        probe('os_release', 'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble'),
        probe('docker_info', '27.3.1|/var/lib/docker'),
        probe('apt_policy', text),
      ]);
      expect(facts.repo.candidateSourceVerified).toBe(false);
    });

    it('reads the archive of the candidate stanza when it is not first', () => {
      const text = policy([
        '  Candidate: 2.0',
        '  Version table:',
        '     3.0 100',
        '        100 http://archive.ubuntu.com/ubuntu noble/universe amd64 Packages',
        ' *** 2.0 500',
        '        500 https://download.docker.com/linux/ubuntu noble/stable amd64 Packages',
        '        100 /var/lib/dpkg/status',
      ]);
      const ce = parseAptPolicy(text).find((pkg) => pkg.name === 'docker-ce');
      expect(ce?.candidateSources).toEqual([{ uri: 'https://download.docker.com/linux/ubuntu', release: 'noble/stable' }]);
    });

    it('reports a candidate that any foreign archive also serves as unverified', () => {
      const text = policy([
        '  Candidate: 2.0',
        '  Version table:',
        '     2.0 500',
        '        500 https://download.docker.com/linux/ubuntu noble/stable amd64 Packages',
        '        500 file:/srv/mirror noble/stable amd64 Packages',
      ]);
      const facts = assemble([probe('os_release', 'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble'), probe('apt_policy', text)]);
      expect(facts.repo.candidateSourceVerified).toBe(false);
    });

    it('follows an apt-pinned candidate rather than the highest version', () => {
      const text = policy([
        '  Candidate: 1.5',
        '  Version table:',
        '     2.0 500',
        '        500 https://download.docker.com/linux/ubuntu noble/stable amd64 Packages',
        '     1.5 1001',
        '        1001 http://archive.ubuntu.com/ubuntu noble/universe amd64 Packages',
      ]);
      const facts = assemble([probe('os_release', 'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble'), probe('apt_policy', text)]);
      expect(facts.repo.candidateSourceVerified).toBe(false);
    });

    it('rejects Docker\'s archive for another release', () => {
      const text = policy([
        '  Candidate: 2.0',
        '  Version table:',
        '     2.0 500',
        '        500 https://download.docker.com/linux/ubuntu jammy/stable amd64 Packages',
      ]);
      const facts = assemble([probe('os_release', 'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble'), probe('apt_policy', text)]);
      expect(facts.repo.candidateSourceVerified).toBe(false);
    });

    it('verifies the official archive and treats an unknown archive as unknown, never as true', () => {
      const official = policy([
        '  Candidate: 2.0',
        '  Version table:',
        ' *** 2.0 500',
        '        500 https://download.docker.com/linux/ubuntu noble/stable amd64 Packages',
        '        100 /var/lib/dpkg/status',
      ]);
      const osRelease = probe('os_release', 'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble');
      expect(assemble([osRelease, probe('apt_policy', official)]).repo.candidateSourceVerified).toBe(true);
      const noArchive = policy([
        '  Candidate: 2.0',
        '  Version table:',
        ' *** 2.0 100',
        '        100 /var/lib/dpkg/status',
      ]);
      expect(assemble([osRelease, probe('apt_policy', noArchive)]).repo.candidateSourceVerified).toBeNull();
    });
  });

  it('does not report verified when the key, the source and the candidate archive are all wrong', () => {
    // The audit's combined sequence: header-only key, trusted=yes source, misattributed archive.
    const repoText = [
      block(listFile, deb('arch=amd64 trusted=yes')),
      keyBlock(DOCKER_ASC_PATH, Buffer.from('-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n')),
    ].join('\n');
    const facts = assemble([
      probe('os_release', 'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble'),
      probe('docker_repo', repoText),
      probe('apt_policy', [
        'docker-ce:', '  Installed: (none)', '  Candidate: 1.0', '  Version table:',
        '     2.0 500', '        500 https://download.docker.com/linux/ubuntu noble/stable amd64 Packages',
        '     1.0 500', '        500 http://archive.ubuntu.com/ubuntu noble/universe amd64 Packages',
      ].join('\n')),
    ]);
    expect(facts.repo.sourceVerified).toBe(false);
    expect(facts.repo.keyringVerified).toBe(false);
    expect(facts.repo.candidateSourceVerified).toBe(false);
    expect(repoVerified(facts)).toBe(false);
  });

  it('keeps the real Docker repository verified end to end', () => {
    const facts = assemble([
      probe('os_release', 'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble'),
      probe('docker_repo', [block(listFile, deb('arch=amd64')), dockerAscBlock()].join('\n')),
      probe('apt_policy', [
        'docker-ce:', '  Installed: 5:27.3.1-1', '  Candidate: 5:27.3.1-1', '  Version table:',
        ' *** 5:27.3.1-1 500', '        500 https://download.docker.com/linux/ubuntu noble/stable amd64 Packages',
        '        100 /var/lib/dpkg/status',
      ].join('\n')),
    ]);
    expect(repoVerified(facts)).toBe(true);
    expect(facts.repo.candidateSourceVerified).toBe(true);
  });
});
