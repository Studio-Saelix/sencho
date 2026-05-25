import type { Request, Response } from 'express';
import { enforcePolicyPreDeploy, type PolicyEnforcementOptions } from '../services/PolicyEnforcement';
import DockerController from '../services/DockerController';
import { DatabaseService } from '../services/DatabaseService';
import { NotificationService } from '../services/NotificationService';
import TrivyService, { DIGEST_CACHE_TTL_MS } from '../services/TrivyService';
import { LicenseService } from '../services/LicenseService';
import { effectiveTier } from '../middleware/tierGates';
import { getErrorMessage } from '../utils/errors';
import { sanitizeForLog } from '../utils/safeLog';

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
    blockingEnabled: effectiveTier(req) === 'paid',
    ip: (req.ip ?? req.socket.remoteAddress ?? '') as string,
    auditMethod: req.method,
    auditPath: req.originalUrl || req.url,
  };
}

export function buildSystemPolicyGateOptions(
  actor: string,
  overrides: { bypass?: boolean; blockingEnabled?: boolean; auditPath?: string; auditMethod?: string } = {},
): PolicyEnforcementOptions {
  return {
    bypass: overrides.bypass ?? false,
    actor,
    blockingEnabled: overrides.blockingEnabled ?? LicenseService.getInstance().getTier() === 'paid',
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
    throw new Error(`Policy "${gate.policy?.name}" blocked deploy: ${gate.violations.length} image(s) exceed ${gate.policy?.max_severity}`);
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
      error: `Policy "${gate.policy?.name}" blocked deploy: ${gate.violations.length} image(s) exceed ${gate.policy?.max_severity}`,
      policy: gate.policy && {
        id: gate.policy.id,
        name: gate.policy.name,
        maxSeverity: gate.policy.max_severity,
      },
      violations: gate.violations,
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
