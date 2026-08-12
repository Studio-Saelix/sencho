export interface PatchableSettings {
    host_cpu_limit?: string;
    host_ram_limit?: string;
    host_disk_limit?: string;
    host_alert_suppression_mins?: string;
    host_alerts_enabled?: '0' | '1';
    docker_janitor_gb?: string;
    global_crash?: '0' | '1';
    developer_mode?: '0' | '1';
    template_registry_url?: string;
    metrics_retention_hours?: string;
    log_retention_days?: string;
    audit_retention_days?: string;
    mesh_auto_recreate?: '0' | '1';
    scan_history_per_image_limit?: string;
    prune_orphaned_scans?: '0' | '1';
    prune_on_update?: '0' | '1';
    reclaim_hero?: '0' | '1';
    snapshot_documentation?: '0' | '1';
    health_gate_enabled?: '0' | '1';
    health_gate_window_seconds?: string;
    recovery_retention_days?: string;
    recovery_max_generations?: string;
    env_block_deploy_on_missing_required?: '0' | '1';
    auto_create_missing_external_networks?: '0' | '1';
    image_update_sidebar_indicators?: '0' | '1';
    notification_dispatch_retries?: string;
    session_sliding_refresh?: '0' | '1';
}

export const DEFAULT_SETTINGS: PatchableSettings = {
    host_cpu_limit: '90',
    host_ram_limit: '90',
    host_disk_limit: '90',
    host_alert_suppression_mins: '60',
    host_alerts_enabled: '1',
    global_crash: '1',
    docker_janitor_gb: '5',
    developer_mode: '0',
    template_registry_url: '',
    metrics_retention_hours: '24',
    log_retention_days: '30',
    audit_retention_days: '90',
    mesh_auto_recreate: '0',
    scan_history_per_image_limit: '50',
    prune_orphaned_scans: '1',
    prune_on_update: '1',
    reclaim_hero: '0',
    snapshot_documentation: '0',
    health_gate_enabled: '1',
    health_gate_window_seconds: '90',
    recovery_retention_days: '7',
    recovery_max_generations: '0',
    env_block_deploy_on_missing_required: '0',
    auto_create_missing_external_networks: '0',
    image_update_sidebar_indicators: '1',
    notification_dispatch_retries: '0',
    session_sliding_refresh: '1',
};

export type SectionId =
    | 'account'
    | 'appearance'
    | 'license'
    | 'users'
    | 'sso'
    | 'api-tokens'
    | 'registries'
    | 'labels'
    | 'host-alerts'
    | 'container-alerts'
    | 'docker-storage'
    | 'image-updates'
    | 'fleet-mesh'
    | 'notifications'
    | 'webhooks'
    | 'cloud-backup'
    | 'developer'
    | 'data-retention'
    | 'nodes'
    | 'app-store'
    | 'stacks'
    | 'notification-routing'
    | 'notification-suppression'
    | 'recovery'
    | 'support'
    | 'about';

export interface Agent {
    type: 'discord' | 'slack' | 'webhook' | 'apprise' | 'ntfy';
    url: string;
    enabled: boolean;
    config?: { mode?: 'keyed' | 'stateless'; tags?: string; urls?: string; has_urls?: boolean; providers?: string[]; url_count?: number } | null;
    /** Optional user-authored JSON payload template; null/blank = built-in payload. */
    payload_template?: string | null;
}
