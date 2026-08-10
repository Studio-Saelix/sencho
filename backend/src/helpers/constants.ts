// Shared constants used across the backend. Extracted from index.ts to keep
// the entry point lean and to make values discoverable without scanning the
// monolith.

// Server
export const PORT = 1852;

// Password policy
export const MIN_PASSWORD_LENGTH = 8;
/** bcrypt cost factor. 10 is current Sencho default; roughly ~75ms/hash on modern hardware. */
export const BCRYPT_SALT_ROUNDS = 10;

// Labels
export const VALID_LABEL_COLORS = ['teal', 'blue', 'purple', 'rose', 'amber', 'green', 'orange', 'pink', 'cyan', 'slate'] as const;
export type LabelColor = typeof VALID_LABEL_COLORS[number];
export const MAX_LABELS_PER_NODE = 50;
// Hard cap on stack assignments a single bulk-assign request may carry, summed
// across all target nodes. A node typically has tens of stacks, not thousands;
// the cap bounds the DB writes one request can force. Shared by the per-node
// receiver and the fleet orchestrator so they cannot drift.
export const MAX_ASSIGNMENTS = 1000;

// Session cookies
export const COOKIE_NAME = 'sencho_token';
export const SESSION_COOKIE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
export const REMEMBER_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, "stay signed in"
// Sliding-refresh window: a user-session token with less than this much life
// left gets silently reissued with a fresh full TTL, so continued activity
// never runs into the hard expiry. See middleware/auth.ts::authMiddleware.
export const SESSION_REFRESH_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour
export const MFA_PENDING_COOKIE_NAME = 'sencho_mfa_pending';
export const MFA_PENDING_SCOPE = 'mfa_pending';
export const MFA_PENDING_TTL_MS = 5 * 60 * 1000; // 5 minutes to complete the challenge

// MFA replay-prevention: recently-used codes are blacklisted for
// MFA_REPLAY_TTL_MS to block replay within a single 30-second TOTP window
// (plus drift tolerance). A periodic purge keeps the table bounded.
export const MFA_REPLAY_TTL_MS = 120 * 1000;
export const MFA_REPLAY_PURGE_INTERVAL_MS = 60 * 1000;

// Hot-path cache TTLs.
// Short TTLs collapse concurrent polling pressure across browser tabs and
// overlapping service samplers without introducing noticeable UI staleness.
// Keys are per-node: "stats:<nodeId>", "system-stats:<nodeId>", "stack-statuses:<nodeId>".
export const STATS_CACHE_TTL_MS = 2_000;
export const SYSTEM_STATS_CACHE_TTL_MS = 3_000;
// Stack statuses are cached past the frontend dashboard poll cadence (10s),
// so ordinary polls hit instead of recomputing. Container events and
// lifecycle mutations invalidate the key; 15s bounds worst-case staleness for
// any missed invalidation path.
export const STACK_STATUSES_CACHE_TTL_MS = 15_000;
