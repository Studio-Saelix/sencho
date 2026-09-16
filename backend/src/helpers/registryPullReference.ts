import { normalizeImageHost } from '../services/RegistryService';

/**
 * A single canonical pull reference parsed for exact-ref proof and delivery.
 * `value` is always the canonical `registry/repo:tag` or `registry/repo@digest`
 * form (Docker Hub aliases folded to index.docker.io, `library/` prefix applied,
 * tag defaulted to `latest`). A digest ref keeps its digest exactly and never
 * falls back to a tag.
 */
export type ParsedPullReference =
  | { kind: 'tag'; value: string }
  | { kind: 'digest'; value: string };

/**
 * The host segment of a canonical pull reference, or null when the value
 * carries no host. Canonical refs always do; the null exists for callers that
 * must not assume it.
 */
export function canonicalRefHost(value: string): string | null {
  const slash = value.indexOf('/');
  return slash === -1 ? null : value.slice(0, slash);
}

/** The registry host a parsed pull reference targets, in canonical form. */
export function pullReferenceHost(ref: ParsedPullReference): string {
  const host = canonicalRefHost(ref.value);
  if (host === null) {
    throw new Error(`Pull reference has no registry host: ${ref.value}`);
  }
  return host;
}

const HUB_REGISTRY = 'index.docker.io';
const DIGEST_RE = /^[a-z0-9+._-]+:[a-f0-9]+$/i;

/**
 * Bare local image IDs (`sha256:...` with no repo) are not pull references.
 * Restricted to the sha256 prefix because docker image IDs are always sha256;
 * a broader name:hex pattern would reject legitimate short names whose tag is
 * all hex digits (alpine:3, node:20, redis:6).
 */
function isBareImageId(ref: string): boolean {
  return /^sha256:[a-f0-9]+$/i.test(ref);
}

/**
 * Parse a pull reference into canonical form. Returns null for empty,
 * unparseable, or bare local image ID inputs (these are omitted, not fatal).
 * Deliberately distinct from the tag-oriented `parseImageRef` in registry-api.ts,
 * which strips `@digest` and defaults to `latest`; this parser preserves a
 * digest manifest reference exactly.
 */
export function parsePullReference(raw: string): ParsedPullReference | null {
  const ref = raw.trim();
  if (!ref) return null;

  const atIdx = ref.indexOf('@');
  let namePart = ref;
  let digest: string | null = null;
  if (atIdx !== -1) {
    namePart = ref.slice(0, atIdx);
    digest = ref.slice(atIdx + 1);
    if (!DIGEST_RE.test(digest)) return null;
    if (!namePart) return null;
    if (isBareImageId(namePart)) return null;
  }

  if (isBareImageId(ref)) return null;

  const slashIdx = namePart.indexOf('/');
  let registry: string;
  let repo: string;
  if (slashIdx === -1) {
    registry = HUB_REGISTRY;
    repo = namePart;
  } else {
    const first = namePart.slice(0, slashIdx);
    if (first.includes('.') || first.includes(':') || first === 'localhost') {
      // A colon in the first segment is a registry port; docker's reference
      // grammar requires it to be numeric, so a sha256:<hex>/... form is an
      // invalid ref rather than a host named sha256.
      const portColon = first.lastIndexOf(':');
      if (portColon !== -1 && !/^\d+$/.test(first.slice(portColon + 1))) {
        return null;
      }
      registry = first;
      repo = namePart.slice(slashIdx + 1);
    } else {
      registry = HUB_REGISTRY;
      repo = namePart;
    }
  }

  registry = normalizeImageHost(registry);

  if (digest !== null) {
    // A digest ref may carry a name:tag@digest pin; only the digest is
    // canonical, so strip the tag exactly as the tag branch below does.
    const colonIdx = repo.lastIndexOf(':');
    if (colonIdx > 0) {
      repo = repo.slice(0, colonIdx);
    }
    if (!repo) return null;
    if (registry === HUB_REGISTRY && !repo.includes('/')) {
      repo = `library/${repo}`;
    }
    return { kind: 'digest', value: `${registry}/${repo}@${digest}` };
  }

  // Tag: the last colon after the repo is the separator; a registry port was
  // consumed above and cannot appear here.
  const colonIdx = repo.lastIndexOf(':');
  let tag = 'latest';
  if (colonIdx > 0) {
    tag = repo.slice(colonIdx + 1);
    repo = repo.slice(0, colonIdx);
  }
  if (!repo) return null;

  if (registry === HUB_REGISTRY && !repo.includes('/')) {
    repo = `library/${repo}`;
  }

  return { kind: 'tag', value: `${registry}/${repo}:${tag}` };
}

/** Max number of distinct exact pull references a discovery may carry. */
export const PULL_REF_MAX_COUNT = 200;

/** Max serialized size of the exact pull reference list (64 KiB). */
const PULL_REF_MAX_BYTES = 64 * 1024;

/**
 * Canonicalize and bound a set of pull references. Deduplicates, omits
 * unparseable entries, and sorts for stable hashing. Throws a 413-style error
 * when the set exceeds the count or byte cap.
 */
export function normalizePullRefList(refs: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of refs) {
    const parsed = parsePullReference(raw);
    if (!parsed) continue;
    if (seen.has(parsed.value)) continue;
    seen.add(parsed.value);
    out.push(parsed.value);
    if (out.length > PULL_REF_MAX_COUNT) {
      throw pullRefLimitError();
    }
  }
  out.sort();
  const bytes = Buffer.byteLength(JSON.stringify(out), 'utf8');
  if (bytes > PULL_REF_MAX_BYTES) {
    throw pullRefLimitError();
  }
  return out;
}

function pullRefLimitError(): Error {
  const error = new Error('Too many registry pull references');
  (error as { status?: number }).status = 413;
  return error;
}
