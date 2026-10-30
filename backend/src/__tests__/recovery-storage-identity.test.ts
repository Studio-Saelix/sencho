/**
 * Storage identity: stable across stack renames and restarts, a new linked
 * generation when a volume is recreated, one identity for shared storage, and
 * never keyed on a stack name, a node's integer id or a display name.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let mod: typeof import('../services/recovery/storageIdentity');
let RecoveryError: typeof import('../services/recovery/redaction').RecoveryError;

const ENGINE = 'docker-engine:7f1c2a90-aaaa-bbbb-cccc-000000000001';

beforeAll(async () => {
  tmpDir = await setupTestDb();
  mod = await import('../services/recovery/storageIdentity');
  ({ RecoveryError } = await import('../services/recovery/redaction'));
});

afterAll(() => cleanupTestDb(tmpDir));

function errorClassOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof RecoveryError ? err.errorClass : `not-recovery:${String(err)}`;
  }
}

describe('canonicalizeLocator', () => {
  it('keeps a Docker volume name exactly, case included', () => {
    expect(mod.canonicalizeLocator('named_volume', 'App_data.v1')).toBe('App_data.v1');
    expect(mod.canonicalizeLocator('named_volume', 'app_data')).not.toBe(mod.canonicalizeLocator('named_volume', 'App_data'));
  });

  it('refuses names Docker would refuse', () => {
    for (const bad of ['', 'a', '-lead', 'has space', 'sl/ash', 'nul\0l']) {
      expect(errorClassOf(() => mod.canonicalizeLocator('named_volume', bad))).toBe('invalid_request');
    }
  });

  it('folds trailing and doubled slashes so one directory is one identity', () => {
    expect(mod.canonicalizeLocator('bind_root', '/srv/app/data/')).toBe('/srv/app/data');
    expect(mod.canonicalizeLocator('bind_root', '/srv//app/./data')).toBe('/srv/app/data');
  });

  it('refuses relative paths, traversal and the filesystem root', () => {
    for (const bad of ['srv/app', '/srv/../etc', '/srv/app/..', '/', '//', '/srv/\0x']) {
      expect(errorClassOf(() => mod.canonicalizeLocator('bind_root', bad))).toBe('invalid_request');
    }
  });
});

describe('resolveOwnerNodeKey', () => {
  it('uses the engine id Docker persists', async () => {
    await expect(mod.resolveOwnerNodeKey({ info: async () => ({ ID: ' abc-123 ' }) } as never)).resolves.toBe('docker-engine:abc-123');
  });

  it('is unknown, never a guess, when Docker does not answer or has no id', async () => {
    for (const docker of [
      { info: async () => { throw new Error('connect ENOENT /var/run/docker.sock'); } },
      { info: async () => ({ ID: '' }) },
      { info: async () => ({}) },
      { info: async () => null },
    ]) {
      await expect(mod.resolveOwnerNodeKey(docker as never)).rejects.toMatchObject({ errorClass: 'identity_unknown' });
    }
  });
});

describe('StorageIdentityStore', () => {
  const store = () => mod.StorageIdentityStore.getInstance();

  it('returns the same identity for the same storage, across a store restart', () => {
    const first = store().observe({
      ownerNodeKey: ENGINE, kind: 'named_volume', locator: 'web_data', generationToken: '2026-10-01T00:00:00Z',
      dependents: [{ stackName: 'web', serviceName: 'db' }],
    }, 1_000);
    expect(first.generation).toBe(1);
    expect(first.lineageParentId).toBeNull();

    // A new process reads the same row back; nothing is held in memory.
    const restarted = new mod.StorageIdentityStore();
    const again = restarted.observe({
      ownerNodeKey: ENGINE, kind: 'named_volume', locator: 'web_data', generationToken: '2026-10-01T00:00:00Z',
      dependents: [{ stackName: 'web', serviceName: 'db' }],
    }, 2_000);
    expect(again.id).toBe(first.id);
    expect(again.firstSeenAt).toBe(1_000);
    expect(again.lastSeenAt).toBe(2_000);
  });

  it('keeps the identity when the stack that uses it is renamed', () => {
    const before = store().observe({
      ownerNodeKey: ENGINE, kind: 'named_volume', locator: 'pinned_data', generationToken: 'g1',
      dependents: [{ stackName: 'shop', serviceName: 'db' }],
    });
    const after = store().observe({
      ownerNodeKey: ENGINE, kind: 'named_volume', locator: 'pinned_data', generationToken: 'g1',
      dependents: [{ stackName: 'storefront', serviceName: 'db' }],
    });
    expect(after.id).toBe(before.id);
    expect(store().listDependents(after.storageKey)).toEqual([{ stackName: 'storefront', serviceName: 'db' }]);
  });

  it('opens a linked generation when the volume is recreated under the same name', () => {
    const g1 = store().observe({
      ownerNodeKey: ENGINE, kind: 'named_volume', locator: 'cache_data', generationToken: 'created-1', dependents: [],
    });
    const g2 = store().observe({
      ownerNodeKey: ENGINE, kind: 'named_volume', locator: 'cache_data', generationToken: 'created-2', dependents: [],
    });
    expect(g2.id).not.toBe(g1.id);
    expect(g2.storageKey).toBe(g1.storageKey);
    expect(g2.generation).toBe(2);
    expect(g2.lineageParentId).toBe(g1.id);
    expect(store().getById(g1.id)?.state).toBe('superseded');
    expect(store().getCurrent(g1.storageKey)?.id).toBe(g2.id);
    expect(store().listGenerations(g1.storageKey).map((g) => g.generation)).toEqual([1, 2]);

    // Seeing the old token again is a third generation, not a revival of the first.
    const g3 = store().observe({
      ownerNodeKey: ENGINE, kind: 'named_volume', locator: 'cache_data', generationToken: 'created-1', dependents: [],
    });
    expect(g3.generation).toBe(3);
    expect(g3.id).not.toBe(g1.id);
  });

  it('models shared storage once, with every stack that uses it', () => {
    const shared = store().observe({
      ownerNodeKey: ENGINE, kind: 'named_volume', locator: 'shared_media', generationToken: 't',
      dependents: [
        { stackName: 'photos', serviceName: 'app' },
        { stackName: 'backup-tools', serviceName: null },
        { stackName: 'photos', serviceName: 'app' },
      ],
    });
    const viaOtherAlias = store().observe({
      ownerNodeKey: ENGINE, kind: 'named_volume', locator: 'shared_media', generationToken: 't',
      dependents: [
        { stackName: 'photos', serviceName: 'app' },
        { stackName: 'backup-tools', serviceName: null },
      ],
    });
    expect(viaOtherAlias.id).toBe(shared.id);
    expect(store().listDependents(shared.storageKey)).toEqual([
      { stackName: 'backup-tools', serviceName: null },
      { stackName: 'photos', serviceName: 'app' },
    ]);
  });

  it('treats the same path spelled two ways as one bind root', () => {
    const a = store().observe({ ownerNodeKey: ENGINE, kind: 'bind_root', locator: '/srv/app/data/', generationToken: 'ino-1', dependents: [] });
    const b = store().observe({ ownerNodeKey: ENGINE, kind: 'bind_root', locator: '/srv//app/data', generationToken: 'ino-1', dependents: [] });
    expect(b.id).toBe(a.id);
  });

  it('keeps the same name on another engine, or of another kind, distinct', () => {
    const here = store().observe({ ownerNodeKey: ENGINE, kind: 'named_volume', locator: 'common', generationToken: 't', dependents: [] });
    const there = store().observe({ ownerNodeKey: 'docker-engine:other', kind: 'named_volume', locator: 'common', generationToken: 't', dependents: [] });
    expect(there.storageKey).not.toBe(here.storageKey);
  });

  it('does not put a stack name, node id or display name in the key', () => {
    const identity = store().observe({ ownerNodeKey: ENGINE, kind: 'named_volume', locator: 'keyed', generationToken: 't', dependents: [{ stackName: 'web', serviceName: null }] });
    expect(identity.storageKey).toBe(mod.deriveStorageKey(identity.authorityId, ENGINE, 'named_volume', 'keyed'));
  });

  it('refuses an observation it cannot identify', () => {
    expect(errorClassOf(() => store().observe({ ownerNodeKey: ENGINE, kind: 'named_volume', locator: 'x1', generationToken: ' ', dependents: [] }))).toBe('identity_unknown');
    expect(errorClassOf(() => store().observe({ ownerNodeKey: '', kind: 'named_volume', locator: 'x1', generationToken: 't', dependents: [] }))).toBe('identity_unknown');
    expect(errorClassOf(() => store().observe({ ownerNodeKey: ENGINE, kind: 'named_volume', locator: 'x1', generationToken: 't', dependents: [{ stackName: '', serviceName: null }] }))).toBe('invalid_request');
  });

  it('leaves no partial row behind when an observation is refused mid-write', () => {
    const before = store().observe({ ownerNodeKey: ENGINE, kind: 'named_volume', locator: 'atomic', generationToken: 'g1', dependents: [{ stackName: 'a', serviceName: null }] });
    expect(errorClassOf(() => store().observe({
      ownerNodeKey: ENGINE, kind: 'named_volume', locator: 'atomic', generationToken: 'g2',
      dependents: [{ stackName: 'a', serviceName: null }, { stackName: '', serviceName: null }],
    }))).toBe('invalid_request');
    expect(store().getCurrent(before.storageKey)?.id).toBe(before.id);
    expect(store().listGenerations(before.storageKey)).toHaveLength(1);
    expect(store().listDependents(before.storageKey)).toEqual([{ stackName: 'a', serviceName: null }]);
  });
});
