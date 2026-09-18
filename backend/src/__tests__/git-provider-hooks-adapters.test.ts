import crypto from 'crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { verifyProviderSignature } from '../services/gitops/providerWebhooks/verify';
import { ProviderWebhookService } from '../services/gitops/providerWebhooks/ProviderWebhookService';
import { GitProviderWebhookStore } from '../services/gitops/providerWebhooks/store';
import type { GitProviderKind } from '../services/gitops/providerWebhooks/types';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

type ProviderFixture = {
  provider: GitProviderKind;
  repoUrl: string;
  eventHeader: string;
  eventValue: string;
  deliveryHeader: string;
  sign: (rawBody: Buffer, secret: string) => Record<string, string>;
  pushBody: (ref?: string) => Record<string, unknown>;
  pingBody: () => Record<string, unknown>;
  pingEventValue?: string;
};

function sha256Prefixed(rawBody: Buffer, secret: string): Record<string, string> {
  const hex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return { 'x-hub-signature-256': `sha256=${hex}` };
}

function rawHex(rawBody: Buffer, secret: string, headerName: string): Record<string, string> {
  const hex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return { [headerName]: hex };
}

const PROVIDER_FIXTURES: ProviderFixture[] = [
  {
    provider: 'github',
    repoUrl: 'https://github.com/example/repo.git',
    eventHeader: 'x-github-event',
    eventValue: 'push',
    deliveryHeader: 'x-github-delivery',
    sign: sha256Prefixed,
    pushBody: (ref = 'refs/heads/main') => ({
      ref,
      after: 'c'.repeat(40),
      repository: { clone_url: 'https://github.com/example/repo.git' },
    }),
    pingBody: () => ({ zen: 'Keep it logically awesome.' }),
    pingEventValue: 'ping',
  },
  {
    provider: 'gitlab',
    repoUrl: 'https://gitlab.com/example/repo.git',
    eventHeader: 'x-gitlab-event',
    eventValue: 'push',
    deliveryHeader: 'webhook-id',
    sign: (_rawBody, secret) => ({ 'x-gitlab-token': secret }),
    pushBody: (ref = 'refs/heads/main') => ({
      object_kind: 'push',
      ref,
      after: 'c'.repeat(40),
      project: { http_url: 'https://gitlab.com/example/repo.git' },
    }),
    pingBody: () => ({ object_kind: 'ping' }),
    pingEventValue: 'ping',
  },
  {
    provider: 'gitea',
    repoUrl: 'https://gitea.example/example/repo.git',
    eventHeader: 'x-gitea-event',
    eventValue: 'push',
    deliveryHeader: 'x-github-delivery',
    sign: (rawBody, secret) => rawHex(rawBody, secret, 'x-gitea-signature'),
    pushBody: (ref = 'refs/heads/main') => ({
      ref,
      after: 'c'.repeat(40),
      repository: { clone_url: 'https://gitea.example/example/repo.git' },
    }),
    pingBody: () => ({}),
    pingEventValue: 'ping',
  },
  {
    provider: 'forgejo',
    repoUrl: 'https://forgejo.example/example/repo.git',
    eventHeader: 'x-forgejo-event',
    eventValue: 'push',
    deliveryHeader: 'x-github-delivery',
    sign: (rawBody, secret) => rawHex(rawBody, secret, 'x-forgejo-signature'),
    pushBody: (ref = 'refs/heads/main') => ({
      ref,
      after: 'c'.repeat(40),
      repository: { clone_url: 'https://forgejo.example/example/repo.git' },
    }),
    pingBody: () => ({}),
    pingEventValue: 'ping',
  },
  {
    provider: 'bitbucket_cloud',
    repoUrl: 'https://bitbucket.org/example/repo',
    eventHeader: 'x-event-key',
    eventValue: 'repo:push',
    deliveryHeader: 'x-request-uuid',
    sign: (rawBody, secret) => {
      const hex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
      return { 'x-hub-signature': `sha256=${hex}` };
    },
    pushBody: (ref = 'refs/heads/main') => {
      const branch = ref.replace(/^refs\/heads\//, '');
      return {
        push: {
          changes: [{
            new: { name: branch, target: { hash: 'c'.repeat(40) } },
          }],
        },
        repository: { links: { html: { href: 'https://bitbucket.org/example/repo' } } },
      };
    },
    pingBody: () => ({ eventKey: 'ping' }),
    pingEventValue: 'ping',
  },
];

function seedGitSource(stackName: string, repoUrl: string, branch = 'main'): void {
  DatabaseService.getInstance().upsertGitSource({
    stack_name: stackName,
    repo_url: repoUrl,
    branch,
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
    auto_apply_on_webhook: false,
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

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  const db = DatabaseService.getInstance();
  for (const row of db.getDb().prepare('SELECT id FROM git_provider_endpoints').all() as { id: string }[]) {
    db.deleteGitProviderEndpoint(row.id);
  }
  for (const source of db.getGitSources()) {
    db.deleteGitSource(source.stack_name);
  }
});

describe.each(PROVIDER_FIXTURES)('$provider adapter signatures', (fixture) => {
  it('accepts a valid signature', () => {
    const secret = 'fixture-secret-value-1234567890';
    const rawBody = Buffer.from(JSON.stringify(fixture.pushBody()), 'utf-8');
    const headers = {
      ...fixture.sign(rawBody, secret),
      [fixture.eventHeader]: fixture.eventValue,
      [fixture.deliveryHeader]: crypto.randomUUID(),
    };

    expect(verifyProviderSignature(fixture.provider, rawBody, secret, headers)).toBe(true);
  });

  it('rejects a wrong secret', () => {
    const secret = 'fixture-secret-value-1234567890';
    const rawBody = Buffer.from(JSON.stringify(fixture.pushBody()), 'utf-8');
    const headers = {
      ...fixture.sign(rawBody, 'wrong-secret-value-12345678901'),
      [fixture.eventHeader]: fixture.eventValue,
      [fixture.deliveryHeader]: crypto.randomUUID(),
    };

    expect(verifyProviderSignature(fixture.provider, rawBody, secret, headers)).toBe(false);
  });

  it('records ping deliveries as ignored_by_policy', async () => {
    const stackName = `${fixture.provider}-ping`;
    seedGitSource(stackName, fixture.repoUrl);
    const { id, secret } = ProviderWebhookService.getInstance().createEndpoint({
      stackName,
      provider: fixture.provider,
    });
    const rawBody = Buffer.from(JSON.stringify(fixture.pingBody()), 'utf-8');
    const headers: Record<string, string> = {
      ...fixture.sign(rawBody, secret),
      [fixture.deliveryHeader]: crypto.randomUUID(),
    };
    if (fixture.pingEventValue) {
      headers[fixture.eventHeader] = fixture.pingEventValue;
    }

    const outcome = await ProviderWebhookService.getInstance().ingestLocal({
      endpointId: id,
      rawBody,
      headers,
    });

    expect(outcome.httpStatus).toBe(202);
    expect(outcome.state).toBe('ignored_by_policy');
    expect(GitProviderWebhookStore.getInstance().listDeliveries(id)[0]?.outcome_class).toBe('ping');
  });

  it('ignores push events for a non-configured ref', async () => {
    const stackName = `${fixture.provider}-wrong-ref`;
    seedGitSource(stackName, fixture.repoUrl, 'main');
    const { id, secret } = ProviderWebhookService.getInstance().createEndpoint({
      stackName,
      provider: fixture.provider,
    });
    const rawBody = Buffer.from(JSON.stringify(fixture.pushBody('refs/heads/develop')), 'utf-8');
    const headers = {
      ...fixture.sign(rawBody, secret),
      [fixture.eventHeader]: fixture.eventValue,
      [fixture.deliveryHeader]: crypto.randomUUID(),
    };

    const outcome = await ProviderWebhookService.getInstance().ingestLocal({
      endpointId: id,
      rawBody,
      headers,
    });

    expect(outcome.httpStatus).toBe(202);
    expect(outcome.state).toBe('ignored_by_policy');
    expect(GitProviderWebhookStore.getInstance().listDeliveries(id)[0]?.outcome_class).toBe('ref_policy');
  });
});
