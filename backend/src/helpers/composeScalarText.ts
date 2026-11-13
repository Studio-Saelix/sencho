/**
 * The text Docker Compose gives a plain (unquoted) YAML scalar once it is an
 * environment value. Compose reads YAML with a Go decoder that resolves a plain
 * scalar to a boolean, an integer, a float, or a timestamp, and then writes
 * that value back out as text, so `true`, `010`, `1e-7`, and `2020-01-01`
 * become `true`, `8`, `1e-07`, and `2020-01-01 00:00:00 +0000 UTC`. A reader
 * that kept the characters as written would size a value Compose never builds.
 *
 * The rules below follow what Compose 5.7.0 produced for a table of probes
 * (see the unit tests). A quoted scalar without an explicit tag is a string and
 * never comes here; `.inf`, `-.inf`, and `.nan` follow Go's float names, since
 * Compose refuses to print them as JSON.
 *
 * A scalar with an explicit `!!int`, `!!float`, `!!bool`, or `!!timestamp` tag
 * resolves the same way, quoted or not, but only to that kind: `!!float` turns
 * an integer into a float (not one above the largest int64), and a text the
 * kind cannot hold is a file Compose rejects ({@link composeTaggedScalarText}).
 */

const BOOLEAN_TRUE = new Set(['true', 'True', 'TRUE']);
const BOOLEAN_FALSE = new Set(['false', 'False', 'FALSE']);
const POSITIVE_INFINITY = new Set(['.inf', '.Inf', '.INF', '+.inf', '+.Inf', '+.INF']);
const NEGATIVE_INFINITY = new Set(['-.inf', '-.Inf', '-.INF']);
const NOT_A_NUMBER = new Set(['.nan', '.NaN', '.NAN']);

/** A decimal, hex (`0x`), binary (`0b`), or octal (`0o` or a leading `0`) integer, once `_` is dropped. */
const INTEGER = /^([+-]?)(?:0[xX]([0-9a-fA-F]+)|0[bB]([01]+)|0[oO]([0-7]+)|0([0-7]*)|([1-9][0-9]*))$/;
const FLOAT = /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/;
const TIMESTAMP =
  /^(\d{4})-(\d{1,2})-(\d{1,2})(?:(?:[Tt](\d{1,2}):(\d{1,2}):(\d{1,2})(?:[.,](\d+))?(Z|[+-]\d{2}:\d{2}))|(?: +(\d{1,2}):(\d{1,2}):(\d{1,2})(?:[.,](\d+))?))?$/;

const MAX_INT64 = (1n << 63n) - 1n;
const MIN_INT64 = -(1n << 63n);
const MAX_UINT64 = (1n << 64n) - 1n;

/** The most digits, once leading zeros are dropped, that a 64-bit value takes in each base. */
const MAX_SIGNIFICANT_DIGITS = { 16: 16, 10: 20, 8: 22, 2: 64 } as const;

/**
 * The integer a spelling names, or null when it is not one or does not fit in
 * 64 bits. Only the digits that count are converted, so a numeral padded with
 * zeros is the value it names however long it is, and one with too many
 * significant digits is refused before any conversion.
 */
function integerValue(plain: string): bigint | null {
  const match = INTEGER.exec(plain);
  if (match === null) return null;
  const [, sign, hex, binary, octalPrefixed, octalLeading, decimal] = match;
  let digits: string;
  let radix: keyof typeof MAX_SIGNIFICANT_DIGITS;
  let prefix: string;
  if (hex !== undefined) [digits, radix, prefix] = [hex, 16, '0x'];
  else if (binary !== undefined) [digits, radix, prefix] = [binary, 2, '0b'];
  else if (octalPrefixed !== undefined) [digits, radix, prefix] = [octalPrefixed, 8, '0o'];
  else if (octalLeading !== undefined) [digits, radix, prefix] = [octalLeading, 8, '0o'];
  else [digits, radix, prefix] = [decimal, 10, ''];
  const significant = digits.replace(/^0+/, '');
  if (significant.length > MAX_SIGNIFICANT_DIGITS[radix]) return null;
  const magnitude = significant === '' ? 0n : BigInt(`${prefix}${significant}`);
  const value = sign === '-' ? -magnitude : magnitude;
  if (value >= MIN_INT64 && value <= MAX_INT64) return value;
  // A value past int64 is read as unsigned when it has no sign.
  if (sign === '' && value <= MAX_UINT64) return value;
  return null;
}

/** Go's `strconv.FormatFloat(x, 'g', -1, 64)`: the shortest digits, in exponent form past 1e6 or under 1e-4. */
function floatText(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return value > 0 ? '+Inf' : '-Inf';
  if (value === 0) return Object.is(value, -0) ? '-0' : '0';
  const [mantissa, exponentText] = value.toExponential().split('e');
  const negative = mantissa.startsWith('-');
  const digits = mantissa.replace('-', '').replace('.', '');
  const exponent = Number(exponentText);
  const sign = negative ? '-' : '';
  if (exponent < -4 || exponent >= 6) {
    const fraction = digits.length > 1 ? `.${digits.slice(1)}` : '';
    const power = Math.abs(exponent).toString().padStart(2, '0');
    return `${sign}${digits[0]}${fraction}e${exponent < 0 ? '-' : '+'}${power}`;
  }
  if (exponent < 0) return `${sign}0.${'0'.repeat(-exponent - 1)}${digits}`;
  const whole = digits.padEnd(exponent + 1, '0');
  const integral = whole.slice(0, exponent + 1);
  const fractional = whole.slice(exponent + 1);
  return `${sign}${integral}${fractional === '' ? '' : `.${fractional}`}`;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * A timestamp the way Go prints a `time.Time`. A numeric offset prints as its
 * own zone name, which is the longest form the print takes: a machine whose
 * local zone has that offset prints a shorter abbreviation, so this can only
 * over-count a value.
 */
function timestampText(plain: string): string | null {
  const match = TIMESTAMP.exec(plain);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hasZone = match[8] !== undefined;
  const hasClock = hasZone || match[9] !== undefined;
  const hour = Number(hasZone ? match[4] : (match[9] ?? 0));
  const minute = Number(hasZone ? match[5] : (match[10] ?? 0));
  const second = Number(hasZone ? match[6] : (match[11] ?? 0));
  const fraction = ((hasZone ? match[7] : match[12]) ?? '').slice(0, 9).replace(/0+$/, '');
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const pad = (value: number): string => value.toString().padStart(2, '0');
  const date = `${match[1]}-${pad(month)}-${pad(day)}`;
  const clock = hasClock ? `${pad(hour)}:${pad(minute)}:${pad(second)}${fraction === '' ? '' : `.${fraction}`}` : '00:00:00';
  let zone = '+0000 UTC';
  const offset = match[8];
  if (offset !== undefined && offset !== 'Z') {
    const compact = offset.replace(':', '');
    zone = `${compact} ${compact}`;
  }
  return `${date} ${clock} ${zone}`;
}

/** What a scalar resolves to: its kind, the text Compose gives it, and for a number its float64 value. */
interface ResolvedScalar {
  kind: 'bool' | 'int' | 'float' | 'timestamp' | 'string';
  text: string;
  number?: number;
  /** The exact value of an integer, which `number` loses past 2^53. */
  integer?: bigint;
}

function resolveScalar(text: string): ResolvedScalar {
  if (BOOLEAN_TRUE.has(text)) return { kind: 'bool', text: 'true' };
  if (BOOLEAN_FALSE.has(text)) return { kind: 'bool', text: 'false' };
  if (POSITIVE_INFINITY.has(text)) return { kind: 'float', text: '+Inf', number: Infinity };
  if (NEGATIVE_INFINITY.has(text)) return { kind: 'float', text: '-Inf', number: -Infinity };
  if (NOT_A_NUMBER.has(text)) return { kind: 'float', text: 'NaN', number: NaN };
  const first = text[0];
  if (first === undefined || !/[0-9+\-.]/.test(first)) return { kind: 'string', text };
  const timestamp = timestampText(text);
  if (timestamp !== null) return { kind: 'timestamp', text: timestamp };
  const plain = text.replace(/_/g, '');
  // A lone `-0` is the one integer spelling Compose reads as a float.
  if (plain === '-0') return { kind: 'float', text: '-0', number: -0 };
  const integer = integerValue(plain);
  if (integer !== null) return { kind: 'int', text: integer.toString(), number: Number(integer), integer };
  if (FLOAT.test(plain)) {
    const value = Number(plain);
    // Go rejects a float past its range, which leaves the text as it was.
    if (Number.isFinite(value)) return { kind: 'float', text: floatText(value), number: value };
  }
  return { kind: 'string', text };
}

/** The text Compose gives a plain scalar written as `text`. */
export function composePlainScalarText(text: string): string {
  return resolveScalar(text).text;
}

/**
 * The text Compose gives a scalar written as `text` under an explicit
 * `!!int`, `!!float`, `!!bool`, or `!!timestamp` tag, or null when `text` is
 * not of that kind, which is a file Compose rejects.
 * `!!float` takes an integer as well, as the float it converts to, except one
 * above the largest signed 64-bit value: the decoder reads that as an unsigned
 * integer and has no conversion for it, so the file is rejected.
 */
export function composeTaggedScalarText(text: string, tag: 'int' | 'float' | 'bool' | 'timestamp'): string | null {
  const resolved = resolveScalar(text);
  if (tag === 'float' && resolved.kind === 'int') {
    return resolved.integer !== undefined && resolved.integer > MAX_INT64 ? null : floatText(resolved.number ?? 0);
  }
  if (tag === 'float' && resolved.kind === 'float') return floatText(resolved.number ?? 0);
  return resolved.kind === tag ? resolved.text : null;
}
