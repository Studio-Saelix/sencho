/**
 * Which container carries this node's Docker API. Covers the DOCKER_HOST
 * parse, the shared-network address match, the unresolved paths that must not
 * be guessed past, and the short-lived cache.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockLookup, mockListContainers } = vi.hoisted(() => ({
  mockLookup: vi.fn(),
  mockListContainers: vi.fn(),
}));

vi.mock('dns', () => ({ default: { promises: { lookup: mockLookup } } }));

vi.mock('../services/DockerController', () => ({
  default: {
    getInstance: () => ({ getDocker: () => ({ listContainers: mockListContainers }) }),
  },
}));

import SelfIdentityService from '../services/SelfIdentityService';
import {
  parseDockerEndpoint,
  resolveDockerEndpointProvider,
  resetDockerEndpointProviderCache,
} from '../services/DockerEndpointProvider';

const originalDockerHost = process.env.DOCKER_HOST;
const SELF_ID = 'a'.repeat(64);
const PROXY_ID = 'b'.repeat(64);

function stubSelf(state: 'resolved' | 'none' | 'unresolved', networks: string[] = ['sencho_default']) {
  const self = SelfIdentityService.getInstance();
  vi.spyOn(self, 'ensureResolved').mockResolvedValue(state);
  vi.spyOn(self, 'getUnresolvedReason').mockReturnValue(state === 'unresolved' ? 'HOSTNAME inspect failed: 403' : null);
  vi.spyOn(self, 'isOwnContainer').mockImplementation(id => id === SELF_ID);
  vi.spyOn(self, 'isOwnNetwork').mockImplementation(name => networks.includes(name));
}

function proxyContainer(over: Record<string, unknown> = {}) {
  return {
    Id: PROXY_ID,
    Names: ['/sencho-proxy'],
    Labels: {
      'com.docker.compose.project': 'sencho',
      'com.docker.compose.service': 'socket-proxy',
      'com.docker.compose.project.working_dir': '/srv/compose/sencho',
    },
    NetworkSettings: { Networks: { sencho_default: { IPAddress: '172.20.0.3', NetworkID: 'n1' } } },
    Mounts: [{ Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock' }],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDockerEndpointProviderCache();
  process.env.DOCKER_HOST = 'tcp://socket-proxy:2375';
  mockLookup.mockResolvedValue([{ address: '172.20.0.3', family: 4 }]);
  mockListContainers.mockResolvedValue([proxyContainer()]);
  stubSelf('resolved');
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalDockerHost === undefined) delete process.env.DOCKER_HOST;
  else process.env.DOCKER_HOST = originalDockerHost;
});

describe('parseDockerEndpoint', () => {
  it.each([
    [undefined, { kind: 'local' }],
    ['', { kind: 'local' }],
    ['unix:///var/run/docker.sock', { kind: 'local' }],
    ['/var/run/docker.sock', { kind: 'local' }],
    ['npipe:////./pipe/docker_engine', { kind: 'local' }],
    ['ssh://user@host', { kind: 'local' }],
    ['tcp://socket-proxy:2375', { kind: 'tcp', host: 'socket-proxy' }],
    ['TCP://Proxy.internal:2375', { kind: 'tcp', host: 'Proxy.internal' }],
    ['http://10.0.0.5:2375', { kind: 'tcp', host: '10.0.0.5' }],
    ['tcp://[fd00::5]:2375', { kind: 'tcp', host: 'fd00::5' }],
  ])('parses %s', (raw, expected) => {
    expect(parseDockerEndpoint(raw)).toEqual(expected);
  });
});

describe('resolveDockerEndpointProvider', () => {
  it('is none for a local socket and never looks anything up', async () => {
    process.env.DOCKER_HOST = 'unix:///var/run/docker.sock';

    const result = await resolveDockerEndpointProvider();

    expect(result.state).toBe('none');
    expect(mockLookup).not.toHaveBeenCalled();
    expect(mockListContainers).not.toHaveBeenCalled();
  });

  it('finds the container that owns the endpoint address on a shared network', async () => {
    const result = await resolveDockerEndpointProvider();

    expect(result).toEqual({
      state: 'resolved',
      provider: {
        containerId: PROXY_ID,
        containerName: 'sencho-proxy',
        project: 'sencho',
        service: 'socket-proxy',
        workingDir: '/srv/compose/sencho',
        socketBindSource: '/var/run/docker.sock',
      },
    });
  });

  it('stores an empty Compose label as null, so a refusal never names service ""', async () => {
    mockListContainers.mockResolvedValue([proxyContainer({
      Labels: {
        'com.docker.compose.project': '',
        'com.docker.compose.service': '',
        'com.docker.compose.project.working_dir': '',
      },
    })]);

    expect(await resolveDockerEndpointProvider()).toMatchObject({
      state: 'resolved',
      provider: { containerName: 'sencho-proxy', project: null, service: null, workingDir: null },
    });
  });

  it('skips the lookup for an IP literal', async () => {
    process.env.DOCKER_HOST = 'tcp://172.20.0.3:2375';

    const result = await resolveDockerEndpointProvider();

    expect(result.state).toBe('resolved');
    expect(mockLookup).not.toHaveBeenCalled();
  });

  describe('IPv6 endpoint addresses', () => {
    const v6Proxy = (address: string, over: Record<string, unknown> = {}) => proxyContainer({
      NetworkSettings: { Networks: { sencho_default: { IPAddress: '', GlobalIPv6Address: address, NetworkID: 'n1' } } },
      ...over,
    });

    it('finds a provider reached through an AAAA-only host name', async () => {
      mockLookup.mockResolvedValue([{ address: 'fd00::5', family: 6 }]);
      mockListContainers.mockResolvedValue([v6Proxy('fd00::5')]);

      expect((await resolveDockerEndpointProvider()).state).toBe('resolved');
    });

    it.each([
      ['a literal', 'tcp://[fd00::5]:2375', 'fd00::5'],
      ['an uncompressed literal', 'tcp://[fd00:0:0:0:0:0:0:5]:2375', 'fd00::5'],
      ['an upper-case literal against a compressed address', 'tcp://[FD00::5]:2375', 'fd00::5'],
      ['a compressed literal against an uncompressed address', 'tcp://[fd00::5]:2375', 'fd00:0000:0000:0000:0000:0000:0000:0005'],
    ])('matches %s', async (_name, host, address) => {
      process.env.DOCKER_HOST = host;
      mockListContainers.mockResolvedValue([v6Proxy(address)]);

      const result = await resolveDockerEndpointProvider();

      expect(result.state).toBe('resolved');
      expect(mockLookup).not.toHaveBeenCalled();
    });

    it('finds a dual-stack provider when resolution selects only the IPv6 address', async () => {
      mockLookup.mockResolvedValue([{ address: 'fd00::5', family: 6 }]);
      mockListContainers.mockResolvedValue([proxyContainer({
        NetworkSettings: { Networks: { sencho_default: { IPAddress: '172.20.0.3', GlobalIPv6Address: 'fd00::5', NetworkID: 'n1' } } },
      })]);

      expect((await resolveDockerEndpointProvider()).state).toBe('resolved');
    });

    it('treats an IPv4-mapped literal as the IPv4 address', async () => {
      process.env.DOCKER_HOST = 'tcp://[::ffff:172.20.0.3]:2375';

      expect((await resolveDockerEndpointProvider()).state).toBe('resolved');
    });

    it('does not match an IPv6 address on a network Sencho is not attached to, or a different address', async () => {
      mockLookup.mockResolvedValue([{ address: 'fd00::5', family: 6 }]);
      mockListContainers.mockResolvedValue([v6Proxy('fd00::6')]);
      expect((await resolveDockerEndpointProvider()).state).toBe('none');

      resetDockerEndpointProviderCache();
      stubSelf('resolved', ['some_other_network']);
      mockListContainers.mockResolvedValue([v6Proxy('fd00::5')]);
      expect((await resolveDockerEndpointProvider()).state).toBe('none');
    });
  });

  it('does not match an address that lives on a network Sencho is not attached to', async () => {
    stubSelf('resolved', ['some_other_network']);

    const result = await resolveDockerEndpointProvider();

    expect(result.state).toBe('none');
  });

  it('never names Sencho itself as the provider', async () => {
    mockListContainers.mockResolvedValue([proxyContainer({ Id: SELF_ID })]);

    const result = await resolveDockerEndpointProvider();

    expect(result.state).toBe('none');
  });

  it('is none when no container owns the address, rather than guessing', async () => {
    mockLookup.mockResolvedValue([{ address: '192.168.1.50', family: 4 }]);

    const result = await resolveDockerEndpointProvider();

    expect(result.state).toBe('none');
  });

  it('is none when Sencho is not in a container', async () => {
    stubSelf('none');

    expect((await resolveDockerEndpointProvider()).state).toBe('none');
    expect(mockListContainers).not.toHaveBeenCalled();
  });

  it('is unresolved, with the reason, when Sencho cannot identify itself', async () => {
    stubSelf('unresolved');

    const result = await resolveDockerEndpointProvider();

    expect(result).toEqual({ state: 'unresolved', reason: 'HOSTNAME inspect failed: 403' });
  });

  it('is unresolved when the endpoint host does not resolve', async () => {
    mockLookup.mockRejectedValue(new Error('getaddrinfo ENOTFOUND socket-proxy'));

    const result = await resolveDockerEndpointProvider();

    expect(result.state).toBe('unresolved');
    expect((result as { reason: string }).reason).toContain('socket-proxy');
  });

  it('is unresolved when the container list fails', async () => {
    mockListContainers.mockRejectedValue(new Error('403 forbidden'));

    const result = await resolveDockerEndpointProvider();

    expect(result.state).toBe('unresolved');
  });

  it('shares one lookup between concurrent callers and reuses the answer', async () => {
    const [a, b] = await Promise.all([resolveDockerEndpointProvider(), resolveDockerEndpointProvider()]);
    await resolveDockerEndpointProvider();

    expect(a).toBe(b);
    expect(mockListContainers).toHaveBeenCalledTimes(1);
  });

  it('does not cache an unresolved answer, so the next call tries again', async () => {
    mockListContainers.mockRejectedValueOnce(new Error('boom'));

    expect((await resolveDockerEndpointProvider()).state).toBe('unresolved');
    expect((await resolveDockerEndpointProvider()).state).toBe('resolved');
    expect(mockListContainers).toHaveBeenCalledTimes(2);
  });

  it('re-resolves after the 15 s window, so a recreated proxy is found', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      expect((await resolveDockerEndpointProvider()).state).toBe('resolved');
      vi.setSystemTime(Date.now() + 14_000);
      await resolveDockerEndpointProvider();
      expect(mockListContainers).toHaveBeenCalledTimes(1);

      vi.setSystemTime(Date.now() + 2_000);
      await resolveDockerEndpointProvider();

      expect(mockListContainers).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not remember an unmatched tcp endpoint, so a proxy that comes up later is found', async () => {
    mockLookup.mockResolvedValueOnce([{ address: '192.168.1.50', family: 4 }]);

    expect((await resolveDockerEndpointProvider()).state).toBe('none');
    expect((await resolveDockerEndpointProvider()).state).toBe('resolved');
    expect(mockListContainers).toHaveBeenCalledTimes(2);
  });

  it('says once, per host, that a tcp endpoint matched no container', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockLookup.mockResolvedValue([{ address: '192.168.1.50', family: 4 }]);

    await resolveDockerEndpointProvider();
    await resolveDockerEndpointProvider();

    const unmatched = warn.mock.calls.filter(call => String(call[0]).includes('owns the Docker endpoint address'));
    expect(unmatched).toHaveLength(1);
  });

  it('does not keep a failed lookup in the cache, so the next call resolves again', async () => {
    vi.spyOn(SelfIdentityService.getInstance(), 'ensureResolved').mockRejectedValueOnce(new Error('inspect exploded'));

    await expect(resolveDockerEndpointProvider()).rejects.toThrow('inspect exploded');
    expect((await resolveDockerEndpointProvider()).state).toBe('resolved');
  });

  it('answers for the endpoint in force, not an earlier one', async () => {
    expect((await resolveDockerEndpointProvider()).state).toBe('resolved');

    process.env.DOCKER_HOST = 'unix:///var/run/docker.sock';

    expect((await resolveDockerEndpointProvider()).state).toBe('none');
  });
});
