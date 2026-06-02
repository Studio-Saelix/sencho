/**
 * Emergency CLI: invalidate every active session by bumping every user's
 * token_version. Used after a suspected cookie theft or when a wedged login
 * state needs a clean sign-out of every user on this node.
 *
 * Run via:
 *   docker compose exec sencho node dist/cli/clearSessions.js
 *
 * Written to the audit log with actor `cli`.
 */
import { DatabaseService } from '../services/DatabaseService';
import { auditCli, exitWith, type CliResult } from './_shared';

export function clearSessions(): CliResult {
    const db = DatabaseService.getInstance();
    const count = db.bumpAllTokenVersions();
    auditCli(db, '/cli/clear-sessions', `CLI cleared all sessions (${count} users)`);
    return { ok: true, message: `Cleared sessions for ${count} user(s). Everyone must sign in again.` };
}

function main(): void {
    exitWith(clearSessions());
}

if (require.main === module) {
    main();
}
