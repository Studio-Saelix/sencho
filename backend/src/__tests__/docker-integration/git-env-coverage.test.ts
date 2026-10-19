/**
 * Docker-backed: a Git-managed recovery generation has to say which env files it
 * does not hold.
 *
 * The managed-project manifesto is the canonical Git file inventory, so it fixes
 * which compose layers a run loads. It says nothing about the interpolation
 * environment: Compose loads COMPOSE_ENV_FILES, or the project .env when nothing
 * selects one, on top of the `-f` list, and those values render the layers. A
 * generation that certifies complete coverage while they stay live promises an
 * exact restore it cannot make, so this case captures a real generation from a
 * real manifest, changes the operator env file, restores, and renders the
 * captured invocation with the real CLI.
 *
 * Skipped automatically when Docker is unavailable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { setupTestDb, cleanupTestDb } from '../helpers/setupTestDb';
import type { GitProjectManifest } from '../../types/gitProjectManifest';

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
const STACK = 'gitenvcoverage';

const COMPOSE = [
  'services:',
  '  web:',
  '    image: busybox:1.36.1',
  '    command: ["echo","${GREETING}"]',
  '',
].join('\n');

/** A real manifest: the same shape the pull writes, holding only compose.yaml. */
function manifestFor(nodeId: number): GitProjectManifest {
  return {
    schemaVersion: 1,
    manifestVersion: 1,
    state: 'active',
    generatedAt: Date.now(),
    identity: { nodeId: String(nodeId), stackName: STACK, repoUrl: REPO, branch: 'main' },
    repo: { url: REPO, branch: 'main' },
    resolvedRevision: { commitSha: COMMIT, fetchedAt: Date.now() },
    project: {
      root: null,
      composeFiles: ['compose.yaml'],
      effectiveProjectDir: null,
      projectName: STACK,
      invocation: ['-f', 'compose.yaml', '-p', STACK],
    },
    inputs: [{
      sourcePath: 'compose.yaml',
      materializedPath: 'compose.yaml',
      role: 'compose-primary',
      dependencyKind: 'explicit',
      ownership: 'managed',
      provenance: 'fetch',
      sensitivity: 'low',
      contentSha256: null,
      sizeBytes: null,
      state: 'present',
      deletionAuthority: 'sencho',
      note: null,
    }],
    refusals: [],
    buildContexts: [],
    generation: {
      candidateDir: 'generations/candidate',
      appliedDir: 'generations/applied',
      previousDir: null,
    },
    counts: { managed: 1, unmanaged: 0, refused: 0 },
    bounds: { maxFiles: 1_000, maxBytes: 1_000_000, maxContextBytes: 1_000_000, maxPathDepth: 64, maxFileBytes: 100_000 },
  };
}

describe.skipIf(!hasDocker)('a Git generation records the env files it does not hold', () => {
  let tmpDir: string;
  let composeDir: string;
  let stackDir: string;
  let nodeId: number;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    composeDir = process.env.COMPOSE_DIR!;
    stackDir = path.join(composeDir, STACK);
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), COMPOSE, 'utf8');
    fs.writeFileSync(path.join(stackDir, 'operator.env'), 'GREETING=old\n', 'utf8');

    const { DatabaseService } = await import('../../services/DatabaseService');
    const db = DatabaseService.getInstance();
    const local = db.getDefaultNode();
    if (!local?.id) throw new Error('Test DB has no default local node');
    nodeId = local.id;

    db.upsertGitSource({
      stack_name: STACK,
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
    db.setGitSourceAppliedSpec(STACK, { files: ['compose.yaml'], contextDir: null });
    db.setGitSourceManifestState(STACK, 1, 'active', null);

    const { GitProjectManifestService } = await import('../../services/GitProjectManifestService');
    await GitProjectManifestService.getInstance().writeManifest(STACK, manifestFor(nodeId));
  }, 120_000);

  afterAll(() => {
    if (tmpDir) cleanupTestDb(tmpDir);
  });

  it('lists an operator env file as omitted and reads its current content on restore', async () => {
    process.env.COMPOSE_ENV_FILES = 'operator.env';
    try {
      const { resolveRollbackInventory } = await import('../../services/rollbackInventory');
      const { RollbackGenerationStore } = await import('../../services/RollbackGenerationStore');
      const { describeRollbackManagedInputs, storedRestoreCoverage } = await import('../../services/updateGuard/readiness');
      const { resolveComposeProjectContextForGeneration } = await import('../../services/composeProjectContext');
      const { ComposeService } = await import('../../services/ComposeService');

      const inventory = await resolveRollbackInventory(nodeId, STACK);
      expect(inventory.coverageRefusal).toBeNull();
      expect(inventory.git).not.toBeNull();
      // The manifest is still the file inventory and the layer selection.
      expect(inventory.entries.map((entry) => entry.relativePath)).toEqual(['compose.yaml']);
      expect(inventory.invocation.composeLayers).toEqual(['compose.yaml']);
      // Compose loads the listed file on top of the -f list, so the generation
      // has to say it does not hold it.
      expect(inventory.uncapturedRelativePaths).toContain('operator.env');
      expect(inventory.uncapturedInputs.join(' ')).toContain('operator.env');

      const generationId = randomUUID();
      await RollbackGenerationStore.captureGeneration({
        nodeId,
        stackName: STACK,
        generationId,
        inventory,
      });
      const stored = await RollbackGenerationStore.readVerifiedGeneration(nodeId, STACK, generationId);
      expect(stored.uncapturedRelativePaths).toContain('operator.env');
      expect(storedRestoreCoverage(stored)).toBe('omits_inputs');
      const managedInputs = describeRollbackManagedInputs({
        coverage: 'omits_inputs',
        stored,
        live: inventory,
      });
      expect(managedInputs).toMatchObject({ covered: false });
      expect(managedInputs !== 'error' ? managedInputs.detail : '').toContain('operator.env');

      // The operator moves the env file on. No generation holds the old value,
      // so the rollback reads the current one, which is what the recorded
      // omission says.
      fs.writeFileSync(path.join(stackDir, 'operator.env'), 'GREETING=new\n', 'utf8');

      const ctx = await resolveComposeProjectContextForGeneration(nodeId, STACK, generationId);
      await ctx.restoreFromContext();
      expect(fs.readFileSync(path.join(stackDir, 'operator.env'), 'utf8')).toBe('GREETING=new\n');

      const recoveryLayer = path.join(stackDir, '.sencho-recovery-test.yml');
      fs.writeFileSync(
        recoveryLayer,
        'services:\n  web:\n    labels:\n      sencho.recovery-test: "1"\n',
        'utf8',
      );
      const args = await ComposeService.getInstance(nodeId).buildComposeArgsWithRecoveryOverride(
        STACK,
        ['config'],
        recoveryLayer,
        stored.invocation,
      );
      const prefix = args.slice(1, args.indexOf('config'));
      expect(prefix).toEqual(expect.arrayContaining(['-f', 'compose.yaml']));
      const rendered = JSON.parse(execFileSync(
        'docker',
        ['compose', '-p', STACK, ...prefix, 'config', '--format', 'json'],
        { cwd: stackDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )) as { services: { web: { command: string[] } } };
      expect(rendered.services.web.command).toEqual(['echo', 'new']);
    } finally {
      delete process.env.COMPOSE_ENV_FILES;
    }
  });

  it('lists a listed env file outside the compose folder without protecting a stack path', async () => {
    // Compose reads the file the list names, wherever it is. Sencho's
    // compose-root containment refuses to read it, and the generation still has
    // to say the run loads it: otherwise a capture would claim coverage it does
    // not have.
    const outside = path.join(composeDir, '..', 'operator-outside.env');
    fs.writeFileSync(outside, 'GREETING=outside-old\n', 'utf8');
    process.env.COMPOSE_ENV_FILES = outside;
    try {
      const { resolveRollbackInventory } = await import('../../services/rollbackInventory');
      const { RollbackGenerationStore } = await import('../../services/RollbackGenerationStore');
      const { storedRestoreCoverage } = await import('../../services/updateGuard/readiness');
      const { resolveComposeProjectContextForGeneration } = await import('../../services/composeProjectContext');
      const { ComposeService } = await import('../../services/ComposeService');

      const inventory = await resolveRollbackInventory(nodeId, STACK);
      expect(inventory.coverageRefusal).toBeNull();
      // A path outside the stack cannot be protected by a relative name, so it
      // is only named in the notes.
      expect(inventory.uncapturedRelativePaths).toEqual([]);
      expect(inventory.uncapturedInputs.join(' ')).toContain('operator-outside.env');

      const generationId = randomUUID();
      await RollbackGenerationStore.captureGeneration({
        nodeId,
        stackName: STACK,
        generationId,
        inventory,
      });
      const stored = await RollbackGenerationStore.readVerifiedGeneration(nodeId, STACK, generationId);
      expect(storedRestoreCoverage(stored)).toBe('omits_inputs');

      fs.writeFileSync(outside, 'GREETING=outside-new\n', 'utf8');
      const ctx = await resolveComposeProjectContextForGeneration(nodeId, STACK, generationId);
      await ctx.restoreFromContext();
      expect(fs.readFileSync(outside, 'utf8')).toBe('GREETING=outside-new\n');

      const recoveryLayer = path.join(stackDir, '.sencho-recovery-test.yml');
      const args = await ComposeService.getInstance(nodeId).buildComposeArgsWithRecoveryOverride(
        STACK,
        ['config'],
        recoveryLayer,
        stored.invocation,
      );
      const prefix = args.slice(1, args.indexOf('config'));
      const rendered = JSON.parse(execFileSync(
        'docker',
        ['compose', '-p', STACK, ...prefix, 'config', '--format', 'json'],
        { cwd: stackDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )) as { services: { web: { command: string[] } } };
      // The captured layers render with the file's current value, which is what
      // the recorded omission tells the operator.
      expect(rendered.services.web.command).toEqual(['echo', 'outside-new']);
    } finally {
      delete process.env.COMPOSE_ENV_FILES;
      fs.rmSync(outside, { force: true });
    }
  });
});
