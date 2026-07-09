/** Must stay in sync with backend/src/services/CapabilityRegistry.ts */
export const CAPABILITIES = [
  'stacks',
  'containers',
  'resources',
  'templates',
  'global-logs',
  'system-stats',
  'fleet',
  'auto-updates',
  'labels',
  'webhooks',
  'network-topology',
  'notifications',
  'notification-routing',
  'notification-suppression',
  'host-console',
  'container-exec',
  'audit-log',
  'scheduled-ops',
  'sso',
  'api-tokens',
  'users',
  'registries',
  'self-update',
  'vulnerability-scanning',
  'compose-doctor',
  'update-guard',
  'compose-networking',
  'env-inventory',
  'container-label-inventory',
  'project-env-files',
  'compose-storage',
  'cross-node-rbac',
  'stack-down-remove-volumes',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** Must stay in sync with backend CapabilityRegistry.STACK_DOWN_REMOVE_VOLUMES_CAPABILITY */
export const STACK_DOWN_REMOVE_VOLUMES_CAPABILITY = 'stack-down-remove-volumes' as const satisfies Capability;
