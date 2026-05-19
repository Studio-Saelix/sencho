/**
 * Integration tests for the stack-action 404 contract (F-7).
 *
 * Verifies that POST /api/stacks/:stackName/{deploy,down,update} returns
 * HTTP 404 with `{ error: 'Stack not found' }` when the named stack has no
 * compose file under COMPOSE_DIR, instead of allowing the request to flow
 * into ComposeService and surface the raw `spawn docker ENOENT` from the
 * child_process spawn cwd failure.
 *
 * ComposeService is mocked to act as a tripwire: if any of these endpoints
 * ever reach the service layer for a nonexistent stack, the mock assertion
 * will fail loudly.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

const {
  mockDeployStack,
  mockRunCommand,
  mockUpdateStack,
} = vi.hoisted(() => ({
  mockDeployStack: vi.fn(),
  mockRunCommand: vi.fn(),
  mockUpdateStack: vi.fn(),
}));

vi.mock('../services/ComposeService', async () => {
  const actual = await vi.importActual<typeof import('../services/ComposeService')>(
    '../services/ComposeService',
  );
  return {
    ...actual,
    ComposeService: {
      ...actual.ComposeService,
      getInstance: () => ({
        deployStack: mockDeployStack,
        runCommand: mockRunCommand,
        updateStack: mockUpdateStack,
      }),
    },
  };
});

let tmpDir: string;
let app: import('express').Express;
let authCookie: string;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  authCookie = await loginAsTestAdmin(app);
});

afterAll(() => {
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

describe('POST /api/stacks/:stackName/deploy on a nonexistent stack', () => {
  it('returns 404 with "Stack not found" and never enters ComposeService.deployStack', async () => {
    mockDeployStack.mockClear();

    const res = await request(app)
      .post('/api/stacks/does-not-exist-f7/deploy')
      .set('Cookie', authCookie);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Stack not found' });
    expect(mockDeployStack).not.toHaveBeenCalled();
  });
});

describe('POST /api/stacks/:stackName/down on a nonexistent stack', () => {
  it('returns 404 with "Stack not found" and never enters ComposeService.runCommand', async () => {
    mockRunCommand.mockClear();

    const res = await request(app)
      .post('/api/stacks/does-not-exist-f7/down')
      .set('Cookie', authCookie);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Stack not found' });
    expect(mockRunCommand).not.toHaveBeenCalled();
  });
});

describe('POST /api/stacks/:stackName/update on a nonexistent stack', () => {
  it('returns 404 with "Stack not found" and never enters ComposeService.updateStack', async () => {
    mockUpdateStack.mockClear();

    const res = await request(app)
      .post('/api/stacks/does-not-exist-f7/update')
      .set('Cookie', authCookie);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Stack not found' });
    expect(mockUpdateStack).not.toHaveBeenCalled();
  });
});

describe('Invalid stack names are rejected with 400 before the existence check', () => {
  it('POST /api/stacks/..bad../deploy returns 400 Invalid stack name', async () => {
    mockDeployStack.mockClear();

    const res = await request(app)
      .post('/api/stacks/..bad../deploy')
      .set('Cookie', authCookie);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid stack name' });
    expect(mockDeployStack).not.toHaveBeenCalled();
  });
});
