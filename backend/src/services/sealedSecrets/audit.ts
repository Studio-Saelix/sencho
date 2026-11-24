import { sanitizeForLog } from '../../utils/safeLog';
import { DatabaseService } from '../DatabaseService';

export type SealedSecretAuditFacts = Record<string, string | number | null | undefined>;

/**
 * Write one sealed secret audit row: the dotted action and its facts as
 * `key=value` pairs. Callers pass purpose, slot, generation, node, actor and
 * reason only: never the secret, any part of it, or its fingerprint. A failed
 * write is logged and does not fail the action it records.
 */
export function recordSealedSecretAudit(
  action: string,
  facts: SealedSecretAuditFacts,
  context: { username: string; path: string; method: string; nodeId?: number | null; statusCode?: number },
): void {
  const summary = `${action}: ${Object.entries(facts)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${sanitizeForLog(String(value))}`)
    .join(' ')}`;
  try {
    DatabaseService.getInstance().insertAuditLog({
      timestamp: Date.now(),
      username: context.username,
      method: context.method,
      path: context.path,
      status_code: context.statusCode ?? 200,
      node_id: context.nodeId ?? null,
      ip_address: '',
      summary,
    });
  } catch (error: unknown) {
    console.warn(
      `[SealedSecrets] Audit log write failed for ${sanitizeForLog(action)}:`,
      sanitizeForLog(error instanceof Error ? error.message : 'unknown'),
    );
  }
}
