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

// The fetch-meta classification tests all probe the same proxy-mode node
// shape; only the node name differs (each test registers its own row).
function seedProxyMetaNode(name: string): number {
  const db = DatabaseService.getInstance();
  const nodeId = db.addNode({
    name,
    type: 'remote',
    mode: 'proxy',
    compose_dir: '/tmp',
    is_default: false,
    api_url: 'https://remote.example.com:1852',
    api_token: 'token',
  });
  vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue({
    apiUrl: 'https://remote.example.com:1852',
    apiToken: 'token',
    trustedLoopback: false,
  });
  return nodeId;
}

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
      imagePinKind: null,
      updateBlocked: false, imageChannel: null,
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
      trustedLoopback: true,
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
    const init = axiosSpy.mock.calls[0][1] as { headers: Record<string, string>; httpAgent?: unknown; httpsAgent?: unknown };
    expect(init.headers).toEqual({});
    expect(init.httpAgent).toBeUndefined();
    expect(init.httpsAgent).toBeUndefined();

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
      trustedLoopback: false,
    });
    const axiosSpy = vi.spyOn(axios, 'get').mockResolvedValue({
      data: { version: '0.76.7', capabilities: [], startedAt: 1, updateError: null },
    });

    await reg.fetchMetaForNode(nodeId);

    const init = axiosSpy.mock.calls[0][1] as { headers: Record<string, string>; httpAgent?: unknown; httpsAgent?: unknown };
    expect(init.headers).toEqual({ Authorization: 'Bearer real-token' });
    expect(init.httpAgent).toBeDefined();
    expect(init.httpsAgent).toBeDefined();

    db.deleteNode(nodeId);
  });

  it('classifies a 2xx non-object JSON body as offline, not as an empty capability set', async () => {
    const reg = NodeRegistry.getInstance();
    const db = DatabaseService.getInstance();
    const nodeId = seedProxyMetaNode('meta-garbage-string');
    const metaWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(axios, 'get').mockResolvedValue({ data: 'not-a-meta-object' });

    const meta = await reg.fetchMetaForNode(nodeId);
    expect(meta.online).toBe(false);
    expect(meta.capabilities).toEqual([]);
    expect(metaWarn).toHaveBeenCalledWith(
      expect.stringContaining('malformed (not-object)'),
    );
    db.deleteNode(nodeId);
  });

  it('classifies a 2xx array body as offline', async () => {
    const reg = NodeRegistry.getInstance();
    const db = DatabaseService.getInstance();
    const nodeId = seedProxyMetaNode('meta-garbage-array');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(axios, 'get').mockResolvedValue({ data: [] });

    const meta = await reg.fetchMetaForNode(nodeId);
    expect(meta.online).toBe(false);
    db.deleteNode(nodeId);
  });

  it('classifies a 2xx object without a capabilities field as offline', async () => {
    const reg = NodeRegistry.getInstance();
    const db = DatabaseService.getInstance();
    const nodeId = seedProxyMetaNode('meta-no-capabilities');
    const metaWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(axios, 'get').mockResolvedValue({ data: { version: '0.97.1' } });

    const meta = await reg.fetchMetaForNode(nodeId);
    expect(meta.online).toBe(false);
    expect(metaWarn).toHaveBeenCalledWith(
      expect.stringContaining('malformed (capabilities-missing)'),
    );
    db.deleteNode(nodeId);
  });

  it('classifies a 2xx object with a non-array capabilities field as offline', async () => {
    const reg = NodeRegistry.getInstance();
    const db = DatabaseService.getInstance();
    const nodeId = seedProxyMetaNode('meta-capabilities-string');
    const metaWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(axios, 'get').mockResolvedValue({ data: { version: '0.97.1', capabilities: 'yes' } });

    const meta = await reg.fetchMetaForNode(nodeId);
    expect(meta.online).toBe(false);
    expect(metaWarn).toHaveBeenCalledWith(
      expect.stringContaining('malformed (capabilities-not-array)'),
    );
    db.deleteNode(nodeId);
  });

  it('classifies a capabilities array with non-string entries as offline', async () => {
    const reg = NodeRegistry.getInstance();
    const db = DatabaseService.getInstance();
    const nodeId = seedProxyMetaNode('meta-capabilities-numbers');
    const metaWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(axios, 'get').mockResolvedValue({ data: { version: '0.97.1', capabilities: [1, 2] } });

    const meta = await reg.fetchMetaForNode(nodeId);
    expect(meta.online).toBe(false);
    expect(metaWarn).toHaveBeenCalledWith(
      expect.stringContaining('malformed (capabilities-not-strings)'),
    );
    db.deleteNode(nodeId);
  });

  it('stays offline for a request failure covering timeout, disconnect, non-2xx, and invalid JSON responses', async () => {
    const reg = NodeRegistry.getInstance();
    const db = DatabaseService.getInstance();
    const nodeId = seedProxyMetaNode('meta-request-failures');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Axios throws on timeout/disconnect (network error), non-2xx status
    // (validateStatus default), and invalid JSON (parse failure), so all four
    // failure modes enter the same catch and return offline meta.
    for (const rejection of [
      new Error('timeout of 5000ms exceeded'),
      new Error('socket hang up'),
      Object.assign(new Error('Request failed with status code 502'), { response: { status: 502 } }),
      Object.assign(new Error('Unexpected token < in JSON'), { response: { status: 200, data: '<html>' } }),
    ]) {
      vi.spyOn(axios, 'get').mockReset().mockRejectedValue(rejection);
      const meta = await reg.fetchMetaForNode(nodeId);
      expect(meta.online).toBe(false);
      expect(meta.capabilities).toEqual([]);
    }
    db.deleteNode(nodeId);
  });

  it('keeps a valid 2xx object without the flag online and unsupported, never unreachable', async () => {
    const reg = NodeRegistry.getInstance();
    const db = DatabaseService.getInstance();
    const nodeId = seedProxyMetaNode('meta-valid-no-flag');
    vi.spyOn(axios, 'get').mockResolvedValue({
      data: { version: '0.97.1', capabilities: ['fleet'], startedAt: 1, updateError: null },
    });

    const meta = await reg.fetchMetaForNode(nodeId);
    expect(meta.online).toBe(true);
    expect(meta.capabilities).toEqual(['fleet']);
    db.deleteNode(nodeId);
  });
});
