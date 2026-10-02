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
import { sanitizeForLog } from '../utils/safeLog';
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
    policyInputs,
    type PolicyBlockReason,
    type PolicyRiskInputs,
} from '../utils/policy-risk';
import {
    classifyScanEvidence,
    classifyScannerEvidence,
    decideEvidenceGate,
    type EvidenceAvailabilityOutcome,
    type EvidenceGateDecision,
    type EvidenceRuleApplication,
    type SecurityEvidenceRecord,
    type SecurityEvidenceState,
} from './securityEvidence';
import {
    resolveSecurityEvidencePolicy,
    type SecurityEvidencePolicy,
} from './securityEvidencePolicy';

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
    /**
     * True when the deploy was allowed because no scanner could run, which is
     * distinct from "no policy matched" and from "every image was scanned and
     * clean". Set only on an allow; when the policy blocks on an unavailable
     * scanner this stays absent and `violations` carries the refusal.
     */
    trivyMissing?: boolean;
    /**
     * The evidence half of the decision: what each required source actually
     * reported, and which configured rule turned that into the outcome. Absent
     * when the gate short-circuited before any evidence was required.
     */
    evidence?: EvidenceGateDecision;
}

/**
 * Candidate (pre-acceptance) policy outcome. Unlike the deploy-time gate,
 * which deliberately fails open when the scanner is unavailable so an
 * operator is never blocked from deploying, an unresolvable scanner state
 * here is its own outcome: automatic source acceptance must not read
 * `unavailable` as `allowed`, or a GitOps source could accept a candidate
 * nothing actually proved safe.
 */
export type CandidatePolicyEvaluation = { policy?: ScanPolicy; evidence?: EvidenceGateDecision } & (
    | { status: 'allowed' }
    | { status: 'blocked'; violations: PolicyViolation[] }
    | { status: 'unavailable'; reason: string }
);

const TRIVY_MISSING_NOTIFY_COOLDOWN_MS = 60 * 60 * 1000;
// Growth bounded by configured-policy fanout (only stacks with an enabled
// block_on_deploy policy can land here), not by total stack churn. Cleared
// on process restart, which is the right scope for an informational warning.
const trivyMissingNotifiedAt = new Map<string, number>();

// Growth bounded the same way as trivyMissingNotifiedAt: by configured-policy
// fanout over distinct (node, stack, reason) triples, not by total stack churn.
const evidenceWarnedAt = new Map<string, number>();

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
    evidenceWarnedAt.clear();
}

/**
 * One warning alert per node/stack/reason per hour. Shares the trivy-missing
 * cooldown because it answers the same operator question ("this deploy went
 * through on evidence you may not trust") and the same flood risk: the gate runs
 * on every mutation path, and an unbounded notifier here would turn one
 * misconfigured threshold into an alert storm.
 */
function notifyEvidenceWarningOnce(nodeId: number, stackName: string, rule: string, detail: string): void {
    // Keyed by the rule that fired, never by the interpolated detail: a key
    // carrying an image reference or a summary sentence would grow one entry per
    // distinct string the process ever produced.
    const key = `${nodeId}:${stackName}:${rule}`;
    const now = Date.now();
    const last = evidenceWarnedAt.get(key);
    if (last !== undefined && now - last < TRIVY_MISSING_NOTIFY_COOLDOWN_MS) return;
    evidenceWarnedAt.set(key, now);
    NotificationService.getInstance().dispatchAlert(
        'warning',
        'scan_finding',
        `Pre-deploy scan for "${stackName}" proceeded on incomplete evidence: ${detail}`,
        { stackName, actor: 'system:policy' },
    );
}

/**
 * Read the instance's evidence-availability policy.
 *
 * A settings read that throws resolves to the shipped defaults rather than
 * propagating. The deploy path cannot afford an unrelated database error to
 * become a deploy failure, and the defaults are the documented operator-visible
 * behaviour, so the decision stays attributable either way.
 */
/**
 * Everything this gate reads from `global_settings`, resolved in one guarded
 * pass. Reading it twice would leave the second read outside the guard, and an
 * unrelated database error there would surface as a failed deploy rather than a
 * documented default.
 */
interface GateSettings {
    evidencePolicy: SecurityEvidencePolicy;
    honorSuppressions: boolean;
}

function loadGateSettings(): GateSettings {
    try {
        const settings = DatabaseService.getInstance().getGlobalSettings();
        return {
            evidencePolicy: resolveSecurityEvidencePolicy(settings),
            // Read in the same guarded pass. Honoring suppressions weakens a
            // deploy block, so its default is the strict one: an unreadable
            // setting must not quietly start suppressing.
            honorSuppressions: settings['deploy_block_honor_suppressions'] === '1',
        };
    } catch (err) {
        console.error(
            '[Policy] Gate settings read failed; falling back to the documented defaults:',
            getErrorMessage(err, 'settings read failed'),
        );
        return {
            evidencePolicy: resolveSecurityEvidencePolicy(null),
            honorSuppressions: false,
        };
    }
}

/** Audit-readable name for the rule that produced an outcome. */
function ruleClause(key: string, outcome: EvidenceAvailabilityOutcome): string {
    return `${key}=${outcome}`;
}

/** One synthetic violation standing in for "the evidence could not be obtained". */
function unavailableViolation(imageRef: string, message: string): PolicyViolation {
    return {
        imageRef,
        severity: 'UNKNOWN',
        criticalCount: 0,
        highCount: 0,
        kevCount: 0,
        fixableCount: 0,
        reasons: [],
        scanId: 0,
        error: message,
    };
}

/**
 * Decide what an unavailable scanner means for this deploy.
 *
 * This is the branch that used to be a bare `if` returning `ok: true`. The
 * operator-facing behaviour is unchanged at every setting value it shipped with
 * (`allow` plus an hourly warning alert); what changed is that the reason is now
 * a recorded fact rather than an accident of which `if` executed. The deploy
 * path answers `trivyMissing`, the candidate path answers `unavailable`, and
 * neither is reachable from the other.
 */
function decideScannerUnavailable(
    policy: ScanPolicy,
    evidencePolicy: SecurityEvidencePolicy,
    nodeId: number,
    stackName: string,
    opts: PolicyEnforcementOptions,
): PolicyEnforcementResult {
    const classification = classifyScannerEvidence({ available: false, collectedAt: null });
    const records: SecurityEvidenceRecord[] = [
        {
            source: 'scanner_availability',
            state: classification.state,
            target: 'node',
            collectedAt: null,
            reason: classification.reason,
        },
    ];
    const decision = decideEvidenceGate(records, [
        {
            source: 'scanner_availability',
            state: classification.state,
            outcome: evidencePolicy.scannerUnavailable,
            rule: ruleClause('security_scanner_unavailable', evidencePolicy.scannerUnavailable),
        },
    ]);

    notifyTrivyMissingOnce(nodeId, stackName);

    if (decision.outcome === 'block') {
        // Every other refusal in this evaluator honors an authorized bypass
        // before it returns, and this one has to as well: an operator who has
        // configured `block` is expressing a default, not revoking the escape
        // hatch that every other branch keeps. Without this the setting would
        // silently strand a node whose scanner is missing.
        if (opts.bypass) {
            // Audited like every other bypass. An admin proceeding past a gate
            // is the same event here as anywhere else, and the reason it was
            // needed (no scanner on this node) is exactly what an incident
            // review will want to see.
            recordBypassAudit(stackName, nodeId, policy, [], opts);
            return { ok: true, bypassed: true, policy, violations: [], trivyMissing: true, evidence: decision };
        }
        console.warn(
            '[Policy] Blocked deploy for "%s": the vulnerability scanner is unavailable and the configured policy blocks (policy "%s")',
            sanitizeForLog(stackName), sanitizeForLog(policy.name),
        );
        return {
            ok: false,
            bypassed: false,
            policy,
            violations: [unavailableViolation('(scanner unavailable)', decision.summary)],
            evidence: decision,
        };
    }

    return { ok: true, bypassed: false, policy, violations: [], trivyMissing: true, evidence: decision };
}

type PreflightScan = Pick<VulnerabilityScan, 'id' | 'highest_severity' | 'critical_count' | 'high_count' | 'total_vulnerabilities'>;

interface ImageRiskEvaluation {
    /** Policy inputs that matched for this image. */
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
     * Set when the per-finding detail rows could not be trusted, which is the
     * `partial` evidence state. Severity still gates from the aggregate counts;
     * KEV and fixability cannot be read from aggregates, so the reason is
     * recorded rather than left invisible.
     */
    partialEvidenceReason?: string;
}

interface SuppressionPass {
    imageRef: string;
    cves: string[];
}

/**
 * Aggregate-only evaluation. Two roles: the cheap fast path for a severity-only
 * policy that does not need detail rows (`failClosed=false`), and the fallback
 * when the detail rows cannot be trusted. Severity stays verifiable from the
 * stored aggregate counts, so it always gates. KEV/fixability cannot be read
 * from aggregates: when `failClosed` is set the active KEV/fixable inputs block
 * anyway, because their absence cannot be proven without the details.
 */
function aggregateFallback(
    inputs: PolicyRiskInputs,
    rawSeverity: VulnSeverity,
    scan: PreflightScan,
    failClosed: boolean,
): ImageRiskEvaluation {
    const reasons: PolicyBlockReason[] = [];
    if (inputs.blockOnSeverity && isSeverityAtLeast(rawSeverity, inputs.maxSeverity)) reasons.push('severity');
    if (failClosed && inputs.blockOnKev) reasons.push('kev');
    if (failClosed && inputs.blockOnFixable) reasons.push('fixable');
    return {
        reasons,
        severity: rawSeverity,
        criticalCount: scan.critical_count,
        highCount: scan.high_count,
        kevCount: 0,
        fixableCount: 0,
        suppressedCves: [],
        rawWouldBlock: reasons.length > 0,
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
        return { ...aggregateFallback(inputs, rawSeverity, scan, false) };
    }

    const db = DatabaseService.getInstance();
    let findings: VulnerabilityDetail[];
    let suppressions;
    try {
        findings = db.getAllVulnerabilityDetails(scan.id);
        suppressions = db.getCveSuppressions();
    } catch (err) {
        // Detail read failed: severity still gates from the aggregate, but
        // KEV/fixability are unknowable. Fail closed on them, consistent with the
        // truncated-details path below: a policy that explicitly opted into a
        // KEV/fixable gate must not silently degrade to "allow" on a transient
        // read error. The admin bypass path stays available.
        console.error('[Policy] Detail read failed for %s; gating severity on aggregate, failing closed on KEV/fixable:', sanitizeForLog(imageRef), sanitizeForLog(getErrorMessage(err, 'db read failed')));
        return {
            ...aggregateFallback(inputs, rawSeverity, scan, true),
            partialEvidenceReason: 'The scan findings could not be read, so known-exploited and fixability were treated as risky',
        };
    }

    // The stored detail rows must reproduce the scan's full finding set before
    // KEV/fixability can be trusted. A cache-hit preflight scan keeps the
    // complete aggregate counts but copies only the first N detail rows. When the
    // counts disagree, gate severity on the raw aggregate and fail closed on any
    // KEV/fixable input: absence of a known-exploited or fixable finding cannot be
    // proven from a truncated set, so the unverifiable finding is treated as risky.
    if (findings.length !== scan.total_vulnerabilities) {
        if (scan.total_vulnerabilities > 0) {
            console.warn(
                '[Policy] Scan %d detail rows (%d) do not match its total (%d); gating severity on raw scan, failing closed on KEV/fixable',
                scan.id, findings.length, scan.total_vulnerabilities,
            );
        }
        return {
            ...aggregateFallback(inputs, rawSeverity, scan, true),
            partialEvidenceReason: 'The stored findings do not cover every vulnerability in this scan, so known-exploited and fixability were treated as risky',
        };
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
 * Record an authorized bypass.
 *
 * Shared by every refusal this evaluator can return, because a bypass is the
 * same security-relevant event whichever branch refused: an admin chose to
 * proceed past a gate. Writing this inline at one branch and not another is how
 * the scanner-unavailable bypass came to leave no trace at all.
 */
function recordBypassAudit(
    stackName: string,
    nodeId: number,
    policy: ScanPolicy,
    images: string[],
    opts: PolicyEnforcementOptions,
): void {
    try {
        DatabaseService.getInstance().insertAuditLog({
            timestamp: Date.now(),
            username: opts.actor,
            method: opts.auditMethod ?? 'POST',
            path: opts.auditPath ?? `/api/stacks/${stackName}/deploy`,
            status_code: 200,
            node_id: nodeId,
            ip_address: opts.ip ?? '',
            summary: `policy.bypass stack="${stackName}" policy="${policy.name}" violations=${images.length} images=[${images.join(',')}]`,
        });
    } catch (err) {
        console.error('[Policy] Failed to record bypass audit entry:', err);
    }
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
        return decideScannerUnavailable(policy, loadGateSettings().evidencePolicy, nodeId, stackName, opts);
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
        return decideScannerUnavailable(policy, loadGateSettings().evidencePolicy, nodeId, stackName, opts);
    }

    const { evidencePolicy, honorSuppressions } = loadGateSettings();

    const debug = isDebugEnabled();
    if (debug) {
        console.log(
            '[Policy:debug] Evaluating "%s" against policy "%s" (inputs=%s, images=%d, honorSuppressions=%s)',
            sanitizeForLog(stackName), sanitizeForLog(policy.name), describePolicyInputs(policyInputs(policy)), imageRefs.length, honorSuppressions,
        );
    }

    const violations: PolicyViolation[] = [];
    const suppressionPasses: SuppressionPass[] = [];
    const evidenceRecords: SecurityEvidenceRecord[] = [];
    const evidenceApplications: EvidenceRuleApplication[] = [];
    for (const imageRef of imageRefs) {
        if (!validateImageRef(imageRef)) {
            // A reference that cannot be parsed is not an image, so the scanner
            // never gets a chance to produce an answer. Recorded as
            // `not_evaluated` so the decision record shows a gap rather than a
            // silent omission; whether it blocks stays a caller decision, not
            // this branch's.
            evidenceRecords.push({
                source: 'vulnerability_scan',
                state: 'not_evaluated',
                target: imageRef,
                collectedAt: null,
                reason: 'Not a valid image reference, so no scan was attempted',
            });
            if (failClosedInvalidRefs) {
                violations.push(unavailableViolation(imageRef, 'Invalid image reference; the image could not be scanned'));
            }
            continue;
        }
        let scan: VulnerabilityScan;
        try {
            scan = await svc.scanImagePreflight(imageRef, nodeId, stackName);
        } catch (err) {
            const message = getErrorMessage(err, 'pre-flight scan failed');
            console.error(`[Policy] scanImagePreflight failed for ${imageRef}:`, message);
            const classification = classifyScanEvidence({
                now: Date.now(),
                collectedAt: null,
                freshnessThresholdMs: null,
                failed: true,
                failureReason: `Pre-flight scan failed: ${message}`,
            });
            evidenceRecords.push({
                source: 'vulnerability_scan',
                state: classification.state,
                target: imageRef,
                collectedAt: null,
                reason: classification.reason,
            });
            const outcome = evidencePolicy.scanFailure;
            evidenceApplications.push({
                source: 'vulnerability_scan',
                state: classification.state,
                outcome,
                rule: ruleClause('security_scan_failure', outcome),
                target: imageRef,
            });
            // allow and warn both let the deploy through; warn additionally says
            // so out loud, which is the only thing distinguishing it from allow
            // at the call site. Neither is silent.
            if (outcome === 'warn') {
                notifyEvidenceWarningOnce(
                    nodeId, stackName, 'security_scan_failure',
                    `the scan of ${imageRef} did not complete`,
                );
            }
            if (outcome !== 'block') {
                continue;
            }
            violations.push(unavailableViolation(imageRef, `Pre-flight scan failed: ${message}`));
            continue;
        }

        // No freshness bound is passed. This path scans on demand (reusing a
        // cached row only inside the scanner's own cache window), so the
        // evidence it holds is fresh by construction and can never be `stale`.
        // The `stale` state and the classifier's bound exist for the paths that
        // read stored evidence without re-scanning; they arrive with the
        // cached-acceptance work.
        const scanEvidence = classifyScanEvidence({
            now: Date.now(),
            collectedAt: scan.scanned_at,
            freshnessThresholdMs: null,
        });
        evidenceRecords.push({
            source: 'vulnerability_scan',
            state: scanEvidence.state,
            target: imageRef,
            collectedAt: scan.scanned_at,
            digest: scan.image_digest ?? null,
            ...(scanEvidence.reason ? { reason: scanEvidence.reason } : {}),
        });
        try {
            const evaluated = evaluateImageRisk(scan, imageRef, policy, honorSuppressions);
            if (debug) {
                console.log(
                    '[Policy:debug] %s scanned: severity=%s kev=%d fixable=%d matched=[%s]',
                    sanitizeForLog(imageRef), evaluated.severity, evaluated.kevCount, evaluated.fixableCount, evaluated.reasons.join(','),
                );
            }
            // The same image carries two records: the scan's own freshness state
            // above, and whether its finding set was complete enough to read
            // KEV and fixability from. A clean result under partial evidence is
            // not a clean result.
            if (evaluated.partialEvidenceReason) {
                evidenceRecords.push({
                    source: 'vulnerability_scan',
                    state: 'partial',
                    target: imageRef,
                    collectedAt: scan.scanned_at,
                    digest: scan.image_digest ?? null,
                    reason: evaluated.partialEvidenceReason,
                });
                // Deliberately a record and not an application. `outcome` reports
                // what the availability POLICY decided, and the policy has no
                // setting for partial evidence: the gate fails closed on the
                // unproven inputs unconditionally, which is why this can block
                // while the outcome reads `allow`. Recording it as an
                // `allow` application would be worse, by implying a policy
                // permitted something no policy governs. Consumers explain the
                // block from the records, which carry the reason.
            }
            if (evaluated.reasons.length > 0) {
                violations.push({
                    imageRef,
                    severity: evaluated.severity,
                    criticalCount: evaluated.criticalCount,
                    highCount: evaluated.highCount,
                    kevCount: evaluated.kevCount,
                    fixableCount: evaluated.fixableCount,
                    reasons: evaluated.reasons,
                    scanId: scan.id,
                });
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
            // Recorded as evidence as well as a violation. The scan is current,
            // but the decision it was supposed to support is not, and a consumer
            // that reads only the evidence records (the candidate path does) must
            // still see this image as unproven. Without this record an evaluation
            // failure looked identical to a clean pass.
            evidenceRecords.push({
                source: 'vulnerability_scan',
                state: 'failed',
                target: imageRef,
                collectedAt: scan.scanned_at,
                digest: scan.image_digest ?? null,
                reason: `Policy evaluation failed: ${message}`,
            });
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

    // Built once, before any return below this point, so every exit carries the
    // same account of what the evidence said. A decision with no violation can
    // still have been made on `unavailable` evidence, and that is exactly the
    // case an operator cannot otherwise see.
    //
    // No notification here. Every rule that can produce `warn` already notified
    // at the point it fired, keyed by (node, stack, rule), and one event must
    // not alert twice under two different keys.
    //
    // Two earlier returns are deliberately not covered: the no-matching-policy
    // case required no evidence, and the compose-parse failure never reached the
    // point where an image could be examined (its violation carries its own
    // `(compose parse error)` explanation).
    const evidence = decideEvidenceGate(evidenceRecords, evidenceApplications);

    if (violations.length === 0) {
        if (suppressionPasses.length > 0) {
            recordSuppressionPassAudit(stackName, nodeId, policy, suppressionPasses, opts);
        }
        return { ok: true, bypassed: false, policy, violations: [], evidence };
    }

    if (opts.bypass) {
        recordBypassAudit(stackName, nodeId, policy, violations.map((v) => v.imageRef), opts);
        if (debug) {
            console.log(
                '[Policy:debug] Bypass for "%s" (%d violation(s))',
                sanitizeForLog(stackName), violations.length,
            );
        }
        return { ok: true, bypassed: true, policy, violations, evidence };
    }

    console.warn(
        '[Policy] Blocked deploy for "%s": %d image(s) matched %s (policy "%s")',
        sanitizeForLog(stackName), violations.length, describePolicyInputs(policyInputs(policy)), sanitizeForLog(policy.name),
    );
    return { ok: false, bypassed: false, policy, violations, evidence };
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

    // A violation with no `error` is a genuine scanned policy match; one with
    // `error` set is an invalid ref, a scan failure, or an evaluation failure,
    // which is evidence Sencho could not prove either way rather than a proven
    // violation. Only a genuine match is reported as `blocked`; everything else
    // is `unavailable` so it cannot read as a refusal on the merits.
    const hasGenuineViolation = result.violations.some((v) => !v.error);

    if (opts.bypass && (result.bypassed || result.trivyMissing || hasGenuineViolation)) {
        return { status: 'allowed', policy: result.policy, evidence: result.evidence };
    }
    if (hasGenuineViolation) {
        return { status: 'blocked', policy: result.policy, evidence: result.evidence, violations: result.violations };
    }

    // Anything the gate could not establish as `current` is unproven, and this
    // path applies its OWN rule to it rather than inheriting the deploy gate's.
    // That separation is the point: a setting an operator relaxes to get past a
    // scanner outage at the keyboard must not become standing authority for an
    // unattended automation to accept a candidate nothing proved safe. The
    // default holds, which is also what this path did before it was
    // configurable.
    // Unproven is read from BOTH the evidence records and the violations, not
    // from the records alone. A violation carrying `error` is by construction a
    // case the gate could not evaluate, and deriving this only from records made
    // an evaluation failure look clean: the scan itself is `current`, so nothing
    // in the records said otherwise. Two independent signals, so a future record
    // that is missed cannot silently become authority to accept.
    const unprovenTargets = new Set<string>();
    for (const r of result.evidence?.records ?? []) {
        if (r.state !== 'current') unprovenTargets.add(r.target);
    }
    for (const v of result.violations) {
        if (v.error) unprovenTargets.add(v.imageRef);
    }
    const unproven = [...unprovenTargets];
    if (unproven.length > 0) {
        const { candidateUnproven } = loadGateSettings().evidencePolicy;
        // The rule is recorded on the decision itself. An acceptance on unproven
        // evidence that left no trace of which setting permitted it would
        // contradict the whole point of resolving the rule into the record, and
        // this is the one path where "allowed" and "proven clean" look alike
        // downstream.
        const evidence = withCandidateRuleApplied(result.evidence, candidateUnproven, unproven);
        if (candidateUnproven === 'allow') {
            return { status: 'allowed', policy: result.policy, evidence };
        }
        if (candidateUnproven === 'warn') {
            notifyEvidenceWarningOnce(
                nodeId, stackName, 'security_candidate_unproven',
                `a candidate image could not be fully evaluated (${unproven.join(", ")})`,
            );
            return { status: 'allowed', policy: result.policy, evidence };
        }
        return {
            status: 'unavailable',
            policy: result.policy,
            evidence,
            reason: 'Candidate could not be fully evaluated',
        };
    }

    return { status: 'allowed', policy: result.policy, evidence: result.evidence };
}

/**
 * Attach the candidate rule to a decision that had no application of its own.
 *
 * The shared evaluator only records applications for rules it applied, and it
 * does not know about `candidateUnproven`. Without this the record for an
 * accepted-on-unproven candidate is indistinguishable from a clean one.
 */
function withCandidateRuleApplied(
    decision: EvidenceGateDecision | undefined,
    outcome: EvidenceAvailabilityOutcome,
    targets: string[],
): EvidenceGateDecision | undefined {
    if (!decision) return decision;
    // One application per unproven target, even when the evaluator already
    // recorded an application for it. Those name the deploy-gate rule that fired
    // (a scan failure, say); this one names the candidate rule that decided what
    // to do about it, and the two are different facts. The state is reused from
    // whatever already described this target, so the entry does not restate it
    // differently.
    const stateFor = (target: string): SecurityEvidenceState =>
        decision.applications.find((a) => a.target === target && a.state !== 'current')?.state ??
        decision.records.find((r) => r.target === target && r.state !== 'current')?.state ??
        'not_evaluated';
    const added: EvidenceRuleApplication[] = targets.map((target) => ({
        source: 'vulnerability_scan' as const,
        state: stateFor(target),
        outcome,
        rule: ruleClause('security_candidate_unproven', outcome),
        target,
    }));
    return {
        ...decision,
        applications: [...decision.applications, ...added],
        // The candidate's own decision, not the most restrictive of the two.
        // This object describes what happened to the candidate, and the two
        // statuses must agree: reporting `block` beside a `status: 'allowed'`
        // would say the candidate was both held and accepted. The deploy-gate
        // rules remain visible per application, which is where they belong.
        outcome,
    };
}
