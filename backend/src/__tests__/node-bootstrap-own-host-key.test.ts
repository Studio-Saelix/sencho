import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';
import { NodeBootstrapService } from '../services/nodeBootstrap/NodeBootstrapService';
import { ownHostAddresses } from '../services/nodeBootstrap/targetPolicy';
import {
  SshTransportError,
  type BootstrapTransport,
  type SshSessionInput,
  type SshTarget,
} from '../services/nodeBootstrap/sshProbeClient';

/**
 * The hub cannot list its Docker host's other interface addresses from inside a
 * container, so the address guard cannot name a private NIC or a bridge address
 * that is not `.1`. The service therefore also asks the addresses it does know
 * for their SSH host key, and refuses a target that answers with the same one.
 */

const HUB_KEY = 'SHA256:hubhostkey000000000000000000000000000000000';
const OTHER_KEY = 'SHA256:someotherserverkey00000000000000000000000';
const HUB_URL = 'https://hub.example.com';

/** An SSH world keyed by `address:port`; `runCommands` applies the `refusedFingerprints` rule of the real client. */
class FakeSshWorld implements BootstrapTransport {
  public readonly keys = new Map<string, string>();
  public readonly keyscans: Array<{ address: string; port: number; timeoutMs: number | undefined }> = [];
  public authAttempts = 0;
  /** What a session that is allowed to authenticate reports. */
  public authError = new SshTransportError('SSH_AUTH_FAILED', 'Authentication failed. Check the SSH user and private key.');

  public async captureHostKey(target: SshTarget, options: { timeoutMs?: number } = {}) {
    this.keyscans.push({ address: target.address, port: target.port, timeoutMs: options.timeoutMs });
    const fingerprint = this.keys.get(`${target.address}:${target.port}`);
    if (!fingerprint) throw new SshTransportError('SSH_UNREACHABLE', 'The target refused the SSH connection.');
    return { algorithm: 'ssh-ed25519', fingerprint, knownHostsLine: `${target.host} ssh-ed25519 AAAA` };
  }

  public async runCommands(
    session: SshSessionInput,
    _commands: unknown[],
    options: { refusedFingerprints?: ReadonlySet<string> } = {},
  ): Promise<never> {
    const fingerprint = this.keys.get(`${session.address}:${session.port}`);
    if (!fingerprint) throw new SshTransportError('SSH_UNREACHABLE', 'The target refused the SSH connection.');
    if (options.refusedFingerprints?.has(fingerprint)) {
      throw new SshTransportError('SELF_TARGET', 'The target presents the SSH host key of the server running this Sencho instance.');
    }
    this.authAttempts += 1;
    throw this.authError;
  }
}

let tmpDir: string;
beforeAll(async () => { tmpDir = await setupTestDb(); });
afterAll(() => { cleanupTestDb(tmpDir); });

function service(
  world: FakeSshWorld,
  ownAddresses: () => Promise<string[]>,
  extra: Partial<ConstructorParameters<typeof NodeBootstrapService>[0]> = {},
) {
  return new NodeBootstrapService({
    transport: world,
    db: DatabaseService.getInstance(),
    now: () => Date.now(),
    ownHostAddresses: ownAddresses,
    resolveAddresses: async (host) => [host],
    caPem: () => null,
    ...extra,
  });
}

const audit = { username: 'admin', ip: '127.0.0.1', method: 'POST', path: '/api/nodes/bootstrap/preflight' };
const preflightRequest = (host: string, port = 22) => ({
  host,
  port,
  username: 'ubuntu',
  privateKey: 'not-parsed-by-the-fake',
  expectedFingerprint: HUB_KEY,
  targetName: 'self-probe',
});

describe('bootstrap target that is the hub host reached through another of its addresses', () => {
  let world: FakeSshWorld;
  // The hub host answers on its public address and on the gateway the hub reaches it by.
  const own = async () => ['151.145.63.14', '172.17.0.1'];

  beforeEach(() => {
    world = new FakeSshWorld();
    world.keys.set('151.145.63.14:22', HUB_KEY);
    world.keys.set('172.17.0.1:22', HUB_KEY);
    // The addresses the interface list cannot name: a private NIC and a bridge address.
    world.keys.set('10.0.2.109:22', HUB_KEY);
    world.keys.set('172.30.0.128:22', HUB_KEY);
    world.keys.set('10.0.2.200:22', OTHER_KEY);
  });

  it.each(['10.0.2.109', '172.30.0.128'])('refuses the host-key capture of %s', async (host) => {
    await expect(service(world, own).captureHostKey({ host, port: 22 }, { hubUrl: HUB_URL }))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_TARGET', field: 'host' });
  });

  it.each(['10.0.2.109', '172.30.0.128'])('refuses a preflight of %s before any authentication', async (host) => {
    await expect(service(world, own).preflight(preflightRequest(host), { hubUrl: HUB_URL, audit }))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_TARGET' });
    expect(world.authAttempts).toBe(0);
    expect(DatabaseService.getInstance().getNodeBootstrapTrust(host, 22)).toBeUndefined();
  });

  it('still captures and probes a different server', async () => {
    const result = await service(world, own).captureHostKey({ host: '10.0.2.200', port: 22 }, { hubUrl: HUB_URL });
    expect(result).toMatchObject({ fingerprint: OTHER_KEY, trust: 'unknown' });

    await expect(service(world, own).preflight({ ...preflightRequest('10.0.2.200'), expectedFingerprint: OTHER_KEY }, { hubUrl: HUB_URL, audit }))
      .rejects.toMatchObject({ code: 'SSH_AUTH_FAILED' });
    expect(world.authAttempts).toBe(1);
  });

  it('finds the hub host when its SSH server listens on 22 and the target is on another port', async () => {
    world.keys.set('10.0.2.109:2222', HUB_KEY);
    await expect(service(world, own).captureHostKey({ host: '10.0.2.109', port: 2222 }, { hubUrl: HUB_URL }))
      .rejects.toMatchObject({ code: 'INVALID_TARGET' });
    await expect(service(world, own).preflight(preflightRequest('10.0.2.109', 2222), { hubUrl: HUB_URL, audit }))
      .rejects.toMatchObject({ code: 'INVALID_TARGET' });
    expect(world.authAttempts).toBe(0);
  });

  it('does not refuse a target for matching its own address', async () => {
    // The own list names the target itself, which must not count as proof it is the hub.
    const result = await service(world, async () => ['10.0.2.200']).captureHostKey({ host: '10.0.2.200', port: 22 }, { hubUrl: HUB_URL });
    expect(result.fingerprint).toBe(OTHER_KEY);
    expect(world.keyscans.filter((scan) => scan.address === '10.0.2.200')).toHaveLength(1);
  });

  it('fails open when the own addresses cannot be listed or none answers', async () => {
    const broken = async (): Promise<string[]> => { throw new Error('boom'); };
    await expect(service(world, broken).preflight(preflightRequest('10.0.2.109'), { hubUrl: HUB_URL, audit }))
      .rejects.toMatchObject({ code: 'SSH_AUTH_FAILED' });
    world.keys.delete('151.145.63.14:22');
    world.keys.delete('172.17.0.1:22');
    await expect(service(world, own).captureHostKey({ host: '10.0.2.109', port: 22 }, { hubUrl: HUB_URL }))
      .resolves.toMatchObject({ fingerprint: HUB_KEY });
  });

  it('passes a cap of at most 3 seconds to each own-address key scan', async () => {
    await service(world, own).captureHostKey({ host: '10.0.2.200', port: 22 }, { hubUrl: HUB_URL });
    const ownScans = world.keyscans.filter((scan) => scan.address !== '10.0.2.200');
    expect(ownScans.length).toBeGreaterThan(0);
    for (const scan of ownScans) expect(scan.timeoutMs).toBeLessThanOrEqual(3_000);
  });

  it('finds the hub host on the target port when nothing answers on 22', async () => {
    world.keys.delete('151.145.63.14:22');
    world.keys.delete('172.17.0.1:22');
    world.keys.set('151.145.63.14:2222', HUB_KEY);
    world.keys.set('10.0.2.109:2222', HUB_KEY);
    await expect(service(world, own).captureHostKey({ host: '10.0.2.109', port: 2222 }, { hubUrl: HUB_URL }))
      .rejects.toMatchObject({ code: 'INVALID_TARGET' });
  });

  it('scans port 22 once when the target is on 22', async () => {
    await service(world, own).captureHostKey({ host: '10.0.2.200', port: 22 }, { hubUrl: HUB_URL });
    const ownScans = world.keyscans.filter((scan) => scan.address === '151.145.63.14');
    expect(ownScans).toHaveLength(1);
  });

  it('refuses a name when any of its records is the hub host, even after one that is down', async () => {
    const records = ['10.0.2.250', '10.0.2.109'];
    const resolveAddresses = async () => records;
    await expect(service(world, own, { resolveAddresses }).captureHostKey({ host: 'media.example.com', port: 22 }, { hubUrl: HUB_URL }))
      .rejects.toMatchObject({ code: 'INVALID_TARGET' });
    await expect(service(world, own, { resolveAddresses }).preflight(preflightRequest('media.example.com'), { hubUrl: HUB_URL, audit }))
      .rejects.toMatchObject({ code: 'INVALID_TARGET' });
    expect(world.authAttempts).toBe(0);
  });

  it('refuses the execution recheck of an approved address that now presents the hub key', async () => {
    await expect(service(world, own).preflight(preflightRequest('10.0.2.109'), {
      hubUrl: HUB_URL,
      audit,
      pinnedAddress: '10.0.2.109',
      planNow: 1_762_300_000_000,
    })).rejects.toMatchObject({ code: 'INVALID_TARGET' });
    expect(world.authAttempts).toBe(0);
  });

  it('never dials an address the outbound policy blocks or an IPv6 one, whatever the Host header named', async () => {
    const poisoned = async () => ['127.0.0.1', '169.254.169.254', '0.0.0.0', 'fe80::1', '172.17.0.1'];
    await service(world, poisoned).captureHostKey({ host: '10.0.2.200', port: 22 }, { hubUrl: 'https://169.254.169.254' });
    const dialed = world.keyscans.map((scan) => scan.address);
    expect(dialed).not.toContain('127.0.0.1');
    expect(dialed).not.toContain('169.254.169.254');
    expect(dialed).not.toContain('0.0.0.0');
    expect(dialed).not.toContain('fe80::1');
    expect(dialed).toContain('172.17.0.1');
  });

  it('stops a host-key capture whose request budget ran out before the own keys were read', async () => {
    let clock = 1_000_000;
    const slowTarget = new FakeSshWorld();
    slowTarget.keys.set('10.0.2.109:22', HUB_KEY);
    slowTarget.keys.set('172.17.0.1:22', HUB_KEY);
    const original = slowTarget.captureHostKey.bind(slowTarget);
    vi.spyOn(slowTarget, 'captureHostKey').mockImplementation(async (target, options) => {
      const result = await original(target, options);
      clock += 90_000;
      return result;
    });
    await expect(service(slowTarget, own, { now: () => clock, requestBudgetMs: 90_000 })
      .captureHostKey({ host: '10.0.2.109', port: 22 }, { hubUrl: HUB_URL }))
      .rejects.toMatchObject({ code: 'PREFLIGHT_TIMEOUT' });
  });

  it('stops a host-key capture that was cancelled while the own keys were being read', async () => {
    const controller = new AbortController();
    const cancelling = new FakeSshWorld();
    cancelling.keys.set('10.0.2.109:22', HUB_KEY);
    const original = cancelling.captureHostKey.bind(cancelling);
    vi.spyOn(cancelling, 'captureHostKey').mockImplementation(async (target, options) => {
      if (target.address === '172.17.0.1') controller.abort();
      return original(target, options);
    });
    await expect(service(cancelling, own).captureHostKey({ host: '10.0.2.109', port: 22 }, { hubUrl: HUB_URL, signal: controller.signal }))
      .rejects.toMatchObject({ message: 'The request was cancelled.' });
  });

  it('does not let a hung own-address list hold the request past the probe cap', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const hung = () => new Promise<string[]>(() => {});
      const pending = service(world, hung).captureHostKey({ host: '10.0.2.109', port: 22 }, { hubUrl: HUB_URL });
      const settled = expect(pending).resolves.toMatchObject({ fingerprint: HUB_KEY });
      await vi.advanceTimersByTimeAsync(3_000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the own-host address list', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('holds the hub host, the gateways and the interfaces, each once', async () => {
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({
      eth0: [
        { address: '172.30.0.5', netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: '172.30.0.5/24' },
        { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '00:00:00:00:00:00', internal: false, cidr: 'fe80::1/64', scopeid: 1 },
      ],
    });
    const list = await ownHostAddresses('151.145.63.14');
    expect(list).toEqual(expect.arrayContaining(['151.145.63.14', '172.30.0.5', '172.30.0.1', '172.17.0.1']));
    expect(new Set(list).size).toBe(list.length);
  });
});

