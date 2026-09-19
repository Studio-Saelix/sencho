import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let db: import('../services/DatabaseService').DatabaseService;
let remoteNodeId: number;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  const dbModule = await import('../services/DatabaseService');
  db = dbModule.DatabaseService.getInstance();
  remoteNodeId = db.addNode({
    name: 'seal-pin-remote',
    type: 'remote',
    compose_dir: '/app/compose',
    is_default: false,
    api_url: 'http://192.168.1.50:1852',
    api_token: 'token',
    mode: 'proxy',
  });
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

describe('node_sealing_keys TOFU pin', () => {
  it('pins on first insert and returns the stored row', () => {
    const pinned = db.pinNodeSealingKey(remoteNodeId, 'pubkey-a', 'fp-a');
    expect(pinned.pubkey).toBe('pubkey-a');
    expect(pinned.fingerprint).toBe('fp-a');
    expect(pinned.registeredAt).toBeGreaterThan(0);
    expect(db.getNodeSealingKey(remoteNodeId)).toEqual(pinned);
  });

  it('does not overwrite an existing pin (ON CONFLICT DO NOTHING)', () => {
    const first = db.getNodeSealingKey(remoteNodeId)!;
    const second = db.pinNodeSealingKey(remoteNodeId, 'pubkey-b', 'fp-b');
    expect(second.pubkey).toBe(first.pubkey);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.registeredAt).toBe(first.registeredAt);
  });

  it('clearNodeSealingKey removes the pin so the next delivery can re-pin', () => {
    db.clearNodeSealingKey(remoteNodeId);
    expect(db.getNodeSealingKey(remoteNodeId)).toBeNull();
    const pinned = db.pinNodeSealingKey(remoteNodeId, 'pubkey-b', 'fp-b');
    expect(pinned.pubkey).toBe('pubkey-b');
    expect(pinned.fingerprint).toBe('fp-b');
  });

  it('deleteNode removes the sealing-key row', () => {
    const doomedId = db.addNode({
      name: 'seal-pin-doomed',
      type: 'remote',
      compose_dir: '/app/compose',
      is_default: false,
      api_url: 'http://192.168.1.51:1852',
      api_token: 'token',
      mode: 'proxy',
    });
    db.pinNodeSealingKey(doomedId, 'pubkey-x', 'fp-x');
    expect(db.getNodeSealingKey(doomedId)).not.toBeNull();
    db.deleteNode(doomedId);
    expect(db.getNodeSealingKey(doomedId)).toBeNull();
  });

  it('clearNodeSealingKey is idempotent for missing rows', () => {
    expect(() => db.clearNodeSealingKey(99999)).not.toThrow();
  });
});
