import type { SectionId } from './types';

export type SettingsGroupId =
    | 'personal'
    | 'access'
    | 'infrastructure'
    | 'monitoring'
    | 'notifications'
    | 'automation'
    | 'organization'
    | 'operations'
    | 'help';

export interface SettingsGroupMeta {
    id: SettingsGroupId;
    label: string;
    kicker?: string;
    glyph: string;
}

export const SETTINGS_GROUPS: readonly SettingsGroupMeta[] = [
    { id: 'personal', label: 'Personal', glyph: '\u25C8' },
    { id: 'access', label: 'Access', glyph: '\u25C8' },
    { id: 'infrastructure', label: 'Infrastructure', glyph: '\u25C6' },
    { id: 'monitoring', label: 'Monitoring', kicker: 'node-scoped', glyph: '\u25C6' },
    { id: 'notifications', label: 'Notifications', glyph: '\u25C7' },
    { id: 'automation', label: 'Automation', glyph: '\u25C7' },
    { id: 'organization', label: 'Organization', glyph: '\u25C7' },
    { id: 'operations', label: 'Operations', glyph: '\u25C7' },
    { id: 'help', label: 'Help', glyph: '\u25C7' },
];

export type TierGate = 'paid' | null;
export type Scope = 'global' | 'node' | 'browser';

export interface SettingsItemMeta {
    id: SectionId;
    group: SettingsGroupId;
    label: string;
    description: string;
    keywords: string[];
    tier: TierGate;
    scope: Scope;
    adminOnly?: boolean;
    hiddenOnRemote?: boolean;
}

export const SETTINGS_ITEMS: readonly SettingsItemMeta[] = [
    // Personal
    {
        id: 'account',
        group: 'personal',
        label: 'Account',
        description: 'Password, MFA, and session controls for the signed-in operator.',
        keywords: ['password', 'mfa', 'two-factor', 'session', 'profile'],
        tier: null,
        scope: 'global',
        hiddenOnRemote: true,
    },
    {
        id: 'appearance',
        group: 'personal',
        label: 'Appearance',
        description: 'Visual style, readability, theme, accent, charts, and display preferences saved to this browser.',
        keywords: ['theme', 'dim', 'oled', 'light', 'dark', 'accent', 'color', 'glow', 'border', 'contrast', 'density', 'comfortable', 'compact', 'spacing', 'display', 'calm', 'signature', 'readability', 'heading', 'chart', 'motion', 'effects'],
        tier: null,
        scope: 'browser',
    },
    // Access
    {
        id: 'license',
        group: 'access',
        label: 'License',
        description: 'Activation key, plan tier, and seat allocation.',
        keywords: ['key', 'activation', 'tier', 'plan', 'seats', 'billing'],
        tier: null,
        scope: 'global',
        hiddenOnRemote: true,
    },
    {
        id: 'users',
        group: 'access',
        label: 'Users',
        description: 'Operators, role assignments, and access scopes.',
        keywords: ['operators', 'team', 'rbac', 'roles', 'permissions'],
        tier: null,
        scope: 'global',
        adminOnly: true,
        hiddenOnRemote: true,
    },
    {
        id: 'sso',
        group: 'access',
        label: 'SSO',
        description: 'Single sign-on via SAML or OIDC identity providers.',
        keywords: ['saml', 'oidc', 'okta', 'entra', 'azure', 'login'],
        tier: null,
        scope: 'global',
        adminOnly: true,
        hiddenOnRemote: true,
    },
    {
        id: 'api-tokens',
        group: 'access',
        label: 'API Tokens',
        description: 'Long-lived bearer tokens for CI and scripts.',
        keywords: ['bearer', 'automation', 'ci', 'scripts', 'scopes'],
        tier: null,
        scope: 'global',
        adminOnly: true,
        hiddenOnRemote: true,
    },
    // Infrastructure
    {
        id: 'nodes',
        group: 'infrastructure',
        label: 'Nodes',
        description: 'Remote Sencho instances proxied through this control plane.',
        keywords: ['fleet', 'remote', 'proxy', 'node', 'cluster'],
        tier: null,
        scope: 'global',
        hiddenOnRemote: true,
    },
    {
        id: 'fleet-mesh',
        group: 'infrastructure',
        label: 'Fleet',
        description: 'Cross-node service-mesh data plane and fleet-snapshot documentation capture.',
        keywords: ['mesh', 'network', 'recreate', 'fleet', 'routing', 'data plane', 'sencho_mesh', 'snapshot', 'documentation', 'dossier'],
        tier: null,
        scope: 'node',
        adminOnly: true,
    },
    {
        id: 'registries',
        group: 'infrastructure',
        label: 'Registries',
        description: 'Private Docker registries and pull credentials.',
        keywords: ['docker', 'ghcr', 'ecr', 'private', 'pull', 'auth'],
        tier: null,
        scope: 'global',
        adminOnly: true,
        hiddenOnRemote: true,
    },
    {
        id: 'cloud-backup',
        group: 'infrastructure',
        label: 'Cloud Backup',
        description: 'Mirror fleet snapshots to Sencho Cloud Backup or any S3-compatible storage.',
        keywords: ['cloud', 'backup', 'snapshot', 's3', 'r2', 'minio', 'storage', 'offsite'],
        tier: null,
        scope: 'global',
        adminOnly: true,
        hiddenOnRemote: true,
    },
    {
        id: 'app-store',
        group: 'infrastructure',
        label: 'App Store',
        description: 'Template registry URL and featured-catalog source.',
        keywords: ['templates', 'registry', 'catalog', 'featured'],
        tier: null,
        scope: 'node',
    },
    {
        id: 'stacks',
        group: 'infrastructure',
        label: 'Stacks',
        description: 'Stack editor, lifecycle workflow preferences, and deploy guardrails.',
        keywords: ['stack', 'compose', 'deploy', 'guardrail', 'health gate', 'observation', 'env', 'required variable', 'progress', 'modal', 'inline', 'diff', 'preview', 'save', 'editor', 'workflow'],
        tier: null,
        scope: 'node',
    },
    // Monitoring
    {
        id: 'host-alerts',
        group: 'monitoring',
        label: 'Host Alerts',
        description: 'Alert thresholds for host CPU, RAM, and disk, plus suppression cadence.',
        keywords: ['cpu', 'ram', 'disk', 'thresholds', 'alerts', 'suppression', 'host', 'limits'],
        tier: null,
        scope: 'node',
    },
    {
        id: 'container-alerts',
        group: 'monitoring',
        label: 'Container Alerts',
        description: 'Crash, OOM, and healthcheck alert behavior for every managed container on this node.',
        keywords: ['crash', 'oom', 'healthcheck', 'health', 'container', 'exit', 'alert', 'auto-heal'],
        tier: null,
        scope: 'node',
    },
    {
        id: 'docker-storage',
        group: 'monitoring',
        label: 'Docker & Storage',
        description: 'Reclaimable-space alerts and Docker image cleanup after updates.',
        keywords: ['docker', 'prune', 'reclaim', 'storage', 'images', 'cleanup', 'dangling'],
        tier: null,
        scope: 'node',
    },
    // Notifications
    {
        id: 'notifications',
        group: 'notifications',
        label: 'Channels',
        description: 'Discord, Slack, and custom webhook destinations for Sencho alerts.',
        keywords: ['discord', 'slack', 'webhook', 'channels', 'destinations', 'alerts'],
        tier: null,
        scope: 'node',
    },
    {
        id: 'notification-routing',
        group: 'notifications',
        label: 'Notification Routing',
        description: 'Rules that steer alerts to the right channel based on severity or label.',
        keywords: ['rules', 'routing', 'channels', 'severity', 'labels'],
        tier: null,
        scope: 'global',
        adminOnly: true,
        hiddenOnRemote: true,
    },
    // Automation
    {
        id: 'image-updates',
        group: 'automation',
        label: 'Image update checks',
        description: 'How often this node polls registries to detect available image updates and raise notifications.',
        keywords: ['image', 'update', 'registry', 'check', 'interval', 'cadence', 'poll', 'auto-update', 'detection', 'recheck'],
        tier: null,
        scope: 'node',
    },
    {
        id: 'webhooks',
        group: 'automation',
        label: 'Webhooks',
        description: 'Incoming HMAC-signed HTTP triggers that run stack actions from CI/CD pipelines.',
        keywords: ['webhook', 'incoming', 'trigger', 'ci', 'cd', 'pipeline', 'deploy', 'hmac', 'signature', 'action'],
        tier: null,
        scope: 'global',
        hiddenOnRemote: true,
    },
    // Organization
    {
        id: 'labels',
        group: 'organization',
        label: 'Labels',
        description: 'Per-node labels for stacks and containers.',
        keywords: ['labels', 'tags', 'palette', 'organisation'],
        tier: null,
        scope: 'node',
    },
    // Operations
    {
        id: 'data-retention',
        group: 'operations',
        label: 'Data Retention',
        description: 'How long to keep container metrics, notification logs, scan history, and audit entries.',
        keywords: ['retention', 'metrics', 'logs', 'scans', 'audit', 'history', 'prune', 'window'],
        tier: null,
        scope: 'node',
    },
    {
        id: 'developer',
        group: 'operations',
        label: 'Developer Diagnostics',
        description: 'Developer mode for real-time metrics streams and verbose debug diagnostics.',
        keywords: ['developer', 'debug', 'diagnostics', 'metrics', 'verbose'],
        tier: null,
        scope: 'node',
    },
    {
        id: 'recovery',
        group: 'operations',
        label: 'Recovery',
        description: 'System health snapshot, safe recovery actions, and emergency command-line reference.',
        keywords: ['recovery', 'safe mode', 'diagnostics', 'health', 'emergency', 'cli', 'reset', 'backup', 'restore'],
        tier: null,
        scope: 'global',
        adminOnly: true,
        hiddenOnRemote: true,
    },
    // Help
    {
        id: 'support',
        group: 'help',
        label: 'Support',
        description: 'Diagnostics bundle, docs links, and contact channels.',
        keywords: ['help', 'diagnostics', 'bundle', 'docs', 'contact'],
        tier: null,
        scope: 'global',
    },
    {
        id: 'about',
        group: 'help',
        label: 'About',
        description: 'Build metadata, release notes, and licence attributions.',
        keywords: ['version', 'build', 'release', 'attributions'],
        tier: null,
        scope: 'global',
    },
];

export function getSettingsItem(id: SectionId): SettingsItemMeta | undefined {
    return SETTINGS_ITEMS.find(item => item.id === id);
}

export function getSettingsGroup(id: SettingsGroupId): SettingsGroupMeta | undefined {
    return SETTINGS_GROUPS.find(group => group.id === id);
}

export interface VisibilityContext {
    isRemote: boolean;
    isAdmin: boolean;
    isPaid: boolean;
}

export function isItemVisible(item: SettingsItemMeta, ctx: VisibilityContext): boolean {
    if (ctx.isRemote && item.hiddenOnRemote) return false;
    if (item.adminOnly && !ctx.isAdmin) return false;
    return true;
}

export function isItemLocked(item: SettingsItemMeta, ctx: VisibilityContext): boolean {
    return item.tier === 'paid' ? !ctx.isPaid : false;
}

/**
 * The masthead SCOPE value for a non-node section. Browser-local sections
 * (Appearance) persist to this browser's localStorage and read as
 * browser regardless of their group; the signed-in Account is operator-scoped;
 * Access sections (license, users, sso, api-tokens) are instance-global, so
 * they read as global like every other non-node group. Node-scoped sections
 * render a NODE pill instead and never reach here.
 */
export function scopeLabel(item: SettingsItemMeta): string {
    if (item.scope === 'browser') return 'browser';
    if (item.group === 'personal') return 'operator';
    return 'global';
}
