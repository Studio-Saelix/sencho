import type { NotificationCategory } from '@/components/dashboard/types';

export const CATEGORY_LABELS: Record<NotificationCategory, string> = {
    deploy_success: 'Deploy success',
    deploy_failure: 'Deploy failure',
    stack_started: 'Stack started',
    stack_stopped: 'Stack stopped',
    stack_restarted: 'Stack restarted',
    image_update_available: 'Update available',
    image_update_applied: 'Update applied',
    autoheal_triggered: 'Auto-heal',
    monitor_alert: 'Monitor alert',
    scan_finding: 'Scan finding',
    node_update_available: 'Node update',
    system: 'System',
};
