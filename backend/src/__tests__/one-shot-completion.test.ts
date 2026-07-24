import { describe, expect, it } from 'vitest';
import {
  isCleanOneShotCompletion,
  isNoRestartPolicy,
  normalizeComposeRestartIntent,
} from '../utils/oneShotCompletion';

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

describe('normalizeComposeRestartIntent', () => {
  it('falls back to service restart when deploy.restart_policy is unset', () => {
    expect(normalizeComposeRestartIntent('no')).toBe('no');
    expect(normalizeComposeRestartIntent('unless-stopped')).toBe('unless-stopped');
    expect(normalizeComposeRestartIntent(undefined)).toBeNull();
    expect(normalizeComposeRestartIntent(null, {})).toBeNull();
    expect(normalizeComposeRestartIntent('always', { replicas: 2 })).toBe('always');
  });

  it('maps deploy.restart_policy.condition with Compose defaults and precedence', () => {
    expect(normalizeComposeRestartIntent('unless-stopped', {
      restart_policy: { condition: 'none' },
    })).toBe('no');
    expect(normalizeComposeRestartIntent(null, {
      restart_policy: { condition: 'any' },
    })).toBe('always');
    expect(normalizeComposeRestartIntent('no', {
      restart_policy: { condition: 'on-failure' },
    })).toBe('on-failure');
    expect(normalizeComposeRestartIntent('no', {
      restart_policy: {},
    })).toBe('always');
  });

  it('fails closed on malformed restart_policy shapes', () => {
    expect(normalizeComposeRestartIntent('no', { restart_policy: null })).toBe('always');
    expect(normalizeComposeRestartIntent('no', { restart_policy: 'none' })).toBe('always');
    expect(normalizeComposeRestartIntent('no', { restart_policy: [] })).toBe('always');
    expect(normalizeComposeRestartIntent('no', {
      restart_policy: { condition: 'weird' },
    })).toBe('always');
  });
});
