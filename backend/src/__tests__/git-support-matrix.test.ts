/**
 * Validates the Git transport support matrix (docs/git-transport-support.yaml)
 * against the reality it claims to describe, so a published claim can never
 * silently outrun its evidence.
 *
 * The renderer this test imports (backend/scripts/git-support-matrix/*)
 * lives outside backend's tsconfig `rootDir` (pinned to `src`), the same
 * constraint git-transport-auth.integration.test.ts documents for its own
 * cross-directory fixture reuse. A static `import` there would fail
 * `tsc --noEmit`; `require()` at runtime does not, since TS never has to
 * resolve or type-check a file it was not statically asked to include.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { gitSourceStatus } from '../utils/gitSourceHttp';
import type { GitSourceErrorCode } from '../services/GitSourceService';
import { resolveTestHandle } from './__helpers__/testHandleResolver';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const matrixRenderer = require('../../scripts/git-support-matrix/render');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { loadClaimSet, REPO_ROOT } = require('../../scripts/git-support-matrix/loadClaimSet');

const CLOSED_ENUMS = {
    transport: ['https', 'ssh'],
    ref: ['branch', 'tag', 'sha'],
    auth: ['none', 'pat', 'deploy-key'],
    host: ['github', 'gitlab', 'gitea', 'forgejo', 'bitbucket', 'generic'],
    ca: ['system', 'per-source', 'not-applicable'],
    node_path: ['local', 'direct-proxy', 'pilot'],
    port: ['default', 'nonstandard'],
    support: ['supported', 'unsupported', 'unverified'],
};

const REQUIRED_CLAIM_KEYS = ['id', 'transport', 'ref', 'auth', 'host', 'ca', 'node_path', 'support', 'qualifiers'];
const OPTIONAL_CLAIM_KEYS = ['port', 'evidence'];
const ALLOWED_CLAIM_KEYS = new Set([...REQUIRED_CLAIM_KEYS, ...OPTIONAL_CLAIM_KEYS]);

interface Claim {
    id: string;
    transport: string;
    ref: string;
    auth: string;
    host: string;
    ca: string;
    node_path: string;
    port?: string;
    support: string;
    qualifiers: string[];
    limitations?: string[];
    evidence?: {
        kind: 'automated' | 'live';
        outcome: 'success' | 'rejected';
        handles?: { file: string; title: string }[];
        attestation?: string;
    };
}

interface Attestation {
    id: string;
    date: string;
    source_commit: string;
    sencho_image_digest?: string;
    host: string;
    node_path: string;
    transport?: string;
    ref?: string;
    auth?: string;
    ca?: string;
    result: 'success' | 'rejected';
}

/** Pure schema validation: closed enums, required keys, no unknown fields, resolvable limitation refs. */
function validateClaimSchema(claim: Record<string, unknown>, limitationIds: Set<string>): string[] {
    const errors: string[] = [];
    const keys = Object.keys(claim);

    for (const key of REQUIRED_CLAIM_KEYS) {
        if (!(key in claim)) errors.push(`missing required key "${key}"`);
    }
    for (const key of keys) {
        if (!ALLOWED_CLAIM_KEYS.has(key)) errors.push(`unknown key "${key}"`);
    }
    for (const [field, allowed] of Object.entries(CLOSED_ENUMS)) {
        if (field === 'support' && typeof claim.support === 'string' && !allowed.includes(claim.support)) {
            errors.push(`invalid support "${String(claim.support)}"`);
        } else if (field in claim && field !== 'support') {
            const value = (claim as Record<string, unknown>)[field];
            if (typeof value === 'string' && !allowed.includes(value)) {
                errors.push(`invalid ${field} "${value}"`);
            }
        }
    }
    if (Array.isArray(claim.limitations)) {
        for (const id of claim.limitations as string[]) {
            if (!limitationIds.has(id)) errors.push(`unknown limitation id "${id}"`);
        }
    }
    return errors;
}

/** Pure evidence-semantics validation, independent of file/AST resolution. */
function validateClaimEvidence(claim: Claim): string[] {
    const errors: string[] = [];
    const { support, evidence } = claim;

    if (support === 'unverified') {
        if (evidence) errors.push('unverified claim must not carry evidence');
        return errors;
    }

    if (!evidence) {
        errors.push(`${support} claim requires evidence`);
        return errors;
    }

    const expectedOutcome = support === 'supported' ? 'success' : 'rejected';
    if (evidence.outcome !== expectedOutcome) {
        errors.push(`${support} claim requires evidence.outcome "${expectedOutcome}", got "${evidence.outcome}"`);
    }

    if (evidence.kind === 'automated' && (!evidence.handles || evidence.handles.length === 0)) {
        errors.push('automated evidence requires at least one handle');
    }
    if (evidence.kind === 'live' && !evidence.attestation) {
        errors.push('live evidence requires an attestation id');
    }
    return errors;
}

/** Cross-checks a live claim's dimensions and baseline against its attestation. */
function validateLiveEvidenceIntegrity(claim: Claim, attestationsById: Map<string, Attestation>, expectedBaseline: string): string[] {
    if (claim.support === 'unverified' || claim.evidence?.kind !== 'live') return [];
    const errors: string[] = [];
    const attestation = claim.evidence.attestation ? attestationsById.get(claim.evidence.attestation) : undefined;

    if (!attestation) {
        errors.push(`claim "${claim.id}" references missing attestation "${String(claim.evidence.attestation)}"`);
        return errors;
    }
    if (attestation.source_commit !== expectedBaseline) {
        errors.push(`claim "${claim.id}"'s attestation is stale: source_commit "${attestation.source_commit}" != implementation_baseline "${expectedBaseline}"`);
    }
    if (attestation.host !== claim.host) errors.push(`claim "${claim.id}" host mismatch with its attestation`);
    if (attestation.node_path !== claim.node_path) errors.push(`claim "${claim.id}" node_path mismatch with its attestation`);
    if (attestation.transport !== undefined && attestation.transport !== claim.transport) errors.push(`claim "${claim.id}" transport mismatch with its attestation`);
    if (attestation.ref !== undefined && attestation.ref !== claim.ref) errors.push(`claim "${claim.id}" ref mismatch with its attestation`);
    if (attestation.auth !== undefined && attestation.auth !== claim.auth) errors.push(`claim "${claim.id}" auth mismatch with its attestation`);
    if (attestation.ca !== undefined && attestation.ca !== claim.ca) errors.push(`claim "${claim.id}" ca mismatch with its attestation`);
    const expectedOutcome = claim.support === 'supported' ? 'success' : 'rejected';
    if (attestation.result !== expectedOutcome) errors.push(`claim "${claim.id}" attestation result "${attestation.result}" contradicts claim support "${claim.support}"`);
    return errors;
}

function extractStringUnionMembers(filePath: string, typeName: string): string[] {
    const sourceText = fs.readFileSync(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
    const members: string[] = [];
    const collect = (typeNode: ts.TypeNode): void => {
        if (ts.isUnionTypeNode(typeNode)) {
            typeNode.types.forEach(collect);
        } else if (ts.isLiteralTypeNode(typeNode) && ts.isStringLiteral(typeNode.literal)) {
            members.push(typeNode.literal.text);
        }
    };
    const visit = (node: ts.Node): void => {
        if (ts.isTypeAliasDeclaration(node) && node.name.text === typeName) {
            collect(node.type);
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (members.length === 0) throw new Error(`Type alias ${typeName} not found (or has no string-literal members) in ${filePath}`);
    return members;
}

describe('git transport support matrix', () => {
    const { support, attestations } = loadClaimSet() as { support: { claims: Claim[]; limitations: { id: string; title: string; statement: string }[]; error_model: { code: string; label: string; status: number; meaning: string }[]; reconciliation_only_codes: string[]; implementation_baseline: string }; attestations: { attestations: Attestation[] } };
    const limitationIds = new Set(support.limitations.map((l) => l.id));
    const attestationsById = new Map(attestations.attestations.map((a) => [a.id, a]));

    describe('schema', () => {
        it('every real claim is schema-valid', () => {
            for (const claim of support.claims) {
                expect(validateClaimSchema(claim as unknown as Record<string, unknown>, limitationIds), claim.id).toEqual([]);
            }
        });

        it('every claim id is unique', () => {
            const ids = support.claims.map((c) => c.id);
            expect(new Set(ids).size).toBe(ids.length);
        });

        it('rejects an invalid enum value', () => {
            const bad = { ...support.claims[0], transport: 'ftp' };
            expect(validateClaimSchema(bad, limitationIds)).toContain('invalid transport "ftp"');
        });

        it('rejects an unknown field', () => {
            const bad = { ...support.claims[0], bogusField: true };
            expect(validateClaimSchema(bad, limitationIds)).toContain('unknown key "bogusField"');
        });

        it('rejects a dangling limitation reference', () => {
            const bad = { ...support.claims[0], limitations: ['does-not-exist'] };
            expect(validateClaimSchema(bad, limitationIds)).toContain('unknown limitation id "does-not-exist"');
        });

        it('rejects a claim missing a required key', () => {
            const bad = { ...support.claims[0] } as Record<string, unknown>;
            delete bad.host;
            expect(validateClaimSchema(bad, limitationIds)).toContain('missing required key "host"');
        });
    });

    describe('evidence semantics', () => {
        it('every real claim satisfies evidence semantics', () => {
            for (const claim of support.claims) {
                expect(validateClaimEvidence(claim), claim.id).toEqual([]);
            }
        });

        it('rejects a supported claim with no evidence', () => {
            const bad: Claim = { ...support.claims.find((c) => c.support === 'supported')!, evidence: undefined };
            expect(validateClaimEvidence(bad)).toContain('supported claim requires evidence');
        });

        it('rejects an unverified claim that carries evidence', () => {
            const template = support.claims.find((c) => c.support === 'supported')!;
            const bad: Claim = { ...template, support: 'unverified' };
            expect(validateClaimEvidence(bad)).toContain('unverified claim must not carry evidence');
        });

        it('rejects a supported claim whose evidence outcome is "rejected"', () => {
            const template = support.claims.find((c) => c.support === 'supported' && c.evidence)!;
            const bad: Claim = { ...template, evidence: { ...template.evidence!, outcome: 'rejected' } };
            expect(validateClaimEvidence(bad)).toContain('supported claim requires evidence.outcome "success", got "rejected"');
        });

        it('rejects automated evidence with no handles', () => {
            const template = support.claims.find((c) => c.evidence?.kind === 'automated')!;
            const bad: Claim = { ...template, evidence: { ...template.evidence!, handles: [] } };
            expect(validateClaimEvidence(bad)).toContain('automated evidence requires at least one handle');
        });

        it('requires an unsupported claim to carry rejection evidence, not silence', () => {
            const template = support.claims.find((c) => c.support === 'supported')!;
            const bad: Claim = { ...template, support: 'unsupported', evidence: undefined };
            expect(validateClaimEvidence(bad)).toContain('unsupported claim requires evidence');
        });
    });

    describe('page binding', () => {
        it('the committed MDX is byte-identical to a fresh render of the YAML', () => {
            const mdxPath = path.join(REPO_ROOT, 'docs', 'features', 'git-transport-support.mdx');
            expect(matrixRenderer.renderFullMdx()).toBe(fs.readFileSync(mdxPath, 'utf8'));
        });

        it('re-rendering with a mutated claim produces different generated output', () => {
            const mutated = {
                support: {
                    ...support,
                    claims: support.claims.map((c, i) => (i === 0 ? { ...c, support: 'unsupported' } : c)),
                },
                attestations,
            };
            const original = matrixRenderer.renderGeneratedBlock({ support, attestations });
            const changed = matrixRenderer.renderGeneratedBlock(mutated);
            expect(changed).not.toBe(original);
        });
    });

    describe('proof handles', () => {
        const automatedClaims = support.claims.filter((c) => c.evidence?.kind === 'automated');

        it('has at least one automated claim to check', () => {
            expect(automatedClaims.length).toBeGreaterThan(0);
        });

        for (const claim of automatedClaims) {
            for (const handle of claim.evidence!.handles ?? []) {
                it(`resolves "${handle.title}" in ${handle.file} (claim ${claim.id})`, () => {
                    const absPath = path.join(REPO_ROOT, handle.file);
                    const sourceText = fs.readFileSync(absPath, 'utf8');
                    const result = resolveTestHandle(absPath, sourceText, handle.title);
                    expect(result, JSON.stringify(result)).toEqual({ ok: true });
                });
            }
        }

        // Mutation coverage for the resolver's found/duplicate/skip/ancestor
        // logic itself lives in testHandleResolver.test.ts; this suite only
        // needs to prove every real handle actually resolves.
    });

    describe('live evidence integrity', () => {
        it('every real live claim (if any) is internally consistent', () => {
            for (const claim of support.claims) {
                expect(validateLiveEvidenceIntegrity(claim, attestationsById, support.implementation_baseline), claim.id).toEqual([]);
            }
        });

        it('rejects a live claim referencing a missing attestation', () => {
            const bad: Claim = {
                id: 'synthetic-missing-attestation', transport: 'https', ref: 'branch', auth: 'pat',
                host: 'github', ca: 'system', node_path: 'local', support: 'supported', qualifiers: [],
                evidence: { kind: 'live', outcome: 'success', attestation: 'does-not-exist' },
            };
            expect(validateLiveEvidenceIntegrity(bad, attestationsById, support.implementation_baseline).length).toBeGreaterThan(0);
        });

        it('rejects a live claim whose attestation baseline is stale', () => {
            const fakeAttestations = new Map<string, Attestation>([
                ['att-stale', { id: 'att-stale', date: '2020-01-01', source_commit: 'deadbeef', host: 'github', node_path: 'local', result: 'success' }],
            ]);
            const bad: Claim = {
                id: 'synthetic-stale', transport: 'https', ref: 'branch', auth: 'pat',
                host: 'github', ca: 'system', node_path: 'local', support: 'supported', qualifiers: [],
                evidence: { kind: 'live', outcome: 'success', attestation: 'att-stale' },
            };
            const errors = validateLiveEvidenceIntegrity(bad, fakeAttestations, support.implementation_baseline);
            expect(errors.some((e) => e.includes('stale'))).toBe(true);
        });

        it('rejects a live claim whose node_path does not match its attestation', () => {
            const fakeAttestations = new Map<string, Attestation>([
                ['att-mismatch', { id: 'att-mismatch', date: '2026-01-01', source_commit: support.implementation_baseline, host: 'github', node_path: 'direct-proxy', result: 'success' }],
            ]);
            const bad: Claim = {
                id: 'synthetic-mismatch', transport: 'https', ref: 'branch', auth: 'pat',
                host: 'github', ca: 'system', node_path: 'local', support: 'supported', qualifiers: [],
                evidence: { kind: 'live', outcome: 'success', attestation: 'att-mismatch' },
            };
            const errors = validateLiveEvidenceIntegrity(bad, fakeAttestations, support.implementation_baseline);
            expect(errors.some((e) => e.includes('node_path mismatch'))).toBe(true);
        });

        it('rejects an attestation whose result contradicts the claim support', () => {
            const fakeAttestations = new Map<string, Attestation>([
                ['att-contradict', { id: 'att-contradict', date: '2026-01-01', source_commit: support.implementation_baseline, host: 'github', node_path: 'local', result: 'rejected' }],
            ]);
            const bad: Claim = {
                id: 'synthetic-contradict', transport: 'https', ref: 'branch', auth: 'pat',
                host: 'github', ca: 'system', node_path: 'local', support: 'supported', qualifiers: [],
                evidence: { kind: 'live', outcome: 'success', attestation: 'att-contradict' },
            };
            const errors = validateLiveEvidenceIntegrity(bad, fakeAttestations, support.implementation_baseline);
            expect(errors.some((e) => e.includes('contradicts'))).toBe(true);
        });
    });

    describe('error model partition', () => {
        const transportFacingCodes = extractStringUnionMembers(
            path.join(REPO_ROOT, 'backend', 'src', 'services', 'git', 'errors.ts'),
            'TransportFacingCode',
        );
        const gitSourceErrorCodes = extractStringUnionMembers(
            path.join(REPO_ROOT, 'backend', 'src', 'services', 'GitSourceService.ts'),
            'GitSourceErrorCode',
        );

        it('the matrix error_model is exactly TransportFacingCode plus REF_DELETED and FILE_NOT_FOUND', () => {
            const expected = new Set([...transportFacingCodes, 'REF_DELETED', 'FILE_NOT_FOUND']);
            const actual = new Set(support.error_model.map((e) => e.code));
            expect(actual).toEqual(expected);
        });

        it('reconciliation_only_codes plus the matrix error_model partitions all of GitSourceErrorCode exactly once', () => {
            const matrixCodes = support.error_model.map((e) => e.code);
            const reconciliationCodes: string[] = support.reconciliation_only_codes;
            const combined = [...matrixCodes, ...reconciliationCodes];

            expect(new Set(combined).size).toBe(combined.length); // no code in both sets
            expect(new Set(combined)).toEqual(new Set(gitSourceErrorCodes)); // covers every code
        });

        it('every published status matches the real gitSourceStatus mapping', () => {
            for (const entry of support.error_model) {
                expect(gitSourceStatus(entry.code as GitSourceErrorCode), entry.code).toBe(entry.status);
            }
        });

        it('rejects a matrix that leaves a code unclassified', () => {
            const incomplete = support.error_model.filter((e) => e.code !== 'GIT_ERROR').map((e) => e.code);
            const reconciliationCodes: string[] = support.reconciliation_only_codes;
            const combined = [...incomplete, ...reconciliationCodes];
            expect(new Set(combined)).not.toEqual(new Set(gitSourceErrorCodes));
        });
    });

    describe('rate limiting', () => {
        it('is documented as a limitation, not a supported claim', () => {
            expect(limitationIds.has('no-rate-limit-classification')).toBe(true);
        });
    });
});
