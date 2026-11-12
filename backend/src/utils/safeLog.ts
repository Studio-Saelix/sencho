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
    // The lookbehind is what keeps this linear. Without it the greedy first
    // segment is retried from every offset of a long run that holds no dot, so
    // a 60 kB label value costs seconds and blocks the event loop; Docker
    // metadata is untrusted and unbounded. It only forbids a match that starts
    // inside a base64url run, which is not where a JWT begins.
    .replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted-jwt]')
    // Any URL scheme, since a credential rides in postgres://, redis://, and
    // amqp:// strings as readily as in http(s) ones. The user may be empty
    // (redis://:pw@host), and the password runs to the last `@` of the authority,
    // so a raw `@` inside it does not leave its tail behind. The userinfo may
    // also be a lone token with no colon (https://ghp_token@host), which is how a
    // Git provider token is written, so that form is redacted too. Only that
    // token form stops at a quote or a comma, which end a URL in JSON and YAML,
    // so it cannot run on into the next value. The scheme length is bounded to
    // keep a long dotted run from backtracking quadratically.
    // A lone user after ssh:// or sftp:// (or a +ssh form such as git+ssh://) is
    // a login name, not a secret, so only a password after it is redacted there.
    .replace(
      /([a-z][a-z0-9+.-]{0,31}):\/\/(?:([^/\s:@]*:[^/\s]+)|[^/\s:"',]+)@/gi,
      (match, scheme: string, withPassword: string | undefined) =>
        withPassword === undefined && /(?:^|\+)(?:ssh|sftp)$/i.test(scheme) ? match : `${scheme}://[redacted]@`,
    )
    // Scheme-less registry credentials, which lead an image reference
    // (user:password@registry.example.com/repo/image:tag). Compose echoes the
    // reference back in its own errors. Two constraints keep this narrow:
    // the credential must start a token, and the `@` must be followed by a host
    // and a path. The second is what separates a credential from a digest: in
    // repo/image:tag@sha256:... the `@` is followed by an algorithm and hex, and
    // never by a `/`. Without it every digest pin loses its repository and tag,
    // which is the text a GitOps diagnosis is built from. The first keeps a URL
    // path that merely contains `a:b@c/` from being read as a credential.
    // The credential may also lead a protocol-relative reference (//user:pw@host/x),
    // where the `//` is what precedes it. A `//` right after a `:` is a scheme
    // separator, not a protocol-relative authority, so the `(?<!:)` skips it and
    // the scheme rule above decides (which keeps ssh://git@host/x intact). Its
    // password may be absent (ghp_token@ghcr.io/x/app), as in a token-only
    // registry login.
    // The user takes unreserved characters, `%`, a raw `@` (so a lone token that
    // holds one leaves no tail), and the sub-delimiters that do not open a token
    // (`'(),=` do, so a match starts after them), so a percent-encoded name
    // (user%40corp) is caught. The password runs to the
    // last `@` before the first `/` that still leads to a host and a path, so a
    // raw `@` inside it leaves no tail behind. It stops at a quote, which ends an
    // image reference in YAML and JSON, so a digest pin before a quote keeps its
    // text, and it is capped at 1024 characters, which keeps the backtracking
    // over its `@` runs linear in the input.
    // A lone token is indistinguishable from an address with a path
    // (ops@corp.example/team) or a package reference (lodash@4.17.21/dist), which
    // are redacted as well.
    // The narrowing has a known cost: a credential with no path after the host
    // is not caught, and neither is one whose password contains a `/`, a quote,
    // or more than 1024 characters (an unencoded quote or a kilobyte of password
    // is not a credential an image reference carries). The rule
    // also over-matches text shaped like a time and a host, "10:30@host/a", or a
    // query pair, "a&b:c@d/e", which is indistinguishable from a user and
    // password. That direction is deliberate: an over-redacted log line costs a
    // word, an under-redacted one leaks.
    .replace(
      /(^|[\s"'=,()]|(?<!:)\/\/)[A-Za-z0-9._~%!$&*+;@-]+(?::[^/\s"']{1,1024})?@(\[[^\]\s]+\]|[A-Za-z0-9.-]+(?::\d+)?\/)/g,
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

// The digest a reference may end in: @algorithm:hex, such as @sha256:1a2b...
const IMAGE_DIGEST_TAIL = /@[A-Za-z][A-Za-z0-9]*(?:[+._-][A-Za-z][A-Za-z0-9]*)*:[0-9A-Fa-f]{32,}$/;

/**
 * An image reference with any credential removed. A Compose `image` value has
 * no userinfo, so an `@` that is not the digest separator can only open a
 * credential, and everything before the last one is dropped. This follows the
 * reference's own grammar instead of the text-shape heuristics of
 * `redactSensitiveText`, so it holds for a password with a space, a `/`, a
 * quote, or any length, and for a host with no path. Use it wherever an `image`
 * value is quoted or stored for display; free text that merely contains an
 * image still goes through `redactSensitiveText`.
 */
export function redactImageReference(image: string): string {
  const reference = splitImageReference(image);
  if (reference === null) return image;
  return `[redacted]@${reference.rest}`;
}

/**
 * Split an image reference into its credential and the rest, or return null
 * when it has no credential. The digest tail is removed before the last `@` is
 * read, so a digest pin is never mistaken for userinfo.
 */
function splitImageReference(image: string): { userinfo: string; rest: string } | null {
  const digest = IMAGE_DIGEST_TAIL.exec(image);
  const head = digest === null ? image : image.slice(0, digest.index);
  const at = head.lastIndexOf('@');
  if (at === -1) return null;
  return {
    userinfo: head.slice(0, at),
    rest: `${head.slice(at + 1)}${digest === null ? '' : digest[0]}`,
  };
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
 *
 * Pass the image a failure is about in `options.imageRef` when the caught error
 * may quote it. Docker echoes the reference in its errors, and a password can
 * hold a `/`, a space, or a quote that the text-shape rules deliberately do not
 * treat as one, so the reference's own grammar has to run first. Docker may
 * also quote only the parsed repository name, which starts after the
 * credential's first `/`; removing the userinfo and that tail covers the
 * rewrite. A digest pin carries no userinfo, so it is left intact.
 */
export function errorMessageForLog(error: unknown, options?: { imageRef?: string }): string {
  const message = messageWithCause(error);
  const text = options?.imageRef ? redactImageInText(message, options.imageRef) : message;
  return sanitizeForLog(redactSensitiveText(text));
}

/** Replace a known image reference and any credential fragment Docker echoes after rewriting it. */
function redactImageInText(text: string, imageRef: string): string {
  const reference = splitImageReference(imageRef);
  if (reference === null) return text;
  let out = text.split(imageRef).join(`[redacted]@${reference.rest}`);
  // Docker's domain split takes everything before the reference's first `/` as
  // the domain and reports the rest of the name, so the userinfo reaches the
  // message as its tail after that slash. Removing the tail takes every
  // `/`-separated segment with it, in one pass rather than one split per
  // segment, which a long slash-heavy reference would turn quadratic.
  const slash = reference.userinfo.indexOf('/');
  const tail = slash === -1 ? '' : reference.userinfo.slice(slash + 1);
  for (const fragment of [reference.userinfo, tail]) {
    // Punctuation-only pieces carry no credential value, and replacing them
    // would mangle the rest of the message.
    if (!/[A-Za-z0-9]/.test(fragment)) continue;
    out = out.split(fragment).join('[redacted]');
  }
  return out;
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
