import type Database from 'better-sqlite3';
import { DatabaseService } from '../DatabaseService';
import { RecoveryError } from './redaction';
import { RECOVERY_AUTHORITY_STATE_KEY } from './schema';

/**
 * The database handle for recovery stores, or `schema_unsupported` when this
 * build did not apply the recovery schema (a newer build wrote it, or the
 * migration failed). Every store goes through here, so a downgraded node
 * refuses recovery work instead of misreading newer rows.
 */
export function recoveryDb(): Database.Database {
  const service = DatabaseService.getInstance();
  if (service.getRecoverySchemaOutcome().kind !== 'current') {
    throw new RecoveryError('schema_unsupported');
  }
  return service.getDb();
}

/** This instance's recovery authority id, created once by the schema migration. */
export function getRecoveryAuthorityId(): string {
  const row = recoveryDb().prepare('SELECT value FROM system_state WHERE key = ?')
    .get(RECOVERY_AUTHORITY_STATE_KEY) as { value: string } | undefined;
  if (!row?.value) throw new RecoveryError('identity_unknown');
  return row.value;
}
