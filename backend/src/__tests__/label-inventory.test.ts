/**
 * Label inventory service, redaction, and GET routes.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';
import { ComposeService } from '../services/ComposeService';
import DockerController from '../services/DockerController';
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

function stubRender(serviceLabels: Record<string, Record<string, string>> | null): void {
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

function stubDockerList(rows: Array<{
  id: string;
  name: string;
  state: string;
  stack: string | null;
  service: string | null;
  labels: Record<string, string>;
  inspectFailed?: boolean;
}>): void {
  vi.spyOn(DockerController, 'getInstance').mockReturnValue({
    listContainersForLabelInventory: vi.fn().mockResolvedValue(rows.map(r => ({
      inspectFailed: false,
      ...r,
    }))),
    getContainersByStack: vi.fn().mockImplementation(async (stack: string) =>
      rows.filter(r => r.stack === stack).map(r => ({
        Id: r.id,
        Names: [`/${r.name}`],
        State: r.state,
        Service: r.service,
      })),
    ),
    inspectContainerLabels: vi.fn().mockImplementation(async (id: string) => {
      const row = rows.find(r => r.id === id);
      return row?.labels ?? {};
    }),
  } as unknown as DockerController);
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  authCookie = await loginAsTestAdmin(app);
  const { DatabaseService } = await import('../services/DatabaseService');
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
  });

  it('redacts secret-like label values by default', async () => {
    stubDockerList([
      {
        id: 'c1',
        name: 'app-1',
        state: 'running',
        stack: 'sec',
        service: 'app',
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

  it('reveals secret-like values when revealSecrets is true', async () => {
    stubDockerList([
      {
        id: 'c1',
        name: 'app-1',
        state: 'running',
        stack: 'sec',
        service: 'app',
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
        labels: {
          'traefik.enable': 'true',
          'runtime.only': '1',
          'com.docker.compose.service': 'web',
        },
      },
    ]);
    const inv = await buildStackLabelInventory(nodeId, 'lbl1');
    expect(inv.renderable).toBe(true);
    const web = inv.services.find(s => s.service === 'web');
    expect(web?.declaredLabels.map(l => l.key)).toEqual(['compose.only', 'traefik.enable']);
    expect(web?.replicas[0].onlyInCompose).toEqual(['compose.only']);
    expect(web?.replicas[0].onlyOnContainer).toContain('runtime.only');
    expect(web?.replicas[0].inBoth).toContain('traefik.enable');
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
});

describe('GET /api/system/container-labels', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/system/container-labels');
    expect(res.status).toBe(401);
  });

  it('returns node inventory', async () => {
    stubDockerList([
      { id: 'c1', name: 'a', state: 'running', stack: 's', service: 'web', labels: { foo: 'bar' } },
    ]);
    const res = await request(app).get('/api/system/container-labels').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body.nodeId).toBe(nodeId);
    expect(res.body.containers).toHaveLength(1);
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
