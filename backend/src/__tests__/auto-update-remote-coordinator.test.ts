import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  meta: vi.fn(), target: vi.fn(), checks: vi.fn(), fetch: vi.fn(), prepare: vi.fn(),
  authorize: vi.fn(), inspect: vi.fn(), roster: vi.fn(), recheck: vi.fn(),
}));
vi.mock('../services/NodeRegistry', () => ({ NodeRegistry: { getInstance: () => ({ probeRemoteMeta: mocks.meta, getProxyTarget: mocks.target }) } }));
vi.mock('../services/ImageUpdateService', () => ({ ImageUpdateService: { isChecksEnabled: mocks.checks } }));
vi.mock('../services/LicenseService', () => ({ LicenseService: { getInstance: () => ({ getProxyHeaders: () => ({ tier: 'community' }) }) } }));
vi.mock('../services/license-headers', () => ({ PROXY_TIER_HEADER: 'x-proxy-tier' }));
vi.mock('../helpers/registryDeliveryOutbound', () => ({ prepareOutboundRegistryDeliveryBody: mocks.prepare, throwRegistryDeliveryRefusal: () => { throw new Error('delivery refused'); } }));
vi.mock('../utils/outboundTarget', () => ({ safeRemoteFetch: mocks.fetch }));
vi.mock('../services/hubPostUpdateVerification', () => ({ awaitHubPostUpdateVerification: mocks.recheck }));
import { AutoUpdateRemoteCoordinator } from '../services/AutoUpdateRemoteCoordinator';

const CAPABLE = { kind: 'ok' as const, meta: { capabilities: ['remote-image-inspect-v1', 'remote-auto-update-checked-v1'] } };
const TARGET = { apiUrl: 'https://node.example', apiToken: 'token', trustedLoopback: true };
const FACTS = {
  name: 'web', model: { renderable: true as const }, services: [], observationToken: 'observation',
  images: [{ ref: 'nginx:1', localDigests: [], platform: { os: 'linux', architecture: 'amd64' }, emptyReason: 'none' as const }],
};
const scanner = () => ({ inspectRemoteStack: mocks.inspect, getRemoteRoster: mocks.roster, recheckRemoteStack: mocks.recheck });
const input = () => ({ nodeId: 2, selection: { target: 'web' } as const, caller: { kind: 'scheduled' as const, authorizeAll: mocks.authorize }, scanner: scanner() });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.meta.mockResolvedValue(CAPABLE);
  mocks.target.mockReturnValue(TARGET);
  mocks.checks.mockReturnValue(true);
  mocks.prepare.mockImplementation(async ({ body }) => ({ ok: true, body, augmented: false }));
  mocks.inspect.mockImplementation(async (_node: number, stack: string) => ({
    facts: { ...FACTS, name: stack }, imageResults: new Map([['nginx:1', { hasUpdate: true, digestUpdate: true, checkStatus: 'ok' }]]),
  }));
  mocks.fetch.mockImplementation(async (_url: string, options: RequestInit) => {
    const body = JSON.parse(String(options.body));
    return new Response(JSON.stringify({ contractVersion: 1, stack: body.stack, result: 'applied', applied: true, healthGateId: 'health' }), { status: 200 });
  });
  mocks.recheck.mockResolvedValue({ status: 'verified', source: 'hub_authority', completedAt: 1, detail: null });
});
afterEach(() => { vi.useRealTimers(); });

describe('remote automatic update coordinator', () => {
  it('authorizes the roster, applies once, verifies once, and reports the stable message', async () => {
    const result = await new AutoUpdateRemoteCoordinator().execute(input());
    expect(mocks.authorize).toHaveBeenCalledTimes(1);
    expect(mocks.inspect).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(mocks.fetch.mock.calls[0][1].body));
    expect(body).toMatchObject({ contractVersion: 1, stack: 'web', digestUpdateImages: ['nginx:1'], observationToken: 'observation' });
    expect(result).toEqual({ handled: true, result: 'Stack "web": updated (nginx:1).' });
  });

  it('expands the wildcard from the roster and authorizes every stack before work', async () => {
    mocks.roster.mockResolvedValue(['web', 'api']);
    const result = await new AutoUpdateRemoteCoordinator().execute({ ...input(), selection: { target: '*' } });
    expect(mocks.authorize).toHaveBeenCalledWith(2, ['web', 'api']);
    expect(mocks.inspect).toHaveBeenCalledTimes(2);
    expect(result.handled ? result.result : null).toContain('"api": updated');
  });

  it('falls back untouched when either checked capability is missing', async () => {
    mocks.meta.mockResolvedValue({ kind: 'ok', meta: { capabilities: [] } });
    const result = await new AutoUpdateRemoteCoordinator().execute(input());
    expect(result).toEqual({ handled: false });
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('retries exactly once after a stale observation, then skips truthfully', async () => {
    mocks.fetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ contractVersion: 1, stack: 'web', result: 'stale_observation', applied: false, healthGateId: null }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ contractVersion: 1, stack: 'web', result: 'applied', applied: true, healthGateId: 'health' }), { status: 200 }));
    const result = await new AutoUpdateRemoteCoordinator().execute(input());
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(result.handled ? result.result : null).toBe('Stack "web": updated (nginx:1).');
  });

  it('stops after the bounded second stale response without further mutation', async () => {
    mocks.fetch.mockImplementation(async () => new Response(JSON.stringify({ contractVersion: 1, stack: 'web', result: 'stale_observation', applied: false, healthGateId: null }), { status: 409 }));
    const result = await new AutoUpdateRemoteCoordinator().execute(input());
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(result.handled ? result.result : null).toContain('observation changed twice');
  });

  it('refuses an unauthorized stack before any machine execution request', async () => {
    mocks.authorize.mockRejectedValue(new Error('denied'));
    await expect(new AutoUpdateRemoteCoordinator().execute(input())).rejects.toThrow('denied');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('skips a mixed failed check rather than pulling an unverified sibling', async () => {
    mocks.inspect.mockResolvedValue({
      facts: { ...FACTS, images: [...FACTS.images, { ...FACTS.images[0], ref: 'redis:7' }] },
      imageResults: new Map([
        ['nginx:1', { hasUpdate: true, digestUpdate: true, checkStatus: 'ok' }],
        ['redis:7', { hasUpdate: false, error: 'unavailable', checkStatus: 'failed' }],
      ]),
    });
    const result = await new AutoUpdateRemoteCoordinator().execute(input());
    expect(result.handled ? result.result : null).toContain('skipped auto-update');
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('does not recheck a policy-blocked response', async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ contractVersion: 1, stack: 'web', result: 'policy_blocked', applied: false, healthGateId: null }), { status: 200 }));
    const result = await new AutoUpdateRemoteCoordinator().execute(input());
    expect(result.handled ? result.result : null).toContain('policy_blocked');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.recheck).not.toHaveBeenCalled();
  });

  it('bounds preparation separately and never sends a late mutation', async () => {
    vi.useFakeTimers();
    let finish!: (value: { facts: typeof FACTS; imageResults: Map<string, { hasUpdate: boolean; digestUpdate: boolean }> }) => void;
    mocks.inspect.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = new AutoUpdateRemoteCoordinator().execute(input());
    await vi.advanceTimersByTimeAsync(90_000);
    const result = await pending;
    expect(result.handled ? result.result : null).toContain('failed');
    finish({ facts: FACTS, imageResults: new Map([['nginx:1', { hasUpdate: true, digestUpdate: true }]]) });
    await Promise.resolve();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('does not retry or verify an unconfirmed mutation transport outcome', async () => {
    mocks.fetch.mockRejectedValue(new Error('connection lost after send'));
    const result = await new AutoUpdateRemoteCoordinator().execute(input());
    expect(result).toEqual({ handled: true, result: 'Stack "web" failed: Remote automatic update did not complete.' });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.recheck).not.toHaveBeenCalled();
  });

  it('strips control characters from failure logs', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.fetch.mockRejectedValue(new Error('boom\n[INFO] forged\rline'));
    await new AutoUpdateRemoteCoordinator().execute(input());
    expect(errorSpy).toHaveBeenCalled();
    const logged = errorSpy.mock.calls.flat().map(String).join(' ');
    expect(logged).not.toMatch(/[\r\n]/);
    expect(logged).toContain('boom[INFO] forgedline');
    errorSpy.mockRestore();
  });
});
