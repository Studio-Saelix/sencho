/**
 * readNodePlatform must translate the architecture spelling Docker reports
 * (`uname -m` values such as `x86_64` and `aarch64`) into the OCI name that
 * registry index descriptors use (`amd64` and `arm64`). The digest resolver
 * compares the two by exact string, so the raw spelling never matches.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockDockerInfo = vi.fn();

vi.mock('../services/DockerController', () => ({
  default: {
    getInstance: () => ({
      getDocker: () => ({
        info: (...args: unknown[]) => mockDockerInfo(...args),
      }),
    }),
  },
}));

import { readNodePlatform } from '../services/gitops/effectiveArtifactContext';

describe('readNodePlatform', () => {
  beforeEach(() => {
    mockDockerInfo.mockReset();
  });

  it.each([
    ['x86_64', 'amd64'],
    ['aarch64', 'arm64'],
    ['i386', '386'],
    ['i486', '386'],
    ['i586', '386'],
    ['i686', '386'],
    ['loongarch64', 'loong64'],
  ])('reports the OCI architecture for the docker-info spelling %s', async (reported, expected) => {
    mockDockerInfo.mockResolvedValue({ OSType: 'linux', Architecture: reported });
    await expect(readNodePlatform(1)).resolves.toEqual({ os: 'linux', architecture: expected });
  });

  it('normalizes the daemon OS and maps a Windows host', async () => {
    mockDockerInfo.mockResolvedValue({ OSType: 'Windows', Architecture: 'x86_64' });
    await expect(readNodePlatform(1)).resolves.toEqual({ os: 'windows', architecture: 'amd64' });
  });

  it('keeps an architecture that is already an OCI name', async () => {
    mockDockerInfo.mockResolvedValue({ OSType: 'linux', Architecture: 'amd64' });
    await expect(readNodePlatform(1)).resolves.toEqual({ os: 'linux', architecture: 'amd64' });
  });

  it('passes an unknown architecture through rather than guessing', async () => {
    mockDockerInfo.mockResolvedValue({ OSType: 'linux', Architecture: 'mips64r2' });
    await expect(readNodePlatform(1)).resolves.toEqual({ os: 'linux', architecture: 'mips64r2' });
  });

  it('leaves 32-bit ARM spellings unmapped so the resolver fails closed', async () => {
    // OCI distinguishes arm variants and this code does not model the variant,
    // so translating armv6l/armv7l/armv8l to `arm` could qualify a child built
    // for a different ABI. They pass through and never match a descriptor.
    mockDockerInfo.mockResolvedValue({ OSType: 'linux', Architecture: 'armv7l' });
    await expect(readNodePlatform(1)).resolves.toEqual({ os: 'linux', architecture: 'armv7l' });
  });

  it('returns null when the daemon omits the platform', async () => {
    mockDockerInfo.mockResolvedValue({ OSType: 'linux' });
    await expect(readNodePlatform(1)).resolves.toBeNull();
  });

  it('returns null when the daemon cannot be read', async () => {
    mockDockerInfo.mockRejectedValue(new Error('daemon unreachable'));
    await expect(readNodePlatform(1)).resolves.toBeNull();
  });
});
