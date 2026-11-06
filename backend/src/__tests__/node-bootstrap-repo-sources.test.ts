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
  redactUri,
} from '../services/nodeBootstrap/probes';
import { buildBootstrapEvidence, repoVerified } from '../services/nodeBootstrap/evidence';
import { buildBootstrapPlan, canonicalJson, evidenceDigestOf } from '../services/nodeBootstrap/planBuilder';
import type { SshCommandResult } from '../services/nodeBootstrap/sshProbeClient';
import type { BootstrapCheck, BootstrapFacts } from '../services/nodeBootstrap/types';
import { makeFacts } from './__helpers__/bootstrapFacts';
import { DEFAULT_SOURCE_LOCATIONS, DOCKER_ASC_PATH, DOCKER_KEY_GPG, dockerAscBlock, keyBlock, unrelatedKeyBinary } from './__helpers__/dockerRepoFixtures';

/**
 * Repository verification must hold for the host's own architecture and for
 * every source in the source list apt reads, not two conventional file names.
 */

const OFFICIAL = 'https://download.docker.com/linux/ubuntu';
const LIST_FILE = '/etc/apt/sources.list.d/docker.list';
const SOURCES_FILE = '/etc/apt/sources.list.d/docker.sources';
const CUSTOM_LIST = '/etc/apt/sources.list.d/containers.list';
const CUSTOM_SOURCES = '/etc/apt/sources.list.d/containers.sources';
const MAIN_LIST = '/etc/apt/sources.list';
const GPG_PATH = '/usr/share/keyrings/docker-archive-keyring.gpg';

const block = (file: string, content: string) => `${DEFAULT_SOURCE_LOCATIONS}\nSOURCE_BEGIN=${file}\n${content}\nSOURCE_END=${file}`;
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
const NO_CANDIDATES = parseAptPolicy('', 'noble');
const OFFICIAL_CANDIDATE = [
  'docker-ce:', '  Installed: (none)', '  Candidate: 5:27.3.1-1', '  Version table:',
  '     5:27.3.1-1 500', `        500 ${OFFICIAL} noble/stable amd64 Packages`,
].join('\n');

/** A fresh host whose repository facts come from the given probe output. */
function freshHost(repoText: string, policy = ''): BootstrapFacts {
  const assembled = assemble([probe('docker_repo', repoText), probe('apt_policy', policy)]);
  return makeFacts({
    docker: FRESH_DOCKER,
    packages: policy ? parseAptPolicy(policy, 'noble') : NO_CANDIDATES,
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

    it('verifies an official source written with the host in upper case', () => {
      const result = parse('amd64', block(CUSTOM_LIST, deb('arch=amd64', 'https://Download.Docker.com/linux/ubuntu')), dockerAscBlock());
      expect(result.sourceVerified).toBe(true);
    });

    it('does not take a mirror path that contains the host name for a Docker source', () => {
      const mirror = 'deb https://artifactory.corp/remote/download.docker.com/linux/ubuntu noble stable';
      const result = parse('amd64', block(MAIN_LIST, `${mirror}\n${deb('arch=amd64')}`), dockerAscBlock());
      expect(result.sourceVerified).toBe(true);
      expect(parse('amd64', block(CUSTOM_LIST, mirror), dockerAscBlock()).dockerSourceConfigured).toBe(false);
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

    it('rejects an unparseable line, whether it concerns Docker or sits beside a good Docker entry', () => {
      const broken = parse('amd64', block(MAIN_LIST, `deb ${OFFICIAL}`), dockerAscBlock());
      expect(broken.sourceVerified).toBe(false);
      expect(broken.problem).toMatch(/not a valid apt entry/);
      const beside = parse('amd64', block(MAIN_LIST, `deb broken\n${deb('arch=amd64')}`), dockerAscBlock());
      expect(beside.sourceVerified).toBe(false);
      expect(beside.problem).toContain(MAIN_LIST);
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
      expect(result.problem).toMatch(/different signed-by values/i);
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
      expect(result.problem).toMatch(/different signed-by values for one source on https:\/\/download\.docker\.com/);
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

    it.each([
      ['check-valid-until=no'],
      ['valid-until-min=100'],
      ['date-max-future=10'],
    ])('rejects two entries for one source that disagree on %s, which apt refuses', (option) => {
      const result = parse('amd64', block(LIST_FILE, deb(`arch=amd64 ${option}`)), block(CUSTOM_LIST, deb('arch=amd64')), dockerAscBlock());
      expect(result.sourceVerified).toBe(false);
      expect(result.problem).toContain(option.split('=')[0]);
      expect(parse('amd64', block(LIST_FILE, deb(`arch=amd64 ${option}`)), block(CUSTOM_LIST, deb(`arch=amd64 ${option}`)), dockerAscBlock()).sourceVerified).toBe(true);
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
      ['a deb822 stanza with a valid and an unknown type', CUSTOM_SOURCES, stanza({ Types: 'deb nonsense' })],
      ['a deb822 stanza with the unknown type first', CUSTOM_SOURCES, stanza({ Types: 'nonsense deb' })],
      ['a deb822 type in capital letters, which apt does not know', CUSTOM_SOURCES, stanza({ Types: 'DEB' })],
      ['a deb822 type list separated by a comma, which apt does not split', CUSTOM_SOURCES, stanza({ Types: 'deb,deb-src' })],
      ['a disabled deb822 stanza with an unknown type, which apt still rejects', CUSTOM_SOURCES, stanza({ Types: 'deb nonsense', Enabled: 'no' })],
      ['a deb822 file named docker.sources with a valid and an unknown type', SOURCES_FILE, stanza({ Types: 'deb nonsense' })],
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

    it('does not verify a good Docker stanza beside an unrelated stanza with an unknown type', () => {
      const unrelated = 'Types: deb nonsense\nURIs: http://archive.ubuntu.com/ubuntu\nSuites: noble\nComponents: main';
      const result = parse('amd64', block(CUSTOM_SOURCES, `${unrelated}\n\n${stanza({})}`), dockerAscBlock());
      expect(result.sourceVerified).toBe(false);
      expect(result.problem).toContain('the stanza at line 1 has a Types value that apt does not know');
      expect(result.problem).not.toContain('nonsense');
    });

    it.each(['deb', 'deb-src', 'deb deb-src', 'deb-src  deb', 'deb\tdeb-src'])('still verifies the valid deb822 types %j', (types) => {
      const content = stanza({ Types: types });
      for (const file of [SOURCES_FILE, CUSTOM_SOURCES]) {
        const result = parse('amd64', block(file, content), dockerAscBlock());
        // A deb-src stanza alone has no binary entry to verify.
        expect(result.sourceVerified).toBe(types === 'deb-src' ? false : true);
      }
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

  describe('content that apt rejects is never beside a verified Docker entry', () => {
    const unrelatedStanza = (fields: string) => `Types: deb\nURIs: http://archive.ubuntu.com/ubuntu\n${fields}`;
    const listGood = deb('arch=amd64');
    const listCases: Array<[string, string]> = [
      ['a bare word', 'garbage'],
      ['a line that starts with !', '!garbage'],
      ['a source line with no suite', 'deb http://archive.ubuntu.com/ubuntu'],
      ['a source line with no component', 'deb http://archive.ubuntu.com/ubuntu noble'],
      ['a source line of an unknown type', 'rpm http://archive.ubuntu.com/ubuntu noble main'],
      ['an exact-path suite with components', 'deb http://archive.ubuntu.com/ubuntu/ ./ main'],
      ['an unclosed option bracket', 'deb [arch=amd64 http://archive.ubuntu.com/ubuntu noble main'],
      ['an option with no value', 'deb [arch=amd64 foo] http://archive.ubuntu.com/ubuntu noble main'],
      ['an option with an empty value', 'deb [signed-by=] http://archive.ubuntu.com/ubuntu noble main'],
      ['no space after the option bracket', 'deb [arch=amd64]http://archive.ubuntu.com/ubuntu noble main'],
      ['two option brackets', 'deb [arch=amd64] [trusted=no] http://archive.ubuntu.com/ubuntu noble main'],
      ['a URI with no scheme', 'deb archive.ubuntu.com/ubuntu noble main'],
      ['a bare path as the URI', 'deb /srv/repo noble main'],
      ['an unterminated quote', 'deb http://archive.ubuntu.com/ubuntu "noble main'],
      ['a quoted URI with no scheme', 'deb "archive.ubuntu.com/ubuntu" noble main'],
      ['an upper-case URI scheme, which names no apt method', 'deb HTTPS://archive.ubuntu.com/ubuntu noble main'],
      ['an upper-case scheme on the official URI', `deb [arch=amd64 signed-by=${DOCKER_ASC_PATH}] HTTPS://download.docker.com/linux/ubuntu noble stable`],
      ['an option value in single quotes, which apt does not read as a quote', "deb [signed-by='/etc/apt/keyrings/one.gpg /etc/apt/keyrings/two.gpg'] http://archive.ubuntu.com/ubuntu noble main"],
      // apt starts a comment at any '#' outside an open option group, so what follows one inside a word is gone.
      ['a hash inside the URI, which cuts the suite off', 'deb http://archive.ubuntu.com/ubuntu#x noble main'],
      ['a hash that ends the Docker URI, which cuts the suite off', `deb [arch=amd64 signed-by=${DOCKER_ASC_PATH}] ${OFFICIAL}# noble stable`],
      // Whitespace JavaScript splits on and apt does not.
      ['a no-break space between the suite and the component', 'deb http://archive.ubuntu.com/ubuntu noble\u00a0main'],
      ['a no-break space after the type', 'deb\u00a0http://archive.ubuntu.com/ubuntu noble main'],
      ['a byte order mark before the type', '\ufeffdeb http://archive.ubuntu.com/ubuntu noble main'],
    ];
    const deb822Cases: Array<[string, string]> = [
      ['a bare word', 'garbage'],
      ['a line that starts with !', '!garbage'],
      ['a line with a space where the colon belongs', 'Broken suite value'],
      ['a Types line with no colon', 'Types deb'],
      ['an indented field that starts a stanza', ' Types: deb\nURIs: http://archive.ubuntu.com/ubuntu\nSuites: noble\nComponents: main'],
      ['a tab-indented field that starts a stanza', '\tTypes: deb\nURIs: http://archive.ubuntu.com/ubuntu\nSuites: noble\nComponents: main'],
      ['an enabled stanza with no URIs', 'Types: deb\nSuites: noble\nComponents: main'],
      ['an enabled stanza with empty URIs', 'Types: deb\nURIs:\nSuites: noble\nComponents: main'],
      ['an enabled stanza with a URI that has no scheme', 'Types: deb\nURIs: archive.ubuntu.com\nSuites: noble\nComponents: main'],
      ['an enabled stanza with no Suites', unrelatedStanza('Components: main')],
      ['an enabled stanza with empty Suites', unrelatedStanza('Suites:\nComponents: main')],
      ['an enabled stanza with no Components', unrelatedStanza('Suites: noble')],
      ['an enabled stanza with empty Components', unrelatedStanza('Suites: noble\nComponents:')],
      ['an exact-path suite with components', unrelatedStanza('Suites: ./\nComponents: main')],
      ['a stanza that mixes an exact-path suite with a named one', unrelatedStanza('Suites: ./ noble')],
      // An indented line after an open field continues it, a comment included, so it is part of the value.
      ['an indented comment that continues a Types value', 'Types: deb\n  # note\nURIs: http://archive.ubuntu.com/ubuntu\nSuites: noble\nComponents: main'],
      ['an indented comment that continues a URIs value', 'Types: deb\nURIs: http://archive.ubuntu.com/ubuntu\n  # note\nSuites: noble\nComponents: main'],
      ['an upper-case URI scheme, which names no apt method', 'Types: deb\nURIs: HTTPS://archive.ubuntu.com/ubuntu\nSuites: noble\nComponents: main'],
      ['an upper-case scheme on the official URI', stanza({ URIs: 'HTTPS://download.docker.com/linux/ubuntu' })],
      ['a no-break space after a field name', 'Types:\u00a0deb\nURIs: http://archive.ubuntu.com/ubuntu\nSuites: noble\nComponents: main'],
      ['a byte order mark before the stanza', '\ufeffTypes: deb\nURIs: http://archive.ubuntu.com/ubuntu\nSuites: noble\nComponents: main'],
    ];
    const files: Array<[string, string, string, Array<[string, string]>]> = [
      ['docker.list', LIST_FILE, listGood, listCases],
      ['an arbitrary .list', CUSTOM_LIST, listGood, listCases],
      ['the main source list', MAIN_LIST, listGood, listCases],
      ['docker.sources', SOURCES_FILE, stanza({}), deb822Cases],
      ['an arbitrary .sources', CUSTOM_SOURCES, stanza({}), deb822Cases],
    ];
    const rejected = files.flatMap(([fileLabel, file, good, bad]) => bad.map(
      ([badLabel, extra]): [string, string, string] => [`${badLabel} in ${fileLabel}`, file, [good, extra].join('\n\n')],
    ));

    /** What apt-cache policy does on the host when apt rejects a source file. */
    const APT_REJECTED = { exitCode: 100 };

    it.each(rejected)('does not verify %s', (_label, file, content) => {
      const result = parse('amd64', block(file, content), dockerAscBlock());
      expect(result.dockerSourceConfigured).toBe(true);
      expect(result.sourceVerified).toBe(false);
      expect(result.problem).toContain(file);
      expect(result.problem).toMatch(/apt rejects|not a valid apt entry/);
    });

    it.each(rejected)('keeps a working installation but never reports %s as a verified source', (_label, file, content) => {
      const assembled = assemble([
        probe('docker_repo', [block(file, content), dockerAscBlock()].join('\n')),
        probe('apt_policy', '', APT_REJECTED),
      ]);
      // The audited sequence: working Docker and Compose, apt-cache policy failed because apt rejects the file.
      const facts = makeFacts({ packagesComplete: assembled.packagesComplete, packages: NO_CANDIDATES, repo: assembled.repo });
      expect(repoVerified(facts)).toBe(false);
      expect(aptSource(facts).status).toBe('warn');
      expect(aptSource(facts).observed).not.toMatch(/verified/);
      expect(evidenceFor(facts).blockers).toBe(0);
      expect(planWithheld(facts)).toBe(false);
      expect(stageIds(facts)).not.toContain('docker_repository');
    });

    it.each(rejected)('withholds the plan on a fresh host for %s', (_label, file, content) => {
      const facts = freshHost([block(file, content), dockerAscBlock()].join('\n'));
      expect(repoVerified(facts)).toBe(false);
      expect(planWithheld(facts)).toBe(true);
      expect(() => planFor(facts)).toThrow();
    });

    it('names the offending line by its position and never repeats what it says', () => {
      const result = parse('amd64', block(CUSTOM_LIST, `${listGood}\ndeb archive.ubuntu.com/ubuntu noble main`), dockerAscBlock());
      expect(result.problem).toBe(`${CUSTOM_LIST}: line 2 is not a valid apt entry, which apt rejects`);
      const deb822 = parse('amd64', block(CUSTOM_SOURCES, `${stanza({})}\n\nBroken suite value`), dockerAscBlock());
      expect(deb822.problem).toBe(`${CUSTOM_SOURCES}: line 7 is not a valid apt entry, which apt rejects`);
    });

    it('counts comment, blank and continuation lines in the position, so it is the line in the file', () => {
      const list = parse('amd64', block(CUSTOM_LIST, `# Docker\n\n${listGood}\n\n# note\ndeb archive.ubuntu.com/ubuntu noble main`), dockerAscBlock());
      expect(list.problem).toBe(`${CUSTOM_LIST}: line 6 is not a valid apt entry, which apt rejects`);
      const lateUnparsed = parse('amd64', block(CUSTOM_SOURCES, `# note\n${stanza({})}\n  # a continuation\n\n# second\nBroken suite value`), dockerAscBlock());
      expect(lateUnparsed.problem).toBe(`${CUSTOM_SOURCES}: line 10 is not a valid apt entry, which apt rejects`);
      const unknownType = parse('amd64', block(CUSTOM_SOURCES, `# note\n\n# more\nTypes: rpm\nURIs: http://archive.ubuntu.com/ubuntu\nSuites: noble\nComponents: main`), dockerAscBlock());
      expect(unknownType.problem).toBe(`${CUSTOM_SOURCES}: the stanza at line 4 has a Types value that apt does not know, which apt rejects`);
    });

    it('counts a malformed file that mentions Docker only in a comment, and not one that never mentions it', () => {
      const commentOnly = (file: string, malformed: string) => [
        block(LIST_FILE, listGood),
        block(file, `# download.docker.com mirror\n${malformed}`),
        dockerAscBlock(),
      ].join('\n');
      expect(parse('amd64', commentOnly(CUSTOM_LIST, 'garbage')).sourceVerified).toBe(false);
      expect(parse('amd64', commentOnly(CUSTOM_SOURCES, 'garbage')).sourceVerified).toBe(false);
      // The probe never prints a file that does not mention the host, so the parser never sees it.
      expect(parse('amd64', [block(LIST_FILE, listGood), dockerAscBlock()].join('\n')).sourceVerified).toBe(true);
    });

    // Values the parser does not model (a Signed-By that is neither a path nor
    // a fingerprint). apt-cache policy is the backstop.
    it.each([
      ['a Signed-By value that is not a path or fingerprint', CUSTOM_LIST, `${listGood}\ndeb [signed-by=foo] http://archive.ubuntu.com/ubuntu noble main`],
      ['a quoted Signed-By value that leaves an item that is not a path or fingerprint', CUSTOM_LIST, `${listGood}\ndeb [signed-by=/etc/apt/keyrings/one.gpg"two three"] http://archive.ubuntu.com/ubuntu noble main`],
      ['a deb822 Signed-By value that is not a path or fingerprint', CUSTOM_SOURCES, `${stanza({})}\n\n${unrelatedStanza('Suites: noble\nComponents: main\nSigned-By: foo')}`],
    ])('does not trust %s once apt-cache policy fails', (_label, file, content) => {
      const text = [block(file, content), dockerAscBlock()].join('\n');
      const fresh = assemble([probe('docker_repo', text), probe('apt_policy', '', APT_REJECTED)]);
      expect(fresh.repo.sourceVerified).toBeNull();
      expect(fresh.repo.problem).toMatch(/apt-cache policy did not complete/);
      const freshFacts = makeFacts({ docker: FRESH_DOCKER, packages: NO_CANDIDATES, packagesComplete: fresh.packagesComplete, repo: fresh.repo });
      expect(repoVerified(freshFacts)).toBe(false);
      expect(planWithheld(freshFacts)).toBe(true);
      const healthy = makeFacts({ packages: NO_CANDIDATES, packagesComplete: fresh.packagesComplete, repo: fresh.repo });
      expect(aptSource(healthy).status).toBe('warn');
      expect(stageIds(healthy)).not.toContain('docker_repository');
    });

    const accepted: Array<[string, string, string]> = [
      ['an exact-path line beside the Docker entry', CUSTOM_LIST, `${listGood}\ndeb http://example.com/ ./`],
      ['a file: URI', CUSTOM_LIST, `${listGood}\ndeb file:/srv/repo ./`],
      ['a cdrom line whose URI holds spaces', CUSTOM_LIST, `${listGood}\ndeb cdrom:[Ubuntu 22.04 _Jammy_ - Release amd64 (20220419)]/ jammy main restricted`],
      ['an option bracket with inner spaces', MAIN_LIST, `${listGood}\ndeb [ arch=amd64 ] http://archive.ubuntu.com/ubuntu noble main`],
      ['options that end in a sign', MAIN_LIST, `${listGood}\ndeb [arch-=i386] http://archive.ubuntu.com/ubuntu noble main`],
      ['tabs, a trailing comment, CRLF and a blank line', CUSTOM_LIST, `${listGood} # Docker\r\n\r\ndeb\thttp://archive.ubuntu.com/ubuntu\tnoble\tmain\r\n# note`],
      ['a deb-src line beside the Docker entry', CUSTOM_LIST, `${listGood}\ndeb-src http://archive.ubuntu.com/ubuntu noble main`],
      ['a disabled stanza with no URIs', CUSTOM_SOURCES, `${stanza({})}\n\nTypes: deb\nEnabled: no\nSuites: noble\nComponents: main`],
      ['a disabled stanza with empty URIs', CUSTOM_SOURCES, `${stanza({})}\n\nTypes: deb\nURIs:\nEnabled: no\nSuites: noble\nComponents: main`],
      ['a disabled stanza with a URI that has no scheme', CUSTOM_SOURCES, `${stanza({})}\n\nTypes: deb\nEnabled: no\nURIs: archive.ubuntu.com\nSuites: noble\nComponents: main`],
      ['a disabled stanza with no Suites', CUSTOM_SOURCES, `${stanza({})}\n\n${unrelatedStanza('Enabled: no\nComponents: main')}`],
      ['a disabled stanza with no Components', CUSTOM_SOURCES, `${stanza({})}\n\n${unrelatedStanza('Enabled: no\nSuites: noble')}`],
      ['an exact-path stanza with no Components', CUSTOM_SOURCES, `${stanza({})}\n\n${unrelatedStanza('Suites: ./')}`],
      ['a field name with an underscore', CUSTOM_SOURCES, `${stanza({})}\n\n${unrelatedStanza('Suites: noble\nComponents: main\nX_Note: kept')}`],
      ['comments, CRLF and a continuation line', CUSTOM_SOURCES, `# note\n${stanza({})}\n# note\n\nTypes: deb\r\nURIs: http://archive.ubuntu.com/ubuntu\r\nSuites: noble\r\nComponents: main\r\n  universe`],
    ];

    // Quoting, comments and field names that real apt (3.2.1, isolated) reads without error.
    const unrelatedOne = (rest: string) => `deb ${rest}`;
    const acceptedLists: Array<[string, string]> = [
      ['a double-quoted URI', unrelatedOne('"http://archive.ubuntu.com/ubuntu" noble main')],
      ['a double-quoted suite and component', unrelatedOne('http://archive.ubuntu.com/ubuntu "noble" "main"')],
      ['a double-quoted option value holding two keyrings', unrelatedOne('[signed-by="/etc/apt/keyrings/ubuntu-one.gpg /etc/apt/keyrings/ubuntu-two.gpg"] http://archive.ubuntu.com/ubuntu noble main')],
      ['a double-quoted option value beside another option', unrelatedOne('[arch=amd64 signed-by="/etc/apt/keyrings/ubuntu-one.gpg"] http://archive.ubuntu.com/ubuntu noble main')],
      ['a double-quoted URI that holds credentials', unrelatedOne('"https://operator:secret@private.example/r" noble main')],
      ['a hash that ends the last component', unrelatedOne('http://archive.ubuntu.com/ubuntu noble main#c')],
      ['a no-break space inside a comment', unrelatedOne('http://archive.ubuntu.com/ubuntu noble main # a\u00a0b')],
    ];
    // The Docker stanza itself, so docker.sources (which is checked whatever it points at) takes them too.
    const acceptedStanzas: Array<[string, string]> = [
      ['an indented comment before the first stanza', `  # note\n${stanza({})}`],
      ['a tab-indented comment before the first stanza', `\t# note\n${stanza({})}`],
      ['a custom field whose name holds a plus sign', stanza({ 'X+Note': 'kept' })],
      ['a custom field whose name holds an at sign', stanza({ 'X@Note': 'kept' })],
      ['a custom field whose name holds a slash', stanza({ 'X-Note/foo': 'kept' })],
      ['a custom field whose name holds a space', stanza({ 'X Note': 'kept' })],
    ];
    const acceptedBesideStanza: Array<[string, string]> = [
      ['an indented comment between two stanzas', `${stanza({})}\n\n  # note\n\n${unrelatedStanza('Suites: noble\nComponents: main')}`],
      ['a custom field in an unrelated stanza', `${stanza({})}\n\n${unrelatedStanza('Suites: noble\nComponents: main\nX+Note: kept')}`],
    ];
    // docker.list and docker.sources are checked whatever they point at, so an unrelated entry belongs in the other files.
    const lineFiles: Array<[string, string]> = [['an arbitrary .list', CUSTOM_LIST], ['the main source list', MAIN_LIST]];
    const stanzaFiles: Array<[string, string]> = [['docker.sources', SOURCES_FILE], ['an arbitrary .sources', CUSTOM_SOURCES]];
    accepted.push(
      ...lineFiles.flatMap(([fileLabel, file]) => acceptedLists.map(([label, extra]): [string, string, string] => [`${label} in ${fileLabel}`, file, `${listGood}\n${extra}`])),
      ...stanzaFiles.flatMap(([fileLabel, file]) => acceptedStanzas.map(([label, content]): [string, string, string] => [`${label} in ${fileLabel}`, file, content])),
      ...acceptedBesideStanza.map(([label, content]): [string, string, string] => [`${label} in an arbitrary .sources`, CUSTOM_SOURCES, content]),
    );

    it.each(accepted)('still verifies %s, which apt accepts', (_label, file, content) => {
      const result = parse('amd64', block(file, content), dockerAscBlock());
      expect(result.sourceVerified).toBe(true);
      expect(result.problem).toBeNull();
      const text = [block(file, content), dockerAscBlock()].join('\n');
      expect(repoVerified(freshHost(text))).toBe(true);
      // A healthy host whose apt-cache policy ran keeps the pass.
      const assembled = assemble([probe('docker_repo', text), probe('apt_policy', '')]);
      const healthy = makeFacts({ packagesComplete: assembled.packagesComplete, packages: NO_CANDIDATES, repo: assembled.repo });
      expect(aptSource(healthy).status).toBe('pass');
    });

    it('turns a source that read as valid into unknown, not a pass, when apt-cache policy fails', () => {
      const text = [block(CUSTOM_LIST, listGood), dockerAscBlock()].join('\n');
      const ran = assemble([probe('docker_repo', text), probe('apt_policy', '')]);
      const failed = assemble([probe('docker_repo', text), probe('apt_policy', '', APT_REJECTED)]);
      expect(ran.repo.sourceVerified).toBe(true);
      expect(failed.repo.sourceVerified).toBeNull();
      const healthy = makeFacts({ packagesComplete: false, packages: NO_CANDIDATES, repo: failed.repo });
      expect(aptSource(healthy).status).toBe('warn');
      expect(stageIds(healthy)).not.toContain('docker_repository');
    });

    describe('a quoted official source', () => {
      const keys = [dockerAscBlock(), keyBlock(GPG_PATH, DOCKER_KEY_GPG)];
      const allLineFiles: Array<[string, string]> = [['docker.list', LIST_FILE], ...lineFiles];
      it.each([
        ['a quoted URI', `deb [arch=amd64 signed-by=${DOCKER_ASC_PATH}] "${OFFICIAL}" noble stable`],
        ['a quoted keyring list naming two Docker keyrings', `deb [arch=amd64 signed-by="${DOCKER_ASC_PATH} ${GPG_PATH}"] ${OFFICIAL} noble stable`],
        ['a quoted keyring list and a quoted URI', `deb [signed-by="${DOCKER_ASC_PATH} ${GPG_PATH}"] "${OFFICIAL}" noble stable`],
      ])('verifies %s in every one-line file', (_label, line) => {
        for (const [, file] of allLineFiles) {
          const result = parse('amd64', block(file, line), ...keys);
          expect(result.sourceVerified).toBe(true);
          expect(result.problem).toBeNull();
          const text = [block(file, line), ...keys].join('\n');
          expect(repoVerified(freshHost(text))).toBe(true);
          expect(planWithheld(freshHost(text))).toBe(false);
          const assembled = assemble([probe('docker_repo', text), probe('apt_policy', '')]);
          const healthy = makeFacts({ packagesComplete: assembled.packagesComplete, packages: NO_CANDIDATES, repo: assembled.repo });
          expect(aptSource(healthy).status).toBe('pass');
        }
      });

      it('still rejects a quoted keyring list that names a keyring that is not Docker\'s', () => {
        const line = `deb [signed-by="${DOCKER_ASC_PATH} /etc/apt/keyrings/other.gpg"] ${OFFICIAL} noble stable`;
        for (const [, file] of allLineFiles) {
          expect(parse('amd64', block(file, line), ...keys).sourceVerified).toBe(false);
        }
      });
    });

    // A repository credential can sit in a URI's userinfo, query or path, or in a
    // word apt reads as a suite or a type. None of it may leave the parser in a
    // reason, a returned check, the plan or the facts that are hashed.
    describe('credentials in a source file stay out of every result', () => {
      const PASSWORD = 'AUDIT_FAKE_REPO_PASSWORD';
      const QUERY_TOKEN = 'AUDIT_FAKE_QUERY_TOKEN';
      const PATH_TOKEN = 'AUDIT_FAKE_PATH_TOKEN';
      const SECRETS = [PASSWORD, QUERY_TOKEN, PATH_TOKEN];
      const SIGNED = `signed-by=${DOCKER_ASC_PATH}`;
      const leaks = (value: unknown) => SECRETS.filter((secret) => JSON.stringify(value).includes(secret));

      /** Everything a preflight returns or stores that a source line could reach. */
      function surfaces(facts: BootstrapFacts) {
        return {
          evidence: evidenceFor(facts),
          facts: canonicalJson(facts),
          plan: planWithheld(facts) ? null : planFor(facts),
        };
      }

      const listCases: Array<[string, string]> = [
        ['a missing component after userinfo', `deb https://operator:${PASSWORD}@private.example/r noble`],
        ['a missing component after a query token', `deb https://private.example/r?token=${QUERY_TOKEN} noble`],
        ['a missing component after a path token', `deb https://private.example/${PATH_TOKEN} noble`],
        ['a URI with no scheme', `deb private.example/${PATH_TOKEN}?token=${QUERY_TOKEN} noble main`],
        ['an unclosed quote', `deb "https://operator:${PASSWORD}@private.example/r noble main`],
        ['an option with no value', `deb [${PASSWORD}] https://private.example/r noble main`],
        ['Docker\'s host with a trailing dot, userinfo and a query', `deb [${SIGNED}] https://operator:${PASSWORD}@download.docker.com./linux/ubuntu?token=${QUERY_TOKEN} noble stable`],
        ['the official URI with userinfo and a suite that is a token', `deb [${SIGNED}] https://operator:${PASSWORD}@download.docker.com/linux/ubuntu?token=${QUERY_TOKEN} ${PATH_TOKEN} stable`],
        // A '#', '/' or '?' in the userinfo makes a URL parser read part of the credential as the host.
        ['a hash in the userinfo of a wrong repository', `deb [${SIGNED}] https://${PASSWORD}#x@private.example/r noble stable`],
        ['a numeric-looking password and a hash in the userinfo', `deb [${SIGNED}] https://operator:4815#${PASSWORD}@private.example/r noble stable`],
        ['a credential in a path on Docker\'s host', `deb [${SIGNED}] https://download.docker.com/linux/${PATH_TOKEN} noble stable`],
      ];
      const stanzaCases: Array<[string, string]> = [
        ['a line apt cannot parse', `https/operator ${PASSWORD}`],
        ['a Types value that is a URL', `Types: deb https://operator:${PASSWORD}@private.example/r?token=${QUERY_TOKEN}`],
        ['a Types value that is a token', `Types: ${PATH_TOKEN}`],
        ['a URI with no scheme', `Types: deb\nURIs: private.example/${PATH_TOKEN}?token=${QUERY_TOKEN}\nSuites: noble\nComponents: main`],
        ['a credentialed URI with no components', `Types: deb\nURIs: https://operator:${PASSWORD}@private.example/r\nSuites: noble`],
        ['Docker\'s host with a trailing dot, userinfo and a query', stanza({ URIs: `https://operator:${PASSWORD}@download.docker.com./linux/ubuntu?token=${QUERY_TOKEN}` })],
        ['the official URI with userinfo and a suite that is a token', stanza({ URIs: `https://operator:${PASSWORD}@download.docker.com/linux/ubuntu?token=${QUERY_TOKEN}`, Suites: PATH_TOKEN })],
        ['a credential in a path on Docker\'s host', stanza({ URIs: `https://download.docker.com/linux/${PATH_TOKEN}` })],
      ];
      // Only docker.list and docker.sources are checked whatever they point at.
      const wrongRepository: Array<[string, string, string]> = [
        ['a wrong repository with userinfo, path and query in docker.list', LIST_FILE, `deb [${SIGNED}] https://operator:${PASSWORD}@private.example/${PATH_TOKEN}/ubuntu?token=${QUERY_TOKEN} noble stable`],
        ['a wrong repository with userinfo, path and query in docker.sources', SOURCES_FILE, stanza({ URIs: `https://operator:${PASSWORD}@private.example/${PATH_TOKEN}/ubuntu?token=${QUERY_TOKEN}` })],
        ['a slash in the userinfo of a wrong repository in docker.list', LIST_FILE, `deb [${SIGNED}] https://operator:${PASSWORD}/x@private.example/r noble stable`],
        ['a hash in the userinfo of a wrong repository in docker.sources', SOURCES_FILE, stanza({ URIs: `https://${PASSWORD}#x@private.example/r` })],
        ['a question mark in the userinfo of a wrong repository in docker.sources', SOURCES_FILE, stanza({ URIs: `https://${PASSWORD}?x@private.example/r` })],
      ];
      const credentialLineFiles: Array<[string, string]> = [['docker.list', LIST_FILE], ...lineFiles];
      const cases: Array<[string, string, string]> = [
        ...credentialLineFiles.flatMap(([fileLabel, file]) => listCases.map(([label, bad]): [string, string, string] => [`${label} in ${fileLabel}`, file, `${listGood}\n${bad}`])),
        ...stanzaFiles.flatMap(([fileLabel, file]) => stanzaCases.map(([label, bad]): [string, string, string] => [`${label} in ${fileLabel}`, file, `${stanza({})}\n\n${bad}`])),
        ...wrongRepository.map(([label, file, bad]): [string, string, string] => [label, file, `${file === LIST_FILE ? listGood : stanza({})}\n\n${bad}`]),
      ];

      it.each(cases)('keeps the credentials of %s out of the parse, the evidence, the facts and the plan', (_label, file, content) => {
        const text = [block(file, content), dockerAscBlock()].join('\n');
        const result = parse('amd64', block(file, content), dockerAscBlock());
        expect(result.sourceVerified).toBe(false);
        expect(result.problem).toContain(file);
        expect(leaks(result)).toEqual([]);

        const fresh = freshHost(text);
        expect(leaks(surfaces(fresh))).toEqual([]);
        for (const policy of [{}, APT_REJECTED]) {
          const assembled = assemble([probe('docker_repo', text), probe('apt_policy', '', policy)]);
          expect(leaks(assembled.repo)).toEqual([]);
          const healthy = makeFacts({ packagesComplete: assembled.packagesComplete, packages: NO_CANDIDATES, repo: assembled.repo });
          expect(leaks(surfaces(healthy))).toEqual([]);
        }
      });

      it('still tells the operator which file and which position to look at', () => {
        const list = parse('amd64', block(CUSTOM_LIST, `${listGood}\ndeb https://operator:${PASSWORD}@private.example/r noble`), dockerAscBlock());
        expect(list.problem).toBe(`${CUSTOM_LIST}: line 2 is not a valid apt entry, which apt rejects`);
        const unknownType = parse('amd64', block(CUSTOM_SOURCES, `${stanza({})}\n\nTypes: ${PATH_TOKEN}\nURIs: http://archive.ubuntu.com/ubuntu\nSuites: noble\nComponents: main`), dockerAscBlock());
        expect(unknownType.problem).toBe(`${CUSTOM_SOURCES}: the stanza at line 7 has a Types value that apt does not know, which apt rejects`);
        const wrong = parse('amd64', block(LIST_FILE, wrongRepository[0][2]), dockerAscBlock());
        expect(wrong.problem).toBe(`${LIST_FILE}: the source points at https: (host withheld), not ${OFFICIAL}`);
        const noUserinfo = parse('amd64', block(LIST_FILE, `deb [${SIGNED}] https://private.example/${PATH_TOKEN}?token=${QUERY_TOKEN} noble stable`), dockerAscBlock());
        expect(noUserinfo.problem).toBe(`${LIST_FILE}: the source points at https://private.example, not ${OFFICIAL}`);
      });

      it.each([
        ['userinfo with a hash', `https://${PASSWORD}#x@h.example/r`, 'https: (host withheld)'],
        ['userinfo with a slash', `https://op:${PASSWORD}/x@h.example/r`, 'https: (host withheld)'],
        ['userinfo with a query mark', `https://${PASSWORD}?x@h.example/r`, 'https: (host withheld)'],
        ['a numeric password', 'https://48151623#x@h.example/r', 'https: (host withheld)'],
        ['an @ only in the path', `https://h.example/${PATH_TOKEN}@x`, 'https: (host withheld)'],
        ['an upper-case scheme with userinfo', `HTTPS://${PASSWORD}@h.example`, 'https: (host withheld)'],
        ['a scheme that is a credential', `${PASSWORD}:x@h.example`, '(unrecognized URI)'],
        ['no scheme', `${PASSWORD}/r`, '(unrecognized URI)'],
        ['a path and query on another host', `http://mirror.example:8080/${PATH_TOKEN}?t=${QUERY_TOKEN}`, 'http://mirror.example:8080'],
        ['an IPv6 host', 'http://[2001:db8::1]/r', 'http://[2001:db8::1]'],
        ['a file URI', `file:/srv/${PATH_TOKEN}`, 'file:'],
        ['a cdrom URI', 'cdrom:[Ubuntu 22.04]/', 'cdrom:'],
        ['a URL that does not parse', 'http://exa mple', '(unparsable URI)'],
        ['the official URI with userinfo', `https://op:${PASSWORD}@download.docker.com/linux/ubuntu/`, OFFICIAL],
        ['the official URI with a query, which apt reads as another path', `https://download.docker.com/linux/ubuntu?t=${QUERY_TOKEN}`, 'https://download.docker.com'],
        ['Docker\'s host with another path', `https://download.docker.com/linux/${PATH_TOKEN}`, 'https://download.docker.com'],
      ])('shows %s as nothing but %j', (_label, uri, shown) => {
        expect(redactUri(uri)).toBe(shown);
        expect(leaks(redactUri(uri))).toEqual([]);
      });

      it('keeps the credentials of two entries that disagree on the keyring out of the conflict reason', () => {
        const result = parse(
          'amd64',
          block(LIST_FILE, `deb [arch=amd64 ${SIGNED}] https://operator:${PASSWORD}@download.docker.com/linux/ubuntu noble stable`),
          block(CUSTOM_SOURCES, stanza({ URIs: `https://operator:${PASSWORD}@download.docker.com/linux/ubuntu`, 'Signed-By': GPG_PATH })),
          dockerAscBlock(),
          keyBlock(GPG_PATH, DOCKER_KEY_GPG),
        );
        expect(result.sourceVerified).toBe(false);
        expect(result.problem).toMatch(/different signed-by values for one source on https:\/\/download\.docker\.com/);
        expect(leaks(result)).toEqual([]);
      });

      it('keeps the credentials of a candidate archive out of the facts that are hashed', () => {
        const foreign = `        500 https://operator:${PASSWORD}@private.example/${PATH_TOKEN}/ubuntu?token=${QUERY_TOKEN} noble/stable amd64 Packages`;
        const policy = [
          'docker-ce:', '  Installed: (none)', '  Candidate: 5:27.3.1-1', '  Version table:',
          '     5:27.3.1-1 500', foreign,
        ].join('\n');
        expect(leaks(parseAptPolicy(policy, 'noble'))).toEqual([]);
        const text = [block(LIST_FILE, listGood), dockerAscBlock()].join('\n');
        const assembled = assemble([probe('docker_repo', text), probe('apt_policy', policy)]);
        const facts = makeFacts({ docker: FRESH_DOCKER, packages: parseAptPolicy(policy, 'noble'), repo: assembled.repo });
        expect(leaks(canonicalJson(facts))).toEqual([]);
        // Redacting the URI must not turn a foreign archive into the official one, or the reverse.
        expect(assembled.repo.candidateSourceVerified).toBe(false);
        const official = parseAptPolicy(OFFICIAL_CANDIDATE, 'noble').find((pkg) => pkg.name === 'docker-ce');
        expect(official?.candidateSources).toEqual([{ uri: OFFICIAL, official: true }]);
      });
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
    it('still reports a contradiction found in the same entry', () => {
      const result = parseDockerRepo([block(LIST_FILE, deb('arch=amd64 trusted=yes')), dockerAscBlock()].join('\n'), '', 'amd64');
      expect(result.sourceVerified).toBe(false);
      expect(result.problem).toMatch(/weakens signature checking/);
    });

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
      const none = freshHost(`${DEFAULT_SOURCE_LOCATIONS}\n${dockerAscBlock()}`);
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
          packages: parseAptPolicy(OFFICIAL_CANDIDATE, 'noble'),
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

  it('emits a file that hides Docker\'s host behind a quote or an escape, and judges its entry as apt reads it', () => {
    const files = (dir: string, entries: Record<string, string>) => {
      mkdirSync(path.join(dir, 'parts'));
      for (const [name, content] of Object.entries(entries)) writeFileSync(path.join(dir, 'parts', name), `${content}\n`);
      return { files: [], dirs: [path.join(dir, 'parts')] };
    };
    const signed = `signed-by=${DOCKER_ASC_PATH}`;
    const { output } = run((dir) => files(dir, {
      'escaped.list': `deb [arch=amd64 trusted=yes ${signed}] https://download%2edocker.com/linux/ubuntu noble stable`,
      'quoted.list': `deb [arch=amd64 ${signed}] https://download."docker".com/linux/ubuntu noble stable`,
      'plain.list': 'deb http://archive.ubuntu.com/ubuntu noble main',
    }));
    expect(paths(output)).toEqual(['escaped.list', 'quoted.list']);
    const weakened = parseDockerRepo(`${output}\n${dockerAscBlock()}`, 'noble', 'amd64');
    expect(weakened.sourceVerified).toBe(false);
    expect(weakened.problem).toMatch(/weakens signature checking/);
    const quotedOnly = run((dir) => files(dir, {
      'quoted.list': `deb [arch=amd64 ${signed}] https://download."docker".com/linux/ubuntu noble stable`,
    }));
    expect(parseDockerRepo(`${DEFAULT_SOURCE_LOCATIONS}\n${quotedOnly.output}\n${dockerAscBlock()}`, 'noble', 'amd64').sourceVerified).toBe(true);
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

describe('apt candidate archives keep every credential-shaped word out of the facts', () => {
  const NAMES = ['docker-ce', 'docker-ce-cli', 'containerd.io', 'docker-buildx-plugin', 'docker-compose-plugin'] as const;
  const TOKEN = 'AUDIT_FAKE_SUITE_SECRET';
  const OTHER = 'AUDIT_FAKE_OTHER_SECRET';

  /** apt-cache policy for all five packages, every candidate served by one archive line. */
  const policyFor = (archive: (name: string) => string) => NAMES.map((name) => [
    `${name}:`, '  Installed: (none)', '  Candidate: 5:27.3.1-1', '  Version table:', '     5:27.3.1-1 500', `        500 ${archive(name)}`,
  ].join('\n')).join('\n');
  const GOOD_REPO = [block(LIST_FILE, `deb [arch=amd64 signed-by=${DOCKER_ASC_PATH}] ${OFFICIAL} noble stable`), dockerAscBlock()].join('\n');
  const GOOD_STANZA_REPO = [block(SOURCES_FILE, stanza({})), dockerAscBlock()].join('\n');

  /** The packages and repository exactly as assembleFacts returns them for this probe output. */
  function factsFor(policy: string, repoText: string, fresh: boolean): BootstrapFacts {
    const assembled = assemble([probe('docker_repo', repoText), probe('apt_policy', policy)]);
    return makeFacts({
      ...(fresh ? { docker: FRESH_DOCKER } : {}),
      packages: assembled.packages,
      repo: assembled.repo,
    });
  }

  const archives: Array<[string, (name: string) => string, boolean]> = [
    ['a suite path on a private host', (name) => `https://private.example/ubuntu ${TOKEN}-${name}/main amd64 Packages`, false],
    ['a component path on a private host', (name) => `https://private.example/ubuntu noble/${TOKEN}-${name} amd64 Packages`, false],
    ['a suite path on a local file repository', (name) => `file:/srv/repo ${TOKEN}-${name}/main amd64 Packages`, false],
    ['a component path on the official host', (name) => `${OFFICIAL} noble/stable-${TOKEN}-${name} amd64 Packages`, false],
    ['a suite path on the official host', (name) => `${OFFICIAL} ${TOKEN}-${name}/stable amd64 Packages`, false],
    ['extra words after the architecture', (name) => `${OFFICIAL} noble/stable amd64 Packages ${TOKEN}-${name}`, true],
  ];

  describe.each([['a list file', GOOD_REPO], ['a deb822 file', GOOD_STANZA_REPO]])('beside %s', (_format, repoText) => {
    it.each(archives)('keeps %s out of the canonical facts of a fresh host and a healthy one', (_label, archive, official) => {
      const policy = policyFor(archive);
      for (const fresh of [true, false]) {
        const facts = factsFor(policy, repoText, fresh);
        expect(canonicalJson(facts)).not.toContain(TOKEN);
        expect(JSON.stringify(evidenceFor(facts))).not.toContain(TOKEN);
        if (!planWithheld(facts)) expect(JSON.stringify(planFor(facts))).not.toContain(TOKEN);
        // Classifying before keeping must not change who is trusted: only the official archive for the host release passes.
        expect(facts.repo.candidateSourceVerified).toBe(official);
        expect(facts.packages.flatMap((pkg) => pkg.candidateSources ?? []).map((source) => source.official)).toEqual(NAMES.map(() => official));
        if (!official) {
          // A foreign candidate keeps a fresh host's plan back; a healthy host keeps its installation.
          expect(planWithheld(factsFor(policy, repoText, true))).toBe(true);
        }
      }
      expect(planWithheld(factsFor(policy, repoText, false))).toBe(false);
      expect(aptSource(factsFor(policy, repoText, false)).status).toBe(official ? 'pass' : 'warn');
    });

    it.each(archives)('hashes the same evidence whatever credential-shaped word %s holds', (_label, archive) => {
      const swapped = policyFor((name) => archive(name).replaceAll(TOKEN, OTHER));
      for (const fresh of [true, false]) {
        expect(evidenceDigestOf(factsFor(policyFor(archive), repoText, fresh))).toBe(evidenceDigestOf(factsFor(swapped, repoText, fresh)));
      }
      // Only a healthy host is issued a plan beside a foreign candidate; its digests must not move either.
      const first = planFor(factsFor(policyFor(archive), repoText, false));
      const second = planFor(factsFor(swapped, repoText, false));
      expect(first.evidenceDigest).toBe(second.evidenceDigest);
      expect(first.digest).toBe(second.digest);
    });
  });

  it('hashes different evidence when the archive differs, so the digest does cover the packages', () => {
    const official = factsFor(policyFor(() => `${OFFICIAL} noble/stable amd64 Packages`), GOOD_REPO, true);
    const foreign = factsFor(policyFor(() => `https://private.example/ubuntu noble/main amd64 Packages`), GOOD_REPO, true);
    expect(evidenceDigestOf(official)).not.toBe(evidenceDigestOf(foreign));
  });

  it('leaves the archive undetermined, not official, when the host release is unknown', () => {
    const policy = policyFor((name) => (name === 'containerd.io' ? 'https://private.example/ubuntu noble/main amd64 Packages' : `${OFFICIAL} jammy/test amd64 Packages`));
    const sources = parseAptPolicy(policy, '').flatMap((pkg) => pkg.candidateSources ?? []);
    expect(sources.map((source) => source.official)).toEqual([null, null, false, null, null]);
    const noCodename = assembleFacts({
      target: { host: 'server.example.com', port: 22, username: 'ubuntu', address: '192.168.1.50' },
      hostKey: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:abc', knownHostsLine: 'line' },
      hubUrl: 'https://sencho.example.com',
      composeDir: '/opt/docker/sencho',
      agentDir: '/opt/sencho-agent',
      results: [probe('os_release', 'ID=ubuntu\nVERSION_ID="24.04"'), probe('uname', 'x86_64\n6.8.0'), probe('apt_policy', policyFor(() => `${OFFICIAL} jammy/test amd64 Packages`))],
      fstabMountPoints: ['/'],
      now: 1_762_300_000_000,
    });
    expect(noCodename.repo.candidateSourceVerified).toBeNull();
  });

  it('still verifies the official archive for the host release and refuses it for another release', () => {
    expect(factsFor(policyFor(() => `${OFFICIAL} noble/stable amd64 Packages`), GOOD_REPO, true).repo.candidateSourceVerified).toBe(true);
    expect(factsFor(policyFor(() => `${OFFICIAL} jammy/stable amd64 Packages`), GOOD_REPO, true).repo.candidateSourceVerified).toBe(false);
    expect(factsFor(policyFor(() => `${OFFICIAL} noble/test amd64 Packages`), GOOD_REPO, true).repo.candidateSourceVerified).toBe(false);
  });

  it('refuses a candidate set in which one package comes from a foreign archive', () => {
    const policy = policyFor((name) => (name === 'containerd.io' ? `https://private.example ${TOKEN}/main amd64 Packages` : `${OFFICIAL} noble/stable amd64 Packages`));
    const facts = factsFor(policy, GOOD_REPO, true);
    expect(facts.repo.candidateSourceVerified).toBe(false);
    expect(canonicalJson(facts)).not.toContain(TOKEN);
  });
});

describe('apt-valid one-line and deb822 syntax is read as apt reads it', () => {
  const UNRELATED_KEYRING = '/etc/apt/keyrings/one.gpg';
  const unrelated = (options: string) => `deb [${options}] http://archive.ubuntu.com/ubuntu noble main`;
  const QUOTED = [
    ['a quoted option name', `"signed-by"=${UNRELATED_KEYRING}`],
    ['a quote inside an option name', `sig"ned-by"=${UNRELATED_KEYRING}`],
    ['an escaped option name', `%73igned-by=${UNRELATED_KEYRING}`],
    ['an escaped equals sign', `signed-by%3d${UNRELATED_KEYRING}`],
    ['a quoted name beside a plain option', `"arch"=amd64 signed-by=${UNRELATED_KEYRING}`],
  ];
  const CUSTOM_LOCATIONS = 'SOURCE_LOCATIONS_MAIN=/srv/apt/main.list\nSOURCE_LOCATIONS_PARTS=/srv/apt/parts';
  const source = (file: string, content: string) => `SOURCE_BEGIN=${file}\n${content}\nSOURCE_END=${file}`;

  describe.each([
    ['the main list', DEFAULT_SOURCE_LOCATIONS, MAIN_LIST, LIST_FILE],
    ['an arbitrary .list file', DEFAULT_SOURCE_LOCATIONS, CUSTOM_LIST, LIST_FILE],
    ['a main list at a custom location', CUSTOM_LOCATIONS, '/srv/apt/main.list', '/srv/apt/parts/docker.list'],
  ])('in %s', (_where, locations, file, dockerFile) => {
    /** The unrelated entry in the file under test, beside a verified Docker entry. */
    const repoText = (content: string) => [locations, source(file, content), source(dockerFile, deb('arch=amd64')), dockerAscBlock()].join('\n');

    it.each(QUOTED)('verifies a Docker entry beside %s, with a plan for a fresh host and none of the warning for a healthy one', (_label, options) => {
      const text = repoText(unrelated(options));
      const assembled = assemble([probe('docker_repo', text), probe('apt_policy', '')]);
      expect(assembled.repo.problem).toBeNull();
      expect(assembled.repo.sourceVerified).toBe(true);
      const fresh = makeFacts({ docker: FRESH_DOCKER, packages: NO_CANDIDATES, repo: assembled.repo });
      expect(planWithheld(fresh)).toBe(false);
      expect(aptSource(makeFacts({ packages: NO_CANDIDATES, repo: assembled.repo })).status).toBe('pass');
    });

    it('still fails closed on the malformed counterparts', () => {
      for (const options of ['""=amd64', 'arch=amd64 ""', 'arch=amd64 foo']) {
        const text = repoText(unrelated(options));
        const assembled = assemble([probe('docker_repo', text), probe('apt_policy', '')]);
        expect(assembled.repo.sourceVerified, options).toBe(false);
        const fresh = makeFacts({ docker: FRESH_DOCKER, packages: NO_CANDIDATES, repo: assembled.repo });
        expect(planWithheld(fresh), options).toBe(true);
        expect(aptSource(makeFacts({ packages: NO_CANDIDATES, repo: assembled.repo })).status, options).toBe('warn');
      }
    });
  });

  describe('an option written the way apt reads it keeps its meaning', () => {
    const verified = (options: string, arch = 'amd64') => parse(arch, block(CUSTOM_LIST, `deb [${options}] ${OFFICIAL} noble stable`), dockerAscBlock());

    it.each([
      ['a quoted trusted', `arch=amd64 "trusted"=yes signed-by=${DOCKER_ASC_PATH}`],
      ['an escaped trusted', `arch=amd64 %74rusted=yes signed-by=${DOCKER_ASC_PATH}`],
      ['a quote inside trusted', `arch=amd64 tr"usted"=yes signed-by=${DOCKER_ASC_PATH}`],
      ['an escaped value', `arch=amd64 trusted=y%65s signed-by=${DOCKER_ASC_PATH}`],
      ['a quoted allow-insecure', `arch=amd64 "allow-insecure"=yes signed-by=${DOCKER_ASC_PATH}`],
      ['a spelling in another case beside a plain one', `arch=amd64 trusted=yes TRUSTED=no signed-by=${DOCKER_ASC_PATH}`],
    ])('weakens signatures through %s', (_label, options) => {
      const result = verified(options);
      expect(result.sourceVerified).toBe(false);
      expect(result.problem).toMatch(/weakens signature checking/);
    });

    it('applies an architecture option written with quotes or escapes', () => {
      expect(verified(`"arch"=arm64 signed-by=${DOCKER_ASC_PATH}`).sourceVerified).toBe(false);
      expect(verified(`%61rch=arm64 signed-by=${DOCKER_ASC_PATH}`).sourceVerified).toBe(false);
      expect(verified(`"arch"=amd64 signed-by=${DOCKER_ASC_PATH}`).sourceVerified).toBe(true);
    });

    it('reads a quoted signed-by as the keyring it names', () => {
      expect(verified(`arch=amd64 "signed-by"=${DOCKER_ASC_PATH}`).sourceVerified).toBe(true);
      const unknownKeyring = verified('arch=amd64 "signed-by"=/etc/apt/keyrings/other.gpg');
      expect(unknownKeyring.sourceVerified).toBe(false);
      expect(unknownKeyring.problem).toMatch(/does not name an installed Docker keyring/);
    });

    it('reads a URI, suite and component written with quotes or escapes', () => {
      const line = (uri: string, suite: string, component: string) => parse('amd64', block(CUSTOM_LIST, `deb [arch=amd64 signed-by=${DOCKER_ASC_PATH}] ${uri} ${suite} ${component}`), dockerAscBlock());
      expect(line('https://download.docker.com/linux/ub"untu"', 'no"ble"', 'sta"ble"').sourceVerified).toBe(true);
      expect(line('https://download.docker.com/linux/ubun%74u', '%6eoble', '%73table').sourceVerified).toBe(true);
      expect(line(OFFICIAL, 'noble,jammy', 'stable').sourceVerified).toBe(false);
    });

    it('keeps a comment mark inside an option group out of the comment', () => {
      expect(verified(`arch=amd64 signed-by=${DOCKER_ASC_PATH}`).sourceVerified).toBe(true);
      const hashInOption = parse('amd64', block(CUSTOM_LIST, `deb [arch=amd64 signed-by=${DOCKER_ASC_PATH}#x] ${OFFICIAL} noble stable`), dockerAscBlock());
      expect(hashInOption.sourceVerified).toBe(false);
      expect(hashInOption.problem).toMatch(/does not name an installed Docker keyring/);
    });
  });

  describe('deb822 forms apt skips or reads as a field', () => {
    const withUnrelated = (extra: string) => parse('amd64', block(CUSTOM_SOURCES, extra), dockerAscBlock());

    it.each([
      ['an indented non-comment line before the first stanza', `  foo\n${stanza({})}`],
      ['an indented field-like line before the first stanza', `  foo: bar\n${stanza({})}`],
      ['an indented line between stanzas', `${stanza({})}\n\n  foo\n\n${stanza({})}`],
      ['an empty field name', `${stanza({})}\n:x`],
      ['an empty field name before the first field', `:x\n${stanza({})}`],
      ['an empty field name with a space before its value', `${stanza({})}\n: x`],
    ])('verifies a Docker stanza with %s', (_label, content) => {
      const assembled = assemble([probe('docker_repo', [block(CUSTOM_SOURCES, content), dockerAscBlock()].join('\n')), probe('apt_policy', '')]);
      expect(assembled.repo.problem).toBeNull();
      expect(assembled.repo.sourceVerified).toBe(true);
      const fresh = makeFacts({ docker: FRESH_DOCKER, packages: NO_CANDIDATES, repo: assembled.repo });
      expect(planWithheld(fresh)).toBe(false);
      expect(aptSource(makeFacts({ packages: NO_CANDIDATES, repo: assembled.repo })).status).toBe('pass');
    });

    it('keeps an indented line after a field as part of that field', () => {
      const continued = withUnrelated(`${stanza({})}\n  /etc/apt/keyrings/other.gpg`);
      expect(continued.sourceVerified).toBe(false);
      expect(continued.problem).toMatch(/does not name an installed Docker keyring/);
    });

    it('still rejects the malformed counterparts', () => {
      for (const content of [`${stanza({})}\ngarbage`, ':x', `Foo\n${stanza({})}`]) {
        const result = withUnrelated(content);
        expect(result.sourceVerified, content).toBe(false);
        expect(result.problem, content).toMatch(/not a valid apt entry|no Types field/);
      }
    });
  });
});

describe('what apt reads differently from JavaScript stays fail-closed', () => {
  const NBSP = '\u00a0';
  const SIGNED = `signed-by=${DOCKER_ASC_PATH}`;
  const entry = (options: string, uri = OFFICIAL) => parse('amd64', block(CUSTOM_LIST, `deb [${options}] ${uri} noble stable`), dockerAscBlock());
  const deb822 = (fields: Record<string, string>) => parse('amd64', block(CUSTOM_SOURCES, stanza(fields)), dockerAscBlock());

  it.each([
    ['a no-break space between two architectures', `arch=arm64${NBSP}amd64`],
    ['a no-break space after the architecture', `arch=amd64${NBSP}`],
    ['a quoted space between two architectures', 'arch="arm64 amd64"'],
    ['an escaped space between two architectures', 'arch=arm64%20amd64'],
    ['an added architecture that ends in a no-break space', `arch=arm64 arch+=amd64${NBSP}x`],
    ['a deb822 field name used as a one-line option', 'arch=arm64 architectures=amd64'],
    ['a deb822 add field used as a one-line option', 'arch=arm64 architectures-add=amd64'],
  ])('does not verify an entry with %s', (_label, options) => {
    const result = entry(`${options} ${SIGNED}`);
    expect(result.sourceVerified).toBe(false);
    expect(result.problem).toMatch(/amd64 architecture/);
  });

  it.each([
    'trusted=yes TRUSTED=no',
    'TRUSTED=yes trusted=no',
    'Trusted=yes trusted=no',
    'allow-insecure=yes Allow-Insecure=no',
  ])('keeps a weakening option whichever spelling comes last: %s', (options) => {
    const result = entry(`arch=amd64 ${options} ${SIGNED}`);
    expect(result.sourceVerified).toBe(false);
    expect(result.problem).toMatch(/weakens signature checking/);
  });

  it('does not take a keyring path that starts with a no-break space for the keyring', () => {
    const result = entry(`arch=amd64 signed-by=${NBSP}${DOCKER_ASC_PATH}`);
    expect(result.sourceVerified).toBe(false);
    expect(result.problem).toMatch(/does not name an installed Docker keyring/);
  });

  it.each(['%23x', '%3fx', '%20', '/%09'])('does not take the official URI followed by %s for the official one', (suffix) => {
    const result = entry(`arch=amd64 ${SIGNED}`, `${OFFICIAL}${suffix}`);
    expect(result.sourceVerified).toBe(false);
    expect(result.problem).toMatch(/points at https:\/\/download\.docker\.com, not/);
    expect(parse('amd64', block(CUSTOM_SOURCES, stanza({ URIs: `${OFFICIAL}${decodeURIComponent(suffix)}` })), dockerAscBlock()).sourceVerified).toBe(false);
  });

  it('judges an entry whose escaped or quoted URI names Docker\'s host as apt reads it', () => {
    expect(entry(`arch=amd64 ${SIGNED}`, 'https://download%2edocker.com/linux/ubuntu').sourceVerified).toBe(true);
    expect(entry(`arch=amd64 ${SIGNED}`, 'https://download."docker".com/linux/ubuntu').sourceVerified).toBe(true);
    const evil = entry(`arch=amd64 ${SIGNED}`, 'https://download%2edocker.com.evil.example/linux/ubuntu');
    expect(evil.sourceVerified).toBe(false);
    expect(evil.problem).toMatch(/names Docker's host in a URI that is not/);
  });

  it('reads an entry of an option group closed by a second bracket the way apt does', () => {
    expect(parse('amd64', block(CUSTOM_LIST, `deb [arch=amd64 ${SIGNED}] ] ${OFFICIAL} noble stable`), dockerAscBlock()).sourceVerified).toBe(true);
  });

  it('leaves a file unknown, not contradicted, when its option group closes with an escape', () => {
    const text = [block(CUSTOM_LIST, `${deb('arch=amd64')}\ndeb [arch=amd64%5d http://archive.ubuntu.com/ubuntu noble main`), dockerAscBlock()].join('\n');
    const assembled = assemble([probe('docker_repo', text), probe('apt_policy', '')]);
    expect(assembled.repo.sourceVerified).toBeNull();
    expect(assembled.repo.problem).toMatch(/closes its option group with an escape, which this check does not read/);
    expect(planWithheld(makeFacts({ docker: FRESH_DOCKER, packages: NO_CANDIDATES, repo: assembled.repo }))).toBe(true);
    expect(aptSource(makeFacts({ packages: NO_CANDIDATES, repo: assembled.repo })).status).toBe('warn');
  });

  it('rejects an empty suite, which makes apt abort', () => {
    const result = parse('amd64', block(CUSTOM_LIST, `${deb('arch=amd64')}\ndeb http://archive.ubuntu.com/ubuntu "" main`), dockerAscBlock());
    expect(result.sourceVerified).toBe(false);
    expect(result.problem).toMatch(/not a valid apt entry/);
  });

  it('does not take a URI with a backslash for the official one', () => {
    expect(entry(`arch=amd64 ${SIGNED}`, 'https://download.docker.com\\linux/ubuntu').sourceVerified).toBe(false);
    expect(parse('amd64', block(CUSTOM_SOURCES, stanza({ URIs: 'https://download.docker.com\\linux/ubuntu' })), dockerAscBlock()).sourceVerified).toBe(false);
  });

  it('does not verify an entry beside an empty component, which apt reads as an index that does not exist', () => {
    const result = parse('amd64', block(CUSTOM_LIST, `deb [arch=amd64 ${SIGNED}] ${OFFICIAL} noble stable ""`), dockerAscBlock());
    expect(result.sourceVerified).toBe(false);
    expect(result.problem).toMatch(/empty component/);
  });

  describe('a .sources file', () => {
    it.each(['no', 'false', '0', '00', '0x0', '-0', '+0', ' 0', '0X00'])('treats Enabled: %j as disabled, as apt does', (value) => {
      const result = parse('amd64', block(CUSTOM_SOURCES, stanza({ Enabled: value })), dockerAscBlock());
      // A disabled stanza supplies no source, so none counts as configured.
      expect(result.dockerSourceConfigured).toBe(false);
      expect(result.sourceVerified).toBe(false);
    });

    it.each(['yes', '1', '2', 'maybe', '0x1', '01'])('keeps a stanza with Enabled: %j enabled', (value) => {
      expect(parse('amd64', block(CUSTOM_SOURCES, stanza({ Enabled: value })), dockerAscBlock()).sourceVerified).toBe(true);
    });

    it('takes a comma in Suites or Components as part of the word, as apt does', () => {
      const suite = deb822({ Suites: 'noble,jammy' });
      expect(suite.sourceVerified).toBe(false);
      expect(suite.problem).toMatch(/suite is not the host release noble/);
      const component = deb822({ Components: 'stable,main' });
      expect(component.sourceVerified).toBe(false);
      expect(component.problem).toMatch(/does not enable the stable component/);
    });

    it.each([
      ['two architectures separated by a space', 'arm64 amd64', true],
      ['two architectures separated by a comma', 'arm64,amd64', true],
      ['two architectures separated by a space and a comma', 'arm64, amd64', true],
      ['a single other architecture', 'arm64', false],
      ['two architectures joined by a no-break space', `arm64${NBSP}amd64`, false],
    ])('applies %s', (_label, architectures, verified) => {
      expect(deb822({ Architectures: architectures }).sourceVerified).toBe(verified);
    });

    it('ends a stanza at an empty line only, not at a line of spaces or tabs', () => {
      // apt reads this as one stanza that ends up disabled; a parser that splits at the spaces would verify the second half.
      for (const gap of [' ', '\t']) {
        const merged = parse('amd64', block(CUSTOM_SOURCES, `${stanza({ Enabled: 'no' })}\n${gap}\n${stanza({})}`), dockerAscBlock());
        expect(merged.sourceVerified, JSON.stringify(gap)).toBe(false);
      }
      const split = [
        'Types: deb', `URIs: ${OFFICIAL}`, 'Suites: noble', ' ', 'Components: stable', `Signed-By: ${DOCKER_ASC_PATH}`,
      ].join('\n');
      expect(parse('amd64', block(CUSTOM_SOURCES, split), dockerAscBlock()).sourceVerified).toBe(true);
    });

    it('reads a no-break space in a value or a comment as part of the text, not as a separator', () => {
      expect(parse('amd64', block(CUSTOM_SOURCES, `${stanza({})}\nX-Note: a${NBSP}b`), dockerAscBlock()).sourceVerified).toBe(true);
      expect(parse('amd64', block(CUSTOM_SOURCES, `${stanza({})}\n\n  # a${NBSP}b\n\n${stanza({})}`), dockerAscBlock()).sourceVerified).toBe(true);
      expect(deb822({ Types: `deb${NBSP}deb-src` }).sourceVerified).toBe(false);
      expect(deb822({ Trusted: `no${NBSP}` }).problem).toMatch(/weakens signature checking/);
      expect(parse('amd64', block(CUSTOM_SOURCES, `${NBSP}${stanza({})}`), dockerAscBlock()).sourceVerified).toBe(false);
    });
  });
});
