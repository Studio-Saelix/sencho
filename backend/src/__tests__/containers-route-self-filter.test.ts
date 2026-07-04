/**
 * GET /api/containers must omit Sencho's own container from picker lists.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb, TEST_JWT_SECRET } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let DockerController: typeof import('../services/DockerController').default;
let SelfIdentityServiceMod: typeof import('../services/SelfIdentityService').default;

const VIEWER = 'container-self-filter-viewer';

function viewerToken(): string {
  const user = DatabaseService.getInstance().getUserByUsername(VIEWER)!;
  return jwt.sign({ username: VIEWER, role: 'viewer', tv: user.token_version }, TEST_JWT_SECRET, { expiresIn: '1m' });
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ default: DockerController } = await import('../services/DockerController'));
  ({ default: SelfIdentityServiceMod } = await import('../services/SelfIdentityService'));
  ({ app } = await import('../index'));

  const hash = await bcrypt.hash('password123', 1);
  DatabaseService.getInstance().addUser({ username: VIEWER, password_hash: hash, role: 'viewer' });
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/containers self-filter', () => {
  beforeEach(() => {
    vi.spyOn(SelfIdentityServiceMod, 'getInstance').mockReturnValue({
      initialize: vi.fn().mockResolvedValue(undefined),
      isOwnContainer: (idOrName: string) => idOrName === 'sencho' || idOrName.startsWith('sencho-id'),
      isOwnImage: vi.fn().mockReturnValue(false),
    } as unknown as ReturnType<typeof SelfIdentityServiceMod.getInstance>);

    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      getAllContainers: vi.fn().mockResolvedValue([
        { Id: 'sencho-id-full', Names: ['/sencho'], State: 'running', Status: 'Up 1 day' },
        { Id: 'other-id', Names: ['/mariadb'], State: 'running', Status: 'Up 1 day' },
      ]),
      getRunningContainers: vi.fn().mockResolvedValue([]),
    } as unknown as ReturnType<typeof DockerController.getInstance>);
  });

  it('excludes Sencho from all=true container list', async () => {
    const res = await request(app)
      .get('/api/containers?all=true')
      .set('Authorization', `Bearer ${viewerToken()}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].Names).toEqual(['/mariadb']);
  });

  it('excludes official Sencho images when SelfIdentity does not match by id', async () => {
    vi.spyOn(SelfIdentityServiceMod, 'getInstance').mockReturnValue({
      initialize: vi.fn().mockResolvedValue(undefined),
      isOwnContainer: vi.fn().mockReturnValue(false),
      isOwnImage: vi.fn().mockReturnValue(false),
    } as unknown as ReturnType<typeof SelfIdentityServiceMod.getInstance>);

    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      getAllContainers: vi.fn().mockResolvedValue([
        { Id: 'remote-sencho', Names: ['/sencho'], Image: 'saelix/sencho:latest', State: 'running' },
        { Id: 'other-id', Names: ['/mariadb'], State: 'running' },
      ]),
      getRunningContainers: vi.fn().mockResolvedValue([]),
    } as unknown as ReturnType<typeof DockerController.getInstance>);

    const res = await request(app)
      .get('/api/containers?all=true')
      .set('Authorization', `Bearer ${viewerToken()}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].Names).toEqual(['/mariadb']);
  });
});
