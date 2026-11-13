import { randomUUID } from 'crypto';
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
 * quote, or any length, and for a host with no path. Docker decodes the request
 * path once, so an authored `%40` can open a credential the written spelling
 * hides; decode once more before deciding there is none. Use it wherever an
 * `image` value is quoted or stored for display; free text that merely contains
 * an image still goes through `redactSensitiveText`.
 */
export function redactImageReference(image: string): string {
  // The decoded spelling is what Docker parses, and a literal `@` can sit
  // before an encoded one (`user@pw%40host/app`), so read the last `@` from the
  // decoded form rather than the authored one.
  const decoded = decodeDockerImagePath(image);
  const reference = splitImageReference(decoded);
  return reference === null ? image : `[redacted]@${reference.rest}`;
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

/**
 * Decode the percent escapes Docker's router resolves before it parses an
 * image request path. Go's `URL.Path` is decoded once, so `%2f` reaches the
 * reference parser as `/` and `%3a` as `:`. A syntactically malformed escape
 * is rejected before routing, but an escape that decodes to an invalid UTF-8
 * byte is not: Go keeps the byte in the path, and the JSON error body rewrites
 * it as U+FFFD. Decode the escape bytes as UTF-8 with replacement so the
 * spelling matches that echo, and keep the valid escapes even beside a broken
 * one.
 */
function decodeDockerImagePath(image: string): string {
  if (!image.includes('%')) return image;
  try {
    return decodeURIComponent(image);
  } catch {
    const encoder = new TextEncoder();
    const bytes: number[] = [];
    let literalStart = 0;
    for (let i = 0; i < image.length; i += 1) {
      if (image[i] !== '%') continue;
      const hex = image.slice(i + 1, i + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) continue;
      for (const byte of encoder.encode(image.slice(literalStart, i))) bytes.push(byte);
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
      literalStart = i + 1;
    }
    for (const byte of encoder.encode(image.slice(literalStart))) bytes.push(byte);
    return decodeUtf8WithReplacement(bytes);
  }
}

/**
 * Decode UTF-8 bytes, replacing each invalid byte with U+FFFD the way Go's JSON
 * encoder does. `TextDecoder` collapses a truncated multi-byte sequence into
 * one replacement character, which would leave the bytes after it looking like
 * a different spelling; Go advances one byte at a time, so a credential cannot
 * hide its tail behind a broken sequence.
 */
function decodeUtf8WithReplacement(bytes: readonly number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const first = bytes[i];
    if (first < 0x80) {
      out += String.fromCharCode(first);
      i += 1;
      continue;
    }
    let size: number;
    let codePoint: number;
    if (first >= 0xC2 && first <= 0xDF) {
      size = 2;
      codePoint = first & 0x1F;
    } else if (first >= 0xE0 && first <= 0xEF) {
      size = 3;
      codePoint = first & 0x0F;
    } else if (first >= 0xF0 && first <= 0xF4) {
      size = 4;
      codePoint = first & 0x07;
    } else {
      out += '\uFFFD';
      i += 1;
      continue;
    }
    if (i + size > bytes.length) {
      out += '\uFFFD';
      i += 1;
      continue;
    }
    let valid = true;
    for (let j = 1; j < size; j += 1) {
      const next = bytes[i + j];
      if ((next & 0xC0) !== 0x80) {
        valid = false;
        break;
      }
      codePoint = (codePoint << 6) | (next & 0x3F);
    }
    const overlong = size === 3 && codePoint < 0x800;
    const surrogate = codePoint >= 0xD800 && codePoint <= 0xDFFF;
    const outOfRange = size === 4 && (codePoint < 0x10000 || codePoint > 0x10FFFF);
    if (!valid || overlong || surrogate || outOfRange) {
      out += '\uFFFD';
      i += 1;
      continue;
    }
    out += String.fromCodePoint(codePoint);
    i += size;
  }
  return out;
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
 * also quote only the repository name it parsed from the request path, which it
 * decodes once and may normalize into a Docker Hub form, so an image whose
 * authored or decoded spelling carries a credential has that whole structured
 * field redacted rather than reconstructed. A digest pin with no userinfo is
 * left intact.
 */
export function errorMessageForLog(error: unknown, options?: { imageRef?: string }): string {
  const message = messageWithCause(error);
  const text = options?.imageRef ? redactImageInText(message, options.imageRef) : message;
  return sanitizeForLog(redactSensitiveText(text));
}

/** Replace a known image reference and any credential fragment Docker echoes after rewriting it. */
function redactImageInText(text: string, imageRef: string): string {
  // Docker receives the reference inside a URL path and its router decodes that
  // path once before the reference parser sees it, so the daemon can echo a
  // spelling the Compose file never held. The decoded spelling is also the
  // credential boundary: a literal `@` in the authored spelling can sit inside
  // the password (`user@pw%40host/app`), so only the decoded split may decide
  // what is credential-free. Replace an authored occurrence with that decoded
  // rest, never with the authored rest that may still hold the password tail.
  const decoded = decodeDockerImagePath(imageRef);
  const reference = splitImageReference(decoded);
  if (reference === null) return text;

  // The literal marker is attacker-controlled text: a credential can contain
  // it, and a previous call's output contains it too. The quoted-name passes
  // have to tell text these passes reduced from text the daemon quoted, so
  // every replacement writes this per-call sentinel and the result turns it
  // back into the marker. The random suffix keeps the input from forging it.
  const sentinel = `\u0000${randomUUID()}\u0000`;
  const spellings = imageRef.includes('%')
    ? [...new Set([imageRef, decoded])]
    : [imageRef];
  let out = text;
  for (const spelling of spellings) {
    out = out.split(spelling).join(`${sentinel}@${reference.rest}`);
  }

  const { userinfo, rest } = reference;
  const bareFragments = new Set<string>();
  const anchoredFragments = new Set<string>();
  if (userinfo.includes(':') || userinfo.length >= 8) bareFragments.add(userinfo);
  const slash = userinfo.indexOf('/');
  const tail = slash === -1 ? '' : userinfo.slice(slash + 1);
  // Anchoring each fragment to the host's `@` keeps a short password piece
  // from rewriting unrelated words. A `user:password` userinfo is
  // credential-shaped even when short, and a long token is distinctive, so
  // an echo of either is removed even without the host's `@`. A short
  // token-only userinfo is removed only before the `@`: replacing a bare
  // two- or three-letter token would rewrite ordinary words, and Docker's
  // echo keeps the `@`.
  anchoredFragments.add(userinfo);
  if (tail) anchoredFragments.add(tail);

  for (const fragment of bareFragments) {
    if (!/[A-Za-z0-9]/.test(fragment)) continue;
    out = out.split(fragment).join(sentinel);
  }
  // Remove a fragment anchored to the host's `@` before the quoted-name pass,
  // so a quote that still holds the host keeps its redacted host/path context
  // instead of collapsing to a bare marker. Punctuation-only pieces carry no
  // credential value, and replacing them would mangle the rest of the message.
  for (const fragment of anchoredFragments) {
    if (!/[A-Za-z0-9]/.test(fragment)) continue;
    out = out.split(`${fragment}@`).join(`${sentinel}@`);
  }
  // The invalid-reference error quotes the repository name the daemon parsed,
  // which can come from a path it decoded, a Docker Hub name it normalized, or
  // a byte the JSON body rewrote as U+FFFD. Reconstructing every form is not
  // exhaustive, so redact the structured field as a whole whenever the authored
  // or decoded spelling carries a credential: the failure reason and the
  // redacted reference stay, and only the name is lost. A field an earlier pass
  // already reduced keeps the host context it still holds, but only when that
  // context is validated against the credential-free part of the reference.
  out = redactQuotedRepositoryNames(out, rest, sentinel);
  // A different daemon error shape may quote a name without either known
  // suffix. Without a suffix its closing parenthesis is ambiguous, so redact
  // the rest of the message rather than stop at one the name may hold.
  out = redactNoSuffixQuotedNames(out, rest, sentinel);
  return out.split(sentinel).join(REDACTION_MARKER);
}

const REDACTION_MARKER = '[redacted]';

/** The suffixes Docker's reference parser follows a quoted repository name with. */
const QUOTED_REPOSITORY_NAME_SUFFIXES = [
  ' must be lowercase',
  ', cannot specify 64-byte hexadecimal strings',
];

/**
 * Normalize a quoted repository name that an earlier pass reduced, or return
 * null when the name may still carry a credential. A bare `[redacted]` proves
 * nothing: a credential can contain the literal, and the daemon can quote it
 * inside a longer name. Only the per-call sentinel proves that a redaction pass
 * produced the text. The one exception is a field followed by a known suffix,
 * whose matched end is the daemon's own closing parenthesis, so a previous
 * call's marker shape can be kept for idempotence. A kept field is returned in
 * sentinel form: a bare marker stays bare, and `sentinel@` (or marker@) keeps
 * only a prefix of the credential-free rest of the reference, which by
 * construction contains no credential.
 */
function keptRedactedContext(
  quotedName: string,
  safeRest: string,
  sentinel: string,
  allowPreviousOutput: boolean,
): string | null {
  const marker = quotedName.startsWith(sentinel)
    ? sentinel
    : allowPreviousOutput && quotedName.startsWith(REDACTION_MARKER)
      ? REDACTION_MARKER
      : null;
  if (marker === null) return null;
  if (quotedName === marker) return sentinel;
  if (!quotedName.startsWith(`${marker}@`)) return null;
  const context = quotedName.slice(marker.length + 1);
  if (!safeRest.startsWith(context)) return null;
  return `${sentinel}${quotedName.slice(marker.length)}`;
}

/**
 * Redact the repository name Docker quotes in an invalid-reference error.
 *
 * A credential can hold a `)` and even one of the suffixes, so the name ends at
 * the last `)` that one of those suffixes follows rather than at the first. The
 * scan is linear: a regular expression over the same text backtracks
 * quadratically on a message built from many `repository name (` runs.
 */
function redactQuotedRepositoryNames(text: string, safeRest: string, sentinel: string): string {
  const phrase = 'repository name (';
  let out = '';
  let copied = 0;
  let searchFrom = 0;
  while (true) {
    const openAt = text.indexOf(phrase, searchFrom);
    if (openAt === -1) break;
    // Greedy on purpose: a name can contain a suffix phrase, so the last match
    // is the daemon's closing parenthesis. A span that crosses several quoted
    // fields does not keep its context, so over-redacting two names stays the
    // safe direction. The scan consumes to the last close, so the loop stays
    // linear over the message.
    let closeAt = -1;
    for (let i = openAt + phrase.length; i < text.length; i += 1) {
      if (text[i] !== ')') continue;
      for (const suffix of QUOTED_REPOSITORY_NAME_SUFFIXES) {
        if (text.startsWith(suffix, i + 1)) {
          closeAt = i;
          break;
        }
      }
    }
    if (closeAt === -1) break;
    const quotedName = text.slice(openAt + phrase.length, closeAt);
    const kept = keptRedactedContext(quotedName, safeRest, sentinel, true);
    out += `${text.slice(copied, openAt)}repository name (${kept ?? sentinel})`;
    copied = closeAt + 1;
    searchFrom = closeAt + 1;
  }
  out += text.slice(copied);
  return out;
}

/**
 * Redact a quoted repository name that has no known daemon suffix. Only the
 * phrase is rewritten, so a short prefix such as `Pass` does not rewrite the
 * same word elsewhere in the message, and the scan is linear in the message
 * length.
 *
 * Without a recognised suffix there is no trusted end to the name: a `)` in a
 * credential would make the first one too early and leave the tail behind. Only
 * a field this call already reduced keeps its text; any other field takes the
 * rest of the message with it. A previous call's bare marker is not proof for
 * this pass: the daemon can quote that literal inside a longer credential.
 */
function redactNoSuffixQuotedNames(text: string, safeRest: string, sentinel: string): string {
  const phrase = 'repository name (';
  let out = '';
  let copied = 0;
  let searchFrom = 0;
  while (true) {
    const openAt = text.indexOf(phrase, searchFrom);
    if (openAt === -1) break;
    const closeAt = text.indexOf(')', openAt + phrase.length);
    const quotedName = closeAt === -1 ? '' : text.slice(openAt + phrase.length, closeAt);
    const kept = closeAt === -1 ? null : keptRedactedContext(quotedName, safeRest, sentinel, false);
    if (kept !== null) {
      out += `${text.slice(copied, openAt)}repository name (${kept})`;
      copied = closeAt + 1;
      searchFrom = closeAt + 1;
      continue;
    }
    out += `${text.slice(copied, openAt)}repository name (${sentinel})`;
    copied = text.length;
    break;
  }
  out += text.slice(copied);
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
