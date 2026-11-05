import crypto from 'crypto';
import { Client, utils as sshUtils } from 'ssh2';
import type { ConnectConfig } from 'ssh2';
import type { HostKeyObservation } from './types';

/**
 * Minimal, read-only SSH transport for the bootstrap preflight.
 *
 * Policy, enforced here rather than by convention:
 * - public-key auth only, no agent, no forwarding, no PTY, no shell;
 * - the host key is checked before any authentication or command;
 * - each command has its own timeout, the session has a total budget;
 * - output is capped, and a capped result is reported as truncated so the
 *   dependent check can degrade to `unknown` instead of passing on partial data.
 */

export interface SshTarget {
  host: string;
  address: string;
  port: number;
}

export interface SshSessionInput extends SshTarget {
  username: string;
  privateKey: Buffer | string;
  passphrase?: string | null;
}

export interface SshCommand {
  id: string;
  command: string;
}

export interface SshCommandResult {
  id: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
  timedOut: boolean;
  error: string | null;
}

export type SshErrorCode =
  | 'SSH_AUTH_FAILED'
  | 'SSH_KEY_INVALID'
  | 'SSH_KEY_PASSPHRASE_REQUIRED'
  | 'SSH_UNREACHABLE'
  | 'SSH_DNS_FAILED'
  | 'HOST_KEY_UNTRUSTED'
  | 'PREFLIGHT_TIMEOUT';

export class SshTransportError extends Error {
  public readonly code: SshErrorCode;
  public readonly status: number;

  public constructor(code: SshErrorCode, message: string) {
    super(message);
    this.name = 'SshTransportError';
    this.code = code;
    this.status = code === 'PREFLIGHT_TIMEOUT' ? 504 : code === 'HOST_KEY_UNTRUSTED' ? 409 : 422;
  }
}

export interface BootstrapTransport {
  captureHostKey(target: SshTarget): Promise<HostKeyObservation>;
  runCommands(
    session: SshSessionInput,
    commands: SshCommand[],
    options?: {
      expectedFingerprint?: string | null;
      totalMs?: number;
      perCommandMs?: number;
      onHostKey?: (observation: HostKeyObservation) => void;
    },
  ): Promise<SshCommandResult[]>;
}

export const SSH_CONNECT_TIMEOUT_MS = 15_000;
export const SSH_COMMAND_TIMEOUT_MS = 10_000;
export const SSH_TOTAL_TIMEOUT_MS = 90_000;
export const SSH_MAX_BYTES_PER_COMMAND = 64 * 1024;
export const SSH_MAX_BYTES_TOTAL = 512 * 1024;

const CONTROLS_EXCEPT_LAYOUT_AND_NUL = /[\x00-\x08\x0b-\x1f\x7f]/g;
const ANSI_ESCAPE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

/** Keep newline, tab and NUL (inventory output is NUL-delimited); drop the rest. */
export function scrubCommandOutput(raw: string): string {
  return raw.replace(ANSI_ESCAPE, '').replace(CONTROLS_EXCEPT_LAYOUT_AND_NUL, '');
}

/** Remove secret material from an error or message before it is logged or returned. */
export function scrubSecrets(text: string, secrets: Array<string | null | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 8) continue;
    out = out.split(secret).join('[redacted]');
  }
  return out;
}

function sha256Fingerprint(keyBlob: Buffer): string {
  const digest = crypto.createHash('sha256').update(keyBlob).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

/** SSH wire string: uint32 length followed by the name bytes. */
function readSshString(blob: Buffer, offset: number): { value: Buffer; next: number } | null {
  if (blob.length < offset + 4) return null;
  const length = blob.readUInt32BE(offset);
  const start = offset + 4;
  if (blob.length < start + length) return null;
  return { value: blob.subarray(start, start + length), next: start + length };
}

export function hostKeyObservation(host: string, keyBlob: Buffer): HostKeyObservation {
  const algorithm = readSshString(keyBlob, 0)?.value.toString('ascii') || 'unknown';
  return {
    algorithm,
    fingerprint: sha256Fingerprint(keyBlob),
    knownHostsLine: `${host} ${algorithm} ${keyBlob.toString('base64')}`,
  };
}

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function parsePrivateKey(key: string, passphrase?: string | null): void {
  if (!key.trim()) {
    throw new SshTransportError('SSH_KEY_INVALID', 'A private SSH key is required.');
  }
  const parsed = sshUtils.parseKey(key, passphrase ?? undefined);
  if (parsed instanceof Error) {
    const message = parsed.message || '';
    if (!passphrase && /passphrase|encrypted/i.test(message)) {
      throw new SshTransportError('SSH_KEY_PASSPHRASE_REQUIRED', 'This key is encrypted. Enter its passphrase.');
    }
    throw new SshTransportError(
      'SSH_KEY_INVALID',
      'The private key could not be read. Use an OpenSSH key (id_ed25519 or an RSA key in PEM format).',
    );
  }
  if (Array.isArray(parsed) && parsed.length === 0) {
    throw new SshTransportError('SSH_KEY_INVALID', 'The private key could not be read.');
  }
}

function isAuthError(message: string): boolean {
  return /authentication methods failed|authentication failed|permission denied|publickey/i.test(message);
}

/** Map a raw ssh2/socket error to the API's transport codes. */
export function mapSshError(error: unknown): SshTransportError {
  if (error instanceof SshTransportError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string } | null)?.code;
  if (code === 'ENOTFOUND' || /ENOTFOUND|getaddrinfo/i.test(message)) {
    return new SshTransportError('SSH_DNS_FAILED', 'The target host could not be resolved.');
  }
  if (code === 'ETIMEDOUT' || /timed out|timeout/i.test(message)) {
    return new SshTransportError('SSH_UNREACHABLE', 'The target did not answer in time.');
  }
  if (isAuthError(message)) {
    return new SshTransportError('SSH_AUTH_FAILED', 'Authentication failed. Check the SSH user and private key.');
  }
  if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ECONNRESET') {
    return new SshTransportError('SSH_UNREACHABLE', 'The target refused the SSH connection.');
  }
  return new SshTransportError('SSH_UNREACHABLE', 'The SSH connection failed.');
}

interface ExecOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
  timedOut: boolean;
}

function execOne(
  conn: Client,
  command: string,
  timeoutMs: number,
  maxBytes: number,
  remainingTotalBytes: number,
): Promise<ExecOutcome> {
  const cap = Math.min(maxBytes, remainingTotalBytes);
  return new Promise((resolve, reject) => {
    conn.exec(`LC_ALL=C ${command}`, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let truncated = false;
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        stream.destroy();
        finish();
      }, timeoutMs);

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          stdout: scrubCommandOutput(Buffer.concat(stdout).toString('utf8')),
          stderr: scrubCommandOutput(Buffer.concat(stderr).toString('utf8')),
          exitCode: null,
          truncated,
          timedOut,
        });
      };

      stream.on('data', (chunk: Buffer) => {
        if (bytes >= cap) {
          truncated = true;
          return;
        }
        const room = cap - bytes;
        const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
        if (chunk.length > room) truncated = true;
        bytes += slice.length;
        stdout.push(slice);
      });
      stream.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 32) stderr.push(Buffer.from(chunk));
      });
      stream.on('close', (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          stdout: scrubCommandOutput(Buffer.concat(stdout).toString('utf8')),
          stderr: scrubCommandOutput(Buffer.concat(stderr).toString('utf8')),
          exitCode: typeof code === 'number' ? code : null,
          truncated,
          timedOut,
        });
      });
      stream.on('error', () => finish());
    });
  });
}

interface HostKeyCapture {
  keyBlob: Buffer | null;
}

function captureHostKeyFrom(target: SshTarget): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const capture: HostKeyCapture = { keyBlob: null };
    const conn = new Client();
    const config: ConnectConfig = {
      host: target.address,
      port: target.port,
      username: 'sencho-keyscan',
      readyTimeout: SSH_CONNECT_TIMEOUT_MS,
      hostVerifier: (key: Buffer) => {
        capture.keyBlob = Buffer.from(key);
        // Abort before authentication: a keyscan needs the key, nothing else.
        return false;
      },
    };
    let done = false;
    const settle = (error?: Error) => {
      if (done) return;
      done = true;
      conn.end();
      if (capture.keyBlob) resolve(capture.keyBlob);
      else reject(mapSshError(error ?? new Error('host key unavailable')));
    };
    conn.on('ready', () => settle());
    conn.on('error', (error: Error) => settle(error));
    conn.on('close', () => settle());
    conn.connect(config);
  });
}

function runSession(
  session: SshSessionInput,
  commands: SshCommand[],
  options: {
    expectedFingerprint?: string | null;
    totalMs: number;
    perCommandMs: number;
    onHostKey?: (observation: HostKeyObservation) => void;
  },
): Promise<SshCommandResult[]> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const config: ConnectConfig = {
      host: session.address,
      port: session.port,
      username: session.username,
      privateKey: session.privateKey,
      passphrase: session.passphrase ?? undefined,
      readyTimeout: SSH_CONNECT_TIMEOUT_MS,
      keepaliveInterval: 5_000,
      keepaliveCountMax: 2,
      hostVerifier: (key: Buffer) => {
        const observation = hostKeyObservation(session.host, key);
        options.onHostKey?.(observation);
        if (!options.expectedFingerprint) return true;
        const matches = safeEquals(observation.fingerprint, options.expectedFingerprint);
        if (!matches) hostKeyRejected = true;
        return matches;
      },
    };

    const results: SshCommandResult[] = [];
    const deadline = Date.now() + options.totalMs;
    let finished = false;
    let ready = false;
    let hostKeyRejected = false;
    let completed = 0;
    let remainingBytes = SSH_MAX_BYTES_TOTAL;

    const fail = (error: unknown) => {
      if (finished) return;
      finished = true;
      conn.end();
      reject(hostKeyRejected
        ? new SshTransportError('HOST_KEY_UNTRUSTED', 'The host key changed before the preflight connected.')
        : mapSshError(error));
    };

    const finish = () => {
      if (finished) return;
      finished = true;
      conn.end();
      resolve(results);
    };

    conn.on('error', fail);
    conn.on('ready', () => {
      ready = true;
      void (async () => {
        try {
          for (const command of commands) {
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) {
              results.push({
                id: command.id,
                stdout: '',
                stderr: '',
                exitCode: null,
                truncated: false,
                timedOut: true,
                error: 'PREFLIGHT_TIMEOUT',
              });
              continue;
            }
            if (remainingBytes <= 0) {
              results.push({
                id: command.id,
                stdout: '',
                stderr: '',
                exitCode: null,
                truncated: true,
                timedOut: false,
                error: 'OUTPUT_CAP',
              });
              continue;
            }
            const outcome = await execOne(
              conn,
              command.command,
              Math.min(options.perCommandMs, remainingMs),
              SSH_MAX_BYTES_PER_COMMAND,
              remainingBytes,
            );
            remainingBytes -= Buffer.byteLength(outcome.stdout) + Buffer.byteLength(outcome.stderr);
            results.push({
              id: command.id,
              stdout: outcome.stdout,
              stderr: outcome.stderr,
              exitCode: outcome.exitCode,
              truncated: outcome.truncated,
              timedOut: outcome.timedOut,
              error: outcome.timedOut ? 'COMMAND_TIMEOUT' : null,
            });
            completed += 1;
            if (outcome.timedOut) break;
          }
          finish();
        } catch (error: unknown) {
          fail(error);
        }
      })();
    });

    conn.on('close', () => {
      if (!finished) {
        finished = true;
        if (!ready) {
          reject(hostKeyRejected
            ? new SshTransportError('HOST_KEY_UNTRUSTED', 'The host key changed before the preflight connected.')
            : new SshTransportError('SSH_UNREACHABLE', 'The SSH connection closed before authentication.'));
          return;
        }
        if (completed < commands.length) {
          // A dropped session must not look like a completed inspection: an
          // unread fact would otherwise be reported as a clean negative.
          reject(new SshTransportError('SSH_UNREACHABLE', 'The SSH connection closed before the inspection finished.'));
          return;
        }
        resolve(results);
      }
    });

    conn.connect(config);
  });
}

export class SshProbeClient implements BootstrapTransport {
  public async captureHostKey(target: SshTarget): Promise<HostKeyObservation> {
    const keyBlob = await captureHostKeyFrom(target);
    return hostKeyObservation(target.host, keyBlob);
  }

  public async runCommands(
    session: SshSessionInput,
    commands: SshCommand[],
    options: {
      expectedFingerprint?: string | null;
      totalMs?: number;
      perCommandMs?: number;
      onHostKey?: (observation: HostKeyObservation) => void;
    } = {},
  ): Promise<SshCommandResult[]> {
    parsePrivateKey(
      typeof session.privateKey === 'string' ? session.privateKey : session.privateKey.toString('utf8'),
      session.passphrase,
    );
    return runSession(session, commands, {
      expectedFingerprint: options.expectedFingerprint ?? null,
      totalMs: options.totalMs ?? SSH_TOTAL_TIMEOUT_MS,
      perCommandMs: options.perCommandMs ?? SSH_COMMAND_TIMEOUT_MS,
      onHostKey: options.onHostKey,
    });
  }
}

/** Exported for the route tests that inject a transport. */
export const sshProbeClient = new SshProbeClient();
