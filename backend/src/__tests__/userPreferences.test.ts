/**
 * Tests for per-user interface preferences (appearance + navigation):
 *   - Auth chain: 401 unauthenticated, machine scopes (node_proxy /
 *     pilot_tunnel) rejected 403 with no rows created, API tokens rejected
 *     403 SCOPE_DENIED on GET (route guard) and on writes, viewer succeeds
 *     on all four operations
 *   - Expected-identity guard: a request captured for user A sent under
 *     user B's session returns 409 IDENTITY_CHANGED with no preference
 *     payload, no mutation, distinct from the revision conflict's 409 CONFLICT
 *   - Revision contract: strictly advancing per-domain revisions, atomic
 *     compare-and-write preconditions, absent-baseline mode, frozen-clock
 *     writes still serializing on the integer revision
 *   - Migration: create-if-absent, loser hydrates the winner, tombstones
 *     block re-migration
 *   - Reset: tombstone rows (schema_version 0), PUT un-tombstones,
 *     per-domain isolation
 *   - Corrupt rows: reported corrupt with revision intact, repairable by
 *     conditional PUT
 *   - Validation: full enum membership, bounds, unknown keys, quick-link
 *     id set / duplicates / cap, legacy 'classic' rejected 400
 *   - Account deletion removes preference rows (FK cascade is off)
 *   - Hub-only proxy boundary: remote nodeId on any preference path -> 403
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import {
  setupTestDb,
  cleanupTestDb,
  TEST_JWT_SECRET,
  TEST_USERNAME,
} from './helpers/setupTestDb';
import { createTestApiToken } from './helpers/apiTokenTestHelper';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

const APPEARANCE_DOC = {
  theme: 'dim', accent: 'cyan', uiFont: 'Geist', monoFont: 'Geist Mono',
  visualStyle: 'calm', headingStyle: 'clean', chartStyle: 'muted',
  density: 'comfortable', logChipColorMode: 'unified',
  borderBoost: 0, glow: 0.16, contrast: 0, typeScale: 1,
  reducedEffects: true, reducedMotion: true, readability: false,
  sidebarMode: 'resizable', sidebarWidth: 320,
};

// The document shape an older frontend writer sends (before the sidebar
// fields existed). The backend must accept it and store it normalized with
// the defaults rather than 400ing on the strict schema.
const LEGACY_APPEARANCE_DOC = {
  theme: 'dim', accent: 'cyan', uiFont: 'Geist', monoFont: 'Geist Mono',
  visualStyle: 'calm', headingStyle: 'clean', chartStyle: 'muted',
  density: 'comfortable', logChipColorMode: 'unified',
  borderBoost: 0, glow: 0.16, contrast: 0, typeScale: 1,
  reducedEffects: true, reducedMotion: true, readability: false,
};

const NAVIGATION_DOC = {
  mode: 'smart', quickLinks: ['dashboard', 'fleet'], labels: true, align: 'left',
};

function adminAuth(): { cookie: string; userId: number } {
  const db = DatabaseService.getInstance();
  const user = db.getUserByUsername(TEST_USERNAME)!;
  const token = jwt.sign(
    { username: TEST_USERNAME, role: 'admin', tv: user.token_version },
    TEST_JWT_SECRET,
    { expiresIn: '1m' },
  );
  return { cookie: `sencho_token=${token}`, userId: user.id };
}

async function seedUser(username: string, role: 'viewer' | 'admin'): Promise<{ userId: number; cookie: string }> {
  const db = DatabaseService.getInstance();
  const passwordHash = await bcrypt.hash('Password123!', 1);
  const userId = db.addUser({ username, password_hash: passwordHash, role });
  const token = jwt.sign(
    { username, role, tv: db.getUserByUsername(username)!.token_version },
    TEST_JWT_SECRET,
    { expiresIn: '1m' },
  );
  return { userId, cookie: `sencho_token=${token}` };
}

/** Mint an API-token bearer header bound to the given user. */
function apiTokenFor(userId: number): string {
  const db = DatabaseService as unknown as typeof DatabaseService & { getInstance(): unknown };
  return createTestApiToken({
    // The helper expects the module-namespace type; at runtime the value is
    // the class itself, and getInstance() is all the helper touches.
    db: db as never,
    scope: 'read-only',
    userId,
    name: `pref-test-${Date.now()}`,
  });
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  const { LicenseService } = await import('../services/LicenseService');
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
  ({ app } = await import('../index'));
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

const HEADER = 'x-sencho-pref-user';

// --- Auth chain ---

describe('user-preferences auth chain', () => {
  it('401s without a session', async () => {
    const res = await request(app).get('/api/user-preferences');
    expect(res.status).toBe(401);
  });

  it('rejects node_proxy machine credentials with 403 and creates no rows for userId 0', async () => {
    const token = jwt.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });
    const get = await request(app)
      .get('/api/user-preferences')
      .set('Authorization', `Bearer ${token}`)
      .set(HEADER, '0');
    expect(get.status).toBe(403);
    expect(get.body.code).toBe('SCOPE_DENIED');

    const put = await request(app)
      .put('/api/user-preferences/appearance')
      .set('Authorization', `Bearer ${token}`)
      .set(HEADER, '0')
      .send({ expectedRevision: 1, ...APPEARANCE_DOC });
    expect(put.status).toBe(403);

    const del = await request(app)
      .delete('/api/user-preferences/appearance')
      .set('Authorization', `Bearer ${token}`)
      .set(HEADER, '0')
      .send({ expectedRevision: 1 });
    expect(del.status).toBe(403);

    const mig = await request(app)
      .post('/api/user-preferences/appearance/migrate')
      .set('Authorization', `Bearer ${token}`)
      .set(HEADER, '0')
      .send(APPEARANCE_DOC);
    expect(mig.status).toBe(403);

    const rows = DatabaseService.getInstance()
      .getDb()
      .prepare('SELECT COUNT(*) as c FROM user_preferences WHERE user_id = 0')
      .get() as { c: number };
    expect(rows.c).toBe(0);
  });

  it('rejects pilot_tunnel machine credentials with 403', async () => {
    const token = jwt.sign({ scope: 'pilot_tunnel' }, TEST_JWT_SECRET, { expiresIn: '1m' });
    const res = await request(app)
      .get('/api/user-preferences')
      .set('Authorization', `Bearer ${token}`)
      .set(HEADER, '0');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SCOPE_DENIED');
  });

  it('rejects API tokens with 403 SCOPE_DENIED on all operations', async () => {
    const admin = adminAuth();
    const raw = apiTokenFor(admin.userId);
    const auth = { Authorization: `Bearer ${raw}` };

    // GET passes the global scope middleware (read-only allows GET) and is
    // rejected by the route's own guard.
    const get = await request(app).get('/api/user-preferences').set(auth).set(HEADER, String(admin.userId));
    expect(get.status).toBe(403);
    expect(get.body.code).toBe('SCOPE_DENIED');
    expect(get.body.error).toBe('Interface preferences cannot be managed by API tokens.');

    // Writes: a read-only token is denied by the global scope middleware
    // before the route guard runs; assert the route guard itself with a
    // full-admin token, which the global middleware waves through.
    const adminRaw = createTestApiToken({
      db: DatabaseService as never,
      scope: 'full-admin',
      userId: admin.userId,
      name: `pref-test-admin-${Date.now()}`,
    });
    const adminAuthHeader = { Authorization: `Bearer ${adminRaw}` };

    const put = await request(app)
      .put('/api/user-preferences/appearance')
      .set(adminAuthHeader).set(HEADER, String(admin.userId))
      .send({ expectedRevision: 1, ...APPEARANCE_DOC });
    expect(put.status).toBe(403);
    expect(put.body.code).toBe('SCOPE_DENIED');
    expect(put.body.error).toBe('Interface preferences cannot be managed by API tokens.');

    const del = await request(app)
      .delete('/api/user-preferences/appearance')
      .set(adminAuthHeader).set(HEADER, String(admin.userId))
      .send({ expectedRevision: 1 });
    expect(del.status).toBe(403);
    expect(del.body.code).toBe('SCOPE_DENIED');

    const mig = await request(app)
      .post('/api/user-preferences/appearance/migrate')
      .set(adminAuthHeader).set(HEADER, String(admin.userId))
      .send(APPEARANCE_DOC);
    expect(mig.status).toBe(403);
    expect(mig.body.code).toBe('SCOPE_DENIED');
  });

  it('serves a viewer (human role) on all four operations', async () => {
    const viewer = await seedUser('pref-viewer', 'viewer');

    const get = await request(app).get('/api/user-preferences')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId));
    expect(get.status).toBe(200);
    expect(get.body.preferences.appearance).toBeNull();

    const mig = await request(app).post('/api/user-preferences/appearance/migrate')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId))
      .send(APPEARANCE_DOC);
    expect(mig.status).toBe(201);
    expect(mig.body.migrated).toBe(true);

    const put = await request(app).put('/api/user-preferences/navigation')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId))
      .send({ absent: true, ...NAVIGATION_DOC });
    expect(put.status).toBe(200);

    const del = await request(app).delete('/api/user-preferences/navigation')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId))
      .send({ expectedRevision: put.body.revision });
    expect(del.status).toBe(200);
  });
});

// --- Identity guard ---

describe('user-preferences identity guard', () => {
  it('rejects a request captured for user A under user B session: 409 IDENTITY_CHANGED, no payload, no mutation', async () => {
    const a = await seedUser('pref-identity-a', 'viewer');
    const b = await seedUser('pref-identity-b', 'viewer');

    // Establish A's row.
    const seed = await request(app).post('/api/user-preferences/appearance/migrate')
      .set('Cookie', a.cookie).set(HEADER, String(a.userId))
      .send(APPEARANCE_DOC);
    expect(seed.status).toBe(201);

    // A-captured write carried by B's valid session.
    const put = await request(app).put('/api/user-preferences/appearance')
      .set('Cookie', b.cookie).set(HEADER, String(a.userId))
      .send({ expectedRevision: seed.body.row.revision, ...APPEARANCE_DOC, theme: 'oled' });
    expect(put.status).toBe(409);
    expect(put.body.error).toBe('IDENTITY_CHANGED');
    // No preference payload may ride along on an identity error.
    expect(put.body.current).toBeUndefined();
    expect(put.body.preferences).toBeUndefined();
    expect(put.body.data).toBeUndefined();

    // A-captured read under B's session is rejected the same way.
    const get = await request(app).get('/api/user-preferences')
      .set('Cookie', b.cookie).set(HEADER, String(a.userId));
    expect(get.status).toBe(409);
    expect(get.body.error).toBe('IDENTITY_CHANGED');
    expect(get.body.preferences).toBeUndefined();

    // Both rows untouched.
    const aRow = DatabaseService.getInstance().getUserPreferenceDomain(a.userId, 'appearance');
    expect(aRow?.data).toBeDefined();
    expect((aRow!.data as Record<string, unknown>).theme).toBe('dim');
    const bRow = DatabaseService.getInstance().getUserPreferenceDomain(b.userId, 'appearance');
    expect(bRow).toBeNull();
  });

  it('rejects a missing identity header on all operations', async () => {
    const viewer = await seedUser('pref-identity-missing', 'viewer');

    const get = await request(app).get('/api/user-preferences').set('Cookie', viewer.cookie);
    expect(get.status).toBe(409);
    expect(get.body.error).toBe('IDENTITY_CHANGED');

    const put = await request(app).put('/api/user-preferences/appearance')
      .set('Cookie', viewer.cookie)
      .send({ expectedRevision: 1, ...APPEARANCE_DOC });
    expect(put.status).toBe(409);

    const del = await request(app).delete('/api/user-preferences/appearance')
      .set('Cookie', viewer.cookie).send({ expectedRevision: 1 });
    expect(del.status).toBe(409);

    const mig = await request(app).post('/api/user-preferences/appearance/migrate')
      .set('Cookie', viewer.cookie).send(APPEARANCE_DOC);
    expect(mig.status).toBe(409);
  });

  it('identity 409 is distinct from the revision-conflict 409 machine code', async () => {
    const viewer = await seedUser('pref-identity-codes', 'viewer');
    const identity = await request(app).get('/api/user-preferences')
      .set('Cookie', viewer.cookie).set(HEADER, '99999');
    expect(identity.body.error).toBe('IDENTITY_CHANGED');
    expect(identity.body.current).toBeUndefined();

    const mig = await request(app).post('/api/user-preferences/appearance/migrate')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId))
      .send(APPEARANCE_DOC);
    const conflict = await request(app).put('/api/user-preferences/appearance')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId))
      .send({ expectedRevision: 9999, ...APPEARANCE_DOC });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe('CONFLICT');
    expect(conflict.body.current).toBeDefined();
    expect(conflict.body.current.revision).toBe(mig.body.row.revision);
  });
});

// --- Revisions, preconditions, migration, reset ---

describe('user-preferences revision contract', () => {
  let viewer: { userId: number; cookie: string };

  beforeAll(async () => {
    viewer = await seedUser('pref-revisions', 'viewer');
  });

  it('migrates when absent; a present row wins and is returned unchanged', async () => {
    const first = await request(app).post('/api/user-preferences/appearance/migrate')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId))
      .send(APPEARANCE_DOC);
    expect(first.status).toBe(201);
    expect(first.body.migrated).toBe(true);
    expect(first.body.row.revision).toBe(1);

    const second = await request(app).post('/api/user-preferences/appearance/migrate')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId))
      .send({ ...APPEARANCE_DOC, theme: 'oled' });
    expect(second.status).toBe(200);
    expect(second.body.migrated).toBe(false);
    expect(second.body.row.data.theme).toBe('dim');
  });

  it('serializes competing migrations: exactly one wins, loser hydrates the winner', async () => {
    const loser = await request(app).post('/api/user-preferences/navigation/migrate')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId))
      .send(NAVIGATION_DOC);
    expect(loser.body.migrated).toBe(true);

    // A PUT with an absent:true precondition against the existing row.
    const race = await request(app).put('/api/user-preferences/navigation')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId))
      .send({ absent: true, ...NAVIGATION_DOC, mode: 'compact' });
    expect(race.status).toBe(409);
    expect(race.body.error).toBe('CONFLICT');
    expect(race.body.current.revision).toBe(1);
  });

  it('returns 409 with a null current envelope when a write targets an absent row', async () => {
    const fresh = await seedUser('pref-absent-conflict', 'viewer');
    // First-ever PUT with a guessed expectedRevision: the row does not exist,
    // so the conflict's current envelope is null (there is nothing to read).
    const res = await request(app).put('/api/user-preferences/appearance')
      .set('Cookie', fresh.cookie).set(HEADER, String(fresh.userId))
      .send({ expectedRevision: 3, ...APPEARANCE_DOC });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('CONFLICT');
    expect(res.body.current).toBeNull();
    expect(DatabaseService.getInstance().getUserPreferenceDomain(fresh.userId, 'appearance')).toBeNull();
  });

  it('rejects a migrate request with no JSON body (400, not a server error)', async () => {
    const fresh = await seedUser('pref-bodyless', 'viewer');
    const res = await request(app).post('/api/user-preferences/appearance/migrate')
      .set('Cookie', fresh.cookie).set(HEADER, String(fresh.userId))
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid preference document');
  });

  it('rejects a precondition value of 0, a fraction, and a string', async () => {
    const fresh = await seedUser('pref-badprecondition', 'viewer');
    const put = (revision: unknown) => request(app).put('/api/user-preferences/appearance')
      .set('Cookie', fresh.cookie).set(HEADER, String(fresh.userId))
      .send({ expectedRevision: revision, ...APPEARANCE_DOC });
    expect((await put(0)).status).toBe(400);
    expect((await put(1.5)).status).toBe(400);
    expect((await put('1')).status).toBe(400);
    const both = await request(app).put('/api/user-preferences/appearance')
      .set('Cookie', fresh.cookie).set(HEADER, String(fresh.userId))
      .send({ absent: true, expectedRevision: 1, ...APPEARANCE_DOC });
    expect(both.status).toBe(400);
    expect(both.body.error).toBe('expectedRevision and absent are mutually exclusive');
  });

  it('bumps revision deterministically from the observed baseline and rejects stale preconditions with current envelope', async () => {
    // Deterministic fresh seed: the appearance revision starts at 1 for this
    // user regardless of test execution order (the shared suite database
    // would otherwise make a relative +1 assertion order-dependent).
    const fresh = await seedUser('pref-bump-determinism', 'viewer');
    await request(app).post('/api/user-preferences/appearance/migrate')
      .set('Cookie', fresh.cookie).set(HEADER, String(fresh.userId))
      .send(APPEARANCE_DOC);
    expect(DatabaseService.getInstance().getUserPreferenceDomain(fresh.userId, 'appearance')!.revision).toBe(1);

    const put = await request(app).put('/api/user-preferences/appearance')
      .set('Cookie', fresh.cookie).set(HEADER, String(fresh.userId))
      .send({ expectedRevision: 1, ...APPEARANCE_DOC, contrast: 0.5 });
    expect(put.status).toBe(200);
    expect(put.body.revision).toBe(2);

    const stale = await request(app).put('/api/user-preferences/appearance')
      .set('Cookie', fresh.cookie).set(HEADER, String(fresh.userId))
      .send({ expectedRevision: 1, ...APPEARANCE_DOC });
    expect(stale.status).toBe(409);
    expect(stale.body.current.revision).toBe(2);
  });

  it('rejects a write with no precondition (no unguarded path)', async () => {
    const res = await request(app).put('/api/user-preferences/appearance')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId))
      .send(APPEARANCE_DOC);
    expect(res.status).toBe(400);
  });

  it('serializes two writers sharing one known revision: exactly one wins', async () => {
    const get = await request(app).get('/api/user-preferences')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId));
    const rev = get.body.preferences.appearance.revision;

    const [w1, w2] = await Promise.all([
      request(app).put('/api/user-preferences/appearance')
        .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId))
        .send({ expectedRevision: rev, ...APPEARANCE_DOC, glow: 0.1 }),
      request(app).put('/api/user-preferences/appearance')
        .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId))
        .send({ expectedRevision: rev, ...APPEARANCE_DOC, glow: 0.2 }),
    ]);
    const statuses = [w1.status, w2.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = w1.status === 409 ? w1 : w2;
    expect(loser.body.error).toBe('CONFLICT');
    expect(loser.body.current.revision).toBe(rev + 1);
  });

  it('resets to a tombstone that blocks migration and un-tombstones on PUT', async () => {
    const get = await request(app).get('/api/user-preferences')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId));
    const rev = get.body.preferences.appearance.revision;

    const del = await request(app).delete('/api/user-preferences/appearance')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId))
      .send({ expectedRevision: rev });
    expect(del.status).toBe(200);
    expect(del.body.schemaVersion).toBe(0);
    expect(del.body.revision).toBe(rev + 1);

    // GET shows the tombstone (not null: row exists).
    const afterDel = await request(app).get('/api/user-preferences')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId));
    expect(afterDel.body.preferences.appearance).toMatchObject({ schemaVersion: 0 });

    // Tombstone blocks migration.
    const mig = await request(app).post('/api/user-preferences/appearance/migrate')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId))
      .send(APPEARANCE_DOC);
    expect(mig.status).toBe(200);
    expect(mig.body.migrated).toBe(false);
    expect(mig.body.row.schemaVersion).toBe(0);

    // PUT un-tombstones conditionally on the tombstone revision.
    const put = await request(app).put('/api/user-preferences/appearance')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId))
      .send({ expectedRevision: mig.body.row.revision, ...APPEARANCE_DOC, theme: 'light' });
    expect(put.status).toBe(200);
    expect(put.body.revision).toBe(mig.body.row.revision + 1);

    // Reset isolation: navigation row untouched.
    const nav = await request(app).get('/api/user-preferences')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId));
    expect(nav.body.preferences.navigation.data).toBeDefined();
  });

  it('resets an absent domain with absent:true (tombstone at revision 1)', async () => {
    // A reset is allowed on a domain the client has never seen (the sync layer
    // resets both domains independently; a fresh account may have an
    // appearance row but no navigation row). The absent-baseline precondition
    // covers this: the DELETE creates the tombstone directly at revision 1.
    const fresh = await seedUser('pref-absent-reset', 'viewer');
    const del = await request(app).delete('/api/user-preferences/navigation')
      .set('Cookie', fresh.cookie).set(HEADER, String(fresh.userId))
      .send({ absent: true });
    expect(del.status).toBe(200);
    expect(del.body.schemaVersion).toBe(0);
    expect(del.body.revision).toBe(1);

    // The tombstone is real: GET reports a row (not null) that blocks
    // migration, and a second absent:true DELETE conflicts with the new row.
    const after = await request(app).get('/api/user-preferences')
      .set('Cookie', fresh.cookie).set(HEADER, String(fresh.userId));
    expect(after.body.preferences.navigation).toMatchObject({ schemaVersion: 0, revision: 1 });
    const again = await request(app).delete('/api/user-preferences/navigation')
      .set('Cookie', fresh.cookie).set(HEADER, String(fresh.userId))
      .send({ absent: true });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('CONFLICT');
    expect(again.body.current.revision).toBe(1);
  });

  it('stale DELETE precondition conflicts cleanly', async () => {
    // Ensure a live navigation row at revision >= 2 so a "stale" precondition
    // is a valid-but-outdated integer (revision 1 - 1 would be invalid input,
    // which the route 400s rather than 409s).
    const get0 = await request(app).get('/api/user-preferences')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId));
    const nav0 = get0.body.preferences.navigation;
    if (!nav0 || nav0.schemaVersion === 0) {
      const baseline = nav0?.revision ?? null;
      const revive = await request(app).put('/api/user-preferences/navigation')
        .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId))
        .send(baseline === null ? { absent: true, ...NAVIGATION_DOC } : { expectedRevision: baseline, ...NAVIGATION_DOC });
      expect([200, 409]).toContain(revive.status);
    }
    const bump = await request(app).put('/api/user-preferences/navigation')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId))
      .send({ expectedRevision: 1, ...NAVIGATION_DOC, mode: 'compact' });
    expect([200, 409]).toContain(bump.status);

    const get = await request(app).get('/api/user-preferences')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId));
    const rev = get.body.preferences.navigation.revision;
    expect(rev).toBeGreaterThanOrEqual(2);

    const stale = await request(app).delete('/api/user-preferences/navigation')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId))
      .send({ expectedRevision: rev - 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.current.revision).toBe(rev);

    const ok = await request(app).delete('/api/user-preferences/navigation')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId))
      .send({ expectedRevision: rev });
    expect(ok.status).toBe(200);
  });
});

// --- Frozen clock ---

describe('user-preferences frozen clock', () => {
  it('two same-tick writes still serialize on the integer revision', async () => {
    const viewer = await seedUser('pref-clock', 'viewer');
    const mig = await request(app).post('/api/user-preferences/appearance/migrate')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId))
      .send(APPEARANCE_DOC);
    const rev = mig.body.row.revision;

    const DateSpy = vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    try {
      const [w1, w2] = await Promise.all([
        request(app).put('/api/user-preferences/appearance')
          .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId))
          .send({ expectedRevision: rev, ...APPEARANCE_DOC, contrast: 0.1 }),
        request(app).put('/api/user-preferences/appearance')
          .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId))
          .send({ expectedRevision: rev, ...APPEARANCE_DOC, contrast: 0.2 }),
      ]);
      expect([w1.status, w2.status].sort()).toEqual([200, 409]);
    } finally {
      DateSpy.mockRestore();
    }
  });
});

// --- Corrupt rows ---

describe('user-preferences corrupt rows', () => {
  it('reports a corrupt row with revision intact and accepts a conditional repair', async () => {
    const viewer = await seedUser('pref-corrupt', 'viewer');
    const db = DatabaseService.getInstance();
    db.getDb().prepare(
      `INSERT INTO user_preferences (user_id, domain, schema_version, revision, data, created_at, updated_at)
       VALUES (?, 'appearance', 1, 7, '{not json', 1, 1)`
    ).run(viewer.userId);

    const get = await request(app).get('/api/user-preferences')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId));
    expect(get.body.preferences.appearance).toMatchObject({ corrupt: true, revision: 7 });

    const mig = await request(app).post('/api/user-preferences/appearance/migrate')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId))
      .send(APPEARANCE_DOC);
    expect(mig.status).toBe(200);
    expect(mig.body.migrated).toBe(false);
    expect(mig.body.row.corrupt).toBe(true);
    expect(mig.body.row.revision).toBe(7);

    const repair = await request(app).put('/api/user-preferences/appearance')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId))
      .send({ expectedRevision: 7, ...APPEARANCE_DOC });
    expect(repair.status).toBe(200);
    expect(repair.body.revision).toBe(8);
  });
});

// --- Validation ---

describe('user-preferences validation', () => {
  let viewer: { userId: number; cookie: string };
  beforeAll(async () => {
    viewer = await seedUser('pref-validate', 'viewer');
  });

  async function putNavigation(doc: Record<string, unknown>): Promise<request.Response> {
    return request(app).put('/api/user-preferences/navigation')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId))
      .send({ absent: true, ...doc });
  }

  it('accepts a valid navigation document', async () => {
    const res = await putNavigation(NAVIGATION_DOC);
    expect(res.status).toBe(200);
  });

  it('rejects legacy classic mode with 400', async () => {
    const res = await putNavigation({ ...NAVIGATION_DOC, mode: 'classic' });
    expect(res.status).toBe(400);
  });

  it('rejects unknown enum values, unknown keys, and wrong primitives', async () => {
    expect((await putNavigation({ ...NAVIGATION_DOC, mode: 'warp' })).status).toBe(400);
    expect((await putNavigation({ ...NAVIGATION_DOC, align: 'right' })).status).toBe(400);
    expect((await putNavigation({ ...NAVIGATION_DOC, labels: 'yes' })).status).toBe(400);
    expect((await putNavigation({ ...NAVIGATION_DOC, extra: 1 })).status).toBe(400);
  });

  it('rejects unknown / duplicate / ineligible / oversized quick links', async () => {
    expect((await putNavigation({ ...NAVIGATION_DOC, quickLinks: ['nonexistent'] })).status).toBe(400);
    expect((await putNavigation({ ...NAVIGATION_DOC, quickLinks: ['fleet', 'fleet'] })).status).toBe(400);
    expect((await putNavigation({ ...NAVIGATION_DOC, quickLinks: ['settings'] })).status).toBe(400);
    expect((await putNavigation({ ...NAVIGATION_DOC, quickLinks: Array(17).fill('fleet').map((_, i) => QUICK[i % QUICK.length]) })).status).toBe(400);
  });

  const QUICK = ['dashboard', 'fleet', 'resources', 'networking', 'security', 'templates', 'global-observability', 'auto-updates', 'scheduled-ops', 'host-console', 'audit-log'];

  it('rejects out-of-bounds appearance numbers and unknown appearance enums', async () => {
    const put = async (doc: Record<string, unknown>) => request(app).put('/api/user-preferences/appearance')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId))
      .send({ absent: true, ...doc });

    expect((await put({ ...APPEARANCE_DOC, contrast: 5 })).status).toBe(400);
    expect((await put({ ...APPEARANCE_DOC, borderBoost: -1 })).status).toBe(400);
    expect((await put({ ...APPEARANCE_DOC, theme: 'midnight' })).status).toBe(400);
    expect((await put({ ...APPEARANCE_DOC, density: 'cozy' })).status).toBe(400);
    expect((await put({ ...APPEARANCE_DOC, extra: true })).status).toBe(400);
  });

  it('accepts the new sidebar fields', async () => {
    const put = (doc: Record<string, unknown>) => request(app).put('/api/user-preferences/appearance')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId))
      .send({ absent: true, ...doc });

    expect((await put(APPEARANCE_DOC)).status).toBe(200);
    const all = await request(app).get('/api/user-preferences')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId));
    expect(all.status).toBe(200);
    const appearance = (all.body.preferences.appearance?.data ?? {}) as Record<string, unknown>;
    expect(appearance.sidebarMode).toBe('resizable');
    expect(appearance.sidebarWidth).toBe(320);
  });

  it('rejects invalid sidebar field values', async () => {
    const put = (doc: Record<string, unknown>) => request(app).put('/api/user-preferences/appearance')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId))
      .send({ absent: true, ...doc });

    expect((await put({ ...APPEARANCE_DOC, sidebarMode: 'float' })).status).toBe(400);
    expect((await put({ ...APPEARANCE_DOC, sidebarWidth: 223 })).status).toBe(400);
    expect((await put({ ...APPEARANCE_DOC, sidebarWidth: 441 })).status).toBe(400);
    expect((await put({ ...APPEARANCE_DOC, sidebarWidth: 320.5 })).status).toBe(400);
    expect((await put({ ...APPEARANCE_DOC, sidebarWidth: '320' })).status).toBe(400);
  });

  /** Remove the viewer's appearance row outright. A route-level DELETE only
   *  tombstones the row (it still exists), and a tombstone fails an
   *  absent-precondition PUT, so the tests that need a truly absent row go to
   *  the DB directly. */
  function clearAppearanceRow(): void {
    DatabaseService.getInstance()
      .getDb()
      .prepare("DELETE FROM user_preferences WHERE user_id = ? AND domain = 'appearance'")
      .run(viewer.userId);
  }

  it('normalizes a legacy 16-field document with the sidebar defaults on PUT', async () => {
    await clearAppearanceRow();

    const put = await request(app).put('/api/user-preferences/appearance')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId))
      .send({ absent: true, ...LEGACY_APPEARANCE_DOC });
    expect(put.status).toBe(200);
    expect(put.body.data.sidebarMode).toBe('fixed');
    expect(put.body.data.sidebarWidth).toBe(256);
  });

  it('normalizes a legacy document on migrate and a repair PUT keeps the defaults', async () => {
    // Seed a genuinely absent row, then backdate it in the DB: the stored
    // document predates the sidebar fields, exactly what an older writer
    // would have left behind. Migration is create-if-absent, so the seeded
    // legacy row wins and the incoming document is dropped unchanged.
    clearAppearanceRow();
    DatabaseService.getInstance()
      .getDb()
      .prepare(
        "INSERT INTO user_preferences (user_id, domain, schema_version, revision, data, created_at, updated_at) VALUES (?, 'appearance', 1, 1, ?, ?, ?)",
      )
      .run(viewer.userId, JSON.stringify(LEGACY_APPEARANCE_DOC), Date.now(), Date.now());

    const mig = await request(app).post('/api/user-preferences/appearance/migrate')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId))
      .send(LEGACY_APPEARANCE_DOC);
    expect(mig.status).toBe(200);
    expect(mig.body.migrated).toBe(false);
    // The loser of create-if-absent hydrates the winner's (backdated, legacy)
    // row unchanged: reads serve the stored document as-is, with no
    // server-side rewrite, so the legacy row keeps missing the new fields.
    expect(mig.body.row.data).toEqual(LEGACY_APPEARANCE_DOC);

    // The conditional repair PUT (the documented corrupt/legacy recovery
    // path) stores the legacy document normalized with the defaults.
    const repair = await request(app).put('/api/user-preferences/appearance')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId))
      .send({ expectedRevision: mig.body.row.revision, ...LEGACY_APPEARANCE_DOC });
    expect(repair.status).toBe(200);
    expect(repair.body.data.sidebarMode).toBe('fixed');
    expect(repair.body.data.sidebarWidth).toBe(256);
  });

  it('404s an unknown domain', async () => {
    const res = await request(app).put('/api/user-preferences/workspaces')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId))
      .send({ absent: true });
    expect(res.status).toBe(404);
  });
});

// --- Isolation and deletion ---

describe('user-preferences isolation and deletion', () => {
  it('does not leak rows between two users in either direction', async () => {
    const u1 = await seedUser('pref-iso-1', 'viewer');
    const u2 = await seedUser('pref-iso-2', 'viewer');

    await request(app).post('/api/user-preferences/appearance/migrate')
      .set('Cookie', u1.cookie).set(HEADER, String(u1.userId))
      .send({ ...APPEARANCE_DOC, accent: 'violet' });
    await request(app).post('/api/user-preferences/appearance/migrate')
      .set('Cookie', u2.cookie).set(HEADER, String(u2.userId))
      .send({ ...APPEARANCE_DOC, accent: 'steel' });

    const g1 = await request(app).get('/api/user-preferences')
      .set('Cookie', u1.cookie).set(HEADER, String(u1.userId));
    const g2 = await request(app).get('/api/user-preferences')
      .set('Cookie', u2.cookie).set(HEADER, String(u2.userId));
    expect(g1.body.preferences.appearance.data.accent).toBe('violet');
    expect(g2.body.preferences.appearance.data.accent).toBe('steel');

    await request(app).put('/api/user-preferences/appearance')
      .set('Cookie', u1.cookie).set(HEADER, String(u1.userId))
      .send({ expectedRevision: g1.body.preferences.appearance.revision, ...APPEARANCE_DOC, theme: 'oled' });
    const g2b = await request(app).get('/api/user-preferences')
      .set('Cookie', u2.cookie).set(HEADER, String(u2.userId));
    expect(g2b.body.preferences.appearance.data.theme).toBe('dim');
  });

  it('appearance PUT leaves the navigation row untouched', async () => {
    const viewer = await seedUser('pref-iso-3', 'viewer');
    await request(app).post('/api/user-preferences/navigation/migrate')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId))
      .send(NAVIGATION_DOC);
    const appPut = await request(app).put('/api/user-preferences/appearance')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId))
      .send({ absent: true, ...APPEARANCE_DOC });
    const nav = await request(app).get('/api/user-preferences')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId));
    expect(nav.body.preferences.navigation.revision).toBe(1);
    expect(nav.body.preferences.appearance.revision).toBe(appPut.body.revision);
  });

  it('deleteUser removes preference rows (FK cascade is off)', async () => {
    const doomed = await seedUser('pref-doomed', 'viewer');
    await request(app).post('/api/user-preferences/appearance/migrate')
      .set('Cookie', doomed.cookie).set(HEADER, String(doomed.userId))
      .send(APPEARANCE_DOC);
    expect(DatabaseService.getInstance().getUserPreferenceDomain(doomed.userId, 'appearance')).not.toBeNull();

    DatabaseService.getInstance().deleteUser(doomed.userId);
    expect(DatabaseService.getInstance().getUserPreferenceDomain(doomed.userId, 'appearance')).toBeNull();
  });
});

// --- Hub-only boundary ---

describe('user-preferences hub-only proxy boundary', () => {
  it('403s a remote nodeId on the collection and domain paths', async () => {
    const admin = adminAuth();
    let remote = DatabaseService.getInstance().getDb()
      .prepare("SELECT id FROM nodes WHERE type = 'remote' LIMIT 1")
      .get() as { id: number } | undefined;
    if (!remote) {
      // Seed a remote node if the baseline DB has none.
      const info = DatabaseService.getInstance().getDb()
        .prepare("INSERT INTO nodes (name, type, compose_dir, is_default, status, created_at) VALUES ('remote-test', 'remote', '/tmp/remote-compose', 0, 'unknown', 1)")
        .run();
      remote = { id: Number(info.lastInsertRowid) };
    }

    for (const path of ['/api/user-preferences', `/api/user-preferences/appearance`]) {
      const res = await request(app).get(path)
        .set('Cookie', admin.cookie)
        .set(HEADER, String(admin.userId))
        .set('x-node-id', String(remote.id));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('HUB_ONLY_ENDPOINT');
    }
  });
});

// --- Audit ---

describe('user-preferences audit summaries', () => {
  it('writes audit rows for migrate, put, and delete', async () => {
    const viewer = await seedUser('pref-audit', 'viewer');
    const db = DatabaseService.getInstance();

    const mig = await request(app).post('/api/user-preferences/appearance/migrate')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId))
      .send(APPEARANCE_DOC);
    expect(mig.status).toBe(201);
    const put = await request(app).put('/api/user-preferences/appearance')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId))
      .send({ expectedRevision: mig.body.row.revision, ...APPEARANCE_DOC, theme: 'oled' });
    expect(put.status).toBe(200);
    const del = await request(app).delete('/api/user-preferences/appearance')
      .set('Cookie', viewer.cookie).set(HEADER, String(viewer.userId))
      .send({ expectedRevision: put.body.revision });
    expect(del.status).toBe(200);

    // Audit writes are buffered; poll briefly for this user's three rows.
    // Filter by username so earlier tests' preference rows cannot satisfy
    // the assertions (the suite shares one database).
    const summaries = () => (db.getDb().prepare(
      "SELECT summary FROM audit_log WHERE path LIKE '/api/user-preferences%' AND username = 'pref-audit'"
    ).all() as { summary: string }[]).map((r) => r.summary);
    let rows: string[] = [];
    for (let i = 0; i < 20 && rows.length < 3; i++) {
      await new Promise((r) => setTimeout(r, 100));
      rows = summaries();
    }
    expect(rows.some((s) => s.startsWith('Migrated interface preferences'))).toBe(true);
    expect(rows.some((s) => s.startsWith('Updated interface preferences'))).toBe(true);
    expect(rows.some((s) => s.startsWith('Reset interface preferences'))).toBe(true);
  });
});
