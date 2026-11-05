import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';
import { FileSystemService } from '../services/FileSystemService';
import { NodeRegistry } from '../services/NodeRegistry';
import { buildAuthoredProject, correlateField } from '../services/composeSource';

let tmpDir: string;
let nodeId: number;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  nodeId = NodeRegistry.getInstance().getDefaultNodeId();
});

afterAll(() => cleanupTestDb(tmpDir));

function composeDir(): string {
  return process.env.COMPOSE_DIR as string;
}

function writeStack(stack: string, files: Record<string, string>): void {
  const dir = path.join(composeDir(), stack);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
}

function withSpec(stack: string, files: string[], contextDir: string | null = null): void {
  const db = DatabaseService.getInstance();
  db.upsertGitSource({
    stack_name: stack,
    repo_url: 'https://example.test/repo.git',
    branch: 'main',
    compose_path: files[0],
    compose_paths: files,
    context_dir: contextDir,
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
    last_applied_commit_sha: null,
    last_applied_content_hash: null,
    pending_commit_sha: null,
    pending_compose_content: null,
    pending_env_content: null,
    pending_fetched_at: null,
    last_debounce_at: null,
  });
  db.setGitSourceAppliedSpec(stack, { files, contextDir });
}

describe('buildAuthoredProject resolution', () => {
  it('follows the applied deploy spec in order, as git-authoritative', async () => {
    writeStack('spec-stack', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n',
      'compose.override.yaml': 'services:\n  api:\n    restart: always\n',
    });
    withSpec('spec-stack', ['compose.yaml', 'compose.override.yaml']);
    const project = await buildAuthoredProject(nodeId, 'spec-stack');
    const composeFiles = project.files.filter(file => file.kind === 'compose-primary' || file.kind === 'compose-additional');
    expect(composeFiles.map(file => file.file)).toEqual(['compose.yaml', 'compose.override.yaml']);
    expect(composeFiles.map(file => file.kind)).toEqual(['compose-primary', 'compose-additional']);
    expect(composeFiles.every(file => file.writability === 'git-authoritative')).toBe(true);
  });

  it('discovers the primary file and its implicit override when no spec exists', async () => {
    writeStack('discovered-stack', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n',
      'compose.override.yml': 'services:\n  api:\n    restart: always\n',
    });
    const project = await buildAuthoredProject(nodeId, 'discovered-stack');
    expect(project.files.map(file => file.kind)).toEqual(['compose-primary', 'compose-override']);
    expect(project.files[1].file).toBe('compose.override.yml');
  });

  it('resolves COMPOSE_FILE with a custom separator', async () => {
    writeStack('env-selected', {
      '.env': 'COMPOSE_FILE=base.yml|extra.yml\nCOMPOSE_PATH_SEPARATOR=|\n',
      'base.yml': 'services:\n  api:\n    image: nginx:1\n',
      'extra.yml': 'services:\n  api:\n    restart: always\n',
    });
    const project = await buildAuthoredProject(nodeId, 'env-selected');
    expect(project.files.map(file => file.file)).toEqual(['base.yml', 'extra.yml']);
    expect(project.files.map(file => file.kind)).toEqual(['compose-primary', 'compose-additional']);
  });

  it('records an entry outside the stack and never reads it', async () => {
    writeStack('outside-entry', {
      '.env': 'COMPOSE_FILE=../outside.yml:base.yml\n',
      'base.yml': 'services:\n  api:\n    image: nginx:1\n',
    });
    const readSpy = vi.spyOn(FileSystemService.prototype, 'readStackFile');
    const project = await buildAuthoredProject(nodeId, 'outside-entry');
    const outside = project.files.find(file => file.file.includes('outside.yml'));
    expect(outside?.state).toBe('outside-boundary');
    expect(readSpy.mock.calls.map(call => call[1])).not.toContain('../outside.yml');
    expect(readSpy.mock.calls.map(call => call[1])).toContain('base.yml');
    readSpy.mockRestore();
  });

  it('follows include, label_file, and extends graphs, and marks the label file shared', async () => {
    writeStack('graph-stack', {
      'compose.yaml': [
        'include:',
        '  - child.yaml',
        'services:',
        '  api:',
        '    extends:',
        '      file: base.yaml',
        '      service: base',
        '    label_file: app.labels',
        '  web:',
        '    label_file: app.labels',
        '',
      ].join('\n'),
      'child.yaml': 'services:\n  worker:\n    image: busybox:1\n',
      'base.yaml': 'services:\n  base:\n    image: nginx:1\n',
      'app.labels': 'io.sencho.url=http://example.test\n',
    });
    const project = await buildAuthoredProject(nodeId, 'graph-stack');
    expect(project.files.some(file => file.file === 'child.yaml' && file.kind === 'compose-include')).toBe(true);
    expect(project.files.some(file => file.file === 'base.yaml' && file.kind === 'compose-extends')).toBe(true);
    const apiLabels = project.labels.get('api');
    expect(apiLabels?.winners['io.sencho.url']?.source).toBe('label-file');
    expect(apiLabels?.winners['io.sencho.url']?.shared).toBe(true);
    expect(apiLabels?.winners['io.sencho.url']?.file).toBe('app.labels');
  });

  it('reports a cycle and a too-large label file without throwing', async () => {
    writeStack('cycle-stack', {
      'compose.yaml': 'include:\n  - a.yaml\nservices:\n  api:\n    image: nginx:1\n',
      'a.yaml': 'include:\n  - compose.yaml\nservices:\n  worker:\n    image: busybox:1\n',
      'big.labels': `x=${'a'.repeat(1_048_600)}\n`,
    });
    writeStack('big-label-stack', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    label_file: big.labels\n',
      'big.labels': `x=${'a'.repeat(1_048_600)}\n`,
    });
    const project = await buildAuthoredProject(nodeId, 'cycle-stack');
    expect(project.diagnostics.some(entry => entry.code === 'cycle')).toBe(true);
    const big = await buildAuthoredProject(nodeId, 'big-label-stack');
    expect(big.files.find(file => file.file === 'big.labels')?.state).toBe('too-large');
  });

  it('uses an applied spec context directory as the project base', async () => {
    writeStack('context-dir', {
      'app/compose.yaml': 'services:\n  api:\n    image: nginx:1\n    label_file: app.labels\n',
      'app/app.labels': 'a=1\n',
    });
    withSpec('context-dir', ['app/compose.yaml'], 'app');
    const project = await buildAuthoredProject(nodeId, 'context-dir');
    expect(project.labels.get('api')?.winners.a?.file).toBe('app/app.labels');
    expect(project.partial).toBe(false);
  });

  it('does not guess a file chain when COMPOSE_FILE cannot be read', async () => {
    writeStack('unknown-selection', {
      '.env': 'COMPOSE_FILE=base.yml\n',
      'base.yml': 'services:\n  api:\n    image: nginx:1\n',
    });
    fs.chmodSync(path.join(composeDir(), 'unknown-selection', '.env'), 0o000);
    const project = await buildAuthoredProject(nodeId, 'unknown-selection');
    fs.chmodSync(path.join(composeDir(), 'unknown-selection', '.env'), 0o644);
    expect(project.files.filter(file => file.kind === 'compose-primary')).toHaveLength(0);
    expect(project.partialReasons).toContain('compose-file-unknown');
  });

  it('refuses a parent-field location when an include project directory leaves the stack', async () => {
    writeStack('outside-include', {
      'compose.yaml': 'include:\n  - project_directory: ../elsewhere\n    path: child/compose.yaml\nservices:\n  api:\n    image: nginx:1\n',
      'child/compose.yaml': 'services:\n  api:\n    image: redis:7\n',
    });
    const project = await buildAuthoredProject(nodeId, 'outside-include');
    expect(project.partialReasons).toContain('outside-boundary');
    expect(correlateField(project, 'api', 'image', 'nginx:1').origin).toBeUndefined();
  });

  it('records the mesh override as a generated layer, never reads it', async () => {
    writeStack('mesh-stack', { 'compose.yaml': 'services:\n  api:\n    image: nginx:1\n' });
    DatabaseService.getInstance().getDb().prepare(
      'INSERT INTO mesh_stacks (node_id, stack_name, created_at, created_by) VALUES (?, ?, ?, ?)',
    ).run(nodeId, 'mesh-stack', Date.now(), 'test');
    const project = await buildAuthoredProject(nodeId, 'mesh-stack');
    expect(project.generatedLayers).toContain('mesh-override');
    expect(project.files.some(file => file.file.includes('mesh'))).toBe(false);
  });
});
