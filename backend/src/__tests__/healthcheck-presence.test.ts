import { describe, it, expect } from 'vitest';
import {
  classifyComposeHealthcheck,
  isComposeHealthcheckActive,
  isDockerHealthcheckActive,
} from '../helpers/healthcheckPresence';

describe('classifyComposeHealthcheck', () => {
  it('treats a missing or non-object healthcheck as absent', () => {
    expect(classifyComposeHealthcheck(undefined)).toBe('absent');
    expect(classifyComposeHealthcheck(null)).toBe('absent');
    expect(classifyComposeHealthcheck('CMD')).toBe('absent');
  });

  it('treats disable: true as disabled', () => {
    expect(classifyComposeHealthcheck({ disable: true })).toBe('disabled');
    expect(isComposeHealthcheckActive({ disable: true })).toBe(false);
  });

  it('treats test NONE forms as disabled', () => {
    expect(classifyComposeHealthcheck({ test: 'NONE' })).toBe('disabled');
    expect(classifyComposeHealthcheck({ test: ['NONE'] })).toBe('disabled');
    expect(classifyComposeHealthcheck({ test: ['none'] })).toBe('disabled');
  });

  it('treats an active test as active', () => {
    expect(classifyComposeHealthcheck({ test: ['CMD', 'true'] })).toBe('active');
    expect(isComposeHealthcheckActive({ test: ['CMD', 'curl', '-f', 'http://localhost'] })).toBe(true);
  });
});

describe('isDockerHealthcheckActive', () => {
  it('is false for missing, empty, and NONE', () => {
    expect(isDockerHealthcheckActive(undefined)).toBe(false);
    expect(isDockerHealthcheckActive([])).toBe(false);
    expect(isDockerHealthcheckActive(['NONE'])).toBe(false);
    expect(isDockerHealthcheckActive('NONE')).toBe(false);
  });

  it('is true for a real Test array without exposing its contents', () => {
    const secretTest = ['CMD-SHELL', 'curl -f http://x/?token=secret-token || exit 1'];
    expect(isDockerHealthcheckActive(secretTest)).toBe(true);
  });
});
