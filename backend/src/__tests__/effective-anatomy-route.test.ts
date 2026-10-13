/**
 * GET /api/stacks/:stackName/effective-anatomy: returns the merged effective
 * facts, requires stack:read, 404s a missing stack, surfaces a structural (never
 * raw) error on render failure, and never leaks an env or label value.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { ComposeService } from '../services/ComposeService';
import { DatabaseService, type StackGitSource } from '../services/DatabaseService';

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;

const STACK = 'effanat';
const ENV_SECRET = 'env-secret-71bd-value';
const LABEL_SECRET = 'label-secret-22ce-value';

function stubRender(rendered: string | null, stderr = '') {
  vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
    renderConfig: vi.fn().mockResolvedValue({ rendered, stderr, code: rendered === null ? 1 : 0, timedOut: false }),
  } as unknown as ComposeService);
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  authHeader = `Bearer ${jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '5m' })}`;
});

afterAll(() => cleanupTestDb(tmpDir));

describe('effective-anatomy route', () => {
  let stackDir: string;
  beforeEach(() => {
    stackDir = path.join(process.env.COMPOSE_DIR as string, STACK);
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx:latest\n');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(stackDir, { recursive: true, force: true });
  });

  it('returns merged effective facts for a renderable stack', async () => {
    stubRender(JSON.stringify({
      name: STACK,
      services: {
        web: {
          image: 'nginx:latest',
          restart: 'always',
          ports: [{ target: 80, published: '8080', protocol: 'tcp' }],
          volumes: [{ type: 'volume', source: 'data', target: '/data' }],
          networks: { backend: null },
        },
      },
      networks: { backend: {}, default: {} },
      volumes: { data: {} },
    }));
    const res = await request(app).get(`/api/stacks/${STACK}/effective-anatomy`).set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.renderable).toBe(true);
    expect(res.body.services).toEqual(['web']);
    expect(res.body.ports.web).toEqual([{ host: '8080', container: '80', proto: 'tcp', published: true }]);
    expect(res.body.volumes.web).toEqual([{ host: 'data', container: '/data' }]);
    expect(res.body.restart).toBe('always');
    expect(res.body.networks).toEqual(['backend', 'default']);
    // A single-file stack has no other file that could shadow the label.
    expect(res.body.serviceUrlEdit).toEqual({ web: 'root' });
    expect(res.body.serviceUrlClear).toEqual({ web: 'root' });
  });

  it('surfaces a structural error and never raw stderr on render failure', async () => {
    stubRender(null, `error: the "${ENV_SECRET}" variable is not set`);
    const res = await request(app).get(`/api/stacks/${STACK}/effective-anatomy`).set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.renderable).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain(ENV_SECRET);
  });

  it('falls back to a structural error when the render is not valid JSON', async () => {
    stubRender('this is not json {');
    const res = await request(app).get(`/api/stacks/${STACK}/effective-anatomy`).set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.renderable).toBe(false);
    expect(res.body.services).toEqual([]);
  });

  it('never leaks env or label values into the facts', async () => {
    stubRender(JSON.stringify({
      name: STACK,
      services: { web: { image: 'nginx:latest', environment: { TOKEN: ENV_SECRET }, labels: { 'x.secret': LABEL_SECRET } } },
      networks: {},
      volumes: {},
    }));
    const res = await request(app).get(`/api/stacks/${STACK}/effective-anatomy`).set('Authorization', authHeader);
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(ENV_SECRET);
    expect(body).not.toContain(LABEL_SECRET);
  });

  it('returns a validated service URL and still omits every other label value', async () => {
    stubRender(JSON.stringify({
      name: STACK,
      services: {
        web: {
          labels: {
            'sencho.service.url': 'https://app.example.com',
            'x.secret': LABEL_SECRET,
          },
        },
      },
      networks: {},
      volumes: {},
    }));
    const res = await request(app).get(`/api/stacks/${STACK}/effective-anatomy`).set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.serviceUrls).toEqual({ web: 'https://app.example.com' });
    expect(JSON.stringify(res.body)).not.toContain(LABEL_SECRET);
  });

  it('marks a URL label set by another compose file as not editable here', async () => {
    fs.writeFileSync(path.join(stackDir, 'compose.override.yaml'),
      'services:\n  web:\n    labels:\n      sencho.service.url: not-a-url\n');
    stubRender(JSON.stringify({
      services: { web: { labels: { 'sencho.service.url': 'not-a-url' } }, api: { labels: { 'sencho.service.url': 'https://api.example.com' } } },
      networks: {},
      volumes: {},
    }));
    const res = await request(app).get(`/api/stacks/${STACK}/effective-anatomy`).set('Authorization', authHeader);
    expect(res.status).toBe(200);
    // An invalid later label still shadows the main file; a service the override
    // leaves alone stays editable. Either way the clear is refused: the override
    // still supplies (web) or could supply (api is not in it) the label.
    expect(res.body.serviceUrlEdit).toEqual({ web: 'other', api: 'root' });
    expect(res.body.serviceUrlClear).toEqual({ web: 'other', api: 'root' });
  });

  it('keeps services editable when the override leaves the label alone', async () => {
    fs.writeFileSync(path.join(stackDir, 'compose.override.yaml'),
      'services:\n  web:\n    restart: always\n');
    stubRender(JSON.stringify({
      services: { web: { restart: 'always' } },
      networks: {},
      volumes: {},
    }));
    const res = await request(app).get(`/api/stacks/${STACK}/effective-anatomy`).set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.serviceUrlEdit).toEqual({ web: 'root' });
    expect(res.body.serviceUrlClear).toEqual({ web: 'root' });
  });

  it('audit F1: a later bare list label blocks the edit', async () => {
    fs.writeFileSync(path.join(stackDir, 'compose.override.yaml'),
      'services:\n  web:\n    labels:\n      - sencho.service.url\n');
    stubRender(JSON.stringify({
      services: { web: { labels: { 'sencho.service.url': '' } } },
      networks: {},
      volumes: {},
    }));
    const res = await request(app).get(`/api/stacks/${STACK}/effective-anatomy`).set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.serviceUrlEdit).toEqual({ web: 'other' });
    expect(res.body.serviceUrlClear).toEqual({ web: 'other' });
  });

  it('audit F01: an interpolated list-label key in the override refuses the edit and the clear', async () => {
    fs.writeFileSync(path.join(stackDir, 'compose.override.yaml'),
      'services:\n  web:\n    labels:\n      - "${URL_LABEL}=https://later.example.com"\n');
    stubRender(JSON.stringify({
      services: {
        web: { labels: { 'sencho.service.url': 'https://later.example.com' } },
        api: { image: 'nginx:latest' },
      },
      networks: {},
      volumes: {},
    }));
    const res = await request(app).get(`/api/stacks/${STACK}/effective-anatomy`).set('Authorization', authHeader);
    expect(res.status).toBe(200);
    // The service whose key the override could hide is refused; its sibling stays editable.
    expect(res.body.serviceUrlEdit).toEqual({ web: 'unknown', api: 'root' });
    expect(res.body.serviceUrlClear).toEqual({ web: 'unknown', api: 'root' });
  });

  it('audit F01: an interpolated list-label key in the open file refuses the set and the clear', async () => {
    // The audit reproduction: the literal direct label is replaced in place by a
    // set, the interpolated item survives after it, and Compose lets the later
    // item win. Neither operation can be written from this file.
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), [
      'services:',
      '  web:',
      '    labels:',
      '      - sencho.service.url=https://old.example.com',
      '      - "${URL_LABEL}=https://winning.example.com"',
      '  api:',
      '    image: nginx:latest',
      '',
    ].join('\n'));
    stubRender(JSON.stringify({
      services: {
        web: { labels: { 'sencho.service.url': 'https://winning.example.com' } },
        api: { image: 'nginx:latest' },
      },
      networks: {},
      volumes: {},
    }));
    const res = await request(app).get(`/api/stacks/${STACK}/effective-anatomy`).set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.serviceUrlEdit).toEqual({ web: 'unknown', api: 'root' });
    expect(res.body.serviceUrlClear).toEqual({ web: 'unknown', api: 'root' });
  });

  it('refuses editability when the override uses constructs whose labels cannot be traced', async () => {
    fs.writeFileSync(path.join(stackDir, 'compose.override.yaml'),
      'include:\n  - common.yaml\nservices:\n  web:\n    image: nginx\n');
    stubRender(JSON.stringify({ services: { web: { image: 'nginx' } }, networks: {}, volumes: {} }));
    const res = await request(app).get(`/api/stacks/${STACK}/effective-anatomy`).set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.serviceUrlEdit).toEqual({ web: 'unknown' });
    expect(res.body.serviceUrlClear).toEqual({ web: 'unknown' });
  });

  it('audit F2: an earlier Git chain file blocks the clear but not the set', async () => {
    fs.writeFileSync(path.join(stackDir, 'base.yaml'),
      'services:\n  web:\n    labels:\n      sencho.service.url: https://base.example.com\n');
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'),
      'services:\n  web:\n    labels:\n      sencho.service.url: https://root.example.com\n');
    vi.spyOn(DatabaseService.getInstance(), 'getGitSource').mockReturnValue({
      applied_deploy_spec: { files: ['base.yaml', 'compose.yaml'], contextDir: null },
    } as StackGitSource);
    stubRender(JSON.stringify({
      services: { web: { labels: { 'sencho.service.url': 'https://root.example.com' } } },
      networks: {},
      volumes: {},
    }));
    const res = await request(app).get(`/api/stacks/${STACK}/effective-anatomy`).set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.serviceUrlEdit).toEqual({ web: 'root' });
    expect(res.body.serviceUrlClear).toEqual({ web: 'other' });
  });

  it('refuses editability when COMPOSE_FILE changes the file discovery', async () => {
    fs.writeFileSync(path.join(stackDir, '.env'), 'COMPOSE_FILE=compose.yaml:extra.yaml\n');
    stubRender(JSON.stringify({ services: { web: { image: 'nginx' } }, networks: {}, volumes: {} }));
    const res = await request(app).get(`/api/stacks/${STACK}/effective-anatomy`).set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.serviceUrlEdit).toEqual({ web: 'unknown' });
    expect(res.body.serviceUrlClear).toEqual({ web: 'unknown' });
    fs.rmSync(path.join(stackDir, '.env'));
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get(`/api/stacks/${STACK}/effective-anatomy`);
    expect(res.status).toBe(401);
  });

  it('returns 404 for a stack that does not exist', async () => {
    stubRender(JSON.stringify({ name: 'x', services: {}, networks: {}, volumes: {} }));
    const res = await request(app).get('/api/stacks/nope-not-here/effective-anatomy').set('Authorization', authHeader);
    expect(res.status).toBe(404);
  });
});
