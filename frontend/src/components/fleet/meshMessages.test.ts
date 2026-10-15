import { describe, expect, it } from 'vitest';
import { describeMembershipError, describeProbeFailure, fixActionLabel } from './meshMessages';

describe('describeProbeFailure', () => {
    const target = { nodeName: 'opsix', port: 5432 };

    it.each([
        ['no_route', /not published right now/, 'route'],
        ['pilot_tunnel', /Could not reach opsix/, 'diagnostics'],
        ['agent_resolve', /opsix does not publish/, 'route'],
        ['agent_dial', /could not connect to the container/, 'route'],
        ['target_port', /not listening on port 5432/, 'route'],
    ] as const)('explains %s and points at the next step', (where, pattern, fix) => {
        const out = describeProbeFailure('db.api.opsix.sencho', { where }, target);
        expect(out.message).toMatch(pattern);
        expect(out.fix).toBe(fix);
    });

    it('falls back to the activity log for unknown stages', () => {
        expect(describeProbeFailure('x.sencho', { message: 'boom' }).fix).toBe('activity');
    });

    it('labels every fix action', () => {
        expect(fixActionLabel('diagnostics')).toBe('Open diagnostics');
        expect(fixActionLabel('route')).toBe('Open route');
        expect(fixActionLabel('activity')).toBe('View activity');
    });
});

describe('describeMembershipError', () => {
    it('explains a port collision with the fix', () => {
        expect(describeMembershipError(409, 'port 5432 is already claimed by db.pg.home.sencho'))
            .toMatch(/already used by another meshed service .*different port/);
    });

    it('passes the backend reason through instead of guessing at it', () => {
        // 503 covers a down data plane and also a failed push, for example a
        // stack operation lock. Claiming the data plane when the backend said
        // something else sends the operator after the wrong thing.
        expect(describeMembershipError(503, 'subnet_overlap')).toBe('Could not change mesh membership: subnet_overlap');
        expect(describeMembershipError(503, 'another operation is in progress'))
            .toBe('Could not change mesh membership: another operation is in progress');
    });

    it('names the data plane when the backend gave no reason', () => {
        expect(describeMembershipError(503)).toMatch(/not ready on this node/);
    });

    it('explains missing permissions', () => {
        expect(describeMembershipError(403)).toMatch(/administrator/);
    });

    it('never shows a bare status code without guidance', () => {
        expect(describeMembershipError(500)).toMatch(/activity log/);
    });
});
