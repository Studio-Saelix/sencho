/**
 * Hub-to-node sealed secret delivery, end to end in one process: the hub
 * service seals and sends through its real client, the in-process transport
 * hands each request to the node's Express app (authentication, the
 * hub-background rule, the route and the store all run), and the node's
 * writer runs against a Docker double. Every case runs for a direct-proxy node
 * and for a Pilot node; the local node runs in process.
 */
import { randomUUID } from 'node:crypto';

import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanupTestDb, setupTestDb, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { createFakeSecretDocker, type FakeSecretDocker } from './helpers/fakeSecretDocker';
import { installInProcessNodeTransport, type InProcessCall } from './helpers/inProcessNodeTransport';

const probe = vi.hoisted(() => ({ kind: 'supported' as 'supported' | 'unsupported' | 'unreachable' }));

vi.mock('../helpers/remoteCapabilities', async (importOriginal) => {
  const original = await importOriginal<typeof import('../helpers/remoteCapabilities')>();
  return {
    ...original,
    probeRemoteCapability: vi.fn(async () => (probe.kind === 'unreachable'
      ? { kind: 'unreachable', detail: 'transport_failure' }
      : { kind: probe.kind })),
  };
});

type ServiceModule = typeof import('../services/sealedSecrets/SealedSecretDeliveryService');

const PURPOSE = 'edge-tunnel-run-token' as const;
const VOLUME_FILE = 'sencho_edge_secret/token';
const SLOT_A = '0b9f3c2e-1d4a-4b5c-8d6e-7f8091a2b3c4';
const SLOT_B = '1c0a4d3f-2e5b-4c6d-9e7f-8a9102b3c4d5';
const SECRET = 'S3ntinelRunToken-zxcvbnmasdfghjkl';

let tmpDir: string;
let app: import('express').Express;
let db: import('../services/DatabaseService').DatabaseService;
let Service: ServiceModule['SealedSecretDeliveryService'];
let fake: FakeSecretDocker;
let localFingerprint: string;
let pilotConfidential = false;
let directNodeId: number;
let pilotNodeId: number;
let localNodeId: number;

interface Transport {
  name: string;
  nodeId: () => number;
  bearer: () => string;
  setConfidential: (on: boolean) => void;
}

const transports: Transport[] = [
  {
    name: 'direct proxy',
    nodeId: () => directNodeId,
    bearer: () => jwt.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '5m' }),
    setConfidential: (on) => db.updateNode(directNodeId, { api_url: `${on ? 'https' : 'http'}://192.168.1.60:1852` }),
  },
  {
    name: 'Pilot',
    nodeId: () => pilotNodeId,
    bearer: () => jwt.sign({ scope: 'pilot_tunnel' }, TEST_JWT_SECRET, { expiresIn: '5m' }),
    setConfidential: (on) => { pilotConfidential = on; },
  },
];

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  const dbModule = await import('../services/DatabaseService');
  db = dbModule.DatabaseService.getInstance();
  ({ SealedSecretDeliveryService: Service } = await import('../services/sealedSecrets/SealedSecretDeliveryService'));
  localFingerprint = (await import('../helpers/registryEnvelopeSeal')).getOrCreateSealingKey().fingerprint;
  directNodeId = db.addNode({
    name: 'sealed-direct', type: 'remote', mode: 'proxy', compose_dir: '/app/compose', is_default: false,
    api_url: 'http://192.168.1.60:1852', api_token: 'stored-node-token',
  });
  pilotNodeId = db.addNode({ name: 'sealed-pilot', type: 'remote', mode: 'pilot_agent', compose_dir: '/app/compose', is_default: false });
  localNodeId = db.getDefaultNode()!.id;
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

beforeEach(async () => {
  vi.restoreAllMocks();
  probe.kind = 'supported';
  pilotConfidential = false;
  for (const table of ['sealed_secret_generations', 'sealed_secret_deliveries', 'node_sealing_keys', 'audit_log']) {
    db.getDb().prepare(`DELETE FROM ${table}`).run();
  }
  db.updateNode(directNodeId, { api_url: 'http://192.168.1.60:1852' });
  const { PilotTunnelManager } = await import('../services/PilotTunnelManager');
  const pilot = PilotTunnelManager.getInstance();
  vi.spyOn(pilot, 'getLoopbackUrl').mockImplementation((id: number) => (id === pilotNodeId ? 'http://127.0.0.1:41999' : null));
  vi.spyOn(pilot, 'isTunnelConfidential').mockImplementation((id: number) => id === pilotNodeId && pilotConfidential);
  fake = createFakeSecretDocker();
  const { SealedSecretStore } = await import('../services/sealedSecrets/SealedSecretStore');
  SealedSecretStore.resetForTests();
  SealedSecretStore.getInstance().setDockerForTests(fake.docker);
  Service.resetForTests();
});

/**
 * Make a remote node the default while the store resolves its own Docker, as
 * on a receiving instance whose operator picked a remote default. Only the
 * local node's client answers; any other node id throws as the registry does
 * for a remote node. Returns the restore step.
 */
async function remoteDefaultWithLocalDaemon(remoteDefaultId: number): Promise<() => void> {
  const { NodeRegistry } = await import('../services/NodeRegistry');
  const { SealedSecretStore } = await import('../services/sealedSecrets/SealedSecretStore');
  const registry = NodeRegistry.getInstance();
  const realGetDocker = registry.getDocker.bind(registry);
  vi.spyOn(registry, 'getDocker').mockImplementation((id: number) => (id === localNodeId ? fake.docker : realGetDocker(id)));
  SealedSecretStore.getInstance().setDockerForTests(null);
  db.updateNode(remoteDefaultId, { is_default: true });
  expect(registry.getDefaultNodeId()).toBe(remoteDefaultId);
  return () => db.updateNode(localNodeId, { is_default: true });
}

/**
 * Add a remote node whose stored credential this instance cannot decrypt, as
 * after restoring a database without its encryption key, and prove it is
 * unreadable. With `asDefault` it also becomes the default node, and the
 * restore step makes the local node the default again. Returns the restore
 * step.
 */
function unreadableRemote(asDefault = false): () => void {
  const unreadable = `enc:${'00'.repeat(12)}:${'00'.repeat(16)}:00`;
  const id = Number(db.getDb().prepare(
    "INSERT INTO nodes (name, type, compose_dir, is_default, status, created_at, api_url, api_token, mode) VALUES ('unrecovered', 'remote', '/app/compose', 0, 'offline', ?, 'https://10.0.0.9:1852', ?, 'proxy')",
  ).run(Date.now(), unreadable).lastInsertRowid);
  if (asDefault) {
    db.getDb().prepare('UPDATE nodes SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END').run(id);
    expect(() => db.getDefaultNode()).toThrow();
  }
  expect(() => db.getNodes()).toThrow();
  return () => {
    db.getDb().prepare('DELETE FROM nodes WHERE id = ?').run(id);
    if (asDefault) db.getDb().prepare('UPDATE nodes SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END').run(localNodeId);
  };
}

function service() {
  return Service.getInstance();
}

async function refusal(promise: Promise<unknown>): Promise<{ code: string; status: number; details: Record<string, unknown> }> {
  try {
    await promise;
  } catch (error: unknown) {
    return error as { code: string; status: number; details: Record<string, unknown> };
  }
  throw new Error('expected a refusal');
}

function writes(calls: InProcessCall[]): InProcessCall[] {
  return calls.filter((call) => call.method !== 'GET');
}

function audit(): string[] {
  db.flushAuditLogBuffer();
  return (db.getDb().prepare('SELECT summary FROM audit_log ORDER BY id').all() as { summary: string }[]).map((row) => row.summary);
}

describe.each(transports)('sealed secret delivery over $name', (transport) => {
  const deliver = (slot = SLOT_A, secret = SECRET) => service().deliver({
    nodeId: transport.nodeId(), purpose: PURPOSE, slot, secret, actor: 'admin',
  });
  const remove = (slot = SLOT_A) => service().remove({ nodeId: transport.nodeId(), purpose: PURPOSE, slot, actor: 'admin' });
  const install = (hooks: Partial<Parameters<typeof installInProcessNodeTransport>[0]> = {}) =>
    installInProcessNodeTransport({ app, bearer: transport.bearer, ...hooks });

  it('refuses an unsupported node and sends nothing', async () => {
    const { calls } = install();
    probe.kind = 'unsupported';
    const error = await refusal(deliver());
    expect(error.code).toBe('SEALED_SECRET_TARGET_UNSUPPORTED');
    expect(error.status).toBe(409);
    expect(calls).toHaveLength(0);
  });

  it('refuses an unreachable node and sends nothing', async () => {
    const { calls } = install();
    probe.kind = 'unreachable';
    const error = await refusal(deliver());
    expect(error.code).toBe('SEALED_SECRET_TARGET_UNREACHABLE');
    expect(error.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it('refuses a key never seen over a confidential connection and sends nothing sealed', async () => {
    const { calls } = install();
    const error = await refusal(deliver());
    expect(error.code).toBe('SEALED_SECRET_TRANSPORT_NOT_CONFIDENTIAL');
    expect(writes(calls)).toHaveLength(0);
    expect(db.getNodeSealingPin(transport.nodeId())).toMatchObject({ fingerprint: localFingerprint, confidential: false });
    expect(audit().some((line) => line.startsWith('sealed_secret.delivery_refused:') && line.includes('code=SEALED_SECRET_TRANSPORT_NOT_CONFIDENTIAL'))).toBe(true);
  });

  it('refuses a key that differs from the pin and sends nothing sealed', async () => {
    const { calls } = install();
    transport.setConfidential(true);
    db.pinNodeSealingKey(transport.nodeId(), Buffer.alloc(32, 7).toString('base64'), 'other-fingerprint', true);
    const error = await refusal(deliver());
    expect(error.code).toBe('SEAL_KEY_MISMATCH');
    expect(writes(calls)).toHaveLength(0);
  });

  it('pins on a confidential first contact and delivers the secret into the volume', async () => {
    const { calls } = install();
    transport.setConfidential(true);
    expect(await deliver()).toEqual({ status: 'accepted', generation: 1 });
    expect(fake.files.get(VOLUME_FILE)?.content).toBe(SECRET);
    expect(db.getNodeSealingPin(transport.nodeId())).toMatchObject({ fingerprint: localFingerprint, confidential: true });
    expect(db.getSealedSecretDelivery(transport.nodeId(), PURPOSE)).toMatchObject({ slot: SLOT_A, generation: 1, state: 'delivered' });
    const post = writes(calls)[0];
    expect(post.headers['x-sencho-actor-role']).toBeUndefined();
    // Every request carries the bearer this hub holds for the node's resolved
    // target: the stored node token on direct proxy. On Pilot the agent's
    // loopback replaces it with the tunnel bearer.
    const { NodeRegistry } = await import('../services/NodeRegistry');
    const expected = `Bearer ${NodeRegistry.getInstance().getProxyTarget(transport.nodeId())?.apiToken ?? ''}`;
    if (transport.name === 'direct proxy') expect(expected).toBe('Bearer stored-node-token');
    expect(calls.every((call) => call.sentAuthorization === expected)).toBe(true);
    expect(JSON.stringify(post.data)).not.toContain(SECRET.slice(0, 8));
    const lines = audit();
    expect(lines.some((line) => line.startsWith('sealed_secret.delivered:'))).toBe(true);
    expect(lines.some((line) => line.startsWith('sealed_secret.accepted:'))).toBe(true);
  });

  it('accepts, replaces and removes on the local daemon when a remote node is the default', async () => {
    install();
    transport.setConfidential(true);
    const restore = await remoteDefaultWithLocalDaemon(directNodeId);
    try {
      expect(await deliver()).toEqual({ status: 'accepted', generation: 1 });
      expect(fake.files.get(VOLUME_FILE)?.content).toBe(SECRET);
      expect(await deliver(SLOT_B, `${SECRET}-b`)).toMatchObject({ status: 'accepted', generation: 2 });
      expect(fake.files.get(VOLUME_FILE)?.content).toBe(`${SECRET}-b`);
      expect((await remove(SLOT_B)).status).toBe('deleted');
      expect(fake.files.has(VOLUME_FILE)).toBe(false);
    } finally {
      restore();
    }
  });

  it('keeps serving its receiving routes and its store while an unrelated remote credential cannot be decrypted', async () => {
    install();
    transport.setConfidential(true);
    const restore = await remoteDefaultWithLocalDaemon(directNodeId);
    const restoreUnreadable = unreadableRemote();
    try {
      const bearer = `Bearer ${transport.bearer()}`;
      expect((await request(app).get('/api/sealed-secrets/key').set('Authorization', bearer)).status).toBe(200);
      expect((await request(app).get('/api/sealed-secrets').set('Authorization', bearer)).status).toBe(200);
      expect((await request(app).get(`/api/sealed-secrets/${PURPOSE}/${SLOT_A}`).set('Authorization', bearer)).status).toBe(200);
      expect(await deliver()).toEqual({ status: 'accepted', generation: 1 });
      expect(await deliver(SLOT_B, `${SECRET}-b`)).toMatchObject({ status: 'accepted', generation: 2 });
      expect(fake.files.get(VOLUME_FILE)?.content).toBe(`${SECRET}-b`);
      expect((await remove(SLOT_B)).status).toBe('deleted');
      expect(fake.files.has(VOLUME_FILE)).toBe(false);
    } finally {
      restoreUnreadable();
      restore();
    }
  });

  it('serves its receiving routes when the default node itself has a credential it cannot decrypt', async () => {
    const restoreUnreadable = unreadableRemote(true);
    try {
      const bearer = `Bearer ${transport.bearer()}`;
      expect((await request(app).get('/api/sealed-secrets/key').set('Authorization', bearer)).status).toBe(200);
      expect((await request(app).get('/api/sealed-secrets').set('Authorization', bearer)).status).toBe(200);
      expect((await request(app).get(`/api/sealed-secrets/${PURPOSE}/${SLOT_A}`).set('Authorization', bearer)).status).toBe(200);
      const post = await request(app).post(`/api/sealed-secrets/${PURPOSE}`).set('Authorization', bearer).send({ slot: SLOT_A, generation: 1 });
      // Past every middleware to the route's own validation: no envelope was sent.
      expect(post.status).toBe(400);
    } finally {
      restoreUnreadable();
    }
  });

  describe.each([
    { defaultCredential: 'readable' },
    { defaultCredential: 'unreadable' },
  ])('with no local node row and a $defaultCredential remote default', ({ defaultCredential }) => {
    it.each([
      { selector: 'no selector', apply: (r: request.Test) => r },
      { selector: 'an x-node-id header', apply: (r: request.Test) => r.set('x-node-id', String(transport.nodeId())) },
      { selector: 'a nodeId query', apply: (r: request.Test) => r.query({ nodeId: transport.nodeId() }) },
      // The receiving instance ignores selectors, so a deleted, malformed or
      // nonexistent one cannot redirect the request or its audit row.
      { selector: 'a nonexistent x-node-id', apply: (r: request.Test) => r.set('x-node-id', '999999') },
      { selector: 'a malformed nodeId query', apply: (r: request.Test) => r.query({ nodeId: 'not-a-number' }) },
    ])('answers every receiving route from this instance with $selector', async ({ apply }) => {
      const raw = db.getDb();
      raw.prepare("UPDATE nodes SET type = 'remote' WHERE id = ?").run(localNodeId);
      const restoreUnreadable = defaultCredential === 'unreadable' ? unreadableRemote(true) : null;
      if (!restoreUnreadable) db.updateNode(directNodeId, { is_default: true });
      try {
        const { NodeRegistry } = await import('../services/NodeRegistry');
        expect(NodeRegistry.getInstance().getLocalNodeId()).toBeNull();
        const { SealedSecretStore } = await import('../services/sealedSecrets/SealedSecretStore');
        SealedSecretStore.getInstance().setDockerForTests(null);
        // Rows an earlier case buffered must not count as this case's.
        db.flushAuditLogBuffer();
        raw.prepare('DELETE FROM audit_log').run();
        const bearer = `Bearer ${transport.bearer()}`;
        const send = (r: request.Test) => apply(r.set('Authorization', bearer));

        const key = await send(request(app).get('/api/sealed-secrets/key'));
        expect(key.status).toBe(200);
        expect((await send(request(app).get('/api/sealed-secrets'))).status).toBe(200);
        expect((await send(request(app).get(`/api/sealed-secrets/${PURPOSE}/${SLOT_A}`))).status).toBe(200);

        const { sealSecret } = await import('../helpers/sealedSecretSeal');
        const operationId = randomUUID();
        const sealed = sealSecret(Buffer.from(key.body.publicKey, 'base64'), {
          purpose: PURPOSE, deliverySourceId: key.body.deliverySourceId, slot: SLOT_A, generation: 1, operationId,
        }, SECRET);
        const accept = await send(request(app).post(`/api/sealed-secrets/${PURPOSE}`))
          .send({ slot: SLOT_A, generation: 1, operationId, actor: 'admin', sealed });
        // The store's own answer for an instance with no daemon, not a 500 from a decrypted default.
        expect(accept.status).toBe(503);
        expect(accept.body.code).toBe('SECRET_STORE_UNAVAILABLE');
        const removal = await send(request(app).delete(`/api/sealed-secrets/${PURPOSE}/${SLOT_A}`))
          .send({ generation: 2, operationId: randomUUID(), actor: 'admin' });
        expect(removal.status).toBe(200);
        expect(removal.body.status).toBe('not_current');
        expect(fake.files.size).toBe(0);
        // A request this instance served is never recorded against the node it named.
        db.flushAuditLogBuffer();
        const nodeIds = (raw.prepare("SELECT node_id FROM audit_log WHERE path LIKE '/api/sealed-secrets%'").all() as { node_id: number | null }[])
          .map((row) => row.node_id);
        expect(nodeIds.length).toBeGreaterThan(0);
        expect(nodeIds.every((id) => id === null)).toBe(true);
      } finally {
        restoreUnreadable?.();
        raw.prepare("UPDATE nodes SET type = 'local' WHERE id = ?").run(localNodeId);
        db.getDb().prepare('UPDATE nodes SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END').run(localNodeId);
      }
    });
  });

  it('does not trust a pin the registry path made over plaintext', async () => {
    const { calls } = install();
    db.pinNodeSealingKey(transport.nodeId(), 'registry-pinned', localFingerprint);
    expect((await refusal(deliver())).code).toBe('SEALED_SECRET_TRANSPORT_NOT_CONFIDENTIAL');
    expect(writes(calls)).toHaveLength(0);
  });

  it('delivers over plaintext once an Admin confirmed the fingerprint', async () => {
    install();
    const confirmed = await service().confirmFingerprint(transport.nodeId(), localFingerprint, 'admin');
    expect(confirmed.readiness).toBe('ready');
    expect(db.getNodeSealingPin(transport.nodeId())).toMatchObject({ confidential: true, confirmedBy: 'admin' });
    expect((await deliver()).status).toBe('accepted');
  });

  it('never attaches the flag to a key fetched over plaintext, even when the transport turns confidential mid-operation', async () => {
    install({
      beforeSend: (call) => {
        if (call.path.endsWith('/key')) transport.setConfidential(true);
      },
    });
    expect((await refusal(deliver())).code).toBe('SEALED_SECRET_TRANSPORT_NOT_CONFIDENTIAL');
    expect(db.getNodeSealingPin(transport.nodeId())?.confidential).toBe(false);
    // The next operation resolves the now-confidential transport and may re-confirm.
    expect((await deliver()).status).toBe('accepted');
    expect(db.getNodeSealingPin(transport.nodeId())?.confidential).toBe(true);
  });

  it('records the generation before it sends', async () => {
    transport.setConfidential(true);
    const seen: unknown[] = [];
    install({
      beforeSend: (call) => {
        if (call.method === 'POST') seen.push(db.getSealedSecretDelivery(transport.nodeId(), PURPOSE));
      },
    });
    await deliver();
    expect(seen[0]).toMatchObject({ state: 'sending', generation: 1, slot: SLOT_A });
  });

  it('reuses the generation after a lost response, and the node answers already_accepted', async () => {
    transport.setConfidential(true);
    let lose = true;
    install({
      afterAnswer: (call) => {
        if (call.method === 'POST' && lose) { lose = false; throw new Error('response lost'); }
      },
    });
    expect((await refusal(deliver())).code).toBe('SEALED_SECRET_TARGET_UNREACHABLE');
    expect(db.getSealedSecretDelivery(transport.nodeId(), PURPOSE)).toMatchObject({ state: 'sending', generation: 1 });
    expect(fake.files.get(VOLUME_FILE)?.content).toBe(SECRET);
    expect(await deliver()).toEqual({ status: 'already_accepted', generation: 1 });
    expect(db.getSealedSecretDelivery(transport.nodeId(), PURPOSE)?.state).toBe('delivered');
  });

  it('moves past a reused generation that held other content', async () => {
    transport.setConfidential(true);
    let lose = true;
    install({
      afterAnswer: (call) => {
        if (call.method === 'POST' && lose) { lose = false; throw new Error('response lost'); }
      },
    });
    await refusal(deliver());
    expect(await deliver(SLOT_A, `${SECRET}-new`)).toEqual({ status: 'accepted', generation: 2 });
    expect(fake.files.get(VOLUME_FILE)?.content).toBe(`${SECRET}-new`);
    // The reused generation was refused as stale first, then the hub moved past it.
    expect(audit().some((line) => line.startsWith('sealed_secret.refused:') && line.includes('reason=stale'))).toBe(true);
  });

  it('recovers the generation by read-back after the hub lost its record', async () => {
    transport.setConfidential(true);
    install();
    await deliver();
    db.getDb().prepare('DELETE FROM sealed_secret_deliveries').run();
    expect(await deliver(SLOT_B, `${SECRET}-b`)).toEqual({ status: 'accepted', generation: 2 });
  });

  it('replaces with a new slot at the next generation', async () => {
    transport.setConfidential(true);
    install();
    await deliver();
    expect(await deliver(SLOT_B, `${SECRET}-b`)).toEqual({ status: 'accepted', generation: 2 });
    expect(fake.files.get(VOLUME_FILE)?.content).toBe(`${SECRET}-b`);
  });

  it('removes the live slot, and a second removal answers already_deleted without a new generation', async () => {
    transport.setConfidential(true);
    const { calls } = install();
    await deliver();
    expect((await remove()).status).toBe('deleted');
    expect(fake.files.has(VOLUME_FILE)).toBe(false);
    expect(db.getSealedSecretDelivery(transport.nodeId(), PURPOSE)?.state).toBe('removed');
    const writesBefore = writes(calls).length;
    expect(await remove()).toEqual({ status: 'already_deleted', generation: 2, currentSlot: SLOT_A });
    expect(writes(calls)).toHaveLength(writesBefore);
    expect(audit().some((line) => line.startsWith('sealed_secret.removed:') && line.includes('status=already_deleted'))).toBe(true);
  });

  it('leaves the live token in place when an old slot is removed after a replace', async () => {
    transport.setConfidential(true);
    install();
    await deliver();
    await deliver(SLOT_B, `${SECRET}-b`);
    expect(await remove(SLOT_A)).toEqual({ status: 'not_current', generation: 2, currentSlot: SLOT_B });
    expect(fake.files.get(VOLUME_FILE)?.content).toBe(`${SECRET}-b`);
    expect(db.getSealedSecretDelivery(transport.nodeId(), PURPOSE)).toMatchObject({ slot: SLOT_B, state: 'delivered' });
  });

  it('converges a removal whose response was lost', async () => {
    transport.setConfidential(true);
    let lose = false;
    install({
      afterAnswer: (call) => {
        if (call.method === 'DELETE' && lose) { lose = false; throw new Error('response lost'); }
      },
    });
    await deliver();
    lose = true;
    await refusal(remove());
    expect(db.getSealedSecretDelivery(transport.nodeId(), PURPOSE)?.state).toBe('removing');
    expect(await remove()).toEqual({ status: 'already_deleted', generation: 2, currentSlot: SLOT_A });
    expect(db.getSealedSecretDelivery(transport.nodeId(), PURPOSE)?.state).toBe('removed');
  });

  it('converges after the send failed between persisting the generation and reaching the node', async () => {
    transport.setConfidential(true);
    let fail = true;
    install({
      beforeSend: (call) => {
        if (call.method === 'POST' && fail) { fail = false; throw new Error('connection reset'); }
      },
    });
    expect((await refusal(deliver())).code).toBe('SEALED_SECRET_TARGET_UNREACHABLE');
    expect(db.getSealedSecretDelivery(transport.nodeId(), PURPOSE)).toMatchObject({ state: 'sending', generation: 1 });
    expect(fake.files.has(VOLUME_FILE)).toBe(false);
    expect(await deliver()).toEqual({ status: 'accepted', generation: 1 });
  });

  it('converges after the node wrote the file but answered 5xx', async () => {
    transport.setConfidential(true);
    install();
    const upsert = vi.spyOn(db, 'upsertSealedSecretRecord').mockImplementationOnce(() => {
      throw new Error('database is locked');
    });
    const error = await refusal(deliver());
    // A node failure is a retryable delivery failure, not a refusal.
    expect(error.code).toBe('SEALED_SECRET_DELIVERY_FAILED');
    expect(error.status).toBe(502);
    expect(error.details.nodeCode).toBe('SECRET_STORE_UNAVAILABLE');
    expect(fake.files.get(VOLUME_FILE)?.content).toBe(SECRET);
    upsert.mockRestore();
    expect(await deliver()).toEqual({ status: 'accepted', generation: 1 });
    expect(db.getSealedSecretRecord(PURPOSE)?.generation).toBe(1);
  });

  it('maps a node refusal to the hub code, and a retry succeeds once the cause is gone', async () => {
    transport.setConfidential(true);
    install();
    fake.volumes.set('sencho_edge_secret', {});
    const error = await refusal(deliver());
    expect(error.code).toBe('SEALED_SECRET_TARGET_REFUSED');
    expect(error.details.nodeCode).toBe('SECRET_VOLUME_FOREIGN');
    // The node decided before writing anything, so the hub keeps no pending row.
    expect(db.getSealedSecretDelivery(transport.nodeId(), PURPOSE)).toBeNull();
    fake.volumes.delete('sencho_edge_secret');
    expect(await deliver()).toEqual({ status: 'accepted', generation: 1 });
  });

  /**
   * Hold the first state read until a second one arrives (two operations in
   * flight at once) or a short deadline passes (the hub ran them one after the
   * other). Without the hub's queue both would read the same generation.
   */
  function overlapStateReads(): Parameters<typeof installInProcessNodeTransport>[0]['beforeSend'] {
    let release: (() => void) | null = null;
    let reads = 0;
    return async (call) => {
      if (call.method !== 'GET' || !call.path.includes(`/${PURPOSE}/`)) return;
      reads += 1;
      if (reads === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
          setTimeout(resolve, 150);
        });
      } else if (release) {
        (release as () => void)();
      }
    };
  }

  it('serializes two deliveries for one node and purpose: the second never races the first to a generation', async () => {
    transport.setConfidential(true);
    install({ beforeSend: overlapStateReads() });
    const results = await Promise.all([deliver(SLOT_A, SECRET), deliver(SLOT_B, `${SECRET}-b`)]);
    expect(results).toEqual([{ status: 'accepted', generation: 1 }, { status: 'accepted', generation: 2 }]);
    expect(fake.files.get(VOLUME_FILE)?.content).toBe(`${SECRET}-b`);
    expect(db.getSealedSecretDelivery(transport.nodeId(), PURPOSE)).toMatchObject({ slot: SLOT_B, generation: 2, state: 'delivered' });
    // Serialized on the hub, so the node never had to refuse a colliding generation.
    expect(audit().some((line) => line.includes('reason=stale'))).toBe(false);
  });

  it('serializes a removal behind a delivery of the same slot', async () => {
    transport.setConfidential(true);
    install({ beforeSend: overlapStateReads() });
    const [delivered, removed] = await Promise.all([deliver(), remove()]);
    expect(delivered).toEqual({ status: 'accepted', generation: 1 });
    expect(removed).toEqual({ status: 'deleted', generation: 2, currentSlot: SLOT_A });
    expect(fake.files.has(VOLUME_FILE)).toBe(false);
  });

  it('will not remove the old secret while a replacement is unconfirmed, so the new file survives', async () => {
    transport.setConfidential(true);
    install();
    await deliver();
    // The node writes the replacement's file but cannot record it.
    const upsert = vi.spyOn(db, 'upsertSealedSecretRecord').mockImplementationOnce(() => {
      throw new Error('database is locked');
    });
    expect((await refusal(deliver(SLOT_B, `${SECRET}-b`))).code).toBe('SEALED_SECRET_DELIVERY_FAILED');
    upsert.mockRestore();
    expect(fake.files.get(VOLUME_FILE)?.content).toBe(`${SECRET}-b`);
    // The node's record still names the old slot; removing it now would remove the new file.
    const error = await refusal(remove(SLOT_A));
    expect(error.code).toBe('SEALED_SECRET_DELIVERY_PENDING');
    expect(fake.files.get(VOLUME_FILE)?.content).toBe(`${SECRET}-b`);
    // Removing the pending slot itself would answer not_current (the record names
    // the old slot) and report the new secret removed while it is still there.
    expect((await refusal(remove(SLOT_B))).code).toBe('SEALED_SECRET_DELIVERY_PENDING');
    expect(fake.files.get(VOLUME_FILE)?.content).toBe(`${SECRET}-b`);
    // Once the replacement converges, the old slot is simply not current.
    expect(await deliver(SLOT_B, `${SECRET}-b`)).toEqual({ status: 'accepted', generation: 2 });
    expect((await remove(SLOT_A)).status).toBe('not_current');
    expect(fake.files.get(VOLUME_FILE)?.content).toBe(`${SECRET}-b`);
  });

  it('puts the hub row back after a refusal the node decided, so it never blocks a removal', async () => {
    transport.setConfidential(true);
    install();
    await deliver();
    // The node refuses an oversize replacement before touching its file.
    const error = await refusal(deliver(SLOT_B, 'x'.repeat(5000)));
    expect(error.code).toBe('SEALED_SECRET_TARGET_REFUSED');
    expect(error.details.nodeCode).toBe('SEALED_SECRET_REQUEST_INVALID');
    expect(db.getSealedSecretDelivery(transport.nodeId(), PURPOSE)).toMatchObject({ slot: SLOT_A, generation: 1, state: 'delivered' });
    expect(fake.files.get(VOLUME_FILE)?.content).toBe(SECRET);
    expect(await remove(SLOT_A)).toEqual({ status: 'deleted', generation: 2, currentSlot: SLOT_A });
  });

  it('removes the hub row of a first delivery the node refused outright', async () => {
    transport.setConfidential(true);
    install();
    await refusal(deliver(SLOT_A, 'x'.repeat(5000)));
    expect(db.getSealedSecretDelivery(transport.nodeId(), PURPOSE)).toBeNull();
  });

  it('reports a node whose key read fails with a server error as unreachable', async () => {
    install({ respond: (call) => (call.path.endsWith('/key') ? { status: 503, body: { error: 'busy' } } : undefined) });
    expect((await service().evaluateReadiness(transport.nodeId())).readiness).toBe('unreachable');
  });

  it('treats an answer with no known code (a bridge or proxy error) as a retryable failure', async () => {
    transport.setConfidential(true);
    install({ respond: (call) => (call.method === 'POST' ? { status: 502, body: { error: 'Bad gateway' } } : undefined) });
    const error = await refusal(deliver());
    expect(error.code).toBe('SEALED_SECRET_DELIVERY_FAILED');
    expect(db.getSealedSecretDelivery(transport.nodeId(), PURPOSE)?.state).toBe('sending');
    expect(audit().some((line) => line.startsWith('sealed_secret.delivery_refused:') && line.includes('node_status=502'))).toBe(true);
  });

  it('reports a node that answers the key read without a usable key, and sends nothing', async () => {
    const { calls } = install({ respond: (call) => (call.path.endsWith('/key') ? { status: 404, body: { error: 'Not found' } } : undefined) });
    expect((await service().evaluateReadiness(transport.nodeId())).readiness).toBe('key_invalid');
    expect((await refusal(deliver())).code).toBe('SEALED_SECRET_DELIVERY_FAILED');
    expect(writes(calls)).toHaveLength(0);
  });

  it('refuses a node answer that is not a delivery result', async () => {
    transport.setConfidential(true);
    install({ respond: (call) => (call.method === 'POST' ? { status: 200, body: { status: 'accepted', generation: 'one' } } : undefined) });
    expect((await refusal(deliver())).code).toBe('SEALED_SECRET_DELIVERY_FAILED');
    expect(db.getSealedSecretDelivery(transport.nodeId(), PURPOSE)?.state).toBe('sending');
  });

  it('audits a refusal of an invalid secret id', async () => {
    install();
    const error = await refusal(service().deliver({ nodeId: transport.nodeId(), purpose: PURPOSE, slot: 'not-a-uuid', secret: SECRET, actor: 'admin' }));
    expect(error.status).toBe(400);
    expect(audit().some((line) => line.startsWith('sealed_secret.delivery_refused:') && line.includes('slot=not-a-uuid'))).toBe(true);
  });

  it('reports readiness without writing a pin', async () => {
    install();
    expect((await service().evaluateReadiness(transport.nodeId())).readiness).toBe('pin_unconfirmed');
    expect(db.getNodeSealingPin(transport.nodeId())).toBeNull();
    transport.setConfidential(true);
    expect(await service().evaluateReadiness(transport.nodeId())).toMatchObject({
      readiness: 'ready', presented: { fingerprint: localFingerprint },
    });
    probe.kind = 'unsupported';
    expect((await service().evaluateReadiness(transport.nodeId())).readiness).toBe('unsupported');
  });

  it('refuses an Admin confirmation of a fingerprint the node does not present', async () => {
    install();
    const error = await refusal(service().confirmFingerprint(transport.nodeId(), 'not-the-fingerprint', 'admin'));
    expect(error.code).toBe('SEAL_KEY_MISMATCH');
    expect(db.getNodeSealingPin(transport.nodeId())).toBeNull();
  });
});

describe('sealed secret delivery over a Pilot tunnel that goes away', () => {
  it('refuses as unreachable when the tunnel is gone before the request, and sends nothing', async () => {
    const { calls } = installInProcessNodeTransport({ app, bearer: transports[1].bearer });
    const { PilotTunnelManager } = await import('../services/PilotTunnelManager');
    vi.spyOn(PilotTunnelManager.getInstance(), 'getLoopbackUrl').mockReturnValue(null);
    const error = await refusal(service().deliver({ nodeId: pilotNodeId, purpose: PURPOSE, slot: SLOT_A, secret: SECRET, actor: 'admin' }));
    expect(error.code).toBe('SEALED_SECRET_TARGET_UNREACHABLE');
    expect(calls).toHaveLength(0);
  });

  it('never trusts a key fetched while the tunnel dropped to plaintext mid-fetch', async () => {
    pilotConfidential = true;
    installInProcessNodeTransport({
      app,
      bearer: transports[1].bearer,
      beforeSend: (call) => { if (call.path.endsWith('/key')) pilotConfidential = false; },
    });
    expect((await refusal(service().deliver({ nodeId: pilotNodeId, purpose: PURPOSE, slot: SLOT_A, secret: SECRET, actor: 'admin' }))).code)
      .toBe('SEALED_SECRET_TRANSPORT_NOT_CONFIDENTIAL');
    expect(db.getNodeSealingPin(pilotNodeId)?.confidential).toBe(false);
  });
});

describe('sealed secret delivery to the local node', () => {
  it('runs in process through the same store, with no network call', async () => {
    const { calls } = installInProcessNodeTransport({ app, bearer: () => '' });
    expect(await service().deliver({ nodeId: localNodeId, purpose: PURPOSE, slot: SLOT_A, secret: SECRET, actor: 'admin' }))
      .toEqual({ status: 'accepted', generation: 1 });
    expect(fake.files.get(VOLUME_FILE)?.content).toBe(SECRET);
    expect((await service().remove({ nodeId: localNodeId, purpose: PURPOSE, slot: SLOT_A, actor: 'admin' })).status).toBe('deleted');
    expect(calls).toHaveLength(0);
    expect((await service().evaluateReadiness(localNodeId)).readiness).toBe('local');
  });

  it('accepts, replaces and removes on the local daemon when a remote node is the default', async () => {
    const { calls } = installInProcessNodeTransport({ app, bearer: () => '' });
    const restore = await remoteDefaultWithLocalDaemon(pilotNodeId);
    try {
      const deliver = (slot: string, secret: string) => service().deliver({ nodeId: localNodeId, purpose: PURPOSE, slot, secret, actor: 'admin' });
      expect(await deliver(SLOT_A, SECRET)).toEqual({ status: 'accepted', generation: 1 });
      expect(await deliver(SLOT_B, `${SECRET}-b`)).toMatchObject({ status: 'accepted', generation: 2 });
      expect(fake.files.get(VOLUME_FILE)?.content).toBe(`${SECRET}-b`);
      expect((await service().remove({ nodeId: localNodeId, purpose: PURPOSE, slot: SLOT_B, actor: 'admin' })).status).toBe('deleted');
      expect(fake.files.has(VOLUME_FILE)).toBe(false);
      expect(calls).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it('accepts, replaces and removes in process while an unrelated remote credential cannot be decrypted', async () => {
    const { calls } = installInProcessNodeTransport({ app, bearer: () => '' });
    const restore = await remoteDefaultWithLocalDaemon(pilotNodeId);
    const restoreUnreadable = unreadableRemote();
    try {
      const deliver = (slot: string, secret: string) => service().deliver({ nodeId: localNodeId, purpose: PURPOSE, slot, secret, actor: 'admin' });
      expect(await deliver(SLOT_A, SECRET)).toEqual({ status: 'accepted', generation: 1 });
      expect(await deliver(SLOT_B, `${SECRET}-b`)).toMatchObject({ status: 'accepted', generation: 2 });
      expect((await service().remove({ nodeId: localNodeId, purpose: PURPOSE, slot: SLOT_B, actor: 'admin' })).status).toBe('deleted');
      expect(fake.files.has(VOLUME_FILE)).toBe(false);
      expect(calls).toHaveLength(0);
    } finally {
      restoreUnreadable();
      restore();
    }
  });
});
