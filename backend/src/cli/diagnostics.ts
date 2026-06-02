/**
 * Emergency CLI: print a redacted diagnostic summary (version, database
 * integrity, encryption-key status, admin/SSO/MFA counts, non-secret config) as
 * JSON. Read-only; carries no secrets (see DiagnosticsService for the
 * redaction allowlist). Safe to copy into a bug report.
 *
 * Run via:
 *   docker compose exec sencho node dist/cli/diagnostics.js
 */
import { collectDiagnostics } from '../services/DiagnosticsService';

export async function printDiagnostics(): Promise<void> {
    const report = await collectDiagnostics();
    console.log(JSON.stringify(report, null, 2));
}

async function main(): Promise<void> {
    try {
        await printDiagnostics();
        process.exit(0);
    } catch (err) {
        console.error(`Failed to collect diagnostics: ${(err as Error).message}`);
        process.exit(1);
    }
}

if (require.main === module) {
    void main();
}
