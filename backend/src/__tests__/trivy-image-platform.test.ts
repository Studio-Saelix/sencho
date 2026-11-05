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
const OTHER_DIGEST = `sha256:${'4'.repeat(64)}`;

const state = vi.hoisted(() => ({
  calls: [] as ExecFileCall[],
  local: null as null | {
    RepoDigests?: string[];
    Os?: string;
    Architecture?: string;
    Variant?: string;
    Id?: string;
    Identity?: unknown;
  },
  /** Force the platform the fake Trivy report claims, regardless of the selector. */
  forcedReadArchitecture: null as string | null,
  /** Force the variant in the fake report; null omits it, as Trivy often does. */
  forcedReadVariant: null as string | null,
  /** Omit ImageConfig entirely, as a report that names no image platform would. */
  omitImageConfig: false,
  cached: null as null | Record<string, unknown>,
  cacheLookups: 0,
}));

vi.mock('child_process', () => {
  const execFile = () => undefined;
  (execFile as unknown as Record<symbol, unknown>)[
    Symbol.for('nodejs.util.promisify.custom')
  ] = async (file: string, args: string[]) => {
    state.calls.push({ file, args });
    // The real Docker source ignores --platform. Only the remote source honours
    // it, so the fake must too: a local scan that wrongly passed the selector
    // would otherwise look like it read the requested child.
    const sourceIndex = args.indexOf('--image-src');
    const usesRemote = sourceIndex >= 0 && args[sourceIndex + 1] === 'remote';
    const platformIndex = usesRemote ? args.indexOf('--platform') : -1;
    const selected = platformIndex >= 0 ? args[platformIndex + 1].split('/')[1] : null;
    const architecture = state.forcedReadArchitecture
      ?? selected
      ?? state.local?.Architecture
      ?? 'arm64';
    return {
      stdout: JSON.stringify({
        ...(state.omitImageConfig
          ? {}
          : {
              Metadata: {
                ImageConfig: {
                  os: 'linux',
                  architecture,
                  ...(state.forcedReadVariant ? { variant: state.forcedReadVariant } : {}),
                },
              },
            }),
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
      getAllVulnerabilityDetails: () => [],
      getSecretFindings: () => ({ items: [] }),
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
  state.forcedReadVariant = null;
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
    // An installed entry that names a platform is scanned fresh: a row under
    // this digest and platform may have been written for another child before
    // the local ref could select one.
    expect(state.cacheLookups).toBe(0);
  });

  it('does not let a cached row answer an installed platform scan', async () => {
    state.cached = {
      id: 99,
      platform: 'linux/arm64',
      scanned_at: Date.now(),
      total_vulnerabilities: 0,
      critical_count: 0,
      high_count: 0,
      medium_count: 0,
      low_count: 0,
      unknown_count: 0,
      fixable_count: 0,
      secret_count: 0,
      scanners_used: 'vuln',
      highest_severity: 'LOW',
      os_info: 'alpine 3.20.10',
      trivy_version: '0.76.1',
      scan_duration_ms: 10,
      vuln_db_updated_at: null,
    };

    const result = await TrivyService.getInstance().scanImage('registry.example.com/web:1.2', 1, {
      platform: 'linux/arm64',
    });

    expect(state.cacheLookups).toBe(0);
    expect(result.fromCache).toBeUndefined();
    expect(state.calls).toHaveLength(1);
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

  it('uses the repo digest that belongs to this reference, not one left from a retag', async () => {
    state.local = {
      RepoDigests: [
        `other.example.com/other@${OTHER_DIGEST}`,
        `registry.example.com/web@${INDEX_DIGEST}`,
      ],
      Os: 'linux',
      Architecture: 'arm64',
    };

    const result = await TrivyService.getInstance().scanImage('registry.example.com/web:1.2', 1, {
      platform: 'linux/amd64',
    });

    expect(state.calls).toHaveLength(1);
    expect(lastArg(state.calls[0])).toBe(`registry.example.com/web@${INDEX_DIGEST}`);
    expect(result.imageDigest).toBe(INDEX_DIGEST);
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

  it('treats a local variant as a different child', async () => {
    state.local = {
      RepoDigests: [`registry.example.com/web@${INDEX_DIGEST}`],
      Os: 'linux',
      Architecture: 'arm',
      Variant: 'v6',
    };

    // The daemon holds v6; asking for v7 must read the registry child.
    const nonDefault = await TrivyService.getInstance().scanImage('registry.example.com/web:1.2', 1, {
      platform: 'linux/arm/v7',
    });
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].args[state.calls[0].args.indexOf('--image-src') + 1]).toBe('remote');
    expect(nonDefault.platform).toBe('linux/arm');

    // Asking for the child the daemon holds stays local.
    state.calls.length = 0;
    await TrivyService.getInstance().scanImage('registry.example.com/web:1.2', 1, {
      platform: 'linux/arm/v6',
    });
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].args).not.toContain('--image-src');
  });

  it('refuses a scan that read another child instead of filing it under the requested platform', async () => {
    state.forcedReadArchitecture = 'arm64';

    await expect(
      TrivyService.getInstance().scanImage('registry.example.com/web:1.2', 1, {
        platform: 'linux/amd64',
      }),
    ).rejects.toThrow(/scanned linux\/arm64 .* not linux\/amd64/);
  });

  it('refuses a report that names a different variant', async () => {
    state.forcedReadArchitecture = 'arm';
    state.forcedReadVariant = 'v6';

    await expect(
      TrivyService.getInstance().scanImage('registry.example.com/web:1.2', 1, {
        platform: 'linux/arm/v7',
      }),
    ).rejects.toThrow(/scanned linux\/arm\/v6 .* not linux\/arm\/v7/);
  });

  it('accepts a report that names the requested variant', async () => {
    state.forcedReadArchitecture = 'arm';
    state.forcedReadVariant = 'v7';

    const result = await TrivyService.getInstance().scanImage('registry.example.com/web:1.2', 1, {
      platform: 'linux/arm/v7',
    });

    expect(result.platform).toBe('linux/arm');
  });

  it('refuses a reported non-default variant when a bare architecture asks for the default', async () => {
    // A service with no platform override asks for the node platform, which is
    // the architecture's default variant (arm is v7). A v6 report is another
    // child even though the requested label has no variant segment.
    state.forcedReadArchitecture = 'arm';
    state.forcedReadVariant = 'v6';

    await expect(
      TrivyService.getInstance().scanImage('registry.example.com/web:1.2', 1, {
        platform: 'linux/arm',
      }),
    ).rejects.toThrow(/scanned linux\/arm\/v6 .* not linux\/arm/);
  });

  it('keys a local-match installed scan by the matching repo digest, not a leftover one', async () => {
    state.local = {
      RepoDigests: [
        `other.example.com/other@${OTHER_DIGEST}`,
        `registry.example.com/web@${INDEX_DIGEST}`,
      ],
      Os: 'linux',
      Architecture: 'arm64',
    };

    const result = await TrivyService.getInstance().scanImage('registry.example.com/web:1.2', 1, {
      platform: 'linux/arm64',
    });

    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].args).not.toContain('--image-src');
    expect(result.imageDigest).toBe(INDEX_DIGEST);
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

  it('does not address a local build by the RepoDigest that repeats its config ID', async () => {
    // The containerd image store records a local build's own config ID as a
    // self-referential RepoDigest. Treating that as a registry digest sent the
    // image to Docker Hub, which answered UNAUTHORIZED instead of the intended
    // "no registry digest" failure for a child the node cannot provide.
    const configId = `sha256:${'5'.repeat(64)}`;
    state.local = {
      Id: configId,
      Identity: { Build: [{ Ref: 'buildkit-ref' }] },
      RepoDigests: [`registry.example.com/web@${configId}`],
      Os: 'linux',
      Architecture: 'arm64',
    };

    await expect(
      TrivyService.getInstance().scanImage('registry.example.com/web:1.2', 1, {
        platform: 'linux/amd64',
      }),
    ).rejects.toThrow(/no registry digest/);
    expect(state.calls).toHaveLength(0);
  });

  it('addresses a pulled containerd image by its RepoDigest even when the ID matches it', async () => {
    // On the containerd image store a pulled image's Id is the registry
    // manifest/index digest, so it equals the RepoDigest. That is registry
    // content and must still be scanned remotely for the requested child.
    state.local = {
      Id: INDEX_DIGEST,
      Identity: { Pull: [{ Repository: 'registry.example.com/web' }] },
      RepoDigests: [`registry.example.com/web@${INDEX_DIGEST}`],
      Os: 'linux',
      Architecture: 'arm64',
    };

    const result = await TrivyService.getInstance().scanImage('registry.example.com/web:1.2', 1, {
      platform: 'linux/amd64',
    });

    expect(state.calls).toHaveLength(1);
    const call = state.calls[0];
    expect(call.args[call.args.indexOf('--image-src') + 1]).toBe('remote');
    expect(call.args[call.args.indexOf('--platform') + 1]).toBe('linux/amd64');
    expect(lastArg(call)).toBe(`registry.example.com/web@${INDEX_DIGEST}`);
    expect(result.imageDigest).toBe(INDEX_DIGEST);
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
