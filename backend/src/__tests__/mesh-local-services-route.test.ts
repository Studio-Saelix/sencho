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
import { execFileSync } from 'child_process';
import fsSync from 'fs';
import path from 'path';
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

/**
 * Contract tests for GET /api/mesh/local-declared-services/:stackName.
 *
 * Central releases a saved port claim only when the owning node reports that
 * the compose file no longer declares the service. An unreadable declaration
 * is not a service removal, so it has to answer non-2xx rather than an empty
 * list that would look like one.
 */
describe('GET /api/mesh/local-declared-services/:stackName', () => {
    const TWO_SERVICES = 'services:\n  db:\n    image: busybox:latest\n  web:\n    image: busybox:latest\n';
    const ONE_SERVICE = 'services:\n  web:\n    image: busybox:latest\n';

    async function writeComposeFile(stack: string, contents = TWO_SERVICES): Promise<void> {
        fsSync.mkdirSync(path.join(process.env.COMPOSE_DIR as string, stack), { recursive: true });
        // The declaration reader only trusts a layer Sencho published whole,
        // so a completed save goes through the atomic publisher.
        const { FileSystemService } = await import('../services/FileSystemService');
        await FileSystemService.getInstance().writeStackFile(stack, 'compose.yaml', contents);
    }

    it('answers 200 with the declared service names', async () => {
        await writeComposeFile('declared-stack');

        const res = await request(app)
            .get('/api/mesh/local-declared-services/declared-stack')
            .set('Authorization', `Bearer ${adminToken()}`);

        expect(res.status).toBe(200);
        expect((res.body.declared as string[]).sort()).toEqual(['db', 'web']);
    });

    it('answers 503 when the compose declaration cannot be read', async () => {
        const res = await request(app)
            .get('/api/mesh/local-declared-services/no-such-stack')
            .set('Authorization', `Bearer ${adminToken()}`);

        expect(res.status).toBe(503);
        expect(res.body.error).toMatch(/declaration is unreadable/i);
    });

    it('answers 503 for a compose file Sencho did not publish whole', async () => {
        // A file written in place by another process may be the prefix of a
        // save that has paused, however long ago it was last touched.
        const stack = 'external-declared-stack';
        const dir = path.join(process.env.COMPOSE_DIR as string, stack);
        fsSync.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'compose.yaml');
        fsSync.writeFileSync(file, ONE_SERVICE, 'utf8');
        const past = new Date(Date.now() - 600_000);
        fsSync.utimesSync(file, past, past);

        const res = await request(app)
            .get(`/api/mesh/local-declared-services/${stack}`)
            .set('Authorization', `Bearer ${adminToken()}`);

        expect(res.status).toBe(503);
        expect(res.body.error).toMatch(/declaration is unreadable/i);
    });

    it('answers 503 when services is not a service mapping', async () => {
        // An editor can save invalid content. Returning 200 with the array
        // indexes would let central treat "0" as a service name and release a
        // real reservation, so the route reports unknown instead.
        await writeComposeFile('invalid-declared-stack', 'services:\n  - web\n');

        const res = await request(app)
            .get('/api/mesh/local-declared-services/invalid-declared-stack')
            .set('Authorization', `Bearer ${adminToken()}`);

        expect(res.status).toBe(503);
        expect(res.body.error).toMatch(/declaration is unreadable/i);
    });

    it('answers 503 when a discovered override links outside the compose root', async () => {
        // The same link is refused by the canonical compose read guard. Reading
        // its service names as a declaration would release claims from a file
        // the compose root does not own.
        const stack = 'outside-link-declared-stack';
        await writeComposeFile(stack, ONE_SERVICE);
        const dir = path.join(process.env.COMPOSE_DIR as string, stack);
        const tmpDir = path.dirname(process.env.COMPOSE_DIR as string);
        const outside = path.join(tmpDir, 'outside-declaration');
        fsSync.mkdirSync(outside, { recursive: true });
        const outsideOverride = path.join(outside, 'compose.override.yml');
        fsSync.writeFileSync(outsideOverride, 'services:\n  other:\n    image: busybox:latest\n', 'utf8');
        fsSync.symlinkSync(outsideOverride, path.join(dir, 'compose.override.yml'));

        const res = await request(app)
            .get(`/api/mesh/local-declared-services/${stack}`)
            .set('Authorization', `Bearer ${adminToken()}`);

        expect(res.status).toBe(503);
        expect(res.body.error).toMatch(/declaration is unreadable/i);
    });

    it.skipIf(process.platform === 'win32')('answers 503 for a special file instead of blocking', async () => {
        const stack = 'fifo-declared-stack';
        await writeComposeFile(stack, ONE_SERVICE);
        const dir = path.join(process.env.COMPOSE_DIR as string, stack);
        execFileSync('mkfifo', [path.join(dir, 'compose.override.yml')]);

        const deadline = new Promise<'timeout'>((resolve) => {
            setTimeout(() => resolve('timeout'), 3_000).unref();
        });
        const answered = request(app)
            .get(`/api/mesh/local-declared-services/${stack}`)
            .set('Authorization', `Bearer ${adminToken()}`)
            .then((res) => res.status);

        await expect(Promise.race([answered, deadline])).resolves.not.toBe('timeout');
        expect(await answered).toBe(503);
    });
});
