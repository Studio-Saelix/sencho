/**
 * Local SSH git server for E2E specs.
 *
 * Spins up openssh-server with a forced git-upload-pack command and a bare
 * repository containing compose.yaml so Git Source dry-run validation passes.
 */
import { createHash } from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

export function sshGitFixtureAvailable(): boolean {
  return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0
    && spawnSync('/usr/sbin/sshd', ['-V'], { stdio: 'ignore' }).status === 0;
}

const COMPOSE_FIXTURE = `services:
  web:
    image: nginx
`;

function runGit(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function generateKeyPair(dir: string, name: string): { privatePem: string; publicLine: string; privatePath: string } {
  const privatePath = path.join(dir, name);
  const gen = spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', privatePath, '-q'], { encoding: 'utf8' });
  if (gen.status !== 0) throw new Error(`ssh-keygen failed: ${gen.stderr}`);
  return {
    privatePath,
    privatePem: readFileSync(privatePath, 'utf8'),
    publicLine: readFileSync(`${privatePath}.pub`, 'utf8').trim(),
  };
}

function buildBareRepo(): { bareDir: string; scratchDirs: string[] } {
  const srcDir = mkdtempSync(path.join(os.tmpdir(), 'sencho-e2e-ssh-src-'));
  writeFileSync(path.join(srcDir, 'compose.yaml'), COMPOSE_FIXTURE);
  runGit(srcDir, ['init', '-b', 'main']);
  runGit(srcDir, ['config', 'user.email', 'e2e@sencho.test']);
  runGit(srcDir, ['config', 'user.name', 'Sencho E2E SSH']);
  runGit(srcDir, ['add', '-A']);
  runGit(srcDir, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture']);
  const bareRoot = mkdtempSync(path.join(os.tmpdir(), 'sencho-e2e-ssh-bare-'));
  const bareDir = path.join(bareRoot, 'repo.git');
  const clone = spawnSync('git', ['clone', '--bare', '--quiet', srcDir, bareDir], { encoding: 'utf8' });
  if (clone.status !== 0) throw new Error(`git clone --bare failed: ${clone.stderr}`);
  return { bareDir, scratchDirs: [srcDir, bareRoot] };
}

async function waitForPort(host: string, port: number, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect({ host, port }, () => {
          socket.end();
          resolve();
        });
        socket.on('error', reject);
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(`port ${port} did not open within ${timeoutMs}ms`);
}

function fingerprintFromKnownHostsLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/);
  let keyBase64: string | null = null;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (parts[i].startsWith('ssh-') || parts[i].startsWith('ecdsa-') || parts[i].startsWith('sk-')) {
      keyBase64 = parts[i + 1];
      break;
    }
  }
  if (!keyBase64) return null;
  const digest = createHash('sha256').update(Buffer.from(keyBase64, 'base64')).digest('base64').replace(/=+$/, '');
  return `SHA256:${digest}`;
}

function runSshKeyscan(host: string, port: number): { knownHostsEntry: string; firstFingerprint: string } {
  const args = port === 22 ? ['-H', host] : ['-p', String(port), '-H', host];
  const result = spawnSync('ssh-keyscan', args, { encoding: 'utf8' });
  if (result.status !== 0 && !result.stdout.trim()) {
    throw new Error(result.stderr.trim() || 'ssh-keyscan failed');
  }
  const lines = result.stdout.trim().split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (lines.length === 0) throw new Error('ssh-keyscan returned no host keys');
  const firstFingerprint = fingerprintFromKnownHostsLine(lines[0]);
  if (!firstFingerprint) throw new Error('ssh-keyscan line could not be fingerprinted');
  return { knownHostsEntry: lines.join('\n'), firstFingerprint };
}

export interface SshGitE2eFixture {
  port: number;
  repoUrlSsh: string;
  deployPrivateKey: string;
  knownHostsEntry: string;
  firstFingerprint: string;
  close: () => void;
}

export async function startSshGitFixture(port = 22224): Promise<SshGitE2eFixture> {
  const repo = buildBareRepo();
  const sshRoot = mkdtempSync(path.join(os.tmpdir(), 'sencho-e2e-ssh-sshd-'));
  const scratchDirs = [...repo.scratchDirs, sshRoot];
  const cleanupScratch = (): void => {
    for (const dir of scratchDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  };

  const deploy = generateKeyPair(sshRoot, 'deploy');
  const hostKey = generateKeyPair(sshRoot, 'host');
  const authorizedKeysPath = path.join(sshRoot, 'authorized_keys');
  const forced = `command="git-upload-pack '${repo.bareDir}'",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ${deploy.publicLine}`;
  writeFileSync(authorizedKeysPath, `${forced}\n`, { mode: 0o600 });

  const configPath = path.join(sshRoot, 'sshd_config');
  const pidPath = path.join(sshRoot, 'sshd.pid');
  writeFileSync(
    configPath,
    [
      `Port ${port}`,
      'ListenAddress 127.0.0.1',
      `HostKey ${hostKey.privatePath}`,
      `AuthorizedKeysFile ${authorizedKeysPath}`,
      `PidFile ${pidPath}`,
      'UsePAM no',
      'PasswordAuthentication no',
      'PubkeyAuthentication yes',
      'X11Forwarding no',
      'StrictModes no',
      'LogLevel ERROR',
    ].join('\n'),
    { mode: 0o600 },
  );

  const child = spawn('/usr/sbin/sshd', ['-D', '-f', configPath, '-e'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

  try {
    await waitForPort('127.0.0.1', port);
  } catch (e) {
    child.kill('SIGKILL');
    cleanupScratch();
    throw new Error(`sshd did not come up on port ${port}: ${stderr.trim() || '(no stderr)'}`, { cause: e });
  }

  const { knownHostsEntry, firstFingerprint } = runSshKeyscan('127.0.0.1', port);
  const sshUser = os.userInfo().username;
  const repoUrlSsh = `ssh://${sshUser}@127.0.0.1:${port}${repo.bareDir}`;

  let closed = false;
  return {
    port,
    repoUrlSsh,
    deployPrivateKey: deploy.privatePem,
    knownHostsEntry,
    firstFingerprint,
    close: () => {
      if (closed) return;
      closed = true;
      child.kill('SIGTERM');
      cleanupScratch();
    },
  };
}
