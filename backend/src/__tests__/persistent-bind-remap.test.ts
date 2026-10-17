/**
 * A decrypt overlay is a temporary copy. Ordinary relative data binds must keep
 * resolving at the live stack, and overlay cleanup must not take those writes
 * with it. A decrypted secret file that is itself mounted stays on the overlay.
 * A mount that covers both is refused before Compose is asked to start anything.
 */
import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { buildSopsAgeDotenvDocument } from './helpers/sopsFixtures';
import type { ComposeInputEntry } from '../types/gitProjectManifest';
import type { RollbackInvocationRecord } from '../types/rollbackGeneration';
import {
  PERSISTENT_BIND_REFUSAL,
  PERSISTENT_BIND_UNSAFE,
  readDecryptedRelPaths,
  remapPersistentBindModel,
} from '../services/gitops/sops/persistentBinds';

let tmpDir: string;
let nodeId: number;
let composeDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let ComposeService: typeof import('../services/ComposeService').ComposeService;
let NodeRegistry: typeof import('../services/NodeRegistry').NodeRegistry;
let GitOpsDecryptOverlay: typeof import('../services/gitops/sops/overlay').GitOpsDecryptOverlay;
let buildGitOpsDecryptOverlay: typeof import('../services/gitops/sops/prepareOverlay').buildGitOpsDecryptOverlay;
let SelfIdentityService: typeof import('../services/SelfIdentityService').default;

const COMPOSE = [
  'services:',
  '  app:',
  '    image: alpine:3',
  '    volumes:',
  '      - ./data:/var/lib/app',
  '',
].join('\n');

const SECRET_AND_DATA = [
  'services:',
  '  app:',
  '    image: alpine:3',
  '    volumes:',
  '      - ./.env:/run/secrets/env:ro',
  '      - ./data:/var/lib/app',
  '',
].join('\n');

const COVERING = [
  'services:',
  '  app:',
  '    image: alpine:3',
  '    volumes:',
  '      - .:/srv/stack',
  '',
].join('\n');

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ ComposeService } = await import('../services/ComposeService'));
  ({ NodeRegistry } = await import('../services/NodeRegistry'));
  ({ GitOpsDecryptOverlay } = await import('../services/gitops/sops/overlay'));
  ({ buildGitOpsDecryptOverlay } = await import('../services/gitops/sops/prepareOverlay'));
  ({ default: SelfIdentityService } = await import('../services/SelfIdentityService'));
  nodeId = (DatabaseService.getInstance().getDb().prepare(
    'SELECT id FROM nodes WHERE is_default = 1',
  ).get() as { id: number }).id;
  composeDir = NodeRegistry.getInstance().getComposeDir(nodeId);
});

afterAll(() => cleanupTestDb(tmpDir));

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.SENCHO_MODE;
});

function bindSource(rendered: string, target: string): string | null {
  const parsed = JSON.parse(rendered) as {
    services?: Record<string, { volumes?: Array<{ type?: string; source?: string; target?: string }> }>;
  };
  for (const service of Object.values(parsed.services ?? {})) {
    for (const volume of service.volumes ?? []) {
      if (volume.type === 'bind' && volume.target === target && volume.source) return volume.source;
    }
  }
  return null;
}

async function encryptedEnv(identity: string, recipient: string): Promise<string> {
  return buildSopsAgeDotenvDocument({
    values: { TOKEN: 'decrypted-token' },
    identity,
    recipient,
  });
}

async function importIdentity(stackName: string, identity: string): Promise<void> {
  const { SopsIdentityStore } = await import('../services/gitops/sops/identityStore');
  await SopsIdentityStore.getInstance().importIdentity({
    applicationId: `app-${stackName}`,
    stackName,
    identity,
  });
}

function envInput(recipient: string): ComposeInputEntry {
  return {
    sourcePath: '.env',
    materializedPath: '.env',
    role: 'env',
    dependencyKind: 'env_file',
    ownership: 'managed',
    provenance: 'fetch',
    sensitivity: 'high',
    contentSha256: null,
    sizeBytes: null,
    state: 'present',
    deletionAuthority: 'sencho',
    note: null,
    encryption: 'sops-age',
    sopsRecipients: [recipient],
  };
}

async function writeLiveStack(stackName: string, compose: string, dataRel: string): Promise<{
  stackDir: string;
  dataDir: string;
  identity: string;
  recipient: string;
}> {
  const age = await import('age-encryption');
  const identity = await age.generateIdentity();
  const recipient = await age.identityToRecipient(identity);
  const stackDir = path.join(composeDir, stackName);
  const dataDir = path.join(stackDir, dataRel);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(stackDir, 'compose.yaml'), compose);
  fs.writeFileSync(path.join(stackDir, '.env'), await encryptedEnv(identity, recipient), { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'sentinel'), 'kept');
  await importIdentity(stackName, identity);
  return { stackDir, dataDir, identity, recipient };
}

async function openOverlay(stackName: string, stackDir: string, recipient: string) {
  const overlay = await buildGitOpsDecryptOverlay({
    stackName,
    nodeId,
    applicationId: `app-${stackName}`,
    generationId: `gen-${stackName}`,
    commitSha: 'a'.repeat(40),
    sourceRoot: stackDir,
    manifest: { inputs: [envInput(recipient)] },
  });
  expect(overlay).not.toBeNull();
  return overlay!;
}

async function renderedModel(stackName: string, overlayDir: string): Promise<string> {
  const rendered = await ComposeService.getInstance(nodeId).renderConfig(stackName, {
    stackDirOverride: overlayDir,
  });
  expect(rendered.rendered).not.toBeNull();
  return rendered.rendered!;
}

describe('decrypt overlay keeps ordinary data binds on the live stack', () => {
  it('selects the live data path and keeps writes across overlay cleanup and a later operation', async () => {
    const stackName = 'bind-live';
    const { stackDir, dataDir, recipient } = await writeLiveStack(stackName, COMPOSE, 'data');
    const first = await openOverlay(stackName, stackDir, recipient);

    const rendered = await renderedModel(stackName, first.overlayDir);
    const source = bindSource(rendered, '/var/lib/app');
    expect(source).toBe(dataDir);
    expect(rendered).not.toContain(path.join(first.overlayDir, 'data'));

    fs.writeFileSync(path.join(source!, 'written-during-deploy'), 'new');
    await GitOpsDecryptOverlay.getInstance().destroy(nodeId, stackName, first.binding.operationId);
    expect(fs.existsSync(first.overlayDir)).toBe(false);
    expect(fs.readFileSync(path.join(dataDir, 'sentinel'), 'utf8')).toBe('kept');
    expect(fs.readFileSync(path.join(dataDir, 'written-during-deploy'), 'utf8')).toBe('new');

    const second = await openOverlay(stackName, stackDir, recipient);
    const again = bindSource(await renderedModel(stackName, second.overlayDir), '/var/lib/app');
    expect(again).toBe(dataDir);
    await GitOpsDecryptOverlay.getInstance().destroy(nodeId, stackName, second.binding.operationId);
    expect(fs.existsSync(second.overlayDir)).toBe(false);
    expect(fs.readFileSync(path.join(dataDir, 'sentinel'), 'utf8')).toBe('kept');
    expect(fs.readFileSync(path.join(dataDir, 'written-during-deploy'), 'utf8')).toBe('new');
  });

  it('resolves a context-directory bind against the live project directory', async () => {
    const stackName = 'bind-ctx';
    const { stackDir, dataDir, recipient } = await writeLiveStack(stackName, COMPOSE, path.join('app', 'data'));
    DatabaseService.getInstance().upsertGitSource({
      stack_name: stackName,
      repo_url: 'https://github.com/example/repo.git',
      branch: 'main',
      compose_path: 'compose.yaml',
      compose_paths: ['compose.yaml'],
      context_dir: 'app',
      sync_env: true,
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
    DatabaseService.getInstance().setGitSourceAppliedSpec(stackName, {
      files: ['compose.yaml'],
      contextDir: 'app',
    });
    const overlay = await openOverlay(stackName, stackDir, recipient);

    const source = bindSource(await renderedModel(stackName, overlay.overlayDir), '/var/lib/app');
    expect(source).toBe(dataDir);
    fs.writeFileSync(path.join(source!, 'written-during-deploy'), 'ctx');
    await GitOpsDecryptOverlay.getInstance().destroy(nodeId, stackName, overlay.binding.operationId);
    expect(fs.readFileSync(path.join(dataDir, 'sentinel'), 'utf8')).toBe('kept');
    expect(fs.readFileSync(path.join(dataDir, 'written-during-deploy'), 'utf8')).toBe('ctx');
  });

  it('keeps the live path when Pilot host and container paths match', async () => {
    const stackName = 'bind-pilot';
    const { stackDir, dataDir, recipient } = await writeLiveStack(stackName, COMPOSE, 'data');
    process.env.SENCHO_MODE = 'pilot';
    vi.spyOn(SelfIdentityService.getInstance(), 'getBindMounts').mockResolvedValue([
      { source: composeDir, destination: composeDir },
    ]);
    const overlay = await openOverlay(stackName, stackDir, recipient);
    const compose = ComposeService.getInstance(nodeId);

    await expect((compose as unknown as {
      assertSafePilotBindMapping: (name: string, dir?: string) => Promise<void>;
    }).assertSafePilotBindMapping(stackName, overlay.overlayDir)).resolves.toBeUndefined();

    const source = bindSource(await renderedModel(stackName, overlay.overlayDir), '/var/lib/app');
    expect(source).toBe(dataDir);
    await GitOpsDecryptOverlay.getInstance().destroy(nodeId, stackName, overlay.binding.operationId);
    expect(fs.readFileSync(path.join(dataDir, 'sentinel'), 'utf8')).toBe('kept');
  });

  it('leaves a mounted secret file on the overlay and the data bind on the live stack', async () => {
    const stackName = 'bind-secret';
    const { stackDir, dataDir, recipient } = await writeLiveStack(stackName, SECRET_AND_DATA, 'data');
    const overlay = await openOverlay(stackName, stackDir, recipient);
    const rendered = await renderedModel(stackName, overlay.overlayDir);

    expect(bindSource(rendered, '/var/lib/app')).toBe(dataDir);
    expect(bindSource(rendered, '/run/secrets/env')).toBe(path.join(overlay.overlayDir, '.env'));
    await GitOpsDecryptOverlay.getInstance().destroy(nodeId, stackName, overlay.binding.operationId);
    expect(fs.readFileSync(path.join(dataDir, 'sentinel'), 'utf8')).toBe('kept');
    expect(fs.readFileSync(path.join(stackDir, '.env'), 'utf8')).not.toContain('decrypted-token');
  });

  it('refuses a mount that covers a decrypted secret and persistent data before deleting live data', async () => {
    const stackName = 'bind-cover';
    const { stackDir, dataDir, recipient } = await writeLiveStack(stackName, COVERING, 'data');
    const overlay = await openOverlay(stackName, stackDir, recipient);

    await expect(renderedModel(stackName, overlay.overlayDir)).rejects.toThrow(/decrypted secret and persistent data/);
    expect(fs.readFileSync(path.join(dataDir, 'sentinel'), 'utf8')).toBe('kept');
    await GitOpsDecryptOverlay.getInstance().destroy(nodeId, stackName, overlay.binding.operationId);
    expect(fs.readFileSync(path.join(dataDir, 'sentinel'), 'utf8')).toBe('kept');
  });

  it('applies the same live path when recovery rebuilds a captured invocation', async () => {
    const stackName = 'bind-recover';
    const { stackDir, dataDir, recipient } = await writeLiveStack(stackName, COMPOSE, 'data');
    const overlay = await openOverlay(stackName, stackDir, recipient);
    const invocation: RollbackInvocationRecord = {
      composeArgsPrefix: ['-f', 'compose.yaml', '-p', stackName],
      projectDirectory: stackDir,
      projectName: stackName,
      explicitComposeFiles: ['compose.yaml'],
    };
    const args = await ComposeService.getInstance(nodeId).buildComposeArgsWithRecoveryOverride(
      stackName,
      ['config', '--format', 'json'],
      null,
      invocation,
      overlay.overlayDir,
    );
    expect(args.some((token) => token.endsWith('.sencho-bind-remap.yml'))).toBe(true);

    const { spawn } = await import('child_process');
    const rendered = await new Promise<string>((resolve, reject) => {
      const child = spawn('docker', args, { cwd: overlay.overlayDir });
      let stdout = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`compose config exited ${code}`));
      });
    });
    expect(bindSource(rendered, '/var/lib/app')).toBe(dataDir);
    expect(rendered).not.toContain(path.join(overlay.overlayDir, 'data'));
    await GitOpsDecryptOverlay.getInstance().destroy(nodeId, stackName, overlay.binding.operationId);
    expect(fs.readFileSync(path.join(dataDir, 'sentinel'), 'utf8')).toBe('kept');
  });

  it('puts the remap layer on the deploy up arguments', async () => {
    const stackName = 'bind-up';
    const { stackDir, recipient } = await writeLiveStack(stackName, COMPOSE, 'data');
    const overlay = await openOverlay(stackName, stackDir, recipient);
    const args = await (ComposeService.getInstance(nodeId) as unknown as {
      authoredComposeArgs(name: string, action: string[], dir?: string): Promise<string[]>;
    }).authoredComposeArgs(stackName, ['up', '-d'], overlay.overlayDir);
    const remapAt = args.findIndex((token) => token.endsWith('.sencho-bind-remap.yml'));
    expect(remapAt).toBeGreaterThan(-1);
    expect(args.indexOf('up')).toBeGreaterThan(remapAt);
    await GitOpsDecryptOverlay.getInstance().destroy(nodeId, stackName, overlay.binding.operationId);
  });

  it('refuses to start containers when the overlay model cannot be read, and still returns a config read', async () => {
    const stackName = 'bind-unreadable';
    const { stackDir, dataDir, recipient } = await writeLiveStack(stackName, 'services:\n  app: [\n', 'data');
    const overlay = await openOverlay(stackName, stackDir, recipient);
    const compose = ComposeService.getInstance(nodeId);
    const authored = compose as unknown as {
      authoredComposeArgs(name: string, action: string[], dir?: string): Promise<string[]>;
    };
    await expect(authored.authoredComposeArgs(stackName, ['up', '-d'], overlay.overlayDir))
      .rejects.toThrow(PERSISTENT_BIND_UNSAFE);
    await expect(compose.buildComposeArgsWithRecoveryOverride(
      stackName,
      ['up', '-d'],
      null,
      null,
      overlay.overlayDir,
    )).rejects.toThrow(PERSISTENT_BIND_UNSAFE);
    const args = await authored.authoredComposeArgs(stackName, ['config'], overlay.overlayDir);
    expect(args.some((token) => token.endsWith('.sencho-bind-remap.yml'))).toBe(false);
    expect(fs.readFileSync(path.join(dataDir, 'sentinel'), 'utf8')).toBe('kept');
    await GitOpsDecryptOverlay.getInstance().destroy(nodeId, stackName, overlay.binding.operationId);
  });

});

describe('persistent bind decisions', () => {
  const ctx = {
    overlayRoot: '/secrets/1/stack/op',
    liveRoot: '/compose/stack',
    overlayProjectDir: '/secrets/1/stack/op',
    liveProjectDir: '/compose/stack',
    secretsRoot: '/secrets',
    decryptedRelPaths: ['.env'],
  };

  it('preserves read-only when a relative bind moves to the live stack', () => {
    const decision = remapPersistentBindModel({
      services: {
        app: {
          volumes: [{
            type: 'bind',
            source: '/secrets/1/stack/op/data',
            target: '/var/lib/app',
            read_only: true,
          }],
        },
      },
    }, ctx);
    expect(decision.ok).toBe(true);
    if (!decision.ok || !decision.override) throw new Error('expected a rewrite');
    const services = decision.override.services as Record<string, { volumes: Array<{ source: string; read_only?: boolean }> }>;
    expect(services.app.volumes[0]).toMatchObject({
      source: '/compose/stack/data',
      target: '/var/lib/app',
      read_only: true,
    });
  });

  it('leaves an external absolute bind and an exact secret-file bind unmoved', () => {
    const decision = remapPersistentBindModel({
      services: {
        app: {
          volumes: [
            { type: 'bind', source: '/srv/postgres/data', target: '/data' },
            { type: 'bind', source: '/secrets/1/stack/op/.env', target: '/run/secrets/env', read_only: true },
          ],
        },
      },
    }, ctx);
    expect(decision).toEqual({ ok: true, override: null });
  });

  it('refuses a directory that contains a decrypted secret', () => {
    const decision = remapPersistentBindModel({
      services: {
        app: {
          volumes: [{ type: 'bind', source: '/secrets/1/stack/op', target: '/srv/stack' }],
        },
      },
    }, ctx);
    expect(decision).toEqual({ ok: false, reason: PERSISTENT_BIND_REFUSAL });
  });

  it('leaves an absolute bind in another secrets directory where it was declared', () => {
    const decision = remapPersistentBindModel({
      services: {
        app: {
          volumes: [{ type: 'bind', source: '/secrets/9/other/data', target: '/data' }],
        },
      },
    }, ctx);
    expect(decision).toEqual({ ok: true, override: null });
  });

  it('moves a parent-relative bind to the live stack parent', () => {
    const decision = remapPersistentBindModel({
      services: {
        app: {
          volumes: [{ type: 'bind', source: '/secrets/1/stack/data', target: '/data' }],
        },
      },
    }, ctx);
    expect(decision.ok).toBe(true);
    if (!decision.ok || !decision.override) throw new Error('expected a rewrite');
    const services = decision.override.services as Record<string, { volumes: Array<{ source: string }> }>;
    expect(services.app.volumes[0].source).toBe('/compose/data');
  });

  it('refuses a metadata file that does not record which files were decrypted', () => {
    const root = fs.mkdtempSync(path.join(tmpDir, 'secrets-'));
    const overlay = path.join(root, '1', 'stack', 'op');
    fs.mkdirSync(overlay, { recursive: true });
    fs.writeFileSync(path.join(overlay, '.sencho-overlay.json'), JSON.stringify({ applicationId: 'app' }));
    expect(() => readDecryptedRelPaths(overlay, root)).toThrow(PERSISTENT_BIND_UNSAFE);
    fs.writeFileSync(path.join(overlay, '.sencho-overlay.json'), JSON.stringify({ decryptedRelPaths: [] }));
    expect(readDecryptedRelPaths(overlay, root)).toEqual([]);
  });
});
