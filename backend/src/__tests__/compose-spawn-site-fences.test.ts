/**
 * Four Compose spawns that are not `ComposeService.execute` admit their process
 * against a data restore's directory fences at the spawn, by the files it
 * opens: the Git candidate validation runner, the registry reference
 * discovery's effective render, the SOPS overlay's model read, and the
 * required-variable check of a decrypted overlay. Each is given a project whose
 * `.env` is a link into the directory a restore holds, and must answer with the
 * fence (or, for the Git runner, with a failed validation worded by it) and
 * start no process; given a clear project, it starts one and holds its lease
 * until the process exits.
 *
 * Real: the project files, the link walk, the Compose file selection, the
 * admission. Stand-ins: `child_process.spawn` (a call means Docker Compose was
 * started) and the fence store's list of held directories.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import path from 'path';
import { promises as fsPromises } from 'fs';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (signal?: string) => boolean;
  args: readonly string[];
}

const spawned: FakeChild[] = [];
const spawnControl = { autoClose: true };

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn((_command: string, args: readonly string[]) => {
      const child = new EventEmitter() as FakeChild;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => true;
      child.args = args;
      spawned.push(child);
      if (spawnControl.autoClose) {
        setImmediate(() => {
          child.stdout.emit('data', Buffer.from('{"services":{"web":{"image":"nginx"}}}'));
          child.emit('close', 0);
        });
      }
      return child;
    }),
  };
});

vi.mock('../utils/debug', () => ({ isDebugEnabled: () => false }));

let tmpDir: string;
let root: string;
let project: string;
let fenced: string;
let fences: Array<{ senchoPath: string; hostPath: string; aliases: string[] }>;
let m: {
  RestoreFenceStore: typeof import('../services/recovery/restoreFence').RestoreFenceStore;
  waitForFsWorkOn: typeof import('../services/recovery/restoreFence').waitForFsWorkOn;
  fsWorkInFlightCountForTests: typeof import('../services/recovery/restoreFence').fsWorkInFlightCountForTests;
  isDataRestoreFenceError: typeof import('../helpers/dataRestoreFenceError').isDataRestoreFenceError;
  SelfIdentityService: typeof import('../services/SelfIdentityService').default;
  DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
  ComposeService: typeof import('../services/ComposeService').ComposeService;
  GitSourceService: typeof import('../services/GitSourceService').GitSourceService;
  discoverRegistryReferences: typeof import('../services/registryReferenceDiscovery').discoverRegistryReferences;
  planPersistentBindRemap: typeof import('../services/gitops/sops/persistentBinds').planPersistentBindRemap;
};

beforeAll(async () => {
  tmpDir = await setupTestDb();
  m = {
    RestoreFenceStore: (await import('../services/recovery/restoreFence')).RestoreFenceStore,
    waitForFsWorkOn: (await import('../services/recovery/restoreFence')).waitForFsWorkOn,
    fsWorkInFlightCountForTests: (await import('../services/recovery/restoreFence')).fsWorkInFlightCountForTests,
    isDataRestoreFenceError: (await import('../helpers/dataRestoreFenceError')).isDataRestoreFenceError,
    SelfIdentityService: (await import('../services/SelfIdentityService')).default,
    DatabaseService: (await import('../services/DatabaseService')).DatabaseService,
    ComposeService: (await import('../services/ComposeService')).ComposeService,
    GitSourceService: (await import('../services/GitSourceService')).GitSourceService,
    discoverRegistryReferences: (await import('../services/registryReferenceDiscovery')).discoverRegistryReferences,
    planPersistentBindRemap: (await import('../services/gitops/sops/persistentBinds')).planPersistentBindRemap,
  };
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

beforeEach(async () => {
  spawned.length = 0;
  spawnControl.autoClose = true;
  root = await fsPromises.realpath(await fsPromises.mkdtemp(path.join(tmpDir, 'site-fence-')));
  project = path.join(root, 'project');
  fenced = path.join(root, 'data');
  await fsPromises.mkdir(project, { recursive: true });
  await fsPromises.mkdir(fenced, { recursive: true });
  await fsPromises.writeFile(path.join(project, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n');
  // The project's env file is a readable link into the directory a restore holds.
  await fsPromises.writeFile(path.join(fenced, 'project.env'), 'A=1\n');
  await fsPromises.symlink(path.join('..', 'data', 'project.env'), path.join(project, '.env'));
  fences = [];
  vi.spyOn(m.SelfIdentityService.getInstance(), 'getBindMounts').mockResolvedValue(null);
  vi.spyOn(m.RestoreFenceStore.getInstance(), 'liveFencedFsTargets').mockImplementation(() => fences);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of spawned) child.emit('close', 0);
  await fsPromises.rm(root, { recursive: true, force: true });
});

function holdFence(): void {
  fences.splice(0, fences.length, { senchoPath: fenced, hostPath: fenced, aliases: [] });
}

async function refusal(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  return null;
}

describe('the Git candidate validation runner', () => {
  const run = () => (m.GitSourceService.getInstance() as unknown as {
    runDockerCompose(args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }>;
  }).runDockerCompose(['compose', '-f', 'compose.yaml', 'config', '--quiet'], project, 5_000);

  it('answers a failed validation worded by the fence, and starts no Compose process', async () => {
    holdFence();
    const result = await run();
    expect(result.code).toBe(-1);
    expect(result.stderr).toMatch(/restor/i);
    expect(spawned).toHaveLength(0);
    expect(m.fsWorkInFlightCountForTests()).toBe(0);
  });

  it('starts the validation for a clear project, and holds a fence recorded meanwhile off until it exits', async () => {
    spawnControl.autoClose = false;
    const running = run();
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    holdFence();
    await expect(m.waitForFsWorkOn(fences[0], 20)).resolves.toBe(false);
    spawned[0].emit('close', 0);
    await expect(running).resolves.toMatchObject({ code: 0 });
    await expect(m.waitForFsWorkOn(fences[0], 20)).resolves.toBe(true);
  });
});

describe('the registry reference discovery\'s effective render', () => {
  it('refuses with the fence and starts no Compose process', async () => {
    holdFence();
    const error = await refusal(m.discoverRegistryReferences(project, {}, 'web'));
    expect(m.isDataRestoreFenceError(error), String(error)).toBe(true);
    expect(spawned).toHaveLength(0);
    expect(m.fsWorkInFlightCountForTests()).toBe(0);
  });

  it('renders for a clear project, holding its lease until the process exits', async () => {
    spawnControl.autoClose = false;
    const discovered = m.discoverRegistryReferences(project, {}, 'web');
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    holdFence();
    await expect(m.waitForFsWorkOn(fences[0], 20)).resolves.toBe(false);
    spawned[0].stdout.emit('data', Buffer.from('{"services":{"web":{"image":"nginx"}}}'));
    spawned[0].emit('close', 0);
    await discovered;
    await expect(m.waitForFsWorkOn(fences[0], 20)).resolves.toBe(true);
  });
});

describe('the SOPS overlay\'s model read', () => {
  async function overlay(): Promise<{ overlayDir: string; secretsRoot: string }> {
    const secretsRoot = path.join(root, 'secrets');
    const overlayDir = path.join(secretsRoot, 'overlay');
    await fsPromises.mkdir(overlayDir, { recursive: true });
    await fsPromises.copyFile(path.join(project, 'compose.yaml'), path.join(overlayDir, 'compose.yaml'));
    await fsPromises.symlink(path.join('..', '..', 'data', 'project.env'), path.join(overlayDir, '.env'));
    return { overlayDir, secretsRoot };
  }
  const plan = async () => {
    const { overlayDir, secretsRoot } = await overlay();
    return m.planPersistentBindRemap({
      overlayDir,
      secretsRoot,
      liveRoot: project,
      liveComposeRoot: project,
      composeArgs: ['compose', '-f', 'compose.yaml'],
    });
  };

  it('refuses with the fence and starts no Compose process', async () => {
    holdFence();
    const error = await refusal(plan());
    expect(m.isDataRestoreFenceError(error), String(error)).toBe(true);
    expect(spawned).toHaveLength(0);
    expect(m.fsWorkInFlightCountForTests()).toBe(0);
  });

  it('reads the model for a clear overlay, holding its lease until the process exits', async () => {
    spawnControl.autoClose = false;
    const planned = plan();
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    holdFence();
    await expect(m.waitForFsWorkOn(fences[0], 20)).resolves.toBe(false);
    spawned[0].stdout.emit('data', Buffer.from('{"services":{"web":{"image":"nginx"}}}'));
    spawned[0].emit('close', 0);
    await planned;
    await expect(m.waitForFsWorkOn(fences[0], 20)).resolves.toBe(true);
  });
});

describe('the required-variable check of a decrypted overlay', () => {
  const check = () => (m.ComposeService.getInstance() as unknown as {
    assertRequiredEnvPresent(stack: string, overlayDir: string): Promise<void>;
  }).assertRequiredEnvPresent('app', project);

  beforeEach(async () => {
    const db = m.DatabaseService.getInstance();
    const settings = { ...db.getGlobalSettings(), env_block_deploy_on_missing_required: '1' };
    vi.spyOn(db, 'getGlobalSettings').mockReturnValue(settings);
  });

  it('refuses with the fence and starts no Compose process', async () => {
    holdFence();
    const error = await refusal(check());
    expect(m.isDataRestoreFenceError(error), String(error)).toBe(true);
    expect(spawned).toHaveLength(0);
    expect(m.fsWorkInFlightCountForTests()).toBe(0);
  });

  it('runs for a clear overlay, holding its lease until the process exits', async () => {
    spawnControl.autoClose = false;
    const checked = check();
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    holdFence();
    await expect(m.waitForFsWorkOn(fences[0], 20)).resolves.toBe(false);
    spawned[0].emit('close', 0);
    await checked;
    await expect(m.waitForFsWorkOn(fences[0], 20)).resolves.toBe(true);
  });
});
