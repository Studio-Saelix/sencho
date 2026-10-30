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

  it('names a refused deploy spec in the log and never logs an env-file error message', async () => {
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'),
      'services:\n  ts:\n    image: tailscale/tailscale\n    environment:\n      TS_AUTHKEY: tskey-secret\n      TS_EXTRA_ARGS: ${TS_ARGS}\n  app:\n    image: example/app:1\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gitSource = vi.spyOn(DatabaseService.getInstance(), 'getGitSource');

    // A context directory a deploy refuses: the env files read fine, so the cause is the spec.
    gitSource.mockReturnValue({ applied_deploy_spec: { files: ['compose.yaml'], contextDir: '../outside' } } as ReturnType<DatabaseService['getGitSource']>);
    const refusedSpec = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(refusedSpec.body.exposed.stacks).toContain(STACK);
    const specLog = warn.mock.calls.map(args => format(...args)).join('\n');
    expect(specLog).toContain(`Stack ${STACK} interpolation failed; TS_EXTRA_ARGS left unresolved: Error: Invalid context directory in deploy spec`);
    expect(specLog).not.toContain('env files cannot be read');

    // The env files read first and fine; the project-directory check then throws.
    warn.mockClear();
    let calls = 0;
    gitSource.mockImplementation(() => {
      calls += 1;
      if (calls === 1) return undefined;
      throw new ComposeEnvFileError('required variable A is missing a value: hunter2-value');
    });
    const refused = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(refused.body.exposed.stacks).toContain(STACK);
    const logged = warn.mock.calls.map(args => format(...args)).join('\n');
    expect(logged).toContain('TS_EXTRA_ARGS left unresolved: ComposeEnvFileError');
    expect(logged).not.toContain('hunter2-value');
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
      expect(warn.mock.calls.filter(call => String(call[0]).includes('Skipped stack'))).toEqual([]);
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
      const skipped = warn.mock.calls.find(call => call[1] === linked);
      expect(skipped?.[0]).toContain('Skipped stack');
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

  it('rejects an unauthenticated request to the node-local summary', async () => {
    expect((await request(app).get('/api/networking/summary')).status).toBe(401);
  });
});
