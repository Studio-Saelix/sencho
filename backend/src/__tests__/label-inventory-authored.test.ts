import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { ComposeService } from '../services/ComposeService';
import DockerController from '../services/DockerController';
import { NodeRegistry } from '../services/NodeRegistry';
import { buildStackLabelInventory } from '../services/LabelInventoryService';

let tmpDir: string;
let nodeId: number;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  nodeId = NodeRegistry.getInstance().getDefaultNodeId();
});

afterAll(() => cleanupTestDb(tmpDir));
afterEach(() => vi.restoreAllMocks());

function writeStack(stack: string, files: Record<string, string>): void {
  const dir = path.join(process.env.COMPOSE_DIR as string, stack);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
}

function stubRender(serviceLabels: Record<string, Record<string, string>>): void {
  vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
    renderConfig: vi.fn().mockResolvedValue({
      rendered: JSON.stringify({
        name: 'proj',
        services: Object.fromEntries(Object.entries(serviceLabels).map(([service, labels]) => [service, { labels }])),
      }),
      stderr: '',
      code: 0,
      timedOut: false,
    }),
  } as unknown as ComposeService);
}

function stubDocker(rows: Array<{ id: string; service: string; labels: Record<string, string> }> = []): void {
  vi.spyOn(DockerController, 'getInstance').mockReturnValue({
    getContainersByStack: vi.fn().mockResolvedValue(rows.map(row => ({
      Id: row.id, Names: [`/${row.id}`], State: 'running', Service: row.service,
    }))),
    inspectContainerLabelsAndImage: vi.fn().mockImplementation(async (id: string) => {
      const row = rows.find(entry => entry.id === id);
      return row ? { labels: row.labels, imageId: 'img' } : null;
    }),
    inspectImageLabels: vi.fn().mockResolvedValue({ labels: {} }),
  } as unknown as DockerController);
}

describe('authored label origins in the stack inventory', () => {
  it('adds inline and label-file origins with ranges and no values', async () => {
    writeStack('label-origins', {
      'compose.yaml': [
        'services:',
        '  api:',
        '    image: nginx:1',
        '    labels:',
        '      com.example.inline: "secret-inline-value"',
        '    label_file: app.labels',
        '  web:',
        '    image: nginx:1',
        '    label_file: app.labels',
        '',
      ].join('\n'),
      'app.labels': 'com.example.file=secret-file-value\n',
    });
    stubRender({
      api: { 'com.example.inline': 'secret-inline-value', 'com.example.file': 'secret-file-value' },
      web: { 'com.example.file': 'secret-file-value' },
    });
    stubDocker();
    const inventory = await buildStackLabelInventory(nodeId, 'label-origins');
    const api = inventory.services.find(service => service.service === 'api')!;
    expect(api.authored?.['com.example.inline']).toMatchObject({
      source: 'inline', file: 'compose.yaml', line: 5,
    });
    expect(api.authored?.['com.example.file']).toMatchObject({
      source: 'label-file', file: 'app.labels', line: 1, shared: true,
    });
    expect(api.authored?.['com.example.file']?.overridden).toBeUndefined();
    const web = inventory.services.find(service => service.service === 'web')!;
    expect(web.authored?.['com.example.file']?.shared).toBe(true);
    expect(JSON.stringify(api.authored)).not.toContain('secret-inline-value');
    expect(JSON.stringify(api.authored)).not.toContain('secret-file-value');
  });

  it('gives an export-prefixed label-file entry an authored origin', async () => {
    writeStack('label-export', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    label_file: lf.env\n',
      'lf.env': 'export ex=3\nplain=1\n',
    });
    stubRender({ api: { ex: '3', plain: '1' } });
    stubDocker();
    const inventory = await buildStackLabelInventory(nodeId, 'label-export');
    const api = inventory.services.find(service => service.service === 'api')!;
    expect(api.authored?.ex).toMatchObject({
      source: 'label-file', file: 'lf.env', line: 1, column: 8,
    });
    expect(api.authored?.ex?.ambiguity).toBeUndefined();
    expect(api.authored?.plain).toMatchObject({ source: 'label-file', file: 'lf.env', line: 2 });
  });

  it('marks an inline override of a label-file entry without a value', async () => {
    writeStack('label-override', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    label_file: app.labels\n    labels:\n      a: inline\n',
      'app.labels': 'a=file\n',
    });
    stubRender({ api: { a: 'inline' } });
    stubDocker();
    const inventory = await buildStackLabelInventory(nodeId, 'label-override');
    const api = inventory.services.find(service => service.service === 'api')!;
    expect(api.authored?.a).toMatchObject({ source: 'inline', overridden: true });
  });

  it('renders one reason and no link for an unreadable label file', async () => {
    writeStack('label-unreadable', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    label_file: missing.labels\n',
    });
    stubRender({ api: { a: 'x' } });
    stubDocker();
    const inventory = await buildStackLabelInventory(nodeId, 'label-unreadable');
    const api = inventory.services.find(service => service.service === 'api')!;
    expect(api.authored?.a).toEqual({ ambiguity: 'unparsed-source' });
  });

  it('builds origins for many inline winners without a per-key contribution scan', async () => {
    // The inline map is capped by the parser's node budget; the label file is
    // not, so it carries the bulk of the contributions. Every inline winner is
    // an override, which is the branch that used to rescan the whole list.
    const inlineCount = 10_000;
    const fileCount = 30_000;
    const labels = Object.fromEntries(Array.from({ length: inlineCount }, (_, index) => [`key.${index}`, `value${index}`]));
    writeStack('label-large-inline', {
      'compose.yaml': `services:\n  api:\n    image: nginx:1\n    label_file: app.labels\n    labels:\n${
        Object.entries(labels).map(([key, value]) => `      "${key}": "${value}"`).join('\n')
      }\n`,
      'app.labels': `${Array.from({ length: fileCount }, (_, index) => `key.${index}=file${index}`).join('\n')}\n`,
    });
    stubRender({ api: labels });
    stubDocker();
    const started = performance.now();
    const inventory = await buildStackLabelInventory(nodeId, 'label-large-inline');
    const elapsed = performance.now() - started;
    const api = inventory.services.find(service => service.service === 'api')!;
    expect(Object.keys(api.authored ?? {})).toHaveLength(inlineCount);
    expect(api.authored?.['key.0']).toMatchObject({
      source: 'inline', file: 'compose.yaml', overridden: true,
    });
    // The old read scanned every contribution once per key (quadratic). A map
    // built with the model keeps this linear; the margin absorbs CI noise.
    expect(elapsed).toBeLessThan(2_000);
  }, 30_000);

  it('omits authored origins when a service extends an unresolvable base', async () => {
    writeStack('label-extends-cycle', {
      'compose.yaml': [
        'services:',
        '  a:',
        '    extends: b',
        '    image: nginx:1',
        '    labels:',
        '      a: "1"',
        '  b:',
        '    extends: a',
        '    image: nginx:1',
        '    labels:',
        '      b: "1"',
        '',
      ].join('\n'),
    });
    stubRender({ a: { a: '1' }, b: { b: '1' } });
    stubDocker();
    const inventory = await buildStackLabelInventory(nodeId, 'label-extends-cycle');
    const a = inventory.services.find(service => service.service === 'a')!;
    expect(a.authored?.a).toEqual({ source: 'inline', ambiguity: 'unparsed-source' });
    expect(a.authored?.a?.file).toBeUndefined();
    expect(a.authored?.a?.line).toBeUndefined();
  });

  it('shows an unreadable reason when the service is only declared in an unparsable layer', async () => {
    writeStack('label-service-unparsed', {
      'compose.yaml': 'services: [\n',
    });
    stubRender({ api: { a: '1' } });
    stubDocker();
    const inventory = await buildStackLabelInventory(nodeId, 'label-service-unparsed');
    const api = inventory.services.find(service => service.service === 'api')!;
    expect(api.authored?.a).toEqual({ ambiguity: 'unparsed-source' });
    expect(api.authored?.a?.file).toBeUndefined();
  });

  it('leaves runtime-only labels untouched and adds no authored map when the payload has none', async () => {
    writeStack('label-runtime-only', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n',
    });
    stubRender({ api: {} });
    stubDocker([{ id: 'c1', service: 'api', labels: { 'runtime.only': 'yes' } }]);
    const inventory = await buildStackLabelInventory(nodeId, 'label-runtime-only');
    const api = inventory.services.find(service => service.service === 'api')!;
    expect(api.authored).toBeUndefined();
    const runtime = api.replicas[0].runtimeLabels.find(label => label.key === 'runtime.only');
    expect(runtime?.source).toBe('runtime');
  });
});
