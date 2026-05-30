import { describe, it, expect } from 'vitest';
import {
  normalizeContainerName,
  parseLogTimestamp,
  detectLogLevel,
  stripControlChars,
  demuxDockerLog,
  createFrameDemuxer,
} from '../utils/log-parsing';

/** Build one Docker multiplexed frame: [streamType, 0,0,0, len(BE)] + payload. */
function frame(streamType: 1 | 2, payload: string): Buffer {
  const body = Buffer.from(payload);
  const header = Buffer.alloc(8);
  header[0] = streamType;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

// ── normalizeContainerName ──────────────────────────────────────────────────

describe('normalizeContainerName', () => {
  it('strips dash-separated stack prefix and trailing -1 replica suffix', () => {
    expect(normalizeContainerName('mystack-redis-1', 'mystack')).toBe('redis');
  });

  it('strips underscore-separated stack prefix and trailing _1 replica suffix', () => {
    expect(normalizeContainerName('mystack_redis_1', 'mystack')).toBe('redis');
  });

  it('strips prefix but preserves name when no trailing replica number', () => {
    expect(normalizeContainerName('mystack-redis', 'mystack')).toBe('redis');
  });

  it('returns raw name when stack prefix does not match', () => {
    expect(normalizeContainerName('standalone-container', 'system')).toBe('standalone-container');
  });

  it('does not strip if prefix match is partial (no separator)', () => {
    expect(normalizeContainerName('mystackredis-1', 'mystack')).toBe('mystackredis-1');
  });

  it('handles multi-segment service names after prefix', () => {
    expect(normalizeContainerName('mystack-my-service-1', 'mystack')).toBe('my-service');
  });

  it('only strips the trailing -1 or _1, not higher replica numbers', () => {
    // Docker Compose v2 uses -1, v1 uses _1 for first replica.
    // Higher numbers (-2, _3) are kept since the regex only matches -1/_1.
    expect(normalizeContainerName('mystack-redis-2', 'mystack')).toBe('redis-2');
  });
});

// ── parseLogTimestamp ────────────────────────────────────────────────────────

describe('parseLogTimestamp', () => {
  it('parses standard Z-suffix timestamp', () => {
    const result = parseLogTimestamp('2024-01-15T12:30:45.123Z some log message');
    expect(result.timestampMs).toBe(new Date('2024-01-15T12:30:45.123Z').getTime());
    expect(result.cleanMessage).toBe('some log message');
  });

  it('parses positive timezone offset', () => {
    const result = parseLogTimestamp('2024-01-15T18:00:45.123+05:30 message with offset');
    expect(result.timestampMs).toBe(new Date('2024-01-15T18:00:45.123+05:30').getTime());
    expect(result.cleanMessage).toBe('message with offset');
  });

  it('parses negative timezone offset', () => {
    const result = parseLogTimestamp('2024-06-01T08:00:00.000-07:00 pacific time log');
    expect(result.timestampMs).toBe(new Date('2024-06-01T08:00:00.000-07:00').getTime());
    expect(result.cleanMessage).toBe('pacific time log');
  });

  it('parses timestamp without fractional seconds', () => {
    const result = parseLogTimestamp('2024-01-15T12:30:45Z no fractional');
    expect(result.timestampMs).toBe(new Date('2024-01-15T12:30:45Z').getTime());
    expect(result.cleanMessage).toBe('no fractional');
  });

  it('falls back to Date.now() when no timestamp found', () => {
    const before = Date.now();
    const result = parseLogTimestamp('plain log line with no timestamp');
    const after = Date.now();
    expect(result.timestampMs).toBeGreaterThanOrEqual(before);
    expect(result.timestampMs).toBeLessThanOrEqual(after);
    expect(result.cleanMessage).toBe('plain log line with no timestamp');
  });

  it('returns original line for empty input', () => {
    const result = parseLogTimestamp('');
    expect(result.cleanMessage).toBe('');
  });
});

// ── detectLogLevel ──────────────────────────────────────────────────────────

describe('detectLogLevel', () => {
  // Structured key=value format
  it('detects level=error in structured logs', () => {
    expect(detectLogLevel('level=error msg="db failed"', 'STDOUT')).toBe('ERROR');
  });

  it('detects level=info in structured logs', () => {
    expect(detectLogLevel('level=info msg="started"', 'STDOUT')).toBe('INFO');
  });

  it('detects level=warn in structured logs', () => {
    expect(detectLogLevel('level=warn msg="slow query"', 'STDOUT')).toBe('WARN');
  });

  // Bracket format
  it('detects [ERROR] bracket format', () => {
    expect(detectLogLevel('[ERROR] connection refused', 'STDOUT')).toBe('ERROR');
  });

  it('detects [WARN] bracket format', () => {
    expect(detectLogLevel('[WARN] disk usage high', 'STDOUT')).toBe('WARN');
  });

  it('detects [INFO] bracket format', () => {
    expect(detectLogLevel('[INFO] server started', 'STDERR')).toBe('INFO');
  });

  it('detects [debug] bracket format as INFO', () => {
    expect(detectLogLevel('[debug] tracing request', 'STDOUT')).toBe('INFO');
  });

  // Standalone keyword
  it('detects standalone ERROR keyword', () => {
    expect(detectLogLevel('ERROR: something failed', 'STDOUT')).toBe('ERROR');
  });

  it('detects fatal keyword', () => {
    expect(detectLogLevel('fatal: cannot proceed', 'STDOUT')).toBe('ERROR');
  });

  it('detects critical keyword', () => {
    expect(detectLogLevel('critical disk failure detected', 'STDOUT')).toBe('ERROR');
  });

  it('detects panic keyword', () => {
    expect(detectLogLevel('panic: runtime error: index out of range', 'STDOUT')).toBe('ERROR');
  });

  // Exception pattern
  it('detects Exception: pattern', () => {
    expect(detectLogLevel('Exception: java.lang.NullPointerException', 'STDOUT')).toBe('ERROR');
  });

  // STDERR default
  it('defaults to ERROR for plain message from STDERR', () => {
    expect(detectLogLevel('some generic output', 'STDERR')).toBe('ERROR');
  });

  // STDOUT default
  it('defaults to INFO for plain message from STDOUT', () => {
    expect(detectLogLevel('some generic output', 'STDOUT')).toBe('INFO');
  });

  // Override: explicit INFO on STDERR
  it('overrides STDERR default when explicit info indicator present', () => {
    expect(detectLogLevel('level=info starting service', 'STDERR')).toBe('INFO');
  });

  it('overrides STDERR default when [trace] bracket present', () => {
    expect(detectLogLevel('[trace] detailed operation', 'STDERR')).toBe('INFO');
  });

  // Priority: INFO beats ERROR keyword ambiguity
  it('prioritizes INFO when both info and error-like words appear', () => {
    // "info" is checked first, so it wins even if "error" appears later.
    expect(detectLogLevel('[INFO] recovered from error state', 'STDOUT')).toBe('INFO');
  });
});

// ── stripControlChars ───────────────────────────────────────────────────────

describe('stripControlChars', () => {
  it('strips null bytes and low control characters', () => {
    expect(stripControlChars('hello\u0000world\u0007!')).toBe('helloworld!');
  });

  it('preserves normal text, newlines, and tabs', () => {
    // \n (0x0A) and \t (0x09) are intentionally NOT stripped
    expect(stripControlChars('line1\nline2\ttab')).toBe('line1\nline2\ttab');
  });

  it('strips C1 control characters (0x7F-0x9F)', () => {
    expect(stripControlChars('a\u007Fb\u0080c\u009Fd')).toBe('abcd');
  });

  it('returns empty string unchanged', () => {
    expect(stripControlChars('')).toBe('');
  });
});

// ── demuxDockerLog ──────────────────────────────────────────────────────────

describe('demuxDockerLog', () => {
  it('parses TTY output as plain STDOUT lines', () => {
    const buf = Buffer.from('line1\nline2\n');
    const lines: Array<{ line: string; source: string }> = [];
    demuxDockerLog(buf, true, (line, source) => lines.push({ line, source }));
    // A trailing newline does not produce a spurious empty final line.
    expect(lines).toEqual([
      { line: 'line1', source: 'STDOUT' },
      { line: 'line2', source: 'STDOUT' },
    ]);
  });

  it('parses multiplexed STDOUT frame', () => {
    const buf = frame(1, 'hello stdout\n');
    const lines: Array<{ line: string; source: string }> = [];
    demuxDockerLog(buf, false, (line, source) => lines.push({ line, source }));
    expect(lines).toEqual([{ line: 'hello stdout', source: 'STDOUT' }]);
  });

  it('parses multiplexed STDERR frame', () => {
    const payload = Buffer.from('error output');
    const header = Buffer.alloc(8);
    header[0] = 2; // STDERR
    header.writeUInt32BE(payload.length, 4);
    const buf = Buffer.concat([header, payload]);

    const lines: Array<{ line: string; source: string }> = [];
    demuxDockerLog(buf, false, (line, source) => lines.push({ line, source }));
    expect(lines).toEqual([{ line: 'error output', source: 'STDERR' }]);
  });

  it('handles multiple concatenated frames', () => {
    const p1 = Buffer.from('out1');
    const h1 = Buffer.alloc(8);
    h1[0] = 1;
    h1.writeUInt32BE(p1.length, 4);

    const p2 = Buffer.from('err1');
    const h2 = Buffer.alloc(8);
    h2[0] = 2;
    h2.writeUInt32BE(p2.length, 4);

    const buf = Buffer.concat([h1, p1, h2, p2]);
    const lines: Array<{ line: string; source: string }> = [];
    demuxDockerLog(buf, false, (line, source) => lines.push({ line, source }));
    expect(lines).toEqual([
      { line: 'out1', source: 'STDOUT' },
      { line: 'err1', source: 'STDERR' },
    ]);
  });

  it('strips control chars in TTY mode', () => {
    const buf = Buffer.from('clean\u0000text\n');
    const lines: Array<{ line: string; source: string }> = [];
    demuxDockerLog(buf, true, (line, source) => lines.push({ line, source }));
    expect(lines[0]).toEqual({ line: 'cleantext', source: 'STDOUT' });
  });
});

// ── createFrameDemuxer (stateful, survives chunk boundaries) ─────────────────

describe('createFrameDemuxer', () => {
  function collect() {
    const lines: Array<{ line: string; source: string }> = [];
    let errors = 0;
    const d = createFrameDemuxer(false, (line, source) => lines.push({ line, source }), () => { errors += 1; });
    return { lines, push: d.push, flush: d.flush, errors: () => errors };
  }

  it('reassembles a frame whose 8-byte header is split across two chunks', () => {
    const full = frame(1, 'split header\n');
    const c = collect();
    c.push(full.subarray(0, 3)); // first 3 bytes of the header
    c.push(full.subarray(3));    // remainder
    c.flush();
    expect(c.lines).toEqual([{ line: 'split header', source: 'STDOUT' }]);
  });

  it('reassembles a frame whose payload is split across two chunks', () => {
    const full = frame(2, 'partial payload\n');
    const c = collect();
    c.push(full.subarray(0, 12)); // header + start of payload
    c.push(full.subarray(12));
    c.flush();
    expect(c.lines).toEqual([{ line: 'partial payload', source: 'STDERR' }]);
  });

  it('joins a single log line split across two frames', () => {
    const c = collect();
    c.push(frame(1, 'hello ')); // no newline yet
    c.push(frame(1, 'world\n'));
    c.flush();
    expect(c.lines).toEqual([{ line: 'hello world', source: 'STDOUT' }]);
  });

  it('keeps interleaved STDOUT/STDERR partial lines separate', () => {
    const c = collect();
    c.push(frame(1, 'out-part '));
    c.push(frame(2, 'err-part '));
    c.push(frame(1, 'out-end\n'));
    c.push(frame(2, 'err-end\n'));
    c.flush();
    expect(c.lines).toEqual([
      { line: 'out-part out-end', source: 'STDOUT' },
      { line: 'err-part err-end', source: 'STDERR' },
    ]);
  });

  it('flushes a buffered partial line with no trailing newline on stream end', () => {
    const c = collect();
    c.push(frame(1, 'no newline'));
    expect(c.lines).toEqual([]); // held until flush
    c.flush();
    expect(c.lines).toEqual([{ line: 'no newline', source: 'STDOUT' }]);
  });

  it('counts a malformed frame header and resyncs instead of stalling', () => {
    const c = collect();
    // A stray byte > 2 where a stream type is expected, then a valid frame.
    c.push(Buffer.concat([Buffer.from([0x07]), frame(1, 'recovered\n')]));
    c.flush();
    expect(c.errors()).toBeGreaterThanOrEqual(1);
    expect(c.lines).toContainEqual({ line: 'recovered', source: 'STDOUT' });
  });
});
