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
import type { ScanPolicy, VulnSeverity, VulnerabilityScan, VulnerabilityDetail } from './DatabaseService';
import { FleetSyncService } from './FleetSyncService';
import { NotificationService } from './NotificationService';
import { redactSensitiveText, sanitizeForLog } from '../utils/safeLog';
import TrivyService from './TrivyService';
import { isSeverityAtLeast } from '../utils/severity';
import { applySuppressions } from '../utils/suppression-filter';
import { validateImageRef } from '../utils/image-ref';
import { getErrorMessage } from '../utils/errors';
import { isDebugEnabled } from '../utils/debug';
import type { RollbackInvocationRecord } from '../types/rollbackGeneration';
import {
    evaluatePolicyRisk,
    describePolicyInputs,
    describeReason,
    policyInputs,
    type PolicyBlockReason,
    type PolicyRiskInputs,
} from '../utils/policy-risk';

export interface PolicyViolation {
    imageRef: string;
    severity: VulnSeverity;
    criticalCount: number;
    highCount: number;
    /** Non-suppressed CVEs in the CISA known-exploited (KEV) set on this image. */
    kevCount: number;
    /** Non-suppressed Critical/High findings with a fix available on this image. */
    fixableCount: number;
    /** Which policy inputs matched (empty when the image could not be scanned). */
    reasons: PolicyBlockReason[];
    scanId: number;
    /**
     * Why the block is unactionable by policy: set when the gate blocked because
     * the image could not be scanned or evaluated (compose parse error, scan
     * failure, evaluation error), not because a policy input matched. Absent for
     * a normal policy match. Lets the UI explain the failure instead of showing a
     * zero-count block with no reason.
     */
    error?: string;
}

export interface PolicyEnforcementOptions {
    bypass: boolean;
    actor: string;
    ip?: string;
    /** HTTP method of the originating request; used for audit attribution. */
    auditMethod?: string;
    /** Request path of the originating route; used for audit attribution. */
    auditPath?: string;
    /**
     * Rollback compensation: list images via this captured Compose invocation
     * instead of the live database-derived args.
     */
    composeInvocation?: RollbackInvocationRecord | null;
}

export interface PolicyEnforcementResult {
    ok: boolean;
    bypassed: boolean;
    policy?: ScanPolicy;
    violations: PolicyViolation[];
    trivyMissing?: boolean;
}

/**
 * Candidate (pre-acceptance) policy outcome. Unlike the deploy-time gate,
 * which deliberately fails open when the scanner is unavailable so an
 * operator is never blocked from deploying, an unresolvable scanner state
 * here is its own outcome: automatic source acceptance must not read
 * `unavailable` as `allowed`, or a GitOps source could accept a candidate
 * nothing actually proved safe.
 */
export type CandidatePolicyEvaluation = { policy?: ScanPolicy } & (
    | { status: 'allowed' }
    | { status: 'blocked'; violations: PolicyViolation[] }
    | { status: 'unavailable'; reason: string }
);

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

type PreflightScan = Pick<VulnerabilityScan, 'id' | 'highest_severity' | 'critical_count' | 'high_count' | 'total_vulnerabilities'>;

interface ImageRiskEvaluation {
    /** Policy inputs that matched for this image, including any KEV/fixable inputs assumed (see `unverified`). */
    reasons: PolicyBlockReason[];
    /** Highest non-suppressed severity; UNKNOWN means no severity remains. */
    severity: VulnSeverity;
    criticalCount: number;
    highCount: number;
    kevCount: number;
    fixableCount: number;
    /** CVE IDs suppressed for this image; only populated when honoring suppressions. */
    suppressedCves: string[];
    /** True when the same inputs would have matched if suppressions were ignored. */
    rawWouldBlock: boolean;
    /**
     * Log-only: the reasons in `reasons` that were not established on verified
     * evidence, and why. KEV/fixable are assumed because the detail rows could
     * not be trusted. `severity` is listed only when suppressions are honored:
     * it matched on the raw aggregate, and suppressions, which might lift it,
     * could not be applied without the rows. Never reaches the API: the
     * violation keeps the plain `reasons`.
     */
    unverified?: { reasons: PolicyBlockReason[]; cause: string };
}

/** Why `aggregateFallback` could not rely on the stored evidence: KEV/fixability, and suppressions when honored. */
const EVIDENCE_READ_FAILED = 'stored scan evidence could not be read';
const detailRowsTruncated = (stored: number, total: number): string =>
    `stored detail rows (${stored}) do not match the scan total (${total})`;

/**
 * What one image's unverified-evidence entry says. KEV/fixable read "not
 * verified, <cause>"; a severity match made while honored suppressions could not
 * be applied reads "matched before suppressions could be applied"; a severity
 * match on verified evidence reads "matched". Parts are joined with "; ", and
 * the cause follows the first part that names an unverified input:
 * `<kev/fixable> not verified, <cause>[; <severity part>]` or
 * `<severity> matched before suppressions could be applied, <cause>`.
 */
function describeUnverified(
    violation: PolicyViolation,
    { reasons: unverified, cause }: NonNullable<ImageRiskEvaluation['unverified']>,
): string {
    const assumed = unverified.filter((r) => r !== 'severity');
    const parts: string[] = [];
    if (assumed.length > 0) parts.push(`${assumed.map(describeReason).join(', ')} not verified, ${cause}`);
    if (unverified.includes('severity')) {
        parts.push(`${describeReason('severity')} matched before suppressions could be applied${assumed.length > 0 ? '' : `, ${cause}`}`);
    } else if (violation.reasons.includes('severity')) {
        parts.push(`${describeReason('severity')} matched`);
    }
    return parts.join('; ');
}

interface SuppressionPass {
    imageRef: string;
    cves: string[];
}

/**
 * Aggregate-only evaluation. Two roles: the cheap fast path for a severity-only
 * policy that does not need detail rows (`failClosedCause=null`), and the fallback
 * when the detail rows cannot be trusted. The raw severity always gates, because
 * the stored aggregate counts still give it. KEV/fixability cannot be read from
 * aggregates: when `failClosedCause` is set the active KEV/fixable inputs block
 * anyway, because their absence cannot be proven without the details. When
 * suppressions are honored they cannot be applied without the rows either, so
 * the post-suppression severity is unknown and a raw severity match is recorded
 * as unverified. The cause is carried in `unverified` so the block log can name
 * it.
 */
function aggregateFallback(
    inputs: PolicyRiskInputs,
    rawSeverity: VulnSeverity,
    scan: PreflightScan,
    failClosedCause: string | null,
    honorSuppressions: boolean,
): ImageRiskEvaluation {
    const reasons: PolicyBlockReason[] = [];
    const unverified: PolicyBlockReason[] = [];
    if (inputs.blockOnSeverity && isSeverityAtLeast(rawSeverity, inputs.maxSeverity)) {
        reasons.push('severity');
        if (failClosedCause && honorSuppressions) unverified.push('severity');
    }
    if (failClosedCause && inputs.blockOnKev) unverified.push('kev');
    if (failClosedCause && inputs.blockOnFixable) unverified.push('fixable');
    reasons.push(...unverified.filter((r) => r !== 'severity'));
    return {
        reasons,
        severity: rawSeverity,
        criticalCount: scan.critical_count,
        highCount: scan.high_count,
        kevCount: 0,
        fixableCount: 0,
        suppressedCves: [],
        rawWouldBlock: reasons.length > 0,
        ...(failClosedCause && unverified.length > 0 ? { unverified: { reasons: unverified, cause: failClosedCause } } : {}),
    };
}

/**
 * Resolve which of a policy's risk inputs (severity, KEV, fixability) an image
 * matches. A severity-only policy that is not honoring suppressions keeps the
 * cheap aggregate path (historical behavior). Any KEV/fixable input, or honoring
 * suppressions, requires the per-finding detail rows: KEV/fixability cannot be
 * read from the aggregate counts, so the details are loaded regardless of the
 * honor flag. KEV/fixable are evaluated over the non-suppressed set only.
 */
function evaluateImageRisk(
    scan: PreflightScan,
    imageRef: string,
    policy: ScanPolicy,
    honorSuppressions: boolean,
): ImageRiskEvaluation {
    const inputs = policyInputs(policy);
    const rawSeverity = scan.highest_severity ?? 'UNKNOWN';
    const needsDetails = inputs.blockOnKev || inputs.blockOnFixable || honorSuppressions;
    if (!needsDetails) {
        return aggregateFallback(inputs, rawSeverity, scan, null, false);
    }

    const db = DatabaseService.getInstance();
    let findings: VulnerabilityDetail[];
    let suppressions;
    try {
        findings = db.getAllVulnerabilityDetails(scan.id);
        suppressions = db.getCveSuppressions();
    } catch (err) {
        // Detail read failed: severity still gates from the aggregate (without
        // applying suppressions), but KEV/fixability are unknowable. Fail closed
        // on them, consistent with the truncated-details path below: a policy
        // that explicitly opted into a KEV/fixable gate must not silently degrade
        // to "allow" on a transient read error. The admin bypass path stays
        // available.
        console.error('[Policy] Detail read failed for %s; gating severity on aggregate, failing closed on KEV/fixable:', sanitizeForLog(imageRef), sanitizeForLog(getErrorMessage(err, 'db read failed')));
        return aggregateFallback(inputs, rawSeverity, scan, EVIDENCE_READ_FAILED, honorSuppressions);
    }

    // The stored detail rows must reproduce the scan's full finding set before
    // KEV/fixability can be trusted. A cache-hit preflight scan keeps the
    // complete aggregate counts but copies only the first N detail rows. When the
    // counts disagree, gate severity on the raw aggregate (suppressions cannot be
    // applied to a partial set) and fail closed on any KEV/fixable input: absence
    // of a known-exploited or fixable finding cannot be proven from a truncated
    // set, so the unverifiable finding is treated as risky.
    if (findings.length !== scan.total_vulnerabilities) {
        if (scan.total_vulnerabilities > 0) {
            console.warn(
                '[Policy] Scan %d detail rows (%d) do not match its total (%d); gating severity on raw scan, failing closed on KEV/fixable',
                scan.id, findings.length, scan.total_vulnerabilities,
            );
        }
        return aggregateFallback(inputs, rawSeverity, scan, detailRowsTruncated(findings.length, scan.total_vulnerabilities), honorSuppressions);
    }

    // KEV membership is the same for the full set and the non-suppressed subset,
    // so resolve intel once over every CVE and reuse it for both the effective
    // decision and the suppression-pass check below.
    const intel = inputs.blockOnKev ? db.getCveIntel(findings.map((f) => f.vulnerability_id)) : null;
    const isKev = (cveId: string): boolean => intel?.get(cveId)?.kev === true;

    const suppressedCves = new Set<string>();
    let evalSet: VulnerabilityDetail[];
    if (honorSuppressions) {
        evalSet = [];
        for (const f of applySuppressions(findings, imageRef, suppressions)) {
            if (f.suppressed) { suppressedCves.add(f.vulnerability_id); continue; }
            evalSet.push(f);
        }
    } else {
        evalSet = findings;
    }

    const outcome = evaluatePolicyRisk(evalSet, isKev, inputs);
    // When honoring suppressions, "would have blocked on the raw set" detects a
    // pass that only succeeded because an accepted CVE was filtered out.
    const rawWouldBlock = honorSuppressions
        ? evaluatePolicyRisk(findings, isKev, inputs).reasons.length > 0
        : outcome.reasons.length > 0;
    return {
        reasons: outcome.reasons,
        severity: outcome.highestSeverity,
        criticalCount: outcome.criticalCount,
        highCount: outcome.highCount,
        kevCount: outcome.kevCount,
        fixableCount: outcome.fixableCount,
        suppressedCves: [...suppressedCves],
        rawWouldBlock,
    };
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
        '[Policy] Deploy for "%s" allowed by suppressions: %d image(s) would have matched %s (policy "%s")',
        sanitizeForLog(stackName), passes.length, describePolicyInputs(policyInputs(policy)), sanitizeForLog(policy.name),
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

    const svc = TrivyService.getInstance();
    if (!svc.isTrivyAvailable()) {
        notifyTrivyMissingOnce(nodeId, stackName);
        return { ok: true, bypassed: false, policy, violations: [], trivyMissing: true };
    }

    let imageRefs: string[] = [];
    try {
        imageRefs = await ComposeService.getInstance(nodeId).listStackImages(
            stackName,
            opts.composeInvocation ?? null,
        );
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
                kevCount: 0,
                fixableCount: 0,
                reasons: [],
                scanId: 0,
                error: `Compose file could not be parsed: ${message}`,
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
            '[Policy:debug] Evaluating "%s" against policy "%s" (inputs=%s, images=%d, honorSuppressions=%s)',
            sanitizeForLog(stackName), sanitizeForLog(policy.name), describePolicyInputs(policyInputs(policy)), imageRefs.length, honorSuppressions,
        );
    }

    const violations: PolicyViolation[] = [];
    // Log-only side table: violations with unverified evidence (KEV/fixable
    // reasons assumed, or a severity match that honored suppressions could not
    // be applied to), kept off PolicyViolation so the API and the user-facing
    // block messages are unchanged.
    const unverifiedByViolation = new Map<PolicyViolation, NonNullable<ImageRiskEvaluation['unverified']>>();
    const suppressionPasses: SuppressionPass[] = [];
    for (const imageRef of imageRefs) {
        if (!validateImageRef(imageRef)) {
            if (failClosedInvalidRefs) {
                violations.push({
                    imageRef,
                    severity: 'UNKNOWN',
                    criticalCount: 0,
                    highCount: 0,
                    kevCount: 0,
                    fixableCount: 0,
                    reasons: [],
                    scanId: 0,
                    error: 'Invalid image reference; the image could not be scanned',
                });
            }
            continue;
        }
        let scan: VulnerabilityScan;
        try {
            scan = await svc.scanImagePreflight(imageRef, nodeId, stackName);
        } catch (err) {
            const message = getErrorMessage(err, 'pre-flight scan failed');
            console.error(`[Policy] scanImagePreflight failed for ${imageRef}:`, message);
            violations.push({
                imageRef,
                severity: 'UNKNOWN',
                criticalCount: 0,
                highCount: 0,
                kevCount: 0,
                fixableCount: 0,
                reasons: [],
                scanId: 0,
                error: `Pre-flight scan failed: ${message}`,
            });
            continue;
        }

        try {
            const evaluated = evaluateImageRisk(scan, imageRef, policy, honorSuppressions);
            if (debug) {
                console.log(
                    '[Policy:debug] %s scanned: severity=%s kev=%d fixable=%d matched=[%s] unverified=[%s]',
                    sanitizeForLog(imageRef), evaluated.severity, evaluated.kevCount, evaluated.fixableCount,
                    evaluated.reasons.filter((r) => !evaluated.unverified?.reasons.includes(r)).join(','),
                    evaluated.unverified?.reasons.join(',') ?? '',
                );
            }
            if (evaluated.reasons.length > 0) {
                const violation: PolicyViolation = {
                    imageRef,
                    severity: evaluated.severity,
                    criticalCount: evaluated.criticalCount,
                    highCount: evaluated.highCount,
                    kevCount: evaluated.kevCount,
                    fixableCount: evaluated.fixableCount,
                    reasons: evaluated.reasons,
                    scanId: scan.id,
                };
                violations.push(violation);
                if (evaluated.unverified) unverifiedByViolation.set(violation, evaluated.unverified);
            } else if (
                honorSuppressions &&
                evaluated.suppressedCves.length > 0 &&
                evaluated.rawWouldBlock
            ) {
                suppressionPasses.push({ imageRef, cves: evaluated.suppressedCves });
            }
        } catch (err) {
            const message = getErrorMessage(err, 'policy evaluation failed');
            console.error(`[Policy] policy evaluation failed for ${imageRef}:`, message);
            violations.push({
                imageRef,
                severity: 'UNKNOWN',
                criticalCount: 0,
                highCount: 0,
                kevCount: 0,
                fixableCount: 0,
                reasons: [],
                // The scan completed; only evaluation failed, so the real scan
                // id is kept (the other failure sites have no scan and use 0).
                scanId: scan.id,
                error: `Policy evaluation failed: ${message}`,
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
                '[Policy:debug] Bypass for "%s" (%d violation(s))',
                sanitizeForLog(stackName), violations.length,
            );
        }
        return { ok: true, bypassed: true, policy, violations };
    }

    // Three causes, each logged as what it is. `error`: the image could not be
    // scanned or evaluated. `unverified`: KEV/fixable reasons were assumed, or a
    // severity match could not be checked against honored suppressions, because
    // the detail rows could not be trusted (any other severity match on the same
    // image is named too). Everything else matched a policy input.
    const unevaluated = violations.filter((v) => v.error);
    const unverified = violations.filter((v) => !v.error && unverifiedByViolation.has(v));
    const matched = violations.filter((v) => !v.error && !unverifiedByViolation.has(v));
    if (matched.length > 0) {
        console.warn(
            '[Policy] Blocked deploy for "%s": %d image(s) matched %s (policy "%s")',
            sanitizeForLog(stackName), matched.length, describePolicyInputs(policyInputs(policy)), sanitizeForLog(policy.name),
        );
    }
    if (unverified.length > 0) {
        console.warn(
            '[Policy] Blocked deploy for "%s": %d image(s) had evidence that could not be verified (policy "%s"): %s',
            sanitizeForLog(stackName), unverified.length, sanitizeForLog(policy.name),
            unverified.map((v) => sanitizeForLog(redactSensitiveText(
                `${v.imageRef}: ${describeUnverified(v, unverifiedByViolation.get(v)!)}`,
            ))).join('; '),
        );
    }
    if (unevaluated.length > 0) {
        console.warn(
            '[Policy] Blocked deploy for "%s": %d image(s) could not be evaluated (policy "%s"): %s',
            sanitizeForLog(stackName), unevaluated.length, sanitizeForLog(policy.name),
            unevaluated.map((v) => sanitizeForLog(redactSensitiveText(`${v.imageRef}: ${v.error}`))).join('; '),
        );
    }
    return { ok: false, bypassed: false, policy, violations };
}

/**
 * Tri-state candidate evaluation for GitOps source acceptance, built on the
 * same evaluator the deploy-time gate uses, with the candidate's own image
 * refs supplied directly rather than read from disk. Has side effects:
 * writes a policy.bypass/policy.suppression_pass audit row when applicable,
 * and may dispatch the once-per-hour Trivy-missing operator notification.
 */
export async function evaluateCandidatePolicy(
    stackName: string,
    nodeId: number,
    imageRefs: string[],
    opts: PolicyEnforcementOptions,
): Promise<CandidatePolicyEvaluation> {
    const result = await enforcePolicyForImageRefs(stackName, nodeId, imageRefs, {
        ...opts,
        // Undefaulted, these attribute the audit row to a deploy path
        // (enforcePolicyForImageRefs's own default), which never happened
        // for a pre-acceptance candidate.
        auditMethod: opts.auditMethod ?? 'POST',
        auditPath: opts.auditPath ?? `/api/stacks/${stackName}/git-source/candidate`,
        // The deploy gate silently skips an unscannable ref (fail-open,
        // since it must never block an operator's deploy on its own
        // inability to evaluate). Candidate evaluation is the opposite: an
        // unscannable ref must surface as evidence, not vanish, so it can be
        // told apart from a genuinely clean scan below.
    }, undefined, true);
    // Only trivyMissing forgoes bypass consideration below it because it is
    // the one path that returns bypassed: false unconditionally; every other
    // branch of the shared evaluator already honors opts.bypass itself.
    if (result.trivyMissing) {
        if (opts.bypass) return { status: 'allowed', policy: result.policy };
        return { status: 'unavailable', policy: result.policy, reason: 'Vulnerability scanner is unavailable' };
    }
    if (!result.ok) {
        // A violation with no `error` is a genuine scanned policy match; one
        // with `error` set is an invalid ref, a scan failure, or an
        // evaluation failure -- evidence Sencho could not prove either way,
        // not a proven violation. All-unproven must not read as `blocked`.
        const hasGenuineViolation = result.violations.some((v) => !v.error);
        if (!hasGenuineViolation) {
            return { status: 'unavailable', policy: result.policy, reason: 'Candidate could not be fully evaluated' };
        }
        return { status: 'blocked', policy: result.policy, violations: result.violations };
    }
    return { status: 'allowed', policy: result.policy };
}
