import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/api';
import {
  BootstrapApiError,
  FALLBACK_CAPABILITIES,
  checkBootstrapHostKey,
  fetchBootstrapCapabilities,
  fetchBootstrapOperation,
  listBootstrapOperations,
  releaseBootstrapOperation,
  runBootstrapPreflight,
} from '../bootstrapApi';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('bootstrapApi', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('requests capabilities locally only', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonResponse(FALLBACK_CAPABILITIES));
    const result = await fetchBootstrapCapabilities();
    expect(result.defaults.composeDir).toBe('/opt/docker/sencho');
    expect(apiFetch).toHaveBeenCalledWith('/nodes/bootstrap/capabilities', expect.objectContaining({ localOnly: true }));
  });

  it('falls back to the local defaults when the capabilities request fails', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('offline'));
    const result = await fetchBootstrapCapabilities();
    expect(result.defaults).toEqual({ composeDir: '/opt/docker/sencho', agentDir: '/opt/sencho-agent' });
  });

  it('checks a host key locally and parses the fingerprint', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonResponse({
      host: 'server.example.com',
      port: 22,
      address: '192.168.1.50',
      algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:abc',
      knownHostsLine: 'line',
      trust: 'unknown',
      pinnedFingerprint: null,
    }));
    const result = await checkBootstrapHostKey({ host: 'server.example.com', port: 22 });
    expect(result.fingerprint).toBe('SHA256:abc');
    const [, options] = vi.mocked(apiFetch).mock.calls[0];
    expect(options?.localOnly).toBe(true);
    expect(options?.method).toBe('POST');
    expect(JSON.parse(String(options?.body))).toEqual({ host: 'server.example.com', port: 22 });
  });

  it('maps an error body to a typed error with its code and field', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonResponse({
      error: 'The Compose stacks directory must not be under /etc.',
      code: 'INVALID_PATH',
      field: 'composeDir',
    }, 400));
    await expect(runBootstrapPreflight({
      host: 'server.example.com',
      port: 22,
      username: 'ubuntu',
      privateKey: 'key',
      passphrase: null,
      expectedFingerprint: 'SHA256:abc',
      replacePinnedFingerprint: null,
      reviewedPinnedFingerprint: null,
      targetName: 'media-server',
      composeDir: '/etc/stacks',
      agentDir: '/opt/sencho-agent',
    })).rejects.toMatchObject({ code: 'INVALID_PATH', field: 'composeDir' });

    try {
      await runBootstrapPreflight({
        host: 'server.example.com',
        port: 22,
        username: 'ubuntu',
        privateKey: 'key',
        passphrase: null,
        expectedFingerprint: 'SHA256:abc',
        replacePinnedFingerprint: null,
        reviewedPinnedFingerprint: null,
        targetName: 'media-server',
        composeDir: '/etc/stacks',
        agentDir: '/opt/sencho-agent',
      });
    } catch (error) {
      expect(error).toBeInstanceOf(BootstrapApiError);
    }
  });

  it('sends both paths and the replacement confirmation explicitly', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonResponse({ inspection: {}, plan: null, blocked: true }));
    await runBootstrapPreflight({
      host: 'server.example.com',
      port: 22,
      username: 'ubuntu',
      privateKey: 'key',
      passphrase: 'pass',
      expectedFingerprint: 'SHA256:abc',
      replacePinnedFingerprint: 'SHA256:def',
      reviewedPinnedFingerprint: 'SHA256:old',
      targetName: 'media-server',
      composeDir: '/srv/stacks',
      agentDir: '/srv/agent',
    });
    const [, options] = vi.mocked(apiFetch).mock.calls[0];
    const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
    expect(body.composeDir).toBe('/srv/stacks');
    expect(body.agentDir).toBe('/srv/agent');
    expect(body.replacePinnedFingerprint).toBe('SHA256:def');
    expect(body.reviewedPinnedFingerprint).toBe('SHA256:old');
  });
  it('reads the first page without a cursor and the next one with it, URL-encoded', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(jsonResponse({ operations: [{ id: 'a' }], nextCursor: 'c+/=' }))
      .mockResolvedValueOnce(jsonResponse({ operations: [{ id: 'b' }] }));
    const first = await listBootstrapOperations();
    expect(first).toEqual({ operations: [{ id: 'a', nodeExists: null }], nextCursor: 'c+/=' });
    const second = await listBootstrapOperations(undefined, first.nextCursor);
    expect(second).toEqual({ operations: [{ id: 'b', nodeExists: null }], nextCursor: null });
    expect(vi.mocked(apiFetch).mock.calls[0][0]).toBe('/nodes/bootstrap/operations');
    expect(vi.mocked(apiFetch).mock.calls[1][0]).toBe('/nodes/bootstrap/operations?cursor=c%2B%2F%3D');
  });

  it('reads a missing nodeExists as unknown on the detail, list, and mutation responses', async () => {
    // A hub older than the field sends no nodeExists at all.
    const legacy = { id: 'op-1', nodeId: 4 };
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(jsonResponse(legacy))
      .mockResolvedValueOnce(jsonResponse({ operations: [legacy], nextCursor: null }))
      .mockResolvedValueOnce(jsonResponse(legacy));
    await expect(fetchBootstrapOperation('op-1')).resolves.toMatchObject({ nodeExists: null });
    const page = await listBootstrapOperations();
    expect(page.operations[0].nodeExists).toBeNull();
    await expect(releaseBootstrapOperation('op-1')).resolves.toMatchObject({ nodeExists: null });
  });

  it('keeps an explicit nodeExists answer on the detail, list, and mutation responses', async () => {
    const present = { id: 'op-1', nodeId: 4, nodeExists: true };
    const deleted = { id: 'op-2', nodeId: 5, nodeExists: false };
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(jsonResponse(present))
      .mockResolvedValueOnce(jsonResponse({ operations: [present, deleted], nextCursor: null }))
      .mockResolvedValueOnce(jsonResponse(deleted));
    await expect(fetchBootstrapOperation('op-1')).resolves.toMatchObject({ nodeExists: true });
    const page = await listBootstrapOperations();
    expect(page.operations.map((entry) => entry.nodeExists)).toEqual([true, false]);
    await expect(releaseBootstrapOperation('op-2')).resolves.toMatchObject({ nodeExists: false });
  });
});
