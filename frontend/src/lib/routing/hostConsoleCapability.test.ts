import { describe, it, expect } from 'vitest';
import { resolveHostConsoleCapability, resolveHostConsoleLockMessage } from './hostConsoleCapability';

describe('resolveHostConsoleCapability', () => {
  it('returns loading when the active node is unresolved', () => {
    expect(resolveHostConsoleCapability({
      nodeResolved: false,
      isRemote: false,
      isPaid: false,
      licenseReady: true,
      activeNodeMeta: null,
    })).toBe('loading');
  });

  it('allows local nodes without waiting for meta', () => {
    expect(resolveHostConsoleCapability({
      nodeResolved: true,
      isRemote: false,
      isPaid: false,
      licenseReady: true,
      activeNodeMeta: null,
    })).toBe('allowed');
  });

  it('returns loading when remote meta is absent', () => {
    expect(resolveHostConsoleCapability({
      nodeResolved: true,
      isRemote: true,
      isPaid: false,
      licenseReady: true,
      activeNodeMeta: null,
    })).toBe('loading');
  });

  it('allows Community when remote advertises host-console-community', () => {
    expect(resolveHostConsoleCapability({
      nodeResolved: true,
      isRemote: true,
      isPaid: false,
      licenseReady: true,
      activeNodeMeta: { capabilities: ['host-console', 'host-console-community'] },
    })).toBe('allowed');
  });

  it('locks Community when remote only has legacy host-console', () => {
    expect(resolveHostConsoleCapability({
      nodeResolved: true,
      isRemote: true,
      isPaid: false,
      licenseReady: true,
      activeNodeMeta: { capabilities: ['host-console'] },
    })).toBe('locked');
  });

  it('allows Admiral when remote only has legacy host-console', () => {
    expect(resolveHostConsoleCapability({
      nodeResolved: true,
      isRemote: true,
      isPaid: true,
      licenseReady: true,
      activeNodeMeta: { capabilities: ['host-console'] },
    })).toBe('allowed');
  });

  it('returns loading for legacy-only remote while license is not ready', () => {
    expect(resolveHostConsoleCapability({
      nodeResolved: true,
      isRemote: true,
      isPaid: false,
      licenseReady: false,
      activeNodeMeta: { capabilities: ['host-console'] },
    })).toBe('loading');
  });

  it('allows community-capable remote without waiting on license', () => {
    expect(resolveHostConsoleCapability({
      nodeResolved: true,
      isRemote: true,
      isPaid: false,
      licenseReady: false,
      activeNodeMeta: { capabilities: ['host-console-community'] },
    })).toBe('allowed');
  });

  it('locks Pilot / empty capability lists', () => {
    expect(resolveHostConsoleCapability({
      nodeResolved: true,
      isRemote: true,
      isPaid: true,
      licenseReady: true,
      activeNodeMeta: { capabilities: ['stacks', 'fleet'] },
    })).toBe('locked');
  });
});

describe('resolveHostConsoleLockMessage', () => {
  it('returns Pilot-specific copy for a pilot_agent node regardless of version', () => {
    expect(resolveHostConsoleLockMessage({
      nodeMode: 'pilot_agent',
      nodeName: 'Pilot',
      version: '0.97.1',
    })).toEqual({
      title: 'Host Console is not available through Pilot Agent yet',
      body: 'Host Console is currently available on the local node and Distributed API Proxy remotes.',
    });
  });

  it('returns the upgrade copy for a proxy node with a real version', () => {
    expect(resolveHostConsoleLockMessage({
      nodeMode: 'proxy',
      nodeName: 'Peer',
      version: '0.95.0',
    })).toEqual({
      title: 'Host Console is not available on this node',
      body: 'Peer is running v0.95.0. Upgrade the node to use this feature.',
    });
  });

  it('returns the no-capability copy for a proxy node with a placeholder version', () => {
    expect(resolveHostConsoleLockMessage({
      nodeMode: 'proxy',
      nodeName: 'Peer',
      version: '0.0.0-dev',
    })).toEqual({
      title: 'Host Console is not available on this node',
      body: 'Peer does not advertise this capability. Upgrade the node to use this feature.',
    });
  });

  it('returns the no-capability copy for a proxy node with an unknown version', () => {
    expect(resolveHostConsoleLockMessage({
      nodeMode: 'proxy',
      nodeName: 'Peer',
      version: 'unknown',
    })).toEqual({
      title: 'Host Console is not available on this node',
      body: 'Peer does not advertise this capability. Upgrade the node to use this feature.',
    });
  });

  it('treats an undefined mode as the generic proxy fallback', () => {
    expect(resolveHostConsoleLockMessage({
      nodeMode: undefined,
      nodeName: 'Peer',
      version: null,
    })).toEqual({
      title: 'Host Console is not available on this node',
      body: 'Peer does not advertise this capability. Upgrade the node to use this feature.',
    });
  });
});
