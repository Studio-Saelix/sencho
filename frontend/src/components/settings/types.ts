export interface PatchableSettings {
    host_cpu_limit?: string;
    host_ram_limit?: string;
    host_disk_limit?: string;
    host_alert_suppression_mins?: string;
    docker_janitor_gb?: string;
    global_crash?: '0' | '1';
    developer_mode?: '0' | '1';
    template_registry_url?: string;
    metrics_retention_hours?: string;
    log_retention_days?: string;
    audit_retention_days?: string;
    mesh_auto_recreate?: '0' | '1';
    scan_history_per_image_limit?: string;
    prune_on_update?: '0' | '1';
    reclaim_hero?: '0' | '1';
    snapshot_documentation?: '0' | '1';
    health_gate_enabled?: '0' | '1';
    health_gate_window_seconds?: string;
}

export const DEFAULT_SETTINGS: PatchableSettings = {
    host_cpu_limit: '90',
    host_ram_limit: '90',
    host_disk_limit: '90',
    host_alert_suppression_mins: '60',
    global_crash: '1',
    docker_janitor_gb: '5',
    developer_mode: '0',
    template_registry_url: '',
    metrics_retention_hours: '24',
    log_retention_days: '30',
    audit_retention_days: '90',
    mesh_auto_recreate: '0',
    scan_history_per_image_limit: '50',
    prune_on_update: '1',
    reclaim_hero: '1',
    snapshot_documentation: '0',
    health_gate_enabled: '1',
    health_gate_window_seconds: '90',
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
    | 'docker-storage'
    | 'fleet-mesh'
    | 'notifications'
    | 'webhooks'
    | 'cloud-backup'
    | 'developer'
    | 'data-retention'
    | 'nodes'
    | 'app-store'
    | 'notification-routing'
    | 'recovery'
    | 'support'
    | 'about';

export interface Agent {
    type: 'discord' | 'slack' | 'webhook';
    url: string;
    enabled: boolean;
}
