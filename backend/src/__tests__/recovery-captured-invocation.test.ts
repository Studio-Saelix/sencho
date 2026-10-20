/**
 * Recovery must execute the generation-captured Compose invocation, not the
 * live database-derived file / env selection after capture.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import net from 'net';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

describe('captured invocation on recovery Compose args', () => {
  let tmpDir: string;
  let composeDir: string;
  let nodeId: number;

  // One database for the file: DatabaseService is a singleton keyed to the
  // path it first opened, so each test works in its own stack directory.
  beforeAll(async () => {
    tmpDir = await setupTestDb();
    composeDir = process.env.COMPOSE_DIR!;
    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance();
    const local = db.getDefaultNode();
    if (!local?.id) throw new Error('missing default node');
    nodeId = local.id;
  });

  afterAll(() => {
    if (tmpDir) cleanupTestDb(tmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses captured -f order and env-file when live settings diverge', async () => {
    const stackName = 'inv-capture';
    const stackDir = path.join(composeDir, stackName);
    const fsPromises = await import('fs/promises');
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services:\n  a: {}\n', 'utf8');
    await fsPromises.writeFile(path.join(stackDir, 'compose.prod.yaml'), 'services:\n  b: {}\n', 'utf8');
    await fsPromises.writeFile(path.join(stackDir, 'prod.env'), 'A=1\n', 'utf8');
    await fsPromises.writeFile(path.join(stackDir, 'dev.env'), 'A=2\n', 'utf8');

    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance();
    db.upsertGitSource({
      stack_name: stackName,
      repo_url: 'https://example.com/repo.git',
      branch: 'main',
      compose_path: 'compose.yaml',
      compose_paths: ['compose.yaml', 'compose.prod.yaml'],
      context_dir: null,
      sync_env: false,
      env_path: null,
      auth_type: 'none',
      encrypted_token: null, encrypted_deploy_key: null, ssh_known_hosts_entry: null, ssh_host_key_fingerprint: null,
            encrypted_ca_bundle: null,
      auto_apply_on_webhook: false,
      auto_deploy_on_apply: false,
      last_applied_commit_sha: 'abc',
      last_applied_content_hash: 'h',
      pending_commit_sha: null,
      pending_compose_content: null,
      pending_env_content: null,
      pending_fetched_at: null,
      last_debounce_at: null,
    });
    db.getDb().prepare(
      `UPDATE stack_git_sources SET applied_deploy_spec = ? WHERE stack_name = ?`,
    ).run(
      JSON.stringify({ files: ['compose.yaml'], contextDir: null }),
      stackName,
    );
    db.setStackProjectEnvFiles(nodeId, stackName, ['dev.env']);

    const { ComposeService } = await import('../services/ComposeService');
    const svc = ComposeService.getInstance(nodeId);
    const captured = {
      composeArgsPrefix: [
        '-f', 'compose.yaml',
        '-f', 'compose.prod.yaml',
        '-p', stackName,
        '--env-file', path.join(stackDir, 'prod.env'),
      ],
      projectDirectory: null,
      projectName: stackName,
      explicitComposeFiles: ['compose.yaml', 'compose.prod.yaml'],
    };

    const args = await svc.buildComposeArgsWithRecoveryOverride(
      stackName,
      ['up', '-d'],
      path.join(stackDir, '.sencho-recovery-aaaaaaaaaaaa.yml'),
      captured,
    );

    expect(args).toEqual([
      'compose',
      '-f', 'compose.yaml',
      '-f', 'compose.prod.yaml',
      '-p', stackName,
      '--env-file', path.resolve(stackDir, 'prod.env'),
      '-f', path.join(stackDir, '.sencho-recovery-aaaaaaaaaaaa.yml'),
      'up', '-d',
    ]);
    // Live settings would prefer only compose.yaml + dev.env; captured must win.
    expect(args.join('\0')).not.toContain('dev.env');
  });

  it('runs recovery against a selected env file that links to a sibling inside the compose root', async () => {
    const stackName = 'inv-external-env';
    const stackDir = path.join(composeDir, stackName);
    const sharedDir = path.join(composeDir, 'shared-common');
    await fs.promises.mkdir(stackDir, { recursive: true });
    await fs.promises.mkdir(sharedDir, { recursive: true });
    await fs.promises.writeFile(path.join(stackDir, 'compose.yaml'), 'services:\n  a: {}\n', 'utf8');
    const sharedEnv = path.join(sharedDir, 'app.env');
    await fs.promises.writeFile(sharedEnv, 'TOKEN=shared\n', 'utf8');
    await fs.promises.symlink('../shared-common/app.env', path.join(stackDir, 'app.env'));

    const { DatabaseService } = await import('../services/DatabaseService');
    DatabaseService.getInstance().setStackProjectEnvFiles(nodeId, stackName, ['app.env']);

    const { resolveRollbackInventory } = await import('../services/rollbackInventory');
    const { RollbackGenerationStore } = await import('../services/RollbackGenerationStore');
    const inventory = await resolveRollbackInventory(nodeId, stackName);
    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.uncapturedRelativePaths).toEqual(['app.env']);

    const manifest = await RollbackGenerationStore.captureGeneration({
      nodeId,
      stackName,
      generationId: randomUUID(),
      inventory,
    });
    const realSharedEnv = await fs.promises.realpath(sharedEnv);
    expect(manifest.invocation.composeArgsPrefix).toEqual(['--env-file', realSharedEnv]);

    const { ComposeService } = await import('../services/ComposeService');
    const args = await ComposeService.getInstance(nodeId).buildComposeArgsWithRecoveryOverride(
      stackName,
      ['up', '-d'],
      path.join(stackDir, '.sencho-recovery-aaaaaaaaaaaa.yml'),
      manifest.invocation,
    );
    // The authorized external input is what recovery has to launch with.
    expect(args).toContain(realSharedEnv);
    expect(fs.readFileSync(sharedEnv, 'utf8')).toBe('TOKEN=shared\n');
  });

  it('keeps the authorized external env file live when a recovery overlay is in play', async () => {
    const stackName = 'inv-external-env-overlay';
    const stackDir = path.join(composeDir, stackName);
    const sharedDir = path.join(composeDir, 'shared-common');
    const overlayDir = path.join(composeDir, 'overlay-op');
    await fs.promises.mkdir(stackDir, { recursive: true });
    await fs.promises.mkdir(sharedDir, { recursive: true });
    await fs.promises.mkdir(overlayDir, { recursive: true });
    await fs.promises.writeFile(path.join(stackDir, 'compose.yaml'), 'services:\n  a: {}\n', 'utf8');
    await fs.promises.writeFile(path.join(stackDir, 'app.env'), 'TOKEN=stack\n', 'utf8');
    await fs.promises.writeFile(path.join(overlayDir, 'app.env'), 'TOKEN=decrypted\n', 'utf8');
    const sharedEnv = path.join(sharedDir, 'overlay.env');
    await fs.promises.writeFile(sharedEnv, 'TOKEN=overlay\n', 'utf8');

    const { ComposeService } = await import('../services/ComposeService');
    const svc = ComposeService.getInstance(nodeId);
    const captured = {
      composeArgsPrefix: [
        '--env-file', await fs.promises.realpath(path.join(stackDir, 'app.env')),
        '--env-file', await fs.promises.realpath(sharedEnv),
      ],
      projectDirectory: null,
      projectName: stackName,
      explicitComposeFiles: [],
    };

    const args = await svc.buildComposeArgsWithRecoveryOverride(
      stackName,
      ['up', '-d'],
      path.join(stackDir, '.sencho-recovery-aaaaaaaaaaaa.yml'),
      captured,
      overlayDir,
    );

    // An in-stack env file is mirrored under the overlay; the authorized
    // external one keeps its live path, because an overlay mirrors the stack.
    expect(args).toContain(path.join(overlayDir, 'app.env'));
    expect(args).toContain(await fs.promises.realpath(sharedEnv));
  });

  it('refuses a captured env file whose link target leaves the compose root', async () => {
    const stackName = 'inv-escaping-link';
    const stackDir = path.join(composeDir, stackName);
    await fs.promises.mkdir(stackDir, { recursive: true });
    const outside = path.join(tmpDir, 'host-secret');
    await fs.promises.writeFile(outside, 'TOKEN=host\n', 'utf8');
    await fs.promises.symlink(outside, path.join(stackDir, 'app.env'));

    const { ComposeService } = await import('../services/ComposeService');
    const svc = ComposeService.getInstance(nodeId);
    const captured = {
      // The name sits inside the stack, which is what the old lexical check saw.
      composeArgsPrefix: ['--env-file', path.join(stackDir, 'app.env')],
      projectDirectory: null,
      projectName: stackName,
      explicitComposeFiles: [],
    };

    await expect(svc.buildComposeArgsWithRecoveryOverride(
      stackName,
      ['up', '-d'],
      null,
      captured,
    )).rejects.toThrow(/Captured env-file path escapes stack directory/);
  });

  it('refuses a captured env file when the stack directory itself links outside the compose root', async () => {
    const stackName = 'inv-linked-stack';
    const realStackDir = path.join(tmpDir, 'elsewhere');
    await fs.promises.mkdir(realStackDir, { recursive: true });
    await fs.promises.writeFile(path.join(realStackDir, 'app.env'), 'TOKEN=elsewhere\n', 'utf8');
    await fs.promises.symlink(realStackDir, path.join(composeDir, stackName));

    const { ComposeService } = await import('../services/ComposeService');
    const svc = ComposeService.getInstance(nodeId);
    const captured = {
      composeArgsPrefix: ['--env-file', path.join(realStackDir, 'app.env')],
      projectDirectory: null,
      projectName: stackName,
      explicitComposeFiles: [],
    };

    await expect(svc.buildComposeArgsWithRecoveryOverride(
      stackName,
      ['up', '-d'],
      null,
      captured,
    )).rejects.toThrow(/Captured env-file path escapes stack directory/);
  });

  it('refuses a captured env file through a stack directory link under a symlinked compose root', async () => {
    // A symlinked compose root makes the real root differ from the lexical
    // one; a stack directory that links outside it must still be refused,
    // which is why the real stack root is the real base plus the stack name
    // and never the stack directory's own link target.
    const stackName = 'inv-linked-stack-root';
    const realComposeDir = path.join(composeDir, 'root-real');
    const linkedComposeDir = path.join(composeDir, 'root-linked');
    const elsewhere = path.join(tmpDir, 'elsewhere');
    await fs.promises.mkdir(realComposeDir, { recursive: true });
    await fs.promises.mkdir(elsewhere, { recursive: true });
    await fs.promises.symlink(elsewhere, path.join(realComposeDir, stackName));
    await fs.promises.symlink(realComposeDir, linkedComposeDir);
    await fs.promises.writeFile(path.join(elsewhere, 'app.env'), 'TOKEN=elsewhere\n', 'utf8');

    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance();
    db.getDb().prepare('UPDATE nodes SET compose_dir = ? WHERE id = ?').run(linkedComposeDir, nodeId);
    try {
      const { ComposeService } = await import('../services/ComposeService');
      const svc = ComposeService.getInstance(nodeId);
      const captured = {
        composeArgsPrefix: ['--env-file', path.join(realComposeDir, stackName, 'app.env')],
        projectDirectory: null,
        projectName: stackName,
        explicitComposeFiles: [],
      };

      await expect(svc.buildComposeArgsWithRecoveryOverride(
        stackName,
        ['up', '-d'],
        null,
        captured,
      )).rejects.toThrow(/Captured env-file path escapes stack directory/);
    } finally {
      db.getDb().prepare('UPDATE nodes SET compose_dir = ? WHERE id = ?').run(composeDir, nodeId);
    }
  });

  it('refuses a captured env file that leaves the compose root', async () => {
    const stackName = 'inv-escaping-env';
    const stackDir = path.join(composeDir, stackName);
    await fs.promises.mkdir(stackDir, { recursive: true });

    const { ComposeService } = await import('../services/ComposeService');
    const svc = ComposeService.getInstance(nodeId);
    const captured = {
      composeArgsPrefix: ['--env-file', path.join(composeDir, '..', 'outside.env')],
      projectDirectory: null,
      projectName: stackName,
      explicitComposeFiles: [],
    };

    await expect(svc.buildComposeArgsWithRecoveryOverride(
      stackName,
      ['up', '-d'],
      null,
      captured,
    )).rejects.toThrow(/Captured env-file path escapes stack directory/);
  });

  it('runs recovery against a captured env file when the compose root is itself a symlink', async () => {
    const stackName = 'inv-linked-root';
    const realComposeDir = path.join(composeDir, 'real-root');
    const linkedComposeDir = path.join(composeDir, 'linked-root');
    const stackDir = path.join(realComposeDir, stackName);
    await fs.promises.mkdir(stackDir, { recursive: true });
    await fs.promises.symlink(realComposeDir, linkedComposeDir);
    await fs.promises.writeFile(path.join(stackDir, 'compose.yaml'), 'services:\n  a: {}\n', 'utf8');
    await fs.promises.writeFile(path.join(stackDir, 'app.env'), 'TOKEN=linked\n', 'utf8');

    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance();
    db.getDb().prepare('UPDATE nodes SET compose_dir = ? WHERE id = ?').run(linkedComposeDir, nodeId);
    db.setStackProjectEnvFiles(nodeId, stackName, ['app.env']);
    try {
      const { ComposeService } = await import('../services/ComposeService');
      const svc = ComposeService.getInstance(nodeId);
      const capturedEnv = await fs.promises.realpath(path.join(stackDir, 'app.env'));
      const captured = {
        composeArgsPrefix: ['--env-file', capturedEnv],
        projectDirectory: null,
        projectName: stackName,
        explicitComposeFiles: [],
      };

      const args = await svc.buildComposeArgsWithRecoveryOverride(stackName, ['up', '-d'], null, captured);
      const recoveredEnv = args[args.indexOf('--env-file') + 1];
      expect(await fs.promises.realpath(recoveredEnv)).toBe(capturedEnv);
    } finally {
      db.getDb().prepare('UPDATE nodes SET compose_dir = ? WHERE id = ?').run(composeDir, nodeId);
      db.setStackProjectEnvFiles(nodeId, stackName, []);
    }
  });

  it('mirrors a captured env file under the overlay when the compose root is a symlink', async () => {
    // The context-directory fallback captures the compose-root spelling of the
    // project .env, not its real path, so a linked compose root leaves the
    // captured name outside the real stack directory while the file itself is
    // inside it. Rebasing that name in the wrong coordinate system produces a
    // path that escapes the overlay, and recovery refuses a valid generation.
    const stackName = 'inv-linked-root-overlay';
    const realComposeDir = path.join(composeDir, 'real-root-overlay');
    const linkedComposeDir = path.join(composeDir, 'linked-root-overlay');
    const realStackDir = path.join(realComposeDir, stackName);
    const linkedStackDir = path.join(linkedComposeDir, stackName);
    const overlayDir = path.join(composeDir, 'overlay-linked');
    await fs.promises.mkdir(path.join(realStackDir, 'ctx'), { recursive: true });
    await fs.promises.mkdir(path.join(overlayDir, 'ctx'), { recursive: true });
    await fs.promises.symlink(realComposeDir, linkedComposeDir);
    const compose = 'services:\n  web:\n    image: nginx\n';
    await fs.promises.writeFile(path.join(realStackDir, 'compose.yaml'), compose, 'utf8');
    await fs.promises.writeFile(path.join(realStackDir, '.env'), 'MARK=original\n', 'utf8');
    await fs.promises.writeFile(path.join(overlayDir, 'compose.yaml'), compose, 'utf8');
    await fs.promises.writeFile(path.join(overlayDir, '.env'), 'MARK=decrypted\n', 'utf8');

    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance();
    db.getDb().prepare('UPDATE nodes SET compose_dir = ? WHERE id = ?').run(linkedComposeDir, nodeId);
    db.upsertGitSource({
      stack_name: stackName,
      repo_url: 'https://example.com/operator/repo.git',
      branch: 'main',
      compose_path: 'compose.yaml',
      compose_paths: ['compose.yaml'],
      context_dir: 'ctx',
      sync_env: false,
      env_path: null,
      auth_type: 'none',
      encrypted_token: null, encrypted_deploy_key: null, ssh_known_hosts_entry: null, ssh_host_key_fingerprint: null,
      encrypted_ca_bundle: null,
      auto_apply_on_webhook: false,
      auto_deploy_on_apply: false,
      last_applied_commit_sha: 'a'.repeat(40),
      last_applied_content_hash: 'content',
      pending_commit_sha: null,
      pending_compose_content: null,
      pending_env_content: null,
      pending_fetched_at: null,
      last_debounce_at: null,
    });
    db.setGitSourceAppliedSpec(stackName, { files: ['compose.yaml'], contextDir: 'ctx' });
    try {
      const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
      const manifestService = GitProjectManifestService.getInstance();
      const gitSource = db.getGitSource(stackName);
      if (!gitSource) throw new Error('missing Git source');
      await manifestService.writeManifest(
        stackName,
        await manifestService.buildMigratedManifest(stackName, gitSource),
      );

      const { resolveRollbackInventory } = await import('../services/rollbackInventory');
      const { RollbackGenerationStore } = await import('../services/RollbackGenerationStore');
      const { ComposeService } = await import('../services/ComposeService');

      const inventory = await resolveRollbackInventory(nodeId, stackName);
      expect(inventory.coverageRefusal).toBeNull();
      const generationId = randomUUID();
      const captured = await RollbackGenerationStore.captureGeneration({
        nodeId,
        stackName,
        generationId,
        inventory,
      });
      const capturedEnv = captured.invocation.composeArgsPrefix[
        captured.invocation.composeArgsPrefix.indexOf('--env-file') + 1
      ];
      // The fallback records the compose-root spelling, which is the linked one.
      expect(capturedEnv).toBe(path.join(linkedStackDir, '.env'));

      const args = await ComposeService.getInstance(nodeId).buildComposeArgsWithRecoveryOverride(
        stackName,
        ['up', '-d'],
        null,
        captured.invocation,
        overlayDir,
      );
      // The mirror is the overlay's counterpart of the file the run loads, not
      // the overlay root plus a name that only exists in the linked spelling.
      expect(args[args.indexOf('--env-file') + 1]).toBe(path.join(overlayDir, '.env'));
      expect(fs.readFileSync(path.join(realStackDir, '.env'), 'utf8')).toBe('MARK=original\n');
    } finally {
      db.getDb().prepare('UPDATE nodes SET compose_dir = ? WHERE id = ?').run(composeDir, nodeId);
      // The fixtures share this file's compose root with every other test in
      // it, so the link and the trees it introduced are removed rather than
      // left for a later test to resolve through.
      await fs.promises.rm(linkedComposeDir, { force: true });
      await fs.promises.rm(realComposeDir, { recursive: true, force: true });
      await fs.promises.rm(overlayDir, { recursive: true, force: true });
    }
  });

  it('pins the captured root when an ordinary stack captured no -f and a higher-priority root appeared', async () => {
    const stackName = 'inv-late-root';
    const stackDir = path.join(composeDir, stackName);
    await fs.promises.mkdir(stackDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(stackDir, 'docker-compose.yml'),
      'services:\n  web:\n    image: nginx\n',
      'utf8',
    );

    // A real authored capture: no applied deploy spec, so the prefix is empty
    // and Compose's own discovery chose docker-compose.yml at deploy time.
    const { resolveRollbackInventory } = await import('../services/rollbackInventory');
    const inventory = await resolveRollbackInventory(nodeId, stackName);
    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.invocation.composeArgsPrefix).toEqual([]);
    expect(inventory.invocation.composeLayers).toEqual(['docker-compose.yml']);

    const captured = {
      composeArgsPrefix: inventory.invocation.composeArgsPrefix,
      projectDirectory: null,
      projectName: stackName,
      explicitComposeFiles: inventory.invocation.explicitComposeFiles,
      composeLayers: inventory.invocation.composeLayers,
    };

    // A later edit adds a root Compose prefers over the captured one.
    await fs.promises.writeFile(
      path.join(stackDir, 'compose.yaml'),
      'services:\n  web:\n    image: nginx\n    command: ["false"]\n',
      'utf8',
    );

    const { ComposeService } = await import('../services/ComposeService');
    const args = await ComposeService.getInstance(nodeId).buildComposeArgsWithRecoveryOverride(
      stackName,
      ['up', '-d'],
      null,
      captured,
    );
    expect(args).toEqual(['compose', '-f', 'docker-compose.yml', 'up', '-d']);
  });

  it('names the implicit override for a generation captured before compose layers were recorded', async () => {
    const stackName = 'inv-legacy-override';
    const stackDir = path.join(composeDir, stackName);
    await fs.promises.mkdir(stackDir, { recursive: true });
    await fs.promises.writeFile(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n', 'utf8');
    await fs.promises.writeFile(
      path.join(stackDir, 'docker-compose.override.yml'),
      'services:\n  web:\n    environment:\n      - FOO=bar\n',
      'utf8',
    );

    const { ComposeService } = await import('../services/ComposeService');
    const captured = {
      composeArgsPrefix: [],
      projectDirectory: null,
      projectName: stackName,
      explicitComposeFiles: [],
    };

    const recoveryOverride = path.join(stackDir, '.sencho-recovery-aaaaaaaaaaaa.yml');
    const args = await ComposeService.getInstance(nodeId).buildComposeArgsWithRecoveryOverride(
      stackName,
      ['up', '-d'],
      recoveryOverride,
      captured,
    );
    // The trailing recovery layer would otherwise suppress the override the
    // stack's own compose run loads.
    expect(args).toEqual([
      'compose',
      '-f', 'compose.yaml',
      '-f', 'docker-compose.override.yml',
      '-f', recoveryOverride,
      'up', '-d',
    ]);
  });

  it('does not pin an included file as a project-root layer', async () => {
    const stackName = 'inv-include-layer';
    const stackDir = path.join(composeDir, stackName);
    await fs.promises.mkdir(path.join(stackDir, 'inc'), { recursive: true });
    await fs.promises.writeFile(path.join(stackDir, 'inc', 'base.yaml'), 'services: {}\n', 'utf8');
    await fs.promises.writeFile(
      path.join(stackDir, 'docker-compose.yml'),
      'include:\n  - ./inc/base.yaml\nservices:\n  web:\n    image: nginx\n',
      'utf8',
    );

    const { resolveRollbackInventory } = await import('../services/rollbackInventory');
    const inventory = await resolveRollbackInventory(nodeId, stackName);
    expect(inventory.coverageRefusal).toBeNull();
    // The include is an input, so it is named as an explicit compose file but
    // never as a project-root layer.
    expect(inventory.invocation.explicitComposeFiles).toContain('inc/base.yaml');
    expect(inventory.invocation.composeLayers).toEqual(['docker-compose.yml']);

    const { ComposeService } = await import('../services/ComposeService');
    const args = await ComposeService.getInstance(nodeId).buildComposeArgsWithRecoveryOverride(
      stackName,
      ['up', '-d'],
      null,
      inventory.invocation,
    );
    expect(args).toEqual(['compose', '-f', 'docker-compose.yml', 'up', '-d']);
  });

  function layerInvocation(stackName: string, layers: string[], prefix: string[] = []) {
    return {
      composeArgsPrefix: prefix,
      projectDirectory: null,
      projectName: stackName,
      explicitComposeFiles: layers,
      composeLayers: prefix.some((token) => token === '-f' || token === '--file') ? undefined : layers,
      meshEnabled: false,
    };
  }

  it('accepts a shared compose layer whose target stays inside the compose root', async () => {
    const stackName = 'inv-shared-layer';
    const stackDir = path.join(composeDir, stackName);
    const shared = path.join(composeDir, 'shared-base.yaml');
    await fs.promises.mkdir(stackDir, { recursive: true });
    await fs.promises.writeFile(shared, 'services:\n  web:\n    image: nginx\n', 'utf8');
    await fs.promises.symlink(shared, path.join(stackDir, 'compose.yaml'));

    const { ComposeService } = await import('../services/ComposeService');
    const args = await ComposeService.getInstance(nodeId).buildComposeArgsWithRecoveryOverride(
      stackName,
      ['up', '-d'],
      null,
      layerInvocation(stackName, ['compose.yaml']),
    );

    expect(args).toEqual(['compose', '-f', 'compose.yaml', 'up', '-d']);
  });

  it('refuses a compose layer retargeted outside the compose root before Compose runs', async () => {
    const stackName = 'inv-escaped-layer';
    const stackDir = path.join(composeDir, stackName);
    await fs.promises.mkdir(stackDir, { recursive: true });
    const inside = path.join(composeDir, 'inside.yaml');
    const outside = path.join(tmpDir, 'outside.yaml');
    await fs.promises.writeFile(inside, 'services:\n  web:\n    image: nginx\n', 'utf8');
    await fs.promises.writeFile(outside, 'services:\n  web:\n    image: evil\n', 'utf8');
    const link = path.join(stackDir, 'compose.yaml');
    await fs.promises.symlink(inside, link);
    await fs.promises.unlink(link);
    await fs.promises.symlink(outside, link);

    const { FileSystemService } = await import('../services/FileSystemService');
    await expect(FileSystemService.getInstance(nodeId).getStackContent(stackName))
      .rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });

    const { ComposeService } = await import('../services/ComposeService');
    const svc = ComposeService.getInstance(nodeId);
    const invocation = layerInvocation(stackName, ['compose.yaml']);
    await expect(svc.buildComposeArgsWithRecoveryOverride(
      stackName,
      ['up', '-d'],
      null,
      invocation,
    )).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    await expect(svc.composeUpWithRecoveryOverride(
      stackName,
      path.join(stackDir, '.sencho-recovery-unused.yml'),
      undefined,
      invocation,
    )).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    expect(await fs.promises.readFile(outside, 'utf8')).toContain('evil');
  });

  it('refuses an explicit -f layer and a shared override retargeted outside the compose root', async () => {
    const stackName = 'inv-escaped-override';
    const stackDir = path.join(composeDir, stackName);
    await fs.promises.mkdir(stackDir, { recursive: true });
    await fs.promises.writeFile(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n', 'utf8');
    const outside = path.join(tmpDir, 'outside-override.yaml');
    await fs.promises.writeFile(outside, 'services:\n  web:\n    image: evil\n', 'utf8');
    await fs.promises.symlink(outside, path.join(stackDir, 'compose.override.yml'));

    const { ComposeService } = await import('../services/ComposeService');
    const svc = ComposeService.getInstance(nodeId);
    await expect(svc.buildComposeArgsWithRecoveryOverride(
      stackName,
      ['up', '-d'],
      null,
      layerInvocation(stackName, ['compose.yaml', 'compose.override.yml']),
    )).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    await expect(svc.buildComposeArgsWithRecoveryOverride(
      stackName,
      ['up', '-d'],
      null,
      layerInvocation(stackName, ['compose.yaml'], ['-f', 'compose.override.yml']),
    )).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
  });

  it('allows a missing captured layer and refuses a dangling one', async () => {
    const stackName = 'inv-missing-layer';
    const stackDir = path.join(composeDir, stackName);
    await fs.promises.mkdir(stackDir, { recursive: true });
    const file = path.join(stackDir, 'compose.yaml');
    await fs.promises.writeFile(file, 'services: {}\n', 'utf8');
    await fs.promises.rm(file);

    const { ComposeService } = await import('../services/ComposeService');
    const svc = ComposeService.getInstance(nodeId);
    const args = await svc.buildComposeArgsWithRecoveryOverride(
      stackName,
      ['up', '-d'],
      null,
      layerInvocation(stackName, ['compose.yaml']),
    );
    expect(args).toContain('compose.yaml');

    await fs.promises.symlink(path.join(stackDir, 'gone.yaml'), file);
    await expect(svc.buildComposeArgsWithRecoveryOverride(
      stackName,
      ['up', '-d'],
      null,
      layerInvocation(stackName, ['compose.yaml']),
    )).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
  });

  it('replays the recorded interpolation env files of a pinned COMPOSE_FILE selection in order', async () => {
    const stackName = 'inv-interpolation-env';
    const stackDir = path.join(composeDir, stackName);
    await fs.promises.mkdir(path.join(stackDir, 'sub'), { recursive: true });
    await fs.promises.writeFile(
      path.join(stackDir, 'compose.yaml'),
      'services:\n  web:\n    extends:\n      file: sub/compose.yaml\n      service: web\n',
      'utf8',
    );
    await fs.promises.writeFile(
      path.join(stackDir, 'sub', 'compose.yaml'),
      'services:\n  web:\n    image: nginx\n',
      'utf8',
    );
    await fs.promises.writeFile(path.join(stackDir, '.env'), 'COMPOSE_FILE=sub/compose.yaml\nROOT_ONLY=captured\n', 'utf8');
    await fs.promises.writeFile(path.join(stackDir, 'sub', '.env'), 'SUBVAR=captured\n', 'utf8');

    // A real authored capture: the chain moves the project directory into the
    // subdirectory, so the invocation records the env files the live run
    // applied, the project file first and the stack root file last.
    const { resolveRollbackInventory } = await import('../services/rollbackInventory');
    const inventory = await resolveRollbackInventory(nodeId, stackName);
    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.invocation.composeLayers).toEqual(['sub/compose.yaml']);
    expect(inventory.invocation.interpolationEnvFiles).toEqual(['sub/.env', '.env']);

    const { ComposeService } = await import('../services/ComposeService');
    const args = await ComposeService.getInstance(nodeId).buildComposeArgsWithRecoveryOverride(
      stackName,
      ['up', '-d'],
      null,
      inventory.invocation,
    );
    // The flags keep the live order, because Compose applies repeated
    // --env-file arguments in sequence and the last one wins a key both
    // files define: without them the root values the live run rendered with
    // fall back after the rollback.
    expect(args).toEqual([
      'compose',
      '-f', 'sub/compose.yaml',
      '--env-file', path.resolve(stackDir, 'sub', '.env'),
      '--env-file', path.resolve(stackDir, '.env'),
      'up', '-d',
    ]);
  });

  it('adds no env-file flags for a generation captured before interpolation env files were recorded', async () => {
    const stackName = 'inv-legacy-interpolation';
    const stackDir = path.join(composeDir, stackName);
    await fs.promises.mkdir(stackDir, { recursive: true });
    await fs.promises.writeFile(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n', 'utf8');

    const { ComposeService } = await import('../services/ComposeService');
    const args = await ComposeService.getInstance(nodeId).buildComposeArgsWithRecoveryOverride(
      stackName,
      ['up', '-d'],
      null,
      layerInvocation(stackName, ['compose.yaml']),
    );
    expect(args).toEqual(['compose', '-f', 'compose.yaml', 'up', '-d']);
  });

  /**
   * Put a special file where an omitted shared input used to be. The capture
   * never held these bytes, so the restore leaves the path alone: only recovery
   * can notice that Compose is about to be handed something it cannot read.
   */
  async function replaceWithSpecialFile(
    target: string,
    kind: 'fifo' | 'directory' | 'socket',
    run: () => Promise<void>,
  ): Promise<void> {
    await fs.promises.rm(target, { recursive: true, force: true });
    if (kind === 'directory') {
      await fs.promises.mkdir(target);
      await run();
      return;
    }
    if (kind === 'fifo') {
      execFileSync('mkfifo', [target]);
      await run();
      return;
    }
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(target, resolve);
    });
    try {
      await run();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  async function captureSharedComposeLayer() {
    const stackName = 'inv-special-layer';
    const stackDir = path.join(composeDir, stackName);
    const sharedDir = path.join(composeDir, 'shared-special-layer');
    const shared = path.join(sharedDir, 'base.yaml');
    await fs.promises.mkdir(stackDir, { recursive: true });
    await fs.promises.mkdir(sharedDir, { recursive: true });
    await fs.promises.writeFile(shared, 'services:\n  web:\n    image: nginx\n', 'utf8');
    await fs.promises.symlink(shared, path.join(stackDir, 'compose.yaml'));

    const { resolveRollbackInventory } = await import('../services/rollbackInventory');
    const { RollbackGenerationStore } = await import('../services/RollbackGenerationStore');
    const inventory = await resolveRollbackInventory(nodeId, stackName);
    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.uncapturedRelativePaths).toEqual(['compose.yaml']);
    const manifest = await RollbackGenerationStore.captureGeneration({
      nodeId,
      stackName,
      generationId: randomUUID(),
      inventory,
    });
    expect(manifest.invocation.composeLayers).toEqual(['compose.yaml']);
    return { stackName, stackDir, shared, invocation: manifest.invocation };
  }

  async function captureSharedEnvFile() {
    const stackName = 'inv-special-env';
    const stackDir = path.join(composeDir, stackName);
    const sharedDir = path.join(composeDir, 'shared-special-env');
    const shared = path.join(sharedDir, 'app.env');
    await fs.promises.mkdir(stackDir, { recursive: true });
    await fs.promises.mkdir(sharedDir, { recursive: true });
    await fs.promises.writeFile(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n', 'utf8');
    await fs.promises.writeFile(shared, 'TOKEN=shared\n', 'utf8');
    await fs.promises.symlink(shared, path.join(stackDir, 'app.env'));

    const { DatabaseService } = await import('../services/DatabaseService');
    DatabaseService.getInstance().setStackProjectEnvFiles(nodeId, stackName, ['app.env']);

    const { resolveRollbackInventory } = await import('../services/rollbackInventory');
    const { RollbackGenerationStore } = await import('../services/RollbackGenerationStore');
    const inventory = await resolveRollbackInventory(nodeId, stackName);
    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.uncapturedRelativePaths).toEqual(['app.env']);
    const manifest = await RollbackGenerationStore.captureGeneration({
      nodeId,
      stackName,
      generationId: randomUUID(),
      inventory,
    });
    const realSharedEnv = await fs.promises.realpath(shared);
    expect(manifest.invocation.composeArgsPrefix).toEqual(['--env-file', realSharedEnv]);
    return { stackName, stackDir, shared, realSharedEnv, invocation: manifest.invocation };
  }

  it.skipIf(process.platform === 'win32')(
    'refuses a captured shared compose layer that became a special file after capture',
    async () => {
      const { stackName, stackDir, shared, invocation } = await captureSharedComposeLayer();
      const { ComposeService } = await import('../services/ComposeService');
      const svc = ComposeService.getInstance(nodeId);
      const execute = vi.spyOn(svc as unknown as {
        execute: (...args: unknown[]) => Promise<void>;
      }, 'execute').mockResolvedValue(undefined);

      // A regular shared target keeps the supported partial recovery path.
      await expect(svc.buildComposeArgsWithRecoveryOverride(
        stackName,
        ['up', '-d'],
        null,
        invocation,
      )).resolves.toEqual(['compose', '-f', 'compose.yaml', 'up', '-d']);

      for (const kind of ['fifo', 'directory', 'socket'] as const) {
        await replaceWithSpecialFile(shared, kind, async () => {
          await expect(svc.buildComposeArgsWithRecoveryOverride(
            stackName,
            ['up', '-d'],
            null,
            invocation,
          )).rejects.toMatchObject({ code: 'NOT_A_FILE' });
          // The refusal comes from rebuilding the invocation, so it lands
          // before the execution boundary: a FIFO never reaches Compose, which
          // would wait for a writer instead of naming the invalid input.
          await expect(svc.composeUpWithRecoveryOverride(
            stackName,
            path.join(stackDir, '.sencho-recovery-unused.yml'),
            undefined,
            invocation,
          )).rejects.toMatchObject({ code: 'NOT_A_FILE' });
        });
      }
      expect(execute).not.toHaveBeenCalled();

      // A target that comes back as a regular file is accepted again.
      await fs.promises.writeFile(shared, 'services:\n  web:\n    image: nginx\n', 'utf8');
      await expect(svc.buildComposeArgsWithRecoveryOverride(
        stackName,
        ['up', '-d'],
        null,
        invocation,
      )).resolves.toEqual(['compose', '-f', 'compose.yaml', 'up', '-d']);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a captured shared env file that became a special file after capture',
    async () => {
      const { stackName, stackDir, shared, realSharedEnv, invocation } = await captureSharedEnvFile();
      const { ComposeService } = await import('../services/ComposeService');
      const svc = ComposeService.getInstance(nodeId);
      const execute = vi.spyOn(svc as unknown as {
        execute: (...args: unknown[]) => Promise<void>;
      }, 'execute').mockResolvedValue(undefined);

      const regular = await svc.buildComposeArgsWithRecoveryOverride(
        stackName,
        ['up', '-d'],
        null,
        invocation,
      );
      expect(regular[regular.indexOf('--env-file') + 1]).toBe(realSharedEnv);

      for (const kind of ['fifo', 'directory', 'socket'] as const) {
        await replaceWithSpecialFile(shared, kind, async () => {
          await expect(svc.buildComposeArgsWithRecoveryOverride(
            stackName,
            ['up', '-d'],
            null,
            invocation,
          )).rejects.toMatchObject({ code: 'NOT_A_FILE' });
          await expect(svc.composeUpWithRecoveryOverride(
            stackName,
            path.join(stackDir, '.sencho-recovery-unused.yml'),
            undefined,
            invocation,
          )).rejects.toMatchObject({ code: 'NOT_A_FILE' });
        });
      }
      expect(execute).not.toHaveBeenCalled();

      await fs.promises.writeFile(shared, 'TOKEN=shared\n', 'utf8');
      const restored = await svc.buildComposeArgsWithRecoveryOverride(
        stackName,
        ['up', '-d'],
        null,
        invocation,
      );
      expect(restored[restored.indexOf('--env-file') + 1]).toBe(realSharedEnv);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a captured env file that the recovery overlay holds as a special file',
    async () => {
      // The captured env file is a regular in-stack file, so the generation
      // holds it, but recovery reads the overlay mirror when one is in play.
      // The check has to land on that mirror, which is the path Compose opens.
      const stackName = 'inv-overlay-special-env';
      const stackDir = path.join(composeDir, stackName);
      const overlayDir = path.join(composeDir, 'overlay-special-env');
      await fs.promises.mkdir(stackDir, { recursive: true });
      await fs.promises.mkdir(overlayDir, { recursive: true });
      await fs.promises.writeFile(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n', 'utf8');
      await fs.promises.writeFile(path.join(stackDir, 'app.env'), 'TOKEN=held\n', 'utf8');
      await fs.promises.writeFile(path.join(overlayDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n', 'utf8');

      const { DatabaseService } = await import('../services/DatabaseService');
      DatabaseService.getInstance().setStackProjectEnvFiles(nodeId, stackName, ['app.env']);

      const { resolveRollbackInventory } = await import('../services/rollbackInventory');
      const { RollbackGenerationStore } = await import('../services/RollbackGenerationStore');
      const inventory = await resolveRollbackInventory(nodeId, stackName);
      expect(inventory.coverageRefusal).toBeNull();
      const manifest = await RollbackGenerationStore.captureGeneration({
        nodeId,
        stackName,
        generationId: randomUUID(),
        inventory,
      });
      expect(manifest.invocation.composeArgsPrefix).toEqual([
        '--env-file',
        await fs.promises.realpath(path.join(stackDir, 'app.env')),
      ]);

      const { ComposeService } = await import('../services/ComposeService');
      const svc = ComposeService.getInstance(nodeId);
      const overlayEnv = path.join(overlayDir, 'app.env');
      await fs.promises.writeFile(overlayEnv, 'TOKEN=decrypted\n', 'utf8');
      const args = await svc.buildComposeArgsWithRecoveryOverride(
        stackName,
        ['up', '-d'],
        null,
        manifest.invocation,
        overlayDir,
      );
      expect(args[args.indexOf('--env-file') + 1]).toBe(overlayEnv);

      await replaceWithSpecialFile(overlayEnv, 'fifo', async () => {
        await expect(svc.buildComposeArgsWithRecoveryOverride(
          stackName,
          ['up', '-d'],
          null,
          manifest.invocation,
          overlayDir,
        )).rejects.toMatchObject({ code: 'NOT_A_FILE' });
      });
    },
  );

  it('keeps a prefix that names its own env file, and refuses an escaping recorded one', async () => {
    const stackName = 'inv-interpolation-guard';
    const stackDir = path.join(composeDir, stackName);
    await fs.promises.mkdir(path.join(stackDir, 'sub'), { recursive: true });
    await fs.promises.writeFile(path.join(stackDir, 'sub', 'compose.yaml'), 'services:\n  web:\n    image: nginx\n', 'utf8');
    await fs.promises.writeFile(path.join(stackDir, 'select.env'), 'A=1\n', 'utf8');

    const { ComposeService } = await import('../services/ComposeService');
    const svc = ComposeService.getInstance(nodeId);
    // The captured prefix already selected its env file, so the recorded list
    // is not replayed beside it.
    const replayed = await svc.buildComposeArgsWithRecoveryOverride(
      stackName,
      ['up', '-d'],
      null,
      {
        ...layerInvocation(stackName, ['sub/compose.yaml'], ['--env-file', path.join(stackDir, 'select.env')]),
        interpolationEnvFiles: ['sub/.env', '.env'],
      },
    );
    expect(replayed.join('\0')).toContain('--env-file\0' + path.resolve(stackDir, 'select.env'));
    expect(replayed).not.toContain('.env');

    // A recorded path that escapes the stack directory is refused rather
    // than followed.
    await expect(svc.buildComposeArgsWithRecoveryOverride(
      stackName,
      ['up', '-d'],
      null,
      {
        ...layerInvocation(stackName, ['sub/compose.yaml']),
        interpolationEnvFiles: ['../escape.env'],
      },
    )).rejects.toThrow(/Invalid captured interpolation env file/);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a restore before any project file moves when a live interpolation input is not a regular file',
    async () => {
      const stackName = 'inv-restore-env-special';
      const stackDir = path.join(composeDir, stackName);
      await fs.promises.mkdir(stackDir, { recursive: true });
      await fs.promises.writeFile(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n', 'utf8');
      await fs.promises.writeFile(path.join(stackDir, '.env'), 'MARK=captured\n', 'utf8');

      const { resolveComposeProjectContext } = await import('../services/composeProjectContext');
      const context = await resolveComposeProjectContext(nodeId, stackName);
      expect(await context.backupFromContext('deployment')).toBeTruthy();

      // The generation holds the old bytes, so a restore would normally write
      // them back. An unreadable live interpolation input has to stop it first:
      // a directory is prompt for every reader, so this exercises the refusal
      // path without needing the FIFO's external deadline.
      await fs.promises.writeFile(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: changed\n', 'utf8');
      await fs.promises.rm(path.join(stackDir, '.env'));
      await fs.promises.mkdir(path.join(stackDir, '.env'));

      await expect(context.restoreFromContext()).rejects.toMatchObject({
        code: 'NOT_A_FILE',
        message: expect.stringContaining('.env'),
      });
      expect(await fs.promises.readFile(path.join(stackDir, 'compose.yaml'), 'utf8')).toBe(
        'services:\n  web:\n    image: changed\n',
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a recovery run whose process-selected env file is not a regular file',
    async () => {
      const stackName = 'inv-process-env-special';
      const stackDir = path.join(composeDir, stackName);
      const envFile = path.join(stackDir, 'operator.env');
      await fs.promises.mkdir(stackDir, { recursive: true });
      await fs.promises.writeFile(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n', 'utf8');

      const previous = process.env.COMPOSE_ENV_FILES;
      process.env.COMPOSE_ENV_FILES = 'operator.env';
      try {
        const { ComposeService } = await import('../services/ComposeService');
        const svc = ComposeService.getInstance(nodeId);
        const execute = vi.spyOn(svc as unknown as {
          execute: (...args: unknown[]) => Promise<void>;
        }, 'execute').mockResolvedValue(undefined);

        for (const kind of ['fifo', 'directory'] as const) {
          await replaceWithSpecialFile(envFile, kind, async () => {
            // The captured invocation does not name this file, so only the
            // inherited variable carries it into the child; the refusal has to
            // land before the spawn.
            await expect(svc.composeUpWithRecoveryOverride(
              stackName,
              path.join(stackDir, '.sencho-recovery-unused.yml'),
            )).rejects.toMatchObject({ code: 'NOT_A_FILE' });
          });
        }
        expect(execute).not.toHaveBeenCalled();

        // An explicit --env-file replaces the process list for interpolation,
        // so a stale special file there cannot reach this run and must not
        // refuse it.
        await fs.promises.writeFile(path.join(stackDir, 'app.env'), 'A=1\n', 'utf8');
        await expect(svc.composeUpWithRecoveryOverride(
          stackName,
          path.join(stackDir, '.sencho-recovery-unused.yml'),
          undefined,
          layerInvocation(stackName, [], ['--env-file', path.join(stackDir, 'app.env')]),
        )).resolves.toEqual({ mutatedByCompose: true });
        expect(execute).toHaveBeenCalledTimes(1);

        // A compose layer literally named `--env-file` is the `-f` operand, not
        // an env-file flag, so Compose still reads the process list and the
        // guard has to keep checking it.
        await fs.promises.rm(path.join(stackDir, 'app.env'));
        await fs.promises.writeFile(
          path.join(stackDir, '--env-file'),
          'services:\n  web:\n    image: nginx\n',
          'utf8',
        );
        await expect(svc.composeUpWithRecoveryOverride(
          stackName,
          path.join(stackDir, '.sencho-recovery-unused.yml'),
          undefined,
          layerInvocation(stackName, ['--env-file']),
        )).rejects.toMatchObject({ code: 'NOT_A_FILE' });
        expect(execute).toHaveBeenCalledTimes(1);
      } finally {
        if (previous === undefined) delete process.env.COMPOSE_ENV_FILES;
        else process.env.COMPOSE_ENV_FILES = previous;
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'recovers through a spaced COMPOSE_ENV_FILES entry under the name Compose opens',
    async () => {
      const stackName = 'inv-process-env-spaced';
      const stackDir = path.join(composeDir, stackName);
      // Compose uses a non-empty entry verbatim, so the spaces are filename
      // characters. The plain sibling directory is the target a reader that
      // trimmed the entry would stat instead.
      const spacedEnv = path.join(stackDir, ' plain.env ');
      await fs.promises.mkdir(stackDir, { recursive: true });
      await fs.promises.mkdir(path.join(stackDir, 'plain.env'));
      await fs.promises.writeFile(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n', 'utf8');
      await fs.promises.writeFile(spacedEnv, 'VALUE=spaced\n', 'utf8');
      await fs.promises.writeFile(path.join(stackDir, 'select.env'), 'VALUE=explicit\n', 'utf8');

      const previous = process.env.COMPOSE_ENV_FILES;
      process.env.COMPOSE_ENV_FILES = ' plain.env ';
      try {
        const { resolveRollbackInventory } = await import('../services/rollbackInventory');
        const inventory = await resolveRollbackInventory(nodeId, stackName);
        expect(inventory.coverageRefusal).toBeNull();
        // The capture names the same spaced file, so the guard below and the
        // omission note share one entry selection.
        expect(inventory.uncapturedInputs.some(
          (note) => note.includes(' plain.env ') && note.includes('COMPOSE_ENV_FILES'),
        )).toBe(true);

        const { ComposeService } = await import('../services/ComposeService');
        const svc = ComposeService.getInstance(nodeId);
        const execute = vi.spyOn(svc as unknown as {
          execute: (...args: unknown[]) => Promise<void>;
        }, 'execute').mockResolvedValue(undefined);

        await expect(svc.composeUpWithRecoveryOverride(
          stackName,
          path.join(stackDir, '.sencho-recovery-unused.yml'),
        )).resolves.toEqual({ mutatedByCompose: true });
        expect(execute).toHaveBeenCalledTimes(1);
        // The child inherits the variable verbatim: the guard inspects the file
        // Compose opens and never rewrites the value it passes on.
        expect(process.env.COMPOSE_ENV_FILES).toBe(' plain.env ');

        // An explicit --env-file replaces the process list for interpolation,
        // so the spaced entry cannot reach this run and must not refuse it.
        await expect(svc.composeUpWithRecoveryOverride(
          stackName,
          path.join(stackDir, '.sencho-recovery-unused.yml'),
          undefined,
          layerInvocation(stackName, [], ['--env-file', path.join(stackDir, 'select.env')]),
        )).resolves.toEqual({ mutatedByCompose: true });
        expect(execute).toHaveBeenCalledTimes(2);
      } finally {
        if (previous === undefined) delete process.env.COMPOSE_ENV_FILES;
        else process.env.COMPOSE_ENV_FILES = previous;
      }
    },
  );

  it('keeps live paths when the current env selection cannot be decided', async () => {
    const stackName = 'inv-undecidable-live-env';
    const stackDir = path.join(composeDir, stackName);
    const composeFile = path.join(stackDir, 'compose.yaml');
    const laterEnv = path.join(stackDir, 'later.env');
    await fs.promises.mkdir(stackDir, { recursive: true });
    await fs.promises.writeFile(composeFile, [
      'services:',
      '  web:',
      '    image: busybox',
      '    env_file:',
      '      - path: later.env',
      '        required: false',
      '',
    ].join('\n'), 'utf8');

    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance();
    // An enabled Mesh stack pins its own -f list, so an undecidable live
    // selection holds the coverage claim at Partial instead of refusing.
    db.insertMeshStack(nodeId, stackName, null);

    const { resolveRollbackInventory } = await import('../services/rollbackInventory');
    const { RollbackGenerationStore } = await import('../services/RollbackGenerationStore');
    const { resolveComposeProjectContextForGeneration } = await import('../services/composeProjectContext');

    const carried = await resolveRollbackInventory(nodeId, stackName);
    expect(carried.coverageRefusal).toBeNull();
    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId,
      stackName,
      generationId,
      inventory: carried,
    });

    // A file appears after capture at a path the live project manages, and the
    // live selection becomes one this reader cannot reproduce.
    await fs.promises.writeFile(composeFile, [
      'services:',
      '  web:',
      '    image: nginx',
      '    env_file:',
      '      - path: later.env',
      '        required: false',
      '',
    ].join('\n'), 'utf8');
    await fs.promises.writeFile(laterEnv, 'X=1\n', 'utf8');
    await fs.promises.writeFile(path.join(stackDir, 'select.env'), 'BAD="unterminated\n', 'utf8');
    const previous = process.env.COMPOSE_ENV_FILES;
    process.env.COMPOSE_ENV_FILES = 'select.env';
    try {
      const live = await resolveRollbackInventory(nodeId, stackName);
      expect(live.coverageRefusal).toBeNull();
      expect(live.recoveryRefusal).not.toBeNull();

      const ctx = await resolveComposeProjectContextForGeneration(nodeId, stackName, generationId);
      await ctx.restoreFromContext();
      await RollbackGenerationStore.commitRestoreTransaction(nodeId, stackName, generationId);

      expect(await fs.promises.readFile(composeFile, 'utf8')).toContain('busybox');
      await expect(fs.promises.readFile(laterEnv, 'utf8')).resolves.toBe('X=1\n');
    } finally {
      if (previous === undefined) delete process.env.COMPOSE_ENV_FILES;
      else process.env.COMPOSE_ENV_FILES = previous;
    }

    // Control: a decidable selection makes the same live path a cleanup
    // candidate, so the survival above is the ownership guard and not a path
    // the restore never considered.
    const control = await resolveComposeProjectContextForGeneration(nodeId, stackName, generationId);
    await control.restoreFromContext();
    await RollbackGenerationStore.commitRestoreTransaction(nodeId, stackName, generationId);
    await expect(fs.promises.readFile(laterEnv, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores a captured env file after the live selection moves to an unusable one', async () => {
    const stackName = 'inv-unrelated-live-env';
    const stackDir = path.join(composeDir, stackName);
    const original = 'services:\n  web:\n    image: busybox\n    command: ["echo", "${MARK}"]\n';
    const override = 'services:\n  web:\n    image: nginx\n';
    const composeFile = path.join(stackDir, 'compose.yaml');
    const overrideFile = path.join(stackDir, 'compose.override.yaml');
    const oldEnv = path.join(stackDir, 'old.env');
    const newEnv = path.join(stackDir, 'new.env');
    await fs.promises.mkdir(stackDir, { recursive: true });
    await fs.promises.writeFile(composeFile, original, 'utf8');
    await fs.promises.writeFile(oldEnv, 'MARK=captured\n', 'utf8');

    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance();
    db.setStackProjectEnvFiles(nodeId, stackName, ['old.env']);

    const { resolveComposeProjectContext } = await import('../services/composeProjectContext');
    const { RollbackGenerationStore } = await import('../services/RollbackGenerationStore');
    const { ComposeService } = await import('../services/ComposeService');

    const context = await resolveComposeProjectContext(nodeId, stackName);
    const generationId = await context.backupFromContext('deployment');
    const stored = await RollbackGenerationStore.readVerifiedGeneration(nodeId, stackName, generationId);
    expect(stored.invocation.composeArgsPrefix).toEqual(['--env-file', oldEnv]);

    // Control: while the captured selection is still live, a file created after
    // capture is a live managed path, so the restore removes it.
    await fs.promises.writeFile(composeFile, original.replace('busybox', 'nginx'), 'utf8');
    await fs.promises.writeFile(overrideFile, override, 'utf8');
    await context.restoreFromContext();
    await RollbackGenerationStore.commitRestoreTransaction(nodeId, stackName, generationId);
    expect(await fs.promises.readFile(composeFile, 'utf8')).toBe(original);
    await expect(fs.promises.readFile(overrideFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    // The operator then selects a different env file that is a directory. The
    // generation still replays old.env, so the restore must proceed: the
    // unrelated selection stays untouched, and no live path is deleted on an
    // ownership the unusable selection cannot establish.
    await fs.promises.mkdir(newEnv);
    db.setStackProjectEnvFiles(nodeId, stackName, ['new.env']);
    await fs.promises.writeFile(composeFile, original.replace('busybox', 'alpine'), 'utf8');
    await fs.promises.writeFile(overrideFile, override, 'utf8');

    await context.restoreFromContext();
    await RollbackGenerationStore.commitRestoreTransaction(nodeId, stackName, generationId);

    expect(await fs.promises.readFile(composeFile, 'utf8')).toBe(original);
    expect((await fs.promises.stat(newEnv)).isDirectory()).toBe(true);
    expect(await fs.promises.readFile(overrideFile, 'utf8')).toBe(override);

    const args = await ComposeService.getInstance(nodeId).buildComposeArgsWithRecoveryOverride(
      stackName,
      ['up', '-d'],
      path.join(stackDir, '.sencho-recovery-aaaaaaaaaaaa.yml'),
      stored.invocation,
    );
    expect(args).toContain(oldEnv);
    expect(args).not.toContain(newEnv);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a recovery run when the spaced COMPOSE_ENV_FILES entry is not a regular file',
    async () => {
      const stackName = 'inv-process-env-spaced-special';
      const stackDir = path.join(composeDir, stackName);
      const spacedEnv = path.join(stackDir, ' plain.env ');
      await fs.promises.mkdir(stackDir, { recursive: true });
      await fs.promises.writeFile(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n', 'utf8');

      const previous = process.env.COMPOSE_ENV_FILES;
      process.env.COMPOSE_ENV_FILES = ' plain.env ';
      try {
        const { ComposeService } = await import('../services/ComposeService');
        const svc = ComposeService.getInstance(nodeId);
        const execute = vi.spyOn(svc as unknown as {
          execute: (...args: unknown[]) => Promise<void>;
        }, 'execute').mockResolvedValue(undefined);

        // The exact spaced name is the one Compose would open, so a FIFO or a
        // directory under it is a refusal rather than a reason to fall back to
        // the trimmed name.
        for (const kind of ['fifo', 'directory'] as const) {
          await replaceWithSpecialFile(spacedEnv, kind, async () => {
            await expect(svc.composeUpWithRecoveryOverride(
              stackName,
              path.join(stackDir, '.sencho-recovery-unused.yml'),
            )).rejects.toMatchObject({ code: 'NOT_A_FILE' });
          });
        }
        expect(execute).not.toHaveBeenCalled();
      } finally {
        if (previous === undefined) delete process.env.COMPOSE_ENV_FILES;
        else process.env.COMPOSE_ENV_FILES = previous;
      }
    },
  );
});
