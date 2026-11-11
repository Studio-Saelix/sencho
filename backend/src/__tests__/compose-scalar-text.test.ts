/**
 * The text Compose gives a plain YAML scalar as an environment value. Every row
 * is what Docker Compose 5.7.0 printed for that scalar in
 * `docker compose config --format json`.
 */
import { describe, it, expect } from 'vitest';
import { composePlainScalarText, composeTaggedScalarText } from '../helpers/composeScalarText';

const COMPOSE_TEXT: Array<[string, string]> = [
  ['-0', '-0'],
  ['-00', '0'],
  ['+0', '0'],
  ['00', '0'],
  ['-0x0', '0'],
  ['0x', '0x'],
  ['0b2', '0b2'],
  ['08', '8'],
  ['09.5', '9.5'],
  ['1e', '1e'],
  ['1.2.3', '1.2.3'],
  ['1__0', '10'],
  ['_1', '_1'],
  ['1_', '1'],
  ['+-1', '+-1'],
  ['0o9', '0o9'],
  ['0X1f', '31'],
  ['-0b11', '-3'],
  ['9223372036854775807', '9223372036854775807'],
  ['9223372036854775808', '9223372036854775808'],
  ['-9223372036854775808', '-9223372036854775808'],
  ['-9223372036854775809', '-9.223372036854776e+18'],
  ['18446744073709551615', '18446744073709551615'],
  ['18446744073709551616', '1.8446744073709552e+19'],
  ['1e400', '1e400'],
  ['.5', '0.5'],
  ['5.', '5'],
  ['-.5e-3', '-0.0005'],
  ['1000000.0', '1e+06'],
  ['100000.0', '100000'],
  ['123456.789', '123456.789'],
  ['1.5e-5', '1.5e-05'],
  ['0.0001', '0.0001'],
  ['0.00001', '1e-05'],
  ['1E3', '1000'],
  ['1e+3', '1000'],
  ['0x1.8p1', '0x1.8p1'],
  ['0_7', '7'],
  ['1_0.5', '10.5'],
  ['0b1_1', '3'],
  ['-0o17', '-15'],
  ['2020-13-01', '2020-13-01'],
  ['2020-02-30', '2020-02-30'],
  ['2020-1-2T3:4:5Z', '2020-01-02 03:04:05 +0000 UTC'],
  ['2020-01-01t10:20:30z', '2020-01-01t10:20:30z'],
  ['2020-01-01T10:20:30.5-03:30', '2020-01-01 10:20:30.5 -0330 -0330'],
  ['2020-01-01 10:20:30 +5', '2020-01-01 10:20:30 +5'],
  ['2020-01-01 10:20:30Z', '2020-01-01 10:20:30Z'],
  ['20200-01-01', '20200-01-01'],
  ['2020-01-01T10:20:30.000Z', '2020-01-01 10:20:30 +0000 UTC'],
  ['2020-01-01T10:20:30+00:00', '2020-01-01 10:20:30 +0000 +0000'],
  ['1234-5678', '1234-5678'],
  ['True', 'true'],
  ['TRUE', 'true'],
  ['tRue', 'tRue'],
  ['Yes', 'Yes'],
  ['ON', 'ON'],
  ['1.e3', '1000'],
  ['2020-01-01T10:20:30+05:00', '2020-01-01 10:20:30 +0500 +0500'],
  ['2020-01-01 10:20:30.50', '2020-01-01 10:20:30.5 +0000 UTC'],
  ['true', 'true'],
  ['false', 'false'],
  ['1e21', '1e+21'],
  ['1e-7', '1e-07'],
  ['0x10', '16'],
  ['0o10', '8'],
  ['1_000', '1000'],
  ['12345678901234567890', '12345678901234567890'],
  ['1.50', '1.5'],
  ['+1', '1'],
  ['1.0', '1'],
  ['2020-01-01', '2020-01-01 00:00:00 +0000 UTC'],
  ['2020-01-01T10:20:30Z', '2020-01-01 10:20:30 +0000 UTC'],
  ['2020-1-2', '2020-01-02 00:00:00 +0000 UTC'],
  ['2020-01-01 10:20:30', '2020-01-01 10:20:30 +0000 UTC'],
  ['2020-01-01 10:20:30.5', '2020-01-01 10:20:30.5 +0000 UTC'],
  ['2020-01-01T10:20:30.123456789Z', '2020-01-01 10:20:30.123456789 +0000 UTC'],
  ['0b11', '3'],
  ['010', '8'],
  ['1.5e3', '1500'],
  ['100000000000000000000.5', '1e+20'],
  ['123456789.123456789', '1.2345678912345679e+08'],
  ['yes', 'yes'],
  ['0.1', '0.1'],
  ['1e3', '1000'],
  ['0e0', '0'],
  // Compose accepts more than one space between the date and the time.
  ['2020-01-01  10:20:30', '2020-01-01 10:20:30 +0000 UTC'],
  ['2020-01-01     10:20:30', '2020-01-01 10:20:30 +0000 UTC'],
  ['2020-01-01  1:2:3', '2020-01-01 01:02:03 +0000 UTC'],
  ['2020-1-1  1:2:3.5', '2020-01-01 01:02:03.5 +0000 UTC'],
  ['2020-01-01  10:20:30,25', '2020-01-01 10:20:30.25 +0000 UTC'],
  ['2020-01-01  10:20:30.123456789123', '2020-01-01 10:20:30.123456789 +0000 UTC'],
  // A zone, a tab, or a space around the `T` is no timestamp.
  ['2020-01-01  10:20:30 +01:00', '2020-01-01  10:20:30 +01:00'],
  ['2020-01-01  10:20:30Z', '2020-01-01  10:20:30Z'],
  ['2020-01-01T10:20:30  Z', '2020-01-01T10:20:30  Z'],
  ['2020-01-01 T10:20:30Z', '2020-01-01 T10:20:30Z'],
  ['2020-01-01\t10:20:30', '2020-01-01\t10:20:30'],
  ['2020-02-30  10:20:30', '2020-02-30  10:20:30'],
  ['2020-01-01  25:20:30', '2020-01-01  25:20:30'],
];

const ZEROS = '0'.repeat(70);
/** Padding with zeros changes no value, so each of these is read by the digits that count. */
const PADDED_INTEGERS: Array<[string, string]> = [
  [`0x${ZEROS}1`, '1'],
  [`0b${ZEROS}1`, '1'],
  [`0o${ZEROS}1`, '1'],
  [`-0x${ZEROS}1`, '-1'],
  [`+0b${ZEROS}1`, '1'],
  [`-0o${ZEROS}1`, '-1'],
  [`+0x${ZEROS}1`, '1'],
  [`0${ZEROS}7`, '7'],
  [`-0${ZEROS}7`, '-7'],
  [`0${ZEROS}8`, '8'],
  ['0'.repeat(80), '0'],
  [`-${'0'.repeat(80)}`, '0'],
  [`0x${'0'.repeat(80)}`, '0'],
  [`0x${ZEROS}_1`, '1'],
  [`1_${ZEROS}`, '1e+70'],
  [`${'0'.repeat(30)}9`, '9'],
  // The widest value each base holds, and one digit more.
  [`0x${'f'.repeat(16)}`, '18446744073709551615'],
  [`0x${'f'.repeat(17)}`, `0x${'f'.repeat(17)}`],
  [`0x${ZEROS}${'f'.repeat(16)}`, '18446744073709551615'],
  [`-0x8${'0'.repeat(15)}`, '-9223372036854775808'],
  [`-0x8${'0'.repeat(14)}1`, `-0x8${'0'.repeat(14)}1`],
  [`0b${'1'.repeat(64)}`, '18446744073709551615'],
  [`0b${'1'.repeat(65)}`, `0b${'1'.repeat(65)}`],
  [`-0b1${'0'.repeat(63)}`, '-9223372036854775808'],
  [`-0b1${'0'.repeat(62)}1`, `-0b1${'0'.repeat(62)}1`],
  [`0o1${'7'.repeat(21)}`, '18446744073709551615'],
  [`0o2${'7'.repeat(21)}`, `0o2${'7'.repeat(21)}`],
  [`01${'7'.repeat(21)}`, '18446744073709551615'],
  ['1'.repeat(19), '1'.repeat(19)],
  ['1'.repeat(20), '1'.repeat(20)],
  ['1'.repeat(21), '1.1111111111111111e+20'],
  [`-${'9'.repeat(20)}`, '-1e+20'],
  ['18446744073709551615', '18446744073709551615'],
  ['000018446744073709551615', '1.8446744073709552e+19'],
  ['09000', '9000'],
];

/**
 * Compose 5.7.0 for a scalar under an explicit tag; `null` is a file Compose
 * rejects ("cannot construct ... as a !!float"), where nothing is interpolated.
 */
const TAGGED_TEXT: Array<['int' | 'float' | 'bool' | 'timestamp', string, string | null]> = [
  ['float', '9223372036854775807', '9.223372036854776e+18'],
  ['float', '1', '1'],
  ['float', '010', '8'],
  ['float', '0x10', '16'],
  ['float', '1e3', '1000'],
  ['float', '1.5', '1.5'],
  ['float', '18446744073709551615', '1.8446744073709552e+19'],
  ['float', 'true', null],
  ['float', 'abc', null],
  ['float', '2020-01-01', null],
  ['int', '5', '5'],
  ['int', '0x10', '16'],
  ['int', '010', '8'],
  ['int', '9223372036854775808', '9223372036854775808'],
  ['int', '1.5', null],
  ['int', '1e3', null],
  ['int', 'true', null],
  ['int', 'abc', null],
  ['bool', 'true', 'true'],
  ['bool', 'True', 'true'],
  ['bool', 'yes', null],
  ['bool', '1', null],
  ['timestamp', '2020-01-01', '2020-01-01 00:00:00 +0000 UTC'],
  ['timestamp', '2020-01-01 10:20:30', '2020-01-01 10:20:30 +0000 UTC'],
  ['timestamp', '2020-01-01   10:20:30', '2020-01-01 10:20:30 +0000 UTC'],
  ['timestamp', '5', null],
  ['timestamp', 'abc', null],
];

describe('composePlainScalarText', () => {
  it.each(COMPOSE_TEXT)('reads %s as %s, as Compose does', (written, expected) => {
    expect(composePlainScalarText(written)).toBe(expected);
  });

  it.each(PADDED_INTEGERS)('reads %#: a numeral padded with zeros by the digits that count', (written, expected) => {
    expect(composePlainScalarText(written)).toBe(expected);
  });

  it('reads a very long numeral as a float without converting it as an integer', () => {
    const started = Date.now();
    expect(composePlainScalarText('9'.repeat(1_000_000))).toBe('9'.repeat(1_000_000));
    expect(composePlainScalarText(`0x${'f'.repeat(1_000_000)}`)).toBe(`0x${'f'.repeat(1_000_000)}`);
    expect(composePlainScalarText('1'.repeat(30))).toBe('1.111111111111111e+29');
    // Padding must not turn into a conversion of the padding.
    expect(composePlainScalarText(`0x${'0'.repeat(1_000_000)}1`)).toBe('1');
    expect(composePlainScalarText(`${'0'.repeat(1_000_000)}7`)).toBe('7');
    expect(composePlainScalarText(`0b${'0'.repeat(1_000_000)}1`)).toBe('1');
    expect(composePlainScalarText(`1${'0'.repeat(1_000_000)}`)).toBe(`1${'0'.repeat(1_000_000)}`);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('names the non-finite floats the way Go does (Compose refuses to print them as JSON, so these are not probed rows)', () => {
    expect(composePlainScalarText('.inf')).toBe('+Inf');
    expect(composePlainScalarText('-.Inf')).toBe('-Inf');
    expect(composePlainScalarText('.NaN')).toBe('NaN');
  });
});

describe('composeTaggedScalarText', () => {
  it.each(TAGGED_TEXT)('reads !!%s %s as %s, as Compose does', (tag, written, expected) => {
    expect(composeTaggedScalarText(written, tag)).toBe(expected);
  });
});
