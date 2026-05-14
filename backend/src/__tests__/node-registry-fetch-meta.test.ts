/**
 * F9 regression guard for NodeRegistry.fetchMetaForNode:
 *
 *  - Resolves getProxyTarget for the node and delegates to fetchRemoteMeta.
 *  - Pilot-agent with active tunnel resolves to a loopback URL with empty
 *    token; the request must reach fetchRemoteMeta with that exact shape.
 *  - Null target (proxy-mode missing api_url/api_token, or pilot-agent
 *    tunnel disconnected) returns OFFLINE_META without touching the network.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let NodeRegistry: typeof import('../services/NodeRegistry').NodeRegistry;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ NodeRegistry } = await import('../services/NodeRegistry'));
  ({ DatabaseService } = await import('../services/DatabaseService'));
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('NodeRegistry.fetchMetaForNode', () => {
  it('returns OFFLINE_META when getProxyTarget is null', async () => {
    const reg = NodeRegistry.getInstance();
    const db = DatabaseService.getInstance();
    const nodeId = db.addNode({
      name: 'meta-pilot-down',
      type: 'remote',
      mode: 'pilot_agent',
      compose_dir: '/tmp',
      is_default: false,
      api_url: '',
      api_token: '',
    });

    vi.spyOn(reg, 'getProxyTarget').mockReturnValue(null);
    const axiosSpy = vi.spyOn(axios, 'get');

    const meta = await reg.fetchMetaForNode(nodeId);

    expect(meta).toEqual({
      version: null,
      capabilities: [],
      startedAt: null,
      updateError: null,
      online: false,
    });
    expect(axiosSpy).not.toHaveBeenCalled();
    db.deleteNode(nodeId);
  });

  it('delegates to fetchRemoteMeta against the loopback URL for pilot-agent', async () => {
    const reg = NodeRegistry.getInstance();
    const db = DatabaseService.getInstance();
    const nodeId = db.addNode({
      name: 'meta-pilot-up',
      type: 'remote',
      mode: 'pilot_agent',
      compose_dir: '/tmp',
      is_default: false,
      api_url: '',
      api_token: '',
    });

    vi.spyOn(reg, 'getProxyTarget').mockReturnValue({
      apiUrl: 'http://127.0.0.1:54321',
      apiToken: '',
    });
    const axiosSpy = vi.spyOn(axios, 'get').mockResolvedValue({
      data: {
        version: '0.76.7',
        capabilities: ['stacks', 'containers'],
        startedAt: 1234,
        updateError: null,
      },
    });

    const meta = await reg.fetchMetaForNode(nodeId);

    expect(meta.version).toBe('0.76.7');
    expect(meta.capabilities).toEqual(['stacks', 'containers']);
    expect(meta.online).toBe(true);

    expect(axiosSpy).toHaveBeenCalledTimes(1);
    const url = axiosSpy.mock.calls[0][0];
    expect(url).toBe('http://127.0.0.1:54321/api/meta');
    const init = axiosSpy.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers).toEqual({});

    db.deleteNode(nodeId);
  });

  it('forwards Authorization for proxy-mode targets with non-empty tokens', async () => {
    const reg = NodeRegistry.getInstance();
    const db = DatabaseService.getInstance();
    const nodeId = db.addNode({
      name: 'meta-proxy',
      type: 'remote',
      mode: 'proxy',
      compose_dir: '/tmp',
      is_default: false,
      api_url: 'https://remote.example.com:1852',
      api_token: 'real-token',
    });

    vi.spyOn(reg, 'getProxyTarget').mockReturnValue({
      apiUrl: 'https://remote.example.com:1852',
      apiToken: 'real-token',
    });
    const axiosSpy = vi.spyOn(axios, 'get').mockResolvedValue({
      data: { version: '0.76.7', capabilities: [], startedAt: 1, updateError: null },
    });

    await reg.fetchMetaForNode(nodeId);

    const init = axiosSpy.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers).toEqual({ Authorization: 'Bearer real-token' });

    db.deleteNode(nodeId);
  });
});
