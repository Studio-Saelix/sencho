/**
 * An installed platform-qualified scan reads the child it names.
 *
 * `trivy image` against the Docker image source always scans the daemon's
 * default child and ignores `--platform`, so passing the selector to a local ref
 * filed the default child's findings under the requested platform. The scanner
 * must read the local ref only when the daemon reports the requested platform;
 * otherwise it reads the registry child for that platform by the image's own
 * digest, and refuses any report that describes a different platform.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface ExecFileCall {
  file: string;
  args: string[];
}

const INDEX_DIGEST = `sha256:${'1'.repeat(64)}`;
const CHILD_DIGEST = `sha256:${'2'.repeat(64)}`;
const PINNED_DIGEST = `sha256:${'3'.repeat(64)}`;

const state = vi.hoisted(() => ({
  calls: [] as ExecFileCall[],
  local: null as null | {
    RepoDigests?: string[];
    Os?: string;
    Architecture?: string;
    Id?: string;
  },
  /** Force the platform the fake Trivy report claims, regardless of the selector. */
  forcedReadArchitecture: null as string | null,
  /** Omit ImageConfig entirely, as a report that names no image platform would. */
  omitImageConfig: false,
  cached: null as null | { id: number; platform: string | null; scanned_at: number },
  cacheLookups: 0,
}));

vi.mock('child_process', () => {
  const execFile = () => undefined;
  (execFile as unknown as Record<symbol, unknown>)[
    Symbol.for('nodejs.util.promisify.custom')
  ] = async (file: string, args: string[]) => {
    state.calls.push({ file, args });
    const platformIndex = args.indexOf('--platform');
    const selected = platformIndex >= 0 ? args[platformIndex + 1].split('/')[1] : null;
    const architecture = state.forcedReadArchitecture
      ?? selected
      ?? state.local?.Architecture
      ?? 'arm64';
    return {
      stdout: JSON.stringify({
        ...(state.omitImageConfig
          ? {}
          : { Metadata: { ImageConfig: { os: 'linux', architecture } } }),
        Results: [],
      }),
      stderr: '',
    };
  };
  return { execFile };
});

vi.mock('../services/DockerController', () => ({
  default: {
    getInstance: () => ({
      getDocker: () => ({
        getImage: () => ({
          inspect: async () => {
            if (!state.local) throw new Error('No such image');
            return state.local;
          },
        }),
      }),
    }),
  },
}));

vi.mock('../services/DatabaseService', () => ({
  DatabaseService: {
    getInstance: () => ({
      getRegistries: () => [],
      getLatestScanByDigest: () => {
        state.cacheLookups += 1;
        return state.cached;
      },
    }),
  },
}));

import TrivyService from '../services/TrivyService';

function forceBinary(svc: TrivyService): void {
  const internals = svc as unknown as { binaryPath: string | null; version: string | null; source: string };
  internals.binaryPath = '/fake/trivy';
  internals.version = '0.76.1';
  internals.source = 'managed';
}

function lastArg(call: ExecFileCall): string {
  return call.args[call.args.length - 1];
}

beforeEach(() => {
  state.calls.length = 0;
  state.local = {
    RepoDigests: [`registry.example.com/web@${INDEX_DIGEST}`],
    Os: 'linux',
    Architecture: 'arm64',
  };
  state.forcedReadArchitecture = null;
  state.omitImageConfig = false;
  state.cached = null;
  state.cacheLookups = 0;
  forceBinary(TrivyService.getInstance());
});

describe('trivy image platform selection', () => {
  it('reads the local ref when the daemon exposes the requested child', async () => {
    const result = await TrivyService.getInstance().scanImage('registry.example.com/web:1.2', 1, {
      platform: 'linux/arm64',
    });

    expect(state.calls).toHaveLength(1);
    const call = state.calls[0];
    expect(call.args).not.toContain('--platform');
    expect(call.args).not.toContain('--image-src');
    expect(lastArg(call)).toBe('registry.example.com/web:1.2');
    expect(result.platform).toBe('linux/arm64');
    expect(state.cacheLookups).toBe(1);
  });

  it('reads the requested child from the registry when the daemon default is another platform', async () => {
    const result = await TrivyService.getInstance().scanImage('registry.example.com/web:1.2', 1, {
      platform: 'linux/amd64',
    });

    expect(state.calls).toHaveLength(1);
    const call = state.calls[0];
    expect(call.args[call.args.indexOf('--image-src') + 1]).toBe('remote');
    expect(call.args[call.args.indexOf('--platform') + 1]).toBe('linux/amd64');
    // The local image's own index digest, not the mutable tag: the registry
    // child is the one inside the image the node holds.
    expect(lastArg(call)).toBe(`registry.example.com/web@${INDEX_DIGEST}`);
    expect(result.platform).toBe('linux/amd64');
    // The row keeps the local image's index digest, so the evidence names the
    // image the node holds, not a moving tag.
    expect(result.imageDigest).toBe(INDEX_DIGEST);
    // A row under this key may predate the fix and describe the default child,
    // so a registry-addressed child scan never answers from the cache.
    expect(state.cacheLookups).toBe(0);
  });

  it('addresses a digest pin directly when the node holds no child for it', async () => {
    state.local = null;
    const pinned = `registry.example.com/web@${PINNED_DIGEST}`;

    const result = await TrivyService.getInstance().scanImage(pinned, 1, {
      platform: 'linux/amd64',
    });

    expect(state.calls).toHaveLength(1);
    const call = state.calls[0];
    expect(call.args[call.args.indexOf('--image-src') + 1]).toBe('remote');
    expect(call.args[call.args.indexOf('--platform') + 1]).toBe('linux/amd64');
    expect(lastArg(call)).toBe(pinned);
    expect(result.imageDigest).toBe(PINNED_DIGEST);
    expect(result.platform).toBe('linux/amd64');
  });

  it('does not select a variant child through the local daemon', async () => {
    const result = await TrivyService.getInstance().scanImage('registry.example.com/web:1.2', 1, {
      platform: 'linux/arm/v7',
    });

    expect(state.calls).toHaveLength(1);
    const call = state.calls[0];
    expect(call.args[call.args.indexOf('--image-src') + 1]).toBe('remote');
    expect(call.args[call.args.indexOf('--platform') + 1]).toBe('linux/arm/v7');
    // Trivy reports `linux/arm` without a variant for an arm/v7 child; the
    // missing variant cannot disprove the requested one.
    expect(result.platform).toBe('linux/arm');
  });

  it('refuses a scan that read another child instead of filing it under the requested platform', async () => {
    state.forcedReadArchitecture = 'arm64';

    await expect(
      TrivyService.getInstance().scanImage('registry.example.com/web:1.2', 1, {
        platform: 'linux/amd64',
      }),
    ).rejects.toThrow(/scanned linux\/arm64 .* not linux\/amd64/);
  });

  it('refuses a platform-qualified scan whose report names no platform', async () => {
    state.omitImageConfig = true;

    await expect(
      TrivyService.getInstance().scanImage('registry.example.com/web:1.2', 1, {
        platform: 'linux/arm64',
      }),
    ).rejects.toThrow(/did not report the platform/);
  });

  it('fails closed when a local tag has no registry digest to address the child by', async () => {
    state.local = { Os: 'linux', Architecture: 'arm64' };

    await expect(
      TrivyService.getInstance().scanImage('registry.example.com/web:1.2', 1, {
        platform: 'linux/amd64',
      }),
    ).rejects.toThrow(/no registry digest/);
    expect(state.calls).toHaveLength(0);
  });

  it('leaves a candidate addressed by its own manifest digest without a selector', async () => {
    // The digest-addressed ref is the amd64 child, so the report describes it.
    state.forcedReadArchitecture = 'amd64';
    const result = await TrivyService.getInstance().scanImage('registry.example.com/web:1.2', 1, {
      scanRef: `registry.example.com/web@${CHILD_DIGEST}`,
      digest: INDEX_DIGEST,
      platform: 'linux/amd64',
    });

    expect(state.calls).toHaveLength(1);
    const call = state.calls[0];
    expect(call.args).not.toContain('--platform');
    expect(call.args).not.toContain('--image-src');
    expect(lastArg(call)).toBe(`registry.example.com/web@${CHILD_DIGEST}`);
    expect(result.platform).toBe('linux/amd64');
  });

  it('refuses a candidate scan that read a different child', async () => {
    state.forcedReadArchitecture = 'arm64';

    await expect(
      TrivyService.getInstance().scanImage('registry.example.com/web:1.2', 1, {
        scanRef: `registry.example.com/web@${CHILD_DIGEST}`,
        digest: INDEX_DIGEST,
        platform: 'linux/amd64',
      }),
    ).rejects.toThrow(/scanned linux\/arm64 .* not linux\/amd64/);
  });

  it('leaves an unqualified local scan that names no child unchanged', async () => {
    const result = await TrivyService.getInstance().scanImage('registry.example.com/web:1.2', 1);

    expect(state.calls).toHaveLength(1);
    const call = state.calls[0];
    expect(call.args).not.toContain('--platform');
    expect(call.args).not.toContain('--image-src');
    expect(lastArg(call)).toBe('registry.example.com/web:1.2');
    expect(result.platform).toBe('linux/arm64');
  });
});
