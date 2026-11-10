import { Client } from 'ssh2';
import type { ClientChannel, ConnectConfig } from 'ssh2';
import {
  SSH_CONNECT_TIMEOUT_MS,
  SshTransportError,
  cancelledError,
  hostKeyObservation,
  mapSshError,
  parsePrivateKey,
  safeEquals,
  scrubCommandOutput,
  type SshSessionInput,
} from './sshProbeClient';

/**
 * Bounded SSH session for executing an approved bootstrap plan.
 *
 * It keeps the preflight transport's policy: public-key auth only, no agent,
 * no forwarding, no PTY and no shell channel (each command is one exec), and a
 * host key that must equal the approved fingerprint before authentication. It
 * differs in what execution needs: one connection runs the steps in order,
 * each command has its own deadline, standard input can carry file content (so
 * a credential never appears in a process argument), and only the tail of the
 * output is kept. A dropped connection or an expired deadline is reported as
 * such, because the remote outcome of that command is then unknown.
 */

export const EXEC_OUTPUT_TAIL_BYTES = 16 * 1024;
export const EXEC_READ_MAX_BYTES = 256 * 1024;

export interface ExecResult {
  exitCode: number | null;
  /** The last bytes of standard output, scrubbed of control characters. */
  stdout: string;
  stderr: string;
  /** More output arrived than was kept. */
  truncated: boolean;
  timedOut: boolean;
  /** `CONNECTION_LOST` or `COMMAND_ERROR`; null for a normal exit. */
  error: 'CONNECTION_LOST' | 'COMMAND_ERROR' | null;
}

export interface ExecOptions {
  timeoutMs: number;
  /** Written to the command's standard input, which is then closed. */
  stdin?: string;
  /**
   * Keep the first `maxBytes` of output and mark the rest truncated, for a
   * command whose output is read whole (a file). Default keeps the tail.
   */
  keep?: { mode: 'head'; maxBytes: number } | { mode: 'tail'; maxBytes: number };
}

export interface ExecSession {
  run(command: string, options: ExecOptions): Promise<ExecResult>;
  close(): void;
  readonly closed: boolean;
}

export interface BootstrapExecTransport {
  open(
    session: SshSessionInput,
    options: { expectedFingerprint: string; signal?: AbortSignal },
  ): Promise<ExecSession>;
}

class OutputBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;
  public truncated = false;

  public constructor(private readonly keep: NonNullable<ExecOptions['keep']>) {}

  public push(chunk: Buffer): void {
    if (this.keep.mode === 'head') {
      const room = this.keep.maxBytes - this.bytes;
      if (room <= 0) {
        this.truncated = true;
        return;
      }
      const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (chunk.length > room) this.truncated = true;
      this.chunks.push(slice);
      this.bytes += slice.length;
      return;
    }
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    if (this.bytes > this.keep.maxBytes * 2) this.compact();
  }

  private compact(): void {
    const joined = Buffer.concat(this.chunks);
    if (joined.length > this.keep.maxBytes) this.truncated = true;
    const tail = joined.subarray(Math.max(0, joined.length - this.keep.maxBytes));
    this.chunks = [tail];
    this.bytes = tail.length;
  }

  public text(): string {
    if (this.keep.mode === 'tail') this.compact();
    return scrubCommandOutput(Buffer.concat(this.chunks).toString('utf8'));
  }
}

class Ssh2ExecSession implements ExecSession {
  private lost = false;
  private readonly pending = new Set<() => void>();

  public constructor(private readonly conn: Client) {
    const markLost = () => {
      this.lost = true;
      for (const notify of [...this.pending]) notify();
    };
    conn.on('close', markLost);
    conn.on('error', markLost);
  }

  public get closed(): boolean {
    return this.lost;
  }

  public run(command: string, options: ExecOptions): Promise<ExecResult> {
    const keep = options.keep ?? { mode: 'tail', maxBytes: EXEC_OUTPUT_TAIL_BYTES };
    const stdout = new OutputBuffer(keep);
    const stderr = new OutputBuffer(keep);
    return new Promise((resolve) => {
      let settled = false;
      let timedOut = false;
      let channel: ClientChannel | null = null;
      let timer: NodeJS.Timeout | null = null;
      const settle = (exitCode: number | null, error: ExecResult['error']) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.pending.delete(onLost);
        resolve({
          exitCode,
          stdout: stdout.text(),
          stderr: stderr.text(),
          truncated: stdout.truncated || stderr.truncated,
          timedOut,
          error,
        });
      };
      const onLost = () => settle(null, 'CONNECTION_LOST');
      if (this.lost) {
        onLost();
        return;
      }
      this.pending.add(onLost);
      // The deadline starts before the exec request, so a peer that never
      // acknowledges it cannot hold the step open.
      timer = setTimeout(() => {
        timedOut = true;
        try {
          channel?.destroy();
        } catch {
          // The channel may already be closed; the result below still settles.
        }
        settle(null, null);
      }, options.timeoutMs);
      this.conn.exec(`LC_ALL=C ${command}`, (err, stream) => {
        if (settled) {
          try {
            stream?.destroy();
          } catch {
            // A late acknowledgement after the deadline: nothing left to read.
          }
          return;
        }
        if (err) {
          settle(null, 'COMMAND_ERROR');
          return;
        }
        channel = stream;
        stream.on('data', (chunk: Buffer) => stdout.push(chunk));
        stream.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
        stream.on('close', (code: number | null) => {
          if (typeof code === 'number') settle(code, null);
          else settle(null, this.lost ? 'CONNECTION_LOST' : 'COMMAND_ERROR');
        });
        stream.on('error', () => settle(null, 'COMMAND_ERROR'));
        // No command reads a terminal: standard input carries file content or
        // is closed at once, so a prompt reads end-of-file instead of waiting.
        if (options.stdin !== undefined) stream.end(options.stdin);
        else stream.end();
      });
    });
  }

  public close(): void {
    this.lost = true;
    this.conn.destroy();
  }
}

function openSession(
  session: SshSessionInput,
  options: { expectedFingerprint: string; signal?: AbortSignal },
): Promise<ExecSession> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let hostKeyRejected = false;
    let done = false;
    const config: ConnectConfig = {
      host: session.address,
      port: session.port,
      username: session.username,
      privateKey: session.privateKey,
      passphrase: session.passphrase || undefined,
      readyTimeout: SSH_CONNECT_TIMEOUT_MS,
      keepaliveInterval: 5_000,
      keepaliveCountMax: 3,
      hostVerifier: (key: Buffer) => {
        const matches = safeEquals(hostKeyObservation(session.host, key).fingerprint, options.expectedFingerprint);
        if (!matches) hostKeyRejected = true;
        return matches;
      },
    };
    const onAbort = () => fail(cancelledError());
    const fail = (error: unknown) => {
      if (done) return;
      done = true;
      options.signal?.removeEventListener('abort', onAbort);
      conn.destroy();
      reject(hostKeyRejected
        ? new SshTransportError('HOST_KEY_UNTRUSTED', 'The host key no longer matches the approved key.')
        : mapSshError(error));
    };
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    conn.on('error', fail);
    conn.on('close', () => fail(new Error('The SSH connection closed before authentication.')));
    conn.on('ready', () => {
      if (done) {
        conn.destroy();
        return;
      }
      done = true;
      options.signal?.removeEventListener('abort', onAbort);
      resolve(new Ssh2ExecSession(conn));
    });
    conn.connect(config);
  });
}

export const sshExecClient: BootstrapExecTransport = {
  async open(session, options) {
    parsePrivateKey(
      typeof session.privateKey === 'string' ? session.privateKey : session.privateKey.toString('utf8'),
      session.passphrase,
    );
    return openSession(session, options);
  },
};
