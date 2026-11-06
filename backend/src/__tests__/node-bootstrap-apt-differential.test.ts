import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { parseAptPolicy, parseDockerRepo } from '../services/nodeBootstrap/probes';
import { DEFAULT_SOURCE_LOCATIONS } from './__helpers__/dockerRepoFixtures';

/**
 * The source parser against apt itself. Each case is one source file; the
 * expectation for apt was read from `apt-get --print-uris update` over that
 * file alone (exit 0, or 100 for "The list of sources could not be read"), and
 * the parser must agree. Where the parser is stricter than apt on purpose, the
 * case says so (`apt: 'accepts'`, `parser: 'rejects'`): a stricter answer is a
 * false blocker, never a false verification. Both halves are asserted for every
 * case. The apt half runs where apt-get can run against an isolated
 * configuration, and must run in CI. Every apt expectation was recorded on apt
 * 3.2.1. The one-line reader is a port of apt's own word reader, so every case
 * here is a form apt reads one way: quotes anywhere in a word, `%XX` escapes
 * and bracket groups included.
 */

type Kind = 'list' | 'sources';
interface Case {
  name: string;
  kind: Kind;
  content: string;
  /** What apt does with the file. */
  apt: 'accepts' | 'rejects';
  /** What the parser does; `rejects` while apt accepts would be a false blocker, so no case may do that. */
  parser: 'accepts' | 'rejects';
}

const NBSP = '\u00a0';
const BOM = '\ufeff';

const DOCKER_STANZA = [
  'Types: deb',
  'URIs: https://download.docker.com/linux/ubuntu',
  'Suites: noble',
  'Components: stable',
  'Signed-By: /etc/apt/keyrings/docker.asc',
].join('\n');

const cases: Case[] = [
  // One-line quoting: valid.
  { name: 'double-quoted URI', kind: 'list', content: 'deb "http://archive.ubuntu.com/ubuntu" noble main', apt: 'accepts', parser: 'accepts' },
  { name: 'double-quoted suite', kind: 'list', content: 'deb http://archive.ubuntu.com/ubuntu "noble" main', apt: 'accepts', parser: 'accepts' },
  { name: 'double-quoted component', kind: 'list', content: 'deb http://archive.ubuntu.com/ubuntu noble "main"', apt: 'accepts', parser: 'accepts' },
  { name: 'double-quoted option value with two keyrings', kind: 'list', content: 'deb [signed-by="/etc/apt/keyrings/one.gpg /etc/apt/keyrings/two.gpg"] http://archive.ubuntu.com/ubuntu noble main', apt: 'accepts', parser: 'accepts' },
  { name: 'comma-separated keyrings', kind: 'list', content: 'deb [signed-by=/etc/apt/keyrings/one.gpg,/etc/apt/keyrings/two.gpg] http://archive.ubuntu.com/ubuntu noble main', apt: 'accepts', parser: 'accepts' },
  { name: 'spaces inside the option brackets', kind: 'list', content: 'deb [ signed-by=/etc/apt/keyrings/one.gpg ] http://archive.ubuntu.com/ubuntu noble main', apt: 'accepts', parser: 'accepts' },
  { name: 'quoted URI that holds a space', kind: 'list', content: 'deb "http://repo.example/a b" noble main', apt: 'accepts', parser: 'accepts' },
  { name: 'tabs and a trailing comment', kind: 'list', content: 'deb\thttp://archive.ubuntu.com/ubuntu\tnoble\tmain # note', apt: 'accepts', parser: 'accepts' },
  // One-line quoting apt reads, wherever the quote stands in a word.
  { name: 'quote opening inside an option value', kind: 'list', content: 'deb [arch=amd"64"] http://archive.ubuntu.com/ubuntu noble main', apt: 'accepts', parser: 'accepts' },
  { name: 'double-quoted option name', kind: 'list', content: 'deb ["signed-by"=/etc/apt/keyrings/one.gpg] http://archive.ubuntu.com/ubuntu noble main', apt: 'accepts', parser: 'accepts' },
  { name: 'quote inside an option name', kind: 'list', content: 'deb [sig"ned-by"=/etc/apt/keyrings/one.gpg] http://archive.ubuntu.com/ubuntu noble main', apt: 'accepts', parser: 'accepts' },
  { name: 'quoted option name beside a plain one', kind: 'list', content: 'deb ["arch"=amd64 signed-by=/etc/apt/keyrings/one.gpg] http://archive.ubuntu.com/ubuntu noble main', apt: 'accepts', parser: 'accepts' },
  { name: 'quote inside a suite and a component', kind: 'list', content: 'deb http://archive.ubuntu.com/ubuntu no"ble" ma"in"', apt: 'accepts', parser: 'accepts' },
  { name: 'escaped option name', kind: 'list', content: 'deb [%73igned-by=/etc/apt/keyrings/one.gpg] http://archive.ubuntu.com/ubuntu noble main', apt: 'accepts', parser: 'accepts' },
  { name: 'escaped equals sign in an option', kind: 'list', content: 'deb [signed-by%3d/etc/apt/keyrings/one.gpg] http://archive.ubuntu.com/ubuntu noble main', apt: 'accepts', parser: 'accepts' },
  { name: 'escaped option value', kind: 'list', content: 'deb [arch=amd%36%34] http://archive.ubuntu.com/ubuntu noble main', apt: 'accepts', parser: 'accepts' },
  { name: 'escaped URI scheme', kind: 'list', content: 'deb ht%74p://archive.ubuntu.com/ubuntu noble main', apt: 'accepts', parser: 'accepts' },
  { name: 'escape inside a suite', kind: 'list', content: 'deb http://archive.ubuntu.com/ubuntu noble%20x main', apt: 'accepts', parser: 'accepts' },
  { name: 'hash inside an option value', kind: 'list', content: 'deb [arch=amd64#x] http://archive.ubuntu.com/ubuntu noble main', apt: 'accepts', parser: 'accepts' },
  { name: 'comment that opens a bracket', kind: 'list', content: 'deb http://archive.ubuntu.com/ubuntu "noble" main # [ open', apt: 'accepts', parser: 'accepts' },
  { name: 'comma in a suite', kind: 'list', content: 'deb http://archive.ubuntu.com/ubuntu noble,jammy main', apt: 'accepts', parser: 'accepts' },
  { name: 'unclosed quote after the components', kind: 'list', content: 'deb [arch=amd64] http://archive.ubuntu.com/ubuntu noble main "unclosed', apt: 'accepts', parser: 'accepts' },
  { name: 'unclosed quote after an exact-path suite', kind: 'list', content: 'deb http://archive.ubuntu.com/ubuntu noble/ "unclosed', apt: 'accepts', parser: 'accepts' },
  { name: 'exact-path suite', kind: 'list', content: 'deb http://archive.ubuntu.com/ubuntu ./', apt: 'accepts', parser: 'accepts' },
  { name: 'two option groups with no space between', kind: 'list', content: 'deb [a=b][c=d] http://archive.ubuntu.com/ubuntu noble main', apt: 'accepts', parser: 'accepts' },
  { name: 'tabs between every word', kind: 'list', content: 'deb\t[arch=amd64]\thttp://archive.ubuntu.com/ubuntu\tnoble\tmain', apt: 'accepts', parser: 'accepts' },
  { name: 'deb-src with options', kind: 'list', content: 'deb-src [arch=amd64] http://archive.ubuntu.com/ubuntu noble main', apt: 'accepts', parser: 'accepts' },
  // One-line quoting: invalid.
  { name: 'empty quoted option', kind: 'list', content: 'deb [arch=amd64 ""] http://archive.ubuntu.com/ubuntu noble main', apt: 'rejects', parser: 'rejects' },
  { name: 'empty quoted option name', kind: 'list', content: 'deb [""=amd64] http://archive.ubuntu.com/ubuntu noble main', apt: 'rejects', parser: 'rejects' },
  { name: 'no space after the option group', kind: 'list', content: 'deb [arch=amd64]http://archive.ubuntu.com/ubuntu noble main', apt: 'rejects', parser: 'rejects' },
  { name: 'comment inside an open option group', kind: 'list', content: 'deb [arch=amd64 # in option ] http://archive.ubuntu.com/ubuntu noble main', apt: 'rejects', parser: 'rejects' },
  { name: 'exact-path suite with a component', kind: 'list', content: 'deb http://archive.ubuntu.com/ubuntu noble/ main', apt: 'rejects', parser: 'rejects' },
  { name: 'closing bracket written as an escape', kind: 'list', content: 'deb [arch=amd64%5d http://archive.ubuntu.com/ubuntu noble main', apt: 'rejects', parser: 'rejects' },
  { name: 'closing bracket inside quotes', kind: 'list', content: 'deb [arch=amd64"]" http://archive.ubuntu.com/ubuntu noble main', apt: 'rejects', parser: 'rejects' },
  { name: 'single-quoted option value', kind: 'list', content: "deb [signed-by='/etc/apt/keyrings/one.gpg /etc/apt/keyrings/two.gpg'] http://archive.ubuntu.com/ubuntu noble main", apt: 'rejects', parser: 'rejects' },
  { name: 'unclosed quote', kind: 'list', content: 'deb "http://archive.ubuntu.com/ubuntu noble main', apt: 'rejects', parser: 'rejects' },
  { name: 'quoted URI with no scheme', kind: 'list', content: 'deb "archive.ubuntu.com/ubuntu" noble main', apt: 'rejects', parser: 'rejects' },
  { name: 'two option groups', kind: 'list', content: 'deb [arch=amd64] [signed-by=/etc/apt/keyrings/one.gpg] http://archive.ubuntu.com/ubuntu noble main', apt: 'rejects', parser: 'rejects' },
  { name: 'option group quoted as a whole', kind: 'list', content: 'deb "[signed-by=/etc/apt/keyrings/one.gpg]" http://archive.ubuntu.com/ubuntu noble main', apt: 'rejects', parser: 'rejects' },
  { name: 'option with no value', kind: 'list', content: 'deb [signed-by] http://archive.ubuntu.com/ubuntu noble main', apt: 'rejects', parser: 'rejects' },
  { name: 'option with an empty value', kind: 'list', content: 'deb [signed-by=] http://archive.ubuntu.com/ubuntu noble main', apt: 'rejects', parser: 'rejects' },
  { name: 'unclosed option group', kind: 'list', content: 'deb [signed-by=/etc/apt/keyrings/one.gpg http://archive.ubuntu.com/ubuntu noble main', apt: 'rejects', parser: 'rejects' },
  { name: 'no component', kind: 'list', content: 'deb http://archive.ubuntu.com/ubuntu noble', apt: 'rejects', parser: 'rejects' },
  { name: 'upper-case type', kind: 'list', content: 'DEB http://archive.ubuntu.com/ubuntu noble main', apt: 'rejects', parser: 'rejects' },
  { name: 'URI with no scheme', kind: 'list', content: 'deb archive.ubuntu.com/ubuntu noble main', apt: 'rejects', parser: 'rejects' },
  { name: 'upper-case URI scheme', kind: 'list', content: 'deb HTTPS://archive.ubuntu.com/ubuntu noble main', apt: 'rejects', parser: 'rejects' },
  { name: 'upper-case URI scheme in a deb822 stanza', kind: 'sources', content: 'Types: deb\nURIs: HTTPS://download.docker.com/linux/ubuntu\nSuites: noble\nComponents: stable', apt: 'rejects', parser: 'rejects' },
  // A '#' starts a comment wherever it stands, inside a word too.
  { name: 'hash inside the URI', kind: 'list', content: 'deb http://archive.ubuntu.com/ubuntu#x noble main', apt: 'rejects', parser: 'rejects' },
  { name: 'hash that ends the last component', kind: 'list', content: 'deb http://archive.ubuntu.com/ubuntu noble main#c', apt: 'accepts', parser: 'accepts' },
  // Whitespace JavaScript splits on and apt does not.
  { name: 'no-break space between suite and component', kind: 'list', content: `deb http://archive.ubuntu.com/ubuntu noble${NBSP}main`, apt: 'rejects', parser: 'rejects' },
  { name: 'no-break space after the type', kind: 'list', content: `deb${NBSP}http://archive.ubuntu.com/ubuntu noble main`, apt: 'rejects', parser: 'rejects' },
  { name: 'byte order mark before the type', kind: 'list', content: `${BOM}deb http://archive.ubuntu.com/ubuntu noble main`, apt: 'rejects', parser: 'rejects' },
  { name: 'no-break space inside a comment', kind: 'list', content: `deb http://archive.ubuntu.com/ubuntu noble main # a${NBSP}b`, apt: 'accepts', parser: 'accepts' },
  { name: 'no-break space after a deb822 field name', kind: 'sources', content: `Types:${NBSP}deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: noble\nComponents: stable`, apt: 'rejects', parser: 'rejects' },
  { name: 'byte order mark before a deb822 stanza', kind: 'sources', content: `${BOM}${DOCKER_STANZA}`, apt: 'rejects', parser: 'rejects' },
  // deb822 comments and field names: valid.
  { name: 'indented comment before the first stanza', kind: 'sources', content: `  # note\n${DOCKER_STANZA}`, apt: 'accepts', parser: 'accepts' },
  { name: 'tab-indented comment before the first stanza', kind: 'sources', content: `\t# note\n${DOCKER_STANZA}`, apt: 'accepts', parser: 'accepts' },
  { name: 'indented comment between stanzas', kind: 'sources', content: `${DOCKER_STANZA}\n\n  # note\n\n${DOCKER_STANZA}`, apt: 'accepts', parser: 'accepts' },
  { name: 'comment at column zero inside a stanza', kind: 'sources', content: 'Types: deb\n# note\nURIs: https://download.docker.com/linux/ubuntu\nSuites: noble\nComponents: stable', apt: 'accepts', parser: 'accepts' },
  { name: 'indented comment after Components', kind: 'sources', content: 'Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: noble\nComponents: stable\n  # note', apt: 'accepts', parser: 'accepts' },
  { name: 'field name with a plus sign', kind: 'sources', content: `${DOCKER_STANZA}\nX+Note: x`, apt: 'accepts', parser: 'accepts' },
  { name: 'field name with an at sign', kind: 'sources', content: `${DOCKER_STANZA}\nX@Note: x`, apt: 'accepts', parser: 'accepts' },
  { name: 'field name with a slash', kind: 'sources', content: `${DOCKER_STANZA}\nX-Note/foo: x`, apt: 'accepts', parser: 'accepts' },
  { name: 'field name with a space', kind: 'sources', content: `${DOCKER_STANZA}\nX Note: x`, apt: 'accepts', parser: 'accepts' },
  { name: 'field with no space after the colon', kind: 'sources', content: `${DOCKER_STANZA}\nX-Note:x`, apt: 'accepts', parser: 'accepts' },
  { name: 'field with an empty value', kind: 'sources', content: `${DOCKER_STANZA}\nX-Note:`, apt: 'accepts', parser: 'accepts' },
  // deb822: invalid.
  { name: 'indented comment that continues Types', kind: 'sources', content: 'Types: deb\n  # note\nURIs: https://download.docker.com/linux/ubuntu\nSuites: noble\nComponents: stable', apt: 'rejects', parser: 'rejects' },
  { name: 'indented comment that continues URIs', kind: 'sources', content: 'Types: deb\nURIs: https://download.docker.com/linux/ubuntu\n  # note\nSuites: noble\nComponents: stable', apt: 'rejects', parser: 'rejects' },
  { name: 'line with no colon', kind: 'sources', content: `${DOCKER_STANZA}\ngarbage`, apt: 'rejects', parser: 'rejects' },
  { name: 'indented field that starts the stanza', kind: 'sources', content: ' Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: noble\nComponents: stable', apt: 'rejects', parser: 'rejects' },
  // deb822 forms apt skips or reads as a field.
  { name: 'indented non-comment line before the first stanza', kind: 'sources', content: `  foo\n${DOCKER_STANZA}`, apt: 'accepts', parser: 'accepts' },
  { name: 'indented field-like line before the first stanza', kind: 'sources', content: `  foo: bar\n${DOCKER_STANZA}`, apt: 'accepts', parser: 'accepts' },
  { name: 'indented non-comment line between stanzas', kind: 'sources', content: `${DOCKER_STANZA}\n\n  foo\n\n${DOCKER_STANZA}`, apt: 'accepts', parser: 'accepts' },
  { name: 'empty field name', kind: 'sources', content: `${DOCKER_STANZA}\n:x`, apt: 'accepts', parser: 'accepts' },
  { name: 'empty field name before the first field', kind: 'sources', content: `:x\n${DOCKER_STANZA}`, apt: 'accepts', parser: 'accepts' },
  { name: 'empty field name with a space before the value', kind: 'sources', content: `${DOCKER_STANZA}\n: x`, apt: 'accepts', parser: 'accepts' },
  { name: 'stanza that holds only an empty field name', kind: 'sources', content: ':x', apt: 'rejects', parser: 'rejects' },
];

function parserRejects(testCase: Case): boolean {
  const file = `/etc/apt/sources.list.d/differential.${testCase.kind === 'list' ? 'list' : 'sources'}`;
  const output = `${DEFAULT_SOURCE_LOCATIONS}\nSOURCE_BEGIN=${file}\n${testCase.content}\nSOURCE_END=${file}`;
  // Only a reason about content apt rejects, or content this check refuses to read, counts; the file holds no keyring, so Docker stanzas carry another problem.
  return /apt rejects|not a valid apt entry|does not read/.test(parseDockerRepo(output, 'noble', 'amd64').problem ?? '');
}

const root = mkdtempSync(path.join(os.tmpdir(), 'sencho-apt-differential-'));
mkdirSync(path.join(root, 'state', 'lists', 'partial'), { recursive: true });
mkdirSync(path.join(root, 'cache', 'archives', 'partial'), { recursive: true });
let sequence = 0;

/** Exit status of apt reading only this file, or null when apt cannot run here. */
function aptStatus(kind: Kind, content: string): number | null {
  const dir = path.join(root, `case-${sequence++}`);
  mkdirSync(path.join(dir, 'parts'), { recursive: true });
  writeFileSync(path.join(dir, 'main.list'), kind === 'list' ? `${content}\n` : '');
  if (kind === 'sources') writeFileSync(path.join(dir, 'parts', 'one.sources'), `${content}\n`);
  const result = spawnSync('apt-get', [
    '-o', `Dir::Etc::sourcelist=${path.join(dir, 'main.list')}`,
    '-o', `Dir::Etc::sourceparts=${kind === 'list' ? '-' : path.join(dir, 'parts')}`,
    '-o', `Dir::State=${path.join(root, 'state')}`,
    '-o', `Dir::State::lists=${path.join(root, 'state', 'lists')}`,
    '-o', `Dir::Cache=${path.join(root, 'cache')}`,
    '--print-uris', 'update',
  ], { encoding: 'utf8', timeout: 20_000 });
  return result.error ? null : result.status;
}

const aptRuns = aptStatus('list', 'deb http://archive.ubuntu.com/ubuntu noble main') === 0
  && aptStatus('list', 'deb http://archive.ubuntu.com/ubuntu noble') === 100;

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('the source parser against apt', () => {
  it.each(cases)('agrees with the expectation for $name', (testCase) => {
    expect(parserRejects(testCase)).toBe(testCase.parser === 'rejects');
  });

  it('never accepts what apt rejects', () => {
    const wrong = cases.filter((testCase) => testCase.apt === 'rejects' && testCase.parser === 'accepts');
    expect(wrong).toEqual([]);
  });

  // A CI image without a working apt-get would otherwise skip the whole apt half unnoticed.
  it.skipIf(!process.env.CI)('has an apt-get that runs against an isolated configuration', () => {
    expect(aptRuns).toBe(true);
  });

  (aptRuns ? it.each(cases) : it.skip.each(cases))('matches what apt does with $name', (testCase) => {
    expect(aptStatus(testCase.kind, testCase.content)).toBe(testCase.apt === 'accepts' ? 0 : 100);
  });
});

/**
 * `apt-cache policy` of a real local repository whose suite and component hold a
 * credential-shaped token, read by the same parser the preflight uses.
 */
const DOCKER_PACKAGE_NAMES = ['docker-ce', 'docker-ce-cli', 'containerd.io', 'docker-buildx-plugin', 'docker-compose-plugin'];

function realPolicy(suite: string, component: string): string | null {
  const dir = path.join(root, `repo-${sequence++}`);
  const packages = path.join(dir, 'repo', 'dists', suite, component, 'binary-amd64');
  mkdirSync(packages, { recursive: true });
  mkdirSync(path.join(dir, 'state', 'lists', 'partial'), { recursive: true });
  mkdirSync(path.join(dir, 'cache', 'archives', 'partial'), { recursive: true });
  const index = DOCKER_PACKAGE_NAMES.map((name) => [
    `Package: ${name}`, 'Version: 5:27.3.1-1', 'Architecture: amd64', 'Maintainer: t <t@example.com>',
    `Filename: pool/${name}.deb`, 'Size: 1', 'MD5sum: 00000000000000000000000000000000', 'Description: t', '',
  ].join('\n')).join('\n');
  writeFileSync(path.join(packages, 'Packages'), index);
  const bytes = readFileSync(path.join(packages, 'Packages'));
  writeFileSync(path.join(dir, 'repo', 'dists', suite, 'Release'), [
    `Suite: ${suite}`, `Codename: ${suite}`, 'Architectures: amd64', `Components: ${component}`, 'Date: Mon, 02 Nov 2026 00:00:00 UTC',
    'SHA256:', ` ${createHash('sha256').update(bytes).digest('hex')} ${bytes.length} ${component}/binary-amd64/Packages`, '',
  ].join('\n'));
  writeFileSync(path.join(dir, 'main.list'), `deb [trusted=yes] file:${path.join(dir, 'repo')} ${suite} ${component}\n`);
  writeFileSync(path.join(dir, 'status'), '');
  const config = [
    '-o', `Dir::Etc::sourcelist=${path.join(dir, 'main.list')}`, '-o', 'Dir::Etc::sourceparts=-',
    '-o', `Dir::State=${path.join(dir, 'state')}`, '-o', `Dir::State::lists=${path.join(dir, 'state', 'lists')}`,
    '-o', `Dir::State::status=${path.join(dir, 'status')}`, '-o', `Dir::Cache=${path.join(dir, 'cache')}`,
    '-o', 'APT::Architecture=amd64', '-o', 'APT::Architectures=amd64',
  ];
  if (spawnSync('apt-get', [...config, 'update'], { encoding: 'utf8', timeout: 20_000 }).status !== 0) return null;
  const policy = spawnSync('apt-cache', [...config, 'policy', ...DOCKER_PACKAGE_NAMES], { encoding: 'utf8', timeout: 20_000 });
  return policy.status === 0 ? policy.stdout : null;
}

describe('the candidate archives of a real apt-cache policy', () => {
  const tokenCases: Array<[string, string, string]> = [
    ['a suite', 'AUDIT_FAKE_SUITE_SECRET', 'main'],
    ['a component', 'noble', 'AUDIT_FAKE_COMPONENT_SECRET'],
  ];
  (aptRuns ? it.each(tokenCases) : it.skip.each(tokenCases))('keep a token in %s out of the facts that are hashed', (_label, suite, component) => {
    const policy = realPolicy(suite, component);
    expect(policy).toContain(`${suite}/${component}`);
    const packages = parseAptPolicy(policy ?? '', 'noble');
    expect(packages.map((pkg) => pkg.name)).toEqual(DOCKER_PACKAGE_NAMES);
    for (const pkg of packages) expect(pkg.candidateSources).toEqual([{ uri: 'file:', official: false }]);
    expect(JSON.stringify(packages)).not.toMatch(/AUDIT_FAKE/);
  });
});
