/**
 * Rescan from the post-deploy scan banner: POST /api/stacks/:stackName/scan-status/rescan
 * starts the same scan a deploy starts, for the request node and the named
 * stack only, answers before the scan ends, and starts nothing a second time
 * while one is running.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import DockerController from '../services/DockerController';
import TrivyService from '../services/TrivyService';
import { classifyStackApiPath } from '../helpers/stackRouteAuth';

let tmpDir: string;
let app: import('express').Express;
let adminAuth: string;
let viewerAuth: string;
let deployerAuth: string;
let otherStackDeployerAuth: string;
let nodeId: number;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

const STACK = 'web';
const OTHER = 'other';

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ DatabaseService } = await import('../services/DatabaseService'));
  const db = DatabaseService.getInstance();
  nodeId = db.getNodes().find((node) => node.is_default)!.id;

  const sign = (username: string, tv: number) =>
    `Bearer ${jwt.sign({ username, role: 'viewer', tv }, TEST_JWT_SECRET, { expiresIn: '5m' })}`;
  adminAuth = `Bearer ${jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '5m' })}`;
  const addViewer = async (username: string) => {
    db.addUser({ username, password_hash: await bcrypt.hash('password123', 1), role: 'viewer' });
    return db.getUserByUsername(username)!;
  };
  viewerAuth = sign('rescan-viewer', (await addViewer('rescan-viewer')).token_version);
  const deployer = await addViewer('rescan-deployer');
  db.addRoleAssignment({ user_id: deployer.id, role: 'deployer', resource_type: 'stack', resource_id: STACK, node_id: nodeId });
  deployerAuth = sign('rescan-deployer', deployer.token_version);
  const elsewhere = await addViewer('rescan-elsewhere');
  db.addRoleAssignment({ user_id: elsewhere.id, role: 'deployer', resource_type: 'stack', resource_id: OTHER, node_id: nodeId });
  otherStackDeployerAuth = sign('rescan-elsewhere', elsewhere.token_version);
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Docker lists no containers until `release` is called, so a scan stays "running" for as long as a test needs. */
function stubScan(containers: Array<{ Image: string }>) {
  const gate = deferred<Array<{ Image: string }>>();
  const listContainers = vi.fn().mockReturnValue(gate.promise);
  const getDocker = vi.fn().mockReturnValue({ listContainers });
  vi.spyOn(DockerController, 'getInstance').mockReturnValue({ getDocker } as unknown as DockerController);
  const trivy = TrivyService.getInstance();
  vi.spyOn(trivy, 'isTrivyAvailable').mockReturnValue(true);
  vi.spyOn(trivy, 'getImageDigest').mockResolvedValue(null);
  const runScan = vi.spyOn(trivy, 'runScanAndPersist').mockResolvedValue({ critical_count: 0, high_count: 0 } as never);
  return { listContainers, runScan, release: () => gate.resolve(containers) };
}

const rescan = (auth = adminAuth, stack = STACK) =>
  request(app).post(`/api/stacks/${stack}/scan-status/rescan`).set('Authorization', auth);
const status = (stack = STACK) =>
  request(app).get(`/api/stacks/${stack}/scan-status`).set('Authorization', adminAuth);

/** Waits for the scan that `release` lets finish to write its attempt row. */
async function untilIdle(stack = STACK): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (!(await status(stack)).body.scanning) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('the scan never finished');
}

beforeEach(() => {
  for (const name of [STACK, OTHER]) {
    fs.mkdirSync(path.join(process.env.COMPOSE_DIR as string, name), { recursive: true });
    fs.writeFileSync(path.join(process.env.COMPOSE_DIR as string, name, 'compose.yaml'), 'services:\n  web:\n    image: nginx:1.27\n');
    DatabaseService.getInstance().clearStackScanAttempts(nodeId, name);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/stacks/:stackName/scan-status/rescan', () => {
  it('starts a scan, answers before it ends, and records a new attempt for that stack only', async () => {
    const db = DatabaseService.getInstance();
    db.recordStackScanAttempt(nodeId, STACK, 'failed', '1 image(s) failed to scan');
    db.recordStackScanAttempt(nodeId, OTHER, 'failed', 'left alone');
    db.getDb().prepare('UPDATE stack_scan_attempts SET attempted_at = attempted_at - 5000 WHERE node_id = ? AND stack_name = ?').run(nodeId, STACK);
    const before = db.getStackScanAttempt(nodeId, STACK)!.attempted_at;
    const scan = stubScan([{ Image: 'nginx:1.27' }]);

    const res = await rescan(deployerAuth);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ started: true, scanning: true });
    // The route has answered while Docker has not: the scan is still running.
    const running = await status();
    expect(running.body).toMatchObject({ status: 'failed', scanning: true });
    expect(scan.listContainers).toHaveBeenCalledWith({
      all: true,
      filters: { label: [`com.docker.compose.project=${STACK}`] },
    });

    scan.release();
    await untilIdle();
    const after = await status();
    expect(after.body).toMatchObject({ status: 'ok', scanning: false });
    expect(after.body.attemptedAt).toBeGreaterThan(before);
    expect(scan.runScan).toHaveBeenCalledTimes(1);
    expect(scan.runScan.mock.calls[0]?.[3]).toBe(STACK);
    expect(db.getStackScanAttempt(nodeId, OTHER)).toMatchObject({ status: 'failed', error_message: 'left alone' });
  });

  it('starts nothing a second time while a scan is running', async () => {
    const scan = stubScan([{ Image: 'nginx:1.27' }]);
    const first = await rescan();
    expect(first.body.started).toBe(true);

    const second = await rescan();
    expect(second.status).toBe(202);
    expect(second.body).toEqual({ started: false, scanning: true });
    expect(scan.listContainers).toHaveBeenCalledTimes(1);

    scan.release();
    await untilIdle();
    expect(scan.runScan).toHaveBeenCalledTimes(1);
    // Finished, so the next click is a new scan again.
    expect((await status()).body.scanning).toBe(false);
  });

  it('records a failed result, and is free to run again afterwards', async () => {
    const scan = stubScan([{ Image: 'nginx:1.27' }]);
    scan.runScan.mockRejectedValueOnce(new Error('registry unreachable'));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

    await rescan();
    scan.release();
    await untilIdle();
    const failed = await status();
    expect(failed.body.status).toBe('failed');
    expect(failed.body.scanning).toBe(false);

    // The attempt that failed must not leave the stack looking busy forever.
    const again = await rescan();
    expect(again.body.started).toBe(true);
    await untilIdle();
    quiet.mockRestore();
  });

  it('reports a stack with nothing running as skipped, not as never scanned', async () => {
    const scan = stubScan([]);
    await rescan();
    scan.release();
    await untilIdle();
    expect(await status()).toMatchObject({ body: { status: 'skipped', errorMessage: 'No images to scan', scanning: false } });
    expect(scan.runScan).not.toHaveBeenCalled();
  });

  it('refuses a viewer, and a deployer of a different stack, without scanning', async () => {
    const scan = stubScan([]);
    expect((await rescan(viewerAuth)).status).toBe(403);
    expect((await rescan(otherStackDeployerAuth)).status).toBe(403);
    expect(scan.listContainers).not.toHaveBeenCalled();
    expect((await status()).body.scanning).toBe(false);
  });

  it('answers 404 for a stack that does not exist', async () => {
    const scan = stubScan([]);
    expect((await rescan(adminAuth, 'ghost')).status).toBe(404);
    expect(scan.listContainers).not.toHaveBeenCalled();
  });

  it('is classified as a deploy on the named stack for the remote hop', () => {
    expect(classifyStackApiPath('POST', '/stacks/web/scan-status/rescan'))
      .toEqual({ kind: 'named-stack', stackName: 'web', action: 'stack:deploy' });
    expect(classifyStackApiPath('GET', '/stacks/web/scan-status/rescan')).toEqual({ kind: 'unknown-named' });
  });
});
