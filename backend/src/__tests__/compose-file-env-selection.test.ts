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
      isMeshStackEnabled: () => false,
    }),
  },
}));

import { composeFileEnvVarSelection } from '../utils/authoredComposeArgs';
import { resolveRollbackInventory } from '../services/rollbackInventory';
import {
  ComposeEnvFiles,
  ComposeEnvFileError,
  expandComposeEnvEscapes,
  expandComposeEnvTemplate,
} from '../utils/composeDotenv';

const STACK = 'app';

function writeStackFile(name: string, body: string): string {
  const abs = path.join(mockState.composeDir, STACK, name);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf8');
  return abs;
}

/** The absolute path of a fixture file in the stack directory. */
function stackPath(name: string): string {
  return path.join(mockState.composeDir, STACK, name);
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
    ['a dollar in a name', 'COMPOSE$FILE=compose.yaml\n'],
    ['an at sign in a name', 'COMPOSE@FILE=compose.yaml\n'],
    ['a slash in a name', 'COMPOSE/FILE=compose.yaml\n'],
    ['a plus in a name', 'COMPOSE+FILE=compose.yaml\n'],
    ['a question mark in a name', 'COMPOSE?FILE=compose.yaml\n'],
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

  it.each([
    ['a Latin-1 letter', 'UNICODE_é=value\n', 'UNICODE_é', 'value'],
    ['a Greek letter', 'Ω=value\n', 'Ω', 'value'],
    ['a CJK name', '中文_键=值\n', '中文_键', '值'],
    ['an astral-plane letter', '𝔘=value\n', '𝔘', 'value'],
    ['a non-ASCII digit', 'NAME١=value\n', 'NAME١', 'value'],
  ])('reads an assignment named with %s', (_label, text, name, expected) => {
    // Compose validates a name with Go's unicode.IsLetter/IsNumber over runes,
    // so a name outside ASCII is an ordinary assignment. Refusing it made an
    // unrelated line in .env refuse every Compose action on the stack.
    expect(readEnvFile(text).lookup(name)).toBe(expected);
  });

  it('does not let a Unicode assignment disturb the chain that follows it', () => {
    const files = readEnvFile('UNICODE_é=value\nCOMPOSE_FILE=compose.yaml:prod.yaml\n');

    expect(files.lookup('COMPOSE_FILE')).toBe('compose.yaml:prod.yaml');
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

  // A literal `{` is text. Compose closes the template at the `}` the pattern
  // finds, and an unused default is discarded with the braces it held.
  it.each([
    ['a literal brace in a used default', '${UNSET:-foo{bar}', undefined, 'foo{bar'],
    ['a literal brace and a leftover closer', '${UNSET:-foo{bar}}', undefined, 'foo{bar}'],
    ['text after a literal brace', '${UNSET:-foo{bar}}TAIL', undefined, 'foo{bar}TAIL'],
    ['a literal brace inside the default text', '${UNSET:-foo{bar}tail}', undefined, 'foo{bar}tail'],
    ['an unused default with a literal brace', '${SET:-foo{bar}', 'value', 'value'],
    ['an unused default that holds both closers', '${SET:-foo{bar}}TAIL', 'value', 'valueTAIL'],
    ['an alternate value with a literal brace', '${SET:+foo{bar}', 'value', 'foo{bar'],
    ['an alternate value that holds a closer', '${SET:+foo{bar}}', 'value', 'foo{bar}'],
    ['an unset alternate', '${UNSET:+foo{bar}', undefined, ''],
    ['a hard default with a literal brace', '${UNSET-foo{bar}}', undefined, 'foo{bar}'],
    ['a nested default', '${A:-${B:-deep}}', undefined, 'deep'],
    ['a nested default with a literal brace', '${A:-${B:-foo{bar}}}', undefined, 'foo{bar}'],
    ['a nested default whose closer is consumed', '${A:-${B:-foo{bar}}', undefined, 'foo{bar'],
    ['a cut before a later brace', '${A:-foo}bar}', undefined, 'foobar}'],
  ])('expands %s', (_label, template, setValue, expected) => {
    const lookup = (name: string) => (name === 'SET' ? setValue : undefined);
    expect(expandComposeEnvTemplate(template, lookup)).toBe(expected);
  });

  it.each([
    ['an unclosed default', '${UNSET:-foo{bar'],
    ['an unclosed name', '${BAD'],
    ['an empty template', '${}'],
    ['an empty nested template', '${A:-${}}'],
  ])('still refuses %s', (_label, template) => {
    expect(() => expandComposeEnvTemplate(template, () => undefined)).toThrow(ComposeEnvFileError);
  });

  it('reads a file that starts with a UTF-8 BOM, as Compose does', () => {
    // Compose drops a leading BOM from the file's bytes before parsing, so an
    // editor that saves one must not turn a valid stack into an unknown layer
    // selection.
    const files = readEnvFile('\uFEFFCOMPOSE_FILE=compose.yaml:prod.yaml\n');

    expect(files.lookup('COMPOSE_FILE')).toBe('compose.yaml:prod.yaml');
  });

  it('keeps a BOM that is not the first character an error, as Compose does', () => {
    // Only the file's first bytes are trimmed, so a BOM further in is a name
    // character Compose rejects rather than something to swallow silently.
    expect(() => readEnvFile('A=1\n\uFEFFB=2\n')).toThrow(ComposeEnvFileError);
  });
});

describe('expandComposeEnvEscapes', () => {
  // Compose unquotes each match with Go's strconv.UnquoteChar: `\ooo` is exactly
  // three octal digits holding a byte, and a `\0` prefix is rewritten to `\`
  // before that call. A spelling Go refuses comes back in the rewritten form,
  // which is what the deploy's own layer selection used.
  it.each([
    ['a valid byte octal', '\\0123', 'S'],
    ['a three-digit octal for a control byte', '\\0000', '\x00'],
    ['an incomplete octal', '\\012', '\\12'],
    ['an incomplete octal with one digit', '\\01', '\\1'],
    ['a bare octal prefix', '\\0', '\\'],
    ['an octal prefix with two digits', '\\00', '\\0'],
    ['an octal prefix with a non-octal digit', '\\089', '\\89'],
    ['an out-of-range octal', '\\0400', '\\400'],
    ['an octal without the prefix', '\\123', '\\123'],
    ['an octal above the byte range', '\\400', '\\400'],
    ['a digit that is not octal', '\\8', '\\8'],
    ['a Go escape Compose does not list', '\\c', '\\c'],
    ['a hexadecimal escape Go has and Compose does not', '\\x41', '\\x41'],
    ['a Unicode escape Go has and Compose does not', '\\u0041', '\\u0041'],
    ['the Go escapes Compose does list', '\\a\\b\\f\\n\\r\\t\\v', '\x07\b\f\n\r\t\v'],
    ['an escaped backslash', '\\\\', '\\'],
    ['an escaped double quote', '\\"', '"'],
    ['an escaped dollar, which interpolation reads as a literal', '\\$', '$$'],
    ['an escape inside a name', 'a\\0b', 'a\\b'],
    ['a valid escape beside an incomplete one', '\\0123\\012', 'S\\12'],
    ['text with no escape at all', 'compose.yaml', 'compose.yaml'],
  ])('expands %s', (_label, raw, expected) => {
    expect(expandComposeEnvEscapes(raw)).toBe(expected);
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
    delete process.env.COMPOSE_DISABLE_ENV_FILE;
  });

  afterEach(() => {
    delete process.env.COMPOSE_FILE;
    delete process.env.COMPOSE_PATH_SEPARATOR;
    delete process.env.COMPOSE_ENV_FILES;
    delete process.env.COMPOSE_DISABLE_ENV_FILE;
  });

  afterAll(() => {
    fs.rmSync(mockState.composeDir, { recursive: true, force: true });
  });

  it('reads a literal brace in an unrelated assignment without changing the layer set', async () => {
    writeStackFile('.env', 'LABEL=${UNSET:-foo{bar}\n');
    writeStackFile('compose.yaml', 'services:\n  web:\n    image: nginx\n');

    const selection = await composeFileEnvVarSelection(STACK, 1);
    expect(selection.kind).toBe('absent');

    const inventory = await resolveRollbackInventory(1, STACK);
    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.invocation.composeLayers).toEqual(['compose.yaml']);
  });

  it('reports absent when no env file sets it', async () => {
    writeStackFile('.env', 'IMAGE=nginx\n');

    expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({
      kind: 'absent',
      composeEnvFiles: [],
      loadedEnvFiles: [stackPath('.env')],
    });
  });

  it('reports absent when the stack has no env file at all', async () => {
    expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({
      kind: 'absent',
      composeEnvFiles: [],
      loadedEnvFiles: [],
    });
  });

  it('reads the value from the project .env', async () => {
    writeStackFile('.env', 'COMPOSE_FILE=compose.yaml:prod.yaml\n');

    expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({
      kind: 'value',
      value: 'compose.yaml:prod.yaml',
      pathSeparator: ':',
      composeEnvFiles: [],
      loadedEnvFiles: [stackPath('.env')],
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
      loadedEnvFiles: [stackPath('.env')],
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
      loadedEnvFiles: [stackPath('select.env')],
    });
  });

  it('ignores the project .env once an env file is selected', async () => {
    writeStackFile('.env', 'COMPOSE_FILE=from-project-env.yaml\n');
    writeStackFile('select.env', 'IMAGE=nginx\n');
    mockGetStackProjectEnvFiles.mockReturnValue(['select.env']);

    // Compose reads the selected file instead of the project .env, so a
    // COMPOSE_FILE only in the project file does not apply and discovery does.
    expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({
      kind: 'absent',
      composeEnvFiles: [],
      loadedEnvFiles: [stackPath('select.env')],
    });
  });

  it('prefers the process environment over every file', async () => {
    writeStackFile('.env', 'COMPOSE_FILE=from-project-env.yaml\n');
    process.env.COMPOSE_FILE = 'from-process-env.yaml';

    expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({
      kind: 'value',
      value: 'from-process-env.yaml',
      pathSeparator: ':',
      composeEnvFiles: [],
      loadedEnvFiles: [stackPath('.env')],
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
      loadedEnvFiles: [stackPath('first.env'), stackPath('second.env')],
    });
  });

  it('reads the chain separator Compose would use', async () => {
    writeStackFile('.env', 'COMPOSE_PATH_SEPARATOR=;\nCOMPOSE_FILE=first;second\n');
    expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({
      kind: 'value',
      value: 'first;second',
      pathSeparator: ';',
      composeEnvFiles: [],
      loadedEnvFiles: [stackPath('.env')],
    });

    writeStackFile('.env', 'COMPOSE_FILE=first:second\n');
    expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({
      kind: 'value',
      value: 'first:second',
      pathSeparator: ':',
      composeEnvFiles: [],
      loadedEnvFiles: [stackPath('.env')],
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
      loadedEnvFiles: [stackPath('.env')],
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
      loadedEnvFiles: [stackPath('.env')],
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
        loadedEnvFiles: [listed],
      });
    });

    it('lets --env-file win over the listed files', async () => {
      writeStackFile('select.env', 'COMPOSE_FILE=from-listed.yaml\n');
      const explicit = writeStackFile('explicit.env', 'IMAGE=nginx\n');
      process.env.COMPOSE_ENV_FILES = 'select.env';
      mockGetStackProjectEnvFiles.mockReturnValue(['explicit.env']);

      // Compose ignores COMPOSE_ENV_FILES once a file is selected explicitly.
      expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({
        kind: 'absent',
        composeEnvFiles: [],
        loadedEnvFiles: [explicit],
      });
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
        loadedEnvFiles: [stackPath('.env')],
      });
    });

    it('treats an empty value as unset', async () => {
      writeStackFile('.env', 'COMPOSE_FILE=from-project-env.yaml\n');
      process.env.COMPOSE_ENV_FILES = '';

      expect(await composeFileEnvVarSelection(STACK, 1)).toMatchObject({ value: 'from-project-env.yaml' });
    });

    it('names every listed file when the first cannot be read', async () => {
      const outside = path.join(mockState.composeDir, '..', 'outside.env');
      fs.writeFileSync(outside, 'IMAGE=nginx\n', 'utf8');
      const inside = writeStackFile('select.env', 'COMPOSE_FILE=compose.yaml:prod.yaml\n');
      process.env.COMPOSE_ENV_FILES = `${outside},select.env`;

      // The reader stops at the file it cannot read, but the run was given both,
      // so both are named: a caller recording what a capture does not hold must
      // not see only the first.
      const selection = await composeFileEnvVarSelection(STACK, 1);
      expect(selection).toMatchObject({ kind: 'unknown' });
      expect(selection.loadedEnvFiles).toEqual([path.resolve(outside), inside]);
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
      // folder, and the file is still reported as one the run loads: a capture
      // that cannot hold it has to say so instead of claiming full coverage.
      const selection = await composeFileEnvVarSelection(STACK, 1);
      expect(selection).toMatchObject({ kind: 'unknown' });
      expect(selection.kind === 'unknown' ? selection.reason : '').toContain(outside);
      expect(selection.loadedEnvFiles).toEqual([path.resolve(outside)]);
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

  describe('COMPOSE_DISABLE_ENV_FILE', () => {
    it.each(['1', 't', 'T', 'TRUE', 'true', 'True'])(
      'ignores the project .env when it is set to %s',
      async (value) => {
        writeStackFile('.env', 'COMPOSE_FILE=compose.yaml:prod.yaml\n');
        process.env.COMPOSE_DISABLE_ENV_FILE = value;

        // Compose parses the variable with strconv.ParseBool and skips the
        // default env file entirely, so a chain only that file holds must not
        // decide which layers the run loads.
        expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({
          kind: 'absent',
          composeEnvFiles: [],
          loadedEnvFiles: [],
        });
      },
    );

    it.each(['0', 'f', 'F', 'FALSE', 'false', 'False'])(
      'still reads the project .env when it is set to %s',
      async (value) => {
        writeStackFile('.env', 'COMPOSE_FILE=compose.yaml:prod.yaml\n');
        process.env.COMPOSE_DISABLE_ENV_FILE = value;

        expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({
          kind: 'value',
          value: 'compose.yaml:prod.yaml',
          pathSeparator: ':',
          composeEnvFiles: [],
          loadedEnvFiles: [path.join(mockState.composeDir, STACK, '.env')],
        });
      },
    );

    it.each(['', 'yes', 'no', 'banana', '2'])(
      'reports unknown when it is set to %s, which Compose refuses to parse',
      async (value) => {
        writeStackFile('.env', 'COMPOSE_FILE=compose.yaml:prod.yaml\n');
        process.env.COMPOSE_DISABLE_ENV_FILE = value;

        // strconv.ParseBool rejects anything outside its truth table and the
        // run fails there, so there is no layer set to claim. The reason names
        // the variable so the operator can fix the environment.
        const selection = await composeFileEnvVarSelection(STACK, 1);
        expect(selection).toMatchObject({ kind: 'unknown' });
        expect(selection.kind === 'unknown' ? selection.reason : '').toContain('COMPOSE_DISABLE_ENV_FILE');
        expect(selection.kind === 'unknown' ? selection.reason : '').toContain(JSON.stringify(value));
      },
    );

    it('does not read a malformed project .env it disables', async () => {
      // The file would be an unknown if it were read, and Compose never reads
      // it, so a stack that deploys must not be refused here.
      writeStackFile('.env', 'COMPOSE_FILE=${1BAD}\n');
      process.env.COMPOSE_DISABLE_ENV_FILE = 'true';

      expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({
        kind: 'absent',
        composeEnvFiles: [],
        loadedEnvFiles: [],
      });
    });

    it('leaves an explicitly selected --env-file alone', async () => {
      writeStackFile('select.env', 'COMPOSE_FILE=compose.yaml:prod.yaml\n');
      mockGetStackProjectEnvFiles.mockReturnValue(['select.env']);
      process.env.COMPOSE_DISABLE_ENV_FILE = 'true';

      // Compose consults the variable only when nothing selected a file, so a
      // configured project env file still decides the chain.
      expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({
        kind: 'value',
        value: 'compose.yaml:prod.yaml',
        pathSeparator: ':',
        composeEnvFiles: [],
        loadedEnvFiles: [path.join(mockState.composeDir, STACK, 'select.env')],
      });
    });

    it('leaves a COMPOSE_ENV_FILES list alone', async () => {
      writeStackFile('select.env', 'COMPOSE_FILE=compose.yaml:prod.yaml\n');
      process.env.COMPOSE_ENV_FILES = 'select.env';
      process.env.COMPOSE_DISABLE_ENV_FILE = 'true';

      expect((await composeFileEnvVarSelection(STACK, 1))).toMatchObject({
        kind: 'value',
        value: 'compose.yaml:prod.yaml',
      });
    });

    it('still honours COMPOSE_FILE from the process environment', async () => {
      writeStackFile('.env', 'IMAGE=nginx\n');
      process.env.COMPOSE_FILE = 'from-process-env.yaml';
      process.env.COMPOSE_DISABLE_ENV_FILE = 'true';

      // Disabling the default env file does not disable the variable Compose
      // reads from its own environment.
      expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({
        kind: 'value',
        value: 'from-process-env.yaml',
        pathSeparator: ':',
        composeEnvFiles: [],
        loadedEnvFiles: [],
      });
    });
  });

  describe('the env files a run loads', () => {
    it('names the project .env it read', async () => {
      writeStackFile('.env', 'IMAGE=nginx\n');

      expect((await composeFileEnvVarSelection(STACK, 1))).toMatchObject({
        loadedEnvFiles: [path.join(mockState.composeDir, STACK, '.env')],
      });
    });

    it('names every configured env file in order', async () => {
      const first = writeStackFile('first.env', 'IMAGE=nginx\n');
      const second = writeStackFile('second.env', 'IMAGE=nginx\n');
      mockGetStackProjectEnvFiles.mockReturnValue(['first.env', 'second.env']);

      expect((await composeFileEnvVarSelection(STACK, 1))).toMatchObject({
        loadedEnvFiles: [first, second],
      });
    });

    it('names every listed env file in order', async () => {
      const first = writeStackFile('first.env', 'IMAGE=nginx\n');
      const second = writeStackFile('second.env', 'IMAGE=nginx\n');
      process.env.COMPOSE_ENV_FILES = 'first.env,second.env';

      expect((await composeFileEnvVarSelection(STACK, 1))).toMatchObject({
        loadedEnvFiles: [first, second],
      });
    });

    it('names a file it read but could not reproduce, so coverage stays honest', async () => {
      const good = writeStackFile('good.env', 'IMAGE=nginx\n');
      const broken = writeStackFile('broken.env', 'COMPOSE_FILE="compose.yaml\n');
      process.env.COMPOSE_ENV_FILES = 'good.env,broken.env';

      // Compose reads both files; only this reader is unable to reproduce one.
      // A caller recording what a capture does not hold has to name it instead
      // of certifying coverage it does not have.
      const selection = await composeFileEnvVarSelection(STACK, 1);
      expect(selection).toMatchObject({ kind: 'unknown' });
      expect(selection.loadedEnvFiles).toEqual([good, broken]);
    });
  });

  describe('a relocated compose root', () => {
    // The compose folder itself is a link, which Sencho supports end to end: the
    // deploy reads a selected env file by its real path while the compose-root
    // containment rule cannot check a path outside the lexical root.
    let previousRoot: string;
    let linkRoot: string;
    let realRoot: string;

    beforeEach(() => {
      previousRoot = mockState.composeDir;
      realRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-composeargs-real-')));
      linkRoot = path.join(previousRoot, 'linked-compose');
      fs.symlinkSync(realRoot, linkRoot, 'dir');
      mockState.composeDir = linkRoot;
      fs.mkdirSync(path.join(realRoot, STACK), { recursive: true });
      fs.writeFileSync(path.join(realRoot, STACK, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n', 'utf8');
      fs.writeFileSync(path.join(realRoot, STACK, 'select.env'), 'COMPOSE_FILE=compose.yaml\n', 'utf8');
    });

    afterEach(() => {
      mockState.composeDir = previousRoot;
      fs.rmSync(linkRoot, { force: true });
      fs.rmSync(realRoot, { recursive: true, force: true });
    });

    it('names a configured env file it cannot read at the path the deploy uses', async () => {
      mockGetStackProjectEnvFiles.mockReturnValue(['select.env']);

      const selection = await composeFileEnvVarSelection(STACK, 1);

      // The deploy passes this file to Compose, which reads it, so the capture
      // has to name it as an input it does not hold rather than call the stack
      // fully covered.
      const realEnvPath = path.join(realRoot, STACK, 'select.env');
      expect(selection).toMatchObject({ kind: 'unknown' });
      expect(selection.loadedEnvFiles).toEqual([realEnvPath]);
      expect(selection.kind === 'unknown' ? selection.reason : '').toContain('select.env');
    });

    it('reads the project .env through the link, as Compose does', async () => {
      fs.writeFileSync(path.join(realRoot, STACK, '.env'), 'COMPOSE_FILE=compose.yaml\n', 'utf8');

      expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({
        kind: 'value',
        value: 'compose.yaml',
        pathSeparator: ':',
        composeEnvFiles: [],
        loadedEnvFiles: [path.join(linkRoot, STACK, '.env')],
      });
    });
  });

  describe('a UTF-8 BOM', () => {
    it('reads a BOM-prefixed project .env the way Compose does', async () => {
      writeStackFile('.env', '\uFEFFCOMPOSE_FILE=compose.yaml:prod.yaml\n');

      expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({
        kind: 'value',
        value: 'compose.yaml:prod.yaml',
        pathSeparator: ':',
        composeEnvFiles: [],
        loadedEnvFiles: [path.join(mockState.composeDir, STACK, '.env')],
      });
    });

    it('reports absent for a BOM-prefixed project .env with no COMPOSE_FILE', async () => {
      // A BOM alone must not turn an ordinary stack into a coverage refusal.
      writeStackFile('.env', '\uFEFFNORMAL=value\n');

      expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({
        kind: 'absent',
        composeEnvFiles: [],
        loadedEnvFiles: [path.join(mockState.composeDir, STACK, '.env')],
      });
    });

    it('reads a BOM-prefixed COMPOSE_ENV_FILES file', async () => {
      const listed = writeStackFile('select.env', '\uFEFFCOMPOSE_FILE=compose.yaml:prod.yaml\n');
      process.env.COMPOSE_ENV_FILES = 'select.env';

      expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({
        kind: 'value',
        value: 'compose.yaml:prod.yaml',
        pathSeparator: ':',
        composeEnvFiles: [listed],
        loadedEnvFiles: [listed],
      });
    });

    it('reads a BOM-prefixed configured env file', async () => {
      const selected = writeStackFile('select.env', '\uFEFFCOMPOSE_FILE=compose.yaml:prod.yaml\n');
      mockGetStackProjectEnvFiles.mockReturnValue(['select.env']);

      expect(await composeFileEnvVarSelection(STACK, 1)).toEqual({
        kind: 'value',
        value: 'compose.yaml:prod.yaml',
        pathSeparator: ':',
        composeEnvFiles: [],
        loadedEnvFiles: [selected],
      });
    });
  });
});
