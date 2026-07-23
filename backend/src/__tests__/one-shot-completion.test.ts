import { describe, expect, it } from 'vitest';
import { isCleanOneShotCompletion, isNoRestartPolicy } from '../utils/oneShotCompletion';

describe('isNoRestartPolicy', () => {
  it('treats undefined, null, empty string, and no as absent', () => {
    expect(isNoRestartPolicy(undefined)).toBe(true);
    expect(isNoRestartPolicy(null)).toBe(true);
    expect(isNoRestartPolicy('')).toBe(true);
    expect(isNoRestartPolicy('no')).toBe(true);
  });

  it('rejects restarting policies', () => {
    expect(isNoRestartPolicy('unless-stopped')).toBe(false);
    expect(isNoRestartPolicy('always')).toBe(false);
    expect(isNoRestartPolicy('on-failure')).toBe(false);
  });
});

describe('isCleanOneShotCompletion', () => {
  const clean = {
    state: 'exited',
    exitCode: 0 as number | null,
    restartPolicy: 'no' as string | null | undefined,
  };

  it('returns true only for exited + exit 0 + no/absent restart', () => {
    expect(isCleanOneShotCompletion(clean)).toBe(true);
    expect(isCleanOneShotCompletion({ ...clean, restartPolicy: undefined })).toBe(true);
    expect(isCleanOneShotCompletion({ ...clean, restartPolicy: null })).toBe(true);
    expect(isCleanOneShotCompletion({ ...clean, restartPolicy: '' })).toBe(true);
  });

  it('returns false for non-exited states', () => {
    expect(isCleanOneShotCompletion({ ...clean, state: 'running' })).toBe(false);
    expect(isCleanOneShotCompletion({ ...clean, state: 'restarting' })).toBe(false);
    expect(isCleanOneShotCompletion({ ...clean, state: 'created' })).toBe(false);
    expect(isCleanOneShotCompletion({ ...clean, state: 'dead' })).toBe(false);
  });

  it('returns false for non-zero and null exit codes (fail closed)', () => {
    expect(isCleanOneShotCompletion({ ...clean, exitCode: 1 })).toBe(false);
    expect(isCleanOneShotCompletion({ ...clean, exitCode: 137 })).toBe(false);
    expect(isCleanOneShotCompletion({ ...clean, exitCode: null })).toBe(false);
  });

  it('returns false for restarting policies even with exit 0', () => {
    expect(isCleanOneShotCompletion({ ...clean, restartPolicy: 'unless-stopped' })).toBe(false);
    expect(isCleanOneShotCompletion({ ...clean, restartPolicy: 'always' })).toBe(false);
    expect(isCleanOneShotCompletion({ ...clean, restartPolicy: 'on-failure' })).toBe(false);
  });
});
