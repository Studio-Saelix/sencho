import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { NodeRegistry } from '../services/NodeRegistry';
import { buildAuthoredProject, correlateLabel } from '../services/composeSource';

let tmpDir: string;
let nodeId: number;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  nodeId = NodeRegistry.getInstance().getDefaultNodeId();
});

afterAll(() => cleanupTestDb(tmpDir));

function writeStack(stack: string, files: Record<string, string>): void {
  const dir = path.join(process.env.COMPOSE_DIR as string, stack);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
}

describe('authored label contributions', () => {
  it('orders label files by declaration and marks the earlier entry overridden', async () => {
    writeStack('two-files', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    label_file:\n      - first.labels\n      - second.labels\n',
      'first.labels': 'a=one\n',
      'second.labels': 'a=two\n',
    });
    const project = await buildAuthoredProject(nodeId, 'two-files');
    const labels = project.labels.get('api')!;
    expect(labels.winners.a.file).toBe('second.labels');
    const first = labels.contributions.find(contribution => contribution.file === 'first.labels')!;
    expect(first.overridden).toBe(true);
    const result = correlateLabel(project, 'api', 'a');
    expect(result.reason).toBe('label-file');
    expect(result.origin?.file).toBe('second.labels');
  });

  it('lets an inline labels map override a label file', async () => {
    writeStack('inline-wins', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    label_file: app.labels\n    labels:\n      a: inline\n',
      'app.labels': 'a=file\n',
    });
    const project = await buildAuthoredProject(nodeId, 'inline-wins');
    const labels = project.labels.get('api')!;
    expect(labels.winners.a.source).toBe('inline');
    expect(correlateLabel(project, 'api', 'a').reason).toBe('inline-overrides-label-file');
  });

  it('marks a file used by two services shared', async () => {
    writeStack('shared-label', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    label_file: app.labels\n  web:\n    image: nginx:1\n    label_file: app.labels\n',
      'app.labels': 'a=1\n',
    });
    const project = await buildAuthoredProject(nodeId, 'shared-label');
    expect(project.labels.get('api')!.winners.a.shared).toBe(true);
    expect(correlateLabel(project, 'api', 'a').reason).toBe('shared-input');
    expect(project.labels.get('web')!.winners.a.shared).toBe(true);
  });

  it('blocks a winner when the label file is unreadable', async () => {
    writeStack('missing-label', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    label_file: missing.labels\n',
    });
    const project = await buildAuthoredProject(nodeId, 'missing-label');
    const labels = project.labels.get('api')!;
    expect(labels.winners.a).toBeUndefined();
    expect(labels.unparsedLabelFiles).toContain('missing.labels');
    expect(correlateLabel(project, 'api', 'a').reason).toBe('ambiguous-unparsed-source');
  });

  it('refuses a winner for a duplicate key inside one label file', async () => {
    writeStack('duplicate-label', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    label_file: app.labels\n',
      'app.labels': 'a=1\na=2\n',
    });
    const project = await buildAuthoredProject(nodeId, 'duplicate-label');
    const labels = project.labels.get('api')!;
    expect(labels.ambiguity.a).toBe('duplicate-key');
    expect(labels.winners.a).toBeUndefined();
    expect(correlateLabel(project, 'api', 'a').reason).toBe('ambiguous-multiple-sources');
  });

  it('marks interpolated keys and values and does not claim a location', async () => {
    writeStack('interpolated-label', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    label_file: app.labels\n',
      'app.labels': 'token=${SECRET}\n',
    });
    const project = await buildAuthoredProject(nodeId, 'interpolated-label');
    const labels = project.labels.get('api')!;
    expect(labels.ambiguity.token).toBe('interpolated');
    expect(labels.winners.token).toBeUndefined();
    expect(correlateLabel(project, 'api', 'token').reason).toBe('interpolated');
  });

  it('records an unsupported line without inventing an entry', async () => {
    writeStack('unsupported-label', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    label_file: app.labels\n',
      'app.labels': 'good=1\nnot a label line\n',
    });
    const project = await buildAuthoredProject(nodeId, 'unsupported-label');
    expect(project.files.find(file => file.file === 'app.labels')?.diagnostics[0]?.code).toBe('unsupported-syntax');
    expect(project.labels.get('api')!.winners.good.source).toBe('label-file');
  });

  it('locates inline map and list forms by their real ranges', async () => {
    writeStack('inline-forms', {
      'compose.yaml': [
        'services:',
        '  api:',
        '    image: nginx:1',
        '    labels:',
        '      map.key: value',
        '  web:',
        '    image: nginx:1',
        '    labels:',
        '      - "list.key=value"',
        '',
      ].join('\n'),
    });
    const project = await buildAuthoredProject(nodeId, 'inline-forms');
    const map = project.labels.get('api')!.winners['map.key'];
    expect(map.form).toBe('map');
    expect(map.range.line).toBe(5);
    const list = project.labels.get('web')!.winners['list.key'];
    expect(list.form).toBe('list');
    expect(list.range.line).toBe(9);
  });
});
