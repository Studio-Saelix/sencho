/**
 * Docker inspect routes classify a failure from its structured status first.
 * A server error whose message happens to contain "404" must stay a 500 on
 * the legacy network, Networking, and image inspect routes, while a real 404
 * still reports the resource as missing.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import DockerController from '../services/DockerController';
import { isDockerNotFoundError } from '../utils/errors';

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;

const NETWORK_ID = 'a'.repeat(64);
const IMAGE_ID = 'b'.repeat(64);

function dockerError(message: string, statusCode?: number): Error {
  const error = new Error(message) as Error & { statusCode?: number };
  if (statusCode !== undefined) error.statusCode = statusCode;
  return error;
}

function stubDocker(overrides: Record<string, unknown>) {
  vi.spyOn(DockerController, 'getInstance').mockReturnValue({
    getDependencySnapshot: vi.fn().mockResolvedValue({ containers: [], networks: [], volumes: [] }),
    ...overrides,
  } as unknown as DockerController);
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  authHeader = `Bearer ${jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '5m' })}`;
});

afterAll(() => cleanupTestDb(tmpDir));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isDockerNotFoundError', () => {
  it('trusts a structured 404 even when the message carries no digits', () => {
    expect(isDockerNotFoundError(dockerError('resource is gone', 404))).toBe(true);
  });

  it('keeps a structured 500 a failure even when the message embeds 404', () => {
    expect(isDockerNotFoundError(dockerError('daemon failed for net404', 500))).toBe(false);
    expect(isDockerNotFoundError(dockerError('proxy answered 404 for the inspect call', 500))).toBe(false);
  });

  it('does not let a not-found phrase override a conflicting status', () => {
    expect(isDockerNotFoundError(dockerError('No such image: nginx:latest', 500))).toBe(false);
  });

  it('falls back to a standalone 404 when no status is available', () => {
    expect(isDockerNotFoundError(dockerError('request failed with 404'))).toBe(true);
  });

  it('rejects an embedded 404 in the message-only fallback', () => {
    expect(isDockerNotFoundError(dockerError('daemon failed for net404'))).toBe(false);
  });

  it('recognizes Docker not-found wording when no status is available', () => {
    expect(isDockerNotFoundError(dockerError('No such network: bridge42'))).toBe(true);
    expect(isDockerNotFoundError(dockerError('No such image: nginx:latest'))).toBe(true);
  });

  it('does not treat other resources wording as an inspect not-found', () => {
    expect(isDockerNotFoundError(dockerError('No such container: abc123'))).toBe(false);
  });

  it('reads a status from a non-Error object', () => {
    expect(isDockerNotFoundError({ statusCode: 404 })).toBe(true);
    expect(isDockerNotFoundError({ statusCode: 500 })).toBe(false);
  });

  it('is false for values that are not errors', () => {
    expect(isDockerNotFoundError(undefined)).toBe(false);
    expect(isDockerNotFoundError(null)).toBe(false);
    expect(isDockerNotFoundError('404')).toBe(false);
  });
});

describe('inspect routes with a 500 whose message contains 404', () => {
  it('keeps the legacy network inspect a 500', async () => {
    stubDocker({
      inspectNetwork: vi.fn().mockRejectedValue(dockerError('daemon failed for net404', 500)),
    });

    const res = await request(app).get(`/api/system/networks/${NETWORK_ID}`).set('Authorization', authHeader);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to inspect network' });
  });

  it('keeps the Networking inspect a 500', async () => {
    stubDocker({
      inspectNetwork: vi.fn().mockRejectedValue(dockerError('daemon failed for net404', 500)),
    });

    const res = await request(app).get(`/api/networking/networks/${NETWORK_ID}`).set('Authorization', authHeader);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to inspect network' });
  });

  it('keeps the image inspect a 500', async () => {
    stubDocker({
      inspectImage: vi.fn().mockRejectedValue(dockerError('manifest fetch returned 404 from the registry mirror', 500)),
    });

    const res = await request(app).get(`/api/system/images/${IMAGE_ID}`).set('Authorization', authHeader);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to inspect image' });
  });
});

describe('inspect routes with a structured 404', () => {
  it('reports the legacy network as missing', async () => {
    stubDocker({
      inspectNetwork: vi.fn().mockRejectedValue(dockerError('network not found', 404)),
    });

    const res = await request(app).get(`/api/system/networks/${NETWORK_ID}`).set('Authorization', authHeader);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Network not found' });
  });

  it('reports the network as missing in Networking', async () => {
    stubDocker({
      inspectNetwork: vi.fn().mockRejectedValue(dockerError('network not found', 404)),
    });

    const res = await request(app).get(`/api/networking/networks/${NETWORK_ID}`).set('Authorization', authHeader);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Network not found' });
  });

  it('reports the image as missing', async () => {
    stubDocker({
      inspectImage: vi.fn().mockRejectedValue(dockerError('no such image', 404)),
    });

    const res = await request(app).get(`/api/system/images/${IMAGE_ID}`).set('Authorization', authHeader);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Image not found' });
  });
});
