/**
 * Emergency CLI: back up the Sencho data directory (sencho.db + encryption.key)
 * to a target directory. Uses SQLite's online backup so the copy is consistent
 * even while Sencho is running.
 *
 * Run via:
 *   docker compose exec sencho node dist/cli/backupData.js [destination-dir]
 *
 * With no argument it writes a timestamped folder under <DATA_DIR>/backups.
 * Written to the audit log with actor `cli`.
 */
import fs from 'fs';
import path from 'path';
import { DatabaseService } from '../services/DatabaseService';
import { auditCli, exitWith, type CliResult } from './_shared';

function dataDir(): string {
    return process.env.DATA_DIR || path.join(process.cwd(), 'data');
}

export async function backupData(destArg?: string): Promise<CliResult> {
    const src = dataDir();
    const keyPath = path.join(src, 'encryption.key');
    const trimmedDest = destArg?.trim();
    const dest = trimmedDest
        ? path.resolve(trimmedDest)
        : path.join(src, 'backups', `sencho-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);

    const db = DatabaseService.getInstance();
    // Refuse a destination that would write the copy onto the live database
    // itself, which would report success while producing no separate backup.
    if (path.resolve(dest, 'sencho.db') === path.resolve(db.getDb().name)) {
        return { ok: false, message: 'Destination would overwrite the live database. Choose a different directory.' };
    }

    fs.mkdirSync(dest, { recursive: true });

    // Online backup produces a consistent snapshot even while the DB is in use.
    await db.getDb().backup(path.join(dest, 'sencho.db'));

    let keyNote = '';
    if (fs.existsSync(keyPath)) {
        fs.copyFileSync(keyPath, path.join(dest, 'encryption.key'));
        keyNote = ' + encryption.key';
    }

    auditCli(db, '/cli/backup-data', `CLI backed up data directory to ${dest}`);
    return { ok: true, message: `Backup written to ${dest} (sencho.db${keyNote}). Store it somewhere safe; it contains your encryption key.` };
}

async function main(): Promise<void> {
    exitWith(await backupData(process.argv[2]));
}

if (require.main === module) {
    void main();
}
