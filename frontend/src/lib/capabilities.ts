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
  'notification-suppression-schedule',
  'notification-suppression-replica-retraction',
  'host-console',
  'host-console-community',
  'container-exec',
  'audit-log',
  'scheduled-ops',
  'sso',
  'authentication-mode',
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
  'stack-delete-prune-volumes',
  'guided-external-network-preflight',
  'service-scoped-update',
  'service-scoped-stack-alert',
  'scoped-stack-auth-evidence',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** Legacy Host Console advertisement (Admiral hubs still accept this on remotes). */
export const HOST_CONSOLE_CAPABILITY = 'host-console' as const satisfies Capability;

/** Host Console works without a paid license on this node. */
export const HOST_CONSOLE_COMMUNITY_CAPABILITY = 'host-console-community' as const satisfies Capability;

export const STACK_DOWN_REMOVE_VOLUMES_CAPABILITY = 'stack-down-remove-volumes' as const satisfies Capability;
export const STACK_DELETE_PRUNE_VOLUMES_CAPABILITY = 'stack-delete-prune-volumes' as const satisfies Capability;
export const GUIDED_EXTERNAL_NETWORK_PREFLIGHT_CAPABILITY = 'guided-external-network-preflight' as const satisfies Capability;
export const SERVICE_SCOPED_UPDATE_CAPABILITY = 'service-scoped-update' as const satisfies Capability;
export const SERVICE_SCOPED_STACK_ALERT_CAPABILITY = 'service-scoped-stack-alert' as const satisfies Capability;
export const SCOPED_STACK_AUTH_EVIDENCE_CAPABILITY = 'scoped-stack-auth-evidence' as const satisfies Capability;
