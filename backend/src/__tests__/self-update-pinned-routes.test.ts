/**
 * Route coverage for pinned-compose self-update: targetVersion validation,
 * synchronous preflight (409 before 202), and the safe public /api/meta pin
 * subset (imagePinKind + updateBlocked, never composeImageRef).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { buildTargetImageRef } from '../helpers/selfUpdateCompose';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let adminAuth: string;
let localNodeId: number;
let SelfUpdateService: typeof import('../services/SelfUpdateService').default;
let FleetUpdateTrackerService: typeof import('../services/FleetUpdateTrackerService').FleetUpdateTrackerService;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

function mockSelfUpdateAvailable(over: {
  pinInfo?: { pinKind: 'semver' | 'floating' | 'digest' | 'unknown'; composeImageRef: string; filePath: string } | null;
  preflight?: { ok: true } | { ok: false; reason: string };
  available?: boolean;
} = {}) {
  const svc = SelfUpdateService.getInstance();
  vi.spyOn(svc, 'isAvailable').mockReturnValue(over.available ?? true);
  vi.spyOn(svc, 'getPinInfo').mockResolvedValue(over.pinInfo ?? null);
  vi.spyOn(svc, 'canSelfUpdateTarget').mockResolvedValue(over.preflight ?? { ok: true });
  vi.spyOn(svc, 'triggerUpdate').mockResolvedValue(undefined);
  vi.spyOn(svc, 'getLastError').mockReturnValue(null);
}

function mockCompareTargetFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify({ tag_name: 'v0.99.0' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  SelfUpdateService = (await import('../services/SelfUpdateService')).default;
  ({ FleetUpdateTrackerService } = await import('../services/FleetUpdateTrackerService'));
  ({ DatabaseService } = await import('../services/DatabaseService'));

  localNodeId = DatabaseService.getInstance().getNodes().find(n => n.type === 'local')!.id;
  adminAuth = `Bearer ${jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' })}`;
});

afterAll(() => cleanupTestDb(tmpDir));

afterEach(() => {
  vi.restoreAllMocks();
  const tracker = FleetUpdateTrackerService.getInstance();
  for (const [id] of tracker.entries()) tracker.delete(id);
});

describe('POST /api/system/update', () => {
  it('rejects hardened updates from node-proxy credentials', async () => {
    mockSelfUpdateAvailable({
      pinInfo: {
        pinKind: 'digest',
        composeImageRef: 'ghcr.io/studio-saelix/sencho-hardened@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        filePath: '/opt/sencho/docker-compose.yml',
      },
    });
    const machineAuth = `Bearer ${jwt.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' })}`;

    const res = await request(app)
      .post('/api/system/update')
      .set('Authorization', machineAuth);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('HARDENED_REMOTE_UPDATE_UNSUPPORTED');
  });

  it('returns 400 for a supplied but invalid targetVersion', async () => {
    mockSelfUpdateAvailable();

    const res = await request(app)
      .post('/api/system/update')
      .set('Authorization', adminAuth)
      .send({ targetVersion: 'not-a-version' });

    expect(res.status).toBe(400);
    expect(res.body?.error).toMatch(/invalid target version/i);
  });

  it('returns 409 when preflight blocks a digest or unknown pin', async () => {
    mockSelfUpdateAvailable({
      preflight: { ok: false, reason: 'Cannot repin digest pin.' },
    });

    const res = await request(app)
      .post('/api/system/update')
      .set('Authorization', adminAuth)
      .send({ targetVersion: '0.99.0' });

    expect(res.status).toBe(409);
    expect(res.body?.code).toBe('update_blocked');
    expect(res.body?.error).toMatch(/cannot repin/i);
  });

  it('returns 202 and schedules the update when preflight passes', async () => {
    const triggerSpy = vi.spyOn(SelfUpdateService.getInstance(), 'triggerUpdate').mockResolvedValue(undefined);
    mockSelfUpdateAvailable({ preflight: { ok: true } });

    const res = await request(app)
      .post('/api/system/update')
      .set('Authorization', adminAuth)
      .send({ targetVersion: '0.99.0' });

    expect(res.status).toBe(202);
    expect(res.body?.message).toMatch(/restart/i);
    // The route schedules triggerUpdate 500ms after responding, so poll for it.
    await vi.waitFor(() => {
      expect(triggerSpy).toHaveBeenCalledWith(expect.objectContaining({
        targetVersion: '0.99.0',
        successMarkerFile: expect.stringMatching(/image-op-success-[\w-]+\.json$/),
        successMarkerContent: expect.stringMatching(/"operationId":"[\w-]+"/),
      }));
    }, { timeout: 5_000 });
  });
});

describe('GET /api/meta pin subset', () => {
  it('does not expose a raw update error with a private image reference', async () => {
    mockSelfUpdateAvailable();
    vi.spyOn(SelfUpdateService.getInstance(), 'getLastError')
      .mockReturnValue('pull private.registry.example/internal/sencho:1.0 failed');

    const res = await request(app).get('/api/meta');

    expect(res.body.updateError).toBe('update_failed');
    expect(JSON.stringify(res.body)).not.toContain('private.registry.example');
  });

  it('exposes imagePinKind, updateBlocked, and imageChannel but never composeImageRef', async () => {
    mockSelfUpdateAvailable({
      pinInfo: { pinKind: 'semver', composeImageRef: 'saelix/sencho:0.93.3', filePath: '/opt/sencho/docker-compose.yml' },
    });

    const res = await request(app).get('/api/meta');

    expect(res.status).toBe(200);
    expect(res.body.imagePinKind).toBe('semver');
    expect(res.body.updateBlocked).toBe(false);
    expect(res.body.imageChannel).toBe('community');
    expect(res.body).not.toHaveProperty('composeImageRef');
    expect(res.body).not.toHaveProperty('targetImageRef');
  });

  it('reports updateBlocked=true for a digest pin', async () => {
    mockSelfUpdateAvailable({
      pinInfo: { pinKind: 'digest', composeImageRef: 'ghcr.io/studio-saelix/sencho-hardened@sha256:abc', filePath: '/opt/sencho/docker-compose.yml' },
    });

    const res = await request(app).get('/api/meta');

    expect(res.body.imagePinKind).toBe('digest');
    expect(res.body.updateBlocked).toBe(true);
    expect(res.body.imageChannel).toBe('hardened');
  });
});

describe('POST /api/fleet/nodes/:nodeId/update (local preflight)', () => {
  it('returns 409 before 202 when the local pin cannot be repinned', async () => {
    mockCompareTargetFetch();
    mockSelfUpdateAvailable({
      preflight: { ok: false, reason: 'Blocked by digest pin.' },
    });

    const res = await request(app)
      .post(`/api/fleet/nodes/${localNodeId}/update`)
      .set('Authorization', adminAuth)
      .send({ targetVersion: '0.99.0' });

    expect(res.status).toBe(409);
    expect(res.body?.code).toBe('update_blocked');
  });
});

describe('GET /api/fleet/update-status pin projection', () => {
  it('includes compose pin fields for the local node on the authenticated route', async () => {
    mockCompareTargetFetch();
    mockSelfUpdateAvailable({
      pinInfo: { pinKind: 'semver', composeImageRef: 'saelix/sencho:0.83.0', filePath: '/opt/sencho/docker-compose.yml' },
    });

    const res = await request(app)
      .get('/api/fleet/update-status')
      .set('Authorization', adminAuth);

    expect(res.status).toBe(200);
    const local = res.body.nodes.find((n: { nodeId: number }) => n.nodeId === localNodeId);
    expect(local.imagePinKind).toBe('semver');
    expect(local.composeImageRef).toBe('saelix/sencho:0.83.0');
    expect(local.targetImageRef).toBe(buildTargetImageRef(local.composeImageRef, local.latestVersion));
    expect(local.updateBlocked).toBe(false);
  });

  it('marks the local node updateBlocked when the pin is unknown', async () => {
    mockCompareTargetFetch();
    mockSelfUpdateAvailable({
      pinInfo: { pinKind: 'unknown', composeImageRef: 'saelix/sencho:${TAG}', filePath: '/opt/sencho/docker-compose.yml' },
    });

    const res = await request(app)
      .get('/api/fleet/update-status')
      .set('Authorization', adminAuth);

    const local = res.body.nodes.find((n: { nodeId: number }) => n.nodeId === localNodeId);
    expect(local.updateBlocked).toBe(true);
    expect(local.updateBlockedReason).toMatch(/cannot update automatically/i);
  });
});
