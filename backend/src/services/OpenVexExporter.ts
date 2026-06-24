/**
 * Builds an OpenVEX document from the instance's CVE triage decisions.
 *
 * Each suppression carries a triage status; this maps it to an OpenVEX status so
 * downstream scanners (and other Sencho nodes) can consume our authored
 * not-affected / fixed statements rather than re-deciding. Emitting from the
 * stored decisions (not a live scan) keeps the export consistent with the UI.
 */
import type { CveSuppression } from './DatabaseService';

export interface OpenVexStatement {
    vulnerability: { name: string };
    products: string[];
    status: 'not_affected' | 'affected' | 'fixed' | 'under_investigation';
    justification?: string;
    action_statement?: string;
    timestamp: string;
}

export interface OpenVexDocument {
    '@context': string;
    '@id': string;
    author: string;
    timestamp: string;
    version: number;
    statements: OpenVexStatement[];
}

// Triage status -> OpenVEX status. OpenVEX has four statuses; "accepted"/"ignored"
// risk is "affected" with an action statement, "needs_review" maps to the
// in-flight "under_investigation".
const STATUS_MAP: Record<string, OpenVexStatement['status']> = {
    not_affected: 'not_affected',
    false_positive: 'not_affected',
    fixed: 'fixed',
    affected: 'affected',
    accepted: 'affected',
    ignored: 'affected',
    needs_review: 'under_investigation',
};

export function generateOpenVex(
    suppressions: CveSuppression[],
    author: string,
    timestamp: string,
): OpenVexDocument {
    const statements: OpenVexStatement[] = suppressions.map((s) => {
        const status = STATUS_MAP[s.status ?? 'accepted'] ?? 'affected';
        const stmt: OpenVexStatement = {
            vulnerability: { name: s.cve_id },
            // Glob image pattern as the product scope; '*' means fleet-wide.
            products: [s.image_pattern ?? '*'],
            status,
            timestamp,
        };
        // OpenVEX requires a justification (or impact statement) for not_affected.
        if (status === 'not_affected') {
            stmt.justification = s.justification ?? 'vulnerable_code_not_present';
        }
        // An accepted risk is "affected" with the operator's reason as the action.
        if (status === 'affected' && s.reason) {
            stmt.action_statement = s.reason;
        }
        return stmt;
    });
    return {
        '@context': 'https://openvex.dev/ns/v0.2.0',
        '@id': `https://sencho.io/vex/${timestamp}`,
        author,
        timestamp,
        version: 1,
        statements,
    };
}
