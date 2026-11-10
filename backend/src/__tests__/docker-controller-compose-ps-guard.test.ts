/**
 * Real-guard regression for the `compose ps` caller of the alias-expansion
 * guard. The main DockerController suite mocks the guard and the authored file
 * arguments to prove wiring, so it cannot notice the guard stop reading a
 * stack's env selection. This file runs both for real and mocks only the
 * Docker child: a bomb must never reach `docker compose ps`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fsPromises } from 'fs';
import os from 'os';
import path from 'path';

const { mockExecFileAsync, composeDirRef } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
  composeDirRef: { current: '' },
}));

vi.mock('child_process', () => ({
  exec: vi.fn(),
  execFile: vi.fn(),
}));
vi.mock('util', () => ({
  promisify: () => mockExecFileAsync,
}));

vi.mock('../services/NodeRegistry', () => ({
  NodeRegistry: {
    getInstance: () => ({
      getDocker: () => ({ listContainers: vi.fn().mockResolvedValue([]) }),
      getDefaultNodeId: () => 1,
      getComposeDir: () => composeDirRef.current,
    }),
  },
}));

vi.mock('../services/DatabaseService', () => ({
  DatabaseService: {
    getInstance: () => ({
      getGitSource: () => undefined,
      getStackProjectEnvFiles: () => [],
    }),
  },
}));

import DockerController from '../services/DockerController';

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

let root: string;
let stackDir: string;
let savedComposeFile: string | undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
  savedComposeFile = process.env.COMPOSE_FILE;
  delete process.env.COMPOSE_FILE;
  root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-ps-guard-'));
  composeDirRef.current = root;
  stackDir = path.join(root, 'stack');
  await fsPromises.mkdir(stackDir, { recursive: true });
});

afterEach(async () => {
  if (savedComposeFile === undefined) delete process.env.COMPOSE_FILE;
  else process.env.COMPOSE_FILE = savedComposeFile;
  await fsPromises.rm(root, { recursive: true, force: true });
});

async function writeStackFile(name: string, content: string): Promise<void> {
  await fsPromises.mkdir(path.dirname(path.join(stackDir, name)), { recursive: true });
  await fsPromises.writeFile(path.join(stackDir, name), content);
}

async function listContainers(): Promise<unknown[]> {
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    return await DockerController.getInstance(1).getContainersByStack('stack');
  } finally {
    errSpy.mockRestore();
  }
}

describe('DockerController compose ps uses the real guard', () => {
  it('does not run compose ps for a discovered bomb', async () => {
    await writeStackFile('compose.yaml', nestedAliasBomb(12));

    await expect(listContainers()).resolves.toEqual([]);

    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it('does not run compose ps for a bomb selected by the project .env', async () => {
    await writeStackFile('compose.yaml', SAFE_COMPOSE);
    await writeStackFile('selected.yaml', nestedAliasBomb(12));
    await writeStackFile('.env', 'COMPOSE_FILE=selected.yaml\n');

    await expect(listContainers()).resolves.toEqual([]);

    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it('does not run compose ps for a bomb in an include dependency', async () => {
    await writeStackFile('compose.yaml', 'include:\n  - dep.yaml\nservices:\n  web:\n    image: nginx:alpine\n');
    await writeStackFile('dep.yaml', nestedAliasBomb(12));

    await expect(listContainers()).resolves.toEqual([]);

    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it('does not run compose ps for an include of a device', async () => {
    await writeStackFile('compose.yaml', 'include:\n  - /dev/zero\n');

    await expect(listContainers()).resolves.toEqual([]);

    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it('logs the refusal so the empty result is not silent', async () => {
    await writeStackFile('compose.yaml', nestedAliasBomb(12));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await DockerController.getInstance(1).getContainersByStack('stack');

    const logged = errSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
    expect(logged).toContain('nested YAML aliases');
    errSpy.mockRestore();
  });

  it('still runs compose ps for an ordinary stack', async () => {
    await writeStackFile('compose.yaml', SAFE_COMPOSE);

    await listContainers();

    expect(mockExecFileAsync).toHaveBeenCalled();
  });
});
