import crypto from 'crypto';
import { Client, utils as sshUtils } from 'ssh2';
import type { ClientChannel, ConnectConfig } from 'ssh2';
import { sanitizeForLog } from '../../utils/safeLog';
import type { HostKeyObservation } from './types';

/**
 * Minimal, read-only SSH transport for the bootstrap preflight.
 *
 * Policy, enforced here rather than by convention:
 * - public-key auth only, no agent, no forwarding, no PTY, no interactive shell
 *   (each fixed command runs through exec, never a shell channel);
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
  | 'SSH_KEY_PASSPHRASE_INVALID'
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

/** The caller went away before the request finished. */
export function cancelledError(): SshTransportError {
  return new SshTransportError('SSH_UNREACHABLE', 'The request was cancelled.');
}

export interface BootstrapTransport {
  captureHostKey(target: SshTarget, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<HostKeyObservation>;
  runCommands(
    session: SshSessionInput,
    commands: SshCommand[],
    options?: {
      expectedFingerprint?: string | null;
      totalMs?: number;
      perCommandMs?: number;
      onHostKey?: (observation: HostKeyObservation) => void;
      /** Aborts the session and releases the connection when the caller goes away. */
      signal?: AbortSignal;
    },
  ): Promise<SshCommandResult[]>;
}

export const SSH_CONNECT_TIMEOUT_MS = 15_000;
export const SSH_COMMAND_TIMEOUT_MS = 10_000;
export const SSH_TOTAL_TIMEOUT_MS = 90_000;
export const SSH_MAX_BYTES_PER_COMMAND = 64 * 1024;
export const SSH_MAX_BYTES_TOTAL = 512 * 1024;

// Start at 0x01: NUL is the inventory record separator and must survive.
const CONTROLS_EXCEPT_LAYOUT_AND_NUL = /[\x01-\x08\x0b-\x1f\x7f]/g;
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

export function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function parsePrivateKey(key: string, passphrase?: string | null): void {
  if (!key.trim()) {
    throw new SshTransportError('SSH_KEY_INVALID', 'A private SSH key is required.');
  }
  // An empty passphrase is no passphrase: ssh2 would try it as a real one.
  const parsed = sshUtils.parseKey(key, passphrase || undefined);
  if (parsed instanceof Error) {
    const message = parsed.message || '';
    if (!passphrase && /passphrase|encrypted/i.test(message)) {
      throw new SshTransportError('SSH_KEY_PASSPHRASE_REQUIRED', 'This key is encrypted. Enter its passphrase.');
    }
    // ssh2 words a failed decryption as "bad passphrase" for OpenSSH, PEM and PPK keys.
    if (passphrase && /bad passphrase/i.test(message)) {
      throw new SshTransportError('SSH_KEY_PASSPHRASE_INVALID', 'The passphrase does not unlock this key. Check it and try again.');
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
  /** Raw bytes retained before scrubbing, for the session-wide budget. */
  bytes: number;
  /** Transport-level failure that is neither a timeout nor a normal exit. */
  error: string | null;
}

function execOne(
  conn: Client,
  command: string,
  timeoutMs: number,
  maxBytes: number,
  remainingTotalBytes: number,
  onTimeout: () => void,
): Promise<ExecOutcome> {
  const cap = Math.min(maxBytes, remainingTotalBytes);
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let stream: ClientChannel | null = null;

    const snapshot = (exitCode: number | null, error: string | null): ExecOutcome => ({
      stdout: scrubCommandOutput(Buffer.concat(stdout).toString('utf8')),
      stderr: scrubCommandOutput(Buffer.concat(stderr).toString('utf8')),
      exitCode,
      truncated,
      timedOut,
      bytes,
      error,
    });
    const settle = (exitCode: number | null, error: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(snapshot(exitCode, error));
    };
    // Budget both output streams through one raw-byte counter. A peer that
    // writes only stderr must hit the same cap as one that writes stdout.
    const collect = (chunk: Buffer, target: Buffer[]): void => {
      if (bytes >= cap) {
        truncated = true;
        return;
      }
      const room = cap - bytes;
      const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (chunk.length > room) truncated = true;
      bytes += slice.length;
      target.push(slice);
    };

    // The timer starts before the exec request, so a peer that withholds the
    // exec acknowledgement cannot keep the request (and the target lock) alive.
    const timer = setTimeout(() => {
      timedOut = true;
      onTimeout();
      try {
        stream?.destroy();
      } catch {
        // The channel may already be gone; the session close is the cleanup.
      }
      settle(null, 'COMMAND_TIMEOUT');
    }, timeoutMs);

    conn.exec(`LC_ALL=C ${command}`, (err, channel) => {
      if (settled) {
        try {
          channel?.destroy();
        } catch {
          // Late acknowledgement after the deadline: nothing left to read.
        }
        return;
      }
      if (err) {
        settled = true;
        clearTimeout(timer);
        reject(err);
        return;
      }
      stream = channel;
      channel.on('data', (chunk: Buffer) => collect(chunk, stdout));
      channel.stderr.on('data', (chunk: Buffer) => collect(chunk, stderr));
      channel.on('close', (code: number | null) => {
        if (typeof code === 'number') settle(code, null);
        else settle(null, 'COMMAND_ERROR');
      });
      channel.on('error', () => settle(null, 'COMMAND_ERROR'));
    });
  });
}

interface HostKeyCapture {
  keyBlob: Buffer | null;
}

function captureHostKeyFrom(
  target: SshTarget,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const capture: HostKeyCapture = { keyBlob: null };
    const conn = new Client();
    const budgetMs = Math.max(1, Math.min(SSH_CONNECT_TIMEOUT_MS, options.timeoutMs ?? SSH_CONNECT_TIMEOUT_MS));
    const config: ConnectConfig = {
      host: target.address,
      port: target.port,
      username: 'sencho-keyscan',
      readyTimeout: budgetMs,
      hostVerifier: (key: Buffer) => {
        capture.keyBlob = Buffer.from(key);
        // Abort before authentication: a keyscan needs the key, nothing else.
        return false;
      },
    };
    let done = false;
    // ssh2's readyTimeout only covers the handshake; this timer also bounds a
    // peer that stalls elsewhere, and the caller's deadline caps both.
    const timer = setTimeout(() => settle(new Error('The target did not answer in time (timeout).')), budgetMs);
    const onAbort = () => settle(cancelledError());
    const settle = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      conn.destroy();
      if (capture.keyBlob) resolve(capture.keyBlob);
      else reject(mapSshError(error ?? new Error('host key unavailable')));
    };
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
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
    signal?: AbortSignal;
  },
): Promise<SshCommandResult[]> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const config: ConnectConfig = {
      host: session.address,
      port: session.port,
      username: session.username,
      privateKey: session.privateKey,
      passphrase: session.passphrase || undefined,
      readyTimeout: SSH_CONNECT_TIMEOUT_MS,
      keepaliveInterval: 5_000,
      keepaliveCountMax: 2,
      hostVerifier: (key: Buffer) => {
        const observation = hostKeyObservation(session.host, key);
        options.onHostKey?.(observation);
        // No expected fingerprint means no trust decision was made: refuse
        // before authentication rather than accept whatever key answers.
        if (!options.expectedFingerprint) {
          hostKeyRejected = true;
          return false;
        }
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
    let aborted = false;
    let watchdog: NodeJS.Timeout | null = null;

    const clearWatchdog = () => {
      if (watchdog) {
        clearTimeout(watchdog);
        watchdog = null;
      }
    };
    const timeoutResult = (command: SshCommand): SshCommandResult => ({
      id: command.id,
      stdout: '',
      stderr: '',
      exitCode: null,
      truncated: false,
      timedOut: true,
      error: 'PREFLIGHT_TIMEOUT',
    });

    const fail = (error: unknown) => {
      if (finished) return;
      finished = true;
      clearWatchdog();
      options.signal?.removeEventListener('abort', onAbort);
      conn.destroy();
      if (hostKeyRejected) {
        reject(new SshTransportError('HOST_KEY_UNTRUSTED', 'The host key changed before the preflight connected.'));
        return;
      }
      const mapped = mapSshError(error);
      // The API reply is deliberately generic; keep the cause for the operator.
      if (!(error instanceof SshTransportError)) {
        console.warn(
          `[Bootstrap] SSH session to ${sanitizeForLog(session.host)} failed (${mapped.code}):`,
          sanitizeForLog(error instanceof Error ? error.message : String(error)),
        );
      }
      reject(mapped);
    };
    const onAbort = () => fail(cancelledError());

    const finish = () => {
      if (finished) return;
      finished = true;
      clearWatchdog();
      options.signal?.removeEventListener('abort', onAbort);
      // Destroy rather than end(): end() only half-closes the socket, so a peer
      // that withholds its own close keeps the connection open after the request
      // released its target lock, and a destroy() after end() would do nothing
      // because ssh2 skips it once the socket is no longer writable. This skips
      // the SSH disconnect message; every command has finished or been
      // abandoned, so there is nothing left to flush.
      conn.destroy();
      resolve(results);
    };

    // The watchdog is independent of every callback. It covers connect, exec
    // acknowledgement and stream collection, so a peer cannot hold the request
    // open past the session budget.
    watchdog = setTimeout(() => {
      if (finished) return;
      aborted = true;
      for (let index = completed; index < commands.length; index += 1) {
        results.push(timeoutResult(commands[index]));
      }
      // finish() destroys the connection, a connect that has not completed included.
      finish();
    }, options.totalMs);

    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });

    conn.on('error', fail);
    conn.on('ready', () => {
      // A connect that completes after the session was already settled must
      // not leave an authenticated connection behind.
      if (finished) {
        conn.destroy();
        return;
      }
      ready = true;
      void (async () => {
        try {
          for (const command of commands) {
            if (finished) return;
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) {
              results.push(timeoutResult(command));
              completed += 1;
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
              completed += 1;
              continue;
            }
            const outcome = await execOne(
              conn,
              command.command,
              Math.min(options.perCommandMs, remainingMs),
              SSH_MAX_BYTES_PER_COMMAND,
              remainingBytes,
              () => {
                aborted = true;
                conn.destroy();
              },
            );
            if (finished) return;
            remainingBytes -= outcome.bytes;
            // The command timer is capped by what is left of the session budget,
            // so it can fire just before the watchdog. A timeout the session
            // budget bounded (on a tie too) is the session timeout, and the
            // commands behind it did not run either: the outcome must not depend
            // on which timer wins the race.
            const sessionBound = outcome.timedOut && remainingMs <= options.perCommandMs;
            results.push({
              id: command.id,
              stdout: outcome.stdout,
              stderr: outcome.stderr,
              exitCode: outcome.exitCode,
              truncated: outcome.truncated,
              timedOut: outcome.timedOut,
              error: outcome.timedOut ? (sessionBound ? 'PREFLIGHT_TIMEOUT' : 'COMMAND_TIMEOUT') : outcome.error,
            });
            completed += 1;
            if (sessionBound) {
              for (let index = completed; index < commands.length; index += 1) {
                results.push(timeoutResult(commands[index]));
              }
              completed = commands.length;
            }
            if (outcome.timedOut) break;
          }
          finish();
        } catch (error: unknown) {
          fail(error);
        }
      })();
    });

    conn.on('close', () => {
      if (finished) return;
      // An abort already has a resolver: the command loop or the watchdog.
      if (aborted) return;
      finished = true;
      clearWatchdog();
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
    });

    conn.connect(config);
  });
}

export class SshProbeClient implements BootstrapTransport {
  public async captureHostKey(
    target: SshTarget,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<HostKeyObservation> {
    const keyBlob = await captureHostKeyFrom(target, options);
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
      signal?: AbortSignal;
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
      signal: options.signal,
    });
  }
}

/** Exported for the route tests that inject a transport. */
export const sshProbeClient = new SshProbeClient();
