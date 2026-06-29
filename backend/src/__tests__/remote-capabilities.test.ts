/**
 * Unit coverage for the cross-node-rbac capability probe used to gate
 * mixed-version cross-node operations. It probes the remote's live /api/meta on
 * every call (no cross-request caching), must fail closed when the capability
 * cannot be determined, and must re-verify each time so a downgraded remote is
 * detected immediately rather than trusted from a stale verdict.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import type { RemoteMeta } from '../services/CapabilityRegistry';

let remoteSupportsCrossNodeRbac: typeof import('../helpers/remoteCapabilities').remoteSupportsCrossNodeRbac;
let NodeRegistry: typeof import('../services/NodeRegistry').NodeRegistry;
let tmpDir: string;

const NODE_ID = 4242;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ remoteSupportsCrossNodeRbac } = await import('../helpers/remoteCapabilities'));
  ({ NodeRegistry } = await import('../services/NodeRegistry'));
});

afterAll(() => cleanupTestDb(tmpDir));

afterEach(() => vi.restoreAllMocks());

const ONLINE = { startedAt: null, updateError: null, online: true } as const;
const capable: RemoteMeta = { version: '0.93.0', capabilities: ['fleet', 'cross-node-rbac'], ...ONLINE };
const incapable: RemoteMeta = { version: '0.92.0', capabilities: ['fleet', 'labels'], ...ONLINE };

describe('remoteSupportsCrossNodeRbac', () => {
  it('returns true when the remote advertises cross-node-rbac', async () => {
    vi.spyOn(NodeRegistry.getInstance(), 'fetchMetaForNode').mockResolvedValue(capable);
    expect(await remoteSupportsCrossNodeRbac(NODE_ID)).toBe(true);
  });

  it('returns false when the remote does not advertise it', async () => {
    vi.spyOn(NodeRegistry.getInstance(), 'fetchMetaForNode').mockResolvedValue(incapable);
    expect(await remoteSupportsCrossNodeRbac(NODE_ID)).toBe(false);
  });

  it('fails closed when the remote is offline (empty capabilities)', async () => {
    vi.spyOn(NodeRegistry.getInstance(), 'fetchMetaForNode')
      .mockResolvedValue({ version: null, capabilities: [], startedAt: null, updateError: null, online: false });
    expect(await remoteSupportsCrossNodeRbac(NODE_ID)).toBe(false);
  });

  it('trusts a reachable remote that advertises the capability even with a non-semver version', async () => {
    // A 0.0.0-dev image reports version null (non-semver) but is reachable and
    // genuinely advertises the capability; it must not be wrongly denied.
    vi.spyOn(NodeRegistry.getInstance(), 'fetchMetaForNode')
      .mockResolvedValue({ version: null, capabilities: ['fleet', 'cross-node-rbac'], startedAt: null, updateError: null, online: true });
    expect(await remoteSupportsCrossNodeRbac(NODE_ID)).toBe(true);
  });

  it('fails closed when the meta fetch throws (unreachable)', async () => {
    vi.spyOn(NodeRegistry.getInstance(), 'fetchMetaForNode').mockRejectedValue(new Error('unreachable'));
    expect(await remoteSupportsCrossNodeRbac(NODE_ID)).toBe(false);
  });

  it('re-probes on every call so a downgraded remote is detected immediately (no stale verdict)', async () => {
    const spy = vi.spyOn(NodeRegistry.getInstance(), 'fetchMetaForNode')
      .mockResolvedValueOnce(capable)   // first probe: current remote
      .mockResolvedValue(incapable);    // after the remote is swapped for older code
    expect(await remoteSupportsCrossNodeRbac(NODE_ID)).toBe(true);
    expect(await remoteSupportsCrossNodeRbac(NODE_ID)).toBe(false);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('dedupes concurrent probes for the same node into a single fetch', async () => {
    const spy = vi.spyOn(NodeRegistry.getInstance(), 'fetchMetaForNode').mockResolvedValue(capable);
    const [a, b] = await Promise.all([
      remoteSupportsCrossNodeRbac(NODE_ID),
      remoteSupportsCrossNodeRbac(NODE_ID),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
