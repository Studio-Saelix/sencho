/**
 * F9 regression guard for CapabilityRegistry:
 *
 *  - fetchRemoteMeta omits the Authorization header when the apiToken is
 *    empty so the loopback bridge (used by pilot-agent proxy targets) is
 *    not handed a malformed `Bearer ` header.
 *  - applyPilotModeCapabilityFilter strips host-console (whose central->pilot
 *    WS upgrade path is not yet wired) but leaves self-update in place so a
 *    Compose-deployed pilot can advertise it and the Fleet Update flow can
 *    route through NodeRegistry.getProxyTarget().
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

import {
  CAPABILITIES,
  applyPilotModeCapabilityFilter,
  enableCapability,
  fetchRemoteMeta,
  getActiveCapabilities,
} from '../services/CapabilityRegistry';

describe('fetchRemoteMeta Authorization header', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends Authorization: Bearer <token> when token is non-empty', async () => {
    const getSpy = vi.spyOn(axios, 'get').mockResolvedValue({
      data: { version: '0.76.7', capabilities: ['stacks'], startedAt: 1, updateError: null },
    });

    await fetchRemoteMeta('https://remote.example.com:1852', 'real-token');

    expect(getSpy).toHaveBeenCalledTimes(1);
    const init = getSpy.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers).toEqual({ Authorization: 'Bearer real-token' });
  });

  it('omits Authorization entirely when token is empty (pilot-agent loopback)', async () => {
    const getSpy = vi.spyOn(axios, 'get').mockResolvedValue({
      data: { version: '0.76.7', capabilities: ['stacks'], startedAt: 1, updateError: null },
    });

    await fetchRemoteMeta('http://127.0.0.1:54321', '');

    expect(getSpy).toHaveBeenCalledTimes(1);
    const init = getSpy.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers).toEqual({});
    expect(init.headers).not.toHaveProperty('Authorization');
  });

  it('returns OFFLINE_META shape on transport failure', async () => {
    vi.spyOn(axios, 'get').mockRejectedValue(new Error('connect ECONNREFUSED'));

    const meta = await fetchRemoteMeta('http://127.0.0.1:54321', '');

    expect(meta).toEqual({
      version: null,
      capabilities: [],
      startedAt: null,
      updateError: null,
      online: false,
    });
  });
});

describe('applyPilotModeCapabilityFilter', () => {
  afterEach(() => {
    enableCapability('host-console');
  });

  it('removes host-console from active capabilities', () => {
    expect(CAPABILITIES).toContain('host-console');

    applyPilotModeCapabilityFilter();
    const active = getActiveCapabilities();

    expect(active).not.toContain('host-console');
    expect(active).toContain('stacks');
  });

  it('leaves self-update in place so Compose-deployed pilots can advertise it', () => {
    expect(CAPABILITIES).toContain('self-update');

    applyPilotModeCapabilityFilter();
    const active = getActiveCapabilities();

    expect(active).toContain('self-update');
  });

  it('is idempotent (safe to call multiple times)', () => {
    applyPilotModeCapabilityFilter();
    applyPilotModeCapabilityFilter();
    const active = getActiveCapabilities();

    expect(active).not.toContain('host-console');
    expect(active.length).toBe(CAPABILITIES.length - 1);
  });
});
