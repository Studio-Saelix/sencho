import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { sanitizeNotificationMessage } from '../utils/notificationMessage';

let tmpDir: string;
let db: import('../services/DatabaseService').DatabaseService;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  const { DatabaseService } = await import('../services/DatabaseService');
  db = DatabaseService.getInstance();
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  db.deleteAllNotifications(0);
});

describe('sanitizeNotificationMessage', () => {
  it('passes plain messages through unchanged', () => {
    expect(sanitizeNotificationMessage('Stack deployed in 4.2s')).toBe('Stack deployed in 4.2s');
  });

  it('redacts KEY=VALUE pairs whose key matches a sensitive suffix', () => {
    const raw = 'compose parse failed: DB_PASSWORD=hunter2 missing closing quote';
    expect(sanitizeNotificationMessage(raw)).toBe('compose parse failed: DB_PASSWORD=<redacted> missing closing quote');
  });

  it('redacts API_KEY, SECRET, TOKEN, CREDENTIAL variants', () => {
    expect(sanitizeNotificationMessage('STRIPE_API_KEY=sk_live_abc')).toContain('STRIPE_API_KEY=<redacted>');
    expect(sanitizeNotificationMessage('JWT_SECRET=eyJabc')).toContain('JWT_SECRET=<redacted>');
    expect(sanitizeNotificationMessage('GITHUB_TOKEN=ghp_abc')).toContain('GITHUB_TOKEN=<redacted>');
    expect(sanitizeNotificationMessage('AWS_CREDENTIALS=foo')).toContain('AWS_CREDENTIALS=<redacted>');
  });

  it('redacts every sensitive KEY=VALUE pair in a single message', () => {
    const raw = 'compose env: DB_PASSWORD=hunter2 API_KEY=abc OTHER=keep';
    const out = sanitizeNotificationMessage(raw);
    expect(out).toContain('DB_PASSWORD=<redacted>');
    expect(out).toContain('API_KEY=<redacted>');
    expect(out).toContain('OTHER=keep');
  });

  it('leaves bare PASS-suffix keys like BYPASS and COMPASS unredacted', () => {
    expect(sanitizeNotificationMessage('BYPASS=true')).toBe('BYPASS=true');
    expect(sanitizeNotificationMessage('COMPASS_URL=https://example.com')).toBe('COMPASS_URL=https://example.com');
  });

  it('leaves non-sensitive uppercase KEY=VALUE untouched', () => {
    expect(sanitizeNotificationMessage('NODE_ENV=production')).toBe('NODE_ENV=production');
    expect(sanitizeNotificationMessage('PORT=1852')).toBe('PORT=1852');
  });

  it('redacts lowercase sensitive keys (compose env vars are commonly lowercase)', () => {
    expect(sanitizeNotificationMessage('db_password=foo')).toBe('db_password=<redacted>');
    expect(sanitizeNotificationMessage('jwt_secret=abc')).toBe('jwt_secret=<redacted>');
    expect(sanitizeNotificationMessage('github_token=ghp_xyz')).toBe('github_token=<redacted>');
  });

  it('still leaves bare PASS-suffix lowercase keys unredacted', () => {
    expect(sanitizeNotificationMessage('bypass=true')).toBe('bypass=true');
    expect(sanitizeNotificationMessage('compass_url=https://example.com')).toBe('compass_url=https://example.com');
  });

  it('redacts HTTP basic auth in URLs', () => {
    const raw = 'pull failed for https://user:pa55@registry.example.com/img';
    expect(sanitizeNotificationMessage(raw)).toBe('pull failed for https://user:<redacted>@registry.example.com/img');
  });

  it('redacts bearer tokens', () => {
    const raw = 'auth header was Bearer abc123xyzdef456';
    expect(sanitizeNotificationMessage(raw)).toBe('auth header was Bearer <redacted>');
  });

  it('truncates messages longer than 1000 characters', () => {
    const raw = 'x'.repeat(2000);
    const out = sanitizeNotificationMessage(raw);
    expect(out.length).toBeLessThanOrEqual(1000);
    expect(out.endsWith('… [truncated]')).toBe(true);
  });

  it('collapses COMPOSE_DIR path prefixes', () => {
    const out = sanitizeNotificationMessage(
      'file not found: /opt/docker/sencho/compose/myapp/.env',
      { composeDir: '/opt/docker/sencho/compose' },
    );
    expect(out).toBe('file not found: <compose-dir>/myapp/.env');
  });

});

describe('DatabaseService.getStackActivity', () => {
  it('returns only events for the requested (node, stack)', () => {
    const base = Date.now();
    db.addNotificationHistory(0, { level: 'info', message: 'a-evt', timestamp: base, stack_name: 'a' });
    db.addNotificationHistory(0, { level: 'info', message: 'b-evt', timestamp: base + 1, stack_name: 'b' });
    db.addNotificationHistory(0, { level: 'info', message: 'a-evt-2', timestamp: base + 2, stack_name: 'a' });

    const aOnly = db.getStackActivity(0, 'a', { limit: 50 });
    expect(aOnly.map((e: any) => e.message)).toEqual(['a-evt-2', 'a-evt']);
  });

  it('honors limit and orders newest first', () => {
    const base = Date.now();
    for (let i = 0; i < 5; i++) {
      db.addNotificationHistory(0, { level: 'info', message: `e-${i}`, timestamp: base + i, stack_name: 's' });
    }
    const out = db.getStackActivity(0, 's', { limit: 3 });
    expect(out.length).toBe(3);
    expect(out.map((e: any) => e.message)).toEqual(['e-4', 'e-3', 'e-2']);
  });

  it('legacy timestamp-only cursor excludes equal-or-newer rows', () => {
    const base = Date.now();
    for (let i = 0; i < 5; i++) {
      db.addNotificationHistory(0, { level: 'info', message: `e-${i}`, timestamp: base + i * 10, stack_name: 's' });
    }
    // Cursor at base+20 (= e-2). before=base+20 means timestamp < base+20, so only e-0/e-1 returned.
    const out = db.getStackActivity(0, 's', { limit: 50, before: base + 20 });
    expect(out.map((e: any) => e.message)).toEqual(['e-1', 'e-0']);
  });

  it('composite (timestamp, id) cursor drops only the cursor row and older when many share a ms', () => {
    const ts = Date.now();
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      const row = db.addNotificationHistory(0, { level: 'info', message: `e-${i}`, timestamp: ts, stack_name: 's' });
      if (typeof row.id !== 'number') throw new Error('notification row missing id');
      ids.push(row.id);
    }
    // ids[0..4] all share ts. Cursor at the third row's id should return ids[0] and ids[1].
    const cursorId = ids[2];
    if (cursorId === undefined) throw new Error('cursor id missing');
    const out = db.getStackActivity(0, 's', { limit: 50, before: ts, beforeId: cursorId });
    const returnedIds = out.map((e: any) => e.id);
    expect(returnedIds).toEqual([ids[1], ids[0]]);
  });

  it('documents the legacy timestamp-only cursor drops same-ms rows (kept for backward compat)', () => {
    const ts = Date.now();
    for (let i = 0; i < 5; i++) {
      db.addNotificationHistory(0, { level: 'info', message: `e-${i}`, timestamp: ts, stack_name: 's' });
    }
    // The composite-cursor test above proves the fix; this test pins the legacy form's
    // behavior so a client that omits beforeId gets a predictable (if lossy) result.
    const out = db.getStackActivity(0, 's', { limit: 50, before: ts });
    expect(out).toEqual([]);
  });

  it('returns empty array when stack has no events', () => {
    db.addNotificationHistory(0, { level: 'info', message: 'other', timestamp: Date.now(), stack_name: 'other' });
    const out = db.getStackActivity(0, 'missing', { limit: 50 });
    expect(out).toEqual([]);
  });
});

describe('DatabaseService.clearSelfContainerNotificationRouting', () => {
  it('clears routing fields only from self Docker-event monitor notifications', () => {
    const ts = Date.now();
    const byProjectWithoutContainer = db.addNotificationHistory(0, {
      level: 'error',
      category: 'monitor_alert',
      actor_username: 'system:docker-events',
      message: 'sencho project crash without container',
      timestamp: ts,
      stack_name: 'sencho',
    });
    const byContainer = db.addNotificationHistory(0, {
      level: 'error',
      category: 'monitor_alert',
      actor_username: 'system:docker-events',
      message: 'sencho container crash',
      timestamp: ts + 1,
      stack_name: 'other',
      container_name: 'sencho',
    });
    const sameProjectOtherContainer = db.addNotificationHistory(0, {
      level: 'error',
      category: 'monitor_alert',
      actor_username: 'system:docker-events',
      message: 'sencho sidecar crash',
      timestamp: ts + 2,
      stack_name: 'sencho',
      container_name: 'sidecar',
    });
    const otherActor = db.addNotificationHistory(0, {
      level: 'error',
      category: 'monitor_alert',
      actor_username: 'system:monitor',
      message: 'user alert',
      timestamp: ts + 3,
      stack_name: 'sencho',
      container_name: 'sencho',
    });
    const otherStack = db.addNotificationHistory(0, {
      level: 'error',
      category: 'monitor_alert',
      actor_username: 'system:docker-events',
      message: 'web crash',
      timestamp: ts + 4,
      stack_name: 'web',
      container_name: 'web-1',
    });

    const changed = db.clearSelfContainerNotificationRouting(0, {
      containerName: 'sencho',
      composeProjectName: 'sencho',
    });

    expect(changed).toBe(2);
    const rows = new Map(db.getNotificationHistory(0, 50).map(row => [row.message, row] as const));
    expect(rows.get(byProjectWithoutContainer.message)?.stack_name).toBeUndefined();
    expect(rows.get(byProjectWithoutContainer.message)?.container_name).toBeUndefined();
    expect(rows.get(byContainer.message)?.stack_name).toBeUndefined();
    expect(rows.get(byContainer.message)?.container_name).toBeUndefined();
    expect(rows.get(sameProjectOtherContainer.message)?.stack_name).toBe('sencho');
    expect(rows.get(sameProjectOtherContainer.message)?.container_name).toBe('sidecar');
    expect(rows.get(otherActor.message)?.stack_name).toBe('sencho');
    expect(rows.get(otherActor.message)?.container_name).toBe('sencho');
    expect(rows.get(otherStack.message)?.stack_name).toBe('web');
    expect(rows.get(otherStack.message)?.container_name).toBe('web-1');
  });
});

describe('DatabaseService.addNotificationHistory (no per-insert prune)', () => {
  it('keeps a quiet stack visible even after a chatty stack writes past the old 100-row per-node cap', () => {
    const ts = Date.now();
    db.addNotificationHistory(0, { level: 'info', message: 'first', timestamp: ts, stack_name: 'a' });
    // The old per-insert prune kept only the newest 100 rows per node, regardless of stack.
    // Writing 150 rows for stack b would have evicted 'first' from stack a under the old rule.
    for (let i = 0; i < 150; i++) {
      db.addNotificationHistory(0, { level: 'info', message: `chatty-${i}`, timestamp: ts + i + 1, stack_name: 'b' });
    }
    const aActivity = db.getStackActivity(0, 'a', { limit: 50 });
    expect(aActivity.map((e: any) => e.message)).toEqual(['first']);
  });
});
