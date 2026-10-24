/**
 * Contract tests for GET /api/mesh/local-services/:stackName.
 *
 * Central calls this route on a peer and treats a non-2xx answer as "could
 * not inspect", which makes it replay that stack's saved snapshot. A failed
 * Docker inspection used to answer 200 with an empty list, indistinguishable
 * from a successfully inspected stopped stack, so these tests pin the two
 * answers apart at the route boundary.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_JWT_SECRET, TEST_USERNAME } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let LicenseService: typeof import('../services/LicenseService').LicenseService;

function adminToken(): string {
    const user = DatabaseService.getInstance().getUserByUsername(TEST_USERNAME);
    if (!user) throw new Error(`missing test user ${TEST_USERNAME}`);
    return jwt.sign(
        { username: TEST_USERNAME, role: user.role, tv: user.token_version },
        TEST_JWT_SECRET,
        { expiresIn: '5m' },
    );
}

async function withLocalDocker(listContainers: () => Promise<unknown[]>): Promise<void> {
    const { default: DockerController } = await import('../services/DockerController');
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
        getDocker: () => ({ listContainers }),
    } as unknown as ReturnType<typeof DockerController.getInstance>);
}

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ LicenseService } = await import('../services/LicenseService'));
    ({ app } = await import('../index'));
});

beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
});

afterAll(() => {
    vi.restoreAllMocks();
    cleanupTestDb(tmpDir);
});

describe('GET /api/mesh/local-services/:stackName', () => {
    it('answers 503 when the local Docker inspection fails', async () => {
        await withLocalDocker(() => Promise.reject(new Error('docker socket unavailable')));
        vi.spyOn(console, 'warn').mockImplementation(() => { /* silence the inspection warn */ });

        const res = await request(app)
            .get('/api/mesh/local-services/stopped-stack')
            .set('Authorization', `Bearer ${adminToken()}`);

        expect(res.status).toBe(503);
        expect(res.body.error).toMatch(/inspection failed/i);
    });

    it('answers 200 with the stopped service list when Docker answers', async () => {
        await withLocalDocker(async () => [{
            State: 'exited',
            Labels: { 'com.docker.compose.service': 'db' },
            Ports: [],
        }]);

        const res = await request(app)
            .get('/api/mesh/local-services/stopped-stack')
            .set('Authorization', `Bearer ${adminToken()}`);

        expect(res.status).toBe(200);
        expect(res.body.services).toEqual([{ service: 'db', ports: [], running: false }]);
    });
});
