/**
 * The environment-file reader Compose uses for a project's interpolation
 * environment, restricted to what layer selection needs.
 *
 * Compose does not read these files with a dotenv(1) parser. A quoted value may
 * span lines, a double-quoted value expands backslash escapes and then `${VAR}`
 * references, an unquoted value ends at " #", `export` is optional, and a
 * reference resolves against the process environment first and then the
 * assignments already read (earlier files, and earlier lines of the same file).
 * `COMPOSE_FILE` and `COMPOSE_PATH_SEPARATOR` come out of that reading, so a
 * reader that disagrees picks a different project than the deploy ran.
 *
 * A file whose bytes begin with a UTF-8 BOM is read from after it, the way
 * Compose trims one before parsing. It is the file's first bytes only: a BOM
 * anywhere else is a name character Compose rejects.
 *
 * Anything this reader cannot reproduce exactly (an unterminated quote, a
 * malformed template, a required variable with no value, a name it cannot
 * parse) throws `ComposeEnvFileError`. Callers turn that into an explicit
 * unknown rather than a guessed layer set.
 *
 * Mirrors compose-go dotenv/parser.go, dotenv/env.go, and template/template.go.
 */

/** Resolves a name: a string when set (possibly empty), undefined when unset. */
export type ComposeEnvLookup = (name: string) => string | undefined;

/** The text cannot be read the way Compose reads it. */
export class ComposeEnvFileError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ComposeEnvFileError';
  }
}

/** Compose's chain separator when COMPOSE_PATH_SEPARATOR is unset or empty. */
export const DEFAULT_PATH_SEPARATOR = ':';

/** The byte-order mark Compose drops from the start of an env file's bytes. */
const UTF8_BOM = '\uFEFF';

const DOUBLE_QUOTE = '"';
const SINGLE_QUOTE = "'";
const COMMENT = '#';

/** The escape sequences Compose expands inside a double-quoted value. */
const ESCAPE_SEQUENCE = /(\\(?:[abcfnrtv$"\\]|0\d{0,3}))/g;

/** Go's octal escape: a backslash and exactly three octal digits. */
const OCTAL_ESCAPE = /^\\[0-7]{3}$/;

const GO_ESCAPES: Record<string, string> = {
  a: '\x07',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '"': '"',
  '\\': '\\',
};

/** Go's isSpace: whitespace except the line break, which ends an unquoted value. */
function isEnvSpace(char: string): boolean {
  return char === ' '
    || char === '\t'
    || char === '\v'
    || char === '\f'
    || char === '\r'
    || char === '\x85'
    || char === '\xa0';
}

function isNameStart(char: string): boolean {
  return (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || char === '_';
}

function isNameRest(char: string): boolean {
  return isNameStart(char) || (char >= '0' && char <= '9');
}

/**
 * Go's unicode.IsLetter / unicode.IsNumber, which is the check Compose makes on
 * an assignment name: any Unicode letter or number is a name character, not
 * only the ASCII range. This is the assignment grammar alone. The template
 * grammar above stays ASCII, because a reference Compose resolves is read with
 * its own rules.
 *
 * The character tables are the ones this Node build ships, so a letter added to
 * Unicode after the Compose binary was built is accepted here and refused
 * there. That direction is the safe one: over-accepting a name Compose refuses
 * cannot block a stack Compose runs, and the deploy still fails on Compose's
 * own error.
 */
const NAME_LETTER_OR_NUMBER = /^[\p{L}\p{N}]$/u;

/** The name at `from`, or '' when the text does not start with one. */
function readName(text: string, from: number): string {
  if (from >= text.length || !isNameStart(text[from])) return '';
  let end = from + 1;
  while (end < text.length && isNameRest(text[end])) end++;
  return text.slice(from, end);
}

/**
 * Index of the brace that closes the `${` at `openIndex`, or -1. Nested braces
 * are counted, so a default that itself holds a reference stays inside.
 */
function matchingBrace(text: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Expand the shell escape sequences Compose recognizes in a double-quoted
 * value. `\$` becomes `$$`, which the interpolation pass then reads as a
 * literal dollar. Anything else the sequence regex matched is unquoted with
 * Go's `strconv.UnquoteChar`, as Compose does, and a sequence Go refuses is
 * kept as written.
 *
 * Go accepts `\ooo` only as exactly three octal digits holding a byte, and
 * Compose rewrites a `\0` prefix to `\` before that call. A spelling that fails
 * the unquote comes back in the rewritten form, so `"\012"` is the two-character
 * `\12` rather than a newline and `"\0"` is a single backslash. Turning either
 * into another character would select a different layer set than the deploy ran.
 */
export function expandComposeEnvEscapes(raw: string): string {
  return raw.replace(ESCAPE_SEQUENCE, (match) => {
    if (match === '\\$') return '$$';
    const body = match.startsWith('\\0') ? `\\${match.slice(2)}` : match;
    if (body.length === 2 && body[1] in GO_ESCAPES) return GO_ESCAPES[body[1]];
    if (OCTAL_ESCAPE.test(body)) {
      const value = parseInt(body.slice(1), 8);
      if (value <= 255) return String.fromCharCode(value);
    }
    return body;
  });
}

/**
 * Substitute `${VAR}` and `$VAR` the way Compose does. A name that is unset
 * expands to the empty string (Compose warns and continues); a malformed
 * template or a required variable with no value is an error, because Compose
 * fails the run there and no layer set can be claimed.
 */
export function expandComposeEnvTemplate(text: string, lookup: ComposeEnvLookup): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char !== '$') {
      out += char;
      continue;
    }
    const next = text[i + 1];
    if (next === '$') {
      out += '$';
      i++;
      continue;
    }
    if (next === '{') {
      const close = matchingBrace(text, i + 1);
      if (close === -1) throw new ComposeEnvFileError(`Invalid template: "${text.slice(i)}"`);
      out += substituteBraced(text.slice(i + 2, close), lookup);
      i = close;
      continue;
    }
    const name = next === undefined ? '' : readName(text, i + 1);
    if (name !== '') {
      out += lookup(name) ?? '';
      i += name.length;
      continue;
    }
    // `$` followed by anything else is not a template: Compose leaves it alone.
    out += char;
  }
  return out;
}

/** One `${...}` body: a name, optionally followed by a substitution operator. */
function substituteBraced(inner: string, lookup: ComposeEnvLookup): string {
  const invalid = (): never => {
    throw new ComposeEnvFileError(`Invalid template: "\${${inner}}"`);
  };
  const name = readName(inner, 0);
  if (name === '') invalid();
  const rest = inner.slice(name.length);
  if (rest === '') return lookup(name) ?? '';
  const twoChar = rest.slice(0, 2);
  const oneChar = rest[0];
  if (twoChar === ':-' || twoChar === ':?' || twoChar === ':+') {
    return applyOperator(name, twoChar, rest.slice(2), lookup);
  }
  if (oneChar === '-' || oneChar === '?' || oneChar === '+') {
    return applyOperator(name, oneChar, rest.slice(1), lookup);
  }
  return invalid();
}

function applyOperator(name: string, operator: string, argument: string, lookup: ComposeEnvLookup): string {
  const value = lookup(name);
  const set = value !== undefined;
  const nonEmpty = set && value !== '';
  switch (operator) {
    case ':-':
      return nonEmpty ? (value as string) : expandComposeEnvTemplate(argument, lookup);
    case '-':
      return set ? (value as string) : expandComposeEnvTemplate(argument, lookup);
    case ':+':
      return nonEmpty ? expandComposeEnvTemplate(argument, lookup) : '';
    case '+':
      return set ? expandComposeEnvTemplate(argument, lookup) : '';
    case ':?':
      if (!nonEmpty) {
        const reason = argument === '' ? '' : `: ${expandComposeEnvTemplate(argument, lookup)}`;
        throw new ComposeEnvFileError(`required variable ${name} is missing a value${reason}`);
      }
      return value as string;
    default:
      if (!set) {
        const reason = argument === '' ? '' : `: ${expandComposeEnvTemplate(argument, lookup)}`;
        throw new ComposeEnvFileError(`required variable ${name} is missing a value${reason}`);
      }
      return value as string;
  }
}

/** Skip whitespace, line breaks, and whole comment lines. */
function skipToStatement(text: string, from: number): number {
  let i = from;
  for (;;) {
    while (i < text.length && (text[i] === '\n' || isEnvSpace(text[i]))) i++;
    if (i >= text.length) return i;
    if (text[i] !== COMMENT) return i;
    const lineEnd = text.indexOf('\n', i);
    if (lineEnd === -1) return text.length;
    i = lineEnd + 1;
  }
}

/**
 * Read one file's assignments into `assign`, resolving references through
 * `lookup` (the process environment, then everything already read).
 */
function parseEnvFileText(
  content: string,
  lookup: ComposeEnvLookup,
  assign: (name: string, value: string) => void,
): void {
  let cursor = 0;
  for (;;) {
    cursor = skipToStatement(content, cursor);
    if (cursor >= content.length) return;

    const statementStart = cursor;
    // `statement` is a suffix of `content`, so the offset it loses to the
    // `export` prefix is exactly the difference in length.
    let statement = content.slice(statementStart);
    statement = statement.replace(/^export\s+/, '');
    cursor = content.length - statement.length;

    let keyEnd = -1;
    let inherited = false;
    // Read by code point, as Compose reads by rune: a name may hold a character
    // outside the basic plane, and half of one is not a name character.
    let offset = 0;
    for (const char of statement) {
      const at = offset;
      offset += char.length;
      if (isEnvSpace(char)) continue;
      if (char === '=' || char === ':' || char === '\n') {
        keyEnd = at;
        inherited = char === '\n';
        break;
      }
      if (char === '_' || char === '.' || char === '-' || char === '[' || char === ']') continue;
      if (NAME_LETTER_OR_NUMBER.test(char)) continue;
      throw new ComposeEnvFileError(`unexpected character ${JSON.stringify(char)} in a variable name`);
    }
    if (keyEnd === -1) return;

    const key = statement.slice(0, keyEnd).trimEnd();
    if (key.includes(' ')) throw new ComposeEnvFileError('a variable name cannot contain a space');
    cursor += keyEnd + 1;

    if (inherited) {
      // `export NAME` on its own inherits the name's current value, or sets
      // nothing when it has none.
      const inheritedValue = lookup(key);
      if (inheritedValue !== undefined) assign(key, inheritedValue);
      continue;
    }

    cursor = skipEnvSpaces(content, cursor);
    const quote = content[cursor];
    if (quote === DOUBLE_QUOTE || quote === SINGLE_QUOTE) {
      const { raw, next } = readQuotedValue(content, cursor, quote);
      const value = quote === DOUBLE_QUOTE
        ? expandComposeEnvTemplate(expandComposeEnvEscapes(raw), lookup)
        : raw;
      assign(key, value);
      cursor = next;
      continue;
    }

    const lineEnd = content.indexOf('\n', cursor);
    const end = lineEnd === -1 ? content.length : lineEnd;
    const commentAt = content.slice(cursor, end).indexOf(' #');
    const rawValue = (commentAt === -1 ? content.slice(cursor, end) : content.slice(cursor, cursor + commentAt))
      .replace(/[\s\x85\xa0]+$/, '');
    assign(key, expandComposeEnvTemplate(rawValue, lookup));
    cursor = lineEnd === -1 ? content.length : lineEnd + 1;
  }
}

function skipEnvSpaces(text: string, from: number): number {
  let i = from;
  while (i < text.length && isEnvSpace(text[i])) i++;
  return i;
}

/** The raw text between the quotes, plus the index just past the closing one. */
function readQuotedValue(text: string, openIndex: number, quote: string): { raw: string; next: number } {
  let raw = '';
  let escaped = false;
  for (let i = openIndex + 1; i < text.length; i++) {
    const char = text[i];
    if (char !== quote) {
      if (!escaped && char === '\\') {
        escaped = true;
        continue;
      }
      if (escaped) {
        escaped = false;
        raw += '\\';
      }
      raw += char;
      continue;
    }
    if (escaped) {
      escaped = false;
      raw += char;
      continue;
    }
    return { raw, next: i + 1 };
  }
  throw new ComposeEnvFileError('unterminated quoted value');
}

/**
 * The interpolation environment Compose builds from a stack's env files: the
 * process environment first, then everything read so far, in file order. A name
 * that is set to an empty string is present, which is what separates `${VAR}`
 * and `${VAR:-fallback}`.
 */
export class ComposeEnvFiles {
  private readonly values = new Map<string, string>();

  constructor(private readonly processEnv: ComposeEnvLookup) {}

  lookup(name: string): string | undefined {
    const fromProcess = this.processEnv(name);
    return fromProcess !== undefined ? fromProcess : this.values.get(name);
  }

  /** Read one file's text, adding its assignments. Throws on unreadable syntax. */
  read(content: string): void {
    // Compose reads a file's bytes and drops a leading BOM before parsing it
    // (`bytes.TrimPrefix(data, utf8BOM)`), which is what an editor-saved file
    // starts with. Only the first character is considered, so a BOM elsewhere
    // stays the character Compose rejects in a name.
    const text = content.startsWith(UTF8_BOM) ? content.slice(1) : content;
    parseEnvFileText(text, (name) => this.lookup(name), (name, value) => {
      this.values.set(name, value);
    });
  }
}
