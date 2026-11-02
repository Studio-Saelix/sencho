import type { Request } from 'express';

/**
 * The header a hub puts on a descriptor dispatch to a node, which the node
 * echoes back. It is how the hub tells its own answer from a crossed or replayed
 * one; a hop that strips it makes every read a mismatch, which is logged rather
 * than trusted.
 *
 * Kept in its own module so the dispatcher and the hub-side support read can both
 * use it without importing each other.
 */
export const RECOVERY_OPERATION_HEADER = 'x-sencho-recovery-operation-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The operation id a dispatch sent, when it is a well-formed one. */
export function operationIdFromRequest(req: Pick<Request, 'get'>): string | null {
  const value = req.get(RECOVERY_OPERATION_HEADER);
  return value && UUID.test(value) ? value.toLowerCase() : null;
}
