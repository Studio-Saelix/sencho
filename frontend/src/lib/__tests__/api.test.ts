/**
 * Unit tests for apiFetch's request shape, specifically the header merge.
 *
 * Regression guard: callers that pass a `headers` field must not lose the
 * default Content-Type and x-node-id that apiFetch builds. An earlier shape
 * spread fetchOptions over defaultOptions at the outer level after merging
 * headers into defaultOptions.headers, which silently clobbered the merge
 * when the caller supplied any `headers` value.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiFetch, DEPLOY_SESSION_HEADER, withDeploySession } from '../api';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;
  try { localStorage.removeItem('sencho-active-node'); } catch { /* jsdom */ }
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function lastFetchInit(): RequestInit {
  const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
  return calls[calls.length - 1][1] as RequestInit;
}

describe('apiFetch header merge', () => {
  it('always sets Content-Type: application/json on the outgoing request', async () => {
    await apiFetch('/health');
    const init = lastFetchInit();
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('preserves Content-Type even when the caller supplies a custom header', async () => {
    await apiFetch('/stacks/foo/files/content?path=app.txt', {
      method: 'PUT',
      headers: { 'If-Match': '"1700000000000"' },
      body: JSON.stringify({ content: 'hi' }),
    });
    const init = lastFetchInit();
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['If-Match']).toBe('"1700000000000"');
  });

  it('merges x-node-id when an active node is set even when caller supplies headers', async () => {
    localStorage.setItem('sencho-active-node', '7');
    await apiFetch('/stacks/foo/files', {
      method: 'GET',
      headers: { 'X-Trace-Id': 'abc' },
    });
    const init = lastFetchInit();
    const headers = init.headers as Record<string, string>;
    expect(headers['x-node-id']).toBe('7');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Trace-Id']).toBe('abc');
    localStorage.removeItem('sencho-active-node');
  });

  it('honours localOnly to skip x-node-id', async () => {
    localStorage.setItem('sencho-active-node', '7');
    await apiFetch('/stacks/foo/files', { localOnly: true, headers: { 'If-Match': '"1"' } });
    const init = lastFetchInit();
    const headers = init.headers as Record<string, string>;
    expect(headers['x-node-id']).toBeUndefined();
    expect(headers['If-Match']).toBe('"1"');
    expect(headers['Content-Type']).toBe('application/json');
    localStorage.removeItem('sencho-active-node');
  });
});

describe('apiFetch nodeId override', () => {
  it('targets the explicit node, overriding a different active node', async () => {
    localStorage.setItem('sencho-active-node', '7');
    await apiFetch('/stacks/foo/deploy', { method: 'POST', nodeId: 3 });
    const init = lastFetchInit();
    expect((init.headers as Record<string, string>)['x-node-id']).toBe('3');
    localStorage.removeItem('sencho-active-node');
  });

  it('targets the local node (omits x-node-id) when nodeId is null, even with an active node set', async () => {
    localStorage.setItem('sencho-active-node', '7');
    await apiFetch('/stacks/foo/deploy', { method: 'POST', nodeId: null });
    const init = lastFetchInit();
    expect((init.headers as Record<string, string>)['x-node-id']).toBeUndefined();
    localStorage.removeItem('sencho-active-node');
  });

  it('falls back to the active node when nodeId is undefined', async () => {
    localStorage.setItem('sencho-active-node', '7');
    await apiFetch('/stacks/foo/deploy', { method: 'POST' });
    const init = lastFetchInit();
    expect((init.headers as Record<string, string>)['x-node-id']).toBe('7');
    localStorage.removeItem('sencho-active-node');
  });

  it('does not leak the nodeId option onto the outgoing fetch init', async () => {
    await apiFetch('/stacks/foo/deploy', { method: 'POST', nodeId: 3 });
    const init = lastFetchInit() as RequestInit & { nodeId?: unknown };
    expect(init.nodeId).toBeUndefined();
  });
});

describe('withDeploySession', () => {
  it('uses the canonical header name (kept in sync with the backend)', () => {
    expect(DEPLOY_SESSION_HEADER).toBe('x-deploy-session-id');
  });

  it('tags a bare POST with the session header', () => {
    const opts = withDeploySession('sess-123', { method: 'POST' });
    expect(opts.method).toBe('POST');
    expect((opts.headers as Record<string, string>)[DEPLOY_SESSION_HEADER]).toBe('sess-123');
  });

  it('preserves caller body and headers without clobbering them', () => {
    const opts = withDeploySession('sess-abc', {
      method: 'POST',
      body: JSON.stringify({ a: 1 }),
      headers: { 'X-Custom': 'keep' },
    });
    const headers = opts.headers as Record<string, string>;
    expect(opts.method).toBe('POST');
    expect(opts.body).toBe(JSON.stringify({ a: 1 }));
    expect(headers['X-Custom']).toBe('keep');
    expect(headers[DEPLOY_SESSION_HEADER]).toBe('sess-abc');
  });
});
