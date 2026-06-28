/**
 * Unit coverage for the cross-node-rbac capability probe used to gate
 * mixed-version cross-node operations. It reads the shared remote-meta cache
 * (fetching once on a cold miss) and must fail closed: a node whose capability
 * cannot be determined is treated as unsupported.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import type { RemoteMeta } from '../services/CapabilityRegistry';

let remoteSupportsCrossNodeRbac: typeof import('../helpers/remoteCapabilities').remoteSupportsCrossNodeRbac;
let NodeRegistry: typeof import('../services/NodeRegistry').NodeRegistry;
let CacheService: typeof import('../services/CacheService').CacheService;
let tmpDir: string;

const NODE_ID = 4242;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ remoteSupportsCrossNodeRbac } = await import('../helpers/remoteCapabilities'));
  ({ NodeRegistry } = await import('../services/NodeRegistry'));
  ({ CacheService } = await import('../services/CacheService'));
});

afterAll(() => cleanupTestDb(tmpDir));

afterEach(() => {
  vi.restoreAllMocks();
  CacheService.getInstance().invalidate(`remote-meta:${NODE_ID}`);
});

function mockMeta(meta: RemoteMeta): void {
  vi.spyOn(NodeRegistry.getInstance(), 'fetchMetaForNode').mockResolvedValue(meta);
}

const ONLINE = { startedAt: null, updateError: null, online: true } as const;

describe('remoteSupportsCrossNodeRbac', () => {
  it('returns true when the remote advertises cross-node-rbac', async () => {
    mockMeta({ version: '0.93.0', capabilities: ['fleet', 'cross-node-rbac'], ...ONLINE });
    expect(await remoteSupportsCrossNodeRbac(NODE_ID)).toBe(true);
  });

  it('returns false when the remote does not advertise it', async () => {
    mockMeta({ version: '0.92.0', capabilities: ['fleet', 'labels'], ...ONLINE });
    expect(await remoteSupportsCrossNodeRbac(NODE_ID)).toBe(false);
  });

  it('fails closed when the remote meta has no resolvable version', async () => {
    mockMeta({ version: null, capabilities: [], startedAt: null, updateError: null, online: false });
    expect(await remoteSupportsCrossNodeRbac(NODE_ID)).toBe(false);
  });

  it('fails closed when the meta fetch throws (unreachable)', async () => {
    vi.spyOn(NodeRegistry.getInstance(), 'fetchMetaForNode').mockRejectedValue(new Error('unreachable'));
    expect(await remoteSupportsCrossNodeRbac(NODE_ID)).toBe(false);
  });
});
