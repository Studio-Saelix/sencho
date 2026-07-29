import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../services/DatabaseService';
import SelfIdentityService from '../services/SelfIdentityService';
import type { DependencyContainer } from '../services/DockerController';
import { resolveManagedMeshAttachment } from '../services/network/managedMeshAttachment';

const originalDataDir = process.env.DATA_DIR;
const originalMode = process.env.SENCHO_MODE;
let tempDir: string | null = null;

function runtimeContainer(overrides: Partial<DependencyContainer> = {}): DependencyContainer {
  return {
    id: 'app-id',
    name: 'app-web-1',
    service: 'web',
    composeProject: 'app',
    stack: 'app',
    state: 'running',
    exitCode: null,
    image: 'nginx:latest',
    networks: [],
    volumes: [],
    ports: [],
    ...overrides,
  };
}

function stubAuthorities(meshStackEnabled: boolean, ownContainers: string[] = []): void {
  vi.spyOn(DatabaseService, 'getInstance').mockReturnValue({
    isMeshStackEnabled: vi.fn().mockReturnValue(meshStackEnabled),
  } as unknown as DatabaseService);
  vi.spyOn(SelfIdentityService, 'getInstance').mockReturnValue({
    isOwnContainer: vi.fn((idOrName: string) => ownContainers.includes(idOrName)),
  } as unknown as SelfIdentityService);
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalMode === undefined) delete process.env.SENCHO_MODE;
  else process.env.SENCHO_MODE = originalMode;
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('resolveManagedMeshAttachment', () => {
  it('authorizes the canonical Mesh attachment for a centrally opted-in stack', async () => {
    process.env.SENCHO_MODE = 'server';
    stubAuthorities(true);
    const isManaged = await resolveManagedMeshAttachment(1, 'app');

    expect(isManaged(runtimeContainer(), 'sencho_mesh')).toBe(true);
    expect(isManaged(runtimeContainer(), 'sencho_extra')).toBe(false);
  });

  it('authorizes the canonical Mesh attachment for the actual Sencho container', async () => {
    process.env.SENCHO_MODE = 'server';
    stubAuthorities(false, ['sencho-id']);
    const isManaged = await resolveManagedMeshAttachment(1, 'sencho');

    expect(isManaged(runtimeContainer({ id: 'sencho-id', name: 'sencho' }), 'sencho_mesh')).toBe(true);
    expect(isManaged(runtimeContainer(), 'sencho_mesh')).toBe(false);
  });

  it('keeps a manual Mesh attachment actionable for an opted-out stack', async () => {
    process.env.SENCHO_MODE = 'server';
    stubAuthorities(false);
    const isManaged = await resolveManagedMeshAttachment(1, 'app');

    expect(isManaged(runtimeContainer(), 'sencho_mesh')).toBe(false);
  });

  it('uses Pilot override presence as the authoritative opt-in representation', async () => {
    process.env.SENCHO_MODE = 'pilot';
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sencho-mesh-drift-'));
    process.env.DATA_DIR = tempDir;
    const overrideDir = path.join(tempDir, 'mesh', 'overrides', '7');
    await fs.mkdir(overrideDir, { recursive: true });
    await fs.writeFile(path.join(overrideDir, 'app.override.yml'), 'services: {}\n');
    stubAuthorities(false);

    const isManaged = await resolveManagedMeshAttachment(7, 'app');

    expect(isManaged(runtimeContainer(), 'sencho_mesh')).toBe(true);
  });

  it('does not let stale server override presence supersede opted-out DB state', async () => {
    process.env.SENCHO_MODE = 'server';
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sencho-mesh-drift-'));
    process.env.DATA_DIR = tempDir;
    const overrideDir = path.join(tempDir, 'mesh', 'overrides', '1');
    await fs.mkdir(overrideDir, { recursive: true });
    await fs.writeFile(path.join(overrideDir, 'app.override.yml'), 'services: {}\n');
    stubAuthorities(false);

    const isManaged = await resolveManagedMeshAttachment(1, 'app');

    expect(isManaged(runtimeContainer(), 'sencho_mesh')).toBe(false);
  });

  it('fails closed when Mesh opt-in state cannot be read', async () => {
    process.env.SENCHO_MODE = 'server';
    vi.spyOn(DatabaseService, 'getInstance').mockImplementation(() => {
      throw new Error('database unavailable');
    });
    vi.spyOn(SelfIdentityService, 'getInstance').mockReturnValue({
      isOwnContainer: vi.fn().mockReturnValue(false),
    } as unknown as SelfIdentityService);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const isManaged = await resolveManagedMeshAttachment(1, 'app');

    expect(isManaged(runtimeContainer(), 'sencho_mesh')).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      '[NetworkDrift] Could not verify Mesh opt-in state for %s:',
      'app',
      'database unavailable',
    );
  });
});
