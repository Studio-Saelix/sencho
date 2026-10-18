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
});
