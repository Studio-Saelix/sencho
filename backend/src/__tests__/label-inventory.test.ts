/**
 * Label inventory service, provenance, redaction, and GET routes.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';
import { ComposeService } from '../services/ComposeService';
import DockerController from '../services/DockerController';
import { DatabaseService } from '../services/DatabaseService';
import { NodeRegistry } from '../services/NodeRegistry';
import {
  buildNodeLabelInventory,
  buildStackLabelInventory,
} from '../services/LabelInventoryService';
import { REDACTED_SENTINEL } from '../helpers/labelValueRedaction';

let tmpDir: string;
let app: import('express').Express;
let authCookie: string;
let nodeId: number;

function composeDir(): string { return process.env.COMPOSE_DIR as string; }

function writeStack(stack: string, files: Record<string, string>): void {
  const dir = path.join(composeDir(), stack);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
}

function stubRender(serviceLabels: Record<string, Record<string, string> | string[]> | null): void {
  const rendered = serviceLabels === null
    ? null
    : JSON.stringify({
      name: 'proj',
      services: Object.fromEntries(
        Object.entries(serviceLabels).map(([s, labels]) => [s, { labels }]),
      ),
    });
  vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
    renderConfig: vi.fn().mockResolvedValue({ rendered, stderr: '', code: rendered === null ? 1 : 0, timedOut: false }),
  } as unknown as ComposeService);
}

interface StubRow {
  id: string;
  name: string;
  state: string;
  stack: string | null;
  service: string | null;
  labels: Record<string, string>;
  inspectFailed?: boolean;
  imageId?: string;
}

/**
 * Stub DockerController for the label inventory. `images` maps an image id to its label
 * map, or to `null` to simulate an image inspect failure. An image id absent from the map
 * inspects successfully with no labels. Returns the `inspectImageLabels` spy so tests can
 * assert deduplication.
 */
function stubDockerList(
  rows: StubRow[],
  opts: { images?: Record<string, Record<string, string> | null> } = {},
): { inspectImageLabels: ReturnType<typeof vi.fn> } {
  const withDefaults = rows.map(r => ({ inspectFailed: false, imageId: 'img-default', ...r }));
  const images = opts.images ?? {};
  const inspectImageLabels = vi.fn(async (imageId: string) => {
    if (imageId in images) {
      const labels = images[imageId];
      return labels === null ? null : { labels };
    }
    return { labels: {} };
  });
  vi.spyOn(DockerController, 'getInstance').mockReturnValue({
    listContainersForLabelInventory: vi.fn().mockResolvedValue(withDefaults),
    getContainersByStack: vi.fn().mockImplementation(async (stack: string) =>
      withDefaults.filter(r => r.stack === stack).map(r => ({
        Id: r.id,
        Names: [`/${r.name}`],
        State: r.state,
        Service: r.service,
      })),
    ),
    inspectContainerLabelsAndImage: vi.fn().mockImplementation(async (id: string) => {
      const row = withDefaults.find(r => r.id === id);
      if (!row || row.inspectFailed) return null;
      return { labels: row.labels, imageId: row.imageId };
    }),
    inspectImageLabels,
  } as unknown as DockerController);
  return { inspectImageLabels };
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  authCookie = await loginAsTestAdmin(app);
  nodeId = (DatabaseService.getInstance().getDb().prepare('SELECT id FROM nodes WHERE is_default = 1').get() as { id: number }).id;
});

afterAll(() => cleanupTestDb(tmpDir));
afterEach(() => vi.restoreAllMocks());

describe('buildNodeLabelInventory', () => {
  it('builds inverted index and compose-system provenance', async () => {
    stubDockerList([
      {
        id: 'c1',
        name: 'web-1',
        state: 'running',
        stack: 'mys',
        service: 'web',
        imageId: 'img1',
        labels: {
          'com.docker.compose.service': 'web',
          'traefik.enable': 'true',
        },
      },
    ]);
    const inv = await buildNodeLabelInventory(nodeId);
    expect(inv.containers).toHaveLength(1);
    expect(inv.byLabel).toHaveLength(2);
    const svc = inv.containers[0].labels.find(l => l.key === 'com.docker.compose.service');
    expect(svc?.source).toBe('compose-system');
    const traefik = inv.containers[0].labels.find(l => l.key === 'traefik.enable');
    expect(traefik?.source).toBe('runtime');
    expect(inv.partial).toBe(false);
  });

  it('attributes image-inherited labels to the image, but runtime overrides stay runtime', async () => {
    stubDockerList([
      {
        id: 'c1',
        name: 'plex-1',
        state: 'running',
        stack: 'media',
        service: 'plex',
        imageId: 'plex-img',
        labels: {
          'org.opencontainers.image.title': 'Plex',
          'traefik.enable': 'true',
        },
      },
    ], { images: { 'plex-img': { 'org.opencontainers.image.title': 'Plex', 'traefik.enable': 'false' } } });
    const inv = await buildNodeLabelInventory(nodeId);
    const oci = inv.containers[0].labels.find(l => l.key === 'org.opencontainers.image.title');
    expect(oci?.source).toBe('image');
    // Same key on the image but a different value: the container overrides it, so runtime.
    const traefik = inv.containers[0].labels.find(l => l.key === 'traefik.enable');
    expect(traefik?.source).toBe('runtime');
    expect(inv.partial).toBe(false);
  });

  it('marks labels unknown and the inventory partial when the image inspect fails', async () => {
    stubDockerList([
      { id: 'c1', name: 'a-1', state: 'running', stack: 's', service: 'a', imageId: 'broken', labels: { 'custom.label': 'v' } },
    ], { images: { broken: null } });
    const inv = await buildNodeLabelInventory(nodeId);
    expect(inv.containers[0].labels.find(l => l.key === 'custom.label')?.source).toBe('unknown');
    expect(inv.partial).toBe(true);
  });

  it('treats an empty image id as unknown and partial without inspecting an empty id', async () => {
    const { inspectImageLabels } = stubDockerList([
      { id: 'c1', name: 'a-1', state: 'running', stack: 's', service: 'a', imageId: '', labels: { 'custom.label': 'v' } },
    ]);
    const inv = await buildNodeLabelInventory(nodeId);
    expect(inv.containers[0].labels.find(l => l.key === 'custom.label')?.source).toBe('unknown');
    expect(inv.partial).toBe(true);
    expect(inspectImageLabels).not.toHaveBeenCalledWith('');
  });

  it('inspects each shared image only once (dedup)', async () => {
    const { inspectImageLabels } = stubDockerList([
      { id: 'c1', name: 'a-1', state: 'running', stack: 's', service: 'a', imageId: 'shared', labels: { a: '1' } },
      { id: 'c2', name: 'a-2', state: 'running', stack: 's', service: 'a', imageId: 'shared', labels: { a: '1' } },
    ], { images: { shared: {} } });
    await buildNodeLabelInventory(nodeId);
    const sharedCalls = inspectImageLabels.mock.calls.filter(c => c[0] === 'shared');
    expect(sharedCalls).toHaveLength(1);
  });

  it('redacts secret-like label values by default', async () => {
    stubDockerList([
      {
        id: 'c1',
        name: 'app-1',
        state: 'running',
        stack: 'sec',
        service: 'app',
        imageId: 'img1',
        labels: { 'my.api.token': 'super-secret', 'traefik.enable': 'true' },
      },
    ]);
    const inv = await buildNodeLabelInventory(nodeId);
    const token = inv.containers[0].labels.find(l => l.key === 'my.api.token');
    expect(token?.value).toBe(REDACTED_SENTINEL);
    expect(token?.redacted).toBe(true);
    const plain = inv.containers[0].labels.find(l => l.key === 'traefik.enable');
    expect(plain?.value).toBe('true');
    expect(plain?.redacted).toBeUndefined();
  });

  it('redacts Traefik basicauth and digestauth label values', async () => {
    stubDockerList([
      {
        id: 'c1', name: 'web-1', state: 'running', stack: 's', service: 'web', imageId: 'img1',
        labels: {
          'traefik.http.middlewares.foo.basicauth.users': 'admin:$apr1$abc123',
          'traefik.http.middlewares.bar.digestauth.users': 'admin:realm:deadbeef',
          'traefik.enable': 'true',
        },
      },
    ]);
    const inv = await buildNodeLabelInventory(nodeId);
    const basic = inv.containers[0].labels.find(l => l.key.endsWith('basicauth.users'));
    const digest = inv.containers[0].labels.find(l => l.key.endsWith('digestauth.users'));
    expect(basic?.value).toBe(REDACTED_SENTINEL);
    expect(basic?.redacted).toBe(true);
    expect(digest?.value).toBe(REDACTED_SENTINEL);
    expect(digest?.redacted).toBe(true);
    expect(inv.containers[0].labels.find(l => l.key === 'traefik.enable')?.redacted).toBeUndefined();
  });

  it('reveals secret-like values when revealSecrets is true', async () => {
    stubDockerList([
      {
        id: 'c1',
        name: 'app-1',
        state: 'running',
        stack: 'sec',
        service: 'app',
        imageId: 'img1',
        labels: { 'api.token': 'visible-when-revealed' },
      },
    ]);
    const inv = await buildNodeLabelInventory(nodeId, { revealSecrets: true });
    expect(inv.containers[0].labels[0].value).toBe('visible-when-revealed');
    expect(inv.containers[0].labels[0].redacted).toBeUndefined();
  });
});

describe('buildStackLabelInventory', () => {
  it('reconciles declared and runtime labels', async () => {
    writeStack('lbl1', {
      'compose.yaml': 'services:\n  web:\n    image: nginx\n    labels:\n      traefik.enable: "true"\n      compose.only: "1"\n',
    });
    stubRender({ web: { 'traefik.enable': 'true', 'compose.only': '1' } });
    stubDockerList([
      {
        id: 'c1',
        name: 'lbl1-web-1',
        state: 'running',
        stack: 'lbl1',
        service: 'web',
        imageId: 'img1',
        labels: {
          'traefik.enable': 'true',
          'runtime.only': '1',
          'com.docker.compose.service': 'web',
        },
      },
    ]);
    const inv = await buildStackLabelInventory(nodeId, 'lbl1');
    expect(inv.renderable).toBe(true);
    expect(inv.partial).toBe(false);
    const web = inv.services.find(s => s.service === 'web');
    expect(web?.declaredLabels.map(l => l.key)).toEqual(['compose.only', 'traefik.enable']);
    expect(web?.replicas[0].onlyInCompose).toEqual(['compose.only']);
    expect(web?.replicas[0].onlyOnContainer).toContain('runtime.only');
    expect(web?.replicas[0].inBoth).toContain('traefik.enable');
    expect(web?.replicas[0].changed).toEqual([]);
  });

  it('flags a value that drifted between compose and runtime as changed, not inBoth', async () => {
    writeStack('drift1', {
      'compose.yaml': 'services:\n  web:\n    image: nginx\n    labels:\n      watchtower.enable: "true"\n',
    });
    stubRender({ web: { 'watchtower.enable': 'true' } });
    stubDockerList([
      {
        id: 'c1',
        name: 'drift1-web-1',
        state: 'running',
        stack: 'drift1',
        service: 'web',
        imageId: 'img1',
        labels: { 'watchtower.enable': 'false' },
      },
    ]);
    const inv = await buildStackLabelInventory(nodeId, 'drift1');
    const web = inv.services.find(s => s.service === 'web');
    expect(web?.replicas[0].changed).toEqual(['watchtower.enable']);
    expect(web?.replicas[0].inBoth).not.toContain('watchtower.enable');
  });

  it('detects drift on a secret-like key while its value stays redacted', async () => {
    writeStack('drift2', {
      'compose.yaml': 'services:\n  web:\n    image: nginx\n    labels:\n      auth.token: "declared"\n',
    });
    stubRender({ web: { 'auth.token': 'declared' } });
    stubDockerList([
      { id: 'c1', name: 'drift2-web-1', state: 'running', stack: 'drift2', service: 'web', imageId: 'img1', labels: { 'auth.token': 'runtime' } },
    ]);
    const inv = await buildStackLabelInventory(nodeId, 'drift2');
    const web = inv.services.find(s => s.service === 'web');
    expect(web?.replicas[0].changed).toEqual(['auth.token']);
    const rt = web?.replicas[0].runtimeLabels.find(l => l.key === 'auth.token');
    expect(rt?.value).toBe(REDACTED_SENTINEL);
    expect(rt?.redacted).toBe(true);
  });

  it('marks a replica inspectFailed and skips reconciliation instead of reporting false drift', async () => {
    writeStack('fail1', {
      'compose.yaml': 'services:\n  web:\n    image: nginx\n    labels:\n      traefik.enable: "true"\n',
    });
    stubRender({ web: { 'traefik.enable': 'true' } });
    stubDockerList([
      { id: 'c1', name: 'fail1-web-1', state: 'running', stack: 'fail1', service: 'web', imageId: 'img1', labels: {}, inspectFailed: true },
    ]);
    const inv = await buildStackLabelInventory(nodeId, 'fail1');
    const web = inv.services.find(s => s.service === 'web');
    expect(web?.replicas[0].inspectFailed).toBe(true);
    expect(web?.replicas[0].onlyInCompose).toEqual([]);
    expect(web?.replicas[0].runtimeLabels).toEqual([]);
    expect(inv.partial).toBe(true);
  });

  it('inspects each shared image only once across replicas (dedup)', async () => {
    writeStack('ddup', { 'compose.yaml': 'services:\n  web:\n    image: nginx\n' });
    stubRender({ web: {} });
    const { inspectImageLabels } = stubDockerList([
      { id: 'c1', name: 'ddup-web-1', state: 'running', stack: 'ddup', service: 'web', imageId: 'shared', labels: { a: '1' } },
      { id: 'c2', name: 'ddup-web-2', state: 'running', stack: 'ddup', service: 'web', imageId: 'shared', labels: { a: '1' } },
    ], { images: { shared: {} } });
    await buildStackLabelInventory(nodeId, 'ddup');
    expect(inspectImageLabels.mock.calls.filter(c => c[0] === 'shared')).toHaveLength(1);
  });

  it('attributes provenance on the stack path: compose wins over image, image labels tagged image', async () => {
    writeStack('prov1', {
      'compose.yaml': 'services:\n  web:\n    image: nginx\n    labels:\n      foo: "bar"\n',
    });
    stubRender({ web: { foo: 'bar' } });
    stubDockerList([
      { id: 'c1', name: 'prov1-web-1', state: 'running', stack: 'prov1', service: 'web', imageId: 'img1', labels: { foo: 'bar', 'org.opencontainers.image.title': 'Nginx' } },
    ], { images: { img1: { foo: 'bar', 'org.opencontainers.image.title': 'Nginx' } } });
    const inv = await buildStackLabelInventory(nodeId, 'prov1');
    const rep = inv.services.find(s => s.service === 'web')?.replicas[0];
    // foo is on both the image and the Compose file with the same value: Compose wins.
    expect(rep?.runtimeLabels.find(l => l.key === 'foo')?.source).toBe('compose');
    expect(rep?.runtimeLabels.find(l => l.key === 'org.opencontainers.image.title')?.source).toBe('image');
    expect(inv.partial).toBe(false);
  });

  it('marks stack runtime labels unknown and the inventory partial when the image inspect fails', async () => {
    writeStack('prov2', { 'compose.yaml': 'services:\n  web:\n    image: nginx\n' });
    stubRender({ web: {} });
    stubDockerList([
      { id: 'c1', name: 'prov2-web-1', state: 'running', stack: 'prov2', service: 'web', imageId: 'broken', labels: { 'custom.label': 'v' } },
    ], { images: { broken: null } });
    const inv = await buildStackLabelInventory(nodeId, 'prov2');
    const rep = inv.services.find(s => s.service === 'web')?.replicas[0];
    expect(rep?.runtimeLabels.find(l => l.key === 'custom.label')?.source).toBe('unknown');
    expect(inv.partial).toBe(true);
  });

  it('parses list-form compose labels', async () => {
    writeStack('lbl2', {
      'compose.yaml': 'services:\n  web:\n    image: nginx\n    labels:\n      - "watchtower.enable=true"\n',
    });
    stubRender({ web: { 'watchtower.enable': 'true' } });
    stubDockerList([]);
    const inv = await buildStackLabelInventory(nodeId, 'lbl2');
    expect(inv.services[0].declaredLabels[0]).toMatchObject({ key: 'watchtower.enable', value: 'true', source: 'compose' });
  });

  it('sets renderable false when compose render fails', async () => {
    writeStack('lbl3', { 'compose.yaml': 'services:\n  web:\n    image: nginx\n' });
    stubRender(null);
    stubDockerList([]);
    const inv = await buildStackLabelInventory(nodeId, 'lbl3');
    expect(inv.renderable).toBe(false);
  });

  it('resolves non-system labels to unknown and skips reconciliation when render fails', async () => {
    writeStack('rf1', { 'compose.yaml': 'services:\n  web:\n    image: nginx\n' });
    stubRender(null);
    stubDockerList([
      {
        id: 'c1', name: 'rf1-web-1', state: 'running', stack: 'rf1', service: 'web', imageId: 'img1',
        labels: { 'traefik.enable': 'true', 'com.docker.compose.service': 'web' },
      },
    ]);
    const inv = await buildStackLabelInventory(nodeId, 'rf1');
    expect(inv.renderable).toBe(false);
    // Render failure is signalled by renderable, not partial (which is for inspect failures).
    expect(inv.partial).toBe(false);
    const rep = inv.services.find(s => s.service === 'web')?.replicas[0];
    expect(rep?.runtimeLabels.find(l => l.key === 'traefik.enable')?.source).toBe('unknown');
    expect(rep?.runtimeLabels.find(l => l.key === 'com.docker.compose.service')?.source).toBe('compose-system');
    expect(rep?.onlyOnContainer).toEqual([]);
    expect(rep?.changed).toEqual([]);
  });
});

describe('io.sencho.* behavior annotations', () => {
  it('marks declared labels active or invalid and image or runtime copies inert', async () => {
    writeStack('sl1', { 'compose.yaml': 'services:\n  web:\n    image: nginx\n' });
    stubRender({
      web: {
        'io.sencho.url': 'https://app.example.com',
        'io.sencho.order': 'first',
        'io.sencho.future': 'x',
      },
    });
    stubDockerList([
      {
        id: 'c1', name: 'sl1-web-1', state: 'running', stack: 'sl1', service: 'web', imageId: 'img1',
        labels: {
          'io.sencho.url': 'https://app.example.com',
          'io.sencho.hidden': 'true',
          'io.sencho.image-only': 'y',
        },
      },
    ], { images: { img1: { 'io.sencho.image-only': 'y' } } });
    const inv = await buildStackLabelInventory(nodeId, 'sl1');
    const web = inv.services.find(s => s.service === 'web');
    const declared = Object.fromEntries((web?.declaredLabels ?? []).map(l => [l.key, l.behavior]));
    expect(declared['io.sencho.url']).toMatchObject({ state: 'active' });
    expect(declared['io.sencho.order']).toMatchObject({ state: 'invalid', reason: 'Use a whole number such as 10.' });
    expect(declared['io.sencho.future']).toMatchObject({ state: 'unsupported' });
    const runtime = Object.fromEntries((web?.replicas[0].runtimeLabels ?? []).map(l => [l.key, l]));
    // The runtime copy equal to the declaration is that declaration.
    expect(runtime['io.sencho.url'].behavior?.state).toBe('active');
    // Present only at runtime, or only in the image: visible but inert.
    expect(runtime['io.sencho.hidden'].behavior?.state).toBe('inert');
    expect(runtime['io.sencho.image-only'].behavior?.state).toBe('inert');
  });

  it('keeps every io.sencho.* label inert when the model did not render', async () => {
    writeStack('sl2', { 'compose.yaml': 'services:\n  web:\n    image: nginx\n' });
    stubRender(null);
    stubDockerList([
      {
        id: 'c1', name: 'sl2-web-1', state: 'running', stack: 'sl2', service: 'web', imageId: 'img1',
        labels: { 'io.sencho.url': 'https://runtime.example.com', 'other.label': '1' },
      },
    ]);
    const inv = await buildStackLabelInventory(nodeId, 'sl2');
    const labels = inv.services.find(s => s.service === 'web')?.replicas[0].runtimeLabels ?? [];
    expect(labels.find(l => l.key === 'io.sencho.url')?.behavior).toMatchObject({ state: 'inert' });
    expect(labels.find(l => l.key === 'other.label')?.behavior).toBeUndefined();
  });

  it('reads list-syntax labels, a bare key, and the last duplicate the same way the audit does', async () => {
    writeStack('sl3', { 'compose.yaml': 'services:\n  web:\n    image: nginx\n' });
    stubRender({ web: ['io.sencho.url=https://a.example.com', 'io.sencho.url=https://b.example.com', 'io.sencho.hidden', 'plain=1'] });
    stubDockerList([]);
    const inv = await buildStackLabelInventory(nodeId, 'sl3');
    const declared = Object.fromEntries((inv.services.find(s => s.service === 'web')?.declaredLabels ?? []).map(l => [l.key, l]));
    expect(declared['io.sencho.url'].value).toBe('https://b.example.com');
    expect(declared['io.sencho.url'].behavior?.state).toBe('active');
    // A bare list item is an empty value: declared, but not a boolean.
    expect(declared['io.sencho.hidden'].value).toBe('');
    expect(declared['io.sencho.hidden'].behavior?.state).toBe('invalid');
    expect(declared['plain'].behavior).toBeUndefined();
  });

  it('judges each replica of a service on its own value against the one declaration', async () => {
    writeStack('sl4', { 'compose.yaml': 'services:\n  web:\n    image: nginx\n' });
    stubRender({ web: { 'io.sencho.hidden': 'true' } });
    stubDockerList([
      { id: 'r1', name: 'sl4-web-1', state: 'running', stack: 'sl4', service: 'web', imageId: 'img1', labels: { 'io.sencho.hidden': 'true' } },
      { id: 'r2', name: 'sl4-web-2', state: 'running', stack: 'sl4', service: 'web', imageId: 'img1', labels: { 'io.sencho.hidden': 'false' } },
    ]);
    const inv = await buildStackLabelInventory(nodeId, 'sl4');
    const replicas = inv.services.find(s => s.service === 'web')?.replicas ?? [];
    const behaviors = replicas.map(r => r.runtimeLabels.find(l => l.key === 'io.sencho.hidden')?.behavior);
    expect(behaviors[0]?.state).toBe('active');
    expect(behaviors[1]?.state).toBe('inert');
    // The declared key exists, so the stale copy is told to recreate, not to declare it.
    expect(behaviors[1]?.reason).toContain('recreate the container');
  });

  it('treats a rendered $$ and the container\'s single $ as the same declaration', async () => {
    writeStack('sl5', { 'compose.yaml': 'services:\n  web:\n    image: nginx\n' });
    stubRender({ web: { 'io.sencho.url': 'https://a.example.com/?x=$$y', 'other.label': 'a$$b' } });
    stubDockerList([
      { id: 'c1', name: 'sl5-web-1', state: 'running', stack: 'sl5', service: 'web', imageId: 'img1', labels: { 'io.sencho.url': 'https://a.example.com/?x=$y', 'other.label': 'a$b' } },
    ]);
    const inv = await buildStackLabelInventory(nodeId, 'sl5');
    const runtime = Object.fromEntries((inv.services.find(s => s.service === 'web')?.replicas[0].runtimeLabels ?? []).map(l => [l.key, l]));
    expect(runtime['io.sencho.url'].source).toBe('compose');
    expect(runtime['io.sencho.url'].behavior?.state).toBe('active');
    expect(runtime['other.label'].source).toBe('compose');
  });

  it('names an unrenderable stack as the reason for every io.sencho.* label and never activates one', async () => {
    writeStack('sl6', { 'compose.yaml': 'services:\n  web:\n    image: nginx\n' });
    stubRender({ web: { 'io.sencho.url': 'https://a.example.com' } });
    vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
      renderConfig: vi.fn().mockResolvedValue({ rendered: 'not json', stderr: '', code: 0, timedOut: false }),
    } as unknown as ComposeService);
    stubDockerList([
      { id: 'c1', name: 'sl6-web-1', state: 'running', stack: 'sl6', service: 'web', imageId: 'img1', labels: { 'io.sencho.url': 'https://a.example.com' } },
    ]);
    const inv = await buildStackLabelInventory(nodeId, 'sl6');
    const labels = inv.services.find(s => s.service === 'web')?.replicas[0].runtimeLabels ?? [];
    expect(labels.find(l => l.key === 'io.sencho.url')?.behavior).toMatchObject({ state: 'inert', reason: expect.stringContaining('could not be rendered') });
  });

  it('never marks a node-wide io.sencho.* label active', async () => {
    stubDockerList([
      {
        id: 'c1', name: 'a-1', state: 'running', stack: 'a', service: 'web', imageId: 'img1',
        labels: { 'io.sencho.url': 'https://runtime.example.com', 'io.sencho.mesh': 'true', 'plain': '1' },
      },
    ]);
    const inv = await buildNodeLabelInventory(nodeId);
    const labels = inv.containers[0].labels;
    expect(labels.find(l => l.key === 'io.sencho.url')?.behavior?.state).toBe('inert');
    expect(labels.find(l => l.key === 'io.sencho.mesh')?.behavior?.state).toBe('inert');
    expect(labels.find(l => l.key === 'plain')?.behavior).toBeUndefined();
    expect(inv.byLabel.find(r => r.key === 'io.sencho.url')?.behavior?.state).toBe('inert');
    // The node-wide view has no Compose model, so its reason points at the stack view instead of claiming the label is undeclared.
    expect(labels.find(l => l.key === 'io.sencho.url')?.behavior?.reason).toContain('Compose Labels view');
  });
});

describe('GET /api/system/container-labels', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/system/container-labels');
    expect(res.status).toBe(401);
  });

  it('returns node inventory', async () => {
    stubDockerList([
      { id: 'c1', name: 'a', state: 'running', stack: 's', service: 'web', imageId: 'img1', labels: { foo: 'bar' } },
    ]);
    const res = await request(app).get('/api/system/container-labels').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body.nodeId).toBe(nodeId);
    expect(res.body.containers).toHaveLength(1);
  });

  it('redacts secrets by default and reveals them for an admin with reveal=1', async () => {
    stubDockerList([
      { id: 'c1', name: 'a', state: 'running', stack: 's', service: 'web', imageId: 'img1', labels: { 'api.token': 's3cr3t' } },
    ]);
    const redacted = await request(app).get('/api/system/container-labels').set('Cookie', authCookie);
    const rLabel = redacted.body.containers[0].labels.find((l: { key: string }) => l.key === 'api.token');
    expect(rLabel.value).toBe(REDACTED_SENTINEL);
    expect(rLabel.redacted).toBe(true);

    stubDockerList([
      { id: 'c1', name: 'a', state: 'running', stack: 's', service: 'web', imageId: 'img1', labels: { 'api.token': 's3cr3t' } },
    ]);
    const revealed = await request(app).get('/api/system/container-labels?reveal=1').set('Cookie', authCookie);
    const vLabel = revealed.body.containers[0].labels.find((l: { key: string }) => l.key === 'api.token');
    expect(vLabel.value).toBe('s3cr3t');
  });
});

describe('GET /api/stacks/:stackName/label-inventory', () => {
  it('returns 404 for unknown stack', async () => {
    const res = await request(app).get('/api/stacks/missing-stack/label-inventory').set('Cookie', authCookie);
    expect(res.status).toBe(404);
  });

  it('returns stack inventory', async () => {
    writeStack('route1', { 'compose.yaml': 'services:\n  web:\n    image: nginx\n' });
    stubRender({ web: {} });
    stubDockerList([]);
    const res = await request(app).get('/api/stacks/route1/label-inventory').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body.stackName).toBe('route1');
  });
});

describe('GET /api/fleet/container-labels', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/fleet/container-labels');
    expect(res.status).toBe(401);
  });

  it('aggregates the local node with no node errors', async () => {
    stubDockerList([
      { id: 'c1', name: 'a-1', state: 'running', stack: 's', service: 'a', imageId: 'img1', labels: { 'shared.label': 'v' } },
      { id: 'c2', name: 'b-1', state: 'running', stack: 's', service: 'b', imageId: 'img1', labels: { 'shared.label': 'v' } },
    ]);
    const res = await request(app).get('/api/fleet/container-labels').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body.nodeErrors).toEqual({});
    const shared = res.body.aggregatedByLabel.filter((r: { key: string }) => r.key === 'shared.label');
    expect(shared).toHaveLength(1);
    expect(shared[0].containers).toHaveLength(2);
  });

  it('keeps the same key=value distinct when the source differs', async () => {
    stubDockerList([
      { id: 'c1', name: 'a-1', state: 'running', stack: 's', service: 'a', imageId: 'ia', labels: { 'dup.label': 'v' } },
      { id: 'c2', name: 'b-1', state: 'running', stack: 's', service: 'b', imageId: 'ib', labels: { 'dup.label': 'v' } },
    ], { images: { ia: { 'dup.label': 'v' }, ib: {} } });
    const res = await request(app).get('/api/fleet/container-labels').set('Cookie', authCookie);
    const dup = res.body.aggregatedByLabel.filter((r: { key: string }) => r.key === 'dup.label');
    expect(dup).toHaveLength(2);
    // The server sorts by key, value, then source; assert that order directly (no re-sort).
    expect(dup.map((r: { source: string }) => r.source)).toEqual(['image', 'runtime']);
  });

  it('degrades an unreachable remote into nodeErrors without failing the whole request', async () => {
    stubDockerList([
      { id: 'c1', name: 'a-1', state: 'running', stack: 's', service: 'a', imageId: 'img1', labels: { foo: 'bar' } },
    ]);
    const db = DatabaseService.getInstance();
    const remoteId = db.addNode({ name: 'remote-lbl', type: 'remote', compose_dir: '/app/compose', is_default: false, api_url: 'http://remote.invalid', api_token: 't' });
    vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockImplementation((id: number) => id === remoteId ? { apiUrl: 'http://remote.invalid', apiToken: 't', trustedLoopback: false } : null);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 502 }));
    try {
      const res = await request(app).get('/api/fleet/container-labels').set('Cookie', authCookie);
      expect(res.status).toBe(200);
      expect(res.body.nodeErrors[remoteId]).toBeDefined();
      expect(res.body.aggregatedByLabel.some((r: { key: string }) => r.key === 'foo')).toBe(true);
    } finally {
      db.deleteNode(remoteId);
    }
  });

  it('degrades a malformed remote payload into nodeErrors, not a 500', async () => {
    stubDockerList([
      { id: 'c1', name: 'a-1', state: 'running', stack: 's', service: 'a', imageId: 'img1', labels: { foo: 'bar' } },
    ]);
    const db = DatabaseService.getInstance();
    const remoteId = db.addNode({ name: 'remote-bad', type: 'remote', compose_dir: '/app/compose', is_default: false, api_url: 'http://remote.invalid', api_token: 't' });
    vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockImplementation((id: number) => id === remoteId ? { apiUrl: 'http://remote.invalid', apiToken: 't', trustedLoopback: false } : null);
    // byLabel row missing valid key/value/source: must be rejected by the deep guard.
    const malformed = JSON.stringify({ nodeId: remoteId, containers: [], byLabel: [{ key: 123, containers: [] }], partial: false, generatedAt: 0 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(malformed, { status: 200, headers: { 'content-type': 'application/json' } }));
    try {
      const res = await request(app).get('/api/fleet/container-labels').set('Cookie', authCookie);
      expect(res.status).toBe(200);
      expect(res.body.nodeErrors[remoteId]).toBeDefined();
    } finally {
      db.deleteNode(remoteId);
    }
  });

  it('rejects a remote row with an invalid source value via the source allowlist', async () => {
    stubDockerList([]);
    const db = DatabaseService.getInstance();
    const remoteId = db.addNode({ name: 'remote-src', type: 'remote', compose_dir: '/app/compose', is_default: false, api_url: 'http://remote.invalid', api_token: 't' });
    vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockImplementation((id: number) => id === remoteId ? { apiUrl: 'http://remote.invalid', apiToken: 't', trustedLoopback: false } : null);
    const badSource = JSON.stringify({ nodeId: remoteId, containers: [], partial: false, generatedAt: 0, byLabel: [{ key: 'k', value: 'v', source: 'not-a-source', containers: [{ id: 'c', name: 'n' }] }] });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(badSource, { status: 200, headers: { 'content-type': 'application/json' } }));
    try {
      const res = await request(app).get('/api/fleet/container-labels').set('Cookie', authCookie);
      expect(res.status).toBe(200);
      expect(res.body.nodeErrors[remoteId]).toBe('Remote returned an unexpected label-inventory payload');
    } finally {
      db.deleteNode(remoteId);
    }
  });

  it('degrades a remote with a malformed inventory container into nodeErrors', async () => {
    stubDockerList([]);
    const db = DatabaseService.getInstance();
    const remoteId = db.addNode({ name: 'remote-cont', type: 'remote', compose_dir: '/app/compose', is_default: false, api_url: 'http://remote.invalid', api_token: 't' });
    vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockImplementation((id: number) => id === remoteId ? { apiUrl: 'http://remote.invalid', apiToken: 't', trustedLoopback: false } : null);
    const badContainer = JSON.stringify({ nodeId: remoteId, byLabel: [], partial: false, generatedAt: 0, containers: [{}] });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(badContainer, { status: 200, headers: { 'content-type': 'application/json' } }));
    try {
      const res = await request(app).get('/api/fleet/container-labels').set('Cookie', authCookie);
      expect(res.status).toBe(200);
      expect(res.body.nodeErrors[remoteId]).toBeDefined();
    } finally {
      db.deleteNode(remoteId);
    }
  });

  it('rejects a remote row with a malformed nested container ref', async () => {
    stubDockerList([]);
    const db = DatabaseService.getInstance();
    const remoteId = db.addNode({ name: 'remote-ref', type: 'remote', compose_dir: '/app/compose', is_default: false, api_url: 'http://remote.invalid', api_token: 't' });
    vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockImplementation((id: number) => id === remoteId ? { apiUrl: 'http://remote.invalid', apiToken: 't', trustedLoopback: false } : null);
    const badRef = JSON.stringify({ nodeId: remoteId, containers: [], partial: false, generatedAt: 0, byLabel: [{ key: 'k', value: 'v', source: 'runtime', containers: [{ id: 5 }] }] });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(badRef, { status: 200, headers: { 'content-type': 'application/json' } }));
    try {
      const res = await request(app).get('/api/fleet/container-labels').set('Cookie', authCookie);
      expect(res.status).toBe(200);
      expect(res.body.nodeErrors[remoteId]).toBeDefined();
    } finally {
      db.deleteNode(remoteId);
    }
  });
  describe('remote io.sencho.* behavior', () => {
    const containers = [{ id: 'c', name: 'n', stack: 's', service: 'web' }];
    const row = (extra: Record<string, unknown>) => ({ key: 'io.sencho.url', value: 'https://x.example.com', source: 'runtime', containers, ...extra });
    const respondWith = (inventories: Record<string, unknown>) => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: Parameters<typeof fetch>[0]) => {
        const host = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).hostname;
        return new Response(JSON.stringify(inventories[host]), { status: 200, headers: { 'content-type': 'application/json' } });
      });
    };
    const payload = (nodeId: number, byLabel: unknown[], labelContainers: unknown[] = []) =>
      ({ nodeId, containers: labelContainers, partial: false, generatedAt: 0, byLabel });
    const addRemote = (name: string, host: string) => {
      const db = DatabaseService.getInstance();
      const id = db.addNode({ name, type: 'remote', compose_dir: '/app/compose', is_default: false, api_url: `http://${host}`, api_token: 't' });
      return id;
    };
    const fetchFleet = () => request(app).get('/api/fleet/container-labels').set('Cookie', authCookie);
    const rowsOf = (body: { aggregatedByLabel: Array<{ key: string; value: string; behavior?: { state: string; reason?: string } }> }) => body.aggregatedByLabel;

    it('keeps a remote row\'s behavior and accepts an older node that sends none', async () => {
      stubDockerList([]);
      const remoteId = addRemote('remote-beh', 'new.invalid');
      vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockImplementation((id: number) => id === remoteId ? { apiUrl: 'http://new.invalid', apiToken: 't', trustedLoopback: false } : null);
      try {
        respondWith({ 'new.invalid': payload(remoteId, [
          row({ behavior: { state: 'inert', reason: 'Present only on the running container.' } }),
          { key: 'plain', value: '1', source: 'runtime', containers },
        ]) });
        const res = await fetchFleet();
        expect(res.body.nodeErrors[remoteId]).toBeUndefined();
        expect(rowsOf(res.body).find(r => r.key === 'io.sencho.url')?.behavior?.state).toBe('inert');
        expect(rowsOf(res.body).find(r => r.key === 'plain')?.behavior).toBeUndefined();
      } finally {
        DatabaseService.getInstance().deleteNode(remoteId);
      }
    });

    it.each([
      ['an unknown state', { state: 'trusted' }],
      ['a string', 'active'],
      ['a non-string reason', { state: 'inert', reason: 123 }],
    ])('degrades %s to an unsupported row and keeps the node\'s whole inventory', async (_label, behavior) => {
      stubDockerList([]);
      const remoteId = addRemote('remote-bad', 'bad.invalid');
      vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockImplementation((id: number) => id === remoteId ? { apiUrl: 'http://bad.invalid', apiToken: 't', trustedLoopback: false } : null);
      try {
        respondWith({ 'bad.invalid': payload(remoteId, [
          row({ behavior }),
          { key: 'plain', value: '1', source: 'runtime', containers },
        ], [{ id: 'c', name: 'n', stack: 's', service: 'web', state: 'running', labels: [{ key: 'io.sencho.url', value: 'v', source: 'runtime', behavior }] }]) });
        const res = await fetchFleet();
        expect(res.body.nodeErrors[remoteId]).toBeUndefined();
        expect(rowsOf(res.body).find(r => r.key === 'io.sencho.url')?.behavior).toMatchObject({ state: 'unsupported' });
        expect(rowsOf(res.body).find(r => r.key === 'plain')).toBeDefined();
        const node = (res.body.nodes as Array<{ nodeId: number; inventory: { containers: Array<{ labels: Array<{ behavior?: { state: string } }> }> } }>).find(n => n.nodeId === remoteId);
        expect(node?.inventory.containers[0].labels[0].behavior?.state).toBe('unsupported');
      } finally {
        DatabaseService.getInstance().deleteNode(remoteId);
      }
    });

    it('forces a remote\'s active claim on a runtime-only label to inert and bounds its text', async () => {
      stubDockerList([]);
      const remoteId = addRemote('remote-claim', 'claim.invalid');
      vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockImplementation((id: number) => id === remoteId ? { apiUrl: 'http://claim.invalid', apiToken: 't', trustedLoopback: false } : null);
      try {
        respondWith({ 'claim.invalid': payload(remoteId, [
          row({ behavior: { state: 'active', reason: 'y'.repeat(5000), extra: { nested: true } } }),
        ]) });
        const res = await fetchFleet();
        const behavior = rowsOf(res.body).find(r => r.key === 'io.sencho.url')?.behavior;
        expect(behavior?.state).toBe('inert');
        expect(behavior?.reason?.length).toBe(240);
        expect(JSON.stringify(behavior)).not.toContain('nested');
      } finally {
        DatabaseService.getInstance().deleteNode(remoteId);
      }
    });

    it('shows the same status whichever node reports a row first when versions differ', async () => {
      stubDockerList([]);
      const oldId = addRemote('remote-old', 'old.invalid');
      const newId = addRemote('remote-new', 'new2.invalid');
      vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockImplementation((id: number) =>
        id === oldId ? { apiUrl: 'http://old.invalid', apiToken: 't', trustedLoopback: false }
          : id === newId ? { apiUrl: 'http://new2.invalid', apiToken: 't', trustedLoopback: false } : null);
      try {
        respondWith({
          'old.invalid': payload(oldId, [row({})]),
          'new2.invalid': payload(newId, [row({ behavior: { state: 'inert', reason: 'Present only on the running container.' } })]),
        });
        const first = await fetchFleet();
        // Reverse the node order so the newer node is merged first.
        const realGetNodes = DatabaseService.getInstance().getNodes.bind(DatabaseService.getInstance());
        vi.spyOn(DatabaseService.getInstance(), 'getNodes').mockImplementation(() => [...realGetNodes()].reverse());
        const second = await fetchFleet();
        expect(rowsOf(first.body).find(r => r.key === 'io.sencho.url')?.behavior?.state).toBe('inert');
        expect(rowsOf(second.body).find(r => r.key === 'io.sencho.url')?.behavior?.state).toBe('inert');
      } finally {
        DatabaseService.getInstance().deleteNode(oldId);
        DatabaseService.getInstance().deleteNode(newId);
      }
    });
  });
});
