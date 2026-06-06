/**
 * Structural invariants for the settings registry after the hub reorganization.
 *
 * Guards the ten-group taxonomy and the System Limits split: every item lands in
 * a real group, the three successor sections (Host Alerts, Docker & Storage,
 * Fleet Mesh) exist with the right group/scope/gate, Developer is split from
 * Data Retention, and the renamed labels are applied.
 */
import { describe, it, expect } from 'vitest';
import { SETTINGS_GROUPS, SETTINGS_ITEMS } from '../registry';

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
    });

    it('gates the Fleet Mesh section to admins so the sidebar entry and panel both hide', () => {
        const fleetMesh = SETTINGS_ITEMS.find(i => i.id === 'fleet-mesh');
        expect(fleetMesh?.adminOnly).toBe(true);
    });

    it('splits Developer into Developer Diagnostics and Data Retention under Operations', () => {
        const developer = SETTINGS_ITEMS.find(i => i.id === 'developer');
        const dataRetention = SETTINGS_ITEMS.find(i => i.id === 'data-retention');
        expect(developer?.label).toBe('Developer Diagnostics');
        expect(developer?.group).toBe('operations');
        expect(dataRetention?.group).toBe('operations');
    });

    it('applies the renamed section labels', () => {
        const byId = new Map(SETTINGS_ITEMS.map(i => [i.id, i]));
        expect(byId.get('notifications')?.label).toBe('Channels');
        expect(byId.get('notification-routing')?.label).toBe('Notification Routing');
        expect(byId.get('security')?.label).toBe('Vulnerability Scanning');
    });

    it('preserves the paid gate on Registries', () => {
        const registries = SETTINGS_ITEMS.find(i => i.id === 'registries');
        expect(registries?.tier).toBe('paid');
    });
});
