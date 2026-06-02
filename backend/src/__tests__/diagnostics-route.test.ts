/**
 * Route-level tests for GET /api/diagnostics: auth required, admin-only,
 * response shape, and no secret leakage in the payload.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let adminAuthHeader: string;
let viewerAuthHeader: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ app } = await import('../index'));
    ({ DatabaseService } = await import('../services/DatabaseService'));

    adminAuthHeader = `Bearer ${jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' })}`;

    const viewerHash = await bcrypt.hash('viewerpass', 1);
    DatabaseService.getInstance().addUser({ username: 'diag-viewer', password_hash: viewerHash, role: 'viewer' });
    viewerAuthHeader = `Bearer ${jwt.sign({ username: 'diag-viewer' }, TEST_JWT_SECRET, { expiresIn: '1m' })}`;
});

afterAll(() => {
    cleanupTestDb(tmpDir);
});

describe('GET /api/diagnostics', () => {
    it('requires authentication', async () => {
        const res = await request(app).get('/api/diagnostics');
        expect(res.status).toBe(401);
    });

    it('rejects a non-admin', async () => {
        const res = await request(app).get('/api/diagnostics').set('Authorization', viewerAuthHeader);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ADMIN_REQUIRED');
    });

    it('returns the diagnostics report for an admin', async () => {
        const res = await request(app).get('/api/diagnostics').set('Authorization', adminAuthHeader);
        expect(res.status).toBe(200);
        expect(res.body.database).toBeDefined();
        expect(res.body.encryptionKey).toBeDefined();
        expect(res.body.docker).toBeDefined();
        expect(res.body.auth.adminCount).toBeGreaterThanOrEqual(1);
        expect(Array.isArray(res.body.auth.ssoProviders)).toBe(true);
    });

    it('does not leak secret settings in the payload', async () => {
        // Use a non-auth secret so overwriting it cannot break token verification
        // (auth_jwt_secret is what the admin token is signed against).
        DatabaseService.getInstance().updateGlobalSetting('cloud_backup_secret_key', 'route-secret-value');
        const res = await request(app).get('/api/diagnostics').set('Authorization', adminAuthHeader);
        expect(res.status).toBe(200);
        const serialized = JSON.stringify(res.body);
        expect(serialized).not.toContain('route-secret-value');
        expect(res.body.config.cloud_backup_secret_key).toBeUndefined();
    });
});
