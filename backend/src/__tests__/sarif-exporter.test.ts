/**
 * Unit tests for the SARIF 2.1.0 exporter.
 *
 * Locks in the schema-visible surface that external tools (GitHub code
 * scanning, Defender for Cloud) rely on: level/severity mapping, rule-id
 * namespacing, and the `suppressions[]` contract for accepted CVEs.
 */
import { describe, it, expect } from 'vitest';
import { generateSarif } from '../services/SarifExporter';
import type {
    VulnerabilityScan,
    VulnerabilityDetail,
    SecretFinding,
    MisconfigFinding,
} from '../services/DatabaseService';

function mkScan(overrides: Partial<VulnerabilityScan> = {}): VulnerabilityScan {
    return {
        id: 1,
        node_id: 1,
        image_ref: 'alpine:3.19',
        image_digest: 'sha256:dead',
        scanned_at: 1_700_000_000_000,
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
        highest_severity: null,
        os_info: null,
        trivy_version: '0.56.0',
        scan_duration_ms: 1000,
        triggered_by: 'manual',
        status: 'completed',
        error: null,
        stack_context: null,
        policy_evaluation: null,
        ...overrides,
    };
}

function vuln(overrides: Partial<VulnerabilityDetail> = {}): VulnerabilityDetail {
    return {
        id: 1,
        scan_id: 1,
        vulnerability_id: 'CVE-2024-0001',
        pkg_name: 'openssl',
        installed_version: '3.0.0',
        fixed_version: '3.0.1',
        severity: 'HIGH',
        title: 'OpenSSL memory corruption',
        description: null,
        primary_url: 'https://nvd.nist.gov/vuln/CVE-2024-0001',
        ...overrides,
    };
}

describe('generateSarif', () => {
    it('emits a schema-compliant root envelope', () => {
        const doc = generateSarif(mkScan(), [], [], []);
        expect(doc.$schema).toContain('sarif-schema-2.1.0.json');
        expect(doc.version).toBe('2.1.0');
        expect(doc.runs).toHaveLength(1);
        expect(doc.runs[0].tool.driver.name).toBe('Trivy (via Sencho)');
        expect(doc.runs[0].tool.driver.version).toBe('0.56.0');
    });

    it('maps severities to SARIF levels and security-severity scores', () => {
        const details = [
            vuln({ vulnerability_id: 'CVE-A', severity: 'CRITICAL' }),
            vuln({ vulnerability_id: 'CVE-B', severity: 'HIGH' }),
            vuln({ vulnerability_id: 'CVE-C', severity: 'MEDIUM' }),
            vuln({ vulnerability_id: 'CVE-D', severity: 'LOW' }),
            vuln({ vulnerability_id: 'CVE-E', severity: 'UNKNOWN' }),
        ];
        const doc = generateSarif(mkScan(), details, [], []);
        const levels = doc.runs[0].results.map((r) => r.level);
        expect(levels).toEqual(['error', 'error', 'warning', 'note', 'none']);
        const scores = doc.runs[0].results.map((r) => r.properties?.['security-severity']);
        expect(scores).toEqual(['9.8', '7.5', '5.0', '2.5', '0.0']);
    });

    it('namespaces secret and misconfig rule IDs to avoid collisions', () => {
        const secrets: SecretFinding[] = [
            {
                id: 1,
                scan_id: 1,
                rule_id: 'aws-access-key-id',
                category: 'AWS',
                severity: 'CRITICAL',
                title: 'AWS Access Key',
                target: 'app/.env',
                start_line: 4,
                end_line: 4,
                match_excerpt: 'AKIA1234...',
            },
        ];
        const misconfigs: MisconfigFinding[] = [
            {
                id: 1,
                scan_id: 1,
                rule_id: 'DS002',
                check_id: 'AVD-DS-0002',
                severity: 'HIGH',
                title: 'Running as root',
                message: 'Specify a non-root user',
                resolution: 'Set user:',
                target: 'docker-compose.yml',
                primary_url: null,
            },
        ];
        const doc = generateSarif(mkScan(), [vuln()], secrets, misconfigs);
        const ruleIds = doc.runs[0].tool.driver.rules.map((r) => r.id);
        expect(ruleIds).toContain('CVE-2024-0001');
        expect(ruleIds).toContain('SECRET:aws-access-key-id');
        expect(ruleIds).toContain('MISCONFIG:DS002');
        const resultRuleIds = doc.runs[0].results.map((r) => r.ruleId);
        expect(resultRuleIds).toEqual([
            'CVE-2024-0001',
            'SECRET:aws-access-key-id',
            'MISCONFIG:DS002',
        ]);
    });

    it('attaches SARIF suppressions[] without leaking free-form reasons', () => {
        const suppressed = {
            ...vuln(),
            suppressed: true,
            suppression_id: 7,
            suppression_reason: 'Not exploitable in our config',
        };
        const doc = generateSarif(mkScan(), [suppressed], [], []);
        const result = doc.runs[0].results[0];
        expect(result.suppressions).toHaveLength(1);
        expect(result.suppressions?.[0]).toEqual({
            kind: 'external',
            status: 'accepted',
            justification: 'Suppressed in Sencho',
        });
    });

    it('omits suppressions when finding is not suppressed', () => {
        const doc = generateSarif(mkScan(), [vuln()], [], []);
        expect(doc.runs[0].results[0].suppressions).toBeUndefined();
    });

    it('uses "Suppressed in Sencho" as justification fallback when reason is blank', () => {
        const suppressed = { ...vuln(), suppressed: true, suppression_reason: '   ' };
        const doc = generateSarif(mkScan(), [suppressed], [], []);
        expect(doc.runs[0].results[0].suppressions?.[0].justification).toBe('Suppressed in Sencho');
    });

    it('exports acknowledged misconfigs without leaking free-form reasons', () => {
        const misconfig: MisconfigFinding & { acknowledged: boolean; acknowledgement_reason: string } = {
            id: 1,
            scan_id: 1,
            rule_id: 'DS002',
            check_id: 'AVD-DS-0002',
            severity: 'HIGH',
            title: 'Running as root',
            message: 'Specify a non-root user',
            resolution: 'Set user:',
            target: 'docker-compose.yml',
            primary_url: null,
            acknowledged: true,
            acknowledgement_reason: 'Accepted for internal lab stack',
        };
        const doc = generateSarif(mkScan(), [], [], [misconfig]);
        expect(doc.runs[0].results[0].suppressions?.[0]).toEqual({
            kind: 'external',
            status: 'accepted',
            justification: 'Acknowledged in Sencho',
        });
    });

    it('deduplicates rules across findings with the same CVE id', () => {
        const details = [
            vuln({ pkg_name: 'openssl' }),
            vuln({ pkg_name: 'libcrypto' }),
        ];
        const doc = generateSarif(mkScan(), details, [], []);
        expect(doc.runs[0].tool.driver.rules).toHaveLength(1);
        expect(doc.runs[0].results).toHaveLength(2);
    });

    it('embeds package identity as a logical location on vulnerability results', () => {
        const doc = generateSarif(mkScan({ image_ref: 'nginx:1.25' }), [vuln()], [], []);
        const loc = doc.runs[0].results[0].locations[0];
        expect(loc.physicalLocation.artifactLocation.uri).toBe('nginx:1.25');
        expect(loc.logicalLocations?.[0]).toMatchObject({
            name: 'openssl',
            fullyQualifiedName: 'openssl@3.0.0',
            kind: 'package',
        });
    });

    it('places secrets at target:line via physicalLocation.region', () => {
        const secret: SecretFinding = {
            id: 1,
            scan_id: 1,
            rule_id: 'gh-token',
            category: 'GitHub',
            severity: 'HIGH',
            title: 'GitHub token',
            target: 'src/config.ts',
            start_line: 42,
            end_line: null,
            match_excerpt: 'ghp_abcd...',
        };
        const doc = generateSarif(mkScan(), [], [secret], []);
        const loc = doc.runs[0].results[0].locations[0];
        expect(loc.physicalLocation.artifactLocation.uri).toBe('src/config.ts');
        expect(loc.physicalLocation.region).toEqual({ startLine: 42, endLine: 42 });
    });

    it('does not embed the secret match excerpt in the SARIF message', () => {
        const secret: SecretFinding = {
            id: 1,
            scan_id: 1,
            rule_id: 'gh-token',
            category: 'GitHub',
            severity: 'CRITICAL',
            title: 'GitHub token',
            target: 'src/config.ts',
            start_line: 1,
            end_line: 1,
            match_excerpt: 'ghp_abcd...',
        };
        const doc = generateSarif(mkScan(), [], [secret], []);
        expect(doc.runs[0].results[0].message.text).toBe('GitHub token');
        const serialized = JSON.stringify(doc);
        expect(serialized).not.toContain('ghp_abcd');
    });

    it('populates helpUri from primary_url when set, omits it otherwise', () => {
        const withUrl = generateSarif(
            mkScan(),
            [vuln({ primary_url: 'https://nvd.nist.gov/x' })],
            [],
            [],
        );
        expect(withUrl.runs[0].tool.driver.rules[0].helpUri).toBe('https://nvd.nist.gov/x');

        const withoutUrl = generateSarif(mkScan(), [vuln({ primary_url: null })], [], []);
        expect(withoutUrl.runs[0].tool.driver.rules[0].helpUri).toBeUndefined();
    });

    it('emits misconfig Fix segment in the result message when resolution is set', () => {
        const m: MisconfigFinding = {
            id: 1,
            scan_id: 1,
            rule_id: 'DS002',
            check_id: 'AVD-DS-0002',
            severity: 'HIGH',
            title: 'Running as root',
            message: 'Specify a non-root user',
            resolution: 'Set user: 1000',
            target: 'docker-compose.yml',
            primary_url: null,
        };
        const doc = generateSarif(mkScan(), [], [], [m]);
        expect(doc.runs[0].results[0].message.text).toContain('Fix: Set user: 1000');
    });

    it('handles an empty scan without throwing', () => {
        const doc = generateSarif(mkScan(), [], [], []);
        expect(doc.runs[0].results).toEqual([]);
        expect(doc.runs[0].tool.driver.rules).toEqual([]);
    });
});
