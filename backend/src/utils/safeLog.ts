import { getErrorMessage } from './errors';

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
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic [redacted]')
    .replace(/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted-jwt]')
    .replace(/https?:\/\/[^/\s:@]+:[^/\s@]+@/gi, 'https://[redacted]@')
    .replace(/((?:authorization|token|password|secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/\/home\/[^/\s'"]+/g, '/home/<user>')
    .replace(/\/Users\/[^/\s'"]+/g, '/Users/<user>')
    .replace(/([A-Za-z]):\\Users\\[^\\/\s'"]+/g, '$1:\\Users\\<user>');
}

/** How many `cause` links to fold into a log message before giving up on it. */
const MAX_CAUSE_DEPTH = 3;

/**
 * A caught value's message, ready to sit in a log line.
 *
 * The one spelling of the four steps every failure log needs: a message (a
 * non-`Error` throw has none), the cause chain folded in, sensitive text
 * removed, control characters stripped.
 *
 * The chain is folded in here rather than by logging the raw error beside this
 * string, which is the shape this replaced: `console.error` inspects an `Error`
 * by printing its stack, and a stack's first line is the message that the second
 * step just redacted, so passing both put the secret back. Wrapped errors are
 * also the ones that need the chain: a rejected `fetch` reads only `fetch
 * failed`, and the reason an operator can act on (`ECONNREFUSED`,
 * `getaddrinfo ENOTFOUND`) is on its `cause`, which `getErrorMessage` does not
 * reach on its own.
 */
export function errorMessageForLog(error: unknown): string {
  return sanitizeForLog(redactSensitiveText(messageWithCause(error)));
}

function messageWithCause(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    parts.push(current.message);
    current = current.cause;
  }
  // A throw that is not an `Error` has no message to fold, and reads as `unknown`.
  return parts.length > 0 ? parts.join(': ') : getErrorMessage(error, 'unknown');
}
