/**
 * What an unattended Git-managed source does with a candidate when the operator
 * has configured nothing.
 *
 * One row per situation the candidate evaluator can meet, each asserting only
 * the outcome: accepted (`allowed`), refused on the merits (`blocked`), or held
 * because nothing proved it either way (`unavailable`). Every row runs against
 * the shipped defaults (`getGlobalSettings` returns no keys), so this table is
 * the answer to "does a source that was never touched accept or hold a candidate
 * differently than it did before the evidence settings existed?".
 *
 * Run against the v0.98.1 evaluator, every row below gives the same outcome
 * except the future-dated scan, which that evaluator accepted.
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

import { _resetTrivyMissingNotificationStateForTests, evaluateCandidatePolicy } from '../services/PolicyEnforcement';


/**
 * The gate resolves a registry candidate before scanning it. These suites are
 * about what the gate does with a scan, not about registry transport (which
 * `candidate-image.test.ts` covers), so every reference resolves to a
 * deterministic candidate for the node's platform.
 */
vi.mock('../services/candidateImage', async () => {
  const { createHash } = await import('node:crypto');
  const digestOf = (ref: string): string =>
    `sha256:${createHash('sha256').update(ref).digest('hex')}`;
  return {
    nodePlatformFor: async () => ({ os: 'linux', architecture: 'amd64' }),
    localImageExists: async () => true,
    pullPolicyPullsOnUp: () => false,
    resolveCandidateImage: async (_nodeId: number, ref: string) => {
      const digest = digestOf(ref);
      return {
        kind: 'candidate',
        ref,
        scanRef: `registry.example.com/candidate@${digest}`,
        indexDigest: digest,
        platformDigest: digest,
        platform: 'linux/amd64',
        qualification: 'exact',
      };
    },
  };
});

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

type CandidateStatus = Awaited<ReturnType<typeof evaluateCandidatePolicy>>['status'];

interface Situation {
    name: string;
    imageRefs?: string[];
    arrange: () => void;
    expected: CandidateStatus;
}

const kevPolicy = () => mkPolicy({ block_on_severity: 0, block_on_kev: 1 });

const SITUATIONS: Situation[] = [
    {
        name: 'no policy matches the stack',
        arrange: () => dbStub.getMatchingPolicy.mockReturnValue(null),
        expected: 'allowed',
    },
    {
        name: 'a clean, current scan',
        arrange: () => trivyStub.scanImagePreflight.mockResolvedValue(mkScan()),
        expected: 'allowed',
    },
    {
        name: 'a scan that exceeds the policy severity',
        arrange: () => trivyStub.scanImagePreflight.mockResolvedValue(
            mkScan({ highest_severity: 'CRITICAL', critical_count: 2, total_vulnerabilities: 2 }),
        ),
        expected: 'blocked',
    },
    {
        name: 'the scanner is not installed',
        arrange: () => trivyStub.isTrivyAvailable.mockReturnValue(false),
        expected: 'unavailable',
    },
    {
        name: 'the scan throws',
        arrange: () => trivyStub.scanImagePreflight.mockRejectedValue(new Error('scan process crashed')),
        expected: 'unavailable',
    },
    {
        name: 'the image reference cannot be parsed',
        imageRefs: ['not a valid ref!!'],
        arrange: () => undefined,
        expected: 'unavailable',
    },
    {
        name: 'policy evaluation throws after a successful scan',
        arrange: () => {
            dbStub.getMatchingPolicy.mockReturnValue(kevPolicy());
            trivyStub.scanImagePreflight.mockResolvedValue(mkScan({ total_vulnerabilities: 1 }));
            dbStub.getAllVulnerabilityDetails.mockReturnValue([{ vulnerability_id: 'CVE-2024-0001' }]);
            dbStub.getCveIntel.mockImplementation(() => {
                throw new Error('database is locked');
            });
        },
        expected: 'unavailable',
    },
    {
        name: 'stored findings are truncated under a known-exploited policy',
        arrange: () => {
            dbStub.getMatchingPolicy.mockReturnValue(kevPolicy());
            trivyStub.scanImagePreflight.mockResolvedValue(mkScan({ total_vulnerabilities: 3 }));
            dbStub.getAllVulnerabilityDetails.mockReturnValue([{ vulnerability_id: 'CVE-2024-0001' }]);
        },
        expected: 'blocked',
    },
    {
        // The one situation the v0.98.1 evaluator accepted: it read the scan as
        // clean whatever its timestamp. A scan dated ahead of the node clock has
        // an age nobody can determine, so it can no longer support a clean claim.
        name: 'a clean scan dated ahead of the node clock',
        arrange: () => trivyStub.scanImagePreflight.mockResolvedValue(mkScan({ scanned_at: Date.now() + 3_600_000 })),
        expected: 'unavailable',
    },
];

describe('candidate outcomes at the default evidence settings', () => {
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

    it.each(SITUATIONS)('$name: $expected', async ({ arrange, imageRefs, expected }) => {
        arrange();
        const candidate = await evaluateCandidatePolicy('web', 1, imageRefs ?? ['nginx:1.27'], {
            bypass: false,
            actor: 'system',
        });
        expect(candidate.status).toBe(expected);
    });
});
