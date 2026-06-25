import { describe, it, expect } from 'vitest';
import { getCronFieldError } from './scheduling';

describe('getCronFieldError', () => {
  it('accepts a standard 5-field expression', () => {
    expect(getCronFieldError('0 3 * * *')).toBeNull();
  });

  it('rejects a 6-field expression with a seconds field', () => {
    expect(getCronFieldError('30 0 3 * * *')).toMatch(/5 fields/);
  });

  it('rejects expressions with extra fields beyond six', () => {
    expect(getCronFieldError('0 0 3 * * * 2026')).toMatch(/5 fields/);
  });

  it('accepts cron nicknames such as @daily', () => {
    expect(getCronFieldError('@daily')).toBeNull();
  });

  it('ignores empty or whitespace-only input', () => {
    expect(getCronFieldError('')).toBeNull();
    expect(getCronFieldError('   ')).toBeNull();
  });

  it('tolerates irregular spacing between five fields', () => {
    expect(getCronFieldError('  0   3 *  * * ')).toBeNull();
  });
});
