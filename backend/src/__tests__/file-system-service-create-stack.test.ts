/**
 * Tests for FileSystemService.createStack().
 *
 * Runs against a real tmpdir-backed compose root so the template is read
 * from actual on-disk bytes (not a writeFile spy). Locks in the default
 * Empty template shape: a minimal nginx skeleton with the host port
 * binding commented out so a fresh deploy never collides with whatever
 * already owns the host's port 8080.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { parse as parseYaml } from 'yaml';

const mockState = { composeDir: '' };

vi.mock('../services/NodeRegistry', () => ({
  NodeRegistry: {
    getInstance: () => ({
      getComposeDir: () => mockState.composeDir,
      getDefaultNodeId: () => 1,
    }),
  },
}));

import { FileSystemService } from '../services/FileSystemService';
import { DatabaseService } from '../services/DatabaseService';

describe('FileSystemService.createStack', () => {
  let tmpBase: string;

  beforeEach(async () => {
    tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'sencho-create-stack-'));
    mockState.composeDir = tmpBase;
  });

  afterEach(async () => {
    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  async function createAndRead(name: string): Promise<{ text: string; parsed: unknown }> {
    await FileSystemService.getInstance().createStack(name);
    const text = await fs.readFile(path.join(tmpBase, name, 'compose.yaml'), 'utf-8');
    return { text, parsed: parseYaml(text) };
  }

  it('creates the stack directory under the compose root', async () => {
    await FileSystemService.getInstance().createStack('alpha');
    const stat = await fs.stat(path.join(tmpBase, 'alpha'));
    expect(stat.isDirectory()).toBe(true);
  });

  it('writes a compose.yaml file inside the stack directory', async () => {
    await FileSystemService.getInstance().createStack('bravo');
    const stat = await fs.stat(path.join(tmpBase, 'bravo', 'compose.yaml'));
    expect(stat.isFile()).toBe(true);
  });

  it('writes a YAML document that parses as a service map with image and restart', async () => {
    const { parsed } = await createAndRead('charlie');
    expect(parsed).toMatchObject({
      services: {
        app: {
          image: 'nginx:latest',
          restart: 'always',
        },
      },
    });
  });

  it('ships the ports block commented out (no live host port binding)', async () => {
    const { parsed } = await createAndRead('delta');
    const services = (parsed as { services?: { app?: { ports?: unknown } } }).services;
    expect(services?.app?.ports).toBeUndefined();
  });

  it('preserves a commented ports hint so the user can uncomment without re-typing the structure', async () => {
    const { text } = await createAndRead('echo');
    expect(text).toMatch(/^[ \t]*#[ \t]*ports:[ \t]*$/m);
    expect(text).toMatch(/^[ \t]*#[ \t]*-[ \t]*"8080:80"[ \t]*$/m);
  });

  it('includes a one-line hint above the commented block explaining what to uncomment', async () => {
    const { text } = await createAndRead('foxtrot');
    expect(text).toMatch(/^[ \t]*#[ \t]+Uncomment to expose a host port:[ \t]*$/m);
  });

  it('contains live (uncommented) configuration so the template is not entirely commented out', async () => {
    const { text } = await createAndRead('golf');
    expect(text).toMatch(/^[ \t]*image:[ \t]+nginx:latest[ \t]*$/m);
    expect(text).toMatch(/^[ \t]*restart:[ \t]+always[ \t]*$/m);
  });

  it('rejects creation when the stack directory already exists', async () => {
    await FileSystemService.getInstance().createStack('hotel');
    await expect(FileSystemService.getInstance().createStack('hotel')).rejects.toThrow(/already exists/);
  });
});

describe('FileSystemService.ensureStackDir', () => {
  let tmpBase: string;

  beforeEach(async () => {
    tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'sencho-ensure-stack-'));
    mockState.composeDir = tmpBase;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  it('creates the stack directory without publishing a compose file', async () => {
    const created = await FileSystemService.getInstance().ensureStackDir('restored');

    expect(created).toBe(true);
    const stat = await fs.stat(path.join(tmpBase, 'restored'));
    expect(stat.isDirectory()).toBe(true);
    await expect(fs.access(path.join(tmpBase, 'restored', 'compose.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports an existing directory without touching its files', async () => {
    const stackDir = path.join(tmpBase, 'present');
    await fs.mkdir(stackDir);
    await fs.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n');

    const created = await FileSystemService.getInstance().ensureStackDir('present');

    expect(created).toBe(false);
    expect(await fs.readFile(path.join(stackDir, 'compose.yaml'), 'utf-8')).toBe('services: {}\n');
  });

  it('refuses to restore a stack while a deletion is in progress', async () => {
    vi.spyOn(DatabaseService.getInstance(), 'hasBlockingDeletionIntent').mockReturnValue(true);

    await expect(FileSystemService.getInstance().ensureStackDir('deleting'))
      .rejects.toMatchObject({ code: 'stack_deletion_in_progress' });
    await expect(fs.access(path.join(tmpBase, 'deleting'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a stack name that escapes the compose root', async () => {
    await expect(FileSystemService.getInstance().ensureStackDir('../escape'))
      .rejects.toMatchObject({ code: 'INVALID_STACK_NAME' });
  });
});
