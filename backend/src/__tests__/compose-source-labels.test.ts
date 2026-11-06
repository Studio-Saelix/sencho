import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { NodeRegistry } from '../services/NodeRegistry';
import { buildAuthoredProject, correlateLabel, resolveEditOrigin } from '../services/composeSource';

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

  it('treats a label file with an unsupported line as not fully understood', async () => {
    writeStack('unsupported-label', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    label_file: app.labels\n',
      'app.labels': 'good=1\nnot a label line\n',
    });
    const project = await buildAuthoredProject(nodeId, 'unsupported-label');
    expect(project.files.find(file => file.file === 'app.labels')?.diagnostics[0]?.code).toBe('unsupported-syntax');
    // Compose may accept the line this reader rejects, so no key in the file
    // can be claimed as parsed.
    expect(project.files.find(file => file.file === 'app.labels')?.state).toBe('parse-failed');
    expect(project.labels.get('api')!.winners.good).toBeUndefined();
    expect(correlateLabel(project, 'api', 'good').reason).toBe('ambiguous-unparsed-source');
  });

  it('does not claim an earlier label file when a later one is unreadable', async () => {
    writeStack('label-later-unreadable', {
      'compose.yaml': [
        'services:',
        '  api:',
        '    image: nginx:1',
        '    label_file:',
        '      - first.labels',
        '      - missing.labels',
        '',
      ].join('\n'),
      'first.labels': 'a=one\n',
    });
    const project = await buildAuthoredProject(nodeId, 'label-later-unreadable');
    const labels = project.labels.get('api')!;
    expect(labels.winners.a?.file).toBe('first.labels');
    expect(correlateLabel(project, 'api', 'a').origin).toBeUndefined();
    expect(correlateLabel(project, 'api', 'a').reason).toBe('ambiguous-unparsed-source');
  });

  it('does not claim an earlier label file when a later one has an unsupported entry', async () => {
    writeStack('label-later-unsupported', {
      'compose.yaml': [
        'services:',
        '  api:',
        '    image: nginx:1',
        '    label_file:',
        '      - first.labels',
        '      - escaped.labels',
        '',
      ].join('\n'),
      'first.labels': 'a=one\n',
      'escaped.labels': 'a=two\\ three\n',
    });
    const project = await buildAuthoredProject(nodeId, 'label-later-unsupported');
    expect(correlateLabel(project, 'api', 'a').origin).toBeUndefined();
    expect(correlateLabel(project, 'api', 'a').reason).toBe('ambiguous-unparsed-source');
  });

  it('keeps a decisive inline override even when an earlier label file is unreadable', async () => {
    writeStack('label-inline-decisive', {
      'compose.yaml': [
        'services:',
        '  api:',
        '    image: nginx:1',
        '    label_file: missing.labels',
        '    labels:',
        '      a: inline',
        '',
      ].join('\n'),
    });
    const project = await buildAuthoredProject(nodeId, 'label-inline-decisive');
    const result = correlateLabel(project, 'api', 'a');
    expect(result.origin?.file).toBe('compose.yaml');
    expect(result.reason).toBe('unique');
  });

  it('does not claim a label-file winner when an earlier compose layer is unparsed', async () => {
    writeStack('label-unparsed-compose', {
      'compose.yaml': 'services: [\n',
      'compose.override.yaml': 'services:\n  api:\n    image: nginx:1\n    label_file: app.labels\n',
      'app.labels': 'a=one\n',
    });
    const project = await buildAuthoredProject(nodeId, 'label-unparsed-compose');
    expect(project.labels.get('api')!.winners.a?.file).toBe('app.labels');
    // An unparsed layer could still hold an inline declaration, which outranks
    // every label file, so the file origin is not decisive.
    expect(correlateLabel(project, 'api', 'a').origin).toBeUndefined();
    expect(correlateLabel(project, 'api', 'a').reason).toBe('ambiguous-unparsed-source');
  });

  it('lets an earlier inline label beat a later layer label file', async () => {
    writeStack('inline-across-layers', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    labels:\n      a: base-inline\n',
      'compose.override.yaml': 'services:\n  api:\n    label_file: app.labels\n',
      'app.labels': 'a=file-later\n',
    });
    const project = await buildAuthoredProject(nodeId, 'inline-across-layers');
    const labels = project.labels.get('api')!;
    expect(labels.winners.a.source).toBe('inline');
    expect(labels.winners.a.file).toBe('compose.yaml');
    expect(correlateLabel(project, 'api', 'a').reason).toBe('inline-overrides-label-file');
    const fileContribution = labels.contributions.find(contribution => contribution.file === 'app.labels')!;
    expect(fileContribution.overridden).toBe(true);
  });

  it('lets a later label file beat an earlier layer label file', async () => {
    writeStack('label-file-across-layers', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    label_file: first.labels\n',
      'compose.override.yaml': 'services:\n  api:\n    label_file: second.labels\n',
      'first.labels': 'a=one\n',
      'second.labels': 'a=two\n',
    });
    const project = await buildAuthoredProject(nodeId, 'label-file-across-layers');
    expect(project.labels.get('api')!.winners.a.file).toBe('second.labels');
  });

  it('lets an inheriting layer inline label beat a base label file', async () => {
    writeStack('extends-label-precedence', {
      'compose.yaml': 'services:\n  api:\n    extends:\n      file: base.yaml\n      service: api\n    labels:\n      a: own-inline\n',
      'base.yaml': 'services:\n  api:\n    image: nginx:1\n    label_file: base.labels\n',
      'base.labels': 'a=base-file\n',
    });
    const project = await buildAuthoredProject(nodeId, 'extends-label-precedence');
    expect(project.labels.get('api')!.winners.a.source).toBe('inline');
    expect(project.labels.get('api')!.winners.a.file).toBe('compose.yaml');
  });

  it('lets an earlier label file lose to an inline label in a later layer', async () => {
    writeStack('inline-overrides-earlier-file', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    label_file: app.labels\n',
      'compose.override.yaml': 'services:\n  api:\n    labels:\n      a: inline-later\n',
      'app.labels': 'a=file-earlier\n',
    });
    const project = await buildAuthoredProject(nodeId, 'inline-overrides-earlier-file');
    const labels = project.labels.get('api')!;
    expect(labels.winners.a.source).toBe('inline');
    expect(labels.winners.a.file).toBe('compose.override.yaml');
    expect(correlateLabel(project, 'api', 'a').reason).toBe('inline-overrides-label-file');
  });

  it('resolves an extends declaration written through an alias', async () => {
    writeStack('extends-alias', {
      'compose.yaml': [
        'x-base: &base',
        '  file: base.yml',
        '  service: api',
        'services:',
        '  api:',
        '    extends: *base',
        '    labels:',
        '      own: "1"',
        '',
      ].join('\n'),
      'base.yml': 'services:\n  api:\n    image: nginx:1\n    labels:\n      base: "1"\n',
    });
    const project = await buildAuthoredProject(nodeId, 'extends-alias');
    const labels = project.labels.get('api')!;
    expect(labels.winners.base?.file).toBe('base.yml');
    expect(labels.winners.own?.file).toBe('compose.yaml');
  });

  it('refuses an inline label value written through an alias', async () => {
    writeStack('label-value-alias', {
      'compose.yaml': [
        'x-value: &value override',
        'services:',
        '  api:',
        '    image: nginx:1',
        '    label_file: app.labels',
        '    labels:',
        '      a: *value',
        '',
      ].join('\n'),
      'app.labels': 'a=file\n',
    });
    const project = await buildAuthoredProject(nodeId, 'label-value-alias');
    const labels = project.labels.get('api')!;
    expect(labels.ambiguity.a).toBe('unresolved-alias');
    expect(labels.winners.a).toBeUndefined();
    expect(correlateLabel(project, 'api', 'a').origin).toBeUndefined();
    expect(correlateLabel(project, 'api', 'a').reason).toBe('ambiguous-unparsed-source');
  });

  it('refuses a label origin when a later layer has a truncated alias graph', async () => {
    writeStack('label-alias-truncated', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    labels:\n      a: base-inline\n',
      'compose.override.yaml': 'services:\n  api:\n    x-a: &a [*a, *a]\n    <<: *a\n',
    });
    const project = await buildAuthoredProject(nodeId, 'label-alias-truncated');
    expect(project.files.find(file => file.file === 'compose.override.yaml')?.state).toBe('parse-failed');
    expect(correlateLabel(project, 'api', 'a').origin).toBeUndefined();
    expect(correlateLabel(project, 'api', 'a').reason).toBe('ambiguous-unparsed-source');
  });

  it('attributes labels and edit origins for a dotted service name', async () => {
    writeStack('dotted-service', {
      'compose.yaml': 'services:\n  my.service:\n    image: nginx:1\n    labels:\n      team.name: platform\n',
    });
    const project = await buildAuthoredProject(nodeId, 'dotted-service');
    expect(correlateLabel(project, 'my.service', 'team.name').origin).toMatchObject({
      file: 'compose.yaml', range: { line: 5 },
    });
    const edit = resolveEditOrigin(project, 'services.my.service.image');
    expect(edit.ok).toBe(true);
    if (edit.ok) expect(edit.origin.file).toBe('compose.yaml');
  });

  it('lets a decisive inline label beat a duplicate key in a label file', async () => {
    writeStack('inline-over-duplicate', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    label_file: app.labels\n    labels:\n      a: inline\n',
      'app.labels': 'a=first\na=second\n',
    });
    const project = await buildAuthoredProject(nodeId, 'inline-over-duplicate');
    expect(correlateLabel(project, 'api', 'a').origin).toMatchObject({ file: 'compose.yaml', range: { line: 6 } });
    expect(correlateLabel(project, 'api', 'a').reason).toBe('unique');
  });

  it('refuses an inline label under a tagged labels map', async () => {
    writeStack('tagged-labels', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    labels:\n      old: kept\n',
      'compose.override.yaml': 'services:\n  api:\n    labels: !override\n      new: replaced\n',
    });
    const project = await buildAuthoredProject(nodeId, 'tagged-labels');
    expect(correlateLabel(project, 'api', 'old').origin).toBeUndefined();
    expect(correlateLabel(project, 'api', 'new').origin).toBeUndefined();
  });

  it('refuses a nested edit origin under a tagged parent mapping', async () => {
    writeStack('tagged-environment', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    environment:\n      OLD: kept\n',
      'compose.override.yaml': 'services:\n  api:\n    environment: !override\n      NEW: replaced\n',
    });
    const project = await buildAuthoredProject(nodeId, 'tagged-environment');
    expect(resolveEditOrigin(project, 'services.api.environment.OLD').ok).toBe(false);
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
