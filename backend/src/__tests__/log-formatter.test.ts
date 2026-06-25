import { describe, it, expect } from 'vitest';
import { LogFormatter } from '../services/LogFormatter';

const CYAN = '\x1b[36m';
const GRAY = '\x1b[90m';
const RESET = '\x1b[0m';
const WHITE = '\x1b[37m';

describe('LogFormatter.process', () => {
  it('colorizes prefix and timestamp when prefix comes first', () => {
    const result = LogFormatter.process('redis | 2024-01-01T00:00:00Z started');
    expect(result).toContain(`${CYAN}redis${WHITE}${RESET} | `);
    expect(result).toContain(`${GRAY}2024-01-01T00:00:00Z ${RESET}`);
  });

  it('colorizes timestamp and prefix when timestamp comes first (legacy order)', () => {
    const result = LogFormatter.process('2024-01-01T00:00:00Z redis | started');
    expect(result).toContain(`${GRAY}2024-01-01T00:00:00Z ${RESET}`);
    expect(result).toContain(`${CYAN}redis${WHITE}${RESET} | `);
  });

  it('colorizes timestamp only when no prefix is present (backward compat)', () => {
    const result = LogFormatter.process('2024-01-01T00:00:00Z started');
    expect(result).toContain(`${GRAY}2024-01-01T00:00:00Z ${RESET}`);
    expect(result).not.toContain(CYAN);
  });

  it('colorizes dotted container names', () => {
    const result = LogFormatter.process('api.v1 | 2024-01-01T00:00:00Z started');
    expect(result).toContain(`${CYAN}api.v1${WHITE}${RESET} | `);
    expect(result).toContain(`${GRAY}2024-01-01T00:00:00Z ${RESET}`);
  });

  it('colorizes container names with underscores', () => {
    const result = LogFormatter.process('my-service_1 | 2024-01-01T00:00:00Z started');
    expect(result).toContain(`${CYAN}my-service_1${WHITE}${RESET} | `);
    expect(result).toContain(`${GRAY}2024-01-01T00:00:00Z ${RESET}`);
  });

  it('handles timestamp with offset notation', () => {
    const result = LogFormatter.process('redis | 2024-01-01T00:00:00+05:00 started');
    expect(result).toContain(`${CYAN}redis${WHITE}${RESET} | `);
    expect(result).toContain(`${GRAY}2024-01-01T00:00:00+05:00 ${RESET}`);
  });

  it('returns empty string unchanged', () => {
    expect(LogFormatter.process('')).toBe('');
  });

  it('returns whitespace-only string unchanged', () => {
    expect(LogFormatter.process('   ')).toBe('   ');
  });

  it('handles bare message with no prefix or timestamp', () => {
    const result = LogFormatter.process('just a plain message');
    expect(result).toBe('just a plain message');
  });

  it('does not colorize a second "word | " in the message body as a prefix', () => {
    const result = LogFormatter.process('redis | 2024-01-01T00:00:00Z api | started');
    // The first "redis | " is the genuine container prefix.
    expect(result).toContain(`${CYAN}redis${WHITE}${RESET} | `);
    // The "api | " in the body must not be colorized as a second prefix.
    const afterPrefix = result.split(' | ').slice(1).join(' | ');
    expect(afterPrefix).not.toContain(CYAN);
  });
});
