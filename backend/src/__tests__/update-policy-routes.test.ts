/**
 * Update policy at the route boundary.
 *
 * The Compose service is mocked, but its render is a real `docker compose config`
 * answer, so these tests run the real evaluator: the stack is read from the
 * rendered model, exactly as production reads it. The assertions are on
 * observable effects: the status and code a caller sees, and whether any Compose
 * mutation or security-gate evidence happened.
 */
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin, TEST_JWT_SECRET } from './helpers/setupTestDb';
import jwt from 'jsonwebtoken';
import { renderedModel } from './__helpers__/updatePolicyFixture';

const {
  mockRenderConfig,
  mockUpdateStack,
  mockPullStackImages,
  mockGetContainersByStack,
  mockEnforcePolicy,
} = vi.hoisted(() => ({
  mockRenderConfig: vi.fn(),
  mockUpdateStack: vi.fn(),
  mockPullStackImages: vi.fn(),
  mockGetContainersByStack: vi.fn(),
  mockEnforcePolicy: vi.fn(),
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
        evaluateDockerEndpoint: async () => null,
        assertDockerEndpointSafe: async () => undefined,
        renderConfig: mockRenderConfig,
        updateStack: mockUpdateStack,
        pullStackImages: mockPullStackImages,
        updateService: vi.fn(),
      }),
    },
  };
});

vi.mock('../services/PolicyEnforcement', async () => {
  const actual = await vi.importActual<typeof import('../services/PolicyEnforcement')>(
    '../services/PolicyEnforcement',
  );
  return { ...actual, enforcePolicyPreDeploy: mockEnforcePolicy };
});

vi.mock('../services/DockerController', async () => {
  const actual = await vi.importActual<typeof import('../services/DockerController')>(
    '../services/DockerController',
  );
  return {
    ...actual,
    default: {
      ...actual.default,
      getInstance: () => ({
        getContainersByStack: mockGetContainersByStack,
        getAllContainers: vi.fn().mockResolvedValue([]),
        assertNoDockerEndpointContainers: vi.fn().mockResolvedValue(undefined),
        getDocker: () => ({ listContainers: vi.fn().mockResolvedValue([]) }),
      }),
    },
  };
});

vi.mock('../services/FileSystemService', async () => {
  const actual = await vi.importActual<typeof import('../services/FileSystemService')>(
    '../services/FileSystemService',
  );
  return {
    ...actual,
    FileSystemService: {
      ...actual.FileSystemService,
      getInstance: () => ({
        getStacks: vi.fn().mockResolvedValue(['web']),
        getBaseDir: () => '/tmp/compose',
        readComposeFile: vi.fn().mockResolvedValue(''),
        hasComposeFile: vi.fn().mockResolvedValue(true),
        getBackupInfo: vi.fn().mockResolvedValue({ exists: false }),
      }),
    },
  };
});

let tmpDir: string;
let app: import('express').Express;
let authCookie: string;

function serveModel(services: Record<string, { update?: string }>): void {
  mockRenderConfig.mockResolvedValue({
    rendered: JSON.stringify(renderedModel(services)),
    stderr: '',
    code: 0,
    timedOut: false,
  });
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  authCookie = await loginAsTestAdmin(app);
});

afterAll(() => {
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  mockRenderConfig.mockReset();
  mockUpdateStack.mockReset().mockResolvedValue({ recoveryId: null, deployedGenerationId: null, gitopsOperationId: null });
  mockPullStackImages.mockReset().mockResolvedValue({ skippedBuildBacked: [] });
  mockGetContainersByStack.mockReset().mockResolvedValue([]);
  mockEnforcePolicy.mockReset().mockResolvedValue({ ok: true, policy: null, violations: [], evidence: null });
});

describe('POST /stacks/:name/update', () => {
  it('refuses a stack with a disabled service before the security gate and before any Compose call', async () => {
    serveModel({ web: {}, db: { update: 'disabled' } });

    const res = await request(app).post('/api/stacks/web/update').set('Cookie', authCookie).send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('update_policy_blocked');
    expect(res.body.error).toContain('io.sencho.update');
    expect(res.body.updatePolicy).toMatchObject({ decision: 'block', stack: 'web' });
    // The gate writes allowed-evidence and scan rows; a refused update must not reach it.
    expect(mockEnforcePolicy).not.toHaveBeenCalled();
    expect(mockUpdateStack).not.toHaveBeenCalled();
  });

  it('allows a service set to manual for the operator own update', async () => {
    serveModel({ web: { update: 'manual' } });

    const res = await request(app).post('/api/stacks/web/update').set('Cookie', authCookie).send({});

    expect(res.status).toBe(200);
    expect(mockUpdateStack).toHaveBeenCalledTimes(1);
    expect(mockEnforcePolicy).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the model cannot be rendered', async () => {
    mockRenderConfig.mockResolvedValue({ rendered: null, stderr: 'boom', code: 1, timedOut: false });

    const res = await request(app).post('/api/stacks/web/update').set('Cookie', authCookie).send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('update_policy_blocked');
    expect(mockUpdateStack).not.toHaveBeenCalled();
  });

  it('answers a trusted webhook update with 200 skipped instead of a failure', async () => {
    serveModel({ web: { update: 'manual' } });
    const token = jwt.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });

    const res = await request(app)
      .post('/api/stacks/web/update')
      .set('Authorization', `Bearer ${token}`)
      .set('x-sencho-deploy-source', 'webhook')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('skipped');
    expect(res.body.message).toContain('io.sencho.update');
    expect(mockUpdateStack).not.toHaveBeenCalled();
  });

  it('does not let a browser session claim webhook provenance', async () => {
    serveModel({ web: { update: 'manual' } });

    // The header is only trusted on the machine-auth path, and the proxy
    // overwrites it for interactive requests. A browser that sets it is still
    // making the operator's own update: allowed under `manual`, not skipped as
    // an unattended webhook run.
    const res = await request(app)
      .post('/api/stacks/web/update')
      .set('Cookie', authCookie)
      .set('x-sencho-deploy-source', 'webhook')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.status).not.toBe('skipped');
    expect(mockUpdateStack).toHaveBeenCalledTimes(1);
  });
});

describe('POST /stacks/:name/pull-images', () => {
  it('refuses a pull when any rendered service is disabled', async () => {
    serveModel({ web: {}, db: { update: 'disabled' } });

    const res = await request(app).post('/api/stacks/web/pull-images').set('Cookie', authCookie).send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('update_policy_blocked');
    expect(mockPullStackImages).not.toHaveBeenCalled();
  });

  it('pulls when every service allows it', async () => {
    serveModel({ web: { update: 'auto' } });

    const res = await request(app).post('/api/stacks/web/pull-images').set('Cookie', authCookie).send({});

    expect(res.status).toBe(200);
    expect(mockPullStackImages).toHaveBeenCalledTimes(1);
  });
});

describe('POST /stacks/bulk with the update action', () => {
  it('reports a policy skip per stack without updating it or writing gate evidence', async () => {
    serveModel({ web: { update: 'manual' } });

    const res = await request(app)
      .post('/api/stacks/bulk')
      .set('Cookie', authCookie)
      .send({ action: 'update', stackNames: ['web'] });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      expect.objectContaining({ stackName: 'web', ok: false, code: 'update_policy_skipped' }),
    ]);
    expect(res.body.results[0].error).toContain('io.sencho.update');
    expect(mockUpdateStack).not.toHaveBeenCalled();
    expect(mockEnforcePolicy).not.toHaveBeenCalled();
  });

  it('leaves the other bulk actions alone', async () => {
    const res = await request(app)
      .post('/api/stacks/bulk')
      .set('Cookie', authCookie)
      .send({ action: 'stop', stackNames: ['web'] });

    expect(res.status).toBe(200);
    // No containers is a legitimate outcome here; what matters is that update
    // policy was never consulted for a non-update action.
    expect(res.body.results[0].code).not.toBe('update_policy_skipped');
  });
});
