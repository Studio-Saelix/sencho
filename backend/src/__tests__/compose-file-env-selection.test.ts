/**
 * Unit tests for the COMPOSE_FILE reader that decides whether Compose's own file
 * discovery applies at all. A stack that sets the variable selects layers from
 * something the stack directory alone does not describe, so a wrong answer here
 * makes a rollback restore a project the deploy never ran.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const mockState = { composeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-composeargs-')) };

const { mockGetGitSource, mockGetStackProjectEnvFiles } = vi.hoisted(() => ({
  mockGetGitSource: vi.fn(),
  mockGetStackProjectEnvFiles: vi.fn(),
}));

vi.mock('../services/NodeRegistry', () => ({
  NodeRegistry: {
    getInstance: () => ({
      getComposeDir: () => mockState.composeDir,
      getDefaultNodeId: () => 1,
    }),
  },
}));

vi.mock('../services/DatabaseService', () => ({
  DatabaseService: {
    getInstance: () => ({
      getGitSource: mockGetGitSource,
      getStackProjectEnvFiles: mockGetStackProjectEnvFiles,
    }),
  },
}));

import { composeFileEnvVarSelection, parseDotenv } from '../utils/authoredComposeArgs';

const STACK = 'app';

function writeStackFile(name: string, body: string): string {
  const abs = path.join(mockState.composeDir, STACK, name);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf8');
  return abs;
}

describe('parseDotenv', () => {
  it.each([
    ['a bare value', 'COMPOSE_FILE=compose.yaml:prod.yaml', 'compose.yaml:prod.yaml'],
    ['an exported value', 'export COMPOSE_FILE=compose.yaml', 'compose.yaml'],
    ['surrounding whitespace', 'COMPOSE_FILE =  compose.yaml  ', 'compose.yaml'],
    ['an unquoted inline comment', 'COMPOSE_FILE=compose.yaml:prod.yaml # production', 'compose.yaml:prod.yaml'],
    ['a double-quoted comment', 'COMPOSE_FILE="compose.yaml # not a comment"', 'compose.yaml # not a comment'],
    ['a single-quoted comment', "COMPOSE_FILE='compose.yaml # not a comment'", 'compose.yaml # not a comment'],
    ['an unterminated quote', 'COMPOSE_FILE="compose.yaml', 'compose.yaml'],
    ['a hash without a leading space', 'COMPOSE_FILE=compose.yaml#tag', 'compose.yaml#tag'],
  ])('reads %s', (_label, line, expected) => {
    expect(parseDotenv(line).get('COMPOSE_FILE')).toBe(expected);
  });

  it('reports an unset variable', () => {
    expect(parseDotenv('OTHER=1\n').has('COMPOSE_FILE')).toBe(false);
  });
});

describe('composeFileEnvVarSelection', () => {
  beforeEach(() => {
    fs.rmSync(path.join(mockState.composeDir, STACK), { recursive: true, force: true });
    fs.mkdirSync(path.join(mockState.composeDir, STACK), { recursive: true });
    writeStackFile('compose.yaml', 'services:\n  web:\n    image: nginx\n');
    mockGetGitSource.mockReturnValue(undefined);
    mockGetStackProjectEnvFiles.mockReturnValue([]);
    delete process.env.COMPOSE_FILE;
    delete process.env.COMPOSE_PATH_SEPARATOR;
  });

  afterAll(() => {
    delete process.env.COMPOSE_FILE;
    delete process.env.COMPOSE_PATH_SEPARATOR;
    fs.rmSync(mockState.composeDir, { recursive: true, force: true });
  });

  it('reports absent when no env file sets it', async () => {
    writeStackFile('.env', 'IMAGE=nginx\n');

    expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({ kind: 'absent' });
  });

  it('reports absent when the stack has no env file at all', async () => {
    expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({ kind: 'absent' });
  });

  it('reads the value from the project .env', async () => {
    writeStackFile('.env', 'COMPOSE_FILE=compose.yaml:prod.yaml\n');

    expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({
      kind: 'value',
      value: 'compose.yaml:prod.yaml',
      pathSeparator: ':',
    });
  });

  it('strips an inline comment the way Compose does', async () => {
    writeStackFile('.env', 'COMPOSE_FILE=compose.yaml:prod.yaml # production\n');

    // Compose drops the comment before it reads the chain, so keeping it here
    // would pin a layer path that ends in the comment text.
    expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({
      kind: 'value',
      value: 'compose.yaml:prod.yaml',
      pathSeparator: ':',
    });
  });

  it('prefers the selected --env-file over the project .env', async () => {
    writeStackFile('.env', 'COMPOSE_FILE=from-project-env.yaml\n');
    writeStackFile('select.env', 'COMPOSE_FILE=from-selected-env.yaml\n');
    mockGetStackProjectEnvFiles.mockReturnValue(['select.env']);

    // Compose reads a selected --env-file instead of the project .env, so the
    // project file must not decide the value here.
    expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({
      kind: 'value',
      value: 'from-selected-env.yaml',
      pathSeparator: ':',
    });
  });

  it('ignores the project .env once an env file is selected', async () => {
    writeStackFile('.env', 'COMPOSE_FILE=from-project-env.yaml\n');
    writeStackFile('select.env', 'IMAGE=nginx\n');
    mockGetStackProjectEnvFiles.mockReturnValue(['select.env']);

    // Compose reads the selected file instead of the project .env, so a
    // COMPOSE_FILE only in the project file does not apply and discovery does.
    expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({ kind: 'absent' });
  });

  it('prefers the process environment over every file', async () => {
    writeStackFile('.env', 'COMPOSE_FILE=from-project-env.yaml\n');
    process.env.COMPOSE_FILE = 'from-process-env.yaml';

    expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({
      kind: 'value',
      value: 'from-process-env.yaml',
      pathSeparator: ':',
    });
  });

  it('lets the last selected env file win, as Compose does', async () => {
    writeStackFile('.env', 'COMPOSE_FILE=from-project-env.yaml\n');
    writeStackFile('first.env', 'COMPOSE_FILE=first.yaml\n');
    writeStackFile('second.env', 'COMPOSE_FILE=second.yaml\n');
    mockGetStackProjectEnvFiles.mockReturnValue(['first.env', 'second.env']);

    // Compose applies env files in the order given, so the later file decides.
    // Answering with the first one pins a chain the deployed command never ran.
    expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({
      kind: 'value',
      value: 'second.yaml',
      pathSeparator: ':',
    });
  });

  it('reads the chain separator Compose would use', async () => {
    writeStackFile('.env', 'COMPOSE_PATH_SEPARATOR=;\nCOMPOSE_FILE=first;second\n');
    expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({
      kind: 'value',
      value: 'first;second',
      pathSeparator: ';',
    });

    writeStackFile('.env', 'COMPOSE_FILE=first:second\n');
    expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({
      kind: 'value',
      value: 'first:second',
      pathSeparator: ':',
    });
  });

  it('reads the separator from the process environment too', async () => {
    writeStackFile('.env', 'COMPOSE_FILE=first;second\n');
    process.env.COMPOSE_PATH_SEPARATOR = ';';

    expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({
      kind: 'value',
      value: 'first;second',
      pathSeparator: ';',
    });
  });

  it('reports unknown when a selected env file cannot be read', async () => {
    mockGetStackProjectEnvFiles.mockReturnValue(['missing.env']);

    // Anything unreadable has to be treated as deciding: guessing the chain is
    // what makes a rollback run the wrong project.
    expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({ kind: 'unknown' });
  });
});