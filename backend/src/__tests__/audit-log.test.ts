/**
 * Comprehensive tests for the Audit Logging feature:
 * - getAuditSummary() pure function (wildcard, prefix, fallback)
 * - DatabaseService audit log CRUD (insert, query, filter, paginate, cleanup)
 * - API endpoints (GET /api/audit-log, GET /api/audit-log/export)
 * - Permission gating (Admiral + system:audit required)
 * - Audit middleware integration (logs mutating requests, skips GETs)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { getAuditSummary } from '../utils/audit-summaries';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

function authToken(username: string, role: string = 'admin', tv?: number): string {
  const payload: Record<string, unknown> = { username, role };
  if (tv !== undefined) payload.tv = tv;
  return jwt.sign(payload, TEST_JWT_SECRET, { expiresIn: '1m' });
}

function adminToken(): string {
  const db = DatabaseService.getInstance();
  const user = db.getUserByUsername(TEST_USERNAME)!;
  return authToken(TEST_USERNAME, 'admin', user.token_version);
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));

  // Mock LicenseService to return paid/admiral for audit log access
  const { LicenseService } = await import('../services/LicenseService');
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
  vi.spyOn(LicenseService.getInstance(), 'getVariant').mockReturnValue('admiral');
  vi.spyOn(LicenseService.getInstance(), 'getSeatLimits').mockReturnValue({ maxAdmins: null, maxViewers: null });

  ({ app } = await import('../index'));
});

afterAll(() => {
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

// ---- getAuditSummary() unit tests ----

describe('getAuditSummary()', () => {
  it('resolves prefix match with resource name: POST /stacks/mystack', () => {
    expect(getAuditSummary('POST', '/stacks/mystack')).toBe('Created stack: mystack');
  });

  it('resolves wildcard match: POST /stacks/mystack/deploy', () => {
    expect(getAuditSummary('POST', '/stacks/mystack/deploy')).toBe('Deployed stack: mystack');
  });

  it('resolves wildcard match: POST /stacks/mystack/down', () => {
    expect(getAuditSummary('POST', '/stacks/mystack/down')).toBe('Stopped stack: mystack');
  });

  it('resolves wildcard match: POST /stacks/mystack/rollback', () => {
    expect(getAuditSummary('POST', '/stacks/mystack/rollback')).toBe('Rolled back stack: mystack');
  });

  it('resolves per-service restart summary (stack name as resource)', () => {
    expect(getAuditSummary('POST', '/stacks/web/services/app/restart')).toBe('Restarted stack service: web');
  });

  it('resolves per-service stop summary (stack name as resource)', () => {
    expect(getAuditSummary('POST', '/stacks/web/services/app/stop')).toBe('Stopped stack service: web');
  });

  it('resolves per-service start summary (stack name as resource)', () => {
    expect(getAuditSummary('POST', '/stacks/web/services/app/start')).toBe('Started stack service: web');
  });

  it('decodes URL-encoded resource names', () => {
    expect(getAuditSummary('POST', '/stacks/my%20stack/deploy')).toBe('Deployed stack: my stack');
  });

  it('wildcard match wins over prefix when more specific', () => {
    // POST /stacks/*/deploy (3 segments) should win over POST /stacks (1 segment prefix)
    const result = getAuditSummary('POST', '/stacks/mystack/deploy');
    expect(result).toBe('Deployed stack: mystack');
    expect(result).not.toContain('Created');
  });

  it('resolves container operations', () => {
    expect(getAuditSummary('POST', '/containers/abc123/start')).toBe('Started container: abc123');
    expect(getAuditSummary('POST', '/containers/abc123/stop')).toBe('Stopped container: abc123');
    expect(getAuditSummary('POST', '/containers/abc123/restart')).toBe('Restarted container: abc123');
  });

  it('resolves fleet snapshot restore with wildcard', () => {
    expect(getAuditSummary('POST', '/fleet/snapshots/42/restore')).toBe('Restored fleet backup: 42');
  });

  it('resolves label actions', () => {
    expect(getAuditSummary('POST', '/labels')).toBe('Created label');
    expect(getAuditSummary('POST', '/labels/5/action')).toBe('Executed label action: 5');
  });

  it('resolves settings routes (POST and PATCH)', () => {
    expect(getAuditSummary('POST', '/settings')).toBe('Updated settings');
    expect(getAuditSummary('PATCH', '/settings')).toBe('Updated settings');
  });

  it('resolves auth operations', () => {
    expect(getAuditSummary('PUT', '/auth/password')).toBe('Changed password');
    expect(getAuditSummary('POST', '/auth/generate-node-token')).toBe('Generated node token');
  });

  it('falls back to generic format for unmapped routes', () => {
    expect(getAuditSummary('POST', '/unknown/route')).toBe('POST /api/unknown/route');
  });

  it('does not match old compose routes (dead entries removed)', () => {
    expect(getAuditSummary('POST', '/compose/up')).toBe('POST /api/compose/up');
    expect(getAuditSummary('POST', '/compose/down')).toBe('POST /api/compose/down');
  });

  it('handles leading slash normalization', () => {
    expect(getAuditSummary('DELETE', '/nodes/5')).toBe('Deleted node: 5');
    expect(getAuditSummary('DELETE', 'nodes/5')).toBe('Deleted node: 5');
  });
});

// ---- DatabaseService audit methods ----

describe('DatabaseService audit methods', () => {
  it('inserts and retrieves an audit log entry', () => {
    const db = DatabaseService.getInstance();
    db.insertAuditLog({
      timestamp: Date.now(),
      username: 'testuser',
      method: 'POST',
      path: '/api/stacks/test',
      status_code: 201,
      node_id: null,
      ip_address: '127.0.0.1',
      summary: 'Created stack: test',
    });

    const { entries, total } = db.getAuditLogs({ limit: 10 });
    expect(total).toBeGreaterThanOrEqual(1);
    const entry = entries.find(e => e.summary === 'Created stack: test');
    expect(entry).toBeDefined();
    expect(entry!.username).toBe('testuser');
    expect(entry!.method).toBe('POST');
    expect(entry!.status_code).toBe(201);
  });

  it('filters by username', () => {
    const db = DatabaseService.getInstance();
    db.insertAuditLog({
      timestamp: Date.now(),
      username: 'uniquefilteruser',
      method: 'DELETE',
      path: '/api/nodes/1',
      status_code: 200,
      node_id: 1,
      ip_address: '10.0.0.1',
      summary: 'Deleted node: 1',
    });

    const { entries } = db.getAuditLogs({ username: 'uniquefilteruser', limit: 100 });
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries.every(e => e.username === 'uniquefilteruser')).toBe(true);
  });

  it('filters by method', () => {
    const db = DatabaseService.getInstance();
    const { entries } = db.getAuditLogs({ method: 'DELETE', limit: 100 });
    expect(entries.every(e => e.method === 'DELETE')).toBe(true);
  });

  it('filters by date range', () => {
    const db = DatabaseService.getInstance();
    const now = Date.now();

    db.insertAuditLog({
      timestamp: now - 100_000,
      username: 'rangetest',
      method: 'PUT',
      path: '/api/settings',
      status_code: 200,
      node_id: null,
      ip_address: '127.0.0.1',
      summary: 'Updated settings',
    });

    const { entries } = db.getAuditLogs({
      from: now - 200_000,
      to: now - 50_000,
      limit: 100,
    });
    const found = entries.find(e => e.username === 'rangetest');
    expect(found).toBeDefined();

    // Outside range should not return the entry
    const { entries: outside } = db.getAuditLogs({
      from: now + 100_000,
      to: now + 200_000,
      limit: 100,
    });
    const notFound = outside.find(e => e.username === 'rangetest');
    expect(notFound).toBeUndefined();
  });

  it('searches across summary, path, and username', () => {
    const db = DatabaseService.getInstance();
    db.insertAuditLog({
      timestamp: Date.now(),
      username: 'searchableuser',
      method: 'POST',
      path: '/api/stacks/searchablestack',
      status_code: 200,
      node_id: null,
      ip_address: '127.0.0.1',
      summary: 'Deployed stack: searchablestack',
    });

    // Search by summary keyword
    const { entries: bySummary } = db.getAuditLogs({ search: 'searchablestack', limit: 100 });
    expect(bySummary.length).toBeGreaterThanOrEqual(1);

    // Search by username
    const { entries: byUser } = db.getAuditLogs({ search: 'searchableuser', limit: 100 });
    expect(byUser.length).toBeGreaterThanOrEqual(1);
  });

  it('paginates correctly', () => {
    const db = DatabaseService.getInstance();
    // Insert enough entries for pagination
    for (let i = 0; i < 5; i++) {
      db.insertAuditLog({
        timestamp: Date.now() + i,
        username: 'paginateuser',
        method: 'POST',
        path: `/api/stacks/page${i}`,
        status_code: 200,
        node_id: null,
        ip_address: '127.0.0.1',
        summary: `Paginate entry ${i}`,
      });
    }

    const page1 = db.getAuditLogs({ username: 'paginateuser', page: 1, limit: 2 });
    const page2 = db.getAuditLogs({ username: 'paginateuser', page: 2, limit: 2 });

    expect(page1.entries.length).toBe(2);
    expect(page2.entries.length).toBe(2);
    expect(page1.total).toBe(5);

    // Pages should not overlap
    const page1Ids = page1.entries.map(e => e.id);
    const page2Ids = page2.entries.map(e => e.id);
    expect(page1Ids.some(id => page2Ids.includes(id))).toBe(false);
  });

  it('getAuditLogsInRange caps to the most-recent rows and returns ascending order', () => {
    const db = DatabaseService.getInstance();
    // Old, isolated window: keeps these rows out of the "most recent" DESC
    // queries other tests rely on, while staying easy to range-query here.
    const base = 1_000_000_000_000; // 2001, far from any now()-based entry
    for (let i = 0; i < 10; i++) {
      db.insertAuditLog({
        timestamp: base + i,
        username: 'rangecapuser',
        method: 'POST',
        path: `/api/stacks/cap${i}`,
        status_code: 200,
        node_id: null,
        ip_address: '127.0.0.1',
        summary: `cap entry ${i}`,
      });
    }

    const capped = db.getAuditLogsInRange(base, base + 100, 3);
    expect(capped.length).toBe(3);
    // Most-recent three (timestamps base+7, +8, +9), returned ascending.
    expect(capped.map(e => e.timestamp)).toEqual([base + 7, base + 8, base + 9]);

    const uncapped = db.getAuditLogsInRange(base, base + 100);
    expect(uncapped.length).toBe(10);
    expect(uncapped[0].timestamp).toBe(base);
  });
});

// ---- API endpoint tests ----

describe('GET /api/audit-log', () => {
  it('returns 403 without Admiral license', async () => {
    const { LicenseService } = await import('../services/LicenseService');
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValueOnce('community');
    vi.spyOn(LicenseService.getInstance(), 'getVariant').mockReturnValueOnce(null);

    const res = await request(app)
      .get('/api/audit-log')
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(403);
  });

  it('returns 403 for viewer role (no system:audit permission)', async () => {
    const db = DatabaseService.getInstance();
    db.addUser({ username: 'vieweraudit', password_hash: 'hash', role: 'viewer' });
    const viewerToken = authToken('vieweraudit', 'viewer');

    const res = await request(app)
      .get('/api/audit-log')
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(403);
  });

  it('returns paginated results for admin with correct structure', async () => {
    const res = await request(app)
      .get('/api/audit-log?page=1&limit=10')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('entries');
    expect(res.body).toHaveProperty('total');
    expect(Array.isArray(res.body.entries)).toBe(true);
    expect(typeof res.body.total).toBe('number');
  });

  it('respects method filter', async () => {
    const res = await request(app)
      .get('/api/audit-log?method=DELETE')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    for (const entry of res.body.entries) {
      expect(entry.method).toBe('DELETE');
    }
  });

  it('respects search filter', async () => {
    const res = await request(app)
      .get('/api/audit-log?search=searchablestack')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBeGreaterThanOrEqual(1);
  });

  it('clamps a negative limit to a single row instead of returning the whole table', async () => {
    // A negative LIMIT reaches SQLite as "unlimited" without the clamp.
    const res = await request(app)
      .get('/api/audit-log?limit=-1')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBeLessThanOrEqual(1);
    expect(res.body.total).toBeGreaterThan(1);
  });

  it('clamps an oversized limit to the 200 cap', async () => {
    const res = await request(app)
      .get('/api/audit-log?limit=99999')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBeLessThanOrEqual(200);
  });

  it('clamps a non-positive page to page 1', async () => {
    const res = await request(app)
      .get('/api/audit-log?page=-5&limit=5')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBeGreaterThan(0);
  });

  it('annotates entries with a flags array when with_anomalies=1', async () => {
    const res = await request(app)
      .get('/api/audit-log?with_anomalies=1&limit=5')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBeGreaterThan(0);
    for (const entry of res.body.entries) {
      expect(Array.isArray(entry.flags)).toBe(true);
    }
  });

  it('flags a never-before-seen actor as first_seen_actor', async () => {
    const db = DatabaseService.getInstance();
    db.insertAuditLog({
      timestamp: Date.now(),
      username: 'brandnewactor_unique',
      method: 'POST',
      path: '/api/stacks/firstseen',
      status_code: 200,
      node_id: null,
      ip_address: '127.0.0.1',
      summary: 'Deployed stack: firstseen',
    });

    const res = await request(app)
      .get('/api/audit-log?with_anomalies=1&search=brandnewactor_unique')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    const entry = res.body.entries.find(
      (e: { username: string }) => e.username === 'brandnewactor_unique',
    );
    expect(entry).toBeDefined();
    expect(entry.flags).toContain('first_seen_actor');
  });

  it('treats limit=0 as the default page size, not zero rows', async () => {
    // parseInt('0') is falsy, so the `|| 50` default applies before the clamp.
    const res = await request(app)
      .get('/api/audit-log?limit=0')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBeGreaterThan(0);
    expect(res.body.entries.length).toBeLessThanOrEqual(50);
  });
});

describe('GET /api/audit-log/stats', () => {
  it('returns 403 without Admiral license', async () => {
    const { LicenseService } = await import('../services/LicenseService');
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValueOnce('community');
    vi.spyOn(LicenseService.getInstance(), 'getVariant').mockReturnValueOnce(null);

    const res = await request(app)
      .get('/api/audit-log/stats')
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(403);
  });

  it('returns the four-tile stat structure for admin', async () => {
    const res = await request(app)
      .get('/api/audit-log/stats')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('events_24h');
    expect(res.body).toHaveProperty('actors_24h');
    expect(res.body).toHaveProperty('failure_rate');
    expect(res.body).toHaveProperty('unusual_hour');
    expect(Array.isArray(res.body.activity_by_hour)).toBe(true);
    expect(res.body.activity_by_hour.length).toBe(24);
    expect(res.body.failures_by_hour.length).toBe(24);
  });
});

describe('GET /api/audit-log/export', () => {
  it('returns 403 without Admiral license', async () => {
    const { LicenseService } = await import('../services/LicenseService');
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValueOnce('community');
    vi.spyOn(LicenseService.getInstance(), 'getVariant').mockReturnValueOnce(null);

    const res = await request(app)
      .get('/api/audit-log/export?format=json')
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(403);
  });

  it('exports JSON with correct Content-Type', async () => {
    const res = await request(app)
      .get('/api/audit-log/export?format=json')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['content-disposition']).toContain('audit-log-');
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('exports CSV with correct Content-Type and headers', async () => {
    const res = await request(app)
      .get('/api/audit-log/export?format=csv')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('audit-log-');

    const csvText = res.text;
    const lines = csvText.split('\n');
    expect(lines[0]).toBe('id,timestamp,username,method,path,status_code,node_id,ip_address,summary');
    expect(lines.length).toBeGreaterThan(1);
  });

  it('respects filters during export', async () => {
    const res = await request(app)
      .get('/api/audit-log/export?format=json&method=DELETE')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    for (const entry of res.body) {
      expect(entry.method).toBe('DELETE');
    }
  });

  it('neutralizes a formula-injection payload in the CSV export', async () => {
    const db = DatabaseService.getInstance();
    db.insertAuditLog({
      timestamp: Date.now(),
      username: 'csvinjectuser',
      method: 'POST',
      path: '/api/stacks/csvinject',
      status_code: 200,
      node_id: null,
      ip_address: '127.0.0.1',
      summary: '=DANGER_FORMULA',
    });

    const res = await request(app)
      .get('/api/audit-log/export?format=csv&search=csvinjectuser')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    // The leading '=' must be defused with a single-quote prefix.
    expect(res.text).toContain("'=DANGER_FORMULA");
    expect(res.text).not.toMatch(/(^|,)=DANGER_FORMULA/);
  });
});

// ---- Audit middleware integration ----

describe('Audit middleware', () => {
  it('logs POST requests with correct data', async () => {
    const db = DatabaseService.getInstance();
    const beforeCount = db.getAuditLogs({ limit: 1 }).total;

    // Make a POST request that triggers the audit middleware
    await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ username: 'auditmiddlewaretest', password: 'password123', role: 'viewer' });

    const afterCount = db.getAuditLogs({ limit: 1 }).total;
    expect(afterCount).toBeGreaterThan(beforeCount);

    // The audit entry records the admin who performed the action, not the created user.
    // Search by the summary pattern instead.
    const { entries } = db.getAuditLogs({ search: 'Created user', method: 'POST', limit: 10 });
    const entry = entries.find(e => e.path === '/api/users');
    expect(entry).toBeDefined();
    expect(entry!.method).toBe('POST');
    expect(entry!.username).toBe(TEST_USERNAME);
  });

  it('does NOT log GET requests', async () => {
    const db = DatabaseService.getInstance();
    const beforeCount = db.getAuditLogs({ limit: 1 }).total;

    await request(app)
      .get('/api/health')
      .set('Authorization', `Bearer ${adminToken()}`);

    const afterCount = db.getAuditLogs({ limit: 1 }).total;
    expect(afterCount).toBe(beforeCount);
  });

  it('extracts first IP from X-Forwarded-For', async () => {
    const db = DatabaseService.getInstance();
    const beforeTotal = db.getAuditLogs({ limit: 1 }).total;

    await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .set('X-Forwarded-For', '203.0.113.50, 70.41.3.18, 150.172.238.178')
      .send({ username: 'xfftest', password: 'password123', role: 'viewer' });

    // Get the most recent entry (page 1, sorted by timestamp DESC)
    const { entries } = db.getAuditLogs({ method: 'POST', limit: 10 });
    // Find the new entry (total increased)
    const afterTotal = db.getAuditLogs({ limit: 1 }).total;
    expect(afterTotal).toBeGreaterThan(beforeTotal);

    // The most recent POST /api/users entry should have an IP set
    const entry = entries.find(e => e.path === '/api/users' && e.summary === 'Created user');
    expect(entry).toBeDefined();
    expect(entry!.ip_address).toBeDefined();
  });
});
