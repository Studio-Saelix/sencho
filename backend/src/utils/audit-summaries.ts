/**
 * Audit log route summaries and summary resolution.
 *
 * Maps HTTP method + API path patterns to human-readable action descriptions.
 * Supports exact prefix matching and single-segment wildcard (*) matching.
 */

export const AUDIT_ROUTE_SUMMARIES: Record<string, string> = {
  // Stack CRUD
  'POST /stacks': 'Created stack',
  'DELETE /stacks': 'Deleted stack',
  'PUT /stacks/*/env': 'Updated stack env file',
  'PUT /stacks': 'Updated stack file',

  // Stack lifecycle
  'POST /stacks/*/deploy': 'Deployed stack',
  'POST /stacks/*/down': 'Stopped stack',
  'POST /stacks/*/start': 'Started stack',
  'POST /stacks/*/stop': 'Stopped stack',
  'POST /stacks/*/restart': 'Restarted stack',

  // Per-service lifecycle (resourceName = stack name; service name is in the path column)
  'POST /stacks/*/services/*/start': 'Started stack service',
  'POST /stacks/*/services/*/stop': 'Stopped stack service',
  'POST /stacks/*/services/*/restart': 'Restarted stack service',

  'POST /stacks/*/update': 'Updated stack images',
  'POST /stacks/*/rollback': 'Rolled back stack',

  // Container operations
  'POST /containers/*/start': 'Started container',
  'POST /containers/*/stop': 'Stopped container',
  'POST /containers/*/restart': 'Restarted container',

  // System operations
  'POST /system/prune': 'Pruned system resources',
  'POST /system/prune/orphans': 'Pruned orphan containers',
  'POST /system/prune/system': 'Pruned system resources',
  'POST /system/images/delete': 'Deleted images',
  'POST /system/volumes/delete': 'Deleted volumes',
  'POST /system/networks/delete': 'Deleted networks',
  'POST /system/networks': 'Created network',
  'POST /system/console-token': 'Generated console token',

  // Node management
  'POST /nodes': 'Added node',
  'PUT /nodes': 'Updated node',
  'DELETE /nodes': 'Deleted node',
  'POST /nodes/*/cordon': 'Cordoned node',
  'POST /nodes/*/uncordon': 'Uncordoned node',

  // User management
  'POST /users': 'Created user',
  'DELETE /users': 'Deleted user',
  'PUT /users': 'Updated user',
  'POST /users/*/roles': 'Assigned role',
  'DELETE /users/*/roles': 'Removed role assignment',

  // Auth
  'PUT /auth/password': 'Changed password',
  'POST /auth/generate-node-token': 'Generated node token',

  // License
  'POST /license/activate': 'Activated license',
  'POST /license/deactivate': 'Deactivated license',

  // Notifications & Agents
  'POST /agents': 'Updated notification agent',
  'POST /notifications/test': 'Tested notification',
  'POST /notification-routes': 'Created notification route',
  'PUT /notification-routes': 'Updated notification route',
  'DELETE /notification-routes': 'Deleted notification route',
  'POST /notification-routes/*/test': 'Tested notification route',

  // Webhooks
  'POST /webhooks': 'Created webhook',
  'PUT /webhooks': 'Updated webhook',
  'DELETE /webhooks': 'Deleted webhook',

  // Settings
  'POST /settings': 'Updated settings',
  'PATCH /settings': 'Updated settings',

  // Fleet
  'POST /fleet/snapshots': 'Created fleet backup',
  'DELETE /fleet/snapshots': 'Deleted fleet backup',
  'POST /fleet/snapshots/*/restore': 'Restored fleet backup',
  'POST /fleet/nodes/*/update': 'Triggered fleet node update',
  'POST /fleet/update-all': 'Triggered fleet-wide update',
  'POST /fleet/role/reanchor': 'Re-anchored fleet replica',
  'POST /fleet/role/demote': 'Demoted fleet replica to control',

  // Cloud backup
  'PUT /cloud-backup/config': 'Updated cloud backup config',
  'POST /cloud-backup/test': 'Tested cloud backup connection',
  'POST /cloud-backup/provision': 'Provisioned Sencho Cloud Backup',
  'POST /cloud-backup/upload': 'Uploaded snapshot to cloud',
  'DELETE /cloud-backup/object': 'Deleted cloud snapshot',

  // SSO
  'PUT /sso/config': 'Updated SSO configuration',
  'DELETE /sso/config': 'Deleted SSO configuration',
  'POST /sso/config/*/test': 'Tested SSO configuration',

  // API tokens
  'POST /api-tokens': 'Created API token',
  'DELETE /api-tokens': 'Revoked API token',

  // Scheduled tasks
  'POST /scheduled-tasks/*/run': 'Triggered scheduled task',
  'POST /scheduled-tasks': 'Created scheduled task',
  'PUT /scheduled-tasks': 'Updated scheduled task',
  'DELETE /scheduled-tasks': 'Deleted scheduled task',
  'PATCH /scheduled-tasks': 'Toggled scheduled task',

  // Registries
  'POST /registries': 'Created registry credential',
  'PUT /registries': 'Updated registry credential',
  'DELETE /registries': 'Deleted registry credential',

  // Labels
  'POST /labels': 'Created label',
  'PUT /labels': 'Updated label',
  'DELETE /labels': 'Deleted label',
  'POST /labels/*/action': 'Executed label action',
  'PUT /stacks/*/labels': 'Updated stack labels',

  // Templates
  'POST /templates/deploy': 'Deployed template',

  // Auto-update
  'POST /auto-update/execute': 'Executed auto-update',

  // Blueprints (Federation pin)
  'PUT /blueprints/*/pin': 'Updated blueprint pin',

  // Fleet secrets
  'POST /secrets': 'Created secret',
  'PUT /secrets': 'Updated secret',
  'DELETE /secrets': 'Deleted secret',
  'POST /secrets/*/import-from-stack': 'Imported env into secret',
  'POST /secrets/*/push/preview': 'Previewed secret push',
  'POST /secrets/*/push': 'Pushed secret',
};

// Pre-sorted at module load: most specific patterns (by segment count) first.
const SORTED_PATTERNS = Object.entries(AUDIT_ROUTE_SUMMARIES)
  .sort((a, b) => b[0].split('/').length - a[0].split('/').length);

/**
 * Resolve a human-readable summary for an audit log entry.
 *
 * Tries wildcard patterns first (most specific by segment count), then
 * falls back to prefix matching. Returns a generic method+path string
 * if no pattern matches.
 */
export function getAuditSummary(method: string, apiPath: string): string {
  const normalized = apiPath.replace(/^\//, '');
  const normalizedSegments = normalized.split('/');

  for (const [pattern, summary] of SORTED_PATTERNS) {
    const spaceIdx = pattern.indexOf(' ');
    const pMethod = pattern.slice(0, spaceIdx);
    const pPath = pattern.slice(spaceIdx + 1).replace(/^\//, '');
    if (method !== pMethod) continue;

    const patternSegments = pPath.split('/');
    const hasWildcard = patternSegments.includes('*');

    if (hasWildcard) {
      // Wildcard matching: pattern segments must not exceed actual segments
      if (patternSegments.length > normalizedSegments.length) continue;
      let match = true;
      let resourceName = '';
      for (let i = 0; i < patternSegments.length; i++) {
        if (patternSegments[i] === '*') {
          resourceName = resourceName || normalizedSegments[i];
        } else if (patternSegments[i] !== normalizedSegments[i]) {
          match = false;
          break;
        }
      }
      if (match) {
        return resourceName ? `${summary}: ${decodeURIComponent(resourceName)}` : summary;
      }
    } else {
      // Prefix matching (original behavior)
      if (normalized.startsWith(pPath)) {
        const rest = normalized.slice(pPath.length).replace(/^\//, '');
        const resourceName = rest.split('/')[0];
        return resourceName ? `${summary}: ${decodeURIComponent(resourceName)}` : summary;
      }
    }
  }
  return `${method} /api/${normalized}`;
}
