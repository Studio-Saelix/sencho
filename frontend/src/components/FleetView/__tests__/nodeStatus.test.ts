import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { deriveNodeStatus } from '../nodeStatus';
import type { FleetNode, NodeUpdateStatus } from '../types';

const NOW = 1_800_000_000_000;

const sys = (cpu: string, disk = '30.0') => ({
    cpu: { usage: cpu, cores: 4 },
    memory: { total: 100, used: 40, free: 60, usagePercent: '40.0' },
    disk: { total: 100, used: 30, free: 70, usagePercent: disk },
});

function node(overrides: Partial<FleetNode> = {}): FleetNode {
    return {
        id: 2, name: 'edge', type: 'remote', status: 'online',
        stats: { active: 3, managed: 3, unmanaged: 0, exited: 0, total: 3 },
        systemStats: sys('10.0'), stacks: ['web'],
        cordoned: false, cordoned_at: null, cordoned_reason: null,
        ...overrides,
    };
}

function update(overrides: Partial<NodeUpdateStatus> = {}): NodeUpdateStatus {
    return {
        nodeId: 2, name: 'edge', type: 'remote', version: '0.97.0', latestVersion: '0.98.0',
        updateAvailable: false, updateStatus: null, ...overrides,
    };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => vi.useRealTimers());

describe('deriveNodeStatus', () => {
    it('is healthy with no verb and no other conditions when nothing needs attention', () => {
        const s = deriveNodeStatus({ node: node(), isPilot: false, updateStatus: update() });
        expect(s.answer.kind).toBe('healthy');
        expect(s.answer.verb).toBeUndefined();
        expect(s.conditions).toEqual([]);
        expect(s.otherCount).toBe(0);
    });

    it('says a Pilot is disconnected with its last-seen age and offers Test connection', () => {
        const s = deriveNodeStatus({
            node: node({ status: 'offline', stats: null, systemStats: null, pilot_last_seen: NOW / 1000 - 12 * 60 }),
            isPilot: true,
        });
        expect(s.answer).toMatchObject({ kind: 'offline', title: 'Offline', verb: { id: 'test-connection' } });
        expect(s.answer.line).toMatch(/^Pilot disconnected · last seen 12m ago$/);
    });

    it('says a proxy node is unreachable with its last contact, or that it never connected', () => {
        const seen = deriveNodeStatus({ node: node({ status: 'offline', stats: null, systemStats: null, last_successful_contact: NOW / 1000 - 3600 }), isPilot: false });
        expect(seen.answer.line).toBe('Proxy unreachable · last contact 1h ago');
        const never = deriveNodeStatus({ node: node({ status: 'offline', stats: null, systemStats: null }), isPilot: false });
        expect(never.answer.line).toBe('Proxy unreachable · never connected');
    });

    it('ignores stale update, GitOps and networking readings on an offline node', () => {
        const s = deriveNodeStatus({
            node: node({ status: 'offline', stats: null, systemStats: null }),
            isPilot: false,
            updateStatus: update({ updateAvailable: true }),
            gitopsAttention: 2,
            networking: { exposed: true, unknown: false, drift: false },
        });
        expect(s.conditions.map(c => c.kind)).toEqual(['offline']);
        expect(s.stages.map(st => st.id)).toEqual(['connection']);
    });

    it('treats an online remote with no readings as reconnecting', () => {
        const s = deriveNodeStatus({ node: node({ stats: null, systemStats: null, pilot_last_seen: NOW / 1000 - 5 }), isPilot: true });
        expect(s.answer).toMatchObject({ kind: 'reconnecting', verb: { id: 'test-connection' } });
        expect(s.stages).toEqual([{ id: 'connection', label: 'connection', tone: 'warning', word: 'reconnecting' }]);
    });

    it('ranks critical over an available update, and counts the update as the other condition', () => {
        const s = deriveNodeStatus({ node: node({ systemStats: sys('95.0') }), isPilot: false, updateStatus: update({ updateAvailable: true }) });
        expect(s.answer.kind).toBe('critical');
        expect(s.answer.line).toBe('CPU 95% is above the critical threshold.');
        expect(s.conditions.map(c => c.kind)).toEqual(['critical', 'update-available']);
        expect(s.otherCount).toBe(1);
    });

    it('orders failed update, GitOps, update available, networking, then cordoned', () => {
        const s = deriveNodeStatus({
            node: node({ cordoned: true }),
            isPilot: false,
            updateStatus: update({ updateAvailable: true, updateStatus: null }),
            gitopsAttention: 2,
            networking: { exposed: false, unknown: false, drift: true },
        });
        expect(s.conditions.map(c => c.kind)).toEqual(['gitops', 'update-available', 'networking', 'cordoned']);
        const failed = deriveNodeStatus({ node: node(), isPilot: false, updateStatus: update({ updateStatus: 'failed', error: 'pull failed' }), gitopsAttention: 1 });
        expect(failed.answer).toMatchObject({ kind: 'update-failed', line: 'pull failed', verb: { id: 'retry-update' } });
        expect(failed.conditions.map(c => c.kind)).toEqual(['update-failed', 'gitops']);
    });

    it('offers the versioned update verb, a dev-build verb, and none for a pinned image', () => {
        const avail = deriveNodeStatus({ node: node(), isPilot: false, updateStatus: update({ updateAvailable: true }) });
        expect(avail.answer.verb).toEqual({ id: 'update', label: 'Update to v0.98.0' });
        const dev = deriveNodeStatus({ node: node(), isPilot: false, updateStatus: update({ devBuildUpdateAvailable: true }) });
        expect(dev.answer).toMatchObject({ kind: 'update-dev', verb: { id: 'update-dev' } });
        const pinned = deriveNodeStatus({ node: node(), isPilot: false, updateStatus: update({ updateAvailable: true, updateBlocked: true, imageChannel: 'community' }) });
        expect(pinned.answer).toMatchObject({ kind: 'update-pinned' });
        expect(pinned.answer.verb).toBeUndefined();
        const hardened = deriveNodeStatus({ node: node(), isPilot: false, updateStatus: update({ updateAvailable: true, updateBlocked: true, imageChannel: 'hardened' }) });
        expect(hardened.answer.kind).toBe('update-available');
    });

    it('does not offer an update the operator skipped or one already running', () => {
        const skipped = deriveNodeStatus({ node: node(), isPilot: false, updateStatus: update({ updateAvailable: true, skipActive: true }) });
        expect(skipped.answer.kind).toBe('healthy');
        const running = deriveNodeStatus({ node: node(), isPilot: false, updateStatus: update({ updateAvailable: true, updateStatus: 'updating' }) });
        expect(running.conditions.map(c => c.kind)).toEqual(['updating']);
    });

    it('speaks for a cordoned node with its reason and an Uncordon verb', () => {
        const s = deriveNodeStatus({ node: node({ cordoned: true, cordoned_reason: 'draining' }), isPilot: false });
        expect(s.answer).toMatchObject({ kind: 'cordoned', line: 'draining', verb: { id: 'uncordon' } });
    });

    it('builds the Path only from stages that apply', () => {
        const local = deriveNodeStatus({ node: node({ type: 'local' }), isPilot: false });
        expect(local.stages.map(st => st.id)).toEqual(['resources', 'workload']);
        const full = deriveNodeStatus({
            node: node({ stats: { active: 3, managed: 3, unmanaged: 0, exited: 1, total: 4 } }),
            isPilot: false, updateStatus: update(), gitopsAttention: 1, networking: { exposed: true, unknown: false, drift: false },
        });
        expect(full.stages.map(st => [st.id, st.word])).toEqual([
            ['connection', 'connected'],
            ['resources', 'normal'],
            ['workload', '3 running · 1 stopped'],
            ['version', 'up to date'],
            ['gitops', '1 need attention'],
            ['networking', 'exposed'],
        ]);
    });

    it('marks an integration image on the version stage even with no update pending', () => {
        const s = deriveNodeStatus({ node: node(), isPilot: false, updateStatus: update({ isDevImage: true }) });
        expect(s.stages.find(st => st.id === 'version')).toMatchObject({ word: 'integration image', tone: 'warning' });
    });

    it('says the Local node is offline because Docker is unreachable, not that a proxy is', () => {
        const s = deriveNodeStatus({ node: node({ type: 'local', status: 'offline', stats: null, systemStats: null }), isPilot: false });
        expect(s.answer).toMatchObject({ kind: 'offline', line: 'Docker is unreachable on this host.' });
    });

    it('keeps a failed or running update on a node that is offline, with its error on the Path', () => {
        const down = { node: node({ status: 'offline', stats: null, systemStats: null }), isPilot: false };
        const failed = deriveNodeStatus({ ...down, updateStatus: update({ updateStatus: 'timeout', error: 'node never returned' }) });
        expect(failed.conditions.map(c => c.kind)).toEqual(['offline', 'update-failed']);
        expect(failed.conditions[1]).toMatchObject({ title: 'Update timed out', line: 'node never returned' });
        expect(failed.stages.find(st => st.id === 'version')).toMatchObject({ word: 'update failed', line: 'node never returned' });

        const running = deriveNodeStatus({ ...down, updateStatus: update({ updateStatus: 'updating' }) });
        expect(running.conditions.map(c => c.kind)).toEqual(['offline', 'updating']);
    });

    it('keeps a failed update reachable when a louder state outranks it', () => {
        const s = deriveNodeStatus({ node: node({ systemStats: sys('95.0') }), isPilot: false, updateStatus: update({ updateStatus: 'failed' }) });
        expect(s.conditions.map(c => c.kind)).toEqual(['critical', 'update-failed']);
        expect(s.conditions[1].verb).toEqual({ id: 'retry-update', label: 'Retry update' });
    });

    it('names a timed-out update and falls back to a plain sentence when there is no error text', () => {
        const s = deriveNodeStatus({ node: node(), isPilot: false, updateStatus: update({ updateStatus: 'timeout' }) });
        expect(s.answer).toMatchObject({ title: 'Update timed out', line: 'The node did not come back in time.' });
    });

    it('reports a skipped update as skipped on the version stage, never up to date', () => {
        const s = deriveNodeStatus({ node: node(), isPilot: false, updateStatus: update({ updateAvailable: true, skipActive: true }) });
        expect(s.stages.find(st => st.id === 'version')).toMatchObject({ word: 'update skipped', tone: 'neutral' });
    });

    it('lets a reconnecting node also carry a cordon, and labels the verb the way the menu does', () => {
        const s = deriveNodeStatus({ node: node({ stats: null, systemStats: null, cordoned: true }), isPilot: true });
        expect(s.conditions.map(c => c.kind)).toEqual(['reconnecting', 'cordoned']);
        expect(s.conditions[1].verb?.label).toBe('Uncordon node');
    });
});
