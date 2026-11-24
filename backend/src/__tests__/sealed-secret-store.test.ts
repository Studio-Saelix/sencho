import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanupTestDb, setupTestDb } from './helpers/setupTestDb';
import { createFakeSecretDocker, type FakeSecretDocker } from './helpers/fakeSecretDocker';

type StoreModule = typeof import('../services/sealedSecrets/SealedSecretStore');

const PURPOSE = 'edge-tunnel-run-token' as const;
const VOLUME = 'sencho_edge_secret';
const SLOT_A = '0b9f3c2e-1d4a-4b5c-8d6e-7f8091a2b3c4';
const SLOT_B = '1c0a4d3f-2e5b-4c6d-9e7f-8a9102b3c4d5';
const SECRET = 'S3ntinelSecretValue-qwertyuiop';
const WHO = { actor: 'admin', path: 'test', method: 'POST' };

let tmpDir: string;
let store: InstanceType<StoreModule['SealedSecretStore']>;
let StoreClass: StoreModule['SealedSecretStore'];
let db: import('../services/DatabaseService').DatabaseService;
let fake: FakeSecretDocker;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ SealedSecretStore: StoreClass } = await import('../services/sealedSecrets/SealedSecretStore'));
  db = (await import('../services/DatabaseService')).DatabaseService.getInstance();
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  vi.restoreAllMocks();
  db.getDb().prepare('DELETE FROM sealed_secret_generations').run();
  db.getDb().prepare('DELETE FROM audit_log').run();
  fake = createFakeSecretDocker();
  StoreClass.resetForTests();
  store = StoreClass.getInstance();
  store.setDockerForTests(fake.docker);
});

function auditSummaries(): string[] {
  db.flushAuditLogBuffer?.();
  return (db.getDb().prepare('SELECT summary FROM audit_log ORDER BY id').all() as { summary: string }[]).map((row) => row.summary);
}

async function refusal(promise: Promise<unknown>): Promise<{ code: string; status: number; details: Record<string, unknown> }> {
  try {
    await promise;
  } catch (error: unknown) {
    return error as { code: string; status: number; details: Record<string, unknown> };
  }
  throw new Error('expected a refusal');
}

describe('SealedSecretStore.accept', () => {
  it('creates the labelled volume, writes the file with its owner and mode, then records it', async () => {
    const result = await store.accept(PURPOSE, SLOT_A, 1, SECRET, WHO);
    expect(result.status).toBe('accepted');
    expect(fake.volumes.get(VOLUME)).toEqual({ 'io.sencho.secret': PURPOSE });
    expect(fake.files.get(`${VOLUME}/token`)).toEqual({ content: SECRET, uid: 65532, gid: 65532, mode: '0400' });
    expect(db.getSealedSecretRecord(PURPOSE)).toMatchObject({ slot: SLOT_A, generation: 1, state: 'present' });
    expect(auditSummaries().some((line) => line.startsWith('sealed_secret.accepted:'))).toBe(true);
  });

  it('answers already_accepted to an identical retry at the same generation without writing again', async () => {
    await store.accept(PURPOSE, SLOT_A, 1, SECRET, WHO);
    const runs = fake.writerRuns();
    const again = await store.accept(PURPOSE, SLOT_A, 1, SECRET, WHO);
    expect(again.status).toBe('already_accepted');
    expect(fake.writerRuns()).toBe(runs);
  });

  it.each([
    ['different content', SLOT_A, `${SECRET}-other`, 1],
    ['a different slot', SLOT_B, SECRET, 1],
    ['an older generation', SLOT_A, SECRET, 0.5],
  ])('refuses the same or older generation with %s as stale', async (_label, slot, secret, generationFactor) => {
    await store.accept(PURPOSE, SLOT_A, 2, SECRET, WHO);
    const generation = generationFactor === 1 ? 2 : 1;
    const error = await refusal(store.accept(PURPOSE, slot, generation, secret, WHO));
    expect(error.code).toBe('SEALED_SECRET_GENERATION_STALE');
    expect(error.status).toBe(409);
    expect(error.details.purposeGeneration).toBe(2);
    expect(fake.files.get(`${VOLUME}/token`)?.content).toBe(SECRET);
  });

  it('replaces with a new slot at a higher generation and keeps one record', async () => {
    await store.accept(PURPOSE, SLOT_A, 1, SECRET, WHO);
    const result = await store.accept(PURPOSE, SLOT_B, 2, `${SECRET}-b`, WHO);
    expect(result.status).toBe('accepted');
    expect(db.listSealedSecretRecords()).toHaveLength(1);
    expect(db.getSealedSecretRecord(PURPOSE)).toMatchObject({ slot: SLOT_B, generation: 2 });
    expect(auditSummaries().some((line) => line.startsWith('sealed_secret.replaced:') && line.includes(`previous_slot=${SLOT_A}`))).toBe(true);
  });

  it('leaves the generation unrecorded when the writer fails, so the same generation can be retried', async () => {
    fake.exitCodes.push(1);
    const error = await refusal(store.accept(PURPOSE, SLOT_A, 1, SECRET, WHO));
    expect(error.code).toBe('SECRET_STORE_UNAVAILABLE');
    expect(error.status).toBe(503);
    expect(db.getSealedSecretRecord(PURPOSE)).toBeNull();
    expect((await store.accept(PURPOSE, SLOT_A, 1, SECRET, WHO)).status).toBe('accepted');
  });

  it('answers 503 when the record write fails after the file was written, and the retry converges', async () => {
    const upsert = vi.spyOn(db, 'upsertSealedSecretRecord').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const error = await refusal(store.accept(PURPOSE, SLOT_A, 1, SECRET, WHO));
    expect(error.code).toBe('SECRET_STORE_UNAVAILABLE');
    expect(db.getSealedSecretRecord(PURPOSE)).toBeNull();
    upsert.mockRestore();
    expect((await store.accept(PURPOSE, SLOT_A, 1, SECRET, WHO)).status).toBe('accepted');
    expect(db.getSealedSecretRecord(PURPOSE)?.generation).toBe(1);
  });

  it('serializes concurrent accepts for one purpose: the second waits for the first writer to finish', async () => {
    let release: () => void = () => undefined;
    fake.holdNextWait = new Promise<void>((resolve) => { release = resolve; });
    const first = store.accept(PURPOSE, SLOT_A, 1, SECRET, WHO);
    const second = store.accept(PURPOSE, SLOT_B, 2, `${SECRET}-b`, WHO);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The first writer is still running; the second has not started its own.
    expect(fake.writerRuns()).toBe(1);
    release();
    await expect(first).resolves.toMatchObject({ status: 'accepted' });
    await expect(second).resolves.toMatchObject({ status: 'accepted' });
    expect(fake.writerRuns()).toBe(2);
    expect(db.getSealedSecretRecord(PURPOSE)).toMatchObject({ slot: SLOT_B, generation: 2 });
    expect(fake.files.get(`${VOLUME}/token`)?.content).toBe(`${SECRET}-b`);
  });

  it('keeps serving after a failed operation: a refusal does not block the next one', async () => {
    fake.exitCodes.push(1);
    const failed = store.accept(PURPOSE, SLOT_A, 1, SECRET, WHO);
    const next = store.accept(PURPOSE, SLOT_A, 1, SECRET, WHO);
    expect((await refusal(failed)).code).toBe('SECRET_STORE_UNAVAILABLE');
    await expect(next).resolves.toMatchObject({ status: 'accepted', generation: 1 });
  });

  it('removes a writer a crashed run left behind, and does not count it as a foreign mount', async () => {
    fake.volumes.set(VOLUME, { 'io.sencho.secret': PURPOSE });
    fake.leftoverWriters.push({ Id: 'crashed-writer', volume: VOLUME });
    expect((await store.accept(PURPOSE, SLOT_A, 1, SECRET, WHO)).status).toBe('accepted');
    expect(fake.removedContainers).toEqual(['crashed-writer']);
  });

  it('answers 503 when the helper stream fails, and records nothing', async () => {
    fake.streamErrorNext = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    expect((await refusal(store.accept(PURPOSE, SLOT_A, 1, SECRET, WHO))).code).toBe('SECRET_STORE_UNAVAILABLE');
    expect(db.getSealedSecretRecord(PURPOSE)).toBeNull();
    expect(fake.writerRemovals()).toBe(1);
  });

  it('refuses an empty or oversize secret before touching Docker', async () => {
    expect((await refusal(store.accept(PURPOSE, SLOT_A, 1, '', WHO))).code).toBe('SEALED_SECRET_REQUEST_INVALID');
    expect((await refusal(store.accept(PURPOSE, SLOT_A, 1, 'x'.repeat(4097), WHO))).code).toBe('SEALED_SECRET_REQUEST_INVALID');
    expect(fake.writerRuns()).toBe(0);
  });

  it('refuses a volume of that name without the store label and writes nothing', async () => {
    fake.volumes.set(VOLUME, {});
    const error = await refusal(store.accept(PURPOSE, SLOT_A, 1, SECRET, WHO));
    expect(error.code).toBe('SECRET_VOLUME_FOREIGN');
    expect(error.status).toBe(409);
    expect(fake.writerRuns()).toBe(0);
    expect(db.getSealedSecretRecord(PURPOSE)).toBeNull();
  });

  it('refuses a labelled volume a container already mounts when the node has no record for it', async () => {
    fake.volumes.set(VOLUME, { 'io.sencho.secret': PURPOSE });
    fake.mounted.add(VOLUME);
    expect((await refusal(store.accept(PURPOSE, SLOT_A, 1, SECRET, WHO))).code).toBe('SECRET_VOLUME_FOREIGN');
    expect(fake.writerRuns()).toBe(0);
  });

  it('adopts its own labelled, unmounted volume left by a failed first write', async () => {
    fake.volumes.set(VOLUME, { 'io.sencho.secret': PURPOSE });
    expect((await store.accept(PURPOSE, SLOT_A, 1, SECRET, WHO)).status).toBe('accepted');
  });

  it('runs the writer locked down, with the secret on stdin only', async () => {
    await store.accept(PURPOSE, SLOT_A, 1, SECRET, WHO);
    const opts = fake.createOptions[0];
    expect(opts.User).toBe('0:0');
    expect(opts.HostConfig?.CapDrop).toEqual(['ALL']);
    expect(opts.HostConfig?.CapAdd).toEqual(['CHOWN', 'FOWNER']);
    expect(opts.HostConfig?.NetworkMode).toBe('none');
    expect(opts.HostConfig?.ReadonlyRootfs).toBe(true);
    expect(opts.HostConfig?.Privileged).toBe(false);
    expect(opts.HostConfig?.SecurityOpt).toEqual(['no-new-privileges:true']);
    expect(opts.HostConfig?.LogConfig?.Type).toBe('none');
    // If Docker has to create the volume, it gets the store's label, never a bare look-alike.
    expect(opts.HostConfig?.Mounts).toEqual([{
      Type: 'volume',
      Source: VOLUME,
      Target: '/v',
      ReadOnly: false,
      VolumeOptions: { NoCopy: false, Labels: { 'io.sencho.secret': PURPOSE }, DriverConfig: { Name: 'local', Options: {} } },
    }]);
    expect(opts.OpenStdin).toBe(true);
    expect(opts.Env).toBeUndefined();
    expect(JSON.stringify(opts)).not.toContain(SECRET.slice(0, 8));
  });
});

describe('the store resolves this instance\'s own daemon', () => {
  it('uses the default node when it is local, else the lowest-id local node, and refuses with 503 when there is none', async () => {
    const { NodeRegistry } = await import('../services/NodeRegistry');
    const registry = NodeRegistry.getInstance();
    const node = (id: number, type: 'local' | 'remote') => ({ id, type }) as unknown as import('../services/DatabaseService').Node;
    const getDefault = vi.spyOn(db, 'getDefaultNode').mockReturnValue(node(4, 'local'));
    const getNodes = vi.spyOn(db, 'getNodes').mockReturnValue([node(9, 'local'), node(4, 'remote'), node(6, 'local')]);
    expect(registry.getLocalNodeId()).toBe(4);
    getDefault.mockReturnValue(node(4, 'remote'));
    expect(registry.getLocalNodeId()).toBe(6);
    getNodes.mockReturnValue([node(4, 'remote')]);
    expect(registry.getLocalNodeId()).toBeNull();

    store.setDockerForTests(null);
    const error = await refusal(store.accept(PURPOSE, SLOT_A, 1, SECRET, WHO));
    expect(error.code).toBe('SECRET_STORE_UNAVAILABLE');
    expect(error.status).toBe(503);
    expect(db.getSealedSecretRecord(PURPOSE)).toBeNull();
  });
});

describe('volume prune racing a first delivery', () => {
  it('keeps a secret a first delivery wrote after the prune listed the volumes, and an identical retry still finds it', async () => {
    const { NodeRegistry } = await import('../services/NodeRegistry');
    const DockerController = (await import('../services/DockerController')).default;
    vi.spyOn(NodeRegistry.getInstance(), 'getDocker').mockReturnValue(fake.docker);
    fake.volumes.set('app_data', {});
    // The delivery lands right after the prune's first volume listing, the
    // moment a choice made from that listing would be stale.
    fake.afterListVolumes = async () => {
      fake.afterListVolumes = null;
      expect((await store.accept(PURPOSE, SLOT_A, 1, SECRET, WHO)).status).toBe('accepted');
    };

    await DockerController.getInstance(1).pruneSystem('volumes');

    expect(fake.removedVolumes).toEqual(['app_data']);
    expect(fake.volumes.get(VOLUME)).toEqual({ 'io.sencho.secret': PURPOSE });
    expect(fake.files.get(`${VOLUME}/token`)?.content).toBe(SECRET);
    expect(db.getSealedSecretRecord(PURPOSE)).toMatchObject({ slot: SLOT_A, generation: 1, state: 'present' });
    expect((await store.accept(PURPOSE, SLOT_A, 1, SECRET, WHO)).status).toBe('already_accepted');
    expect(fake.files.get(`${VOLUME}/token`)?.content).toBe(SECRET);
  });
});

describe('SealedSecretStore.remove', () => {
  it('records the removal without starting the writer when the volume was removed outside Sencho', async () => {
    await store.accept(PURPOSE, SLOT_A, 1, SECRET, WHO);
    fake.volumes.delete(VOLUME);
    const runs = fake.writerRuns();
    expect((await store.remove(PURPOSE, SLOT_A, 2, WHO)).status).toBe('deleted');
    expect(fake.writerRuns()).toBe(runs);
    expect(auditSummaries().some((line) => line.startsWith('sealed_secret.removed:') && line.includes('reason=volume_gone'))).toBe(true);
    // Nothing recreated the volume, labelled or not, so the next delivery creates the store's own.
    expect(fake.volumes.has(VOLUME)).toBe(false);
    expect((await store.accept(PURPOSE, SLOT_A, 3, SECRET, WHO)).status).toBe('accepted');
    expect(fake.volumes.get(VOLUME)).toEqual({ 'io.sencho.secret': PURPOSE });
  });

  it('records the removal without touching a volume someone recreated without the store label', async () => {
    await store.accept(PURPOSE, SLOT_A, 1, SECRET, WHO);
    fake.volumes.set(VOLUME, {});
    const runs = fake.writerRuns();
    expect((await store.remove(PURPOSE, SLOT_A, 2, WHO)).status).toBe('deleted');
    expect(fake.writerRuns()).toBe(runs);
    expect(db.getSealedSecretRecord(PURPOSE)).toMatchObject({ state: 'deleted', generation: 2 });
    expect(auditSummaries().some((line) => line.startsWith('sealed_secret.removed:') && line.includes('reason=volume_replaced'))).toBe(true);
  });

  it('sweeps a leftover writer before every run, also when the node already holds a record', async () => {
    await store.accept(PURPOSE, SLOT_A, 1, SECRET, WHO);
    fake.leftoverWriters.push({ Id: 'replayable-writer', volume: VOLUME });
    expect((await store.accept(PURPOSE, SLOT_B, 2, `${SECRET}-b`, WHO)).status).toBe('accepted');
    expect(fake.removedContainers).toEqual(['replayable-writer']);
  });

  it('audits a removal that names a slot other than the live one', async () => {
    await store.accept(PURPOSE, SLOT_A, 1, SECRET, WHO);
    await store.remove(PURPOSE, SLOT_B, 2, WHO);
    expect(auditSummaries().some((line) => line.startsWith('sealed_secret.remove_skipped:') && line.includes('reason=not_current'))).toBe(true);
  });

  it('answers 503 when recording a removal of an already deleted slot fails', async () => {
    await store.accept(PURPOSE, SLOT_A, 1, SECRET, WHO);
    await store.remove(PURPOSE, SLOT_A, 2, WHO);
    vi.spyOn(db, 'upsertSealedSecretRecord').mockImplementationOnce(() => { throw new Error('database is locked'); });
    expect((await refusal(store.remove(PURPOSE, SLOT_A, 3, WHO))).code).toBe('SECRET_STORE_UNAVAILABLE');
  });

  it('answers not_current for a slot that is not live and never starts the writer', async () => {
    expect(await store.remove(PURPOSE, SLOT_A, 1, WHO)).toEqual({ status: 'not_current', generation: 0, currentSlot: null });
    await store.accept(PURPOSE, SLOT_B, 1, SECRET, WHO);
    const runs = fake.writerRuns();
    expect(await store.remove(PURPOSE, SLOT_A, 5, WHO)).toEqual({ status: 'not_current', generation: 1, currentSlot: SLOT_B });
    expect(fake.writerRuns()).toBe(runs);
    expect(fake.files.get(`${VOLUME}/token`)?.content).toBe(SECRET);
    expect(db.getSealedSecretRecord(PURPOSE)).toMatchObject({ slot: SLOT_B, generation: 1, state: 'present' });
  });

  it('removes the live slot at a higher generation, then is idempotent, then accepts a redelivery', async () => {
    await store.accept(PURPOSE, SLOT_A, 1, SECRET, WHO);
    expect((await refusal(store.remove(PURPOSE, SLOT_A, 1, WHO))).code).toBe('SEALED_SECRET_GENERATION_STALE');
    expect(await store.remove(PURPOSE, SLOT_A, 2, WHO)).toEqual({ status: 'deleted', generation: 2, currentSlot: SLOT_A });
    expect(fake.files.has(`${VOLUME}/token`)).toBe(false);
    expect(db.getSealedSecretRecord(PURPOSE)).toMatchObject({ state: 'deleted', generation: 2, fingerprint: null });
    expect((await store.remove(PURPOSE, SLOT_A, 2, WHO)).status).toBe('already_deleted');
    expect((await refusal(store.remove(PURPOSE, SLOT_A, 1, WHO))).code).toBe('SEALED_SECRET_GENERATION_STALE');
    expect((await store.remove(PURPOSE, SLOT_A, 3, WHO)).status).toBe('deleted');
    expect((await store.accept(PURPOSE, SLOT_A, 4, SECRET, WHO)).status).toBe('accepted');
    expect(fake.files.get(`${VOLUME}/token`)?.content).toBe(SECRET);
  });

  it('keeps the record present when the removal fails, so the retry converges', async () => {
    await store.accept(PURPOSE, SLOT_A, 1, SECRET, WHO);
    fake.exitCodes.push(1);
    expect((await refusal(store.remove(PURPOSE, SLOT_A, 2, WHO))).code).toBe('SECRET_STORE_UNAVAILABLE');
    expect(db.getSealedSecretRecord(PURPOSE)).toMatchObject({ state: 'present', generation: 1 });
    expect((await store.remove(PURPOSE, SLOT_A, 2, WHO)).status).toBe('deleted');
  });

  it('describes the purpose record and never a value', async () => {
    expect(store.describe(PURPOSE, SLOT_A)).toMatchObject({ state: 'absent', purposeGeneration: 0 });
    await store.accept(PURPOSE, SLOT_A, 3, SECRET, WHO);
    const described = store.describe(PURPOSE, SLOT_A);
    expect(described).toMatchObject({ state: 'present', purposeGeneration: 3 });
    expect(store.describe(PURPOSE, SLOT_B)).toMatchObject({ state: 'absent', purposeGeneration: 3, fingerprint: null });
    expect(JSON.stringify([described, store.list()])).not.toContain(SECRET.slice(0, 8));
  });

  it('survives a node restart: a fresh store reads the same record', async () => {
    await store.accept(PURPOSE, SLOT_A, 1, SECRET, WHO);
    StoreClass.resetForTests();
    const restarted = StoreClass.getInstance();
    restarted.setDockerForTests(fake.docker);
    expect(restarted.describe(PURPOSE, SLOT_A)).toMatchObject({ state: 'present', purposeGeneration: 1 });
    expect((await restarted.accept(PURPOSE, SLOT_A, 1, SECRET, WHO)).status).toBe('already_accepted');
  });
});

describe('secret writer lifecycle', () => {
  it('gives up on a hung helper after its timeout and still force-removes the container', async () => {
    const { runSecretWriter } = await import('../services/sealedSecrets/secretVolumeWriter');
    const { getSealedSecretPurpose } = await import('../services/sealedSecrets/purposes');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      fake.holdNextWait = new Promise<void>(() => undefined);
      const run = runSecretWriter(fake.docker, { name: VOLUME, purposeId: PURPOSE }, getSealedSecretPurpose(PURPOSE), { kind: 'write', secret: SECRET });
      const outcome = refusal(run);
      await vi.advanceTimersByTimeAsync(30_000);
      const error = await outcome;
      expect(error.code).toBe('SECRET_STORE_UNAVAILABLE');
      expect(fake.writerRemovals()).toBe(1);
      expect(fake.files.has(`${VOLUME}/token`)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
