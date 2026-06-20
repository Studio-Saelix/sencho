import { describe, it, expect } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import {
  parseInterpolationRefs,
  extractEnvKeyFromLine,
  readEnvFileKeys,
  parseUnsetEnvVars,
  parseMissingRequiredVars,
} from '../helpers/envVarParse';

describe('parseInterpolationRefs', () => {
  it('classifies all seven operator forms, including the no-colon variants', () => {
    const src = [
      'a: ${BARE}',
      'b: ${DEF:-fallback}',
      'c: ${DEF2-fallback}',
      'd: ${REQ:?must be set}',
      'e: ${REQ2?must be set}',
      'f: ${ALT:+present}',
      'g: ${ALT2+present}',
    ].join('\n');
    const refs = new Map(parseInterpolationRefs(src).map(r => [r.name, r]));
    expect(refs.get('BARE')).toMatchObject({ required: false, hasDefault: false, alternate: false });
    expect(refs.get('DEF')).toMatchObject({ hasDefault: true, required: false });
    expect(refs.get('DEF2')).toMatchObject({ hasDefault: true, required: false });
    expect(refs.get('REQ')).toMatchObject({ required: true });
    expect(refs.get('REQ2')).toMatchObject({ required: true });
    expect(refs.get('ALT')).toMatchObject({ alternate: true, required: false, hasDefault: false });
    expect(refs.get('ALT2')).toMatchObject({ alternate: true });
  });

  it('skips the $${ESCAPED} literal', () => {
    expect(parseInterpolationRefs('x: $${ESCAPED}').map(r => r.name)).not.toContain('ESCAPED');
  });

  it('merges flags across repeated references of one name', () => {
    const refs = parseInterpolationRefs('${X} then ${X:?e}');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ name: 'X', required: true });
  });

  it('ORs default and alternate flags across occurrences too', () => {
    const refs = parseInterpolationRefs('${Y:-d} then ${Y:+a}');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ name: 'Y', hasDefault: true, alternate: true, required: false });
  });
});

describe('extractEnvKeyFromLine', () => {
  it('returns the key name only for each line form', () => {
    expect(extractEnvKeyFromLine('FOO=bar')).toBe('FOO');
    expect(extractEnvKeyFromLine('export BAZ=qux')).toBe('BAZ');
    expect(extractEnvKeyFromLine('BARE')).toBe('BARE');
    expect(extractEnvKeyFromLine('# comment')).toBeNull();
    expect(extractEnvKeyFromLine('   ')).toBeNull();
    expect(extractEnvKeyFromLine('1BAD=x')).toBeNull();
  });

  it('never returns the value', () => {
    expect(extractEnvKeyFromLine('SECRET=supersecretvalue')).toBe('SECRET');
  });
});

describe('readEnvFileKeys', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'envkeys-'));

  it('reads key names only and never the value', async () => {
    const p = path.join(base, '.env');
    fs.writeFileSync(p, 'FOO=secretvalue\n# c\nexport BAR=2\nBARE\n');
    const res = await readEnvFileKeys(p, base);
    expect(res.keys.sort()).toEqual(['BAR', 'BARE', 'FOO']);
    expect(res.unverifiable).toBe(false);
    expect(JSON.stringify(res)).not.toContain('secretvalue');
  });

  it('caps bytes/lines on a large fixture, flags truncated, and leaks no value', async () => {
    const p = path.join(base, 'big.env');
    let content = '';
    for (let i = 0; i < 20000; i++) content += `K${i}=verylongsecret${'x'.repeat(40)}\n`;
    fs.writeFileSync(p, content);
    const res = await readEnvFileKeys(p, base, { maxBytes: 4096, maxLines: 100, maxLineLen: 8192 });
    expect(res.truncated).toBe(true);
    expect(res.keys.length).toBeLessThanOrEqual(100);
    expect(JSON.stringify(res)).not.toContain('verylongsecret');
  });

  it('marks a path escaping the base directory as unverifiable', async () => {
    // A secure temp dir that is a sibling of `base`, so the file is outside it.
    const otherBase = fs.mkdtempSync(path.join(os.tmpdir(), 'envkeys-out-'));
    const outside = path.join(otherBase, 'x.env');
    fs.writeFileSync(outside, 'X=1');
    const res = await readEnvFileKeys(outside, base);
    expect(res.unverifiable).toBe(true);
    expect(res.keys).toEqual([]);
    fs.rmSync(otherBase, { recursive: true, force: true });
  });

  it('marks a missing file as unverifiable', async () => {
    const res = await readEnvFileKeys(path.join(base, 'nope.env'), base);
    expect(res.unverifiable).toBe(true);
    expect(res.keys).toEqual([]);
  });
});

describe('parseUnsetEnvVars / parseMissingRequiredVars', () => {
  it('extracts unset variable names (escaped, quoted, and bare forms)', () => {
    const stderr =
      'time="t" level=warning msg="The \\"DB_HOST\\" variable is not set. Defaulting to a blank string."\n'
      + 'The "TOKEN" variable is not set.\n'
      + 'The PLAIN variable is not set.';
    expect(parseUnsetEnvVars(stderr).sort()).toEqual(['DB_HOST', 'PLAIN', 'TOKEN']);
  });

  it('extracts the name from a required-variable error', () => {
    const stderr = 'error while interpolating services.web.environment.TOKEN: required variable REQ_TOKEN is missing a value: must be provided';
    expect(parseMissingRequiredVars(stderr)).toEqual(['REQ_TOKEN']);
  });
});
