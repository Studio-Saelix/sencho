/**
 * A hub-side machine read of a remote's /api/system/stats must advertise that
 * it renders nullable host usage, or a newer nested remote answers with the
 * numeric kernel shape and the connection test reports the outer machine.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { HOST_USAGE_UNKNOWN_HEADER } from '../services/CapabilityRegistry';

vi.mock('../utils/outboundTarget', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/outboundTarget')>();
  return { ...actual, assertSafeOutboundUrl: vi.fn().mockResolvedValue(undefined) };
});

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

describe('NodeRegistry.testConnection remote host usage', () => {
  it('advertises nullable host usage on the remote system-stats probe', async () => {
    const db = DatabaseService.getInstance();
    const nodeId = db.addNode({
      name: 'nested-connection-test',
      type: 'remote',
      mode: 'proxy',
      compose_dir: '/tmp',
      is_default: false,
      api_url: 'https://remote.example.com:1852',
      api_token: 'token',
    });
    const node = db.getNode(nodeId);
    if (!node) throw new Error('expected the seeded node');

    const axiosSpy = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/api/auth/check')) return { status: 200, data: {} };
      if (url.endsWith('/api/system/stats')) {
        return {
          status: 200,
          data: {
            cpu: { usage: null, cores: 2 },
            memory: { total: 4 * 1024 ** 3, used: null, free: null, usagePercent: null },
          },
        };
      }
      if (url.endsWith('/api/stats')) return { status: 200, data: { total: 3, active: 2 } };
      if (url.endsWith('/api/system/images')) return { status: 200, data: [] };
      if (url.endsWith('/api/meta')) {
        return {
          status: 200,
          data: { version: '0.97.0', capabilities: ['host-usage-unknown-v1'] },
        };
      }
      throw new Error(`unexpected request ${url}`);
    });

    const result = await (NodeRegistry.getInstance() as unknown as {
      testRemoteConnection: (n: typeof node) => Promise<{
        success: boolean;
        info?: { memTotal: number; cpus: number | string };
      }>;
    }).testRemoteConnection(node);

    expect(result.success).toBe(true);
    const sysCall = axiosSpy.mock.calls.find((call) => String(call[0]).endsWith('/api/system/stats'));
    expect(sysCall).toBeDefined();
    const config = sysCall![1] as { headers: Record<string, string> };
    expect(config.headers[HOST_USAGE_UNKNOWN_HEADER]).toBe('1');
    expect(result.info).toMatchObject({ memTotal: 4 * 1024 ** 3, cpus: 2 });

    db.deleteNode(nodeId);
  });
});
