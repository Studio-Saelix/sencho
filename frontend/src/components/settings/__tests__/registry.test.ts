/**
 * Structural invariants for the settings registry after the hub reorganization.
 *
 * Guards the ten-group taxonomy and the System Limits split: every item lands in
 * a real group, the three successor sections (Host Alerts, Docker & Storage,
 * Fleet Mesh) exist with the right group/scope/gate, Developer is split from
 * Data Retention, and the renamed labels are applied.
 */
import { describe, it, expect } from 'vitest';
import { SETTINGS_GROUPS, SETTINGS_ITEMS, scopeLabel } from '../registry';
import type { SettingsItemMeta } from '../registry';

describe('settings registry', () => {
    it('points every item at a defined group', () => {
        const groupIds = new Set(SETTINGS_GROUPS.map(g => g.id));
        for (const item of SETTINGS_ITEMS) {
            expect(groupIds.has(item.group), `item ${item.id} -> group ${item.group}`).toBe(true);
        }
    });

    it('gives every group at least one item', () => {
        for (const group of SETTINGS_GROUPS) {
            const count = SETTINGS_ITEMS.filter(i => i.group === group.id).length;
            expect(count, `group ${group.id}`).toBeGreaterThan(0);
        }
    });

    it('keeps item ids unique', () => {
        const ids = SETTINGS_ITEMS.map(i => i.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('replaces System Limits with three focused sections', () => {
        expect(SETTINGS_ITEMS.some(i => (i.id as string) === 'system')).toBe(false);

        const hostAlerts = SETTINGS_ITEMS.find(i => i.id === 'host-alerts');
        const dockerStorage = SETTINGS_ITEMS.find(i => i.id === 'docker-storage');
        const fleetMesh = SETTINGS_ITEMS.find(i => i.id === 'fleet-mesh');

        expect(hostAlerts?.group).toBe('monitoring');
        expect(dockerStorage?.group).toBe('monitoring');
        expect(fleetMesh?.group).toBe('infrastructure');

        // All three edit the active instance's own settings through the proxy.
        expect(hostAlerts?.scope).toBe('node');
        expect(dockerStorage?.scope).toBe('node');
        expect(fleetMesh?.scope).toBe('node');

        const containerAlerts = SETTINGS_ITEMS.find(i => i.id === 'container-alerts');
        expect(containerAlerts?.group).toBe('monitoring');
        expect(containerAlerts?.scope).toBe('node');
        expect(containerAlerts?.tier).toBeNull();
        for (const term of ['crash', 'oom', 'healthcheck', 'container']) {
            expect(containerAlerts?.keywords, `keyword ${term}`).toContain(term);
        }
    });

    it('gates the Fleet section to admins so the sidebar entry and panel both hide', () => {
        const fleetMesh = SETTINGS_ITEMS.find(i => i.id === 'fleet-mesh');
        expect(fleetMesh?.adminOnly).toBe(true);
        expect(fleetMesh?.description?.toLowerCase()).not.toContain('mesh');
        expect(fleetMesh?.keywords?.some(k => /mesh|sencho_mesh|routing/i.test(k))).toBe(false);
    });

    it('splits Developer into Developer Diagnostics and Data Retention under Operations', () => {
        const developer = SETTINGS_ITEMS.find(i => i.id === 'developer');
        const dataRetention = SETTINGS_ITEMS.find(i => i.id === 'data-retention');
        expect(developer?.label).toBe('Developer Diagnostics');
        expect(developer?.group).toBe('operations');
        expect(dataRetention?.group).toBe('operations');
    });

    it('registers the Image update checks section under Automation, viewer-visible and node-scoped', () => {
        const item = SETTINGS_ITEMS.find(i => i.id === 'image-updates');
        expect(item?.group).toBe('automation');
        expect(item?.scope).toBe('node');
        expect(item?.tier).toBeNull();
        // No adminOnly: viewers see the section read-only (the control disables
        // itself); the backend PUT is the authoritative admin guard.
        expect(item?.adminOnly).toBeUndefined();
    });

    it('applies the renamed section labels', () => {
        const byId = new Map(SETTINGS_ITEMS.map(i => [i.id, i]));
        expect(byId.get('notifications')?.label).toBe('Channels');
        expect(byId.get('notification-routing')?.label).toBe('Routing');
        expect(byId.get('notification-suppression')?.label).toBe('Mute Rules');
    });

    it('no longer registers the standalone Vulnerability Scanning section (moved to the Security page)', () => {
        expect(SETTINGS_ITEMS.some(i => (i.id as string) === 'security')).toBe(false);
    });

    it('opens Registries to Community behind system:registries', () => {
        const registries = SETTINGS_ITEMS.find(i => i.id === 'registries');
        expect(registries?.tier).toBeNull();
        expect(registries?.adminOnly).toBeUndefined();
        expect(registries?.requiredPermission).toBe('system:registries');
    });

    it('registers the Stacks section under Infrastructure with searchable workflow keywords', () => {
        const stacks = SETTINGS_ITEMS.find(i => i.id === 'stacks');
        expect(stacks?.group).toBe('infrastructure');
        expect(stacks?.tier).toBeNull();
        for (const term of ['stack', 'deploy', 'guardrail', 'health gate', 'observation', 'env', 'required variable', 'progress', 'diff', 'save']) {
            expect(stacks?.keywords, `keyword ${term}`).toContain(term);
        }
    });

    it('scopes the browser-local sections to the browser', () => {
        // Appearance is the only remaining browser-local section. Stacks moved to
        // node scope when Deploy Guardrails (backend settings) were added to it
        // alongside the existing browser-local Workflow controls.
        expect(SETTINGS_ITEMS.find(i => i.id === 'appearance')?.scope).toBe('browser');
        expect(SETTINGS_ITEMS.find(i => i.id === 'stacks')?.scope).toBe('node');
    });

    it('exposes the Calm/Signature appearance keywords for search', () => {
        const appearance = SETTINGS_ITEMS.find(i => i.id === 'appearance');
        for (const term of ['calm', 'signature', 'readability', 'heading', 'chart', 'motion', 'effects']) {
            expect(appearance?.keywords, `keyword ${term}`).toContain(term);
        }
    });
});

describe('scopeLabel', () => {
    const item = (over: Partial<SettingsItemMeta>): SettingsItemMeta => ({
        id: 'stacks', group: 'infrastructure', label: 'X', description: '',
        keywords: [], tier: null, scope: 'global', ...over,
    });

    it('reads browser for browser-scoped sections regardless of their group', () => {
        expect(scopeLabel(item({ scope: 'browser', group: 'personal' }))).toBe('browser');
        expect(scopeLabel(item({ scope: 'browser', group: 'infrastructure' }))).toBe('browser');
    });

    it('reads operator for the signed-in Account (personal group)', () => {
        expect(scopeLabel(item({ scope: 'global', group: 'personal' }))).toBe('operator');
    });

    it('reads global for other non-node, non-browser groups', () => {
        expect(scopeLabel(item({ scope: 'global', group: 'access' }))).toBe('global');
    });
});

describe('requiredPermission registry mapping', () => {
    it('declares matrix permissions for access and credential sections', () => {
        const byId = new Map(SETTINGS_ITEMS.map(i => [i.id, i]));
        expect(byId.get('users')?.requiredPermission).toBe('system:users');
        expect(byId.get('users')?.adminOnly).toBeUndefined();
        expect(byId.get('license')?.requiredPermission).toBe('system:license');
        expect(byId.get('api-tokens')?.requiredPermission).toBe('system:tokens');
        expect(byId.get('api-tokens')?.adminOnly).toBeUndefined();
        expect(byId.get('webhooks')?.requiredPermission).toBe('system:webhooks');
        expect(byId.get('nodes')?.requiredPermission).toBe('node:read');
        expect(byId.get('developer')?.requiredPermission).toBe('system:settings');
        expect(byId.get('data-retention')?.requiredPermission).toBe('system:settings');
        expect(byId.get('image-updates')?.requiredPermission).toBe('system:settings');
        expect(byId.get('labels')?.requiredPermission).toBe('stack:read');
    });

    it('keeps adminOnly on identity, credentials, and emergency surfaces', () => {
        for (const id of [
            'sso',
            'cloud-backup',
            'recovery',
            'fleet-mesh',
            'notification-routing',
            'notification-suppression',
        ] as const) {
            expect(SETTINGS_ITEMS.find(i => i.id === id)?.adminOnly, id).toBe(true);
            expect(SETTINGS_ITEMS.find(i => i.id === id)?.requiredPermission, id).toBeUndefined();
        }
    });
});
