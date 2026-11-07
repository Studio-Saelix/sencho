import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'os';
import { resolveTargetAddresses, UnsafeTargetError, validateHost, validateTarget } from '../services/nodeBootstrap/targetPolicy';

/**
 * The target resolver is the security boundary in front of every SSH dial, so
 * these tests exercise the real function with controlled DNS answers and the
 * real blocked-address policy rather than a replaced resolver.
 */

function resolveWith(records: Array<{ address: string; family: number }>) {
  return async () => records;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('bootstrap target address policy', () => {
  it('accepts an allowed public IPv4 answer', async () => {
    await expect(resolveTargetAddresses('host.example.com', resolveWith([
      { address: '8.8.8.8', family: 4 },
    ]))).resolves.toEqual(['8.8.8.8']);
  });

  it('rejects a mixed answer with the blocked record first', async () => {
    await expect(resolveTargetAddresses('host.example.com', resolveWith([
      { address: '127.0.0.1', family: 4 },
      { address: '8.8.8.8', family: 4 },
    ]))).rejects.toMatchObject({ code: 'INVALID_TARGET' });
  });

  it('rejects a mixed answer with the blocked record second', async () => {
    await expect(resolveTargetAddresses('host.example.com', resolveWith([
      { address: '8.8.8.8', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]))).rejects.toMatchObject({ code: 'INVALID_TARGET' });
  });

  it('rejects an answer that is one of this instance own addresses', async () => {
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({
      eth0: [{ address: '8.8.4.4', netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: '8.8.4.4/24' }],
    });
    await expect(resolveTargetAddresses('self.example.com', resolveWith([
      { address: '8.8.4.4', family: 4 },
    ]))).rejects.toMatchObject({ code: 'INVALID_TARGET' });
  });

  describe('the hub address as clients reach it (Docker and NAT deployments)', () => {
    function bridgeOnly() {
      vi.spyOn(os, 'networkInterfaces').mockReturnValue({
        eth0: [{ address: '172.17.0.2', netmask: '255.255.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: '172.17.0.2/16' }],
      });
    }

    it('rejects the hub public IPv4 address that no interface in the container holds', async () => {
      bridgeOnly();
      await expect(resolveTargetAddresses('8.8.4.4', resolveWith([]), '8.8.4.4'))
        .rejects.toMatchObject({ code: 'INVALID_TARGET', message: 'The target resolves to this Sencho instance.' });
    });

    it('rejects a DNS name for the hub, and a target name that resolves to the hub public name', async () => {
      bridgeOnly();
      const resolve = async (hostname: string) => (
        hostname === 'hub.example.com' || hostname === 'alias.example.com'
          ? [{ address: '8.8.4.4', family: 4 }]
          : []
      );
      await expect(resolveTargetAddresses('alias.example.com', resolve, 'hub.example.com'))
        .rejects.toMatchObject({ code: 'INVALID_TARGET' });
      await expect(resolveTargetAddresses('hub.example.com', resolve, 'hub.example.com'))
        .rejects.toMatchObject({ code: 'INVALID_TARGET' });
    });

    it('accepts any other public address while the hub host is known', async () => {
      bridgeOnly();
      await expect(resolveTargetAddresses('8.8.8.8', resolveWith([]), '8.8.4.4')).resolves.toEqual(['8.8.8.8']);
    });

    it('accepts a target when the hub host does not resolve or is IPv6, and without a hub host', async () => {
      bridgeOnly();
      const failing = async (hostname: string) => {
        if (hostname === 'hub.invalid') throw new Error('ENOTFOUND');
        return [{ address: '8.8.8.8', family: 4 }];
      };
      await expect(resolveTargetAddresses('target.example.com', failing, 'hub.invalid')).resolves.toEqual(['8.8.8.8']);
      await expect(resolveTargetAddresses('target.example.com', failing, '::1')).resolves.toEqual(['8.8.8.8']);
      await expect(resolveTargetAddresses('target.example.com', failing, null)).resolves.toEqual(['8.8.8.8']);
    });
  });

  it('rejects malformed and IPv6 records', async () => {
    await expect(resolveTargetAddresses('host.example.com', resolveWith([
      { address: 'not-an-address', family: 4 },
    ]))).rejects.toMatchObject({ code: 'INVALID_TARGET' });
    await expect(resolveTargetAddresses('host.example.com', resolveWith([
      { address: '2001:4860:4860::8888', family: 6 },
    ]))).rejects.toMatchObject({ code: 'INVALID_TARGET' });
  });

  it('fails closed on an empty answer and on DNS failure', async () => {
    await expect(resolveTargetAddresses('host.example.com', resolveWith([])))
      .rejects.toMatchObject({ code: 'SSH_DNS_FAILED' });
    await expect(resolveTargetAddresses('host.example.com', async () => {
      throw new Error('ENOTFOUND');
    })).rejects.toMatchObject({ code: 'SSH_DNS_FAILED' });
  });

  it('checks a literal IPv4 without asking DNS', async () => {
    const resolve = vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]);
    await expect(resolveTargetAddresses('8.8.8.8', resolve)).resolves.toEqual(['8.8.8.8']);
    expect(resolve).not.toHaveBeenCalled();
    await expect(resolveTargetAddresses('127.0.0.1', resolve)).rejects.toBeInstanceOf(UnsafeTargetError);
  });
});

describe('bootstrap target identity', () => {
  it('canonicalizes a DNS name to lower case and leaves an IPv4 literal alone', () => {
    expect(validateHost('  Server.Example.COM ')).toBe('server.example.com');
    expect(validateHost('192.168.1.50')).toBe('192.168.1.50');
    expect(validateTarget({ host: 'SERVER.example.com', username: 'ubuntu', targetName: 'x' }).host).toBe('server.example.com');
  });

  it.each(['1.2.3.04', '0x7f.1', '10.1', 'host.123', '300.1.1.1', '1.2.3.0x4'])('rejects %s as a legacy spelling of an IPv4 address', (host) => {
    expect(() => validateHost(host)).toThrow(/dotted form|DNS name/);
  });

  it.each(['example.com', 'a1.example.com', '123.example.com', 'node-1', 'x0x.example.org'])('still accepts %s', (host) => {
    expect(validateHost(host)).toBe(host);
  });
});
