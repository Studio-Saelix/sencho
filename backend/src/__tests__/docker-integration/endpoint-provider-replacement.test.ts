/**
 * Docker-backed acceptance journey for the Docker endpoint replacement, using
 * the shared Compose project from GitHub #2142 / SEN-1015: a Sencho service and
 * a LinuxServer socket proxy in one project, with the proxy carrying the host
 * Docker socket. The real helper sequence (stage, detached replace, rollback)
 * runs against a real engine, so container identities, the durable outcome and
 * a restored provider are observed rather than mocked.
 *
 * The helper's Compose and Docker code is the production wiring; only the data
 * directory and socket path are parameterized so the test can run in-process.
 * Skipped when Docker is unavailable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  helperFiles,
  replaceProvider,
  stageProviderReplacement,
  type ProviderReplacePlan,
  type ProviderOutcome,
} from '../../helpers/endpointProviderReplace';
import { buildDeps } from '../../helpers/endpointProviderDeps';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 8_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

const hasDocker = dockerAvailable();
const SOCKET_PATH = '/var/run/docker.sock';
const SENCHO_IMAGE = 'busybox:1.36.1';
const PROXY_IMAGE = 'linuxserver/socket-proxy:latest';
const OP_PREFIX = 'e2e' + process.pid;

let rootDir: string;
let dataDir: string;
const projects: string[] = [];

function compose(project: string, dir: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync('docker', ['compose', '-p', project, '-f', path.join(dir, 'compose.yaml'), ...args], {
    cwd: dir,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300_000,
  });
}

function composeFile(proxyService: string): string {
  // No network is needed: the helper talks to the host socket, and this keeps
  // the journey independent of Docker's address-pool size.
  return [
    'services:',
    '  sencho:',
    `    image: ${SENCHO_IMAGE}`,
    '    command: ["sleep", "3600"]',
    '    network_mode: none',
    '  socket-proxy:',
    proxyService,
    '    network_mode: none',
    '',
  ].join('\n');
}

function workingProxy(): string {
  return [
    `    image: ${PROXY_IMAGE}`,
    '    volumes:',
    `      - ${SOCKET_PATH}:/var/run/docker.sock:ro`,
  ].join('\n');
}

function brokenProxy(): string {
  return [
    `    image: ${SENCHO_IMAGE}`,
    '    command: ["sh", "-c", "exit 1"]',
  ].join('\n');
}

async function containerId(project: string, dir: string, service: string): Promise<string> {
  const id = compose(project, dir, ['ps', '-q', service]).trim();
  expect(id, `no container for ${service}`).not.toBe('');
  return id;
}

function inspect(id: string): {
  Image: string;
  Config: { Image?: string; Env?: string[] };
  State: { Running: boolean; Status: string };
} {
  const raw = execFileSync('docker', ['inspect', id], { encoding: 'utf8' });
  return (JSON.parse(raw) as Array<{
    Image: string;
    Config: { Image?: string; Env?: string[] };
    State: { Running: boolean; Status: string };
  }>)[0];
}

/**
 * Whether the recreated LinuxServer proxy actually serves the Docker API from
 * inside its own network namespace. A running container alone does not prove
 * the replacement is usable.
 */
function proxyAnswers(proxyContainerId: string): boolean {
  try {
    const output = execFileSync('docker', [
      'run', '--rm', '--network', `container:${proxyContainerId}`,
      SENCHO_IMAGE, 'wget', '-qO-', 'http://127.0.0.1:2375/_ping',
    ], { encoding: 'utf8', timeout: 60_000 });
    return output.trim() === 'OK';
  } catch {
    return false;
  }
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error('condition did not settle before the test deadline');
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

interface Fixture {
  project: string;
  dir: string;
  plan: ProviderReplacePlan;
  deps: ReturnType<typeof buildDeps>;
}

async function fixture(mode: 'provider' | 'stack'): Promise<Fixture> {
  const project = `${OP_PREFIX}-${mode}-${Math.random().toString(16).slice(2, 8)}`;
  const dir = path.join(rootDir, project);
  await fs.mkdir(dir, { recursive: true });
  projects.push(project);
  await fs.writeFile(path.join(dir, 'compose.yaml'), composeFile(workingProxy()), 'utf8');
  compose(project, dir, ['up', '-d', '--pull', 'never']);

  const providerContainerId = await containerId(project, dir, 'socket-proxy');
  const operationId = crypto.randomUUID();
  const operationDir = path.dirname(helperFiles.plan(dataDir, operationId));
  await fs.mkdir(operationDir, { recursive: true, mode: 0o700 });

  const plan: ProviderReplacePlan = {
    schemaVersion: 1,
    operationId,
    mode: 'reapply',
    scope: mode,
    project,
    workingDir: dir,
    configFiles: [path.join(dir, 'compose.yaml')],
    providerService: 'socket-proxy',
    senchoService: 'sencho',
    providerContainerId,
    composeCopy: null,
    pruneOnUpdate: false,
    providerReadySeconds: 20,
    ackSeconds: 30,
  };
  await fs.writeFile(helperFiles.plan(dataDir, operationId), JSON.stringify(plan), { mode: 0o600 });
  const deps = buildDeps(plan, helperFiles.log(dataDir, operationId), fs, null, {
    dataDir,
    socketPath: SOCKET_PATH,
  });
  return { project, dir, plan, deps };
}

/** Answer as the surviving/restarted Sencho once the helper publishes the marker. */
async function answerAfterMarker(fix: Fixture, onRecreated?: () => Promise<void> | void): Promise<ProviderOutcome> {
  const replacement = replaceProvider(fix.plan, fix.deps);
  await waitFor(async () => {
    try {
      await fs.access(helperFiles.recreated(dataDir, fix.plan.operationId));
      return true;
    } catch {
      return false;
    }
  });
  if (onRecreated) await onRecreated();
  await fix.deps.writeJson(helperFiles.ack(dataDir, fix.plan.operationId), {
    operationId: fix.plan.operationId,
    ok: true,
    detail: null,
  });
  return replacement;
}

describe.skipIf(!hasDocker || process.platform !== 'linux')('Docker endpoint replacement against a real shared project', () => {
  beforeAll(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sencho-endpoint-replace-'));
    dataDir = path.join(rootDir, 'data');
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    for (const image of [SENCHO_IMAGE, PROXY_IMAGE, 'docker:27-cli']) {
      execFileSync('docker', ['pull', image], { stdio: 'ignore', timeout: 300_000 });
    }
  }, 300_000);

  afterAll(async () => {
    for (const project of projects) {
      try {
        compose(project, path.join(rootDir, project), ['down', '-v', '--remove-orphans']);
      } catch {
        // Best-effort cleanup; the project may never have started.
      }
    }
    if (rootDir) await fs.rm(rootDir, { recursive: true, force: true });
  }, 300_000);

  it('replaces only the provider, leaves Sencho running, and accepts its late verdict', async () => {
    const fix = await fixture('provider');
    const senchoBefore = await containerId(fix.project, fix.dir, 'sencho');
    const proxyBefore = await containerId(fix.project, fix.dir, 'socket-proxy');

    const staged = await stageProviderReplacement(fix.plan, fix.deps);
    expect(staged).toMatchObject({ ok: true, providerImage: PROXY_IMAGE });

    const outcome = await answerAfterMarker(fix);
    expect(outcome).toEqual({ operationId: fix.plan.operationId, ok: true });

    const senchoAfter = await containerId(fix.project, fix.dir, 'sencho');
    const proxyAfter = await containerId(fix.project, fix.dir, 'socket-proxy');
    expect(senchoAfter).toBe(senchoBefore);
    expect(proxyAfter).not.toBe(proxyBefore);
    expect(inspect(proxyAfter).State.Running).toBe(true);
    expect(proxyAnswers(proxyAfter), 'the recreated proxy must answer the Docker API').toBe(true);
  }, 300_000);

  it('applies a configuration-only change to the provider', async () => {
    const fix = await fixture('provider');
    const proxyBefore = await containerId(fix.project, fix.dir, 'socket-proxy');
    expect(await stageProviderReplacement(fix.plan, fix.deps)).toMatchObject({ ok: true });
    await fs.writeFile(path.join(fix.dir, 'compose.yaml'), composeFile([
      `    image: ${PROXY_IMAGE}`,
      '    environment:',
      '      - SENCHO_E2E_CONFIG=changed',
      '    volumes:',
      `      - ${SOCKET_PATH}:/var/run/docker.sock:ro`,
    ].join('\n')), 'utf8');

    const outcome = await answerAfterMarker(fix);
    expect(outcome).toEqual({ operationId: fix.plan.operationId, ok: true });
    const proxyAfter = await containerId(fix.project, fix.dir, 'socket-proxy');
    const after = inspect(proxyAfter);
    expect(after.State.Running).toBe(true);
    expect(after.Config.Env).toContain('SENCHO_E2E_CONFIG=changed');
    expect(proxyAfter).not.toBe(proxyBefore);
    expect(proxyAnswers(proxyAfter), 'the reconfigured proxy must answer the Docker API').toBe(true);
  }, 300_000);

  it('applies an image change to the provider without restarting Sencho', async () => {
    const fix = await fixture('provider');
    const senchoBefore = await containerId(fix.project, fix.dir, 'sencho');
    expect(await stageProviderReplacement(fix.plan, fix.deps)).toMatchObject({ ok: true });
    await fs.writeFile(path.join(fix.dir, 'compose.yaml'), composeFile([
      `    image: ${SENCHO_IMAGE}`,
      '    command: ["sleep", "3600"]',
    ].join('\n')), 'utf8');

    const outcome = await answerAfterMarker(fix);
    expect(outcome).toEqual({ operationId: fix.plan.operationId, ok: true });
    const after = inspect(await containerId(fix.project, fix.dir, 'socket-proxy'));
    expect(after.Config.Image).toBe(SENCHO_IMAGE);
    expect(after.State.Running).toBe(true);
    expect(await containerId(fix.project, fix.dir, 'sencho')).toBe(senchoBefore);
  }, 300_000);

  it('recreates Sencho after the provider in the shared scope', async () => {
    const fix = await fixture('stack');
    const senchoBefore = await containerId(fix.project, fix.dir, 'sencho');
    const proxyBefore = await containerId(fix.project, fix.dir, 'socket-proxy');
    expect(await stageProviderReplacement(fix.plan, fix.deps)).toMatchObject({ ok: true });

    const outcome = await answerAfterMarker(fix, async () => {
      await waitFor(() => {
        try {
          const id = compose(fix.project, fix.dir, ['ps', '-q', 'sencho']).trim();
          return id !== '' && id !== senchoBefore;
        } catch {
          // Compose can answer empty while the service is being replaced.
          return false;
        }
      });
    });
    expect(outcome).toEqual({ operationId: fix.plan.operationId, ok: true });
    const proxyAfter = await containerId(fix.project, fix.dir, 'socket-proxy');
    expect(proxyAfter).not.toBe(proxyBefore);
    expect(proxyAnswers(proxyAfter), 'the recreated proxy must answer the Docker API').toBe(true);
  }, 300_000);

  it('renders required, defaulted and .env Compose values with the validation helper arguments', async () => {
    const dir = path.join(rootDir, 'validation');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'compose.yaml'), [
      'services:',
      '  required:',
      '    image: ${SENCHO_E2E_REQUIRED_IMAGE:?required proxy image}',
      '  defaulted:',
      '    image: ${SENCHO_E2E_DEFAULTED_IMAGE:-busybox:1.36.1}',
      '  envfile:',
      '    image: ${SENCHO_E2E_ENV_FILE_IMAGE}',
      '',
    ].join('\n'), 'utf8');
    await fs.writeFile(path.join(dir, '.env'), 'SENCHO_E2E_ENV_FILE_IMAGE=redis:7\n', 'utf8');
    process.env.SENCHO_E2E_REQUIRED_IMAGE = 'busybox:1.36.1';
    delete process.env.SENCHO_E2E_DEFAULTED_IMAGE;

    const { buildComposeConfigValidateArgs } = await import('../../services/SelfUpdateService');
    const args = buildComposeConfigValidateArgs({
      workingDir: dir,
      imageName: 'docker:27-cli',
      hostBindMounts: [],
      configFiles: path.join(dir, 'compose.yaml'),
      envKeys: ['SENCHO_E2E_REQUIRED_IMAGE', 'SENCHO_E2E_DEFAULTED_IMAGE'],
    });
    const rendered = execFileSync('docker', args, {
      encoding: 'utf8',
      env: { ...process.env },
      timeout: 300_000,
    });
    // The required value comes from the forwarded process key, the defaulted
    // one from its Compose default, and the third from the project's .env.
    expect(rendered).toContain('image: busybox:1.36.1');
    expect(rendered).toContain('image: redis:7');

    const withoutForwarding = buildComposeConfigValidateArgs({
      workingDir: dir,
      imageName: 'docker:27-cli',
      hostBindMounts: [],
      configFiles: path.join(dir, 'compose.yaml'),
      envKeys: [],
    });
    expect(() => execFileSync('docker', withoutForwarding, {
      encoding: 'utf8',
      env: { ...process.env },
      timeout: 300_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })).toThrow(/required proxy image/);
  }, 300_000);

  it('restores the previous provider image and configuration after a failed recreation', async () => {
    const fix = await fixture('provider');
    const proxyBefore = await containerId(fix.project, fix.dir, 'socket-proxy');
    const previousImageId = inspect(proxyBefore).Image;
    expect(await stageProviderReplacement(fix.plan, fix.deps)).toMatchObject({ ok: true });

    // The authored configuration now points at a service that exits immediately,
    // so `compose up --wait` fails after the old provider is gone. Recovery must
    // put the snapshot back without a live Sencho to answer the ack.
    await fs.writeFile(path.join(fix.dir, 'compose.yaml'), composeFile(brokenProxy()), 'utf8');
    const outcome = await replaceProvider(fix.plan, fix.deps);
    expect(outcome).toMatchObject({
      ok: false,
      phase: 'provider',
      rollback: { attempted: true, restored: true, error: null },
    });

    const restored = await containerId(fix.project, fix.dir, 'socket-proxy');
    expect(restored).not.toBe(proxyBefore);
    expect(inspect(restored)).toMatchObject({ Image: previousImageId, State: { Running: true } });
    // The restore must put back a proxy that actually answers the Docker API,
    // not merely a container that is running.
    expect(proxyAnswers(restored), 'the restored proxy must answer the Docker API').toBe(true);
  }, 300_000);
});
