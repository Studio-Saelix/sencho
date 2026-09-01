/**
 * Recovery must execute the generation-captured Compose invocation, not the
 * live database-derived file / env selection after capture.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'path';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

describe('captured invocation on recovery Compose args', () => {
  let tmpDir: string;
  let composeDir: string;
  let nodeId: number;

  beforeEach(async () => {
    tmpDir = await setupTestDb();
    composeDir = process.env.COMPOSE_DIR!;
    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance();
    const local = db.getDefaultNode();
    if (!local?.id) throw new Error('missing default node');
    nodeId = local.id;
  });

  afterEach(() => {
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
});
