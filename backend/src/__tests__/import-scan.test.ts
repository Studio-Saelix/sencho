/**
 * Tests for FileSystemService.findImportCandidates: the read-only compose-dir
 * walk behind the guided import scan. Uses a real temp directory so the nesting
 * and placement-status logic is exercised against the actual filesystem.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const { tmpRoot } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeOs = require('os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require('path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require('fs');
  const tmpRoot: string = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'sencho-import-'));
  return { tmpRoot };
});

vi.mock('../services/NodeRegistry', () => ({
  NodeRegistry: {
    getInstance: () => ({
      getComposeDir: () => tmpRoot,
      getDefaultNodeId: () => 1,
    }),
  },
}));

import { FileSystemService } from '../services/FileSystemService';

const COMPOSE = 'services:\n  app:\n    image: nginx:1.27\n';

describe('FileSystemService.findImportCandidates', () => {
  beforeAll(() => {
    // Already a stack: top-level subdir with a compose file.
    fs.mkdirSync(path.join(tmpRoot, 'immich'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'immich', 'compose.yaml'), COMPOSE);
    // Loose at the root: will not auto-register.
    fs.writeFileSync(path.join(tmpRoot, 'docker-compose.yml'), COMPOSE);
    // One directory too deep: apps/ has no compose, apps/vault/ does.
    fs.mkdirSync(path.join(tmpRoot, 'apps', 'vault'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'apps', 'vault', 'compose.yaml'), COMPOSE);
    // A directory with no compose file at all: ignored.
    fs.mkdirSync(path.join(tmpRoot, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'notes', 'README.md'), '# notes');
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('classifies listed, loose-root, and nested compose files and ignores the rest', async () => {
    const candidates = await FileSystemService.getInstance().findImportCandidates();

    const listed = candidates.find((c) => c.status === 'listed');
    expect(listed).toMatchObject({ name: 'immich', composeFile: 'compose.yaml', location: 'immich/compose.yaml' });
    expect(listed?.content).toContain('services:');

    const loose = candidates.find((c) => c.status === 'loose-root');
    expect(loose).toMatchObject({ name: '', composeFile: 'docker-compose.yml', location: 'docker-compose.yml' });

    const nested = candidates.find((c) => c.status === 'nested');
    expect(nested).toMatchObject({ name: 'vault', composeFile: 'compose.yaml', location: 'apps/vault/compose.yaml' });

    // The directory with only a README produced no candidate.
    expect(candidates.some((c) => c.name === 'notes')).toBe(false);
    expect(candidates).toHaveLength(3);
  });

  it('flags oversized compose files instead of reading them', async () => {
    const bigDir = path.join(tmpRoot, 'big');
    fs.mkdirSync(bigDir, { recursive: true });
    fs.writeFileSync(path.join(bigDir, 'compose.yaml'), 'x'.repeat(1_048_577));
    try {
      const candidates = await FileSystemService.getInstance().findImportCandidates();
      const big = candidates.find((c) => c.name === 'big');
      expect(big?.oversized).toBe(true);
      expect(big?.content).toBeNull();
    } finally {
      fs.rmSync(bigDir, { recursive: true, force: true });
    }
  });

  it('reports content: null (not oversized) and logs when a candidate cannot be read', async () => {
    // A directory named compose.yaml passes the access() probe but fails the
    // readFile (EISDIR), exercising the read-error branch deterministically.
    const weirdDir = path.join(tmpRoot, 'weird');
    fs.mkdirSync(path.join(weirdDir, 'compose.yaml'), { recursive: true });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const candidates = await FileSystemService.getInstance().findImportCandidates();
      const weird = candidates.find((c) => c.name === 'weird');
      expect(weird).toBeDefined();
      expect(weird?.content).toBeNull();
      expect(weird?.oversized).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      fs.rmSync(weirdDir, { recursive: true, force: true });
    }
  });

  it('keeps the top-level listing and does not also descend into it', async () => {
    // A directory that is already a stack and also has a compose file one level
    // deeper yields only the listed entry, never the nested child.
    const dir = path.join(tmpRoot, 'both');
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'compose.yaml'), COMPOSE);
    fs.writeFileSync(path.join(dir, 'sub', 'compose.yaml'), COMPOSE);
    try {
      const candidates = await FileSystemService.getInstance().findImportCandidates();
      const fromBoth = candidates.filter((c) => c.location.startsWith('both/'));
      expect(fromBoth).toHaveLength(1);
      expect(fromBoth[0]).toMatchObject({ name: 'both', status: 'listed', location: 'both/compose.yaml' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('truncates at maxCandidates', async () => {
    const candidates = await FileSystemService.getInstance().findImportCandidates(2);
    expect(candidates).toHaveLength(2);
  });
});
