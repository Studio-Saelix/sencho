/**
 * Live-caller regression for the compose alias-expansion guard.
 *
 * `ComposeService` is the caller behind deploy, update, preflight, image
 * listing and health. Its main suite mocks the guard to prove wiring, so this
 * file runs the real guard through `renderConfig`: a bomb must come back as
 * Sencho's refusal and the Docker child must never be spawned.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fsPromises } from 'fs';
import os from 'os';
import path from 'path';

const { mockSpawn, composeDirRef } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  composeDirRef: { current: '' },
}));

vi.mock('child_process', () => ({
  spawn: mockSpawn,
  execFile: vi.fn(),
}));

vi.mock('../services/NodeRegistry', () => ({
  NodeRegistry: {
    getInstance: () => ({
      getComposeDir: () => composeDirRef.current,
      getDefaultNodeId: () => 1,
    }),
  },
}));

vi.mock('../services/DatabaseService', () => ({
  DatabaseService: {
    getInstance: () => ({
      getGitSource: () => null,
      getStackProjectEnvFiles: () => [],
      isMeshStackEnabled: () => false,
    }),
  },
}));

import { ComposeService } from '../services/ComposeService';

function nestedAliasBomb(levels: number): string {
  const lines = ['x0: &a0 [lol, lol, lol, lol, lol, lol, lol, lol, lol]'];
  for (let level = 1; level <= levels; level += 1) {
    const refs = Array.from({ length: 9 }, () => `*a${level - 1}`).join(', ');
    lines.push(`x${level}: &a${level} [${refs}]`);
  }
  lines.push('services:', '  web:', '    image: nginx:alpine');
  return `${lines.join('\n')}\n`;
}

const SAFE_COMPOSE = 'services:\n  web:\n    image: nginx:alpine\n';

/** Encode text the way a BOM-marked UTF-16 Compose file stores it. */
function encodeUtf16(text: string, endianness: 'le' | 'be'): Buffer {
  const body = Buffer.from(text, 'utf16le');
  if (endianness === 'le') return Buffer.concat([Buffer.from([0xff, 0xfe]), body]);
  const swapped = Buffer.from(body);
  swapped.swap16();
  return Buffer.concat([Buffer.from([0xfe, 0xff]), swapped]);
}

const ENV_KEYS = [
  'COMPOSE_FILE',
  'COMPOSE_PATH_SEPARATOR',
  'COMPOSE_ENV_FILES',
  'COMPOSE_DISABLE_ENV_FILE',
] as const;

let root: string;
let stackDir: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  mockSpawn.mockReset();
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-compose-live-'));
  composeDirRef.current = path.join(root, 'compose');
  stackDir = path.join(composeDirRef.current, 'stack');
  await fsPromises.mkdir(stackDir, { recursive: true });
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await fsPromises.rm(root, { recursive: true, force: true });
});

async function writeStackFile(name: string, content: string | Buffer): Promise<void> {
  const target = path.join(stackDir, name);
  await fsPromises.mkdir(path.dirname(target), { recursive: true });
  await fsPromises.writeFile(target, content);
}

describe('ComposeService live caller uses the real guard', () => {
  it('refuses a discovered bomb without spawning Compose', async () => {
    await writeStackFile('compose.yaml', nestedAliasBomb(12));

    const result = await ComposeService.getInstance(1).renderConfig('stack');

    expect(result.rendered).toBeNull();
    expect(result.refusal).toContain('nested YAML aliases');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('refuses a bomb selected by the project .env without spawning Compose', async () => {
    await writeStackFile('compose.yaml', SAFE_COMPOSE);
    await writeStackFile('selected.yaml', nestedAliasBomb(12));
    await writeStackFile('.env', 'COMPOSE_FILE=selected.yaml\n');

    const result = await ComposeService.getInstance(1).renderConfig('stack');

    expect(result.rendered).toBeNull();
    expect(result.refusal).toContain('nested YAML aliases');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('refuses a bomb in an include dependency without spawning Compose', async () => {
    await writeStackFile('compose.yaml', 'include:\n  - shared/bomb.yaml\nservices:\n  web:\n    image: nginx:alpine\n');
    await writeStackFile('shared/bomb.yaml', nestedAliasBomb(12));

    const result = await ComposeService.getInstance(1).renderConfig('stack');

    expect(result.rendered).toBeNull();
    expect(result.refusal).toContain('nested YAML aliases');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('refuses a bomb selected by the process COMPOSE_FILE without spawning Compose', async () => {
    await writeStackFile('compose.yaml', SAFE_COMPOSE);
    await writeStackFile('selected.yaml', nestedAliasBomb(12));
    process.env.COMPOSE_FILE = 'selected.yaml';

    const result = await ComposeService.getInstance(1).renderConfig('stack');

    expect(result.rendered).toBeNull();
    expect(result.refusal).toContain('nested YAML aliases');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('refuses a bomb in a multi-file selection with a custom separator without spawning Compose', async () => {
    await writeStackFile('compose.yaml', SAFE_COMPOSE);
    await writeStackFile('a.yaml', SAFE_COMPOSE);
    await writeStackFile('b.yaml', nestedAliasBomb(12));
    await writeStackFile('.env', 'COMPOSE_FILE=a.yaml;b.yaml\nCOMPOSE_PATH_SEPARATOR=;\n');

    const result = await ComposeService.getInstance(1).renderConfig('stack');

    expect(result.rendered).toBeNull();
    expect(result.refusal).toContain('nested YAML aliases');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('refuses a bomb in a later document of a stream without spawning Compose', async () => {
    await writeStackFile('compose.yaml', `${SAFE_COMPOSE}---\n${nestedAliasBomb(12)}`);

    const result = await ComposeService.getInstance(1).renderConfig('stack');

    expect(result.rendered).toBeNull();
    expect(result.refusal).toContain('nested YAML aliases');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('refuses a BOM-marked UTF-16 bomb without spawning Compose', async () => {
    await writeStackFile('compose.yaml', encodeUtf16(nestedAliasBomb(12), 'le'));

    const result = await ComposeService.getInstance(1).renderConfig('stack');

    expect(result.rendered).toBeNull();
    expect(result.refusal).toContain('nested YAML aliases');
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
