/**
 * Tests for the post-deploy scan-attempt persistence + read endpoint.
 * Covers the database layer (recordStackScanAttempt / getStackScanAttempt)
 * and the GET /api/stacks/:name/scan-status route shape.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let authCookie: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

const STACK = 'web';
const NODE_ID = 1;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ app } = await import('../index'));
  authCookie = await loginAsTestAdmin(app);
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  DatabaseService.getInstance().clearStackScanAttempts(NODE_ID, STACK);
});

describe('DatabaseService stack scan attempts', () => {
  it('returns null when no attempt has been recorded', () => {
    expect(DatabaseService.getInstance().getStackScanAttempt(NODE_ID, STACK)).toBeNull();
  });

  it('records and reads back a successful attempt', () => {
    const db = DatabaseService.getInstance();
    db.recordStackScanAttempt(NODE_ID, STACK, 'ok', null);
    const row = db.getStackScanAttempt(NODE_ID, STACK);
    expect(row).not.toBeNull();
    expect(row?.status).toBe('ok');
    expect(row?.error_message).toBeNull();
    expect(typeof row?.attempted_at).toBe('number');
  });

  it('overwrites a previous attempt (one row per stack)', () => {
    const db = DatabaseService.getInstance();
    db.recordStackScanAttempt(NODE_ID, STACK, 'ok', null);
    db.recordStackScanAttempt(NODE_ID, STACK, 'failed', 'trivy crashed');
    const row = db.getStackScanAttempt(NODE_ID, STACK);
    expect(row?.status).toBe('failed');
    expect(row?.error_message).toBe('trivy crashed');
  });

  it('accepts skipped and partial statuses', () => {
    const db = DatabaseService.getInstance();
    db.recordStackScanAttempt(NODE_ID, STACK, 'skipped', 'Trivy not available');
    expect(db.getStackScanAttempt(NODE_ID, STACK)?.status).toBe('skipped');
    db.recordStackScanAttempt(NODE_ID, STACK, 'partial', '1 of 3 failed');
    expect(db.getStackScanAttempt(NODE_ID, STACK)?.status).toBe('partial');
  });

  it('clearStackScanAttempts removes the row', () => {
    const db = DatabaseService.getInstance();
    db.recordStackScanAttempt(NODE_ID, STACK, 'ok', null);
    db.clearStackScanAttempts(NODE_ID, STACK);
    expect(db.getStackScanAttempt(NODE_ID, STACK)).toBeNull();
  });

  it('keys per (nodeId, stackName) - other rows are unaffected', () => {
    const db = DatabaseService.getInstance();
    db.recordStackScanAttempt(NODE_ID, STACK, 'ok', null);
    db.recordStackScanAttempt(NODE_ID, 'api', 'failed', 'oops');
    db.recordStackScanAttempt(2, STACK, 'partial', '1 failed');
    expect(db.getStackScanAttempt(NODE_ID, STACK)?.status).toBe('ok');
    expect(db.getStackScanAttempt(NODE_ID, 'api')?.status).toBe('failed');
    expect(db.getStackScanAttempt(2, STACK)?.status).toBe('partial');
  });
});

describe('GET /api/stacks/:stackName/scan-status', () => {
  it('returns {status: null} when no scan has been attempted', async () => {
    const res = await request(app)
      .get(`/api/stacks/${STACK}/scan-status`)
      .set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: null });
  });

  it('returns the recorded attempt shape', async () => {
    DatabaseService.getInstance().recordStackScanAttempt(NODE_ID, STACK, 'failed', 'trivy missing');
    const res = await request(app)
      .get(`/api/stacks/${STACK}/scan-status`)
      .set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');
    expect(res.body.errorMessage).toBe('trivy missing');
    expect(typeof res.body.attemptedAt).toBe('number');
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).get(`/api/stacks/${STACK}/scan-status`);
    expect(res.status).toBe(401);
  });
});
