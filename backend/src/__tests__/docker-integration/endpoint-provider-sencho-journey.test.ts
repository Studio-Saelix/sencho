/**
 * Whole-node acceptance journey for the Docker endpoint replacement.
 *
 * Unlike the helper-level Docker test, this runs an actual Sencho container
 * (this checkout's compiled `dist` layered on the published release image) in
 * a real Compose project with a LinuxServer socket proxy, reached through
 * `DOCKER_HOST=tcp://socket-proxy:2375`. The test drives the same system routes
 * the UI calls, so the production claim, detached helper launch, provider
 * recreation, in-place verification/ack, node restart, startup reconciliation
 * and durable outcome are all exercised together.
 *
 * The project name deliberately differs from the directory and a
 * `${COMPOSE_PROJECT_NAME}.env` file only resolves under that name, so the
 * preliminary Reapply render must carry the authoritative `-p` too.
 *
 * Skipped when Docker is unavailable or the backend has not been built.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fsSync from 'fs';
import fs from 'fs/promises';
import net from 'net';
import os from 'os';
import path from 'path';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 8_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

const hasDocker = dockerAvailable();
const PROXY_IMAGE = 'linuxserver/socket-proxy:latest';
const BUSYBOX_IMAGE = 'busybox:1.36.1';
const DIST_DIR = path.resolve(process.cwd(), 'dist');
const IMAGE = `sencho-endpoint-journey:${process.pid}`;
const PROJECT_PREFIX = `senchoj${process.pid.toString(36)}`;

/** Published release that supplies the runtime (node_modules, CLI) under this checkout's dist. */
let baseImage: string;

let rootDir: string;
const startedProjects: Array<{ project: string; dir: string }> = [];

function compose(project: string, dir: string, args: string[]): string {
  return execFileSync('docker', ['compose', '-p', project, '-f', path.join(dir, 'compose.yaml'), ...args], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300_000,
  });
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error('condition did not settle before the test deadline');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

interface Fixture {
  project: string;
  dir: string;
  dataDir: string;
  hostPort: number;
  subnetIndex: number;
  baseUrl: string;
  cookie: string;
}

function serviceId(project: string, dir: string, service: string): string {
  const id = compose(project, dir, ['ps', '-q', service]).trim();
  expect(id, `no container for ${service}`).not.toBe('');
  return id;
}

/** Proves the recreated/restored proxy actually serves the Docker API on the project network. */
function proxyAnswers(project: string): boolean {
  try {
    const output = execFileSync('docker', [
      'run', '--rm', '--network', `${project}_default`,
      BUSYBOX_IMAGE, 'wget', '-qO-', 'http://socket-proxy:2375/_ping',
    ], { encoding: 'utf8', timeout: 60_000 });
    return output.trim() === 'OK';
  } catch {
    return false;
  }
}

function proxyEnv(project: string, dir: string): string[] {
  const raw = execFileSync('docker', ['inspect', serviceId(project, dir, 'socket-proxy'), '--format', '{{json .Config.Env}}'], { encoding: 'utf8' });
  return JSON.parse(raw) as string[];
}

function composeFile(hostPort: number, dataDir: string, brokenProvider: boolean, subnetIndex: number): string {
  const provider = brokenProvider
    ? [
      '  socket-proxy:',
      `    image: ${BUSYBOX_IMAGE}`,
      '    command: ["sh", "-c", "exit 1"]',
    ]
    : [
      '  socket-proxy:',
      `    image: ${PROXY_IMAGE}`,
      // This bin's proxy config uses unprefixed section/action keys. Sencho
      // needs the read and lifecycle API it uses for ordinary stack work, and
      // the helper needs container create/start/remove plus image list/pull.
      '    environment:',
      '      CONTAINERS: "1"',
      '      NETWORKS: "1"',
      '      IMAGES: "1"',
      '      EXEC: "1"',
      '      POST: "1"',
      '      INFO: "1"',
      '      VERSION: "1"',
      '      EVENTS: "1"',
      '      SYSTEM: "1"',
      '      VOLUMES: "1"',
      '      START: "1"',
      '      STOP: "1"',
      '      RESTARTS: "1"',
      '      LOGS: "1"',
      '      BUILD: "1"',
      '    volumes:',
      '      - /var/run/docker.sock:/var/run/docker.sock:ro',
    ];
  return [
    'services:',
    '  sencho:',
    `    image: ${IMAGE}`,
    '    environment:',
    '      DATA_DIR: /app/data',
    '      PORT: "1852"',
    '      DOCKER_HOST: tcp://socket-proxy:2375',
    '      NODE_ENV: test',
    '    volumes:',
    `      - ${dataDir}:/app/data`,
    '    ports:',
    `      - "127.0.0.1:${hostPort}:1852"`,
    '    depends_on:',
    '      - socket-proxy',
    ...provider,
    '    env_file:',
    // Only resolvable through the project name, never the directory name.
    '      - ${COMPOSE_PROJECT_NAME}.env',
    'networks:',
    '  default:',
    '    ipam:',
    '      config:',
    // A private range outside Docker's predefined pools: the shared integration
    // host can otherwise run out of default /16 allocations across projects.
    `        - subnet: 10.213.${subnetIndex}.0/24`,
    '',
  ].join('\n');
}

async function api(fix: Fixture, route: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${fix.baseUrl}${route}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
      Cookie: fix.cookie,
    },
  });
}

async function health(fix: Fixture): Promise<boolean> {
  try {
    const res = await fetch(`${fix.baseUrl}/api/health`, { signal: AbortSignal.timeout(3_000) });
    return res.ok;
  } catch {
    return false;
  }
}

interface Operation {
  state: string;
  failureCode?: string;
  endpointProvider?: { scope: string };
}

async function currentOperation(fix: Fixture): Promise<Operation | null> {
  try {
    const res = await api(fix, '/api/license/image-channel/status');
    if (!res.ok) return null;
    return ((await res.json()) as { operation?: Operation }).operation ?? null;
  } catch {
    return null;
  }
}

/** Waits through a Sencho restart for the operation to reach a terminal state. */
async function settledOperation(fix: Fixture): Promise<Operation> {
  let last: Operation | null = null;
  await waitFor(async () => {
    last = await currentOperation(fix);
    return last?.state === 'succeeded' || last?.state === 'failed';
  }, 180_000);
  expect(last).not.toBeNull();
  return last!;
}

async function meta(fix: Fixture): Promise<Record<string, unknown>> {
  const res = await api(fix, '/api/meta');
  expect(res.status).toBe(200);
  return await res.json() as Record<string, unknown>;
}

async function fixture(kind: string, brokenProvider = false): Promise<Fixture> {
  const project = `${PROJECT_PREFIX}${startedProjects.length}${kind}`.toLowerCase();
  const dir = path.join(rootDir, kind);
  const dataDir = path.join(rootDir, `${kind}-data`);
  const hostPort = await freePort();
  const subnetIndex = (process.pid % 100) + startedProjects.length * 3 + 1;
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  startedProjects.push({ project, dir });
  await fs.writeFile(path.join(dir, 'compose.yaml'), composeFile(hostPort, dataDir, brokenProvider, subnetIndex), 'utf8');
  await fs.writeFile(path.join(dir, `${project}.env`), 'SENCHO_E2E_ENV_FILE_MARKER=present\n', 'utf8');
  compose(project, dir, ['up', '-d', '--pull', 'never']);
  const fix: Fixture = { project, dir, dataDir, hostPort, subnetIndex, baseUrl: `http://127.0.0.1:${hostPort}`, cookie: '' };
  await waitFor(() => health(fix));
  const setup = await fetch(`${fix.baseUrl}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'password123', confirmPassword: 'password123' }),
  });
  expect(setup.status, `first-run setup failed: ${await setup.text()}`).toBe(200);
  const setCookie = setup.headers.getSetCookie()[0] ?? setup.headers.get('set-cookie');
  expect(setCookie, 'setup did not issue a session cookie').toBeTruthy();
  fix.cookie = setCookie!.split(';')[0];
  return fix;
}

async function composeReapply(fix: Fixture, body: Record<string, boolean>): Promise<Response> {
  return api(fix, '/api/system/reapply-compose', { method: 'POST', body: JSON.stringify(body) });
}

describe.skipIf(!hasDocker || process.platform !== 'linux')('actual Sencho Docker endpoint replacement journey', () => {
  beforeAll(async () => {
    for (const required of ['index.js', 'endpointProviderHelper.js']) {
      try {
        await fs.access(path.join(DIST_DIR, required));
      } catch {
        throw new Error(`backend/dist/${required} is missing; run "npm run build" in backend before the Docker integration suite`);
      }
    }
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sencho-endpoint-journey-'));
    // Prefer the release matching this checkout; fall back to latest so a
    // release PR whose new tag is not published yet still runs the journey.
    const version = (JSON.parse(fsSync.readFileSync(path.resolve(process.cwd(), '../package.json'), 'utf8')) as { version: string }).version;
    const candidates = [`saelix/sencho:${version}`, 'saelix/sencho:latest'];
    baseImage = '';
    for (const candidate of candidates) {
      try {
        execFileSync('docker', ['pull', candidate], { stdio: 'ignore', timeout: 600_000 });
        baseImage = candidate;
        break;
      } catch {
        // Try the next candidate.
      }
    }
    if (!baseImage) throw new Error(`none of the Sencho base images could be pulled: ${candidates.join(', ')}`);
    for (const image of [PROXY_IMAGE, BUSYBOX_IMAGE]) {
      execFileSync('docker', ['pull', image], { stdio: 'ignore', timeout: 600_000 });
    }
    const context = path.join(rootDir, 'image');
    await fs.mkdir(context, { recursive: true });
    await fs.cp(DIST_DIR, path.join(context, 'dist'), { recursive: true });
    await fs.writeFile(path.join(context, 'Dockerfile'), `FROM ${baseImage}\nCOPY dist /app/dist\n`, 'utf8');
    execFileSync('docker', ['build', '-q', '-t', IMAGE, context], { stdio: 'ignore', timeout: 600_000 });
  }, 900_000);

  afterAll(async () => {
    for (const { project, dir } of startedProjects) {
      try {
        compose(project, dir, ['down', '-v', '--remove-orphans']);
      } catch {
        // Best-effort cleanup; the project may never have fully started.
      }
    }
    if (rootDir) {
      // Sencho runs as root in the container, so its data directory holds
      // root-owned files the test user cannot remove directly.
      try {
        const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
        const gid = typeof process.getgid === 'function' ? process.getgid() : 0;
        execFileSync('docker', ['run', '--rm', '-v', `${rootDir}:/cleanup`, BUSYBOX_IMAGE, 'chown', '-R', `${uid}:${gid}`, '/cleanup'], {
          stdio: 'ignore', timeout: 120_000,
        });
      } catch {
        // Fall through to the host removal for whatever is left.
      }
      await fs.rm(rootDir, { recursive: true, force: true });
    }
    try {
      execFileSync('docker', ['image', 'rm', '-f', IMAGE], { stdio: 'ignore' });
    } catch {
      // The image may never have been built.
    }
  }, 300_000);

  it('replaces only the provider through production, stays running, and excludes a duplicate', async () => {
    const fix = await fixture('provider');
    const senchoBefore = serviceId(fix.project, fix.dir, 'sencho');
    const proxyBefore = serviceId(fix.project, fix.dir, 'socket-proxy');

    const option = await api(fix, '/api/system/endpoint-provider');
    expect(await option.json()).toMatchObject({
      state: 'available', service: 'socket-proxy', project: fix.project, providerOnly: true,
    });

    const started = await composeReapply(fix, { replaceEndpointProvider: true, endpointProviderOnly: true });
    expect(started.status, await started.text()).toBe(202);
    // The claim is durable before the response, so a duplicate never reaches a
    // second helper even while the first one is still staging.
    const duplicate = await composeReapply(fix, { replaceEndpointProvider: true, endpointProviderOnly: true });
    expect(duplicate.status).toBe(409);
    expect(((await duplicate.json()) as { code?: string }).code).toBe('IMAGE_OPERATION_IN_FLIGHT');

    let sawPending = false;
    const operation = await (async () => {
      const deadline = Date.now() + 180_000;
      for (;;) {
        const current = await currentOperation(fix);
        if ((await meta(fix)).endpointProviderPending === true) sawPending = true;
        if (current?.state === 'succeeded' || current?.state === 'failed') return current;
        if (Date.now() >= deadline) throw new Error('replacement did not settle before the test deadline');
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    })();

    expect(operation.state, JSON.stringify(operation)).toBe('succeeded');
    expect(operation.endpointProvider?.scope).toBe('provider');
    expect(sawPending, 'Fleet must see the replacement pending while it runs').toBe(true);

    // Actual identities: Sencho never restarted, the provider is a new container.
    expect(serviceId(fix.project, fix.dir, 'sencho')).toBe(senchoBefore);
    expect(serviceId(fix.project, fix.dir, 'socket-proxy')).not.toBe(proxyBefore);
    expect(proxyAnswers(fix.project), 'the recreated proxy must answer the Docker API').toBe(true);
    // Sencho reaches Docker through the new provider (the option re-resolves it).
    expect(await (await api(fix, '/api/system/endpoint-provider')).json()).toMatchObject({ state: 'available', service: 'socket-proxy' });
    expect((await meta(fix)).endpointProviderCompletedAt).toEqual(expect.any(Number));
    // The project-dependent env_file rendered through the authoritative project
    // name in both the preliminary validation and the replacement.
    expect(proxyEnv(fix.project, fix.dir)).toContain('SENCHO_E2E_ENV_FILE_MARKER=present');
  }, 300_000);

  it('recreates the provider and Sencho in the shared scope, then reconciles from the new process', async () => {
    const fix = await fixture('shared');
    const senchoBefore = serviceId(fix.project, fix.dir, 'sencho');
    const proxyBefore = serviceId(fix.project, fix.dir, 'socket-proxy');

    const started = await composeReapply(fix, { replaceEndpointProvider: true });
    expect(started.status, await started.text()).toBe(202);

    // The helper recreates Sencho; the replacement's verdict comes from the new
    // process reading the durable operation file and answering the helper.
    const operation = await settledOperation(fix);
    expect(operation.state, JSON.stringify(operation)).toBe('succeeded');
    expect(operation.endpointProvider?.scope).toBe('stack');

    expect(await health(fix)).toBe(true);
    expect(serviceId(fix.project, fix.dir, 'sencho')).not.toBe(senchoBefore);
    expect(serviceId(fix.project, fix.dir, 'socket-proxy')).not.toBe(proxyBefore);
    expect(proxyAnswers(fix.project), 'the recreated proxy must answer the Docker API').toBe(true);
    expect(await (await api(fix, '/api/system/endpoint-provider')).json()).toMatchObject({ state: 'available', service: 'socket-proxy' });
    expect((await meta(fix)).updateError ?? null).toBeNull();
  }, 300_000);

  it('restores the previous provider and proves connectivity after a failed recreation', async () => {
    const fix = await fixture('recovery');
    const senchoBefore = serviceId(fix.project, fix.dir, 'sencho');
    const proxyBefore = serviceId(fix.project, fix.dir, 'socket-proxy');

    // Same project, but the provider now exits before it can serve Docker.
    await fs.writeFile(path.join(fix.dir, 'compose.yaml'), composeFile(fix.hostPort, fix.dataDir, true, fix.subnetIndex), 'utf8');
    const started = await composeReapply(fix, { replaceEndpointProvider: true, endpointProviderOnly: true });
    expect(started.status, await started.text()).toBe(202);

    const operation = await settledOperation(fix);
    expect(operation.state, JSON.stringify(operation)).toBe('failed');
    expect(operation.failureCode).toBe('endpoint_provider_restored');

    // Recovery is real: the old provider is back in a new container, Sencho
    // stayed up, and it reaches Docker through the restored container again.
    expect(serviceId(fix.project, fix.dir, 'sencho')).toBe(senchoBefore);
    expect(serviceId(fix.project, fix.dir, 'socket-proxy')).not.toBe(proxyBefore);
    expect(proxyAnswers(fix.project), 'the restored proxy must answer the Docker API').toBe(true);
    expect(await (await api(fix, '/api/system/endpoint-provider')).json()).toMatchObject({ state: 'available', service: 'socket-proxy' });
    const metaAfter = await meta(fix);
    expect(metaAfter.updateError).toBe('endpoint_provider_restored');
    expect(metaAfter.endpointProviderPending).toBeUndefined();
  }, 300_000);
});
