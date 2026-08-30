import type { NotificationCategory } from '@/components/dashboard/types';

export const CATEGORY_LABELS: Record<NotificationCategory, string> = {
    deploy_success: 'Deploy success',
    deploy_failure: 'Deploy failure',
    stack_started: 'Stack started',
    stack_stopped: 'Stack stopped',
    stack_restarted: 'Stack restarted',
    stack_taken_down: 'Stack taken down',
    image_update_available: 'Update available',
    image_update_applied: 'Update applied',
    autoheal_triggered: 'Auto-heal',
    monitor_alert: 'Monitor alert',
    scan_finding: 'Scan finding',
    drift_detected: 'Drift detected',
    drift_resolved: 'Drift resolved',
    update_started: 'Update started',
    health_gate_passed: 'Health gate passed',
    health_gate_failed: 'Health gate failed',
    rollback_generation_released: 'Rollback protection released',
    node_update_available: 'Node update',
    dev_build_update_available: 'Dev build update',
    system: 'System',
};
