/**
 * Unit tests for the COMPOSE_FILE reader that decides whether Compose's own file
 * discovery applies at all. A stack that sets the variable selects layers from
 * something the stack directory alone does not describe, so a wrong answer here
 * makes a rollback restore a project the deploy never ran. The reader has to
 * reproduce Compose's own env-file semantics (quoting, escapes, interpolation,
 * file order, process precedence) or say that it cannot.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
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

import { composeFileEnvVarSelection } from '../utils/authoredComposeArgs';
import { ComposeEnvFiles, ComposeEnvFileError, expandComposeEnvTemplate } from '../utils/composeDotenv';

const STACK = 'app';

function writeStackFile(name: string, body: string): string {
  const abs = path.join(mockState.composeDir, STACK, name);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf8');
  return abs;
}

/** Read one env file's text the way Compose would, with `env` as the process environment. */
function readEnvFile(text: string, env: Record<string, string> = {}): ComposeEnvFiles {
  const files = new ComposeEnvFiles((name) => env[name]);
  files.read(text);
  return files;
}

describe('ComposeEnvFiles', () => {
  it.each([
    ['a bare value', 'COMPOSE_FILE=compose.yaml:prod.yaml\n', 'compose.yaml:prod.yaml'],
    ['an exported value', 'export COMPOSE_FILE=compose.yaml\n', 'compose.yaml'],
    ['surrounding whitespace', 'COMPOSE_FILE =  compose.yaml  \n', 'compose.yaml'],
    ['a yaml-style colon', 'COMPOSE_FILE: compose.yaml\n', 'compose.yaml'],
    ['an unquoted inline comment', 'COMPOSE_FILE=compose.yaml:prod.yaml # production\n', 'compose.yaml:prod.yaml'],
    ['a double-quoted comment', 'COMPOSE_FILE="compose.yaml # not a comment"\n', 'compose.yaml # not a comment'],
    ['a single-quoted comment', "COMPOSE_FILE='compose.yaml # not a comment'\n", 'compose.yaml # not a comment'],
    ['a hash without a leading space', 'COMPOSE_FILE=compose.yaml#tag\n', 'compose.yaml#tag'],
    ['an empty value', 'COMPOSE_FILE=\n', ''],
    ['a comment line before the value', '# COMPOSE_FILE=nope.yaml\nCOMPOSE_FILE=compose.yaml\n', 'compose.yaml'],
  ])('reads %s', (_label, text, expected) => {
    expect(readEnvFile(text).lookup('COMPOSE_FILE')).toBe(expected);
  });

  it('reads a quoted value continued on the next line', () => {
    // The value holds a real newline, so the first layer's filename ends with
    // one. Truncating it to the first physical line would pin a different file.
    expect(readEnvFile('COMPOSE_FILE="compose.yaml\n:prod.yaml"\n').lookup('COMPOSE_FILE')).toBe(
      'compose.yaml\n:prod.yaml',
    );
  });

  it.each([
    ['an unterminated double quote', 'COMPOSE_FILE="compose.yaml\n'],
    ['an unterminated single quote', "COMPOSE_FILE='compose.yaml\n"],
    ['a space inside a name', 'COMPOSE FILE=compose.yaml\n'],
    ['a character Compose does not allow in a name', 'COMPOSE%FILE=compose.yaml\n'],
    ['an invalid template', 'COMPOSE_FILE=${1BAD}\n'],
    ['an unclosed template', 'COMPOSE_FILE=${BAD\n'],
    ['a name followed by junk in braces', 'COMPOSE_FILE=${A.B}\n'],
    ['a required variable with no value', 'COMPOSE_FILE=${MISSING:?need it}\n'],
  ])('refuses %s', (_label, text) => {
    expect(() => readEnvFile(text)).toThrow(ComposeEnvFileError);
  });

  it('reads a name that starts with a digit, which no template can reference', () => {
    const files = readEnvFile('1KEY=value\n');

    expect(files.lookup('1KEY')).toBe('value');
  });

  it('reports an unset variable', () => {
    expect(readEnvFile('OTHER=1\n').lookup('COMPOSE_FILE')).toBeUndefined();
  });

  it.each([
    ['a named reference', 'BASE=compose.yaml\nCOMPOSE_FILE=$BASE:prod.yaml\n', 'compose.yaml:prod.yaml'],
    ['a braced reference', 'BASE=compose.yaml\nCOMPOSE_FILE=${BASE}:prod.yaml\n', 'compose.yaml:prod.yaml'],
    ['a soft default with the name unset', 'COMPOSE_FILE=${BASE:-compose.yaml}:prod.yaml\n', 'compose.yaml:prod.yaml'],
    ['a soft default with the name empty', 'BASE=\nCOMPOSE_FILE=${BASE:-compose.yaml}\n', 'compose.yaml'],
    ['a hard default with the name empty', 'BASE=\nCOMPOSE_FILE=${BASE-compose.yaml}\n', ''],
    ['an alternative with the name set', 'BASE=x\nCOMPOSE_FILE=${BASE:+compose.yaml}\n', 'compose.yaml'],
    ['an escaped dollar', 'COMPOSE_FILE=$$BASE.yaml\n', '$BASE.yaml'],
    ['a reference to a later assignment', 'COMPOSE_FILE=${BASE:-fallback}\nBASE=compose.yaml\n', 'fallback'],
  ])('expands %s', (_label, text, expected) => {
    expect(readEnvFile(text).lookup('COMPOSE_FILE')).toBe(expected);
  });

  it('expands the process environment over the file, as Compose does', () => {
    const files = readEnvFile('BASE=from-file\nCOMPOSE_FILE=$BASE\n', { BASE: 'from-process' });

    expect(files.lookup('COMPOSE_FILE')).toBe('from-process');
    // The process value also wins for a name the file sets itself.
    expect(files.lookup('BASE')).toBe('from-process');
  });

  it('lets a later file win and stay visible to the next one', () => {
    const files = new ComposeEnvFiles(() => undefined);
    files.read('BASE=first\nCOMPOSE_FILE=$BASE\n');
    files.read('BASE=second\n');
    files.read('COMPOSE_FILE=${BASE}-chain\n');

    expect(files.lookup('COMPOSE_FILE')).toBe('second-chain');
  });

  it('keeps a single-quoted value verbatim', () => {
    expect(readEnvFile("COMPOSE_FILE='$BASE'\n").lookup('COMPOSE_FILE')).toBe('$BASE');
  });

  it.each([
    ['a newline escape', 'COMPOSE_FILE="a\\nb"\n', 'a\nb'],
    ['a tab escape', 'COMPOSE_FILE="a\\tb"\n', 'a\tb'],
    ['an escaped quote', 'COMPOSE_FILE="a\\"b"\n', 'a"b'],
    ['an escaped backslash', 'COMPOSE_FILE="a\\\\b"\n', 'a\\b'],
    ['an escaped dollar', 'COMPOSE_FILE="\\$BASE"\n', '$BASE'],
    ['an octal escape', 'COMPOSE_FILE="\\0123"\n', 'S'],
    ['a sequence Go does not accept', 'COMPOSE_FILE="a\\cb"\n', 'a\\cb'],
  ])('expands %s inside double quotes', (_label, text, expected) => {
    expect(readEnvFile(text).lookup('COMPOSE_FILE')).toBe(expected);
  });

  it('keeps an escape sequence verbatim in an unquoted value', () => {
    expect(readEnvFile('COMPOSE_FILE=a\\nb\n').lookup('COMPOSE_FILE')).toBe('a\\nb');
  });

  it('inherits an exported name from the environment', () => {
    expect(readEnvFile('export BASE\nCOMPOSE_FILE=$BASE\n', { BASE: 'compose.yaml' }).lookup('COMPOSE_FILE'))
      .toBe('compose.yaml');
  });

  it('expands a nested default', () => {
    expect(expandComposeEnvTemplate('${A:-${B:-deep}}', () => undefined)).toBe('deep');
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
    delete process.env.COMPOSE_ENV_FILES;
  });

  afterEach(() => {
    delete process.env.COMPOSE_FILE;
    delete process.env.COMPOSE_PATH_SEPARATOR;
    delete process.env.COMPOSE_ENV_FILES;
  });

  afterAll(() => {
    fs.rmSync(mockState.composeDir, { recursive: true, force: true });
  });

  it('reports absent when no env file sets it', async () => {
    writeStackFile('.env', 'IMAGE=nginx\n');

    expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({ kind: 'absent', composeEnvFiles: [] });
  });

  it('reports absent when the stack has no env file at all', async () => {
    expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({ kind: 'absent', composeEnvFiles: [] });
  });

  it('reads the value from the project .env', async () => {
    writeStackFile('.env', 'COMPOSE_FILE=compose.yaml:prod.yaml\n');

    expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({
      kind: 'value',
      value: 'compose.yaml:prod.yaml',
      pathSeparator: ':',
      composeEnvFiles: [],
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
      composeEnvFiles: [],
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
      composeEnvFiles: [],
    });
  });

  it('ignores the project .env once an env file is selected', async () => {
    writeStackFile('.env', 'COMPOSE_FILE=from-project-env.yaml\n');
    writeStackFile('select.env', 'IMAGE=nginx\n');
    mockGetStackProjectEnvFiles.mockReturnValue(['select.env']);

    // Compose reads the selected file instead of the project .env, so a
    // COMPOSE_FILE only in the project file does not apply and discovery does.
    expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({ kind: 'absent', composeEnvFiles: [] });
  });

  it('prefers the process environment over every file', async () => {
    writeStackFile('.env', 'COMPOSE_FILE=from-project-env.yaml\n');
    process.env.COMPOSE_FILE = 'from-process-env.yaml';

    expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({
      kind: 'value',
      value: 'from-process-env.yaml',
      pathSeparator: ':',
      composeEnvFiles: [],
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
      composeEnvFiles: [],
    });
  });

  it('reads the chain separator Compose would use', async () => {
    writeStackFile('.env', 'COMPOSE_PATH_SEPARATOR=;\nCOMPOSE_FILE=first;second\n');
    expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({
      kind: 'value',
      value: 'first;second',
      pathSeparator: ';',
      composeEnvFiles: [],
    });

    writeStackFile('.env', 'COMPOSE_FILE=first:second\n');
    expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({
      kind: 'value',
      value: 'first:second',
      pathSeparator: ':',
      composeEnvFiles: [],
    });
  });

  it('reads the separator from the process environment too', async () => {
    writeStackFile('.env', 'COMPOSE_FILE=first;second\n');
    process.env.COMPOSE_PATH_SEPARATOR = ';';

    expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({
      kind: 'value',
      value: 'first;second',
      pathSeparator: ';',
      composeEnvFiles: [],
    });
  });

  it('falls back to the default separator when the variable is set but empty', async () => {
    writeStackFile('.env', 'COMPOSE_PATH_SEPARATOR=;\nCOMPOSE_FILE=first;second\n');
    // An empty process value is set, so it decides and the default applies, as
    // it does in Compose.
    process.env.COMPOSE_PATH_SEPARATOR = '';

    expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({
      kind: 'value',
      value: 'first;second',
      pathSeparator: ':',
      composeEnvFiles: [],
    });
  });

  it('reports unknown when a selected env file cannot be read', async () => {
    mockGetStackProjectEnvFiles.mockReturnValue(['missing.env']);

    // Anything unreadable has to be treated as deciding: guessing the chain is
    // what makes a rollback run the wrong project.
    expect(await composeFileEnvVarSelection(STACK, 1)).toMatchObject({ kind: 'unknown' });
  });

  it('reports unknown when a selected env file cannot be parsed', async () => {
    writeStackFile('select.env', 'COMPOSE_FILE="compose.yaml\n');
    mockGetStackProjectEnvFiles.mockReturnValue(['select.env']);

    expect(await composeFileEnvVarSelection(STACK, 1)).toMatchObject({ kind: 'unknown' });
  });

  it('reports unknown when the project .env cannot be parsed', async () => {
    writeStackFile('.env', 'COMPOSE_FILE=${1BAD}\n');

    expect(await composeFileEnvVarSelection(STACK, 1)).toMatchObject({ kind: 'unknown' });
  });

  describe('COMPOSE_ENV_FILES', () => {
    it('reads the value from a listed file and ignores the project .env', async () => {
      writeStackFile('.env', 'COMPOSE_FILE=from-project-env.yaml\n');
      const listed = writeStackFile('select.env', 'COMPOSE_FILE=compose.yaml:prod.yaml\n');
      process.env.COMPOSE_ENV_FILES = 'select.env';

      expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({
        kind: 'value',
        value: 'compose.yaml:prod.yaml',
        pathSeparator: ':',
        composeEnvFiles: [listed],
      });
    });

    it('lets --env-file win over the listed files', async () => {
      writeStackFile('select.env', 'COMPOSE_FILE=from-listed.yaml\n');
      writeStackFile('explicit.env', 'IMAGE=nginx\n');
      process.env.COMPOSE_ENV_FILES = 'select.env';
      mockGetStackProjectEnvFiles.mockReturnValue(['explicit.env']);

      // Compose ignores COMPOSE_ENV_FILES once a file is selected explicitly.
      expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({ kind: 'absent', composeEnvFiles: [] });
    });

    it('applies the listed files in order', async () => {
      writeStackFile('first.env', 'COMPOSE_FILE=first.yaml\n');
      writeStackFile('second.env', 'COMPOSE_FILE=second.yaml\n');
      process.env.COMPOSE_ENV_FILES = 'first.env,second.env';

      expect((await composeFileEnvVarSelection(STACK, 1))).toMatchObject({ kind: 'value', value: 'second.yaml' });
    });

    it('skips empty entries and falls back to the project .env when none is left', async () => {
      writeStackFile('.env', 'COMPOSE_FILE=from-project-env.yaml\n');
      process.env.COMPOSE_ENV_FILES = ',';

      expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({
        kind: 'value',
        value: 'from-project-env.yaml',
        pathSeparator: ':',
        composeEnvFiles: [],
      });
    });

    it('treats an empty value as unset', async () => {
      writeStackFile('.env', 'COMPOSE_FILE=from-project-env.yaml\n');
      process.env.COMPOSE_ENV_FILES = '';

      expect(await composeFileEnvVarSelection(STACK, 1)).toMatchObject({ value: 'from-project-env.yaml' });
    });

    it('reports unknown when a listed file is missing, as Compose refuses to run', async () => {
      process.env.COMPOSE_ENV_FILES = 'missing.env';

      const selection = await composeFileEnvVarSelection(STACK, 1);
      expect(selection).toMatchObject({ kind: 'unknown' });
      // The reason names the file, so the operator can act on the refusal.
      expect(selection.kind === 'unknown' ? selection.reason : '').toContain('missing.env');
    });

    it('refuses a listed file outside the compose directory, naming it', async () => {
      const outside = path.join(mockState.composeDir, '..', 'outside.env');
      fs.writeFileSync(outside, 'COMPOSE_FILE=compose.yaml:prod.yaml\n', 'utf8');
      process.env.COMPOSE_ENV_FILES = outside;

      // Compose reads that file, and this reader cannot under the compose-root
      // containment rule, so the selection is unknown rather than guessed. The
      // reason names the path, so the operator can move it into the compose
      // folder.
      const selection = await composeFileEnvVarSelection(STACK, 1);
      expect(selection).toMatchObject({ kind: 'unknown' });
      expect(selection.kind === 'unknown' ? selection.reason : '').toContain(outside);
    });

    it('reports unknown with the file named when a listed file cannot be parsed', async () => {
      writeStackFile('broken.env', 'COMPOSE_FILE="compose.yaml\n');
      process.env.COMPOSE_ENV_FILES = 'broken.env';

      const selection = await composeFileEnvVarSelection(STACK, 1);
      expect(selection).toMatchObject({ kind: 'unknown' });
      expect(selection.kind === 'unknown' ? selection.reason : '').toContain('broken.env');
    });

    it('reads a multiline quoted value exactly', async () => {
      writeStackFile('select.env', 'COMPOSE_FILE="compose.yaml\n:prod.yaml"\n');
      process.env.COMPOSE_ENV_FILES = 'select.env';

      expect((await composeFileEnvVarSelection(STACK, 1))).toMatchObject({
        kind: 'value',
        value: 'compose.yaml\n:prod.yaml',
      });
    });

    it('expands a reference to an earlier assignment', async () => {
      writeStackFile('select.env', 'BASE_FILE=compose.yaml\nCOMPOSE_FILE=${BASE_FILE}:prod.yaml\n');
      process.env.COMPOSE_ENV_FILES = 'select.env';

      expect((await composeFileEnvVarSelection(STACK, 1))).toMatchObject({
        kind: 'value',
        value: 'compose.yaml:prod.yaml',
      });
    });

    it('leaves an empty entry when a referenced variable has no value, as Compose does', async () => {
      writeStackFile('select.env', 'COMPOSE_FILE=compose.yaml:${MISSING_LAYER}\n');
      process.env.COMPOSE_ENV_FILES = 'select.env';

      // Compose warns and substitutes a blank string, then refuses the chain.
      // The reader reports what Compose read, and the inventory turns the empty
      // entry into a refusal rather than pinning a chain Compose never loaded.
      expect((await composeFileEnvVarSelection(STACK, 1))).toMatchObject({
        kind: 'value',
        value: 'compose.yaml:',
      });
    });

    it('keeps a literal dollar from a doubled escape', async () => {
      writeStackFile('select.env', 'COMPOSE_FILE=compose.yaml:$$prod.yaml\n');
      process.env.COMPOSE_ENV_FILES = 'select.env';

      expect((await composeFileEnvVarSelection(STACK, 1))).toMatchObject({
        kind: 'value',
        value: 'compose.yaml:$prod.yaml',
      });
    });
  });
});
