/**
 * Emergency CLI: create a fresh local admin account from a shell inside the
 * container, used when every admin is locked out but the database is otherwise
 * intact (so resetting first-boot setup would needlessly discard config).
 *
 * Run via:
 *   docker compose exec sencho node dist/cli/createEmergencyAdmin.js <username> <password>
 *
 * Refuses to overwrite an existing user; use resetPassword for that. Written to
 * the audit log with actor `cli`.
 */
import bcrypt from 'bcrypt';
import { DatabaseService } from '../services/DatabaseService';
import { BCRYPT_SALT_ROUNDS } from '../helpers/constants';
import { auditCli, exitWith, usage, type CliResult } from './_shared';

const MIN_PASSWORD_LENGTH = 8;

export async function createEmergencyAdmin(username: string, password: string): Promise<CliResult> {
    if (!username || typeof username !== 'string') {
        return { ok: false, message: 'Username is required' };
    }
    if (!password || password.length < MIN_PASSWORD_LENGTH) {
        return { ok: false, message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` };
    }
    const db = DatabaseService.getInstance();
    if (db.getUserByUsername(username)) {
        return { ok: false, message: `User already exists: ${username}. Use reset-password instead.` };
    }
    const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
    db.addUser({ username, password_hash: passwordHash, role: 'admin', auth_provider: 'local' });
    auditCli(db, `/cli/create-emergency-admin/${username}`, `CLI created emergency admin ${username}`);
    return { ok: true, message: `Emergency admin ${username} created. Sign in and review your other accounts.` };
}

async function main(): Promise<void> {
    const username = process.argv[2];
    const password = process.argv[3];
    if (!username || !password) {
        usage('Usage: node dist/cli/createEmergencyAdmin.js <username> <password>');
    }
    exitWith(await createEmergencyAdmin(username, password));
}

if (require.main === module) {
    void main();
}
