import type { SectionId } from './types';

export type SettingsGroupId = 'identity' | 'system' | 'alerts' | 'advanced';

export interface SettingsGroupMeta {
    id: SettingsGroupId;
    label: string;
    kicker?: string;
    glyph: string;
}

export const SETTINGS_GROUPS: readonly SettingsGroupMeta[] = [
    { id: 'identity', label: 'Identity', glyph: '\u25C8' },
    { id: 'system', label: 'System', kicker: 'node-scoped', glyph: '\u25C6' },
    { id: 'alerts', label: 'Alerts', glyph: '\u25C7' },
    { id: 'advanced', label: 'Advanced', glyph: '\u25C7' },
];

export type TierGate = 'paid' | null;
export type Scope = 'global' | 'node';

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
    {
        id: 'account',
        group: 'identity',
        label: 'Account',
        description: 'Password, MFA, and session controls for the signed-in operator.',
        keywords: ['password', 'mfa', 'two-factor', 'session', 'profile'],
        tier: null,
        scope: 'global',
        hiddenOnRemote: true,
    },
    {
        id: 'appearance',
        group: 'identity',
        label: 'Appearance',
        description: 'Theme, accent, density, and display preferences saved to this browser.',
        keywords: ['theme', 'dim', 'oled', 'light', 'dark', 'accent', 'color', 'glow', 'border', 'contrast', 'density', 'comfortable', 'compact', 'spacing', 'display'],
        tier: null,
        scope: 'global',
    },
    {
        id: 'license',
        group: 'identity',
        label: 'License',
        description: 'Activation key, plan tier, and seat allocation.',
        keywords: ['key', 'activation', 'tier', 'plan', 'seats', 'billing'],
        tier: null,
        scope: 'global',
        hiddenOnRemote: true,
    },
    {
        id: 'users',
        group: 'identity',
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
        group: 'identity',
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
        group: 'identity',
        label: 'API Tokens',
        description: 'Long-lived bearer tokens for CI and scripts.',
        keywords: ['bearer', 'automation', 'ci', 'scripts', 'scopes'],
        tier: null,
        scope: 'global',
        adminOnly: true,
        hiddenOnRemote: true,
    },
    {
        id: 'system',
        group: 'system',
        label: 'System Limits',
        description: 'Threshold percentages for host CPU, RAM, disk, and crash-loop alerts.',
        keywords: ['cpu', 'ram', 'disk', 'limits', 'thresholds', 'alerts'],
        tier: null,
        scope: 'node',
    },
    {
        id: 'registries',
        group: 'system',
        label: 'Registries',
        description: 'Private Docker registries and pull credentials.',
        keywords: ['docker', 'ghcr', 'ecr', 'private', 'pull', 'auth'],
        tier: 'paid',
        scope: 'global',
        adminOnly: true,
        hiddenOnRemote: true,
    },
    {
        id: 'cloud-backup',
        group: 'system',
        label: 'Cloud Backup',
        description: 'Mirror fleet snapshots to Sencho Cloud Backup or any S3-compatible storage.',
        keywords: ['cloud', 'backup', 'snapshot', 's3', 'r2', 'minio', 'storage', 'offsite'],
        tier: null,
        scope: 'global',
        adminOnly: true,
        hiddenOnRemote: true,
    },
    {
        id: 'nodes',
        group: 'system',
        label: 'Nodes',
        description: 'Remote Sencho instances proxied through this control plane.',
        keywords: ['fleet', 'remote', 'proxy', 'node', 'cluster'],
        tier: null,
        scope: 'global',
        hiddenOnRemote: true,
    },
    {
        id: 'notifications',
        group: 'alerts',
        label: 'Notifications',
        description: 'In-app toasts and browser push for stack, container, and system events.',
        keywords: ['toasts', 'push', 'events', 'alerts', 'inbox'],
        tier: null,
        scope: 'node',
    },
    {
        id: 'notification-routing',
        group: 'alerts',
        label: 'Routing',
        description: 'Rules that steer alerts to the right channel based on severity or label.',
        keywords: ['rules', 'routing', 'channels', 'severity', 'labels'],
        tier: null,
        scope: 'global',
        adminOnly: true,
        hiddenOnRemote: true,
    },
    {
        id: 'webhooks',
        group: 'alerts',
        label: 'Webhooks',
        description: 'Incoming HMAC-signed HTTP triggers that run stack actions from CI/CD pipelines.',
        keywords: ['webhook', 'incoming', 'trigger', 'ci', 'cd', 'pipeline', 'deploy', 'hmac', 'signature', 'action'],
        tier: null,
        scope: 'global',
        hiddenOnRemote: true,
    },
    {
        id: 'labels',
        group: 'advanced',
        label: 'Labels',
        description: 'Per-node labels for stacks and containers.',
        keywords: ['labels', 'tags', 'palette', 'organisation'],
        tier: null,
        scope: 'node',
    },
    {
        id: 'security',
        group: 'advanced',
        label: 'Security',
        description: 'Image scanning, suppressions, and posture defaults.',
        keywords: ['scan', 'cve', 'trivy', 'suppressions', 'hardening'],
        tier: null,
        scope: 'node',
        adminOnly: true,
    },
    {
        id: 'developer',
        group: 'advanced',
        label: 'Developer',
        description: 'Retention windows and debug modes.',
        keywords: ['retention', 'logs', 'metrics', 'debug', 'developer'],
        tier: null,
        scope: 'node',
    },
    {
        id: 'app-store',
        group: 'advanced',
        label: 'App Store',
        description: 'Template registry URL and featured-catalog source.',
        keywords: ['templates', 'registry', 'catalog', 'featured'],
        tier: null,
        scope: 'node',
    },
    {
        id: 'recovery',
        group: 'advanced',
        label: 'Recovery',
        description: 'System health snapshot, safe recovery actions, and emergency command-line reference.',
        keywords: ['recovery', 'safe mode', 'diagnostics', 'health', 'emergency', 'cli', 'reset', 'backup', 'restore'],
        tier: null,
        scope: 'global',
        adminOnly: true,
        hiddenOnRemote: true,
    },
    {
        id: 'support',
        group: 'advanced',
        label: 'Support',
        description: 'Diagnostics bundle, docs links, and contact channels.',
        keywords: ['help', 'diagnostics', 'bundle', 'docs', 'contact'],
        tier: null,
        scope: 'global',
    },
    {
        id: 'about',
        group: 'advanced',
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
