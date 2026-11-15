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

const { mockExecFileAsync, mockListContainers, composeDirRef } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
  mockListContainers: vi.fn(),
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
      getDocker: () => ({ listContainers: mockListContainers }),
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
import { ComposeExpansionRefusal } from '../helpers/composeExpansionGuard';

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
  mockListContainers.mockResolvedValue([]);
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

/** A refused stack is not an empty one: the refusal reaches the caller, and neither compose ps nor a name-matched fallback runs. */
async function expectRefused(): Promise<void> {
  await expect(listContainers()).rejects.toBeInstanceOf(ComposeExpansionRefusal);
  expect(mockExecFileAsync).not.toHaveBeenCalled();
  expect(mockListContainers).not.toHaveBeenCalled();
}

describe('DockerController compose ps uses the real guard', () => {
  it('does not run compose ps for a discovered bomb', async () => {
    await writeStackFile('compose.yaml', nestedAliasBomb(12));

    await expectRefused();
  });

  it('does not run compose ps for a bomb selected by the project .env', async () => {
    await writeStackFile('compose.yaml', SAFE_COMPOSE);
    await writeStackFile('selected.yaml', nestedAliasBomb(12));
    await writeStackFile('.env', 'COMPOSE_FILE=selected.yaml\n');

    await expectRefused();
  });

  it('does not run compose ps for a bomb in an include dependency', async () => {
    await writeStackFile('compose.yaml', 'include:\n  - dep.yaml\nservices:\n  web:\n    image: nginx:alpine\n');
    await writeStackFile('dep.yaml', nestedAliasBomb(12));

    await expectRefused();
  });

  it('does not run compose ps for an include of a device', async () => {
    await writeStackFile('compose.yaml', 'include:\n  - /dev/zero\n');

    await expectRefused();
  });

  it('hands the refusal text to the caller, so a stop or delete can say why', async () => {
    await writeStackFile('compose.yaml', nestedAliasBomb(12));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(DockerController.getInstance(1).getContainersByStack('stack'))
      .rejects.toThrow('nested YAML aliases');

    errSpy.mockRestore();
  });

  it('fails closed for the callers that classify orphans: no fallback, and the reason is kept', async () => {
    await writeStackFile('compose.yaml', nestedAliasBomb(12));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dc = DockerController.getInstance(1);

    await expect(dc.getLegacyOrphanContainersByStack('stack')).resolves.toEqual([]);
    const classified = await dc.classifyLegacyOrphansForUpdate('stack');

    expect(classified.status).toBe('classification_failed');
    expect((classified as { error: string }).error).toContain('nested YAML aliases');
    expect(mockListContainers).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('still runs compose ps for an ordinary stack', async () => {
    await writeStackFile('compose.yaml', SAFE_COMPOSE);

    await listContainers();

    expect(mockExecFileAsync).toHaveBeenCalled();
  });
});

describe('DockerController.listContainersBoundToStackDir reads the Engine without Compose', () => {
  it('returns every container Compose started from the stack directory, in any state, and runs no Compose', async () => {
    await writeStackFile('compose.yaml', nestedAliasBomb(12));
    mockListContainers.mockResolvedValue([
      { Id: 'a', Names: ['/stack-web-1'], State: 'running', Labels: { 'com.docker.compose.project': 'stack', 'com.docker.compose.project.working_dir': stackDir } },
      { Id: 'b', Names: ['/stack-old-1'], State: 'exited', Labels: { 'com.docker.compose.project': 'stack', 'com.docker.compose.project.config_files': path.join(stackDir, 'compose.yaml') } },
      // Same name shape, another directory: not this stack's.
      { Id: 'c', Names: ['/stack-web-2'], State: 'running', Labels: { 'com.docker.compose.project': 'stack', 'com.docker.compose.project.working_dir': path.join(root, 'elsewhere') } },
      // No Compose labels at all: never matched by name.
      { Id: 'd', Names: ['/stack-web-1'], State: 'running', Labels: {} },
    ]);

    const bound = await DockerController.getInstance(1).listContainersBoundToStackDir('stack');

    expect(bound).toEqual([
      { Id: 'a', Name: 'stack-web-1', State: 'running' },
      { Id: 'b', Name: 'stack-old-1', State: 'exited' },
    ]);
    expect(mockListContainers).toHaveBeenCalledWith({ all: true, filters: { label: ['com.docker.compose.project'] } });
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it('throws when the Engine cannot be listed, so "unknown" is never read as "none"', async () => {
    mockListContainers.mockRejectedValue(new Error('engine unreachable'));
    await expect(DockerController.getInstance(1).listContainersBoundToStackDir('stack')).rejects.toThrow('engine unreachable');
  });

  it('rejects a stack name that is not valid', async () => {
    await expect(DockerController.getInstance(1).listContainersBoundToStackDir('../x')).rejects.toThrow('Invalid stack path');
  });
});
