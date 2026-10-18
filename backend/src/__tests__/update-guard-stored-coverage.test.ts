/**
 * Rollback readiness reports the coverage of the recovery generation that a
 * rollback would restore, read from that generation, not from the live project.
 * Collaborators other than the inventory, the store and the readiness method
 * are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'path';
import os from 'os';
import { promises as fsPromises } from 'fs';
import { randomUUID } from 'crypto';

const mockState = { composeDir: '' };

const { mockGetCurrent } = vi.hoisted(() => ({ mockGetCurrent: vi.fn() }));

vi.mock('../services/NodeRegistry', () => ({
  NodeRegistry: {
    getInstance: () => ({
      getComposeDir: () => mockState.composeDir,
      getDefaultNodeId: () => 1,
    }),
  },
}));

vi.mock('../utils/debug', () => ({ isDebugEnabled: () => false }));

vi.mock('../services/DockerController', () => ({
  default: { getInstance: () => ({ getDocker: () => ({ listContainers: async () => [], getContainer: vi.fn() }) }) },
}));

vi.mock('../services/ComposeDoctorService', () => ({
  ComposeDoctorService: { getInstance: () => ({ getLatest: () => null }) },
}));

vi.mock('../services/UpdatePreviewService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/UpdatePreviewService')>()),
  UpdatePreviewService: {
    getInstance: () => ({
      getPreview: async () => ({
        stack_name: 'app',
        images: [],
        build_services: [],
        summary: {
          has_update: false, primary_image: 'app', current_tag: null, next_tag: null, semver_bump: 'none',
          update_kind: 'none', blocked: false, blocked_reason: null, has_build_services: false,
          rebuild_available: false, check_status: 'ok', verification_failed: false, verification_error: null,
        },
        rollback_target: 'app:1.2.3',
        changelog: null,
      }),
    }),
  },
}));

vi.mock('../services/DatabaseService', () => ({
  DatabaseService: {
    getInstance: () => ({
      getOpenDriftFindings: () => [],
      getGlobalSettings: () => ({ host_disk_limit: '90' }),
      getStackActivity: () => [],
      getGitSource: () => undefined,
      getStackProjectEnvFiles: () => [],
      isMeshStackEnabled: () => false,
      getCurrentStackUpdateRecovery: () => undefined,
    }),
  },
}));

vi.mock('../services/StackUpdateRecoveryService', () => ({
  StackUpdateRecoveryService: { getInstance: () => ({ getCurrent: mockGetCurrent }) },
  shortGenerationId: (id: string) => id.slice(0, 12),
}));

vi.mock('../services/rollbackEligibility', () => ({
  assessGenerationEligibility: async () => 'eligible',
}));

vi.mock('../utils/authoredComposeArgs', () => ({
  authoredComposeFileArgs: () => ['-f', 'compose.yaml'],
  authoredComposeEnvFileArgs: async () => [],
}));

vi.mock('systeminformation', () => ({ default: { fsSize: async () => [{ mount: '/', use: 10 }] } }));

import { UpdateGuardService } from '../services/UpdateGuardService';
import { resolveRollbackInventory } from '../services/rollbackInventory';
import { RollbackGenerationStore } from '../services/RollbackGenerationStore';

const NODE = 1;
const STACK = 'app';
const WITH_INCLUDE = 'include:\n  - path: ../shared-common/base.yaml\nservices:\n  web:\n    image: nginx\n';
const PLAIN = 'services:\n  web:\n    image: nginx\n';

describe('rollback readiness coverage comes from the stored generation', () => {
  let composeDir: string;
  let dataDir: string;
  let stackDir: string;
  let originalDataDir: string | undefined;

  async function captureCurrent(): Promise<string> {
    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName: STACK,
      generationId,
      inventory: await resolveRollbackInventory(NODE, STACK),
    });
    // A different row id: the stored content is keyed by content_path, not by the row id.
    mockGetCurrent.mockReturnValue({ id: randomUUID(), content_path: generationId, gitops_generation_id: null });
    return generationId;
  }

  async function report() {
    const result = await UpdateGuardService.getInstance().computeRollbackReadiness(NODE, STACK);
    const item = (id: string) => result.items.find((i) => i.id === id)!;
    return { managed: item('managed_inputs'), recovery: item('recovery_generation') };
  }

  beforeEach(async () => {
    composeDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-rr-'));
    dataDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-rrdata-'));
    mockState.composeDir = composeDir;
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;
    stackDir = path.join(composeDir, STACK);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.mkdir(path.join(composeDir, 'shared-common'), { recursive: true });
    mockGetCurrent.mockReturnValue(undefined);
  });

  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    await fsPromises.rm(composeDir, { recursive: true, force: true });
    await fsPromises.rm(dataDir, { recursive: true, force: true });
  });

  it('keeps the partial warning when the live file no longer has the external include', async () => {
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), WITH_INCLUDE, 'utf8');
    await captureCurrent();
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), PLAIN, 'utf8');

    const { managed, recovery } = await report();

    expect(managed.state).toBe('warning');
    expect(managed.detail).toContain('../shared-common/base.yaml');
    expect(recovery.detail).not.toMatch(/exact restore/i);
    expect(recovery.detail).toMatch(/does not hold every input/i);
  });

  it('describes a complete stored generation from its own content, not the live file', async () => {
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), PLAIN, 'utf8');
    await captureCurrent();
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), WITH_INCLUDE, 'utf8');

    const { managed, recovery } = await report();

    expect(managed.state).toBe('ready');
    expect(managed.detail).toBe('This recovery generation holds 1 managed path(s).');
    expect(recovery.detail).toMatch(/available for exact restore/);
  });

  it('does not call a generation complete when it recorded no omissions at all', async () => {
    // Before omissions were recorded, an outside env_file was skipped without a note.
    await fsPromises.writeFile(
      path.join(stackDir, 'compose.yaml'),
      'services:\n  web:\n    image: nginx\n    env_file: ../shared-common/app.env\n',
      'utf8',
    );
    const generationId = await captureCurrent();
    const genJson = path.join(RollbackGenerationStore.getGenerationDir(NODE, STACK, generationId), 'generation.json');
    const legacy = JSON.parse(await fsPromises.readFile(genJson, 'utf8'));
    delete legacy.uncapturedInputs;
    delete legacy.uncapturedRelativePaths;
    await fsPromises.writeFile(genJson, JSON.stringify(legacy), 'utf8');

    const { managed, recovery } = await report();

    expect(managed.state).toBe('warning');
    expect(managed.detail).toContain('../shared-common/app.env');
    expect(recovery.detail).toMatch(/is available\. What it holds was not recorded\.$/);
  });

  it('does not say a generation that recorded nothing is covered when the live project is clean', async () => {
    await fsPromises.writeFile(
      path.join(stackDir, 'compose.yaml'),
      'services:\n  web:\n    image: nginx\n    env_file: ../shared-common/app.env\n',
      'utf8',
    );
    const generationId = await captureCurrent();
    const genJson = path.join(RollbackGenerationStore.getGenerationDir(NODE, STACK, generationId), 'generation.json');
    const legacy = JSON.parse(await fsPromises.readFile(genJson, 'utf8'));
    delete legacy.uncapturedInputs;
    delete legacy.uncapturedRelativePaths;
    await fsPromises.writeFile(genJson, JSON.stringify(legacy), 'utf8');
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), PLAIN, 'utf8');

    const { managed } = await report();

    expect(managed.state).toBe('warning');
    expect(managed.detail).toBe('What the current recovery generation holds was not recorded.');
  });

  it('still warns that the next capture would be refused while a complete generation is current', async () => {
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), PLAIN, 'utf8');
    await captureCurrent();
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'include:\n  - ./missing.yaml\nservices: {}\n', 'utf8');

    const { managed, recovery } = await report();

    expect(managed.state).toBe('warning');
    expect(managed.detail).toMatch(/^This recovery generation holds 1 managed path\(s\)\. The next capture would be refused: .*missing\.yaml is unreadable\.$/);
    expect(recovery.detail).toMatch(/available for exact restore\.$/);
  });

  it('reports unknown, and makes no exact-restore claim, when the stored generation cannot be read', async () => {
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), PLAIN, 'utf8');
    const generationId = await captureCurrent();
    await fsPromises.rm(path.join(RollbackGenerationStore.getGenerationDir(NODE, STACK, generationId), 'generation.json'));

    const { managed, recovery } = await report();

    expect(managed.state).toBe('unknown');
    expect(recovery.state).toBe('ready');
    expect(recovery.detail).toMatch(/exists, but what it holds could not be read\./);
  });

  it('reports unknown when the stored content no longer matches its checksum', async () => {
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), PLAIN, 'utf8');
    const generationId = await captureCurrent();
    const stored = path.join(RollbackGenerationStore.getGenerationDir(NODE, STACK, generationId), 'files', 'compose.yaml');
    await fsPromises.writeFile(stored, 'tampered\n', 'utf8');

    const { managed, recovery } = await report();

    expect(managed.state).toBe('unknown');
    expect(recovery.detail).toMatch(/could not be read/);
  });

  it.each([null, ''])('uses the live project and records no coverage for a row with content_path %j', async (contentPath) => {
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), WITH_INCLUDE, 'utf8');
    mockGetCurrent.mockReturnValue({ id: randomUUID(), content_path: contentPath, gitops_generation_id: null });

    const { managed, recovery } = await report();

    expect(managed.state).toBe('warning');
    expect(managed.detail).toContain('../shared-common/base.yaml');
    expect(recovery.detail).toMatch(/What it holds was not recorded\.$/);
  });

  it('describes a clean live project as covered, with no mention of a generation, when none is current', async () => {
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), PLAIN, 'utf8');

    const { managed, recovery } = await report();

    expect(managed).toMatchObject({ state: 'ready', detail: 'Exact authored-project coverage includes 1 managed path(s).' });
    expect(recovery.state).toBe('missing');
  });

  it('falls back to the live project when no generation is current', async () => {
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), WITH_INCLUDE, 'utf8');

    const { managed } = await report();

    expect(managed.state).toBe('warning');
    expect(managed.detail).toContain('../shared-common/base.yaml');
    expect(managed.detail).not.toMatch(/not recorded/);
  });

  describe('overall readiness never contradicts the stored coverage rows', () => {
    beforeEach(async () => {
      // A backup slot with an env file, so env coverage is ready and the
      // overall state turns on managed-input coverage alone.
      const backupDir = path.join(dataDir, 'backups', String(NODE), STACK);
      await fsPromises.mkdir(backupDir, { recursive: true });
      await fsPromises.writeFile(path.join(backupDir, '.env'), 'A=1\nB=2\n', 'utf8');
      await fsPromises.writeFile(path.join(backupDir, '.timestamp'), String(Date.now()), 'utf8');
    });

    async function overall() {
      return (await UpdateGuardService.getInstance().computeRollbackReadiness(NODE, STACK)).overall;
    }

    it('is ready when the stored generation holds every input', async () => {
      await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), PLAIN, 'utf8');
      await captureCurrent();

      expect(await overall()).toBe('ready');
    });

    it('is partial when the stored generation recorded omissions', async () => {
      await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), WITH_INCLUDE, 'utf8');
      await captureCurrent();
      await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), PLAIN, 'utf8');

      expect(await overall()).toBe('partial');
    });

    it('is partial when the stored generation recorded no coverage at all', async () => {
      await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), PLAIN, 'utf8');
      const generationId = await captureCurrent();
      const genJson = path.join(RollbackGenerationStore.getGenerationDir(NODE, STACK, generationId), 'generation.json');
      const legacy = JSON.parse(await fsPromises.readFile(genJson, 'utf8'));
      delete legacy.uncapturedInputs;
      delete legacy.uncapturedRelativePaths;
      await fsPromises.writeFile(genJson, JSON.stringify(legacy), 'utf8');

      expect(await overall()).toBe('partial');
    });
  });
});
