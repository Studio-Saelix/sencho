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

  it('surfaces loose-root and nested files and skips directories already a stack', async () => {
    const candidates = await FileSystemService.getInstance().findImportCandidates();

    // immich is a top-level subdir with a compose file, so it is already a stack
    // (it shows in the sidebar) and is not offered as an import candidate.
    expect(candidates.some((c) => c.name === 'immich')).toBe(false);

    const loose = candidates.find((c) => c.status === 'loose-root');
    expect(loose).toMatchObject({ name: '', composeFile: 'docker-compose.yml', location: 'docker-compose.yml' });
    expect(loose?.content).toContain('services:');

    const nested = candidates.find((c) => c.status === 'nested');
    expect(nested).toMatchObject({ name: 'vault', composeFile: 'compose.yaml', location: 'apps/vault/compose.yaml' });

    // The directory with only a README produced no candidate.
    expect(candidates.some((c) => c.name === 'notes')).toBe(false);
    expect(candidates).toHaveLength(2);
  });

  it('flags oversized compose files instead of reading them', async () => {
    // Nested under a wrapper with no top-level compose, so the scan descends and
    // surfaces the inner file (a top-level dir with a compose file is a stack and
    // would be skipped).
    const bigDir = path.join(tmpRoot, 'oversized-wrap', 'big');
    fs.mkdirSync(bigDir, { recursive: true });
    fs.writeFileSync(path.join(bigDir, 'compose.yaml'), 'x'.repeat(1_048_577));
    try {
      const candidates = await FileSystemService.getInstance().findImportCandidates();
      const big = candidates.find((c) => c.name === 'big');
      expect(big?.status).toBe('nested');
      expect(big?.oversized).toBe(true);
      expect(big?.content).toBeNull();
    } finally {
      fs.rmSync(path.join(tmpRoot, 'oversized-wrap'), { recursive: true, force: true });
    }
  });

  it('skips a non-regular file (a directory named compose.yaml) without reading it', async () => {
    // A directory named compose.yaml passes the access() probe; the isFile()
    // guard means it is reported as unreadable rather than read as content.
    // Nested under a wrapper so it surfaces as a candidate at all.
    const weirdDir = path.join(tmpRoot, 'weird-wrap', 'weird');
    fs.mkdirSync(path.join(weirdDir, 'compose.yaml'), { recursive: true });
    try {
      const candidates = await FileSystemService.getInstance().findImportCandidates();
      const weird = candidates.find((c) => c.name === 'weird');
      expect(weird).toBeDefined();
      expect(weird?.content).toBeNull();
      expect(weird?.oversized).toBe(false);
    } finally {
      fs.rmSync(path.join(tmpRoot, 'weird-wrap'), { recursive: true, force: true });
    }
  });

  it('does not read a compose file that symlinks outside the compose directory', async () => {
    // Sibling of the temp compose root, i.e. outside the base dir.
    const outside = path.join(path.dirname(tmpRoot), `sencho-outside-${Date.now()}.yaml`);
    fs.writeFileSync(outside, COMPOSE);
    // Nested under a wrapper so the symlinked compose file surfaces as a candidate.
    const escDir = path.join(tmpRoot, 'escape-wrap', 'escape');
    fs.mkdirSync(escDir, { recursive: true });
    let linked = true;
    try {
      fs.symlinkSync(outside, path.join(escDir, 'compose.yaml'));
    } catch {
      // Creating symlinks needs privilege on some platforms; the assertion below
      // runs for real on the Linux CI runners.
      linked = false;
    }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      if (!linked) return;
      const candidates = await FileSystemService.getInstance().findImportCandidates();
      const esc = candidates.find((c) => c.name === 'escape');
      expect(esc).toBeDefined();
      expect(esc?.content).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      fs.rmSync(path.join(tmpRoot, 'escape-wrap'), { recursive: true, force: true });
      fs.rmSync(outside, { force: true });
    }
  });

  it('skips a directory that is already a stack and does not descend into it', async () => {
    // A directory that is already a stack (top-level compose) and also has a
    // compose file one level deeper yields no candidates: it is skipped as an
    // existing stack, and the scan does not descend into it to surface the child.
    const dir = path.join(tmpRoot, 'both');
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'compose.yaml'), COMPOSE);
    fs.writeFileSync(path.join(dir, 'sub', 'compose.yaml'), COMPOSE);
    try {
      const candidates = await FileSystemService.getInstance().findImportCandidates();
      const fromBoth = candidates.filter((c) => c.location.startsWith('both/'));
      expect(fromBoth).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('truncates at maxCandidates', async () => {
    // Base fixtures yield 2 candidates (loose-root + nested); add a third loose
    // file so a cap of 2 actually truncates rather than coincidentally matching.
    fs.writeFileSync(path.join(tmpRoot, 'compose.yaml'), COMPOSE);
    try {
      const candidates = await FileSystemService.getInstance().findImportCandidates(2);
      expect(candidates).toHaveLength(2);
    } finally {
      fs.rmSync(path.join(tmpRoot, 'compose.yaml'), { force: true });
    }
  });
});
