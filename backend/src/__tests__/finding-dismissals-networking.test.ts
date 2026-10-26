/**
 * Networking dismissals: the structural key and fingerprint, the per-kind
 * policy, and the routes that write and read them.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { NETWORKING_FINDING_KINDS } from '../services/network/networkingTypes';
import { buildNodeNetworkingFindings } from '../services/network/networkingFindings';
import type { NetworkFactPort, StackNetworkFacts } from '../services/network/types';
import {
  networkingDismissalKey,
  networkingDismissPolicy,
  networkingFindingKey,
  networkingFingerprint,
  parseNetworkingKey,
} from '../services/network/networkingDismissals';

vi.mock('../services/network/exposureContext', () => ({
  getExposureContext: () => ({ available: true, stackIntent: 'lan', serviceIntents: {}, hasAccessUrls: false }),
}));

let tmpDir: string;
let app: import('express').Express;
let adminAuth: string;
let viewerAuth: string;
let deployerAuth: string;
let localNodeId: number;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let FindingDismissalStore: typeof import('../services/findingDismissals/FindingDismissalStore').FindingDismissalStore;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ FindingDismissalStore } = await import('../services/findingDismissals/FindingDismissalStore'));

  adminAuth = `Bearer ${jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '5m' })}`;
  const db = DatabaseService.getInstance();
  localNodeId = db.getNodes().find((node) => node.type === 'local')!.id;

  const sign = (username: string, role: string, tv: number) =>
    `Bearer ${jwt.sign({ username, role, tv }, TEST_JWT_SECRET, { expiresIn: '5m' })}`;
  db.addUser({ username: 'net-viewer', password_hash: await bcrypt.hash('password123', 1), role: 'viewer' });
  const viewer = db.getUserByUsername('net-viewer')!;
  viewerAuth = sign('net-viewer', 'viewer', viewer.token_version);

  db.addUser({ username: 'net-deployer', password_hash: await bcrypt.hash('password123', 1), role: 'viewer' });
  const deployer = db.getUserByUsername('net-deployer')!;
  db.addRoleAssignment({ user_id: deployer.id, role: 'deployer', resource_type: 'stack', resource_id: 'web', node_id: localNodeId });
  deployerAuth = sign('net-deployer', 'viewer', deployer.token_version);
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  DatabaseService.getInstance().getDb().prepare('DELETE FROM finding_dismissals').run();
});

const keyFor = (kind: string, stack = 'web', service = '', network = '', subject = '') =>
  networkingDismissalKey(localNodeId, [kind, stack, service, network, subject].join('|'));

describe('networking finding key', () => {
  it('round trips node, stack, kind and the other parts', () => {
    const id = networkingFindingKey({ kind: 'alias-collision', stack: '', service: '', network: 'shared', subject: 'db' });
    expect(id).toBe('alias-collision|||shared|db');
    expect(parseNetworkingKey(networkingDismissalKey(3, id))).toEqual({
      nodeId: 3, kind: 'alias-collision', stack: '', service: '', network: 'shared', subject: 'db',
    });
  });

  it('keeps a separator inside a value from changing the target the key names', () => {
    const id = networkingFindingKey({ kind: 'network-missing', stack: 'a|b', service: '', network: 'n', subject: '' });
    expect(parseNetworkingKey(networkingDismissalKey(1, id))?.stack).toBe('a_b');
  });

  it('refuses a key too long to be a real finding', () => {
    expect(parseNetworkingKey(networkingDismissalKey(1, `network-missing|${'a'.repeat(700)}|||`))).toBeNull();
  });

  it.each([
    '', 'readiness:1:x', 'networking:0:network-missing|a|||', 'networking:x:network-missing|a|||',
    'networking:1:bogus-kind|a|||', 'networking:1:network-missing|a||', 'networking:1:network-missing|a||||',
  ])('refuses %j', (key) => {
    expect(parseNetworkingKey(key)).toBeNull();
  });
});

describe('networking fingerprint', () => {
  it('depends on severity and the sorted targets, not their order', () => {
    expect(networkingFingerprint('high', ['b', 'a'])).toBe(networkingFingerprint('high', ['a', 'b']));
    expect(networkingFingerprint('high', ['a'])).not.toBe(networkingFingerprint('medium', ['a']));
    expect(networkingFingerprint('high', ['a'])).not.toBe(networkingFingerprint('high', ['a', 'c']));
  });
});

describe('networkingDismissPolicy', () => {
  it('names a policy for every kind', () => {
    for (const kind of NETWORKING_FINDING_KINDS) {
      expect(['any', 'timed', 'none']).toContain(networkingDismissPolicy(kind));
    }
  });

  it('allows only a timed dismissal of missing runtime evidence, and none of what Doctor owns', () => {
    expect(networkingDismissPolicy('runtime-unavailable')).toBe('timed');
    expect(networkingDismissPolicy('port-conflict-node')).toBe('none');
    expect(networkingDismissPolicy('new-network')).toBe('none');
    expect(networkingDismissPolicy('exposure-all-interfaces')).toBe('any');
  });
});

describe('POST /api/fleet/dismissals/networking', () => {
  const seen = { fingerprint: 'fp-1', count: 1, severity: 'medium' };
  const post = (body: unknown, auth = adminAuth) =>
    request(app).post('/api/fleet/dismissals/networking').set('Authorization', auth).send({ ...seen, ...(body as object) });

  it('stores the dismissal under the key, with scope taken from the key alone', async () => {
    const findingId = keyFor('exposure-all-interfaces', 'web', 'app');
    const res = await post({ findingId, mode: 'until_change' });
    expect(res.status).toBe(201);
    expect(res.body.dismissal).toMatchObject({
      nodeId: localNodeId, surface: 'networking', findingKey: findingId, fingerprint: 'fp-1', severity: 'medium', count: 1, mode: 'until_change',
    });
    const [stored] = FindingDismissalStore.getInstance().list('networking');
    expect(stored.stack_name).toBe('web');
  });

  it('records a node-level finding with no stack', async () => {
    const res = await post({ findingId: keyFor('shared-network', '', '', 'backbone'), mode: 'forever' });
    expect(res.status).toBe(201);
    expect(FindingDismissalStore.getInstance().list('networking')[0].stack_name).toBeNull();
  });

  it('turns days into an expiry and bounds it', async () => {
    const findingId = keyFor('exposure-all-interfaces', 'web', 'app');
    const ok = await post({ findingId, mode: 'days', days: 7 });
    expect(ok.status).toBe(201);
    expect(ok.body.dismissal.expiresAt).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    expect((await post({ findingId, mode: 'days', days: 0 })).status).toBe(400);
    expect((await post({ findingId, mode: 'days', days: '7' })).status).toBe(400);
  });

  it('refuses a malformed key and a state of the finding it cannot read', async () => {
    const findingId = keyFor('exposure-all-interfaces', 'web', 'app');
    expect((await post({ findingId: 'networking:1:nope', mode: 'until_change' })).status).toBe(400);
    expect((await post({ findingId, mode: 'until_change', fingerprint: '' })).status).toBe(400);
    expect((await post({ findingId, mode: 'until_change', count: 0 })).status).toBe(400);
    expect((await post({ findingId, mode: 'until_change', count: '1' })).status).toBe(400);
    expect((await post({ findingId, mode: 'until_change', severity: 'catastrophic' })).status).toBe(400);
    expect((await post({ findingId, mode: 'sometimes' })).status).toBe(400);
  });

  it('refuses a node that does not exist', async () => {
    const findingId = networkingDismissalKey(9999, 'shared-network|||backbone|');
    expect((await post({ findingId, mode: 'until_change' })).status).toBe(404);
  });

  it('refuses a finding Doctor owns', async () => {
    const res = await post({ findingId: keyFor('port-conflict-node', 'web', 'app', '', 'port-conflict-node'), mode: 'until_change' });
    expect(res.status).toBe(400);
    expect(FindingDismissalStore.getInstance().list('networking')).toHaveLength(0);
  });

  it('allows only a timed dismissal of missing runtime evidence', async () => {
    const findingId = keyFor('runtime-unavailable', '');
    expect((await post({ findingId, mode: 'until_change' })).status).toBe(400);
    expect((await post({ findingId, mode: 'forever' })).status).toBe(400);
    expect((await post({ findingId, mode: 'days', days: 7 })).status).toBe(201);
  });

  it('lets a deployer on a stack dismiss that stack only', async () => {
    expect((await post({ findingId: keyFor('exposure-all-interfaces', 'web', 'app'), mode: 'until_change' }, deployerAuth)).status).toBe(201);
    expect((await post({ findingId: keyFor('exposure-all-interfaces', 'other', 'app'), mode: 'until_change' }, deployerAuth)).status).toBe(403);
  });

  it('keeps node-level findings behind node management', async () => {
    const findingId = keyFor('shared-network', '', '', 'backbone');
    expect((await post({ findingId, mode: 'until_change' }, deployerAuth)).status).toBe(403);
    expect((await post({ findingId, mode: 'until_change' }, viewerAuth)).status).toBe(403);
    expect(FindingDismissalStore.getInstance().list('networking')).toHaveLength(0);
  });

  it('reports a weaker repeat as kept and does not create a second row', async () => {
    const findingId = keyFor('exposure-all-interfaces', 'web', 'app');
    await post({ findingId, mode: 'forever' });
    const again = await post({ findingId, mode: 'until_change' });
    expect(again.status).toBe(200);
    expect(again.body.kept).toBe(true);
    expect(FindingDismissalStore.getInstance().list('networking')).toHaveLength(1);
    expect(FindingDismissalStore.getInstance().list('networking')[0].mode).toBe('forever');
  });

  it('does not accept a readiness key', async () => {
    expect((await post({ findingId: `workloads:${localNodeId}:web:workloads_partial`, mode: 'until_change' })).status).toBe(400);
  });
});

describe('GET /api/fleet/dismissals/networking', () => {
  const seed = (findingKey: string, mode: 'until_change' | 'days' = 'until_change', expiresAt: number | null = null, nodeId = localNodeId) =>
    FindingDismissalStore.getInstance().dismiss(
      { nodeId, surface: 'networking', findingKey, stackName: 'web', fingerprint: 'fp', severity: 'medium', count: 1 },
      { mode, expiresAt, createdBy: 'alice', now: 1 },
    ).row;

  it("lists one node's dismissals and drops a timed one whose time is up", async () => {
    const live = keyFor('exposure-all-interfaces', 'web', 'app');
    seed(live);
    seed(keyFor('exposure-all-interfaces', 'web', 'old'), 'days', 5);
    const res = await request(app).get(`/api/fleet/dismissals/networking?nodeId=${localNodeId}`).set('Authorization', viewerAuth);
    expect(res.status).toBe(200);
    expect(res.body.dismissals.map((d: { findingKey: string }) => d.findingKey)).toEqual([live]);
    expect(FindingDismissalStore.getInstance().list('networking')).toHaveLength(1);
  });

  it('refuses a bad node id and answers nothing for another node', async () => {
    expect((await request(app).get('/api/fleet/dismissals/networking').set('Authorization', adminAuth)).status).toBe(400);
    seed(keyFor('shared-network', '', '', 'backbone'));
    const res = await request(app).get('/api/fleet/dismissals/networking?nodeId=9999').set('Authorization', adminAuth);
    expect(res.body.dismissals).toEqual([]);
  });
});

describe('DELETE /api/fleet/dismissals/:id for a networking row', () => {
  const seed = (stack: string) => FindingDismissalStore.getInstance().dismiss(
    {
      nodeId: localNodeId, surface: 'networking', findingKey: keyFor('exposure-all-interfaces', stack, 'app'),
      stackName: stack, fingerprint: 'fp', severity: 'medium', count: 1,
    },
    { mode: 'until_change', expiresAt: null, createdBy: 'alice', now: 1 },
  ).row;

  it('restores it for someone who could have dismissed it', async () => {
    const row = seed('web');
    expect((await request(app).delete(`/api/fleet/dismissals/${row.id}`).set('Authorization', deployerAuth)).status).toBe(204);
    expect(FindingDismissalStore.getInstance().get(row.id)).toBeNull();
  });

  it('refuses someone who could not have', async () => {
    const row = seed('other');
    expect((await request(app).delete(`/api/fleet/dismissals/${row.id}`).set('Authorization', deployerAuth)).status).toBe(403);
    expect(FindingDismissalStore.getInstance().get(row.id)).not.toBeNull();
  });
});

describe('buildNodeNetworkingFindings ids and fingerprints', () => {
  const port = (hostPort: number): NetworkFactPort => ({
    hostIp: '', startPort: hostPort, endPort: hostPort, protocol: 'tcp', allInterfaces: true, loopbackOnly: false,
  } as NetworkFactPort);
  const facts = (ports: NetworkFactPort[]): StackNetworkFacts => ({
    stack: 'web', renderable: true, renderError: null, runtime: 'available', networks: [],
    services: [{ name: 'app', networks: [], publishedPorts: ports, extraHosts: [] }],
    drift: { runtimeOnlyAttachments: [], declaredButUnused: [], missingFromRuntime: [], foreignNetworkAttachments: [] },
    missingExternalNetworks: [],
  });
  const build = (ports: NetworkFactPort[]) => buildNodeNetworkingFindings(localNodeId, null, [facts(ports)], [])
    .find((f) => f.kind === 'exposure-all-interfaces')!;

  it('names the finding by its target, not its wording', () => {
    expect(build([port(8080)]).id).toBe('exposure-all-interfaces|web|app||');
  });

  it('keeps the fingerprint through a repeat read and moves it when the ports change', () => {
    expect(build([port(8080)]).fingerprint).toBe(build([port(8080)]).fingerprint);
    expect(build([port(8080)]).fingerprint).not.toBe(build([port(9090)]).fingerprint);
  });

  it('counts the ports it covers', () => {
    expect(build([port(8080), port(8081)]).count).toBe(2);
  });

  it('marks missing runtime evidence timed', () => {
    const [unavailable] = buildNodeNetworkingFindings(localNodeId, null, [], []);
    expect(unavailable).toMatchObject({ kind: 'runtime-unavailable', dismissPolicy: 'timed', id: 'runtime-unavailable||||' });
  });
});
