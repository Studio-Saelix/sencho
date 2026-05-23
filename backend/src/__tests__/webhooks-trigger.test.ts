import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let LicenseService: typeof import('../services/LicenseService').LicenseService;
let WebhookService: typeof import('../services/WebhookService').WebhookService;

function adminToken(): string {
    return jwt.sign({ username: TEST_USERNAME, role: 'admin' }, TEST_JWT_SECRET, { expiresIn: '1m' });
}

function sign(rawBody: string, secret: string): string {
    return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

interface WebhookFixture {
    id: number;
    secret: string;
}

function createWebhook(opts: { action?: string; enabled?: boolean; name?: string; stack?: string } = {}): WebhookFixture {
    const db = DatabaseService.getInstance();
    const nodeId = db.getDefaultNode()!.id!;
    const secret = WebhookService.getInstance().generateSecret();
    const id = db.addWebhook({
        node_id: nodeId,
        name: opts.name ?? 'trigger-test',
        stack_name: opts.stack ?? 'missing-stack',
        action: (opts.action ?? 'restart') as never,
        secret,
        enabled: opts.enabled ?? true,
    });
    return { id, secret };
}

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ app } = await import('../index'));
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ LicenseService } = await import('../services/LicenseService'));
    ({ WebhookService } = await import('../services/WebhookService'));
});

afterAll(() => {
    cleanupTestDb(tmpDir);
});

beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
    vi.spyOn(LicenseService.getInstance(), 'getVariant').mockReturnValue('skipper');
});

describe('POST /api/webhooks/:id/trigger: uniform unauthenticated 404 (M1, H3)', () => {
    const expected = { error: 'Webhook not found or signature invalid' };

    it('returns 404 when the webhook id is unknown', async () => {
        const body = '{}';
        const res = await request(app)
            .post('/api/webhooks/9999999/trigger')
            .set('Content-Type', 'application/json')
            .set('X-Webhook-Signature', sign(body, 'whatever'))
            .send(body);

        expect(res.status).toBe(404);
        expect(res.body).toEqual(expected);
    });

    it('returns the same 404 when the webhook exists but is disabled', async () => {
        const { id, secret } = createWebhook({ enabled: false });
        const body = '{}';

        const res = await request(app)
            .post(`/api/webhooks/${id}/trigger`)
            .set('Content-Type', 'application/json')
            .set('X-Webhook-Signature', sign(body, secret))
            .send(body);

        expect(res.status).toBe(404);
        expect(res.body).toEqual(expected);
    });

    it('returns the same 404 when the licence tier is not paid', async () => {
        const { id, secret } = createWebhook();
        vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
        const body = '{}';

        const res = await request(app)
            .post(`/api/webhooks/${id}/trigger`)
            .set('Content-Type', 'application/json')
            .set('X-Webhook-Signature', sign(body, secret))
            .send(body);

        expect(res.status).toBe(404);
        expect(res.body).toEqual(expected);
        // The forbidden code from the prior surface must not leak.
        expect(res.body.code).toBeUndefined();
    });

    it('returns the same 404 when the X-Webhook-Signature header is missing', async () => {
        const { id } = createWebhook();
        const body = '{}';

        const res = await request(app)
            .post(`/api/webhooks/${id}/trigger`)
            .set('Content-Type', 'application/json')
            .send(body);

        expect(res.status).toBe(404);
        expect(res.body).toEqual(expected);
    });

    it('returns the same 404 when the request has no body (H3 fail-closed)', async () => {
        const { id, secret } = createWebhook();

        const res = await request(app)
            .post(`/api/webhooks/${id}/trigger`)
            // No Content-Type → express.json() does not run verify, so
            // req.rawBody is never populated. The handler must fail closed
            // instead of re-stringifying req.body to compute the HMAC.
            .set('X-Webhook-Signature', sign('', secret));

        expect(res.status).toBe(404);
        expect(res.body).toEqual(expected);
    });

    it('returns the same 404 for a signature with the wrong prefix', async () => {
        const { id, secret } = createWebhook();
        const body = '{}';
        const hex = crypto.createHmac('sha256', secret).update(body).digest('hex');

        const res = await request(app)
            .post(`/api/webhooks/${id}/trigger`)
            .set('Content-Type', 'application/json')
            .set('X-Webhook-Signature', `sha1=${hex}`)
            .send(body);

        expect(res.status).toBe(404);
        expect(res.body).toEqual(expected);
    });

    it('returns the same 404 for a malformed hex signature', async () => {
        const { id } = createWebhook();
        const body = '{}';

        const res = await request(app)
            .post(`/api/webhooks/${id}/trigger`)
            .set('Content-Type', 'application/json')
            .set('X-Webhook-Signature', 'sha256=notavalidhex-zzzz')
            .send(body);

        expect(res.status).toBe(404);
        expect(res.body).toEqual(expected);
    });

    it('returns the same 404 when the signature does not match the body', async () => {
        const { id } = createWebhook();
        const body = '{"foo":"bar"}';
        const wrongSig = sign(body, 'wrong-secret-of-equal-length-as-the-real-one-1234');

        const res = await request(app)
            .post(`/api/webhooks/${id}/trigger`)
            .set('Content-Type', 'application/json')
            .set('X-Webhook-Signature', wrongSig)
            .send(body);

        expect(res.status).toBe(404);
        expect(res.body).toEqual(expected);
    });
});

describe('POST /api/webhooks/:id/trigger: authenticated happy path', () => {
    it('returns 202 and echoes the configured action', async () => {
        const { id, secret } = createWebhook({ action: 'stop' });
        const body = '{}';

        const res = await request(app)
            .post(`/api/webhooks/${id}/trigger`)
            .set('Content-Type', 'application/json')
            .set('X-Webhook-Signature', sign(body, secret))
            .send(body);

        expect(res.status).toBe(202);
        expect(res.body).toMatchObject({ message: 'Webhook accepted', action: 'stop' });
    });

    it('accepts a valid action override and echoes it', async () => {
        const { id, secret } = createWebhook({ action: 'restart' });
        const body = '{"action":"start"}';

        const res = await request(app)
            .post(`/api/webhooks/${id}/trigger`)
            .set('Content-Type', 'application/json')
            .set('X-Webhook-Signature', sign(body, secret))
            .send(body);

        expect(res.status).toBe(202);
        expect(res.body).toMatchObject({ action: 'start' });
    });

    it('rejects an unknown action override with 400 after the signature passes (L2)', async () => {
        const { id, secret } = createWebhook();
        const body = '{"action":"nuke-the-cluster"}';

        const res = await request(app)
            .post(`/api/webhooks/${id}/trigger`)
            .set('Content-Type', 'application/json')
            .set('X-Webhook-Signature', sign(body, secret))
            .send(body);

        // Auth succeeded, so the caller learns the action was rejected.
        // Pre-auth callers would still get the uniform 404 instead.
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/action must be one of/);
    });

    it('rejects a non-string action override with 400', async () => {
        const { id, secret } = createWebhook();
        const body = '{"action":42}';

        const res = await request(app)
            .post(`/api/webhooks/${id}/trigger`)
            .set('Content-Type', 'application/json')
            .set('X-Webhook-Signature', sign(body, secret))
            .send(body);

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/action must be one of/);
    });
});

describe('POST /api/webhooks: name length cap (L1)', () => {
    it('rejects a name longer than 100 characters', async () => {
        const res = await request(app)
            .post('/api/webhooks')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({
                name: 'a'.repeat(101),
                stack_name: 'irrelevant-stack',
                action: 'restart',
            });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/100 characters or fewer/);
    });

    it('rejects a non-string name', async () => {
        const res = await request(app)
            .post('/api/webhooks')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({
                name: { obj: 'not-a-string' },
                stack_name: 'irrelevant-stack',
                action: 'restart',
            });

        expect(res.status).toBe(400);
        // 'name, stack_name, and action are required' catches this when name is
        // truthy-but-not-a-string before the length check; either error message
        // is acceptable for non-string input.
        expect(res.body.error).toBeTruthy();
    });

    it('accepts a name at the 100-character boundary', async () => {
        const res = await request(app)
            .post('/api/webhooks')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({
                name: 'a'.repeat(100),
                stack_name: 'boundary-stack',
                action: 'restart',
            });

        expect(res.status).toBe(201);
        expect(typeof res.body.secret).toBe('string');
    });
});

describe('PUT /api/webhooks/:id: name length cap (L1)', () => {
    it('rejects updating name to over 100 characters', async () => {
        const { id } = createWebhook();
        const res = await request(app)
            .put(`/api/webhooks/${id}`)
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({ name: 'b'.repeat(101) });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/100 characters or fewer/);
    });

    it('allows partial updates that omit name', async () => {
        const { id } = createWebhook({ enabled: true });
        const res = await request(app)
            .put(`/api/webhooks/${id}`)
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({ enabled: false });

        expect(res.status).toBe(200);
        expect(DatabaseService.getInstance().getWebhook(id)?.enabled).toBe(false);
    });
});

describe('WebhookService.execute: delete-during-execution race (M5)', () => {
    it('does not crash when the parent webhook is deleted before recordExecution runs', async () => {
        // The webhook targets a stack that does not exist on disk, so
        // executeLocal fails fast at the FileSystemService.getStacks() check
        // and tries to write a failure row to webhook_executions. By the time
        // that insert fires the parent row is gone, so the FK CASCADE makes
        // the insert fail. The fix is for recordExecution to swallow that
        // error with a console.warn instead of crashing the async dispatch.
        const { id } = createWebhook({ action: 'restart', stack: 'definitely-not-on-disk' });
        const webhook = DatabaseService.getInstance().getWebhook(id)!;

        // Mid-flight delete.
        DatabaseService.getInstance().deleteWebhook(id);

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        await expect(
            WebhookService.getInstance().execute(webhook, 'restart', 'test', true),
        ).resolves.toMatchObject({ success: false });

        // recordExecution caught the FK error and logged a single warning.
        const calls = warnSpy.mock.calls.map(args => args.join(' '));
        expect(calls.some(line => line.includes(`webhook ${id}`))).toBe(true);
    });

    it('records the execution row when the webhook persists through execution', async () => {
        const { id } = createWebhook({ action: 'restart', stack: 'definitely-not-on-disk' });
        const webhook = DatabaseService.getInstance().getWebhook(id)!;

        const result = await WebhookService.getInstance().execute(webhook, 'restart', 'test', true);
        expect(result.success).toBe(false);
        // Filter by webhook_id rather than asserting toHaveLength on the
        // entire history: getWebhookExecutions already scopes to this row's
        // id, but tests in this file share a baseline DB and an earlier
        // run could re-use an id range. Read it positionally instead.
        const history = DatabaseService.getInstance().getWebhookExecutions(id);
        expect(history.length).toBeGreaterThanOrEqual(1);
        expect(history[0].status).toBe('failure');
        expect(history[0].error).toMatch(/not found/i);
    });
});

describe('webhook_executions.error redaction (M6)', () => {
    // Both tests force executeLocal's switch-statement try/catch path so the
    // raw upstream error flows through getErrorMessage -> recordExecution ->
    // redactSensitiveText. FileSystemService.getStacks is stubbed to claim the
    // stack exists, and ComposeService.runCommand is stubbed to throw the
    // sensitive content. Spies attach to the prototypes because both
    // singletons hand out fresh instances per nodeId.
    it('strips bearer tokens before persisting the execution error', async () => {
        const stack = 'redact-stack-bearer';
        const { id } = createWebhook({ action: 'restart', stack });
        const webhook = DatabaseService.getInstance().getWebhook(id)!;

        const fs = await import('../services/FileSystemService');
        const compose = await import('../services/ComposeService');
        vi.spyOn(fs.FileSystemService.prototype, 'getStacks').mockResolvedValue([stack]);
        vi.spyOn(compose.ComposeService.prototype, 'runCommand').mockRejectedValue(
            new Error('upstream rejected: Authorization: Bearer abcdef1234567890tokenvalue'),
        );

        const result = await WebhookService.getInstance().execute(webhook, 'restart', 'test', true);
        expect(result.success).toBe(false);

        const history = DatabaseService.getInstance().getWebhookExecutions(id);
        expect(history[0].error).toBeTruthy();
        expect(history[0].error).not.toContain('abcdef1234567890tokenvalue');
        expect(history[0].error).toContain('[redacted]');
    });

    it('strips homedir paths before persisting the execution error', async () => {
        const stack = 'redact-stack-home';
        const { id } = createWebhook({ action: 'restart', stack });
        const webhook = DatabaseService.getInstance().getWebhook(id)!;

        const fs = await import('../services/FileSystemService');
        const compose = await import('../services/ComposeService');
        vi.spyOn(fs.FileSystemService.prototype, 'getStacks').mockResolvedValue([stack]);
        vi.spyOn(compose.ComposeService.prototype, 'runCommand').mockRejectedValue(
            new Error('compose error reading /home/user-redact-target/docker/compose.yaml'),
        );

        const result = await WebhookService.getInstance().execute(webhook, 'restart', 'test', true);
        expect(result.success).toBe(false);

        const history = DatabaseService.getInstance().getWebhookExecutions(id);
        expect(history[0].error).toBeTruthy();
        expect(history[0].error).not.toContain('user-redact-target');
        expect(history[0].error).toContain('/home/<user>');
    });
});
