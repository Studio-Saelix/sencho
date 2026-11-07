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
  ] as const)('maps a %s edit to the %s invalidation', async (field, value, reason) => {
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

  it.each([
    ['composeDir', 'host', 'target'],
    ['targetName', 'composeDir', 'paths'],
    ['composeDir', 'privateKey', 'key'],
    ['host', 'privateKey', 'target'],
    ['privateKey', 'composeDir', 'key'],
  ] as const)('after a %s edit, a %s edit leaves the %s banner', async (first, second, expected) => {
    const api = fakeApi();
    const { result: hook } = renderHook(() => useNodeBootstrap({ open: true, api }));
    await act(async () => { fillTarget(hook.current); });
    await act(async () => { await hook.current.checkHostKey(); });
    await act(async () => { await hook.current.runPreflight(); });

    await act(async () => { hook.current.setField(first, first === 'composeDir' ? '/srv/a' : 'changed-a'); });
    await act(async () => { hook.current.setField(second, second === 'composeDir' ? '/srv/b' : 'changed-b'); });
    expect(hook.current.invalidated).toBe(expected);
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
      expect.objectContaining({ replacePinnedFingerprint: 'SHA256:abc', reviewedPinnedFingerprint: 'SHA256:old' }),
      expect.anything(),
    );
  });

  it('sends no replacement confirmation, and no reviewed pin, for a trusted or first-seen key', async () => {
    const api = fakeApi();
    const { result: hook } = renderHook(() => useNodeBootstrap({ open: true, api }));
    await act(async () => { fillTarget(hook.current); });
    await act(async () => { await hook.current.checkHostKey(); });
    await act(async () => { hook.current.setTrusted(true); });
    await act(async () => { await hook.current.runPreflight(); });
    expect(api.preflight).toHaveBeenCalledWith(
      expect.objectContaining({ replacePinnedFingerprint: null, reviewedPinnedFingerprint: null }),
      expect.anything(),
    );
  });

  it('names the pin the server reported as current when the replacement is confirmed after a mismatch', async () => {
    const api = fakeApi();
    api.hostKey.mockResolvedValue({ ...HOST_KEY, trust: 'changed', pinnedFingerprint: 'SHA256:scanned' });
    api.preflight.mockRejectedValueOnce(new BootstrapApiError(
      'The host key does not match the pinned key.',
      'HOST_KEY_MISMATCH',
      null,
      { pinnedFingerprint: 'SHA256:newer', expectedFingerprint: 'SHA256:abc' },
    ));
    const { result: hook } = renderHook(() => useNodeBootstrap({ open: true, api }));
    await act(async () => { fillTarget(hook.current); });
    await act(async () => { await hook.current.checkHostKey(); });
    await act(async () => { hook.current.setReplacing(true); });
    await act(async () => { await hook.current.runPreflight(); });
    expect(api.preflight).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ reviewedPinnedFingerprint: 'SHA256:scanned' }),
      expect.anything(),
    );
    // The stale confirmation is spent: the operator must review the newer pin.
    expect(hook.current.replacing).toBe(false);
    expect(hook.current.hostKey).toMatchObject({ trust: 'changed', pinnedFingerprint: 'SHA256:newer' });
    await act(async () => { await hook.current.runPreflight(true); });
    expect(api.preflight).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ replacePinnedFingerprint: 'SHA256:abc', reviewedPinnedFingerprint: 'SHA256:newer' }),
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

  it('names the pin the server reported when the live key changed between the scan and the connection', async () => {
    const api = fakeApi();
    api.hostKey.mockResolvedValue({ ...HOST_KEY, trust: 'trusted', pinnedFingerprint: 'SHA256:abc' });
    api.preflight.mockRejectedValueOnce(new BootstrapApiError(
      'The host key changed before the preflight connected.',
      'HOST_KEY_UNTRUSTED',
      null,
      { pinnedFingerprint: 'SHA256:pinned', observedFingerprint: 'SHA256:live', observedAlgorithm: 'ssh-rsa' },
    ));
    const { result: hook } = renderHook(() => useNodeBootstrap({ open: true, api }));
    await act(async () => { fillTarget(hook.current); });
    await act(async () => { await hook.current.checkHostKey(); });
    await act(async () => { await hook.current.runPreflight(); });
    await act(async () => { hook.current.setReplacing(true); });
    await act(async () => { await hook.current.runPreflight(); });
    expect(api.preflight).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        expectedFingerprint: 'SHA256:live',
        replacePinnedFingerprint: 'SHA256:live',
        reviewedPinnedFingerprint: 'SHA256:pinned',
      }),
      expect.anything(),
    );
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

describe('useNodeBootstrap preflight replies that land after the configuration changed', () => {
  type Settle = { resolve: (value: BootstrapPreflightResult) => void; reject: (error: unknown) => void };
  const EDITS = [
    ['targetName', 'other-name', 'name'],
    ['host', 'other.example.com', 'target'],
    ['port', '2222', 'target'],
    ['username', 'deploy', 'target'],
    ['privateKey', '-----BEGIN OPENSSH PRIVATE KEY-----other', 'key'],
    ['passphrase', 'secret', 'key'],
    ['composeDir', '/srv/stacks', 'paths'],
    ['agentDir', '/srv/agent', 'paths'],
  ] as const;

  function pendingApi() {
    const settles: Settle[] = [];
    const api = {
      capabilities: vi.fn(async () => capabilities()),
      hostKey: vi.fn(async () => ({ ...HOST_KEY, trust: 'trusted' as const, pinnedFingerprint: HOST_KEY.fingerprint })),
      preflight: vi.fn(() => new Promise<BootstrapPreflightResult>((resolve, reject) => { settles.push({ resolve, reject }); })),
    };
    return { api, settles };
  }

  async function startPreflightThenGoBack(api: ReturnType<typeof pendingApi>['api']) {
    const hook = renderHook(() => useNodeBootstrap({ open: true, api }));
    await act(async () => { fillTarget(hook.result.current); });
    await act(async () => { await hook.result.current.checkHostKey(); });
    let pending: Promise<void> | null = null;
    act(() => { pending = hook.result.current.runPreflight(); });
    expect(hook.result.current.busy).toBe('preflight');
    await act(async () => { hook.result.current.back(); });
    expect(hook.result.current.step).toBe('target');
    return { hook, pending: () => pending as Promise<void> };
  }

  it.each(EDITS)('ignores a successful reply that lands after %s was edited', async (field, value, reason) => {
    const { api, settles } = pendingApi();
    const { hook, pending } = await startPreflightThenGoBack(api);
    await act(async () => { hook.result.current.setField(field, value); });
    const before = { step: hook.result.current.step, hostKey: hook.result.current.hostKey };
    await act(async () => { settles[0].resolve(result()); await pending(); });
    expect(hook.result.current.result).toBeNull();
    expect(hook.result.current.step).toBe(before.step);
    expect(hook.result.current.step).toBe('target');
    expect(hook.result.current.hostKey).toBe(before.hostKey);
    expect(hook.result.current.invalidated).toBe(reason);
    expect(hook.result.current.busy).toBeNull();
    expect(hook.result.current.form[field]).toBe(value);
  });

  it.each(EDITS)('ignores a failed reply that lands after %s was edited', async (field, value, reason) => {
    const { api, settles } = pendingApi();
    const { hook, pending } = await startPreflightThenGoBack(api);
    await act(async () => { hook.result.current.setField(field, value); });
    const hostKey = hook.result.current.hostKey;
    await act(async () => {
      settles[0].reject(new BootstrapApiError('The preflight failed.', 'HOST_KEY_MISMATCH', null, { pinnedFingerprint: 'SHA256:other' }));
      await pending();
    });
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.step).toBe('target');
    expect(hook.result.current.hostKey).toBe(hostKey);
    expect(hook.result.current.invalidated).toBe(reason);
    expect(hook.result.current.busy).toBeNull();
  });

  it.each(['composeDir', 'privateKey'] as const)('keeps the banner and the step when a late reply follows a %s edit made from the preflight step', async (field) => {
    const { api, settles } = pendingApi();
    const hook = renderHook(() => useNodeBootstrap({ open: true, api }));
    await act(async () => { fillTarget(hook.result.current); });
    await act(async () => { await hook.result.current.checkHostKey(); });
    let pending: Promise<void> | null = null;
    act(() => { pending = hook.result.current.runPreflight(); });
    await act(async () => { hook.result.current.setField(field, field === 'composeDir' ? '/srv/stacks' : 'new-key'); });
    expect(hook.result.current.step).toBe('preflight');
    expect(hook.result.current.busy).toBeNull();
    await act(async () => { settles[0].resolve(result()); await pending; });
    expect(hook.result.current.step).toBe('preflight');
    expect(hook.result.current.result).toBeNull();
    expect(hook.result.current.invalidated).toBe(field === 'composeDir' ? 'paths' : 'key');
  });

  it('ignores a late preflight reply after the host key was checked again without an edit', async () => {
    const { api, settles } = pendingApi();
    const { hook, pending } = await startPreflightThenGoBack(api);
    await act(async () => { await hook.result.current.checkHostKey(); });
    expect(hook.result.current.step).toBe('preflight');
    await act(async () => { settles[0].resolve(result()); await pending(); });
    expect(hook.result.current.result).toBeNull();
    expect(hook.result.current.step).toBe('preflight');
    expect(hook.result.current.busy).toBeNull();
  });

  it('ignores a late preflight reply after the dialog was closed and reopened', async () => {
    const { api, settles } = pendingApi();
    let open = true;
    const hook = renderHook(() => useNodeBootstrap({ open, api }));
    await act(async () => { fillTarget(hook.result.current); });
    await act(async () => { await hook.result.current.checkHostKey(); });
    let pending: Promise<void> | null = null;
    act(() => { pending = hook.result.current.runPreflight(); });
    open = false;
    hook.rerender();
    open = true;
    hook.rerender();
    await act(async () => { settles[0].resolve(result()); await pending; });
    expect(hook.result.current.result).toBeNull();
    expect(hook.result.current.step).toBe('preflight');
    expect(hook.result.current.busy).toBeNull();
  });

  it('lets only the newest of two overlapping preflights apply, whichever settles first', async () => {
    const { api, settles } = pendingApi();
    const { hook, pending } = await startPreflightThenGoBack(api);
    await act(async () => { hook.result.current.setField('composeDir', '/srv/stacks'); });
    let second: Promise<void> | null = null;
    act(() => { second = hook.result.current.runPreflight(); });
    expect(settles).toHaveLength(2);
    expect(hook.result.current.busy).toBe('preflight');
    // The superseded request settling must not clear the newer request's busy flag or result.
    await act(async () => { settles[0].resolve(result()); await pending(); });
    expect(hook.result.current.busy).toBe('preflight');
    expect(hook.result.current.result).toBeNull();
    await act(async () => { settles[1].resolve(result()); await second; });
    expect(hook.result.current.busy).toBeNull();
    expect(hook.result.current.step).toBe('plan');
    expect(hook.result.current.resultIsCurrent).toBe(true);
    expect(hook.result.current.invalidated).toBeNull();
  });

  it('does not let a superseded reply that settles after the newer one replace its result', async () => {
    const { api, settles } = pendingApi();
    const { hook, pending } = await startPreflightThenGoBack(api);
    await act(async () => { hook.result.current.setField('agentDir', '/srv/agent'); });
    let second: Promise<void> | null = null;
    act(() => { second = hook.result.current.runPreflight(); });
    const newest = result(true);
    await act(async () => { settles[1].resolve(newest); await second; });
    expect(hook.result.current.result).toBe(newest);
    await act(async () => { settles[0].resolve(result()); await pending(); });
    expect(hook.result.current.result).toBe(newest);
    expect(hook.result.current.step).toBe('preflight');
  });

  it('still applies a reply for the current configuration', async () => {
    const { api, settles } = pendingApi();
    const hook = renderHook(() => useNodeBootstrap({ open: true, api }));
    await act(async () => { fillTarget(hook.result.current); });
    await act(async () => { await hook.result.current.checkHostKey(); });
    let pending: Promise<void> | null = null;
    act(() => { pending = hook.result.current.runPreflight(); });
    await act(async () => { settles[0].resolve(result()); await pending; });
    expect(hook.result.current.step).toBe('plan');
    expect(hook.result.current.busy).toBeNull();
  });
});
