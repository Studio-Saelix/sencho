/**
 * Tests for ComposeDiscoveryService.probeComposeDiscovery and
 * FileSystemService.countImportCandidates.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { probeComposeDiscovery } from '../services/ComposeDiscoveryService';
import { FileSystemService } from '../services/FileSystemService';

const { tmpRoot } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeOs = require('os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require('path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require('fs');
  const tmpRoot: string = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'sencho-discovery-'));
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

const COMPOSE = 'services:\n  app:\n    image: nginx:1.27\n';

describe('probeComposeDiscovery', () => {
  beforeAll(() => {
    fs.mkdirSync(path.join(tmpRoot, 'existing'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'existing', 'compose.yaml'), COMPOSE);
    fs.writeFileSync(path.join(tmpRoot, 'docker-compose.yml'), COMPOSE);
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns readable discovery with stack and adopt counts', async () => {
    const probe = await probeComposeDiscovery(1);
    expect(probe.readable).toBe(true);
    if (!probe.readable) return;
    expect(probe.composeDir).toBe(tmpRoot);
    expect(probe.discovery.stackCount).toBe(1);
    expect(probe.discovery.adoptCandidateCount).toBe(1);
    expect(probe.discovery.adoptCandidatesTruncated).toBe(false);
  });

});

describe('FileSystemService.countImportCandidates', () => {
  it('matches findImportCandidates length when under the cap', async () => {
    const listed = await FileSystemService.getInstance().findImportCandidates();
    const counted = await FileSystemService.getInstance().countImportCandidates(100);
    expect(counted.count).toBe(listed.length);
    expect(counted.truncated).toBe(false);
  });

  it('sets truncated only when more than maxCandidates exist', async () => {
    const wrap = path.join(tmpRoot, 'trunc-wrap');
    fs.mkdirSync(wrap, { recursive: true });
    try {
      for (let i = 0; i < 101; i++) {
        const dir = path.join(wrap, `c${i}`);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'compose.yaml'), COMPOSE);
      }
      const at100 = await FileSystemService.getInstance().countImportCandidates(100);
      expect(at100.count).toBe(100);
      expect(at100.truncated).toBe(true);
    } finally {
      fs.rmSync(wrap, { recursive: true, force: true });
    }
  });
});
