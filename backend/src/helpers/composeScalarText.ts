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
  /^(\d{4})-(\d{1,2})-(\d{1,2})(?:(?:[Tt](\d{1,2}):(\d{1,2}):(\d{1,2})(?:[.,](\d+))?(Z|[+-]\d{2}:\d{2}))|(?: (\d{1,2}):(\d{1,2}):(\d{1,2})(?:[.,](\d+))?))?$/;

const MAX_INT64 = (1n << 63n) - 1n;
const MIN_INT64 = -(1n << 63n);
const MAX_UINT64 = (1n << 64n) - 1n;

function integerText(plain: string): string | null {
  const match = INTEGER.exec(plain);
  if (match === null) return null;
  const [, sign, hex, binary, octalPrefixed, octalLeading, decimal] = match;
  let magnitude: bigint;
  if (hex !== undefined) magnitude = BigInt(`0x${hex}`);
  else if (binary !== undefined) magnitude = BigInt(`0b${binary}`);
  else if (octalPrefixed !== undefined) magnitude = BigInt(`0o${octalPrefixed}`);
  else if (octalLeading !== undefined) magnitude = octalLeading === '' ? 0n : BigInt(`0o${octalLeading}`);
  else magnitude = BigInt(decimal);
  const value = sign === '-' ? -magnitude : magnitude;
  if (value >= MIN_INT64 && value <= MAX_INT64) return value.toString();
  // A value past int64 is read as unsigned when it has no sign.
  if (sign === '' && value <= MAX_UINT64) return value.toString();
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

/** The text Compose gives a plain scalar written as `text`. */
export function composePlainScalarText(text: string): string {
  if (BOOLEAN_TRUE.has(text)) return 'true';
  if (BOOLEAN_FALSE.has(text)) return 'false';
  if (POSITIVE_INFINITY.has(text)) return '+Inf';
  if (NEGATIVE_INFINITY.has(text)) return '-Inf';
  if (NOT_A_NUMBER.has(text)) return 'NaN';
  const first = text[0];
  if (first === undefined || !/[0-9+\-.]/.test(first)) return text;
  const timestamp = timestampText(text);
  if (timestamp !== null) return timestamp;
  const plain = text.replace(/_/g, '');
  // A lone `-0` is the one integer spelling Compose reads as a float.
  if (plain === '-0') return '-0';
  const integer = integerText(plain);
  if (integer !== null) return integer;
  if (FLOAT.test(plain)) {
    const value = Number(plain);
    // Go rejects a float past its range, which leaves the text as it was.
    if (Number.isFinite(value)) return floatText(value);
  }
  return text;
}
