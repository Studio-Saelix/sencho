/**
 * Local presence is per platform.
 *
 * The defect these cover: `localImageExists` asked only whether the reference
 * was in the local store. A ref present as another platform's child made the
 * gate treat the service as installed, while Compose fetched the requested
 * child at `up` and ran an image nothing had scanned.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const dockerStub = vi.hoisted(() => ({ inspect: vi.fn(), getImage: vi.fn() }));

vi.mock('../services/DockerController', () => ({
  default: {
    getInstance: () => ({
      getDocker: () => ({
        getImage: (ref: string) => {
          dockerStub.getImage(ref);
          return { inspect: dockerStub.inspect };
        },
      }),
    }),
  },
}));

import { localImageExists } from '../services/candidateImage';

const ARM64 = { os: 'linux', architecture: 'arm64' };
const AMD64 = { os: 'linux', architecture: 'amd64' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('localImageExists', () => {
  it('is false when the ref exists only as another platform child', async () => {
    dockerStub.inspect.mockResolvedValue({ Os: 'linux', Architecture: 'arm64' });

    expect(await localImageExists(1, 'alpine:3.20', AMD64)).toBe(false);
    expect(await localImageExists(1, 'alpine:3.20', ARM64)).toBe(true);
    expect(dockerStub.getImage).toHaveBeenCalledWith('alpine:3.20');
  });

  it('compares canonical platform names', async () => {
    dockerStub.inspect.mockResolvedValue({ Os: 'linux', Architecture: 'aarch64' });

    expect(await localImageExists(1, 'alpine:3.20', ARM64)).toBe(true);
  });

  it('treats an unreadable local platform as absent, the fail-closed reading', async () => {
    dockerStub.inspect.mockResolvedValue({ Os: '', Architecture: '' });

    expect(await localImageExists(1, 'alpine:3.20', AMD64)).toBe(false);
  });

  it('distinguishes variants of the same OS and architecture', async () => {
    dockerStub.inspect.mockResolvedValue({ Os: 'linux', Architecture: 'arm', Variant: 'v6' });
    const v6 = { os: 'linux', architecture: 'arm', variant: 'v6' };
    const v7 = { os: 'linux', architecture: 'arm', variant: 'v7' };

    expect(await localImageExists(1, 'alpine:3.20', v7)).toBe(false);
    expect(await localImageExists(1, 'alpine:3.20', v6)).toBe(true);
  });

  it('treats a variant-bearing request as absent when the local image reports none', async () => {
    dockerStub.inspect.mockResolvedValue({ Os: 'linux', Architecture: 'arm' });

    expect(await localImageExists(1, 'alpine:3.20', { os: 'linux', architecture: 'arm', variant: 'v7' })).toBe(false);
  });

  it('compares a bare architecture against the default variant Compose selects', async () => {
    // `platform: arm` is the default arm variant (v7), so a local v6 child is
    // not the image the operation will run.
    dockerStub.inspect.mockResolvedValue({ Os: 'linux', Architecture: 'arm', Variant: 'v6' });
    expect(await localImageExists(1, 'alpine:3.20', { os: 'linux', architecture: 'arm' })).toBe(false);

    dockerStub.inspect.mockResolvedValue({ Os: 'linux', Architecture: 'arm', Variant: 'v7' });
    expect(await localImageExists(1, 'alpine:3.20', { os: 'linux', architecture: 'arm' })).toBe(true);
  });

  it('keeps the ref-level answer when no platform is asked for', async () => {
    dockerStub.inspect.mockResolvedValue({ Os: 'linux', Architecture: 'arm64' });

    expect(await localImageExists(1, 'alpine:3.20')).toBe(true);
  });

  it('is false when the image is absent', async () => {
    dockerStub.inspect.mockRejectedValue(new Error('no such image'));

    expect(await localImageExists(1, 'alpine:3.20', AMD64)).toBe(false);
  });
});
