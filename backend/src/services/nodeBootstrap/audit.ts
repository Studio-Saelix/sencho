import { sanitizeForLog } from '../../utils/safeLog';
import type { DatabaseService } from '../DatabaseService';

/** Who asked, from where, through which route. Captured once per request. */
export interface BootstrapAuditContext {
  username: string;
  ip: string;
  method: string;
  path: string;
}

/**
 * Write one bootstrap audit row: the action and its facts as `key=value`
 * pairs. Callers pass identifiers, fingerprints, digests and states only,
 * never a key, passphrase, token or command output. A failed write is logged
 * and does not fail the action it records.
 */
export function recordBootstrapAudit(
  db: DatabaseService,
  now: number,
  context: BootstrapAuditContext,
  action: string,
  facts: Record<string, unknown>,
  statusCode = 200,
): void {
  const summary = `${action}: ${Object.entries(facts)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key}=${sanitizeForLog(String(value))}`)
    .join(' ')}`;
  try {
    db.insertAuditLog({
      timestamp: now,
      username: context.username,
      method: context.method,
      path: context.path,
      status_code: statusCode,
      node_id: null,
      ip_address: context.ip,
      summary,
    });
  } catch (error: unknown) {
    console.warn('[Bootstrap] Audit log write failed:', error instanceof Error ? error.message : 'unknown');
  }
}
