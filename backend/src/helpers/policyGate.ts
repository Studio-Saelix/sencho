import type { Request, Response } from 'express';
import { enforcePolicyPreDeploy, type PolicyEnforcementOptions, type PolicyViolation } from '../services/PolicyEnforcement';
import DockerController from '../services/DockerController';
import { DatabaseService } from '../services/DatabaseService';
import type { ScanPolicy } from '../services/DatabaseService';
import { NotificationService } from '../services/NotificationService';
import TrivyService, { DIGEST_CACHE_TTL_MS } from '../services/TrivyService';
import { getErrorMessage } from '../utils/errors';
import { sanitizeForLog } from '../utils/safeLog';
import { summarizeBlockReasons } from '../utils/policy-risk';
import { NODE_WIDE_EVIDENCE_TARGET, type EvidenceGateDecision } from '../services/securityEvidence';

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
  overrides: { bypass?: boolean; actor?: string } = {},
): PolicyEnforcementOptions {
  const defaultBypass = req.query.ignorePolicy === 'true' && req.user?.role === 'admin';
  return {
    bypass: overrides.bypass ?? defaultBypass,
    actor: overrides.actor ?? req.user?.username ?? 'unknown',
    ip: (req.ip ?? req.socket.remoteAddress ?? '') as string,
    auditMethod: req.method,
    auditPath: req.originalUrl || req.url,
  };
}

export function buildSystemPolicyGateOptions(
  actor: string,
  overrides: { bypass?: boolean; auditPath?: string; auditMethod?: string } = {},
): PolicyEnforcementOptions {
  return {
    bypass: overrides.bypass ?? false,
    actor,
    auditMethod: overrides.auditMethod ?? 'POST',
    auditPath: overrides.auditPath,
  };
}

export async function assertPolicyGateAllows(
  stackName: string,
  nodeId: number,
  options: PolicyEnforcementOptions,
): Promise<void> {
  const gate = await enforcePolicyPreDeploy(stackName, nodeId, options);
  if (!gate.ok) {
    throw new Error(describePolicyBlock(gate.policy, gate.violations, 'deploy', gate.evidence));
  }
}

/**
 * Returns true if the deploy may proceed. Returns false after sending a 409,
 * in which case the caller must return immediately.
 */
export async function runPolicyGate(
  req: Request,
  res: Response,
  stackName: string,
  nodeId: number,
): Promise<boolean> {
  const gate = await enforcePolicyPreDeploy(stackName, nodeId, buildPolicyGateOptions(req));
  if (!gate.ok) {
    res.status(409).json({
      error: describePolicyBlock(gate.policy, gate.violations, 'deploy', gate.evidence),
      policy: gate.policy && {
        id: gate.policy.id,
        name: gate.policy.name,
        maxSeverity: gate.policy.max_severity,
        blockOnSeverity: gate.policy.block_on_severity,
        blockOnKev: gate.policy.block_on_kev,
        blockOnFixable: gate.policy.block_on_fixable,
      },
      violations: gate.violations,
      // Why the gate lacked the evidence it needed, and which configured rule
      // turned that into the refusal. Without it the dialog can only say a scan
      // did not complete, which reads the same as a proven violation.
      ...(gate.evidence ? { evidence: gate.evidence } : {}),
    });
    return false;
  }
  return true;
}

export async function triggerPostDeployScan(
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
          const cached = db.getLatestScanByDigest(digest, 'vuln');
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
