// Turns a Docker image reference into actionable external links so operators can
// review an image upstream before approving an update. Pure and offline: parsing
// and URL building never touch the network. OCI label handling is deliberately
// conservative so untrusted image metadata can never produce a broken or unsafe
// link (only absolute http(s) values become links; everything else stays text).

export interface ParsedImageRef {
  /** Normalized registry host actually present in the ref ('docker.io' when implicit). */
  registry: string;
  /** First path segment (Docker Hub namespace / GHCR owner); null for official Hub images. */
  namespace: string | null;
  /** Repository name without the namespace, e.g. 'nginx', 'sonarr'. */
  repo: string;
  /** Tag if present, else null. */
  tag: string | null;
  /** Full digest including algorithm (e.g. 'sha256:abc…') if pinned, else null. */
  digest: string | null;
}

export type RegistryKind =
  | 'dockerhub-official'
  | 'dockerhub-namespace'
  | 'ghcr'
  | 'other';

interface ImageLinksBase {
  /** Host to display, e.g. 'docker.io', 'ghcr.io', 'registry.example.com:5000'. */
  registryHost: string;
  /** Human label for the registry, e.g. 'Docker Hub'. */
  registryLabel: string;
}

// A recognized registry always yields a link; an unknown/private registry never
// guesses one. Modeling that as a discriminated union makes the "no link for
// 'other'" rule provable at the type level instead of a convention.
export type ImageLinks =
  | (ImageLinksBase & { kind: Exclude<RegistryKind, 'other'>; registryUrl: string })
  | (ImageLinksBase & { kind: 'other'; registryUrl: null });

export interface ImageSourceLink {
  id: 'source' | 'url' | 'documentation' | 'revision';
  label: string;
  url: string;
}

export interface ImageSourceMeta {
  links: ImageSourceLink[];
  /** org.opencontainers.image.version, shown as plain text (never a derived link). */
  version: string | null;
  /** Short revision text, only when it could not be turned into a commit link. */
  revision: string | null;
}

// docker.io is the public alias; registry-1.docker.io / index.docker.io are the
// API/login hosts an explicit ref may carry. All three are Docker Hub for linking.
const DOCKER_HUB_HOSTS = new Set(['docker.io', 'registry-1.docker.io', 'index.docker.io']);

function isRegistryHost(segment: string): boolean {
  return segment.includes('.') || segment.includes(':') || segment === 'localhost';
}

export function parseImageRef(ref: string): ParsedImageRef | null {
  const trimmed = ref?.trim();
  if (!trimmed) return null;
  // A bare digest carries no repository, so there is nothing to link to.
  if (trimmed.startsWith('sha256:')) return null;

  let rest = trimmed;

  let digest: string | null = null;
  const atIdx = rest.indexOf('@');
  if (atIdx !== -1) {
    digest = rest.slice(atIdx + 1) || null;
    rest = rest.slice(0, atIdx);
  }

  let registry = 'docker.io';
  const slashIdx = rest.indexOf('/');
  if (slashIdx !== -1) {
    const firstPart = rest.slice(0, slashIdx);
    if (isRegistryHost(firstPart)) {
      registry = firstPart;
      rest = rest.slice(slashIdx + 1);
    }
  }

  let tag: string | null = null;
  const colonIdx = rest.lastIndexOf(':');
  if (colonIdx > 0) {
    tag = rest.slice(colonIdx + 1);
    rest = rest.slice(0, colonIdx);
  }

  if (!rest) return null;

  const segments = rest.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  let namespace: string | null;
  let repo: string;
  if (segments.length === 1) {
    namespace = null;
    repo = segments[0];
  } else {
    namespace = segments[0];
    repo = segments.slice(1).join('/');
  }

  return { registry, namespace, repo, tag, digest };
}

export function buildImageLinks(ref: string): ImageLinks | null {
  const parsed = parseImageRef(ref);
  if (!parsed) return null;
  const { registry, namespace, repo } = parsed;

  if (DOCKER_HUB_HOSTS.has(registry)) {
    const isOfficial = namespace === null || namespace === 'library';
    return {
      registryHost: 'docker.io',
      registryLabel: 'Docker Hub',
      kind: isOfficial ? 'dockerhub-official' : 'dockerhub-namespace',
      registryUrl: isOfficial
        ? `https://hub.docker.com/_/${repo}`
        : `https://hub.docker.com/r/${namespace}/${repo}`,
    };
  }

  if (registry === 'ghcr.io') {
    // GitHub does not expose a reliable package URL from the ref alone (user vs org,
    // image name may differ from the repo). The owner profile always resolves; the
    // exact source repo is filled in from the OCI source label when available.
    const owner = namespace ?? repo;
    return {
      registryHost: 'ghcr.io',
      registryLabel: 'GitHub Container Registry',
      kind: 'ghcr',
      registryUrl: `https://github.com/${owner}`,
    };
  }

  // Unknown / private registry: never guess a link, just expose the host.
  return {
    registryHost: registry,
    registryLabel: registry,
    kind: 'other',
    registryUrl: null,
  };
}

function asHttpUrl(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

function githubRepoRoot(sourceUrl: string): string | null {
  try {
    const u = new URL(sourceUrl);
    if (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/, '');
    return `https://github.com/${owner}/${repo}`;
  } catch {
    return null;
  }
}

const OCI = {
  source: 'org.opencontainers.image.source',
  url: 'org.opencontainers.image.url',
  documentation: 'org.opencontainers.image.documentation',
  revision: 'org.opencontainers.image.revision',
  version: 'org.opencontainers.image.version',
} as const;

const SHA_LIKE = /^[0-9a-f]{7,40}$/i;

export function extractImageSourceMeta(
  labels: Record<string, string> | null | undefined,
): ImageSourceMeta {
  const links: ImageSourceLink[] = [];
  if (!labels) return { links, version: null, revision: null };

  const sourceUrl = asHttpUrl(labels[OCI.source]);
  if (sourceUrl) links.push({ id: 'source', label: 'Source repository', url: sourceUrl });

  const homepage = asHttpUrl(labels[OCI.url]);
  if (homepage) links.push({ id: 'url', label: 'Project homepage', url: homepage });

  const docs = asHttpUrl(labels[OCI.documentation]);
  if (docs) links.push({ id: 'documentation', label: 'Documentation', url: docs });

  const rawRevision = labels[OCI.revision]?.trim() || null;
  let revisionText: string | null = rawRevision;
  if (rawRevision && SHA_LIKE.test(rawRevision) && sourceUrl) {
    const repoRoot = githubRepoRoot(sourceUrl);
    if (repoRoot) {
      links.push({
        id: 'revision',
        label: `Revision ${rawRevision.slice(0, 12)}`,
        url: `${repoRoot}/commit/${rawRevision}`,
      });
      revisionText = null;
    }
  }

  const version = labels[OCI.version]?.trim() || null;

  return { links, version, revision: revisionText };
}
