/**
 * Emergency CLI: validate that the database and encryption key are intact.
 * Runs a SQLite integrity check, confirms the core tables exist, confirms the
 * encryption key is present and usable, and confirms at least one admin exists.
 * Exits non-zero if any check fails, so it can gate a restore decision in a
 * script. Read-only.
 *
 * Run via:
 *   docker compose exec sencho node dist/cli/validateDb.js
 */
import { collectDiagnostics } from '../services/DiagnosticsService';
import { exitWith, type CliResult } from './_shared';

export async function validateDb(): Promise<CliResult> {
    const report = await collectDiagnostics();
    const problems: string[] = [];

    if (!report.database.ok) {
        problems.push(`database integrity: ${report.database.integrity}`);
        if (report.database.missingTables.length > 0) {
            problems.push(`missing core tables: ${report.database.missingTables.join(', ')}`);
        }
    }
    if (!report.encryptionKey.present) {
        problems.push('encryption.key is missing');
    } else if (!report.encryptionKey.valid) {
        problems.push('encryption.key is present but invalid');
    }
    if (report.auth.adminCount === 0) {
        problems.push('no admin users exist');
    }

    if (problems.length > 0) {
        return { ok: false, message: `Validation failed:\n  - ${problems.join('\n  - ')}` };
    }
    return {
        ok: true,
        message: `Database OK (integrity ok, ${report.auth.adminCount} admin(s), encryption key valid).`,
    };
}

async function main(): Promise<void> {
    exitWith(await validateDb());
}

if (require.main === module) {
    void main();
}
