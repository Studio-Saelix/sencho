/**
 * Integration tests for optimistic concurrency on PUT /api/stacks/:name and
 * PUT /api/stacks/:name/env.
 *
 * GET returns the file content with an `ETag` header carrying the mtimeMs.
 * The frontend echoes that as `If-Match` on save. When the file on disk has
 * mutated in the interim, the server returns 412 with the current content
 * and mtime so the caller can show a "file changed" recovery sheet.
 *
 * These tests use real fs ops against a temp COMPOSE_DIR rather than mocks
 * because the contract is specifically about mtime semantics.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';
import { NodeRegistry } from '../services/NodeRegistry';
import { FileSystemService } from '../services/FileSystemService';

let tmpDir: string;
let composeDir: string;
let app: import('express').Express;
let authCookie: string;

const STACK = 'web';

function seedStack(stackName: string, content: string): string {
  const stackDir = path.join(composeDir, stackName);
  fs.mkdirSync(stackDir, { recursive: true });
  const filePath = path.join(stackDir, 'compose.yaml');
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function seedEnv(stackName: string, content: string): string {
  const stackDir = path.join(composeDir, stackName);
  fs.mkdirSync(stackDir, { recursive: true });
  const envPath = path.join(stackDir, '.env');
  fs.writeFileSync(envPath, content, 'utf-8');
  return envPath;
}

function parseEtag(etag: string | undefined): number | null {
  if (!etag) return null;
  const m = etag.match(/(?:W\/)?"(\d+)"/);
  return m ? Number(m[1]) : null;
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  composeDir = process.env.COMPOSE_DIR as string;
  ({ app } = await import('../index'));
  authCookie = await loginAsTestAdmin(app);
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  const stackDir = path.join(composeDir, STACK);
  if (fs.existsSync(stackDir)) {
    fs.rmSync(stackDir, { recursive: true, force: true });
  }
  // Project env files are stack-scoped database state, not part of the temp
  // compose dir; reset so a configured-file test cannot leak into the next one.
  DatabaseService.getInstance().setStackProjectEnvFiles(NodeRegistry.getInstance().getDefaultNodeId(), STACK, []);
});

describe('GET /api/stacks/:stackName emits ETag with mtime', () => {
  it('responds 200 with content body and a W/"<mtime>" ETag header', async () => {
    seedStack(STACK, 'services:\n  web:\n    image: nginx\n');

    const res = await request(app)
      .get(`/api/stacks/${STACK}`)
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.text).toContain('image: nginx');
    const etag = res.headers.etag;
    expect(etag).toMatch(/^W\/"\d+"$/);
    expect(parseEtag(etag)).toBeGreaterThan(0);
  });
});

describe('PUT /api/stacks/:stackName optimistic concurrency', () => {
  it('writes successfully when If-Match matches current mtime', async () => {
    seedStack(STACK, 'original');
    const getRes = await request(app).get(`/api/stacks/${STACK}`).set('Cookie', authCookie);
    const etag = getRes.headers.etag as string;

    const putRes = await request(app)
      .put(`/api/stacks/${STACK}`)
      .set('Cookie', authCookie)
      .set('If-Match', etag)
      .send({ content: 'updated' });

    expect(putRes.status).toBe(200);
    expect(putRes.headers.etag).toMatch(/^W\/"\d+"$/);
    expect(typeof putRes.body.mtimeMs).toBe('number');
    const filePath = path.join(composeDir, STACK, 'compose.yaml');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('updated');
  });

  it('returns 412 with stack_file_changed and the current content on If-Match mismatch', async () => {
    seedStack(STACK, 'original');
    const getRes = await request(app).get(`/api/stacks/${STACK}`).set('Cookie', authCookie);
    const etag = getRes.headers.etag as string;

    const filePath = path.join(composeDir, STACK, 'compose.yaml');
    fs.writeFileSync(filePath, 'changed-by-other-tab', 'utf-8');
    const future = Date.now() + 5_000;
    fs.utimesSync(filePath, future / 1000, future / 1000);

    const putRes = await request(app)
      .put(`/api/stacks/${STACK}`)
      .set('Cookie', authCookie)
      .set('If-Match', etag)
      .send({ content: 'my-overwrite' });

    expect(putRes.status).toBe(412);
    expect(putRes.body).toMatchObject({
      code: 'stack_file_changed',
      currentContent: 'changed-by-other-tab',
    });
    expect(typeof putRes.body.currentMtimeMs).toBe('number');
    expect(putRes.headers.etag).toMatch(/^W\/"\d+"$/);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('changed-by-other-tab');
  });

  it('writes through when If-Match is absent', async () => {
    seedStack(STACK, 'original');

    const putRes = await request(app)
      .put(`/api/stacks/${STACK}`)
      .set('Cookie', authCookie)
      .send({ content: 'forced' });

    expect(putRes.status).toBe(200);
    const filePath = path.join(composeDir, STACK, 'compose.yaml');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('forced');
  });

  it('writes through when the file does not exist yet (first save creates compose.yaml)', async () => {
    const stackDir = path.join(composeDir, STACK);
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'docker-compose.yaml'), 'legacy', 'utf-8');

    const putRes = await request(app)
      .put(`/api/stacks/${STACK}`)
      .set('Cookie', authCookie)
      .set('If-Match', 'W/"1234"')
      .send({ content: 'fresh' });

    expect(putRes.status).toBe(200);
    expect(fs.readFileSync(path.join(stackDir, 'compose.yaml'), 'utf-8')).toBe('fresh');
  });

  it('detects a near-boundary mtime change (Math.floor precision)', async () => {
    seedStack(STACK, 'original');
    const getRes = await request(app).get(`/api/stacks/${STACK}`).set('Cookie', authCookie);
    const etag = getRes.headers.etag as string;
    const filePath = path.join(composeDir, STACK, 'compose.yaml');
    const originalStat = fs.statSync(filePath);

    // Bump the mtime by exactly one full second so Math.floor(mtimeMs) is
    // guaranteed to differ even on filesystems that round to whole seconds.
    fs.writeFileSync(filePath, 'changed-just-after', 'utf-8');
    const bumped = (originalStat.mtimeMs + 1000) / 1000;
    fs.utimesSync(filePath, bumped, bumped);

    const putRes = await request(app)
      .put(`/api/stacks/${STACK}`)
      .set('Cookie', authCookie)
      .set('If-Match', etag)
      .send({ content: 'my-edit' });

    expect(putRes.status).toBe(412);
    expect(putRes.body.code).toBe('stack_file_changed');
  });

  it('ignores malformed If-Match headers and writes through', async () => {
    seedStack(STACK, 'original');

    const putRes = await request(app)
      .put(`/api/stacks/${STACK}`)
      .set('Cookie', authCookie)
      .set('If-Match', 'not-a-valid-etag')
      .send({ content: 'forced' });

    expect(putRes.status).toBe(200);
  });
});

describe('PUT /api/stacks/:stackName/env optimistic concurrency', () => {
  it('writes successfully when If-Match matches', async () => {
    seedStack(STACK, 'services: {}');
    const envPath = seedEnv(STACK, 'FOO=1');

    const getRes = await request(app)
      .get(`/api/stacks/${STACK}/env?file=${encodeURIComponent(envPath)}`)
      .set('Cookie', authCookie);
    const etag = getRes.headers.etag as string;
    expect(etag).toMatch(/^W\/"\d+"$/);

    const putRes = await request(app)
      .put(`/api/stacks/${STACK}/env?file=${encodeURIComponent(envPath)}`)
      .set('Cookie', authCookie)
      .set('If-Match', etag)
      .send({ content: 'FOO=2' });

    expect(putRes.status).toBe(200);
    expect(fs.readFileSync(envPath, 'utf-8')).toBe('FOO=2');
  });

  it('returns a clean 404 (not a 500) when the stack has no env file yet', async () => {
    // Compose exists with no env_file directive and no .env on disk, so
    // resolveAllEnvFilePaths filters the synthesized default out and returns [],
    // leaving the env path undefined. Callers that did not ask for creation
    // (Fleet Secrets pushes, API clients) must keep the handled response, and
    // the guard must short-circuit before any write touches disk.
    seedStack(STACK, 'services:\n  web:\n    image: nginx\n');

    const putRes = await request(app)
      .put(`/api/stacks/${STACK}/env`)
      .set('Cookie', authCookie)
      .send({ content: 'FOO=1' });

    expect(putRes.status).toBe(404);
    expect(putRes.body.error).toMatch(/no env file/i);
    expect(fs.existsSync(path.join(composeDir, STACK, '.env'))).toBe(false);
  });

  it('creates the default .env when the editor save asks for creation', async () => {
    seedStack(STACK, 'services:\n  web:\n    image: nginx\n');

    const putRes = await request(app)
      .put(`/api/stacks/${STACK}/env?create=1`)
      .set('Cookie', authCookie)
      .send({ content: 'FOO=1' });

    expect(putRes.status).toBe(200);
    expect(putRes.body.created).toBe(true);
    const createdPath = putRes.body.envPath as string;
    expect(createdPath).toBe(path.join(composeDir, STACK, '.env'));
    expect(putRes.headers.etag).toMatch(/^W\/"\d+"$/);
    expect(fs.readFileSync(createdPath, 'utf-8')).toBe('FOO=1');
  });

  it('saves again through the canonical path returned by the create response', async () => {
    // The editor selects the created file from the create response and echoes
    // it as ?file= on the next save. That path must be accepted, otherwise the
    // very next save fails with "Requested env file not allowed".
    seedStack(STACK, 'services:\n  web:\n    image: nginx\n');

    const createRes = await request(app)
      .put(`/api/stacks/${STACK}/env?create=1`)
      .set('Cookie', authCookie)
      .send({ content: 'FOO=1' });

    const createdPath = createRes.body.envPath as string;
    const etag = createRes.headers.etag as string;

    const secondRes = await request(app)
      .put(`/api/stacks/${STACK}/env?file=${encodeURIComponent(createdPath)}`)
      .set('Cookie', authCookie)
      .set('If-Match', etag)
      .send({ content: 'FOO=2' });

    expect(secondRes.status).toBe(200);
    expect(fs.readFileSync(createdPath, 'utf-8')).toBe('FOO=2');
  });

  it('returns 404 for a create save on a stack that does not exist', async () => {
    // The create branch validates stack existence before the write: a missing
    // stack must not fabricate a directory (or surface as an ENOENT 500).
    const missing = 'ghost-stack';

    const putRes = await request(app)
      .put(`/api/stacks/${missing}/env?create=1`)
      .set('Cookie', authCookie)
      .send({ content: 'FOO=1' });

    expect(putRes.status).toBe(404);
    expect(putRes.body.error).toMatch(/not found/i);
    expect(fs.existsSync(path.join(composeDir, missing))).toBe(false);
  });

  it('returns a conflict instead of overwriting when create is set and the env file exists', async () => {
    // A stale editor (the file appeared after the tab loaded) sends create=1
    // with no If-Match. The exclusive create must fail with the same 412 shape
    // the optimistic-concurrency path uses, and leave the file untouched.
    seedStack(STACK, 'services: {}');
    const envPath = seedEnv(STACK, 'SECRET=keepme');

    const putRes = await request(app)
      .put(`/api/stacks/${STACK}/env?create=1`)
      .set('Cookie', authCookie)
      .send({ content: 'FOO=2' });

    expect(putRes.status).toBe(412);
    expect(putRes.body.code).toBe('stack_file_changed');
    expect(putRes.body.currentContent).toBe('SECRET=keepme');
    expect(putRes.body.envPath).toBe(envPath);
    expect(fs.readFileSync(envPath, 'utf-8')).toBe('SECRET=keepme');
  });

  it('overwrites on the forced create retry after the conflict confirmation', async () => {
    seedStack(STACK, 'services: {}');
    const envPath = seedEnv(STACK, 'SECRET=keepme');

    const putRes = await request(app)
      .put(`/api/stacks/${STACK}/env?create=1&force=1`)
      .set('Cookie', authCookie)
      .send({ content: 'FOO=2' });

    expect(putRes.status).toBe(200);
    expect(putRes.body.created).toBeUndefined();
    expect(putRes.body.envPath).toBe(envPath);
    expect(fs.readFileSync(envPath, 'utf-8')).toBe('FOO=2');
  });

  it('pins the forced create retry to the file the conflict named', async () => {
    // Reachable create flow: the tab loaded while the configured custom.env was
    // missing (no env file resolved), then the file appeared before the save.
    // The conflict names it, and the retry must write exactly that file.
    seedStack(STACK, 'services: {}');
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    DatabaseService.getInstance().setStackProjectEnvFiles(nodeId, STACK, ['custom.env']);
    const customPath = path.join(composeDir, STACK, 'custom.env');
    const strayPath = path.join(composeDir, STACK, '.env');
    fs.writeFileSync(strayPath, 'SECRET=keepme', 'utf-8');
    fs.writeFileSync(customPath, 'C=1', 'utf-8');

    const conflictRes = await request(app)
      .put(`/api/stacks/${STACK}/env?create=1`)
      .set('Cookie', authCookie)
      .send({ content: 'C=2' });

    expect(conflictRes.status).toBe(412);
    expect(conflictRes.body.envPath).toBe(customPath);

    const forcedRes = await request(app)
      .put(`/api/stacks/${STACK}/env?create=1&force=1&file=${encodeURIComponent(customPath)}`)
      .set('Cookie', authCookie)
      .send({ content: 'C=2' });

    expect(forcedRes.status).toBe(200);
    expect(forcedRes.body.envPath).toBe(customPath);
    expect(fs.readFileSync(customPath, 'utf-8')).toBe('C=2');
    expect(fs.readFileSync(strayPath, 'utf-8')).toBe('SECRET=keepme');
  });

  it('creates normally with the precondition header the older-node client sends', async () => {
    // The client sends If-Match: W/"0" on the non-forced create so a node that
    // predates create-on-save answers 412 for an existing file instead of
    // overwriting it. This build's exclusive create must ignore the header.
    seedStack(STACK, 'services: {}');

    const putRes = await request(app)
      .put(`/api/stacks/${STACK}/env?create=1`)
      .set('Cookie', authCookie)
      .set('If-Match', 'W/"0"')
      .send({ content: 'FOO=1' });

    expect(putRes.status).toBe(200);
    expect(putRes.body.created).toBe(true);
    expect(fs.readFileSync(path.join(composeDir, STACK, '.env'), 'utf-8')).toBe('FOO=1');
  });

  it('answers 409 when the env target is a directory', async () => {
    seedStack(STACK, 'services: {}');
    const dirPath = path.join(composeDir, STACK, '.env');
    fs.mkdirSync(dirPath);

    const putRes = await request(app)
      .put(`/api/stacks/${STACK}/env?create=1`)
      .set('Cookie', authCookie)
      .send({ content: 'FOO=1' });

    expect(putRes.status).toBe(409);
    expect(fs.statSync(dirPath).isDirectory()).toBe(true);
  });

  it('refuses a create through a symlink that escapes the stack without reading it', async () => {
    seedStack(STACK, 'services: {}');
    const outsidePath = path.join(tmpDir, 'outside.env');
    fs.writeFileSync(outsidePath, 'OUTSIDE=secret', 'utf-8');
    fs.symlinkSync(outsidePath, path.join(composeDir, STACK, '.env'));

    const putRes = await request(app)
      .put(`/api/stacks/${STACK}/env?create=1`)
      .set('Cookie', authCookie)
      .send({ content: 'FOO=1' });

    expect(putRes.status).toBe(409);
    expect(putRes.body.currentContent).toBeUndefined();
    expect(fs.readFileSync(outsidePath, 'utf-8')).toBe('OUTSIDE=secret');
  });

  it('answers 409 for an in-root symlinked .env instead of an opaque 500', async () => {
    // The resolver sees the link as present; the exclusive create refuses to
    // follow it and the route maps the path error to 409.
    seedStack(STACK, 'services: {}');
    const realPath = path.join(composeDir, STACK, 'real.env');
    const linkPath = path.join(composeDir, STACK, '.env');
    fs.writeFileSync(realPath, 'REAL=1', 'utf-8');
    fs.symlinkSync(realPath, linkPath);

    const putRes = await request(app)
      .put(`/api/stacks/${STACK}/env?create=1`)
      .set('Cookie', authCookie)
      .send({ content: 'FOO=1' });

    expect(putRes.status).toBe(409);
    expect(putRes.body.currentContent).toBeUndefined();
    expect(fs.readFileSync(realPath, 'utf-8')).toBe('REAL=1');
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
  });

  it('answers 409 when the default env path is a dangling symlink', async () => {
    seedStack(STACK, 'services: {}');
    const linkPath = path.join(composeDir, STACK, '.env');
    fs.symlinkSync(path.join(composeDir, STACK, 'missing.env'), linkPath);

    const putRes = await request(app)
      .put(`/api/stacks/${STACK}/env?create=1`)
      .set('Cookie', authCookie)
      .send({ content: 'FOO=1' });

    expect(putRes.status).toBe(409);
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
  });

  it('lets exactly one of two concurrent creates win', async () => {
    seedStack(STACK, 'services: {}');

    const [a, b] = await Promise.all([
      request(app)
        .put(`/api/stacks/${STACK}/env?create=1`)
        .set('Cookie', authCookie)
        .send({ content: 'A=1' }),
      request(app)
        .put(`/api/stacks/${STACK}/env?create=1`)
        .set('Cookie', authCookie)
        .send({ content: 'B=1' }),
    ]);

    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 412]);
    expect(['A=1', 'B=1']).toContain(fs.readFileSync(path.join(composeDir, STACK, '.env'), 'utf-8'));
  });

  it('refuses a create when every configured project env file escapes the stack', async () => {
    // A stale or hand-edited config row must not turn the first save into a
    // write outside the stack directory.
    seedStack(STACK, 'services: {}');
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    DatabaseService.getInstance().setStackProjectEnvFiles(nodeId, STACK, ['../escape.env']);

    const putRes = await request(app)
      .put(`/api/stacks/${STACK}/env?create=1`)
      .set('Cookie', authCookie)
      .send({ content: 'FOO=1' });

    expect(putRes.status).toBe(409);
    expect(fs.existsSync(path.join(composeDir, 'escape.env'))).toBe(false);
  });

  it('creates the configured project env file and leaves a stray .env untouched', async () => {
    // With project env files configured, Compose reads those instead of .env.
    // The first save must create the configured file, and a .env left on disk
    // (not an env source in that state) must not be overwritten.
    seedStack(STACK, 'services: {}');
    const strayEnv = seedEnv(STACK, 'SECRET=keepme');
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    DatabaseService.getInstance().setStackProjectEnvFiles(nodeId, STACK, ['custom.env']);

    const putRes = await request(app)
      .put(`/api/stacks/${STACK}/env?create=1`)
      .set('Cookie', authCookie)
      .send({ content: 'FOO=1' });

    expect(putRes.status).toBe(200);
    expect(putRes.body.created).toBe(true);
    const createdPath = putRes.body.envPath as string;
    expect(createdPath).toBe(path.join(composeDir, STACK, 'custom.env'));
    expect(fs.readFileSync(createdPath, 'utf-8')).toBe('FOO=1');
    expect(fs.readFileSync(strayEnv, 'utf-8')).toBe('SECRET=keepme');

    // The created file is a real env source now, so /envs lists it and the
    // next save through the returned path is accepted.
    const envsRes = await request(app)
      .get(`/api/stacks/${STACK}/envs`)
      .set('Cookie', authCookie);
    expect(envsRes.body.envFiles).toEqual([createdPath]);

    const secondRes = await request(app)
      .put(`/api/stacks/${STACK}/env?file=${encodeURIComponent(createdPath)}`)
      .set('Cookie', authCookie)
      .send({ content: 'FOO=2' });

    expect(secondRes.status).toBe(200);
    expect(fs.readFileSync(createdPath, 'utf-8')).toBe('FOO=2');
  });

  it('reports a stack directory that vanished before the create and does not recreate it', async () => {
    // requireStackExists reads the disk, so a concurrent deleteStack can land
    // between the check and the exclusive create. The delete is injected at
    // the existence check itself; the real create then fails with ENOENT and
    // the route must answer a handled 404 without recreating the directory, or
    // the deleted stack would come back hidden holding the env content and
    // block its name.
    seedStack(STACK, 'services: {}');
    const stackDir = path.join(composeDir, STACK);
    const spy = vi
      .spyOn(FileSystemService.prototype, 'hasComposeFile')
      .mockImplementation(async () => {
        fs.rmSync(stackDir, { recursive: true, force: true });
        return true;
      });

    try {
      const putRes = await request(app)
        .put(`/api/stacks/${STACK}/env?create=1`)
        .set('Cookie', authCookie)
        .send({ content: 'FOO=1' });

      expect(putRes.status).toBe(404);
      expect(putRes.body.error).toBe('Stack not found');
      expect(fs.existsSync(stackDir)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('recreates the pinned file when it is deleted between the conflict and the confirmed retry', async () => {
    // The editor loaded with no env file, another actor created .env, and the
    // save conflicted. The file is then deleted while the operator reads the
    // dialog. The confirmed retry pins the vanished path; it is still the
    // resolved create target, so the route must recreate it rather than 400
    // and strand the editor on a path it has already adopted.
    seedStack(STACK, 'services: {}');
    const envPath = path.join(composeDir, STACK, '.env');
    fs.writeFileSync(envPath, 'OTHER=1', 'utf-8');

    const firstRes = await request(app)
      .put(`/api/stacks/${STACK}/env?create=1`)
      .set('Cookie', authCookie)
      .send({ content: 'MINE=1' });

    expect(firstRes.status).toBe(412);
    expect(firstRes.body.envPath).toBe(envPath);

    fs.rmSync(envPath);

    const retryRes = await request(app)
      .put(`/api/stacks/${STACK}/env?create=1&force=1&file=${encodeURIComponent(envPath)}`)
      .set('Cookie', authCookie)
      .send({ content: 'MINE=1' });

    expect(retryRes.status).toBe(200);
    expect(fs.readFileSync(envPath, 'utf-8')).toBe('MINE=1');
  });

  it('ignores force on the non-create save path', async () => {
    // force is a create-path flag: the editor's normal forced retry works by
    // omitting If-Match, so force=1 here must not bypass a stale precondition.
    seedStack(STACK, 'services: {}');
    const envPath = seedEnv(STACK, 'FOO=1');

    const getRes = await request(app)
      .get(`/api/stacks/${STACK}/env?file=${encodeURIComponent(envPath)}`)
      .set('Cookie', authCookie);
    const etag = getRes.headers.etag as string;

    fs.writeFileSync(envPath, 'FOO=bumped', 'utf-8');
    const future = Date.now() + 5_000;
    fs.utimesSync(envPath, future / 1000, future / 1000);

    const putRes = await request(app)
      .put(`/api/stacks/${STACK}/env?force=1&file=${encodeURIComponent(envPath)}`)
      .set('Cookie', authCookie)
      .set('If-Match', etag)
      .send({ content: 'FOO=2' });

    expect(putRes.status).toBe(412);
    expect(fs.readFileSync(envPath, 'utf-8')).toBe('FOO=bumped');
  });

  it('returns 412 on env-file mtime mismatch', async () => {
    seedStack(STACK, 'services: {}');
    const envPath = seedEnv(STACK, 'FOO=1');

    const getRes = await request(app)
      .get(`/api/stacks/${STACK}/env?file=${encodeURIComponent(envPath)}`)
      .set('Cookie', authCookie);
    const etag = getRes.headers.etag as string;

    fs.writeFileSync(envPath, 'FOO=bumped', 'utf-8');
    const future = Date.now() + 5_000;
    fs.utimesSync(envPath, future / 1000, future / 1000);

    const putRes = await request(app)
      .put(`/api/stacks/${STACK}/env?file=${encodeURIComponent(envPath)}`)
      .set('Cookie', authCookie)
      .set('If-Match', etag)
      .send({ content: 'FOO=my-overwrite' });

    expect(putRes.status).toBe(412);
    expect(putRes.body.code).toBe('stack_file_changed');
    expect(putRes.body.currentContent).toBe('FOO=bumped');
    expect(fs.readFileSync(envPath, 'utf-8')).toBe('FOO=bumped');
  });
});
