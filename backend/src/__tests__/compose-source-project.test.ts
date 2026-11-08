import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';
import { FileSystemService } from '../services/FileSystemService';
import { NodeRegistry } from '../services/NodeRegistry';
import { buildAuthoredProject, correlateField, correlateLabel, resolveEditOrigin } from '../services/composeSource';

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

  it('keeps Git authority on label files and identity-only supporting inputs', async () => {
    writeStack('spec-supporting', {
      'compose.yaml': [
        'services:',
        '  api:',
        '    image: nginx:1',
        '    label_file: app.labels',
        '    env_file: app.env',
        'configs:',
        '  app-config:',
        '    file: ./app.conf',
        '',
      ].join('\n'),
      'app.labels': 'io.sencho.url=http://example.test\n',
      'app.env': 'TOKEN=not-read\n',
      'app.conf': 'not-read-either\n',
    });
    withSpec('spec-supporting', ['compose.yaml']);
    const project = await buildAuthoredProject(nodeId, 'spec-supporting');
    expect(project.files.find(file => file.file === 'compose.yaml')?.writability).toBe('git-authoritative');
    expect(project.files.find(file => file.file === 'app.labels')?.writability).toBe('git-authoritative');
    expect(project.files.find(file => file.file === 'app.env')?.writability).toBe('git-authoritative');
    expect(project.files.find(file => file.file === 'app.conf')?.writability).toBe('git-authoritative');
    const origin = correlateLabel(project, 'api', 'io.sencho.url').origin;
    expect(origin?.file).toBe('app.labels');
    expect(origin?.writability).toBe('git-authoritative');
    const edit = resolveEditOrigin(project, 'services.api.labels.io.sencho.url');
    expect(edit.ok).toBe(true);
    if (edit.ok) {
      expect(edit.origin.file).toBe('app.labels');
      expect(edit.origin.writability).toBe('git-authoritative');
    }
  });

  it('keeps a locally discovered label file writable', async () => {
    writeStack('local-supporting', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    label_file: app.labels\n',
      'app.labels': 'a=1\n',
    });
    const project = await buildAuthoredProject(nodeId, 'local-supporting');
    expect(project.files.find(file => file.file === 'app.labels')?.writability).toBe('writable');
    expect(correlateLabel(project, 'api', 'a').origin?.writability).toBe('writable');
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

  it('promotes an extends base that is also a project file to its real layer', async () => {
    writeStack('promoted-extends', {
      '.env': 'COMPOSE_FILE=compose.yaml:override.yml:common.yml\n',
      'compose.yaml': 'services:\n  api:\n    extends:\n      file: common.yml\n      service: base\n',
      'override.yml': 'services:\n  base:\n    image: nginx:1\n    labels:\n      x: from-override\n',
      'common.yml': 'services:\n  base:\n    image: nginx:1\n    labels:\n      x: from-common\n',
    });
    const project = await buildAuthoredProject(nodeId, 'promoted-extends');
    const common = project.files.find(file => file.file === 'common.yml');
    expect(common?.kind).toBe('compose-additional');
    // common.yml is last in COMPOSE_FILE, so its label wins even though it was
    // first read as an extends base while compose.yaml loaded.
    expect(project.labels.get('base')?.winners.x?.file).toBe('common.yml');
  });

  it('refuses an origin in a parse-failed extends base promoted to a project layer', async () => {
    writeStack('promoted-truncated', {
      'compose.yaml': 'services:\n  api:\n    extends:\n      file: base.yml\n      service: base\n',
      'compose.override.yaml': 'include:\n  - base.yml\nservices:\n  api:\n    image: nginx:1\n',
      'base.yml': 'services:\n  base:\n    image: nginx:1\n    labels:\n      a: base\n    bad: *missing\n',
    });
    const project = await buildAuthoredProject(nodeId, 'promoted-truncated');
    const base = project.files.find(file => file.file === 'base.yml');
    expect(base?.kind).toBe('compose-include');
    expect(base?.state).toBe('parse-failed');
    expect(correlateLabel(project, 'base', 'a').origin).toBeUndefined();
    expect(correlateLabel(project, 'base', 'a').reason).toBe('ambiguous-unparsed-source');
  });

  it('follows an include declaration written through an alias', async () => {
    writeStack('include-alias', {
      'compose.yaml': 'x-inc: &inc\n  path: shared.yml\ninclude:\n  - *inc\nservices:\n  api:\n    image: nginx:1\n',
      'shared.yml': 'services:\n  worker:\n    image: busybox:1\n',
    });
    const project = await buildAuthoredProject(nodeId, 'include-alias');
    expect(project.files.some(file => file.file === 'shared.yml' && file.kind === 'compose-include')).toBe(true);
    expect(project.partial).toBe(false);
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

  it('refuses every location when an include path leaves the stack', async () => {
    writeStack('outside-include-path', {
      'compose.yaml': 'include:\n  - ../outside.yaml\nservices:\n  api:\n    image: nginx:1\n',
    });
    const project = await buildAuthoredProject(nodeId, 'outside-include-path');
    // The refused include is still a declared project layer, so an origin in
    // compose.yaml is not decisive.
    expect(project.partialReasons).toContain('outside-boundary');
    expect(project.files.some(file => file.file === '../outside.yaml' && file.state === 'outside-boundary')).toBe(true);
    const image = correlateField(project, 'api', 'image', 'nginx:1');
    expect(image.origin).toBeUndefined();
    expect(image.ambiguity?.kind).toBe('outside-boundary');
  });

  it('refuses an origin when the include graph hits the depth bound', async () => {
    const files: Record<string, string> = {
      'compose.yaml': 'include:\n  - inc-1.yml\nservices:\n  api:\n    image: nginx:1\n',
    };
    for (let level = 1; level <= 17; level += 1) {
      const lines = [`include:`, `  - inc-${level + 1}.yml`, 'services:', '  api:', '    image: nginx:1'];
      if (level === 16) lines.push('    labels:', '      a: from-16');
      if (level === 17) lines.push('    labels:', '      a: from-17');
      files[`inc-${level}.yml`] = `${lines.join('\n')}\n`;
    }
    writeStack('include-depth', files);
    const project = await buildAuthoredProject(nodeId, 'include-depth');
    expect(project.partialReasons).toContain('too-deep');
    const label = correlateLabel(project, 'api', 'a');
    expect(label.origin).toBeUndefined();
    expect(label.reason).toBe('ambiguous-unparsed-source');
  });

  it('refuses a depth-refused include reached through a promoted extends base', async () => {
    const files: Record<string, string> = {
      'compose.yaml': 'services:\n  api:\n    extends:\n      file: base.yml\n      service: base\n',
      'compose.override.yaml': 'include:\n  - base.yml\nservices:\n  api:\n    image: nginx:1\n',
      'base.yml': 'include:\n  - inc-1.yml\nservices:\n  base:\n    image: nginx:1\n',
    };
    for (let level = 1; level <= 16; level += 1) {
      const lines = ['include:', `  - inc-${level + 1}.yml`, 'services:', '  api:', '    image: nginx:1'];
      if (level === 15) lines.push('    labels:', '      a: from-15');
      if (level === 16) lines.push('    labels:', '      a: from-16');
      files[`inc-${level}.yml`] = `${lines.join('\n')}\n`;
    }
    writeStack('promoted-depth', files);
    const project = await buildAuthoredProject(nodeId, 'promoted-depth');
    expect(project.partialReasons).toContain('too-deep');
    const refused = project.files.find(file => file.file === 'inc-16.yml');
    // The refused descendant is promoted with its base, so the project layer
    // stays visible to the correlation guards.
    expect(refused?.kind).toBe('compose-include');
    expect(refused?.state).toBe('parse-failed');
    expect(correlateLabel(project, 'api', 'a').origin).toBeUndefined();
  });

  it('refuses every location when the project include graph is cyclic', async () => {
    writeStack('include-cycle-labels', {
      'compose.yaml': 'include:\n  - a.yml\nservices:\n  api:\n    image: nginx:1\n    labels:\n      a: base\n',
      'a.yml': 'include:\n  - compose.yaml\nservices:\n  worker:\n    image: busybox:1\n',
    });
    const project = await buildAuthoredProject(nodeId, 'include-cycle-labels');
    expect(project.partialReasons).toContain('cycle');
    expect(project.partialReasons).toContain('project-cycle');
    expect(correlateLabel(project, 'api', 'a').origin).toBeUndefined();
    expect(correlateField(project, 'api', 'image', 'nginx:1').origin).toBeUndefined();
  });

  it('locates a value inside a merge nested inside an anchored map', async () => {
    writeStack('nested-merge', {
      'compose.yaml': 'services:\n  api:\n    image: old-image\n',
      'compose.override.yaml': [
        'x-a: &a',
        '  image: new-image',
        '  healthcheck:',
        '    test: ["CMD", "new"]',
        'x-b: &b',
        '  <<: *a',
        'services:',
        '  api:',
        '    <<: *b',
        '    restart: always',
        '',
      ].join('\n'),
    });
    const project = await buildAuthoredProject(nodeId, 'nested-merge');
    const image = correlateField(project, 'api', 'image', 'new-image');
    expect(image.origin).toMatchObject({ file: 'compose.override.yaml', range: { line: 2 } });
    expect(image.reason).toBe('override-winner');
    const healthcheck = correlateField(project, 'api', 'healthcheck');
    expect(healthcheck.origin?.file).toBe('compose.override.yaml');
  });

  it('refuses a base location when a later layer has a truncated alias graph', async () => {
    writeStack('alias-truncated-override', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:latest\n',
      'compose.override.yaml': 'services:\n  api:\n    x-a: &a [*a, *a]\n    <<: *a\n',
    });
    const project = await buildAuthoredProject(nodeId, 'alias-truncated-override');
    expect(project.files.find(file => file.file === 'compose.override.yaml')?.state).toBe('parse-failed');
    expect(project.partial).toBe(true);
    const image = correlateField(project, 'api', 'image', 'nginx:latest');
    expect(image.origin).toBeUndefined();
    expect(image.reason).toBe('ambiguous-unparsed-source');
  });

  it('keeps the primary file service names when an alias or merge chain exceeds the follow cap', async () => {
    const aliasLines = ['x-0: &a0 [true]'];
    for (let level = 1; level < 20; level += 1) aliasLines.push(`x-${level}: &a${level} [*a${level - 1}]`);
    aliasLines.push('services:', '  web:', '    image: nginx:1', '');
    writeStack('alias-service-names', { 'compose.yaml': aliasLines.join('\n') });
    const aliased = await buildAuthoredProject(nodeId, 'alias-service-names');
    const aliasPrimary = aliased.files.find(file => file.kind === 'compose-primary')!;
    // The chain is refused for locations, but the file still declares web.
    expect(aliasPrimary.state).toBe('parse-failed');
    expect(aliasPrimary.serviceNames).toEqual(['web']);

    const mergeLines = ['x-1: &x1 {privileged: true}'];
    for (let level = 2; level <= 20; level += 1) mergeLines.push(`x-${level}: &x${level} {<<: *x${level - 1}}`);
    mergeLines.push('services:', '  web:', '    <<: *x20', '    image: nginx:1', '');
    writeStack('merge-service-names', { 'compose.yaml': mergeLines.join('\n') });
    const merged = await buildAuthoredProject(nodeId, 'merge-service-names');
    const mergePrimary = merged.files.find(file => file.kind === 'compose-primary')!;
    expect(mergePrimary.state).toBe('parse-failed');
    expect(mergePrimary.serviceNames).toEqual(['web']);
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
