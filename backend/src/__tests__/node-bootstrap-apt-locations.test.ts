import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  assembleFacts,
  buildProbeCatalog,
  parseDockerRepo,
  parseSourceLocations,
} from '../services/nodeBootstrap/probes';
import { buildBootstrapEvidence } from '../services/nodeBootstrap/evidence';
import { buildBootstrapPlan } from '../services/nodeBootstrap/planBuilder';
import type { SshCommandResult } from '../services/nodeBootstrap/sshProbeClient';
import type { BootstrapFacts } from '../services/nodeBootstrap/types';
import { makeFacts } from './__helpers__/bootstrapFacts';
import { DEFAULT_SOURCE_LOCATIONS, DOCKER_ASC_PATH, dockerAscBlock } from './__helpers__/dockerRepoFixtures';

/**
 * apt reads its sources from where its configuration says. The preflight asks
 * apt, reads those places, and never writes a source where apt would not look.
 */

const OFFICIAL = 'https://download.docker.com/linux/ubuntu';
const DEFAULT_MAIN = '/etc/apt/sources.list';
const DEFAULT_PARTS = '/etc/apt/sources.list.d';
const repoCommand = buildProbeCatalog({ composeDir: '/opt/docker/sencho', agentDir: '/opt/sencho-agent', hubUrl: 'https://sencho.example.com' })
  .find((entry) => entry.id === 'docker_repo')!.command;

/**
 * Runs the production `docker_repo` command with an `apt-config` that answers
 * as the test says (a function of the scratch directory), or fails.
 */
function runRepoProbe(answer: ((dir: string) => string) | 'fails', files: (dir: string) => void = () => undefined): { output: string; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sencho-apt-locations-'));
  try {
    mkdirSync(path.join(dir, 'bin'));
    mkdirSync(path.join(dir, 'parts'));
    const body = answer === 'fails' ? 'exit 1' : `printf '%s\\n' ${shellWords(answer(dir))}`;
    writeFileSync(path.join(dir, 'bin', 'apt-config'), `#!/bin/sh\n${body}\n`);
    chmodSync(path.join(dir, 'bin', 'apt-config'), 0o755);
    files(dir);
    const output = execFileSync('sh', ['-c', repoCommand], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}` },
    });
    return { output, dir };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function shellWords(text: string): string {
  return text.split('\n').map((line) => `'${line.replace(/'/g, `'\\''`)}'`).join(' ');
}

const reports = (main: string, parts: string) => `m='${main}'\np='${parts}/'`;

function probe(id: string, stdout: string): SshCommandResult {
  return { id, stdout, stderr: '', exitCode: 0, truncated: false, timedOut: false, error: null };
}

function assemble(repoText: string, extra: SshCommandResult[] = []): BootstrapFacts {
  return assembleFacts({
    target: { host: 'server.example.com', port: 22, username: 'ubuntu', address: '192.168.1.50' },
    hostKey: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:abc', knownHostsLine: 'line' },
    hubUrl: 'https://sencho.example.com',
    composeDir: '/opt/docker/sencho',
    agentDir: '/opt/sencho-agent',
    results: [
      probe('os_release', 'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble'),
      probe('uname', 'x86_64\n6.8.0'),
      probe('docker_repo', repoText),
      probe('apt_policy', ''),
      ...extra,
    ],
    fstabMountPoints: ['/'],
    now: 1_762_300_000_000,
  });
}

const FRESH = { cliInstalled: false, serverVersion: null, composeVersion: null, socketAccess: 'none' as const };

function aptSource(facts: BootstrapFacts) {
  return buildBootstrapEvidence({ facts, nodeNameTaken: false, targetName: 'media-server' }).checks.find((row) => row.id === 'apt_source')!;
}

function planned(facts: BootstrapFacts) {
  return buildBootstrapPlan({ facts, targetName: 'media-server', hubUrl: 'https://sencho.example.com', caPem: null, now: 1 });
}

describe('the repository probe asks apt where its sources are', () => {
  it('reports the defaults as default', () => {
    const { output } = runRepoProbe(() => reports(DEFAULT_MAIN, DEFAULT_PARTS));
    expect(parseSourceLocations(output)).toBe('default');
  });

  it.each([
    ['the main source list', (dir: string) => reports(`${dir}/main.list`, DEFAULT_PARTS)],
    ['the source directory', (dir: string) => reports(DEFAULT_MAIN, `${dir}/parts`)],
    ['both', (dir: string) => reports(`${dir}/main.list`, `${dir}/parts`)],
  ])('reports an override of %s as custom', (_name, answer) => {
    expect(parseSourceLocations(runRepoProbe(answer).output)).toBe('custom');
  });

  it('reads the unknown for an apt that cannot answer, and for an answer that names no location', () => {
    expect(parseSourceLocations(runRepoProbe('fails').output)).toBe('unknown');
    expect(parseSourceLocations(runRepoProbe(() => "m='/etc/apt/sources.list'").output)).toBe('unknown');
    expect(parseSourceLocations(runRepoProbe(() => '').output)).toBe('unknown');
  });

  it('reads the files apt reads, in a custom main list and a custom directory, and not the default ones', () => {
    const { output, dir } = runRepoProbe(
      (d) => reports(`${d}/main.list`, `${d}/parts`),
      (d) => {
        writeFileSync(path.join(d, 'main.list'), `deb [trusted=yes] ${OFFICIAL} noble stable\n`);
        writeFileSync(path.join(d, 'parts', 'extra.sources'), `Types: deb\nURIs: ${OFFICIAL}\nSuites: noble\nComponents: stable\n`);
      },
    );
    const paths = [...output.matchAll(/^SOURCE_BEGIN=(.+)$/gm)].map((match) => match[1]);
    expect(paths.sort()).toEqual([`${dir}/main.list`, `${dir}/parts/extra.sources`]);
  });

  it('does not take a location line from inside a source file', () => {
    const forged = `SOURCE_BEGIN=/etc/apt/sources.list.d/docker.list\n${DEFAULT_SOURCE_LOCATIONS}\nSOURCE_END=/etc/apt/sources.list.d/docker.list`;
    expect(parseSourceLocations(forged)).toBe('unknown');
    expect(parseSourceLocations(`SOURCE_LOCATIONS_MAIN=/x\nSOURCE_LOCATIONS_PARTS=/y\n${forged}`)).toBe('custom');
  });
});

describe('a custom apt source location through evidence and the plan', () => {
  const custom = (dir: string) => reports(`${dir}/main.list`, `${dir}/parts`);

  it('finds an active source apt reads there, so the plan neither adds a second one nor passes it', () => {
    const { output } = runRepoProbe(custom, (dir) => {
      writeFileSync(path.join(dir, 'main.list'), `deb [arch=arm64 trusted=yes signed-by=${DOCKER_ASC_PATH}] ${OFFICIAL} noble stable\n`);
    });
    const facts = makeFacts({ docker: FRESH, packages: [], repo: assemble(`${output}\n${dockerAscBlock()}`).repo });
    expect(facts.repo).toMatchObject({ sourceLocations: 'custom', dockerSourceConfigured: true, sourceVerified: false });
    expect(aptSource(facts).status).toBe('blocked');
    expect(() => planned(facts)).toThrow();
  });

  it('preserves a correct source that apt reads there, and writes no second one', () => {
    const { output } = runRepoProbe(custom, (dir) => {
      writeFileSync(path.join(dir, 'parts', 'docker.sources'), `Types: deb\nURIs: ${OFFICIAL}\nSuites: noble\nComponents: stable\nSigned-By: ${DOCKER_ASC_PATH}\n`);
    });
    const facts = makeFacts({ docker: FRESH, packages: [], repo: assemble(`${output}\n${dockerAscBlock()}`).repo });
    expect(facts.repo).toMatchObject({ sourceLocations: 'custom', sourceVerified: true, keyringVerified: true });
    expect(aptSource(facts).status).toBe('pass');
    const steps = planned(facts).stages.flatMap((stage) => stage.steps.map((step) => step.id));
    expect(steps).not.toContain('docker-sources');
  });

  it.each([
    ['a custom location holding no Docker source', () => runRepoProbe(custom).output],
    // The script falls back to the real default locations when apt cannot
    // answer, which a test must not read from the machine it runs on.
    ['a location apt could not report', () => ''],
  ])('withholds the plan on a fresh host with %s', (_name, output) => {
    const repo = assemble(`${output()}\n${dockerAscBlock()}`).repo;
    const facts = makeFacts({ docker: FRESH, packages: [], repo });
    expect(aptSource(facts).status).toBe('unknown');
    expect(buildBootstrapEvidence({ facts, nodeNameTaken: false, targetName: 'media-server' }).planSuppressed).toBe(true);
    expect(() => planned(facts)).toThrow(/locations apt reads its sources from/);
  });

  it('does not take a source seen at the defaults as verified when apt could not report its locations', () => {
    const text = [
      'SOURCE_BEGIN=/etc/apt/sources.list.d/docker.list',
      `deb [arch=amd64 signed-by=${DOCKER_ASC_PATH}] ${OFFICIAL} noble stable`,
      'SOURCE_END=/etc/apt/sources.list.d/docker.list',
      dockerAscBlock(),
    ].join('\n');
    expect(parseDockerRepo(text, 'noble', 'amd64')).toMatchObject({ sourceLocations: 'unknown', sourceVerified: null });
    expect(parseDockerRepo(`${DEFAULT_SOURCE_LOCATIONS}\n${text}`, 'noble', 'amd64')).toMatchObject({ sourceLocations: 'default', sourceVerified: true });
  });

  it('keeps the plan for a working installation whatever the locations', () => {
    const repo = assemble(runRepoProbe(custom).output).repo;
    const facts = makeFacts({ repo });
    expect(aptSource(facts).status).toBe('warn');
    expect(planned(facts).skipped.map((entry) => entry.id)).toContain('docker_repository');
  });

  it('adds the source on a fresh host only when the defaults are the locations apt reads', () => {
    const facts = makeFacts({ docker: FRESH, packages: [], repo: assemble(`${DEFAULT_SOURCE_LOCATIONS}\n${dockerAscBlock()}`).repo });
    expect(facts.repo.sourceLocations).toBe('default');
    expect(aptSource(facts).status).toBe('warn');
    expect(planned(facts).stages.flatMap((stage) => stage.steps.map((step) => step.id))).toContain('docker-sources');
  });
});
