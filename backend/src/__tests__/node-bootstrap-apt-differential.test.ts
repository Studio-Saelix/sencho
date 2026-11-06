import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { parseDockerRepo } from '../services/nodeBootstrap/probes';
import { DEFAULT_SOURCE_LOCATIONS } from './__helpers__/dockerRepoFixtures';

/**
 * The source parser against apt itself. Each case is one source file; the
 * expectation for apt was read from `apt-get --print-uris update` over that
 * file alone (exit 0, or 100 for "The list of sources could not be read"), and
 * the parser must agree. Where the parser is stricter than apt on purpose, the
 * case says so and only the parser is asserted: a stricter answer is a false
 * blocker, never a false verification. The apt half runs only where apt-get
 * can run against an isolated configuration.
 */

type Kind = 'list' | 'sources';
interface Case {
  name: string;
  kind: Kind;
  content: string;
  /** What apt does with the file. */
  apt: 'accepts' | 'rejects';
  /** What the parser does; `rejects` while apt accepts is a documented strictness. */
  parser: 'accepts' | 'rejects';
}

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
  // One-line quoting: invalid.
  { name: 'single-quoted option value', kind: 'list', content: "deb [signed-by='/etc/apt/keyrings/one.gpg /etc/apt/keyrings/two.gpg'] http://archive.ubuntu.com/ubuntu noble main", apt: 'rejects', parser: 'rejects' },
  { name: 'quote opening inside an option value', kind: 'list', content: 'deb [signed-by=/etc/apt/keyrings/one.gpg"two three"] http://archive.ubuntu.com/ubuntu noble main', apt: 'rejects', parser: 'rejects' },
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
  // Strictness on purpose: quoting an option name is valid but unused.
  { name: 'double-quoted option name', kind: 'list', content: 'deb ["signed-by"=/etc/apt/keyrings/one.gpg] http://archive.ubuntu.com/ubuntu noble main', apt: 'accepts', parser: 'rejects' },
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
  // Strictness on purpose: forms apt tolerates that no real file uses.
  { name: 'indented non-comment line before the first stanza', kind: 'sources', content: `  foo\n${DOCKER_STANZA}`, apt: 'accepts', parser: 'rejects' },
  { name: 'empty field name', kind: 'sources', content: `${DOCKER_STANZA}\n:x`, apt: 'accepts', parser: 'rejects' },
];

function parserRejects(testCase: Case): boolean {
  const file = `/etc/apt/sources.list.d/differential.${testCase.kind === 'list' ? 'list' : 'sources'}`;
  const output = `${DEFAULT_SOURCE_LOCATIONS}\nSOURCE_BEGIN=${file}\n${testCase.content}\nSOURCE_END=${file}`;
  return /apt rejects|not a valid apt entry/.test(parseDockerRepo(output, 'noble', 'amd64').problem ?? '');
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

  (aptRuns ? it.each(cases) : it.skip.each(cases))('matches what apt does with $name', (testCase) => {
    expect(aptStatus(testCase.kind, testCase.content)).toBe(testCase.apt === 'accepts' ? 0 : 100);
  });
});
