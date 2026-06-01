import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { CryptoService } from './CryptoService';
import { isSeverityAtLeast } from '../utils/severity';
import type { AuditStatsInput } from './AuditAnomalyService';

function isPilotMode(): boolean {
    return process.env.SENCHO_MODE === 'pilot';
}

export interface Agent {
    id?: number;
    type: 'discord' | 'slack' | 'webhook';
    url: string;
    enabled: boolean;
}

export interface GlobalSetting {
    key: string;
    value: string;
}

export interface StackAlert {
    id?: number;
    stack_name: string;
    metric: string;
    operator: string;
    threshold: number;
    duration_mins: number;
    cooldown_mins: number;
    last_fired_at?: number;
}

export type NodeMode = 'proxy' | 'pilot_agent';

export interface AutoHealPolicy {
    id?: number;
    node_id: number;
    proxy_entitled_until: number;
    stack_name: string;
    service_name: string | null;
    unhealthy_duration_mins: number;
    cooldown_mins: number;
    max_restarts_per_hour: number;
    auto_disable_after_failures: number;
    enabled: number;
    consecutive_failures: number;
    last_fired_at: number;
    created_at: number;
    updated_at: number;
}

export interface AutoHealHistoryEntry {
    id?: number;
    policy_id: number;
    stack_name: string;
    service_name: string | null;
    container_name: string;
    container_id: string;
    action: 'restarted' | 'skipped_user_action' | 'skipped_cooldown' | 'skipped_rate_limit' | 'failed' | 'policy_auto_disabled' | 'docker_unavailable';
    reason: string;
    success: number;
    error: string | null;
    timestamp: number;
}

export interface Node {
    id: number;
    name: string;
    type: 'local' | 'remote';
    mode: NodeMode;
    compose_dir: string;
    is_default: boolean;
    status: 'online' | 'offline' | 'unknown';
    created_at: number;
    api_url?: string;
    api_token?: string;
    pilot_last_seen?: number | null;
    pilot_agent_version?: string | null;
    last_successful_contact?: number | null;
    cordoned: boolean;
    cordoned_at: number | null;
    cordoned_reason: string | null;
}

export interface StackRestartSummary {
    stackName: string;
    crash: number;
    autoheal: number;
    manual: number;
    total: number;
}

export interface PilotEnrollment {
    node_id: number;
    token_hash: string;
    expires_at: number;
    used_at: number | null;
}

export interface Label {
    id: number;
    node_id: number;
    name: string;
    color: string;
}

export type WebhookAction = 'deploy' | 'restart' | 'stop' | 'start' | 'pull' | 'git-pull';

export interface Webhook {
    id?: number;
    node_id: number;
    name: string;
    stack_name: string;
    action: WebhookAction;
    secret: string;
    enabled: boolean;
    created_at: number;
    updated_at: number;
}

export type GitSourceAuthType = 'none' | 'token';

export interface StackGitSource {
    id?: number;
    stack_name: string;
    repo_url: string;
    branch: string;
    compose_path: string;
    sync_env: boolean;
    env_path: string | null;
    auth_type: GitSourceAuthType;
    encrypted_token: string | null;
    auto_apply_on_webhook: boolean;
    auto_deploy_on_apply: boolean;
    last_applied_commit_sha: string | null;
    last_applied_content_hash: string | null;
    pending_commit_sha: string | null;
    pending_compose_content: string | null;
    pending_env_content: string | null;
    pending_fetched_at: number | null;
    last_debounce_at: number | null;
    created_at: number;
    updated_at: number;
}

export interface WebhookExecution {
    id?: number;
    webhook_id: number;
    action: string;
    status: 'success' | 'failure';
    trigger_source: string | null;
    duration_ms: number | null;
    error: string | null;
    executed_at: number;
}

export type AuthProvider = 'local' | 'ldap' | 'oidc_google' | 'oidc_github' | 'oidc_okta' | 'oidc_custom';

export type UserRole = 'admin' | 'viewer' | 'deployer' | 'node-admin' | 'auditor';
export type ResourceType = 'stack' | 'node';

export interface User {
    id: number;
    username: string;
    password_hash: string;
    role: UserRole;
    auth_provider: AuthProvider;
    provider_id: string | null;
    email: string | null;
    token_version: number;
    created_at: number;
    updated_at: number;
}

export interface UserMfa {
    user_id: number;
    enabled: number;
    totp_secret_encrypted: string | null;
    backup_codes_json: string | null;
    sso_enforce_mfa: number;
    failed_attempts: number;
    locked_until: number | null;
    created_at: number;
    updated_at: number;
}

export type UserMfaUpdate = Partial<{
    enabled: boolean;
    totp_secret_encrypted: string | null;
    backup_codes_json: string | null;
    sso_enforce_mfa: boolean;
    failed_attempts: number;
    locked_until: number | null;
}>;

export interface RoleAssignment {
    id: number;
    user_id: number;
    role: UserRole;
    resource_type: ResourceType;
    resource_id: string;
    created_at: number;
}

export interface SSOConfig {
    id: number;
    provider: string;
    enabled: number;
    config_json: string;
    created_at: number;
    updated_at: number;
}

export interface NotificationHistory {
    id?: number;
    level: 'info' | 'warning' | 'error';
    category?: string;
    message: string;
    timestamp: number;
    is_read: boolean;
    dispatch_error?: string;
    stack_name?: string;
    container_name?: string;
    actor_username?: string | null;
}

export interface FleetSnapshot {
    id: number;
    description: string;
    created_by: string;
    node_count: number;
    stack_count: number;
    skipped_nodes: string;
    created_at: number;
}

export interface FleetSnapshotFile {
    id: number;
    snapshot_id: number;
    node_id: number;
    node_name: string;
    stack_name: string;
    filename: string;
    content: string;
}

export type DriftMode = 'observe' | 'suggest' | 'enforce';
export type BlueprintClassification = 'stateless' | 'stateful' | 'unknown';
export type BlueprintDeploymentStatus =
    | 'pending'
    | 'pending_state_review'
    | 'deploying'
    | 'active'
    | 'drifted'
    | 'correcting'
    | 'failed'
    | 'withdrawing'
    | 'withdrawn'
    | 'evict_blocked'
    | 'name_conflict';

export type BlueprintSelector =
    | { type: 'labels'; any: string[]; all: string[] }
    | { type: 'nodes'; ids: number[] };

export interface NodeLabelRow {
    id: number;
    node_id: number;
    label: string;
    created_at: number;
}

export interface Blueprint {
    id: number;
    name: string;
    description: string | null;
    compose_content: string;
    selector: BlueprintSelector;
    drift_mode: DriftMode;
    classification: BlueprintClassification;
    classification_reasons: string[];
    enabled: boolean;
    revision: number;
    created_at: number;
    updated_at: number;
    created_by: string | null;
    pinned_node_id: number | null;
}

export interface BlueprintDeployment {
    id: number;
    blueprint_id: number;
    node_id: number;
    status: BlueprintDeploymentStatus;
    applied_revision: number | null;
    last_deployed_at: number | null;
    last_checked_at: number | null;
    last_drift_at: number | null;
    drift_summary: string | null;
    last_error: string | null;
}

export interface AuditLogEntry {
    id: number;
    timestamp: number;
    username: string;
    method: string;
    path: string;
    status_code: number;
    node_id: number | null;
    ip_address: string;
    summary: string;
}

export interface SecretRow {
    id: number;
    name: string;
    description: string;
    current_version: number;
    created_at: number;
    created_by: string;
    updated_at: number;
}

export interface SecretVersionRow {
    id: number;
    secret_id: number;
    version: number;
    encrypted_payload: string;
    key_count: number;
    created_at: number;
    created_by: string;
    note: string;
}

export type SecretPushStatus = 'ok' | 'failed' | 'skipped';

export interface SecretPushRow {
    id: number;
    secret_id: number;
    version: number;
    push_id: string;
    node_id: number;
    stack_name: string;
    env_file_basename: string;
    status: SecretPushStatus;
    error: string;
    added_count: number;
    changed_count: number;
    unchanged_count: number;
    pushed_by: string;
    pushed_at: number;
}

export type ApiTokenScope = 'read-only' | 'deploy-only' | 'full-admin';

/** Map an API token's scope to the synthesized user role used during request authorization. */
export const API_TOKEN_SCOPE_TO_ROLE: Record<ApiTokenScope, UserRole> = {
    'read-only': 'viewer',
    'deploy-only': 'deployer',
    'full-admin': 'admin',
};

export interface ApiToken {
    id: number;
    token_hash: string;
    name: string;
    scope: ApiTokenScope;
    user_id: number;
    created_at: number;
    last_used_at: number | null;
    expires_at: number | null;
    revoked_at: number | null;
}

export interface ScheduledTask {
    id: number;
    name: string;
    target_type: 'stack' | 'fleet' | 'system';
    target_id: string | null;
    node_id: number | null;
    action: 'restart' | 'snapshot' | 'prune' | 'update' | 'scan' | 'auto_backup' | 'auto_stop' | 'auto_down' | 'auto_start';
    cron_expression: string;
    enabled: number;
    created_by: string;
    created_at: number;
    updated_at: number;
    last_run_at: number | null;
    next_run_at: number | null;
    last_status: string | null;
    last_error: string | null;
    prune_targets: string | null;
    target_services: string | null;
    prune_label_filter: string | null;
    delete_after_run?: number;
}

export interface ScheduledTaskRun {
    id: number;
    task_id: number;
    started_at: number;
    completed_at: number | null;
    status: 'running' | 'success' | 'failure';
    output: string | null;
    error: string | null;
    triggered_by: 'scheduler' | 'manual';
}

export type RegistryType = 'dockerhub' | 'ghcr' | 'ecr' | 'custom';

export interface Registry {
    id: number;
    name: string;
    url: string;
    type: RegistryType;
    username: string;
    secret: string;
    aws_region: string | null;
    created_at: number;
    updated_at: number;
}

export interface NotificationRoute {
    id: number;
    name: string;
    node_id: number | null;
    stack_patterns: string[];
    label_ids: number[] | null;
    categories: string[] | null;
    channel_type: 'discord' | 'slack' | 'webhook';
    channel_url: string;
    priority: number;
    enabled: boolean;
    created_at: number;
    updated_at: number;
}

export type VulnSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
export type VulnScanStatus = 'in_progress' | 'completed' | 'failed';
export type VulnScanTrigger = 'manual' | 'scheduled' | 'deploy' | 'deploy-preflight';

/**
 * Decision recorded when a scan is evaluated against the matching policy.
 * Persisted as JSON on `vulnerability_scans.policy_evaluation` so the UI
 * can surface a banner on the scan details sheet without re-running the
 * match. `violated=false` rows exist too (informational), which is why
 * presence of the field does not mean "blocked".
 */
export interface PolicyEvaluation {
    policyId: number;
    policyName: string;
    maxSeverity: VulnSeverity;
    violated: boolean;
    evaluatedAt: number;
}

export interface VulnerabilityScan {
    id: number;
    node_id: number;
    image_ref: string;
    image_digest: string | null;
    scanned_at: number;
    total_vulnerabilities: number;
    critical_count: number;
    high_count: number;
    medium_count: number;
    low_count: number;
    unknown_count: number;
    fixable_count: number;
    secret_count: number;
    misconfig_count: number;
    scanners_used: string;
    highest_severity: VulnSeverity | null;
    os_info: string | null;
    trivy_version: string | null;
    scan_duration_ms: number | null;
    triggered_by: VulnScanTrigger;
    status: VulnScanStatus;
    error: string | null;
    stack_context: string | null;
    // JSON-encoded PolicyEvaluation; null if never evaluated.
    policy_evaluation: string | null;
}

export function parsePolicyEvaluation(raw: string | null | undefined): PolicyEvaluation | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as PolicyEvaluation;
        if (typeof parsed.policyId !== 'number' || typeof parsed.policyName !== 'string') {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

export interface VulnerabilityDetail {
    id: number;
    scan_id: number;
    vulnerability_id: string;
    pkg_name: string;
    installed_version: string;
    fixed_version: string | null;
    severity: VulnSeverity;
    title: string | null;
    description: string | null;
    primary_url: string | null;
}

export interface SecretFinding {
    id: number;
    scan_id: number;
    rule_id: string;
    category: string | null;
    severity: VulnSeverity;
    title: string | null;
    target: string;
    start_line: number | null;
    end_line: number | null;
    match_excerpt: string | null;
}

export interface MisconfigFinding {
    id: number;
    scan_id: number;
    rule_id: string;
    check_id: string | null;
    severity: VulnSeverity;
    title: string | null;
    message: string | null;
    resolution: string | null;
    target: string;
    primary_url: string | null;
}

export interface ScanPolicy {
    id: number;
    name: string;
    node_id: number | null;
    node_identity: string;
    stack_pattern: string | null;
    max_severity: VulnSeverity;
    block_on_deploy: number;
    enabled: number;
    replicated_from_control: number;
    created_at: number;
    updated_at: number;
}

export interface FleetSyncStatus {
    node_id: number;
    resource: string;
    last_success_at: number | null;
    last_failure_at: number | null;
    last_error: string | null;
    sticky_error_code: string | null;
    sticky_error_expected: string | null;
    sticky_error_got: string | null;
}

export interface CveSuppression {
    id: number;
    cve_id: string;
    pkg_name: string | null;
    image_pattern: string | null;
    reason: string;
    created_by: string;
    created_at: number;
    expires_at: number | null;
    replicated_from_control: number;
}

/**
 * Operator-acknowledged misconfiguration finding. Acknowledgements match by
 * rule_id and an optional stack_pattern glob, are applied at read time, and
 * never modify the persisted finding row. Mirrors `cve_suppressions` shape.
 */
export interface MisconfigAcknowledgement {
    id: number;
    rule_id: string;
    stack_pattern: string | null;
    reason: string;
    created_by: string;
    created_at: number;
    expires_at: number | null;
    replicated_from_control: number;
}

export interface ScanSummary {
    image_ref: string;
    highest_severity: VulnSeverity | null;
    total: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    unknown: number;
    fixable: number;
    scanned_at: number;
    scan_id: number;
}

// Audit log buffering: writes are batched into a transaction either after
// AUDIT_LOG_FLUSH_INTERVAL_MS or once the buffer hits AUDIT_LOG_FLUSH_THRESHOLD,
// whichever comes first. Without this, every mutating /api/* request runs an
// individual INSERT and serializes against other writers under burst load
// (SQLite's single-writer model). All read paths (getAuditLogs,
// getAuditLogsInRange, cleanupOldAuditLogs) drain the buffer first so callers
// always observe a consistent view.
const AUDIT_LOG_FLUSH_INTERVAL_MS = 1_000;
const AUDIT_LOG_FLUSH_THRESHOLD = 100;

// Upper bound on the rows the anomaly baseline / stats computations pull into
// memory for a single request. The audit table grows unbounded within the
// retention window, and the analysis paths run on every list page and every
// stats refresh, so without a cap a busy fleet would scan the whole window into
// a JS array each time. When the window holds more than this, the most-recent
// rows are used and baselines become an approximation over recent activity.
export const AUDIT_ANOMALY_HISTORY_CAP = 20_000;

export const PILOT_METRICS_COUNTERS_KEY = 'pilot_metrics_counters';

export class DatabaseService {
    private static instance: DatabaseService;
    private db: Database.Database;
    // Cache of the global_settings table, populated on first read and
    // invalidated by updateGlobalSetting(). Hot paths (auth middleware,
    // WS upgrade, the audit-log debug gate) read this on every request,
    // so the round-trip to SQLite is worth eliminating. Assumes this
    // process is the sole writer to global_settings; sidecar tools that
    // edit the row directly will not invalidate the cache.
    private cachedGlobalSettings: Readonly<Record<string, string>> | null = null;
    private auditLogBuffer: Array<Omit<AuditLogEntry, 'id'>> = [];
    private auditLogFlushTimer: ReturnType<typeof setTimeout> | null = null;
    private auditLogInsertStmt: Database.Statement | null = null;

    private constructor() {
        const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');

        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }

        const dbPath = path.join(dataDir, 'sencho.db');
        this.db = new Database(dbPath);

        this.initSchema();
        this.migrateJsonConfig(dataDir);
        this.migrateAdminToUsersTable();
        this.migrateEncryptNodeTokens();
        this.migrateSSOColumns();
        this.migrateRegistries();
        this.migrateRoleAssignments();
        this.migrateNotificationRoutes();
        this.migrateNotificationRoutesNodeId();
        this.migrateNotificationRoutesMatchers();
        this.migrateNotificationHistoryContext();
        this.migrateScanPolicyFleetColumns();
        this.migrateSecretMisconfigColumns();
        this.migrateAgentsAndNotificationsNodeId();
        this.migratePolicyEvaluationColumn();
        this.migrateNotificationCategory();
        this.migrateNotificationActor();
        this.migrateMeshTables();
        this.migrateNodeLabels();
        this.migrateBlueprints();
        this.migrateAddNodeLastContact();
        this.migrateAddNodeCordonFields();
        this.migrateAddBlueprintPinnedNode();
        this.migrateAutoHealNodeId();
        this.migrateFleetSyncStickyError();

        // Reset the cache once at end of constructor in case any migration
        // populated it via getGlobalSettings() and a subsequent migration
        // changed the underlying rows.
        this.cachedGlobalSettings = null;
    }

    public static getInstance(): DatabaseService {
        if (!DatabaseService.instance) {
            DatabaseService.instance = new DatabaseService();
        }
        return DatabaseService.instance;
    }

    public getDb(): Database.Database {
        return this.db;
    }

    private initSchema() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id INTEGER NOT NULL DEFAULT 0,
        type TEXT NOT NULL,
        url TEXT NOT NULL,
        enabled INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS global_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS stack_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stack_name TEXT NOT NULL,
        metric TEXT NOT NULL,
        operator TEXT NOT NULL,
        threshold REAL NOT NULL,
        duration_mins INTEGER NOT NULL,
        cooldown_mins INTEGER NOT NULL,
        last_fired_at INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS notification_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id INTEGER NOT NULL DEFAULT 0,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        is_read INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS container_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        container_id TEXT NOT NULL,
        stack_name TEXT NOT NULL,
        cpu_percent REAL NOT NULL,
        memory_mb REAL NOT NULL,
        net_rx_mb REAL NOT NULL,
        net_tx_mb REAL NOT NULL,
        timestamp INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON container_metrics(timestamp);
      CREATE INDEX IF NOT EXISTS idx_metrics_container ON container_metrics(container_id);

      CREATE TABLE IF NOT EXISTS stack_update_status (
        node_id INTEGER NOT NULL DEFAULT 0,
        stack_name TEXT NOT NULL,
        has_update INTEGER DEFAULT 0,
        checked_at INTEGER NOT NULL,
        PRIMARY KEY (node_id, stack_name)
      );

      CREATE TABLE IF NOT EXISTS stack_scan_attempts (
        node_id INTEGER NOT NULL DEFAULT 0,
        stack_name TEXT NOT NULL,
        status TEXT NOT NULL,
        attempted_at INTEGER NOT NULL,
        error_message TEXT,
        PRIMARY KEY (node_id, stack_name)
      );

      CREATE TABLE IF NOT EXISTS nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL DEFAULT 'local',
        compose_dir TEXT NOT NULL DEFAULT '/app/compose',
        is_default INTEGER DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'unknown',
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pilot_enrollments (
        node_id INTEGER PRIMARY KEY,
        token_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS system_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS webhooks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id INTEGER,
        name TEXT NOT NULL,
        stack_name TEXT NOT NULL,
        action TEXT NOT NULL DEFAULT 'deploy',
        secret TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS webhook_executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        webhook_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        trigger_source TEXT,
        duration_ms INTEGER,
        error TEXT,
        executed_at INTEGER NOT NULL,
        FOREIGN KEY(webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_webhook_executions_webhook ON webhook_executions(webhook_id);

      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'admin',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fleet_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        description TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL,
        node_count INTEGER NOT NULL,
        stack_count INTEGER NOT NULL,
        skipped_nodes TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fleet_snapshot_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_id INTEGER NOT NULL,
        node_id INTEGER NOT NULL,
        node_name TEXT NOT NULL,
        stack_name TEXT NOT NULL,
        filename TEXT NOT NULL,
        content TEXT NOT NULL,
        FOREIGN KEY(snapshot_id) REFERENCES fleet_snapshots(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_snapshot_files_snapshot ON fleet_snapshot_files(snapshot_id);

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        username TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        status_code INTEGER NOT NULL DEFAULT 0,
        node_id INTEGER,
        ip_address TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_log_username ON audit_log(username);

      CREATE TABLE IF NOT EXISTS api_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'read-only',
        user_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        expires_at INTEGER,
        revoked_at INTEGER,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);
      CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);

      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT,
        node_id INTEGER,
        action TEXT NOT NULL,
        cron_expression TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_run_at INTEGER,
        next_run_at INTEGER,
        last_status TEXT,
        last_error TEXT
      );

      CREATE TABLE IF NOT EXISTS scheduled_task_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        status TEXT NOT NULL DEFAULT 'running',
        output TEXT,
        error TEXT,
        FOREIGN KEY(task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_task ON scheduled_task_runs(task_id);
      CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_status ON scheduled_task_runs(status);
      CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_run ON scheduled_tasks(next_run_at);

      CREATE TABLE IF NOT EXISTS vulnerability_scans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id INTEGER NOT NULL,
        image_ref TEXT NOT NULL,
        image_digest TEXT,
        scanned_at INTEGER NOT NULL,
        total_vulnerabilities INTEGER NOT NULL DEFAULT 0,
        critical_count INTEGER NOT NULL DEFAULT 0,
        high_count INTEGER NOT NULL DEFAULT 0,
        medium_count INTEGER NOT NULL DEFAULT 0,
        low_count INTEGER NOT NULL DEFAULT 0,
        unknown_count INTEGER NOT NULL DEFAULT 0,
        fixable_count INTEGER NOT NULL DEFAULT 0,
        secret_count INTEGER NOT NULL DEFAULT 0,
        misconfig_count INTEGER NOT NULL DEFAULT 0,
        scanners_used TEXT NOT NULL DEFAULT 'vuln',
        highest_severity TEXT,
        os_info TEXT,
        trivy_version TEXT,
        scan_duration_ms INTEGER,
        triggered_by TEXT NOT NULL DEFAULT 'manual',
        status TEXT NOT NULL DEFAULT 'completed',
        error TEXT,
        stack_context TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_vuln_scans_node_image ON vulnerability_scans(node_id, image_ref);
      CREATE INDEX IF NOT EXISTS idx_vuln_scans_digest ON vulnerability_scans(image_digest);
      CREATE INDEX IF NOT EXISTS idx_vuln_scans_scanned_at ON vulnerability_scans(scanned_at);
      CREATE INDEX IF NOT EXISTS idx_vuln_scans_status ON vulnerability_scans(status);

      CREATE TABLE IF NOT EXISTS vulnerability_details (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scan_id INTEGER NOT NULL,
        vulnerability_id TEXT NOT NULL,
        pkg_name TEXT NOT NULL,
        installed_version TEXT NOT NULL,
        fixed_version TEXT,
        severity TEXT NOT NULL,
        title TEXT,
        description TEXT,
        primary_url TEXT,
        FOREIGN KEY(scan_id) REFERENCES vulnerability_scans(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_vuln_details_scan ON vulnerability_details(scan_id);
      CREATE INDEX IF NOT EXISTS idx_vuln_details_severity ON vulnerability_details(severity);

      CREATE TABLE IF NOT EXISTS secret_findings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scan_id INTEGER NOT NULL,
        rule_id TEXT NOT NULL,
        category TEXT,
        severity TEXT NOT NULL,
        title TEXT,
        target TEXT NOT NULL,
        start_line INTEGER,
        end_line INTEGER,
        match_excerpt TEXT,
        FOREIGN KEY(scan_id) REFERENCES vulnerability_scans(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_secret_findings_scan ON secret_findings(scan_id);

      CREATE TABLE IF NOT EXISTS misconfig_findings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scan_id INTEGER NOT NULL,
        rule_id TEXT NOT NULL,
        check_id TEXT,
        severity TEXT NOT NULL,
        title TEXT,
        message TEXT,
        resolution TEXT,
        target TEXT NOT NULL,
        primary_url TEXT,
        FOREIGN KEY(scan_id) REFERENCES vulnerability_scans(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_misconfig_findings_scan ON misconfig_findings(scan_id);

      CREATE TABLE IF NOT EXISTS scan_policies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        node_id INTEGER,
        stack_pattern TEXT,
        max_severity TEXT NOT NULL DEFAULT 'CRITICAL',
        block_on_deploy INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fleet_sync_status (
        node_id INTEGER NOT NULL,
        resource TEXT NOT NULL,
        last_success_at INTEGER,
        last_failure_at INTEGER,
        last_error TEXT,
        PRIMARY KEY (node_id, resource)
      );

      CREATE TABLE IF NOT EXISTS cve_suppressions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cve_id TEXT NOT NULL,
        pkg_name TEXT,
        image_pattern TEXT,
        reason TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        replicated_from_control INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_cve_suppressions_cve ON cve_suppressions(cve_id);
      CREATE INDEX IF NOT EXISTS idx_cve_suppressions_expires ON cve_suppressions(expires_at);
      -- COALESCE makes NULL scope slots collide the way users expect (NULL == NULL here).
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cve_suppressions_unique
        ON cve_suppressions(cve_id, COALESCE(pkg_name, ''), COALESCE(image_pattern, ''));

      CREATE TABLE IF NOT EXISTS misconfig_acknowledgements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id TEXT NOT NULL,
        stack_pattern TEXT,
        reason TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        replicated_from_control INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_misconfig_ack_rule ON misconfig_acknowledgements(rule_id);
      CREATE INDEX IF NOT EXISTS idx_misconfig_ack_expires ON misconfig_acknowledgements(expires_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_misconfig_ack_unique
        ON misconfig_acknowledgements(rule_id, COALESCE(stack_pattern, ''));

      CREATE TABLE IF NOT EXISTS stack_labels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id INTEGER NOT NULL DEFAULT 0,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        UNIQUE(node_id, name)
      );

      CREATE TABLE IF NOT EXISTS stack_label_assignments (
        label_id INTEGER NOT NULL REFERENCES stack_labels(id) ON DELETE CASCADE,
        stack_name TEXT NOT NULL,
        node_id INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (label_id, stack_name, node_id)
      );

      CREATE INDEX IF NOT EXISTS idx_label_assignments_stack
        ON stack_label_assignments(stack_name, node_id);

      CREATE TABLE IF NOT EXISTS user_mfa (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 0,
        totp_secret_encrypted TEXT,
        backup_codes_json TEXT,
        sso_enforce_mfa INTEGER NOT NULL DEFAULT 0,
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mfa_used_tokens (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code TEXT NOT NULL,
        window INTEGER NOT NULL,
        used_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, code, window)
      );

      CREATE INDEX IF NOT EXISTS idx_mfa_used_tokens_used_at ON mfa_used_tokens(used_at);

      CREATE TABLE IF NOT EXISTS stack_git_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stack_name TEXT NOT NULL UNIQUE,
        repo_url TEXT NOT NULL,
        branch TEXT NOT NULL,
        compose_path TEXT NOT NULL,
        sync_env INTEGER NOT NULL DEFAULT 0,
        env_path TEXT,
        auth_type TEXT NOT NULL DEFAULT 'none',
        encrypted_token TEXT,
        auto_apply_on_webhook INTEGER NOT NULL DEFAULT 0,
        auto_deploy_on_apply INTEGER NOT NULL DEFAULT 0,
        last_applied_commit_sha TEXT,
        last_applied_content_hash TEXT,
        pending_commit_sha TEXT,
        pending_compose_content TEXT,
        pending_env_content TEXT,
        pending_fetched_at INTEGER,
        last_debounce_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS auto_heal_policies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id INTEGER NOT NULL DEFAULT 1,
        proxy_entitled_until INTEGER NOT NULL DEFAULT 0,
        stack_name TEXT NOT NULL,
        service_name TEXT,
        unhealthy_duration_mins INTEGER NOT NULL,
        cooldown_mins INTEGER NOT NULL DEFAULT 5,
        max_restarts_per_hour INTEGER NOT NULL DEFAULT 3,
        auto_disable_after_failures INTEGER NOT NULL DEFAULT 5,
        enabled INTEGER NOT NULL DEFAULT 1,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_fired_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS auto_heal_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        policy_id INTEGER NOT NULL,
        stack_name TEXT NOT NULL,
        service_name TEXT,
        container_name TEXT NOT NULL,
        container_id TEXT NOT NULL,
        action TEXT NOT NULL,
        reason TEXT NOT NULL,
        success INTEGER NOT NULL,
        error TEXT,
        timestamp INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_auto_heal_history_policy_ts
        ON auto_heal_history(policy_id, timestamp DESC);

      CREATE TABLE IF NOT EXISTS secrets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        current_version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        created_by TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_secrets_name ON secrets(name);

      CREATE TABLE IF NOT EXISTS secret_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        secret_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        encrypted_payload TEXT NOT NULL,
        key_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        created_by TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        UNIQUE(secret_id, version),
        FOREIGN KEY(secret_id) REFERENCES secrets(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_secret_versions_secret ON secret_versions(secret_id);

      CREATE TABLE IF NOT EXISTS secret_pushes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        secret_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        push_id TEXT NOT NULL,
        node_id INTEGER NOT NULL,
        stack_name TEXT NOT NULL,
        env_file_basename TEXT NOT NULL DEFAULT '.env',
        status TEXT NOT NULL,
        error TEXT NOT NULL DEFAULT '',
        added_count INTEGER NOT NULL DEFAULT 0,
        changed_count INTEGER NOT NULL DEFAULT 0,
        unchanged_count INTEGER NOT NULL DEFAULT 0,
        pushed_by TEXT NOT NULL,
        pushed_at INTEGER NOT NULL,
        FOREIGN KEY(secret_id) REFERENCES secrets(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_secret_pushes_push ON secret_pushes(push_id);
      CREATE INDEX IF NOT EXISTS idx_secret_pushes_secret_version ON secret_pushes(secret_id, version);
      CREATE INDEX IF NOT EXISTS idx_secret_pushes_node ON secret_pushes(node_id, stack_name);
    `);

        // Apply migrations safely (ignore if columns already exist)
        const maybeAddCol = (table: string, col: string, def: string) => {
            try { this.db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run(); } catch (e) { /* ignore */ }
        };

        // Distributed API model columns
        maybeAddCol('nodes', 'api_url', "TEXT DEFAULT ''");
        maybeAddCol('nodes', 'api_token', "TEXT DEFAULT ''");
        maybeAddCol('webhooks', 'node_id', 'INTEGER');
        this.db.prepare(`
          UPDATE webhooks
          SET node_id = COALESCE((SELECT id FROM nodes WHERE is_default = 1 LIMIT 1), 1)
          WHERE node_id IS NULL
        `).run();

        // Pilot Agent outbound-mode columns
        maybeAddCol('nodes', 'mode', "TEXT NOT NULL DEFAULT 'proxy'");
        maybeAddCol('nodes', 'pilot_last_seen', 'INTEGER');
        maybeAddCol('nodes', 'pilot_agent_version', 'TEXT');

        // Scheduled operations migrations
        maybeAddCol('scheduled_task_runs', 'triggered_by', "TEXT NOT NULL DEFAULT 'scheduler'");
        maybeAddCol('scheduled_tasks', 'prune_targets', 'TEXT DEFAULT NULL');
        maybeAddCol('scheduled_tasks', 'target_services', 'TEXT DEFAULT NULL');
        maybeAddCol('scheduled_tasks', 'prune_label_filter', 'TEXT DEFAULT NULL');
        maybeAddCol('scheduled_tasks', 'delete_after_run', 'INTEGER DEFAULT 0');

        // Recreate stack_update_status with composite PK (node_id, stack_name).
        // Original table had stack_name as sole PK which breaks when multiple nodes share stack names.
        const susInfo = this.db.pragma('table_info(stack_update_status)') as Array<{ name: string; pk: number }>;
        const needsRecreate = susInfo.some(c => c.name === 'stack_name' && c.pk === 1) && !susInfo.some(c => c.name === 'node_id' && c.pk > 0);
        if (needsRecreate) {
          this.db.exec(`
            CREATE TABLE stack_update_status_new (
              node_id INTEGER NOT NULL DEFAULT 0,
              stack_name TEXT NOT NULL,
              has_update INTEGER DEFAULT 0,
              checked_at INTEGER NOT NULL,
              PRIMARY KEY (node_id, stack_name)
            );
            INSERT OR IGNORE INTO stack_update_status_new (node_id, stack_name, has_update, checked_at)
              SELECT COALESCE(node_id, 0), stack_name, has_update, checked_at FROM stack_update_status;
            DROP TABLE stack_update_status;
            ALTER TABLE stack_update_status_new RENAME TO stack_update_status;
          `);
        }

        // Drop legacy SSH/TLS columns from pre-0.7 databases (no longer read or written)
        const legacyCols = ['host', 'port', 'ssh_port', 'ssh_user', 'ssh_password', 'ssh_key', 'tls_ca', 'tls_cert', 'tls_key'];
        for (const col of legacyCols) {
            try { this.db.prepare(`ALTER TABLE nodes DROP COLUMN ${col}`).run(); } catch (e: unknown) {
                // Expected: column already dropped or never existed
                if (!String((e as Error)?.message).includes('no such column')) {
                    console.warn(`[DatabaseService] Unexpected error dropping legacy column "${col}":`, (e as Error).message);
                }
            }
        }

        // Initialize default global settings if they don't exist
        const stmt = this.db.prepare('INSERT OR IGNORE INTO global_settings (key, value) VALUES (?, ?)');
        stmt.run('host_cpu_limit', '90');
        stmt.run('host_ram_limit', '90');
        stmt.run('host_disk_limit', '90');
        stmt.run('host_alert_suppression_mins', '60');
        stmt.run('global_crash', '1');
        stmt.run('docker_janitor_gb', '5');
        stmt.run('developer_mode', '0');
        stmt.run('metrics_retention_hours', '24');
        stmt.run('log_retention_days', '30');
        stmt.run('scan_history_per_image_limit', '50');
        stmt.run('trivy_auto_update', '0');
        stmt.run('trivy_last_notified_version', '');
        stmt.run('mesh_auto_recreate', '0');

        // Seed the default local node if none exists
        const nodeCount = (this.db.prepare('SELECT COUNT(*) as count FROM nodes').get() as any)?.count || 0;
        if (nodeCount === 0) {
            this.db.prepare(
                'INSERT INTO nodes (name, type, compose_dir, is_default, status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
            ).run('Local', 'local', process.env.COMPOSE_DIR || '/app/compose', 1, 'online', Date.now());
        }
    }

    private migrateAdminToUsersTable(): void {
        const userCount = (this.db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number })?.count || 0;
        if (userCount > 0) return;

        const settings = this.getGlobalSettings();
        const username = settings.auth_username;
        const passwordHash = settings.auth_password_hash;
        if (!username || !passwordHash) return;

        const now = Date.now();
        this.db.prepare(
            'INSERT INTO users (username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
        ).run(username, passwordHash, 'admin', now, now);
        console.log('Migrated legacy admin user to users table.');
    }

    private migrateJsonConfig(dataDir: string) {
        const configPath = path.join(dataDir, 'sencho.json');
        if (fs.existsSync(configPath)) {
            try {
                const data = fs.readFileSync(configPath, 'utf-8');
                const config = JSON.parse(data);

                if (config.username && config.passwordHash && config.jwtSecret) {
                    const stmt = this.db.prepare('INSERT OR IGNORE INTO global_settings (key, value) VALUES (?, ?)');
                    stmt.run('auth_username', config.username);
                    stmt.run('auth_password_hash', config.passwordHash);
                    stmt.run('auth_jwt_secret', config.jwtSecret);

                    console.log('Successfully migrated sencho.json credentials to SQLite global_settings.');
                    fs.unlinkSync(configPath);
                }
            } catch (err) {
                console.error('Failed to migrate sencho.json:', err);
            }
        }
    }

    private migrateEncryptNodeTokens(): void {
        const crypto = CryptoService.getInstance();
        const rows = this.db.prepare("SELECT id, api_token FROM nodes WHERE api_token != '' AND api_token IS NOT NULL").all() as Array<{ id: number; api_token: string }>;
        for (const row of rows) {
            if (!crypto.isEncrypted(row.api_token)) {
                const encrypted = crypto.encrypt(row.api_token);
                this.db.prepare('UPDATE nodes SET api_token = ? WHERE id = ?').run(encrypted, row.id);
            }
        }
    }

    private migrateSSOColumns(): void {
        const maybeAddCol = (table: string, col: string, def: string) => {
            try { this.db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run(); } catch (e: unknown) {
                // Expected: column already exists
                if (!String((e as Error)?.message).includes('duplicate column')) {
                    console.warn(`[DatabaseService] Unexpected error adding column "${col}" to "${table}":`, (e as Error).message);
                }
            }
        };
        maybeAddCol('users', 'auth_provider', "TEXT NOT NULL DEFAULT 'local'");
        maybeAddCol('users', 'provider_id', 'TEXT DEFAULT NULL');
        maybeAddCol('users', 'email', 'TEXT DEFAULT NULL');
        maybeAddCol('users', 'token_version', 'INTEGER NOT NULL DEFAULT 1');

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS sso_config (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                provider TEXT NOT NULL UNIQUE,
                enabled INTEGER DEFAULT 0,
                config_json TEXT NOT NULL DEFAULT '{}',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_users_provider ON users(auth_provider, provider_id) WHERE provider_id IS NOT NULL;
        `);
    }

    private migrateRegistries(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS registries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                url TEXT NOT NULL,
                type TEXT NOT NULL DEFAULT 'custom',
                username TEXT NOT NULL DEFAULT '',
                secret TEXT NOT NULL DEFAULT '',
                aws_region TEXT DEFAULT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
        `);
    }

    private migrateRoleAssignments(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS role_assignments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                role TEXT NOT NULL,
                resource_type TEXT NOT NULL,
                resource_id TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_role_assignments_user ON role_assignments(user_id);
            CREATE INDEX IF NOT EXISTS idx_role_assignments_resource ON role_assignments(resource_type, resource_id);
        `);
        try {
            this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_role_assignments_unique ON role_assignments(user_id, role, resource_type, resource_id)');
        } catch (e) {
            console.warn('[DatabaseService] Could not create role_assignments unique index:', (e as Error).message);
        }
    }

    private migrateNotificationRoutes(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS notification_routes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                stack_patterns TEXT NOT NULL,
                channel_type TEXT NOT NULL,
                channel_url TEXT NOT NULL,
                priority INTEGER NOT NULL DEFAULT 0,
                enabled INTEGER DEFAULT 1,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_notification_routes_priority ON notification_routes(priority);
        `);
        // Track external dispatch errors on notification records
        try { this.db.prepare('ALTER TABLE notification_history ADD COLUMN dispatch_error TEXT').run(); } catch { /* already exists */ }
    }

    private migrateNotificationRoutesNodeId(): void {
        try {
            this.db.prepare('ALTER TABLE notification_routes ADD COLUMN node_id INTEGER NULL').run();
        } catch {
            // column already present
        }
        this.db.prepare('CREATE INDEX IF NOT EXISTS idx_notification_routes_node_priority ON notification_routes(node_id, enabled, priority)').run();
    }

    private tryAddColumn(table: string, col: string, def: string): boolean {
        try {
            this.db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run();
            return true;
        } catch (err) {
            const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
            if (!message.includes('duplicate column name')) throw err;
            return false;
        }
    }

    private migrateNotificationRoutesMatchers(): void {
        this.tryAddColumn('notification_routes', 'label_ids', 'TEXT NULL');
        this.tryAddColumn('notification_routes', 'categories', 'TEXT NULL');
    }

    private migrateNotificationHistoryContext(): void {
        this.tryAddColumn('notification_history', 'stack_name', 'TEXT');
        this.tryAddColumn('notification_history', 'container_name', 'TEXT');
    }

    private migrateScanPolicyFleetColumns(): void {
        this.tryAddColumn('scan_policies', 'node_identity', "TEXT NOT NULL DEFAULT ''");
        this.tryAddColumn('scan_policies', 'replicated_from_control', 'INTEGER NOT NULL DEFAULT 0');
    }

    private migrateSecretMisconfigColumns(): void {
        this.tryAddColumn('vulnerability_scans', 'secret_count', 'INTEGER NOT NULL DEFAULT 0');
        this.tryAddColumn('vulnerability_scans', 'misconfig_count', 'INTEGER NOT NULL DEFAULT 0');
        this.tryAddColumn('vulnerability_scans', 'scanners_used', "TEXT NOT NULL DEFAULT 'vuln'");
    }

    private migrateAgentsAndNotificationsNodeId(): void {
        this.tryAddColumn('agents', 'node_id', 'INTEGER NOT NULL DEFAULT 0');
        this.tryAddColumn('notification_history', 'node_id', 'INTEGER NOT NULL DEFAULT 0');
        const tryIndex = (sql: string, label: string) => {
            try {
                this.db.prepare(sql).run();
            } catch (e) {
                console.warn(`[DatabaseService] Could not create ${label}:`, (e as Error).message);
            }
        };
        tryIndex(
            'CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_node_type ON agents(node_id, type)',
            'agents(node_id, type) unique index',
        );
        tryIndex(
            'CREATE INDEX IF NOT EXISTS idx_notif_history_node_timestamp ON notification_history(node_id, timestamp DESC)',
            'notification_history(node_id, timestamp) index',
        );
    }

    private migratePolicyEvaluationColumn(): void {
        try {
            this.db
                .prepare('ALTER TABLE vulnerability_scans ADD COLUMN policy_evaluation TEXT')
                .run();
        } catch {
            /* column already present */
        }
    }

    private migrateNotificationCategory(): void {
        try {
            this.db.prepare('ALTER TABLE notification_history ADD COLUMN category TEXT').run();
        } catch {
            // column already present
        }
    }

    private migrateNotificationActor(): void {
        this.tryAddColumn('notification_history', 'actor_username', 'TEXT');
        try {
            this.db.prepare(
                'CREATE INDEX IF NOT EXISTS idx_notif_history_node_stack_ts ON notification_history(node_id, stack_name, timestamp DESC) WHERE stack_name IS NOT NULL'
            ).run();
        } catch {
            // index already present or partial-index syntax unsupported
        }
    }

    private migrateMeshTables(): void {
        try {
            if (isPilotMode()) {
                // Per C-3 design, mesh state lives on central. Pilots never write
                // to mesh_stacks; alias data arrives via the D-1 override push
                // and lives in MeshService.pilotAliasOverlay. Drop any leftover
                // rows from a prior central-mode boot and skip the CREATE.
                this.db.prepare('DROP TABLE IF EXISTS mesh_stacks').run();
            } else {
                this.db.prepare(`
                    CREATE TABLE IF NOT EXISTS mesh_stacks (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        node_id INTEGER NOT NULL,
                        stack_name TEXT NOT NULL,
                        created_at INTEGER NOT NULL,
                        created_by TEXT,
                        UNIQUE(node_id, stack_name),
                        FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
                    )
                `).run();
                this.db.prepare('CREATE INDEX IF NOT EXISTS idx_mesh_stacks_node ON mesh_stacks(node_id)').run();
            }
        } catch (e) {
            console.warn('[DatabaseService] mesh_stacks migration:', (e as Error).message);
        }
        // mesh_centrals was the peer-side cache of the reverse-callback JWT
        // (central → peer bootstrap material). Peer→central traffic now
        // multiplexes over the existing forward WS via `tcp_open_reverse`,
        // so the table is no longer written or read. Drop it on every boot;
        // idempotent.
        try { this.db.prepare('DROP TABLE IF EXISTS mesh_centrals').run(); }
        catch (e) { console.warn('[DatabaseService] Could not drop mesh_centrals:', (e as Error).message); }
        this.tryAddColumn('nodes', 'mesh_enabled', 'INTEGER NOT NULL DEFAULT 0');
    }

    private migrateNodeLabels(): void {
        try {
            this.db.prepare(`
                CREATE TABLE IF NOT EXISTS node_labels (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    node_id INTEGER NOT NULL,
                    label TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    UNIQUE(node_id, label),
                    FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
                )
            `).run();
            this.db.prepare('CREATE INDEX IF NOT EXISTS idx_node_labels_node ON node_labels(node_id)').run();
            this.db.prepare('CREATE INDEX IF NOT EXISTS idx_node_labels_label ON node_labels(label)').run();
        } catch (e) {
            console.warn('[DatabaseService] Could not create node_labels:', (e as Error).message);
        }
    }

    private migrateBlueprints(): void {
        try {
            this.db.prepare(`
                CREATE TABLE IF NOT EXISTS blueprints (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    description TEXT,
                    compose_content TEXT NOT NULL,
                    selector_json TEXT NOT NULL,
                    drift_mode TEXT NOT NULL DEFAULT 'suggest',
                    classification TEXT NOT NULL DEFAULT 'unknown',
                    classification_reasons TEXT,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    revision INTEGER NOT NULL DEFAULT 1,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    created_by TEXT
                )
            `).run();
            this.db.prepare('CREATE INDEX IF NOT EXISTS idx_blueprints_enabled ON blueprints(enabled)').run();
        } catch (e) {
            console.warn('[DatabaseService] Could not create blueprints:', (e as Error).message);
        }
        try {
            this.db.prepare(`
                CREATE TABLE IF NOT EXISTS blueprint_deployments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    blueprint_id INTEGER NOT NULL,
                    node_id INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    applied_revision INTEGER,
                    last_deployed_at INTEGER,
                    last_checked_at INTEGER,
                    last_drift_at INTEGER,
                    drift_summary TEXT,
                    last_error TEXT,
                    UNIQUE(blueprint_id, node_id),
                    FOREIGN KEY (blueprint_id) REFERENCES blueprints(id) ON DELETE CASCADE,
                    FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
                )
            `).run();
            this.db.prepare('CREATE INDEX IF NOT EXISTS idx_blueprint_deployments_blueprint ON blueprint_deployments(blueprint_id)').run();
            this.db.prepare('CREATE INDEX IF NOT EXISTS idx_blueprint_deployments_node ON blueprint_deployments(node_id)').run();
            this.db.prepare('CREATE INDEX IF NOT EXISTS idx_blueprint_deployments_status ON blueprint_deployments(status)').run();
        } catch (e) {
            console.warn('[DatabaseService] Could not create blueprint_deployments:', (e as Error).message);
        }
    }

    private migrateAddNodeLastContact(): void {
        this.tryAddColumn('nodes', 'last_successful_contact', 'INTEGER');
    }

    private migrateAddNodeCordonFields(): void {
        this.tryAddColumn('nodes', 'cordoned', 'INTEGER NOT NULL DEFAULT 0');
        this.tryAddColumn('nodes', 'cordoned_at', 'INTEGER');
        this.tryAddColumn('nodes', 'cordoned_reason', 'TEXT');
    }

    private migrateAddBlueprintPinnedNode(): void {
        this.tryAddColumn('blueprints', 'pinned_node_id', 'INTEGER');
    }

    private migrateFleetSyncStickyError(): void {
        this.tryAddColumn('fleet_sync_status', 'sticky_error_code', 'TEXT');
        this.tryAddColumn('fleet_sync_status', 'sticky_error_expected', 'TEXT');
        this.tryAddColumn('fleet_sync_status', 'sticky_error_got', 'TEXT');
    }

    private migrateAutoHealNodeId(): void {
        const markerKey = 'migration_auto_heal_node_scope_v1';
        const markerDone = this.getGlobalSettings()[markerKey] === '1';
        this.tryAddColumn('auto_heal_policies', 'node_id', 'INTEGER NOT NULL DEFAULT 1');
        this.tryAddColumn('auto_heal_policies', 'proxy_entitled_until', 'INTEGER NOT NULL DEFAULT 0');
        if (!markerDone) {
            const defaultNode = this.getDefaultNode();
            if (defaultNode?.id) {
                this.db.transaction(() => {
                    this.db.prepare('UPDATE auto_heal_policies SET node_id = ? WHERE node_id IS NULL OR node_id = 1').run(defaultNode.id);
                    this.updateGlobalSetting(markerKey, '1');
                })();
            } else {
                this.updateGlobalSetting(markerKey, '1');
            }
        }
    }

    // --- Sencho Mesh ---

    public listMeshStacks(nodeId?: number): Array<{ id: number; node_id: number; stack_name: string; created_at: number; created_by: string | null }> {
        if (isPilotMode()) return [];
        const sql = nodeId !== undefined
            ? 'SELECT id, node_id, stack_name, created_at, created_by FROM mesh_stacks WHERE node_id = ?'
            : 'SELECT id, node_id, stack_name, created_at, created_by FROM mesh_stacks';
        const rows = nodeId !== undefined
            ? this.db.prepare(sql).all(nodeId)
            : this.db.prepare(sql).all();
        return rows as Array<{ id: number; node_id: number; stack_name: string; created_at: number; created_by: string | null }>;
    }

    public isMeshStackEnabled(nodeId: number, stackName: string): boolean {
        if (isPilotMode()) return false;
        const row = this.db.prepare('SELECT 1 FROM mesh_stacks WHERE node_id = ? AND stack_name = ?').get(nodeId, stackName);
        return !!row;
    }

    public insertMeshStack(nodeId: number, stackName: string, createdBy: string | null): void {
        if (isPilotMode()) {
            console.warn(`[DatabaseService] insertMeshStack ignored on pilot (node=${nodeId}, stack=${stackName})`);
            return;
        }
        this.db.prepare(
            'INSERT INTO mesh_stacks (node_id, stack_name, created_at, created_by) VALUES (?, ?, ?, ?)'
        ).run(nodeId, stackName, Date.now(), createdBy);
    }

    public deleteMeshStack(nodeId: number, stackName: string): void {
        if (isPilotMode()) return;
        this.db.prepare('DELETE FROM mesh_stacks WHERE node_id = ? AND stack_name = ?').run(nodeId, stackName);
    }

    public setNodeMeshEnabled(nodeId: number, enabled: boolean): void {
        this.db.prepare('UPDATE nodes SET mesh_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, nodeId);
    }

    public getNodeMeshEnabled(nodeId: number): boolean {
        const row = this.db.prepare('SELECT mesh_enabled FROM nodes WHERE id = ?').get(nodeId) as { mesh_enabled?: number } | undefined;
        return !!row?.mesh_enabled;
    }

    // --- Agents ---

    public getAgents(nodeId: number): Agent[] {
        const stmt = this.db.prepare('SELECT * FROM agents WHERE node_id = ?');
        return stmt.all(nodeId).map((row: any) => ({
            ...row,
            enabled: row.enabled === 1
        }));
    }

    public getEnabledAgents(nodeId: number): Agent[] {
        const stmt = this.db.prepare('SELECT * FROM agents WHERE node_id = ? AND enabled = 1');
        return stmt.all(nodeId).map((row: any) => ({
            ...row,
            enabled: row.enabled === 1
        }));
    }

    public upsertAgent(nodeId: number, agent: Agent): void {
        const existing = this.db.prepare('SELECT id FROM agents WHERE node_id = ? AND type = ?').get(nodeId, agent.type) as any;
        if (existing) {
            const stmt = this.db.prepare('UPDATE agents SET url = ?, enabled = ? WHERE node_id = ? AND type = ?');
            stmt.run(agent.url, agent.enabled ? 1 : 0, nodeId, agent.type);
        } else {
            const stmt = this.db.prepare('INSERT INTO agents (node_id, type, url, enabled) VALUES (?, ?, ?, ?)');
            stmt.run(nodeId, agent.type, agent.url, agent.enabled ? 1 : 0);
        }
    }

    // --- Notification Routes ---

    private parseNotificationRoute(row: Record<string, unknown>): NotificationRoute {
        return {
            id: row.id as number,
            name: row.name as string,
            node_id: row.node_id != null ? (row.node_id as number) : null,
            stack_patterns: JSON.parse(row.stack_patterns as string) as string[],
            label_ids: row.label_ids ? JSON.parse(row.label_ids as string) as number[] : null,
            categories: row.categories ? JSON.parse(row.categories as string) as string[] : null,
            channel_type: row.channel_type as 'discord' | 'slack' | 'webhook',
            channel_url: row.channel_url as string,
            priority: row.priority as number,
            enabled: row.enabled === 1,
            created_at: row.created_at as number,
            updated_at: row.updated_at as number,
        };
    }

    public getStackLabelIds(nodeId: number, stackName: string): number[] {
        const rows = this.db.prepare(
            'SELECT label_id FROM stack_label_assignments WHERE stack_name = ? AND node_id = ?'
        ).all(stackName, nodeId) as { label_id: number }[];
        return rows.map(r => r.label_id);
    }

    public getNotificationRoutes(): NotificationRoute[] {
        return this.db.prepare('SELECT * FROM notification_routes ORDER BY priority ASC')
            .all()
            .map((row) => this.parseNotificationRoute(row as Record<string, unknown>));
    }

    public getEnabledNotificationRoutes(): NotificationRoute[] {
        return this.db.prepare('SELECT * FROM notification_routes WHERE enabled = 1 ORDER BY priority ASC')
            .all()
            .map((row) => this.parseNotificationRoute(row as Record<string, unknown>));
    }

    public getNotificationRoute(id: number): NotificationRoute | undefined {
        const row = this.db.prepare('SELECT * FROM notification_routes WHERE id = ?').get(id) as Record<string, unknown> | undefined;
        return row ? this.parseNotificationRoute(row) : undefined;
    }

    public createNotificationRoute(route: Omit<NotificationRoute, 'id'>): NotificationRoute {
        const result = this.db.prepare(
            'INSERT INTO notification_routes (name, node_id, stack_patterns, label_ids, categories, channel_type, channel_url, priority, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(
            route.name,
            route.node_id ?? null,
            JSON.stringify(route.stack_patterns),
            route.label_ids ? JSON.stringify(route.label_ids) : null,
            route.categories ? JSON.stringify(route.categories) : null,
            route.channel_type,
            route.channel_url,
            route.priority,
            route.enabled ? 1 : 0,
            route.created_at,
            route.updated_at
        );
        return this.getNotificationRoute(result.lastInsertRowid as number)!;
    }

    public updateNotificationRoute(id: number, updates: Partial<Omit<NotificationRoute, 'id' | 'created_at'>>): void {
        const fields: string[] = [];
        const values: unknown[] = [];

        if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
        if ('node_id' in updates) { fields.push('node_id = ?'); values.push(updates.node_id ?? null); }
        if (updates.stack_patterns !== undefined) { fields.push('stack_patterns = ?'); values.push(JSON.stringify(updates.stack_patterns)); }
        if ('label_ids' in updates) { fields.push('label_ids = ?'); values.push(updates.label_ids ? JSON.stringify(updates.label_ids) : null); }
        if ('categories' in updates) { fields.push('categories = ?'); values.push(updates.categories ? JSON.stringify(updates.categories) : null); }
        if (updates.channel_type !== undefined) { fields.push('channel_type = ?'); values.push(updates.channel_type); }
        if (updates.channel_url !== undefined) { fields.push('channel_url = ?'); values.push(updates.channel_url); }
        if (updates.priority !== undefined) { fields.push('priority = ?'); values.push(updates.priority); }
        if (updates.enabled !== undefined) { fields.push('enabled = ?'); values.push(updates.enabled ? 1 : 0); }
        if (updates.updated_at !== undefined) { fields.push('updated_at = ?'); values.push(updates.updated_at); }

        if (fields.length === 0) return;
        values.push(id);
        this.db.prepare(`UPDATE notification_routes SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    }

    public deleteNotificationRoute(id: number): number {
        return this.db.prepare('DELETE FROM notification_routes WHERE id = ?').run(id).changes;
    }

    // --- Global Settings ---

    public getGlobalSettings(): Readonly<Record<string, string>> {
        if (this.cachedGlobalSettings) return this.cachedGlobalSettings;
        const stmt = this.db.prepare('SELECT * FROM global_settings');
        const rows = stmt.all() as Array<{ key: string; value: string }>;
        const settings: Record<string, string> = {};
        for (const row of rows) settings[row.key] = row.value;
        this.cachedGlobalSettings = Object.freeze(settings);
        return this.cachedGlobalSettings;
    }

    public updateGlobalSetting(key: string, value: string): void {
        const stmt = this.db.prepare('INSERT OR REPLACE INTO global_settings (key, value) VALUES (?, ?)');
        stmt.run(key, value);
        this.cachedGlobalSettings = null;
    }

    // --- System State (operational/runtime values - not user-defined config) ---

    public getSystemState(key: string): string | null {
        const row = this.db.prepare('SELECT value FROM system_state WHERE key = ?').get(key) as { value: string } | undefined;
        return row?.value ?? null;
    }

    public setSystemState(key: string, value: string): void {
        this.db.prepare('INSERT OR REPLACE INTO system_state (key, value) VALUES (?, ?)').run(key, value);
    }

    /**
     * Persisted PilotMetrics counters. Returns the parsed JSON object (a
     * numeric record keyed by counter name) or null when the row is missing
     * or unparseable. Callers (PilotMetrics.load) handle per-field defaulting
     * so a missing counter in the persisted blob does not break a new release
     * that added the counter.
     *
     * This is the first JSON blob stored in `system_state`; mirror this
     * parse/validate shape (object check + numeric filter) for any future
     * JSON-shaped system_state row so an operator-edited row cannot crash
     * boot.
     */
    public getPilotMetricsCounters(): Record<string, number> | null {
        const raw = this.getSystemState(PILOT_METRICS_COUNTERS_KEY);
        if (raw === null) return null;
        try {
            const parsed = JSON.parse(raw) as unknown;
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
            const out: Record<string, number> = {};
            for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
                if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
            }
            return out;
        } catch (err) {
            console.warn('[DatabaseService] pilot_metrics_counters JSON parse failed:', (err as Error).message);
            return null;
        }
    }

    public setPilotMetricsCounters(counters: Record<string, number>): void {
        this.setSystemState(PILOT_METRICS_COUNTERS_KEY, JSON.stringify(counters));
    }

    /**
     * Run `fn` inside a single SQLite transaction. better-sqlite3 promotes a
     * nested call to a SAVEPOINT, so callers can compose this with methods
     * that already wrap their own writes in `this.db.transaction(...)`.
     *
     * Used by FleetSync receive to keep the row replacement and the
     * received_pushed_at watermark write atomic. If either step fails, both
     * roll back.
     */
    public transaction<T>(fn: () => T): T {
        return this.db.transaction(fn)();
    }

    // --- Stack Alerts ---

    public getStackAlerts(stackName?: string): StackAlert[] {
        let stmt;
        if (stackName) {
            stmt = this.db.prepare('SELECT * FROM stack_alerts WHERE stack_name = ?');
            return stmt.all(stackName) as StackAlert[];
        } else {
            stmt = this.db.prepare('SELECT * FROM stack_alerts');
            return stmt.all() as StackAlert[];
        }
    }

    public addStackAlert(alert: StackAlert): StackAlert {
        const stmt = this.db.prepare(
            'INSERT INTO stack_alerts (stack_name, metric, operator, threshold, duration_mins, cooldown_mins, last_fired_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        );
        const result = stmt.run(
            alert.stack_name,
            alert.metric,
            alert.operator,
            alert.threshold,
            alert.duration_mins,
            alert.cooldown_mins,
            alert.last_fired_at || 0
        );
        return this.db.prepare('SELECT * FROM stack_alerts WHERE id = ?').get(result.lastInsertRowid) as StackAlert;
    }

    public deleteStackAlert(id: number): void {
        const stmt = this.db.prepare('DELETE FROM stack_alerts WHERE id = ?');
        stmt.run(id);
    }

    public updateStackAlertLastFired(id: number, timestamp: number): void {
        const stmt = this.db.prepare('UPDATE stack_alerts SET last_fired_at = ? WHERE id = ?');
        stmt.run(timestamp, id);
    }

    // --- Auto-Heal Policies ---

    public getAutoHealPolicies(stackName?: string, nodeId?: number): AutoHealPolicy[] {
        if (stackName && nodeId !== undefined) {
            return this.db.prepare('SELECT * FROM auto_heal_policies WHERE stack_name = ? AND node_id = ?').all(stackName, nodeId) as AutoHealPolicy[];
        }
        if (stackName) {
            return this.db.prepare('SELECT * FROM auto_heal_policies WHERE stack_name = ?').all(stackName) as AutoHealPolicy[];
        }
        if (nodeId !== undefined) {
            return this.db.prepare('SELECT * FROM auto_heal_policies WHERE node_id = ?').all(nodeId) as AutoHealPolicy[];
        }
        return this.db.prepare('SELECT * FROM auto_heal_policies').all() as AutoHealPolicy[];
    }

    public getAutoHealPolicy(id: number): AutoHealPolicy | undefined {
        return this.db.prepare('SELECT * FROM auto_heal_policies WHERE id = ?').get(id) as AutoHealPolicy | undefined;
    }

    public addAutoHealPolicy(policy: Omit<AutoHealPolicy, 'id'>): AutoHealPolicy {
        const stmt = this.db.prepare(
            'INSERT INTO auto_heal_policies (node_id, proxy_entitled_until, stack_name, service_name, unhealthy_duration_mins, cooldown_mins, max_restarts_per_hour, auto_disable_after_failures, enabled, consecutive_failures, last_fired_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        const result = stmt.run(
            policy.node_id,
            policy.proxy_entitled_until,
            policy.stack_name,
            policy.service_name ?? null,
            policy.unhealthy_duration_mins,
            policy.cooldown_mins,
            policy.max_restarts_per_hour,
            policy.auto_disable_after_failures,
            policy.enabled,
            policy.consecutive_failures,
            policy.last_fired_at,
            policy.created_at,
            policy.updated_at
        );
        return this.db.prepare('SELECT * FROM auto_heal_policies WHERE id = ?').get(result.lastInsertRowid) as AutoHealPolicy;
    }

    public updateAutoHealPolicy(id: number, patch: Partial<Omit<AutoHealPolicy, 'id' | 'stack_name' | 'created_at'>>): void {
        const ALLOWED_KEYS = new Set([
            'service_name', 'unhealthy_duration_mins', 'cooldown_mins',
            'max_restarts_per_hour', 'auto_disable_after_failures',
            'enabled', 'consecutive_failures', 'last_fired_at', 'proxy_entitled_until',
        ]);
        const entries = Object.entries(patch).filter(([k, v]) => ALLOWED_KEYS.has(k) && v !== undefined);
        if (entries.length === 0) return;
        const fields = entries.map(([k]) => `${k} = ?`).join(', ');
        const values = entries.map(([, v]) => v);
        this.db.prepare(`UPDATE auto_heal_policies SET ${fields}, updated_at = ? WHERE id = ?`).run(...values, Date.now(), id);
    }

    public deleteAutoHealPolicy(id: number): void {
        this.db.transaction(() => {
            this.db.prepare('DELETE FROM auto_heal_history WHERE policy_id = ?').run(id);
            this.db.prepare('DELETE FROM auto_heal_policies WHERE id = ?').run(id);
        })();
    }

    public recordAutoHealHistory(entry: Omit<AutoHealHistoryEntry, 'id'>): void {
        this.db.prepare(
            'INSERT INTO auto_heal_history (policy_id, stack_name, service_name, container_name, container_id, action, reason, success, error, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(
            entry.policy_id,
            entry.stack_name,
            entry.service_name ?? null,
            entry.container_name,
            entry.container_id,
            entry.action,
            entry.reason,
            entry.success,
            entry.error ?? null,
            entry.timestamp
        );
        this.pruneAutoHealHistory(entry.policy_id);
    }

    public getAutoHealHistory(policyId: number, limit = 50): AutoHealHistoryEntry[] {
        return this.db.prepare(
            'SELECT * FROM auto_heal_history WHERE policy_id = ? ORDER BY timestamp DESC LIMIT ?'
        ).all(policyId, limit) as AutoHealHistoryEntry[];
    }

    public pruneAutoHealHistory(policyId: number, maxRows = 500, maxAgeMs = 30 * 24 * 60 * 60_000): void {
        const cutoff = Date.now() - maxAgeMs;
        this.db.prepare('DELETE FROM auto_heal_history WHERE policy_id = ? AND timestamp < ?').run(policyId, cutoff);
        this.db.prepare(`
            DELETE FROM auto_heal_history
            WHERE policy_id = ?
              AND id NOT IN (
                SELECT id FROM auto_heal_history
                WHERE policy_id = ?
                ORDER BY timestamp DESC, id DESC
                LIMIT ?
              )
        `).run(policyId, policyId, maxRows);
    }

    public incrementConsecutiveFailures(policyId: number): void {
        this.db.prepare('UPDATE auto_heal_policies SET consecutive_failures = consecutive_failures + 1, updated_at = ? WHERE id = ?').run(Date.now(), policyId);
    }

    public resetConsecutiveFailures(policyId: number): void {
        this.db.prepare('UPDATE auto_heal_policies SET consecutive_failures = 0, updated_at = ? WHERE id = ?').run(Date.now(), policyId);
    }

    public setPolicyEnabled(policyId: number, enabled: boolean): void {
        this.db.prepare('UPDATE auto_heal_policies SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, Date.now(), policyId);
    }

    // --- Notification History ---

    private mapNotificationRow(row: any): NotificationHistory {
        return {
            ...row,
            is_read: row.is_read === 1,
            stack_name: row.stack_name ?? undefined,
            container_name: row.container_name ?? undefined,
            category: row.category ?? undefined,
            actor_username: row.actor_username ?? null,
        };
    }

    public getNotificationHistory(nodeId: number, limit = 50, category?: string): NotificationHistory[] {
        const sql = category
            ? 'SELECT * FROM notification_history WHERE node_id = ? AND category = ? ORDER BY timestamp DESC LIMIT ?'
            : 'SELECT * FROM notification_history WHERE node_id = ? ORDER BY timestamp DESC LIMIT ?';
        const args: (number | string)[] = category ? [nodeId, category, limit] : [nodeId, limit];
        return (this.db.prepare(sql).all(...args) as unknown[]).map(row => this.mapNotificationRow(row as any));
    }

    public addNotificationHistory(nodeId: number, notification: Omit<NotificationHistory, 'id' | 'is_read'>): NotificationHistory {
        const stmt = this.db.prepare(
            'INSERT INTO notification_history (node_id, level, message, timestamp, is_read, stack_name, container_name, category, actor_username) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)'
        );
        const result = stmt.run(
            nodeId,
            notification.level,
            notification.message,
            notification.timestamp,
            notification.stack_name ?? null,
            notification.container_name ?? null,
            notification.category ?? null,
            notification.actor_username ?? null,
        );

        return {
            id: result.lastInsertRowid as number,
            level: notification.level,
            category: notification.category,
            message: notification.message,
            timestamp: notification.timestamp,
            is_read: false,
            stack_name: notification.stack_name,
            container_name: notification.container_name,
            actor_username: notification.actor_username,
        };
    }

    public clearSelfContainerNotificationRouting(
        nodeId: number,
        self: { containerName?: string | null; composeProjectName?: string | null },
    ): number {
        const containerName = self.containerName?.trim() || null;
        const composeProjectName = self.composeProjectName?.trim() || null;
        if (!containerName && !composeProjectName) return 0;

        const predicates: string[] = [];
        const args: (number | string)[] = [nodeId];
        if (containerName) {
            predicates.push('container_name = ?');
            args.push(containerName);
        }
        if (composeProjectName) {
            predicates.push('(container_name IS NULL AND stack_name = ?)');
            args.push(composeProjectName);
        }

        const result = this.db.prepare(`
            UPDATE notification_history
               SET stack_name = NULL,
                   container_name = NULL
             WHERE node_id = ?
               AND actor_username = 'system:docker-events'
               AND category = 'monitor_alert'
               AND (stack_name IS NOT NULL OR container_name IS NOT NULL)
               AND (${predicates.join(' OR ')})
        `).run(...args);
        return result.changes;
    }

    public getStackActivity(nodeId: number, stackName: string, opts: { limit: number; before?: number; beforeId?: number }): NotificationHistory[] {
        // Composite (timestamp, id) cursor: pure timestamp pagination drops rows
        // on same-millisecond bursts (Docker events from one compose up).
        let sql: string;
        let args: (number | string)[];
        if (opts.before !== undefined && opts.beforeId !== undefined) {
            sql = 'SELECT * FROM notification_history WHERE node_id = ? AND stack_name = ? AND (timestamp < ? OR (timestamp = ? AND id < ?)) ORDER BY timestamp DESC, id DESC LIMIT ?';
            args = [nodeId, stackName, opts.before, opts.before, opts.beforeId, opts.limit];
        } else if (opts.before !== undefined) {
            sql = 'SELECT * FROM notification_history WHERE node_id = ? AND stack_name = ? AND timestamp < ? ORDER BY timestamp DESC, id DESC LIMIT ?';
            args = [nodeId, stackName, opts.before, opts.limit];
        } else {
            sql = 'SELECT * FROM notification_history WHERE node_id = ? AND stack_name = ? ORDER BY timestamp DESC, id DESC LIMIT ?';
            args = [nodeId, stackName, opts.limit];
        }
        return (this.db.prepare(sql).all(...args) as unknown[]).map(row => this.mapNotificationRow(row as any));
    }

    public markAllNotificationsRead(nodeId: number): void {
        const stmt = this.db.prepare('UPDATE notification_history SET is_read = 1 WHERE node_id = ?');
        stmt.run(nodeId);
    }

    public deleteNotification(nodeId: number, id: number): void {
        const stmt = this.db.prepare('DELETE FROM notification_history WHERE node_id = ? AND id = ?');
        stmt.run(nodeId, id);
    }

    public deleteAllNotifications(nodeId: number): void {
        const stmt = this.db.prepare('DELETE FROM notification_history WHERE node_id = ?');
        stmt.run(nodeId);
    }

    public updateNotificationDispatchError(id: number, error: string): void {
        this.db.prepare('UPDATE notification_history SET dispatch_error = ? WHERE id = ?').run(error, id);
    }

    public getStackRestartSummary(nodeId: number, days: number): StackRestartSummary[] {
        const since = Date.now() - days * 86400 * 1000;
        return this.db.prepare(`
            SELECT
              stack_name AS stackName,
              SUM(CASE WHEN category = 'deploy_failure'     THEN 1 ELSE 0 END) AS crash,
              SUM(CASE WHEN category = 'autoheal_triggered' THEN 1 ELSE 0 END) AS autoheal,
              SUM(CASE WHEN category = 'stack_restarted'    THEN 1 ELSE 0 END) AS manual,
              COUNT(*) AS total
            FROM notification_history
            WHERE node_id = ?
              AND timestamp >= ?
              AND category IN ('deploy_failure', 'autoheal_triggered', 'stack_restarted')
              AND stack_name IS NOT NULL
            GROUP BY stack_name
            ORDER BY total DESC
        `).all(nodeId, since) as StackRestartSummary[];
    }

    // --- Container Metrics ---

    public addContainerMetric(metric: Omit<any, 'id'>): void {
        const stmt = this.db.prepare(
            'INSERT INTO container_metrics (container_id, stack_name, cpu_percent, memory_mb, net_rx_mb, net_tx_mb, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)'
        );
        stmt.run(metric.container_id, metric.stack_name, metric.cpu_percent, metric.memory_mb, metric.net_rx_mb, metric.net_tx_mb, metric.timestamp);
    }

    public bulkAddContainerMetrics(metrics: Omit<any, 'id'>[]): void {
        const stmt = this.db.prepare(
            'INSERT INTO container_metrics (container_id, stack_name, cpu_percent, memory_mb, net_rx_mb, net_tx_mb, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)'
        );
        const insertAll = this.db.transaction((items: Omit<any, 'id'>[]) => {
            for (const m of items) {
                stmt.run(m.container_id, m.stack_name, m.cpu_percent, m.memory_mb, m.net_rx_mb, m.net_tx_mb, m.timestamp);
            }
        });
        insertAll(metrics);
    }

    public getContainerMetrics(hoursLookback = 24): any[] {
        const cutoff = Date.now() - (hoursLookback * 60 * 60 * 1000);
        // Aggregate into 5-minute buckets (300000ms) to keep response size bounded.
        // With 24h lookback that's ~288 buckets per container instead of ~1440.
        const bucketMs = 300000;
        const stmt = this.db.prepare(`
            SELECT
              container_id,
              stack_name,
              AVG(cpu_percent) as cpu_percent,
              AVG(memory_mb) as memory_mb,
              MAX(net_rx_mb) as net_rx_mb,
              MAX(net_tx_mb) as net_tx_mb,
              (timestamp / ${bucketMs}) * ${bucketMs} as timestamp
            FROM container_metrics
            WHERE timestamp >= ?
            GROUP BY container_id, stack_name, (timestamp / ${bucketMs})
            ORDER BY timestamp ASC
        `);
        return stmt.all(cutoff);
    }

    public cleanupOldMetrics(hoursToKeep = 24): void {
        const cutoff = Date.now() - (hoursToKeep * 60 * 60 * 1000);
        const stmt = this.db.prepare('DELETE FROM container_metrics WHERE timestamp < ?');
        stmt.run(cutoff);
    }

    public cleanupOldNotifications(daysToKeep = 30, opts: { perStackCap?: number; perNodeUnattachedCap?: number } = {}): { ttl: number; perStack: number; perNode: number } {
        const perStackCap = opts.perStackCap ?? 500;
        const perNodeUnattachedCap = opts.perNodeUnattachedCap ?? 1000;
        const cutoff = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
        const ttlInfo = this.db.prepare('DELETE FROM notification_history WHERE timestamp < ?').run(cutoff);

        const deleteById = this.db.prepare('DELETE FROM notification_history WHERE id = ?');
        const deleteMany = this.db.transaction((ids: number[]) => {
            for (const id of ids) deleteById.run(id);
        });

        // Per (node_id, stack_name) cap so a chatty stack cannot evict a quieter stack's history.
        const stackOverflow = this.db.prepare(`
            SELECT id FROM (
                SELECT id, ROW_NUMBER() OVER (
                    PARTITION BY node_id, stack_name
                    ORDER BY timestamp DESC, id DESC
                ) AS rn
                FROM notification_history
                WHERE stack_name IS NOT NULL
            )
            WHERE rn > ?
        `).all(perStackCap) as { id: number }[];
        if (stackOverflow.length > 0) deleteMany(stackOverflow.map(r => r.id));

        // Unattached system events have no stack to scope by, so they cannot share the per-stack quota; cap them per-node separately.
        const unattachedOverflow = this.db.prepare(`
            SELECT id FROM (
                SELECT id, ROW_NUMBER() OVER (
                    PARTITION BY node_id
                    ORDER BY timestamp DESC, id DESC
                ) AS rn
                FROM notification_history
                WHERE stack_name IS NULL
            )
            WHERE rn > ?
        `).all(perNodeUnattachedCap) as { id: number }[];
        if (unattachedOverflow.length > 0) deleteMany(unattachedOverflow.map(r => r.id));

        return {
            ttl: Number(ttlInfo.changes ?? 0),
            perStack: stackOverflow.length,
            perNode: unattachedOverflow.length,
        };
    }

    // --- Nodes ---

    private decryptNodeRow(row: any): Node {
        const crypto = CryptoService.getInstance();
        return {
            ...row,
            is_default: row.is_default === 1,
            mode: (row.mode === 'pilot_agent' ? 'pilot_agent' : 'proxy') as NodeMode,
            api_token: row.api_token ? crypto.decrypt(row.api_token) : '',
            pilot_last_seen: row.pilot_last_seen ?? null,
            pilot_agent_version: row.pilot_agent_version ?? null,
            last_successful_contact: row.last_successful_contact ?? null,
            cordoned: row.cordoned === 1,
            cordoned_at: row.cordoned_at ?? null,
            cordoned_reason: row.cordoned_reason ?? null,
        };
    }

    private static readonly NODE_COLUMNS =
        'id, name, type, compose_dir, is_default, status, created_at, api_url, api_token, mode, pilot_last_seen, pilot_agent_version, last_successful_contact, cordoned, cordoned_at, cordoned_reason';

    public getNodes(): Node[] {
        const stmt = this.db.prepare(`SELECT ${DatabaseService.NODE_COLUMNS} FROM nodes ORDER BY is_default DESC, name ASC`);
        return stmt.all().map((row: any) => this.decryptNodeRow(row));
    }

    public getNode(id: number): Node | undefined {
        const stmt = this.db.prepare(`SELECT ${DatabaseService.NODE_COLUMNS} FROM nodes WHERE id = ?`);
        const row = stmt.get(id) as any;
        if (!row) return undefined;
        return this.decryptNodeRow(row);
    }

    public getDefaultNode(): Node | undefined {
        const stmt = this.db.prepare(`SELECT ${DatabaseService.NODE_COLUMNS} FROM nodes WHERE is_default = 1 LIMIT 1`);
        const row = stmt.get() as any;
        if (!row) return undefined;
        return this.decryptNodeRow(row);
    }

    public addNode(node: Omit<Node, 'id' | 'status' | 'created_at' | 'mode' | 'cordoned' | 'cordoned_at' | 'cordoned_reason'> & { mode?: NodeMode }): number {
        if (node.is_default) {
            this.db.prepare('UPDATE nodes SET is_default = 0').run();
        }
        const crypto = CryptoService.getInstance();
        const stmt = this.db.prepare(
            'INSERT INTO nodes (name, type, compose_dir, is_default, status, created_at, api_url, api_token, mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        const result = stmt.run(
            node.name,
            node.type,
            node.compose_dir || '/app/compose',
            node.is_default ? 1 : 0,
            'unknown',
            Date.now(),
            node.api_url || '',
            node.api_token ? crypto.encrypt(node.api_token) : '',
            node.mode || 'proxy'
        );
        return result.lastInsertRowid as number;
    }

    public updateNode(id: number, updates: Partial<Omit<Node, 'id' | 'created_at'>>): void {
        const node = this.getNode(id);
        if (!node) throw new Error(`Node with id ${id} not found`);

        if (updates.is_default) {
            this.db.prepare('UPDATE nodes SET is_default = 0').run();
        }

        const fields: string[] = [];
        const values: any[] = [];

        if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
        if (updates.type !== undefined) { fields.push('type = ?'); values.push(updates.type); }
        if (updates.compose_dir !== undefined) { fields.push('compose_dir = ?'); values.push(updates.compose_dir); }
        if (updates.is_default !== undefined) { fields.push('is_default = ?'); values.push(updates.is_default ? 1 : 0); }
        if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
        if (updates.api_url !== undefined) { fields.push('api_url = ?'); values.push(updates.api_url); }
        if (updates.api_token !== undefined) {
            fields.push('api_token = ?');
            values.push(updates.api_token ? CryptoService.getInstance().encrypt(updates.api_token) : '');
        }
        if (updates.mode !== undefined) { fields.push('mode = ?'); values.push(updates.mode); }
        if (updates.pilot_last_seen !== undefined) { fields.push('pilot_last_seen = ?'); values.push(updates.pilot_last_seen); }
        if (updates.pilot_agent_version !== undefined) { fields.push('pilot_agent_version = ?'); values.push(updates.pilot_agent_version); }

        if (fields.length === 0) return;

        values.push(id);
        this.db.prepare(`UPDATE nodes SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    }

    public deleteNode(id: number): void {
        const node = this.getNode(id);
        if (node?.is_default) {
            throw new Error('Cannot delete the default node');
        }
        this.db.transaction(() => {
            this.db.prepare('DELETE FROM scheduled_task_runs WHERE task_id IN (SELECT id FROM scheduled_tasks WHERE node_id = ?)').run(id);
            this.db.prepare('DELETE FROM scheduled_tasks WHERE node_id = ?').run(id);
            this.db.prepare('DELETE FROM stack_update_status WHERE node_id = ?').run(id);
            this.db.prepare('DELETE FROM stack_label_assignments WHERE node_id = ?').run(id);
            this.db.prepare('DELETE FROM stack_labels WHERE node_id = ?').run(id);
            this.db.prepare('UPDATE blueprints SET pinned_node_id = NULL WHERE pinned_node_id = ?').run(id);
            this.deleteRoleAssignmentsByResource('node', String(id));
            this.db.prepare('DELETE FROM fleet_sync_status WHERE node_id = ?').run(id);
            this.db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
        })();
    }

    public updateNodeStatus(id: number, status: 'online' | 'offline' | 'unknown'): void {
        this.db.prepare('UPDATE nodes SET status = ? WHERE id = ?').run(status, id);
    }

    public setNodeCordoned(id: number, cordoned: boolean, reason: string | null): Node | undefined {
        if (cordoned) {
            this.db.prepare(
                'UPDATE nodes SET cordoned = 1, cordoned_at = ?, cordoned_reason = ? WHERE id = ?'
            ).run(Date.now(), reason, id);
        } else {
            this.db.prepare(
                'UPDATE nodes SET cordoned = 0, cordoned_at = NULL, cordoned_reason = NULL WHERE id = ?'
            ).run(id);
        }
        return this.getNode(id);
    }

    public setBlueprintPinnedNode(blueprintId: number, nodeId: number | null): Blueprint | undefined {
        this.db.prepare('UPDATE blueprints SET pinned_node_id = ?, updated_at = ? WHERE id = ?')
            .run(nodeId, Date.now(), blueprintId);
        return this.getBlueprint(blueprintId);
    }

    public updateNodeLastContact(nodeId: number): void {
        this.db.prepare('UPDATE nodes SET last_successful_contact = ? WHERE id = ?')
            .run(Math.floor(Date.now() / 1000), nodeId);
    }

    // --- Pilot enrollments ---

    public getPilotEnrollment(nodeId: number): PilotEnrollment | undefined {
        const row = this.db.prepare(
            'SELECT node_id, token_hash, expires_at, used_at FROM pilot_enrollments WHERE node_id = ?'
        ).get(nodeId) as PilotEnrollment | undefined;
        return row;
    }

    public createPilotEnrollment(nodeId: number, tokenHash: string, expiresAt: number): void {
        this.db.prepare(
            `INSERT INTO pilot_enrollments (node_id, token_hash, expires_at, used_at)
             VALUES (?, ?, ?, NULL)
             ON CONFLICT(node_id) DO UPDATE SET
                token_hash = excluded.token_hash,
                expires_at = excluded.expires_at,
                used_at = NULL`
        ).run(nodeId, tokenHash, expiresAt);
    }

    public consumePilotEnrollment(tokenHash: string): PilotEnrollment | undefined {
        const now = Date.now();
        return this.db.transaction(() => {
            const row = this.db.prepare(
                `SELECT node_id, token_hash, expires_at, used_at FROM pilot_enrollments
                 WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`
            ).get(tokenHash, now) as PilotEnrollment | undefined;
            if (!row) return undefined;
            this.db.prepare('UPDATE pilot_enrollments SET used_at = ? WHERE node_id = ?').run(now, row.node_id);
            return { ...row, used_at: now };
        })();
    }

    public deletePilotEnrollment(nodeId: number): void {
        this.db.prepare('DELETE FROM pilot_enrollments WHERE node_id = ?').run(nodeId);
    }

    // --- Stack Update Status ---

    public upsertStackUpdateStatus(nodeId: number, stackName: string, hasUpdate: boolean, checkedAt: number): void {
        this.db.prepare(
            `INSERT INTO stack_update_status (node_id, stack_name, has_update, checked_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(node_id, stack_name) DO UPDATE SET has_update = excluded.has_update, checked_at = excluded.checked_at`
        ).run(nodeId, stackName, hasUpdate ? 1 : 0, checkedAt);
    }

    public getStackUpdateStatus(nodeId?: number): Record<string, boolean> {
        const rows = nodeId !== undefined
            ? this.db.prepare('SELECT stack_name, has_update FROM stack_update_status WHERE node_id = ?').all(nodeId) as Array<{ stack_name: string; has_update: number }>
            : this.db.prepare('SELECT stack_name, has_update FROM stack_update_status').all() as Array<{ stack_name: string; has_update: number }>;
        const result: Record<string, boolean> = {};
        for (const row of rows) {
            result[row.stack_name] = row.has_update === 1;
        }
        return result;
    }

    public clearStackUpdateStatus(nodeId: number, stackName: string): void {
        this.db.prepare('DELETE FROM stack_update_status WHERE node_id = ? AND stack_name = ?').run(nodeId, stackName);
    }

    // --- Stack Scan Attempts ---
    //
    // Tracks the latest post-deploy scan attempt per (nodeId, stackName) so
    // operators can see when a scan was skipped or failed without scrolling
    // logs. One row per stack; the table is overwritten on every attempt.

    public recordStackScanAttempt(
        nodeId: number,
        stackName: string,
        status: 'ok' | 'partial' | 'failed' | 'skipped',
        errorMessage: string | null,
    ): void {
        this.db.prepare(
            `INSERT INTO stack_scan_attempts (node_id, stack_name, status, attempted_at, error_message)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(node_id, stack_name) DO UPDATE SET
               status = excluded.status,
               attempted_at = excluded.attempted_at,
               error_message = excluded.error_message`
        ).run(nodeId, stackName, status, Date.now(), errorMessage);
    }

    public getStackScanAttempt(nodeId: number, stackName: string): {
        status: string;
        attempted_at: number;
        error_message: string | null;
    } | null {
        const row = this.db.prepare(
            'SELECT status, attempted_at, error_message FROM stack_scan_attempts WHERE node_id = ? AND stack_name = ?'
        ).get(nodeId, stackName) as { status: string; attempted_at: number; error_message: string | null } | undefined;
        return row ?? null;
    }

    public clearStackScanAttempts(nodeId: number, stackName: string): void {
        this.db.prepare('DELETE FROM stack_scan_attempts WHERE node_id = ? AND stack_name = ?').run(nodeId, stackName);
    }

    public getNodeUpdateSummary(): Array<{ node_id: number; stacks_with_updates: number }> {
        return this.db.prepare(
            'SELECT node_id, SUM(has_update) as stacks_with_updates FROM stack_update_status WHERE has_update = 1 GROUP BY node_id'
        ).all() as Array<{ node_id: number; stacks_with_updates: number }>;
    }

    public getNodeSchedulingSummary(): Array<{
        node_id: number;
        active_tasks: number;
        auto_update_enabled: number;
        next_run_at: number | null;
    }> {
        return this.db.prepare(`
            SELECT
                node_id,
                COUNT(*) as active_tasks,
                MAX(CASE WHEN action = 'update' AND enabled = 1 THEN 1 ELSE 0 END) as auto_update_enabled,
                MIN(next_run_at) as next_run_at
            FROM scheduled_tasks
            WHERE enabled = 1 AND node_id IS NOT NULL
            GROUP BY node_id
        `).all() as Array<{ node_id: number; active_tasks: number; auto_update_enabled: number; next_run_at: number | null }>;
    }

    // --- Webhooks ---

    public getWebhooks(): Webhook[] {
        return this.db.prepare('SELECT * FROM webhooks ORDER BY created_at DESC').all().map((row: any) => ({
            ...row,
            node_id: Number(row.node_id ?? this.getDefaultNode()?.id ?? 1),
            enabled: row.enabled === 1,
        }));
    }

    public getWebhook(id: number): Webhook | undefined {
        const row = this.db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as any;
        if (!row) return undefined;
        return {
            ...row,
            node_id: Number(row.node_id ?? this.getDefaultNode()?.id ?? 1),
            enabled: row.enabled === 1,
        };
    }

    public addWebhook(webhook: Omit<Webhook, 'id' | 'created_at' | 'updated_at'>): number {
        const now = Date.now();
        const result = this.db.prepare(
            'INSERT INTO webhooks (node_id, name, stack_name, action, secret, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(webhook.node_id, webhook.name, webhook.stack_name, webhook.action, webhook.secret, webhook.enabled ? 1 : 0, now, now);
        return result.lastInsertRowid as number;
    }

    public updateWebhook(id: number, updates: Partial<Pick<Webhook, 'node_id' | 'name' | 'stack_name' | 'action' | 'enabled'>>): void {
        const fields: string[] = [];
        const values: (string | number)[] = [];

        if (updates.node_id !== undefined) { fields.push('node_id = ?'); values.push(updates.node_id); }
        if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
        if (updates.stack_name !== undefined) { fields.push('stack_name = ?'); values.push(updates.stack_name); }
        if (updates.action !== undefined) { fields.push('action = ?'); values.push(updates.action); }
        if (updates.enabled !== undefined) { fields.push('enabled = ?'); values.push(updates.enabled ? 1 : 0); }

        if (fields.length === 0) return;

        fields.push('updated_at = ?');
        values.push(Date.now());
        values.push(id);
        this.db.prepare(`UPDATE webhooks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    }

    public deleteWebhook(id: number): void {
        this.db.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
    }

    // --- Webhook Executions ---

    public getWebhookExecutions(webhookId: number, limit = 20): WebhookExecution[] {
        return this.db.prepare(
            'SELECT * FROM webhook_executions WHERE webhook_id = ? ORDER BY executed_at DESC LIMIT ?'
        ).all(webhookId, limit) as WebhookExecution[];
    }

    public addWebhookExecution(execution: Omit<WebhookExecution, 'id'>): number {
        const result = this.db.prepare(
            'INSERT INTO webhook_executions (webhook_id, action, status, trigger_source, duration_ms, error, executed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(execution.webhook_id, execution.action, execution.status, execution.trigger_source, execution.duration_ms, execution.error, execution.executed_at);

        // Keep only last 100 executions per webhook
        this.db.prepare(
            'DELETE FROM webhook_executions WHERE webhook_id = ? AND id NOT IN (SELECT id FROM webhook_executions WHERE webhook_id = ? ORDER BY executed_at DESC LIMIT 100)'
        ).run(execution.webhook_id, execution.webhook_id);

        return result.lastInsertRowid as number;
    }

    // --- Users ---

    public getUsers(): Omit<User, 'password_hash'>[] {
        return this.db.prepare('SELECT id, username, role, auth_provider, provider_id, email, created_at, updated_at FROM users ORDER BY created_at ASC').all() as Omit<User, 'password_hash'>[];
    }

    public getUser(id: number): User | undefined {
        return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
    }

    public getUserByUsername(username: string): User | undefined {
        return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as User | undefined;
    }

    public getUserById(id: number): User | undefined {
        return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
    }

    public getUserByProviderIdentity(authProvider: string, providerId: string): User | undefined {
        return this.db.prepare('SELECT * FROM users WHERE auth_provider = ? AND provider_id = ?').get(authProvider, providerId) as User | undefined;
    }

    public addUser(user: { username: string; password_hash: string; role: UserRole; auth_provider?: AuthProvider; provider_id?: string | null; email?: string | null }): number {
        const now = Date.now();
        const result = this.db.prepare(
            'INSERT INTO users (username, password_hash, role, auth_provider, provider_id, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(user.username, user.password_hash, user.role, user.auth_provider ?? 'local', user.provider_id ?? null, user.email ?? null, now, now);
        return result.lastInsertRowid as number;
    }

    public updateUser(id: number, updates: Partial<{ username: string; password_hash: string; role: string; email: string }>): void {
        const fields: string[] = [];
        const values: (string | number)[] = [];

        if (updates.username !== undefined) { fields.push('username = ?'); values.push(updates.username); }
        if (updates.password_hash !== undefined) { fields.push('password_hash = ?'); values.push(updates.password_hash); }
        if (updates.role !== undefined) { fields.push('role = ?'); values.push(updates.role); }
        if (updates.email !== undefined) { fields.push('email = ?'); values.push(updates.email); }

        if (fields.length === 0) return;

        fields.push('updated_at = ?');
        values.push(Date.now());
        values.push(id);
        this.db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    }

    public deleteUser(id: number): void {
        this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    }

    /**
     * Atomically apply `updates` unless doing so would demote the last remaining
     * admin. Returns false (nothing written) when the change would leave zero
     * admins, true otherwise. The current-role read, the admin count, and the
     * write run in a single transaction so a concurrent demote or delete of the
     * other admin cannot race the count to zero.
     */
    public updateUserIfNotLastAdmin(id: number, updates: Partial<{ username: string; password_hash: string; role: string; email: string }>): boolean {
        return this.transaction(() => {
            if (updates.role !== undefined && updates.role !== 'admin') {
                const current = this.db.prepare('SELECT role FROM users WHERE id = ?').get(id) as { role: string } | undefined;
                if (current?.role === 'admin' && this.getAdminCount() <= 1) return false;
            }
            this.updateUser(id, updates);
            return true;
        });
    }

    /**
     * Atomically delete the user unless it is the last remaining admin. Returns
     * false (nothing deleted) in that case, true otherwise. Same single-
     * transaction guard as {@link updateUserIfNotLastAdmin}.
     */
    public deleteUserIfNotLastAdmin(id: number): boolean {
        return this.transaction(() => {
            const current = this.db.prepare('SELECT role FROM users WHERE id = ?').get(id) as { role: string } | undefined;
            if (current?.role === 'admin' && this.getAdminCount() <= 1) return false;
            this.deleteUser(id);
            return true;
        });
    }

    public getUserCount(): number {
        return (this.db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number })?.count || 0;
    }

    public getAdminCount(): number {
        return (this.db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").get() as { count: number })?.count || 0;
    }

    public getViewerCount(): number {
        return (this.db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'viewer'").get() as { count: number })?.count || 0;
    }

    public getNonAdminCount(): number {
        return (this.db.prepare("SELECT COUNT(*) as count FROM users WHERE role != 'admin'").get() as { count: number })?.count || 0;
    }

    public bumpTokenVersion(userId: number): void {
        this.db.prepare('UPDATE users SET token_version = token_version + 1, updated_at = ? WHERE id = ?').run(Date.now(), userId);
    }

    // --- User MFA ---

    public getUserMfa(userId: number): UserMfa | undefined {
        return this.db.prepare('SELECT * FROM user_mfa WHERE user_id = ?').get(userId) as UserMfa | undefined;
    }

    /**
     * Create or merge a user_mfa row. Any field left undefined on the update
     * object is preserved. Boolean flags are normalized to 0/1.
     */
    public upsertUserMfa(userId: number, updates: UserMfaUpdate): void {
        const now = Date.now();
        const existing = this.getUserMfa(userId);

        if (!existing) {
            this.db.prepare(
                `INSERT INTO user_mfa
                  (user_id, enabled, totp_secret_encrypted, backup_codes_json, sso_enforce_mfa,
                   failed_attempts, locked_until, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(
                userId,
                updates.enabled ? 1 : 0,
                updates.totp_secret_encrypted ?? null,
                updates.backup_codes_json ?? null,
                updates.sso_enforce_mfa ? 1 : 0,
                updates.failed_attempts ?? 0,
                updates.locked_until ?? null,
                now,
                now,
            );
            return;
        }

        const fields: string[] = [];
        const values: (string | number | null)[] = [];
        if (updates.enabled !== undefined) { fields.push('enabled = ?'); values.push(updates.enabled ? 1 : 0); }
        if (updates.totp_secret_encrypted !== undefined) { fields.push('totp_secret_encrypted = ?'); values.push(updates.totp_secret_encrypted); }
        if (updates.backup_codes_json !== undefined) { fields.push('backup_codes_json = ?'); values.push(updates.backup_codes_json); }
        if (updates.sso_enforce_mfa !== undefined) { fields.push('sso_enforce_mfa = ?'); values.push(updates.sso_enforce_mfa ? 1 : 0); }
        if (updates.failed_attempts !== undefined) { fields.push('failed_attempts = ?'); values.push(updates.failed_attempts); }
        if (updates.locked_until !== undefined) { fields.push('locked_until = ?'); values.push(updates.locked_until); }

        if (fields.length === 0) return;

        fields.push('updated_at = ?');
        values.push(now);
        values.push(userId);
        this.db.prepare(`UPDATE user_mfa SET ${fields.join(', ')} WHERE user_id = ?`).run(...values);
    }

    public deleteUserMfa(userId: number): void {
        this.db.prepare('DELETE FROM user_mfa WHERE user_id = ?').run(userId);
        this.db.prepare('DELETE FROM mfa_used_tokens WHERE user_id = ?').run(userId);
    }

    /**
     * Single-query helper to enrich a user list with MFA status without the
     * N+1 cost of calling getUserMfa() per row.
     */
    public getUsersWithMfaEnabled(): Set<number> {
        const rows = this.db.prepare('SELECT user_id FROM user_mfa WHERE enabled = 1').all() as { user_id: number }[];
        return new Set(rows.map((r) => r.user_id));
    }

    public recordMfaFailure(userId: number): number {
        const row = this.db.prepare(
            `UPDATE user_mfa
                SET failed_attempts = failed_attempts + 1,
                    updated_at = ?
              WHERE user_id = ?
          RETURNING failed_attempts`
        ).get(Date.now(), userId) as { failed_attempts: number } | undefined;
        return row?.failed_attempts ?? 0;
    }

    public clearMfaFailures(userId: number): void {
        this.db.prepare(
            `UPDATE user_mfa
                SET failed_attempts = 0,
                    locked_until = NULL,
                    updated_at = ?
              WHERE user_id = ?`
        ).run(Date.now(), userId);
    }

    public lockMfa(userId: number, untilMs: number): void {
        this.db.prepare(
            `UPDATE user_mfa SET locked_until = ?, updated_at = ? WHERE user_id = ?`
        ).run(untilMs, Date.now(), userId);
    }

    public isMfaCodeUsed(userId: number, code: string, window: number): boolean {
        const row = this.db.prepare(
            'SELECT 1 FROM mfa_used_tokens WHERE user_id = ? AND code = ? AND window = ?'
        ).get(userId, code, window);
        return !!row;
    }

    public markMfaCodeUsed(userId: number, code: string, window: number): void {
        this.db.prepare(
            'INSERT OR IGNORE INTO mfa_used_tokens (user_id, code, window, used_at) VALUES (?, ?, ?, ?)'
        ).run(userId, code, window, Date.now());
    }

    public purgeOldMfaCodes(olderThanMs: number): number {
        const result = this.db.prepare('DELETE FROM mfa_used_tokens WHERE used_at < ?').run(olderThanMs);
        return result.changes;
    }

    // --- Role Assignments ---

    public getRoleAssignments(userId: number, resourceType: ResourceType, resourceId: string): RoleAssignment[] {
        return this.db.prepare(
            'SELECT * FROM role_assignments WHERE user_id = ? AND resource_type = ? AND resource_id = ?'
        ).all(userId, resourceType, resourceId) as RoleAssignment[];
    }

    public getAllRoleAssignments(userId: number): RoleAssignment[] {
        return this.db.prepare(
            'SELECT * FROM role_assignments WHERE user_id = ? ORDER BY resource_type, resource_id'
        ).all(userId) as RoleAssignment[];
    }

    public addRoleAssignment(assignment: { user_id: number; role: UserRole; resource_type: ResourceType; resource_id: string }): number {
        const now = Date.now();
        const result = this.db.prepare(
            'INSERT INTO role_assignments (user_id, role, resource_type, resource_id, created_at) VALUES (?, ?, ?, ?, ?)'
        ).run(assignment.user_id, assignment.role, assignment.resource_type, assignment.resource_id, now);
        return result.lastInsertRowid as number;
    }

    public getRoleAssignmentById(id: number): RoleAssignment | undefined {
        return this.db.prepare('SELECT * FROM role_assignments WHERE id = ?').get(id) as RoleAssignment | undefined;
    }

    public deleteRoleAssignment(id: number): void {
        this.db.prepare('DELETE FROM role_assignments WHERE id = ?').run(id);
    }

    public deleteRoleAssignmentsByUser(userId: number): void {
        this.db.prepare('DELETE FROM role_assignments WHERE user_id = ?').run(userId);
    }

    public deleteRoleAssignmentsByResource(resourceType: ResourceType, resourceId: string): void {
        this.db.prepare('DELETE FROM role_assignments WHERE resource_type = ? AND resource_id = ?').run(resourceType, resourceId);
    }

    // --- SSO Config ---

    public getSSOConfigs(): SSOConfig[] {
        return this.db.prepare('SELECT * FROM sso_config ORDER BY provider ASC').all() as SSOConfig[];
    }

    public getSSOConfig(provider: string): SSOConfig | undefined {
        return this.db.prepare('SELECT * FROM sso_config WHERE provider = ?').get(provider) as SSOConfig | undefined;
    }

    public getEnabledSSOConfigs(): SSOConfig[] {
        return this.db.prepare('SELECT * FROM sso_config WHERE enabled = 1 ORDER BY provider ASC').all() as SSOConfig[];
    }

    public upsertSSOConfig(provider: string, enabled: boolean, configJson: string): void {
        const now = Date.now();
        const existing = this.getSSOConfig(provider);
        if (existing) {
            this.db.prepare('UPDATE sso_config SET enabled = ?, config_json = ?, updated_at = ? WHERE provider = ?')
                .run(enabled ? 1 : 0, configJson, now, provider);
        } else {
            this.db.prepare('INSERT INTO sso_config (provider, enabled, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
                .run(provider, enabled ? 1 : 0, configJson, now, now);
        }
    }

    public deleteSSOConfig(provider: string): void {
        this.db.prepare('DELETE FROM sso_config WHERE provider = ?').run(provider);
    }

    // --- Fleet Snapshots ---

    public createSnapshot(description: string, createdBy: string, nodeCount: number, stackCount: number, skippedNodes: string): number {
        const result = this.db.prepare(
            'INSERT INTO fleet_snapshots (description, created_by, node_count, stack_count, skipped_nodes, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(description, createdBy, nodeCount, stackCount, skippedNodes, Date.now());
        return result.lastInsertRowid as number;
    }

    public insertSnapshotFiles(snapshotId: number, files: Array<{ nodeId: number; nodeName: string; stackName: string; filename: string; content: string }>): void {
        const insert = this.db.prepare(
            'INSERT INTO fleet_snapshot_files (snapshot_id, node_id, node_name, stack_name, filename, content) VALUES (?, ?, ?, ?, ?, ?)'
        );
        const insertMany = this.db.transaction((rows: Array<{ nodeId: number; nodeName: string; stackName: string; filename: string; content: string }>) => {
            for (const row of rows) {
                insert.run(snapshotId, row.nodeId, row.nodeName, row.stackName, row.filename, row.content);
            }
        });
        insertMany(files);
    }

    public getSnapshots(limit = 50, offset = 0): FleetSnapshot[] {
        return this.db.prepare(
            'SELECT * FROM fleet_snapshots ORDER BY created_at DESC LIMIT ? OFFSET ?'
        ).all(limit, offset) as FleetSnapshot[];
    }

    public getSnapshot(id: number): FleetSnapshot | undefined {
        return this.db.prepare('SELECT * FROM fleet_snapshots WHERE id = ?').get(id) as FleetSnapshot | undefined;
    }

    public getSnapshotFiles(snapshotId: number): FleetSnapshotFile[] {
        return this.db.prepare(
            'SELECT * FROM fleet_snapshot_files WHERE snapshot_id = ? ORDER BY node_name, stack_name'
        ).all(snapshotId) as FleetSnapshotFile[];
    }

    public getSnapshotStackFiles(snapshotId: number, nodeId: number, stackName: string): FleetSnapshotFile[] {
        return this.db.prepare(
            'SELECT * FROM fleet_snapshot_files WHERE snapshot_id = ? AND node_id = ? AND stack_name = ?'
        ).all(snapshotId, nodeId, stackName) as FleetSnapshotFile[];
    }

    public deleteSnapshot(id: number): void {
        this.db.prepare('DELETE FROM fleet_snapshots WHERE id = ?').run(id);
    }

    public getSnapshotCount(): number {
        return (this.db.prepare('SELECT COUNT(*) as count FROM fleet_snapshots').get() as { count: number })?.count || 0;
    }

    // --- Audit Log ---

    public insertAuditLog(entry: Omit<AuditLogEntry, 'id'>): void {
        this.auditLogBuffer.push(entry);
        if (this.auditLogBuffer.length >= AUDIT_LOG_FLUSH_THRESHOLD) {
            this.flushAuditLogBuffer();
            return;
        }
        if (!this.auditLogFlushTimer) {
            // unref(): the buffer flush should not by itself keep the process
            // alive. The HTTP server keeps the event loop running during
            // normal operation; on shutdown, the explicit flush in
            // bootstrap/shutdown.ts drains the buffer before db.close().
            this.auditLogFlushTimer = setTimeout(
                () => this.flushAuditLogBuffer(),
                AUDIT_LOG_FLUSH_INTERVAL_MS,
            );
            this.auditLogFlushTimer.unref();
        }
    }

    /**
     * Drain the audit-log buffer to disk in a single transaction. Safe to
     * call from any path: read methods flush before querying so callers
     * observe buffered writes, and the shutdown handler flushes before the
     * DB connection closes.
     */
    public flushAuditLogBuffer(): void {
        if (this.auditLogFlushTimer) {
            clearTimeout(this.auditLogFlushTimer);
            this.auditLogFlushTimer = null;
        }
        if (this.auditLogBuffer.length === 0) return;
        // Swap the buffer reference before running the transaction. Any
        // re-entrant insertAuditLog call (e.g. from a future hook that audits
        // its own writes) lands on the new empty buffer and survives to the
        // next flush, instead of being captured into the in-flight batch and
        // potentially dropped on transaction failure.
        const batch = this.auditLogBuffer;
        this.auditLogBuffer = [];
        if (!this.auditLogInsertStmt) {
            this.auditLogInsertStmt = this.db.prepare(
                'INSERT INTO audit_log (timestamp, username, method, path, status_code, node_id, ip_address, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            );
        }
        const stmt = this.auditLogInsertStmt;
        const insertMany = this.db.transaction((entries: typeof batch) => {
            for (const entry of entries) {
                stmt.run(
                    entry.timestamp,
                    entry.username,
                    entry.method,
                    entry.path,
                    entry.status_code,
                    entry.node_id,
                    entry.ip_address,
                    entry.summary,
                );
            }
        });
        try {
            insertMany(batch);
        } catch (err) {
            console.error('[Audit] Failed to flush audit log buffer:', err);
        }
    }

    public getAuditLogs(filters: {
        page?: number;
        limit?: number;
        username?: string;
        method?: string;
        from?: number;
        to?: number;
        search?: string;
    } = {}): { entries: AuditLogEntry[]; total: number } {
        this.flushAuditLogBuffer();
        const page = filters.page ?? 1;
        const limit = filters.limit ?? 50;
        const offset = (page - 1) * limit;

        const conditions: string[] = [];
        const params: (string | number)[] = [];

        if (filters.username) {
            conditions.push('username = ?');
            params.push(filters.username);
        }
        if (filters.method) {
            conditions.push('method = ?');
            params.push(filters.method);
        }
        if (filters.from) {
            conditions.push('timestamp >= ?');
            params.push(filters.from);
        }
        if (filters.to) {
            conditions.push('timestamp <= ?');
            params.push(filters.to);
        }
        if (filters.search) {
            conditions.push('(summary LIKE ? OR path LIKE ? OR username LIKE ?)');
            const term = `%${filters.search}%`;
            params.push(term, term, term);
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const total = (this.db.prepare(`SELECT COUNT(*) as count FROM audit_log ${where}`).get(...params) as { count: number })?.count || 0;
        const entries = this.db.prepare(
            `SELECT * FROM audit_log ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`
        ).all(...params, limit, offset) as AuditLogEntry[];

        return { entries, total };
    }

    public cleanupOldAuditLogs(daysToKeep = 90): void {
        this.flushAuditLogBuffer();
        const cutoff = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
        this.db.prepare('DELETE FROM audit_log WHERE timestamp < ?').run(cutoff);
    }

    public getAuditLogsInRange(from: number, to: number, limit?: number): AuditLogEntry[] {
        this.flushAuditLogBuffer();
        if (limit !== undefined) {
            // Cap to the most-recent `limit` rows in the window, then return
            // them in ascending order to preserve this method's contract.
            return this.db.prepare(
                `SELECT * FROM (
                   SELECT * FROM audit_log WHERE timestamp >= ? AND timestamp < ?
                   ORDER BY timestamp DESC LIMIT ?
                 ) ORDER BY timestamp ASC`
            ).all(from, to, limit) as AuditLogEntry[];
        }
        return this.db.prepare(
            'SELECT * FROM audit_log WHERE timestamp >= ? AND timestamp < ? ORDER BY timestamp ASC'
        ).all(from, to) as AuditLogEntry[];
    }

    /**
     * Exact aggregate inputs for the audit signal-rail stats, computed with SQL
     * COUNT / GROUP BY rather than materializing rows. The counts and hourly
     * series stay exact regardless of window size (no row cap), while the
     * new-ip detection works over the small DISTINCT (user, ip) pair sets.
     */
    public getAuditStatsInputs(now: number): AuditStatsInput {
        this.flushAuditLogBuffer();
        const cutoff24h = now - 24 * 60 * 60 * 1000;
        const cutoff7d = now - 7 * 24 * 60 * 60 * 1000;
        const cutoff30d = now - 30 * 24 * 60 * 60 * 1000;
        // Every current-window query is upper-bounded by `now` so a future-dated
        // row (clock skew, a test fixture) never inflates the live counts.
        const countOf = (sql: string, ...params: number[]): number =>
            (this.db.prepare(sql).get(...params) as { c: number }).c;

        const events24 = countOf('SELECT COUNT(*) AS c FROM audit_log WHERE timestamp >= ? AND timestamp < ?', cutoff24h, now);
        const events7d = countOf('SELECT COUNT(*) AS c FROM audit_log WHERE timestamp >= ? AND timestamp < ?', cutoff7d, now);
        const actors24 = countOf("SELECT COUNT(DISTINCT username) AS c FROM audit_log WHERE timestamp >= ? AND timestamp < ? AND username != ''", cutoff24h, now);
        const failures24 = countOf('SELECT COUNT(*) AS c FROM audit_log WHERE timestamp >= ? AND timestamp < ? AND status_code >= 400', cutoff24h, now);

        const activityByHour = Array.from({ length: 24 }, () => 0);
        const failuresByHour = Array.from({ length: 24 }, () => 0);
        const hourRows = this.db.prepare(
            `SELECT CAST(strftime('%H', timestamp / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
                    COUNT(*) AS total,
                    SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS failures
             FROM audit_log WHERE timestamp >= ? AND timestamp < ? GROUP BY hour`,
        ).all(cutoff24h, now) as { hour: number; total: number; failures: number }[];
        for (const r of hourRows) {
            if (r.hour >= 0 && r.hour < 24) {
                activityByHour[r.hour] = r.total;
                failuresByHour[r.hour] = r.failures;
            }
        }

        // ORDER BY makes both the new-ip scan and the sample actor deterministic.
        const recentPairs = this.db.prepare(
            "SELECT DISTINCT username, ip_address FROM audit_log WHERE timestamp >= ? AND timestamp < ? AND username != '' AND ip_address != '' ORDER BY username, ip_address",
        ).all(cutoff24h, now) as { username: string; ip_address: string }[];
        const priorPairs = this.db.prepare(
            "SELECT DISTINCT username, ip_address FROM audit_log WHERE timestamp >= ? AND timestamp < ? AND username != '' AND ip_address != ''",
        ).all(cutoff30d, cutoff24h) as { username: string; ip_address: string }[];
        const priorByActor = new Map<string, Set<string>>();
        for (const p of priorPairs) {
            let set = priorByActor.get(p.username);
            if (!set) { set = new Set(); priorByActor.set(p.username, set); }
            set.add(p.ip_address);
        }
        let newIpCount = 0;
        let sampleNewIpActor: string | null = null;
        for (const p of recentPairs) {
            const prior = priorByActor.get(p.username);
            if (prior && prior.size > 0 && !prior.has(p.ip_address)) {
                newIpCount++;
                if (!sampleNewIpActor) sampleNewIpActor = p.username;
            }
        }

        return { events24, events7d, actors24, failures24, activityByHour, failuresByHour, newIpCount, sampleNewIpActor };
    }

    // --- API Tokens ---

    public addApiToken(token: Omit<ApiToken, 'id' | 'last_used_at' | 'revoked_at'>): number {
        const result = this.db.prepare(
            'INSERT INTO api_tokens (token_hash, name, scope, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(token.token_hash, token.name, token.scope, token.user_id, token.created_at, token.expires_at);
        return result.lastInsertRowid as number;
    }

    public getApiTokensByUser(userId: number): ApiToken[] {
        return this.db.prepare(
            'SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC'
        ).all(userId) as ApiToken[];
    }

    public getApiTokenByHash(tokenHash: string): ApiToken | undefined {
        return this.db.prepare(
            'SELECT * FROM api_tokens WHERE token_hash = ?'
        ).get(tokenHash) as ApiToken | undefined;
    }

    public getApiTokenById(id: number): ApiToken | undefined {
        return this.db.prepare(
            'SELECT * FROM api_tokens WHERE id = ?'
        ).get(id) as ApiToken | undefined;
    }

    public revokeApiToken(id: number): void {
        this.db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ?').run(Date.now(), id);
    }

    public updateApiTokenLastUsed(id: number): void {
        this.db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(Date.now(), id);
    }

    public getActiveApiTokenCountByUser(userId: number): number {
        const row = this.db.prepare(
            'SELECT COUNT(*) AS cnt FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL'
        ).get(userId) as { cnt: number };
        return row.cnt;
    }

    public getActiveApiTokenByNameAndUser(name: string, userId: number): ApiToken | undefined {
        return this.db.prepare(
            'SELECT * FROM api_tokens WHERE name = ? AND user_id = ? AND revoked_at IS NULL LIMIT 1'
        ).get(name, userId) as ApiToken | undefined;
    }

    // --- Registries ---

    public getRegistries(): Registry[] {
        return this.db.prepare('SELECT * FROM registries ORDER BY name ASC').all() as Registry[];
    }

    public getRegistry(id: number): Registry | undefined {
        return this.db.prepare('SELECT * FROM registries WHERE id = ?').get(id) as Registry | undefined;
    }

    public addRegistry(reg: Omit<Registry, 'id'>): number {
        const result = this.db.prepare(
            'INSERT INTO registries (name, url, type, username, secret, aws_region, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(reg.name, reg.url, reg.type, reg.username, reg.secret, reg.aws_region, reg.created_at, reg.updated_at);
        return result.lastInsertRowid as number;
    }

    public updateRegistry(id: number, updates: Partial<Omit<Registry, 'id' | 'created_at'>>): void {
        const fields: string[] = [];
        const values: unknown[] = [];

        if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
        if (updates.url !== undefined) { fields.push('url = ?'); values.push(updates.url); }
        if (updates.type !== undefined) { fields.push('type = ?'); values.push(updates.type); }
        if (updates.username !== undefined) { fields.push('username = ?'); values.push(updates.username); }
        if (updates.secret !== undefined) { fields.push('secret = ?'); values.push(updates.secret); }
        if (updates.aws_region !== undefined) { fields.push('aws_region = ?'); values.push(updates.aws_region); }
        if (updates.updated_at !== undefined) { fields.push('updated_at = ?'); values.push(updates.updated_at); }

        if (fields.length === 0) return;

        values.push(id);
        this.db.prepare(`UPDATE registries SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    }

    public deleteRegistry(id: number): void {
        this.db.prepare('DELETE FROM registries WHERE id = ?').run(id);
    }

    // --- Stack Git Sources ---

    private parseGitSource(row: Record<string, unknown> | undefined): StackGitSource | undefined {
        if (!row) return undefined;
        return {
            id: row.id as number,
            stack_name: row.stack_name as string,
            repo_url: row.repo_url as string,
            branch: row.branch as string,
            compose_path: row.compose_path as string,
            sync_env: Number(row.sync_env) === 1,
            env_path: (row.env_path as string | null) ?? null,
            auth_type: row.auth_type as GitSourceAuthType,
            encrypted_token: (row.encrypted_token as string | null) ?? null,
            auto_apply_on_webhook: Number(row.auto_apply_on_webhook) === 1,
            auto_deploy_on_apply: Number(row.auto_deploy_on_apply) === 1,
            last_applied_commit_sha: (row.last_applied_commit_sha as string | null) ?? null,
            last_applied_content_hash: (row.last_applied_content_hash as string | null) ?? null,
            pending_commit_sha: (row.pending_commit_sha as string | null) ?? null,
            pending_compose_content: (row.pending_compose_content as string | null) ?? null,
            pending_env_content: (row.pending_env_content as string | null) ?? null,
            pending_fetched_at: (row.pending_fetched_at as number | null) ?? null,
            last_debounce_at: (row.last_debounce_at as number | null) ?? null,
            created_at: row.created_at as number,
            updated_at: row.updated_at as number,
        };
    }

    public getGitSource(stackName: string): StackGitSource | undefined {
        const row = this.db.prepare('SELECT * FROM stack_git_sources WHERE stack_name = ?').get(stackName) as Record<string, unknown> | undefined;
        return this.parseGitSource(row);
    }

    public getGitSources(): StackGitSource[] {
        const rows = this.db.prepare('SELECT * FROM stack_git_sources ORDER BY stack_name ASC').all() as Record<string, unknown>[];
        return rows.map(r => this.parseGitSource(r)!);
    }

    public upsertGitSource(source: Omit<StackGitSource, 'id' | 'created_at' | 'updated_at'>): number {
        const now = Date.now();
        const existing = this.getGitSource(source.stack_name);
        if (existing) {
            this.db.prepare(
                `UPDATE stack_git_sources SET
                    repo_url = ?, branch = ?, compose_path = ?, sync_env = ?, env_path = ?,
                    auth_type = ?, encrypted_token = ?,
                    auto_apply_on_webhook = ?, auto_deploy_on_apply = ?,
                    updated_at = ?
                 WHERE stack_name = ?`
            ).run(
                source.repo_url, source.branch, source.compose_path,
                source.sync_env ? 1 : 0, source.env_path,
                source.auth_type, source.encrypted_token,
                source.auto_apply_on_webhook ? 1 : 0, source.auto_deploy_on_apply ? 1 : 0,
                now, source.stack_name
            );
            return existing.id!;
        }
        const result = this.db.prepare(
            `INSERT INTO stack_git_sources
                (stack_name, repo_url, branch, compose_path, sync_env, env_path,
                 auth_type, encrypted_token, auto_apply_on_webhook, auto_deploy_on_apply,
                 created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
            source.stack_name, source.repo_url, source.branch, source.compose_path,
            source.sync_env ? 1 : 0, source.env_path,
            source.auth_type, source.encrypted_token,
            source.auto_apply_on_webhook ? 1 : 0, source.auto_deploy_on_apply ? 1 : 0,
            now, now
        );
        return result.lastInsertRowid as number;
    }

    public deleteGitSource(stackName: string): void {
        this.db.prepare('DELETE FROM stack_git_sources WHERE stack_name = ?').run(stackName);
    }

    public setGitSourcePending(stackName: string, commitSha: string, composeContent: string, envContent: string | null): void {
        this.db.prepare(
            `UPDATE stack_git_sources SET
                pending_commit_sha = ?,
                pending_compose_content = ?,
                pending_env_content = ?,
                pending_fetched_at = ?,
                updated_at = ?
             WHERE stack_name = ?`
        ).run(commitSha, composeContent, envContent, Date.now(), Date.now(), stackName);
    }

    public clearGitSourcePending(stackName: string): void {
        this.db.prepare(
            `UPDATE stack_git_sources SET
                pending_commit_sha = NULL,
                pending_compose_content = NULL,
                pending_env_content = NULL,
                pending_fetched_at = NULL,
                updated_at = ?
             WHERE stack_name = ?`
        ).run(Date.now(), stackName);
    }

    public markGitSourceApplied(stackName: string, commitSha: string, contentHash: string): void {
        this.db.prepare(
            `UPDATE stack_git_sources SET
                last_applied_commit_sha = ?,
                last_applied_content_hash = ?,
                pending_commit_sha = NULL,
                pending_compose_content = NULL,
                pending_env_content = NULL,
                pending_fetched_at = NULL,
                updated_at = ?
             WHERE stack_name = ?`
        ).run(commitSha, contentHash, Date.now(), stackName);
    }

    public touchGitSourceDebounce(stackName: string): void {
        this.db.prepare('UPDATE stack_git_sources SET last_debounce_at = ? WHERE stack_name = ?')
            .run(Date.now(), stackName);
    }

    // --- Scheduled Tasks ---

    public getScheduledTasks(): ScheduledTask[] {
        return this.db.prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC').all() as ScheduledTask[];
    }

    public getScheduledTask(id: number): ScheduledTask | undefined {
        return this.db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as ScheduledTask | undefined;
    }

    public createScheduledTask(task: Omit<ScheduledTask, 'id'>): number {
        const result = this.db.prepare(
            'INSERT INTO scheduled_tasks (name, target_type, target_id, node_id, action, cron_expression, enabled, created_by, created_at, updated_at, last_run_at, next_run_at, last_status, last_error, prune_targets, target_services, prune_label_filter, delete_after_run) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(
            task.name, task.target_type, task.target_id, task.node_id,
            task.action, task.cron_expression, task.enabled, task.created_by,
            task.created_at, task.updated_at, task.last_run_at, task.next_run_at,
            task.last_status, task.last_error, task.prune_targets, task.target_services,
            task.prune_label_filter, task.delete_after_run ?? 0
        );
        return result.lastInsertRowid as number;
    }

    public updateScheduledTask(id: number, updates: Partial<Omit<ScheduledTask, 'id'>>): void {
        const fields: string[] = [];
        const values: unknown[] = [];

        const map: Record<string, unknown> = {
            name: updates.name, target_type: updates.target_type, target_id: updates.target_id,
            node_id: updates.node_id, action: updates.action, cron_expression: updates.cron_expression,
            enabled: updates.enabled, created_by: updates.created_by, updated_at: updates.updated_at,
            last_run_at: updates.last_run_at, next_run_at: updates.next_run_at,
            last_status: updates.last_status, last_error: updates.last_error,
            prune_targets: updates.prune_targets, target_services: updates.target_services,
            prune_label_filter: updates.prune_label_filter,
            delete_after_run: updates.delete_after_run,
        };

        for (const [col, val] of Object.entries(map)) {
            if (val !== undefined) {
                fields.push(`${col} = ?`);
                values.push(val);
            }
        }

        if (fields.length === 0) return;
        values.push(id);
        this.db.prepare(`UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    }

    public deleteScheduledTask(id: number): void {
        this.db.transaction(() => {
            this.db.prepare('DELETE FROM scheduled_task_runs WHERE task_id = ?').run(id);
            this.db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
        })();
    }

    public getDueScheduledTasks(now: number): ScheduledTask[] {
        return this.db.prepare(
            'SELECT * FROM scheduled_tasks WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?'
        ).all(now) as ScheduledTask[];
    }

    public getScheduledTaskRuns(taskId: number, limit = 20, offset = 0): { runs: ScheduledTaskRun[]; total: number } {
        const runs = this.db.prepare(
            'SELECT * FROM scheduled_task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ? OFFSET ?'
        ).all(taskId, limit, offset) as ScheduledTaskRun[];
        const { total } = this.db.prepare(
            'SELECT COUNT(*) as total FROM scheduled_task_runs WHERE task_id = ?'
        ).get(taskId) as { total: number };
        return { runs, total };
    }

    public createScheduledTaskRun(run: Omit<ScheduledTaskRun, 'id'>): number {
        const result = this.db.prepare(
            'INSERT INTO scheduled_task_runs (task_id, started_at, completed_at, status, output, error, triggered_by) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(run.task_id, run.started_at, run.completed_at, run.status, run.output, run.error, run.triggered_by);
        return result.lastInsertRowid as number;
    }

    public updateScheduledTaskRun(id: number, updates: Partial<Omit<ScheduledTaskRun, 'id' | 'task_id'>>): void {
        const fields: string[] = [];
        const values: unknown[] = [];

        if (updates.completed_at !== undefined) { fields.push('completed_at = ?'); values.push(updates.completed_at); }
        if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
        if (updates.output !== undefined) { fields.push('output = ?'); values.push(updates.output); }
        if (updates.error !== undefined) { fields.push('error = ?'); values.push(updates.error); }

        if (fields.length === 0) return;
        values.push(id);
        this.db.prepare(`UPDATE scheduled_task_runs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    }

    public getAllScheduledTaskRuns(taskId: number): ScheduledTaskRun[] {
        return this.db.prepare(
            'SELECT * FROM scheduled_task_runs WHERE task_id = ? ORDER BY started_at DESC'
        ).all(taskId) as ScheduledTaskRun[];
    }

    public markStaleRunsAsFailed(): number {
        const result = this.db.prepare(
            'UPDATE scheduled_task_runs SET status = ?, completed_at = ?, error = ? WHERE status = ?'
        ).run('failure', Date.now(), 'Server restarted during execution', 'running');
        return result.changes;
    }

    public cleanupOldTaskRuns(retentionDays = 30): void {
        const cutoff = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
        this.db.prepare('DELETE FROM scheduled_task_runs WHERE started_at < ?').run(cutoff);
    }

    // --- Vulnerability Scans ---

    public createVulnerabilityScan(
        scan: Omit<VulnerabilityScan, 'id' | 'policy_evaluation'> & {
            policy_evaluation?: string | null;
        },
    ): number {
        const stmt = this.db.prepare(
            `INSERT INTO vulnerability_scans (
                node_id, image_ref, image_digest, scanned_at,
                total_vulnerabilities, critical_count, high_count, medium_count,
                low_count, unknown_count, fixable_count,
                secret_count, misconfig_count, scanners_used,
                highest_severity, os_info, trivy_version, scan_duration_ms,
                triggered_by, status, error, stack_context, policy_evaluation
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const result = stmt.run(
            scan.node_id,
            scan.image_ref,
            scan.image_digest,
            scan.scanned_at,
            scan.total_vulnerabilities,
            scan.critical_count,
            scan.high_count,
            scan.medium_count,
            scan.low_count,
            scan.unknown_count,
            scan.fixable_count,
            scan.secret_count,
            scan.misconfig_count,
            scan.scanners_used,
            scan.highest_severity,
            scan.os_info,
            scan.trivy_version,
            scan.scan_duration_ms,
            scan.triggered_by,
            scan.status,
            scan.error,
            scan.stack_context,
            scan.policy_evaluation ?? null,
        );
        return result.lastInsertRowid as number;
    }

    public updateVulnerabilityScan(
        id: number,
        updates: Partial<Omit<VulnerabilityScan, 'id'>>,
    ): void {
        const ALLOWED_COLUMNS = new Set([
            'node_id', 'image_ref', 'image_digest', 'scanned_at',
            'total_vulnerabilities', 'critical_count', 'high_count',
            'medium_count', 'low_count', 'unknown_count', 'fixable_count',
            'secret_count', 'misconfig_count', 'scanners_used',
            'highest_severity', 'os_info', 'trivy_version', 'scan_duration_ms',
            'triggered_by', 'status', 'error', 'stack_context', 'policy_evaluation',
        ]);
        const fields: string[] = [];
        const values: unknown[] = [];
        for (const [key, value] of Object.entries(updates)) {
            if (!ALLOWED_COLUMNS.has(key)) continue;
            fields.push(`${key} = ?`);
            values.push(value);
        }
        if (fields.length === 0) return;
        values.push(id);
        this.db
            .prepare(`UPDATE vulnerability_scans SET ${fields.join(', ')} WHERE id = ?`)
            .run(...(values as never[]));
    }

    public getVulnerabilityScan(id: number): VulnerabilityScan | null {
        return (
            (this.db
                .prepare('SELECT * FROM vulnerability_scans WHERE id = ?')
                .get(id) as VulnerabilityScan | undefined) ?? null
        );
    }

    public getVulnerabilityScans(
        nodeId: number,
        opts: { imageRef?: string; imageRefLike?: string; status?: VulnScanStatus; limit?: number; offset?: number } = {},
    ): { items: VulnerabilityScan[]; total: number; cappedImageRefs: string[]; perImageLimit: number } {
        const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
        const offset = Math.max(0, opts.offset ?? 0);
        const where = ['node_id = ?'];
        const params: unknown[] = [nodeId];
        if (opts.imageRef) {
            where.push('image_ref = ?');
            params.push(opts.imageRef);
        }
        if (opts.imageRefLike) {
            where.push('image_ref LIKE ?');
            params.push(`%${opts.imageRefLike}%`);
        }
        if (opts.status) {
            where.push('status = ?');
            params.push(opts.status);
        }
        const whereSql = where.join(' AND ');

        // Grouped (history) view caps rows per image_ref so a hot image
        // cannot drown out the others. Single-image deep-dive (imageRef set)
        // bypasses the cap so users can drill past it.
        const applyPerImageCap = !opts.imageRef;
        const parsedLimit = parseInt(this.getGlobalSettings()['scan_history_per_image_limit'] ?? '50', 10);
        const perImageLimit = parsedLimit > 0 ? parsedLimit : 50;

        if (!applyPerImageCap) {
            const total = (
                this.db
                    .prepare(`SELECT COUNT(*) as cnt FROM vulnerability_scans WHERE ${whereSql}`)
                    .get(...(params as never[])) as { cnt: number }
            ).cnt;
            const items = this.db
                .prepare(
                    `SELECT * FROM vulnerability_scans WHERE ${whereSql} ORDER BY scanned_at DESC LIMIT ? OFFSET ?`,
                )
                .all(...(params as never[]), limit, offset) as VulnerabilityScan[];
            return { items, total, cappedImageRefs: [], perImageLimit };
        }

        const rankedCte = `WITH ranked AS (
            SELECT *, ROW_NUMBER() OVER (PARTITION BY image_ref ORDER BY scanned_at DESC) AS rn
            FROM vulnerability_scans
            WHERE ${whereSql}
        )`;
        const total = (
            this.db
                .prepare(`${rankedCte} SELECT COUNT(*) as cnt FROM ranked WHERE rn <= ?`)
                .get(...(params as never[]), perImageLimit) as { cnt: number }
        ).cnt;
        const items = this.db
            .prepare(
                `${rankedCte} SELECT id, node_id, image_ref, image_digest, scanned_at,
                    total_vulnerabilities, critical_count, high_count, medium_count, low_count,
                    unknown_count, fixable_count, secret_count, misconfig_count, scanners_used,
                    highest_severity, os_info, trivy_version, scan_duration_ms, triggered_by,
                    status, error, stack_context, policy_evaluation
                 FROM ranked WHERE rn <= ?
                 ORDER BY scanned_at DESC LIMIT ? OFFSET ?`,
            )
            .all(...(params as never[]), perImageLimit, limit, offset) as VulnerabilityScan[];

        // Identify which image_refs sit at or above the cap so the UI can
        // flag them. `>=` (not `>`) is intentional: the daily prune keeps
        // each image at exactly perImageLimit rows, so by the time a user
        // opens the history sheet the underlying count rarely exceeds the
        // cap. Flagging at-cap groups still tells the truth (older scans
        // have been or will be pruned at this image's next scan).
        const cappedRows = this.db
            .prepare(
                `SELECT image_ref FROM vulnerability_scans
                 WHERE ${whereSql}
                 GROUP BY image_ref HAVING COUNT(*) >= ?`,
            )
            .all(...(params as never[]), perImageLimit) as Array<{ image_ref: string }>;
        const cappedImageRefs = cappedRows.map((r) => r.image_ref);

        return { items, total, cappedImageRefs, perImageLimit };
    }

    /**
     * Per-image scan history pruner. For each (node_id, image_ref), keep the
     * newest N scans (ordered by scanned_at DESC) and delete older rows along
     * with their child findings. SQLite foreign-key cascade is not enabled
     * at the connection level here, so children are deleted explicitly. The
     * subquery is self-contained so we don't bind one parameter per ID. A
     * first-run backlog of thousands of stale scans would otherwise blow
     * past SQLITE_MAX_VARIABLE_NUMBER.
     */
    public pruneScanHistoryPerImage(perImageLimit: number): number {
        const limit = Math.max(1, Math.floor(perImageLimit));
        const overflowSubquery = `SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (
              PARTITION BY node_id, image_ref ORDER BY scanned_at DESC
            ) AS rn
            FROM vulnerability_scans
          ) WHERE rn > ?`;
        const deleteChild = (table: string) =>
            this.db
                .prepare(`DELETE FROM ${table} WHERE scan_id IN (${overflowSubquery})`)
                .run(limit);
        const deleteParent = this.db.prepare(
            `DELETE FROM vulnerability_scans WHERE id IN (${overflowSubquery})`,
        );

        const txn = this.db.transaction(() => {
            deleteChild('vulnerability_details');
            deleteChild('secret_findings');
            deleteChild('misconfig_findings');
            return deleteParent.run(limit).changes;
        });
        return txn();
    }

    public getLatestScanForImage(
        nodeId: number,
        imageRef: string,
    ): VulnerabilityScan | null {
        return (
            (this.db
                .prepare(
                    'SELECT * FROM vulnerability_scans WHERE node_id = ? AND image_ref = ? ORDER BY scanned_at DESC LIMIT 1',
                )
                .get(nodeId, imageRef) as VulnerabilityScan | undefined) ?? null
        );
    }

    public getLatestScanSummaryByImageRefs(
        nodeId: number,
        imageRefs: string[],
    ): Map<string, { total: number; critical: number; high: number; scannedAt: number }> {
        const summary = new Map<string, { total: number; critical: number; high: number; scannedAt: number }>();
        if (imageRefs.length === 0) return summary;

        const placeholders = imageRefs.map(() => '?').join(',');
        const rows = this.db
            .prepare(
                `SELECT image_ref, total_vulnerabilities, critical_count, high_count, scanned_at
                 FROM vulnerability_scans v1
                 WHERE node_id = ?
                   AND image_ref IN (${placeholders})
                   AND scanned_at = (
                     SELECT MAX(scanned_at) FROM vulnerability_scans v2
                     WHERE v2.node_id = v1.node_id AND v2.image_ref = v1.image_ref
                   )`,
            )
            .all(nodeId, ...imageRefs) as Array<{
                image_ref: string;
                total_vulnerabilities: number;
                critical_count: number;
                high_count: number;
                scanned_at: number;
            }>;

        for (const row of rows) {
            summary.set(row.image_ref, {
                total: row.total_vulnerabilities,
                critical: row.critical_count,
                high: row.high_count,
                scannedAt: row.scanned_at,
            });
        }
        return summary;
    }

    public getLatestScanByDigest(digest: string, scannersUsed?: string): VulnerabilityScan | null {
        if (!digest) return null;
        if (scannersUsed) {
            return (
                (this.db
                    .prepare(
                        "SELECT * FROM vulnerability_scans WHERE image_digest = ? AND scanners_used = ? AND status = 'completed' ORDER BY scanned_at DESC LIMIT 1",
                    )
                    .get(digest, scannersUsed) as VulnerabilityScan | undefined) ?? null
            );
        }
        return (
            (this.db
                .prepare(
                    "SELECT * FROM vulnerability_scans WHERE image_digest = ? AND status = 'completed' ORDER BY scanned_at DESC LIMIT 1",
                )
                .get(digest) as VulnerabilityScan | undefined) ?? null
        );
    }

    public deleteOldScans(olderThanMs: number): number {
        const cutoff = Date.now() - olderThanMs;
        const result = this.db
            .prepare('DELETE FROM vulnerability_scans WHERE scanned_at < ?')
            .run(cutoff);
        return result.changes;
    }

    public markStaleScansAsFailed(olderThanMs: number): number {
        const cutoff = Date.now() - olderThanMs;
        const result = this.db
            .prepare(
                `UPDATE vulnerability_scans
                 SET status = 'failed',
                     error = 'Scan did not complete within expected time',
                     scan_duration_ms = ? - scanned_at
                 WHERE status = 'in_progress' AND scanned_at < ?`,
            )
            .run(Date.now(), cutoff);
        return result.changes;
    }

    public isImageBeingScanned(nodeId: number, imageRef: string): boolean {
        const row = this.db
            .prepare(
                "SELECT id FROM vulnerability_scans WHERE node_id = ? AND image_ref = ? AND status = 'in_progress' LIMIT 1",
            )
            .get(nodeId, imageRef);
        return !!row;
    }

    public insertVulnerabilityDetails(
        scanId: number,
        details: Array<Omit<VulnerabilityDetail, 'id' | 'scan_id'>>,
    ): void {
        if (details.length === 0) return;
        const stmt = this.db.prepare(
            `INSERT INTO vulnerability_details (
                scan_id, vulnerability_id, pkg_name, installed_version,
                fixed_version, severity, title, description, primary_url
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const txn = this.db.transaction((rows: typeof details) => {
            for (const d of rows) {
                stmt.run(
                    scanId,
                    d.vulnerability_id,
                    d.pkg_name,
                    d.installed_version,
                    d.fixed_version,
                    d.severity,
                    d.title,
                    d.description,
                    d.primary_url,
                );
            }
        });
        txn(details);
    }

    public getVulnerabilityDetails(
        scanId: number,
        opts: { severity?: VulnSeverity; limit?: number; offset?: number } = {},
    ): { items: VulnerabilityDetail[]; total: number } {
        const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
        const offset = Math.max(0, opts.offset ?? 0);
        const where = ['scan_id = ?'];
        const params: unknown[] = [scanId];
        if (opts.severity) {
            where.push('severity = ?');
            params.push(opts.severity);
        }
        const whereSql = where.join(' AND ');
        const total = (
            this.db
                .prepare(`SELECT COUNT(*) as cnt FROM vulnerability_details WHERE ${whereSql}`)
                .get(...(params as never[])) as { cnt: number }
        ).cnt;
        const severityOrder = `CASE severity
            WHEN 'CRITICAL' THEN 0
            WHEN 'HIGH' THEN 1
            WHEN 'MEDIUM' THEN 2
            WHEN 'LOW' THEN 3
            ELSE 4 END`;
        const items = this.db
            .prepare(
                `SELECT * FROM vulnerability_details WHERE ${whereSql} ORDER BY ${severityOrder}, pkg_name LIMIT ? OFFSET ?`,
            )
            .all(...(params as never[]), limit, offset) as VulnerabilityDetail[];
        return { items, total };
    }

    public insertSecretFindings(
        scanId: number,
        findings: Array<Omit<SecretFinding, 'id' | 'scan_id'>>,
    ): void {
        if (findings.length === 0) return;
        const stmt = this.db.prepare(
            `INSERT INTO secret_findings (
                scan_id, rule_id, category, severity, title, target, start_line, end_line, match_excerpt
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const txn = this.db.transaction((rows: typeof findings) => {
            for (const f of rows) {
                stmt.run(
                    scanId,
                    f.rule_id,
                    f.category,
                    f.severity,
                    f.title,
                    f.target,
                    f.start_line,
                    f.end_line,
                    f.match_excerpt,
                );
            }
        });
        txn(findings);
    }

    public getSecretFindings(
        scanId: number,
        opts: { severity?: VulnSeverity; limit?: number; offset?: number } = {},
    ): { items: SecretFinding[]; total: number } {
        const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
        const offset = Math.max(0, opts.offset ?? 0);
        const where = ['scan_id = ?'];
        const params: unknown[] = [scanId];
        if (opts.severity) {
            where.push('severity = ?');
            params.push(opts.severity);
        }
        const whereSql = where.join(' AND ');
        const total = (
            this.db
                .prepare(`SELECT COUNT(*) as cnt FROM secret_findings WHERE ${whereSql}`)
                .get(...(params as never[])) as { cnt: number }
        ).cnt;
        const severityOrder = `CASE severity
            WHEN 'CRITICAL' THEN 0
            WHEN 'HIGH' THEN 1
            WHEN 'MEDIUM' THEN 2
            WHEN 'LOW' THEN 3
            ELSE 4 END`;
        const items = this.db
            .prepare(
                `SELECT * FROM secret_findings WHERE ${whereSql} ORDER BY ${severityOrder}, target LIMIT ? OFFSET ?`,
            )
            .all(...(params as never[]), limit, offset) as SecretFinding[];
        return { items, total };
    }

    public insertMisconfigFindings(
        scanId: number,
        findings: Array<Omit<MisconfigFinding, 'id' | 'scan_id'>>,
    ): void {
        if (findings.length === 0) return;
        const stmt = this.db.prepare(
            `INSERT INTO misconfig_findings (
                scan_id, rule_id, check_id, severity, title, message, resolution, target, primary_url
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const txn = this.db.transaction((rows: typeof findings) => {
            for (const f of rows) {
                stmt.run(
                    scanId,
                    f.rule_id,
                    f.check_id,
                    f.severity,
                    f.title,
                    f.message,
                    f.resolution,
                    f.target,
                    f.primary_url,
                );
            }
        });
        txn(findings);
    }

    public getMisconfigFindings(
        scanId: number,
        opts: { severity?: VulnSeverity; limit?: number; offset?: number } = {},
    ): { items: MisconfigFinding[]; total: number } {
        const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
        const offset = Math.max(0, opts.offset ?? 0);
        const where = ['scan_id = ?'];
        const params: unknown[] = [scanId];
        if (opts.severity) {
            where.push('severity = ?');
            params.push(opts.severity);
        }
        const whereSql = where.join(' AND ');
        const total = (
            this.db
                .prepare(`SELECT COUNT(*) as cnt FROM misconfig_findings WHERE ${whereSql}`)
                .get(...(params as never[])) as { cnt: number }
        ).cnt;
        const severityOrder = `CASE severity
            WHEN 'CRITICAL' THEN 0
            WHEN 'HIGH' THEN 1
            WHEN 'MEDIUM' THEN 2
            WHEN 'LOW' THEN 3
            ELSE 4 END`;
        const items = this.db
            .prepare(
                `SELECT * FROM misconfig_findings WHERE ${whereSql} ORDER BY ${severityOrder}, target LIMIT ? OFFSET ?`,
            )
            .all(...(params as never[]), limit, offset) as MisconfigFinding[];
        return { items, total };
    }

    public getImageScanSummaries(nodeId: number): Record<string, ScanSummary> {
        const rows = this.db
            .prepare(
                `SELECT vs.image_ref, vs.id as scan_id, vs.highest_severity, vs.total_vulnerabilities,
                    vs.critical_count, vs.high_count, vs.medium_count, vs.low_count,
                    vs.unknown_count, vs.fixable_count, vs.scanned_at
                 FROM vulnerability_scans vs
                 INNER JOIN (
                   SELECT image_ref, MAX(scanned_at) AS max_scanned
                   FROM vulnerability_scans
                   WHERE node_id = ? AND status = 'completed'
                   GROUP BY image_ref
                 ) latest ON latest.image_ref = vs.image_ref AND latest.max_scanned = vs.scanned_at
                 WHERE vs.node_id = ? AND vs.status = 'completed'`,
            )
            .all(nodeId, nodeId) as Array<{
                image_ref: string;
                scan_id: number;
                highest_severity: VulnSeverity | null;
                total_vulnerabilities: number;
                critical_count: number;
                high_count: number;
                medium_count: number;
                low_count: number;
                unknown_count: number;
                fixable_count: number;
                scanned_at: number;
            }>;
        const out: Record<string, ScanSummary> = {};
        for (const r of rows) {
            out[r.image_ref] = {
                image_ref: r.image_ref,
                highest_severity: r.highest_severity,
                total: r.total_vulnerabilities,
                critical: r.critical_count,
                high: r.high_count,
                medium: r.medium_count,
                low: r.low_count,
                unknown: r.unknown_count,
                fixable: r.fixable_count,
                scanned_at: r.scanned_at,
                scan_id: r.scan_id,
            };
        }
        return out;
    }

    // --- Scan Policies ---

    public getScanPolicies(): ScanPolicy[] {
        return this.db
            .prepare('SELECT * FROM scan_policies ORDER BY created_at DESC')
            .all() as ScanPolicy[];
    }

    /**
     * Local-only scan policies (created on this instance, not replicated from a
     * control). Used by the fleet sync sender so it never re-replicates rows
     * that came from a control in the first place.
     */
    public getLocalScanPolicies(): ScanPolicy[] {
        return this.db
            .prepare('SELECT * FROM scan_policies WHERE replicated_from_control = 0 ORDER BY created_at DESC')
            .all() as ScanPolicy[];
    }

    /**
     * Variant of `getScanPolicies` for the security-settings UI.
     *
     * On a control instance: returns the full set, identical to
     * `getScanPolicies`.
     *
     * On a replica: returns only the policies that apply to THIS replica.
     * Replicated rows scoped to a different replica's identity (the
     * `node_identity` of a sibling node in the fleet) are filtered out so
     * an operator on Replica A cannot enumerate the names of identity-scoped
     * policies meant for Replica B. Internal evaluators
     * (`getMatchingPolicy`, `evaluateScanAgainstPolicies`) keep using the
     * unfiltered list because they already enforce identity matching at
     * evaluation time.
     */
    public getScanPoliciesForUi(role: 'control' | 'replica', selfIdentity: string): ScanPolicy[] {
        const all = this.getScanPolicies();
        if (role === 'control') return all;
        return all.filter((p) => {
            if (p.replicated_from_control === 0) return true;
            // Fleet-wide replicated rows have an empty node_identity and
            // apply on every replica.
            if (!p.node_identity) return true;
            return p.node_identity === selfIdentity;
        });
    }

    public getScanPolicy(id: number): ScanPolicy | null {
        return (
            (this.db
                .prepare('SELECT * FROM scan_policies WHERE id = ?')
                .get(id) as ScanPolicy | undefined) ?? null
        );
    }

    public createScanPolicy(
        policy: Omit<ScanPolicy, 'id' | 'created_at' | 'updated_at'>,
    ): ScanPolicy {
        const now = Date.now();
        const result = this.db
            .prepare(
                `INSERT INTO scan_policies (name, node_id, node_identity, stack_pattern, max_severity, block_on_deploy, enabled, replicated_from_control, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                policy.name,
                policy.node_id,
                policy.node_identity ?? '',
                policy.stack_pattern,
                policy.max_severity,
                policy.block_on_deploy,
                policy.enabled,
                policy.replicated_from_control ?? 0,
                now,
                now,
            );
        return {
            ...policy,
            node_identity: policy.node_identity ?? '',
            replicated_from_control: policy.replicated_from_control ?? 0,
            id: result.lastInsertRowid as number,
            created_at: now,
            updated_at: now,
        };
    }

    public updateScanPolicy(
        id: number,
        updates: Partial<Omit<ScanPolicy, 'id' | 'created_at' | 'updated_at'>>,
    ): ScanPolicy | null {
        const existing = this.getScanPolicy(id);
        if (!existing) return null;
        const ALLOWED_COLUMNS = new Set([
            'name', 'node_id', 'node_identity', 'stack_pattern', 'max_severity',
            'block_on_deploy', 'enabled', 'replicated_from_control',
        ]);
        const fields: string[] = [];
        const values: unknown[] = [];
        for (const [key, value] of Object.entries(updates)) {
            if (!ALLOWED_COLUMNS.has(key)) continue;
            fields.push(`${key} = ?`);
            values.push(value);
        }
        if (fields.length === 0) return existing;
        fields.push('updated_at = ?');
        values.push(Date.now());
        values.push(id);
        this.db
            .prepare(`UPDATE scan_policies SET ${fields.join(', ')} WHERE id = ?`)
            .run(...(values as never[]));
        return this.getScanPolicy(id);
    }

    public deleteScanPolicy(id: number): void {
        // policy_evaluation is a JSON blob containing the policyId of the policy
        // that produced it. Clear it on every scan referencing the deleted policy
        // so cached scans no longer report stale violations after the policy is gone.
        const clearEval = this.db.prepare(
            `UPDATE vulnerability_scans
                SET policy_evaluation = NULL
              WHERE json_extract(policy_evaluation, '$.policyId') = ?`,
        );
        const deletePolicy = this.db.prepare('DELETE FROM scan_policies WHERE id = ?');
        const txn = this.db.transaction((policyId: number) => {
            clearEval.run(policyId);
            deletePolicy.run(policyId);
        });
        txn(id);
    }

    /**
     * Replace all policies that were replicated from a control node with the
     * provided rows in a single transaction. Local-only policies (created on
     * this instance directly) are left untouched.
     *
     * Replicated policies always insert with fresh ids on the replica, so any
     * `vulnerability_scans.policy_evaluation` row pointing at a replicated
     * policy from the previous push refers to a now-deleted id. Clear those
     * orphaned cache entries inside the same transaction so a replica's UI
     * stops showing violations from a policy that no longer exists.
     */
    public replaceReplicatedScanPolicies(rows: ScanPolicy[]): void {
        const now = Date.now();
        const deleteStmt = this.db.prepare('DELETE FROM scan_policies WHERE replicated_from_control = 1');
        const insertStmt = this.db.prepare(
            `INSERT INTO scan_policies (name, node_id, node_identity, stack_pattern, max_severity, block_on_deploy, enabled, replicated_from_control, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        );
        const txn = this.db.transaction((policies: ScanPolicy[]) => {
            deleteStmt.run();
            for (const p of policies) {
                insertStmt.run(
                    p.name,
                    null,
                    p.node_identity ?? '',
                    p.stack_pattern,
                    p.max_severity,
                    p.block_on_deploy,
                    p.enabled,
                    p.created_at ?? now,
                    p.updated_at ?? now,
                );
            }
            this.clearOrphanPolicyEvaluations();
        });
        txn(rows);
    }

    public getMatchingPolicy(
        nodeId: number,
        stackName: string | null,
        selfIdentity: string,
    ): ScanPolicy | null {
        // Filter on node_id at SQL: rows are eligible when fleet-wide
        // (node_id IS NULL) or when locally scoped to this node (node_id = ?).
        // Replicated rows always insert node_id = NULL (see
        // replaceReplicatedScanPolicies), so identity scoping for replicated
        // rows is enforced in `matchesIdentity` below, not in SQL.
        const policies = this.db
            .prepare(
                'SELECT * FROM scan_policies WHERE enabled = 1 AND (node_id IS NULL OR node_id = ?)',
            )
            .all(nodeId) as ScanPolicy[];
        const matchesStack = (pattern: string | null): boolean => {
            if (!pattern) return true;
            if (!stackName) return false;
            const regex = new RegExp(
                '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
            );
            return regex.test(stackName);
        };
        const matchesIdentity = (p: ScanPolicy): boolean => {
            // Locally created policies (never replicated) apply based on node_id logic already filtered.
            if (p.replicated_from_control === 0) return true;
            // Replicated policies without a specific identity are fleet-wide.
            if (!p.node_identity) return true;
            // Identity-scoped replicated policies only apply to their target instance.
            return p.node_identity === selfIdentity;
        };
        const scoped = policies.filter((p) => matchesStack(p.stack_pattern) && matchesIdentity(p));
        if (scoped.length === 0) return null;
        const isNodeScoped = (p: ScanPolicy): boolean => Boolean(p.node_id) || Boolean(p.node_identity);
        scoped.sort((a, b) => {
            const aNode = isNodeScoped(a);
            const bNode = isNodeScoped(b);
            if (aNode && !bNode) return -1;
            if (!aNode && bNode) return 1;
            if (a.stack_pattern && !b.stack_pattern) return -1;
            if (!a.stack_pattern && b.stack_pattern) return 1;
            // Deterministic tiebreaker: lowest id wins. Two rows in the same
            // scope class (e.g. both fleet-wide stack-wildcard) must resolve
            // to the same policy on every replica, regardless of SQLite row
            // iteration order.
            return a.id - b.id;
        });
        return scoped[0];
    }

    /**
     * Evaluate a completed scan against the matching policy for its node and
     * stack context. Returns the evaluation that should be persisted to the
     * scan row, or null when no policy matches.
     *
     * The result is informational. `violated=false` means a policy matched
     * but the scan was within limits; the UI surfaces a banner only when
     * `violated=true`. Blocking enforcement lives in the pre-deploy gate.
     */
    public evaluateScanAgainstPolicies(
        nodeId: number,
        scan: VulnerabilityScan,
        selfIdentity: string,
    ): PolicyEvaluation | null {
        const policy = this.getMatchingPolicy(nodeId, scan.stack_context, selfIdentity);
        if (!policy) return null;
        return {
            policyId: policy.id,
            policyName: policy.name,
            maxSeverity: policy.max_severity,
            violated: isSeverityAtLeast(scan.highest_severity, policy.max_severity),
            evaluatedAt: Date.now(),
        };
    }

    /**
     * Persist a PolicyEvaluation onto a scan row. Pass null to clear.
     * Encoded as JSON so consumers round-trip through parsePolicyEvaluation().
     */
    public setScanPolicyEvaluation(
        scanId: number,
        evaluation: PolicyEvaluation | null,
    ): void {
        const json = evaluation ? JSON.stringify(evaluation) : null;
        this.db
            .prepare('UPDATE vulnerability_scans SET policy_evaluation = ? WHERE id = ?')
            .run(json, scanId);
    }

    // --- Fleet Sync Status ---

    public getFleetSyncStatuses(): FleetSyncStatus[] {
        return this.db
            .prepare('SELECT * FROM fleet_sync_status ORDER BY node_id, resource')
            .all() as FleetSyncStatus[];
    }

    public recordFleetSyncSuccess(nodeId: number, resource: string): void {
        const now = Date.now();
        this.db
            .prepare(
                `INSERT INTO fleet_sync_status (node_id, resource, last_success_at, last_failure_at, last_error,
                                                 sticky_error_code, sticky_error_expected, sticky_error_got)
                 VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL)
                 ON CONFLICT(node_id, resource) DO UPDATE SET
                   last_success_at = excluded.last_success_at,
                   last_error = NULL,
                   sticky_error_code = NULL,
                   sticky_error_expected = NULL,
                   sticky_error_got = NULL`,
            )
            .run(nodeId, resource, now);
    }

    public recordFleetSyncFailure(nodeId: number, resource: string, error: string): void {
        const now = Date.now();
        this.db
            .prepare(
                `INSERT INTO fleet_sync_status (node_id, resource, last_failure_at, last_error)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(node_id, resource) DO UPDATE SET
                   last_failure_at = excluded.last_failure_at,
                   last_error = excluded.last_error`,
            )
            .run(nodeId, resource, now, error);
    }

    /**
     * Mark a (node, resource) pair as having hit a non-retriable failure. The
     * retry service skips sticky rows and the push paths short-circuit before
     * any HTTP call. The first such failure still records `last_failure_at` +
     * `last_error` via `recordFleetSyncFailure`; the sticky write is additive.
     *
     * `expected` and `got` carry the fingerprints from a 409
     * CONTROL_IDENTITY_MISMATCH response so the UI can render
     * "anchored to <expected>, this central is <got>" without parsing the
     * error string.
     */
    public setFleetSyncSticky(
        nodeId: number,
        resource: string,
        code: string,
        expected: string | null,
        got: string | null,
    ): void {
        this.db
            .prepare(
                `INSERT INTO fleet_sync_status (node_id, resource, sticky_error_code,
                                                 sticky_error_expected, sticky_error_got)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(node_id, resource) DO UPDATE SET
                   sticky_error_code = excluded.sticky_error_code,
                   sticky_error_expected = excluded.sticky_error_expected,
                   sticky_error_got = excluded.sticky_error_got`,
            )
            .run(nodeId, resource, code, expected, got);
    }

    public getFleetSyncStickyCode(nodeId: number, resource: string): string | null {
        const row = this.db
            .prepare(
                `SELECT sticky_error_code FROM fleet_sync_status
                 WHERE node_id = ? AND resource = ?`,
            )
            .get(nodeId, resource) as { sticky_error_code: string | null } | undefined;
        return row?.sticky_error_code ?? null;
    }

    /**
     * Clear every sticky-error row for one node id. Used by the
     * reset-anchor endpoint after the peer has acknowledged a reanchor; the
     * next push attempt re-tries normally.
     */
    public clearFleetSyncStickyForNode(nodeId: number): void {
        this.db
            .prepare(
                `UPDATE fleet_sync_status
                 SET sticky_error_code = NULL,
                     sticky_error_expected = NULL,
                     sticky_error_got = NULL
                 WHERE node_id = ?`,
            )
            .run(nodeId);
    }

    public getFailedSyncTargets(resource: string, maxAgeMs: number): FleetSyncStatus[] {
        const cutoff = Date.now() - maxAgeMs;
        return this.db
            .prepare(
                `SELECT * FROM fleet_sync_status
                 WHERE resource = ?
                   AND (last_failure_at IS NOT NULL AND last_failure_at > ?)
                   AND (last_success_at IS NULL OR last_success_at < last_failure_at)
                   AND sticky_error_code IS NULL`,
            )
            .all(resource, cutoff) as FleetSyncStatus[];
    }

    // --- CVE Suppressions ---

    public getCveSuppressions(): CveSuppression[] {
        return this.db
            .prepare('SELECT * FROM cve_suppressions ORDER BY cve_id, pkg_name')
            .all() as CveSuppression[];
    }

    /** Local-only CVE suppressions; mirrors `getLocalScanPolicies`. */
    public getLocalCveSuppressions(): CveSuppression[] {
        return this.db
            .prepare('SELECT * FROM cve_suppressions WHERE replicated_from_control = 0 ORDER BY cve_id, pkg_name')
            .all() as CveSuppression[];
    }

    public getCveSuppression(id: number): CveSuppression | null {
        return (
            (this.db.prepare('SELECT * FROM cve_suppressions WHERE id = ?')
                .get(id) as CveSuppression | undefined) ?? null
        );
    }

    public createCveSuppression(
        suppression: Omit<CveSuppression, 'id'>,
    ): CveSuppression {
        const result = this.db
            .prepare(
                `INSERT INTO cve_suppressions
                    (cve_id, pkg_name, image_pattern, reason, created_by, created_at, expires_at, replicated_from_control)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                suppression.cve_id,
                suppression.pkg_name,
                suppression.image_pattern,
                suppression.reason,
                suppression.created_by,
                suppression.created_at,
                suppression.expires_at,
                suppression.replicated_from_control ?? 0,
            );
        return { ...suppression, id: result.lastInsertRowid as number };
    }

    public updateCveSuppression(
        id: number,
        updates: Partial<Pick<CveSuppression, 'reason' | 'image_pattern' | 'expires_at'>>,
    ): CveSuppression | null {
        const existing = this.getCveSuppression(id);
        if (!existing) return null;
        const ALLOWED = new Set(['reason', 'image_pattern', 'expires_at']);
        const fields: string[] = [];
        const values: unknown[] = [];
        for (const [key, value] of Object.entries(updates)) {
            if (!ALLOWED.has(key)) continue;
            fields.push(`${key} = ?`);
            values.push(value);
        }
        if (fields.length === 0) return existing;
        values.push(id);
        this.db
            .prepare(`UPDATE cve_suppressions SET ${fields.join(', ')} WHERE id = ?`)
            .run(...(values as never[]));
        return this.getCveSuppression(id);
    }

    public deleteCveSuppression(id: number): void {
        this.db.prepare('DELETE FROM cve_suppressions WHERE id = ?').run(id);
    }

    /**
     * Replace all replicated CVE suppressions in a single transaction.
     * Preserves rows flagged as locally created on this instance.
     */
    public replaceReplicatedCveSuppressions(rows: Array<Omit<CveSuppression, 'id'>>): void {
        const deleteStmt = this.db.prepare('DELETE FROM cve_suppressions WHERE replicated_from_control = 1');
        const insertStmt = this.db.prepare(
            `INSERT INTO cve_suppressions
                (cve_id, pkg_name, image_pattern, reason, created_by, created_at, expires_at, replicated_from_control)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        );
        const txn = this.db.transaction((items: Array<Omit<CveSuppression, 'id'>>) => {
            deleteStmt.run();
            for (const s of items) {
                insertStmt.run(
                    s.cve_id,
                    s.pkg_name,
                    s.image_pattern,
                    s.reason,
                    s.created_by,
                    s.created_at,
                    s.expires_at,
                );
            }
        });
        txn(rows);
    }

    // --- Misconfig Acknowledgements ---

    public getMisconfigAcknowledgements(): MisconfigAcknowledgement[] {
        return this.db
            .prepare('SELECT * FROM misconfig_acknowledgements ORDER BY rule_id, stack_pattern')
            .all() as MisconfigAcknowledgement[];
    }

    /** Local-only acknowledgements; mirrors `getLocalCveSuppressions`. */
    public getLocalMisconfigAcknowledgements(): MisconfigAcknowledgement[] {
        return this.db
            .prepare('SELECT * FROM misconfig_acknowledgements WHERE replicated_from_control = 0 ORDER BY rule_id, stack_pattern')
            .all() as MisconfigAcknowledgement[];
    }

    public getMisconfigAcknowledgement(id: number): MisconfigAcknowledgement | null {
        return (
            (this.db.prepare('SELECT * FROM misconfig_acknowledgements WHERE id = ?')
                .get(id) as MisconfigAcknowledgement | undefined) ?? null
        );
    }

    public createMisconfigAcknowledgement(
        ack: Omit<MisconfigAcknowledgement, 'id'>,
    ): MisconfigAcknowledgement {
        const result = this.db
            .prepare(
                `INSERT INTO misconfig_acknowledgements
                    (rule_id, stack_pattern, reason, created_by, created_at, expires_at, replicated_from_control)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                ack.rule_id,
                ack.stack_pattern,
                ack.reason,
                ack.created_by,
                ack.created_at,
                ack.expires_at,
                ack.replicated_from_control ?? 0,
            );
        return { ...ack, id: result.lastInsertRowid as number };
    }

    public updateMisconfigAcknowledgement(
        id: number,
        updates: Partial<Pick<MisconfigAcknowledgement, 'reason' | 'stack_pattern' | 'expires_at'>>,
    ): MisconfigAcknowledgement | null {
        const existing = this.getMisconfigAcknowledgement(id);
        if (!existing) return null;
        const ALLOWED = new Set(['reason', 'stack_pattern', 'expires_at']);
        const fields: string[] = [];
        const values: unknown[] = [];
        for (const [key, value] of Object.entries(updates)) {
            if (!ALLOWED.has(key)) continue;
            fields.push(`${key} = ?`);
            values.push(value);
        }
        if (fields.length === 0) return existing;
        values.push(id);
        this.db
            .prepare(`UPDATE misconfig_acknowledgements SET ${fields.join(', ')} WHERE id = ?`)
            .run(...(values as never[]));
        return this.getMisconfigAcknowledgement(id);
    }

    public deleteMisconfigAcknowledgement(id: number): void {
        this.db.prepare('DELETE FROM misconfig_acknowledgements WHERE id = ?').run(id);
    }

    /**
     * Replace all replicated misconfig acknowledgements in a single transaction.
     * Preserves rows flagged as locally created on this instance.
     */
    public replaceReplicatedMisconfigAcknowledgements(
        rows: Array<Omit<MisconfigAcknowledgement, 'id'>>,
    ): void {
        const deleteStmt = this.db.prepare('DELETE FROM misconfig_acknowledgements WHERE replicated_from_control = 1');
        const insertStmt = this.db.prepare(
            `INSERT INTO misconfig_acknowledgements
                (rule_id, stack_pattern, reason, created_by, created_at, expires_at, replicated_from_control)
             VALUES (?, ?, ?, ?, ?, ?, 1)`,
        );
        const txn = this.db.transaction((items: Array<Omit<MisconfigAcknowledgement, 'id'>>) => {
            deleteStmt.run();
            for (const a of items) {
                insertStmt.run(
                    a.rule_id,
                    a.stack_pattern,
                    a.reason,
                    a.created_by,
                    a.created_at,
                    a.expires_at,
                );
            }
        });
        txn(rows);
    }

    /**
     * Null out `vulnerability_scans.policy_evaluation` rows whose `$.policyId`
     * no longer exists in `scan_policies`. Used after replicated rows are
     * wiped (sync replace, demote) so cached scan banners do not reference
     * deleted policies.
     */
    public clearOrphanPolicyEvaluations(): void {
        this.db
            .prepare(
                `UPDATE vulnerability_scans
                    SET policy_evaluation = NULL
                  WHERE policy_evaluation IS NOT NULL
                    AND CAST(json_extract(policy_evaluation, '$.policyId') AS INTEGER)
                        NOT IN (SELECT id FROM scan_policies)`,
            )
            .run();
    }

    /**
     * Atomically delete every replicated_from_control row from scan_policies,
     * cve_suppressions, and misconfig_acknowledgements, then null out any
     * orphaned policy_evaluation cache. Used by the demote endpoint and any
     * future "drop replicated state" operation.
     */
    public clearReplicatedRows(): void {
        this.transaction(() => {
            this.db.prepare('DELETE FROM scan_policies WHERE replicated_from_control = 1').run();
            this.db.prepare('DELETE FROM cve_suppressions WHERE replicated_from_control = 1').run();
            this.db.prepare('DELETE FROM misconfig_acknowledgements WHERE replicated_from_control = 1').run();
            this.clearOrphanPolicyEvaluations();
        });
    }

    // --- Stack Labels ---

    public getLabels(nodeId: number): Label[] {
        return this.db.prepare('SELECT * FROM stack_labels WHERE node_id = ? ORDER BY name').all(nodeId) as Label[];
    }

    public getLabel(id: number, nodeId: number): Label | null {
        return (this.db.prepare('SELECT * FROM stack_labels WHERE id = ? AND node_id = ?')
            .get(id, nodeId) as Label) ?? null;
    }

    public getLabelCount(nodeId: number): number {
        const row = this.db.prepare('SELECT COUNT(*) as cnt FROM stack_labels WHERE node_id = ?')
            .get(nodeId) as { cnt: number };
        return row.cnt;
    }

    public createLabel(nodeId: number, name: string, color: string): Label {
        const result = this.db.prepare(
            'INSERT INTO stack_labels (node_id, name, color) VALUES (?, ?, ?)'
        ).run(nodeId, name, color);
        return { id: result.lastInsertRowid as number, node_id: nodeId, name, color };
    }

    public updateLabel(id: number, nodeId: number, updates: { name?: string; color?: string }): Label | null {
        const label = this.db.prepare('SELECT * FROM stack_labels WHERE id = ? AND node_id = ?').get(id, nodeId) as Label | undefined;
        if (!label) return null;
        const name = updates.name ?? label.name;
        const color = updates.color ?? label.color;
        this.db.prepare('UPDATE stack_labels SET name = ?, color = ? WHERE id = ? AND node_id = ?').run(name, color, id, nodeId);
        return { ...label, name, color };
    }

    public deleteLabel(id: number, nodeId: number): void {
        this.db.prepare('DELETE FROM stack_labels WHERE id = ? AND node_id = ?').run(id, nodeId);
    }

    public setStackLabels(stackName: string, nodeId: number, labelIds: number[]): void {
        const txn = this.db.transaction(() => {
            if (labelIds.length > 0) {
                const placeholders = labelIds.map(() => '?').join(',');
                const validCount = this.db.prepare(
                    `SELECT COUNT(*) as cnt FROM stack_labels WHERE id IN (${placeholders}) AND node_id = ?`
                ).get(...labelIds, nodeId) as { cnt: number };
                if (validCount.cnt !== labelIds.length) {
                    throw new Error('One or more label IDs are invalid for this node');
                }
            }
            this.db.prepare('DELETE FROM stack_label_assignments WHERE stack_name = ? AND node_id = ?').run(stackName, nodeId);
            const insert = this.db.prepare('INSERT INTO stack_label_assignments (label_id, stack_name, node_id) VALUES (?, ?, ?)');
            for (const labelId of labelIds) {
                insert.run(labelId, stackName, nodeId);
            }
        });
        txn();
    }

    public getLabelsForStacks(nodeId: number): Record<string, Label[]> {
        const rows = this.db.prepare(`
            SELECT a.stack_name, l.id, l.node_id, l.name, l.color
            FROM stack_label_assignments a
            JOIN stack_labels l ON a.label_id = l.id
            WHERE a.node_id = ?
            ORDER BY l.name
        `).all(nodeId) as (Label & { stack_name: string })[];
        const result: Record<string, Label[]> = {};
        for (const row of rows) {
            if (!result[row.stack_name]) result[row.stack_name] = [];
            result[row.stack_name].push({ id: row.id, node_id: row.node_id, name: row.name, color: row.color });
        }
        return result;
    }

    public getStacksForLabel(labelId: number, nodeId: number): string[] {
        const rows = this.db.prepare('SELECT stack_name FROM stack_label_assignments WHERE label_id = ? AND node_id = ?')
            .all(labelId, nodeId) as { stack_name: string }[];
        return rows.map(r => r.stack_name);
    }

    public cleanupStaleAssignments(nodeId: number, validStackNames: string[]): number {
        if (validStackNames.length === 0) {
            const result = this.db.prepare('DELETE FROM stack_label_assignments WHERE node_id = ?').run(nodeId);
            return result.changes;
        }
        const placeholders = validStackNames.map(() => '?').join(',');
        const result = this.db.prepare(
            `DELETE FROM stack_label_assignments WHERE node_id = ? AND stack_name NOT IN (${placeholders})`
        ).run(nodeId, ...validStackNames);
        return result.changes;
    }

    // --- Node Labels (fleet-level orchestration) ---

    public listNodeLabels(nodeId?: number): NodeLabelRow[] {
        const sql = nodeId !== undefined
            ? 'SELECT id, node_id, label, created_at FROM node_labels WHERE node_id = ? ORDER BY label'
            : 'SELECT id, node_id, label, created_at FROM node_labels ORDER BY node_id, label';
        const rows = nodeId !== undefined
            ? this.db.prepare(sql).all(nodeId)
            : this.db.prepare(sql).all();
        return rows as NodeLabelRow[];
    }

    public listDistinctNodeLabels(): string[] {
        const rows = this.db.prepare('SELECT DISTINCT label FROM node_labels ORDER BY label').all() as { label: string }[];
        return rows.map(r => r.label);
    }

    public addNodeLabel(nodeId: number, label: string): NodeLabelRow {
        const trimmed = label.trim();
        if (!trimmed) throw new Error('Label must not be empty');
        const now = Date.now();
        const result = this.db.prepare(
            'INSERT OR IGNORE INTO node_labels (node_id, label, created_at) VALUES (?, ?, ?)'
        ).run(nodeId, trimmed, now);
        const row = result.changes > 0
            ? this.db.prepare('SELECT id, node_id, label, created_at FROM node_labels WHERE id = ?').get(result.lastInsertRowid)
            : this.db.prepare('SELECT id, node_id, label, created_at FROM node_labels WHERE node_id = ? AND label = ?').get(nodeId, trimmed);
        return row as NodeLabelRow;
    }

    public removeNodeLabel(nodeId: number, label: string): boolean {
        const result = this.db.prepare('DELETE FROM node_labels WHERE node_id = ? AND label = ?').run(nodeId, label);
        return result.changes > 0;
    }

    public getNodeLabelsMap(): Record<number, string[]> {
        const rows = this.db.prepare('SELECT node_id, label FROM node_labels ORDER BY node_id, label').all() as { node_id: number; label: string }[];
        const map: Record<number, string[]> = {};
        for (const row of rows) {
            if (!map[row.node_id]) map[row.node_id] = [];
            map[row.node_id].push(row.label);
        }
        return map;
    }

    // --- Blueprints ---

    private parseBlueprint(row: Record<string, unknown>): Blueprint {
        return {
            id: row.id as number,
            name: row.name as string,
            description: (row.description as string | null) ?? null,
            compose_content: row.compose_content as string,
            selector: JSON.parse(row.selector_json as string) as BlueprintSelector,
            drift_mode: row.drift_mode as DriftMode,
            classification: row.classification as BlueprintClassification,
            classification_reasons: row.classification_reasons
                ? (JSON.parse(row.classification_reasons as string) as string[])
                : [],
            enabled: row.enabled === 1,
            revision: row.revision as number,
            created_at: row.created_at as number,
            updated_at: row.updated_at as number,
            created_by: (row.created_by as string | null) ?? null,
            pinned_node_id: (row.pinned_node_id as number | null) ?? null,
        };
    }

    public listBlueprints(): Blueprint[] {
        return this.db.prepare('SELECT * FROM blueprints ORDER BY name')
            .all()
            .map(row => this.parseBlueprint(row as Record<string, unknown>));
    }

    public listEnabledBlueprints(): Blueprint[] {
        return this.db.prepare('SELECT * FROM blueprints WHERE enabled = 1 ORDER BY name')
            .all()
            .map(row => this.parseBlueprint(row as Record<string, unknown>));
    }

    public getBlueprint(id: number): Blueprint | undefined {
        const row = this.db.prepare('SELECT * FROM blueprints WHERE id = ?').get(id) as Record<string, unknown> | undefined;
        return row ? this.parseBlueprint(row) : undefined;
    }

    public getBlueprintByName(name: string): Blueprint | undefined {
        const row = this.db.prepare('SELECT * FROM blueprints WHERE name = ?').get(name) as Record<string, unknown> | undefined;
        return row ? this.parseBlueprint(row) : undefined;
    }

    public createBlueprint(input: {
        name: string;
        description: string | null;
        compose_content: string;
        selector: BlueprintSelector;
        drift_mode: DriftMode;
        classification: BlueprintClassification;
        classification_reasons: string[];
        enabled: boolean;
        created_by: string | null;
    }): Blueprint {
        const now = Date.now();
        const result = this.db.prepare(
            `INSERT INTO blueprints (name, description, compose_content, selector_json, drift_mode, classification, classification_reasons, enabled, revision, created_at, updated_at, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
        ).run(
            input.name,
            input.description,
            input.compose_content,
            JSON.stringify(input.selector),
            input.drift_mode,
            input.classification,
            JSON.stringify(input.classification_reasons),
            input.enabled ? 1 : 0,
            now,
            now,
            input.created_by,
        );
        const created = this.getBlueprint(result.lastInsertRowid as number);
        if (!created) throw new Error('Failed to fetch created blueprint');
        return created;
    }

    public updateBlueprint(id: number, updates: {
        name?: string;
        description?: string | null;
        compose_content?: string;
        selector?: BlueprintSelector;
        drift_mode?: DriftMode;
        classification?: BlueprintClassification;
        classification_reasons?: string[];
        enabled?: boolean;
        bumpRevision?: boolean;
    }): Blueprint | undefined {
        const existing = this.getBlueprint(id);
        if (!existing) return undefined;
        const fields: string[] = [];
        const values: unknown[] = [];
        if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
        if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
        if (updates.compose_content !== undefined) { fields.push('compose_content = ?'); values.push(updates.compose_content); }
        if (updates.selector !== undefined) { fields.push('selector_json = ?'); values.push(JSON.stringify(updates.selector)); }
        if (updates.drift_mode !== undefined) { fields.push('drift_mode = ?'); values.push(updates.drift_mode); }
        if (updates.classification !== undefined) { fields.push('classification = ?'); values.push(updates.classification); }
        if (updates.classification_reasons !== undefined) { fields.push('classification_reasons = ?'); values.push(JSON.stringify(updates.classification_reasons)); }
        if (updates.enabled !== undefined) { fields.push('enabled = ?'); values.push(updates.enabled ? 1 : 0); }
        if (updates.bumpRevision) { fields.push('revision = revision + 1'); }
        fields.push('updated_at = ?');
        values.push(Date.now());
        values.push(id);
        this.db.prepare(`UPDATE blueprints SET ${fields.join(', ')} WHERE id = ?`).run(...values);
        return this.getBlueprint(id);
    }

    public deleteBlueprint(id: number): boolean {
        const result = this.db.prepare('DELETE FROM blueprints WHERE id = ?').run(id);
        return result.changes > 0;
    }

    // --- Blueprint Deployments ---

    private parseBlueprintDeployment(row: Record<string, unknown>): BlueprintDeployment {
        return {
            id: row.id as number,
            blueprint_id: row.blueprint_id as number,
            node_id: row.node_id as number,
            status: row.status as BlueprintDeploymentStatus,
            applied_revision: (row.applied_revision as number | null) ?? null,
            last_deployed_at: (row.last_deployed_at as number | null) ?? null,
            last_checked_at: (row.last_checked_at as number | null) ?? null,
            last_drift_at: (row.last_drift_at as number | null) ?? null,
            drift_summary: (row.drift_summary as string | null) ?? null,
            last_error: (row.last_error as string | null) ?? null,
        };
    }

    public listDeployments(blueprintId: number): BlueprintDeployment[] {
        return this.db.prepare('SELECT * FROM blueprint_deployments WHERE blueprint_id = ? ORDER BY node_id')
            .all(blueprintId)
            .map(row => this.parseBlueprintDeployment(row as Record<string, unknown>));
    }

    public listAllDeployments(): BlueprintDeployment[] {
        return this.db.prepare('SELECT * FROM blueprint_deployments')
            .all()
            .map(row => this.parseBlueprintDeployment(row as Record<string, unknown>));
    }

    public getDeployment(blueprintId: number, nodeId: number): BlueprintDeployment | undefined {
        const row = this.db.prepare('SELECT * FROM blueprint_deployments WHERE blueprint_id = ? AND node_id = ?').get(blueprintId, nodeId) as Record<string, unknown> | undefined;
        return row ? this.parseBlueprintDeployment(row) : undefined;
    }

    public upsertDeployment(input: {
        blueprint_id: number;
        node_id: number;
        status: BlueprintDeploymentStatus;
        applied_revision?: number | null;
        last_deployed_at?: number | null;
        last_checked_at?: number | null;
        last_drift_at?: number | null;
        drift_summary?: string | null;
        last_error?: string | null;
    }): BlueprintDeployment {
        const existing = this.getDeployment(input.blueprint_id, input.node_id);
        if (existing) {
            const fields: string[] = ['status = ?'];
            const values: unknown[] = [input.status];
            if (input.applied_revision !== undefined) { fields.push('applied_revision = ?'); values.push(input.applied_revision); }
            if (input.last_deployed_at !== undefined) { fields.push('last_deployed_at = ?'); values.push(input.last_deployed_at); }
            if (input.last_checked_at !== undefined) { fields.push('last_checked_at = ?'); values.push(input.last_checked_at); }
            if (input.last_drift_at !== undefined) { fields.push('last_drift_at = ?'); values.push(input.last_drift_at); }
            if (input.drift_summary !== undefined) { fields.push('drift_summary = ?'); values.push(input.drift_summary); }
            if (input.last_error !== undefined) { fields.push('last_error = ?'); values.push(input.last_error); }
            values.push(input.blueprint_id, input.node_id);
            this.db.prepare(`UPDATE blueprint_deployments SET ${fields.join(', ')} WHERE blueprint_id = ? AND node_id = ?`).run(...values);
        } else {
            this.db.prepare(
                `INSERT INTO blueprint_deployments (blueprint_id, node_id, status, applied_revision, last_deployed_at, last_checked_at, last_drift_at, drift_summary, last_error)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(
                input.blueprint_id,
                input.node_id,
                input.status,
                input.applied_revision ?? null,
                input.last_deployed_at ?? null,
                input.last_checked_at ?? null,
                input.last_drift_at ?? null,
                input.drift_summary ?? null,
                input.last_error ?? null,
            );
        }
        const updated = this.getDeployment(input.blueprint_id, input.node_id);
        if (!updated) throw new Error('Failed to upsert deployment');
        return updated;
    }

    public deleteDeployment(blueprintId: number, nodeId: number): void {
        this.db.prepare('DELETE FROM blueprint_deployments WHERE blueprint_id = ? AND node_id = ?').run(blueprintId, nodeId);
    }

    // --- Secrets ---

    public listSecrets(): SecretRow[] {
        return this.db.prepare(
            'SELECT id, name, description, current_version, created_at, created_by, updated_at FROM secrets ORDER BY name ASC'
        ).all() as SecretRow[];
    }

    public getSecret(id: number): SecretRow | undefined {
        return this.db.prepare(
            'SELECT id, name, description, current_version, created_at, created_by, updated_at FROM secrets WHERE id = ?'
        ).get(id) as SecretRow | undefined;
    }

    public listSecretVersions(secretId: number): SecretVersionRow[] {
        return this.db.prepare(
            'SELECT id, secret_id, version, encrypted_payload, key_count, created_at, created_by, note FROM secret_versions WHERE secret_id = ? ORDER BY version DESC'
        ).all(secretId) as SecretVersionRow[];
    }

    public getCurrentSecretVersion(secretId: number): SecretVersionRow | undefined {
        return this.db.prepare(
            `SELECT v.id, v.secret_id, v.version, v.encrypted_payload, v.key_count, v.created_at, v.created_by, v.note
             FROM secret_versions v
             INNER JOIN secrets s ON s.id = v.secret_id AND s.current_version = v.version
             WHERE v.secret_id = ?`
        ).get(secretId) as SecretVersionRow | undefined;
    }

    public createSecretWithVersion(input: {
        name: string;
        description: string;
        encryptedPayload: string;
        keyCount: number;
        createdBy: string;
        note: string;
    }): { id: number; version: number } {
        const now = Date.now();
        const txn = this.db.transaction(() => {
            const insertSecret = this.db.prepare(
                'INSERT INTO secrets (name, description, current_version, created_at, created_by, updated_at) VALUES (?, ?, 1, ?, ?, ?)'
            );
            const result = insertSecret.run(input.name, input.description, now, input.createdBy, now);
            const secretId = Number(result.lastInsertRowid);
            this.db.prepare(
                'INSERT INTO secret_versions (secret_id, version, encrypted_payload, key_count, created_at, created_by, note) VALUES (?, 1, ?, ?, ?, ?, ?)'
            ).run(secretId, input.encryptedPayload, input.keyCount, now, input.createdBy, input.note);
            return { id: secretId, version: 1 };
        });
        return txn();
    }

    public updateSecretWithVersion(input: {
        secretId: number;
        description: string | null;
        encryptedPayload: string;
        keyCount: number;
        createdBy: string;
        note: string;
    }): { version: number } {
        const now = Date.now();
        const txn = this.db.transaction(() => {
            const current = this.db.prepare('SELECT current_version FROM secrets WHERE id = ?').get(input.secretId) as { current_version: number } | undefined;
            if (!current) throw new Error('Secret not found');
            const nextVersion = current.current_version + 1;
            this.db.prepare(
                'INSERT INTO secret_versions (secret_id, version, encrypted_payload, key_count, created_at, created_by, note) VALUES (?, ?, ?, ?, ?, ?, ?)'
            ).run(input.secretId, nextVersion, input.encryptedPayload, input.keyCount, now, input.createdBy, input.note);
            if (input.description === null) {
                this.db.prepare('UPDATE secrets SET current_version = ?, updated_at = ? WHERE id = ?').run(nextVersion, now, input.secretId);
            } else {
                this.db.prepare('UPDATE secrets SET current_version = ?, description = ?, updated_at = ? WHERE id = ?').run(nextVersion, input.description, now, input.secretId);
            }
            return { version: nextVersion };
        });
        return txn();
    }

    public deleteSecret(id: number): boolean {
        const result = this.db.prepare('DELETE FROM secrets WHERE id = ?').run(id);
        return result.changes > 0;
    }

    public insertSecretPushes(rows: Array<Omit<SecretPushRow, 'id'>>): void {
        if (rows.length === 0) return;
        const stmt = this.db.prepare(
            `INSERT INTO secret_pushes (secret_id, version, push_id, node_id, stack_name, env_file_basename, status, error, added_count, changed_count, unchanged_count, pushed_by, pushed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        const txn = this.db.transaction((entries: Array<Omit<SecretPushRow, 'id'>>) => {
            for (const r of entries) {
                stmt.run(
                    r.secret_id, r.version, r.push_id, r.node_id, r.stack_name, r.env_file_basename,
                    r.status, r.error, r.added_count, r.changed_count, r.unchanged_count, r.pushed_by, r.pushed_at,
                );
            }
        });
        txn(rows);
    }

    public listSecretPushes(secretId: number, limit = 50): SecretPushRow[] {
        return this.db.prepare(
            `SELECT id, secret_id, version, push_id, node_id, stack_name, env_file_basename, status, error,
                    added_count, changed_count, unchanged_count, pushed_by, pushed_at
             FROM secret_pushes
             WHERE secret_id = ?
             ORDER BY pushed_at DESC
             LIMIT ?`
        ).all(secretId, limit) as SecretPushRow[];
    }
}
