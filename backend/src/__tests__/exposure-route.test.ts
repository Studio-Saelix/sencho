/**
 * GET/PUT /api/stacks/:stackName/exposure: read and write the per-stack and
 * per-service exposure classification. PUT requires write access, validates the
 * intent value, and supports clearing a row (intent null) so a service inherits
 * the stack intent again.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';
import { generateApiToken } from '../utils/apiTokenFormat';
import { FileSystemService } from '../services/FileSystemService';
import { EXPOSURE_INTENTS, type ExposureIntent } from '../services/network/types';

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;
let readOnlyToken: string;

const STACK = 'exproute';

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  authHeader = `Bearer ${jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '5m' })}`;

  const db = DatabaseService.getInstance();
  readOnlyToken = generateApiToken();
  db.addApiToken({
    token_hash: crypto.createHash('sha256').update(readOnlyToken).digest('hex'),
    name: 'exposure-readonly', scope: 'read-only',
    user_id: db.getUserByUsername(TEST_USERNAME)!.id, created_at: Date.now(), expires_at: null,
  });
});

afterAll(() => cleanupTestDb(tmpDir));

describe('exposure intent routes', () => {
  let stackDir: string;
  beforeEach(() => {
    stackDir = path.join(process.env.COMPOSE_DIR as string, STACK);
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx:latest\n');
  });
  afterEach(() => {
    DatabaseService.getInstance().deleteStackExposureIntents(1, STACK);
    fs.rmSync(stackDir, { recursive: true, force: true });
  });

  const put = (body: object) => request(app).put(`/api/stacks/${STACK}/exposure`).set('Authorization', authHeader).send(body);
  const get = () => request(app).get(`/api/stacks/${STACK}/exposure`).set('Authorization', authHeader);

  it('starts with no intents', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.intents).toEqual([]);
  });

  it('sets a stack-level and a per-service intent and records the author', async () => {
    expect((await put({ intent: 'internal' })).status).toBe(200);
    const res = await put({ service: 'api', intent: 'public' });
    expect(res.status).toBe(200);
    expect(res.body.intents).toEqual([
      expect.objectContaining({ service: '', intent: 'internal' }),
      expect.objectContaining({ service: 'api', intent: 'public' }),
    ]);
    const stackRow = res.body.intents.find((i: { service: string }) => i.service === '');
    expect(stackRow.updatedBy).toBe(TEST_USERNAME);
    expect(typeof stackRow.updatedAt).toBe('number');
  });

  it('clears a service row (intent null) so it inherits the stack intent', async () => {
    await put({ intent: 'internal' });
    await put({ service: 'api', intent: 'public' });
    expect((await put({ service: 'api', intent: null })).status).toBe(200);
    const res = await get();
    expect(res.body.intents).toEqual([expect.objectContaining({ service: '', intent: 'internal' })]);
  });

  it('clears the stack row (intent null) so the stack is unclassified again', async () => {
    await put({ intent: 'internal' });
    await put({ intent: null });
    expect((await get()).body.intents).toEqual([]);
  });

  it('rejects an invalid intent value', async () => {
    expect((await put({ intent: 'bogus' })).status).toBe(400);
  });

  it('blocks a write from a read-only token', async () => {
    const res = await request(app).put(`/api/stacks/${STACK}/exposure`)
      .set('Authorization', `Bearer ${readOnlyToken}`).send({ intent: 'internal' });
    expect(res.status).toBe(403);
  });

  it('rejects an unauthenticated request', async () => {
    expect((await request(app).get(`/api/stacks/${STACK}/exposure`)).status).toBe(401);
  });

  it('returns 404 for a stack that does not exist', async () => {
    expect((await request(app).get('/api/stacks/nope-not-here/exposure').set('Authorization', authHeader)).status).toBe(404);
  });
});

/**
 * A save whose client gave up on it (the browser times out after 30 seconds and
 * sends the next) is still being worked on by the node. The node applies saves
 * to one stack in the order they arrived, so that save cannot land after a later
 * one that already replied and undo it.
 */
describe('exposure intent saves that overlap', () => {
  const OTHER = 'exproute-other';
  const dirs = () => [STACK, OTHER].map((name) => path.join(process.env.COMPOSE_DIR as string, name));
  const put = (stack: string, body: object) =>
    request(app).put(`/api/stacks/${stack}/exposure`).set('Authorization', authHeader).send(body);
  const intents = async (stack: string) =>
    (await request(app).get(`/api/stacks/${stack}/exposure`).set('Authorization', authHeader)).body.intents as
      { service: string; intent: ExposureIntent }[];
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Holds the first stack validation for `stack` until `release` is called; every other one runs for real. */
  function holdValidationOf(stack: string) {
    const real = FileSystemService.prototype.hasComposeFile;
    let held = false;
    let release: (exists: boolean) => void = () => {};
    let reached: () => void = () => {};
    const reachedHold = new Promise<void>((resolve) => { reached = resolve; });
    vi.spyOn(FileSystemService.prototype, 'hasComposeFile').mockImplementation(function (this: FileSystemService, dir: string) {
      if (!held && path.basename(dir) === stack) {
        held = true;
        reached();
        return new Promise<boolean>((resolve) => { release = resolve; });
      }
      return real.call(this, dir);
    });
    return { reachedHold, release: (exists = true) => release(exists) };
  }

  /** Sends `late` first and holds it in validation, abandons its client, sends `later`, then lets `late` go on. */
  async function lateThenLater(stack: string, late: object, later: object) {
    const hold = holdValidationOf(stack);
    const lateReq = put(stack, late);
    const lateDone = lateReq.then(() => undefined, () => undefined);
    await hold.reachedHold;
    // The abort rejects the client's promise at once; the node goes on with the save when released.
    lateReq.abort();
    const laterDone = put(stack, later);
    const laterReply = laterDone.then((res) => res);
    await sleep(50);
    hold.release();
    await lateDone;
    return laterReply;
  }

  beforeEach(() => {
    for (const dir of dirs()) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'compose.yaml'), 'services:\n  web:\n    image: nginx:latest\n');
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const name of [STACK, OTHER]) DatabaseService.getInstance().deleteStackExposureIntents(1, name);
    for (const dir of dirs()) fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each(EXPOSURE_INTENTS.map((intent) => [intent]))(
    'keeps a later save of a service as %s final when an earlier save that timed out is applied late',
    async (intent) => {
      const stale: ExposureIntent = EXPOSURE_INTENTS.find((other) => other !== intent)!;
      const reply = await lateThenLater(STACK, { service: 'api', intent: stale }, { service: 'api', intent });
      expect(reply.status).toBe(200);
      expect(reply.body.intents).toEqual([expect.objectContaining({ service: 'api', intent })]);
      expect(await intents(STACK)).toEqual([expect.objectContaining({ service: 'api', intent })]);
    },
  );

  it('does not let an earlier clear that is applied late delete a later confirmed service intent', async () => {
    DatabaseService.getInstance().setStackExposureIntent(1, STACK, 'api', 'public', null);
    const reply = await lateThenLater(STACK, { service: 'api', intent: null }, { service: 'api', intent: 'internal' });
    expect(reply.status).toBe(200);
    expect(await intents(STACK)).toEqual([expect.objectContaining({ service: 'api', intent: 'internal' })]);
  });

  it('does not let an earlier stack save that is applied late bring back a stack intent a later save cleared', async () => {
    DatabaseService.getInstance().setStackExposureIntent(1, STACK, '', 'lan', null);
    const reply = await lateThenLater(STACK, { intent: 'public' }, { intent: null });
    expect(reply.status).toBe(200);
    expect(reply.body.intents).toEqual([]);
    expect(await intents(STACK)).toEqual([]);
  });

  it('keeps a later clear of a service final, so it inherits the stack intent, when an earlier save of that service is applied late', async () => {
    DatabaseService.getInstance().setStackExposureIntent(1, STACK, 'api', 'public', null);
    const reply = await lateThenLater(STACK, { service: 'api', intent: 'lan' }, { service: 'api', intent: null });
    expect(reply.status).toBe(200);
    expect(await intents(STACK)).toEqual([]);
    const inherited = await put(STACK, { intent: 'internal' });
    expect(inherited.body.intents).toEqual([expect.objectContaining({ service: '', intent: 'internal' })]);
  });

  it('applies the later save of a stack behind a held one, and replies with both', async () => {
    const hold = holdValidationOf(STACK);
    const first = put(STACK, { service: 'api', intent: 'lan' }).then((res) => res);
    await hold.reachedHold;
    const second = put(STACK, { service: 'worker', intent: 'public' }).then((res) => res);
    await sleep(50);
    expect(await intents(STACK)).toEqual([]);
    hold.release();
    expect((await first).body.intents).toEqual([expect.objectContaining({ service: 'api', intent: 'lan' })]);
    expect((await second).body.intents).toEqual([
      expect.objectContaining({ service: 'api', intent: 'lan' }),
      expect.objectContaining({ service: 'worker', intent: 'public' }),
    ]);
  });

  it('does not make another stack wait for a held save', async () => {
    const hold = holdValidationOf(STACK);
    const held = put(STACK, { service: 'api', intent: 'lan' }).then((res) => res);
    await hold.reachedHold;
    const other = await put(OTHER, { service: 'api', intent: 'public' });
    expect(other.status).toBe(200);
    hold.release();
    expect((await held).status).toBe(200);
  });

  it('applies the next save after one that found the stack gone', async () => {
    const hold = holdValidationOf(STACK);
    const gone = put(STACK, { service: 'api', intent: 'lan' }).then((res) => res);
    await hold.reachedHold;
    const next = put(STACK, { service: 'api', intent: 'public' }).then((res) => res);
    await sleep(50);
    hold.release(false);
    expect((await gone).status).toBe(404);
    expect((await next).status).toBe(200);
    expect(await intents(STACK)).toEqual([expect.objectContaining({ service: 'api', intent: 'public' })]);
  });
});
