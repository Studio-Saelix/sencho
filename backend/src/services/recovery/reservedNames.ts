/**
 * The reserved prefix every recovery-owned volume and image name starts with.
 *
 * Kept in a module with no imports so the Compose and stack-deletion paths can
 * ask whether a name is Sencho's own without loading the recovery engine.
 */
export const RECOVERY_RESERVED_PREFIX = 'sencho-recovery-';
