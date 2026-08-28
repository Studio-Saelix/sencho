/**
 * Networking hardening integration tests:
 *  - the aggregate memo serves repeat reads within its TTL,
 *  - a base (no-topology) read never satisfies a topology request,
 *  - exposure-intent writes invalidate the memo so the next overview reflects
 *    them immediately,
 *  - the delete guard 409s with stack-declaration-unknown for an unlabeled
 *    external network while a stack fails to render.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import DockerController from '../services/DockerController';
import { ComposeService } from '../services/ComposeService';
import { DatabaseService } from '../services/DatabaseService';

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;

const STACK = 'hardnet';
const NET_ID = 'deadbeefdead';

function stubHealthy() {
  vi.spyOn(DockerController, 'getInstance').mockReturnValue({
    getDependencySnapshot: vi.fn().mockResolvedValue({
      containers: [],
      networks: [
        { id: NET_ID, name: 'shared_ext', driver: 'bridge', scope: 'local', isSystem: false, composeProject: null, stack: null },
      ],
      volumes: [],
    }),
    inspectNetwork: vi.fn().mockResolvedValue({ Id: NET_ID, Name: 'shared_ext', Driver: 'bridge', Scope: 'local', Labels: {}, Containers: {} }),
    removeNetwork: vi.fn().mockResolvedValue(undefined),
  } as unknown as DockerController);
  vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
    renderConfig: vi.fn().mockResolvedValue({
      rendered: JSON.stringify({
        name: STACK,
        services: { web: { image: 'nginx:latest', ports: ['8080:80'] } },
        networks: {},
        volumes: {},
      }),
      stderr: '', code: 0, timedOut: false,
    }),
  } as unknown as ComposeService);
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  authHeader = `Bearer ${jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '5m' })}`;
});

afterAll(() => cleanupTestDb(tmpDir));

describe('networking hardening', () => {
  let stackDir: string;

  beforeEach(() => {
    stackDir = path.join(process.env.COMPOSE_DIR as string, STACK);
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx:latest\n');
    stubHealthy();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(stackDir, { recursive: true, force: true });
  });

  it('serves repeat overview reads from one computation within the TTL window', async () => {
    const first = await request(app).get('/api/networking/overview').set('Authorization', authHeader);
    expect(first.status).toBe(200);

    const snapshotSpy = DockerController.getInstance(1).getDependencySnapshot as ReturnType<typeof vi.fn>;
    const callsBefore = snapshotSpy.mock.calls.length;

    const second = await request(app).get('/api/networking/overview').set('Authorization', authHeader);
    expect(second.status).toBe(200);
    expect(second.body.schemaVersion).toBe(first.body.schemaVersion);
    expect(DockerController.getInstance(1).getDependencySnapshot as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(callsBefore);
  });

  it('serves real topology data when overview warmed the cache first', async () => {
    await request(app).get('/api/networking/overview').set('Authorization', authHeader);

    const res = await request(app)
      .get('/api/networking/topology')
      .set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect((res.body.networks as Array<{ name: string }>)).toContainEqual(
      expect.objectContaining({ name: 'shared_ext' }),
    );
  });
  it('reflects an exposure-intent change in the next overview read', async () => {
    const initial = await request(app).get('/api/networking/overview').set('Authorization', authHeader);
    expect(initial.status).toBe(200);
    // The fixture publishes 8080:80 with no intent set, so the pre-write read
    // must carry the unclassified finding; asserting both directions makes an
    // invalidation regression loud instead of silently vacuous.
    const hadUnclassifiedBefore = ((initial.body.findings ?? []) as Array<{ kind: string; stack?: string }>)
      .some((f) => f.kind === 'exposure-unclassified' && f.stack === STACK);
    expect(hadUnclassifiedBefore).toBe(true);

    const put = await request(app)
      .put(`/api/stacks/${STACK}/exposure`)
      .set('Authorization', authHeader)
      .send({ service: '', intent: 'internal' });
    expect(put.status).toBe(200);

    const res = await request(app).get('/api/networking/overview').set('Authorization', authHeader);
    expect(res.status).toBe(200);
    const unclassified = (res.body.findings as Array<{ kind: string; stack?: string }>)
      .find((f) => f.kind === 'exposure-unclassified' && f.stack === STACK);
    expect(unclassified).toBeUndefined();

    DatabaseService.getInstance().deleteStackExposureIntents(1, STACK);
  });

  it('409s an unlabeled external network delete while a stack is unrenderable', async () => {
    (ComposeService.getInstance(1).renderConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      rendered: null,
      stderr: 'redacted render failure',
      code: 1,
      timedOut: false,
    });

    const removeSpy = vi.spyOn(DockerController.getInstance(1), 'removeNetwork');
    const res = await request(app)
      .post('/api/system/networks/delete')
      .set('Authorization', authHeader)
      .send({ id: NET_ID });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('stack-declaration-unknown');
    expect(removeSpy).not.toHaveBeenCalled();
  });

  it('allows deleting the same network once every stack renders again', async () => {
    const removeSpy = vi.spyOn(DockerController.getInstance(1), 'removeNetwork');
    const res = await request(app)
      .post('/api/system/networks/delete')
      .set('Authorization', authHeader)
      .send({ id: NET_ID });
    expect(res.status).toBe(200);
    expect(removeSpy).toHaveBeenCalledOnce();
  });
});
