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

/** Canonicalize a node's OS/architecture read into the same label vocabulary. */
export function canonicalNodePlatform(
  platform: { os: string; architecture: string },
): { os: string; architecture: string } {
  return {
    os: platform.os.trim().toLowerCase(),
    architecture: toOciArchitecture(platform.architecture),
  };
}
