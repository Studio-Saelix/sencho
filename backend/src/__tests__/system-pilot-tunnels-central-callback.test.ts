/**
 * Tests for the `centralCallback` diag block returned by
 * GET /api/system/pilot-tunnels. The block reads from MeshCentralRegistry
 * (cached central material + last-used/last-rejected timestamps) and from
 * PeerToCentralMeshSessionDialer (live bridge presence). Counters for the
 * peer-callback path live in PilotMetrics and are exposed via the existing
 * `counters` field of the same response, so this block only adds the
 * cached-row diagnostics that PilotMetrics does not track.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';
import { MeshCentralRegistry } from '../services/MeshCentralRegistry';
import { PeerToCentralMeshSessionDialer } from '../services/PeerToCentralMeshSessionDialer';
import { DatabaseService } from '../services/DatabaseService';

let tmpDir: string;
let app: Express;
let cookie: string;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ app } = await import('../index'));
    cookie = await loginAsTestAdmin(app);
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
    MeshCentralRegistry.resetForTest();
    PeerToCentralMeshSessionDialer.resetForTest();
    DatabaseService.getInstance().getDb().prepare('DELETE FROM mesh_centrals').run();
});

describe('/api/system/pilot-tunnels centralCallback diag', () => {
    it('returns null centralCallback fields when no central material is cached', async () => {
        const res = await request(app).get('/api/system/pilot-tunnels').set('Cookie', cookie);
        expect(res.status).toBe(200);
        expect(res.body.centralCallback).toEqual({
            bridgeOpen: false,
            lastBootstrapAt: null,
            lastDialOkAt: null,
            lastDialFailAt: null,
            lastDialFailReason: null,
        });
    });

    it('returns populated centralCallback fields when material is present', async () => {
        MeshCentralRegistry.getInstance().upsert({
            centralInstanceId: 'inst-1',
            centralApiUrl: 'https://central.example.com',
            callbackJwt: 'jwt-value',
            jwtIssuedAt: 1,
            jwtExpiresAt: 9999999999,
        });
        MeshCentralRegistry.getInstance().markUsed('inst-1');

        const res = await request(app).get('/api/system/pilot-tunnels').set('Cookie', cookie);
        expect(res.status).toBe(200);
        expect(res.body.centralCallback.bridgeOpen).toBe(false);
        expect(res.body.centralCallback.lastBootstrapAt).toBeGreaterThan(0);
        expect(res.body.centralCallback.lastDialOkAt).toBeGreaterThan(0);
        expect(res.body.centralCallback.lastDialFailAt).toBeNull();
        expect(res.body.centralCallback.lastDialFailReason).toBeNull();
    });

    it('surfaces last reject reason when central marks a dial failed', async () => {
        MeshCentralRegistry.getInstance().upsert({
            centralInstanceId: 'inst-2',
            centralApiUrl: 'https://central.example.com',
            callbackJwt: 'jwt-value',
            jwtIssuedAt: 1,
            jwtExpiresAt: 9999999999,
        });
        MeshCentralRegistry.getInstance().markRejected('inst-2', 'signature_invalid');

        const res = await request(app).get('/api/system/pilot-tunnels').set('Cookie', cookie);
        expect(res.status).toBe(200);
        expect(res.body.centralCallback.lastDialFailAt).toBeGreaterThan(0);
        expect(res.body.centralCallback.lastDialFailReason).toBe('signature_invalid');
    });
});
