import { sanitizeForLog } from '../../utils/safeLog';
import { DatabaseService } from '../DatabaseService';

/** Who asked, from where, through which route. Captured once per request. */
export interface PublicExposureAuditContext {
  username: string;
  ip: string;
  method: string;
  path: string;
}

/**
 * Write one public exposure audit row: the dotted action and its facts as
 * `key=value` pairs. Callers pass account ids, zone names and outcomes only,
 * never the token or any prefix, fingerprint or length of it. A failed write
 * is logged and does not fail the action it records.
 */
export function recordPublicExposureAudit(
  context: PublicExposureAuditContext,
  action: string,
  facts: Record<string, string | number | null | undefined>,
  statusCode = 200,
): void {
  const summary = `${action}: ${Object.entries(facts)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key}=${sanitizeForLog(String(value))}`)
    .join(' ')}`;
  try {
    DatabaseService.getInstance().insertAuditLog({
      timestamp: Date.now(),
      username: context.username,
      method: context.method,
      path: context.path,
      status_code: statusCode,
      node_id: null,
      ip_address: context.ip,
      summary,
    });
  } catch (error: unknown) {
    console.warn(`[PublicExposure] Audit log write failed for ${sanitizeForLog(action)}:`, sanitizeForLog(error instanceof Error ? error.message : 'unknown'));
  }
}
