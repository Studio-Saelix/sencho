/**
 * Tests for escapeCsvField: RFC 4180 quoting plus CSV formula-injection
 * neutralization (CWE-1236). Audit-log export embeds user-controlled resource
 * names, so any field can carry a leading formula trigger.
 */
import { describe, it, expect } from 'vitest';
import { escapeCsvField } from '../utils/csv';

describe('escapeCsvField', () => {
  it('returns empty string for null and undefined', () => {
    expect(escapeCsvField(null)).toBe('');
    expect(escapeCsvField(undefined)).toBe('');
  });

  it('passes benign values through unchanged', () => {
    expect(escapeCsvField('Created stack: web')).toBe('Created stack: web');
    expect(escapeCsvField('admin')).toBe('admin');
    expect(escapeCsvField(201)).toBe('201');
    expect(escapeCsvField(0)).toBe('0');
  });

  it('quotes and doubles embedded quotes / commas / newlines', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"');
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
  });

  it('prefixes a single quote on each formula trigger', () => {
    expect(escapeCsvField('=1+1')).toBe("'=1+1");
    expect(escapeCsvField('+1')).toBe("'+1");
    expect(escapeCsvField('-1')).toBe("'-1");
    expect(escapeCsvField('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(escapeCsvField('\tTAB')).toBe("'\tTAB");
    // A leading CR is both defused and RFC 4180 quoted.
    expect(escapeCsvField('\rCR')).toBe('"\'\rCR"');
  });

  it('defuses a trigger hidden behind leading whitespace', () => {
    expect(escapeCsvField(' =cmd')).toBe("' =cmd");
    expect(escapeCsvField('   +1')).toBe("'   +1");
    expect(escapeCsvField('\t=cmd')).toBe("'\t=cmd");
  });

  it('prefixes a negative number (conservative, by design)', () => {
    expect(escapeCsvField(-5)).toBe("'-5");
  });

  it('neutralizes a HYPERLINK formula payload in a resource name', () => {
    // Embedded quotes + commas force RFC 4180 quoting, so the cell is wrapped;
    // the defused content (leading single quote) sits just inside the wrapper.
    const malicious = '=HYPERLINK("http://evil","click")';
    const out = escapeCsvField(malicious);
    expect(out).toContain("'=HYPERLINK");
    expect(out.startsWith('=')).toBe(false);
  });

  it('combines formula prefix with RFC 4180 quoting when needed', () => {
    // Leading trigger AND an embedded comma: prefix first, then quote.
    expect(escapeCsvField('=cmd,inject')).toBe('"\'=cmd,inject"');
  });

  it('does not alter a value where the trigger is not first', () => {
    expect(escapeCsvField('stack=web')).toBe('stack=web');
    expect(escapeCsvField('a-b-c')).toBe('a-b-c');
  });
});
