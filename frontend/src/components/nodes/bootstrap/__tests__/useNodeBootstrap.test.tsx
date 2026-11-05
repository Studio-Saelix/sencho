import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useNodeBootstrap } from '../useNodeBootstrap';
import { FALLBACK_CAPABILITIES } from '../bootstrapApi';
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
          stackCount: 0, stackNames: [], inventoryTruncated: false, rootComposeFile: false,
        },
        agentDir: {
          input: '/opt/sencho-agent', normalized: '/opt/sencho-agent', realPath: '/opt/sencho-agent', exists: false,
          isDirectory: false, isFinalSymlink: false, hasSymlinkAncestor: false, owner: null, group: null, mode: null,
          readableByUser: false, writableByUser: false, writableBySudo: false, parentWritableByUser: true,
          nearestExistingAncestor: '/opt', filesystem: null, freeBytes: null, probeError: null,
          entries: [], entriesTruncated: false, hasComposeFile: false, hasCaFile: false, hasMarker: false,
          markerProject: null, markerComposeDir: null, markerAgentDir: null,
        },
      },
      agent: { projectContainers: [], dataVolumeExists: false, defaultDirHasComposeFile: false },
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
    expect(hook.current.invalidated).toBe(true);
    expect(hook.current.hostKey?.fingerprint).toBe('SHA256:abc');
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
