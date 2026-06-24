/**
 * Pure risk-decision helper shared by the pre-deploy gate
 * (`PolicyEnforcement.evaluateImageRisk`) and the informational post-scan
 * evaluation (`DatabaseService.evaluateScanAgainstPolicies`). Keeping the match
 * logic in one place means the two surfaces score an identical finding set the
 * same way.
 *
 * It reports positive matches only. Callers own the finding set they pass in:
 * the gate filters suppressions and applies the incomplete-details fail-closed
 * rule, while the banner is best-effort (raw findings, no fail-closed), so the
 * two can still differ when suppressions or a truncated scan are involved. KEV
 * membership is supplied by the caller as a predicate.
 */
import type { ScanPolicy, VulnSeverity } from '../services/DatabaseService';
import { isSeverityAtLeast, severityRank } from './severity';

export type PolicyBlockReason = 'severity' | 'kev' | 'fixable';

/** The three risk inputs a policy can gate on. */
export interface PolicyRiskInputs {
    blockOnSeverity: boolean;
    blockOnKev: boolean;
    blockOnFixable: boolean;
    maxSeverity: VulnSeverity;
}

/** Project a stored policy row's 0/1 risk columns into the decision inputs. */
export function policyInputs(policy: ScanPolicy): PolicyRiskInputs {
    return {
        blockOnSeverity: policy.block_on_severity === 1,
        blockOnKev: policy.block_on_kev === 1,
        blockOnFixable: policy.block_on_fixable === 1,
        maxSeverity: policy.max_severity,
    };
}

/**
 * True when a policy would block on deploy but no risk input is active, which
 * would persist as a silent no-op gate. Inputs are 0/1 flags already resolved by
 * the caller (route coercion, merged update, or replication defaults).
 */
export function isNoOpBlockingPolicy(
    blockOnDeploy: number,
    blockOnSeverity: number,
    blockOnKev: number,
    blockOnFixable: number,
): boolean {
    return blockOnDeploy === 1 && blockOnSeverity === 0 && blockOnKev === 0 && blockOnFixable === 0;
}

/** Minimal finding shape the risk evaluation needs. */
export interface RiskFinding {
    vulnerability_id: string;
    severity: VulnSeverity;
    fixed_version: string | null;
}

export interface PolicyRiskOutcome {
    /** Inputs that matched, in display order (severity, kev, fixable). */
    reasons: PolicyBlockReason[];
    highestSeverity: VulnSeverity;
    criticalCount: number;
    highCount: number;
    kevCount: number;
    fixableCount: number;
}

/**
 * Evaluate a set of non-suppressed findings against a policy's risk inputs.
 * Severity uses the highest finding severity; KEV uses the supplied membership
 * test; a finding is "fixable" when it is Critical/High and carries a fixed
 * version (mirrors the overview's `fixableCriticalHigh` semantics).
 */
export function evaluatePolicyRisk(
    findings: RiskFinding[],
    isKev: (cveId: string) => boolean,
    inputs: PolicyRiskInputs,
): PolicyRiskOutcome {
    let highestSeverity: VulnSeverity = 'UNKNOWN';
    let criticalCount = 0;
    let highCount = 0;
    let kevCount = 0;
    let fixableCount = 0;
    for (const f of findings) {
        if (severityRank(f.severity) > severityRank(highestSeverity)) highestSeverity = f.severity;
        if (f.severity === 'CRITICAL') criticalCount++;
        else if (f.severity === 'HIGH') highCount++;
        if (isKev(f.vulnerability_id)) kevCount++;
        if ((f.severity === 'CRITICAL' || f.severity === 'HIGH') && f.fixed_version) fixableCount++;
    }
    const reasons: PolicyBlockReason[] = [];
    if (inputs.blockOnSeverity && isSeverityAtLeast(highestSeverity, inputs.maxSeverity)) reasons.push('severity');
    if (inputs.blockOnKev && kevCount > 0) reasons.push('kev');
    if (inputs.blockOnFixable && fixableCount > 0) reasons.push('fixable');
    return { reasons, highestSeverity, criticalCount, highCount, kevCount, fixableCount };
}

/** Human-readable label for a block reason; used in gate errors and audit logs. */
export function describeReason(reason: PolicyBlockReason): string {
    switch (reason) {
        case 'severity':
            return 'severity threshold';
        case 'kev':
            return 'known-exploited CVE (KEV)';
        case 'fixable':
            return 'fixable Critical/High';
    }
}

/** Compact descriptor of a policy's active inputs, for log and audit lines. */
export function describePolicyInputs(inputs: PolicyRiskInputs): string {
    const parts: string[] = [];
    if (inputs.blockOnSeverity) parts.push(`severity>=${inputs.maxSeverity}`);
    if (inputs.blockOnKev) parts.push('KEV');
    if (inputs.blockOnFixable) parts.push('fixable Critical/High');
    return parts.length ? parts.join(', ') : 'no active inputs';
}
