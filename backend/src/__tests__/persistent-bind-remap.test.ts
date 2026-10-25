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
  PERSISTENT_BIND_RESERVED_NAME,
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

/** A named volume whose local driver binds a directory beside the compose file. */
const NAMED_LOCAL_VOLUME = [
  'services:',
  '  app:',
  '    image: alpine:3',
  '    volumes:',
  '      - localdata:/var/lib/app',
  'volumes:',
  '  localdata:',
  '    driver: local',
  '    driver_opts:',
  '      type: none',
  '      o: bind',
  '      device: ./vol-data',
  '',
].join('\n');

/** A bind that climbs two parents out of the stack directory. */
const PARENT_TWO = [
  'services:',
  '  app:',
  '    image: alpine:3',
  '    volumes:',
  '      - ../../shared:/shared',
  '',
].join('\n');

/** A bind that climbs three parents out of a context directory. */
const PARENT_THREE_FROM_CONTEXT = [
  'services:',
  '  app:',
  '    image: alpine:3',
  '    volumes:',
  '      - ../../../shared3:/shared3',
  '',
].join('\n');

/** A bind whose overlay resolution leaves Sencho's own area entirely. */
const ESCAPING_PARENTS = [
  'services:',
  '  app:',
  '    image: alpine:3',
  '    volumes:',
  '      - ../../../../escaped:/escaped',
  '',
].join('\n');

/** A relative include whose own file declares a relative bind. */
const INCLUDE = [
  'include:',
  '  - ./sub/inc.yaml',
  'services:',
  '  app:',
  '    image: alpine:3',
  '',
].join('\n');

/** A remote-export volume device, which is never a host path. */
const REMOTE_VOLUME = [
  'services:',
  '  app:',
  '    image: alpine:3',
  '    volumes:',
  '      - nfsdata:/nfs',
  'volumes:',
  '  nfsdata:',
  '    driver: local',
  '    driver_opts:',
  '      type: nfs',
  '      o: addr=10.0.0.1,rw',
  '      device: ":/export/data"',
  '',
].join('\n');

/** A directly mounted decrypted secret, and a data path, whose names both hold a literal dollar. */
const DOLLAR_BINDS = [
  'services:',
  '  app:',
  '    image: alpine:3',
  '    volumes:',
  '      - ./secret$1.env:/run/secrets/env:ro',
  '      - ./data$1:/var/lib/app',
  '',
].join('\n');

/** A mount that covers a decrypted secret in a directory whose name holds a literal dollar. */
const DOLLAR_COVER = [
  'services:',
  '  app:',
  '    image: alpine:3',
  '    volumes:',
  '      - ./secrets$1:/srv/secrets',
  '',
].join('\n');

/** A bind that names an external host directory, which no mapping changes. */
const EXTERNAL_BIND = [
  'services:',
  '  app:',
  '    image: alpine:3',
  '    volumes:',
  '      - /srv/postgres/data:/var/lib/app',
  '',
].join('\n');

/** A relative data bind and a local-driver volume device, the two forms the remap moves. */
const BIND_AND_DEVICE = [
  'services:',
  '  app:',
  '    image: alpine:3',
  '    volumes:',
  '      - ./data:/var/lib/app',
  '      - localdata:/srv/localdata',
  'volumes:',
  '  localdata:',
  '    driver: local',
  '    driver_opts:',
  '      type: none',
  '      o: bind',
  '      device: ./vol-data',
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

function volumeDevice(rendered: string, key: string): string | null {
  const parsed = JSON.parse(rendered) as {
    volumes?: Record<string, { driver_opts?: { device?: string } }>;
  };
  return parsed.volumes?.[key]?.driver_opts?.device ?? null;
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

async function openOverlay(
  stackName: string,
  stackDir: string,
  recipient: string,
  inputs?: ComposeInputEntry[],
) {
  const overlay = await buildGitOpsDecryptOverlay({
    stackName,
    nodeId,
    applicationId: `app-${stackName}`,
    generationId: `gen-${stackName}`,
    commitSha: 'a'.repeat(40),
    sourceRoot: stackDir,
    manifest: { inputs: inputs ?? [envInput(recipient)] },
  });
  expect(overlay).not.toBeNull();
  return overlay!;
}

/**
 * A Git source whose applied deploy spec names these compose files, which is
 * what the deploy and recovery argument assembly reads. `contextDir` moves the
 * Compose project directory below the stack root, as a Git source may.
 */
function recordGitSource(stackName: string, files: string[], contextDir: string | null = null): void {
  DatabaseService.getInstance().upsertGitSource({
    stack_name: stackName,
    repo_url: 'https://github.com/example/repo.git',
    branch: 'main',
    compose_path: files[0] ?? 'compose.yaml',
    compose_paths: [...files],
    context_dir: contextDir,
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
  DatabaseService.getInstance().setGitSourceAppliedSpec(stackName, { files, contextDir });
}

/** A captured generation's invocation, as a rollback rebuilds it. */
function capturedInvocation(
  stackName: string,
  stackDir: string,
  composeFile = 'compose.yaml',
): RollbackInvocationRecord {
  return {
    composeArgsPrefix: ['-f', composeFile, '-p', stackName],
    projectDirectory: stackDir,
    projectName: stackName,
    explicitComposeFiles: [composeFile],
  };
}

/** The pinned-image layer a rollback restores, as the recovery service writes it. */
function writeRecoveryOverride(stackDir: string): string {
  const file = path.join(stackDir, '.sencho-recovery-test.yml');
  fs.writeFileSync(file, 'services:\n  app:\n    image: alpine:3\n');
  return file;
}

/** The source Compose reports for one bind target, with the `$$` it renders for a literal dollar undone. */
function renderSource(rendered: string, target: string): string | null {
  const source = bindSource(rendered, target);
  return source === null ? null : source.replace(/\$\$/g, '$');
}

/**
 * Record every model the Pilot guard reads, while still running the real
 * render. What the guard was handed is the whole question for a recovery: the
 * invocation it judged has to be the one the up is about to run.
 */
function spyOnPilotRenders(compose: InstanceType<typeof ComposeService>): Array<{
  stackDirOverride?: string;
  composePrefix?: string[];
}> {
  const renders: Array<{ stackDirOverride?: string; composePrefix?: string[] }> = [];
  const realRender = compose.renderConfig.bind(compose);
  vi.spyOn(compose, 'renderConfig').mockImplementation(async (stackName, opts) => {
    renders.push({ stackDirOverride: opts?.stackDirOverride, composePrefix: opts?.composePrefix });
    return realRender(stackName, opts);
  });
  return renders;
}

async function renderedModel(stackName: string, overlayDir: string): Promise<string> {
  const rendered = await ComposeService.getInstance(nodeId).renderConfig(stackName, {
    stackDirOverride: overlayDir,
  });
  expect(rendered.rendered).not.toBeNull();
  return rendered.rendered!;
}

/** Render one explicit `docker compose` argv in a directory, as a command would. */
async function renderComposeArgs(cwd: string, args: string[]): Promise<string> {
  const { spawn } = await import('child_process');
  return new Promise<string>((resolve, reject) => {
    const child = spawn('docker', args, { cwd });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`compose config exited ${code}`));
    });
  });
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
    recordGitSource(stackName, ['compose.yaml'], 'app');
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
    const args = await ComposeService.getInstance(nodeId).buildComposeArgsWithRecoveryOverride(
      stackName,
      ['config', '--format', 'json'],
      null,
      capturedInvocation(stackName, stackDir),
      overlay.overlayDir,
    );
    expect(args.some((token) => token.endsWith('.sencho-bind-remap.yml'))).toBe(true);

    const rendered = await renderComposeArgs(overlay.overlayDir, args);
    expect(bindSource(rendered, '/var/lib/app')).toBe(dataDir);
    expect(rendered).not.toContain(path.join(overlay.overlayDir, 'data'));
    await GitOpsDecryptOverlay.getInstance().destroy(nodeId, stackName, overlay.binding.operationId);
    expect(fs.readFileSync(path.join(dataDir, 'sentinel'), 'utf8')).toBe('kept');
  });

  it('keeps a named local-volume device on the live stack across overlay cleanup', async () => {
    const stackName = 'bind-volume-device';
    const { stackDir, recipient } = await writeLiveStack(stackName, NAMED_LOCAL_VOLUME, 'vol-data');
    const deviceDir = path.join(stackDir, 'vol-data');
    fs.writeFileSync(path.join(deviceDir, 'sentinel'), 'kept');
    const overlay = await openOverlay(stackName, stackDir, recipient);

    const rendered = await renderedModel(stackName, overlay.overlayDir);
    expect(volumeDevice(rendered, 'localdata')).toBe(deviceDir);
    expect(rendered).not.toContain(path.join(overlay.overlayDir, 'vol-data'));

    fs.writeFileSync(path.join(deviceDir, 'written-during-deploy'), 'new');
    await GitOpsDecryptOverlay.getInstance().destroy(nodeId, stackName, overlay.binding.operationId);
    expect(fs.existsSync(overlay.overlayDir)).toBe(false);
    expect(fs.readFileSync(path.join(deviceDir, 'sentinel'), 'utf8')).toBe('kept');
    expect(fs.readFileSync(path.join(deviceDir, 'written-during-deploy'), 'utf8')).toBe('new');

    const second = await openOverlay(stackName, stackDir, recipient);
    expect(volumeDevice(await renderedModel(stackName, second.overlayDir), 'localdata')).toBe(deviceDir);
    await GitOpsDecryptOverlay.getInstance().destroy(nodeId, stackName, second.binding.operationId);
    expect(fs.readFileSync(path.join(deviceDir, 'sentinel'), 'utf8')).toBe('kept');
    expect(fs.readFileSync(path.join(deviceDir, 'written-during-deploy'), 'utf8')).toBe('new');

    // Recovery rebuilds its arguments through the same layer, so a rollback
    // selects the live device too.
    const third = await openOverlay(stackName, stackDir, recipient);
    const args = await ComposeService.getInstance(nodeId).buildComposeArgsWithRecoveryOverride(
      stackName,
      ['config', '--format', 'json'],
      null,
      capturedInvocation(stackName, stackDir),
      third.overlayDir,
    );
    expect(volumeDevice(await renderComposeArgs(third.overlayDir, args), 'localdata')).toBe(deviceDir);
    await GitOpsDecryptOverlay.getInstance().destroy(nodeId, stackName, third.binding.operationId);
  });

  it('leaves a remote-export volume device where the stack declared it', async () => {
    const stackName = 'bind-remote-volume';
    const { stackDir, recipient } = await writeLiveStack(stackName, REMOTE_VOLUME, 'data');
    const overlay = await openOverlay(stackName, stackDir, recipient);

    const rendered = await renderedModel(stackName, overlay.overlayDir);
    expect(volumeDevice(rendered, 'nfsdata')).toBe(':/export/data');
    expect(rendered).not.toContain(path.join(overlay.overlayDir, ':/export/data'));

    await GitOpsDecryptOverlay.getInstance().destroy(nodeId, stackName, overlay.binding.operationId);
  });

  it('refuses a rewritten local-volume device when the pilot mapping disagrees', async () => {
    const stackName = 'bind-volume-device-pilot';
    const { stackDir, recipient } = await writeLiveStack(stackName, NAMED_LOCAL_VOLUME, 'vol-data');
    process.env.SENCHO_MODE = 'pilot';
    vi.spyOn(SelfIdentityService.getInstance(), 'getBindMounts').mockResolvedValue([
      { source: '/host/compose', destination: composeDir },
    ]);
    const overlay = await openOverlay(stackName, stackDir, recipient);
    const compose = ComposeService.getInstance(nodeId);

    await expect((compose as unknown as {
      assertSafePilotBindMapping: (name: string, dir?: string) => Promise<void>;
    }).assertSafePilotBindMapping(stackName, overlay.overlayDir)).rejects.toThrow(/1:1/);

    await GitOpsDecryptOverlay.getInstance().destroy(nodeId, stackName, overlay.binding.operationId);
  });

  it('keeps a two-parent relative bind on the live tree across overlay cleanup', async () => {
    const stackName = 'bind-two-parents';
    const { stackDir, recipient } = await writeLiveStack(stackName, PARENT_TWO, 'data');
    const sharedDir = path.join(path.dirname(composeDir), 'shared');
    fs.mkdirSync(sharedDir, { recursive: true });
    fs.writeFileSync(path.join(sharedDir, 'sentinel'), 'kept');
    const overlay = await openOverlay(stackName, stackDir, recipient);

    const rendered = await renderedModel(stackName, overlay.overlayDir);
    expect(bindSource(rendered, '/shared')).toBe(sharedDir);
    expect(rendered).not.toContain(path.join(overlay.overlayDir, '..', 'shared'));

    fs.writeFileSync(path.join(sharedDir, 'written-during-deploy'), 'new');
    await GitOpsDecryptOverlay.getInstance().destroy(nodeId, stackName, overlay.binding.operationId);
    expect(fs.existsSync(overlay.overlayDir)).toBe(false);
    expect(fs.readFileSync(path.join(sharedDir, 'sentinel'), 'utf8')).toBe('kept');
    expect(fs.readFileSync(path.join(sharedDir, 'written-during-deploy'), 'utf8')).toBe('new');

    const second = await openOverlay(stackName, stackDir, recipient);
    expect(bindSource(await renderedModel(stackName, second.overlayDir), '/shared')).toBe(sharedDir);
    await GitOpsDecryptOverlay.getInstance().destroy(nodeId, stackName, second.binding.operationId);
    expect(fs.readFileSync(path.join(sharedDir, 'written-during-deploy'), 'utf8')).toBe('new');
  });

  it('keeps a three-parent relative bind from a context directory on the live tree', async () => {
    const stackName = 'bind-three-parents';
    const { stackDir, recipient } = await writeLiveStack(
      stackName,
      PARENT_THREE_FROM_CONTEXT,
      path.join('app', 'data'),
    );
    recordGitSource(stackName, ['compose.yaml'], 'app');
    const sharedDir = path.join(tmpDir, 'shared3');
    fs.mkdirSync(sharedDir, { recursive: true });
    fs.writeFileSync(path.join(sharedDir, 'sentinel'), 'kept');
    const overlay = await openOverlay(stackName, stackDir, recipient);

    const rendered = await renderedModel(stackName, overlay.overlayDir);
    expect(bindSource(rendered, '/shared3')).toBe(sharedDir);

    fs.writeFileSync(path.join(sharedDir, 'written-during-deploy'), 'new');
    await GitOpsDecryptOverlay.getInstance().destroy(nodeId, stackName, overlay.binding.operationId);
    expect(fs.readFileSync(path.join(sharedDir, 'sentinel'), 'utf8')).toBe('kept');
    expect(fs.readFileSync(path.join(sharedDir, 'written-during-deploy'), 'utf8')).toBe('new');
  });

  it('refuses a relative bind that resolves outside the overlay area and the live tree', async () => {
    const stackName = 'bind-escaping-parents';
    const { stackDir, recipient } = await writeLiveStack(stackName, ESCAPING_PARENTS, 'data');
    const overlay = await openOverlay(stackName, stackDir, recipient);

    await expect(renderedModel(stackName, overlay.overlayDir)).rejects.toThrow(PERSISTENT_BIND_UNSAFE);

    await GitOpsDecryptOverlay.getInstance().destroy(nodeId, stackName, overlay.binding.operationId);
  });

  it('keeps an included file relative bind on the live tree', async () => {
    const stackName = 'bind-include';
    const { stackDir, recipient } = await writeLiveStack(stackName, INCLUDE, path.join('sub', 'idata'));
    fs.writeFileSync(
      path.join(stackDir, 'sub', 'inc.yaml'),
      'services:\n  helper:\n    image: alpine:3\n    volumes:\n      - ./idata:/idata\n',
    );
    const includedDir = path.join(stackDir, 'sub', 'idata');
    fs.writeFileSync(path.join(includedDir, 'sentinel'), 'kept');
    const overlay = await openOverlay(stackName, stackDir, recipient);

    const rendered = await renderedModel(stackName, overlay.overlayDir);
    expect(bindSource(rendered, '/idata')).toBe(includedDir);
    expect(rendered).not.toContain(path.join(overlay.overlayDir, 'sub', 'idata'));

    fs.writeFileSync(path.join(includedDir, 'written-during-deploy'), 'new');
    await GitOpsDecryptOverlay.getInstance().destroy(nodeId, stackName, overlay.binding.operationId);
    expect(fs.readFileSync(path.join(includedDir, 'written-during-deploy'), 'utf8')).toBe('new');
  });

  it('refuses a mount covering a decrypted secret when the data root is a symlink', async () => {
    const stackName = 'bind-symlinked-cover';
    const { stackDir, recipient } = await writeLiveStack(stackName, COVERING, 'data');
    const linkPath = path.join(tmpDir, 'data-link-cover');
    fs.symlinkSync(tmpDir, linkPath);
    process.env.DATA_DIR = linkPath;
    try {
      const overlay = await openOverlay(stackName, stackDir, recipient);
      await expect(renderedModel(stackName, overlay.overlayDir))
        .rejects.toThrow(/decrypted secret and persistent data/);
      await GitOpsDecryptOverlay.getInstance().destroy(nodeId, stackName, overlay.binding.operationId);
    } finally {
      process.env.DATA_DIR = tmpDir;
    }
  });

  it('follows a symlinked data root for a data bind and keeps a mounted secret on the overlay', async () => {
    const stackName = 'bind-symlinked-data-root';
    const { stackDir, dataDir, recipient } = await writeLiveStack(stackName, SECRET_AND_DATA, 'data');
    const linkPath = path.join(tmpDir, 'data-link');
    fs.symlinkSync(tmpDir, linkPath);
    process.env.DATA_DIR = linkPath;
    try {
      const overlay = await openOverlay(stackName, stackDir, recipient);
      expect(overlay.overlayDir.startsWith(path.join(linkPath, 'git-secrets') + path.sep)).toBe(true);

      const rendered = await renderedModel(stackName, overlay.overlayDir);
      expect(bindSource(rendered, '/var/lib/app')).toBe(dataDir);
      const secretSource = bindSource(rendered, '/run/secrets/env');
      expect(secretSource).not.toBe(path.join(stackDir, '.env'));
      expect(fs.readFileSync(secretSource!, 'utf8')).toContain('decrypted-token');

      fs.writeFileSync(path.join(dataDir, 'written-during-deploy'), 'new');
      await GitOpsDecryptOverlay.getInstance().destroy(nodeId, stackName, overlay.binding.operationId);
      expect(fs.existsSync(overlay.overlayDir)).toBe(false);
      expect(fs.readFileSync(path.join(dataDir, 'written-during-deploy'), 'utf8')).toBe('new');
      expect(fs.readFileSync(path.join(stackDir, '.env'), 'utf8')).not.toContain('decrypted-token');

      const second = await openOverlay(stackName, stackDir, recipient);
      expect(bindSource(await renderedModel(stackName, second.overlayDir), '/var/lib/app')).toBe(dataDir);
      await GitOpsDecryptOverlay.getInstance().destroy(nodeId, stackName, second.binding.operationId);
      expect(fs.readFileSync(path.join(dataDir, 'written-during-deploy'), 'utf8')).toBe('new');
    } finally {
      process.env.DATA_DIR = tmpDir;
    }
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

  it('remaps persistent storage when an authored compose file ends with the generated layer name', async () => {
    const stackName = 'bind-authored-suffix';
    const authored = 'custom.sencho-bind-remap.yml';
    const { stackDir, dataDir, recipient } = await writeLiveStack(stackName, BIND_AND_DEVICE, 'data');
    const deviceDir = path.join(stackDir, 'vol-data');
    fs.mkdirSync(deviceDir, { recursive: true });
    fs.writeFileSync(path.join(deviceDir, 'sentinel'), 'kept');
    fs.renameSync(path.join(stackDir, 'compose.yaml'), path.join(stackDir, authored));
    recordGitSource(stackName, [authored]);
    const overlay = await openOverlay(stackName, stackDir, recipient);
    const compose = ComposeService.getInstance(nodeId);

    const deployArgs = await compose.buildComposeArgsWithRecoveryOverride(
      stackName,
      ['config', '--format', 'json'],
      null,
      null,
      overlay.overlayDir,
    );
    const deployModel = await renderComposeArgs(overlay.overlayDir, deployArgs);
    expect(bindSource(deployModel, '/var/lib/app')).toBe(dataDir);
    expect(volumeDevice(deployModel, 'localdata')).toBe(deviceDir);

    // Recovery rebuilds its arguments from the captured generation, so it shares
    // the same skip decision.
    const recoveryArgs = await compose.buildComposeArgsWithRecoveryOverride(
      stackName,
      ['config', '--format', 'json'],
      null,
      capturedInvocation(stackName, stackDir, authored),
      overlay.overlayDir,
    );
    const recoveryModel = await renderComposeArgs(overlay.overlayDir, recoveryArgs);
    expect(bindSource(recoveryModel, '/var/lib/app')).toBe(dataDir);
    expect(volumeDevice(recoveryModel, 'localdata')).toBe(deviceDir);

    fs.writeFileSync(path.join(dataDir, 'written-during-deploy'), 'new');
    fs.writeFileSync(path.join(deviceDir, 'written-during-deploy'), 'new');
    await GitOpsDecryptOverlay.getInstance().destroy(nodeId, stackName, overlay.binding.operationId);
    expect(fs.existsSync(overlay.overlayDir)).toBe(false);
    expect(fs.readFileSync(path.join(dataDir, 'sentinel'), 'utf8')).toBe('kept');
    expect(fs.readFileSync(path.join(dataDir, 'written-during-deploy'), 'utf8')).toBe('new');
    expect(fs.readFileSync(path.join(deviceDir, 'sentinel'), 'utf8')).toBe('kept');
    expect(fs.readFileSync(path.join(deviceDir, 'written-during-deploy'), 'utf8')).toBe('new');
  });

  it('refuses instead of overwriting an authored compose file that holds the reserved layer name', async () => {
    const stackName = 'bind-reserved-name';
    const authored = '.sencho-bind-remap.yml';
    const { stackDir, dataDir, recipient } = await writeLiveStack(stackName, COMPOSE, 'data');
    fs.renameSync(path.join(stackDir, 'compose.yaml'), path.join(stackDir, authored));
    recordGitSource(stackName, [authored]);
    const overlay = await openOverlay(stackName, stackDir, recipient);

    await expect(renderedModel(stackName, overlay.overlayDir))
      .rejects.toThrow(PERSISTENT_BIND_RESERVED_NAME);
    // The authored document is untouched in the overlay, so nothing was written
    // over it, and no container was ever handed the mismatched model.
    expect(fs.readFileSync(path.join(overlay.overlayDir, authored), 'utf8')).toBe(COMPOSE);
    expect(fs.readFileSync(path.join(dataDir, 'sentinel'), 'utf8')).toBe('kept');
    await GitOpsDecryptOverlay.getInstance().destroy(nodeId, stackName, overlay.binding.operationId);
    expect(fs.readFileSync(path.join(stackDir, authored), 'utf8')).toBe(COMPOSE);
  });

  it('refuses a recovery up that would mount a host path the Pilot mapping moves', async () => {
    const stackName = 'recover-pilot-mismatch';
    const { stackDir, dataDir, recipient } = await writeLiveStack(stackName, COMPOSE, 'data');
    process.env.SENCHO_MODE = 'pilot';
    vi.spyOn(SelfIdentityService.getInstance(), 'getBindMounts').mockResolvedValue([
      { source: '/host/compose', destination: composeDir },
    ]);
    const overlay = await openOverlay(stackName, stackDir, recipient);
    const compose = ComposeService.getInstance(nodeId);
    const execute = vi.spyOn(compose as unknown as {
      execute: (...args: unknown[]) => Promise<void>;
    }, 'execute').mockResolvedValue(undefined);
    const renders = spyOnPilotRenders(compose);
    const overridePath = writeRecoveryOverride(stackDir);

    await expect(compose.composeUpWithRecoveryOverride(
      stackName,
      overridePath,
      undefined,
      capturedInvocation(stackName, stackDir),
      { overlayDir: overlay.overlayDir, overlayBinding: overlay.binding },
    )).rejects.toThrow(/1:1/);

    // The refusal came from reading the invocation the up was about to run, and
    // it landed before the execution boundary: no Compose up was handed the
    // remapped relative mount, and the live data is still where it was.
    expect(renders).toHaveLength(1);
    expect(renders[0].stackDirOverride).toBe(overlay.overlayDir);
    expect(renders[0].composePrefix).toContain(overridePath);
    expect(execute).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(dataDir, 'sentinel'), 'utf8')).toBe('kept');
    await GitOpsDecryptOverlay.getInstance().destroy(nodeId, stackName, overlay.binding.operationId);
  });

  it('runs a recovery up when the Pilot host and container paths match 1:1', async () => {
    const stackName = 'recover-pilot-mapped';
    const { stackDir, recipient } = await writeLiveStack(stackName, COMPOSE, 'data');
    process.env.SENCHO_MODE = 'pilot';
    vi.spyOn(SelfIdentityService.getInstance(), 'getBindMounts').mockResolvedValue([
      { source: composeDir, destination: composeDir },
    ]);
    const overlay = await openOverlay(stackName, stackDir, recipient);
    const compose = ComposeService.getInstance(nodeId);
    const execute = vi.spyOn(compose as unknown as {
      execute: (...args: unknown[]) => Promise<void>;
    }, 'execute').mockResolvedValue(undefined);

    await expect(compose.composeUpWithRecoveryOverride(
      stackName,
      writeRecoveryOverride(stackDir),
      undefined,
      capturedInvocation(stackName, stackDir),
      { overlayDir: overlay.overlayDir, overlayBinding: overlay.binding },
    )).resolves.toEqual({ mutatedByCompose: true });
    expect(execute).toHaveBeenCalledTimes(1);
    await GitOpsDecryptOverlay.getInstance().destroy(nodeId, stackName, overlay.binding.operationId);
  });

  it('runs a recovery up whose only storage source is an external absolute path', async () => {
    const stackName = 'recover-pilot-external';
    const { stackDir, recipient } = await writeLiveStack(stackName, EXTERNAL_BIND, 'data');
    process.env.SENCHO_MODE = 'pilot';
    vi.spyOn(SelfIdentityService.getInstance(), 'getBindMounts').mockResolvedValue([
      { source: '/host/compose', destination: composeDir },
    ]);
    const overlay = await openOverlay(stackName, stackDir, recipient);
    const compose = ComposeService.getInstance(nodeId);
    const execute = vi.spyOn(compose as unknown as {
      execute: (...args: unknown[]) => Promise<void>;
    }, 'execute').mockResolvedValue(undefined);
    const renders = spyOnPilotRenders(compose);
    const overridePath = writeRecoveryOverride(stackDir);

    await expect(compose.composeUpWithRecoveryOverride(
      stackName,
      overridePath,
      undefined,
      capturedInvocation(stackName, stackDir),
      { overlayDir: overlay.overlayDir, overlayBinding: overlay.binding },
    )).resolves.toEqual({ mutatedByCompose: true });

    // The guard read the rebuilt invocation and let it through, so this control
    // shows a decision, not a guard that never ran.
    expect(renders).toHaveLength(1);
    expect(renders[0].stackDirOverride).toBe(overlay.overlayDir);
    expect(renders[0].composePrefix).toContain(overridePath);
    expect(execute).toHaveBeenCalledTimes(1);
    await GitOpsDecryptOverlay.getInstance().destroy(nodeId, stackName, overlay.binding.operationId);
  });

  it('keeps a literal-dollar secret mount on the decrypted overlay file and the data path on the live stack', async () => {
    const stackName = 'bind-dollar';
    const secretRel = 'secret$1.env';
    const stackDir = path.join(composeDir, stackName);
    const dataDir = path.join(stackDir, 'data$1');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), DOLLAR_BINDS);
    const age = await import('age-encryption');
    const identity = await age.generateIdentity();
    const recipient = await age.identityToRecipient(identity);
    fs.writeFileSync(path.join(stackDir, secretRel), await encryptedEnv(identity, recipient), { mode: 0o600 });
    fs.writeFileSync(path.join(dataDir, 'sentinel'), 'kept');
    await importIdentity(stackName, identity);
    const overlay = await openOverlay(stackName, stackDir, recipient, [
      { ...envInput(recipient), sourcePath: secretRel, materializedPath: secretRel, role: 'secret' },
    ]);

    const rendered = await renderedModel(stackName, overlay.overlayDir);
    const secretSource = renderSource(rendered, '/run/secrets/env');
    expect(secretSource).toBe(path.join(overlay.overlayDir, secretRel));
    expect(fs.readFileSync(secretSource!, 'utf8')).toContain('decrypted-token');
    expect(renderSource(rendered, '/var/lib/app')).toBe(dataDir);

    fs.writeFileSync(path.join(dataDir, 'written-during-deploy'), 'new');
    await GitOpsDecryptOverlay.getInstance().destroy(nodeId, stackName, overlay.binding.operationId);
    expect(fs.existsSync(overlay.overlayDir)).toBe(false);
    expect(fs.readFileSync(path.join(dataDir, 'sentinel'), 'utf8')).toBe('kept');
    expect(fs.readFileSync(path.join(dataDir, 'written-during-deploy'), 'utf8')).toBe('new');
    expect(fs.readFileSync(path.join(stackDir, secretRel), 'utf8')).not.toContain('decrypted-token');
  });

  it('refuses a mount covering a decrypted secret in a directory whose name holds a literal dollar', async () => {
    const stackName = 'bind-dollar-cover';
    const secretRel = 'secrets$1/app.env';
    const stackDir = path.join(composeDir, stackName);
    fs.mkdirSync(path.join(stackDir, path.dirname(secretRel)), { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), DOLLAR_COVER);
    const age = await import('age-encryption');
    const identity = await age.generateIdentity();
    const recipient = await age.identityToRecipient(identity);
    fs.writeFileSync(path.join(stackDir, secretRel), await encryptedEnv(identity, recipient), { mode: 0o600 });
    await importIdentity(stackName, identity);
    const overlay = await openOverlay(stackName, stackDir, recipient, [
      { ...envInput(recipient), sourcePath: secretRel, materializedPath: secretRel, role: 'secret' },
    ]);

    await expect(renderedModel(stackName, overlay.overlayDir))
      .rejects.toThrow(/decrypted secret and persistent data/);
    expect(fs.readFileSync(path.join(stackDir, secretRel), 'utf8')).not.toContain('decrypted-token');
    await GitOpsDecryptOverlay.getInstance().destroy(nodeId, stackName, overlay.binding.operationId);
  });

});

describe('persistent bind decisions', () => {
  const ctx = {
    overlayRoot: '/secrets/1/stack/op',
    liveRoot: '/compose/stack',
    liveComposeRoot: '/compose',
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
    }, ctx, new Map());
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
    }, ctx, new Map());
    expect(decision).toEqual({ ok: true, override: null });
  });

  it('refuses a directory that contains a decrypted secret', () => {
    const decision = remapPersistentBindModel({
      services: {
        app: {
          volumes: [{ type: 'bind', source: '/secrets/1/stack/op', target: '/srv/stack' }],
        },
      },
    }, ctx, new Map());
    expect(decision).toEqual({ ok: false, reason: PERSISTENT_BIND_REFUSAL });
  });

  it('leaves an absolute bind in another secrets directory where it was declared', () => {
    const decision = remapPersistentBindModel({
      services: {
        app: {
          volumes: [{ type: 'bind', source: '/secrets/9/other/data', target: '/data' }],
        },
      },
    }, ctx, new Map());
    expect(decision).toEqual({ ok: true, override: null });
  });

  it('moves a parent-relative bind to the live stack parent', () => {
    const decision = remapPersistentBindModel({
      services: {
        app: {
          volumes: [{ type: 'bind', source: '/secrets/1/stack/data', target: '/data' }],
        },
      },
    }, ctx, new Map());
    expect(decision.ok).toBe(true);
    if (!decision.ok || !decision.override) throw new Error('expected a rewrite');
    const services = decision.override.services as Record<string, { volumes: Array<{ source: string }> }>;
    expect(services.app.volumes[0].source).toBe('/compose/data');
  });

  it('moves relative sources at two and three parent segments onto the live project', () => {
    const decision = remapPersistentBindModel({
      services: {
        app: {
          volumes: [
            { type: 'bind', source: '../sibling', target: '/sibling' },
            { type: 'bind', source: '../../shared', target: '/shared' },
            { type: 'bind', source: '../../../shared3', target: '/shared3' },
          ],
        },
      },
    }, ctx, new Map());
    expect(decision.ok).toBe(true);
    if (!decision.ok || !decision.override) throw new Error('expected a rewrite');
    const services = decision.override.services as Record<string, { volumes: Array<{ source: string; target: string }> }>;
    expect(services.app.volumes.map((volume) => [volume.target, volume.source])).toEqual([
      ['/sibling', '/compose/sibling'],
      ['/shared', '/shared'],
      ['/shared3', '/shared3'],
    ]);
  });

  it('refuses a relative source that resolves outside Sencho area and the live tree', () => {
    const decision = remapPersistentBindModel({
      services: {
        app: {
          volumes: [{ type: 'bind', source: '../../../../escaped', target: '/escaped' }],
        },
      },
    }, ctx, new Map());
    expect(decision).toEqual({ ok: false, reason: PERSISTENT_BIND_UNSAFE });
  });

  it('leaves a relative source Compose rebased from an absolute include in the live tree', () => {
    const decision = remapPersistentBindModel({
      services: {
        helper: {
          volumes: [{ type: 'bind', source: '../../../../../compose/stack/shared/idata', target: '/idata' }],
        },
      },
    }, ctx, new Map());
    expect(decision).toEqual({ ok: true, override: null });
  });

  it('rewrites a named-volume device and refuses one inside the decrypt area', () => {
    const model = {
      services: { app: { volumes: [{ type: 'volume', source: 'localdata', target: '/data' }] } },
      volumes: {
        localdata: { driver: 'local', driver_opts: { type: 'none', o: 'bind', device: './vol-data' } },
      },
    };
    const rewritten = remapPersistentBindModel(
      model,
      ctx,
      new Map([['localdata', '/secrets/1/stack/op/vol-data']]),
    );
    expect(rewritten.ok).toBe(true);
    if (!rewritten.ok || !rewritten.override) throw new Error('expected a rewrite');
    expect(rewritten.override.volumes).toEqual({
      localdata: { driver_opts: { device: '/compose/stack/vol-data' } },
    });

    // A driver form Compose does not resolve against the project directory (a
    // remote export, or `o: bind,ro`) keeps the value the live run passes on.
    expect(remapPersistentBindModel(model, ctx, new Map([['localdata', ':/export/data']])))
      .toEqual({ ok: true, override: null });
    expect(remapPersistentBindModel(model, ctx, new Map())).toEqual({ ok: true, override: null });

    const secretDevice = {
      services: { app: { volumes: [{ type: 'volume', source: 'localdata', target: '/data' }] } },
      volumes: {
        localdata: { driver: 'local', driver_opts: { type: 'none', o: 'bind', device: './.env' } },
      },
    };
    expect(remapPersistentBindModel(secretDevice, ctx, new Map([['localdata', '/secrets/1/stack/op/.env']])))
      .toEqual({ ok: false, reason: PERSISTENT_BIND_REFUSAL });
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
