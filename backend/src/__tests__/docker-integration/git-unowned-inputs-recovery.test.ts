/**
 * Docker-backed: a Git generation recovers the project it captured without
 * taking over files the repository does not own.
 *
 * Two properties of an ordinary single-file Git stack (empty invocation prefix,
 * so Compose's own discovery picks the layers):
 *
 * - An operator `.env` the manifest does not own is never a cleanup candidate.
 *   One created after capture survives a restore, and the recovered project
 *   still renders with the interpolation context the generation captured.
 * - The implicit override the manifest holds is a layer of the captured
 *   project. Pinning only the primary file would drop it from the recovery run,
 *   with or without the Mesh layer.
 *
 * Each case renders the live and recovered projects with the real Compose CLI.
 * Skipped automatically when Docker is unavailable.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { setupTestDb, cleanupTestDb } from '../helpers/setupTestDb';
import { generateOverrideYaml } from '../../services/MeshComposeOverride';
import { storedComposeCoverage, storedRestoreCoverage } from '../../services/updateGuard/readiness';
import type { ComposeInputEntry, GitProjectManifest } from '../../types/gitProjectManifest';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 8_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

const hasDocker = dockerAvailable();

const REPO = 'https://example.com/operator/repo.git';
const COMMIT = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

const COMPOSE = [
  'services:',
  '  web:',
  '    image: busybox:1.36.1',
  '    command: ["echo","${GREETING:-captured}"]',
  '    environment:',
  '      LAYER: base',
  '',
].join('\n');

const OVERRIDE = [
  'services:',
  '  web:',
  '    command: ["echo","deployed-override"]',
  '    environment:',
  '      LAYER: override',
  '',
].join('\n');

const OPERATOR_ENV = 'GREETING=post-capture\nOPERATOR_SECRET=fixture-only\n';

function managedInput(
  sourcePath: string,
  role: ComposeInputEntry['role'],
  dependencyKind: ComposeInputEntry['dependencyKind'],
): ComposeInputEntry {
  return {
    sourcePath,
    materializedPath: sourcePath,
    role,
    dependencyKind,
    ownership: 'managed',
    provenance: 'fetch',
    sensitivity: 'low',
    contentSha256: null,
    sizeBytes: null,
    state: 'present',
    deletionAuthority: 'sencho',
    note: null,
  };
}

/** The manifest a single-file pull with sync_env off writes: empty invocation. */
function manifestFor(
  nodeId: number,
  stack: string,
  extra: ComposeInputEntry[],
): GitProjectManifest {
  const inputs: ComposeInputEntry[] = [
    managedInput('compose.yaml', 'compose-primary', 'explicit'),
    ...extra,
    {
      ...managedInput('.env', 'env', 'interpolation-env'),
      materializedPath: null,
      ownership: 'unmanaged',
      sensitivity: 'high',
      deletionAuthority: 'none',
      note: 'No project .env in the repository; interpolation falls back to the environment at deploy time',
    },
  ];
  return {
    schemaVersion: 1,
    manifestVersion: 1,
    state: 'active',
    generatedAt: Date.now(),
    identity: { nodeId: String(nodeId), stackName: stack, repoUrl: REPO, branch: 'main' },
    repo: { url: REPO, branch: 'main' },
    resolvedRevision: { commitSha: COMMIT, fetchedAt: Date.now() },
    project: {
      root: null,
      composeFiles: ['compose.yaml'],
      effectiveProjectDir: null,
      projectName: stack,
      invocation: [],
    },
    inputs,
    refusals: [],
    buildContexts: [],
    generation: {
      candidateDir: 'generations/candidate',
      appliedDir: 'generations/applied',
      previousDir: null,
    },
    counts: { managed: 1 + extra.length, unmanaged: 1, refused: 0 },
    bounds: { maxFiles: 1_000, maxBytes: 1_000_000, maxContextBytes: 1_000_000, maxPathDepth: 64, maxFileBytes: 100_000 },
  };
}

type Rendered = { services: { web: { command: string[]; environment: Record<string, string> } } };

describe.skipIf(!hasDocker)('a Git generation recovers its captured project', () => {
  let tmpDir: string;
  let composeDir: string;
  let nodeId: number;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    composeDir = process.env.COMPOSE_DIR!;
    const { DatabaseService } = await import('../../services/DatabaseService');
    const local = DatabaseService.getInstance().getDefaultNode();
    if (!local?.id) throw new Error('Test DB has no default local node');
    nodeId = local.id;
    for (const key of ['COMPOSE_FILE', 'COMPOSE_ENV_FILES', 'COMPOSE_DISABLE_ENV_FILE', 'GREETING']) {
      delete process.env[key];
    }
  }, 120_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    if (tmpDir) cleanupTestDb(tmpDir);
  });

  async function seedStack(stack: string, extra: ComposeInputEntry[], files: Record<string, string>) {
    const stackDir = path.join(composeDir, stack);
    fs.mkdirSync(stackDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(stackDir, name), content, 'utf8');
    }
    const { DatabaseService } = await import('../../services/DatabaseService');
    const db = DatabaseService.getInstance();
    db.upsertGitSource({
      stack_name: stack,
      repo_url: REPO,
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
      auto_apply_on_webhook: false,
      auto_deploy_on_apply: false,
      last_applied_commit_sha: COMMIT,
      last_applied_content_hash: 'content-hash',
      pending_commit_sha: null,
      pending_compose_content: null,
      pending_env_content: null,
      pending_fetched_at: null,
      last_debounce_at: null,
    });
    db.setGitSourceAppliedSpec(stack, null);
    db.setGitSourceManifestState(stack, 1, 'active', null);
    const { GitProjectManifestService } = await import('../../services/GitProjectManifestService');
    await GitProjectManifestService.getInstance().writeManifest(stack, manifestFor(nodeId, stack, extra));
    return stackDir;
  }

  async function enableMesh(stack: string): Promise<void> {
    const { DatabaseService } = await import('../../services/DatabaseService');
    const { MeshService } = await import('../../services/MeshService');
    const overrideDir = path.join(tmpDir, 'mesh-overrides');
    fs.mkdirSync(overrideDir, { recursive: true });
    const overridePath = path.join(overrideDir, `${stack}.override.yml`);
    fs.writeFileSync(
      overridePath,
      generateOverrideYaml({ services: ['web'], aliases: [], senchoIp: '172.30.0.2' }),
      'utf8',
    );
    DatabaseService.getInstance().insertMeshStack(nodeId, stack, null);
    vi.spyOn(MeshService.getInstance(), 'ensureStackOverride').mockResolvedValue(overridePath);
  }

  function render(stackDir: string, stack: string, args: string[]): Rendered['services']['web'] {
    const prefix = args.slice(1, args.indexOf('config'));
    const out = JSON.parse(execFileSync(
      'docker',
      ['compose', '-p', stack, ...prefix, 'config', '--format', 'json'],
      { cwd: stackDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )) as Rendered;
    return out.services.web;
  }

  /** Capture, move the live project on, restore, and render the recovery run. */
  async function captureAndRecover(
    stack: string,
    stackDir: string,
    mutate: () => void,
  ) {
    const { resolveRollbackInventory } = await import('../../services/rollbackInventory');
    const { RollbackGenerationStore } = await import('../../services/RollbackGenerationStore');
    const { resolveComposeProjectContextForGeneration } = await import('../../services/composeProjectContext');
    const { ComposeService } = await import('../../services/ComposeService');
    const compose = ComposeService.getInstance(nodeId);

    const liveArgs = await compose.buildComposeArgsWithRecoveryOverride(stack, ['config'], null, null);
    const live = render(stackDir, stack, liveArgs);

    const inventory = await resolveRollbackInventory(nodeId, stack);
    expect(inventory.coverageRefusal).toBeNull();
    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({ nodeId, stackName: stack, generationId, inventory });

    mutate();

    const ctx = await resolveComposeProjectContextForGeneration(nodeId, stack, generationId);
    await ctx.restoreFromContext();
    const stored = await RollbackGenerationStore.readVerifiedGeneration(nodeId, stack, generationId);

    // A recovery run appends a layer of its own; it must not change the model.
    const recoveryLayer = path.join(tmpDir, `${stack}-recovery.yml`);
    fs.writeFileSync(recoveryLayer, 'services:\n  web:\n    labels:\n      sencho.recovery-test: "1"\n', 'utf8');
    const recoveryArgs = await compose.buildComposeArgsWithRecoveryOverride(
      stack,
      ['config'],
      recoveryLayer,
      stored.invocation,
    );
    const recovered = render(stackDir, stack, recoveryArgs);

    await RollbackGenerationStore.commitRestoreTransaction(nodeId, stack, generationId);
    return {
      live,
      recovered,
      stored,
      inventory,
      pending: await RollbackGenerationStore.hasPendingRestoreIntent(nodeId, stack, generationId),
    };
  }

  describe('an operator .env the manifest does not own', () => {
    it('survives a restore and stays out of the recovered interpolation context', async () => {
      const stack = 'gitlateenv';
      const stackDir = await seedStack(stack, [], { 'compose.yaml': COMPOSE });

      const result = await captureAndRecover(stack, stackDir, () => {
        fs.writeFileSync(path.join(stackDir, '.env'), OPERATOR_ENV, 'utf8');
        fs.writeFileSync(
          path.join(stackDir, 'compose.yaml'),
          COMPOSE.replace('busybox:1.36.1', 'busybox:1.36.2'),
          'utf8',
        );
      });

      // The restore never owned the file, so it keeps the operator's bytes.
      expect(fs.readFileSync(path.join(stackDir, '.env'), 'utf8')).toBe(OPERATOR_ENV);
      expect(fs.readFileSync(path.join(stackDir, 'compose.yaml'), 'utf8')).toBe(COMPOSE);
      expect(result.pending).toBe(false);
      // The generation captured a project with no .env, so the recovery run
      // renders without the one that appeared afterwards.
      expect(result.stored.invocation.interpolationEnvFiles).toEqual([]);
      expect(storedRestoreCoverage(result.stored)).toBe('complete');
      expect(result.live.command).toEqual(['echo', 'captured']);
      expect(result.recovered.command).toEqual(['echo', 'captured']);
    });

    it('is still read as current content when it existed at capture', async () => {
      const stack = 'gitcaptureenv';
      const stackDir = await seedStack(stack, [], {
        'compose.yaml': COMPOSE,
        '.env': 'GREETING=old\n',
      });

      const result = await captureAndRecover(stack, stackDir, () => {
        fs.writeFileSync(path.join(stackDir, '.env'), 'GREETING=new\n', 'utf8');
      });

      // A partial generation does not hold the file, so it neither rewrites nor
      // deletes it, and the rollback reads the operator's current value.
      expect(result.inventory.uncapturedRelativePaths).toContain('.env');
      expect(storedRestoreCoverage(result.stored)).toBe('omits_inputs');
      expect(result.stored.invocation.interpolationEnvFiles).toBeUndefined();
      expect(fs.readFileSync(path.join(stackDir, '.env'), 'utf8')).toBe('GREETING=new\n');
      expect(result.live.command).toEqual(['echo', 'old']);
      expect(result.recovered.command).toEqual(['echo', 'new']);
    });
  });

  describe('the implicit override the manifest holds', () => {
    it.each([
      { label: 'without Mesh', mesh: false },
      { label: 'with Mesh', mesh: true },
    ])('stays a layer of the recovered project $label', async ({ label, mesh }) => {
      const stack = mesh ? 'gitoverridemesh' : 'gitoverride';
      const stackDir = await seedStack(
        stack,
        [{ ...managedInput('compose.override.yml', 'compose-override', 'implicit-override'), note: label }],
        { 'compose.yaml': COMPOSE, 'compose.override.yml': OVERRIDE },
      );
      if (mesh) await enableMesh(stack);

      const result = await captureAndRecover(stack, stackDir, () => {
        fs.writeFileSync(
          path.join(stackDir, 'compose.yaml'),
          COMPOSE.replace('busybox:1.36.1', 'busybox:1.36.2'),
          'utf8',
        );
        // The override drifts too, so the recovered model only matches the
        // deployed one if the generation held its bytes and the run pins it.
        fs.writeFileSync(
          path.join(stackDir, 'compose.override.yml'),
          OVERRIDE.replace('deployed-override', 'drifted').replace('LAYER: override', 'LAYER: drifted'),
          'utf8',
        );
      });

      expect(fs.readFileSync(path.join(stackDir, 'compose.override.yml'), 'utf8')).toBe(OVERRIDE);
      expect(storedComposeCoverage(result.stored)).toBe('held');
      expect(result.stored.invocation.composeLayers).toEqual(['compose.yaml', 'compose.override.yml']);
      expect(result.live.command).toEqual(['echo', 'deployed-override']);
      expect(result.recovered.command).toEqual(['echo', 'deployed-override']);
      expect(result.recovered.environment.LAYER).toBe('override');
    });
  });
});
