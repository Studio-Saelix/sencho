/**
 * Developer-mode hydration timing on the instrumented GET routes.
 *
 * Locks down that each instrumented handler emits exactly one structured
 * `console.debug` line under developer_mode, stays silent when it is off, and
 * carries the documented fields (counts, cache outcome, docker subspan,
 * sanitized stack name, elapsed, outcome). Also verifies the /nodes/:id/meta
 * diagnostic was folded into a single `[Nodes:debug]` line with no leftover
 * `[Nodes:diag]` output.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let CacheService: typeof import('../services/CacheService').CacheService;
let DockerController: typeof import('../services/DockerController').default;
let adminCookie: string;
let nodeId: number;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ CacheService } = await import('../services/CacheService'));
  DockerController = (await import('../services/DockerController')).default;
  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);
  nodeId = DatabaseService.getInstance().getDefaultNode()!.id!;
});

afterAll(() => cleanupTestDb(tmpDir));

afterEach(() => {
  DatabaseService.getInstance().updateGlobalSetting('developer_mode', '0');
});

function setDeveloperMode(on: boolean): void {
  DatabaseService.getInstance().updateGlobalSetting('developer_mode', on ? '1' : '0');
}

/** Run `fn` while capturing every console.debug line, returned as strings. */
async function captureDebug(fn: () => Promise<void>): Promise<string[]> {
  const spy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  let lines: string[];
  try {
    await fn();
    lines = spy.mock.calls.map((args) => args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
  } finally {
    spy.mockRestore();
  }
  return lines;
}

describe('[Stacks:debug] GET /api/stacks', () => {
  it('stays silent when developer_mode is off', async () => {
    setDeveloperMode(false);
    const lines = await captureDebug(async () => {
      await request(app).get('/api/stacks').set('Cookie', adminCookie);
    });
    expect(lines.filter((l) => l.startsWith('[Stacks:debug]'))).toHaveLength(0);
  });

  it('logs one line with nodeId, count, elapsed and outcome when on', async () => {
    setDeveloperMode(true);
    const lines = await captureDebug(async () => {
      await request(app).get('/api/stacks').set('Cookie', adminCookie);
    });
    const stacks = lines.filter((l) => l.startsWith('[Stacks:debug]'));
    expect(stacks).toHaveLength(1);
    expect(stacks[0]).toContain('route=GET /');
    expect(stacks[0]).toMatch(/nodeId=/);
    expect(stacks[0]).toMatch(/count=\d+/);
    expect(stacks[0]).toMatch(/elapsedMs=\d+/);
    expect(stacks[0]).toMatch(/outcome=ok/);
  });
});

describe('[Stacks:debug] GET /api/stacks/statuses', () => {
  it('reports cache outcome computed then hit, timing docker only on the compute', async () => {
    setDeveloperMode(true);
    CacheService.getInstance().invalidateNamespace('stack-statuses');
    // getInstance returns a fresh DockerController each call, so spy the shared
    // prototype method rather than one instance.
    const dockerSpy = vi.spyOn(DockerController.prototype, 'getBulkStackStatuses').mockResolvedValue({});

    const firstLines = await captureDebug(async () => {
      await request(app).get('/api/stacks/statuses').set('Cookie', adminCookie);
    });
    const secondLines = await captureDebug(async () => {
      await request(app).get('/api/stacks/statuses').set('Cookie', adminCookie);
    });

    // Capture the call count before restore; mockRestore() clears the history.
    const dockerCalls = dockerSpy.mock.calls.length;
    dockerSpy.mockRestore();

    const first = firstLines.find((l) => l.startsWith('[Stacks:debug]') && l.includes('route=GET /statuses'));
    const second = secondLines.find((l) => l.startsWith('[Stacks:debug]') && l.includes('route=GET /statuses'));
    expect(first).toMatch(/cacheOutcome=computed/);
    expect(first).toMatch(/dockerMs=\d+/);
    expect(second).toMatch(/cacheOutcome=hit/);
    // No docker call on a cache hit, so the subspan is null rather than 0.
    expect(second).toMatch(/dockerMs=null/);
    // Enrichment runs on every request, cache hits included, so its subspan
    // is a number on both legs.
    expect(first).toMatch(/enrichmentMs=\d+/);
    expect(second).toMatch(/enrichmentMs=\d+/);
    // The compute ran the fetcher exactly once across both requests.
    expect(dockerCalls).toBe(1);
  });
});

describe('[Stacks:debug] GET /api/stacks/:stack/containers', () => {
  it('logs the docker subspan and count without the stack name', async () => {
    setDeveloperMode(true);
    const dockerSpy = vi.spyOn(DockerController.prototype, 'getContainersByStack').mockResolvedValue([]);

    const lines = await captureDebug(async () => {
      await request(app).get('/api/stacks/web/containers').set('Cookie', adminCookie);
    });

    dockerSpy.mockRestore();

    const line = lines.find((l) => l.startsWith('[Stacks:debug]') && l.includes('/:stack/containers'));
    expect(line).toBeDefined();
    expect(line).toContain('route=GET /:stack/containers');
    expect(line).not.toContain('web');
    expect(line).not.toMatch(/\bstack=/);
    expect(line).toMatch(/count=0/);
    expect(line).toMatch(/dockerMs=\d+/);
    expect(line).toMatch(/outcome=ok/);
  });
});

describe('[Notifications:debug] GET /api/notifications', () => {
  it('stays silent when developer_mode is off', async () => {
    setDeveloperMode(false);
    const lines = await captureDebug(async () => {
      await request(app).get('/api/notifications').set('Cookie', adminCookie);
    });
    expect(lines.filter((l) => l.startsWith('[Notifications:debug]'))).toHaveLength(0);
  });

  it('logs count and elapsed when on', async () => {
    setDeveloperMode(true);
    const lines = await captureDebug(async () => {
      await request(app).get('/api/notifications').set('Cookie', adminCookie);
    });
    const line = lines.find((l) => l.startsWith('[Notifications:debug]'));
    expect(line).toBeDefined();
    expect(line).toMatch(/count=\d+/);
    expect(line).toMatch(/elapsedMs=\d+/);
    expect(line).toMatch(/outcome=ok/);
  });
});

describe('[Nodes:debug] GET /api/nodes', () => {
  it('logs a gateway-owned count line when on', async () => {
    setDeveloperMode(true);
    const lines = await captureDebug(async () => {
      await request(app).get('/api/nodes').set('Cookie', adminCookie);
    });
    const line = lines.find((l) => l.startsWith('[Nodes:debug]') && l.includes('route=GET /nodes'));
    expect(line).toBeDefined();
    expect(line).toMatch(/count=\d+/);
    expect(line).toMatch(/outcome=ok/);
  });
});

describe('[Nodes:debug] GET /api/nodes/:id/meta', () => {
  it('folds the old [Nodes:diag] meta line into a single [Nodes:debug] timing line', async () => {
    setDeveloperMode(true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

    await request(app).get(`/api/nodes/${nodeId}/meta`).set('Cookie', adminCookie);

    const logLines = logSpy.mock.calls.map((c) => String(c[0]));
    const debugLines = debugSpy.mock.calls.map((c) => String(c[0]));
    logSpy.mockRestore();
    debugSpy.mockRestore();

    expect(logLines.some((l) => l.includes('[Nodes:diag] meta'))).toBe(false);
    const line = debugLines.find((l) => l.startsWith('[Nodes:debug]') && l.includes('/nodes/:id/meta'));
    expect(line).toBeDefined();
    expect(line).toContain('type=local');
    expect(line).toMatch(new RegExp(`node=${nodeId}`));
    expect(line).toMatch(/outcome=ok/);
  });
});

describe('[ImageUpdates:debug] status and detail', () => {
  it('logs a line for /status and a counted line for /detail', async () => {
    setDeveloperMode(true);
    const statusLines = await captureDebug(async () => {
      await request(app).get('/api/image-updates/status').set('Cookie', adminCookie);
    });
    expect(
      statusLines.find((l) => l.startsWith('[ImageUpdates:debug]') && l.includes('route=GET /status')),
    ).toBeDefined();

    const detailLines = await captureDebug(async () => {
      await request(app).get('/api/image-updates/detail').set('Cookie', adminCookie);
    });
    const detail = detailLines.find((l) => l.startsWith('[ImageUpdates:debug]') && l.includes('route=GET /detail'));
    expect(detail).toBeDefined();
    expect(detail).toMatch(/count=\d+/);
    expect(detail).toMatch(/outcome=ok/);
  });
});
