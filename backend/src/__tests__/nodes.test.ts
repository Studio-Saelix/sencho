/**
 * Tests for node management API - focusing on api_url validation (SSRF fix C2).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { disableCapability, enableCapability } from '../services/CapabilityRegistry';
import { NodeRegistry } from '../services/NodeRegistry';
import { CacheService } from '../services/CacheService';

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  const token = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' });
  authHeader = `Bearer ${token}`;
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

describe('POST /api/nodes - api_url SSRF validation (C2 fix)', () => {
  it('rejects localhost api_url', async () => {
    const res = await request(app)
      .post('/api/nodes')
      .set('Authorization', authHeader)
      .send({ name: 'bad-node', type: 'remote', api_url: 'http://localhost:6379' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/loopback/i);
  });

  it('rejects 127.0.0.1 api_url', async () => {
    const res = await request(app)
      .post('/api/nodes')
      .set('Authorization', authHeader)
      .send({ name: 'bad-node-2', type: 'remote', api_url: 'http://127.0.0.1:5432' });
    expect(res.status).toBe(400);
  });

  it('rejects non-http scheme', async () => {
    const res = await request(app)
      .post('/api/nodes')
      .set('Authorization', authHeader)
      .send({ name: 'bad-node-3', type: 'remote', api_url: 'ftp://example.com' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/http/i);
  });

  it('rejects malformed URL', async () => {
    const res = await request(app)
      .post('/api/nodes')
      .set('Authorization', authHeader)
      .send({ name: 'bad-node-4', type: 'remote', api_url: 'not-a-url' });
    expect(res.status).toBe(400);
  });

  it('accepts valid LAN IP', async () => {
    const res = await request(app)
      .post('/api/nodes')
      .set('Authorization', authHeader)
      .send({
        name: 'lan-node',
        type: 'remote',
        api_url: 'http://192.168.1.50:1852',
        api_token: 'sometoken',
      });
    // Should succeed (201 or 200) - not a validation error
    expect(res.status).not.toBe(400);
  });

  it('requires api_url for remote nodes', async () => {
    const res = await request(app)
      .post('/api/nodes')
      .set('Authorization', authHeader)
      .send({ name: 'missing-url', type: 'remote' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/nodes/:id/meta - local meta honors runtime-disabled capabilities', () => {
  it('omits a capability that has been disabled at runtime', async () => {
    const list = await request(app).get('/api/nodes').set('Authorization', authHeader);
    const local = (list.body as Array<{ id: number; type: string }>).find((n) => n.type === 'local');
    expect(local).toBeTruthy();

    disableCapability('vulnerability-scanning');
    try {
      const res = await request(app)
        .get(`/api/nodes/${local!.id}/meta`)
        .set('Authorization', authHeader);
      expect(res.status).toBe(200);
      expect(res.body.capabilities).toContain('stacks');
      expect(res.body.capabilities).not.toContain('vulnerability-scanning');
    } finally {
      enableCapability('vulnerability-scanning');
    }
  });
});

describe('POST /api/nodes/:id/test - invalidates remote-meta cache', () => {
  it('drops the cached meta so the next read rebuilds version and capabilities live', async () => {
    const testSpy = vi
      .spyOn(NodeRegistry.getInstance(), 'testConnection')
      .mockResolvedValue({ success: true });
    const invalidateSpy = vi.spyOn(CacheService.getInstance(), 'invalidate');
    try {
      const res = await request(app).post('/api/nodes/7/test').set('Authorization', authHeader);
      expect(res.status).toBe(200);
      expect(testSpy).toHaveBeenCalledWith(7);
      expect(invalidateSpy).toHaveBeenCalledWith('remote-meta:7');
    } finally {
      testSpy.mockRestore();
      invalidateSpy.mockRestore();
    }
  });
});

describe('Stack name validation on GET routes (H3 fix)', () => {
  it('rejects path traversal in GET /api/stacks/:stackName', async () => {
    const res = await request(app)
      .get('/api/stacks/..%2F..%2Fetc%2Fpasswd')
      .set('Authorization', authHeader);
    expect(res.status).toBe(400);
  });

  it('rejects dots in stack name', async () => {
    const res = await request(app)
      .get('/api/stacks/.hidden')
      .set('Authorization', authHeader);
    expect(res.status).toBe(400);
  });
});
