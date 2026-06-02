/**
 * Shared helpers for the emergency recovery CLI commands in this directory.
 * Each command exports a testable function and a thin `main()` wrapper; these
 * helpers carry the audit-write and exit-code conventions so the individual
 * commands stay focused on their own logic.
 */
import { DatabaseService } from '../services/DatabaseService';

export interface CliResult {
    ok: boolean;
    message: string;
}

/**
 * Record a CLI action in the audit log with the conventional `cli` actor, then
 * flush immediately. The buffer's 1s flush timer never fires because the CLI
 * process exits first, so the explicit flush is what persists the entry. An
 * audit-write failure is logged but never aborts the action it was recording.
 */
export function auditCli(db: DatabaseService, path: string, summary: string): void {
    try {
        db.insertAuditLog({
            timestamp: Date.now(),
            username: 'cli',
            method: 'POST',
            path,
            status_code: 200,
            node_id: null,
            ip_address: 'cli',
            summary,
        });
        // Flush inside the try: the buffer's 1s timer never fires before the
        // CLI exits, so this is what persists the entry. Keeping it under the
        // same catch means a broken DB handle cannot throw a second, uncaught
        // error after the recovery action it records has already succeeded.
        db.flushAuditLogBuffer();
    } catch (err) {
        console.warn(`[cli] audit log write failed: ${(err as Error).message}`);
    }
}

/** Print the result and exit 0 (ok) or 1 (error), matching resetMfa.ts. */
export function exitWith(result: CliResult): never {
    if (result.ok) {
        console.log(result.message);
        process.exit(0);
    }
    console.error(result.message);
    process.exit(1);
}

/** Print a usage error to stderr and exit 2 (matches resetMfa.ts). */
export function usage(message: string): never {
    console.error(message);
    process.exit(2);
}
