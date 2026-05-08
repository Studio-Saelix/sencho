/**
 * Builds SARIF 2.1.0 documents from stored Trivy scan results.
 *
 * The exporter does not shell out to `trivy --format sarif`: emitting from the
 * DB keeps the output consistent with what the UI shows (same suppressions,
 * same counts, no rescan latency) and supports stack misconfig scans.
 *
 * Rule IDs are namespaced so secrets and misconfigs don't collide with CVEs in
 * a flat result list: `<CVE-...>`, `SECRET:<rule>`, `MISCONFIG:<rule>`.
 */
import type {
    VulnerabilityScan,
    VulnerabilityDetail,
    SecretFinding,
    MisconfigFinding,
    VulnSeverity,
} from './DatabaseService';
import type { SuppressionDecision } from '../utils/suppression-filter';
import type { MisconfigAcknowledgementDecision } from '../utils/misconfig-ack-filter';

export interface SarifSuppression {
    kind: 'external';
    status: 'accepted';
    justification: string;
}

export interface SarifRule {
    id: string;
    name: string;
    shortDescription: { text: string };
    fullDescription?: { text: string };
    helpUri?: string;
    properties: {
        'security-severity': string;
        tags: string[];
    };
}

export interface SarifResult {
    ruleId: string;
    level: 'error' | 'warning' | 'note' | 'none';
    message: { text: string };
    locations: Array<{
        physicalLocation: {
            artifactLocation: { uri: string };
            region?: { startLine: number; endLine?: number };
        };
        logicalLocations?: Array<{ name: string; fullyQualifiedName: string; kind: string }>;
    }>;
    suppressions?: SarifSuppression[];
    properties?: { 'security-severity': string; tags?: string[] };
}

export interface SarifDocument {
    $schema: string;
    version: '2.1.0';
    runs: Array<{
        tool: {
            driver: {
                name: string;
                informationUri: string;
                version?: string;
                rules: SarifRule[];
            };
        };
        results: SarifResult[];
        // SARIF 2.1.0 allows arbitrary properties on a run for tool-specific
        // metadata. Sencho writes a truncation marker here when a scan
        // exceeds the export row cap.
        properties?: Record<string, unknown>;
    }>;
}

type SuppressedVulnerability = VulnerabilityDetail & Partial<SuppressionDecision>;
type AcknowledgedMisconfig = MisconfigFinding & Partial<MisconfigAcknowledgementDecision>;

const SEVERITY_TO_LEVEL: Record<VulnSeverity, 'error' | 'warning' | 'note' | 'none'> = {
    CRITICAL: 'error',
    HIGH: 'error',
    MEDIUM: 'warning',
    LOW: 'note',
    UNKNOWN: 'none',
};

const SEVERITY_TO_SCORE: Record<VulnSeverity, string> = {
    CRITICAL: '9.8',
    HIGH: '7.5',
    MEDIUM: '5.0',
    LOW: '2.5',
    UNKNOWN: '0.0',
};

const SARIF_SCHEMA =
    'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json';

function toSuppressions(decision: Partial<SuppressionDecision>): SarifSuppression[] | undefined {
    if (!decision.suppressed) return undefined;
    return [
        {
            kind: 'external',
            status: 'accepted',
            justification: decision.suppression_reason?.trim() || 'Suppressed in Sencho',
        },
    ];
}

function toAckSuppressions(
    decision: Partial<MisconfigAcknowledgementDecision>,
): SarifSuppression[] | undefined {
    if (!decision.acknowledged) return undefined;
    return [
        {
            kind: 'external',
            status: 'accepted',
            justification: decision.acknowledgement_reason?.trim() || 'Acknowledged in Sencho',
        },
    ];
}

function vulnRule(detail: VulnerabilityDetail): SarifRule {
    return {
        id: detail.vulnerability_id,
        name: detail.vulnerability_id,
        shortDescription: { text: detail.title || detail.vulnerability_id },
        fullDescription: detail.description ? { text: detail.description } : undefined,
        helpUri: detail.primary_url || undefined,
        properties: {
            'security-severity': SEVERITY_TO_SCORE[detail.severity],
            tags: ['security', 'vulnerability'],
        },
    };
}

function secretRule(finding: SecretFinding): SarifRule {
    const id = `SECRET:${finding.rule_id}`;
    return {
        id,
        name: id,
        shortDescription: { text: finding.title || finding.rule_id },
        properties: {
            'security-severity': SEVERITY_TO_SCORE[finding.severity],
            tags: ['security', 'secret', finding.category ?? 'unknown'],
        },
    };
}

function misconfigRule(finding: MisconfigFinding): SarifRule {
    const id = `MISCONFIG:${finding.rule_id}`;
    return {
        id,
        name: id,
        shortDescription: { text: finding.title || finding.rule_id },
        fullDescription: finding.message ? { text: finding.message } : undefined,
        helpUri: finding.primary_url || undefined,
        properties: {
            'security-severity': SEVERITY_TO_SCORE[finding.severity],
            tags: ['security', 'misconfiguration'],
        },
    };
}

function vulnResult(
    detail: SuppressedVulnerability,
    imageRef: string,
): SarifResult {
    const messageParts = [
        detail.title || detail.vulnerability_id,
        `Package: ${detail.pkg_name} ${detail.installed_version}`,
    ];
    if (detail.fixed_version) messageParts.push(`Fixed in: ${detail.fixed_version}`);
    return {
        ruleId: detail.vulnerability_id,
        level: SEVERITY_TO_LEVEL[detail.severity],
        message: { text: messageParts.join(' | ') },
        locations: [
            {
                physicalLocation: { artifactLocation: { uri: imageRef } },
                logicalLocations: [
                    {
                        name: detail.pkg_name,
                        fullyQualifiedName: `${detail.pkg_name}@${detail.installed_version}`,
                        kind: 'package',
                    },
                ],
            },
        ],
        suppressions: toSuppressions(detail),
        properties: { 'security-severity': SEVERITY_TO_SCORE[detail.severity] },
    };
}

function secretResult(finding: SecretFinding): SarifResult {
    const region =
        finding.start_line != null
            ? { startLine: finding.start_line, endLine: finding.end_line ?? finding.start_line }
            : undefined;
    return {
        ruleId: `SECRET:${finding.rule_id}`,
        level: SEVERITY_TO_LEVEL[finding.severity],
        message: { text: finding.title || finding.rule_id },
        locations: [
            {
                physicalLocation: {
                    artifactLocation: { uri: finding.target },
                    region,
                },
            },
        ],
        properties: { 'security-severity': SEVERITY_TO_SCORE[finding.severity] },
    };
}

function misconfigResult(finding: AcknowledgedMisconfig): SarifResult {
    const parts = [finding.title || finding.rule_id];
    if (finding.message) parts.push(finding.message);
    if (finding.resolution) parts.push(`Fix: ${finding.resolution}`);
    return {
        ruleId: `MISCONFIG:${finding.rule_id}`,
        level: SEVERITY_TO_LEVEL[finding.severity],
        message: { text: parts.join(' | ') },
        locations: [
            { physicalLocation: { artifactLocation: { uri: finding.target } } },
        ],
        suppressions: toAckSuppressions(finding),
        properties: { 'security-severity': SEVERITY_TO_SCORE[finding.severity] },
    };
}

export function generateSarif(
    scan: VulnerabilityScan,
    vulnerabilities: SuppressedVulnerability[],
    secrets: SecretFinding[],
    misconfigs: AcknowledgedMisconfig[],
): SarifDocument {
    const rules = new Map<string, SarifRule>();
    for (const v of vulnerabilities) if (!rules.has(v.vulnerability_id)) rules.set(v.vulnerability_id, vulnRule(v));
    for (const s of secrets) {
        const id = `SECRET:${s.rule_id}`;
        if (!rules.has(id)) rules.set(id, secretRule(s));
    }
    for (const m of misconfigs) {
        const id = `MISCONFIG:${m.rule_id}`;
        if (!rules.has(id)) rules.set(id, misconfigRule(m));
    }

    const results: SarifResult[] = [
        ...vulnerabilities.map((v) => vulnResult(v, scan.image_ref)),
        ...secrets.map((s) => secretResult(s)),
        ...misconfigs.map((m) => misconfigResult(m)),
    ];

    return {
        $schema: SARIF_SCHEMA,
        version: '2.1.0',
        runs: [
            {
                tool: {
                    driver: {
                        name: 'Trivy (via Sencho)',
                        informationUri: 'https://github.com/aquasecurity/trivy',
                        version: scan.trivy_version ?? undefined,
                        rules: Array.from(rules.values()),
                    },
                },
                results,
            },
        ],
    };
}
