/**
 * The evidence-availability policy as the deploy gate actually applies it.
 *
 * `policy-enforcement.test.ts` pins the shipped behavior and is deliberately
 * left untouched by this change: those tests passing unmodified is the proof
 * that the rewire changed no outcome for an operator who configures nothing.
 * This file covers what the settings can then do.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ScanPolicy, VulnerabilityScan } from '../services/DatabaseService';

interface TrivyStub {
    isTrivyAvailable: ReturnType<typeof vi.fn>;
    scanImagePreflight: ReturnType<typeof vi.fn>;
}
interface ComposeStub {
    listStackImages: ReturnType<typeof vi.fn>;
}
interface DbStub {
    getMatchingPolicy: ReturnType<typeof vi.fn>;
    insertAuditLog: ReturnType<typeof vi.fn>;
    getGlobalSettings: ReturnType<typeof vi.fn>;
    getAllVulnerabilityDetails: ReturnType<typeof vi.fn>;
    getCveSuppressions: ReturnType<typeof vi.fn>;
    getCveIntel: ReturnType<typeof vi.fn>;
}
interface NotificationStub {
    dispatchAlert: ReturnType<typeof vi.fn>;
}

const trivyStub: TrivyStub = { isTrivyAvailable: vi.fn(), scanImagePreflight: vi.fn() };
const composeStub: ComposeStub = { listStackImages: vi.fn() };
const dbStub: DbStub = {
    getMatchingPolicy: vi.fn(),
    insertAuditLog: vi.fn(),
    getGlobalSettings: vi.fn(),
    getAllVulnerabilityDetails: vi.fn(),
    getCveSuppressions: vi.fn(),
    getCveIntel: vi.fn(),
};
const notificationStub: NotificationStub = { dispatchAlert: vi.fn() };

vi.mock('../services/TrivyService', () => ({ default: { getInstance: () => trivyStub } }));
vi.mock('../services/ComposeService', () => ({ ComposeService: { getInstance: () => composeStub } }));
vi.mock('../services/DatabaseService', () => ({ DatabaseService: { getInstance: () => dbStub } }));
vi.mock('../services/NotificationService', () => ({
    NotificationService: { getInstance: () => notificationStub },
}));
vi.mock('../services/FleetSyncService', () => ({ FleetSyncService: { getSelfIdentity: () => 'self-node' } }));

import {
    _resetTrivyMissingNotificationStateForTests,
    enforcePolicyForImageRefs,
    evaluateCandidatePolicy,
} from '../services/PolicyEnforcement';

const DAY = 86_400_000;

function mkPolicy(overrides: Partial<ScanPolicy> = {}): ScanPolicy {
    return {
        id: 1,
        name: 'block-high',
        node_id: null,
        node_identity: 'self-node',
        stack_pattern: '*',
        max_severity: 'HIGH',
        block_on_deploy: 1,
        enabled: 1,
        block_on_severity: 1,
        block_on_kev: 0,
        block_on_fixable: 0,
        replicated_from_control: 0,
        created_at: Date.now(),
        updated_at: Date.now(),
        ...overrides,
    };
}

function mkScan(overrides: Partial<VulnerabilityScan> = {}): VulnerabilityScan {
    return {
        id: 1,
        node_id: 1,
        image_ref: 'nginx:1.27',
        image_digest: null,
        scanned_at: Date.now(),
        total_vulnerabilities: 0,
        critical_count: 0,
        high_count: 0,
        medium_count: 0,
        low_count: 0,
        unknown_count: 0,
        fixable_count: 0,
        secret_count: 0,
        misconfig_count: 0,
        scanners_used: 'vuln',
        highest_severity: 'LOW',
        os_info: null,
        trivy_version: '0.50.0',
        scan_duration_ms: null,
        triggered_by: 'deploy-preflight',
        status: 'completed',
        error: null,
        stack_context: 'web',
        policy_evaluation: null,
        ...overrides,
    };
}

/** Every scanner answer is "fine"; the policy under test is the settings. */
function primeCleanScan(scan: Partial<VulnerabilityScan> = {}): void {
    trivyStub.scanImagePreflight.mockResolvedValue(mkScan(scan));
}

beforeEach(() => {
    trivyStub.isTrivyAvailable.mockReset().mockReturnValue(true);
    trivyStub.scanImagePreflight.mockReset();
    composeStub.listStackImages.mockReset();
    dbStub.getMatchingPolicy.mockReset().mockReturnValue(mkPolicy());
    dbStub.insertAuditLog.mockReset();
    dbStub.getGlobalSettings.mockReset().mockReturnValue({});
    dbStub.getAllVulnerabilityDetails.mockReset().mockReturnValue([]);
    dbStub.getCveSuppressions.mockReset().mockReturnValue([]);
    dbStub.getCveIntel.mockReset().mockReturnValue(new Map());
    notificationStub.dispatchAlert.mockReset();
    _resetTrivyMissingNotificationStateForTests();
});

describe('scanner unavailability policy', () => {
    beforeEach(() => {
        trivyStub.isTrivyAvailable.mockReturnValue(false);
    });

    it('allows the deploy and marks it as having had no evidence, by default', async () => {
        const gate = await enforcePolicyForImageRefs('web', 1, ['nginx:1.27'], { bypass: false, actor: 'admin' });
        expect(gate.ok).toBe(true);
        expect(gate.trivyMissing).toBe(true);
        expect(gate.evidence?.outcome).toBe('allow');
        expect(gate.evidence?.records[0]).toMatchObject({ source: 'scanner_availability', state: 'unavailable' });
    });

    it('warns without blocking when configured to warn', async () => {
        dbStub.getGlobalSettings.mockReturnValue({ security_scanner_unavailable: 'warn' });
        const gate = await enforcePolicyForImageRefs('web', 1, ['nginx:1.27'], { bypass: false, actor: 'admin' });
        expect(gate.ok).toBe(true);
        expect(gate.trivyMissing).toBe(true);
        expect(gate.evidence?.outcome).toBe('warn');
    });

    it('blocks the deploy when configured to block', async () => {
        dbStub.getGlobalSettings.mockReturnValue({ security_scanner_unavailable: 'block' });
        const gate = await enforcePolicyForImageRefs('web', 1, ['nginx:1.27'], { bypass: false, actor: 'admin' });
        expect(gate.ok).toBe(false);
        expect(gate.trivyMissing).toBeUndefined();
        expect(gate.violations[0].imageRef).toBe('(scanner unavailable)');
        expect(gate.violations[0].error).toContain('security_scanner_unavailable=block');
    });

    it('keeps the admin bypass available even when blocking on an unavailable scanner', async () => {
        // Otherwise configuring `block` would strand a node whose scanner is
        // missing, which is the one outcome this whole policy must not cause.
        dbStub.getGlobalSettings.mockReturnValue({ security_scanner_unavailable: 'block' });
        const gate = await enforcePolicyForImageRefs('web', 1, ['nginx:1.27'], { bypass: true, actor: 'admin' });
        expect(gate.ok).toBe(true);
        expect(gate.bypassed).toBe(true);
    });

    it('audits the bypass of a scanner-unavailable block like every other bypass', async () => {
        // Regression: this branch returned bypassed:true and wrote nothing, so an
        // admin choosing to proceed past a missing scanner left no trace at all.
        dbStub.getGlobalSettings.mockReturnValue({ security_scanner_unavailable: 'block' });
        const gate = await enforcePolicyForImageRefs('web', 1, ['nginx:1.27'], { bypass: true, actor: 'admin' });
        expect(gate.ok).toBe(true);
        expect(dbStub.insertAuditLog).toHaveBeenCalledTimes(1);
        const entry = dbStub.insertAuditLog.mock.calls[0][0] as { summary: string; username: string };
        expect(entry.summary).toContain('policy.bypass');
        expect(entry.summary).toContain('policy="block-high"');
        expect(entry.username).toBe('admin');
    });

    it('never reports an unavailable scanner as a clean scan on the candidate path', async () => {
        const candidate = await evaluateCandidatePolicy('web', 1, ['nginx:1.27'], { bypass: false, actor: 'system' });
        expect(candidate.status).toBe('unavailable');
        // The outcome is the candidate's own decision, so it reflects the
        // candidate rule that held it rather than the deploy gate's allowance.
        expect(candidate.evidence?.outcome).toBe('block');
        expect(candidate.evidence?.applications).toContainEqual(
            expect.objectContaining({ rule: 'security_candidate_unproven=block' }),
        );
    });

    it('behaves identically under warn and allow, because the alert fires either way', async () => {
        // Pinned deliberately. `notifyTrivyMissingOnce` already fires for allow,
        // so warn cannot add a second signal without double-alerting one event.
        // The distinction warn/allow carries on the other two rows does not
        // exist on this one; the UI says so rather than implying otherwise.
        dbStub.getGlobalSettings.mockReturnValue({ security_scanner_unavailable: 'allow' });
        const allowed = await enforcePolicyForImageRefs('web', 1, ['nginx:1.27'], { bypass: false, actor: 'admin' });
        const allowedAlerts = notificationStub.dispatchAlert.mock.calls.length;

        notificationStub.dispatchAlert.mockReset();
        _resetTrivyMissingNotificationStateForTests();
        dbStub.getGlobalSettings.mockReturnValue({ security_scanner_unavailable: 'warn' });
        const warned = await enforcePolicyForImageRefs('web', 1, ['nginx:1.27'], { bypass: false, actor: 'admin' });

        expect(warned.ok).toBe(allowed.ok);
        expect(warned.trivyMissing).toBe(allowed.trivyMissing);
        expect(notificationStub.dispatchAlert.mock.calls.length).toBe(allowedAlerts);
        // The outcome label still differs, so the decision record is honest.
        expect(warned.evidence?.outcome).toBe('warn');
        expect(allowed.evidence?.outcome).toBe('allow');
    });
});

describe('candidate acceptance applies its own rule', () => {
    it('holds an unevaluable candidate by default, whatever the deploy settings say', async () => {
        // The deploy fields are relaxed here on purpose. The candidate path must
        // not inherit them: an unattended acceptance is not the same decision as
        // an operator getting past a scanner outage at the keyboard.
        dbStub.getGlobalSettings.mockReturnValue({
            security_scanner_unavailable: 'allow',
            security_scan_failure: 'allow',
        });
        trivyStub.scanImagePreflight.mockRejectedValue(new Error('scan process crashed'));
        const candidate = await evaluateCandidatePolicy('web', 1, ['nginx:1.27'], { bypass: false, actor: 'system' });
        expect(candidate.status).toBe('unavailable');
    });

    it('accepts an unevaluable candidate only when its own setting allows it', async () => {
        dbStub.getGlobalSettings.mockReturnValue({ security_candidate_unproven: 'allow' });
        trivyStub.scanImagePreflight.mockRejectedValue(new Error('scan process crashed'));
        const candidate = await evaluateCandidatePolicy('web', 1, ['nginx:1.27'], { bypass: false, actor: 'system' });
        expect(candidate.status).toBe('allowed');
        // Accepted, but still recorded as unproven rather than as clean.
        expect(candidate.evidence?.records[0]).toMatchObject({ state: 'failed' });
    });

    it('warns without holding when its own setting is warn', async () => {
        dbStub.getGlobalSettings.mockReturnValue({ security_candidate_unproven: 'warn' });
        trivyStub.scanImagePreflight.mockRejectedValue(new Error('scan process crashed'));
        const candidate = await evaluateCandidatePolicy('web', 1, ['nginx:1.27'], { bypass: false, actor: 'system' });
        expect(candidate.status).toBe('allowed');
        expect(notificationStub.dispatchAlert).toHaveBeenCalledTimes(1);
    });

    it('holds an unevaluable candidate when the scanner is unavailable, at every deploy setting', async () => {
        for (const setting of ['allow', 'warn', 'block']) {
            dbStub.getGlobalSettings.mockReturnValue({ security_scanner_unavailable: setting });
            trivyStub.isTrivyAvailable.mockReturnValue(false);
            const candidate = await evaluateCandidatePolicy('web', 1, ['nginx:1.27'], { bypass: false, actor: 'system' });
            expect(candidate.status, `scannerUnavailable=${setting}`).toBe('unavailable');
        }
    });

    it('still reports blocked, not unavailable, when a candidate has a genuine violation', async () => {
        dbStub.getGlobalSettings.mockReturnValue({ security_candidate_unproven: 'allow' });
        primeCleanScan({ highest_severity: 'CRITICAL', critical_count: 2, total_vulnerabilities: 2 });
        const candidate = await evaluateCandidatePolicy('web', 1, ['nginx:1.27'], { bypass: false, actor: 'system' });
        // A relaxed candidate rule must not downgrade a proven finding into an
        // evidence gap.
        expect(candidate.status).toBe('blocked');
    });

    it('holds a candidate the scanner never ran against, and says why', async () => {
        // The one candidate-path difference at the defaults, pinned so the
        // equivalence claim in securityEvidencePolicy.ts has something behind it.
        // The pre-policy evaluator held this too, with a reason naming the scanner;
        // it now reports the candidate rule instead. Same outcome, and the reason
        // an operator reads on the source's hold notice is what changed.
        trivyStub.isTrivyAvailable.mockReturnValue(false);
        const candidate = await evaluateCandidatePolicy('web', 1, ['nginx:1.27'], { bypass: false, actor: 'system' });
        expect(candidate.status).toBe('unavailable');
        if (candidate.status !== 'unavailable') throw new Error(`expected unavailable, got ${candidate.status}`);
        expect(candidate.reason).toBe('Candidate could not be fully evaluated');
        // The record is what makes the hold attributable: it names the node-wide
        // scanner gap and the candidate rule that acted on it.
        expect(candidate.evidence?.records).toContainEqual(
            expect.objectContaining({ source: 'scanner_availability', state: 'unavailable' }),
        );
        expect(candidate.evidence?.applications).toContainEqual(
            expect.objectContaining({ rule: 'security_candidate_unproven=block' }),
        );
    });

    it('holds a candidate whose policy evaluation threw, whatever the deploy settings say', async () => {
        // The release blocker this guards. The scan itself succeeded, so its
        // evidence record reads `current`; only the evaluation failed. Deriving
        // "unproven" from the records alone therefore came out empty and the
        // candidate was auto-accepted: a fail-open on the unattended path, at the
        // default settings, on an evaluation error.
        dbStub.getGlobalSettings.mockReturnValue({
            security_scanner_unavailable: 'allow',
            security_scan_failure: 'allow',
        });
        dbStub.getMatchingPolicy.mockReturnValue(mkPolicy({ block_on_severity: 0, block_on_kev: 1 }));
        primeCleanScan({ total_vulnerabilities: 1, highest_severity: 'LOW' });
        dbStub.getAllVulnerabilityDetails.mockReturnValue([{ vulnerability_id: 'CVE-2024-0001' }]);
        dbStub.getCveIntel.mockImplementation(() => {
            throw new Error('database is locked');
        });
        const candidate = await evaluateCandidatePolicy('web', 1, ['nginx:1.27'], { bypass: false, actor: 'system' });
        expect(candidate.status).toBe('unavailable');
    });

    it('follows its own setting for an evaluation failure too', async () => {
        // The rule is one rule: an evaluation failure is unproven, so relaxing
        // the candidate setting accepts it and nothing else does.
        dbStub.getGlobalSettings.mockReturnValue({ security_candidate_unproven: 'allow' });
        dbStub.getMatchingPolicy.mockReturnValue(mkPolicy({ block_on_severity: 0, block_on_kev: 1 }));
        primeCleanScan({ total_vulnerabilities: 1, highest_severity: 'LOW' });
        dbStub.getAllVulnerabilityDetails.mockReturnValue([{ vulnerability_id: 'CVE-2024-0001' }]);
        dbStub.getCveIntel.mockImplementation(() => {
            throw new Error('database is locked');
        });
        const candidate = await evaluateCandidatePolicy('web', 1, ['nginx:1.27'], { bypass: false, actor: 'system' });
        expect(candidate.status).toBe('allowed');
    });

    it('records which setting permitted an accepted unproven candidate', async () => {
        dbStub.getGlobalSettings.mockReturnValue({ security_candidate_unproven: 'allow' });
        trivyStub.scanImagePreflight.mockRejectedValue(new Error('scan process crashed'));
        const candidate = await evaluateCandidatePolicy('web', 1, ['nginx:1.27'], { bypass: false, actor: 'system' });
        expect(candidate.status).toBe('allowed');
        // An acceptance on unproven evidence must not be indistinguishable from a
        // clean one once persisted.
        expect(candidate.evidence?.applications).toContainEqual(
            expect.objectContaining({
                rule: 'security_candidate_unproven=allow',
                target: 'nginx:1.27',
                outcome: 'allow',
            }),
        );
        expect(candidate.evidence?.outcome).toBe('allow');
    });

    it('reports the real evidence state on the application it adds', async () => {
        // The added application must describe the state the evaluator found, not
        // a generic one, or the record misstates what was wrong.
        dbStub.getGlobalSettings.mockReturnValue({ security_candidate_unproven: 'allow' });
        trivyStub.scanImagePreflight.mockRejectedValue(new Error('scan process crashed'));
        const candidate = await evaluateCandidatePolicy('web', 1, ['nginx:1.27'], { bypass: false, actor: 'system' });
        const app = candidate.evidence?.applications?.find((a) => a.rule.startsWith('security_candidate_unproven'));
        expect(app?.state).toBe('failed');
    });

    it('refuses a truncated-finding candidate on the merits when the policy reads KEV', async () => {
        // The detail rows are what a KEV verdict is read from, so a truncated set
        // is genuinely unprovable here. The refusal must come from the evaluator
        // having failed it closed, not from the candidate rule, so the operator is
        // pointed at the scan rather than at an evidence setting.
        dbStub.getMatchingPolicy.mockReturnValue(mkPolicy({ block_on_severity: 0, block_on_kev: 1 }));
        primeCleanScan({ total_vulnerabilities: 5, highest_severity: 'LOW' });
        dbStub.getAllVulnerabilityDetails.mockReturnValue([{ vulnerability_id: 'CVE-2024-0001' }]);
        const candidate = await evaluateCandidatePolicy('web', 1, ['nginx:1.27'], { bypass: false, actor: 'system' });
        // Narrowed explicitly, because `expect(...).toBe` does not narrow: only
        // the `blocked` arm of the result carries violations.
        if (candidate.status !== 'blocked') throw new Error(`expected blocked, got ${candidate.status}`);
        expect(candidate.violations[0].reasons).toContain('kev');
        // The candidate rule never fired, so no application names it.
        expect(candidate.evidence?.applications ?? []).toEqual([]);
    });

    it('accepts a truncated-finding candidate when the policy reads only the complete aggregate', async () => {
        // Suppressions are honored so the detail rows are loaded, but the policy
        // gates on neither KEV nor fixability, so its only input is the severity in
        // the scan's complete aggregate. The truncation cannot change that verdict,
        // so holding the candidate here would refuse a decision the policy already
        // made. This is the one place the unprovable set could have produced a
        // false positive, and it is deliberately not counted.
        dbStub.getMatchingPolicy.mockReturnValue(mkPolicy({ block_on_severity: 1, block_on_kev: 0, block_on_fixable: 0 }));
        dbStub.getGlobalSettings.mockReturnValue({ deploy_block_honor_suppressions: '1' });
        primeCleanScan({ total_vulnerabilities: 5, highest_severity: 'LOW' });
        dbStub.getAllVulnerabilityDetails.mockReturnValue([{ vulnerability_id: 'CVE-2024-0001' }]);
        const candidate = await evaluateCandidatePolicy('web', 1, ['nginx:1.27'], { bypass: false, actor: 'system' });
        expect(candidate.status).toBe('allowed');
        // The record still carries the truncation, so the decision is auditable
        // even though it did not change the verdict.
        expect(candidate.evidence?.records).toContainEqual(
            expect.objectContaining({ target: 'nginx:1.27', state: 'partial' }),
        );
    });

    it('never reads the detail rows at all when no input needs them', async () => {
        // A severity-only policy that does not honor suppressions keeps the cheap
        // aggregate path, so there is no truncation to reason about in the first
        // place.
        dbStub.getMatchingPolicy.mockReturnValue(mkPolicy({ block_on_severity: 1, block_on_kev: 0, block_on_fixable: 0 }));
        primeCleanScan({ total_vulnerabilities: 5, highest_severity: 'LOW' });
        const candidate = await evaluateCandidatePolicy('web', 1, ['nginx:1.27'], { bypass: false, actor: 'system' });
        expect(candidate.status).toBe('allowed');
        expect(dbStub.getAllVulnerabilityDetails).not.toHaveBeenCalled();
        expect(candidate.evidence?.records.every((r) => r.state === 'current')).toBe(true);
    });

    it('describes one decision, not two, when the rule overrides the outcome', async () => {
        // The summary and the outcome have to agree. The evaluator's own summary
        // reports the deploy gate's verdict, and the candidate rule may decide
        // something different, so the summary is rebuilt rather than carried over.
        // Both the outcome and the applications are persisted with an accepted
        // generation, so a record reader would otherwise see a summary describing
        // a refusal beside an outcome reporting an acceptance.
        dbStub.getGlobalSettings.mockReturnValue({ security_candidate_unproven: 'allow' });
        trivyStub.scanImagePreflight.mockRejectedValue(new Error('scan process crashed'));
        dbStub.getMatchingPolicy.mockReturnValue(mkPolicy({ block_on_severity: 0, block_on_kev: 1 }));
        const candidate = await evaluateCandidatePolicy('web', 1, ['nginx:1.27'], { bypass: false, actor: 'system' });
        expect(candidate.status).toBe('allowed');
        expect(candidate.evidence?.outcome).toBe('allow');
        // The summary names every rule that acted, including the one that let it
        // through, and none of them reports a block.
        expect(candidate.evidence?.summary).toContain('security_candidate_unproven=allow');
        // The deploy-gate rules stay visible in their own right; what must not
        // appear is one reporting an outcome the candidate decision overrode.
        expect(candidate.evidence?.summary).not.toContain('security_candidate_unproven=block');
        // Every application in the decision is represented in the sentence, so the
        // summary cannot describe a subset of what the record holds.
        for (const application of candidate.evidence?.applications ?? []) {
            expect(candidate.evidence?.summary).toContain(application.rule);
        }
    });

    it('accepts a candidate on an authorized bypass', async () => {
        trivyStub.scanImagePreflight.mockRejectedValue(new Error('scan process crashed'));
        const candidate = await evaluateCandidatePolicy('web', 1, ['nginx:1.27'], { bypass: true, actor: 'admin' });
        expect(candidate.status).toBe('allowed');
    });
});

describe('scan failure policy', () => {
    beforeEach(() => {
        trivyStub.scanImagePreflight.mockRejectedValue(new Error('scan process crashed'));
    });

    it('blocks on a failed scan by default', async () => {
        const gate = await enforcePolicyForImageRefs('web', 1, ['nginx:1.27'], { bypass: false, actor: 'admin' });
        expect(gate.ok).toBe(false);
        expect(gate.evidence?.outcome).toBe('block');
    });

    it('allows the deploy when the operator accepts failed scans', async () => {
        dbStub.getGlobalSettings.mockReturnValue({ security_scan_failure: 'allow' });
        const gate = await enforcePolicyForImageRefs('web', 1, ['nginx:1.27'], { bypass: false, actor: 'admin' });
        expect(gate.ok).toBe(true);
        // The failure is still on the record; "allowed" must not read as clean.
        expect(gate.evidence?.records[0]).toMatchObject({ state: 'failed' });
    });

    it('warns and alerts exactly once when configured to warn', async () => {
        dbStub.getGlobalSettings.mockReturnValue({ security_scan_failure: 'warn' });
        const gate = await enforcePolicyForImageRefs('web', 1, ['nginx:1.27'], { bypass: false, actor: 'admin' });
        expect(gate.ok).toBe(true);
        expect(gate.evidence?.outcome).toBe('warn');
        // One event, one alert. The summary-level notify that used to sit
        // alongside this one double-fired under its own cooldown key.
        expect(notificationStub.dispatchAlert).toHaveBeenCalledTimes(1);
        expect(notificationStub.dispatchAlert).toHaveBeenCalledWith(
            'warning',
            'scan_finding',
            expect.stringContaining('did not complete'),
            expect.anything(),
        );
    });
});

describe('scan freshness is not a gate input', () => {
    it('records the scan as current however old it is, because no bound is applied here', async () => {
        // A pre-deploy gate scans on demand, so the evidence it holds is fresh by
        // construction and can never be stale.
        primeCleanScan({ scanned_at: Date.now() - 400 * DAY });
        const gate = await enforcePolicyForImageRefs('web', 1, ['nginx:1.27'], { bypass: false, actor: 'admin' });
        expect(gate.ok).toBe(true);
        expect(gate.evidence?.records[0]?.state).toBe('current');
    });

    it('ignores a freshness bound left behind in settings by a hand edit or an older build', async () => {
        // A control the UI does not offer must not be able to refuse deploys.
        dbStub.getGlobalSettings.mockReturnValue({
            security_max_scan_age_days: '7',
            security_stale_scan: 'block',
        });
        primeCleanScan({ scanned_at: Date.now() - 9 * DAY });
        const gate = await enforcePolicyForImageRefs('web', 1, ['nginx:1.27'], { bypass: false, actor: 'admin' });
        expect(gate.ok).toBe(true);
        expect(gate.evidence?.outcome).toBe('allow');
    });

    it('still blocks on the findings of an old scan, because age is not risk', async () => {
        primeCleanScan({
            scanned_at: Date.now() - 400 * DAY,
            highest_severity: 'CRITICAL',
            critical_count: 3,
            total_vulnerabilities: 3,
        });
        const gate = await enforcePolicyForImageRefs('web', 1, ['nginx:1.27'], { bypass: false, actor: 'admin' });
        expect(gate.ok).toBe(false);
        expect(gate.violations[0].reasons).toContain('severity');
    });
});

describe('evidence the gate records', () => {
    it('records an unparseable image reference as not evaluated rather than omitting it', async () => {
        primeCleanScan();
        const gate = await enforcePolicyForImageRefs('web', 1, ['not a valid ref!!'], { bypass: false, actor: 'admin' });
        expect(gate.evidence?.records).toContainEqual(
            expect.objectContaining({ state: 'not_evaluated', target: 'not a valid ref!!' }),
        );
    });

    it('records truncated finding sets as partial evidence', async () => {
        // A cache-truncated scan keeps the aggregate counts but only some detail
        // rows, so KEV and fixability cannot be read from it.
        dbStub.getGlobalSettings.mockReturnValue({});
        dbStub.getMatchingPolicy.mockReturnValue(mkPolicy({ block_on_severity: 0, block_on_kev: 1, block_on_fixable: 0 }));
        primeCleanScan({ total_vulnerabilities: 10, highest_severity: 'LOW' });
        dbStub.getAllVulnerabilityDetails.mockReturnValue([{ vulnerability_id: 'CVE-2024-0001' }]);
        const gate = await enforcePolicyForImageRefs('web', 1, ['nginx:1.27'], { bypass: false, actor: 'admin' });
        expect(gate.evidence?.records).toContainEqual(expect.objectContaining({ state: 'partial' }));
    });

    it('falls back to the documented defaults when the settings read throws', async () => {
        dbStub.getGlobalSettings.mockImplementation(() => {
            throw new Error('database is locked');
        });
        trivyStub.isTrivyAvailable.mockReturnValue(false);
        const gate = await enforcePolicyForImageRefs('web', 1, ['nginx:1.27'], { bypass: false, actor: 'admin' });
        // A settings hiccup must not become a deploy failure, and must not
        // silently tighten either.
        expect(gate.ok).toBe(true);
        expect(gate.evidence?.outcome).toBe('allow');
    });

    it('does not fail the deploy when the settings read throws on the main scan path', async () => {
        // The scanner is AVAILABLE here, so this exercises the scan loop rather
        // than the early scanner-unavailable return. The suppression toggle used
        // to be read outside the guard, which turned an unrelated database error
        // into a failed deploy.
        dbStub.getGlobalSettings.mockImplementation(() => {
            throw new Error('database is locked');
        });
        primeCleanScan();
        const gate = await enforcePolicyForImageRefs('web', 1, ['nginx:1.27'], { bypass: false, actor: 'admin' });
        expect(gate.ok).toBe(true);
        expect(trivyStub.scanImagePreflight).toHaveBeenCalled();
    });

    it('fails closed on suppressions when the settings read throws', async () => {
        // The strict direction: an unreadable toggle must not start suppressing
        // findings that would otherwise block. The suppression row below is what
        // makes this discriminating: with honorSuppressions wrongly defaulted to
        // true, the KEV finding is suppressed and the deploy is allowed, so the
        // assertion fails. With no suppression row the test would pass either
        // way, which is exactly how it was vacuous before.
        dbStub.getGlobalSettings.mockImplementation(() => {
            throw new Error('database is locked');
        });
        dbStub.getMatchingPolicy.mockReturnValue(mkPolicy({ block_on_severity: 0, block_on_kev: 1 }));
        primeCleanScan({ total_vulnerabilities: 1, highest_severity: 'LOW' });
        dbStub.getAllVulnerabilityDetails.mockReturnValue([{ vulnerability_id: 'CVE-2024-0001' }]);
        dbStub.getCveIntel.mockReturnValue(new Map([['CVE-2024-0001', { kev: true }]]));
        dbStub.getCveSuppressions.mockReturnValue([
            {
                id: 1,
                cve_id: 'CVE-2024-0001',
                pkg_name: null,
                image_pattern: null,
                reason: 'accepted for verification',
                created_by: 'admin',
                created_at: Date.now() - 1000,
                expires_at: null,
                replicated_from_control: 0,
                status: 'accepted',
            },
        ]);
        const gate = await enforcePolicyForImageRefs('web', 1, ['nginx:1.27'], { bypass: false, actor: 'admin' });
        expect(gate.ok).toBe(false);
        expect(gate.violations[0].reasons).toContain('kev');

        // Control: the same suppression does suppress when the toggle really is
        // on, which proves the row above is capable of changing the outcome.
        dbStub.getGlobalSettings.mockReturnValue({ deploy_block_honor_suppressions: '1' });
        const suppressed = await enforcePolicyForImageRefs('web', 1, ['nginx:1.27'], { bypass: false, actor: 'admin' });
        expect(suppressed.ok).toBe(true);
    });

    it('reports every image it examined, not just the ones that matched', async () => {
        primeCleanScan();
        const gate = await enforcePolicyForImageRefs(
            'web',
            1,
            ['nginx:1.27', 'redis:7'],
            { bypass: false, actor: 'admin' },
        );
        expect(gate.evidence?.records.map((r) => r.target)).toEqual(['nginx:1.27', 'redis:7']);
    });
});
