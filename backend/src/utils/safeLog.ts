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
    // Any URL scheme, since a credential rides in postgres://, redis://, and
    // amqp:// strings as readily as in http(s) ones. The user may be empty
    // (redis://:pw@host), and the password runs to the last `@` of the authority,
    // so a raw `@` inside it does not leave its tail behind. The scheme length is
    // bounded to keep a long dotted run from backtracking quadratically.
    .replace(/([a-z][a-z0-9+.-]{0,31}):\/\/[^/\s:@]*:[^/\s]+@/gi, '$1://[redacted]@')
    // Scheme-less registry credentials, which lead an image reference
    // (user:password@registry.example.com/repo/image:tag). Compose echoes the
    // reference back in its own errors. Two constraints keep this narrow:
    // the credential must start a token, and the `@` must be followed by a host
    // and a path. The second is what separates a credential from a digest: in
    // repo/image:tag@sha256:... the `@` is followed by an algorithm and hex, and
    // never by a `/`. Without it every digest pin loses its repository and tag,
    // which is the text a GitOps diagnosis is built from. The first keeps a URL
    // path that merely contains `a:b@c/` from being read as a credential.
    // The user takes unreserved characters, `%`, and the sub-delimiters that do
    // not open a token (`'(),=` do, so a match starts after them), so a
    // percent-encoded name (user%40corp) is caught. The password runs to the
    // last `@` before the first `/` that still leads to a host and a path, so a
    // raw `@` inside it leaves no tail behind. It stops at a quote, which ends an
    // image reference in YAML and JSON, so a digest pin before a quote keeps its
    // text, and it is capped at 1024 characters, which keeps the backtracking
    // over its `@` runs linear in the input.
    // The narrowing has a known cost: a credential with no path after the host
    // is not caught, and neither is one whose password contains a `/`, a quote,
    // or more than 1024 characters (an unencoded quote or a kilobyte of password
    // is not a credential an image reference carries). The rule
    // also over-matches text shaped like a time and a host, "10:30@host/a", or a
    // query pair, "a&b:c@d/e", which is indistinguishable from a user and
    // password. That direction is deliberate: an over-redacted log line costs a
    // word, an under-redacted one leaks.
    .replace(
      /(^|[\s"'=,(])[A-Za-z0-9._~%!$&*+;-]+:[^/\s"']{1,1024}@(\[[^\]\s]+\]|[A-Za-z0-9.-]+(?::\d+)?\/)/g,
      (_match, lead: string, host: string) => `${lead}[redacted]@${host}`,
    )
    // Keyword-led secrets, tolerating a JSON/YAML quoting boundary between the
    // key and its separator, so `"PASSWORD": "s3cret"` is caught like
    // `PASSWORD=s3cret`.
    .replace(
      /((?:authorization|token|password|secret|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s,;"']+/gi,
      '$1[redacted]',
    )
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
