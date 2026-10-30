/**
 * Docker-backed: the tunnel facts the light summary reports must match a real
 * `docker compose config` render for the configuration shapes the summary
 * resolves itself (service env files, interpolation, and COMPOSE_FILE layers).
 * Skipped automatically when Docker is unavailable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { setupTestDb, cleanupTestDb } from '../helpers/setupTestDb';
import { parseEffectiveModel } from '../../services/preflight/effectiveModel';
import { deriveStackExposure } from '../../services/preflight/exposure';
import { detectTunnels, tunnelExposureByService } from '../../services/network/tunnelDetection';
import { computeNodeNetworkingSummary } from '../../services/network/networkingSummary';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 8_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

const hasDocker = dockerAvailable();
const STACK = 'tunneltest';

function render(stackDir: string, files: string[]): unknown {
  const args = ['compose', '-p', STACK];
  for (const file of files) args.push('-f', file);
  args.push('config', '--format', 'json');
  return JSON.parse(execFileSync('docker', args, { cwd: stackDir, encoding: 'utf8', timeout: 20_000, windowsHide: true }));
}

function reachedServices(stackDir: string, files: string[]): string[] {
  const model = parseEffectiveModel(render(stackDir, files), STACK);
  return [...tunnelExposureByService(detectTunnels(model)).keys()].sort();
}

describe.skipIf(!hasDocker)('the tunnel summary reads the same effective inputs Compose renders', () => {
  let tmpDir: string;
  let stackDir: string;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    stackDir = path.join(process.env.COMPOSE_DIR as string, STACK);
    fs.mkdirSync(stackDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(stackDir, { recursive: true, force: true });
    cleanupTestDb(tmpDir);
  });

  it('reads a Tailscale provider key and forwarding flag from a service env_file', async () => {
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), [
      'services:',
      '  ts:',
      '    image: tailscale/tailscale',
      '    env_file: ./ts.env',
      '  app:',
      '    image: busybox:1.36.1',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(stackDir, 'ts.env'), 'TS_AUTHKEY=tskey-secret\nTS_EXTRA_ARGS=--advertise-exit-node\n');

    expect(reachedServices(stackDir, ['compose.yaml'])).toEqual(['app']);
    const exposure = deriveStackExposure(parseEffectiveModel(render(stackDir, ['compose.yaml']), STACK), STACK, Date.now());
    expect(exposure.services.find(service => service.service === 'app')).toMatchObject({ publiclyExposed: true, reason: 'tunnel' });
    const summary = await computeNodeNetworkingSummary(1);
    expect(summary.exposed.stacks).toContain(STACK);
    expect(summary.unreadable?.stacks).not.toContain(STACK);
  });

  it('interpolates an image reference the same way Compose does', async () => {
    fs.writeFileSync(path.join(stackDir, '.env'), 'CF_IMAGE=cloudflare/cloudflared:latest\n');
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), [
      'services:',
      '  cf:',
      '    image: ${CF_IMAGE}',
      '    command: tunnel run',
      '  app:',
      '    image: busybox:1.36.1',
      '',
    ].join('\n'));

    expect(reachedServices(stackDir, ['compose.yaml'])).toEqual(['app']);
    const exposure = deriveStackExposure(parseEffectiveModel(render(stackDir, ['compose.yaml']), STACK), STACK, Date.now());
    expect(exposure.services.find(service => service.service === 'app')).toMatchObject({ publiclyExposed: true, reason: 'tunnel' });
    const summary = await computeNodeNetworkingSummary(1);
    expect(summary.exposed.stacks).toContain(STACK);
    expect(summary.unreadable?.stacks).not.toContain(STACK);
  });

  it('reads every layer COMPOSE_FILE selects', async () => {
    fs.writeFileSync(path.join(stackDir, '.env'), 'COMPOSE_FILE=compose.yaml:override.yaml\n');
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), [
      'services:',
      '  app:',
      '    image: busybox:1.36.1',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(stackDir, 'override.yaml'), [
      'services:',
      '  ts:',
      '    image: tailscale/tailscale',
      '    environment:',
      '      TS_AUTHKEY: tskey-secret',
      '      TS_EXTRA_ARGS: --advertise-exit-node',
      '',
    ].join('\n'));

    expect(reachedServices(stackDir, ['compose.yaml', 'override.yaml'])).toEqual(['app']);
    const exposure = deriveStackExposure(parseEffectiveModel(render(stackDir, ['compose.yaml', 'override.yaml']), STACK), STACK, Date.now());
    expect(exposure.services.find(service => service.service === 'app')).toMatchObject({ publiclyExposed: true, reason: 'tunnel' });
    const summary = await computeNodeNetworkingSummary(1);
    expect(summary.exposed.stacks).toContain(STACK);
    expect(summary.unreadable?.stacks).not.toContain(STACK);
  });

  it('reports an input Compose itself cannot render as unreadable, never as unexposed', async () => {
    fs.rmSync(path.join(stackDir, '.env'), { force: true });
    fs.rmSync(path.join(stackDir, 'override.yaml'), { force: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), [
      'services:',
      '  ts:',
      '    image: tailscale/tailscale',
      '    env_file: ./missing.env',
      '  app:',
      '    image: busybox:1.36.1',
      '',
    ].join('\n'));

    expect(() => render(stackDir, ['compose.yaml'])).toThrow();
    const summary = await computeNodeNetworkingSummary(1);
    expect(summary.unreadable?.stacks).toContain(STACK);
    expect(summary.exposed.stacks).not.toContain(STACK);
  });
});
