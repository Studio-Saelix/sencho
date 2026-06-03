/**
 * Emergency CLI: reset a local user's password from a shell inside the
 * container, used when the admin password is forgotten and no other admin can
 * sign in to reset it from the UI.
 *
 * Run via:
 *   docker compose exec sencho node dist/cli/resetPassword.js <username> <new-password>
 *
 * Existing sessions for the target are invalidated by bumping `token_version`,
 * and the reset is written to the audit log with actor `cli`.
 */
import bcrypt from 'bcrypt';
import { DatabaseService } from '../services/DatabaseService';
import { BCRYPT_SALT_ROUNDS } from '../helpers/constants';
import { auditCli, exitWith, usage, type CliResult } from './_shared';

const MIN_PASSWORD_LENGTH = 8;

export async function resetPassword(username: string, newPassword: string): Promise<CliResult> {
    if (!username || typeof username !== 'string') {
        return { ok: false, message: 'Username is required' };
    }
    if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
        return { ok: false, message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` };
    }
    const db = DatabaseService.getInstance();
    const user = db.getUserByUsername(username);
    if (!user) {
        return { ok: false, message: `User not found: ${username}` };
    }
    if (user.auth_provider !== 'local') {
        return { ok: false, message: `User ${username} signs in via ${user.auth_provider}; password reset applies to local accounts only` };
    }
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_SALT_ROUNDS);
    db.updateUser(user.id, { password_hash: passwordHash });
    db.bumpTokenVersion(user.id);
    auditCli(db, `/cli/reset-password/${username}`, `CLI reset password for ${username}`);
    return { ok: true, message: `Password reset for ${username}. Existing sessions were signed out.` };
}

async function main(): Promise<void> {
    const username = process.argv[2];
    const newPassword = process.argv[3];
    if (!username || !newPassword) {
        usage('Usage: node dist/cli/resetPassword.js <username> <new-password>');
    }
    exitWith(await resetPassword(username, newPassword));
}

if (require.main === module) {
    void main();
}
