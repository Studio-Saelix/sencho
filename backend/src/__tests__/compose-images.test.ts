/**
 * Exercises ComposeService.listStackImages, the helper the policy gate calls
 * to enumerate the images a stack will pull before `docker compose up`.
 *
 * The stdout from `docker compose config --images` can contain duplicates
 * (multiple services running the same image), trailing whitespace, blank
 * lines, and `sha256:` digest lines we must not pass to Trivy. The gate
 * feeds this list directly to `scanImagePreflight`, so dedupe + filter
 * correctness here directly affects what gets scanned and what silently
 * passes through.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));

vi.mock('child_process', () => ({ spawn: mockSpawn, execFile: vi.fn() }));

vi.mock('../services/NodeRegistry', () => ({
  NodeRegistry: {
    getInstance: () => ({
      getDefaultNodeId: () => 1,
      getComposeDir: () => '/test/compose',
    }),
  },
}));

vi.mock('../services/DockerController', () => ({
  default: {
    getInstance: () => ({
      getContainersByStack: vi.fn().mockResolvedValue([]),
      removeContainers: vi.fn().mockResolvedValue([]),
      getDocker: () => ({
        listContainers: vi.fn().mockResolvedValue([]),
      }),
    }),
  },
}));

vi.mock('../services/DatabaseService', () => ({
  DatabaseService: { getInstance: () => ({ getRegistries: () => [] }) },
}));

vi.mock('../services/RegistryService', () => ({
  RegistryService: {
    getInstance: () => ({
      resolveDockerConfig: vi.fn().mockResolvedValue({ config: { auths: {} }, warnings: [] }),
    }),
  },
}));

vi.mock('../services/FileSystemService', () => ({
  FileSystemService: {
    getInstance: () => ({
      backupStackFiles: vi.fn().mockResolvedValue(undefined),
      restoreStackFiles: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

vi.mock('../services/LogFormatter', () => ({
  LogFormatter: { formatLine: (line: string) => line },
}));

import { ComposeService } from '../services/ComposeService';

function mockComposeConfig(stdout: string, exitCode = 0): void {
  mockSpawn.mockImplementation(() => {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = vi.fn();
    Promise.resolve().then(() => {
      if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
      proc.emit('close', exitCode);
    });
    return proc;
  });
}

describe('ComposeService.listStackImages', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it('returns the list of images, trimmed and deduped', async () => {
    mockComposeConfig('nginx:1.14\nredis:7\nnginx:1.14\n');

    const images = await ComposeService.getInstance(1).listStackImages('my-stack');

    expect(images).toEqual(['nginx:1.14', 'redis:7']);
  });

  it('invokes `docker compose config --images` in the stack directory', async () => {
    mockComposeConfig('nginx:1.14\n');

    await ComposeService.getInstance(1).listStackImages('my-stack');

    expect(mockSpawn).toHaveBeenCalledWith(
      'docker',
      ['compose', 'config', '--images'],
      expect.objectContaining({ cwd: expect.stringContaining('my-stack') }),
    );
  });

  it('filters out sha256 digest lines', async () => {
    mockComposeConfig('nginx:1.14\nsha256:deadbeefcafebabe\nredis:7\n');

    const images = await ComposeService.getInstance(1).listStackImages('my-stack');

    expect(images).toEqual(['nginx:1.14', 'redis:7']);
  });

  it('handles trailing / leading whitespace and CRLF endings', async () => {
    mockComposeConfig('  nginx:1.14  \r\n\r\n\tredis:7\r\n');

    const images = await ComposeService.getInstance(1).listStackImages('my-stack');

    expect(images).toEqual(['nginx:1.14', 'redis:7']);
  });

  it('returns an empty list when stdout is empty', async () => {
    mockComposeConfig('');

    const images = await ComposeService.getInstance(1).listStackImages('my-stack');

    expect(images).toEqual([]);
  });

  it('rejects stack names that traverse outside the compose base', async () => {
    await expect(
      ComposeService.getInstance(1).listStackImages('../evil'),
    ).rejects.toThrow(/Invalid stack path/);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('rejects when docker compose exits non-zero', async () => {
    mockSpawn.mockImplementation(() => {
      const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: ReturnType<typeof vi.fn>;
      };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = vi.fn();
      Promise.resolve().then(() => {
        proc.stderr.emit('data', Buffer.from('compose file missing'));
        proc.emit('close', 1);
      });
      return proc;
    });

    await expect(
      ComposeService.getInstance(1).listStackImages('my-stack'),
    ).rejects.toThrow(/compose file missing/);
  });

  it('preserves image-ref ordering for deterministic downstream scans', async () => {
    mockComposeConfig('redis:7\npostgres:15\nnginx:1.14\n');

    const images = await ComposeService.getInstance(1).listStackImages('my-stack');

    expect(images).toEqual(['redis:7', 'postgres:15', 'nginx:1.14']);
  });
});
