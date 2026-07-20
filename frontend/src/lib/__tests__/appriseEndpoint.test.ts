import { describe, expect, it } from 'vitest';
import {
  classifyAppriseEndpoint,
  isKeyedAppriseEndpoint,
  isStatelessAppriseEndpoint,
} from '../appriseEndpoint';

describe('classifyAppriseEndpoint', () => {
  it('classifies keyed and stateless endpoints', () => {
    expect(classifyAppriseEndpoint('http://apprise.local/notify/my-key')).toBe('keyed');
    expect(classifyAppriseEndpoint('http://apprise.local/notify')).toBe('stateless');
    expect(classifyAppriseEndpoint('http://apprise.local/other')).toBeNull();
  });

  it('treats a public redacted notify key as keyed so Tags remain visible', () => {
    expect(classifyAppriseEndpoint('http://apprise.local/notify/<redacted>')).toBe('keyed');
    expect(isKeyedAppriseEndpoint('http://apprise.local/notify/<redacted>')).toBe(true);
    expect(isStatelessAppriseEndpoint('http://apprise.local/notify/<redacted>')).toBe(false);
  });
});
