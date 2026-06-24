import { describe, it, expect } from 'vitest';
import { isAnonymousVolumeName, shortVolumeLabel } from '../volumeName';

const ANON = '079dfda49f2c483f80f1d4f6b1865be55af54a0298507a0e588aae551134ba62';

describe('isAnonymousVolumeName', () => {
  it('treats a 64 lowercase hex name as anonymous', () => {
    expect(isAnonymousVolumeName(ANON)).toBe(true);
  });

  it('treats a friendly named volume as not anonymous', () => {
    expect(isAnonymousVolumeName('app_pgdata')).toBe(false);
  });

  it('rejects names that are not exactly 64 chars', () => {
    expect(isAnonymousVolumeName(ANON.slice(0, 63))).toBe(false);
    expect(isAnonymousVolumeName(ANON + 'a')).toBe(false);
  });

  it('rejects uppercase hex and non-hex characters', () => {
    expect(isAnonymousVolumeName(ANON.toUpperCase())).toBe(false);
    expect(isAnonymousVolumeName('z'.repeat(64))).toBe(false);
  });
});

describe('shortVolumeLabel', () => {
  it('truncates an anonymous name to a 12-char prefix plus an ellipsis', () => {
    expect(shortVolumeLabel(ANON)).toBe('079dfda49f2c…');
  });

  it('returns a named volume verbatim', () => {
    expect(shortVolumeLabel('app_pgdata')).toBe('app_pgdata');
  });
});
