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
let SelfIdentityService: typeof import('../services/SelfIdentityService').default;

const VIEWER = 'container-self-filter-viewer';

function viewerToken(): string {
  const user = DatabaseService.getInstance().getUserByUsername(VIEWER)!;
  return jwt.sign({ username: VIEWER, role: 'viewer', tv: user.token_version }, TEST_JWT_SECRET, { expiresIn: '1m' });
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ default: DockerController } = await import('../services/DockerController'));
  ({ default: SelfIdentityService } = await import('../services/SelfIdentityService'));
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
    vi.spyOn(SelfIdentityService, 'getInstance').mockReturnValue({
      isOwnContainer: (idOrName: string) => idOrName === 'sencho' || idOrName.startsWith('sencho-id'),
    } as ReturnType<typeof SelfIdentityService.getInstance>);

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
});
