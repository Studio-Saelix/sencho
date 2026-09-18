import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { PROVIDER_WEBHOOK_BODY_LIMIT } from '../services/gitops/providerWebhooks/types';
import { GitProviderWebhookStore } from '../services/gitops/providerWebhooks/store';
import { ProviderWebhookService } from '../services/gitops/providerWebhooks/ProviderWebhookService';
import { commitBlueprintCreate } from '../services/gitops/blueprintProducers';
import { GitOpsBindingService } from '../services/gitops/binding';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions } from '../services/gitops/transitions';
import { directApplicationFixture } from './helpers/gitopsFixtures';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let LicenseService: typeof import('../services/LicenseService').LicenseService;

function nodeProxyToken(): string {
  return jwt.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });
}

function sessionToken(): string {
  return jwt.sign({ username: TEST_USERNAME, role: 'admin' }, TEST_JWT_SECRET, { expiresIn: '1m' });
}

function githubSign(rawBody: string, secret: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

function githubPushPayload(opts: {
  ref?: string;
  after?: string;
  padding?: string;
} = {}): Record<string, unknown> {
  return {
    ref: opts.ref ?? 'refs/heads/main',
    after: opts.after ?? 'a'.repeat(40),
    repository: { clone_url: 'https://github.com/example/repo.git' },
    ...(opts.padding ? { padding: opts.padding } : {}),
  };
}

function seedGitSource(stackName: string): void {
  DatabaseService.getInstance().upsertGitSource({
    stack_name: stackName,
    repo_url: 'https://github.com/example/repo.git',
    branch: 'main',
    compose_path: 'compose.yaml',
    compose_paths: ['compose.yaml'],
    context_dir: null,
    sync_env: false,
    env_path: null,
    auth_type: 'none',
    encrypted_token: null,
    encrypted_deploy_key: null,
    ssh_known_hosts_entry: null,
    ssh_host_key_fingerprint: null,
    encrypted_ca_bundle: null,
    auto_apply_on_webhook: true,
    auto_deploy_on_apply: false,
    last_applied_commit_sha: null,
    last_applied_content_hash: null,
    pending_commit_sha: null,
    pending_compose_content: null,
    pending_env_content: null,
    pending_fetched_at: null,
    last_debounce_at: null,
  });
}

function createGithubEndpoint(stackName: string): { id: string; secret: string } {
  return ProviderWebhookService.getInstance().createEndpoint({
    stackName,
    provider: 'github',
  });
}

function postInternalHook(
  endpointId: string,
  body: string,
  secret: string,
  extraHeaders: Record<string, string> = {},
  signatureBody?: string,
) {
  const signedBody = signatureBody ?? body;
  return request(app)
    .post(`/api/gitops/internal/hooks/${endpointId}`)
    .set('Authorization', `Bearer ${nodeProxyToken()}`)
    .set('Content-Type', 'application/json')
    .set('x-github-event', 'push')
    .set('x-github-delivery', crypto.randomUUID())
    .set('x-hub-signature-256', githubSign(signedBody, secret))
    .set(extraHeaders)
    .send(body);
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ LicenseService } = await import('../services/LicenseService'));
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
  GitOpsStore.resetForTests();
  GitOpsTransitions.resetForTests();
  GitOpsBindingService.resetForTests();
});

describe('git provider hooks audit R5: raw-body limits', () => {
  it('verifies a signed body larger than 100 KB on the internal path', async () => {
    const { GitSourceService } = await import('../services/GitSourceService');
    const handleSpy = vi.spyOn(GitSourceService.getInstance(), 'handleWebhookPull')
      .mockResolvedValue({ status: 'success', message: 'Queued for reconciliation.' });
    const stackName = 'provider-hook-large-body';
    seedGitSource(stackName);
    const { id, secret } = createGithubEndpoint(stackName);
    const padding = 'x'.repeat(102_401 - 120);
    const body = JSON.stringify(githubPushPayload({ padding }));

    const res = await postInternalHook(id, body, secret);

    expect(res.status).toBe(202);
    expect(res.body.state).toBe('queued');
    handleSpy.mockRestore();
  });

  it('returns 413 for bodies larger than 1 MiB on the internal path', async () => {
    const stackName = 'provider-hook-internal-413';
    seedGitSource(stackName);
    const { id, secret } = createGithubEndpoint(stackName);
    const body = JSON.stringify(githubPushPayload({ padding: 'x'.repeat(PROVIDER_WEBHOOK_BODY_LIMIT) }));

    const res = await postInternalHook(id, body, secret);

    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/too large/i);
  });

  it('returns 413 for bodies larger than 1 MiB on the public path', async () => {
    const db = DatabaseService.getInstance();
    const nodeId = db.getDefaultNode()!.id!;
    const stackName = 'provider-hook-public-413';
    seedGitSource(stackName);
    const { id, secret } = createGithubEndpoint(stackName);
    const body = JSON.stringify(githubPushPayload({ padding: 'x'.repeat(PROVIDER_WEBHOOK_BODY_LIMIT) }));

    const res = await request(app)
      .post(`/api/gitops/hooks/${nodeId}/${id}`)
      .set('Content-Type', 'application/json')
      .set('x-github-event', 'push')
      .set('x-github-delivery', crypto.randomUUID())
      .set('x-hub-signature-256', githubSign(body, secret))
      .send(body);

    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/too large/i);
  });

  it('rejects a tampered byte with the same uniform 404 as a bad signature', async () => {
    const stackName = 'provider-hook-tampered';
    seedGitSource(stackName);
    const { id, secret } = createGithubEndpoint(stackName);
    const body = JSON.stringify(githubPushPayload());
    const tampered = body.replace('"refs/heads/main"', '"refs/heads/mail"');

    const res = await postInternalHook(id, tampered, secret, {}, body);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });
});

describe('git provider hooks audit R6: unreachable remote node', () => {
  it('returns 5xx and writes no hub delivery row when the remote node is unreachable', async () => {
    const db = DatabaseService.getInstance();
    const remoteNodeId = db.addNode({
      name: 'provider-hook-remote-unreachable',
      type: 'remote',
      compose_dir: '/tmp',
      is_default: false,
      api_url: '',
      api_token: '',
    });
    const stackName = 'provider-hook-remote-stack';
    seedGitSource(stackName);
    const { id, secret } = createGithubEndpoint(stackName);
    const body = JSON.stringify(githubPushPayload());

    const res = await request(app)
      .post(`/api/gitops/hooks/${remoteNodeId}/${id}`)
      .set('Content-Type', 'application/json')
      .set('x-github-event', 'push')
      .set('x-github-delivery', crypto.randomUUID())
      .set('x-hub-signature-256', githubSign(body, secret))
      .send(body);

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(GitProviderWebhookStore.getInstance().listDeliveries(id)).toHaveLength(0);
  });
});

describe('git provider hooks audit R7: internal hop auth and policy', () => {
  it('rejects a browser session JWT on the internal hook path', async () => {
    const stackName = 'provider-hook-session-reject';
    seedGitSource(stackName);
    const { id, secret } = createGithubEndpoint(stackName);
    const body = JSON.stringify(githubPushPayload());

    const res = await request(app)
      .post(`/api/gitops/internal/hooks/${id}`)
      .set('Authorization', `Bearer ${sessionToken()}`)
      .set('Content-Type', 'application/json')
      .set('x-github-event', 'push')
      .set('x-github-delivery', crypto.randomUUID())
      .set('x-hub-signature-256', githubSign(body, secret))
      .send(body);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/machine authentication/i);
  });

  it('accepts a signed push on the internal machine-auth path and hands off to provider_event reconcile', async () => {
    const { GitSourceService } = await import('../services/GitSourceService');
    const stackName = 'provider-hook-auto-policy';
    seedGitSource(stackName);
    const { id, secret } = createGithubEndpoint(stackName);
    const body = JSON.stringify(githubPushPayload({ after: 'b'.repeat(40) }));
    const handleSpy = vi.spyOn(GitSourceService.getInstance(), 'handleWebhookPull')
      .mockResolvedValue({ status: 'success', message: 'Queued for reconciliation.' });

    const res = await postInternalHook(id, body, secret);

    expect(res.status).toBe(202);
    expect(res.body.state).toBe('queued');
    expect(handleSpy).toHaveBeenCalledWith(
      stackName,
      true,
      expect.stringMatching(new RegExp(`^provider:${id}:`)),
      { trigger: 'provider_event', actor: 'system:provider_event' },
    );
    handleSpy.mockRestore();
  });
});

describe('git provider hooks audit R8: blueprint-adopted source', () => {
  it('records ignored_by_policy and does not queue reconcile for a blueprint-adopted source', async () => {
    const stackName = 'provider-hook-blueprint-source';
    seedGitSource(stackName);
    const blueprint = commitBlueprintCreate({
      name: 'bp-provider-hook',
      description: null,
      compose_content: 'services:\n  web:\n    image: nginx:1.27\n',
      selector: { type: 'nodes', ids: [1] },
      drift_mode: 'suggest',
      classification: 'stateless',
      classification_reasons: [],
      enabled: true,
      created_by: 'tester',
    }, () => [1]);
    const application = {
      ...directApplicationFixture(`app-${stackName}`, stackName),
      configured_repo_url: 'https://github.com/example/repo.git',
    };
    GitOpsTransitions.getInstance().activateDirect({
      application,
      nodeId: 1,
      envelope: { operationId: `op-${stackName}`, actor: 'tester', trigger: 'manual', at: Date.now() },
    });
    GitOpsBindingService.getInstance().convertInlineToGit({
      blueprintId: blueprint.id,
      applicationId: application.id,
      actor: 'tester',
    });

    const { id, secret } = createGithubEndpoint(stackName);
    const body = JSON.stringify(githubPushPayload());
    const res = await postInternalHook(id, body, secret);

    expect(res.status).toBe(202);
    expect(res.body.state).toBe('ignored_by_policy');
    expect(res.body.message).toMatch(/blueprint/i);
    const deliveries = GitProviderWebhookStore.getInstance().listDeliveries(id);
    expect(deliveries[0]?.state).toBe('ignored_by_policy');
    expect(
      DatabaseService.getInstance().getDb()
        .prepare("SELECT COUNT(*) AS n FROM gitops_history WHERE trigger = 'provider_event'")
        .get() as { n: number },
    ).toEqual({ n: 0 });
  });
});
