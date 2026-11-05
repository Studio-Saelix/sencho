/**
 * The OCI names for the architecture spellings Docker reports, and the label
 * canonicalizer shared by the live read and the stored-evidence decoder.
 *
 * `docker info` reports the daemon host's `uname -m` spelling (`x86_64`,
 * `aarch64`, `loongarch64`), while registry index descriptors and OCI manifests
 * name platforms with GOARCH names (`amd64`, `arm64`, `loong64`). Platform
 * labels are compared by exact string, so both the read and evidence decoded
 * from storage pass through one translation.
 *
 * 32-bit ARM spellings (`armv6l`, `armv7l`, `armv8l`) are deliberately absent.
 * OCI distinguishes the `arm` variants (v6/v7/v8), this code does not model the
 * variant, and translating them to `arm` could qualify a child built for a
 * different ABI. They pass through and the resolver fails closed on them.
 */
const DOCKER_TO_OCI_ARCHITECTURE: Record<string, string> = {
  x86_64: 'amd64',
  aarch64: 'arm64',
  i386: '386',
  i486: '386',
  i586: '386',
  i686: '386',
  loongarch64: 'loong64',
};

/** OCI name for a docker-info architecture spelling; unknown names pass through. */
export function toOciArchitecture(architecture: string): string {
  const normalized = architecture.trim().toLowerCase();
  return DOCKER_TO_OCI_ARCHITECTURE[normalized] ?? normalized;
}

/**
 * Canonicalize an `os/architecture` label (an optional variant segment is left
 * as is) to the names registry descriptors use. Evidence stored before the read
 * normalized docker-info spellings can still say `linux/x86_64`, and a fresh
 * comparison says `linux/amd64`, so both sides are translated before they meet.
 */
export function canonicalPlatformLabel(label: string): string {
  const [os, architecture, ...rest] = label.split('/');
  if (!os || !architecture) return label;
  return [os.trim().toLowerCase(), toOciArchitecture(architecture), ...rest].join('/');
}

/**
 * Canonicalize a node's OS/architecture read into the same label vocabulary.
 * An optional variant is kept when one is supplied, because two children of the
 * same OS and architecture (arm/v6 and arm/v7) are different images.
 */
export function canonicalNodePlatform(
  platform: { os: string; architecture: string; variant?: string },
): { os: string; architecture: string; variant?: string } {
  const variant = typeof platform.variant === 'string' ? platform.variant.trim().toLowerCase() : '';
  return {
    os: platform.os.trim().toLowerCase(),
    architecture: toOciArchitecture(platform.architecture),
    ...(variant ? { variant } : {}),
  };
}

/**
 * The variant Compose selects when an override names only an architecture that
 * has variants. A local image that reports a different variant is not the child
 * the operation will run.
 */
export const DEFAULT_ARCHITECTURE_VARIANT: Readonly<Record<string, string>> = {
  arm: 'v7',
  arm64: 'v8',
  amd64: 'v1',
};

/**
 * The cache-key form of a platform label.
 *
 * Canonicalized like the resolver's labels, with the architecture's default
 * variant dropped: `linux/arm64/v8` and `linux/arm64` name the same child, so a
 * candidate that asked for the default variant and the installed image's own
 * read must share a row. A non-default variant (`linux/arm/v6`) is kept because
 * it is a different child.
 */
export function platformCacheKey(label: string): string | null {
  const [os, architecture, ...rest] = label.split('/');
  if (!os || !architecture) return null;
  const platform = canonicalNodePlatform({ os, architecture, variant: rest[0] ?? '' });
  if (!platform.os || !platform.architecture) return null;
  const variant = platform.variant && platform.variant !== DEFAULT_ARCHITECTURE_VARIANT[platform.architecture]
    ? platform.variant
    : '';
  return `${platform.os}/${platform.architecture}${variant ? `/${variant}` : ''}`;
}

/**
 * The platform label of an image Docker holds locally, in the registry
 * resolver's vocabulary (and in the cache-key form above).
 *
 * An image whose platform the daemon did not report returns null.
 */
export function imagePlatformLabel(info: {
  Os?: unknown;
  Architecture?: unknown;
  Variant?: unknown;
}): string | null {
  const platform = canonicalNodePlatform({
    os: typeof info.Os === 'string' ? info.Os : '',
    architecture: typeof info.Architecture === 'string' ? info.Architecture : '',
    variant: typeof info.Variant === 'string' ? info.Variant : '',
  });
  if (!platform.os || !platform.architecture) return null;
  return platformCacheKey(
    `${platform.os}/${platform.architecture}${platform.variant ? `/${platform.variant}` : ''}`,
  );
}
