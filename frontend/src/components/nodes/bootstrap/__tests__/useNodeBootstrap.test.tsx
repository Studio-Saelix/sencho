import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useNodeBootstrap } from '../useNodeBootstrap';
import { BootstrapApiError, FALLBACK_CAPABILITIES } from '../bootstrapApi';
import type { BootstrapCapabilities, BootstrapPreflightResult } from '../types';

function capabilities(overrides: Partial<BootstrapCapabilities['defaults']> = {}): BootstrapCapabilities {
  return { ...FALLBACK_CAPABILITIES, defaults: { ...FALLBACK_CAPABILITIES.defaults, ...overrides } };
}

const HOST_KEY: import('../types').BootstrapHostKeyResult = {
  host: 'server.example.com',
  port: 22,
  address: '192.168.1.50',
  algorithm: 'ssh-ed25519',
  fingerprint: 'SHA256:abc',
  knownHostsLine: 'server.example.com ssh-ed25519 AAAA',
  trust: 'unknown' as const,
  pinnedFingerprint: null,
};

function result(blocked = false): BootstrapPreflightResult {
  return {
    inspection: {
      observedAt: Date.now(),
      target: { host: 'server.example.com', port: 22, username: 'ubuntu', address: '192.168.1.50' },
      hostKey: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:abc', knownHostsLine: 'line' },
      paths: {
        composeDir: {
          input: '/opt/docker/sencho', normalized: '/opt/docker/sencho', realPath: '/opt/docker/sencho', exists: true,
          isDirectory: true, isFinalSymlink: false, hasSymlinkAncestor: false, owner: 'ubuntu', group: 'ubuntu', mode: '755',
          readableByUser: true, writableByUser: true, writableBySudo: true, parentWritableByUser: true,
          nearestExistingAncestor: null, filesystem: null, freeBytes: null, probeError: null,
          stackCount: 0, stackNames: [], inventoryTruncated: false, inventoryError: null, rootComposeFile: false,
        },
        agentDir: {
          input: '/opt/sencho-agent', normalized: '/opt/sencho-agent', realPath: '/opt/sencho-agent', exists: false,
          isDirectory: false, isFinalSymlink: false, hasSymlinkAncestor: false, owner: null, group: null, mode: null,
          readableByUser: false, writableByUser: false, writableBySudo: false, parentWritableByUser: true,
          nearestExistingAncestor: '/opt', filesystem: null, freeBytes: null, probeError: null,
          entries: [], entriesTruncated: false, inventoryError: null, hasComposeFile: false, hasCaFile: false, hasMarker: false,
          markerProject: null, markerComposeDir: null, markerAgentDir: null,
        },
      },
      agent: { projectContainers: [], dataVolumeExists: false, dataVolumeNames: [], defaultDirHasComposeFile: false },
      dockerRoot: { path: '/var/lib/docker', freeBytes: 1, filesystemType: 'ext4' },
      checks: [],
      blockers: blocked ? 1 : 0,
      warnings: 0,
    },
    plan: blocked ? null : { digest: 'abc' } as never,
    blocked,
  };
}

function fakeApi() {
  return {
    capabilities: vi.fn(async () => capabilities()),
    hostKey: vi.fn(async () => HOST_KEY),
    preflight: vi.fn(async () => result()),
  };
}

function fillTarget(wizard: { setField: (field: 'targetName' | 'host' | 'username' | 'privateKey', value: string) => void }) {
  wizard.setField('targetName', 'media-server');
  wizard.setField('host', 'server.example.com');
  wizard.setField('username', 'ubuntu');
  wizard.setField('privateKey', '-----BEGIN OPENSSH PRIVATE KEY-----key');
}

describe('useNodeBootstrap', () => {
  it('prefills both directories from the capabilities response', async () => {
    const api = fakeApi();
    api.capabilities.mockResolvedValue(capabilities({ composeDir: '/srv/stacks', agentDir: '/srv/agent' }));
    const { result: hook } = renderHook(() => useNodeBootstrap({ open: true, api }));
    await waitFor(() => expect(hook.current.form.composeDir).toBe('/srv/stacks'));
    expect(hook.current.form.agentDir).toBe('/srv/agent');
    expect(hook.current.form.port).toBe('22');
  });

  it('does not overwrite a typed directory when the capabilities response lands late', async () => {
    let resolveCapabilities: ((value: BootstrapCapabilities) => void) | null = null;
    const api = {
      capabilities: vi.fn(() => new Promise<BootstrapCapabilities>((resolve) => { resolveCapabilities = resolve; })),
      hostKey: vi.fn(async () => HOST_KEY),
      preflight: vi.fn(async () => result()),
    };
    const { result: hook } = renderHook(() => useNodeBootstrap({ open: true, api }));
    await act(async () => { hook.current.setField('composeDir', '/srv/typed-stacks'); });
    await act(async () => {
      resolveCapabilities?.(capabilities({ composeDir: '/opt/server-default', agentDir: '/opt/server-agent' }));
    });
    await waitFor(() => expect(hook.current.form.agentDir).toBe('/opt/server-agent'));
    expect(hook.current.form.composeDir).toBe('/srv/typed-stacks');
  });

  it('walks target to preflight to plan and gates the preflight on a host key', async () => {
    const api = fakeApi();
    const { result: hook } = renderHook(() => useNodeBootstrap({ open: true, api }));

    await act(async () => { fillTarget(hook.current); });
    expect(await hook.current.validate()).toEqual({ ok: true, errors: [] });

    await act(async () => { await hook.current.checkHostKey(); });
    expect(hook.current.hostKey?.fingerprint).toBe('SHA256:abc');
    expect(hook.current.step).toBe('preflight');

    await act(async () => { await hook.current.runPreflight(); });
    expect(hook.current.step).toBe('plan');
    expect(hook.current.resultIsCurrent).toBe(true);
  });

  it('clears the inspection and plan when a directory changes and marks the result stale', async () => {
    const api = fakeApi();
    const { result: hook } = renderHook(() => useNodeBootstrap({ open: true, api }));
    await act(async () => { fillTarget(hook.current); });
    await act(async () => { await hook.current.checkHostKey(); });
    await act(async () => { await hook.current.runPreflight(); });
    expect(hook.current.step).toBe('plan');

    await act(async () => { hook.current.setField('composeDir', '/srv/other-stacks'); });
    expect(hook.current.result).toBeNull();
    expect(hook.current.resultIsCurrent).toBe(false);
    // A path edit keeps the host trust and lands back on the preflight step,
    // where the stale banner asks for another run.
    expect(hook.current.step).toBe('preflight');
    expect(hook.current.invalidated).toBe('paths');
    expect(hook.current.hostKey?.fingerprint).toBe('SHA256:abc');
  });

  it.each([
    ['host', 'other.example.com', 'target'],
    ['port', '2222', 'target'],
    ['username', 'deploy', 'target'],
    ['privateKey', '-----BEGIN OPENSSH PRIVATE KEY-----other', 'key'],
    ['passphrase', 'secret', 'key'],
    ['composeDir', '/srv/other-stacks', 'paths'],
    ['agentDir', '/srv/other-agent', 'paths'],
    ['targetName', 'renamed', 'name'],
  ] as const)('names the %s edit as a %s invalidation, not a path change', async (field, value, reason) => {
    const api = fakeApi();
    const { result: hook } = renderHook(() => useNodeBootstrap({ open: true, api }));
    await act(async () => { fillTarget(hook.current); });
    await act(async () => { await hook.current.checkHostKey(); });
    await act(async () => { await hook.current.runPreflight(); });
    expect(hook.current.invalidated).toBeNull();

    await act(async () => { hook.current.setField(field, value); });
    expect(hook.current.result).toBeNull();
    expect(hook.current.invalidated).toBe(reason);
  });

  it('keeps the strongest reason when a smaller edit follows, and clears it on the next result', async () => {
    const api = fakeApi();
    const { result: hook } = renderHook(() => useNodeBootstrap({ open: true, api }));
    await act(async () => { fillTarget(hook.current); });
    await act(async () => { await hook.current.checkHostKey(); });
    await act(async () => { await hook.current.runPreflight(); });

    await act(async () => { hook.current.setField('host', 'other.example.com'); });
    await act(async () => { hook.current.setField('composeDir', '/srv/other-stacks'); });
    expect(hook.current.invalidated).toBe('target');

    await act(async () => { await hook.current.checkHostKey(); });
    await act(async () => { await hook.current.runPreflight(); });
    expect(hook.current.invalidated).toBeNull();
  });

  it('shows no banner for an edit made before any preflight result exists', async () => {
    const api = fakeApi();
    const { result: hook } = renderHook(() => useNodeBootstrap({ open: true, api }));
    await act(async () => { fillTarget(hook.current); });
    await act(async () => { hook.current.setField('host', 'other.example.com'); });
    expect(hook.current.invalidated).toBeNull();
  });

  it('drops the host key when the host, port or user changes', async () => {
    const api = fakeApi();
    const { result: hook } = renderHook(() => useNodeBootstrap({ open: true, api }));
    await act(async () => { fillTarget(hook.current); });
    await act(async () => { await hook.current.checkHostKey(); });
    expect(hook.current.hostKey).not.toBeNull();
    await act(async () => { hook.current.setField('host', 'other.example.com'); });
    expect(hook.current.hostKey).toBeNull();
    expect(hook.current.trusted).toBe(false);
  });

  it('refuses to check the host key with invalid paths and reports the field', async () => {
    const api = fakeApi();
    const { result: hook } = renderHook(() => useNodeBootstrap({ open: true, api }));
    await act(async () => {
      fillTarget(hook.current);
      hook.current.setField('composeDir', '/etc/stacks');
    });
    await act(async () => { await hook.current.checkHostKey(); });
    expect(api.hostKey).not.toHaveBeenCalled();
    expect(hook.current.fieldError('composeDir')).toContain('must not be under /etc');
  });

  it('refuses nested directories', async () => {
    const api = fakeApi();
    const { result: hook } = renderHook(() => useNodeBootstrap({ open: true, api }));
    await act(async () => {
      fillTarget(hook.current);
      hook.current.setField('agentDir', '/opt/docker/sencho/agent');
    });
    await act(async () => { await hook.current.checkHostKey(); });
    expect(api.hostKey).not.toHaveBeenCalled();
    expect(hook.current.fieldError('agentDir')).toContain('must not be inside the Compose directory');
  });

  it('marks a changed pin for explicit replacement', async () => {
    const api = fakeApi();
    api.hostKey.mockResolvedValue({ ...HOST_KEY, trust: 'changed', pinnedFingerprint: 'SHA256:old' });
    const { result: hook } = renderHook(() => useNodeBootstrap({ open: true, api }));
    await act(async () => { fillTarget(hook.current); });
    await act(async () => { await hook.current.checkHostKey(); });
    expect(hook.current.hostKey?.trust).toBe('changed');
    expect(hook.current.trusted).toBe(false);
    await act(async () => { hook.current.setReplacing(true); });
    await act(async () => { await hook.current.runPreflight(); });
    expect(api.preflight).toHaveBeenCalledWith(
      expect.objectContaining({ replacePinnedFingerprint: 'SHA256:abc' }),
      expect.anything(),
    );
  });

  it('discards a keyscan response for an endpoint that changed while it was in flight', async () => {
    let resolveKey: ((value: import('../types').BootstrapHostKeyResult) => void) | null = null;
    const api = {
      capabilities: vi.fn(async () => capabilities()),
      hostKey: vi.fn(() => new Promise<import('../types').BootstrapHostKeyResult>((resolve) => { resolveKey = resolve; })),
      preflight: vi.fn(async () => result()),
    };
    const { result: hook } = renderHook(() => useNodeBootstrap({ open: true, api }));
    await act(async () => { fillTarget(hook.current); });
    let pending: Promise<void> | null = null;
    act(() => { pending = hook.current.checkHostKey(); });
    await act(async () => { hook.current.setField('host', 'other.example.com'); });
    await act(async () => {
      resolveKey?.(HOST_KEY);
      await pending;
    });
    expect(hook.current.hostKey).toBeNull();
    expect(hook.current.step).toBe('target');
  });

  it('clears the key and passphrase when the dialog closes', async () => {
    const api = fakeApi();
    const { result: hook, rerender } = renderHook(({ open }) => useNodeBootstrap({ open, api }), {
      initialProps: { open: true },
    });
    await act(async () => {
      fillTarget(hook.current);
      hook.current.setField('passphrase', 'secret');
    });
    expect(hook.current.form.privateKey).not.toBe('');
    rerender({ open: false });
    await waitFor(() => expect(hook.current.form.privateKey).toBe(''));
    expect(hook.current.form.passphrase).toBe('');
  });

  it('resets to the capabilities defaults', async () => {
    const api = fakeApi();
    const { result: hook } = renderHook(() => useNodeBootstrap({ open: true, api }));
    await act(async () => {
      fillTarget(hook.current);
      hook.current.setField('composeDir', '/srv/other');
    });
    await act(async () => { hook.current.reset(); });
    expect(hook.current.form.composeDir).toBe(FALLBACK_CAPABILITIES.defaults.composeDir);
    expect(hook.current.form.targetName).toBe('');
    expect(hook.current.step).toBe('target');
  });
});

describe('useNodeBootstrap stale responses and request ownership', () => {
  type KeyResolver = (value: import('../types').BootstrapHostKeyResult) => void;

  function deferredApi() {
    const resolvers: KeyResolver[] = [];
    const api = {
      capabilities: vi.fn(async () => capabilities()),
      hostKey: vi.fn(() => new Promise<import('../types').BootstrapHostKeyResult>((resolve) => { resolvers.push(resolve); })),
      preflight: vi.fn(async () => result()),
    };
    return { api, resolvers };
  }

  it.each([
    ['port', '2222'],
    ['username', 'deploy'],
  ] as const)('discards a keyscan response after the %s was edited', async (field, value) => {
    const { api, resolvers } = deferredApi();
    const { result: hook } = renderHook(() => useNodeBootstrap({ open: true, api }));
    await act(async () => { fillTarget(hook.current); });
    let pending: Promise<void> | null = null;
    act(() => { pending = hook.current.checkHostKey(); });
    await act(async () => { hook.current.setField(field, value); });
    await act(async () => { resolvers[0](HOST_KEY); await pending; });
    expect(hook.current.hostKey).toBeNull();
    expect(hook.current.step).toBe('target');
    expect(hook.current.busy).toBeNull();
  });

  it('discards a keyscan response that lands after a reset', async () => {
    const { api, resolvers } = deferredApi();
    const { result: hook } = renderHook(() => useNodeBootstrap({ open: true, api }));
    await act(async () => { fillTarget(hook.current); });
    let pending: Promise<void> | null = null;
    act(() => { pending = hook.current.checkHostKey(); });
    await act(async () => { hook.current.reset(); });
    await act(async () => { resolvers[0](HOST_KEY); await pending; });
    expect(hook.current.hostKey).toBeNull();
    expect(hook.current.step).toBe('target');
  });

  it('keeps the busy flag for the newer request when a superseded one settles late', async () => {
    const { api, resolvers } = deferredApi();
    const { result: hook } = renderHook(() => useNodeBootstrap({ open: true, api }));
    await act(async () => { fillTarget(hook.current); });
    let first: Promise<void> | null = null;
    let second: Promise<void> | null = null;
    act(() => { first = hook.current.checkHostKey(); });
    act(() => { second = hook.current.checkHostKey(); });
    expect(hook.current.busy).toBe('host-key');
    // The superseded request resolving must not re-enable the controls.
    await act(async () => { resolvers[0](HOST_KEY); await first; });
    expect(hook.current.busy).toBe('host-key');
    await act(async () => { resolvers[1](HOST_KEY); await second; });
    expect(hook.current.busy).toBeNull();
    expect(hook.current.hostKey?.fingerprint).toBe('SHA256:abc');
  });

  it('shows the live key and algorithm when the host key changes between scan and connect', async () => {
    const api = fakeApi();
    api.hostKey.mockResolvedValue({ ...HOST_KEY, trust: 'trusted', pinnedFingerprint: 'SHA256:abc' });
    api.preflight.mockRejectedValueOnce(new BootstrapApiError(
      'The host key changed before the preflight connected.',
      'HOST_KEY_UNTRUSTED',
      null,
      { pinnedFingerprint: 'SHA256:abc', observedFingerprint: 'SHA256:live', observedAlgorithm: 'ssh-rsa' },
    ));
    const { result: hook } = renderHook(() => useNodeBootstrap({ open: true, api }));
    await act(async () => { fillTarget(hook.current); });
    await act(async () => { await hook.current.checkHostKey(); });
    await act(async () => { await hook.current.runPreflight(); });
    expect(hook.current.hostKey).toMatchObject({
      fingerprint: 'SHA256:live',
      algorithm: 'ssh-rsa',
      knownHostsLine: '',
      trust: 'changed',
      pinnedFingerprint: 'SHA256:abc',
    });
    expect(hook.current.step).toBe('preflight');
    expect(hook.current.result).toBeNull();
    expect(hook.current.busy).toBeNull();
  });

  it('marks the key trusted once a confirmed replacement succeeded', async () => {
    const api = fakeApi();
    api.hostKey.mockResolvedValue({ ...HOST_KEY, trust: 'changed', pinnedFingerprint: 'SHA256:old' });
    const { result: hook } = renderHook(() => useNodeBootstrap({ open: true, api }));
    await act(async () => { fillTarget(hook.current); });
    await act(async () => { await hook.current.checkHostKey(); });
    await act(async () => { hook.current.setReplacing(true); });
    await act(async () => { await hook.current.runPreflight(); });
    expect(hook.current.hostKey).toMatchObject({ trust: 'trusted', pinnedFingerprint: 'SHA256:abc' });
    expect(hook.current.replacing).toBe(false);
  });
});
