/**
 * What image an operation will actually run.
 *
 * Every update path claimed a policy check but evaluated the image already on the
 * node: `trivy image <tag>` and the 24 hour digest cache both read the local
 * daemon first, so for a floating tag the gate proved the old image safe and the
 * pull then replaced it. This module answers the other question, "which image will
 * this operation install", before anything is pulled, tagged, or scanned.
 *
 * A candidate is identified by digest for a specific platform: the index digest
 * is what the tag currently resolves to, and the platform digest is the one
 * manifest this node would run. Scanning the platform child is what makes the
 * findings apply to this node rather than to an architecture it does not run.
 *
 * Reuse, not a second engine: resolution goes through the same registry client,
 * credentials, and platform reader the GitOps artifact resolver uses, and the
 * failure classes are that resolver's own vocabulary.
 */
import { classifyReferenceKind } from './imageReferenceKind';
import DockerController from './DockerController';
import { RegistryService } from './RegistryService';
import { parseImageRef, resolveRegistryImageDigestForPlatform, type RegistryCredentials } from './registry-api';
import { mapRegistryFailure } from './gitops/registryFailure';
import { evidenceStateForFailureClass } from './securityEvidence';
import { readNodePlatform, type NodePlatform } from './gitops/effectiveArtifactContext';
import type { ArtifactServiceFailureClass } from './gitops/json';

/**
 * Which image an operation will run.
 *
 * `installed` is what the node holds now: a rollback, a restore, a digest pin, or
 * a deploy Compose will not pull. `registry` is an update that runs an explicit
 * `docker compose pull`; `compose` is a plain `up`. Both fetch only what each
 * service's own `pull_policy` (or a missing local image) makes them fetch, so
 * both use the same per-service decision.
 */
export type ImageSource = 'installed' | 'registry' | 'compose';

export type CandidateWhy = 'digest_pinned' | 'not_pulled' | 'build';

export type CandidateResolution =
  | { kind: 'installed'; ref: string; why: CandidateWhy }
  | {
      kind: 'candidate';
      ref: string;
      /** `repo@sha256:<platformDigest>`, the exact manifest to scan. */
      scanRef: string;
      /** The digest the tag resolves to on the registry (the index, for multi-arch). */
      indexDigest: string;
      platformDigest: string;
      platform: string;
      /** `exact` for a single manifest, `qualified` for one child of an index. */
      qualification: 'exact' | 'qualified';
    }
  | {
      kind: 'unresolved';
      ref: string;
      state: 'unavailable' | 'unknown' | 'unsupported' | 'failed';
      failureClass: ArtifactServiceFailureClass;
      reason: string;
    };

/** Everything the resolver reads from the outside, injected so it stays testable. */
export interface CandidateDeps {
  readPlatform?: (nodeId: number) => Promise<NodePlatform | null>;
  getAuth?: (registry: string) => Promise<RegistryCredentials | null>;
  resolveDigest?: typeof resolveRegistryImageDigestForPlatform;
}

/**
 * Resolve the image a tag currently points at on the registry, for this node's
 * platform. Never pulls or tags anything: the installed tag is untouched until
 * the operation's own pull, so a refused candidate leaves the node exactly as it
 * was.
 */
export async function resolveCandidateImage(
  nodeId: number,
  ref: string,
  platform: NodePlatform | null,
  deps: CandidateDeps = {},
): Promise<CandidateResolution> {
  if (classifyReferenceKind(ref) === 'digest_pinned') {
    // The pinned digest is the candidate, so there is nothing to resolve and no
    // registry call to make.
    return { kind: 'installed', ref, why: 'digest_pinned' };
  }
  const parsed = parseImageRef(ref);
  if (!parsed) {
    return {
      kind: 'unresolved',
      ref,
      state: 'unsupported',
      failureClass: 'unsupported_registry',
      reason: 'The image reference could not be parsed, so the registry image could not be resolved',
    };
  }
  if (!platform) {
    return {
      kind: 'unresolved',
      ref,
      state: 'unknown',
      failureClass: 'platform_ambiguity',
      reason: 'This node did not report its platform, so the registry image for it could not be chosen',
    };
  }
  const auth = deps.getAuth ?? ((registry: string) => RegistryService.getInstance().getAuthForRegistry(registry));
  const resolveDigest = deps.resolveDigest ?? resolveRegistryImageDigestForPlatform;
  let credentials: RegistryCredentials | null;
  try {
    credentials = await auth(parsed.registry);
  } catch (err) {
    return {
      kind: 'unresolved',
      ref,
      state: 'unavailable',
      failureClass: 'credential_failure',
      reason: `Sencho could not read its registry credentials: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const remote = await resolveDigest(parsed.registry, parsed.repo, parsed.tag, platform, credentials);
  if (!remote.ok) {
    const failureClass = mapRegistryFailure(remote.reason);
    return {
      kind: 'unresolved',
      ref,
      // The shared vocabulary decides the evidence state, so a class the gate
      // treats as indeterminate here cannot read as merely unavailable there.
      state: evidenceStateForFailureClass(failureClass) as 'unavailable' | 'unknown' | 'unsupported' | 'failed',
      failureClass,
      reason: `The registry image could not be resolved: ${remote.reason}`,
    };
  }
  return {
    kind: 'candidate',
    ref,
    // Repository form, not the authored tag: a moving tag would resolve to the
    // index here, and an index is not a scannable image.
    scanRef: `${parsed.registry}/${parsed.repo}@${remote.platformDigest}`,
    indexDigest: remote.indexDigest,
    platformDigest: remote.platformDigest,
    platform: remote.platformLabel,
    qualification: remote.qualification,
  };
}

/** The platform this node runs, or null when its daemon did not answer. */
export async function nodePlatformFor(nodeId: number): Promise<NodePlatform | null> {
  return readNodePlatform(nodeId);
}

/** Whether the node already holds this reference, so `compose up` will not pull it. */
export async function localImageExists(nodeId: number, ref: string): Promise<boolean> {
  try {
    await DockerController.getInstance(nodeId).getDocker().getImage(ref).inspect();
    return true;
  } catch {
    return false;
  }
}

/**
 * When Docker last tagged this reference locally, in epoch ms, or null when the
 * image is absent or the daemon did not report it. Compose's interval policies
 * compare this against `now` to decide whether `up` refreshes the image, so the
 * gate uses the same fact rather than assuming every interval is due.
 */
export async function localImageLastTagTime(nodeId: number, ref: string): Promise<number | null> {
  try {
    const info = await DockerController.getInstance(nodeId).getDocker().getImage(ref).inspect() as {
      Metadata?: { LastTagTime?: string };
    };
    const raw = info.Metadata?.LastTagTime;
    if (typeof raw !== 'string') return null;
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Compose pull policies that fetch on every `up` or `pull`. `missing` and
 * `build` are excluded: `missing` pulls only when the image is absent (checked
 * separately) and `build` builds from a Dockerfile, so neither turns an
 * already-present image into a candidate.
 *
 * Duration policies are matched by prefix rather than enumerated: Compose accepts
 * `every_<number><unit>` for any unit it understands, and an unrecognised policy
 * is treated as pulling. Reading an unknown policy as "will not pull" would let a
 * Compose version that fetches slip past the gate.
 */
const PULLING_POLICIES: ReadonlySet<string> = new Set(['always', 'refresh', 'daily', 'weekly']);

/**
 * Whether a Compose policy can fetch a present image. Interval policies are
 * included; a caller that needs the exact `up` decision must also compare
 * `pullPolicyRefreshDue` against the local last tag time.
 */
export function pullPolicyPullsOnUp(pullPolicy: string | null | undefined): boolean {
  if (typeof pullPolicy !== 'string') return false;
  const value = pullPolicy.trim().toLowerCase();
  if (value === '') return false;
  if (PULLING_POLICIES.has(value)) return true;
  if (value.startsWith('every_')) return value.length > 'every_'.length;
  // `never`, `missing` and `build` are the three that do not fetch a present
  // image; anything else is unknown, and unknown is treated as pulling.
  return value !== 'never' && value !== 'missing' && value !== 'build';
}

/**
 * Whether Compose skips this service even when the image is absent. `pull` and
 * `up` honour `never`, so a missing image under it fails the operation instead
 * of fetching one the gate would have to treat as a candidate.
 */
export function pullPolicyNever(pullPolicy: string | null | undefined): boolean {
  return typeof pullPolicy === 'string' && pullPolicy.trim().toLowerCase() === 'never';
}

/** Normalised policy text, empty when the service declares none. */
export function normalizedPullPolicy(pullPolicy: string | null | undefined): string {
  return typeof pullPolicy === 'string' ? pullPolicy.trim().toLowerCase() : '';
}

/**
 * How long an interval policy waits before `up` refreshes the image, in ms.
 * Null means this is not an interval policy (or is an `every_` value this build
 * cannot parse, which callers treat as due: an unknown interval must not let a
 * stale image through).
 */
export function pullPolicyRefreshAfterMs(pullPolicy: string | null | undefined): number | null {
  const value = normalizedPullPolicy(pullPolicy);
  if (value === 'refresh') return 0;
  if (value === 'daily') return 24 * 60 * 60 * 1000;
  if (value === 'weekly') return 7 * 24 * 60 * 60 * 1000;
  if (!value.startsWith('every_')) return null;
  const body = value.slice('every_'.length);
  if (body === '') return null;
  const units: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
  };
  let total = 0;
  let consumed = 0;
  const part = /(\d+(?:\.\d+)?)(ms|s|m|h|d|w)/g;
  for (let match = part.exec(body); match !== null; match = part.exec(body)) {
    if (match.index !== consumed) return null;
    total += Number(match[1]) * units[match[2]];
    consumed = match.index + match[0].length;
  }
  return consumed === body.length && total > 0 ? total : null;
}

/**
 * Whether an interval policy is due to refresh at `now`. A missing or
 * unreadable tag time is due, matching Compose's zero LastTagTime. An interval
 * value this build cannot parse is also due, the fail-closed reading.
 */
export function pullPolicyRefreshDue(
  pullPolicy: string | null | undefined,
  lastTagTimeMs: number | null,
  now = Date.now(),
): boolean {
  const interval = pullPolicyRefreshAfterMs(pullPolicy);
  if (interval === null) return true;
  if (lastTagTimeMs === null) return true;
  return now >= lastTagTimeMs + interval;
}

/**
 * Whether a reference names the floating `latest` tag. Compose's explicit
 * `pull` refreshes a present `latest` even under `pull_policy: missing`, because
 * the tag is expected to move.
 */
export function isLatestImageTag(ref: string): boolean {
  const parsed = parseImageRef(ref);
  return parsed !== null && parsed.tag === 'latest';
}
