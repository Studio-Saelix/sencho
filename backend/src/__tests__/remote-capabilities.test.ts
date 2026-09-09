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
let remoteAdvertisesCapability: typeof import('../helpers/remoteCapabilities').remoteAdvertisesCapability;
let probeRemoteCapability: typeof import('../helpers/remoteCapabilities').probeRemoteCapability;
let NodeRegistry: typeof import('../services/NodeRegistry').NodeRegistry;
let tmpDir: string;

const NODE_ID = 4242;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ remoteSupportsCrossNodeRbac, remoteAdvertisesCapability, probeRemoteCapability } = await import('../helpers/remoteCapabilities'));
  ({ NodeRegistry } = await import('../services/NodeRegistry'));
});

afterAll(() => cleanupTestDb(tmpDir));

afterEach(() => vi.restoreAllMocks());

const ONLINE = { startedAt: null, updateError: null, online: true, imagePinKind: null, updateBlocked: false, imageChannel: null } as const;
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
      .mockResolvedValue({ version: null, capabilities: [], startedAt: null, updateError: null, online: false, imagePinKind: null, updateBlocked: false, imageChannel: null });
    expect(await remoteSupportsCrossNodeRbac(NODE_ID)).toBe(false);
  });

  it('trusts a reachable remote that advertises the capability even with a non-semver version', async () => {
    // A 0.0.0-dev image reports version null (non-semver) but is reachable and
    // genuinely advertises the capability; it must not be wrongly denied.
    vi.spyOn(NodeRegistry.getInstance(), 'fetchMetaForNode')
      .mockResolvedValue({ version: null, capabilities: ['fleet', 'cross-node-rbac'], startedAt: null, updateError: null, online: true, imagePinKind: null, updateBlocked: false, imageChannel: null });
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

describe('remoteAdvertisesCapability', () => {
  it('returns true when the remote advertises the requested capability', async () => {
    vi.spyOn(NodeRegistry.getInstance(), 'fetchMetaForNode')
      .mockResolvedValue({ version: '0.93.0', capabilities: ['stack-down-remove-volumes'], ...ONLINE });
    expect(await remoteAdvertisesCapability(NODE_ID, 'stack-down-remove-volumes')).toBe(true);
  });

  it('dedupes concurrent probes per node+capability, not per node alone', async () => {
    const spy = vi.spyOn(NodeRegistry.getInstance(), 'fetchMetaForNode')
      .mockResolvedValue({ version: '0.93.0', capabilities: ['cross-node-rbac', 'stack-down-remove-volumes'], ...ONLINE });
    const [rbac, volumes] = await Promise.all([
      remoteAdvertisesCapability(NODE_ID, 'cross-node-rbac'),
      remoteAdvertisesCapability(NODE_ID, 'stack-down-remove-volumes'),
    ]);
    expect(rbac).toBe(true);
    expect(volumes).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('probeRemoteCapability', () => {
  const CAP = 'remote-registry-exact-ref-proof-v1';

  it('returns supported for a valid online metadata that advertises the capability', async () => {
    vi.spyOn(NodeRegistry.getInstance(), 'fetchMetaForNode')
      .mockResolvedValue({ version: '0.97.1', capabilities: ['fleet', CAP], ...ONLINE });
    expect(await probeRemoteCapability(NODE_ID, CAP)).toBe('supported');
  });

  it('returns unsupported for a valid online metadata that does not advertise it', async () => {
    vi.spyOn(NodeRegistry.getInstance(), 'fetchMetaForNode')
      .mockResolvedValue({ version: '0.97.1', capabilities: ['fleet'], ...ONLINE });
    expect(await probeRemoteCapability(NODE_ID, CAP)).toBe('unsupported');
  });

  it('returns unreachable, not unsupported, when the metadata is offline', async () => {
    vi.spyOn(NodeRegistry.getInstance(), 'fetchMetaForNode')
      .mockResolvedValue({ version: null, capabilities: [], startedAt: null, updateError: null, online: false, imagePinKind: null, updateBlocked: false, imageChannel: null });
    expect(await probeRemoteCapability(NODE_ID, CAP)).toBe('unreachable');
  });

  it('returns unreachable, not unsupported, when the meta fetch throws', async () => {
    vi.spyOn(NodeRegistry.getInstance(), 'fetchMetaForNode').mockRejectedValue(new Error('unreachable'));
    expect(await probeRemoteCapability(NODE_ID, CAP)).toBe('unreachable');
  });

  it('returns unreachable, not unsupported, when a 2xx response carries malformed metadata', async () => {
    // Raw response path: a 2xx body that is not a JSON object with a genuine
    // capability array must never read as an online remote that advertises
    // nothing. The probe reports unreachable so an operator distinguishes an
    // outage or intercepting proxy from an old-but-healthy remote.
    const axios = (await import('axios')).default;
    const db = (await import('../services/DatabaseService')).DatabaseService.getInstance();
    const nodeId = db.addNode({
      name: 'probe-malformed-meta',
      type: 'remote',
      mode: 'proxy',
      compose_dir: '/tmp',
      is_default: false,
      api_url: 'https://remote.example.com:1852',
      api_token: 'token',
    });
    const reg = NodeRegistry.getInstance();
    vi.spyOn(reg, 'getProxyTarget').mockReturnValue({
      apiUrl: 'https://remote.example.com:1852',
      apiToken: 'token',
      trustedLoopback: false,
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const data of ['not-an-object', { version: '0.97.1' }, { capabilities: 'yes' }]) {
      vi.spyOn(axios, 'get').mockResolvedValue({ data });
      expect(await probeRemoteCapability(nodeId, CAP)).toBe('unreachable');
    }
    db.deleteNode(nodeId);
  });
});
