/**
 * Route-level tests for self-protection. Stubs SelfIdentityService matchers
 * to simulate "this is Sencho's own resource" and verifies the delete routes
 * return 423 Locked, plus that /prune/orphans filters self out silently.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;
let SelfIdentityService: typeof import('../services/SelfIdentityService').default;
let DockerController: typeof import('../services/DockerController').default;

const SELF_IMAGE = 'a'.repeat(64);
const SELF_NETWORK = 'b'.repeat(64);
const SELF_CONTAINER = 'c'.repeat(64);
const OTHER_IMAGE = 'd'.repeat(64);
const OTHER_NETWORK = 'e'.repeat(64);
const OTHER_CONTAINER = 'f'.repeat(64);

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ default: SelfIdentityService } = await import('../services/SelfIdentityService'));
  ({ default: DockerController } = await import('../services/DockerController'));
  const token = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' });
  authHeader = `Bearer ${token}`;
});

afterAll(() => cleanupTestDb(tmpDir));

afterEach(() => {
  vi.restoreAllMocks();
  SelfIdentityService.getInstance().resetForTesting();
});

function stubSelfIdentity(opts: { imageId?: string; networkId?: string; containerId?: string; volumeName?: string }) {
  const svc = SelfIdentityService.getInstance();
  vi.spyOn(svc, 'isOwnImage').mockImplementation((id: string) => id === opts.imageId);
  vi.spyOn(svc, 'isOwnNetwork').mockImplementation((id: string) => id === opts.networkId);
  vi.spyOn(svc, 'isOwnContainer').mockImplementation((id: string) => id === opts.containerId);
  vi.spyOn(svc, 'isOwnVolume').mockImplementation((id: string) => id === opts.volumeName);
}

function stubDockerControllerNoops() {
  const fake = {
    removeImage: vi.fn().mockResolvedValue(undefined),
    removeNetwork: vi.fn().mockResolvedValue(undefined),
    removeVolume: vi.fn().mockResolvedValue(undefined),
    removeContainers: vi.fn().mockResolvedValue([]),
  };
  vi.spyOn(DockerController, 'getInstance').mockReturnValue(fake as unknown as ReturnType<typeof DockerController.getInstance>);
  return fake;
}

describe('Self-protection on /api/system delete routes', () => {
  it('refuses to delete Sencho\'s own image with 423 Locked', async () => {
    stubSelfIdentity({ imageId: SELF_IMAGE });
    const docker = stubDockerControllerNoops();

    const res = await request(app)
      .post('/api/system/images/delete')
      .set('Authorization', authHeader)
      .send({ id: SELF_IMAGE });

    expect(res.status).toBe(423);
    expect(res.body.error).toMatch(/Cannot delete the running Sencho instance/);
    expect(res.body.kind).toBe('image');
    expect(docker.removeImage).not.toHaveBeenCalled();
  });

  it('allows deleting other images', async () => {
    stubSelfIdentity({ imageId: SELF_IMAGE });
    const docker = stubDockerControllerNoops();

    const res = await request(app)
      .post('/api/system/images/delete')
      .set('Authorization', authHeader)
      .send({ id: OTHER_IMAGE });

    expect(res.status).toBe(200);
    expect(docker.removeImage).toHaveBeenCalledWith(OTHER_IMAGE);
  });

  it('accepts sha256:-prefixed image IDs (the form Docker returns from /system/images)', async () => {
    stubSelfIdentity({ imageId: SELF_IMAGE });
    const docker = stubDockerControllerNoops();

    const res = await request(app)
      .post('/api/system/images/delete')
      .set('Authorization', authHeader)
      .send({ id: 'sha256:' + OTHER_IMAGE });

    expect(res.status).toBe(200);
    expect(docker.removeImage).toHaveBeenCalledWith('sha256:' + OTHER_IMAGE);
  });

  it('refuses to delete Sencho\'s own network with 423', async () => {
    stubSelfIdentity({ networkId: SELF_NETWORK });
    const docker = stubDockerControllerNoops();

    const res = await request(app)
      .post('/api/system/networks/delete')
      .set('Authorization', authHeader)
      .send({ id: SELF_NETWORK });

    expect(res.status).toBe(423);
    expect(res.body.kind).toBe('network');
    expect(docker.removeNetwork).not.toHaveBeenCalled();
  });

  it('allows deleting other networks', async () => {
    stubSelfIdentity({ networkId: SELF_NETWORK });
    const docker = stubDockerControllerNoops();

    const res = await request(app)
      .post('/api/system/networks/delete')
      .set('Authorization', authHeader)
      .send({ id: OTHER_NETWORK });

    expect(res.status).toBe(200);
    expect(docker.removeNetwork).toHaveBeenCalledWith(OTHER_NETWORK);
  });

  it('refuses to delete Sencho\'s own volume with 423', async () => {
    stubSelfIdentity({ volumeName: 'sencho_data' });
    const docker = stubDockerControllerNoops();

    const res = await request(app)
      .post('/api/system/volumes/delete')
      .set('Authorization', authHeader)
      .send({ id: 'sencho_data' });

    expect(res.status).toBe(423);
    expect(res.body.kind).toBe('volume');
    expect(docker.removeVolume).not.toHaveBeenCalled();
  });

  it('allows deleting other volumes', async () => {
    stubSelfIdentity({ volumeName: 'sencho_data' });
    const docker = stubDockerControllerNoops();

    const res = await request(app)
      .post('/api/system/volumes/delete')
      .set('Authorization', authHeader)
      .send({ id: 'other_volume' });

    expect(res.status).toBe(200);
    expect(docker.removeVolume).toHaveBeenCalledWith('other_volume');
  });
});

describe('Self-protection on /api/system/prune/orphans', () => {
  it('filters Sencho\'s own container out silently and reports skipped:self', async () => {
    stubSelfIdentity({ containerId: SELF_CONTAINER });
    const docker = stubDockerControllerNoops();
    docker.removeContainers.mockResolvedValue([{ id: OTHER_CONTAINER, success: true }]);

    const res = await request(app)
      .post('/api/system/prune/orphans')
      .set('Authorization', authHeader)
      .send({ containerIds: [SELF_CONTAINER, OTHER_CONTAINER] });

    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe('self');
    expect(docker.removeContainers).toHaveBeenCalledWith([OTHER_CONTAINER]);
  });

  it('does not flag a request that excludes the self container', async () => {
    stubSelfIdentity({ containerId: SELF_CONTAINER });
    const docker = stubDockerControllerNoops();
    docker.removeContainers.mockResolvedValue([{ id: OTHER_CONTAINER, success: true }]);

    const res = await request(app)
      .post('/api/system/prune/orphans')
      .set('Authorization', authHeader)
      .send({ containerIds: [OTHER_CONTAINER] });

    expect(res.status).toBe(200);
    expect(res.body.skipped).toBeUndefined();
    expect(docker.removeContainers).toHaveBeenCalledWith([OTHER_CONTAINER]);
  });
});

describe('Self-protection in dev mode (SelfIdentityService empty)', () => {
  it('deletes any image when no self identity is configured', async () => {
    // No stubbing of isOwn*; the reset in afterEach left the service empty
    // and a real isOwnImage on an empty cache returns false.
    SelfIdentityService.getInstance().resetForTesting();
    const docker = stubDockerControllerNoops();

    const res = await request(app)
      .post('/api/system/images/delete')
      .set('Authorization', authHeader)
      .send({ id: SELF_IMAGE });

    expect(res.status).toBe(200);
    expect(docker.removeImage).toHaveBeenCalledWith(SELF_IMAGE);
  });
});

