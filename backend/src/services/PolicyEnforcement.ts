/**
 * Pre-deploy policy gate.
 *
 * Extracted from `index.ts` so route handlers and the scheduler can call a
 * single, unit-testable function rather than copy-paste the gate logic.
 *
 * The gate fails open when Trivy is missing (users are never locked out by
 * tooling state) and fails closed when the compose file cannot be parsed
 * (a broken stack must not silently bypass a block policy).
 */
import { ComposeService } from './ComposeService';
import { DatabaseService } from './DatabaseService';
import type { ScanPolicy, VulnSeverity } from './DatabaseService';
import { FleetSyncService } from './FleetSyncService';
import { NotificationService } from './NotificationService';
import { sanitizeForLog } from '../utils/safeLog';
import TrivyService from './TrivyService';
import { isSeverityAtLeast } from '../utils/severity';
import { validateImageRef } from '../utils/image-ref';
import { getErrorMessage } from '../utils/errors';
import { isDebugEnabled } from '../utils/debug';

export interface PolicyViolation {
    imageRef: string;
    severity: VulnSeverity;
    criticalCount: number;
    highCount: number;
    scanId: number;
}

export interface PolicyEnforcementOptions {
    bypass: boolean;
    actor: string;
    /**
     * Paid-tier deploy enforcement switch. Community keeps policies as
     * evaluation-only and must not block compose starts.
     */
    blockingEnabled?: boolean;
    ip?: string;
    /** HTTP method of the originating request; used for audit attribution. */
    auditMethod?: string;
    /** Request path of the originating route; used for audit attribution. */
    auditPath?: string;
}

export interface PolicyEnforcementResult {
    ok: boolean;
    bypassed: boolean;
    policy?: ScanPolicy;
    violations: PolicyViolation[];
    trivyMissing?: boolean;
}

const TRIVY_MISSING_NOTIFY_COOLDOWN_MS = 60 * 60 * 1000;
// Growth bounded by configured-policy fanout (only stacks with an enabled
// block_on_deploy policy can land here), not by total stack churn. Cleared
// on process restart, which is the right scope for an informational warning.
const trivyMissingNotifiedAt = new Map<string, number>();

function notifyTrivyMissingOnce(nodeId: number, stackName: string): void {
    const key = `${nodeId}:${stackName}`;
    const now = Date.now();
    const last = trivyMissingNotifiedAt.get(key);
    if (last !== undefined && now - last < TRIVY_MISSING_NOTIFY_COOLDOWN_MS) return;
    trivyMissingNotifiedAt.set(key, now);
    NotificationService.getInstance().dispatchAlert(
        'warning',
        'scan_finding',
        `Pre-deploy scan for "${stackName}" skipped: Trivy not installed on this node`,
        { stackName, actor: 'system:policy' },
    );
}

export function _resetTrivyMissingNotificationStateForTests(): void {
    trivyMissingNotifiedAt.clear();
}

export async function enforcePolicyPreDeploy(
    stackName: string,
    nodeId: number,
    opts: PolicyEnforcementOptions,
): Promise<PolicyEnforcementResult> {
    const db = DatabaseService.getInstance();
    const policy = db.getMatchingPolicy(nodeId, stackName, FleetSyncService.getSelfIdentity());

    if (!policy || !policy.enabled || !policy.block_on_deploy) {
        return { ok: true, bypassed: false, policy: policy ?? undefined, violations: [] };
    }

    if (opts.blockingEnabled === false) {
        return { ok: true, bypassed: false, policy, violations: [] };
    }

    const svc = TrivyService.getInstance();
    if (!svc.isTrivyAvailable()) {
        notifyTrivyMissingOnce(nodeId, stackName);
        return { ok: true, bypassed: false, policy, violations: [], trivyMissing: true };
    }

    let imageRefs: string[] = [];
    try {
        imageRefs = await ComposeService.getInstance(nodeId).listStackImages(stackName);
    } catch (err) {
        const message = getErrorMessage(err, 'compose parse failed');
        console.error('[Policy] listStackImages failed for %s:', sanitizeForLog(stackName), sanitizeForLog(message));
        return {
            ok: false,
            bypassed: false,
            policy,
            violations: [{
                imageRef: '(compose parse error)',
                severity: 'UNKNOWN',
                criticalCount: 0,
                highCount: 0,
                scanId: 0,
            }],
        };
    }

    return enforcePolicyForImageRefs(stackName, nodeId, imageRefs, opts, policy);
}

export async function enforcePolicyForImageRefs(
    stackName: string,
    nodeId: number,
    imageRefs: string[],
    opts: PolicyEnforcementOptions,
    matchedPolicy?: ScanPolicy,
    failClosedInvalidRefs = false,
): Promise<PolicyEnforcementResult> {
    const db = DatabaseService.getInstance();
    const policy = matchedPolicy ?? db.getMatchingPolicy(nodeId, stackName, FleetSyncService.getSelfIdentity());

    if (!policy || !policy.enabled || !policy.block_on_deploy) {
        return { ok: true, bypassed: false, policy: policy ?? undefined, violations: [] };
    }

    const svc = TrivyService.getInstance();
    if (!svc.isTrivyAvailable()) {
        notifyTrivyMissingOnce(nodeId, stackName);
        return { ok: true, bypassed: false, policy, violations: [], trivyMissing: true };
    }

    const debug = isDebugEnabled();
    if (debug) {
        console.log(
            '[Policy:debug] Evaluating "%s" against policy "%s" (max=%s, images=%d)',
            sanitizeForLog(stackName), sanitizeForLog(policy.name), policy.max_severity, imageRefs.length,
        );
    }

    const violations: PolicyViolation[] = [];
    for (const imageRef of imageRefs) {
        if (!validateImageRef(imageRef)) {
            if (failClosedInvalidRefs) {
                violations.push({
                    imageRef,
                    severity: 'UNKNOWN',
                    criticalCount: 0,
                    highCount: 0,
                    scanId: 0,
                });
            }
            continue;
        }
        try {
            const scan = await svc.scanImagePreflight(imageRef, nodeId, stackName);
            const severity = scan.highest_severity ?? 'UNKNOWN';
            if (debug) {
                console.log(
                    '[Policy:debug] %s scanned: highest=%s vs max=%s',
                    sanitizeForLog(imageRef), severity, policy.max_severity,
                );
            }
            if (isSeverityAtLeast(severity, policy.max_severity)) {
                violations.push({
                    imageRef,
                    severity,
                    criticalCount: scan.critical_count,
                    highCount: scan.high_count,
                    scanId: scan.id,
                });
            }
        } catch (err) {
            const message = getErrorMessage(err, 'pre-flight scan failed');
            console.error(`[Policy] scanImagePreflight failed for ${imageRef}:`, message);
            violations.push({
                imageRef,
                severity: 'UNKNOWN',
                criticalCount: 0,
                highCount: 0,
                scanId: 0,
            });
        }
    }

    if (violations.length === 0) {
        return { ok: true, bypassed: false, policy, violations: [] };
    }

    if (opts.bypass) {
        try {
            db.insertAuditLog({
                timestamp: Date.now(),
                username: opts.actor,
                method: opts.auditMethod ?? 'POST',
                path: opts.auditPath ?? `/api/stacks/${stackName}/deploy`,
                status_code: 200,
                node_id: nodeId,
                ip_address: opts.ip ?? '',
                summary: `policy.bypass stack="${stackName}" policy="${policy.name}" violations=${violations.length} images=[${violations.map((v) => v.imageRef).join(',')}]`,
            });
        } catch (err) {
            console.error('[Policy] Failed to record bypass audit entry:', err);
        }
        if (debug) {
            console.log(
                '[Policy:debug] Bypass by "%s" for "%s" (%d violation(s))',
                sanitizeForLog(opts.actor), sanitizeForLog(stackName), violations.length,
            );
        }
        return { ok: true, bypassed: true, policy, violations };
    }

    console.warn(
        '[Policy] Blocked deploy for "%s": %d image(s) exceed %s (policy "%s")',
        sanitizeForLog(stackName), violations.length, policy.max_severity, sanitizeForLog(policy.name),
    );
    return { ok: false, bypassed: false, policy, violations };
}
