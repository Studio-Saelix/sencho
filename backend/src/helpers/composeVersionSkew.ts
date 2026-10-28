/**
 * Containers a different `docker compose` version created than the one this
 * node deploys with.
 *
 * Compose decides whether a container is out of date by comparing the
 * configuration hash and the image digest it computes with the values the
 * creating version recorded in the container's labels. Versions normalize a
 * bind mount and record an image digest differently, so a container another
 * version created can be recreated even when nothing in the Compose file
 * changed. Sencho cannot make its bundled Compose compute what another version
 * recorded, so it reports the mismatch and lets the one-time recreate happen.
 */

export interface ComposeVersionContainer {
  /** `com.docker.compose.service`; null for an orphan or an empty label. */
  service: string | null;
  /** `com.docker.compose.version`; null when the label is absent or empty. */
  composeVersion: string | null;
  /** `com.docker.compose.oneoff === 'True'`, i.e. a `compose run` container. */
  oneOff: boolean;
}

export interface ComposeVersionSkew {
  /** Normalized version this node deploys with, e.g. "5.6.0". */
  runningVersion: string;
  /** Services with at least one container recording another version or none, sorted by name. */
  services: Array<{ service: string; createdBy: Array<string | null> }>;
}

/** The `v` prefix `docker compose version --short` may print is not part of the container label. */
export function normalizeComposeVersion(version: string | null | undefined): string {
  return (version ?? '').trim().replace(/^v/, '');
}

/**
 * `docker compose version --short` is a local command and must answer quickly;
 * a hung one must not stall a deploy, a Doctor run, or a readiness report.
 */
export const COMPOSE_VERSION_PROBE_TIMEOUT_MS = 5_000;

/**
 * Read the three Compose labels this module compares. An empty label is no
 * label (`|| null`), so a refusal or explanation never names an empty service
 * or version.
 */
export function composeVersionContainerFromLabels(labels: Record<string, string> | undefined): ComposeVersionContainer {
  return {
    service: labels?.['com.docker.compose.service'] || null,
    composeVersion: normalizeComposeVersion(labels?.['com.docker.compose.version']) || null,
    oneOff: labels?.['com.docker.compose.oneoff'] === 'True',
  };
}

/**
 * The services whose containers record a version other than `runningVersion`,
 * with every version they record. Null when the running version cannot be read,
 * so a caller can tell "cannot tell" from "no mismatch"; `services` is empty
 * when everything matches.
 *
 * A container with no service label is an orphan Compose removes rather than
 * recreates, and a one-off container is never brought up again, so neither is
 * reported.
 */
export function findComposeVersionSkew(
  containers: ComposeVersionContainer[],
  runningVersion: string | null,
): ComposeVersionSkew | null {
  const running = normalizeComposeVersion(runningVersion);
  if (!running) return null;
  const byService = new Map<string, Set<string | null>>();
  for (const container of containers) {
    if (container.service === null || container.oneOff) continue;
    const recorded = normalizeComposeVersion(container.composeVersion) || null;
    if (recorded === running) continue;
    const versions = byService.get(container.service) ?? new Set<string | null>();
    versions.add(recorded);
    byService.set(container.service, versions);
  }
  const services = [...byService.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([service, versions]) => ({
      service,
      // Known versions first, the "records none" marker last, each listed once.
      createdBy: [...versions].sort((a, b) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b))),
    }));
  return { runningVersion: running, services };
}

/** "a", "a and b", "a, b, and c". */
function listOf(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

/** "proxy was created by Docker Compose 2.38.1" (no trailing period). */
export function describeComposeVersionSkew(skew: ComposeVersionSkew): string {
  // Services recording the same versions read as one sentence ("proxy and app
  // were created by ..."); a genuinely mixed set keeps one clause per group.
  const groups = new Map<string, { services: string[]; createdBy: Array<string | null> }>();
  for (const entry of skew.services) {
    const key = JSON.stringify(entry.createdBy);
    const group = groups.get(key);
    if (group) group.services.push(entry.service);
    else groups.set(key, { services: [entry.service], createdBy: entry.createdBy });
  }
  return [...groups.values()].map((group) => {
    const plural = group.services.length > 1;
    const known = group.createdBy.filter((version): version is string => version !== null);
    const clauses: string[] = [];
    if (known.length > 0) {
      clauses.push(`${plural ? 'were' : 'was'} created by Docker Compose ${known.join(' and ')}`);
    }
    if (group.createdBy.includes(null)) {
      clauses.push(`${plural ? 'record' : 'records'} no Compose version`);
    }
    return `${listOf(group.services)} ${clauses.join(' and ')}`;
  }).join('; ');
}
