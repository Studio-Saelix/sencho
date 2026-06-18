import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';
import { MAX_BLUEPRINT_COMPOSE_BYTES } from '../routes/blueprints';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let LicenseService: typeof import('../services/LicenseService').LicenseService;
let StackOpLockService: typeof import('../services/StackOpLockService').StackOpLockService;
let adminCookie: string;
let counter = 0;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ LicenseService } = await import('../services/LicenseService'));
    ({ StackOpLockService } = await import('../services/StackOpLockService'));

    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');

    ({ app } = await import('../index'));
    adminCookie = await loginAsTestAdmin(app);
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
    StackOpLockService.resetForTests();
    const db = DatabaseService.getInstance().getDb();
    db.prepare('DELETE FROM blueprint_deployments').run();
    db.prepare('DELETE FROM blueprints').run();
});

function validCreateBody(composeContent: string) {
    counter += 1;
    return {
        name: `route-validate-${counter}`,
        description: null,
        compose_content: composeContent,
        selector: { type: 'nodes', ids: [1] },
        drift_mode: 'suggest',
        enabled: true,
    };
}

describe('Blueprint route compose validation', () => {
    it('rejects invalid compose YAML on create', async () => {
        const res = await request(app)
            .post('/api/blueprints')
            .set('Cookie', adminCookie)
            .send(validCreateBody('services:\n  bad: : nope:'));

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('compose_content must be valid YAML');
        expect(DatabaseService.getInstance().listBlueprints()).toHaveLength(0);
    });

    it('rejects oversized compose content on create', async () => {
        const oversized = `services:\n  app:\n    image: nginx\n    labels:\n      filler: "${'x'.repeat(MAX_BLUEPRINT_COMPOSE_BYTES)}"\n`;

        const res = await request(app)
            .post('/api/blueprints')
            .set('Cookie', adminCookie)
            .send(validCreateBody(oversized));

        expect(res.status).toBe(400);
        expect(res.body.error).toContain(`${MAX_BLUEPRINT_COMPOSE_BYTES} bytes or fewer`);
        expect(DatabaseService.getInstance().listBlueprints()).toHaveLength(0);
    });

    it('rejects oversized compose content on analyze', async () => {
        const oversized = `services:\n  app:\n    image: nginx\n    labels:\n      filler: "${'x'.repeat(MAX_BLUEPRINT_COMPOSE_BYTES)}"\n`;

        const res = await request(app)
            .post('/api/blueprints/analyze')
            .set('Cookie', adminCookie)
            .send({ compose_content: oversized });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain(`${MAX_BLUEPRINT_COMPOSE_BYTES} bytes or fewer`);
    });
});

describe('POST /api/blueprints/apply-local (node-to-node atomic apply)', () => {
    it('rejects an invalid stack name', async () => {
        const res = await request(app)
            .post('/api/blueprints/apply-local')
            .set('Cookie', adminCookie)
            .send({ stackName: '../escape', composeContent: 'services: {}', markerContent: '{}' });
        expect(res.status).toBe(400);
        expect(res.body.error).toContain('Invalid stack name');
    });

    it('rejects a missing compose/marker payload', async () => {
        const res = await request(app)
            .post('/api/blueprints/apply-local')
            .set('Cookie', adminCookie)
            .send({ stackName: 'apply-local-stack' });
        expect(res.status).toBe(400);
    });

    it('rejects a structurally invalid marker', async () => {
        const res = await request(app)
            .post('/api/blueprints/apply-local')
            .set('Cookie', adminCookie)
            .send({ stackName: 'apply-local-stack', composeContent: 'services:\n  app:\n    image: nginx\n', markerContent: '{}' });
        expect(res.status).toBe(400);
        expect(res.body.error).toContain('marker');
    });

    it('returns 409 without deploying when the per-stack lock is held', async () => {
        // The local node (id 1) holds the lock for this stack; the apply must be
        // rejected before it can create or write any files.
        StackOpLockService.getInstance().tryAcquire(1, 'apply-local-busy', 'update', 'admin');
        const res = await request(app)
            .post('/api/blueprints/apply-local')
            .set('Cookie', adminCookie)
            .send({
                stackName: 'apply-local-busy',
                composeContent: 'services:\n  app:\n    image: nginx\n',
                markerContent: JSON.stringify({ blueprintId: 1, revision: 1, lastApplied: 123 }),
            });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('stack_op_in_progress');
        // The manual op still owns the lock; the apply never acquired it.
        expect(StackOpLockService.getInstance().get(1, 'apply-local-busy')?.action).toBe('update');
    });
});
