import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'crypto';
import net from 'net';
import { Server, utils } from 'ssh2';
import {
  SshProbeClient,
  SshTransportError,
  hostKeyObservation,
  parsePrivateKey,
  scrubSecrets,
} from '../services/nodeBootstrap/sshProbeClient';
import { buildProbeCatalog, isReadOnlyProbeCommand } from '../services/nodeBootstrap/probes';

/**
 * In-process SSH server used to prove the transport policy without a real host:
 * host-key capture, pin mismatch before any exec, auth failure, timeouts, output
 * caps, the fixed path script, and the read-only command catalog.
 */

const { privateKey: HOST_KEY } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

const { privateKey: USER_KEY } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

interface FixtureOptions {
  rejectAuth?: boolean;
  hangCommand?: string;
  withholdExec?: string;
  delayExecMs?: number;
  delayExecCommand?: string;
  largeOutput?: boolean;
  largeStderr?: boolean;
  mixedOutput?: boolean;
  closeAfterFirstCommand?: boolean;
  closeDuringCommand?: string;
  responses?: Record<string, string>;
}

interface Fixture {
  port: number;
  commands: string[];
  close: () => Promise<void>;
}

const servers: Server[] = [];

async function startServer(options: FixtureOptions = {}): Promise<Fixture> {
  const commands: string[] = [];
  const server = new Server({ hostKeys: [HOST_KEY] }, (client) => {
    // A keyscan aborts the handshake on purpose, which surfaces here as a
    // key-exchange failure. Swallow fixture-side errors: the client behavior is
    // what this suite asserts.
    client.on('error', () => {});
    client.on('authentication', (ctx) => {
      if (options.rejectAuth) ctx.reject();
      else ctx.accept();
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('exec', (acceptExec, _rejectExec, info) => {
          commands.push(info.command);
          if (options.withholdExec && info.command.includes(options.withholdExec)) return;
          if (options.delayExecMs && options.delayExecCommand && info.command.includes(options.delayExecCommand)) {
            setTimeout(() => {
              const stream = acceptExec();
              stream.exit(0);
              stream.end();
            }, options.delayExecMs);
            return;
          }
          const stream = acceptExec();
          if (options.hangCommand && info.command.includes(options.hangCommand)) return;
          if (options.closeDuringCommand && info.command.includes(options.closeDuringCommand)) {
            setTimeout(() => client.end(), 10);
            return;
          }
          if (options.closeAfterFirstCommand) {
            stream.exit(0);
            stream.end();
            setTimeout(() => client.end(), 10);
            return;
          }
          if (options.largeOutput) {
            stream.write('x'.repeat(100 * 1024));
            stream.exit(0);
            stream.end();
            return;
          }
          if (options.largeStderr) {
            stream.stderr.write('y'.repeat(100 * 1024));
            stream.exit(0);
            stream.end();
            return;
          }
          if (options.mixedOutput) {
            stream.write('x'.repeat(40 * 1024));
            stream.stderr.write('y'.repeat(40 * 1024));
            stream.exit(0);
            stream.end();
            return;
          }
          const match = Object.entries(options.responses ?? {})
            .find(([needle]) => info.command.includes(needle));
          if (match) stream.write(match[1]);
          stream.exit(0);
          stream.end();
        });
      });
    });
  });
  servers.push(server);
  server.on('error', () => {});
  server.on('connection', (socket) => socket.on('error', () => {}));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return {
    port: address.port,
    commands,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

const plainClient = new SshProbeClient();

/**
 * The transport refuses a session with no expected fingerprint, so tests that
 * are about something else run against the fixture's own pinned key.
 */
class PinnedClient extends SshProbeClient {
  private pinned: string | null = null;

  public override async runCommands(
    session: Parameters<SshProbeClient['runCommands']>[0],
    commands: Parameters<SshProbeClient['runCommands']>[1],
    options: Parameters<SshProbeClient['runCommands']>[2] = {},
  ) {
    if (options.expectedFingerprint === undefined) {
      this.pinned ??= (await this.captureHostKey(session)).fingerprint;
      return super.runCommands(session, commands, { ...options, expectedFingerprint: this.pinned });
    }
    return super.runCommands(session, commands, options);
  }
}

const client = new PinnedClient();

describe('bootstrap SSH transport', () => {
  it('captures the host key without authenticating', async () => {
    const fixture = await startServer();
    const observation = await client.captureHostKey({ host: 'fixture.local', address: '127.0.0.1', port: fixture.port });
    expect(observation.algorithm).toBe('ssh-rsa');
    expect(observation.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(observation.knownHostsLine.startsWith('fixture.local ssh-rsa ')).toBe(true);
  });

  it('rejects a changed host key before running any command', async () => {
    const fixture = await startServer();
    await expect(client.runCommands(
      { host: 'fixture.local', address: '127.0.0.1', port: fixture.port, username: 'ubuntu', privateKey: USER_KEY },
      [{ id: 'os_release', command: 'cat /etc/os-release' }],
      { expectedFingerprint: 'SHA256:not-the-right-one' },
    )).rejects.toMatchObject({ code: 'HOST_KEY_UNTRUSTED' });
    expect(fixture.commands).toHaveLength(0);
  });

  it('runs a command when the fingerprint matches', async () => {
    const fixture = await startServer({ responses: { 'uname -m': 'x86_64\n6.8.0\n' } });
    const capture = await client.captureHostKey({ host: 'fixture.local', address: '127.0.0.1', port: fixture.port });
    const results = await client.runCommands(
      { host: 'fixture.local', address: '127.0.0.1', port: fixture.port, username: 'ubuntu', privateKey: USER_KEY },
      [{ id: 'uname', command: 'uname -m; uname -r' }],
      { expectedFingerprint: capture.fingerprint },
    );
    expect(results[0].stdout).toContain('x86_64');
    expect(results[0].exitCode).toBe(0);
    expect(fixture.commands[0]).toBe('LC_ALL=C uname -m; uname -r');
  });

  it('refuses to authenticate when no fingerprint was supplied', async () => {
    const fixture = await startServer();
    await expect(plainClient.runCommands(
      { host: 'fixture.local', address: '127.0.0.1', port: fixture.port, username: 'ubuntu', privateKey: USER_KEY },
      [{ id: 'uname', command: 'uname -m' }],
      {},
    )).rejects.toMatchObject({ code: 'HOST_KEY_UNTRUSTED' });
    expect(fixture.commands).toEqual([]);
  });

  it('maps a rejected authentication to SSH_AUTH_FAILED', async () => {
    const fixture = await startServer({ rejectAuth: true });
    await expect(client.runCommands(
      { host: 'fixture.local', address: '127.0.0.1', port: fixture.port, username: 'ubuntu', privateKey: USER_KEY },
      [{ id: 'uname', command: 'uname -m' }],
      {},
    )).rejects.toMatchObject({ code: 'SSH_AUTH_FAILED' });
  });

  it('rejects an unreadable private key before dialing', () => {
    expect(() => parsePrivateKey('not a key')).toThrow(SshTransportError);
    try {
      parsePrivateKey('not a key');
    } catch (error) {
      expect((error as SshTransportError).code).toBe('SSH_KEY_INVALID');
    }
  });

  describe('encrypted private keys', () => {
    const PASSPHRASE = 'correct horse battery';
    const encryptedKeys = {
      'OpenSSH ed25519': utils.generateKeyPairSync('ed25519', { passphrase: PASSPHRASE, cipher: 'aes256-ctr', rounds: 16 }).private,
      'OpenSSH rsa': utils.generateKeyPairSync('rsa', { bits: 2048, passphrase: PASSPHRASE, cipher: 'aes256-ctr', rounds: 16 }).private,
      'PEM rsa': crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: PASSPHRASE },
        publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
      }).privateKey,
    };

    function codeOf(fn: () => void): string | null {
      try {
        fn();
        return null;
      } catch (error) {
        return error instanceof SshTransportError ? error.code : 'OTHER';
      }
    }

    it.each(Object.entries(encryptedKeys))('%s: a wrong passphrase is reported as the passphrase, not the key format', (_name, key) => {
      expect(codeOf(() => parsePrivateKey(key, 'not-the-passphrase'))).toBe('SSH_KEY_PASSPHRASE_INVALID');
      expect(() => parsePrivateKey(key, 'not-the-passphrase')).toThrow(/passphrase/i);
      expect(() => parsePrivateKey(key, 'not-the-passphrase')).not.toThrow(/OpenSSH key/);
    });

    it.each(Object.entries(encryptedKeys))('%s: a missing passphrase still asks for one', (_name, key) => {
      expect(codeOf(() => parsePrivateKey(key))).toBe('SSH_KEY_PASSPHRASE_REQUIRED');
      expect(codeOf(() => parsePrivateKey(key, ''))).toBe('SSH_KEY_PASSPHRASE_REQUIRED');
    });

    it.each(Object.entries(encryptedKeys))('%s: the right passphrase reads the key', (_name, key) => {
      expect(codeOf(() => parsePrivateKey(key, PASSPHRASE))).toBeNull();
    });

    it('still reports garbage as an unreadable key, with or without a passphrase', () => {
      expect(codeOf(() => parsePrivateKey('not a key', PASSPHRASE))).toBe('SSH_KEY_INVALID');
      expect(codeOf(() => parsePrivateKey('not a key'))).toBe('SSH_KEY_INVALID');
    });
  });

  it('closes a hanging command at the timeout', async () => {
    const fixture = await startServer({ hangCommand: 'sleep' });
    const results = await client.runCommands(
      { host: 'fixture.local', address: '127.0.0.1', port: fixture.port, username: 'ubuntu', privateKey: USER_KEY },
      [{ id: 'hang', command: 'sleep 60' }, { id: 'after', command: 'uname -m' }],
      { perCommandMs: 200, totalMs: 5_000 },
    );
    expect(results[0].timedOut).toBe(true);
    expect(results).toHaveLength(1);
  });

  it('truncates output above the per-command cap', async () => {
    const fixture = await startServer({ largeOutput: true });
    const results = await client.runCommands(
      { host: 'fixture.local', address: '127.0.0.1', port: fixture.port, username: 'ubuntu', privateKey: USER_KEY },
      [{ id: 'big', command: 'cat big-file' }],
      {},
    );
    expect(results[0].truncated).toBe(true);
    expect(Buffer.byteLength(results[0].stdout)).toBeLessThanOrEqual(64 * 1024);
  });

  it('rejects a session that closes before the whole catalog ran', async () => {
    const fixture = await startServer({ closeAfterFirstCommand: true });
    await expect(client.runCommands(
      { host: 'fixture.local', address: '127.0.0.1', port: fixture.port, username: 'ubuntu', privateKey: USER_KEY },
      [
        { id: 'one', command: 'uname -m' },
        { id: 'two', command: 'uname -r' },
        { id: 'three', command: 'id -un' },
      ],
      {},
    )).rejects.toMatchObject({ code: 'SSH_UNREACHABLE' });
  });

  it('rejects a session that drops while the last command is still running', async () => {
    const fixture = await startServer({ closeDuringCommand: 'uname -r' });
    await expect(client.runCommands(
      { host: 'fixture.local', address: '127.0.0.1', port: fixture.port, username: 'ubuntu', privateKey: USER_KEY },
      [
        { id: 'one', command: 'uname -m' },
        { id: 'two', command: 'uname -r' },
      ],
      { perCommandMs: 500, totalMs: 5_000 },
    )).rejects.toMatchObject({ code: 'SSH_UNREACHABLE' });
  });

  it('sends the exact validated path to the fixed path script', async () => {
    const path = '/opt/docker/my-stacks';
    const fixture = await startServer({
      responses: {
        'sencho-probe': [
          `P_INPUT=${path}`,
          'P_EXISTS=1',
          'P_ISDIR=1',
          'P_FINAL_LINK=0',
          `P_REAL=${path}`,
          'P_ANCESTOR_LINK=0',
          'P_OWNER=ubuntu',
          'P_GROUP=ubuntu',
          'P_MODE=755',
          'P_USER_R=1',
          'P_USER_W=1',
          'P_FSTYPE=ext4',
          'P_FSSOURCE=/dev/sda1',
          'P_FSTARGET=/',
        ].join('\n'),
      },
    });
    const catalog = buildProbeCatalog({ composeDir: path, agentDir: '/opt/sencho-agent', hubUrl: 'https://sencho.example.com' });
    const pathProbe = catalog.find((probe) => probe.id === 'path_compose');
    const results = await client.runCommands(
      { host: 'fixture.local', address: '127.0.0.1', port: fixture.port, username: 'ubuntu', privateKey: USER_KEY },
      [{ id: 'path_compose', command: pathProbe!.command }],
      {},
    );
    expect(fixture.commands[0]).toContain(`'${path}'`);
    expect(results[0].stdout).toContain(`P_INPUT=${path}`);
  });

  it('sends only commands from the read-only catalog', async () => {
    const fixture = await startServer();
    const catalog = buildProbeCatalog({
      composeDir: '/opt/docker/sencho',
      agentDir: '/opt/sencho-agent',
      hubUrl: 'https://sencho.example.com',
    });
    await client.runCommands(
      { host: 'fixture.local', address: '127.0.0.1', port: fixture.port, username: 'ubuntu', privateKey: USER_KEY },
      catalog.map(({ id, command }) => ({ id, command })),
      { perCommandMs: 2_000, totalMs: 20_000 },
    );
    expect(fixture.commands.length).toBe(catalog.length);
    for (const command of fixture.commands) {
      expect(isReadOnlyProbeCommand(command.replace(/^LC_ALL=C /, ''))).toBe(true);
    }
  });

  it('builds an OpenSSH fingerprint from the raw key blob', () => {
    const blob = Buffer.concat([
      Buffer.from([0, 0, 0, 7]),
      Buffer.from('ssh-rsa'),
      Buffer.from([0, 0, 0, 3, 1, 2, 3]),
    ]);
    const observation = hostKeyObservation('host.example.com', blob);
    expect(observation.algorithm).toBe('ssh-rsa');
    expect(observation.knownHostsLine.startsWith('host.example.com ssh-rsa ')).toBe(true);
    expect(observation.fingerprint).toMatch(/^SHA256:/);
    expect(net.isIP('127.0.0.1')).toBe(4);
  });

  it('scrubs secret material from messages', () => {
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----secretsecret';
    expect(scrubSecrets(`error with ${key} inside`, [key])).not.toContain('secretsecret');
  });
});

describe('bootstrap SSH transport deadlines and byte budgets', () => {
  it('closes a command whose exec acknowledgement never arrives', async () => {
    const fixture = await startServer({ withholdExec: 'sleep' });
    const started = Date.now();
    const results = await client.runCommands(
      { host: 'fixture.local', address: '127.0.0.1', port: fixture.port, username: 'ubuntu', privateKey: USER_KEY },
      [{ id: 'hang', command: 'sleep 60' }, { id: 'after', command: 'uname -m' }],
      { perCommandMs: 100, totalMs: 1_000 },
    );
    expect(Date.now() - started).toBeLessThan(800);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: 'hang', timedOut: true, error: 'COMMAND_TIMEOUT' });
  });

  it('ends the session at the session budget even when the per-command budget is far longer', async () => {
    const fixture = await startServer({ withholdExec: 'sleep' });
    const started = Date.now();
    const results = await client.runCommands(
      { host: 'fixture.local', address: '127.0.0.1', port: fixture.port, username: 'ubuntu', privateKey: USER_KEY },
      [{ id: 'hang', command: 'sleep 60' }, { id: 'after', command: 'uname -m' }],
      { perCommandMs: 30_000, totalMs: 250 },
    );
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(results.map((entry) => [entry.id, entry.error])).toEqual([
      ['hang', 'PREFLIGHT_TIMEOUT'],
      ['after', 'PREFLIGHT_TIMEOUT'],
    ]);
  });

  it('reports the session timeout whichever timer wins when both budgets expire together', async () => {
    // Equal budgets give the command timer and the watchdog the same deadline,
    // so either may fire first; the result must not depend on which. The race
    // is a few milliseconds wide, so a regression shows up as an occasional
    // failure here, not on every run.
    const fixture = await startServer({ withholdExec: 'sleep' });
    const results = await client.runCommands(
      { host: 'fixture.local', address: '127.0.0.1', port: fixture.port, username: 'ubuntu', privateKey: USER_KEY },
      [{ id: 'first', command: 'uname -m' }, { id: 'hang', command: 'sleep 60' }, { id: 'after', command: 'uname -m' }],
      { perCommandMs: 1_000, totalMs: 1_000 },
    );
    expect(results.map((entry) => [entry.id, entry.error])).toEqual([
      ['first', null],
      ['hang', 'PREFLIGHT_TIMEOUT'],
      ['after', 'PREFLIGHT_TIMEOUT'],
    ]);
  });

  it('abandons a running session when the caller aborts', async () => {
    const fixture = await startServer({ hangCommand: 'sleep' });
    const controller = new AbortController();
    const started = Date.now();
    const pending = client.runCommands(
      { host: 'fixture.local', address: '127.0.0.1', port: fixture.port, username: 'ubuntu', privateKey: USER_KEY },
      [{ id: 'hang', command: 'sleep 60' }],
      { perCommandMs: 30_000, totalMs: 30_000, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toBeInstanceOf(SshTransportError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('refuses to start when the caller already aborted', async () => {
    const fixture = await startServer();
    const controller = new AbortController();
    controller.abort();
    await expect(client.runCommands(
      { host: 'fixture.local', address: '127.0.0.1', port: fixture.port, username: 'ubuntu', privateKey: USER_KEY },
      [{ id: 'uname', command: 'uname -m' }],
      { signal: controller.signal },
    )).rejects.toBeInstanceOf(SshTransportError);
    expect(fixture.commands).toEqual([]);
  });

  it('bounds a host-key scan against a peer that accepts the socket and says nothing', async () => {
    const silent = net.createServer((socket) => { socket.on('error', () => {}); });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = silent.address() as net.AddressInfo;
      const started = Date.now();
      await expect(plainClient.captureHostKey(
        { host: 'silent.local', address: '127.0.0.1', port },
        { timeoutMs: 200 },
      )).rejects.toBeInstanceOf(SshTransportError);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      silent.close();
    }
  });

  it('ignores an exec acknowledgement that arrives after the deadline', async () => {
    const fixture = await startServer({ delayExecMs: 200, delayExecCommand: 'sleep' });
    const results = await client.runCommands(
      { host: 'fixture.local', address: '127.0.0.1', port: fixture.port, username: 'ubuntu', privateKey: USER_KEY },
      [{ id: 'late', command: 'sleep 1' }],
      { perCommandMs: 60, totalMs: 1_000 },
    );
    expect(results[0]).toMatchObject({ timedOut: true, error: 'COMMAND_TIMEOUT' });
    // Let the late acknowledgement land; it must not reopen or append to the session.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(results).toHaveLength(1);
  });

  it('applies the byte cap to stderr as well as stdout', async () => {
    const fixture = await startServer({ largeStderr: true });
    const results = await client.runCommands(
      { host: 'fixture.local', address: '127.0.0.1', port: fixture.port, username: 'ubuntu', privateKey: USER_KEY },
      [{ id: 'stderr', command: 'cat big-error-file' }],
      {},
    );
    expect(results[0].truncated).toBe(true);
    expect(Buffer.byteLength(results[0].stderr)).toBeLessThanOrEqual(64 * 1024);
    expect(Buffer.byteLength(results[0].stdout)).toBeLessThanOrEqual(64 * 1024);
  });

  it('counts mixed stdout and stderr against one per-command budget', async () => {
    const fixture = await startServer({ mixedOutput: true });
    const results = await client.runCommands(
      { host: 'fixture.local', address: '127.0.0.1', port: fixture.port, username: 'ubuntu', privateKey: USER_KEY },
      [{ id: 'mixed', command: 'cat both-streams' }],
      {},
    );
    expect(results[0].truncated).toBe(true);
    const retained = Buffer.byteLength(results[0].stdout) + Buffer.byteLength(results[0].stderr);
    expect(retained).toBeLessThanOrEqual(64 * 1024);
  });

  it('shares one raw-byte budget across every command in the session', async () => {
    const fixture = await startServer({ largeOutput: true });
    const commands = Array.from({ length: 10 }, (_, index) => ({ id: `big-${index}`, command: `cat file-${index}` }));
    const results = await client.runCommands(
      { host: 'fixture.local', address: '127.0.0.1', port: fixture.port, username: 'ubuntu', privateKey: USER_KEY },
      commands,
      { perCommandMs: 2_000, totalMs: 20_000 },
    );
    expect(results).toHaveLength(10);
    expect(results[7].stdout.length).toBeGreaterThan(0);
    expect(results[8].error).toBe('OUTPUT_CAP');
    expect(results[9].error).toBe('OUTPUT_CAP');
    expect(results[9].stdout).toBe('');
    const total = results.reduce((sum, result) => sum + Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), 0);
    expect(total).toBeLessThanOrEqual(512 * 1024);
  });

  it('preserves NUL-delimited inventory output through the real transport', async () => {
    const fixture = await startServer({ responses: { 'sencho-inventory': 'one\0two\0' } });
    const results = await client.runCommands(
      { host: 'fixture.local', address: '127.0.0.1', port: fixture.port, username: 'ubuntu', privateKey: USER_KEY },
      [{ id: 'inventory', command: 'sh -c true sencho-inventory' }],
      {},
    );
    expect(results[0].stdout).toBe('one\0two\0');
  });
});
