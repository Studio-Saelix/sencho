/**
 * Shared constants for the Fleet Sync wire protocol.
 *
 * The control instance pushes scan_policies and cve_suppressions to remote
 * nodes via POST /api/fleet/sync/:resource. The payload schema is defined
 * here so both the sender (FleetSyncService) and the receiver (routes/fleet)
 * agree on limits and field names.
 */

/**
 * Maximum number of rows accepted per sync push.
 *
 * Enforced on both ends:
 *   - Sender: `FleetSyncService.loadResource` truncates at this cap and
 *     emits a warning notification when it triggers. Operators with
 *     >5000 policies on the control are exceedingly rare; truncating is
 *     safer than failing every push.
 *   - Receiver: `POST /api/fleet/sync/:resource` rejects payloads above
 *     this cap with HTTP 413.
 */
export const MAX_SYNC_ROWS = 5000;

/**
 * Maximum body size for POST /api/fleet/sync/:resource. Sized to comfortably
 * fit MAX_SYNC_ROWS rows of either resource at the per-field length caps
 * enforced by the row validators (~1 KB per row worst-case = ~5 MB).
 *
 * The global JSON body limit stays at 100 KB; only this one route allows
 * larger bodies. See middleware/jsonParser.ts for the dispatch logic.
 */
export const SYNC_BODY_LIMIT = '5mb';

/**
 * Path prefix that the JSON body parser uses to dispatch to the larger
 * limit. Kept as a constant so any path change updates both the parser
 * and the route mount.
 *
 * CAUTION: prefix match, not exact route. Any new route under /api/fleet/sync/
 * inherits the elevated body limit. If a future route under this prefix should
 * keep the standard 100 KB cap, narrow the dispatch in middleware/jsonParser.ts
 * to method+exact-path instead of prefix.
 */
export const SYNC_PATH_PREFIX = '/api/fleet/sync/';

/** How long to suppress repeat truncation alerts after one fires. */
export const TRUNCATION_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** How far back the retry service looks for failed sync targets. */
export const RETRY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Failure-window threshold for the retry-service stale-target notification.
 * A previously-working node whose `last_failure_at - last_success_at` exceeds
 * this triggers one warning per cooldown.
 */
export const STALE_THRESHOLD_MS = 60 * 60 * 1000;

/**
 * Resource enum kept here so the state-key helpers below can type-check
 * their arguments without a cycle through FleetSyncService. The ordering
 * below mirrors `FLEET_RESOURCES` in FleetSyncService.
 */
export type FleetResource = 'scan_policies' | 'cve_suppressions';

/**
 * `system_state` keys read or written by Fleet Sync. Centralized so a typo
 * cannot silently bypass a stale-push check or a cooldown gate.
 */
export const SYNC_STATE_KEYS = {
    fleetRole: 'fleet_role',
    fleetSelfIdentity: 'fleet_self_identity',
    fleetControlIdentity: 'fleet_control_identity',
    receivedPushedAt: (resource: FleetResource): string => `received_pushed_at:${resource}`,
    truncationAlertAt: (resource: FleetResource): string => `fleet_sync_truncation_alert_at:${resource}`,
} as const;

/** Structured error codes returned by the receive endpoint. */
export const SYNC_ERROR_CODES = {
    staleSyncPush: 'STALE_SYNC_PUSH',
    payloadTooLarge: 'SYNC_PAYLOAD_TOO_LARGE',
    controlIdentityMismatch: 'CONTROL_IDENTITY_MISMATCH',
} as const;
