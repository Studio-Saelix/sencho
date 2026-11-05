import type { Request, Response } from 'express';
import {
  enforcePolicyForImageRefs,
  enforcePolicyPreDeploy,
  evaluateRemoteCandidateSupport,
  type EvaluatedCandidate,
  type PolicyEnforcementOptions,
  type PolicyViolation,
} from '../services/PolicyEnforcement';
import { allowedPolicyEvidence, type AllowedPolicyEvidence } from '../services/allowedPolicyEvidence';
import DockerController from '../services/DockerController';
import { DatabaseService } from '../services/DatabaseService';
import type { ScanPolicy } from '../services/DatabaseService';
import { NotificationService } from '../services/NotificationService';
import TrivyService, { DIGEST_CACHE_TTL_MS } from '../services/TrivyService';
import { configIdForLocalBuild, parseImageRef, selectLocalRepoDigests } from '../services/registry-api';
import { probeRemoteCapability } from './remoteCapabilities';
import { CANDIDATE_IMAGE_GATE_CAPABILITY } from '../services/CapabilityRegistry';
import { getErrorMessage } from '../utils/errors';
import { sanitizeForLog } from '../utils/safeLog';
import { summarizeBlockReasons } from '../utils/policy-risk';
import { NODE_WIDE_EVIDENCE_TARGET, type EvidenceGateDecision } from '../services/securityEvidence';

export { allowedPolicyEvidence, type AllowedPolicyEvidence };

type BlockableAction = 'deploy' | 'update' | 'rollback';

/**
 * Targets that stand for something other than an image. The node-wide sentinel is
 * the target a scanner-availability record carries; the other two are the
 * placeholders a node-wide refusal puts in the violation list so the caller has
 * something to render. None is an image, so none belongs in an `images=[...]`
 * list. Every entry is parenthesised on purpose: `node` alone is a valid bare
 * image name, so filtering on it would drop a real image from the message.
 */
const NON_IMAGE_TARGETS: ReadonlySet<string> = new Set([
  NODE_WIDE_EVIDENCE_TARGET,
  '(scanner unavailable)',
  '(compose parse error)',
]);

/** The image references an evidence refusal is about, de-duplicated. */
function unprovenImages(violations: PolicyViolation[], evidence?: EvidenceGateDecision): string[] {
  const images = new Set<string>();
  for (const v of violations) {
    if (v.error && !NON_IMAGE_TARGETS.has(v.imageRef)) images.add(v.imageRef);
  }
  for (const a of evidence?.applications ?? []) {
    if (a.outcome === 'block' && a.target && !NON_IMAGE_TARGETS.has(a.target)) images.add(a.target);
  }
  return [...images];
}

/** Append `images=[...]` when there is at least one image to name. */
function namedImages(images: readonly string[]): string {
  return images.length > 0 ? ` images=[${images.join(', ')}]` : '';
}

/**
 * The sentence for a payload carrying at least one genuine match.
 *
 * The matched images are named, as they were before the evidence-aware message:
 * on the unattended paths this sentence is the only account of which images were
 * involved.
 *
 * A payload can carry a genuine match *and* images the gate could not examine.
 * Naming only the matches leaves the second half of the block invisible here: the
 * operator fixes these, redeploys, and only then meets the other one. The matches
 * stay the subject of the sentence, since they are why the block happened, so the
 * unevaluated images are a second clause rather than a rewrite.
 *
 * "could not be evaluated" rather than "could not be scanned", because the clause
 * also covers an image whose scan completed and whose policy evaluation threw.
 * Calling that a scan failure would send the operator to the scanner instead of
 * to whatever made the evaluation fail.
 */
function describeMatchedBlock(
  name: string,
  action: BlockableAction,
  genuine: PolicyViolation[],
  unevaluated: readonly string[],
): string {
  const images = genuine
    .map((v) => v.imageRef)
    .filter((ref) => !NON_IMAGE_TARGETS.has(ref))
    .join(', ');
  const matched = `Policy "${name}" blocked ${action}: ${genuine.length} image(s) matched ${summarizeBlockReasons(genuine)} images=[${images}]`;
  if (unevaluated.length === 0) return matched;
  return `${matched}; ${unevaluated.length} image(s) could not be evaluated images=[${unevaluated.join(', ')}]`;
}

/**
 * One-line block message, shared by the thrown-error and 409-response paths so
 * they never drift.
 *
 * A block is reached two ways, and the message has to tell them apart. Either a
 * scanned image matched a risk input, or the gate could not obtain the evidence
 * it needed and the configured availability policy refused. Reporting the
 * second as "matched scan policy conditions" is false and, on the unattended
 * paths that only have this sentence (bulk deploy, the scheduler, auto-update,
 * Git sources, rollback), it is the operator's only explanation.
 *
 * The images are named in every branch. On those same unattended paths this one
 * sentence is the only account of which images were involved, so an image the
 * gate could not examine has to appear even when the block happened for another
 * reason on a sibling image.
 */
export function describePolicyBlock(
  policy: ScanPolicy | undefined,
  violations: PolicyViolation[],
  action: BlockableAction = 'deploy',
  evidence?: EvidenceGateDecision,
): string {
  const name = policy?.name ?? 'policy';
  // A genuine match is one with no `error` set; an `error` marks a violation
  // standing in for evidence the gate could not obtain.
  const genuine = violations.filter((v) => !v.error);
  // Collected before the branch, because a payload can carry both kinds and the
  // unscanned images have to be named either way. Both sources of an unproven
  // image are used here, not just the violations, so an image a rule blocked is
  // named whether or not it also produced a violation row.
  const unproven = unprovenImages(violations, evidence);
  if (genuine.length > 0) {
    return describeMatchedBlock(name, action, genuine, unproven);
  }
  // Only a rule that actually blocked makes this sentence the account of the
  // block. An application that merely allowed or warned about one image is not
  // why the deploy stopped, and citing it would name the wrong rule while
  // omitting the cause that is: an image whose policy evaluation threw produces
  // a record and a violation but no application at all, because no setting
  // governs it. That case falls through to the sentence below, which says what
  // it actually is.
  const blocking = (evidence?.applications ?? []).filter((a) => a.outcome === 'block');
  if (blocking.length > 0) {
    // The images are named here too. Before this, an evidence block on a
    // multi-image stack reported the rule and nothing else, so a scheduled
    // auto-update blocked by one failed scan could not say which image failed.
    return `Policy "${name}" blocked ${action} because required security evidence was unavailable: ${evidence?.summary}${namedImages(unproven)}`;
  }
  const unevaluated = violations
    .map((v) => v.imageRef)
    .filter((ref) => !NON_IMAGE_TARGETS.has(ref));
  return `Policy "${name}" blocked ${action}: ${violations.length} image(s) could not be evaluated${namedImages(unevaluated)}`;
}

// Bypass requires `?ignorePolicy=true` AND `req.user.role === 'admin'`. The
// `stack:deploy` permission alone is not sufficient because the `deployer`
// role has that permission for day-to-day deploys.
export function buildPolicyGateOptions(
  req: Request,
  overrides: {
    bypass?: boolean;
    actor?: string;
    /** Which image this operation will run. Defaults to the installed one. */
    imageSource?: PolicyEnforcementOptions['imageSource'];
    /** True when no person is in the loop for this operation. */
    unattended?: boolean;
  } = {},
): PolicyEnforcementOptions {
  const defaultBypass = req.query.ignorePolicy === 'true' && req.user?.role === 'admin';
  return {
    bypass: overrides.bypass ?? defaultBypass,
    actor: overrides.actor ?? req.user?.username ?? 'unknown',
    ip: (req.ip ?? req.socket.remoteAddress ?? '') as string,
    auditMethod: req.method,
    auditPath: req.originalUrl || req.url,
    ...(overrides.imageSource ? { imageSource: overrides.imageSource } : {}),
    ...(overrides.unattended === undefined ? {} : { unattended: overrides.unattended }),
    // Put the decision on the response when the gate is reached through a service
    // several calls deep; `policyEvidenceFor(res)` then reads it at the success
    // response. `req.res` is absent only for a request built outside Express.
    onAllowed: (allowed) => {
      if (req.res) req.res.locals.policyEvidence = allowed;
    },
  };
}

/**
 * Build the gate options for an unattended operation (scheduler, auto-update,
 * webhook, Git source, mesh). `unattended: true` by default because every caller
 * of this builder runs without a person present; a caller that is actually
 * attended passes `unattended: false`.
 */
export function buildSystemPolicyGateOptions(
  actor: string,
  overrides: Partial<Pick<PolicyEnforcementOptions,
    'bypass' | 'auditPath' | 'auditMethod' | 'onAllowed' | 'imageSource' | 'unattended'>> = {},
): PolicyEnforcementOptions {
  return {
    bypass: overrides.bypass ?? false,
    actor,
    auditMethod: overrides.auditMethod ?? 'POST',
    auditPath: overrides.auditPath,
    onAllowed: overrides.onAllowed,
    unattended: overrides.unattended ?? true,
    ...(overrides.imageSource ? { imageSource: overrides.imageSource } : {}),
  };
}

/**
 * Spread into the success body of a handler that called `runPolicyGate`, so the
 * caller of an operation that proceeded on incomplete evidence can see that it did.
 */
export function policyEvidenceFor(res: Response): { policyEvidence?: AllowedPolicyEvidence } {
  const policyEvidence = res.locals.policyEvidence as AllowedPolicyEvidence | undefined;
  return policyEvidence ? { policyEvidence } : {};
}

/**
 * Throws when the gate blocks. Returns what the operation was allowed on, for
 * callers that report it; the unattended ones rely on the audit row the gate
 * writes and may ignore the return value. `evaluatedCandidates` is what the
 * pull executor compares its fetched digests against.
 */
export async function assertPolicyGateAllows(
  stackName: string,
  nodeId: number,
  options: PolicyEnforcementOptions,
): Promise<{
  policyEvidence?: AllowedPolicyEvidence;
  evaluatedCandidates?: EvaluatedCandidate[];
  pullServices?: string[];
  noPullOnUp?: boolean;
}> {
  const gate = await enforcePolicyPreDeploy(stackName, nodeId, options);
  if (!gate.ok) {
    throw new Error(describePolicyBlock(gate.policy, gate.violations, 'deploy', gate.evidence));
  }
  return {
    ...allowedPolicyEvidence(gate),
    ...(gate.evaluatedCandidates ? { evaluatedCandidates: gate.evaluatedCandidates } : {}),
    ...(gate.pullServices ? { pullServices: gate.pullServices } : {}),
    ...(gate.noPullOnUp ? { noPullOnUp: true } : {}),
  };
}

/**
 * Returns true if the deploy may proceed. Returns false after sending a 409,
 * in which case the caller must return immediately. When it proceeds on
 * incomplete evidence the decision is kept on `res.locals` for
 * `policyEvidenceFor` to add to the success response, and the candidates it
 * evaluated are kept there for `pulledCandidateVerifier`.
 */
export async function runPolicyGate(
  req: Request,
  res: Response,
  stackName: string,
  nodeId: number,
  overrides: {
    imageSource?: PolicyEnforcementOptions['imageSource'];
    unattended?: boolean;
  } = {},
): Promise<boolean> {
  const gate = await enforcePolicyPreDeploy(stackName, nodeId, buildPolicyGateOptions(req, overrides));
  if (!gate.ok) {
    res.status(409).json({
      error: describePolicyBlock(gate.policy, gate.violations, 'deploy', gate.evidence),
      ...policyBlockPayload(gate.policy, gate.violations, gate.evidence),
    });
    return false;
  }
  if (gate.evaluatedCandidates) res.locals.evaluatedCandidates = gate.evaluatedCandidates;
  if (gate.pullServices) res.locals.pullServices = gate.pullServices;
  if (gate.noPullOnUp) res.locals.noPullOnUp = true;
  return true;
}

/** Thrown when the image the pull actually fetched is not the one the gate proved. */
export class PulledCandidateBlockedError extends Error {
  public constructor(public readonly gate: { policy?: ScanPolicy; violations: PolicyViolation[]; evidence?: EvidenceGateDecision }) {
    super(describePolicyBlock(gate.policy, gate.violations, 'update', gate.evidence));
    this.name = 'PulledCandidateBlockedError';
  }
}

/**
 * Confirm that the pull installed the image the gate evaluated.
 *
 * A tag can move between the gate and the pull, so the digest that was proven and
 * the digest that landed can differ. The pulled image is local by then and not
 * yet running, so it is re-evaluated as an installed image: a block throws before
 * `up`, and the previous workload is untouched. A matching digest costs one
 * inspect per ref and no scan.
 *
 * The platform child is chosen before the pull, from each service's own
 * `platform:` override rather than the node's, so the variant Compose resolves is
 * the one the gate scanned. That is the only reliable boundary: after a pull the
 * image store can hold several children of one index, and it does not record
 * which one Compose will select.
 */
export async function verifyPulledCandidates(
  stackName: string,
  nodeId: number,
  candidates: readonly EvaluatedCandidate[] | undefined,
  options: PolicyEnforcementOptions,
): Promise<void> {
  if (!candidates || candidates.length === 0) return;
  const docker = DockerController.getInstance(nodeId).getDocker();
  const moved: string[] = [];
  for (const candidate of candidates) {
    const parsed = parseImageRef(candidate.ref);
    if (!parsed) continue;
    let digests: string[] = [];
    try {
      const info = (await docker.getImage(candidate.ref).inspect()) as {
        RepoDigests?: string[];
        Id?: string;
        Identity?: unknown;
      };
      digests = selectLocalRepoDigests(
        info.RepoDigests ?? [],
        parsed,
        configIdForLocalBuild(info.Id, info.Identity),
      );
    } catch {
      // The image is not on the node after a pull that was supposed to fetch it,
      // so it certainly is not provably the one that was scanned.
      digests = [];
    }
    const expected = new Set([candidate.indexDigest.toLowerCase(), candidate.platformDigest.toLowerCase()]);
    if (!digests.some((digest) => expected.has(digest.toLowerCase()))) moved.push(candidate.ref);
  }
  if (moved.length === 0) return;
  const movedRefs = [...new Set(moved)];
  console.warn(
    '[Policy] Pulled image digest differs from the evaluated candidate for %s; re-evaluating the pulled image(s): %s',
    sanitizeForLog(stackName), sanitizeForLog(movedRefs.join(', ')),
  );
  const gate = await enforcePolicyForImageRefs(stackName, nodeId, movedRefs, {
    ...options,
    // It lives on the node now, so it is scanned as one; `pulledCandidate` keeps
    // the candidate vocabulary, so an unattended update is still held by the
    // rule that governs unattended evidence.
    imageSource: 'installed',
    pulledCandidate: true,
  });
  if (!gate.ok) throw new PulledCandidateBlockedError(gate);
}

/**
 * The post-pull verifier for the candidates one gate decision evaluated, for
 * callers that hold the decision directly rather than on a request. Returns
 * undefined when the operation pulls nothing, so a caller can pass it straight
 * through to the update executor without adding a pointless check.
 */
export function evaluatedCandidateVerifier(
  stackName: string,
  nodeId: number,
  candidates: readonly EvaluatedCandidate[] | undefined,
  options: PolicyEnforcementOptions,
): (() => Promise<void>) | undefined {
  if (!candidates || candidates.length === 0) return undefined;
  return () => verifyPulledCandidates(stackName, nodeId, candidates, options);
}

/**
 * The pull boundary a plain `up` deploy needs: the services and references to
 * pull first and the verifier to run on what landed. Undefined when the gate
 * evaluated no candidate and no pull-disabling guard is needed, so a non-pulling
 * deploy keeps its ordinary `up`. A no-pull guard without candidates covers a
 * not-yet-due interval policy and a model that would not render in compose mode.
 */
export interface DeployCandidateVerification {
  pullServices: string[];
  /**
   * Candidate refs no Compose service declares, such as an image a pre-start
   * hook references. They are pulled by ref so the boundary never refreshes an
   * unrelated service.
   */
  pullRefs: string[];
  /** Absent when the boundary exists only to keep `up` from fetching. */
  verifyPulled?: () => Promise<void>;
}

export function evaluatedDeployCandidateVerification(
  stackName: string,
  nodeId: number,
  candidates: readonly EvaluatedCandidate[] | undefined,
  options: PolicyEnforcementOptions,
  evaluatedPullServices?: readonly string[],
  noPullOnUp = false,
): DeployCandidateVerification | undefined {
  const verifyPulled = evaluatedCandidateVerifier(stackName, nodeId, candidates, options);
  if (!verifyPulled && !noPullOnUp) return undefined;
  const pullServices = [...new Set(
    evaluatedPullServices && evaluatedPullServices.length > 0
      ? evaluatedPullServices
      : (candidates ?? []).flatMap((candidate) => candidate.services ?? []),
  )];
  const pullRefs = [...new Set(
    (candidates ?? [])
      .filter((candidate) => !candidate.services || candidate.services.length === 0)
      .map((candidate) => candidate.ref),
  )];
  return { pullServices, pullRefs, ...(verifyPulled ? { verifyPulled } : {}) };
}

/**
 * The post-pull verifier for a request that already ran `runPolicyGate`.
 * `runPolicyGate` keeps the evaluated candidates on `res.locals`; this closes
 * over the same request so the re-gate honors the same bypass.
 */
export function pulledCandidateVerifier(
  req: Request,
  res: Response,
  stackName: string,
  nodeId: number,
): (() => Promise<void>) | undefined {
  const candidates = res.locals.evaluatedCandidates as EvaluatedCandidate[] | undefined;
  return evaluatedCandidateVerifier(stackName, nodeId, candidates, buildPolicyGateOptions(req));
}

/** The plain-up pull boundary for a request that already ran `runPolicyGate`. */
export function pulledDeployCandidateVerification(
  req: Request,
  res: Response,
  stackName: string,
  nodeId: number,
): DeployCandidateVerification | undefined {
  const candidates = res.locals.evaluatedCandidates as EvaluatedCandidate[] | undefined;
  const pullServices = res.locals.pullServices as string[] | undefined;
  return evaluatedDeployCandidateVerification(
    stackName, nodeId, candidates, buildPolicyGateOptions(req), pullServices,
    res.locals.noPullOnUp === true,
  );
}

/**
 * What a hub-driven unattended update should do about a remote node that
 * evaluates the installed image rather than the image an update would pull.
 *
 * Returns false when the configured Candidate not evaluated rule holds the
 * update, after dispatching the shared `scan_finding` alert. A node that cannot
 * be reached is not this function's business: the forward attempt fails on its
 * own, exactly as before.
 */
export async function remoteCandidateGateRefusal(
  nodeId: number,
  stackName: string,
  options: PolicyEnforcementOptions,
): Promise<string | null> {
  const probe = await probeRemoteCapability(nodeId, CANDIDATE_IMAGE_GATE_CAPABILITY);
  if (probe.kind !== 'unsupported') return null;
  const gate = evaluateRemoteCandidateSupport(stackName, nodeId, options);
  if (gate.ok) return null;
  // The shared sentence names the rule and the source; this clause says what the
  // unsupported state actually means for the update, because on an unattended
  // path this sentence is all the operator gets.
  const message = `${describePolicyBlock(gate.policy, gate.violations, 'update', gate.evidence)}`
    + ' This node\'s version checks the image already installed, not the image this update would pull.';
  NotificationService.getInstance().dispatchAlert(
    'warning',
    'scan_finding',
    `Update blocked for "${stackName}": ${message}`,
    { stackName, actor: 'system:policy' },
  );
  return message;
}

/**
 * The part of a policy-block 409 body the block dialog reads. Shared by the
 * deploy gate and the rollback route, so the dialog and its bypass button open
 * the same way for either refusal.
 */
export function policyBlockPayload(
  policy: ScanPolicy | undefined,
  violations: PolicyViolation[],
  evidence?: EvidenceGateDecision,
) {
  return {
    policy: policy && {
      id: policy.id,
      name: policy.name,
      maxSeverity: policy.max_severity,
      blockOnSeverity: policy.block_on_severity,
      blockOnKev: policy.block_on_kev,
      blockOnFixable: policy.block_on_fixable,
    },
    violations,
    // Why the gate lacked the evidence it needed, and which configured rule
    // turned that into the refusal. Without it the dialog can only say a scan
    // did not complete, which reads the same as a proven violation.
    ...(evidence ? { evidence } : {}),
  };
}

// Scans running right now, keyed by node and stack. The attempt row is written
// only when a scan ends, so this is the only record that one is under way.
const scansInFlight = new Map<string, number>();
const scanKey = (nodeId: number, stackName: string): string => `${nodeId}:${stackName}`;

/** True while a post-deploy scan (from a deploy or a rescan) is running for this stack on this node. */
export function isPostDeployScanRunning(nodeId: number, stackName: string): boolean {
  return (scansInFlight.get(scanKey(nodeId, stackName)) ?? 0) > 0;
}

export async function triggerPostDeployScan(
  stackName: string,
  nodeId: number,
): Promise<void> {
  const key = scanKey(nodeId, stackName);
  scansInFlight.set(key, (scansInFlight.get(key) ?? 0) + 1);
  try {
    await runPostDeployScan(stackName, nodeId);
  } finally {
    const remaining = (scansInFlight.get(key) ?? 1) - 1;
    if (remaining > 0) scansInFlight.set(key, remaining);
    else scansInFlight.delete(key);
  }
}

async function runPostDeployScan(
  stackName: string,
  nodeId: number,
): Promise<void> {
  const svc = TrivyService.getInstance();
  const db = DatabaseService.getInstance();
  if (!svc.isTrivyAvailable()) {
    db.recordStackScanAttempt(nodeId, stackName, 'skipped', 'Trivy is not available on this node');
    return;
  }
  let imageFailures = 0;
  let imageSuccesses = 0;
  try {
    const docker = DockerController.getInstance(nodeId).getDocker();
    const containers = await docker.listContainers({
      all: true,
      filters: { label: [`com.docker.compose.project=${stackName}`] },
    });
    const imageRefs = new Set<string>();
    for (const c of containers as Array<{ Image?: string }>) {
      if (c.Image && !c.Image.startsWith('sha256:')) imageRefs.add(c.Image);
    }
    if (imageRefs.size === 0) {
      db.recordStackScanAttempt(nodeId, stackName, 'skipped', 'No images to scan');
      return;
    }

    for (const imageRef of imageRefs) {
      try {
        const digest = await svc.getImageDigest(imageRef, nodeId);
        if (digest) {
          // Keyed by the image the row read too: a multi-arch ref's children
          // share the index digest, and the post-deploy scan is of the local
          // child.
          const platform = await svc.getImagePlatform(imageRef, nodeId);
          const cached = platform
            ? db.getLatestScanByDigest(digest, 'vuln', platform)
            : db.getLatestScanByDigest(digest, 'vuln');
          if (cached && Date.now() - cached.scanned_at < DIGEST_CACHE_TTL_MS) {
            imageSuccesses += 1;
            continue;
          }
        }
        const scan = await svc.runScanAndPersist(imageRef, nodeId, 'deploy', stackName);
        imageSuccesses += 1;

        if (scan.critical_count > 0 || scan.high_count > 0) {
          NotificationService.getInstance().dispatchAlert(
            scan.critical_count > 0 ? 'error' : 'warning',
            'scan_finding',
            `Vulnerability scan for ${imageRef}: ${scan.critical_count} critical, ${scan.high_count} high`,
            { stackName, actor: 'system:policy' },
          );
        }
      } catch (err) {
        imageFailures += 1;
        const message = getErrorMessage(err, 'unknown error');
        console.error(`[Security] Post-deploy scan failed for ${imageRef}:`, message);
        NotificationService.getInstance().dispatchAlert(
          'warning',
          'scan_finding',
          `Post-deploy scan failed for ${imageRef} (${stackName}): ${message}`,
          { stackName, actor: 'system:policy' },
        );
      }
    }

    if (imageFailures === 0) {
      db.recordStackScanAttempt(nodeId, stackName, 'ok', null);
    } else if (imageSuccesses === 0) {
      db.recordStackScanAttempt(nodeId, stackName, 'failed', `${imageFailures} image(s) failed to scan`);
    } else {
      db.recordStackScanAttempt(nodeId, stackName, 'partial', `${imageFailures} of ${imageFailures + imageSuccesses} image(s) failed`);
    }
  } catch (err) {
    const message = getErrorMessage(err, 'unknown error');
    console.error('[Security] triggerPostDeployScan error for %s:', sanitizeForLog(stackName), sanitizeForLog(message));
    db.recordStackScanAttempt(nodeId, stackName, 'failed', message);
  }
}
