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
  'guided-external-network-preflight',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export const STACK_DOWN_REMOVE_VOLUMES_CAPABILITY = 'stack-down-remove-volumes' as const satisfies Capability;
export const GUIDED_EXTERNAL_NETWORK_PREFLIGHT_CAPABILITY = 'guided-external-network-preflight' as const satisfies Capability;
