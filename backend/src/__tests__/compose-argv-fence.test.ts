/**
 * Every Compose argv Sencho assembles (an `up`, and equally the `config`,
 * `pull` or `build` a deploy, an update or an image pull runs first) is asked
 * against a data restore's fence once it is assembled, and a deploy and an
 * image pull ask before they run any of them: the recovery, Mesh, Pilot and digest-pin layers
 * name the root file and the first override with `-f` themselves, which turns
 * COMPOSE_FILE off, so the file list a caller asked up front is not the one
 * Compose opens.
 *
 * The argv builders, the stack files and the link walk are real. Stand-ins:
 * the fence store reports one held directory, Sencho's own mounts read as
 * "not in a container", the node registry and database are minimal mocks, and
 * one case supplies the Mesh override path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'path';
import os from 'os';
import { promises as fsPromises } from 'fs';
import { randomUUID } from 'crypto';

const mockState = { composeDir: '', meshEnabled: false };

vi.mock('../services/NodeRegistry', () => ({
  NodeRegistry: {
    getInstance: () => ({
      getComposeDir: () => mockState.composeDir,
      getDefaultNodeId: () => 1,
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
    }),
  },
}));

import { ComposeService } from '../services/ComposeService';
import { MeshService } from '../services/MeshService';
import { RestoreFenceStore } from '../services/recovery/restoreFence';
import SelfIdentityService from '../services/SelfIdentityService';
import { isDataRestoreFenceError } from '../helpers/dataRestoreFenceError';
import { composeArgvFiles, refuseIfComposeArgvFenced } from '../helpers/composeArgvFence';
import * as envFileResolution from '../helpers/envFileResolution';
import { resolveRollbackInventory } from '../services/rollbackInventory';
import { RollbackGenerationStore } from '../services/RollbackGenerationStore';
import { allowingPolicy } from './__helpers__/updatePolicyFixture';

const NODE = 1;

describe('the fence asks the files an assembled Compose argv names', () => {
  let root: string;
  let composeDir: string;
  let dataDir: string;
  let stackDir: string;
  let fenced: string;
  let originalDataDir: string | undefined;
  let originalMode: string | undefined;

  beforeEach(async () => {
    root = await fsPromises.realpath(await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-argv-fence-')));
    composeDir = path.join(root, 'compose');
    dataDir = path.join(root, 'data');
    stackDir = path.join(composeDir, 'app');
    // A bind directory inside the stack, as a stack source or data root is.
    fenced = path.join(stackDir, 'data');
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.mkdir(dataDir, { recursive: true });
    await fsPromises.mkdir(fenced, { recursive: true });
    mockState.composeDir = composeDir;
    mockState.meshEnabled = false;
    originalDataDir = process.env.DATA_DIR;
    originalMode = process.env.SENCHO_MODE;
    process.env.DATA_DIR = dataDir;
    // A clear root file, a COMPOSE_FILE that selects only it, and an override
    // that is a readable link into the directory a restore is overwriting.
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n');
    await fsPromises.writeFile(path.join(stackDir, '.env'), 'COMPOSE_FILE=compose.yaml\n');
    await fsPromises.writeFile(path.join(fenced, 'compose.override.yml'), 'services:\n  web:\n    environment:\n      A: "1"\n');
    await fsPromises.symlink(path.join('data', 'compose.override.yml'), path.join(stackDir, 'compose.override.yml'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    if (originalMode === undefined) delete process.env.SENCHO_MODE;
    else process.env.SENCHO_MODE = originalMode;
    await fsPromises.rm(root, { recursive: true, force: true });
  });

  function holdFence(dir: string = fenced): void {
    // Sencho runs outside a container here, so its paths are the host's.
    vi.spyOn(SelfIdentityService.getInstance(), 'getBindMounts').mockResolvedValue(null);
    vi.spyOn(RestoreFenceStore.getInstance(), 'liveFencedFsTargets')
      .mockReturnValue([{ senchoPath: dir, hostPath: dir, aliases: [] }]);
  }

  async function refusal(work: Promise<unknown>): Promise<unknown> {
    try {
      await work;
    } catch (error) {
      return error;
    }
    return null;
  }

  it('refuses a recovery up whose pinned override links into a held directory, though COMPOSE_FILE names only a clear file', async () => {
    const recoveryLayer = path.join(dataDir, 'recovery.override.yml');
    await fsPromises.writeFile(recoveryLayer, 'services: {}\n');
    const svc = ComposeService.getInstance(NODE);

    // No fence: the pin is the argv this test is about.
    const args = await svc.buildComposeArgsWithRecoveryOverride('app', ['up', '-d'], recoveryLayer, null);
    expect(args).toEqual(['compose', '-f', 'compose.yaml', '-f', 'compose.override.yml', '-f', recoveryLayer, 'up', '-d']);

    holdFence();
    const error = await refusal(svc.buildComposeArgsWithRecoveryOverride('app', ['up', '-d'], recoveryLayer, null));
    expect(isDataRestoreFenceError(error)).toBe(true);

    // A fence on another directory does not refuse it.
    vi.restoreAllMocks();
    await fsPromises.mkdir(path.join(root, 'elsewhere'));
    holdFence(path.join(root, 'elsewhere'));
    await expect(svc.buildComposeArgsWithRecoveryOverride('app', ['up', '-d'], recoveryLayer, null)).resolves.toContain('up');
  });

  it('refuses a recovery up whose captured file set names a file in a held directory', async () => {
    await fsPromises.rm(path.join(stackDir, 'compose.override.yml'));
    await fsPromises.rm(path.join(stackDir, '.env'));
    const captured = await resolveRollbackInventory(NODE, 'app');
    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({ nodeId: NODE, stackName: 'app', generationId, inventory: captured });
    const manifest = await RollbackGenerationStore.readVerifiedGeneration(NODE, 'app', generationId);
    expect(manifest.invocation.explicitComposeFiles).toEqual(['compose.yaml']);
    // The captured root is now a readable link into the held directory.
    await fsPromises.writeFile(path.join(fenced, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n');
    await fsPromises.rm(path.join(stackDir, 'compose.yaml'));
    await fsPromises.symlink(path.join('data', 'compose.yaml'), path.join(stackDir, 'compose.yaml'));
    holdFence();
    const error = await refusal(ComposeService.getInstance(NODE)
      .buildComposeArgsWithRecoveryOverride('app', ['up', '-d'], null, manifest.invocation));
    expect(isDataRestoreFenceError(error), String(error)).toBe(true);
  });

  it('refuses every Compose command a Mesh or Pilot layer pins the override for, a render and a pull as much as an up, and leaves a COMPOSE_FILE argv to the caller', async () => {
    const meshLayer = path.join(dataDir, 'mesh.override.yml');
    await fsPromises.writeFile(meshLayer, 'services: {}\n');
    const svc = ComposeService.getInstance(NODE) as unknown as {
      authoredComposeArgs(stack: string, action: string[]): Promise<string[]>;
    };
    holdFence();

    // Without a Mesh layer the argv names no file: COMPOSE_FILE selects the
    // clear root, and the caller's own ask is the one that answers.
    const plain = await svc.authoredComposeArgs('app', ['up', '-d']);
    expect(plain).not.toContain('-f');

    vi.spyOn(MeshService.getInstance(), 'ensureStackOverride').mockResolvedValue(meshLayer);
    // Each of these opens the root, the override and the Mesh layer, so each
    // is refused before a Compose process could read the override.
    for (const action of [
      ['up', '-d'], ['create'], ['config', '--quiet'], ['config', '--hash=web'],
      ['pull', '--ignore-buildable'], ['build', '--pull'], ['start'], ['stop'], ['down'],
    ]) {
      expect(isDataRestoreFenceError(await refusal(svc.authoredComposeArgs('app', action))), action.join(' ')).toBe(true);
    }
  });

  describe('a deploy, an image pull, and the checks they run before up', () => {
    // Stand-ins for the Compose processes: any call means Docker Compose was started.
    function watchSpawns(svc: ComposeService): { execute: ReturnType<typeof vi.spyOn>; capture: ReturnType<typeof vi.spyOn> } {
      const inner = svc as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      // The SOPS preflight reads the GitOps store, which this suite does not stand up.
      vi.spyOn(inner, 'assertSopsOverlayOrRefuse').mockResolvedValue(undefined);
      return {
        execute: vi.spyOn(inner, 'execute').mockResolvedValue(undefined),
        capture: vi.spyOn(inner, 'captureCompose').mockResolvedValue(''),
      };
    }

    async function withLayer(kind: 'mesh' | 'pilot'): Promise<void> {
      if (kind === 'mesh') {
        mockState.meshEnabled = true;
        const meshLayer = path.join(dataDir, 'mesh.override.yml');
        await fsPromises.writeFile(meshLayer, 'services: {}\n');
        vi.spyOn(MeshService.getInstance(), 'ensureStackOverride').mockResolvedValue(meshLayer);
        return;
      }
      process.env.SENCHO_MODE = 'pilot';
      const overrides = path.join(dataDir, 'mesh', 'overrides', String(NODE));
      await fsPromises.mkdir(overrides, { recursive: true });
      await fsPromises.writeFile(path.join(overrides, 'app.override.yml'), 'services: {}\n');
    }

    for (const kind of ['mesh', 'pilot'] as const) {
      it(`refuses an atomic and a plain deploy with a ${kind} layer before any Compose process or capture`, async () => {
        await withLayer(kind);
        holdFence();
        const { StackUpdateRecoveryService } = await import('../services/StackUpdateRecoveryService');
        const capture = vi.spyOn(StackUpdateRecoveryService.getInstance(), 'captureCandidate');
        const svc = ComposeService.getInstance(NODE);
        const spawns = watchSpawns(svc);
        for (const atomic of [true, false]) {
          const error = await refusal(svc.deployStack('app', undefined, atomic));
          expect(isDataRestoreFenceError(error), `${kind} atomic=${atomic}: ${String(error)}`).toBe(true);
        }
        expect(capture).not.toHaveBeenCalled();
        expect(spawns.execute).not.toHaveBeenCalled();
        expect(spawns.capture).not.toHaveBeenCalled();
      });

      it(`refuses an image pull with a ${kind} layer before docker compose pull`, async () => {
        await withLayer(kind);
        holdFence();
        const svc = ComposeService.getInstance(NODE);
        const spawns = watchSpawns(svc);
        const error = await refusal(svc.pullStackImages('app', allowingPolicy('app')));
        expect(isDataRestoreFenceError(error), String(error)).toBe(true);
        expect(spawns.execute).not.toHaveBeenCalled();
      });
    }

    it('still refuses the capture render, the guard hash and the pull at their own argv when the fence is recorded after the up-front ask', async () => {
      await withLayer('mesh');
      holdFence();
      const { FileSystemService } = await import('../services/FileSystemService');
      // The up-front ask ran before the fence was recorded.
      vi.spyOn(FileSystemService.prototype, 'refuseIfComposeFenced').mockResolvedValue(undefined);
      const svc = ComposeService.getInstance(NODE);
      const inner = svc as unknown as { composeConfigHash(stack: string, service: string): Promise<string | null> };
      const spawns = watchSpawns(svc);
      expect(isDataRestoreFenceError(await refusal(svc.validateExactComposeInvocation('app')))).toBe(true);
      // The guard's hash answers with the fence rather than "hash unknown".
      const hashed = await refusal(inner.composeConfigHash('app', 'web'));
      expect(isDataRestoreFenceError(hashed), String(hashed)).toBe(true);
      const pulled = await refusal(svc.pullStackImages('app', allowingPolicy('app')));
      expect(isDataRestoreFenceError(pulled), String(pulled)).toBe(true);
      // Past the connection check (its hash is asked above), a plain deploy
      // is refused at its up's argv.
      vi.spyOn(svc, 'evaluateDockerEndpoint').mockResolvedValue(null);
      const deployed = await refusal(svc.deployStack('app', undefined, false));
      expect(isDataRestoreFenceError(deployed), String(deployed)).toBe(true);
      expect(spawns.execute).not.toHaveBeenCalled();
      expect(spawns.capture).not.toHaveBeenCalled();
    });

    it('deploys a stack whose fence is on another directory', async () => {
      await withLayer('mesh');
      await fsPromises.mkdir(path.join(root, 'elsewhere'));
      holdFence(path.join(root, 'elsewhere'));
      const svc = ComposeService.getInstance(NODE);
      const spawns = watchSpawns(svc);
      await expect(svc.validateExactComposeInvocation('app')).resolves.toBeUndefined();
      expect(spawns.execute).toHaveBeenCalledTimes(1);
      expect(spawns.execute.mock.calls[0][1]).toEqual(expect.arrayContaining(['config', '--quiet']));
    });
  });

  it('reads every file flag form, and resolves a relative file against the command\'s working directory', async () => {
    expect(composeArgvFiles(['compose', '-f', 'a.yml', '--file', 'b.yml', '--file=c.yml', 'up', '-f'])).toEqual(['a.yml', 'b.yml', 'c.yml']);
    holdFence();
    for (const args of [['-f', 'compose.override.yml'], ['--file', 'compose.override.yml'], ['--file=compose.override.yml']]) {
      expect(isDataRestoreFenceError(await refusal(refuseIfComposeArgvFenced(stackDir, ['compose', ...args, 'up']))), args.join(' ')).toBe(true);
    }
    // The same name in another working directory is another file.
    const other = path.join(composeDir, 'other');
    await fsPromises.mkdir(other);
    await fsPromises.writeFile(path.join(other, 'compose.override.yml'), 'services: {}\n');
    await expect(refuseIfComposeArgvFenced(other, ['compose', '-f', 'compose.override.yml', 'up'])).resolves.toBeUndefined();
    // An argv that names no file is left to the caller's own ask.
    await expect(refuseIfComposeArgvFenced(stackDir, ['compose', 'up', '-d'])).resolves.toBeUndefined();
  });

  it('answers a check that fails while a fence is held as the fence\'s unproven refusal, and asks nothing when no fence is held', async () => {
    const check = vi.spyOn(envFileResolution, 'refuseIfFencedSource').mockRejectedValue(new Error('EIO'));
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(refuseIfComposeArgvFenced(stackDir, ['compose', '-f', 'compose.yaml', 'up'])).resolves.toBeUndefined();
    expect(check).not.toHaveBeenCalled();
    holdFence();
    const error = await refusal(refuseIfComposeArgvFenced(stackDir, ['compose', '-f', 'compose.yaml', 'up']));
    expect(isDataRestoreFenceError(error)).toBe(true);
    expect((error as Error).message).toContain('cannot prove');
    expect(warned).toHaveBeenCalled();
  });

  it('refuses a digest-pinned up whose pin names the override, and removes the overlay it wrote', async () => {
    const svc = ComposeService.getInstance(NODE) as unknown as {
      withDigestPinOverlay(stack: string, action: string[], dir: string | undefined, pins: Record<string, string>): Promise<{ args: string[]; overlayDir: string }>;
    };
    holdFence();
    const made: string[] = [];
    const mkdtemp = fsPromises.mkdtemp.bind(fsPromises);
    vi.spyOn(fsPromises, 'mkdtemp').mockImplementation(async (prefix: string) => {
      const dir = await mkdtemp(prefix);
      made.push(dir);
      return dir;
    });
    const error = await refusal(svc.withDigestPinOverlay('app', ['up', '-d'], undefined, {
      web: `nginx@sha256:${'a'.repeat(64)}`,
    }));
    expect(isDataRestoreFenceError(error)).toBe(true);
    expect(made).toHaveLength(1);
    await expect(fsPromises.access(made[0])).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('says a Pilot override pushed by central, or a Mesh row, puts a layer on the stack', async () => {
    const mesh = MeshService.getInstance();
    expect(await mesh.stackOverrideApplies(NODE, 'app')).toBe(false);
    mockState.meshEnabled = true;
    expect(await mesh.stackOverrideApplies(NODE, 'app')).toBe(true);
    mockState.meshEnabled = false;
    process.env.SENCHO_MODE = 'pilot';
    expect(await mesh.stackOverrideApplies(NODE, 'app')).toBe(false);
    const overrides = path.join(dataDir, 'mesh', 'overrides', String(NODE));
    await fsPromises.mkdir(overrides, { recursive: true });
    await fsPromises.writeFile(path.join(overrides, 'app.override.yml'), 'services: {}\n');
    expect(await mesh.stackOverrideApplies(NODE, 'app')).toBe(true);
    expect(await mesh.ensureStackOverride(NODE, 'app')).toBe(path.join(overrides, 'app.override.yml'));
  });
});
