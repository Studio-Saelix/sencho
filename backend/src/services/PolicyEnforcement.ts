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
import type { ScanPolicy, VulnSeverity, VulnerabilityScan } from './DatabaseService';
import { FleetSyncService } from './FleetSyncService';
import { NotificationService } from './NotificationService';
import { sanitizeForLog } from '../utils/safeLog';
import TrivyService from './TrivyService';
import { isSeverityAtLeast, severityRank } from '../utils/severity';
import { applySuppressions } from '../utils/suppression-filter';
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

type PreflightScan = Pick<VulnerabilityScan, 'id' | 'highest_severity' | 'critical_count' | 'high_count'>;

interface ImageSeverityEvaluation {
    /** Highest non-suppressed severity; UNKNOWN means no severity remains. */
    severity: VulnSeverity;
    criticalCount: number;
    highCount: number;
    /** CVE IDs suppressed for this image; only populated when honoring suppressions. */
    suppressedCves: string[];
}

interface SuppressionPass {
    imageRef: string;
    cves: string[];
}

/**
 * Resolve an image's effective severity for a policy decision. With
 * honorSuppressions off this returns the stored scan's raw severity and counts
 * (the historical behavior). With it on, the scan's findings are filtered
 * through the active CVE suppressions for that image and severity + counts are
 * re-derived from what remains, so an accepted CVE no longer drives a block.
 */
function evaluateImageSeverity(
    scan: PreflightScan,
    imageRef: string,
    honorSuppressions: boolean,
): ImageSeverityEvaluation {
    const raw: ImageSeverityEvaluation = {
        severity: scan.highest_severity ?? 'UNKNOWN',
        criticalCount: scan.critical_count,
        highCount: scan.high_count,
        suppressedCves: [],
    };
    if (!honorSuppressions) return raw;

    const db = DatabaseService.getInstance();
    let findings;
    let suppressions;
    try {
        findings = db.getAllVulnerabilityDetails(scan.id);
        suppressions = db.getCveSuppressions();
    } catch (err) {
        // A suppression-read failure must never drop severity. Fall back to the
        // raw scan, which still gates: an accepted CVE stays blocking rather
        // than slipping a deploy through on a transient DB error.
        console.error('[Policy] Suppression re-derivation failed for %s; gating on raw scan severity:', sanitizeForLog(imageRef), sanitizeForLog(getErrorMessage(err, 'db read failed')));
        return raw;
    }
    if (findings.length === 0) {
        // Stored aggregate says there are findings but the detail table is empty:
        // a data mismatch worth surfacing. Raw severity still gates.
        if (scan.critical_count + scan.high_count > 0) {
            console.warn('[Policy] Scan %d reports findings but has no detail rows; gating on raw scan severity', scan.id);
        }
        return raw;
    }

    const enriched = applySuppressions(findings, imageRef, suppressions);
    let severity: VulnSeverity = 'UNKNOWN';
    let criticalCount = 0;
    let highCount = 0;
    const suppressedCves = new Set<string>();
    for (const f of enriched) {
        if (f.suppressed) {
            suppressedCves.add(f.vulnerability_id);
            continue;
        }
        if (severityRank(f.severity) > severityRank(severity)) severity = f.severity;
        if (f.severity === 'CRITICAL') criticalCount++;
        else if (f.severity === 'HIGH') highCount++;
    }
    return { severity, criticalCount, highCount, suppressedCves: [...suppressedCves] };
}

/**
 * A deploy that would have been blocked on raw severity but proceeded because
 * suppressions dropped every image below the threshold is a security-relevant
 * event: record it so the suppression-driven pass is traceable in the audit log.
 */
function recordSuppressionPassAudit(
    stackName: string,
    nodeId: number,
    policy: ScanPolicy,
    passes: SuppressionPass[],
    opts: PolicyEnforcementOptions,
): void {
    const cves = [...new Set(passes.flatMap((p) => p.cves))];
    try {
        DatabaseService.getInstance().insertAuditLog({
            timestamp: Date.now(),
            username: opts.actor,
            method: opts.auditMethod ?? 'POST',
            path: opts.auditPath ?? `/api/stacks/${stackName}/deploy`,
            status_code: 200,
            node_id: nodeId,
            ip_address: opts.ip ?? '',
            summary: `policy.suppression_pass stack="${stackName}" policy="${policy.name}" images=[${passes.map((p) => p.imageRef).join(',')}] cves=[${cves.join(',')}]`,
        });
    } catch (err) {
        console.error('[Policy] Failed to record suppression-pass audit entry:', err);
    }
    console.warn(
        '[Policy] Deploy for "%s" allowed by suppressions: %d image(s) would have met %s (policy "%s")',
        sanitizeForLog(stackName), passes.length, policy.max_severity, sanitizeForLog(policy.name),
    );
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

    const honorSuppressions = db.getGlobalSettings()['deploy_block_honor_suppressions'] === '1';

    const debug = isDebugEnabled();
    if (debug) {
        console.log(
            '[Policy:debug] Evaluating "%s" against policy "%s" (max=%s, images=%d, honorSuppressions=%s)',
            sanitizeForLog(stackName), sanitizeForLog(policy.name), policy.max_severity, imageRefs.length, honorSuppressions,
        );
    }

    const violations: PolicyViolation[] = [];
    const suppressionPasses: SuppressionPass[] = [];
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
            const evaluated = evaluateImageSeverity(scan, imageRef, honorSuppressions);
            const rawSeverity = scan.highest_severity ?? 'UNKNOWN';
            if (debug) {
                console.log(
                    '[Policy:debug] %s scanned: effective=%s raw=%s vs max=%s',
                    sanitizeForLog(imageRef), evaluated.severity, rawSeverity, policy.max_severity,
                );
            }
            if (isSeverityAtLeast(evaluated.severity, policy.max_severity)) {
                violations.push({
                    imageRef,
                    severity: evaluated.severity,
                    criticalCount: evaluated.criticalCount,
                    highCount: evaluated.highCount,
                    scanId: scan.id,
                });
            } else if (
                honorSuppressions &&
                evaluated.suppressedCves.length > 0 &&
                isSeverityAtLeast(rawSeverity, policy.max_severity)
            ) {
                suppressionPasses.push({ imageRef, cves: evaluated.suppressedCves });
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
        if (suppressionPasses.length > 0) {
            recordSuppressionPassAudit(stackName, nodeId, policy, suppressionPasses, opts);
        }
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
