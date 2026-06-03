/**
 * Route-level tests for the stack file explorer endpoints:
 *   GET    /:stackName/files
 *   GET    /:stackName/files/content
 *   GET    /:stackName/files/download
 *   POST   /:stackName/files/upload
 *   PUT    /:stackName/files/content
 *   DELETE /:stackName/files
 *   POST   /:stackName/files/folder
 *   PATCH  /:stackName/files/rename
 *   PUT    /:stackName/files/permissions
 *
 * The full file explorer is available on every tier; writes still require the
 * `stack:edit` permission (admin role). Tests cover: auth gating, RBAC gating,
 * Community-tier success, input validation, upload size limit, and happy-path
 * 204/200 responses.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { promises as fs } from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

// On Windows, fs.unlink on a directory returns EPERM instead of EISDIR so the
// NOT_EMPTY code path in deleteStackPath is never reached. Skip that test case
// on Windows; it is covered on Linux (CI).
const isWindows = process.platform === 'win32';

let tmpDir: string;
let app: import('express').Express;
let LicenseService: typeof import('../services/LicenseService').LicenseService;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let adminCookie: string;
let viewerCookie: string;
let stacksDir: string;
const STACK = 'teststack';

type FileExplorerMetricEntry = {
  op: string;
  count: number;
  successCount: number;
  errorCount: number;
};

type TestWritableResponse = NodeJS.WritableStream & {
  headersSent?: boolean;
  req?: { emit: (event: 'close') => boolean };
  destroy: (error?: Error) => void;
};

function asTestWritableResponse(destination: NodeJS.WritableStream): TestWritableResponse {
  return destination as unknown as TestWritableResponse;
}

async function resetFileExplorerMetrics(): Promise<void> {
  const { FileExplorerMetricsService } = await import('../services/FileExplorerMetricsService');
  FileExplorerMetricsService.resetForTests();
}

async function getDownloadMetric(): Promise<FileExplorerMetricEntry | undefined> {
  const metricsRes = await request(app)
    .get('/api/file-explorer-metrics')
    .set('Cookie', adminCookie);
  return (metricsRes.body.entries as FileExplorerMetricEntry[]).find(
    e => e.op === 'download',
  );
}

async function expectDownloadMetricCounts(count: number, successCount: number, errorCount: number): Promise<void> {
  let downloadEntry: FileExplorerMetricEntry | undefined;
  for (let attempt = 0; attempt < 20; attempt++) {
    downloadEntry = await getDownloadMetric();
    if (
      downloadEntry?.count === count &&
      downloadEntry.successCount === successCount &&
      downloadEntry.errorCount === errorCount
    ) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  expect(downloadEntry).toBeDefined();
  expect(downloadEntry!.count).toBe(count);
  expect(downloadEntry!.successCount).toBe(successCount);
  expect(downloadEntry!.errorCount).toBe(errorCount);
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  stacksDir = process.env.COMPOSE_DIR!;

  // Create stack directory so file operations have something to work with
  await fs.mkdir(path.join(stacksDir, STACK), { recursive: true });
  await fs.writeFile(path.join(stacksDir, STACK, 'compose.yaml'), 'services: {}\n');
  await fs.writeFile(path.join(stacksDir, STACK, '.env'), 'KEY=val\n');

  ({ LicenseService } = await import('../services/LicenseService'));
  ({ DatabaseService } = await import('../services/DatabaseService'));

  // Default: paid tier so most tests pass the tier gate
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
  vi.spyOn(LicenseService.getInstance(), 'getVariant').mockReturnValue('skipper');
  vi.spyOn(LicenseService.getInstance(), 'getSeatLimits').mockReturnValue({ maxAdmins: null, maxViewers: null });

  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);

  const viewerHash = await bcrypt.hash('viewerpass', 1);
  DatabaseService.getInstance().addUser({ username: 'files-viewer', password_hash: viewerHash, role: 'viewer' });
  const viewerRes = await request(app).post('/api/auth/login').send({ username: 'files-viewer', password: 'viewerpass' });
  const viewerCookies = viewerRes.headers['set-cookie'] as string | string[];
  viewerCookie = Array.isArray(viewerCookies) ? viewerCookies[0] : viewerCookies;
});

afterAll(async () => {
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  // Restore all spies then re-establish the paid-tier default so per-test
  // overrides via mockReturnValueOnce don't accumulate across tests.
  vi.restoreAllMocks();
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
  vi.spyOn(LicenseService.getInstance(), 'getVariant').mockReturnValue('skipper');
  vi.spyOn(LicenseService.getInstance(), 'getSeatLimits').mockReturnValue({ maxAdmins: null, maxViewers: null });
});

// ── GET /:stackName/files ─────────────────────────────────────────────────────

describe('GET /api/stacks/:stackName/files', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).get(`/api/stacks/${STACK}/files`);
    expect(res.status).toBe(401);
  });

  it('returns 200 with entries array for authenticated admin', async () => {
    const res = await request(app)
      .get(`/api/stacks/${STACK}/files`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('includes compose.yaml and .env in the listing', async () => {
    const res = await request(app)
      .get(`/api/stacks/${STACK}/files`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    const names = res.body.map((e: { name: string }) => e.name);
    expect(names).toContain('compose.yaml');
    expect(names).toContain('.env');
  });

  it('emits diagnostic logs only when developer_mode is enabled', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

    DatabaseService.getInstance().updateGlobalSetting('developer_mode', '0');
    await request(app)
      .get(`/api/stacks/${STACK}/files`)
      .set('Cookie', adminCookie);
    expect(debugSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('[Files:diag]'),
      expect.anything(),
    );

    DatabaseService.getInstance().updateGlobalSetting('developer_mode', '1');
    await request(app)
      .get(`/api/stacks/${STACK}/files`)
      .set('Cookie', adminCookie);
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Files:diag]'),
      expect.anything(),
    );

    DatabaseService.getInstance().updateGlobalSetting('developer_mode', '0');
  });

  it('emits a structured INFO line on a successful mutation (op/stack/path/bytes)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await request(app)
      .post(`/api/stacks/${STACK}/files/upload`)
      .set('Cookie', adminCookie)
      .attach('file', Buffer.from('observability payload'), 'observability-info.txt');

    const mutateCall = logSpy.mock.calls.find(
      ([prefix, details]) =>
        typeof prefix === 'string' &&
        prefix.includes('[Files] mutate') &&
        details &&
        typeof details === 'object' &&
        (details as { op?: unknown }).op === 'upload',
    );
    expect(mutateCall).toBeDefined();
    const details = mutateCall![1] as Record<string, unknown>;
    // sanitizeForLog coerces every value to a string before it lands in the log
    // payload, so bytes/mode/etc. arrive as their string representation. Operators
    // and log scrapers still see the right number; the test reflects that shape.
    expect(details.stack).toBe(STACK);
    expect(details.path).toBe('observability-info.txt');
    expect(typeof details.bytes).toBe('string');
    expect(Number(details.bytes)).toBeGreaterThan(0);

    logSpy.mockRestore();
  });

  it('records an error metric when an upload is rejected with FILE_EXISTS (overwrite confirm path)', async () => {
    const { FileExplorerMetricsService } = await import('../services/FileExplorerMetricsService');
    FileExplorerMetricsService.resetForTests();

    // Seed an existing file so the second upload hits the FILE_EXISTS branch.
    await fs.writeFile(path.join(stacksDir, STACK, 'observability-conflict.txt'), 'pre-existing');
    const res = await request(app)
      .post(`/api/stacks/${STACK}/files/upload`)
      .set('Cookie', adminCookie)
      .attach('file', Buffer.from('replacement'), 'observability-conflict.txt');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('FILE_EXISTS');

    const metricsRes = await request(app)
      .get('/api/file-explorer-metrics')
      .set('Cookie', adminCookie);
    const uploadEntry = (metricsRes.body.entries as Array<{ op: string; errorCount: number }>).find(
      e => e.op === 'upload',
    );
    expect(uploadEntry).toBeDefined();
    expect(uploadEntry!.errorCount).toBeGreaterThanOrEqual(1);
  });

  it('records a metric on the upload route that surfaces in /api/file-explorer-metrics', async () => {
    const { FileExplorerMetricsService } = await import('../services/FileExplorerMetricsService');
    FileExplorerMetricsService.resetForTests();

    await request(app)
      .post(`/api/stacks/${STACK}/files/upload`)
      .set('Cookie', adminCookie)
      .attach('file', Buffer.from('metrics payload'), 'observability-metrics.txt');

    const metricsRes = await request(app)
      .get('/api/file-explorer-metrics')
      .set('Cookie', adminCookie);
    expect(metricsRes.status).toBe(200);
    const uploadEntry = (metricsRes.body.entries as Array<{ op: string; successCount: number }>).find(
      e => e.op === 'upload',
    );
    expect(uploadEntry).toBeDefined();
    expect(uploadEntry!.successCount).toBeGreaterThanOrEqual(1);
    const bytesEntry = (metricsRes.body.uploadBytesByNode as Array<{ totalBytes: number }>)[0];
    expect(bytesEntry).toBeDefined();
    expect(bytesEntry.totalBytes).toBeGreaterThan(0);
  });

  it('returns 400 for an invalid stack name containing path traversal', async () => {
    const res = await request(app)
      .get('/api/stacks/../evil/files')
      .set('Cookie', adminCookie);
    // Express may normalise the URL before it reaches the handler;
    // the important thing is we never get 200
    expect([400, 404]).toContain(res.status);
  });

  it('returns 400 for a stack name with special characters', async () => {
    const res = await request(app)
      .get('/api/stacks/my%20stack/files')
      .set('Cookie', adminCookie);
    expect(res.status).toBe(400);
  });

  it('truncates a directory with more than 1000 entries and advertises totals in headers', async () => {
    const subdir = path.join(stacksDir, STACK, 'huge');
    await fs.mkdir(subdir, { recursive: true });
    // Seed 1100 small files. Names sort lexicographically so we can pin the
    // truncation boundary by inspecting the last returned entry.
    const targetCount = 1100;
    for (let i = 0; i < targetCount; i++) {
      const name = `f${String(i).padStart(5, '0')}.txt`;
      await fs.writeFile(path.join(subdir, name), '');
    }

    const res = await request(app)
      .get(`/api/stacks/${STACK}/files`)
      .query({ path: 'huge' })
      .set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(1000);
    expect(res.headers['x-total-count']).toBe(String(targetCount));
    expect(res.headers['x-returned-count']).toBe('1000');
    expect(res.headers['x-truncated']).toBe('true');

    await fs.rm(subdir, { recursive: true, force: true });
  }, 30000);

  it('does not set X-Truncated when the directory fits under the limit', async () => {
    const res = await request(app)
      .get(`/api/stacks/${STACK}/files`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.headers['x-truncated']).toBeUndefined();
    expect(res.headers['x-total-count']).toBe(String(res.body.length));
  });
});

// ── GET /:stackName/files/content ─────────────────────────────────────────────

describe('GET /api/stacks/:stackName/files/content', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app)
      .get(`/api/stacks/${STACK}/files/content`)
      .query({ path: 'compose.yaml' });
    expect(res.status).toBe(401);
  });

  it('returns 400 INVALID_PATH when path query parameter is missing', async () => {
    const res = await request(app)
      .get(`/api/stacks/${STACK}/files/content`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PATH');
  });

  it('returns 200 with file content for an existing text file', async () => {
    const res = await request(app)
      .get(`/api/stacks/${STACK}/files/content`)
      .query({ path: 'compose.yaml' })
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.binary).toBe(false);
    expect(res.body.oversized).toBe(false);
    expect(typeof res.body.content).toBe('string');
    expect(typeof res.body.mtimeMs).toBe('number');
    expect(res.body.mtimeMs).toBeGreaterThan(0);
  });

  it('sets a quoted ETag header derived from mtimeMs', async () => {
    const res = await request(app)
      .get(`/api/stacks/${STACK}/files/content`)
      .query({ path: 'compose.yaml' })
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.headers['etag']).toMatch(/^W\/"\d+"$/);
  });

  it('returns 404 for a non-existent file', async () => {
    const res = await request(app)
      .get(`/api/stacks/${STACK}/files/content`)
      .query({ path: 'nonexistent.txt' })
      .set('Cookie', adminCookie);
    expect(res.status).toBe(404);
  });

  it('returns oversized:true for a file larger than the 2 MB read limit', async () => {
    const bigPath = path.join(stacksDir, STACK, 'oversized.txt');
    await fs.writeFile(bigPath, 'x'.repeat(3 * 1024 * 1024));

    const res = await request(app)
      .get(`/api/stacks/${STACK}/files/content`)
      .query({ path: 'oversized.txt' })
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.oversized).toBe(true);
    expect(res.body.binary).toBe(false);
    expect(res.body.content).toBeUndefined();

    await fs.unlink(bigPath);
  }, 15000);

  it('returns binary:true by default for a file with a NUL byte in the probe window', async () => {
    const oddPath = path.join(stacksDir, STACK, 'force-text-default.txt');
    await fs.writeFile(oddPath, Buffer.from('hello\0world rest is utf8 text', 'utf-8'));
    try {
      const res = await request(app)
        .get(`/api/stacks/${STACK}/files/content`)
        .query({ path: 'force-text-default.txt' })
        .set('Cookie', adminCookie);
      expect(res.status).toBe(200);
      expect(res.body.binary).toBe(true);
      expect(res.body.content).toBeUndefined();
    } finally {
      await fs.unlink(oddPath);
    }
  });

  it('returns the content as UTF-8 when ?force=text is set, even for files the binary heuristic rejects', async () => {
    const oddPath = path.join(stacksDir, STACK, 'force-text-on.txt');
    const raw = Buffer.from('hello\0world rest is utf8 text', 'utf-8');
    await fs.writeFile(oddPath, raw);
    try {
      const res = await request(app)
        .get(`/api/stacks/${STACK}/files/content`)
        .query({ path: 'force-text-on.txt', force: 'text' })
        .set('Cookie', adminCookie);
      expect(res.status).toBe(200);
      expect(res.body.binary).toBe(false);
      expect(typeof res.body.content).toBe('string');
      expect(res.body.content).toBe(raw.toString('utf-8'));
    } finally {
      await fs.unlink(oddPath);
    }
  });
});

// ── GET /:stackName/files/download ────────────────────────────────────────────

describe('GET /api/stacks/:stackName/files/download', () => {
  // The download metric is recorded asynchronously, on the file stream's
  // end/close and the response's close event, so it can land after a test's
  // request has already resolved. Drain any such pending record before the next
  // test runs: a prior download must not leak a count across the next test's
  // resetFileExplorerMetrics() and inflate its "exactly once" assertion. Poll
  // until the download count holds steady across several reads (bounded).
  afterEach(async () => {
    let prev = -1;
    let stableReads = 0;
    for (let i = 0; i < 50 && stableReads < 3; i++) {
      const current = (await getDownloadMetric())?.count ?? 0;
      stableReads = current === prev ? stableReads + 1 : 0;
      prev = current;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    // If the count never settled, a record is firing repeatedly (a real bug);
    // surface it here rather than letting the bound silently swallow it.
    expect(stableReads).toBeGreaterThanOrEqual(3);
  });

  class CloseBeforeEndStream extends Readable {
    public bytesRead: number;

    constructor(private readonly payload: Buffer) {
      super();
      this.bytesRead = payload.length;
    }

    _read(): void {}

    override pipe<T extends NodeJS.WritableStream>(destination: T): T {
      destination.write(this.payload);
      this.emit('close');
      this.emit('end');
      destination.end();
      return destination;
    }
  }

  class RequestCloseBeforeReadStream extends Readable {
    public bytesRead = 0;
    public destroyCalls = 0;
    public emittedRequestClose = false;

    constructor(private readonly payload: Buffer) {
      super();
    }

    _read(): void {}

    override destroy(error?: Error): this {
      this.destroyCalls += 1;
      return super.destroy(error);
    }

    override pipe<T extends NodeJS.WritableStream>(destination: T): T {
      const req = asTestWritableResponse(destination).req;
      if (req) {
        this.emittedRequestClose = true;
        req.emit('close');
      }
      destination.write(this.payload);
      this.bytesRead = this.payload.length;
      this.emit('close');
      this.emit('end');
      destination.end();
      return destination;
    }
  }

  class ResponseCloseBeforeReadStream extends Readable {
    public bytesRead = 0;
    public destroyCalls = 0;
    public emittedResponseClose = false;

    _read(): void {}

    override destroy(_error?: Error): this {
      this.destroyCalls += 1;
      return this;
    }

    override pipe<T extends NodeJS.WritableStream>(destination: T): T {
      this.emittedResponseClose = destination.emit('close');
      asTestWritableResponse(destination).destroy(new Error('synthetic client abort'));
      return destination;
    }
  }

  class ResponseCloseThenFullReadStream extends Readable {
    public bytesRead = 0;
    public destroyCalls = 0;
    public emittedResponseClose = false;

    constructor(private readonly payload: Buffer) {
      super();
    }

    _read(): void {}

    override destroy(error?: Error): this {
      this.destroyCalls += 1;
      return super.destroy(error);
    }

    override pipe<T extends NodeJS.WritableStream>(destination: T): T {
      this.emittedResponseClose = destination.emit('close');
      destination.write(this.payload);
      this.bytesRead = this.payload.length;
      this.emit('end');
      this.emit('close');
      destination.end();
      return destination;
    }
  }

  class ResponseCloseAfterFullReadStream extends Readable {
    public bytesRead = 0;
    public destroyCalls = 0;
    public emittedResponseClose = false;

    constructor(private readonly payload: Buffer) {
      super();
    }

    _read(): void {}

    override destroy(error?: Error): this {
      this.destroyCalls += 1;
      return super.destroy(error);
    }

    override pipe<T extends NodeJS.WritableStream>(destination: T): T {
      destination.write(this.payload);
      this.bytesRead = this.payload.length;
      // The response closes after the whole body was received, and the source
      // stream never emits its own end/close because the consumer is already
      // gone. Mirrors the real fs.ReadStream path under load that previously
      // left the download metric unrecorded.
      this.emittedResponseClose = destination.emit('close');
      destination.end();
      return destination;
    }
  }

  class ErrorThenCloseStream extends Readable {
    _read(): void {}

    override pipe<T extends NodeJS.WritableStream>(destination: T): T {
      this.emit('error', new Error('synthetic read failure'));
      this.emit('close');
      return destination;
    }
  }

  class PrematureCloseOnlyStream extends Readable {
    public bytesRead = 0;

    _read(): void {}

    override pipe<T extends NodeJS.WritableStream>(destination: T): T {
      this.emit('close');
      asTestWritableResponse(destination).destroy(new Error('synthetic premature close'));
      return destination;
    }
  }

  class EarlyEndBeforeFullReadStream extends Readable {
    public bytesRead = 1;

    _read(): void {}

    override pipe<T extends NodeJS.WritableStream>(destination: T): T {
      this.emit('end');
      this.emit('close');
      asTestWritableResponse(destination).destroy(new Error('synthetic early end'));
      return destination;
    }
  }

  class PartialWriteThenErrorStream extends Readable {
    public headersWereSent = false;

    constructor(private readonly payload: Buffer) {
      super();
    }

    _read(): void {}

    override pipe<T extends NodeJS.WritableStream>(destination: T): T {
      destination.write(this.payload);
      this.headersWereSent = Boolean(asTestWritableResponse(destination).headersSent);
      this.emit('error', new Error('synthetic partial read failure'));
      this.emit('close');
      return destination;
    }
  }

  async function mockDownloadStream(stream: Readable, size: number): Promise<void> {
    const { FileSystemService } = await import('../services/FileSystemService');
    vi.spyOn(FileSystemService, 'getInstance').mockReturnValue({
      streamStackFile: vi.fn().mockResolvedValue({
        stream,
        size,
        filename: 'compose.yaml',
        mime: 'text/yaml',
      }),
    } as unknown as InstanceType<typeof FileSystemService>);
  }

  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app)
      .get(`/api/stacks/${STACK}/files/download`)
      .query({ path: 'compose.yaml' });
    expect(res.status).toBe(401);
  });

  it('streams the file for a Community-tier admin', async () => {
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValueOnce('community');
    const res = await request(app)
      .get(`/api/stacks/${STACK}/files/download`)
      .query({ path: 'compose.yaml' })
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
  });

  it('returns 400 INVALID_PATH when path query parameter is missing', async () => {
    const res = await request(app)
      .get(`/api/stacks/${STACK}/files/download`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PATH');
  });

  it('streams the file for a paid tier user', async () => {
    const res = await request(app)
      .get(`/api/stacks/${STACK}/files/download`)
      .query({ path: 'compose.yaml' })
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.text).toContain('services');
  });

  it('records the download metric exactly once per successful file read', async () => {
    // The metric recorder is wired to the file stream lifecycle and guarded
    // by a flag so a later stream event cannot record the same download again.
    await resetFileExplorerMetrics();

    const res = await request(app)
      .get(`/api/stacks/${STACK}/files/download`)
      .query({ path: 'compose.yaml' })
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);

    await expectDownloadMetricCounts(1, 1, 0);
  });

  it('records a fully read stream as success when close fires before end', async () => {
    await resetFileExplorerMetrics();
    const payload = Buffer.from('services: {}\n');
    await mockDownloadStream(new CloseBeforeEndStream(payload), payload.length);

    const res = await request(app)
      .get(`/api/stacks/${STACK}/files/download`)
      .query({ path: 'compose.yaml' })
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.text).toBe(payload.toString('utf-8'));

    await expectDownloadMetricCounts(1, 1, 0);
  });

  it('does not destroy the stream when request close fires before the file is read', async () => {
    await resetFileExplorerMetrics();
    const payload = Buffer.from('services: {}\n');
    const stream = new RequestCloseBeforeReadStream(payload);
    await mockDownloadStream(stream, payload.length);

    const res = await request(app)
      .get(`/api/stacks/${STACK}/files/download`)
      .query({ path: 'compose.yaml' })
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.text).toBe(payload.toString('utf-8'));
    expect(stream.emittedRequestClose).toBe(true);
    expect(stream.destroyCalls).toBe(0);

    await expectDownloadMetricCounts(1, 1, 0);
  });

  it('records response abort cleanup exactly once as a failed download', async () => {
    await resetFileExplorerMetrics();
    const stream = new ResponseCloseBeforeReadStream();
    await mockDownloadStream(stream, 16);

    await expect(request(app)
      .get(`/api/stacks/${STACK}/files/download`)
      .query({ path: 'compose.yaml' })
      .set('Cookie', adminCookie)).rejects.toThrow();

    expect(stream.emittedResponseClose).toBe(true);
    await expectDownloadMetricCounts(1, 0, 1);
    expect(stream.destroyCalls).toBe(1);
  });

  it('lets full source completion win when response close fires first', async () => {
    await resetFileExplorerMetrics();
    const payload = Buffer.from('services: {}\n');
    const stream = new ResponseCloseThenFullReadStream(payload);
    await mockDownloadStream(stream, payload.length);

    const res = await request(app)
      .get(`/api/stacks/${STACK}/files/download`)
      .query({ path: 'compose.yaml' })
      .set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(stream.emittedResponseClose).toBe(true);
    expect(stream.destroyCalls).toBe(0);
    await expectDownloadMetricCounts(1, 1, 0);
  });

  it('records a success when the response closes after a full read and the source emits no end/close', async () => {
    await resetFileExplorerMetrics();
    const payload = Buffer.from('services: {}\n');
    const stream = new ResponseCloseAfterFullReadStream(payload);
    await mockDownloadStream(stream, payload.length);

    const res = await request(app)
      .get(`/api/stacks/${STACK}/files/download`)
      .query({ path: 'compose.yaml' })
      .set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(res.text).toBe(payload.toString('utf-8'));
    expect(stream.emittedResponseClose).toBe(true);
    expect(stream.destroyCalls).toBe(0);
    await expectDownloadMetricCounts(1, 1, 0);
  });

  it('records stream error followed by close exactly once as a failed download', async () => {
    await resetFileExplorerMetrics();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await mockDownloadStream(new ErrorThenCloseStream(), 16);

    try {
      const res = await request(app)
        .get(`/api/stacks/${STACK}/files/download`)
        .query({ path: 'compose.yaml' })
        .set('Cookie', adminCookie);
      expect(res.status).toBe(500);
    } finally {
      errorSpy.mockRestore();
    }

    await expectDownloadMetricCounts(1, 0, 1);
  });

  it('records bare source close before full read exactly once as a failed download', async () => {
    await resetFileExplorerMetrics();
    await mockDownloadStream(new PrematureCloseOnlyStream(), 16);

    await expect(request(app)
      .get(`/api/stacks/${STACK}/files/download`)
      .query({ path: 'compose.yaml' })
      .set('Cookie', adminCookie)).rejects.toThrow();

    await expectDownloadMetricCounts(1, 0, 1);
  });

  it('records source end before full read exactly once as a failed download', async () => {
    await resetFileExplorerMetrics();
    await mockDownloadStream(new EarlyEndBeforeFullReadStream(), 16);

    await expect(request(app)
      .get(`/api/stacks/${STACK}/files/download`)
      .query({ path: 'compose.yaml' })
      .set('Cookie', adminCookie)).rejects.toThrow();

    await expectDownloadMetricCounts(1, 0, 1);
  });

  it('records a partial stream error after headers are sent exactly once', async () => {
    await resetFileExplorerMetrics();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stream = new PartialWriteThenErrorStream(Buffer.from('partial'));
    await mockDownloadStream(stream, 16);

    try {
      await expect(request(app)
        .get(`/api/stacks/${STACK}/files/download`)
        .query({ path: 'compose.yaml' })
        .set('Cookie', adminCookie)).rejects.toThrow();
    } finally {
      errorSpy.mockRestore();
    }
    expect(stream.headersWereSent).toBe(true);

    await expectDownloadMetricCounts(1, 0, 1);
  });
});

// ── POST /:stackName/files/upload ─────────────────────────────────────────────

describe('POST /api/stacks/:stackName/files/upload', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app)
      .post(`/api/stacks/${STACK}/files/upload`)
      .attach('file', Buffer.from('data'), 'test.txt');
    expect(res.status).toBe(401);
  });

  it('uploads successfully for a Community-tier admin', async () => {
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValueOnce('community');
    const res = await request(app)
      .post(`/api/stacks/${STACK}/files/upload`)
      .set('Cookie', adminCookie)
      .attach('file', Buffer.from('community-upload'), 'community-upload.txt');
    expect(res.status).toBe(204);

    const content = await fs.readFile(path.join(stacksDir, STACK, 'community-upload.txt'), 'utf-8');
    expect(content).toBe('community-upload');
  });

  it('returns 400 when no file is attached', async () => {
    const res = await request(app)
      .post(`/api/stacks/${STACK}/files/upload`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(400);
  });

  it('rejects upload filenames with path separators', async () => {
    const boundary = '----sencho-test-boundary';
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="../evil.txt"',
      'Content-Type: text/plain',
      '',
      'data',
      `--${boundary}--`,
      '',
    ].join('\r\n');

    const res = await request(app)
      .post(`/api/stacks/${STACK}/files/upload`)
      .set('Cookie', adminCookie)
      .set('Content-Type', `multipart/form-data; boundary=${boundary}`)
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid filename');
  });

  it('returns 413 TOO_LARGE when file exceeds 25 MB', async () => {
    // 26 MB buffer
    const bigFile = Buffer.alloc(26 * 1024 * 1024, 0x61);
    const res = await request(app)
      .post(`/api/stacks/${STACK}/files/upload`)
      .set('Cookie', adminCookie)
      .attach('file', bigFile, 'toobig.txt');
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('TOO_LARGE');
  }, 20000);

  it('returns 204 for a valid file upload (paid tier)', async () => {
    const res = await request(app)
      .post(`/api/stacks/${STACK}/files/upload`)
      .set('Cookie', adminCookie)
      .attach('file', Buffer.from('uploaded content'), 'uploaded.txt');
    expect(res.status).toBe(204);

    // Verify the file was written
    const content = await fs.readFile(path.join(stacksDir, STACK, 'uploaded.txt'), 'utf-8');
    expect(content).toBe('uploaded content');
  });

  it('returns 204 and writes into a subdirectory when ?path= is provided', async () => {
    const res = await request(app)
      .post(`/api/stacks/${STACK}/files/upload`)
      .query({ path: 'subdir' })
      .set('Cookie', adminCookie)
      .attach('file', Buffer.from('subdir content'), 'sub.txt');
    expect(res.status).toBe(204);

    const content = await fs.readFile(path.join(stacksDir, STACK, 'subdir', 'sub.txt'), 'utf-8');
    expect(content).toBe('subdir content');
  });

  it('returns 409 FILE_EXISTS when the target name already exists and overwrite is not set', async () => {
    const target = path.join(stacksDir, STACK, 'existing.txt');
    await fs.writeFile(target, 'original');
    const res = await request(app)
      .post(`/api/stacks/${STACK}/files/upload`)
      .set('Cookie', adminCookie)
      .attach('file', Buffer.from('replacement'), 'existing.txt');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('FILE_EXISTS');
    // Original content must be preserved when the upload is rejected.
    const after = await fs.readFile(target, 'utf-8');
    expect(after).toBe('original');
    await fs.unlink(target);
  });

  it('overwrites when ?overwrite=1 is set', async () => {
    const target = path.join(stacksDir, STACK, 'replaceme.txt');
    await fs.writeFile(target, 'before');
    const res = await request(app)
      .post(`/api/stacks/${STACK}/files/upload`)
      .query({ overwrite: '1' })
      .set('Cookie', adminCookie)
      .attach('file', Buffer.from('after'), 'replaceme.txt');
    expect(res.status).toBe(204);
    const after = await fs.readFile(target, 'utf-8');
    expect(after).toBe('after');
    await fs.unlink(target);
  });

  it('returns 409 DIR_EXISTS when a directory occupies the upload target name', async () => {
    const dir = path.join(stacksDir, STACK, 'collide-dir');
    await fs.mkdir(dir, { recursive: true });
    const res = await request(app)
      .post(`/api/stacks/${STACK}/files/upload`)
      .set('Cookie', adminCookie)
      .attach('file', Buffer.from('whatever'), 'collide-dir');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DIR_EXISTS');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('still returns 409 DIR_EXISTS even when ?overwrite=1 is set (directories are never replaced)', async () => {
    const dir = path.join(stacksDir, STACK, 'collide-dir-2');
    await fs.mkdir(dir, { recursive: true });
    const res = await request(app)
      .post(`/api/stacks/${STACK}/files/upload`)
      .query({ overwrite: '1' })
      .set('Cookie', adminCookie)
      .attach('file', Buffer.from('whatever'), 'collide-dir-2');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DIR_EXISTS');
    // The directory must still exist after the rejected upload.
    const stat = await fs.stat(dir);
    expect(stat.isDirectory()).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

// ── PUT /:stackName/files/content ─────────────────────────────────────────────

describe('PUT /api/stacks/:stackName/files/content', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app)
      .put(`/api/stacks/${STACK}/files/content`)
      .query({ path: 'new.txt' })
      .send({ content: 'hello' });
    expect(res.status).toBe(401);
  });

  it('writes the file for a Community-tier admin', async () => {
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValueOnce('community');
    const res = await request(app)
      .put(`/api/stacks/${STACK}/files/content`)
      .query({ path: 'community-write.txt' })
      .set('Cookie', adminCookie)
      .send({ content: 'community-write' });
    expect(res.status).toBe(204);

    const content = await fs.readFile(path.join(stacksDir, STACK, 'community-write.txt'), 'utf-8');
    expect(content).toBe('community-write');
  });

  it('returns 400 when content is not a string', async () => {
    const res = await request(app)
      .put(`/api/stacks/${STACK}/files/content`)
      .query({ path: 'new.txt' })
      .set('Cookie', adminCookie)
      .send({ content: 42 });
    expect(res.status).toBe(400);
  });

  it('returns 400 INVALID_PATH when path query parameter is missing', async () => {
    const res = await request(app)
      .put(`/api/stacks/${STACK}/files/content`)
      .set('Cookie', adminCookie)
      .send({ content: 'hello' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PATH');
  });

  it('returns 204 and writes the file for a paid tier admin', async () => {
    const res = await request(app)
      .put(`/api/stacks/${STACK}/files/content`)
      .query({ path: 'written.txt' })
      .set('Cookie', adminCookie)
      .send({ content: 'written via PUT' });
    expect(res.status).toBe(204);

    const content = await fs.readFile(path.join(stacksDir, STACK, 'written.txt'), 'utf-8');
    expect(content).toBe('written via PUT');
  });

  it('echoes a fresh ETag header on successful write', async () => {
    const res = await request(app)
      .put(`/api/stacks/${STACK}/files/content`)
      .query({ path: 'etag-write.txt' })
      .set('Cookie', adminCookie)
      .send({ content: 'etag write' });
    expect(res.status).toBe(204);
    expect(res.headers['etag']).toMatch(/^W\/"\d+"$/);
  });

  it('returns 412 when If-Match disagrees with the current mtimeMs and surfaces the live content', async () => {
    // Seed the target so a known mtime exists.
    const target = path.join(stacksDir, STACK, 'mtime-target.txt');
    await fs.writeFile(target, 'ORIGINAL');

    const res = await request(app)
      .put(`/api/stacks/${STACK}/files/content`)
      .query({ path: 'mtime-target.txt' })
      .set('Cookie', adminCookie)
      .set('If-Match', '"1"') // deliberately stale
      .send({ content: 'overwrite attempt' });

    expect(res.status).toBe(412);
    expect(res.body.code).toBe('PRECONDITION_FAILED');
    expect(res.body.currentContent).toBe('ORIGINAL');
    expect(typeof res.body.currentMtimeMs).toBe('number');

    // Disk content is unchanged.
    const after = await fs.readFile(target, 'utf-8');
    expect(after).toBe('ORIGINAL');
  });

  it('succeeds when If-Match matches the current mtimeMs', async () => {
    const target = path.join(stacksDir, STACK, 'mtime-match.txt');
    await fs.writeFile(target, 'first');
    const getRes = await request(app)
      .get(`/api/stacks/${STACK}/files/content`)
      .query({ path: 'mtime-match.txt' })
      .set('Cookie', adminCookie);
    expect(getRes.status).toBe(200);
    const etag = getRes.headers['etag'];
    expect(etag).toBeDefined();

    const putRes = await request(app)
      .put(`/api/stacks/${STACK}/files/content`)
      .query({ path: 'mtime-match.txt' })
      .set('Cookie', adminCookie)
      .set('If-Match', etag)
      .send({ content: 'second' });
    expect(putRes.status).toBe(204);
    expect(putRes.headers['etag']).toBeDefined();
    expect(putRes.headers['etag']).not.toBe(etag);

    const after = await fs.readFile(target, 'utf-8');
    expect(after).toBe('second');
  });

  it('still writes when no If-Match header is sent (backward compat)', async () => {
    const target = path.join(stacksDir, STACK, 'no-ifmatch.txt');
    await fs.writeFile(target, 'before');
    const res = await request(app)
      .put(`/api/stacks/${STACK}/files/content`)
      .query({ path: 'no-ifmatch.txt' })
      .set('Cookie', adminCookie)
      .send({ content: 'after' });
    expect(res.status).toBe(204);
    const after = await fs.readFile(target, 'utf-8');
    expect(after).toBe('after');
  });

  it('returns 412 with an empty snapshot when If-Match was set but the target has been deleted', async () => {
    // No file at this path; the caller's If-Match implies an existing file.
    const res = await request(app)
      .put(`/api/stacks/${STACK}/files/content`)
      .query({ path: 'vanished.txt' })
      .set('Cookie', adminCookie)
      .set('If-Match', '"42"')
      .send({ content: 'i was editing this' });
    expect(res.status).toBe(412);
    expect(res.body.code).toBe('PRECONDITION_FAILED');
    expect(res.body.currentContent).toBe('');
    expect(res.body.currentMtimeMs).toBe(0);
    // Nothing was written.
    await expect(fs.access(path.join(stacksDir, STACK, 'vanished.txt'))).rejects.toThrow();
  });

  it('still writes a fresh file when no If-Match is sent (target does not exist)', async () => {
    const res = await request(app)
      .put(`/api/stacks/${STACK}/files/content`)
      .query({ path: 'brand-new.txt' })
      .set('Cookie', adminCookie)
      .send({ content: 'first content' });
    expect(res.status).toBe(204);
    const content = await fs.readFile(path.join(stacksDir, STACK, 'brand-new.txt'), 'utf-8');
    expect(content).toBe('first content');
  });
});

// ── PATCH /:stackName/files/rename ───────────────────────────────────────────

describe('PATCH /api/stacks/:stackName/files/rename', () => {
  it('returns 409 ALREADY_EXISTS when destination exists', async () => {
    await fs.writeFile(path.join(stacksDir, STACK, 'rename-source.txt'), 'source');
    await fs.writeFile(path.join(stacksDir, STACK, 'rename-target.txt'), 'target');

    const res = await request(app)
      .patch(`/api/stacks/${STACK}/files/rename`)
      .set('Cookie', adminCookie)
      .send({ from: 'rename-source.txt', to: 'rename-target.txt' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_EXISTS');
  });

  it('renames successfully for a Community-tier admin', async () => {
    await fs.writeFile(path.join(stacksDir, STACK, 'community-rename-from.txt'), 'src');
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValueOnce('community');
    const res = await request(app)
      .patch(`/api/stacks/${STACK}/files/rename`)
      .set('Cookie', adminCookie)
      .send({ from: 'community-rename-from.txt', to: 'community-rename-to.txt' });
    expect(res.status).toBe(204);

    await expect(fs.access(path.join(stacksDir, STACK, 'community-rename-from.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    const moved = await fs.readFile(path.join(stacksDir, STACK, 'community-rename-to.txt'), 'utf-8');
    expect(moved).toBe('src');
  });
});

// ── PUT /:stackName/files/permissions ────────────────────────────────────────

describe('PUT /api/stacks/:stackName/files/permissions', () => {
  it('returns 400 INVALID_PATH for invalid chmod modes', async () => {
    const res = await request(app)
      .put(`/api/stacks/${STACK}/files/permissions`)
      .query({ path: 'compose.yaml' })
      .set('Cookie', adminCookie)
      .send({ mode: 0o1000 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PATH');
  });

  it('sets permissions successfully for a Community-tier admin', async () => {
    await fs.writeFile(path.join(stacksDir, STACK, 'community-perms.txt'), 'data');
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValueOnce('community');
    const res = await request(app)
      .put(`/api/stacks/${STACK}/files/permissions`)
      .query({ path: 'community-perms.txt' })
      .set('Cookie', adminCookie)
      .send({ mode: 0o600 });
    expect(res.status).toBe(204);
  });
});

// ── DELETE /:stackName/files ──────────────────────────────────────────────────

describe('DELETE /api/stacks/:stackName/files', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app)
      .delete(`/api/stacks/${STACK}/files`)
      .query({ path: 'compose.yaml' });
    expect(res.status).toBe(401);
  });

  it('deletes successfully for a Community-tier admin', async () => {
    await fs.writeFile(path.join(stacksDir, STACK, 'community-delete.txt'), 'bye');
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValueOnce('community');
    const res = await request(app)
      .delete(`/api/stacks/${STACK}/files`)
      .query({ path: 'community-delete.txt' })
      .set('Cookie', adminCookie);
    expect(res.status).toBe(204);

    await expect(fs.access(path.join(stacksDir, STACK, 'community-delete.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns 400 when path is missing', async () => {
    const res = await request(app)
      .delete(`/api/stacks/${STACK}/files`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(400);
  });

  it('returns 204 on successful file deletion', async () => {
    // Create a disposable file first
    await fs.writeFile(path.join(stacksDir, STACK, 'todelete.txt'), 'bye');

    const res = await request(app)
      .delete(`/api/stacks/${STACK}/files`)
      .query({ path: 'todelete.txt' })
      .set('Cookie', adminCookie);
    expect(res.status).toBe(204);

    await expect(fs.access(path.join(stacksDir, STACK, 'todelete.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(isWindows)('returns 409 NOT_EMPTY when deleting a non-empty directory without recursive flag (Linux/macOS only)', async () => {
    const dirPath = path.join(stacksDir, STACK, 'nonemptydir');
    await fs.mkdir(dirPath, { recursive: true });
    await fs.writeFile(path.join(dirPath, 'child.txt'), '');

    const res = await request(app)
      .delete(`/api/stacks/${STACK}/files`)
      .query({ path: 'nonemptydir' })
      .set('Cookie', adminCookie);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_EMPTY');
  });

  it.skipIf(isWindows)('returns 204 and removes a non-empty directory when recursive=1 (Linux/macOS only)', async () => {
    const dirPath = path.join(stacksDir, STACK, 'recursivedir');
    await fs.mkdir(dirPath, { recursive: true });
    await fs.writeFile(path.join(dirPath, 'child.txt'), 'data');

    const res = await request(app)
      .delete(`/api/stacks/${STACK}/files`)
      .query({ path: 'recursivedir', recursive: '1' })
      .set('Cookie', adminCookie);
    expect(res.status).toBe(204);

    await expect(fs.access(dirPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

// ── POST /:stackName/files/folder ─────────────────────────────────────────────

describe('POST /api/stacks/:stackName/files/folder', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app)
      .post(`/api/stacks/${STACK}/files/folder`)
      .query({ path: 'newdir' });
    expect(res.status).toBe(401);
  });

  it('creates the folder for a Community-tier admin', async () => {
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValueOnce('community');
    const res = await request(app)
      .post(`/api/stacks/${STACK}/files/folder`)
      .query({ path: 'community-folder' })
      .set('Cookie', adminCookie);
    expect(res.status).toBe(204);

    const stat = await fs.stat(path.join(stacksDir, STACK, 'community-folder'));
    expect(stat.isDirectory()).toBe(true);
  });

  it('returns 400 when path is missing', async () => {
    const res = await request(app)
      .post(`/api/stacks/${STACK}/files/folder`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(400);
  });

  it('returns 204 and creates the directory for a paid tier admin', async () => {
    const res = await request(app)
      .post(`/api/stacks/${STACK}/files/folder`)
      .query({ path: 'mynewdir' })
      .set('Cookie', adminCookie);
    expect(res.status).toBe(204);

    const stat = await fs.stat(path.join(stacksDir, STACK, 'mynewdir'));
    expect(stat.isDirectory()).toBe(true);
  });
});

// ── permission gating ─────────────────────────────────────────────────────────

describe('permission gating', () => {
  it('viewer receives 403 from PUT /files/content', async () => {
    const res = await request(app)
      .put(`/api/stacks/${STACK}/files/content`)
      .query({ path: 'new.txt' })
      .set('Cookie', viewerCookie)
      .send({ content: 'hello' });
    expect(res.status).toBe(403);
  });

  it('viewer receives 403 from POST /files/upload', async () => {
    const res = await request(app)
      .post(`/api/stacks/${STACK}/files/upload`)
      .set('Cookie', viewerCookie)
      .attach('file', Buffer.from('data'), 'test.txt');
    expect(res.status).toBe(403);
  });

  it('viewer receives 403 from DELETE /files', async () => {
    const res = await request(app)
      .delete(`/api/stacks/${STACK}/files`)
      .query({ path: 'compose.yaml' })
      .set('Cookie', viewerCookie);
    expect(res.status).toBe(403);
  });

  it('viewer receives 403 from POST /files/folder', async () => {
    const res = await request(app)
      .post(`/api/stacks/${STACK}/files/folder`)
      .query({ path: 'somedir' })
      .set('Cookie', viewerCookie);
    expect(res.status).toBe(403);
  });

  it('viewer receives 403 from PATCH /files/rename', async () => {
    const res = await request(app)
      .patch(`/api/stacks/${STACK}/files/rename`)
      .set('Cookie', viewerCookie)
      .send({ from: 'compose.yaml', to: 'compose-renamed.yaml' });
    expect(res.status).toBe(403);
  });

  it('viewer receives 403 from PUT /files/permissions', async () => {
    const res = await request(app)
      .put(`/api/stacks/${STACK}/files/permissions`)
      .query({ path: 'compose.yaml' })
      .set('Cookie', viewerCookie)
      .send({ mode: 0o644 });
    expect(res.status).toBe(403);
  });

  it('viewer with global stack:read can GET /files', async () => {
    const res = await request(app)
      .get(`/api/stacks/${STACK}/files`)
      .set('Cookie', viewerCookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('viewer with global stack:read can GET /files/content', async () => {
    const res = await request(app)
      .get(`/api/stacks/${STACK}/files/content`)
      .query({ path: 'compose.yaml' })
      .set('Cookie', viewerCookie);
    expect(res.status).toBe(200);
    expect(typeof res.body.content).toBe('string');
  });

  it('viewer with global stack:read can GET /files/download', async () => {
    const res = await request(app)
      .get(`/api/stacks/${STACK}/files/download`)
      .query({ path: 'compose.yaml' })
      .set('Cookie', viewerCookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
  });

  it('viewer with global stack:read can GET /files/permissions', async () => {
    const res = await request(app)
      .get(`/api/stacks/${STACK}/files/permissions`)
      .query({ path: 'compose.yaml' })
      .set('Cookie', viewerCookie);
    expect(res.status).toBe(200);
    expect(typeof res.body.octal).toBe('string');
  });
});

// ── protected stack files (compose.yaml, .env) ────────────────────────────────

describe('protected stack files', () => {
  it('DELETE /files refuses compose.yaml with 409 PROTECTED_FILE', async () => {
    const res = await request(app)
      .delete(`/api/stacks/${STACK}/files`)
      .query({ path: 'compose.yaml' })
      .set('Cookie', adminCookie);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PROTECTED_FILE');
  });

  it('DELETE /files refuses .env with 409 PROTECTED_FILE', async () => {
    const res = await request(app)
      .delete(`/api/stacks/${STACK}/files`)
      .query({ path: '.env' })
      .set('Cookie', adminCookie);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PROTECTED_FILE');
  });

  it('PATCH /files/rename refuses compose.yaml as source with 409 PROTECTED_FILE', async () => {
    const res = await request(app)
      .patch(`/api/stacks/${STACK}/files/rename`)
      .set('Cookie', adminCookie)
      .send({ from: 'compose.yaml', to: 'renamed-compose.yaml' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PROTECTED_FILE');
  });

  it('PATCH /files/rename refuses compose.yaml as destination with 409 PROTECTED_FILE', async () => {
    await fs.writeFile(path.join(stacksDir, STACK, 'pretend.yaml'), 'services: {}\n');
    const res = await request(app)
      .patch(`/api/stacks/${STACK}/files/rename`)
      .set('Cookie', adminCookie)
      .send({ from: 'pretend.yaml', to: 'compose.yaml' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PROTECTED_FILE');
    await fs.unlink(path.join(stacksDir, STACK, 'pretend.yaml'));
  });

  it('PUT /files/permissions refuses .env with 409 PROTECTED_FILE', async () => {
    const res = await request(app)
      .put(`/api/stacks/${STACK}/files/permissions`)
      .query({ path: '.env' })
      .set('Cookie', adminCookie)
      .send({ mode: 0o644 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PROTECTED_FILE');
  });

  it('DELETE /files still succeeds on a non-protected file', async () => {
    const target = path.join(stacksDir, STACK, 'disposable.txt');
    await fs.writeFile(target, 'temporary');
    const res = await request(app)
      .delete(`/api/stacks/${STACK}/files`)
      .query({ path: 'disposable.txt' })
      .set('Cookie', adminCookie);
    expect(res.status).toBe(204);
  });

  it('PUT /files/content still succeeds on compose.yaml (compose editor path)', async () => {
    const res = await request(app)
      .put(`/api/stacks/${STACK}/files/content`)
      .query({ path: 'compose.yaml' })
      .set('Cookie', adminCookie)
      .send({ content: 'services:\n  echo:\n    image: busybox\n' });
    expect(res.status).toBe(204);
  });

  it('POST /files/upload still succeeds when overwriting compose.yaml with overwrite=1 (legitimate replace)', async () => {
    // Combined semantics: same-name uploads need ?overwrite=1 to pass the
    // upload-confirm gate. The protected-file enforcement deliberately does
    // NOT block this path because replacing compose.yaml via upload is a
    // legitimate user-driven action.
    const replacement = 'services:\n  uploaded:\n    image: busybox\n';
    const res = await request(app)
      .post(`/api/stacks/${STACK}/files/upload`)
      .query({ overwrite: '1' })
      .set('Cookie', adminCookie)
      .attach('file', Buffer.from(replacement), 'compose.yaml');
    expect(res.status).toBe(204);
    const written = await fs.readFile(path.join(stacksDir, STACK, 'compose.yaml'), 'utf-8');
    expect(written).toContain('uploaded');
  });

  it('DELETE /files succeeds on a subdirectory file named compose.yaml (not the active compose file)', async () => {
    const subdir = path.join(stacksDir, STACK, 'backups');
    await fs.mkdir(subdir, { recursive: true });
    await fs.writeFile(path.join(subdir, 'compose.yaml'), 'services: {}\n');
    const res = await request(app)
      .delete(`/api/stacks/${STACK}/files`)
      .query({ path: 'backups/compose.yaml' })
      .set('Cookie', adminCookie);
    expect(res.status).toBe(204);
    await fs.rm(subdir, { recursive: true, force: true });
  });

  it('DELETE /files refuses compose.yaml even with a trailing slash', async () => {
    const res = await request(app)
      .delete(`/api/stacks/${STACK}/files`)
      .query({ path: 'compose.yaml/' })
      .set('Cookie', adminCookie);
    // Either the validator rejects the trailing slash (400) or the protected-file
    // guard catches the normalized basename (409). Both are acceptable; what is NOT
    // acceptable is a 204 success that silently deletes the protected file.
    expect([400, 409]).toContain(res.status);
    if (res.status === 409) expect(res.body.code).toBe('PROTECTED_FILE');
  });
});

// ── symlink semantics ────────────────────────────────────────────────────────
// Symlink creation requires admin/developer-mode on Windows; skip on that
// platform so the suite stays green where the OS denies the setup itself.

describe.skipIf(isWindows)('symlink semantics (Linux/macOS only)', () => {
  it('PUT /files/permissions returns 409 LINK_CHMOD_UNSUPPORTED on a symlink', async () => {
    const targetPath = path.join(stacksDir, STACK, 'symlink-target.txt');
    const linkPath = path.join(stacksDir, STACK, 'symlink-link.txt');
    await fs.writeFile(targetPath, 'payload');
    await fs.chmod(targetPath, 0o644);
    await fs.symlink(targetPath, linkPath);

    try {
      const res = await request(app)
        .put(`/api/stacks/${STACK}/files/permissions`)
        .query({ path: 'symlink-link.txt' })
        .set('Cookie', adminCookie)
        .send({ mode: 0o600 });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('LINK_CHMOD_UNSUPPORTED');

      const stat = await fs.stat(targetPath);
      expect(stat.mode & 0o777).toBe(0o644);
    } finally {
      await fs.unlink(linkPath).catch(() => {});
      await fs.unlink(targetPath).catch(() => {});
    }
  });

  it('DELETE /files removes a symlink and leaves the target intact', async () => {
    const targetPath = path.join(stacksDir, STACK, 'sym-delete-target.txt');
    const linkPath = path.join(stacksDir, STACK, 'sym-delete-link.txt');
    await fs.writeFile(targetPath, 'survives');
    await fs.symlink(targetPath, linkPath);

    try {
      const res = await request(app)
        .delete(`/api/stacks/${STACK}/files`)
        .query({ path: 'sym-delete-link.txt' })
        .set('Cookie', adminCookie);
      expect(res.status).toBe(204);

      await expect(fs.lstat(linkPath)).rejects.toMatchObject({ code: 'ENOENT' });
      const targetContent = await fs.readFile(targetPath, 'utf-8');
      expect(targetContent).toBe('survives');
    } finally {
      await fs.unlink(targetPath).catch(() => {});
    }
  });
});
