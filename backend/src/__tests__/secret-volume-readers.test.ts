/**
 * The volume browser and its routes never open a secret volume: every
 * VolumeBrowserService entry point refuses it before a helper container runs,
 * `/api/volumes/*` answers 423 to a stack:read user, and the single-volume
 * delete route answers 423 too.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { Readable } from 'stream';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let viewerCookie: string;
let adminCookie: string;
let DockerController: typeof import('../services/DockerController').default;
let VolumeBrowserService: typeof import('../services/VolumeBrowserService').VolumeBrowserService;
let SecretVolumeProtectedError: typeof import('../helpers/secretVolume').SecretVolumeProtectedError;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ default: DockerController } = await import('../services/DockerController'));
  ({ VolumeBrowserService } = await import('../services/VolumeBrowserService'));
  ({ SecretVolumeProtectedError } = await import('../helpers/secretVolume'));
  adminCookie = await loginAsTestAdmin(app);
  const { DatabaseService } = await import('../services/DatabaseService');
  DatabaseService.getInstance().addUser({ username: 'secret-viewer', password_hash: await bcrypt.hash('viewerpass', 1), role: 'viewer' });
  const login = await request(app).post('/api/auth/login').send({ username: 'secret-viewer', password: 'viewerpass' });
  const cookies = login.headers['set-cookie'] as string | string[];
  viewerCookie = Array.isArray(cookies) ? cookies[0] : cookies;
});

afterAll(() => cleanupTestDb(tmpDir));

afterEach(() => {
  vi.restoreAllMocks();
});

/** A Docker stub whose volumes carry the given labels and that records any helper start. */
function stubDocker(labels: Record<string, string>) {
  const inspected: string[] = [];
  const helperCalls = { createContainer: vi.fn(), getImage: vi.fn() };
  const docker = {
    getVolume: (name: string) => ({
      inspect: vi.fn().mockImplementation(async () => { inspected.push(name); return { Name: name, Labels: labels }; }),
    }),
    ...helperCalls,
  };
  vi.spyOn(DockerController, 'getInstance').mockReturnValue({
    getDocker: () => docker,
  } as unknown as ReturnType<typeof DockerController.getInstance>);
  return { inspected, helperCalls };
}

const SECRET_LABELS = { 'io.sencho.secret': '' };

describe('VolumeBrowserService on a secret volume', () => {
  const ops: Array<[string, (svc: InstanceType<typeof VolumeBrowserService>, name: string) => Promise<unknown>]> = [
    ['listDir', (svc, name) => svc.listDir(name, '')],
    ['stat', (svc, name) => svc.stat(name, 'token')],
    ['readFile', (svc, name) => svc.readFile(name, 'token')],
    ['downloadFile', (svc, name) => svc.downloadFile(name, 'token')],
    ['pathKind', (svc, name) => svc.pathKind(name, 'token')],
    ['writeFile', (svc, name) => svc.writeFile(name, 'token', Buffer.from('x'))],
    ['writeFileStream', (svc, name) => svc.writeFileStream(name, 'token', Readable.from([Buffer.from('x')]), 1)],
    ['mkdir', (svc, name) => svc.mkdir(name, 'dir')],
    ['deletePath', (svc, name) => svc.deletePath(name, 'token', false)],
    ['rename', (svc, name) => svc.rename(name, 'token', 'other')],
    ['copy', (svc, name) => svc.copy(name, 'token', 'other')],
  ];

  it.each(ops)('%s refuses a labelled volume before any helper runs', async (_op, run) => {
    const { helperCalls } = stubDocker(SECRET_LABELS);
    await expect(run(VolumeBrowserService.getInstance(1), 'my-stack_tok')).rejects.toBeInstanceOf(SecretVolumeProtectedError);
    expect(helperCalls.createContainer).not.toHaveBeenCalled();
    expect(helperCalls.getImage).not.toHaveBeenCalled();
  });

  it.each(ops)('%s refuses the reserved name without inspecting it', async (_op, run) => {
    const { inspected, helperCalls } = stubDocker({});
    await expect(run(VolumeBrowserService.getInstance(1), 'sencho_edge_secret')).rejects.toBeInstanceOf(SecretVolumeProtectedError);
    expect(inspected).toEqual([]);
    expect(helperCalls.createContainer).not.toHaveBeenCalled();
  });
});

describe('/api/volumes routes on a secret volume', () => {
  it.each(['list', 'stat', 'read'])('answers 423 to a stack:read user on %s', async (route) => {
    const { helperCalls } = stubDocker(SECRET_LABELS);
    const res = await request(app)
      .get(`/api/volumes/my-stack_tok/${route}`)
      .query({ path: 'token' })
      .set('Cookie', viewerCookie);
    expect(res.status).toBe(423);
    expect(res.body.code).toBe('secret_volume_protected');
    expect(JSON.stringify(res.body)).not.toMatch(/content|entries/);
    expect(helperCalls.createContainer).not.toHaveBeenCalled();
  });
});

describe('POST /api/system/volumes/delete on a secret volume', () => {
  it('answers 423 with the secret code', async () => {
    const removeVolume = vi.fn().mockRejectedValue(new SecretVolumeProtectedError('protected'));
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      removeVolume,
    } as unknown as ReturnType<typeof DockerController.getInstance>);
    const res = await request(app)
      .post('/api/system/volumes/delete')
      .set('Cookie', adminCookie)
      .send({ id: 'sencho_edge_secret' });
    expect(res.status).toBe(423);
    expect(res.body.code).toBe('secret_volume_protected');
  });
});
