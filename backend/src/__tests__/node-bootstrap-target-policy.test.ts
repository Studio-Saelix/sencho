import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'os';
import { resolveTargetAddresses, UnsafeTargetError } from '../services/nodeBootstrap/targetPolicy';

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
