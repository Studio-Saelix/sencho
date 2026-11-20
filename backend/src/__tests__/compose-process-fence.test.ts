/**
 * Every Docker Compose process Sencho starts is matched against a data
 * restore's directory fences at its spawn, by the files it actually opens
 * (its `-f` files, else the COMPOSE_FILE selection or the discovered root and
 * override, and its env files), and is registered until it exits, so a fence
 * recorded while it runs waits for it. A deploy and an update admit their `up`
 * before their first irreversible step and hold it until the up exits, and a
 * rollback registers its whole file set before its first write.
 *
 * Real: the stack files, the link walk, the selection, the admission and the
 * drain. Stand-ins: `child_process.spawn` (a call means Docker Compose was
 * started), the fence store's list of held directories, Sencho's own mounts
 * ("not in a container"), and a minimal node registry and database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import path from 'path';
import os from 'os';
import { promises as fsPromises } from 'fs';

const mockState = { composeDir: '', meshEnabled: false };

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (signal?: string) => boolean;
  args: readonly string[];
}

const spawned: FakeChild[] = [];
/** When false, a spawned child stays running until the test closes it. */
const spawnControl = { autoClose: true, stdout: '{"services":{}}' };

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
          child.stdout.emit('data', Buffer.from(spawnControl.stdout));
          child.emit('close', 0);
        });
      }
      return child;
    }),
  };
});

vi.mock('../services/NodeRegistry', () => ({
  NodeRegistry: {
    getInstance: () => ({
      getComposeDir: () => mockState.composeDir,
      getDefaultNodeId: () => 1,
      getNode: () => ({ id: 1, type: 'local' }),
      getDocker: () => ({ listContainers: async () => [] }),
    }),
  },
}));

vi.mock('../utils/debug', () => ({ isDebugEnabled: () => false }));

vi.mock('../services/DatabaseService', () => ({
  DatabaseService: {
    getInstance: () => ({
      getGitSource: () => undefined,
      getStackProjectEnvFiles: () => [],
      isMeshStackEnabled: () => mockState.meshEnabled,
      getRegistries: () => [],
      getGlobalSettings: () => ({}),
    }),
  },
}));

import { ComposeService } from '../services/ComposeService';
import { FileSystemService } from '../services/FileSystemService';
import { MeshService } from '../services/MeshService';
import DockerController from '../services/DockerController';
import { RestoreFenceStore, waitForFsWorkOn, fsWorkInFlightCountForTests } from '../services/recovery/restoreFence';
import SelfIdentityService from '../services/SelfIdentityService';
import { isDataRestoreFenceError } from '../helpers/dataRestoreFenceError';
import { isDockerEndpointProtectedError } from '../helpers/dockerEndpointError';
import { composeSelectedInputPaths } from '../helpers/composeExpansionGuard';
import { resolveUpdatePolicy } from '../services/updatePolicy';

const NODE = 1;

describe('a Compose process is admitted by the files it opens, and held until it exits', () => {
  let root: string;
  let composeDir: string;
  let dataDir: string;
  let stackDir: string;
  let fenced: string;
  let fences: Array<{ senchoPath: string; hostPath: string; aliases: string[] }>;
  let originalDataDir: string | undefined;
  let originalComposeFile: string | undefined;

  beforeEach(async () => {
    root = await fsPromises.realpath(await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-proc-fence-')));
    composeDir = path.join(root, 'compose');
    dataDir = path.join(root, 'data');
    stackDir = path.join(composeDir, 'app');
    fenced = path.join(stackDir, 'data');
    await fsPromises.mkdir(fenced, { recursive: true });
    await fsPromises.mkdir(dataDir, { recursive: true });
    mockState.composeDir = composeDir;
    mockState.meshEnabled = false;
    originalDataDir = process.env.DATA_DIR;
    originalComposeFile = process.env.COMPOSE_FILE;
    delete process.env.COMPOSE_FILE;
    process.env.DATA_DIR = dataDir;
    spawned.length = 0;
    spawnControl.autoClose = true;
    // A clear root file, and an override that is a readable link into the
    // directory a restore is overwriting. No COMPOSE_FILE: discovery opens both.
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n');
    await fsPromises.writeFile(path.join(fenced, 'compose.override.yml'), 'services: {}\n');
    await fsPromises.symlink(path.join('data', 'compose.override.yml'), path.join(stackDir, 'compose.override.yml'));
    fences = [];
    vi.spyOn(SelfIdentityService.getInstance(), 'getBindMounts').mockResolvedValue(null);
    vi.spyOn(RestoreFenceStore.getInstance(), 'liveFencedFsTargets').mockImplementation(() => fences);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const child of spawned) child.emit('close', 0);
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    if (originalComposeFile === undefined) delete process.env.COMPOSE_FILE;
    else process.env.COMPOSE_FILE = originalComposeFile;
    await fsPromises.rm(root, { recursive: true, force: true });
  });

  function holdFence(dir: string = fenced): void {
    fences.splice(0, fences.length, { senchoPath: dir, hostPath: dir, aliases: [] });
  }

  async function refusal(work: Promise<unknown>): Promise<unknown> {
    try {
      await work;
    } catch (error) {
      return error;
    }
    return null;
  }

  async function makeInverseFixture(): Promise<void> {
    // Root and override clear; the COMPOSE_FILE layer is in the held directory.
    await fsPromises.rm(path.join(stackDir, 'compose.override.yml'));
    await fsPromises.writeFile(path.join(stackDir, 'compose.override.yml'), 'services: {}\n');
    await fsPromises.writeFile(path.join(fenced, 'layer.yml'), 'services: {}\n');
    await fsPromises.writeFile(path.join(stackDir, '.env'), 'COMPOSE_FILE=compose.yaml:data/layer.yml\n');
  }

  describe('which files a Compose run opens', () => {
    it('names the discovered root and override for an argv with no file, and the env file', async () => {
      const paths = await composeSelectedInputPaths({ cwd: stackDir, invocation: ['compose', 'config'] });
      expect(paths).toEqual([
        path.join(stackDir, '.env'),
        path.join(stackDir, 'compose.yaml'),
        path.join(stackDir, 'compose.override.yml'),
      ]);
    });

    it('names a COMPOSE_FILE selection from the env file or from the environment instead of discovery', async () => {
      await makeInverseFixture();
      const fromFile = await composeSelectedInputPaths({ cwd: stackDir, invocation: ['compose', 'config'] });
      expect(fromFile).toContain(path.join(fenced, 'layer.yml'));
      expect(fromFile).not.toContain(path.join(stackDir, 'compose.override.yml'));
      await fsPromises.rm(path.join(stackDir, '.env'));
      const fromEnv = await composeSelectedInputPaths({
        cwd: stackDir,
        invocation: ['compose', 'config'],
        env: (name) => (name === 'COMPOSE_FILE' ? 'data/layer.yml' : undefined),
      });
      expect(fromEnv).toContain(path.join(fenced, 'layer.yml'));
    });

    it('names only the -f files when the argv names some, whatever COMPOSE_FILE says', async () => {
      await makeInverseFixture();
      const paths = await composeSelectedInputPaths({ cwd: stackDir, invocation: ['compose', '-f', 'compose.yaml', '-f', 'compose.override.yml', 'up'] });
      expect(paths).not.toContain(path.join(fenced, 'layer.yml'));
      expect(paths).toContain(path.join(stackDir, 'compose.override.yml'));
    });

    it('stops the override candidates at the first one present, keeping a dangling one before it', async () => {
      await fsPromises.rm(path.join(stackDir, 'compose.override.yml'));
      await fsPromises.writeFile(path.join(stackDir, 'docker-compose.override.yml'), 'services: {}\n');
      await fsPromises.writeFile(path.join(fenced, 'shadowed.yml'), 'services: {}\n');
      await fsPromises.symlink(path.join('data', 'gone.yml'), path.join(stackDir, 'compose.override.yaml'));
      const paths = await composeSelectedInputPaths({ cwd: stackDir, invocation: ['compose', 'config'] });
      const overrides = paths.filter((p) => p.includes('override'));
      // compose.override.yml is missing, compose.override.yaml dangles, docker-compose.override.yml wins.
      expect(overrides.map((p) => path.basename(p))).toEqual(['compose.override.yml', 'compose.override.yaml', 'docker-compose.override.yml']);
    });
  });

  describe('the renders a mutation runs before its own checks', () => {
    it('refuses a render that names no file, by the override discovery opens, and starts no Compose process', async () => {
      holdFence();
      const error = await refusal(ComposeService.getInstance(NODE).renderConfig('app'));
      expect(isDataRestoreFenceError(error), String(error)).toBe(true);
      expect(spawned).toHaveLength(0);
    });

    it('refuses a render whose COMPOSE_FILE layer is held, from the env file and from the environment', async () => {
      await makeInverseFixture();
      holdFence();
      expect(isDataRestoreFenceError(await refusal(ComposeService.getInstance(NODE).renderConfig('app')))).toBe(true);
      await fsPromises.rm(path.join(stackDir, '.env'));
      process.env.COMPOSE_FILE = 'compose.yaml:data/layer.yml';
      expect(isDataRestoreFenceError(await refusal(ComposeService.getInstance(NODE).renderConfig('app')))).toBe(true);
      expect(spawned).toHaveLength(0);
    });

    it('refuses a render of a captured or spec prefix that names a held file', async () => {
      await fsPromises.writeFile(path.join(fenced, 'captured.yml'), 'services: {}\n');
      holdFence();
      const error = await refusal(ComposeService.getInstance(NODE).renderConfig('app', {
        composePrefix: ['compose', '-f', 'compose.yaml', '-f', 'data/captured.yml'],
      }));
      expect(isDataRestoreFenceError(error), String(error)).toBe(true);
      expect(spawned).toHaveLength(0);
    });

    it('the inverse Mesh fixture: the pinned command is admitted, the unpinned preliminary renders are refused and pass the fence on', async () => {
      await makeInverseFixture();
      const meshLayer = path.join(dataDir, 'mesh.override.yml');
      await fsPromises.writeFile(meshLayer, 'services: {}\n');
      vi.spyOn(MeshService.getInstance(), 'ensureStackOverride').mockResolvedValue(meshLayer);
      mockState.meshEnabled = true;
      holdFence();
      const svc = ComposeService.getInstance(NODE);
      // The pinned argv names root, override and the Mesh layer: Compose
      // ignores COMPOSE_FILE then, so the held layer is not an input.
      await expect(svc.validateExactComposeInvocation('app')).resolves.toBeUndefined();
      expect(spawned).toHaveLength(1);
      expect(spawned[0].args).toEqual(expect.arrayContaining(['-f', meshLayer, 'config', '--quiet']));
      // The unpinned render (the endpoint guard's, the required-variable
      // check's) reads the held layer: the fence answers, and the guard passes
      // that on (docker-endpoint-guard.test.ts), not "could not render".
      const rendered = await refusal(svc.renderConfig('app'));
      expect(isDataRestoreFenceError(rendered), String(rendered)).toBe(true);
      expect(isDockerEndpointProtectedError(rendered)).toBe(false);
      // The update policy's render: the fence, not an unrenderable policy.
      const policy = await refusal(resolveUpdatePolicy(NODE, { stack: 'app', target: { scope: 'stack' }, trigger: 'manual' }));
      expect(isDataRestoreFenceError(policy), String(policy)).toBe(true);
      expect(spawned).toHaveLength(1);
    });

    it('admits a render whose files are clear of the held directory', async () => {
      await fsPromises.mkdir(path.join(root, 'elsewhere'));
      holdFence(path.join(root, 'elsewhere'));
      const result = await ComposeService.getInstance(NODE).renderConfig('app');
      expect(result.rendered).not.toBeNull();
      expect(spawned).toHaveLength(1);
      expect(fsWorkInFlightCountForTests()).toBe(0);
    });
  });

  describe('a process already running when the fence is recorded', () => {
    it('is waited for by the restore until it exits, and only then is the directory clear', async () => {
      spawnControl.autoClose = false;
      const svc = ComposeService.getInstance(NODE);
      const render = svc.renderConfig('app');
      await vi.waitFor(() => expect(spawned).toHaveLength(1));
      // The restore records its fence now and drains the work on the directory.
      holdFence();
      const target = fences[0];
      await expect(waitForFsWorkOn(target, 50)).resolves.toBe(false);
      spawned[0].stdout.emit('data', Buffer.from('{}'));
      spawned[0].emit('close', 0);
      await render;
      await expect(waitForFsWorkOn(target, 50)).resolves.toBe(true);
    });

    it('does not hold off a fence on a directory it does not open', async () => {
      spawnControl.autoClose = false;
      const render = ComposeService.getInstance(NODE).renderConfig('app');
      await vi.waitFor(() => expect(spawned).toHaveLength(1));
      await fsPromises.mkdir(path.join(root, 'elsewhere'));
      holdFence(path.join(root, 'elsewhere'));
      await expect(waitForFsWorkOn(fences[0], 50)).resolves.toBe(true);
      spawned[0].emit('close', 0);
      await render;
    });
  });

  describe('a deploy and an update admit their up before their first irreversible step', () => {
    function stubPreliminaries(svc: ComposeService): { execute: ReturnType<typeof vi.spyOn> } {
      const inner = svc as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      vi.spyOn(inner, 'assertSopsOverlayOrRefuse').mockResolvedValue(undefined);
      vi.spyOn(inner, 'ensureExternalNetworksForDeploy').mockResolvedValue(undefined);
      vi.spyOn(inner, 'noteComposeVersionSkew').mockResolvedValue(undefined);
      vi.spyOn(inner, 'supersedeGatesForContainerOp').mockResolvedValue(undefined);
      vi.spyOn(svc, 'evaluateDockerEndpoint').mockResolvedValue(null);
      return { execute: vi.spyOn(inner, 'execute').mockResolvedValue(undefined) };
    }

    it('refuses a verified deploy whose up became fenced during the verification pull: no orphan removed, no up, no GitOps record', async () => {
      const svc = ComposeService.getInstance(NODE);
      const { execute } = stubPreliminaries(svc);
      const begin = vi.spyOn(svc as unknown as { beginGitOpsDeploy: () => null }, 'beginGitOpsDeploy');
      const orphans = vi.spyOn(DockerController.getInstance(NODE), 'getLegacyOrphanContainersByStack').mockResolvedValue([{ Id: 'old' }]);
      const removed = vi.spyOn(DockerController.getInstance(NODE), 'removeContainers').mockResolvedValue([]);
      const error = await refusal(svc.deployStack('app', undefined, false, undefined, {
        pullServices: ['web'],
        pullRefs: [],
        // The fence is recorded while the deploy verifies what it pulled.
        verifyPulled: async () => { holdFence(); },
      }));
      expect(isDataRestoreFenceError(error), String(error)).toBe(true);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0][1]).toEqual(expect.arrayContaining(['pull', 'web']));
      expect(orphans).not.toHaveBeenCalled();
      expect(removed).not.toHaveBeenCalled();
      expect(begin).not.toHaveBeenCalled();
      expect(fsWorkInFlightCountForTests()).toBe(0);
    });

    it('a deploy admitted before the fence keeps its lease through the up, and the fence waits for it', async () => {
      const svc = ComposeService.getInstance(NODE);
      const { execute } = stubPreliminaries(svc);
      vi.spyOn(DockerController.getInstance(NODE), 'getLegacyOrphanContainersByStack').mockImplementation(async () => {
        // Recorded after the up's admission: the drain finds the up and waits.
        holdFence();
        await expect(waitForFsWorkOn(fences[0], 20)).resolves.toBe(false);
        return [];
      });
      vi.spyOn(svc as unknown as { retireStaleServiceRecoveries: () => Promise<void> }, 'retireStaleServiceRecoveries').mockResolvedValue(undefined);
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      const deployed = svc.deployStack('app', undefined, false);
      await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
      // The up ran under the lease admitted before the orphan check.
      expect(execute.mock.calls[0][1]).toEqual(expect.arrayContaining(['up', '-d']));
      expect(execute.mock.calls[0][8]).toEqual(expect.objectContaining({ release: expect.any(Function) }));
      vi.runAllTimers();
      vi.useRealTimers();
      await deployed;
      await expect(waitForFsWorkOn(fences[0], 20)).resolves.toBe(true);
    });

    it('refuses an update whose up is fenced before it hands off its recovery point or removes a legacy orphan', async () => {
      const svc = ComposeService.getInstance(NODE);
      const { execute } = stubPreliminaries(svc);
      const { StackUpdateRecoveryService } = await import('../services/StackUpdateRecoveryService');
      const recovery = StackUpdateRecoveryService.getInstance();
      vi.spyOn(recovery, 'captureCandidate').mockResolvedValue({ id: 'gen-1' } as never);
      const abandon = vi.spyOn(recovery, 'abandon').mockResolvedValue(undefined as never);
      vi.spyOn(recovery, 'markAcquired').mockReturnValue(true);
      const handoff = vi.spyOn(recovery, 'handoff').mockReturnValue(true);
      const classify = vi.spyOn(DockerController.getInstance(NODE), 'classifyLegacyOrphansForUpdate')
        .mockResolvedValue({ status: 'orphans', ids: ['old'] });
      const removed = vi.spyOn(DockerController.getInstance(NODE), 'removeContainers').mockResolvedValue([]);
      // The fence lands while the pulls run, before the policy is confirmed.
      const error = await refusal(svc.updateStack('app', undefined, true, async () => { holdFence(); }));
      expect(isDataRestoreFenceError(error), String(error)).toBe(true);
      expect((error as { stack?: string }).stack, 'refused at the up\'s admission').toContain('admitComposeProcess');
      expect(classify).not.toHaveBeenCalled();
      expect(handoff).not.toHaveBeenCalled();
      expect(removed).not.toHaveBeenCalled();
      expect(abandon).toHaveBeenCalledWith('gen-1');
      expect(execute.mock.calls.every((call: unknown[]) => !(call[1] as string[]).includes('up'))).toBe(true);
      expect(fsWorkInFlightCountForTests()).toBe(0);
    });
  });

  describe('a stack file transaction', () => {
    it('refuses when a recovery point\'s captured layer is held, though the live selection does not name it', async () => {
      const shared = path.join(composeDir, 'shared');
      await fsPromises.mkdir(shared);
      await fsPromises.writeFile(path.join(shared, 'base.yml'), 'services: {}\n');
      // Live: only the stack's own files, none held. Captured: the shared layer.
      await fsPromises.rm(path.join(stackDir, 'compose.override.yml'));
      holdFence(shared);
      const fsSvc = FileSystemService.getInstance(NODE);
      const live = await fsSvc.admitStackFileWork('app');
      live.release();
      const error = await refusal(fsSvc.admitStackFileWork('app', [], [['-f', '../shared/base.yml']]));
      expect(isDataRestoreFenceError(error), String(error)).toBe(true);
    });

    it('refuses a managed file that links into a held directory, and holds a fence recorded later off until it is released', async () => {
      const fsSvc = FileSystemService.getInstance(NODE);
      const lease = await fsSvc.admitStackFileWork('app');
      holdFence();
      await expect(waitForFsWorkOn(fences[0], 20)).resolves.toBe(false);
      lease.release();
      await expect(waitForFsWorkOn(fences[0], 20)).resolves.toBe(true);
      const error = await refusal(fsSvc.admitStackFileWork('app'));
      expect(isDataRestoreFenceError(error), String(error)).toBe(true);
    });
  });
});
