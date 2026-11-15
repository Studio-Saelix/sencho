import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { NodeRegistry } from '../services/NodeRegistry';
import { buildAuthoredProject, correlateField, correlateLabel, locateFinding } from '../services/composeSource';
import type { RuleHit } from '../services/preflight/types';

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
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
}

function hit(ruleId: RuleHit['ruleId'], overrides: Partial<RuleHit> = {}): RuleHit {
  return { ruleId, severity: 'warning', title: 't', message: 'm', ...overrides };
}

describe('authored service inheritance', () => {
  it('resolves same-name external inheritance without conflating the base with the service', async () => {
    writeStack('inheritance-same-name', {
      'compose.yaml': [
        'services:',
        '  api:',
        '    extends:',
        '      file: common/common.yml',
        '      service: api',
        '    labels:',
        '      own: own-inline',
        '    label_file: own.labels',
        '',
      ].join('\n'),
      'common/common.yml': [
        'services:',
        '  api:',
        '    image: nginx:1',
        '    labels:',
        '      base: from-base',
        '      clash: base-inline',
        '    label_file: base.labels',
        '',
      ].join('\n'),
      'common/base.labels': 'file=from-base-file\nclash=file-wins\n',
      'own.labels': 'ownfile=own-file\n',
    });
    const project = await buildAuthoredProject(nodeId, 'inheritance-same-name');
    const labels = project.labels.get('api')!;
    expect(project.partialReasons).toEqual([]);
    expect(labels.winners.base).toMatchObject({ source: 'inline', file: 'common/common.yml' });
    expect(labels.winners.file).toMatchObject({ source: 'label-file', file: 'common/base.labels' });
    expect(labels.winners.own).toMatchObject({ source: 'inline', file: 'compose.yaml' });
    expect(labels.winners.ownfile).toMatchObject({ source: 'label-file', file: 'own.labels' });
    // Inline beats a label file even when the label file was declared later.
    expect(labels.winners.clash).toMatchObject({ source: 'inline', file: 'common/common.yml' });
    // The extends-only base is a declaration of `api`, not a second project
    // service: its file and declared service are kept separately.
    expect(project.serviceDefinitions?.get('api')?.map(definition => [definition.file, definition.declaredService, definition.rank]))
      .toEqual([['common/common.yml', 'api', 0], ['compose.yaml', 'api', 1]]);
    expect(correlateLabel(project, 'api', 'base').origin?.file).toBe('common/common.yml');
  });

  it('resolves the same base service name in different files independently', async () => {
    writeStack('inheritance-duplicate-base-names', {
      'compose.yaml': [
        'services:',
        '  api:',
        '    extends:',
        '      file: a.yml',
        '      service: base',
        '  web:',
        '    extends:',
        '      file: b.yml',
        '      service: base',
        '',
      ].join('\n'),
      'a.yml': 'services:\n  base:\n    image: nginx:1\n    labels:\n      a-only: "1"\n',
      'b.yml': 'services:\n  base:\n    image: nginx:1\n    labels:\n      b-only: "1"\n',
    });
    const project = await buildAuthoredProject(nodeId, 'inheritance-duplicate-base-names');
    const api = project.labels.get('api')!;
    const web = project.labels.get('web')!;
    expect(api.winners['a-only']?.file).toBe('a.yml');
    expect(api.winners['b-only']).toBeUndefined();
    expect(web.winners['b-only']?.file).toBe('b.yml');
    expect(web.winners['a-only']).toBeUndefined();
  });

  it('resolves same-file long and short extends, and nested inheritance', async () => {
    writeStack('inheritance-nested', {
      'compose.yaml': [
        'services:',
        '  root:',
        '    image: nginx:1',
        '    labels:',
        '      root: "1"',
        '  mid:',
        '    extends: root',
        '    labels:',
        '      mid: "1"',
        '  app:',
        '    extends:',
        '      service: mid',
        '    labels:',
        '      app: "1"',
        '',
      ].join('\n'),
    });
    const project = await buildAuthoredProject(nodeId, 'inheritance-nested');
    expect(project.partial).toBe(false);
    const app = project.labels.get('app')!;
    expect(app.winners.root?.file).toBe('compose.yaml');
    expect(app.winners.mid?.file).toBe('compose.yaml');
    expect(app.winners.app?.file).toBe('compose.yaml');
  });

  it('resolves a nested chain that crosses files', async () => {
    writeStack('inheritance-cross-file', {
      'compose.yaml': 'services:\n  app:\n    extends:\n      file: mid.yml\n      service: mid\n    labels:\n      app: "1"\n',
      'mid.yml': 'services:\n  mid:\n    extends:\n      file: root.yml\n      service: root\n    labels:\n      mid: "1"\n',
      'root.yml': 'services:\n  root:\n    image: nginx:1\n    labels:\n      root: "1"\n',
    });
    const project = await buildAuthoredProject(nodeId, 'inheritance-cross-file');
    const app = project.labels.get('app')!;
    expect(app.winners.root?.file).toBe('root.yml');
    expect(app.winners.mid?.file).toBe('mid.yml');
    expect(app.winners.app?.file).toBe('compose.yaml');
    expect(project.partial).toBe(false);
  });

  it('resolves fields declared only on an inherited base', async () => {
    writeStack('inheritance-field', {
      'compose.yaml': 'services:\n  api:\n    extends:\n      file: common.yml\n      service: api\n',
      'common.yml': 'services:\n  api:\n    image: nginx:1\n    restart: always\n',
    });
    const project = await buildAuthoredProject(nodeId, 'inheritance-field');
    const image = correlateField(project, 'api', 'image', 'nginx:1');
    expect(image.origin?.file).toBe('common.yml');
    const restart = correlateField(project, 'api', 'restart', 'always');
    expect(restart.origin?.file).toBe('common.yml');
  });

  it('does not claim an inherited literal when a later layer interpolates the field', async () => {
    writeStack('inheritance-later-interpolation', {
      'compose.yaml': 'services:\n  api:\n    extends:\n      file: common.yml\n      service: api\n',
      'compose.override.yaml': 'services:\n  api:\n    image: ${IMAGE}\n',
      'common.yml': 'services:\n  api:\n    image: nginx:latest\n',
    });
    const project = await buildAuthoredProject(nodeId, 'inheritance-later-interpolation');
    const image = correlateField(project, 'api', 'image', 'nginx:latest');
    expect(image.origin).toBeUndefined();
    expect(image.reason).toBe('interpolated');
  });

  it('refuses a bind location when an inherited mount and the own mount share a target', async () => {
    writeStack('inheritance-volume-tie', {
      'compose.yaml': 'services:\n  api:\n    extends:\n      file: common.yml\n      service: api\n    volumes:\n      - ./own:/data\n',
      'common.yml': 'services:\n  api:\n    image: nginx:1\n    volumes:\n      - ./base:/data\n',
    });
    const project = await buildAuthoredProject(nodeId, 'inheritance-volume-tie');
    const bind = locateFinding(project, hit('bind-path-missing', {
      service: 'api', sourcePath: '/data', subject: { kind: 'bind', key: '/data' },
    }));
    expect(bind).toBeUndefined();
  });

  it('bounds a long same-file inheritance chain instead of walking it per service', async () => {
    const lines = ['services:', '  s0:', '    image: nginx:1'];
    for (let level = 1; level <= 200; level += 1) {
      lines.push(`  s${level}:`, `    extends: s${level - 1}`);
    }
    writeStack('inheritance-budget', { 'compose.yaml': `${lines.join('\n')}\n` });
    const project = await buildAuthoredProject(nodeId, 'inheritance-budget');
    expect(project.partialReasons).toContain('bounds-exceeded');
    expect(correlateField(project, 's199', 'image', 'nginx:1').origin).toBeUndefined();
  });

  it('refuses every origin when the extends file is missing', async () => {
    writeStack('inheritance-missing', {
      'compose.yaml': [
        'services:',
        '  api:',
        '    extends:',
        '      file: missing.yml',
        '      service: api',
        '    image: nginx:1',
        '    labels:',
        '      a: "1"',
        '',
      ].join('\n'),
    });
    const project = await buildAuthoredProject(nodeId, 'inheritance-missing');
    expect(project.unresolvedServices.has('api')).toBe(true);
    expect(correlateLabel(project, 'api', 'a').origin).toBeUndefined();
    expect(correlateField(project, 'api', 'image', 'nginx:1').origin).toBeUndefined();
  });

  it('detects a same-file extends cycle and refuses every origin for the service', async () => {
    writeStack('inheritance-cycle', {
      'compose.yaml': [
        'services:',
        '  a:',
        '    extends: b',
        '    labels:',
        '      a: "1"',
        '  b:',
        '    extends: a',
        '    labels:',
        '      b: "1"',
        '',
      ].join('\n'),
    });
    const project = await buildAuthoredProject(nodeId, 'inheritance-cycle');
    expect(project.partial).toBe(true);
    expect(project.partialReasons).toContain('cycle');
    expect(project.unresolvedServices?.has('a')).toBe(true);
    expect(project.unresolvedServices?.has('b')).toBe(true);
    expect(correlateLabel(project, 'a', 'a').origin).toBeUndefined();
    expect(correlateLabel(project, 'a', 'a').reason).toBe('ambiguous-unparsed-source');
    expect(locateFinding(project, hit('image-latest', { service: 'a', sourcePath: 'a' }))).toBeUndefined();
  });

  it('detects an external cycle that returns to the same service in the declaring file', async () => {
    writeStack('inheritance-external-cycle', {
      'compose.yaml': 'services:\n  api:\n    extends:\n      file: common.yml\n      service: api\n',
      'common.yml': 'services:\n  api:\n    extends:\n      file: compose.yaml\n      service: api\n',
    });
    const project = await buildAuthoredProject(nodeId, 'inheritance-external-cycle');
    expect(project.partialReasons).toContain('cycle');
    expect(project.unresolvedServices?.has('api')).toBe(true);
    expect(correlateField(project, 'api', 'image', 'nginx:1').origin).toBeUndefined();
  });
});
