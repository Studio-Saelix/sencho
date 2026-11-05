import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  assembleFacts,
  buildProbeCatalog,
  parseComposeInventory,
  parseDockerInfo,
  parseHubHealth,
} from '../services/nodeBootstrap/probes';
import { buildBootstrapEvidence } from '../services/nodeBootstrap/evidence';
import { buildBootstrapPlan } from '../services/nodeBootstrap/planBuilder';
import type { SshCommandResult } from '../services/nodeBootstrap/sshProbeClient';
import { makeFacts } from './__helpers__/bootstrapFacts';

/**
 * Failure modes of the Docker, Compose, package and hub probes: a command that
 * exits non-zero while still printing its template, times out, or errors must
 * read as unknown or absent as appropriate, never as a working installation.
 */

function probe(id: string, stdout: string, overrides: Partial<SshCommandResult> = {}): SshCommandResult {
  return { id, stdout, stderr: '', exitCode: 0, truncated: false, timedOut: false, error: null, ...overrides };
}

function assemble(results: SshCommandResult[], fstabMountPoints: string[] | null = ['/']) {
  return assembleFacts({
    target: { host: 'server.example.com', port: 22, username: 'ubuntu', address: '192.168.1.50' },
    hostKey: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:abc', knownHostsLine: 'line' },
    hubUrl: 'https://sencho.example.com',
    composeDir: '/opt/docker/sencho',
    agentDir: '/opt/sencho-agent',
    results,
    fstabMountPoints,
    now: 1_762_300_000_000,
  });
}

function check(facts: ReturnType<typeof makeFacts>, id: string) {
  const found = buildBootstrapEvidence({ facts, nodeNameTaken: false, targetName: 'srv' }).checks.find((entry) => entry.id === id);
  if (!found) throw new Error(`missing check ${id}`);
  return found;
}

function suppressed(facts: ReturnType<typeof makeFacts>): boolean {
  return buildBootstrapEvidence({ facts, nodeNameTaken: false, targetName: 'srv' }).planSuppressed;
}

describe('docker info that cannot reach the daemon', () => {
  // `docker info --format '{{.ServerVersion}}|{{.DockerRootDir}}'` prints the
  // empty template and exits 1 when the socket is unreachable or denied.
  const unreachable = (id: string) => probe(id, '|\n', { exitCode: 1 });

  it('parses the empty template as no answer', () => {
    expect(parseDockerInfo('|\n')).toBeNull();
    expect(parseDockerInfo('27.3.1|/var/lib/docker')).toMatchObject({ serverVersion: '27.3.1' });
  });

  it('falls through to sudo when the direct query printed the template and failed', () => {
    const facts = assemble([
      probe('docker_cli', '/usr/bin/docker'),
      unreachable('docker_info'),
      probe('docker_info_sudo', '27.3.1|/var/lib/docker'),
    ]);
    expect(facts.docker.socketAccess).toBe('sudo');
    expect(facts.docker.serverVersion).toBe('27.3.1');
    expect(facts.docker.rootDir).toBe('/var/lib/docker');
  });

  it('reports no access, not user access, when both queries failed cleanly', () => {
    const facts = assemble([
      probe('docker_cli', '/usr/bin/docker'),
      unreachable('docker_info'),
      unreachable('docker_info_sudo'),
    ]);
    expect(facts.docker.socketAccess).toBe('none');
    expect(facts.docker.serverVersion).toBeNull();
  });

  it('ignores a clean-looking answer from a command that exited non-zero', () => {
    const facts = assemble([
      probe('docker_cli', '/usr/bin/docker'),
      probe('docker_info', '27.3.1|/var/lib/docker', { exitCode: 1 }),
    ]);
    expect(facts.docker.socketAccess).not.toBe('user');
    expect(facts.docker.serverVersion).toBeNull();
  });

  it.each([
    ['timed out', { timedOut: true, exitCode: null }],
    ['truncated', { truncated: true }],
    ['errored', { error: 'COMMAND_ERROR', exitCode: null }],
  ] as const)('keeps a %s query unknown rather than denied', (_label, overrides) => {
    const facts = assemble([
      probe('docker_cli', '/usr/bin/docker'),
      probe('docker_info', '', overrides),
      unreachable('docker_info_sudo'),
    ]);
    expect(facts.docker.socketAccess).toBe('unknown');
    expect(check(makeFacts({ docker: { socketAccess: 'unknown', serverVersion: null } }), 'docker_daemon').status).toBe('unknown');
    expect(check(makeFacts({ docker: { socketAccess: 'unknown', serverVersion: null } }), 'docker_socket').status).toBe('unknown');
  });

  it('blocks a host whose Docker is installed but whose daemon is stopped', () => {
    const facts = makeFacts({
      docker: { serverVersion: null, rootDir: null, socketAccess: 'none', serviceActive: false },
      containers: { complete: false, error: 'exited 1; exited 1' },
      agent: { dataVolumeExists: null },
    });
    const daemon = check(facts, 'docker_daemon');
    expect(daemon.status).toBe('blocked');
    expect(daemon.summary).toMatch(/not running/i);
    expect(suppressed(facts)).toBe(true);
  });

  it('never plans a sudo-less start for a host whose daemon answered only through sudo', () => {
    const facts = assemble([
      probe('docker_cli', '/usr/bin/docker'),
      unreachable('docker_info'),
      probe('docker_info_sudo', '27.3.1|/var/lib/docker'),
    ]);
    expect(check(makeFacts({ docker: { socketAccess: facts.docker.socketAccess } }), 'docker_socket').status).toBe('warn');
  });
});

describe('compose, package and default-directory probes that did not complete', () => {
  it('reads a timed-out Compose version as unknown and a clean miss as absent', () => {
    const unknown = assemble([
      probe('docker_cli', '/usr/bin/docker'),
      probe('compose_version', '', { timedOut: true, exitCode: null }),
      probe('compose_version_sudo', '', { exitCode: 1 }),
    ]);
    expect(unknown.docker.composeVersion).toBeNull();
    expect(unknown.docker.composeProbeUnknown).toBe(true);

    const absent = assemble([
      probe('docker_cli', '/usr/bin/docker'),
      probe('compose_version', '', { exitCode: 1 }),
      probe('compose_version_sudo', '', { exitCode: 1 }),
    ]);
    expect(absent.docker.composeProbeUnknown).toBe(false);
  });

  it('suppresses the plan while the Compose version is unknown', () => {
    const facts = makeFacts({ docker: { composeVersion: null, composeProbeUnknown: true } });
    expect(check(facts, 'compose_plugin').status).toBe('unknown');
    expect(suppressed(facts)).toBe(true);
    expect(() => buildBootstrapPlan({ facts, targetName: 'srv', hubUrl: 'https://sencho.example.com', caPem: null, now: 1 }))
      .toThrow(/complete Docker daemon and Compose probes/);
  });

  it('does not read a failed apt-cache policy as five missing packages', () => {
    const failed = assemble([probe('apt_policy', '', { exitCode: 100 })]);
    expect(failed.packagesComplete).toBe(false);
    expect(assemble([probe('apt_policy', 'docker-ce:\n  Installed: (none)\n  Candidate: 1\n')]).packagesComplete).toBe(true);

    const facts = makeFacts({
      docker: { cliInstalled: false, serverVersion: null, composeVersion: null, socketAccess: 'none', serviceActive: false, serviceEnabled: false },
      repo: { dockerSourceConfigured: false, keyringPresent: false, sourceVerified: false, keyringVerified: false },
      packagesComplete: false,
    });
    expect(check(facts, 'apt_source').status).toBe('unknown');
    expect(suppressed(facts)).toBe(true);
    expect(() => buildBootstrapPlan({ facts, targetName: 'srv', hubUrl: 'https://sencho.example.com', caPem: null, now: 1 }))
      .toThrow(/package source/);
  });

  it('does not need the package list when Docker and Compose already work', () => {
    const facts = makeFacts({ packagesComplete: false });
    expect(check(facts, 'apt_source').status).not.toBe('unknown');
  });

  it('reads a failed default-directory probe as unknown, not as no earlier installation', () => {
    const facts = assemble([probe('default_agent_path', '', { error: 'COMMAND_ERROR', exitCode: null })]);
    expect(facts.agent.defaultDirHasComposeFile).toBeNull();
    expect(assemble([probe('default_agent_path', 'no')]).agent.defaultDirHasComposeFile).toBe(false);

    const unknown = makeFacts({ agent: { defaultDirHasComposeFile: null } });
    expect(check(unknown, 'agent_conflict').status).toBe('unknown');
    expect(suppressed(unknown)).toBe(true);
    expect(() => buildBootstrapPlan({ facts: unknown, targetName: 'srv', hubUrl: 'https://sencho.example.com', caPem: null, now: 1 }))
      .toThrow(/default Pilot directory/);
  });

  it('refuses a direct plan over an incomplete container or volume inventory', () => {
    for (const facts of [
      makeFacts({ containers: { complete: false, error: 'timed out' } }),
      makeFacts({ agent: { dataVolumeExists: null } }),
    ]) {
      expect(() => buildBootstrapPlan({ facts, targetName: 'srv', hubUrl: 'https://sencho.example.com', caPem: null, now: 1 }))
        .toThrow(/container and volume inventory/);
    }
  });
});

describe('fstab and architecture facts that could not be read', () => {
  const pathFacts = [
    'P_EXISTS=1', 'P_ISDIR=1', 'P_REAL=/mnt/data/stacks', 'P_FSTYPE=ext4', 'P_FSTARGET=/mnt/data',
    'P_USER_R=1', 'P_USER_W=1', 'P_PARENT_W=1',
  ].join('\n');

  it('leaves the mount unknown when fstab was not read, instead of unlisted', () => {
    const facts = assemble([probe('path_compose', pathFacts)], null);
    expect(facts.paths.composeDir.mountInFstab).toBeNull();
    expect(assemble([probe('path_compose', pathFacts)], ['/']).paths.composeDir.mountInFstab).toBe(false);
    expect(assemble([probe('path_compose', pathFacts)], ['/mnt/data']).paths.composeDir.mountInFstab).toBe(true);
  });

  it('reports an unreadable architecture as unknown, not unsupported', () => {
    const facts = makeFacts({
      os: { id: 'ubuntu', versionId: '24.04', codename: 'noble', prettyName: 'Ubuntu', arch: '', kernel: '' },
    });
    expect(check(facts, 'arch_supported').status).toBe('unknown');
    expect(suppressed(facts)).toBe(true);
  });
});

describe('hub health classification', () => {
  const curl = (overrides: Partial<SshCommandResult>) => parseHubHealth(probe('hub_health', '000', { exitCode: 7, ...overrides }));

  it('keeps an untrusted certificate and a missing curl distinct from an unreachable hub', () => {
    expect(curl({ exitCode: 60 })).toMatchObject({ reachable: true, tlsTrusted: false });
    expect(curl({ exitCode: 127 })).toMatchObject({ reachable: null });
    expect(curl({ error: 'COMMAND_ERROR', exitCode: null })).toMatchObject({ reachable: null });
    expect(curl({ exitCode: 7 })).toMatchObject({ reachable: false });
    expect(curl({ stdout: '200', exitCode: 0 })).toMatchObject({ reachable: true, statusCode: 200, tlsTrusted: true });
  });

  it('keeps curl stderr available to the classifier and its timeout under the command budget', () => {
    const command = buildProbeCatalog({ composeDir: '/a', agentDir: '/b', hubUrl: 'https://h.example.com' })
      .find((entry) => entry.id === 'hub_health')?.command ?? '';
    expect(command).not.toContain('2>/dev/null');
    expect(command).toMatch(/--max-time 6\b/);
  });

  it('warns when the hub URL answers with an error status', () => {
    const facts = makeFacts({ hub: { reachable: true, statusCode: 502, tlsTrusted: true } });
    expect(check(facts, 'hub_reachable').status).toBe('warn');
    expect(check(makeFacts({ hub: { reachable: true, statusCode: 200, tlsTrusted: true } }), 'hub_reachable').status).toBe('pass');
  });
});

describe('existing Pilot detection', () => {
  it('finds a docker run container named sencho-agent that carries no Compose label', () => {
    const facts = assemble([
      probe('docker_cli', '/usr/bin/docker'),
      probe('docker_info', '27.3.1|/var/lib/docker'),
      probe('containers', 'sencho-agent\tsaelix/sencho:latest\t\t\tUp 3 days\nweb\tnginx\tweb\t/srv/web\tUp'),
    ]);
    expect(facts.containers.agentContainer).toBe('sencho-agent');
    expect(check(facts, 'agent_conflict').status).toBe('blocked');
  });
});

describe('compose stack counting', () => {
  it('counts every stack past the displayed-name cap without calling the count a lower bound', () => {
    const entries = Array.from({ length: 80 }, (_, index) => `/opt/docker/sencho/stack-${index}/compose.yaml`);
    const summary = parseComposeInventory(entries.join('\0'), '/opt/docker/sencho');
    expect(summary.stackCount).toBe(80);
    expect(summary.stackNames).toHaveLength(50);
    expect(summary.truncated).toBe(false);
    expect(parseComposeInventory(entries.join('\0'), '/opt/docker/sencho', true).truncated).toBe(true);
  });
});

describe('docker repository evidence for partial configurations', () => {
  it('does not call a leftover keyring without a source a contradiction', () => {
    const facts = makeFacts({
      docker: { cliInstalled: false, serverVersion: null, composeVersion: null, socketAccess: 'none', serviceActive: false, serviceEnabled: false },
      repo: { dockerSourceConfigured: false, keyringPresent: true, sourceVerified: false, keyringVerified: true },
    });
    expect(check(facts, 'apt_source').status).not.toBe('blocked');
  });

  it('still blocks a source that points somewhere else', () => {
    const facts = makeFacts({
      docker: { cliInstalled: false, serverVersion: null, composeVersion: null, socketAccess: 'none', serviceActive: false, serviceEnabled: false },
      repo: { dockerSourceConfigured: true, keyringPresent: true, sourceVerified: false, keyringVerified: true, problem: 'points elsewhere' },
    });
    expect(check(facts, 'apt_source').status).toBe('blocked');
  });
});

describe('docker commands under a hostile environment', () => {
  // Runs every Docker-bearing catalog command with a fake `docker` and `sudo`
  // and proves the daemon the command talks to does not depend on the SSH
  // user's ambient Docker configuration, in the direct and the sudo form.
  it('pins every catalog Docker call to the local socket and default context', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sencho-docker-pin-'));
    try {
      const bin = path.join(dir, 'bin');
      const log = path.join(dir, 'calls.log');
      mkdirSync(bin);
      writeFileSync(path.join(bin, 'docker'), [
        '#!/bin/sh',
        `printf 'HOST=%s CTX=%s CFG=%s FILE=%s PROJ=%s\\n' "\${DOCKER_HOST-unset}" "\${DOCKER_CONTEXT-unset}" "\${DOCKER_CONFIG-unset}" "\${COMPOSE_FILE-unset}" "\${COMPOSE_PROJECT_NAME-unset}" >> ${JSON.stringify(log)}`,
        'case "$*" in *"volume ls"*|*"volume inspect"*) exit 0;; esac',
        'echo "27.3.1|/var/lib/docker"',
      ].join('\n'), { mode: 0o755 });
      // A sudo that keeps the caller's environment: the worst case for the sudo form.
      writeFileSync(path.join(bin, 'sudo'), '#!/bin/sh\n[ "$1" = "-n" ] && shift\nexec "$@"\n', { mode: 0o755 });
      const catalog = buildProbeCatalog({ composeDir: '/opt/docker/sencho', agentDir: '/opt/sencho-agent', hubUrl: 'https://h.example.com' });
      const dockerProbes = catalog.filter((entry) => /\bdocker\b/.test(entry.command) && entry.id !== 'docker_cli');
      expect(dockerProbes.map((entry) => entry.id)).toEqual(expect.arrayContaining([
        'docker_info', 'docker_info_sudo', 'compose_version', 'compose_version_sudo',
        'containers', 'containers_sudo', 'agent_volume', 'agent_volume_sudo', 'docker_root_disk',
      ]));
      for (const entry of dockerProbes) {
        try {
          execFileSync('sh', ['-c', entry.command], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            env: {
              PATH: `${bin}:${process.env.PATH ?? ''}`,
              DOCKER_HOST: 'tcp://203.0.113.9:2375',
              DOCKER_CONTEXT: 'audit-remote',
              DOCKER_CONFIG: path.join(dir, 'other-config'),
              COMPOSE_FILE: '/tmp/other.yaml',
              COMPOSE_PROJECT_NAME: 'other',
            },
          });
        } catch {
          // Only the daemon a command reaches matters here, not its exit status.
        }
      }
      const calls = readFileSync(log, 'utf8').trim().split('\n');
      // Each of the nine Docker probes reaches the fake at least once.
      expect(calls.length).toBeGreaterThanOrEqual(9);
      for (const call of calls) {
        expect(call).toMatch(/^HOST=unix:\/\/\/var\/run\/docker\.sock CTX=default CFG=unset /);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
