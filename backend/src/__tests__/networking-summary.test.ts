/**
 * The per-node networking summary and its routes: a stack that publishes a
 * non-loopback port counts as exposed and, with no intent set, as
 * unknown-exposure; the node-local route and the proxy-exempt fleet aggregate
 * both return it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { format } from 'util';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import DockerController from '../services/DockerController';
import { DatabaseService } from '../services/DatabaseService';
import { NodeRegistry } from '../services/NodeRegistry';
import { ComposeEnvFileError } from '../utils/composeDotenv';

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;

const STACK = 'netsummary';

function stubSnapshot() {
  vi.spyOn(DockerController, 'getInstance').mockReturnValue({
    getDependencySnapshot: vi.fn().mockResolvedValue({ containers: [], networks: [], volumes: [] }),
  } as unknown as DockerController);
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  authHeader = `Bearer ${jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '5m' })}`;
});

afterAll(() => cleanupTestDb(tmpDir));

describe('networking summary', () => {
  let stackDir: string;
  beforeEach(() => {
    stackDir = path.join(process.env.COMPOSE_DIR as string, STACK);
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx:latest\n    ports:\n      - "0.0.0.0:8080:80"\n');
    stubSnapshot();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    DatabaseService.getInstance().deleteStackExposureIntents(1, STACK);
    DatabaseService.getInstance().deleteMeshStack(1, STACK);
    fs.rmSync(stackDir, { recursive: true, force: true });
  });

  it('node-local summary marks a published stack exposed and unknown-exposure', async () => {
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.exposed.stacks).toContain(STACK);
    expect(res.body.unknownExposure.stacks).toContain(STACK);
    expect(res.body.networkDrift.stacks).toEqual([]); // empty snapshot, no running containers
    expect(res.body.exposed.count).toBe(res.body.exposed.stacks.length);
  });

  it('counts a stack reached only through a tunnel connector as exposed until it has an intent', async () => {
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'),
      'services:\n  cloudflared:\n    image: cloudflare/cloudflared:latest\n    command: tunnel run\n    environment:\n      TUNNEL_TOKEN: secret-value\n  app:\n    image: example/app:1\n');
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.body.exposed.stacks).toContain(STACK);
    expect(res.body.unknownExposure.stacks).toContain(STACK);
    expect(JSON.stringify(res.body)).not.toContain('secret-value');

    DatabaseService.getInstance().setStackExposureIntent(1, STACK, '', 'public', null);
    const classified = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(classified.body.exposed.stacks).toContain(STACK);
    expect(classified.body.unknownExposure.stacks).not.toContain(STACK);
  });

  it('counts a Tailscale subnet router only when TS_EXTRA_ARGS advertises routes', async () => {
    const compose = (extraArgs: string) =>
      `services:\n  ts:\n    image: tailscale/tailscale\n    environment:\n      - TS_AUTHKEY=tskey-secret\n      - TS_EXTRA_ARGS=${extraArgs}\n  app:\n    image: example/app:1\n`;
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), compose('--advertise-tags=tag:container'));
    const tagsOnly = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(tagsOnly.body.exposed.stacks).not.toContain(STACK);

    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), compose('--advertise-routes=172.20.0.0/16'));
    const router = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(router.body.exposed.stacks).toContain(STACK);
    expect(JSON.stringify(router.body)).not.toContain('tskey-secret');
  });

  it('does not invent a connector from an inherited image or environment name', async () => {
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'),
      'services:\n  edge:\n    image: registry.example/constructor:1\n    environment:\n      toString: ordinary\n  app:\n    image: example/app:1\n');
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.exposed.stacks).not.toContain(STACK);
    expect(res.body.unknownExposure.stacks).not.toContain(STACK);
    expect(res.body.unreadable.stacks).not.toContain(STACK);
  });

  it('counts a connector whose provider key and flags come from a service env_file', async () => {
    fs.writeFileSync(path.join(stackDir, 'ts.env'), 'TS_AUTHKEY=tskey-secret\nTS_EXTRA_ARGS=--advertise-exit-node\n');
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'),
      'services:\n  ts:\n    image: tailscale/tailscale\n    env_file: ./ts.env\n  app:\n    image: example/app:1\n');
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.body.exposed.stacks).toContain(STACK);
    expect(res.body.unknownExposure.stacks).toContain(STACK);
    expect(res.body.unreadable.stacks).not.toContain(STACK);
    expect(JSON.stringify(res.body)).not.toContain('tskey-secret');
  });

  it('counts a custom image identified by a provider key from an env_file', async () => {
    fs.writeFileSync(path.join(stackDir, 'edge.env'), 'TUNNEL_TOKEN=tunnel-secret\n');
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'),
      'services:\n  edge:\n    image: example/edge:1\n    env_file: ./edge.env\n  app:\n    image: example/app:1\n');
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.body.exposed.stacks).toContain(STACK);
    expect(res.body.unreadable.stacks).not.toContain(STACK);
    expect(JSON.stringify(res.body)).not.toContain('tunnel-secret');
  });

  it('interpolates an image reference from the stack .env before identifying the connector', async () => {
    fs.writeFileSync(path.join(stackDir, '.env'), 'CF_IMAGE=cloudflare/cloudflared:latest\n');
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'),
      'services:\n  cf:\n    image: ${CF_IMAGE}\n    command: tunnel run\n  app:\n    image: example/app:1\n');
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.body.exposed.stacks).toContain(STACK);
    expect(res.body.unreadable.stacks).not.toContain(STACK);
  });

  it('reads every authored layer from the deploy spec, including one that adds the connector', async () => {
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  app:\n    image: example/app:1\n');
    fs.writeFileSync(path.join(stackDir, 'override.yaml'),
      'services:\n  ts:\n    image: tailscale/tailscale\n    environment:\n      TS_AUTHKEY: tskey-secret\n      TS_EXTRA_ARGS: --advertise-routes=10.0.0.0/24\n');
    const db = DatabaseService.getInstance();
    vi.spyOn(db, 'getGitSource').mockReturnValue({
      applied_deploy_spec: { files: ['compose.yaml', 'override.yaml'], contextDir: null },
    } as ReturnType<DatabaseService['getGitSource']>);
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.body.exposed.stacks).toContain(STACK);
    expect(res.body.unreadable.stacks).not.toContain(STACK);
    expect(JSON.stringify(res.body)).not.toContain('tskey-secret');
  });

  it('reads COMPOSE_FILE layers, including one that adds the connector', async () => {
    fs.writeFileSync(path.join(stackDir, 'base.yaml'), 'services:\n  app:\n    image: example/app:1\n');
    fs.writeFileSync(path.join(stackDir, 'extra.yaml'),
      'services:\n  cf:\n    image: cloudflare/cloudflared\n    command: tunnel run\n');
    fs.writeFileSync(path.join(stackDir, '.env'), 'COMPOSE_FILE=base.yaml:extra.yaml\n');
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.body.exposed.stacks).toContain(STACK);
    expect(res.body.unreadable.stacks).not.toContain(STACK);
  });

  it('reports a stack as unreadable, not unexposed, when a required env_file is missing', async () => {
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'),
      'services:\n  ts:\n    image: tailscale/tailscale\n    env_file: ./missing.env\n  app:\n    image: example/app:1\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.unreadable.stacks).toContain(STACK);
    expect(res.body.exposed.stacks).not.toContain(STACK);
    expect(warn.mock.calls.map(args => format(...args)).join('\n')).not.toContain('missing.env');
  });

  it('tolerates a missing optional env_file and still reads the rest', async () => {
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'),
      'services:\n  edge:\n    image: cloudflare/cloudflared\n    env_file:\n      - path: ./missing.env\n        required: false\n    environment:\n      TUNNEL_TOKEN: tunnel-secret\n  app:\n    image: example/app:1\n');
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.body.exposed.stacks).toContain(STACK);
    expect(res.body.unreadable.stacks).not.toContain(STACK);
  });

  it('reports a stack as unreadable, not unexposed, when COMPOSE_FILE cannot be read', async () => {
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  app:\n    image: example/app:1\n');
    fs.writeFileSync(path.join(stackDir, '.env'), 'COMPOSE_FILE=missing-layer.yaml\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.unreadable.stacks).toContain(STACK);
    expect(res.body.exposed.stacks).not.toContain(STACK);
    expect(warn.mock.calls.map(args => format(...args)).join('\n')).not.toContain('missing-layer.yaml');
  });

  it('reports a stack with include or extends as unreadable rather than unexposed', async () => {
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'),
      'include:\n  - other.yaml\nservices:\n  app:\n    image: example/app:1\n');
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.unreadable.stacks).toContain(STACK);
    expect(res.body.exposed.stacks).not.toContain(STACK);
  });

  it('reads an interpolated TS_EXTRA_ARGS from the stack .env, as the rendered views do', async () => {
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'),
      'services:\n  ts:\n    image: tailscale/tailscale\n    environment:\n      TS_AUTHKEY: tskey-secret\n      TS_EXTRA_ARGS: ${TS_ARGS:-}\n  app:\n    image: example/app:1\n');
    // Unset: Compose renders an empty value, so the node exposes only itself.
    const unset = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(unset.body.exposed.stacks).not.toContain(STACK);

    fs.writeFileSync(path.join(stackDir, '.env'), 'TS_ARGS=--accept-dns=false\n');
    const quiet = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(quiet.body.exposed.stacks).not.toContain(STACK);

    fs.writeFileSync(path.join(stackDir, '.env'), 'TS_ARGS=--advertise-routes=10.0.0.0/24\n');
    const router = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(router.body.exposed.stacks).toContain(STACK);
    expect(JSON.stringify(router.body)).not.toContain('10.0.0.0');

    // An env file Compose would refuse leaves the value unresolved, counted as
    // forwarding, and says so in the log without any value from the file.
    fs.writeFileSync(path.join(stackDir, '.env'), 'COMPOSE_DISABLE_ENV_FILE=maybe\nTS_ARGS=--advertise-routes=10.9.0.0/24\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unreadable = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(unreadable.body.exposed.stacks).toContain(STACK);
    const logged = warn.mock.calls.map(args => format(...args)).join('\n');
    expect(logged).toContain(`Stack ${STACK} env files cannot be read the way Compose reads them`);
    expect(logged).not.toContain('10.9.0.0');
  });

  it('does not read the values of a stack .env that disables itself', async () => {
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'),
      'services:\n  ts:\n    image: tailscale/tailscale\n    environment:\n      TS_AUTHKEY: tskey-secret\n      TS_EXTRA_ARGS: ${TS_ARGS:---advertise-exit-node}\n  app:\n    image: example/app:1\n');
    // Compose leaves TS_ARGS unset, so its default forwards. Sencho has no lookup
    // here and counts the value as unresolved, which gives the same answer.
    fs.writeFileSync(path.join(stackDir, '.env'), 'COMPOSE_DISABLE_ENV_FILE=true\nTS_ARGS=--accept-dns=false\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.body.exposed.stacks).toContain(STACK);
    // An ordinary configuration, not a warning.
    expect(warn.mock.calls.map(args => format(...args)).filter(line => line.includes('[NetworkingSummary]'))).toEqual([]);
  });

  it('names a refused deploy spec or env-file selection in the log and never logs an env-file value', async () => {
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'),
      'services:\n  ts:\n    image: tailscale/tailscale\n    environment:\n      TS_AUTHKEY: tskey-secret\n      TS_EXTRA_ARGS: ${TS_ARGS}\n  app:\n    image: example/app:1\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = DatabaseService.getInstance();
    const gitSource = vi.spyOn(db, 'getGitSource');
    const selection = vi.spyOn(db, 'getStackProjectEnvFiles');

    // A context directory a deploy refuses: the env files read fine, so the cause is the spec.
    gitSource.mockReturnValue({ applied_deploy_spec: { files: ['compose.yaml'], contextDir: '../outside' } } as ReturnType<DatabaseService['getGitSource']>);
    const refusedSpec = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(refusedSpec.body.exposed.stacks).toContain(STACK);
    const specLog = warn.mock.calls.map(args => format(...args)).join('\n');
    expect(specLog).toContain(`Stack ${STACK} interpolation failed; tunnel inputs left unresolved: Error: Invalid context directory in deploy spec`);
    expect(specLog).not.toContain('env files cannot be read');

    // A selection read that fails keeps its own cause instead of blaming env files.
    warn.mockClear();
    gitSource.mockReturnValue(undefined);
    selection.mockImplementation(() => { throw new Error('SQLITE_BUSY: database is locked'); });
    const refusedSelection = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(refusedSelection.body.exposed.stacks).toContain(STACK);
    const selectionLog = warn.mock.calls.map(args => format(...args)).join('\n');
    expect(selectionLog).toContain(`Stack ${STACK} interpolation failed; tunnel inputs left unresolved: Error: SQLITE_BUSY: database is locked`);
    expect(selectionLog).not.toContain('env files cannot be read');

    // An env-file error message can hold an interpolated value, so only its class name is logged.
    warn.mockClear();
    selection.mockReturnValue([]);
    gitSource.mockImplementation(() => { throw new ComposeEnvFileError('required variable A is missing a value: hunter2-value'); });
    const failedRead = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(failedRead.body.exposed.stacks).toContain(STACK);
    const readLog = warn.mock.calls.map(args => format(...args)).join('\n');
    expect(readLog).toContain('tunnel inputs left unresolved: ComposeEnvFileError');
    expect(readLog).not.toContain('hunter2-value');
  });

  it('does not count a cloudflared DNS proxy as exposure', async () => {
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'),
      'services:\n  dns:\n    image: cloudflare/cloudflared:latest\n    command: proxy-dns\n  pihole:\n    image: pihole/pihole\n');
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.body.exposed.stacks).not.toContain(STACK);
  });

  it('flags a stack with an undeclared runtime network as network drift', async () => {
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      getDependencySnapshot: vi.fn().mockResolvedValue({
        containers: [{ id: 'c1', name: 'web1', service: 'web', composeProject: STACK, stack: STACK, state: 'running', exitCode: null, image: 'nginx', networks: [{ name: `${STACK}_default`, id: 'd', ip: '' }, { name: `${STACK}_rogue`, id: 'r', ip: '' }], volumes: [], ports: [] }],
        networks: [
          { id: 'd', name: `${STACK}_default`, driver: 'bridge', scope: 'local', isSystem: false, composeProject: STACK, stack: STACK },
          { id: 'r', name: `${STACK}_rogue`, driver: 'bridge', scope: 'local', isSystem: false, composeProject: STACK, stack: STACK },
        ],
        volumes: [],
      }),
    } as unknown as DockerController);
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.body.networkDrift.stacks).toContain(STACK);
  });

  it('does not count an opted-in Mesh attachment as network drift', async () => {
    DatabaseService.getInstance().insertMeshStack(1, STACK, 'tester');
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      getDependencySnapshot: vi.fn().mockResolvedValue({
        containers: [{ id: 'c1', name: 'web1', service: 'web', composeProject: STACK, stack: STACK, state: 'running', exitCode: null, image: 'nginx', networks: [{ name: 'sencho_mesh', id: 'm', ip: '' }], volumes: [], ports: [] }],
        networks: [
          { id: 'm', name: 'sencho_mesh', driver: 'bridge', scope: 'local', isSystem: false, composeProject: null, stack: null },
        ],
        volumes: [],
      }),
    } as unknown as DockerController);

    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body.networkDrift).toEqual({ count: 0, stacks: [] });
  });

  it('counts an opted-out manual Mesh attachment as network drift', async () => {
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      getDependencySnapshot: vi.fn().mockResolvedValue({
        containers: [{ id: 'c1', name: 'web1', service: 'web', composeProject: STACK, stack: STACK, state: 'running', exitCode: null, image: 'nginx', networks: [{ name: 'sencho_mesh', id: 'm', ip: '' }], volumes: [], ports: [] }],
        networks: [
          { id: 'm', name: 'sencho_mesh', driver: 'bridge', scope: 'local', isSystem: false, composeProject: null, stack: null },
        ],
        volumes: [],
      }),
    } as unknown as DockerController);

    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body.networkDrift).toEqual({ count: 1, stacks: [STACK] });
  });

  it('still reports declared signals when the snapshot is unavailable (drift skipped)', async () => {
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      getDependencySnapshot: vi.fn().mockRejectedValue(new Error('docker down')),
    } as unknown as DockerController);
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.exposed.stacks).toContain(STACK);
    expect(res.body.networkDrift.stacks).toEqual([]);
  });

  it('summarizes a stack whose compose file links into a sibling stack', async () => {
    const linked = `${STACK}-linked`;
    const linkedDir = path.join(process.env.COMPOSE_DIR as string, linked);
    fs.mkdirSync(linkedDir, { recursive: true });
    fs.symlinkSync(path.join(stackDir, 'compose.yaml'), path.join(linkedDir, 'compose.yaml'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
      expect(res.status).toBe(200);
      // The link stays inside the compose root, so this stack deploys the shared
      // file and its declared exposure belongs in the report.
      expect(res.body.exposed.stacks).toContain(STACK);
      expect(res.body.exposed.stacks).toContain(linked);
      expect(res.body.unknownExposure.stacks).toContain(linked);
      expect(warn.mock.calls.filter(call => String(call[0]).includes('reported unreadable'))).toEqual([]);
    } finally {
      fs.rmSync(linkedDir, { recursive: true, force: true });
    }
  });

  it('skips a stack whose compose file links out of the compose directory', async () => {
    const linked = `${STACK}-outside`;
    const linkedDir = path.join(process.env.COMPOSE_DIR as string, linked);
    fs.mkdirSync(linkedDir, { recursive: true });
    const outside = path.join(tmpDir, 'outside-compose.yaml');
    fs.writeFileSync(outside, fs.readFileSync(path.join(stackDir, 'compose.yaml'), 'utf8'));
    fs.symlinkSync(outside, path.join(linkedDir, 'compose.yaml'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
      expect(res.status).toBe(200);
      expect(res.body.exposed.stacks).not.toContain(linked);
      expect(res.body.unknownExposure.stacks).not.toContain(linked);
      expect(res.body.unreadable.stacks).toContain(linked);
      const skipped = warn.mock.calls.find(call => call[1] === linked);
      expect(skipped?.[0]).toContain('reported unreadable');
    } finally {
      fs.rmSync(linkedDir, { recursive: true, force: true });
    }
  });

  it('drops the stack from unknown-exposure once an intent is set', async () => {
    DatabaseService.getInstance().setStackExposureIntent(1, STACK, '', 'public', 'admin');
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.body.exposed.stacks).toContain(STACK);
    expect(res.body.unknownExposure.stacks).not.toContain(STACK);
  });

  it('a service-level intent on the only publishing service drops it from unknown-exposure', async () => {
    // No stack-level row; classifying the publishing service is enough.
    DatabaseService.getInstance().setStackExposureIntent(1, STACK, 'web', 'public', 'admin');
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.body.unknownExposure.stacks).not.toContain(STACK);
  });

  it('keeps the stack unknown when only some publishing services are classified', async () => {
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'),
      'services:\n  web:\n    image: nginx:latest\n    ports:\n      - "8080:80"\n  api:\n    image: nginx:latest\n    ports:\n      - "9090:90"\n');
    // web classified, api still unset, so the stack remains effectively unknown.
    DatabaseService.getInstance().setStackExposureIntent(1, STACK, 'web', 'public', 'admin');
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.body.unknownExposure.stacks).toContain(STACK);
  });

  it('marks a host-network stack exposed and unknown-exposure even with no published ports', async () => {
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  app:\n    image: nginx:latest\n    network_mode: host\n');
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.exposed.stacks).toContain(STACK);
    expect(res.body.unknownExposure.stacks).toContain(STACK);
  });

  it('drops a host-network stack from unknown-exposure once an intent is set', async () => {
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  app:\n    image: nginx:latest\n    network_mode: host\n');
    DatabaseService.getInstance().setStackExposureIntent(1, STACK, '', 'lan', 'admin');
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.body.exposed.stacks).toContain(STACK);
    expect(res.body.unknownExposure.stacks).not.toContain(STACK);
  });

  it('keeps a stack unknown when an unclassified host-network service sits beside a classified ports service', async () => {
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'),
      'services:\n  metrics:\n    image: nginx:latest\n    network_mode: host\n  web:\n    image: nginx:latest\n    ports:\n      - "8080:80"\n');
    // web classified, the host-network metrics service still unset, so the stack stays unknown.
    DatabaseService.getInstance().setStackExposureIntent(1, STACK, 'web', 'public', 'admin');
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.body.exposed.stacks).toContain(STACK);
    expect(res.body.unknownExposure.stacks).toContain(STACK);
  });

  it('does not treat a non-host network_mode (none) as exposed', async () => {
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  app:\n    image: nginx:latest\n    network_mode: none\n');
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.body.exposed.stacks).not.toContain(STACK);
    expect(res.body.unknownExposure.stacks).not.toContain(STACK);
  });

  it('the fleet aggregate counts a host-network stack as exposed', async () => {
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  app:\n    image: nginx:latest\n    network_mode: host\n');
    const res = await request(app).get('/api/fleet/networking-summary').set('Authorization', authHeader);
    expect(res.status).toBe(200);
    const local = res.body.nodes.find((n: { summary: { exposed: { stacks: string[] } } | null }) => n.summary?.exposed.stacks.includes(STACK));
    expect(local).toBeDefined();
  });

  it('the fleet aggregate returns a per-node summary for the hub', async () => {
    const res = await request(app).get('/api/fleet/networking-summary').set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.nodes)).toBe(true);
    const local = res.body.nodes.find((n: { status: string; summary: { exposed: { stacks: string[] } } | null }) => n.summary?.exposed.stacks.includes(STACK));
    expect(local).toBeDefined();
    expect(local.status).toBe('ok');
    expect(local.summary.unknownExposure).toBeDefined();
    expect(local.summary.networkDrift).toBeDefined();
  });

  it('degrades a remote that errors to a node-error while keeping the hub', async () => {
    const db = DatabaseService.getInstance();
    const remoteId = db.addNode({ name: 'remote-degrade', type: 'remote', compose_dir: '/app/compose', is_default: false, api_url: 'http://remote.invalid', api_token: 't' });
    vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockImplementation((id: number) => id === remoteId ? { apiUrl: 'http://remote.invalid', apiToken: 't', trustedLoopback: false } : null);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not found', { status: 404 }));
    try {
      const res = await request(app).get('/api/fleet/networking-summary').set('Authorization', authHeader);
      expect(res.status).toBe(200);
      const hub = res.body.nodes.find((n: { summary: unknown }) => n.summary !== null);
      const remote = res.body.nodes.find((n: { nodeId: number }) => n.nodeId === remoteId);
      expect(hub.status).toBe('ok');
      expect(remote.status).toBe('error');
      expect(remote.summary).toBeNull();
    } finally {
      db.deleteNode(remoteId);
    }
  });

  it('expands a TS_EXTRA_ARGS template inside a service env_file from the stack .env', async () => {
    fs.writeFileSync(path.join(stackDir, '.env'), 'TS_ARGS=--advertise-exit-node\n');
    fs.writeFileSync(path.join(stackDir, 'ts.env'), 'TS_AUTHKEY=tskey-secret\nTS_EXTRA_ARGS=${TS_ARGS}\n');
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'),
      'services:\n  ts:\n    image: tailscale/tailscale\n    env_file: ./ts.env\n  app:\n    image: example/app:1\n');
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.body.exposed.stacks).toContain(STACK);
    expect(res.body.unreadable.stacks).not.toContain(STACK);
    expect(JSON.stringify(res.body)).not.toContain('tskey-secret');
  });

  it('reports a resolver-present but still unresolved long-form port as unreadable', async () => {
    fs.writeFileSync(path.join(stackDir, '.env'), 'OTHER=1\n');
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'),
      'services:\n  web:\n    image: nginx:latest\n    ports:\n      - target: 80\n        published: ${WEB_PORT:?required}\n        host_ip: 0.0.0.0\n');
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.body.unreadable.stacks).toContain(STACK);
    expect(res.body.exposed.stacks).not.toContain(STACK);
  });

  it('gives a service env_file assignment precedence over the project environment value', async () => {
    fs.writeFileSync(path.join(stackDir, '.env'), 'TS_EXTRA_ARGS=--accept-dns=false\n');
    fs.writeFileSync(path.join(stackDir, 'ts.env'), 'TS_AUTHKEY=tskey-secret\nTS_EXTRA_ARGS=--advertise-exit-node\n');
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'),
      'services:\n  ts:\n    image: tailscale/tailscale\n    env_file: ./ts.env\n  app:\n    image: example/app:1\n');
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.body.exposed.stacks).toContain(STACK);
    expect(res.body.unreadable.stacks).not.toContain(STACK);
  });

  it('does not read a project environment TS_EXTRA_ARGS as the container value', async () => {
    fs.writeFileSync(path.join(stackDir, '.env'), 'TS_EXTRA_ARGS=--advertise-exit-node\n');
    fs.writeFileSync(path.join(stackDir, 'ts.env'), 'TS_AUTHKEY=tskey-secret\nTS_EXTRA_ARGS=--accept-dns=false\n');
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'),
      'services:\n  ts:\n    image: tailscale/tailscale\n    env_file: ./ts.env\n  app:\n    image: example/app:1\n');
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.body.exposed.stacks).not.toContain(STACK);
  });

  it('interpolates a long-form published port from the stack .env', async () => {
    fs.writeFileSync(path.join(stackDir, '.env'), 'WEB_PORT=8080\n');
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'),
      'services:\n  web:\n    image: nginx:latest\n    ports:\n      - target: 80\n        published: ${WEB_PORT}\n        host_ip: 0.0.0.0\n        protocol: tcp\n');
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.body.exposed.stacks).toContain(STACK);
    expect(res.body.unknownExposure.stacks).toContain(STACK);
    expect(res.body.unreadable.stacks).not.toContain(STACK);
  });

  it('loads the first auto-discovered override even when its name uses the other base family', async () => {
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  app:\n    image: example/app:1\n');
    fs.writeFileSync(path.join(stackDir, 'docker-compose.override.yml'),
      'services:\n  cf:\n    image: cloudflare/cloudflared\n    command: tunnel run\n');
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.body.exposed.stacks).toContain(STACK);
    expect(res.body.unreadable.stacks).not.toContain(STACK);
  });

  it('loads only the first of two auto-discovered overrides, as Compose does', async () => {
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  app:\n    image: example/app:1\n');
    fs.writeFileSync(path.join(stackDir, 'compose.override.yml'),
      'services:\n  cf:\n    image: cloudflare/cloudflared\n    command: tunnel run\n');
    fs.writeFileSync(path.join(stackDir, 'compose.override.yaml'),
      'services:\n  cf:\n    image: nginx:latest\n');
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.body.exposed.stacks).toContain(STACK);
    expect(res.body.unreadable.stacks).not.toContain(STACK);
  });

  it('merges a services-free authored layer instead of skipping the stack', async () => {
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'),
      'services:\n  web:\n    image: nginx:latest\n    ports:\n      - "0.0.0.0:8080:80"\n');
    fs.writeFileSync(path.join(stackDir, 'networks.yaml'), 'networks:\n  edge:\n    name: project_edge\n');
    const db = DatabaseService.getInstance();
    vi.spyOn(db, 'getGitSource').mockReturnValue({
      applied_deploy_spec: { files: ['compose.yaml', 'networks.yaml'], contextDir: null },
    } as ReturnType<DatabaseService['getGitSource']>);
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.body.exposed.stacks).toContain(STACK);
    expect(res.body.unreadable.stacks).not.toContain(STACK);
  });

  it('reports a stack whose compose file does not parse as unreadable', async () => {
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services: [\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.unreadable.stacks).toContain(STACK);
    expect(res.body.exposed.stacks).not.toContain(STACK);
    expect(warn.mock.calls.map(args => format(...args)).join('\n')).toContain('does not parse');
  });

  it('reports a stack that uses extends as unreadable', async () => {
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'),
      'services:\n  app:\n    image: example/app:1\n    extends:\n      file: base.yaml\n      service: base\n');
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.body.unreadable.stacks).toContain(STACK);
  });

  it('reports an env_file with syntax the Compose reader cannot follow as unreadable', async () => {
    fs.writeFileSync(path.join(stackDir, 'ts.env'), 'TS_AUTHKEY="unterminated\n');
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'),
      'services:\n  ts:\n    image: tailscale/tailscale\n    env_file: ./ts.env\n  app:\n    image: example/app:1\n');
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.body.unreadable.stacks).toContain(STACK);
  });

  it('reports a required long-form port template as unreadable when the lookup is available but the value is not', async () => {
    fs.writeFileSync(path.join(stackDir, '.env'), 'OTHER=1\n');
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'),
      'services:\n  web:\n    image: nginx:latest\n    ports:\n      - target: 80\n        published: ${WEB_PORT:?required}\n        host_ip: 0.0.0.0\n');
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.body.unreadable.stacks).toContain(STACK);
    expect(res.body.exposed.stacks).not.toContain(STACK);
  });

  it('reports an unresolved detection field as unreadable when the interpolation lookup is unavailable', async () => {
    fs.writeFileSync(path.join(stackDir, '.env'), 'COMPOSE_DISABLE_ENV_FILE=true\n');
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'),
      'services:\n  cf:\n    image: ${CF_IMAGE}\n  app:\n    image: example/app:1\n');
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.body.unreadable.stacks).toContain(STACK);
    expect(res.body.exposed.stacks).not.toContain(STACK);
  });

  it('resolves a YAML merge key before looking for a connector', async () => {
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), [
      'x-cf: &cf',
      '  image: cloudflare/cloudflared:latest',
      '  command: tunnel run',
      '  environment:',
      '    - TUNNEL_TOKEN=tunnel-secret',
      'services:',
      '  tun:',
      '    <<: *cf',
      '  app:',
      '    image: example/app:1',
      '    network_mode: service:tun',
      '',
    ].join('\n'));
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.body.exposed.stacks).toContain(STACK);
    expect(res.body.unreadable.stacks).not.toContain(STACK);
    expect(JSON.stringify(res.body)).not.toContain('tunnel-secret');
  });

  it('reports a layer that uses !reset or !override as unreadable rather than unexposed', async () => {
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'),
      'services:\n  edge:\n    image: example/edge:1\n    network_mode: none\n  app:\n    image: example/app:1\n');
    fs.writeFileSync(path.join(stackDir, 'compose.override.yaml'),
      'services:\n  edge:\n    image: cloudflare/cloudflared:latest\n    network_mode: !reset null\n');
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.body.unreadable.stacks).toContain(STACK);
  });

  it('reads the mount target of a volume whose source is a template, and claims no absence when it cannot', async () => {
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'),
      'services:\n  edge:\n    image: example/edge:1\n    volumes:\n      - ${CF_DIR:-./cf}:/etc/cloudflared\n  app:\n    image: example/app:1\n');
    const readable = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(readable.body.unreadable.stacks).not.toContain(STACK);

    fs.writeFileSync(path.join(stackDir, '.env'), 'COMPOSE_DISABLE_ENV_FILE=true\n');
    const opaque = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(opaque.body.unreadable.stacks).toContain(STACK);
    expect(opaque.body.exposed.stacks).not.toContain(STACK);
  });

  it('does not mistake a $$ escape for an unresolved template', async () => {
    fs.writeFileSync(path.join(stackDir, '.env'), 'IMG=example/app:1\n');
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'),
      'services:\n  app:\n    image: ${IMG}\n    command: ["sh", "-c", "exec app --home $$HOME"]\n');
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.body.unreadable.stacks).not.toContain(STACK);
    expect(res.body.exposed.stacks).not.toContain(STACK);
  });

  it('reports a stack as unreadable, with its cause logged, when the deploy spec cannot be read', async () => {
    const db = DatabaseService.getInstance();
    vi.spyOn(db, 'getGitSource').mockImplementation(() => { throw new Error('database is locked'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.body.unreadable.stacks).toContain(STACK);
    expect(warn.mock.calls.some(call => format(...call).includes('deploy spec') && format(...call).includes(STACK))).toBe(true);
  });

  it('reports a stack as unreadable when the auto-discovered override cannot be read', async () => {
    const override = path.join(stackDir, 'compose.override.yaml');
    fs.writeFileSync(override, 'services:\n  ts:\n    image: tailscale/tailscale\n');
    fs.chmodSync(override, 0o000);
    try {
      if (process.getuid?.() === 0) return;
      const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
      expect(res.body.unreadable.stacks).toContain(STACK);
    } finally {
      fs.chmodSync(override, 0o644);
    }
  });

  it('reports a stack as unreadable when an optional env_file exists but cannot be read', async () => {
    const envFile = path.join(stackDir, 'ts.env');
    fs.writeFileSync(envFile, 'TS_AUTHKEY=tskey-secret\n');
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'),
      'services:\n  ts:\n    image: tailscale/tailscale\n    env_file:\n      - path: ./ts.env\n        required: false\n  app:\n    image: example/app:1\n');
    fs.chmodSync(envFile, 0o000);
    try {
      if (process.getuid?.() === 0) return;
      const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
      expect(res.body.unreadable.stacks).toContain(STACK);
    } finally {
      fs.chmodSync(envFile, 0o644);
    }
  });

  it('reports a stack as unreadable when the COMPOSE_FILE selection cannot be decided', async () => {
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  app:\n    image: example/app:1\n');
    fs.writeFileSync(path.join(stackDir, '.env'), 'NOT A VALID LINE\nCOMPOSE_FILE=extra.yaml\n');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.body.unreadable.stacks).toContain(STACK);
    expect(res.body.exposed.stacks).not.toContain(STACK);
  });

  it('reports a stack as unreadable when a deploy spec layer cannot be read', async () => {
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  app:\n    image: example/app:1\n');
    vi.spyOn(DatabaseService.getInstance(), 'getGitSource').mockReturnValue({
      applied_deploy_spec: { files: ['compose.yaml', 'missing.yaml'], contextDir: null },
    } as ReturnType<DatabaseService['getGitSource']>);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.body.unreadable.stacks).toContain(STACK);
  });

  it('reports a service env_file path that stays a template as unreadable', async () => {
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'),
      'services:\n  ts:\n    image: tailscale/tailscale\n    env_file: ./${ENV_DIR}/ts.env\n  app:\n    image: example/app:1\n');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.body.unreadable.stacks).toContain(STACK);
  });

  it('lets a service environment TS_EXTRA_ARGS override the value in its env_file', async () => {
    fs.writeFileSync(path.join(stackDir, 'ts.env'), 'TS_EXTRA_ARGS=--advertise-routes=10.0.0.0/24\n');
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'),
      'services:\n  ts:\n    image: tailscale/tailscale\n    env_file: ./ts.env\n    environment:\n      TS_AUTHKEY: tskey-secret\n      TS_EXTRA_ARGS: --accept-dns=false\n  app:\n    image: example/app:1\n');
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.body.exposed.stacks).not.toContain(STACK);
    expect(res.body.unreadable.stacks).not.toContain(STACK);
  });

  it('reports a template in an env_file as unreadable when the interpolation lookup is unavailable', async () => {
    fs.writeFileSync(path.join(stackDir, '.env'), 'COMPOSE_DISABLE_ENV_FILE=true\n');
    fs.writeFileSync(path.join(stackDir, 'ts.env'), 'TS_AUTHKEY=tskey-secret\nTS_EXTRA_ARGS=${ARGS}\n');
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'),
      'services:\n  ts:\n    image: tailscale/tailscale\n    env_file: ./ts.env\n  app:\n    image: example/app:1\n');
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.body.unreadable.stacks).toContain(STACK);
  });

  it.each([
    ['an exported template', 'export TS_EXTRA_ARGS=--advertise-routes=$ROUTES\n'],
    ['a bare inherited name', 'TS_EXTRA_ARGS\n'],
    ['an exported bare inherited name', 'export TS_EXTRA_ARGS\n'],
  ])('reports %s in an env_file as unreadable when the interpolation lookup is unavailable', async (_label, line) => {
    fs.writeFileSync(path.join(stackDir, '.env'), 'COMPOSE_DISABLE_ENV_FILE=true\n');
    fs.writeFileSync(path.join(stackDir, 'ts.env'), `TS_AUTHKEY=tskey-secret\n${line}`);
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'),
      'services:\n  ts:\n    image: tailscale/tailscale\n    env_file: ./ts.env\n  app:\n    image: example/app:1\n');
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.body.unreadable.stacks).toContain(STACK);
  });

  describe('effective environment assignments', () => {
    const ts = (service: string) => `services:\n  ts:\n    image: tailscale/tailscale\n${service}  app:\n    image: example/app:1\n`;
    const edge = (service: string) => `services:\n  edge:\n    image: example/edge:1\n${service}  app:\n    image: example/app:1\n`;
    const WG = (port: string) => `services:\n  wg:\n    image: lscr.io/linuxserver/wireguard:latest\n    ports:\n      - ${port}\n  app:\n    image: example/app:1\n`;

    // Each case states what `docker compose config` renders for the same files
    // (see the Docker-backed parity cases) and what the summary must report.
    it.each<[string, Record<string, string>, boolean]>([
      ['a long-form protocol the project environment answers', { 'compose.yaml': WG('{ target: 51820, published: 51820, host_ip: 127.0.0.1, protocol: "${PROTO}" }'), '.env': 'PROTO=udp\n' }, true],
      ['a long-form protocol that resolves to tcp', { 'compose.yaml': WG('{ target: 51820, published: 51820, host_ip: 127.0.0.1, protocol: "${PROTO}" }'), '.env': 'PROTO=tcp\n' }, false],
      ['an upper-case long-form protocol', { 'compose.yaml': WG('{ target: 51820, published: 51820, host_ip: 127.0.0.1, protocol: UDP }') }, true],
      ['a short-form protocol the project environment answers', { 'compose.yaml': WG('"127.0.0.1:51820:51820/${PROTO}"'), '.env': 'PROTO=udp\n' }, true],
      ['a required reference to an earlier assignment in the same env_file', { 'compose.yaml': ts('    env_file: ./ts.env\n'), 'ts.env': 'TS_AUTHKEY=k\nARGS=--advertise-exit-node\nTS_EXTRA_ARGS=${ARGS:?set ARGS}\n' }, true],
      ['a required reference the project environment answers', { 'compose.yaml': ts('    env_file: ./ts.env\n'), 'ts.env': 'TS_AUTHKEY=k\nTS_EXTRA_ARGS=${ARGS:?set ARGS}\n', '.env': 'ARGS=--advertise-routes=10.0.0.0/8\n' }, true],
      ['a bare env_file key with nothing to inherit', { 'compose.yaml': edge('    env_file: ./edge.env\n'), 'edge.env': 'TUNNEL_TOKEN\n' }, false],
      ['a bare env_file key the project environment answers', { 'compose.yaml': edge('    env_file: ./edge.env\n'), 'edge.env': 'TUNNEL_TOKEN\n', '.env': 'TUNNEL_TOKEN=t\n' }, true],
      ['a quoted flag in a raw env_file', { 'compose.yaml': ts('    env_file:\n      - path: ./ts.env\n        format: raw\n'), 'ts.env': "TS_AUTHKEY=k\nTS_EXTRA_ARGS='--advertise-exit-node'\n" }, false],
      ['an unquoted flag in a raw env_file', { 'compose.yaml': ts('    env_file:\n      - path: ./ts.env\n        format: raw\n'), 'ts.env': 'TS_AUTHKEY=k\nTS_EXTRA_ARGS=--advertise-exit-node\n' }, true],
      ['a null environment key over an env_file provider key', { 'compose.yaml': edge('    env_file: ./edge.env\n    environment:\n      TUNNEL_TOKEN:\n'), 'edge.env': 'TUNNEL_TOKEN=t\n' }, false],
      ['a null environment key over an env_file forwarding key', { 'compose.yaml': ts('    env_file: ./ts.env\n    environment:\n      TS_ROUTES: ~\n'), 'ts.env': 'TS_AUTHKEY=k\nTS_ROUTES=10.0.0.0/8\n' }, false],
      ['a list-form key with no value that nothing answers', { 'compose.yaml': edge('    environment:\n      - TUNNEL_TOKEN\n') }, false],
      ['a list-form key with no value that the project environment answers', { 'compose.yaml': edge('    environment:\n      - TUNNEL_TOKEN\n'), '.env': 'TUNNEL_TOKEN=t\n' }, true],
      ['a null TS_EXTRA_ARGS over an env_file value', { 'compose.yaml': ts('    env_file: ./ts.env\n    environment:\n      TS_EXTRA_ARGS:\n'), 'ts.env': 'TS_AUTHKEY=k\nTS_EXTRA_ARGS=--advertise-exit-node\n' }, false],
      ['a later boolean flag between repeated forwarding flags', { 'compose.yaml': ts('    environment:\n      TS_AUTHKEY: k\n      TS_EXTRA_ARGS: --advertise-exit-node=true --accept-dns --advertise-exit-node=false\n') }, false],
      ['a later boolean flag between repeated flags in an env_file', { 'compose.yaml': ts('    env_file: ./ts.env\n'), 'ts.env': 'TS_AUTHKEY=k\nTS_EXTRA_ARGS=--advertise-routes=10.0.0.0/8 --accept-routes --advertise-routes=\n' }, false],
    ])('%s', async (_label, files, exposed) => {
      for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(stackDir, file), content);
      const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
      expect(res.body.unreadable.stacks).not.toContain(STACK);
      if (exposed) {
        expect(res.body.exposed.stacks).toContain(STACK);
        expect(res.body.unknownExposure.stacks).toContain(STACK);
      } else {
        expect(res.body.exposed.stacks).not.toContain(STACK);
      }
    });

    it('lets a later layer unset a key an earlier layer set, and set one it left unset', async () => {
      fs.writeFileSync(path.join(stackDir, 'override.yaml'), 'services:\n  edge:\n    environment:\n      TUNNEL_TOKEN:\n');
      fs.writeFileSync(path.join(stackDir, 'compose.yaml'), edge('    environment:\n      TUNNEL_TOKEN: t\n'));
      fs.writeFileSync(path.join(stackDir, '.env'), 'COMPOSE_FILE=compose.yaml:override.yaml\n');
      const unset = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
      expect(unset.body.exposed.stacks).not.toContain(STACK);
      expect(unset.body.unreadable.stacks).not.toContain(STACK);

      fs.writeFileSync(path.join(stackDir, 'override.yaml'), 'services:\n  edge:\n    environment:\n      TUNNEL_TOKEN: t\n');
      fs.writeFileSync(path.join(stackDir, 'compose.yaml'), edge('    environment:\n      TUNNEL_TOKEN:\n'));
      const set = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
      expect(set.body.exposed.stacks).toContain(STACK);
    });

    it.each([
      ['a bare environment key', edge('    environment:\n      - TUNNEL_TOKEN\n'), {}],
      ['a bare env_file key', edge('    env_file: ./edge.env\n'), { 'edge.env': 'TUNNEL_TOKEN\n' }],
      ['a null environment key', edge('    environment:\n      TUNNEL_TOKEN:\n'), {}],
    ])('reports %s as unreadable when the interpolation lookup is unavailable', async (_label, compose, extra) => {
      fs.writeFileSync(path.join(stackDir, '.env'), 'COMPOSE_DISABLE_ENV_FILE=true\n');
      fs.writeFileSync(path.join(stackDir, 'compose.yaml'), compose);
      for (const [file, content] of Object.entries(extra)) fs.writeFileSync(path.join(stackDir, file), content);
      const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
      expect(res.body.unreadable.stacks).toContain(STACK);
    });

    it('reports a raw env_file it cannot read the way Compose does as unreadable', async () => {
      fs.writeFileSync(path.join(stackDir, 'edge.env'), 'export TUNNEL_TOKEN=t\n');
      fs.writeFileSync(path.join(stackDir, 'compose.yaml'), edge('    env_file:\n      - path: ./edge.env\n        format: raw\n'));
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
      expect(res.body.unreadable.stacks).toContain(STACK);
    });
  });

  it('keeps one stack\'s unexpected failure from failing the whole node summary', async () => {
    const other = `${STACK}-other`;
    const otherDir = path.join(process.env.COMPOSE_DIR as string, other);
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(path.join(otherDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx:latest\n    ports:\n      - "0.0.0.0:8081:80"\n');
    const parser = await import('../helpers/composeDependencyParse');
    const real = parser.parseComposeDependencies;
    const spy = vi.spyOn(parser, 'parseComposeDependencies').mockImplementation((content, options) => {
      if (content.includes('8080')) throw new Error('unexpected');
      return real(content, options);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
      expect(res.status).toBe(200);
      expect(res.body.unreadable.stacks).toContain(STACK);
      expect(res.body.exposed.stacks).toContain(other);
    } finally {
      spy.mockRestore();
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('rejects an unauthenticated request to the node-local summary', async () => {
    expect((await request(app).get('/api/networking/summary')).status).toBe(401);
  });
});
