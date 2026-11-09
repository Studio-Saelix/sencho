import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { NodeRegistry } from '../services/NodeRegistry';
import { buildAuthoredProject, correlateField, correlateLabel, resolveEditOrigin } from '../services/composeSource';
import { authoredOriginsFor } from '../services/LabelInventoryService';

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

  it('gives an export-prefixed label-file entry the same acting origin as a plain one', async () => {
    writeStack('export-label', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    label_file: app.labels\n',
      'app.labels': 'export ex=3\nplain=1\n',
    });
    const project = await buildAuthoredProject(nodeId, 'export-label');
    const result = correlateLabel(project, 'api', 'ex');
    expect(result.reason).toBe('label-file');
    expect(result.origin).toMatchObject({ file: 'app.labels', range: { line: 1, column: 8 } });
    expect(resolveEditOrigin(project, 'services.api.labels.ex')).toMatchObject({
      ok: true,
      origin: { file: 'app.labels', range: { line: 1 } },
    });
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

  it('correlates every key of a large label file without rescanning the service list per key', async () => {
    const count = 30_000;
    const entries = Array.from({ length: count }, (_, index) => `key.${index}=value${index}`).join('\n');
    writeStack('large-label-correlate', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    label_file: app.labels\n',
      'app.labels': `${entries}\n`,
    });
    const project = await buildAuthoredProject(nodeId, 'large-label-correlate');
    const keys = Object.keys(project.labels.get('api')!.winners);
    expect(keys).toHaveLength(count);
    const started = performance.now();
    for (const key of keys) {
      const result = correlateLabel(project, 'api', key);
      if (result.reason !== 'label-file' || result.origin?.file !== 'app.labels') {
        throw new Error(`unexpected correlation for ${key}: ${result.reason}`);
      }
    }
    // The old per-key filter was quadratic (3.9 s for this input). Linear
    // lookup keeps the loop well under this bound; the margin absorbs CI noise.
    expect(performance.now() - started).toBeLessThan(1_500);
  }, 30_000);

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

  it('follows an inline label value written through an alias to its anchor', async () => {
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
    expect(labels.ambiguity.a).toBeUndefined();
    expect(labels.winners.a?.source).toBe('inline');
    const result = correlateLabel(project, 'api', 'a');
    expect(result.origin).toMatchObject({ file: 'compose.yaml', range: { line: 1 } });
    expect(result.reason).toBe('inline-overrides-label-file');
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

  it('resolves a dotted label key through the field path', async () => {
    writeStack('label-dotted-field', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    labels:\n      io.sencho.url: http://example.test\n',
    });
    const project = await buildAuthoredProject(nodeId, 'label-dotted-field');
    expect(correlateField(project, 'api', 'labels.io.sencho.url').origin).toMatchObject({
      file: 'compose.yaml', range: { line: 5 },
    });
  });

  it('returns an authored origin for a label named __proto__', async () => {
    writeStack('label-proto-origin', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    labels:\n      __proto__: value\n',
    });
    const project = await buildAuthoredProject(nodeId, 'label-proto-origin');
    const origins = authoredOriginsFor(project, 'api', ['__proto__']);
    expect(Object.prototype.hasOwnProperty.call(origins, '__proto__')).toBe(true);
    expect(origins?.['__proto__']?.file).toBe('compose.yaml');
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

  it('refuses a label-file winner when an interpolated list key could resolve to it', async () => {
    writeStack('label-dynamic-key', {
      'compose.yaml': [
        'services:',
        '  api:',
        '    image: nginx:1',
        '    label_file: app.labels',
        '    labels:',
        '      - "${LABEL_KEY}=inline"',
        '',
      ].join('\n'),
      'app.labels': 'owner=file\n',
    });
    const project = await buildAuthoredProject(nodeId, 'label-dynamic-key');
    const labels = project.labels.get('api')!;
    expect(labels.hasDynamicKeys).toBe(true);
    expect(labels.winners.owner).toBeUndefined();
    expect(labels.ambiguity.owner).toBe('interpolated');
    const result = correlateLabel(project, 'api', 'owner');
    expect(result.origin).toBeUndefined();
    expect(result.reason).toBe('interpolated');
    expect(resolveEditOrigin(project, 'services.api.labels.owner')).toEqual({
      ok: false, reason: 'interpolated',
    });
    // The literal name of the dynamic declaration is not a claimable key.
    expect(correlateLabel(project, 'api', '${LABEL_KEY}').origin).toBeUndefined();
  });

  it('keeps a later literal inline label that a dynamic earlier key cannot supersede', async () => {
    writeStack('label-dynamic-earlier', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    label_file: app.labels\n    labels:\n      - "${LABEL_KEY}=inline-base"\n',
      'compose.override.yaml': 'services:\n  api:\n    labels:\n      - "owner=literal-later"\n',
      'app.labels': 'owner=file\n',
    });
    const project = await buildAuthoredProject(nodeId, 'label-dynamic-earlier');
    const result = correlateLabel(project, 'api', 'owner');
    expect(result.origin).toMatchObject({ file: 'compose.override.yaml', range: { line: 4 } });
    expect(result.reason).toBe('inline-overrides-label-file');
    expect(resolveEditOrigin(project, 'services.api.labels.owner').ok).toBe(true);
  });

  it('refuses an inherited literal when the extending layer adds a later dynamic key', async () => {
    writeStack('label-dynamic-extends-later', {
      'compose.yaml': 'services:\n  api:\n    extends:\n      file: base.yaml\n      service: api\n    labels:\n      - "${LABEL_KEY}=own-dynamic"\n',
      'base.yaml': 'services:\n  api:\n    image: nginx:1\n    labels:\n      owner: base-literal\n',
    });
    const project = await buildAuthoredProject(nodeId, 'label-dynamic-extends-later');
    const result = correlateLabel(project, 'api', 'owner');
    expect(result.origin).toBeUndefined();
    expect(result.reason).toBe('interpolated');
  });

  it('keeps an own literal label over a dynamic key in an inherited base', async () => {
    writeStack('label-dynamic-extends-earlier', {
      'compose.yaml': 'services:\n  api:\n    extends:\n      file: base.yaml\n      service: api\n    labels:\n      owner: own-literal\n',
      'base.yaml': 'services:\n  api:\n    image: nginx:1\n    labels:\n      - "${LABEL_KEY}=base-dynamic"\n',
    });
    const project = await buildAuthoredProject(nodeId, 'label-dynamic-extends-earlier');
    const result = correlateLabel(project, 'api', 'owner');
    expect(result.origin?.file).toBe('compose.yaml');
    expect(result.reason).toBe('unique');
  });

  it('treats a map-form key as a literal, because Compose never interpolates mapping keys', async () => {
    writeStack('label-map-key-literal', {
      'compose.yaml': [
        'services:',
        '  api:',
        '    image: nginx:1',
        '    label_file: app.labels',
        '    labels:',
        '      "${LABEL_KEY}": inline',
        '',
      ].join('\n'),
      'app.labels': 'owner=file\n',
    });
    const project = await buildAuthoredProject(nodeId, 'label-map-key-literal');
    const labels = project.labels.get('api')!;
    expect(labels.hasDynamicKeys).toBe(false);
    expect(labels.winners.owner?.file).toBe('app.labels');
    expect(correlateLabel(project, 'api', 'owner').origin?.file).toBe('app.labels');
  });

  it('recognizes a defaulted variable in a list-form label key', async () => {
    writeStack('label-dynamic-default', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    label_file: app.labels\n    labels:\n      - "${LABEL_KEY:-owner}=inline"\n',
      'app.labels': 'owner=file\n',
    });
    const project = await buildAuthoredProject(nodeId, 'label-dynamic-default');
    expect(project.labels.get('api')!.winners.owner).toBeUndefined();
    expect(correlateLabel(project, 'api', 'owner').reason).toBe('interpolated');
  });

  it('refuses a label-file winner when a merged list supplies a dynamic key', async () => {
    writeStack('label-dynamic-merge', {
      'compose.yaml': [
        'x-labels: &labels',
        '  - "${LABEL_KEY}=inline"',
        'services:',
        '  api:',
        '    image: nginx:1',
        '    label_file: app.labels',
        '    labels: *labels',
        '',
      ].join('\n'),
      'app.labels': 'owner=file\n',
    });
    const project = await buildAuthoredProject(nodeId, 'label-dynamic-merge');
    expect(project.labels.get('api')!.hasDynamicKeys).toBe(true);
    expect(project.labels.get('api')!.winners.owner).toBeUndefined();
    expect(correlateLabel(project, 'api', 'owner').origin).toBeUndefined();
    expect(correlateLabel(project, 'api', 'owner').reason).toBe('interpolated');
  });

  it('refuses an earlier literal when a later layer adds a dynamic list key', async () => {
    writeStack('label-dynamic-later', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    label_file: app.labels\n    labels:\n      owner: base-literal\n',
      'compose.override.yaml': 'services:\n  api:\n    labels:\n      - "${LABEL_KEY}=dynamic-later"\n',
      'app.labels': 'owner=file\n',
    });
    const project = await buildAuthoredProject(nodeId, 'label-dynamic-later');
    expect(project.labels.get('api')!.winners.owner).toBeUndefined();
    expect(correlateLabel(project, 'api', 'owner').reason).toBe('interpolated');
  });

  it('refuses a label-file winner when an unresolved list alias carries a dynamic key', async () => {
    writeStack('label-dynamic-alias', {
      'compose.yaml': [
        'x-label: &label "${LABEL_KEY}=inline"',
        'services:',
        '  api:',
        '    image: nginx:1',
        '    label_file: app.labels',
        '    labels:',
        '      - *label',
        '',
      ].join('\n'),
      'app.labels': 'owner=file\n',
    });
    const project = await buildAuthoredProject(nodeId, 'label-dynamic-alias');
    expect(project.labels.get('api')!.hasDynamicKeys).toBe(true);
    expect(project.labels.get('api')!.winners.owner).toBeUndefined();
    expect(correlateLabel(project, 'api', 'owner').reason).toBe('interpolated');
  });

  it('normalizes an escaped dollar in a list-form label key', async () => {
    writeStack('label-escaped-dollar', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    label_file: app.labels\n    labels:\n      - "$$KEY=inline"\n',
      'app.labels': '$KEY=file\n',
    });
    const project = await buildAuthoredProject(nodeId, 'label-escaped-dollar');
    const labels = project.labels.get('api')!;
    expect(labels.hasDynamicKeys).toBe(false);
    expect(labels.winners.$KEY?.source).toBe('inline');
    expect(correlateLabel(project, 'api', '$KEY').origin?.file).toBe('compose.yaml');
    expect(correlateLabel(project, 'api', '$$KEY').origin).toBeUndefined();
  });

  it('keeps label keys that shadow Object.prototype members', async () => {
    writeStack('label-prototype-keys', {
      'compose.yaml': [
        'services:',
        '  api:',
        '    image: nginx:1',
        '    labels:',
        '      toString: a',
        '      constructor: b',
        '      __proto__: c',
        '',
      ].join('\n'),
    });
    const project = await buildAuthoredProject(nodeId, 'label-prototype-keys');
    const labels = project.labels.get('api')!;
    for (const key of ['toString', 'constructor', '__proto__']) {
      expect(labels.winners[key]?.file).toBe('compose.yaml');
      expect(correlateLabel(project, 'api', key).origin?.file).toBe('compose.yaml');
    }
  });

  it('lets an inline label written through an anchored map key beat a label file', async () => {
    writeStack('label-alias-key', {
      'compose.yaml': [
        'x-key: &key owner',
        'services:',
        '  api:',
        '    image: nginx:1',
        '    label_file: app.labels',
        '    labels:',
        '      ? *key',
        '      : inline',
        '',
      ].join('\n'),
      'app.labels': 'owner=file\n',
    });
    const project = await buildAuthoredProject(nodeId, 'label-alias-key');
    const labels = project.labels.get('api')!;
    expect(labels.winners.owner?.source).toBe('inline');
    expect(correlateLabel(project, 'api', 'owner').origin?.file).toBe('compose.yaml');
  });
});

describe('value-matched label origins', () => {
  const compose = 'services:\n  web:\n    image: nginx:1\n    labels:\n      shared: same\n';
  const extra = 'services:\n  web:\n    labels:\n      shared: same\n';

  it('reports the same value declared in two files as ambiguous, in either order', async () => {
    for (const order of ['compose.yaml:extra.yml', 'extra.yml:compose.yaml'] as const) {
      const stack = `label-same-value-${order.startsWith('compose') ? 'a' : 'b'}`;
      writeStack(stack, {
        'compose.yaml': compose,
        'extra.yml': extra,
        '.env': `COMPOSE_FILE=${order}\n`,
      });
      const project = await buildAuthoredProject(nodeId, stack);
      const result = correlateLabel(project, 'web', 'shared', 'same');
      expect(result.origin).toBeUndefined();
      expect(result.reason).toBe('ambiguous-multiple-sources');
      expect(result.ambiguity?.kind).toBe('multiple-matches');
      // Without an effective value, two declarations carrying the same text are
      // still indistinguishable, so an edit origin must refuse as well.
      expect(correlateLabel(project, 'web', 'shared').origin).toBeUndefined();
      expect(authoredOriginsFor(project, 'web', ['shared'], { shared: 'same' }))
        .toEqual({ shared: { source: 'inline', ambiguity: 'multiple-sources' } });
    }
  });

  it('locates the one declaration whose value is the effective one', async () => {
    writeStack('label-different-values', {
      'compose.yaml': 'services:\n  web:\n    image: nginx:1\n    labels:\n      shared: second\n',
      'extra.yml': 'services:\n  web:\n    labels:\n      shared: first\n',
      '.env': 'COMPOSE_FILE=extra.yml:compose.yaml\n',
    });
    const project = await buildAuthoredProject(nodeId, 'label-different-values');
    const result = correlateLabel(project, 'web', 'shared', 'second');
    expect(result.origin).toMatchObject({ file: 'compose.yaml', range: { line: 5 } });
    expect(result.reason).toBe('unique');
    // An effective value that contradicts the later declaration is not
    // locatable at the earlier one: that declaration was overridden.
    const contradicted = correlateLabel(project, 'web', 'shared', 'first');
    expect(contradicted.origin).toBeUndefined();
    expect(contradicted.ambiguity?.kind).toBe('later-candidate');
    // The edit-origin door has no effective value to compare against, so it
    // must refuse a key with more than one candidate in the winning tier.
    expect(resolveEditOrigin(project, 'services.web.labels.shared'))
      .toEqual({ ok: false, reason: 'ambiguous-multiple-sources' });
  });

  it('detects interpolation after an escaped dollar in a label-file value', async () => {
    writeStack('label-file-escaped-interpolation', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    label_file: app.labels\n',
      'app.labels': 'a=$$${FOO}\n',
    });
    const project = await buildAuthoredProject(nodeId, 'label-file-escaped-interpolation');
    expect(project.labels.get('api')!.ambiguity.a).toBe('interpolated');
    const result = correlateLabel(project, 'api', 'a');
    expect(result.origin).toBeUndefined();
    expect(result.reason).toBe('interpolated');
    expect(authoredOriginsFor(project, 'api', ['a'])).toEqual({ a: { ambiguity: 'interpolated' } });
  });

  it('keeps an inline declaration decisive over a label file with the same value', async () => {
    writeStack('label-inline-same-value', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    label_file: app.labels\n    labels:\n      a: same\n',
      'app.labels': 'a=same\n',
    });
    const project = await buildAuthoredProject(nodeId, 'label-inline-same-value');
    const result = correlateLabel(project, 'api', 'a', 'same');
    expect(result.origin).toMatchObject({ file: 'compose.yaml', range: { line: 6 } });
    expect(result.reason).toBe('inline-overrides-label-file');
  });
});

describe('interpolated label_file paths', () => {
  it('reports the path as interpolated, never as outside the boundary', async () => {
    writeStack('label-file-interpolated', {
      'compose.yaml': [
        'services:',
        '  interp:',
        '    image: nginx:1.25',
        '    restart: always',
        '    label_file: ./${LF:-l2}.labels',
        '    labels:',
        '      own: inline',
        '',
      ].join('\n'),
      'l2.labels': 'k2=v2\n',
    });
    const project = await buildAuthoredProject(nodeId, 'label-file-interpolated');
    const labels = project.labels.get('interp')!;
    expect(labels.interpolatedLabelFiles).toEqual(['./${LF:-l2}.labels']);
    expect(labels.outsideLabelFiles).toEqual([]);
    expect(project.partialReasons).toContain('interpolated');
    expect(project.partialReasons).not.toContain('outside-boundary');
    const result = correlateLabel(project, 'interp', 'k2');
    expect(result.origin).toBeUndefined();
    expect(result.reason).toBe('interpolated');
    expect(result.ambiguity?.kind).toBe('interpolated');
    expect(resolveEditOrigin(project, 'services.interp.labels.k2'))
      .toEqual({ ok: false, reason: 'interpolated' });
    expect(authoredOriginsFor(project, 'interp', ['k2'])).toEqual({ k2: { ambiguity: 'interpolated' } });
    // An inline declaration outranks every label file, so an unknown path
    // cannot take away the inline origin.
    expect(authoredOriginsFor(project, 'interp', ['own'], { own: 'inline' })?.own)
      .toMatchObject({ source: 'inline', file: 'compose.yaml', line: 7 });
  });
});

describe('empty-key list labels keep every declared range', () => {
  it('locates an empty-key entry and later labels on their own lines', async () => {
    writeStack('label-empty-key-list', {
      'compose.yaml': [
        'services:',
        '  api:',
        '    image: nginx:1',
        '    labels:',
        '      - "=empty"',
        '      - "owner=team"',
        '      - "=between"',
        '      - "other=y"',
        '',
      ].join('\n'),
    });
    const project = await buildAuthoredProject(nodeId, 'label-empty-key-list');
    const labels = project.labels.get('api')!;
    // Both empty-key entries are declarations of the empty key; the later one
    // wins, and each keeps the line it was written on.
    expect(labels.contributionsByKey.get('')?.map(contribution => contribution.range.line)).toEqual([5, 7]);
    expect(labels.winners['']?.range.line).toBe(7);
    expect(correlateLabel(project, 'api', '').origin).toMatchObject({
      file: 'compose.yaml', range: { line: 7 },
    });
    expect(correlateLabel(project, 'api', 'owner').origin).toMatchObject({
      file: 'compose.yaml', range: { line: 6 },
    });
    expect(correlateLabel(project, 'api', 'other').origin).toMatchObject({
      file: 'compose.yaml', range: { line: 8 },
    });
    const origins = authoredOriginsFor(project, 'api', ['', 'owner', 'other']);
    expect(origins?.['']?.line).toBe(7);
    expect(origins?.owner?.line).toBe(6);
    expect(origins?.other?.line).toBe(8);
    expect(resolveEditOrigin(project, 'services.api.labels.owner')).toMatchObject({
      ok: true, origin: { file: 'compose.yaml', range: { line: 6 } },
    });
  });

  it('keeps later indices when the whole list is supplied through an alias or a merge', async () => {
    writeStack('label-empty-key-alias', {
      'compose.yaml': [
        'x-labels: &labels',
        '  - "=empty"',
        '  - "owner=team"',
        'x-svc: &svc',
        '  labels: *labels',
        'services:',
        '  api:',
        '    <<: *svc',
        '    image: nginx:1',
        '',
      ].join('\n'),
    });
    const project = await buildAuthoredProject(nodeId, 'label-empty-key-alias');
    expect(correlateLabel(project, 'api', 'owner').origin).toMatchObject({
      file: 'compose.yaml', range: { line: 3 },
    });
    expect(authoredOriginsFor(project, 'api', ['owner'])?.owner?.line).toBe(3);
  });

  it('keeps later indices when a dynamic empty-key entry sits between them', async () => {
    writeStack('label-empty-key-dynamic', {
      'compose.yaml': [
        'services:',
        '  api:',
        '    image: nginx:1',
        '    labels:',
        '      - "=empty"',
        '      - "${LABEL_KEY}=dynamic"',
        '      - "owner=team"',
        '',
      ].join('\n'),
    });
    const project = await buildAuthoredProject(nodeId, 'label-empty-key-dynamic');
    expect(project.labels.get('api')!.hasDynamicKeys).toBe(true);
    expect(correlateLabel(project, 'api', 'owner').origin).toMatchObject({
      file: 'compose.yaml', range: { line: 7 },
    });
    expect(authoredOriginsFor(project, 'api', ['owner'])?.owner?.line).toBe(7);
  });

  it('keeps later indices when an individual empty-key item is an alias', async () => {
    writeStack('label-empty-key-item-alias', {
      'compose.yaml': [
        'x-empty: &empty "=empty"',
        'services:',
        '  api:',
        '    image: nginx:1',
        '    labels:',
        '      - *empty',
        '      - "owner=team"',
        '',
      ].join('\n'),
    });
    const project = await buildAuthoredProject(nodeId, 'label-empty-key-item-alias');
    // The aliased item resolves to its anchor, and it must not shift its sibling.
    expect(project.labels.get('api')!.ambiguity['']).toBeUndefined();
    expect(correlateLabel(project, 'api', '').origin).toMatchObject({
      file: 'compose.yaml', range: { line: 1 },
    });
    expect(correlateLabel(project, 'api', 'owner').origin).toMatchObject({
      file: 'compose.yaml', range: { line: 7 },
    });
    expect(resolveEditOrigin(project, 'services.api.labels.owner')).toMatchObject({
      ok: true, origin: { range: { line: 7 } },
    });
  });

  it('keeps later indices across layers and external inheritance', async () => {
    writeStack('label-empty-key-layers', {
      'compose.yaml': [
        'services:',
        '  api:',
        '    image: nginx:1',
        '    labels:',
        '      - "=empty"',
        '      - "owner=base"',
        '',
      ].join('\n'),
      'compose.override.yaml': [
        'services:',
        '  api:',
        '    labels:',
        '      - "=between"',
        '      - "owner=override"',
        '',
      ].join('\n'),
    });
    const layered = await buildAuthoredProject(nodeId, 'label-empty-key-layers');
    expect(correlateLabel(layered, 'api', 'owner').origin).toMatchObject({
      file: 'compose.override.yaml', range: { line: 5 },
    });

    writeStack('label-empty-key-extends', {
      'compose.yaml': [
        'services:',
        '  api:',
        '    extends:',
        '      file: base.yaml',
        '      service: api',
        '    image: nginx:1',
        '',
      ].join('\n'),
      'base.yaml': [
        'services:',
        '  api:',
        '    labels:',
        '      - "=empty"',
        '      - "owner=base"',
        '',
      ].join('\n'),
    });
    const inherited = await buildAuthoredProject(nodeId, 'label-empty-key-extends');
    expect(correlateLabel(inherited, 'api', 'owner').origin).toMatchObject({
      file: 'base.yaml', range: { line: 5 },
    });
  });
});

describe('edit-origin disambiguation across label interpretations', () => {
  const sibling = ['  api.labels.owner:', '    image: busybox:1'];

  function composeWith(api: string[], siblingFirst: boolean): string {
    const apiLines = ['  api:', ...api];
    return ['services:', ...(siblingFirst ? [...apiLines, ...sibling] : [...sibling, ...apiLines]), ''].join('\n');
  }

  it('refuses a label-file origin that collides with a dotted sibling service in both orders', async () => {
    for (const siblingFirst of [true, false]) {
      const stack = `label-sibling-file-${siblingFirst ? 'last' : 'first'}`;
      writeStack(stack, {
        'compose.yaml': composeWith([
          '    image: nginx:1',
          '    label_file: app.labels',
        ], siblingFirst),
        'app.labels': 'owner=team\n',
      });
      const project = await buildAuthoredProject(nodeId, stack);
      expect(correlateLabel(project, 'api', 'owner').origin).toMatchObject({ file: 'app.labels' });
      expect(resolveEditOrigin(project, 'services.api.labels.owner')).toEqual({
        ok: false, reason: 'ambiguous-multiple-sources',
      });
      expect(correlateField(project, 'api.labels.owner', 'image', 'busybox:1').origin).toMatchObject({
        file: 'compose.yaml',
      });
    }
  });

  it('refuses a list-form label origin that collides with a dotted sibling service', async () => {
    writeStack('label-sibling-list', {
      'compose.yaml': composeWith([
        '    image: nginx:1',
        '    labels:',
        '      - "owner=team"',
      ], true),
    });
    const project = await buildAuthoredProject(nodeId, 'label-sibling-list');
    expect(correlateLabel(project, 'api', 'owner').origin).toMatchObject({ file: 'compose.yaml' });
    expect(resolveEditOrigin(project, 'services.api.labels.owner')).toEqual({
      ok: false, reason: 'ambiguous-multiple-sources',
    });
  });

  it('refuses a dynamic label key that could name the requested key', async () => {
    writeStack('label-sibling-dynamic', {
      'compose.yaml': composeWith([
        '    image: nginx:1',
        '    labels:',
        '      - "${LABEL_KEY:-owner}=team"',
      ], false),
    });
    const project = await buildAuthoredProject(nodeId, 'label-sibling-dynamic');
    expect(correlateLabel(project, 'api', 'owner').reason).toBe('interpolated');
    expect(resolveEditOrigin(project, 'services.api.labels.owner')).toEqual({
      ok: false, reason: 'ambiguous-unparsed-source',
    });
  });

  it('refuses a label origin when a label file is unreadable or outside the boundary', async () => {
    for (const [stack, labelFile, reason] of [
      ['label-sibling-missing-file', 'missing.labels', 'ambiguous-unparsed-source'],
      ['label-sibling-outside-file', '../outside.labels', 'ambiguous-unparsed-source'],
    ] as const) {
      writeStack(stack, {
        'compose.yaml': composeWith([
          '    image: nginx:1',
          `    label_file: ${labelFile}`,
        ], true),
      });
      const project = await buildAuthoredProject(nodeId, stack);
      expect(resolveEditOrigin(project, 'services.api.labels.owner')).toEqual({
        ok: false, reason,
      });
    }
  });

  it('refuses an aliased or merged inline list against a dotted sibling service', async () => {
    writeStack('label-sibling-alias-list', {
      'compose.yaml': [
        'x-labels: &labels',
        '  - "owner=team"',
        'services:',
        '  api:',
        '    image: nginx:1',
        '    labels: *labels',
        ...sibling,
        '',
      ].join('\n'),
    });
    const aliased = await buildAuthoredProject(nodeId, 'label-sibling-alias-list');
    expect(correlateLabel(aliased, 'api', 'owner').origin).toMatchObject({ file: 'compose.yaml' });
    expect(resolveEditOrigin(aliased, 'services.api.labels.owner')).toEqual({
      ok: false, reason: 'ambiguous-multiple-sources',
    });

    writeStack('label-sibling-merged-list', {
      'compose.yaml': [
        'x-svc: &svc',
        '  image: nginx:1',
        '  labels:',
        '    - "owner=team"',
        'services:',
        '  api:',
        '    <<: *svc',
        ...sibling,
        '',
      ].join('\n'),
    });
    const merged = await buildAuthoredProject(nodeId, 'label-sibling-merged-list');
    expect(correlateLabel(merged, 'api', 'owner').origin).toMatchObject({ file: 'compose.yaml' });
    expect(resolveEditOrigin(merged, 'services.api.labels.owner')).toEqual({
      ok: false, reason: 'ambiguous-multiple-sources',
    });
  });

  it('refuses a shared label-file origin and an inherited label origin against a sibling', async () => {
    writeStack('label-sibling-shared', {
      'compose.yaml': [
        'services:',
        '  api:',
        '    image: nginx:1',
        '    label_file: app.labels',
        '  web:',
        '    image: nginx:1',
        '    label_file: app.labels',
        ...sibling,
        '',
      ].join('\n'),
      'app.labels': 'owner=team\n',
    });
    const shared = await buildAuthoredProject(nodeId, 'label-sibling-shared');
    expect(correlateLabel(shared, 'api', 'owner').reason).toBe('shared-input');
    expect(resolveEditOrigin(shared, 'services.api.labels.owner')).toEqual({
      ok: false, reason: 'ambiguous-multiple-sources',
    });

    writeStack('label-sibling-extends', {
      'compose.yaml': [
        'services:',
        '  api:',
        '    extends:',
        '      file: base.yaml',
        '      service: api',
        '    image: nginx:1',
        ...sibling,
        '',
      ].join('\n'),
      'base.yaml': 'services:\n  api:\n    labels:\n      owner: base-team\n',
    });
    const inherited = await buildAuthoredProject(nodeId, 'label-sibling-extends');
    expect(correlateLabel(inherited, 'api', 'owner').origin).toMatchObject({ file: 'base.yaml' });
    expect(resolveEditOrigin(inherited, 'services.api.labels.owner')).toEqual({
      ok: false, reason: 'ambiguous-multiple-sources',
    });
  });

  it('refuses a later-layer label origin against a sibling service in an earlier layer', async () => {
    writeStack('label-sibling-layer', {
      'compose.yaml': ['services:', ...sibling, '  api:', '    image: nginx:1', ''].join('\n'),
      'compose.override.yaml': [
        'services:',
        '  api:',
        '    labels:',
        '      owner: override-team',
        '',
      ].join('\n'),
    });
    const project = await buildAuthoredProject(nodeId, 'label-sibling-layer');
    expect(correlateLabel(project, 'api', 'owner').origin).toMatchObject({ file: 'compose.override.yaml' });
    expect(resolveEditOrigin(project, 'services.api.labels.owner')).toEqual({
      ok: false, reason: 'ambiguous-multiple-sources',
    });
  });
});
