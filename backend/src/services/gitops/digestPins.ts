import { decodeArtifactEvidenceJson, isRecord } from './json';
import { GitOpsStore } from './store';
import { approvedPlatformDigest } from './artifactIdentity';
import { parse as parseYaml } from 'yaml';

/** serviceName → `name@sha256:<64 hex>` pin map used by digest overlay deploys. */
export type DigestPinsMap = Record<string, string>;

const DIGEST_PIN_RE = /^.+@sha256:[a-fA-F0-9]{64}$/;
const PLATFORM_DIGEST_RE = /^sha256:[a-fA-F0-9]{64}$/;

/** True when `pin` is a non-empty image name with a full sha256 digest. */
export function isDigestPinValue(pin: string): boolean {
  return DIGEST_PIN_RE.test(pin);
}

/** True when `value` is a non-empty map of valid digest pins. */
export function isDigestPinsMap(value: unknown): value is DigestPinsMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length > 0 && entries.every(
    ([key, pin]) => key.length > 0 && typeof pin === 'string' && isDigestPinValue(pin),
  );
}

/**
 * Build a per-service digest pin map from an expected artifact set.
 *
 * Returns null when the set is missing, not exact/qualified, or any service
 * lacks a platform digest. Callers must fail closed rather than falling back
 * to a tag pull.
 */
export function buildDigestPinsFromArtifactSet(
  artifactSetId: string,
  platformLabel?: string | null,
): DigestPinsMap | null {
  if (!platformLabel) return null;
  const row = GitOpsStore.getInstance().getArtifactSet(artifactSetId);
  if (!row) return null;
  if (row.qualification !== 'exact' && row.qualification !== 'qualified') return null;
  let evidence;
  try {
    evidence = decodeArtifactEvidenceJson(row.evidence_json);
  } catch {
    return null;
  }
  if (!('services' in evidence) || !evidence.services || evidence.services.length === 0) {
    return null;
  }
  const pins: DigestPinsMap = {};
  for (const service of evidence.services) {
    const digest = approvedPlatformDigest(service, platformLabel ?? null);
    if (!digest || !PLATFORM_DIGEST_RE.test(digest)) {
      return null;
    }
    if (!service.authoredRef) return null;
    const pin = toDigestImageRef(service.authoredRef, digest);
    if (!pin) return null;
    pins[service.serviceName] = pin;
  }
  return pins;
}

/** Strip tag/digest from an authored ref and append `@sha256:…`. */
export function toDigestImageRef(authoredRef: string, digest: string): string | null {
  if (!PLATFORM_DIGEST_RE.test(digest)) return null;
  let base = authoredRef;
  const at = base.indexOf('@');
  if (at !== -1) base = base.slice(0, at);
  const slash = base.lastIndexOf('/');
  const colon = base.lastIndexOf(':');
  if (colon > slash) base = base.slice(0, colon);
  if (!base) return null;
  return `${base}@${digest}`;
}

/** Compose overlay YAML that pins each service image without rewriting authored files. */
export function digestPinsOverlayYaml(pins: DigestPinsMap): string {
  const lines = ['services:'];
  for (const [serviceName, image] of Object.entries(pins).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${JSON.stringify(serviceName)}:`);
    lines.push(`    image: ${JSON.stringify(image)}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** Service names declared in compose YAML, or null when the document cannot be parsed. */
function composeServiceNames(composeContent: string): string[] | null {
  try {
    const parsed: unknown = parseYaml(composeContent);
    if (!isRecord(parsed) || !isRecord(parsed.services)) return null;
    const names = Object.keys(parsed.services).filter((name) => name.length > 0);
    return names.length > 0 ? names : null;
  } catch {
    return null;
  }
}

/** True when every pin key names a service in the submitted compose content. */
export function digestPinsMatchComposeServices(pins: DigestPinsMap, composeContent: string): boolean {
  const names = composeServiceNames(composeContent);
  if (!names) return false;
  const allowed = new Set(names);
  return Object.keys(pins).every((key) => allowed.has(key));
}
