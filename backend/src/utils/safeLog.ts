// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_REGEX = /[\r\n\t\x00-\x1F\x7F]/g;

/**
 * Strip CR, LF, tab, and other ASCII control characters from a value before
 * embedding it in a log line. Prevents log-injection attacks where untrusted
 * input could forge multi-line log entries or terminal escape sequences.
 *
 * Use at every site where a user-controlled string flows into console.log /
 * console.warn / console.error, including via template literals.
 */
export function sanitizeForLog(value: unknown): string {
  const s = typeof value === 'string' ? value : String(value);
  return s.replace(CONTROL_CHARS_REGEX, '');
}

export function redactSensitiveText(value: unknown): string {
  const s = typeof value === 'string' ? value : String(value);
  return s
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/=]+/gi, 'Bearer [redacted]')
    .replace(/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted-jwt]')
    .replace(/https?:\/\/[^/\s:@]+:[^/\s@]+@/gi, 'https://[redacted]@')
    .replace(/((?:authorization|token|password|secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/\/home\/[^/\s'"]+/g, '/home/<user>')
    .replace(/\/Users\/[^/\s'"]+/g, '/Users/<user>')
    .replace(/([A-Z]):\\Users\\[^\\/\s'"]+/g, '$1:\\Users\\<user>');
}
