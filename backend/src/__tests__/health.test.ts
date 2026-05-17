/**
 * Tests for the public /api/health endpoint.
 * This endpoint must be reachable without authentication.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;

beforeAll(async () => {
  // setupTestDb must run before any app import so DATA_DIR is set first
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

describe('GET /api/health', () => {
  it('returns 200 with status ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('returns uptime as a number', async () => {
    const res = await request(app).get('/api/health');
    expect(typeof res.body.uptime).toBe('number');
    expect(res.body.uptime).toBeGreaterThanOrEqual(0);
  });

  it('does not require an auth token', async () => {
    // No cookie, no Authorization header - must still return 200
    const res = await request(app).get('/api/health');
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it('reports mesh.dataPlane as a typed status object', async () => {
    const res = await request(app).get('/api/health');
    expect(res.body.mesh).toBeDefined();
    expect(res.body.mesh.dataPlane).toBeDefined();
    expect(typeof res.body.mesh.dataPlane.ok).toBe('boolean');
    expect(typeof res.body.mesh.dataPlane.reason).toBe('string');
    expect(typeof res.body.mesh.dataPlane.subnet).toBe('string');
    // `message` is string or null
    expect(['string', 'object']).toContain(typeof res.body.mesh.dataPlane.message);
  });

  it('reflects an injected data-plane failure', async () => {
    const { MeshService } = await import('../services/MeshService');
    const svc = MeshService.getInstance() as unknown as {
      dataPlaneStatus: { ok: boolean; reason: string; message: string | null; subnet: string };
    };
    const prev = { ...svc.dataPlaneStatus };
    svc.dataPlaneStatus = {
      ok: false,
      reason: 'subnet_overlap',
      message: 'Pool overlaps with other one on this address space',
      subnet: '172.30.0.0/24',
    };
    try {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok'); // process is up even when mesh is down
      expect(res.body.mesh.dataPlane.ok).toBe(false);
      expect(res.body.mesh.dataPlane.reason).toBe('subnet_overlap');
      expect(res.body.mesh.dataPlane.subnet).toBe('172.30.0.0/24');
      expect(res.body.mesh.dataPlane.message).toContain('overlap');
    } finally {
      svc.dataPlaneStatus = prev;
    }
  });
});

describe('GET /api/meta experimental flag', () => {
  it('reports experimental=false by default', async () => {
    const prev = process.env.SENCHO_EXPERIMENTAL;
    delete process.env.SENCHO_EXPERIMENTAL;
    try {
      const res = await request(app).get('/api/meta');
      expect(res.status).toBe(200);
      expect(res.body.experimental).toBe(false);
    } finally {
      if (prev !== undefined) process.env.SENCHO_EXPERIMENTAL = prev;
    }
  });

  it('reports experimental=true when SENCHO_EXPERIMENTAL=true', async () => {
    const prev = process.env.SENCHO_EXPERIMENTAL;
    process.env.SENCHO_EXPERIMENTAL = 'true';
    try {
      const res = await request(app).get('/api/meta');
      expect(res.status).toBe(200);
      expect(res.body.experimental).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.SENCHO_EXPERIMENTAL;
      else process.env.SENCHO_EXPERIMENTAL = prev;
    }
  });

  it('treats any non-"true" value as false', async () => {
    const prev = process.env.SENCHO_EXPERIMENTAL;
    process.env.SENCHO_EXPERIMENTAL = '1';
    try {
      const res = await request(app).get('/api/meta');
      expect(res.body.experimental).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.SENCHO_EXPERIMENTAL;
      else process.env.SENCHO_EXPERIMENTAL = prev;
    }
  });

  it('treats an empty string as false', async () => {
    const prev = process.env.SENCHO_EXPERIMENTAL;
    process.env.SENCHO_EXPERIMENTAL = '';
    try {
      const res = await request(app).get('/api/meta');
      expect(res.body.experimental).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.SENCHO_EXPERIMENTAL;
      else process.env.SENCHO_EXPERIMENTAL = prev;
    }
  });
});
