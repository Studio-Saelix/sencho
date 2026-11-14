import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';
import { NodeBootstrapService } from '../services/nodeBootstrap/NodeBootstrapService';
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

/** An SSH world keyed by `address:port`, with the transport policy the real client applies. */
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
    if (fingerprint && options.refusedFingerprints?.has(fingerprint)) {
      throw new SshTransportError('SELF_TARGET', 'The target presents the SSH host key of the server running this Sencho instance.');
    }
    this.authAttempts += 1;
    throw this.authError;
  }
}

let tmpDir: string;
beforeAll(async () => { tmpDir = await setupTestDb(); });
afterAll(() => { cleanupTestDb(tmpDir); });

function service(world: FakeSshWorld, ownAddresses: () => Promise<string[]>) {
  return new NodeBootstrapService({
    transport: world,
    db: DatabaseService.getInstance(),
    now: () => Date.now(),
    ownHostAddresses: ownAddresses,
    resolveAddresses: async (host) => [host],
    caPem: () => null,
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

  it('bounds each own-address key scan, so a silent address cannot hold the request', async () => {
    const hanging = vi.spyOn(world, 'captureHostKey');
    await service(world, own).captureHostKey({ host: '10.0.2.200', port: 22 }, { hubUrl: HUB_URL }).catch(() => undefined);
    const ownScans = world.keyscans.filter((scan) => scan.address !== '10.0.2.200');
    expect(ownScans.length).toBeGreaterThan(0);
    for (const scan of ownScans) expect(scan.timeoutMs).toBeLessThanOrEqual(3_000);
    hanging.mockRestore();
  });
});
