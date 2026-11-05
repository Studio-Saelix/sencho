import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  assembleFacts,
  buildDockerRepoScript,
  buildProbeCatalog,
  debianArchitecture,
  parseAptPolicy,
  parseDockerRepo,
  parseRepoProbeOutput,
} from '../services/nodeBootstrap/probes';
import { buildBootstrapEvidence, repoVerified } from '../services/nodeBootstrap/evidence';
import { buildBootstrapPlan } from '../services/nodeBootstrap/planBuilder';
import type { SshCommandResult } from '../services/nodeBootstrap/sshProbeClient';
import type { BootstrapCheck, BootstrapFacts } from '../services/nodeBootstrap/types';
import { makeFacts } from './__helpers__/bootstrapFacts';
import { DOCKER_ASC_PATH, DOCKER_KEY_GPG, dockerAscBlock, keyBlock, unrelatedKeyBinary } from './__helpers__/dockerRepoFixtures';

/**
 * Repository verification must hold for the host's own architecture and for
 * every source in apt's default source list, not two conventional file names.
 */

const OFFICIAL = 'https://download.docker.com/linux/ubuntu';
const LIST_FILE = '/etc/apt/sources.list.d/docker.list';
const SOURCES_FILE = '/etc/apt/sources.list.d/docker.sources';
const CUSTOM_LIST = '/etc/apt/sources.list.d/containers.list';
const CUSTOM_SOURCES = '/etc/apt/sources.list.d/containers.sources';
const MAIN_LIST = '/etc/apt/sources.list';
const GPG_PATH = '/usr/share/keyrings/docker-archive-keyring.gpg';

const block = (file: string, content: string) => `SOURCE_BEGIN=${file}\n${content}\nSOURCE_END=${file}`;
const deb = (options: string, uri = OFFICIAL) => `deb [${options} signed-by=${DOCKER_ASC_PATH}] ${uri} noble stable`;
const stanza = (fields: Record<string, string>) => Object.entries({
  Types: 'deb', URIs: OFFICIAL, Suites: 'noble', Components: 'stable', 'Signed-By': DOCKER_ASC_PATH, ...fields,
}).map(([name, value]) => `${name}: ${value}`).join('\n');
const parse = (arch: string, ...parts: string[]) => parseDockerRepo(parts.join('\n'), 'noble', arch);

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
    results: [
      probe('os_release', 'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble'),
      probe('uname', 'x86_64\n6.8.0'),
      ...results,
    ],
    fstabMountPoints: ['/'],
    now: 1_762_300_000_000,
  });
}

const FRESH_DOCKER = { cliInstalled: false, serverVersion: null, composeVersion: null, socketAccess: 'none' as const };
const NO_CANDIDATES = parseAptPolicy('');
const OFFICIAL_CANDIDATE = [
  'docker-ce:', '  Installed: (none)', '  Candidate: 5:27.3.1-1', '  Version table:',
  '     5:27.3.1-1 500', `        500 ${OFFICIAL} noble/stable amd64 Packages`,
].join('\n');

/** A fresh host whose repository facts come from the given probe output. */
function freshHost(repoText: string, policy = ''): BootstrapFacts {
  const assembled = assemble([probe('docker_repo', repoText), probe('apt_policy', policy)]);
  return makeFacts({
    docker: FRESH_DOCKER,
    packages: policy ? parseAptPolicy(policy) : NO_CANDIDATES,
    repo: assembled.repo,
  });
}

function evidenceFor(facts: BootstrapFacts) {
  return buildBootstrapEvidence({ facts, nodeNameTaken: false, targetName: 'media-server' });
}

/** The service issues no plan when a check is blocked or a required fact is unknown. */
function planWithheld(facts: BootstrapFacts): boolean {
  const result = evidenceFor(facts);
  return result.blockers > 0 || result.planSuppressed;
}

function aptSource(facts: BootstrapFacts): BootstrapCheck {
  const row = evidenceFor(facts).checks.find((entry) => entry.id === 'apt_source');
  if (!row) throw new Error('missing apt_source check');
  return row;
}

function planFor(facts: BootstrapFacts) {
  return buildBootstrapPlan({ facts, targetName: 'media-server', hubUrl: 'https://sencho.example.com', caPem: null, now: 1 });
}

function stageIds(facts: BootstrapFacts): string[] {
  return planFor(facts).stages.map((stage) => stage.id);
}

describe('a source that cannot supply the host architecture', () => {
  it('maps the machine type to the Debian architecture', () => {
    expect(debianArchitecture('x86_64')).toBe('amd64');
    expect(debianArchitecture('aarch64')).toBe('arm64');
    expect(debianArchitecture('riscv64')).toBe('riscv64');
  });

  describe('one-line format', () => {
    it.each([
      ['arch=amd64', 'amd64', true],
      ['arch=amd64,arm64', 'amd64', true],
      ['arch=arm64,amd64', 'amd64', true],
      ['', 'amd64', true],
      ['arch=arm64', 'amd64', false],
      ['arch=ppc64el,s390x', 'amd64', false],
      ['arch=arm64 arch+=amd64', 'amd64', true],
      ['arch+=arm64', 'amd64', true],
      ['arch-=amd64', 'amd64', false],
      ['arch=amd64,arm64 arch-=amd64', 'amd64', false],
      ['arch=amd64 arch-=arm64', 'amd64', true],
      ['arch=amd64', 'arm64', false],
      ['arch=arm64', 'arm64', true],
    ])('%s on %s is verified: %s', (options, arch, verified) => {
      const result = parse(arch, block(LIST_FILE, deb(options)), dockerAscBlock());
      expect(result.sourceVerified).toBe(verified);
      if (!verified) expect(result.problem).toContain(`${arch} architecture`);
    });

    it('treats an empty architecture list as restricting to nothing', () => {
      expect(parse('amd64', block(LIST_FILE, deb('arch=')), dockerAscBlock()).sourceVerified).toBe(false);
    });
  });

  describe('deb822 format', () => {
    it.each([
      [{}, true],
      [{ Architectures: 'amd64' }, true],
      [{ Architectures: 'amd64 arm64' }, true],
      [{ Architectures: 'ppc64el' }, false],
      [{ Architectures: 'arm64' }, false],
      [{ Architectures: 'arm64', 'Architectures-Add': 'amd64' }, true],
      [{ 'Architectures-Add': 'arm64' }, true],
      [{ 'Architectures-Remove': 'amd64' }, false],
      [{ Architectures: 'amd64 arm64', 'Architectures-Remove': 'amd64' }, false],
      [{ 'Architectures-Remove': 'arm64' }, true],
    ])('%j is verified: %s', (fields, verified) => {
      const result = parse('amd64', block(SOURCES_FILE, stanza(fields)), dockerAscBlock());
      expect(result.sourceVerified).toBe(verified);
      if (!verified) expect(result.problem).toContain('amd64 architecture');
    });
  });

  it('leaves the verdict unknown, not verified, when the host architecture is unknown but the source restricts it', () => {
    expect(parse('', block(LIST_FILE, deb('arch=amd64')), dockerAscBlock()).sourceVerified).toBeNull();
    expect(parse('', block(SOURCES_FILE, stanza({ 'Architectures-Remove': 'amd64' })), dockerAscBlock()).sourceVerified).toBeNull();
    expect(parse('', block(LIST_FILE, deb('')), dockerAscBlock()).sourceVerified).toBe(true);
  });

  describe('through evidence and the plan', () => {
    const cases: Array<[string, string]> = [
      ['a one-line source for arm64', block(LIST_FILE, deb('arch=arm64'))],
      ['a deb822 source for ppc64el', block(SOURCES_FILE, stanza({ Architectures: 'ppc64el' }))],
      ['a deb822 source that removes amd64', block(SOURCES_FILE, stanza({ 'Architectures-Remove': 'amd64' }))],
    ];

    it.each(cases)('blocks %s on a fresh host and issues no plan', (_label, source) => {
      const facts = freshHost([source, dockerAscBlock()].join('\n'));
      expect(repoVerified(facts)).toBe(false);
      expect(aptSource(facts).status).toBe('blocked');
      expect(aptSource(facts).observed).toContain('amd64 architecture');
      expect(planWithheld(facts)).toBe(true);
      expect(() => planFor(facts)).toThrow(/not verified/);
    });

    it.each(cases)('blocks %s even when apt lists official candidates', (_label, source) => {
      const facts = freshHost([source, dockerAscBlock()].join('\n'), OFFICIAL_CANDIDATE);
      expect(repoVerified(facts)).toBe(false);
      expect(planWithheld(facts)).toBe(true);
    });

    it('covers the five Docker packages through one repository verdict', () => {
      const facts = freshHost([block(LIST_FILE, deb('arch=arm64')), dockerAscBlock()].join('\n'));
      expect(facts.packages).toHaveLength(5);
      expect(facts.packages.every((pkg) => pkg.installedVersion === null)).toBe(true);
      expect(planWithheld(facts)).toBe(true);
    });

    it('still plans the refresh for a native-inclusive source', () => {
      const facts = freshHost([block(LIST_FILE, deb('arch=amd64,arm64')), dockerAscBlock()].join('\n'));
      expect(repoVerified(facts)).toBe(true);
      expect(planWithheld(facts)).toBe(false);
      expect(stageIds(facts)).toContain('docker_repository');
    });

    it('preserves a working installation whose source excludes the architecture', () => {
      const assembled = assemble([probe('docker_repo', [block(LIST_FILE, deb('arch=arm64')), dockerAscBlock()].join('\n'))]);
      const facts = makeFacts({ packages: NO_CANDIDATES, repo: assembled.repo });
      expect(aptSource(facts).status).toBe('warn');
      expect(stageIds(facts)).not.toContain('docker_repository');
    });

    it('writes the source line for the host architecture the verifier checks', () => {
      const facts = makeFacts({
        docker: FRESH_DOCKER,
        packages: NO_CANDIDATES,
        repo: { probeComplete: true, dockerSourceConfigured: false, keyringPresent: false, sourceVerified: false, keyringVerified: false, candidateSourceVerified: null, problem: null },
      });
      const step = planFor(facts).stages.flatMap((stage) => stage.steps).find((entry) => entry.id === 'docker-sources');
      expect(step?.file?.content).toContain('arch=amd64');
      expect(step?.file?.path).toBe(LIST_FILE);
      const key = planFor(facts).stages.flatMap((stage) => stage.steps).find((entry) => entry.id === 'docker-key');
      expect(key?.command).toContain(DOCKER_ASC_PATH);
      const written = parse('amd64', block(step!.file!.path, step!.file!.content.trim()), dockerAscBlock());
      expect(written.sourceVerified).toBe(true);
      expect(written.dockerSourceConfigured).toBe(true);
    });
  });
});

describe('sources outside docker.list and docker.sources', () => {
  describe('which files count', () => {
    it.each([
      ['a custom .list', CUSTOM_LIST, deb('arch=amd64 trusted=yes')],
      ['the main source list', MAIN_LIST, deb('arch=amd64 trusted=yes')],
      ['a custom .sources', CUSTOM_SOURCES, stanza({ Trusted: 'yes' })],
    ])('rejects %s that bypasses signature checking', (_label, file, content) => {
      const result = parse('amd64', block(file, content), dockerAscBlock());
      expect(result.dockerSourceConfigured).toBe(true);
      expect(result.sourceVerified).toBe(false);
      expect(result.problem).toContain(file);
      expect(result.problem).toMatch(/weakens signature checking/);
    });

    it.each([
      ['a custom .list', CUSTOM_LIST, deb('arch=amd64')],
      ['the main source list', MAIN_LIST, deb('arch=amd64')],
      ['a custom .sources', CUSTOM_SOURCES, stanza({})],
    ])('verifies and preserves %s that is correct', (_label, file, content) => {
      const result = parse('amd64', block(file, content), dockerAscBlock());
      expect(result.dockerSourceConfigured).toBe(true);
      expect(result.sourceVerified).toBe(true);
    });

    it('treats a trailing slash on the URI as the same repository', () => {
      expect(parse('amd64', block(CUSTOM_LIST, deb('arch=amd64', `${OFFICIAL}/`)), dockerAscBlock()).sourceVerified).toBe(true);
      expect(parse('amd64', block(CUSTOM_SOURCES, stanza({ URIs: `${OFFICIAL}/` })), dockerAscBlock()).sourceVerified).toBe(true);
    });

    it('recognizes the host in upper or lower case', () => {
      const result = parse('amd64', block(CUSTOM_LIST, deb('arch=amd64 trusted=yes', 'https://Download.Docker.com/linux/ubuntu')), dockerAscBlock());
      expect(result.dockerSourceConfigured).toBe(true);
      expect(result.sourceVerified).toBe(false);
    });

    it('rejects a custom source for another path or scheme on Docker\'s host', () => {
      expect(parse('amd64', block(CUSTOM_LIST, deb('arch=amd64', 'https://download.docker.com/linux/debian')), dockerAscBlock()).sourceVerified).toBe(false);
      expect(parse('amd64', block(CUSTOM_LIST, deb('arch=amd64', 'http://download.docker.com/linux/ubuntu')), dockerAscBlock()).sourceVerified).toBe(false);
    });

    it('ignores a file that only mentions the host in a comment, and any unrelated source', () => {
      const result = parse('amd64', block(MAIN_LIST, '# see https://download.docker.com/linux/ubuntu\ndeb http://archive.ubuntu.com/ubuntu noble main'), dockerAscBlock());
      expect(result.dockerSourceConfigured).toBe(false);
      expect(result.sourceVerified).toBe(false);
      const deb822 = parse('amd64', block(CUSTOM_SOURCES, stanza({ URIs: 'https://example.com/ubuntu', Comment: 'download.docker.com mirror' })), dockerAscBlock());
      expect(deb822.dockerSourceConfigured).toBe(false);
    });

    it('does not count a custom deb-src entry as a binary source', () => {
      const result = parse('amd64', block(CUSTOM_LIST, `deb-src [signed-by=${DOCKER_ASC_PATH}] ${OFFICIAL} noble stable`), dockerAscBlock());
      expect(result.dockerSourceConfigured).toBe(true);
      expect(result.sourceVerified).toBe(false);
      expect(result.problem).toMatch(/no enabled binary/);
    });

    it('holds a deb-src twin to the signing options of the source it shares', () => {
      const source = [deb('arch=amd64'), `deb-src [trusted=yes signed-by=${DOCKER_ASC_PATH}] ${OFFICIAL} noble stable`].join('\n');
      expect(parse('amd64', block(CUSTOM_LIST, source), dockerAscBlock()).sourceVerified).toBe(false);
    });

    it('treats a trailing comment on an entry as a comment', () => {
      expect(parse('amd64', block(CUSTOM_LIST, `${deb('arch=amd64')} # Docker`), dockerAscBlock()).sourceVerified).toBe(true);
    });

    it('rejects an unparseable line that concerns Docker and ignores one that does not', () => {
      const broken = parse('amd64', block(MAIN_LIST, `deb ${OFFICIAL}`), dockerAscBlock());
      expect(broken.sourceVerified).toBe(false);
      expect(broken.problem).toMatch(/not a valid apt entry/);
      const unrelated = parse('amd64', block(MAIN_LIST, `deb broken\n${deb('arch=amd64')}`), dockerAscBlock());
      expect(unrelated.sourceVerified).toBe(true);
    });
  });

  describe('several files that configure Docker', () => {
    it('accepts a second file that agrees on the keyring', () => {
      const result = parse('amd64', block(LIST_FILE, deb('arch=amd64')), block(CUSTOM_LIST, deb('arch=amd64')), dockerAscBlock());
      expect(result.sourceVerified).toBe(true);
    });

    it('rejects two files that name different Docker keyrings for one source, which apt refuses', () => {
      const other = `deb [arch=amd64 signed-by=${GPG_PATH}] ${OFFICIAL} noble stable`;
      const result = parse(
        'amd64',
        block(LIST_FILE, deb('arch=amd64')),
        block(CUSTOM_LIST, other),
        dockerAscBlock(),
        keyBlock(GPG_PATH, DOCKER_KEY_GPG),
      );
      // Both keyrings hold Docker's key, so only the disagreement is wrong.
      expect(result.keyringVerified).toBe(true);
      expect(result.sourceVerified).toBe(false);
      expect(result.problem).toMatch(/different Signed-By values/);
    });

    it('rejects the same disagreement between the two formats and the main list', () => {
      const other = stanza({ 'Signed-By': GPG_PATH });
      const keys = [dockerAscBlock(), keyBlock(GPG_PATH, DOCKER_KEY_GPG)];
      expect(parse('amd64', block(MAIN_LIST, deb('arch=amd64')), block(CUSTOM_SOURCES, other), ...keys).sourceVerified).toBe(false);
      expect(parse('amd64', block(SOURCES_FILE, stanza({})), block(CUSTOM_LIST, `deb [signed-by=${GPG_PATH}] ${OFFICIAL} noble stable`), ...keys).sourceVerified).toBe(false);
    });

    it('rejects a good conventional file beside a custom one that names a keyring that is not Docker\'s', () => {
      const other = '/etc/apt/keyrings/other.gpg';
      const result = parse(
        'amd64',
        block(LIST_FILE, deb('arch=amd64')),
        block(CUSTOM_LIST, `deb [arch=amd64 signed-by=${other}] ${OFFICIAL} noble stable`),
        dockerAscBlock(),
        keyBlock(other, unrelatedKeyBinary()),
      );
      expect(result.sourceVerified).toBe(false);
    });

    it('keys the conflict by suite, so an entry that lists several suites is compared for each', () => {
      const result = parse(
        'amd64',
        block(LIST_FILE, deb('arch=amd64')),
        block(CUSTOM_SOURCES, stanza({ Suites: 'noble jammy', 'Signed-By': GPG_PATH })),
        dockerAscBlock(),
        keyBlock(GPG_PATH, DOCKER_KEY_GPG),
      );
      expect(result.sourceVerified).toBe(false);
      expect(result.problem).toMatch(/different Signed-By values for .* noble/);
    });

    it('rejects a deb-src twin that names another keyring, and a trailing-slash twin', () => {
      const keys = [dockerAscBlock(), keyBlock(GPG_PATH, DOCKER_KEY_GPG)];
      const srcTwin = `deb-src [signed-by=${GPG_PATH}] ${OFFICIAL} noble stable`;
      expect(parse('amd64', block(LIST_FILE, `${deb('arch=amd64')}\n${srcTwin}`), ...keys).sourceVerified).toBe(false);
      const slashTwin = `deb [arch=amd64 signed-by=${GPG_PATH}] ${OFFICIAL}/ noble stable`;
      expect(parse('amd64', block(LIST_FILE, deb('arch=amd64')), block(CUSTOM_LIST, slashTwin), ...keys).sourceVerified).toBe(false);
    });

    it('accepts a deb-src twin that names no keyring', () => {
      const srcTwin = `deb-src ${OFFICIAL} noble stable`;
      expect(parse('amd64', block(LIST_FILE, `${deb('arch=amd64')}\n${srcTwin}`), dockerAscBlock()).sourceVerified).toBe(true);
    });

    it('rejects two entries for one source that disagree on trusted, which apt refuses', () => {
      expect(parse('amd64', block(LIST_FILE, deb('arch=amd64 trusted=no')), block(CUSTOM_LIST, deb('arch=amd64')), dockerAscBlock()).sourceVerified).toBe(false);
      const agreeing = parse('amd64', block(LIST_FILE, deb('arch=amd64 trusted=no')), block(CUSTOM_LIST, deb('arch=amd64 trusted=no')), dockerAscBlock());
      expect(agreeing.sourceVerified).toBe(true);
    });

    it('requires every Docker entry to include the host architecture, even when another entry covers it', () => {
      const split = [deb('arch=amd64'), deb('arch=arm64')].join('\n');
      const result = parse('amd64', block(LIST_FILE, split), dockerAscBlock());
      expect(result.sourceVerified).toBe(false);
      expect(result.problem).toContain('amd64 architecture');
    });
  });

  describe('sources that are malformed or unusual are never read as absent', () => {
    const noTypes = 'URIs: https://download.docker.com/linux/ubuntu\nSuites: noble\nComponents: stable';
    it.each([
      ['a deb822 stanza with no Types', CUSTOM_SOURCES, noTypes],
      ['a deb822 stanza with an unknown type', CUSTOM_SOURCES, stanza({ Types: 'rpm' })],
      ['a deb822 field with no colon', CUSTOM_SOURCES, `Types: deb\nURIs ${OFFICIAL}\nSuites: noble\nComponents: stable`],
      ['a deb822 URI with a trailing dot on the host', CUSTOM_SOURCES, stanza({ URIs: 'https://download.docker.com./linux/ubuntu' })],
      ['a one-line entry with an unclosed option bracket', CUSTOM_LIST, `deb [trusted=yes ${OFFICIAL} noble stable`],
      ['a one-line entry with no URI scheme', MAIN_LIST, 'deb download.docker.com/linux/ubuntu noble stable'],
      ['a one-line entry with a trailing dot on the host', CUSTOM_LIST, deb('arch=amd64', 'https://download.docker.com./linux/ubuntu')],
    ])('counts %s as a Docker source that does not verify', (_label, file, content) => {
      const result = parse('amd64', block(file, content), dockerAscBlock());
      expect(result.dockerSourceConfigured).toBe(true);
      expect(result.sourceVerified).toBe(false);
      expect(result.problem).toContain(file);
      const facts = freshHost([block(file, content), dockerAscBlock()].join('\n'));
      expect(planWithheld(facts)).toBe(true);
    });

    it('still ignores an unrelated stanza or line beside a good Docker entry', () => {
      const unrelatedList = 'deb http://archive.ubuntu.com/ubuntu noble main universe\n# deb https://download.docker.com/linux/ubuntu old stable';
      expect(parse('amd64', block(MAIN_LIST, `${unrelatedList}\n${deb('arch=amd64')}`), dockerAscBlock()).sourceVerified).toBe(true);
      const unrelatedStanza = `Types: deb\nURIs: http://archive.ubuntu.com/ubuntu\nSuites: noble\nComponents: main\n\n${stanza({})}`;
      expect(parse('amd64', block(CUSTOM_SOURCES, unrelatedStanza), dockerAscBlock()).sourceVerified).toBe(true);
    });

    it('does not let a marker line inside a source file close the block early', () => {
      const output = `SOURCE_BEGIN=${CUSTOM_LIST}\nSOURCE_END=/elsewhere\n${deb('arch=amd64 trusted=yes')}\nSOURCE_END=${CUSTOM_LIST}`;
      const [source] = parseRepoProbeOutput(output).sources;
      expect(source.content).toContain('trusted=yes');
      expect(parse('amd64', output, dockerAscBlock()).sourceVerified).toBe(false);
    });
  });

  describe('option spelling', () => {
    it('ignores a one-line Signed-By in a spelling apt does not read, so the source names no keyring', () => {
      const result = parse('amd64', block(CUSTOM_LIST, `deb [arch=amd64 Signed-By=${DOCKER_ASC_PATH}] ${OFFICIAL} noble stable`), dockerAscBlock());
      expect(result.sourceVerified).toBe(false);
      expect(result.problem).toMatch(/signed-by/);
    });

    it('ignores a one-line Arch in a spelling apt does not read, as apt does', () => {
      expect(parse('amd64', block(CUSTOM_LIST, deb('Arch=arm64')), dockerAscBlock()).sourceVerified).toBe(true);
    });

    it('honors the signing options in any spelling, so a bypass cannot hide in the letter case', () => {
      expect(parse('amd64', block(CUSTOM_LIST, deb('arch=amd64 TRUSTED=yes')), dockerAscBlock()).sourceVerified).toBe(false);
      expect(parse('amd64', block(CUSTOM_LIST, deb('arch=amd64 Allow-Insecure=yes')), dockerAscBlock()).sourceVerified).toBe(false);
    });
  });

  describe('an unknown host release', () => {
    it('leaves a good source unknown rather than naming the wrong suite', () => {
      const result = parseDockerRepo([block(LIST_FILE, deb('arch=amd64')), dockerAscBlock()].join('\n'), '', 'amd64');
      expect(result.sourceVerified).toBeNull();
      expect(result.problem).toMatch(/host release is unknown/);
    });
  });

  describe('unreadable sources', () => {
    it('keeps an unreadable custom file unknown and counts it as configuration', () => {
      const result = parse('amd64', `SOURCE_BEGIN=${CUSTOM_LIST}\nSOURCE_UNREADABLE=1\nSOURCE_END=${CUSTOM_LIST}`, dockerAscBlock());
      expect(result.dockerSourceConfigured).toBe(true);
      expect(result.sourceVerified).toBeNull();
      expect(result.problem).toContain(CUSTOM_LIST);
    });

    it('lets a known contradiction outweigh a file that cannot be read', () => {
      const unreadable = `SOURCE_BEGIN=${CUSTOM_LIST}\nSOURCE_UNREADABLE=1\nSOURCE_END=${CUSTOM_LIST}`;
      const result = parse('amd64', block(LIST_FILE, deb('arch=amd64 trusted=yes')), unreadable, dockerAscBlock());
      expect(result.sourceVerified).toBe(false);
      expect(result.problem).toContain(LIST_FILE);
    });

    it('keeps an unreadable source directory unknown beside a good file', () => {
      const result = parse('amd64', block(LIST_FILE, deb('arch=amd64')), 'SOURCE_BEGIN=/etc/apt/sources.list.d\nSOURCE_UNREADABLE=1\nSOURCE_END=/etc/apt/sources.list.d', dockerAscBlock());
      expect(result.sourceVerified).toBeNull();
    });
  });

  describe('through evidence and the plan', () => {
    it.each([
      ['a custom .list', CUSTOM_LIST, deb('arch=amd64 trusted=yes')],
      ['the main source list', MAIN_LIST, deb('arch=amd64 trusted=yes')],
      ['a custom .sources', CUSTOM_SOURCES, stanza({ Trusted: 'yes' })],
    ])('blocks %s with a signing bypass on a fresh host, so no second source is proposed', (_label, file, content) => {
      const facts = freshHost([block(file, content), dockerAscBlock()].join('\n'));
      expect(aptSource(facts).status).toBe('blocked');
      expect(planWithheld(facts)).toBe(true);
      expect(() => planFor(facts)).toThrow();
    });

    it('blocks two keyring names for one source on a fresh host', () => {
      const facts = freshHost([
        block(LIST_FILE, deb('arch=amd64')),
        block(CUSTOM_LIST, `deb [signed-by=${GPG_PATH}] ${OFFICIAL} noble stable`),
        dockerAscBlock(),
        keyBlock(GPG_PATH, DOCKER_KEY_GPG),
      ].join('\n'));
      expect(aptSource(facts).status).toBe('blocked');
      expect(planWithheld(facts)).toBe(true);
    });

    it('withholds the plan while a source file cannot be read', () => {
      const facts = freshHost([`SOURCE_BEGIN=${CUSTOM_LIST}\nSOURCE_UNREADABLE=1\nSOURCE_END=${CUSTOM_LIST}`, dockerAscBlock()].join('\n'));
      expect(aptSource(facts).status).toBe('unknown');
      expect(planWithheld(facts)).toBe(true);
    });

    it.each([
      ['a custom .list', CUSTOM_LIST, deb('arch=amd64')],
      ['the main source list', MAIN_LIST, deb('arch=amd64')],
      ['a custom .sources', CUSTOM_SOURCES, stanza({})],
      ['a native-inclusive .list', CUSTOM_LIST, deb('arch=amd64,arm64')],
    ])('preserves %s that is correct: it refreshes the index and writes no second source', (_label, file, content) => {
      for (const policy of ['', OFFICIAL_CANDIDATE]) {
        const facts = freshHost([block(file, content), dockerAscBlock()].join('\n'), policy);
        expect(repoVerified(facts)).toBe(true);
        expect(aptSource(facts).status).toBe('pass');
        expect(planWithheld(facts)).toBe(false);
        const steps = planFor(facts).stages.flatMap((stage) => stage.steps).map((step) => step.id);
        expect(steps).toContain('apt-update');
        expect(steps).not.toContain('docker-sources');
        expect(steps).not.toContain('docker-key');
      }
    });

    it('withholds the plan for a source directory that cannot be read', () => {
      const facts = freshHost(['SOURCE_BEGIN=/etc/apt/sources.list.d\nSOURCE_UNREADABLE=1\nSOURCE_END=/etc/apt/sources.list.d', dockerAscBlock()].join('\n'));
      expect(aptSource(facts).status).toBe('unknown');
      expect(planWithheld(facts)).toBe(true);
    });

    it('withholds the plan when the host architecture is unknown and the source restricts it', () => {
      const assembled = assemble([
        probe('uname', '', { exitCode: 1 }),
        probe('docker_repo', [block(LIST_FILE, deb('arch=amd64')), dockerAscBlock()].join('\n')),
      ]);
      expect(assembled.repo.sourceVerified).toBeNull();
      const facts = makeFacts({ docker: FRESH_DOCKER, packages: NO_CANDIDATES, repo: assembled.repo, os: null });
      expect(planWithheld(facts)).toBe(true);
    });

    it('only writes a source when no Docker source exists anywhere', () => {
      const none = freshHost(dockerAscBlock());
      expect(aptSource(none).status).toBe('warn');
      expect(planFor(none).stages.flatMap((stage) => stage.steps).map((step) => step.id)).toContain('docker-sources');
    });

    it('refuses to write a source line for an unknown architecture', () => {
      const facts = makeFacts({
        docker: FRESH_DOCKER,
        packages: NO_CANDIDATES,
        os: { id: 'ubuntu', versionId: '24.04', codename: 'noble', prettyName: 'Ubuntu 24.04', arch: '', kernel: '' },
        repo: { probeComplete: true, dockerSourceConfigured: false, keyringPresent: false, sourceVerified: false, keyringVerified: false, candidateSourceVerified: null, problem: null },
      });
      expect(() => planFor(facts)).toThrow(/known architecture/);
    });

    it('never builds a plan that adds the Docker source beside one that is not verified', () => {
      const states: Array<Partial<BootstrapFacts['repo']>> = [
        { keyringVerified: false },
        { keyringPresent: false },
        { sourceVerified: false },
        { sourceVerified: null },
        { sourceVerified: true, keyringVerified: true, candidateSourceVerified: false },
        { sourceVerified: true, keyringVerified: true, candidateSourceVerified: null },
      ];
      for (const state of states) {
        const facts = makeFacts({
          docker: FRESH_DOCKER,
          packages: parseAptPolicy(OFFICIAL_CANDIDATE),
          repo: { probeComplete: true, dockerSourceConfigured: true, keyringPresent: true, keyringVerified: true, candidateSourceVerified: null, problem: null, sourceVerified: true, ...state },
        });
        expect(planWithheld(facts), JSON.stringify(state)).toBe(true);
        expect(() => planFor(facts), JSON.stringify(state)).toThrow(/existing Docker source/);
      }
    });
  });
});

describe('the probe reads the apt source files', () => {
  const canDeny = process.getuid?.() !== 0;

  function run(setup: (dir: string) => { files: string[]; dirs: string[] }): { output: string; dir: string } {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sencho-repo-sources-'));
    try {
      const { files, dirs } = setup(dir);
      const output = execFileSync('sh', ['-c', buildDockerRepoScript(files, dirs, [])], { encoding: 'utf8' });
      return { output, dir };
    } finally {
      for (const closed of ['closed', 'unlistable', 'parts/closed.list']) {
        try { chmodSync(path.join(dir, closed), 0o700); } catch { /* not created */ }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const paths = (output: string) => parseRepoProbeOutput(output).sources.map((source) => path.basename(source.path)).sort();

  it('emits files that mention Docker\'s host, in the main list and in the directory, in either case', () => {
    const { output } = run((dir) => {
      mkdirSync(path.join(dir, 'parts'));
      writeFileSync(path.join(dir, 'sources.list'), `deb [trusted=yes] ${OFFICIAL} noble stable\n`);
      writeFileSync(path.join(dir, 'parts', 'a.list'), `deb ${OFFICIAL.toUpperCase()} noble stable\n`);
      writeFileSync(path.join(dir, 'parts', 'b.sources'), `Types: deb\nURIs: ${OFFICIAL}\n`);
      return { files: [path.join(dir, 'sources.list')], dirs: [path.join(dir, 'parts')] };
    });
    expect(paths(output)).toEqual(['a.list', 'b.sources', 'sources.list']);
  });

  it('leaves out files that do not mention Docker\'s host, so unrelated sources do not fill the output', () => {
    const { output } = run((dir) => {
      mkdirSync(path.join(dir, 'parts'));
      writeFileSync(path.join(dir, 'sources.list'), 'deb http://archive.ubuntu.com/ubuntu noble main\n');
      writeFileSync(path.join(dir, 'parts', 'ubuntu.sources'), 'Types: deb\nURIs: http://archive.ubuntu.com/ubuntu\n');
      return { files: [path.join(dir, 'sources.list')], dirs: [path.join(dir, 'parts')] };
    });
    expect(output).toBe('');
  });

  it('always emits the files the plan writes, whatever they point at', () => {
    const { output } = run((dir) => {
      mkdirSync(path.join(dir, 'parts'));
      writeFileSync(path.join(dir, 'parts', 'docker.list'), 'deb https://example.com/ubuntu noble stable\n');
      writeFileSync(path.join(dir, 'parts', 'docker.sources'), '');
      return { files: [], dirs: [path.join(dir, 'parts')] };
    });
    expect(paths(output)).toEqual(['docker.list', 'docker.sources']);
  });

  it('skips the names apt itself ignores', () => {
    const { output } = run((dir) => {
      mkdirSync(path.join(dir, 'parts'));
      for (const name of ['docker.list.save', 'old.list.disabled', 'notes.txt', 'bad name.list', 'tilde.list~']) {
        writeFileSync(path.join(dir, 'parts', name), `deb ${OFFICIAL} noble stable\n`);
      }
      writeFileSync(path.join(dir, 'parts', 'good-name_1.list'), `deb ${OFFICIAL} noble stable\n`);
      return { files: [], dirs: [path.join(dir, 'parts')] };
    });
    expect(paths(output)).toEqual(['good-name_1.list']);
  });

  it('follows a symlinked source file', () => {
    const { output } = run((dir) => {
      mkdirSync(path.join(dir, 'parts'));
      writeFileSync(path.join(dir, 'real'), `deb ${OFFICIAL} noble stable\n`);
      symlinkSync(path.join(dir, 'real'), path.join(dir, 'parts', 'link.list'));
      return { files: [], dirs: [path.join(dir, 'parts')] };
    });
    expect(paths(output)).toEqual(['link.list']);
  });

  it.skipIf(!canDeny)('reports an unreadable docker.list as unreadable though it is read without a search', () => {
    const { output } = run((dir) => {
      mkdirSync(path.join(dir, 'parts'));
      writeFileSync(path.join(dir, 'parts', 'docker.list'), `deb [trusted=yes] ${OFFICIAL} noble stable\n`);
      chmodSync(path.join(dir, 'parts', 'docker.list'), 0o000);
      return { files: [], dirs: [path.join(dir, 'parts')] };
    });
    const [source] = parseRepoProbeOutput(output).sources;
    expect(source.readable).toBe(false);
  });

  it('prints nothing for a source list and directory that really are missing', () => {
    const { output } = run((dir) => ({ files: [path.join(dir, 'sources.list')], dirs: [path.join(dir, 'parts')] }));
    expect(output).toBe('');
  });

  it.skipIf(!canDeny)('reports a source file that cannot be read as unreadable, not absent', () => {
    const { output } = run((dir) => {
      mkdirSync(path.join(dir, 'parts'));
      writeFileSync(path.join(dir, 'parts', 'closed.list'), `deb [trusted=yes] ${OFFICIAL} noble stable\n`);
      chmodSync(path.join(dir, 'parts', 'closed.list'), 0o000);
      return { files: [], dirs: [path.join(dir, 'parts')] };
    });
    const [source] = parseRepoProbeOutput(output).sources;
    expect(source.path).toMatch(/closed\.list$/);
    expect(source.readable).toBe(false);
  });

  it.skipIf(!canDeny)('reports a source directory that cannot be listed, and one behind a closed parent, as unreadable', () => {
    const { output } = run((dir) => {
      mkdirSync(path.join(dir, 'closed'));
      mkdirSync(path.join(dir, 'closed', 'parts'));
      writeFileSync(path.join(dir, 'closed', 'parts', 'a.list'), `deb [trusted=yes] ${OFFICIAL} noble stable\n`);
      mkdirSync(path.join(dir, 'unlistable'));
      writeFileSync(path.join(dir, 'unlistable', 'a.list'), `deb [trusted=yes] ${OFFICIAL} noble stable\n`);
      chmodSync(path.join(dir, 'unlistable'), 0o000);
      chmodSync(path.join(dir, 'closed'), 0o000);
      return { files: [path.join(dir, 'closed', 'sources.list')], dirs: [path.join(dir, 'closed', 'parts'), path.join(dir, 'unlistable')] };
    });
    const sources = parseRepoProbeOutput(output).sources;
    expect(sources).toHaveLength(3);
    expect(sources.every((source) => !source.readable)).toBe(true);
    expect(parseDockerRepo(output, 'noble', 'amd64').sourceVerified).toBeNull();
  });

  it('turns the real script output for a custom source into the verdict, end to end', () => {
    const { output } = run((dir) => {
      mkdirSync(path.join(dir, 'parts'));
      writeFileSync(path.join(dir, 'parts', 'containers.list'), `deb [arch=arm64 signed-by=${DOCKER_ASC_PATH}] ${OFFICIAL} noble stable\n`);
      writeFileSync(path.join(dir, 'parts', 'other.sources'), `Types: deb\nURIs: ${OFFICIAL}\nSuites: noble\nComponents: stable\nTrusted: yes\nSigned-By: ${DOCKER_ASC_PATH}\n`);
      return { files: [], dirs: [path.join(dir, 'parts')] };
    });
    const result = parseDockerRepo(`${output}\n${dockerAscBlock()}`, 'noble', 'amd64');
    expect(result.dockerSourceConfigured).toBe(true);
    expect(result.sourceVerified).toBe(false);
  });

  it('parses and runs when the SSH client puts its environment assignment in front of it', () => {
    const catalog = buildProbeCatalog({ composeDir: '/opt/docker/sencho', agentDir: '/opt/sencho-agent', hubUrl: 'https://sencho.example.com' });
    for (const entry of catalog) {
      // sshProbeClient runs `LC_ALL=C <command>`; a script that begins with a function or a loop cannot follow an assignment.
      expect(() => execFileSync('sh', ['-n', '-c', `LC_ALL=C ${entry.command}`]), entry.id).not.toThrow();
    }
    const repo = catalog.find((entry) => entry.id === 'docker_repo')!;
    const output = execFileSync('sh', ['-c', `LC_ALL=C ${repo.command}`], { encoding: 'utf8' });
    expect(() => parseDockerRepo(output, 'noble', 'amd64')).not.toThrow();
  });

  it('is part of the production catalog as a read-only command that reads the standard locations', () => {
    const catalog = buildProbeCatalog({ composeDir: '/opt/docker/sencho', agentDir: '/opt/sencho-agent', hubUrl: 'https://sencho.example.com' });
    const command = catalog.find((entry) => entry.id === 'docker_repo')?.command ?? '';
    expect(command).toContain('/etc/apt/sources.list');
    expect(command).toContain('/etc/apt/sources.list.d');
    expect(command).not.toMatch(/\b(rm|mv|cp|tee|sed -i|apt-get)\b/);
  });
});
