import { describe, it, expect } from 'vitest';
import { resolveHostConsoleCapability } from './hostConsoleCapability';

describe('resolveHostConsoleCapability', () => {
  it('allows local nodes without waiting for meta', () => {
    expect(resolveHostConsoleCapability({
      isRemote: false,
      isPaid: false,
      licenseReady: true,
      activeNodeMeta: null,
    })).toBe('allowed');
  });

  it('returns loading when remote meta is absent', () => {
    expect(resolveHostConsoleCapability({
      isRemote: true,
      isPaid: false,
      licenseReady: true,
      activeNodeMeta: null,
    })).toBe('loading');
  });

  it('allows Community when remote advertises host-console-community', () => {
    expect(resolveHostConsoleCapability({
      isRemote: true,
      isPaid: false,
      licenseReady: true,
      activeNodeMeta: { capabilities: ['host-console', 'host-console-community'] },
    })).toBe('allowed');
  });

  it('locks Community when remote only has legacy host-console', () => {
    expect(resolveHostConsoleCapability({
      isRemote: true,
      isPaid: false,
      licenseReady: true,
      activeNodeMeta: { capabilities: ['host-console'] },
    })).toBe('locked');
  });

  it('allows Admiral when remote only has legacy host-console', () => {
    expect(resolveHostConsoleCapability({
      isRemote: true,
      isPaid: true,
      licenseReady: true,
      activeNodeMeta: { capabilities: ['host-console'] },
    })).toBe('allowed');
  });

  it('returns loading for legacy-only remote while license is not ready', () => {
    expect(resolveHostConsoleCapability({
      isRemote: true,
      isPaid: false,
      licenseReady: false,
      activeNodeMeta: { capabilities: ['host-console'] },
    })).toBe('loading');
  });

  it('allows community-capable remote without waiting on license', () => {
    expect(resolveHostConsoleCapability({
      isRemote: true,
      isPaid: false,
      licenseReady: false,
      activeNodeMeta: { capabilities: ['host-console-community'] },
    })).toBe('allowed');
  });

  it('locks Pilot / empty capability lists', () => {
    expect(resolveHostConsoleCapability({
      isRemote: true,
      isPaid: true,
      licenseReady: true,
      activeNodeMeta: { capabilities: ['stacks', 'fleet'] },
    })).toBe('locked');
  });
});
