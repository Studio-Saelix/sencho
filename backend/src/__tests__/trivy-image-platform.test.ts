/**
 * The `trivy image` argument vector names the platform child to read.
 *
 * A multi-platform image store can hold more than one child under one tag, and
 * Trivy otherwise scans the daemon's default child. An installed entry for a
 * non-pulling platform group must select that group's child; a candidate is
 * already addressed by its own manifest digest and must not get the selector.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface ExecFileCall {
  file: string;
  args: string[];
}

const execFileCalls: ExecFileCall[] = [];
const DIGEST = `sha256:${'e'.repeat(64)}`;

vi.mock('child_process', () => {
  const execFile = () => undefined;
  (execFile as unknown as Record<symbol, unknown>)[
    Symbol.for('nodejs.util.promisify.custom')
  ] = async (file: string, args: string[]) => {
    execFileCalls.push({ file, args });
    return { stdout: JSON.stringify({ Results: [] }), stderr: '' };
  };
  return { execFile };
});

vi.mock('../services/DockerController', () => ({
  default: {
    getInstance: () => ({
      getDocker: () => ({
        getImage: () => ({
          inspect: async () => ({
            RepoDigests: [`registry.example.com/web@${DIGEST}`],
            Os: 'linux',
            Architecture: 'arm64',
          }),
        }),
      }),
    }),
  },
}));

vi.mock('../services/DatabaseService', () => ({
  DatabaseService: {
    getInstance: () => ({
      getRegistries: () => [],
      getLatestScanByDigest: () => null,
    }),
  },
}));

import TrivyService from '../services/TrivyService';

function forceBinary(svc: TrivyService): void {
  const internals = svc as unknown as { binaryPath: string | null; version: string | null; source: string };
  internals.binaryPath = '/fake/trivy';
  internals.version = '0.70.0';
  internals.source = 'managed';
}

beforeEach(() => {
  execFileCalls.length = 0;
  forceBinary(TrivyService.getInstance());
});

describe('trivy image platform selector', () => {
  it('passes the installed child platform so the scan reads that child', async () => {
    await TrivyService.getInstance().scanImage('registry.example.com/web:1.2', 1, {
      platform: 'linux/arm/v7',
    });

    expect(execFileCalls).toHaveLength(1);
    const args = execFileCalls[0].args;
    expect(args[args.indexOf('--platform') + 1]).toBe('linux/arm/v7');
    expect(args.at(-1)).toBe('registry.example.com/web:1.2');
  });

  it('leaves a candidate addressed by digest without the selector', async () => {
    await TrivyService.getInstance().scanImage('registry.example.com/web:1.2', 1, {
      scanRef: `registry.example.com/web@${DIGEST}`,
      digest: DIGEST,
      platform: 'linux/amd64',
    });

    expect(execFileCalls).toHaveLength(1);
    expect(execFileCalls[0].args).not.toContain('--platform');
    expect(execFileCalls[0].args.at(-1)).toBe(`registry.example.com/web@${DIGEST}`);
  });
});
