/**
 * Recovery must execute the generation-captured Compose invocation, not the
 * live database-derived file / env selection after capture.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'path';
import fs from 'fs';
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
});
