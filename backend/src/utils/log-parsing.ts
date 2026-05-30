/**
 * Shared utilities for global log parsing.
 *
 * Both the polling snapshot (`GET /api/logs/global`) and the SSE stream
 * (`GET /api/logs/global/stream`) need identical timestamp extraction,
 * log-level classification, and container-name normalization. Extracting
 * them here eliminates duplication and provides a single place to test.
 */

/** Which Docker stream a log line came from. */
export type LogStreamSource = 'STDOUT' | 'STDERR';

export interface GlobalLogEntry {
  stackName: string;
  containerName: string;
  source: LogStreamSource;
  level: 'INFO' | 'WARN' | 'ERROR';
  message: string;
  timestampMs: number;
}

// Matches ISO 8601 timestamps with Z or +/-HH:MM offset.
// Docker's `timestamps: true` typically emits Z, but some logging drivers
// and Docker configurations produce offset notation instead.
const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\s+(.*)/;

// Non-printable control characters that appear in TTY container logs.
// Stripping them prevents garbled output in the UI and JSON responses.
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

// --- Level detection regexes (compiled once) ---

// Tier 1: Explicit INFO/DEBUG/TRACE indicators override the STDERR default.
const INFO_STRUCTURED_RE = /level=["']?(info|debug|trace)["']?/i;
const INFO_BRACKET_RE = /\[\s*(info|inf|debug|dbg|trace)\s*\]/i;
const INFO_KEYWORD_RE = /(?:\s|^)(info|inf|debug|trace)(?:\s|:|\(|\[|$)/i;

// Tier 2: WARN indicators.
const WARN_STRUCTURED_RE = /level=["']?(warn|warning)["']?/i;
const WARN_BRACKET_RE = /\[\s*(warn|warning)\s*\]/i;
const WARN_KEYWORD_RE = /(?:\s|^)(warn|warning)(?:\s|:|\(|\[|$)/i;

// Tier 3: ERROR indicators.
const ERROR_STRUCTURED_RE = /level=["']?(error|err|fatal|crit|critical|panic)["']?/i;
const ERROR_BRACKET_RE = /\[\s*(error|err|fatal|crit|critical|panic)\s*\]/i;
const ERROR_KEYWORD_RE = /(?:\s|^)(error|err|fatal|crit|critical|panic)(?:\s|:|\(|\[|$)/i;
const EXCEPTION_RE = /Exception:/i;

/**
 * Strip the Docker Compose stack prefix and trailing replica suffix from a
 * container name so the UI shows the clean service name.
 *
 * Examples:
 *   normalizeContainerName('mystack-redis-1', 'mystack')  -> 'redis'
 *   normalizeContainerName('mystack_redis_1', 'mystack')  -> 'redis'
 *   normalizeContainerName('standalone',      'system')   -> 'standalone'
 */
export function normalizeContainerName(rawName: string, stackName: string): string {
  if (rawName.startsWith(`${stackName}-`)) {
    return rawName.slice(stackName.length + 1).replace(/-1$/, '');
  }
  if (rawName.startsWith(`${stackName}_`)) {
    return rawName.slice(stackName.length + 1).replace(/_1$/, '');
  }
  return rawName;
}

/**
 * Extract and parse an ISO timestamp from the beginning of a Docker log line.
 * Returns the millisecond epoch value and the remainder of the line (the actual
 * log message). Falls back to `Date.now()` when no timestamp is found.
 */
export function parseLogTimestamp(line: string): { timestampMs: number; cleanMessage: string } {
  const match = line.match(TIMESTAMP_RE);
  if (match) {
    return {
      timestampMs: new Date(match[1]).getTime(),
      cleanMessage: match[2],
    };
  }
  return { timestampMs: Date.now(), cleanMessage: line };
}

/**
 * Three-tier regex classification to detect the log level from a message.
 *
 * Priority order:
 *   1. Explicit INFO/DEBUG/TRACE keywords (overrides the STDERR default)
 *   2. WARN keywords
 *   3. ERROR/FATAL/CRIT/PANIC keywords or `Exception:` pattern
 *   4. Fallback: STDERR -> ERROR, STDOUT -> INFO
 */
export function detectLogLevel(message: string, source: LogStreamSource): 'INFO' | 'WARN' | 'ERROR' {
  // Tier 1: INFO/DEBUG/TRACE (overrides STDERR default)
  if (INFO_STRUCTURED_RE.test(message) || INFO_BRACKET_RE.test(message) || INFO_KEYWORD_RE.test(message)) {
    return 'INFO';
  }
  // Tier 2: WARN
  if (WARN_STRUCTURED_RE.test(message) || WARN_BRACKET_RE.test(message) || WARN_KEYWORD_RE.test(message)) {
    return 'WARN';
  }
  // Tier 3: ERROR
  if (ERROR_STRUCTURED_RE.test(message) || ERROR_BRACKET_RE.test(message) || ERROR_KEYWORD_RE.test(message) || EXCEPTION_RE.test(message)) {
    return 'ERROR';
  }
  // Tier 4: Fallback based on stream source
  return source === 'STDERR' ? 'ERROR' : 'INFO';
}

/** Strip non-printable control characters from TTY container log output. */
export function stripControlChars(text: string): string {
  return text.replace(CONTROL_CHARS_RE, '');
}

/** A stateful demuxer that survives chunk boundaries. See `createFrameDemuxer`. */
export interface FrameDemuxer {
  /** Feed the next chunk of stream bytes; emits every complete line found. */
  push(chunk: Buffer): void;
  /** Emit any buffered partial line that has no trailing newline. Call once on stream end. */
  flush(): void;
}

/**
 * Create a stateful demuxer for Docker's multiplexed log stream.
 *
 * Unlike a one-shot parse, this retains state across `push` calls so a frame
 * header or payload split across two chunk boundaries is reassembled instead
 * of dropped, and a log line split across two frames is joined instead of
 * emitted as two partials. Line buffers are kept per source so interleaved
 * STDOUT/STDERR frames don't bleed into one another.
 *
 * TTY containers produce raw text (no headers, single STDOUT stream); non-TTY
 * containers prepend an 8-byte header per frame:
 *   [streamType(1), reserved(3), payloadLength(4 BE)]
 *
 * @param onFrameError called once per malformed frame header (invalid stream
 *   type). The demuxer advances one byte to attempt resync rather than
 *   stalling; the callback lets the caller count corruption events.
 */
export function createFrameDemuxer(
  isTty: boolean,
  onLine: (line: string, source: LogStreamSource) => void,
  onFrameError?: () => void,
): FrameDemuxer {
  if (isTty) {
    let lineBuf = '';
    return {
      push(chunk: Buffer): void {
        lineBuf += stripControlChars(chunk.toString('utf-8'));
        const parts = lineBuf.split('\n');
        lineBuf = parts.pop() ?? '';
        for (const line of parts) onLine(line, 'STDOUT');
      },
      flush(): void {
        if (lineBuf) {
          onLine(lineBuf, 'STDOUT');
          lineBuf = '';
        }
      },
    };
  }

  let leftover: Buffer = Buffer.alloc(0);
  const lineBufs: Record<LogStreamSource, string> = { STDOUT: '', STDERR: '' };

  const emitPayload = (payload: string, source: LogStreamSource): void => {
    const parts = (lineBufs[source] + payload).split('\n');
    lineBufs[source] = parts.pop() ?? '';
    for (const line of parts) onLine(line, source);
  };

  return {
    push(chunk: Buffer): void {
      const buf = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
      let offset = 0;
      while (offset + 8 <= buf.length) {
        const streamType = buf[offset];
        // Valid Docker stream types: 0 (stdin, unused here), 1 (stdout), 2 (stderr).
        if (streamType > 2) {
          onFrameError?.();
          offset += 1; // attempt resync rather than stalling on a corrupt header
          continue;
        }
        const length = buf.readUInt32BE(offset + 4);
        if (offset + 8 + length > buf.length) break; // payload not fully arrived yet
        const payload = buf.slice(offset + 8, offset + 8 + length).toString('utf-8');
        offset += 8 + length;
        emitPayload(payload, streamType === 2 ? 'STDERR' : 'STDOUT');
      }
      leftover = offset < buf.length ? buf.subarray(offset) : Buffer.alloc(0);
    },
    flush(): void {
      for (const source of ['STDOUT', 'STDERR'] as const) {
        if (lineBufs[source]) {
          onLine(lineBufs[source], source);
          lineBufs[source] = '';
        }
      }
    },
  };
}

/**
 * One-shot demux of a complete Docker log buffer (the polling snapshot path,
 * where the whole response is in hand). Implemented on top of
 * `createFrameDemuxer` so frame- and line-splitting are handled identically to
 * the streaming path.
 */
export function demuxDockerLog(
  buf: Buffer,
  isTty: boolean,
  onLine: (line: string, source: LogStreamSource) => void,
): void {
  const demuxer = createFrameDemuxer(isTty, onLine);
  demuxer.push(buf);
  demuxer.flush();
}
