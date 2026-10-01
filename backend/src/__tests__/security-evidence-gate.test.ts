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

    it('never reports an unavailable scanner as a clean scan on the candidate path', async () => {
        const candidate = await evaluateCandidatePolicy('web', 1, ['nginx:1.27'], { bypass: false, actor: 'system' });
        expect(candidate.status).toBe('unavailable');
        expect(candidate.evidence?.outcome).toBe('allow');
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

describe('candidate acceptance under a loosened policy', () => {
    it('accepts a candidate when the operator has explicitly allowed failed scans', async () => {
        // Pinned deliberately, and documented. The operator's availability policy
        // is one contract consumed by every path, so a policy that lets a deploy
        // proceed on a failed scan also lets source acceptance proceed. Treating
        // the candidate path specially here would be the second engine this
        // design exists to avoid. The evidence record still shows `failed`.
        dbStub.getGlobalSettings.mockReturnValue({ security_scan_failure: 'allow' });
        trivyStub.scanImagePreflight.mockRejectedValue(new Error('scan process crashed'));
        const candidate = await evaluateCandidatePolicy('web', 1, ['nginx:1.27'], { bypass: false, actor: 'system' });
        expect(candidate.status).toBe('allowed');
        expect(candidate.evidence?.records[0]).toMatchObject({ state: 'failed' });
    });

    it('still refuses a candidate when the operator has not loosened anything', async () => {
        dbStub.getGlobalSettings.mockReturnValue({});
        trivyStub.scanImagePreflight.mockRejectedValue(new Error('scan process crashed'));
        const candidate = await evaluateCandidatePolicy('web', 1, ['nginx:1.27'], { bypass: false, actor: 'system' });
        expect(candidate.status).toBe('unavailable');
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

describe('scan freshness policy', () => {
    it('does not consult scan age when no bound is configured, however old the scan', async () => {
        primeCleanScan({ scanned_at: Date.now() - 400 * DAY });
        const gate = await enforcePolicyForImageRefs('web', 1, ['nginx:1.27'], { bypass: false, actor: 'admin' });
        expect(gate.ok).toBe(true);
        expect(gate.evidence?.records[0]?.state).toBe('current');
    });

    it('records a stale scan as stale once a bound is configured', async () => {
        dbStub.getGlobalSettings.mockReturnValue({ security_max_scan_age_days: '7' });
        primeCleanScan({ scanned_at: Date.now() - 9 * DAY });
        const gate = await enforcePolicyForImageRefs('web', 1, ['nginx:1.27'], { bypass: false, actor: 'admin' });
        expect(gate.ok).toBe(true);
        expect(gate.evidence?.records[0]?.state).toBe('stale');
        expect(gate.evidence?.outcome).toBe('allow');
    });

    it('still blocks on the findings of a stale scan, because age is not risk', async () => {
        dbStub.getGlobalSettings.mockReturnValue({ security_max_scan_age_days: '7' });
        primeCleanScan({
            scanned_at: Date.now() - 9 * DAY,
            highest_severity: 'CRITICAL',
            critical_count: 3,
            total_vulnerabilities: 3,
        });
        const gate = await enforcePolicyForImageRefs('web', 1, ['nginx:1.27'], { bypass: false, actor: 'admin' });
        expect(gate.ok).toBe(false);
        expect(gate.violations[0].reasons).toContain('severity');
    });

    it('blocks on staleness alone when configured to', async () => {
        dbStub.getGlobalSettings.mockReturnValue({
            security_max_scan_age_days: '7',
            security_stale_scan: 'block',
        });
        primeCleanScan({ scanned_at: Date.now() - 9 * DAY });
        const gate = await enforcePolicyForImageRefs('web', 1, ['nginx:1.27'], { bypass: false, actor: 'admin' });
        expect(gate.ok).toBe(false);
        expect(gate.violations[0].error).toContain('9 day(s) old');
        expect(gate.violations[0].error).toContain('7 day limit');
    });

    it('leaves a fresh scan current under the same bound', async () => {
        dbStub.getGlobalSettings.mockReturnValue({
            security_max_scan_age_days: '7',
            security_stale_scan: 'block',
        });
        primeCleanScan({ scanned_at: Date.now() - DAY });
        const gate = await enforcePolicyForImageRefs('web', 1, ['nginx:1.27'], { bypass: false, actor: 'admin' });
        expect(gate.ok).toBe(true);
        expect(gate.evidence?.records[0]?.state).toBe('current');
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
