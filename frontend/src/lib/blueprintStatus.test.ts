import { describe, expect, it } from 'vitest';
import type { BlueprintDeploymentStatus } from './blueprintsApi';
import { buildBlueprintStatus, summarizeFailure } from './blueprintStatus';

const names: Record<number, string> = { 1: 'alpha', 2: 'beta', 3: 'gamma', 4: 'delta' };
const nodeName = (id: number) => names[id] ?? `node ${id}`;

function status(
    rows: Array<[number, BlueprintDeploymentStatus, string?]>,
    over: { enabled?: boolean; approval?: 'approved' | 'pending' | 'reapproval_required' } = {},
) {
    return buildBlueprintStatus({
        enabled: over.enabled ?? true,
        approval: over.approval ?? 'approved',
        deployments: rows.map(([node_id, s, last_error]) => ({ node_id, status: s, last_error: last_error ?? null })),
        nodeName,
    });
}

describe('buildBlueprintStatus', () => {
    it('is quiet and green when every node runs the confirmed revision', () => {
        const m = status([[1, 'active'], [2, 'active']]);
        expect(m.answer).toMatchObject({ tone: 'success', title: 'in sync', line: '2 nodes running the current revision.' });
        expect(m.verb).toBeNull();
        expect(m.stages.map(s => s.word)).toEqual(['confirmed', '2/2 active']);
    });

    it('names the failed nodes and offers Re-apply, leaving the cause to the failed row', () => {
        const m = status([[1, 'active'], [2, 'failed', 'Network x Created\nError response from daemon: port is already allocated']]);
        expect(m.answer).toMatchObject({
            tone: 'destructive', title: 'failed', line: 'Deploy failed on beta.',
        });
        expect(m.verb).toEqual({ kind: 'reapply', label: 'Re-apply' });
        expect(m.stages.find(s => s.id === 'nodes')).toMatchObject({ tone: 'destructive', word: '1/2 active' });
    });

    it('lets a failure outrank every warning', () => {
        const m = status([[1, 'drifted'], [2, 'failed'], [3, 'pending_state_review']]);
        expect(m.answer.title).toBe('failed');
    });

    it('offers no verb for a name conflict, which only the operator can resolve on the node', () => {
        const m = status([[1, 'name_conflict']]);
        expect(m.answer).toMatchObject({ tone: 'destructive', title: 'name conflict' });
        expect(m.verb).toBeNull();
    });

    it('points the verb at the node that needs the decision', () => {
        expect(status([[2, 'pending_state_review'], [3, 'pending_state_review']]).verb)
            .toEqual({ kind: 'review_state', label: 'Review state', nodeId: 2 });
        expect(status([[3, 'evict_blocked']]).verb).toEqual({ kind: 'evict', label: 'Evict', nodeId: 3 });
    });

    it('summarizes several nodes without listing them all', () => {
        const m = status([[1, 'drifted'], [2, 'drifted'], [3, 'drifted'], [4, 'drifted']]);
        expect(m.answer.line).toBe('alpha, beta and 2 more no longer match the declared revision.');
        expect(m.verb).toEqual({ kind: 'reapply', label: 'Re-apply' });
    });

    it('says the reconciler is off and offers Enable', () => {
        const m = status([[1, 'active']], { enabled: false });
        expect(m.answer).toMatchObject({ tone: 'neutral', title: 'reconciler off' });
        expect(m.verb).toEqual({ kind: 'enable', label: 'Enable' });
        expect(m.stages.map(s => s.id)).toEqual(['approval', 'nodes', 'reconciler']);
    });

    it('still reports a failure on a disabled Blueprint, but offers Enable because applying is refused', () => {
        const m = status([[1, 'failed'], [2, 'drifted']], { enabled: false });
        expect(m.answer.title).toBe('failed');
        expect(m.verb).toEqual({ kind: 'enable', label: 'Enable' });
    });

    it('reads an unknown deployment status as needing attention, never as healthy', () => {
        const m = status([[1, 'active'], [2, 'quarantined' as BlueprintDeploymentStatus]]);
        expect(m.answer).toMatchObject({ tone: 'warning', title: 'unrecognized state', line: 'beta reported a state this Sencho build does not know.' });
        expect(m.stages.find(s => s.id === 'nodes')?.tone).not.toBe('success');
    });

    it('treats an unknown approval as pending rather than confirmed', () => {
        const m = status([[1, 'active']], { approval: 'revoked' as 'approved' });
        expect(m.answer).toMatchObject({ tone: 'warning', status: 'approval_pending' });
        expect(m.stages[0]).toMatchObject({ word: 'pending' });
    });

    it('calls a new Blueprint not deployed and offers the rollout review', () => {
        const m = status([], { approval: 'pending' });
        expect(m.answer).toMatchObject({ tone: 'neutral', title: 'not deployed' });
        expect(m.verb).toEqual({ kind: 'reapply', label: 'Review rollout' });
        expect(m.stages.map(s => s.id)).toEqual(['approval']);
    });

    it('asks to reconfirm after the targets changed', () => {
        const m = status([[1, 'active']], { approval: 'reapproval_required' });
        expect(m.answer).toMatchObject({ tone: 'warning', title: 'needs confirmation' });
        expect(m.verb).toEqual({ kind: 'reapply', label: 'Review rollout' });
        expect(m.stages[0]).toMatchObject({ tone: 'warning', word: 'reconfirm' });
    });

    it('treats saved but unconfirmed changes as a warning once nodes are live', () => {
        const m = status([[1, 'active']], { approval: 'pending' });
        expect(m.answer).toMatchObject({ tone: 'warning', status: 'approval_pending' });
    });

    it('reports work in flight without a verb', () => {
        const m = status([[1, 'deploying']]);
        expect(m.answer).toMatchObject({ tone: 'brand', title: 'in progress' });
        expect(m.verb).toBeNull();
    });

    it('ignores withdrawn deployments', () => {
        const m = status([[1, 'withdrawn'], [2, 'active']]);
        expect(m.answer.line).toBe('1 node running the current revision.');
        expect(m.stages.find(s => s.id === 'nodes')?.word).toBe('1/1 active');
    });

    it('says no node matches when an approved Blueprint has nothing live', () => {
        expect(status([]).answer).toMatchObject({ title: 'no nodes' });
    });
});

describe('summarizeFailure', () => {
    it('returns null for nothing to say', () => {
        expect(summarizeFailure(null)).toBeNull();
        expect(summarizeFailure('  \n ')).toBeNull();
    });

    it('picks the last line that reads like a failure from a transcript', () => {
        const log = 'Network a Creating\nContainer a-1 Starting\nError response from daemon: Bind for 0.0.0.0:8080 failed: port is already allocated\n';
        const result = summarizeFailure(log);
        expect(result?.summary).toBe('Error response from daemon: Bind for 0.0.0.0:8080 failed: port is already allocated');
        expect(result?.full).toBe(log.trim());
    });

    it('cuts a transcript squeezed onto one line at the daemon error', () => {
        const result = summarizeFailure('Network a Creating Container a-1 Starting Error response from daemon: port is already allocated');
        expect(result?.summary).toBe('Error response from daemon: port is already allocated');
        expect(result?.full).not.toBeNull();
    });

    it('has no extra detail when the message is already one line', () => {
        expect(summarizeFailure('image pull denied')).toEqual({ summary: 'image pull denied', full: null });
    });

    it('keeps the line when it is nothing but a container id', () => {
        expect(summarizeFailure('(abcdef123456abcdef)')?.summary).toBe('(abcdef123456abcdef)');
    });

    it('splits on a lone carriage return, as progress output uses', () => {
        expect(summarizeFailure('Pulling\rError response from daemon: no such image')?.summary).toBe('Error response from daemon: no such image');
    });

    it('falls back to the last line when nothing reads like a failure', () => {
        expect(summarizeFailure('step one\nstep two')?.summary).toBe('step two');
    });

    it('keeps the tail of a very long line, where the cause is', () => {
        const result = summarizeFailure(`failed: ${'x'.repeat(400)} port is already allocated`);
        expect(result?.summary).toHaveLength(200);
        expect(result?.summary.startsWith('\u2026')).toBe(true);
        expect(result?.summary.endsWith('port is already allocated')).toBe(true);
    });

    it('drops container ids from the summary but keeps them in the full output', () => {
        const line = 'Error response from daemon: driver failed on endpoint web-1 (1d6d0a2e68ac4b1a3bcca3177a772750becbcd622ee1d29d231100aa): Bind for 0.0.0.0:80 failed: port is already allocated';
        const result = summarizeFailure(line);
        expect(result?.summary).toBe('Error response from daemon: driver failed on endpoint web-1: Bind for 0.0.0.0:80 failed: port is already allocated');
        expect(result?.full).toBe(line);
    });
});
