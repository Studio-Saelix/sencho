/**
 * Route coverage for the canonical build identity:
 *
 * - GET /api/build-info is proxy-exempt (always served by the control
 *   instance), requires a signed-in human session (rejects machine / API-token
 *   credentials), redacts hardened image references to non-admins via
 *   `restricted: true`, and never mislabels a redacted field "Unknown".
 * - GET /api/meta exposes only the bounded `buildChannel` enum on the public
 *   surface and never leaks the running image reference.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { withLoopbackTargetProtection } from './helpers/allowLoopbackTargets';

let tmpDir: string;
let app: import('express').Express;
let adminAuth: string;
let viewerAuth: string;
let machineAuth: string;
let remoteNodeId: number;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let SelfIdentityService: typeof import('../services/SelfIdentityService').default;

const IMAGE_ID = 'b'.repeat(64);
const DIGEST = 'a'.repeat(64);

function mockBuildInfo(over: Record<string, unknown> = {}) {
  const svc = SelfIdentityService.getInstance();
  vi.spyOn(svc, 'getBuildInfo').mockReturnValue({
    version: '0.97.1',
    channel: 'dev',
    imageRef: 'ghcr.io/studio-saelix/sencho-dev:dev-abc1234',
    imageId: IMAGE_ID,
    revision: 'dev-abc1234',
    ...over,
  });
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ DatabaseService } = await import('../services/DatabaseService'));
  SelfIdentityService = (await import('../services/SelfIdentityService')).default;

  const db = DatabaseService.getInstance();
  remoteNodeId = db.addNode({
    name: 'build-info-remote',
    type: 'remote',
    compose_dir: '/tmp',
    is_default: false,
    api_url: 'http://127.0.0.1:1',
    api_token: 'build-info-remote-token',
  });
  // A signed-in non-admin human session (role resolved from the DB row).
  db.addUser({
    username: 'build-info-viewer',
    password_hash: await bcrypt.hash('pw', 1),
    role: 'viewer',
  });

  adminAuth = `Bearer ${jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' })}`;
  viewerAuth = `Bearer ${jwt.sign({ username: 'build-info-viewer' }, TEST_JWT_SECRET, { expiresIn: '1m' })}`;
  // node_proxy machine credential: authMiddleware maps it to role admin with
  // userId 0, so requireUserSession must reject it as not a human session.
  machineAuth = `Bearer ${jwt.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' })}`;
});

afterAll(() => cleanupTestDb(tmpDir));

afterEach(() => vi.restoreAllMocks());

describe('GET /api/build-info auth', () => {
  it('requires authentication', async () => {
    mockBuildInfo();
    const res = await request(app).get('/api/build-info');
    expect(res.status).toBe(401);
  });

  it('rejects node_proxy machine credentials (not a human session)', async () => {
    mockBuildInfo();
    const res = await request(app).get('/api/build-info').set('Authorization', machineAuth);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SESSION_REQUIRED');
  });
});

describe('GET /api/build-info is proxy-exempt', () => {
  it('serves locally even when x-node-id targets a remote node', async () => {
    mockBuildInfo();
    // The remote node's api_url is a closed loopback port. A 502 would mean the
    // proxy intercepted the request; anything else proves the local handler
    // matched, exactly as the existing /api/nodes proxy-exempt test asserts.
    const res = await withLoopbackTargetProtection(() => request(app)
      .get('/api/build-info')
      .set('Authorization', adminAuth)
      .set('x-node-id', String(remoteNodeId)));
    expect(res.status).not.toBe(502);
    expect(res.body.channel).toBe('dev');
  });
});

describe('GET /api/build-info as admin', () => {
  it('returns the full dev identity for a dev image (regression: semver still previous stable)', async () => {
    mockBuildInfo();
    const res = await request(app).get('/api/build-info').set('Authorization', adminAuth);
    expect(res.status).toBe(200);
    expect(res.body.version).toBe('0.97.1');
    expect(res.body.channel).toBe('dev');
    expect(res.body.imageChannel).toBe('community');
    expect(res.body.imageRef).toBe('ghcr.io/studio-saelix/sencho-dev:dev-abc1234');
    expect(res.body.imageId).toBe(IMAGE_ID);
    expect(res.body.revision).toBe('dev-abc1234');
    expect(res.body.restricted).toBe(false);
  });

  it('returns the bounded imageChannel for a hardened image', async () => {
    mockBuildInfo({
      channel: 'stable',
      imageRef: 'ghcr.io/studio-saelix/sencho-hardened:0.97.1',
    });
    const res = await request(app).get('/api/build-info').set('Authorization', adminAuth);
    expect(res.status).toBe(200);
    expect(res.body.channel).toBe('stable');
    expect(res.body.imageChannel).toBe('hardened');
    expect(res.body.imageRef).toBe('ghcr.io/studio-saelix/sencho-hardened:0.97.1');
    expect(res.body.restricted).toBe(false);
  });
});

describe('GET /api/build-info as a non-admin', () => {
  it('redacts a hardened image reference and revision to a non-admin via restricted:true', async () => {
    mockBuildInfo({
      channel: 'stable',
      imageRef: 'ghcr.io/studio-saelix/sencho-hardened:0.97.1',
      revision: `sha256:${DIGEST}`,
    });
    const res = await request(app).get('/api/build-info').set('Authorization', viewerAuth);
    expect(res.status).toBe(200);
    // The build channel stays stable; the procurement channel is what gates
    // redaction. Both reference fields are nulled with restricted:true so the
    // UI can label them "Restricted", never "Unknown".
    expect(res.body.channel).toBe('stable');
    expect(res.body.imageChannel).toBe('hardened');
    expect(res.body.imageRef).toBeNull();
    expect(res.body.revision).toBeNull();
    expect(res.body.restricted).toBe(true);
    // The image ID is not a registry reference and is always returned.
    expect(res.body.imageId).toBe(IMAGE_ID);
  });

  it('does not redact a community image for a non-admin', async () => {
    mockBuildInfo();
    const res = await request(app).get('/api/build-info').set('Authorization', viewerAuth);
    expect(res.status).toBe(200);
    expect(res.body.imageRef).toBe('ghcr.io/studio-saelix/sencho-dev:dev-abc1234');
    expect(res.body.revision).toBe('dev-abc1234');
    expect(res.body.restricted).toBe(false);
  });

  it('reports unknown procurement channel on bare metal without a running reference', async () => {
    mockBuildInfo({ channel: 'unknown', imageRef: null, revision: null });
    const res = await request(app).get('/api/build-info').set('Authorization', viewerAuth);
    expect(res.status).toBe(200);
    // No reference means no classification, and no redaction can apply.
    expect(res.body.channel).toBe('unknown');
    expect(res.body.imageChannel).toBe('unknown');
    expect(res.body.imageRef).toBeNull();
    expect(res.body.revision).toBeNull();
    expect(res.body.restricted).toBe(false);
  });
});

describe('GET /api/build-info awaits revision enrichment', () => {
  it('blocks the response until the enrichment settle promise resolves', async () => {
    mockBuildInfo();
    const svc = SelfIdentityService.getInstance();
    let release!: () => void;
    vi.spyOn(svc, 'whenRevisionResolved').mockImplementation(
      () => new Promise<void>((res) => { release = res; }),
    );

    let settled = false;
    const pending = request(app)
      .get('/api/build-info')
      .set('Authorization', adminAuth)
      .then((res) => { settled = true; return res; });

    // Give the route a tick to reach the await. It must not have responded yet,
    // proving a transient null is never the settled value of a success.
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);

    release();
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body.revision).toBe('dev-abc1234');
  });
});

describe('GET /api/meta buildChannel', () => {
  it('exposes the bounded build channel on the public endpoint', async () => {
    mockBuildInfo();
    const res = await request(app).get('/api/meta');
    expect(res.status).toBe(200);
    expect(res.body.buildChannel).toBe('dev');
  });

  it('never leaks the running image reference on the public endpoint', async () => {
    mockBuildInfo();
    const res = await request(app).get('/api/meta');
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('ghcr.io/studio-saelix/sencho-dev');
    expect(body).not.toContain('dev-abc1234');
  });

  it('omits buildChannel when the running image reference is unknown', async () => {
    mockBuildInfo({ imageRef: null, channel: 'unknown', revision: null });
    const res = await request(app).get('/api/meta');
    expect(res.status).toBe(200);
    expect(res.body.buildChannel).toBeUndefined();
  });
});