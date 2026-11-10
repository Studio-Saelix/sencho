import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { Server, utils } from 'ssh2';
import { sshExecClient } from '../services/nodeBootstrap/sshExecClient';
import { SshTransportError, hostKeyObservation } from '../services/nodeBootstrap/sshProbeClient';
import { READ_EXIT, WRITE_EXIT, readFileCommand, writeFileCommand } from '../services/nodeBootstrap/executionCommands';
import { commandDetail, maskComposeToken, TOKEN_PLACEHOLDER } from '../services/nodeBootstrap/stepRunner';
import { buildPilotEnrollmentCompose } from '../helpers/pilotEnrollmentCompose';

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * The execution transport against an in-process SSH server, and the fixed
 * write and read scripts against a real POSIX shell and filesystem.
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

function hostFingerprint(): string {
  const parsed = utils.parseKey(HOST_KEY);
  if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('host key did not parse');
  return hostKeyObservation('127.0.0.1', parsed.getPublicSSH()).fingerprint;
}

interface ServerLog {
  port: number;
  commands: string[];
  stdin: string[];
  authenticated: number;
  ptyOrShell: number;
  server: Server;
}

const servers: Server[] = [];

async function startServer(handle: (command: string, stream: import('ssh2').ServerChannel, end: () => void) => void): Promise<ServerLog> {
  const log: Omit<ServerLog, 'port' | 'server'> = { commands: [], stdin: [], authenticated: 0, ptyOrShell: 0 };
  const server = new Server({ hostKeys: [HOST_KEY] }, (client) => {
    client.on('error', () => {});
    client.on('authentication', (ctx) => {
      log.authenticated += 1;
      ctx.accept();
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('pty', () => { log.ptyOrShell += 1; });
        session.on('shell', () => { log.ptyOrShell += 1; });
        session.on('exec', (acceptExec, _reject, info) => {
          log.commands.push(info.command);
          const stream = acceptExec();
          let input = '';
          stream.on('data', (chunk: Buffer) => { input += chunk.toString('utf8'); });
          stream.on('end', () => log.stdin.push(input));
          handle(info.command, stream, () => client.end());
        });
      });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { ...log, port, server, get commands() { return log.commands; }, get stdin() { return log.stdin; }, get authenticated() { return log.authenticated; }, get ptyOrShell() { return log.ptyOrShell; } } as ServerLog;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function session(port: number) {
  return { host: '127.0.0.1', address: '127.0.0.1', port, username: 'ubuntu', privateKey: USER_KEY, passphrase: null };
}

describe('bootstrap execution session', () => {
  it('refuses a host key other than the approved one before authenticating', async () => {
    const log = await startServer((_command, stream) => { stream.exit(0); stream.end(); });
    await expect(sshExecClient.open(session(log.port), { expectedFingerprint: 'SHA256:not-this-host' }))
      .rejects.toMatchObject({ code: 'HOST_KEY_UNTRUSTED' });
    expect(log.authenticated).toBe(0);
    expect(log.commands).toEqual([]);
  });

  it('runs each command as one exec with standard input, no PTY and no shell', async () => {
    const log = await startServer((command, stream) => {
      stream.on('end', () => {
        stream.write(`ran ${command.length}\n`);
        stream.exit(command.includes('fail') ? 7 : 0);
        stream.end();
      });
    });
    const exec = await sshExecClient.open(session(log.port), { expectedFingerprint: hostFingerprint() });
    const written = await exec.run('cat > /dev/null', { timeoutMs: 5_000, stdin: 'secret-file-content' });
    const failed = await exec.run('fail', { timeoutMs: 5_000 });
    exec.close();
    expect(written).toMatchObject({ exitCode: 0, timedOut: false, error: null });
    expect(failed.exitCode).toBe(7);
    expect(log.commands).toEqual(['LC_ALL=C cat > /dev/null', 'LC_ALL=C fail']);
    expect(log.stdin[0]).toBe('secret-file-content');
    expect(log.stdin[1]).toBe('');
    expect(log.ptyOrShell).toBe(0);
  });

  it('reports a command that outlives its deadline as timed out', async () => {
    const log = await startServer(() => { /* never exits */ });
    const exec = await sshExecClient.open(session(log.port), { expectedFingerprint: hostFingerprint() });
    const result = await exec.run('sleep 600', { timeoutMs: 100 });
    exec.close();
    expect(result).toMatchObject({ exitCode: null, timedOut: true });
  });

  it('reports a connection dropped mid-command as lost, and every later command too', async () => {
    const log = await startServer((_command, _stream, end) => { setTimeout(end, 20); });
    const exec = await sshExecClient.open(session(log.port), { expectedFingerprint: hostFingerprint() });
    const result = await exec.run('apt-get install -y docker-ce', { timeoutMs: 5_000 });
    expect(result).toMatchObject({ exitCode: null, timedOut: false, error: 'CONNECTION_LOST' });
    await expect(exec.run('true', { timeoutMs: 1_000 })).resolves.toMatchObject({ error: 'CONNECTION_LOST' });
    expect(exec.closed).toBe(true);
  });

  it('keeps only the tail of a long output, and the head of a file read', async () => {
    const log = await startServer((_command, stream) => {
      stream.write(`${'a'.repeat(40 * 1024)}END-OF-OUTPUT`);
      stream.exit(0);
      stream.end();
    });
    const exec = await sshExecClient.open(session(log.port), { expectedFingerprint: hostFingerprint() });
    const tail = await exec.run('noisy', { timeoutMs: 5_000 });
    const head = await exec.run('noisy', { timeoutMs: 5_000, keep: { mode: 'head', maxBytes: 1024 } });
    exec.close();
    expect(tail.truncated).toBe(true);
    expect(tail.stdout.endsWith('END-OF-OUTPUT')).toBe(true);
    expect(tail.stdout.length).toBeLessThanOrEqual(16 * 1024);
    expect(head.truncated).toBe(true);
    expect(head.stdout).toBe('a'.repeat(1024));
  });

  it('rejects an unreadable key before dialing', async () => {
    await expect(sshExecClient.open({ ...session(1), privateKey: 'not a key' }, { expectedFingerprint: 'SHA256:x' }))
      .rejects.toBeInstanceOf(SshTransportError);
  });
});

/** Run a built command the way sshd does: through a POSIX shell, file content on standard input. */
function runShell(command: string, stdin = ''): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('sh', ['-c', `LC_ALL=C ${command}`], { input: stdin, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('bootstrap write and read scripts on a real shell', () => {
  let dir: string;
  const owner = os.userInfo().username;
  const group = execFileSync('id', ['-gn'], { encoding: 'utf8' }).trim();
  const file = { mode: '0600', owner, group };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-bootstrap-write-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes standard input atomically with the planned mode and leaves no temporary file', () => {
    const target = path.join(dir, 'compose.yaml');
    const result = runShell(writeFileCommand(target, { ...file, sha256: sha256('name: sencho-agent\n') }, { sudo: false, replaces: null }), 'name: sencho-agent\n');
    expect(result.status).toBe(0);
    expect(fs.readFileSync(target, 'utf8')).toBe('name: sencho-agent\n');
    expect((fs.statSync(target).mode & 0o777).toString(8)).toBe('600');
    expect(fs.readdirSync(dir)).toEqual(['compose.yaml']);
  });

  it('refuses to clobber, to write through a symlink, or into a missing directory', () => {
    const target = path.join(dir, 'compose.yaml');
    fs.writeFileSync(target, 'theirs');
    expect(runShell(writeFileCommand(target, { ...file, sha256: sha256('ours') }, { sudo: false, replaces: null }), 'ours').status).toBe(WRITE_EXIT.exists);
    expect(fs.readFileSync(target, 'utf8')).toBe('theirs');

    const elsewhere = path.join(dir, 'elsewhere');
    fs.writeFileSync(elsewhere, 'untouched');
    const link = path.join(dir, 'linked.yaml');
    fs.symlinkSync(elsewhere, link);
    expect(runShell(writeFileCommand(link, { ...file, sha256: sha256('ours') }, { sudo: false, replaces: sha256('untouched') }), 'ours').status).toBe(WRITE_EXIT.notRegular);
    expect(fs.readFileSync(elsewhere, 'utf8')).toBe('untouched');

    fs.mkdirSync(path.join(dir, 'a-directory'));
    expect(runShell(writeFileCommand(path.join(dir, 'a-directory'), { ...file, sha256: sha256('ours') }, { sudo: false, replaces: sha256('x') }), 'ours').status).toBe(WRITE_EXIT.notRegular);
    expect(runShell(writeFileCommand(path.join(dir, 'missing', 'x'), { ...file, sha256: sha256('ours') }, { sudo: false, replaces: null }), 'ours').status).toBe(WRITE_EXIT.notDirectory);
    expect(fs.readdirSync(dir).sort()).toEqual(['a-directory', 'compose.yaml', 'elsewhere', 'linked.yaml']);
  });

  it('refuses to put a file in place when standard input ended early', () => {
    const target = path.join(dir, 'compose.yaml');
    const full = 'name: sencho-agent\nservices: {}\n';
    const result = runShell(writeFileCommand(target, { ...file, sha256: sha256(full) }, { sudo: false, replaces: null }), full.slice(0, 10));
    expect(result.status).toBe(WRITE_EXIT.incomplete);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('replaces an existing file in place when clobbering is allowed', () => {
    const target = path.join(dir, 'compose.yaml');
    fs.writeFileSync(target, 'old', { mode: 0o644 });
    expect(runShell(writeFileCommand(target, { ...file, sha256: sha256('new') }, { sudo: false, replaces: sha256('old') }), 'new').status).toBe(0);
    expect(fs.readFileSync(target, 'utf8')).toBe('new');
    expect((fs.statSync(target).mode & 0o777).toString(8)).toBe('600');
    expect(fs.readdirSync(dir)).toEqual(['compose.yaml']);
  });

  it('treats injection-shaped paths and content as data', () => {
    const hostile = path.join(dir, "it's $(touch pwned) `id`;");
    fs.mkdirSync(hostile);
    const target = path.join(hostile, 'compose.yaml');
    const content = "$(touch pwned-content)\n`touch pwned-tick`\n'; touch pwned-quote; '\n";
    const result = runShell(writeFileCommand(target, { ...file, sha256: sha256(content) }, { sudo: false, replaces: null }), content);
    expect(result.status).toBe(0);
    expect(fs.readFileSync(target, 'utf8')).toBe(content);
    const read = runShell(readFileCommand(target, false));
    expect(Buffer.from(read.stdout, 'base64').toString('utf8')).toBe(content);
    for (const where of [dir, hostile, process.cwd()]) {
      expect(fs.readdirSync(where).some((name) => name.startsWith('pwned'))).toBe(false);
    }
  });

  it('reads a file as base64 and tells a missing path from a non-regular one', () => {
    const target = path.join(dir, 'marker.json');
    fs.writeFileSync(target, Buffer.from([0, 1, 2, 255]));
    const read = runShell(readFileCommand(target, false));
    expect(read.status).toBe(0);
    expect(Buffer.from(read.stdout, 'base64')).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(runShell(readFileCommand(path.join(dir, 'absent'), false)).status).toBe(READ_EXIT.missing);
    fs.symlinkSync(target, path.join(dir, 'link'));
    expect(runShell(readFileCommand(path.join(dir, 'link'), false)).status).toBe(READ_EXIT.notRegular);
    expect(runShell(readFileCommand(dir, false)).status).toBe(READ_EXIT.notRegular);
  });

  it('prefixes sudo -n only when the step needs it', () => {
    expect(writeFileCommand('/etc/apt/sources.list.d/docker.list', { mode: '0644', owner: 'root', group: 'root', sha256: sha256('x') }, { sudo: true, replaces: null })).toMatch(/^sudo -n sh -c /);
    expect(readFileCommand('/opt/sencho-agent/compose.yaml', false)).toMatch(/^sh -c /);
  });
});

describe('bootstrap output hygiene', () => {
  it('masks only the enrollment token in a canonical compose file', () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.payload.signature';
    const real = buildPilotEnrollmentCompose({ primaryUrl: 'https://hub.example.com', token, composeDir: '/opt/docker/sencho' });
    const preview = buildPilotEnrollmentCompose({ primaryUrl: 'https://hub.example.com', token: TOKEN_PLACEHOLDER, composeDir: '/opt/docker/sencho' });
    expect(maskComposeToken(real)).toBe(preview);
    expect(maskComposeToken(real.replace('/opt/docker/sencho', '/srv/other'))).not.toBe(preview);
  });

  it('scrubs secrets before cutting, and drops a cut leading line', () => {
    const secret = 'eyJhbGciOiJIUzI1NiJ9.very-secret-token-value';
    const result = {
      exitCode: 1,
      stdout: '',
      stderr: `${secret.slice(10)}\nE: real error with ${secret}\n`,
      truncated: true,
      timedOut: false,
      error: null,
    } as const;
    const detail = commandDetail(result, [secret]);
    expect(detail).toBe('E: real error with [redacted]');
    expect(detail).not.toContain(secret.slice(10));
  });
});
