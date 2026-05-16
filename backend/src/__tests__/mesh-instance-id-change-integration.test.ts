/**
 * Central instance id rotation invariant.
 *
 * `MeshCentralRegistry.upsert` is the single source of truth for the
 * locally-cached callback material. When central regenerates its
 * `instance_id` (factory reset, DB swap, container rebuild without volume),
 * the next bootstrap frame arrives with a different `centralInstanceId`. The
 * registry MUST:
 *   - persist the new row,
 *   - emit a single `central-instance-changed` event so subscribers (loud
 *     log, dialer reset) can react.
 *
 * Failing this invariant means the peer would keep dialing back with the
 * old JWT (rejected with `instance_mismatch`) without anyone noticing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { MeshCentralRegistry } from '../services/MeshCentralRegistry';
import { DatabaseService } from '../services/DatabaseService';

describe('Central instance id change', () => {
    let tmpDir: string;
    beforeEach(async () => {
        tmpDir = await setupTestDb();
        MeshCentralRegistry.resetForTest();
        // Defensive: the per-file DB copy may carry rows from a prior baseline.
        DatabaseService.getInstance().getDb().prepare('DELETE FROM mesh_centrals').run();
    });
    afterEach(() => cleanupTestDb(tmpDir));

    it('drops the old row and accepts the new one with a central-instance-changed event', () => {
        const reg = MeshCentralRegistry.getInstance();
        reg.upsert({
            centralInstanceId: 'old-uuid',
            centralApiUrl: 'https://central.example.com',
            callbackJwt: 'jwt-old',
            jwtIssuedAt: 1,
            jwtExpiresAt: 999999,
        });
        const events: Array<{ previousInstanceId: string; newInstanceId: string }> = [];
        reg.on('central-instance-changed', (e: { previousInstanceId: string; newInstanceId: string }) => events.push(e));

        reg.upsert({
            centralInstanceId: 'new-uuid',
            centralApiUrl: 'https://central.example.com',
            callbackJwt: 'jwt-new',
            jwtIssuedAt: 2,
            jwtExpiresAt: 999999,
        });

        expect(events).toHaveLength(1);
        expect(events[0].previousInstanceId).toBe('old-uuid');
        expect(events[0].newInstanceId).toBe('new-uuid');
        // getActive returns the most-recently-bootstrapped row.
        expect(reg.getActive()?.centralInstanceId).toBe('new-uuid');
        expect(reg.getActive()?.callbackJwt).toBe('jwt-new');
    });

    it('an upsert with the same instance id does NOT emit central-instance-changed', () => {
        const reg = MeshCentralRegistry.getInstance();
        reg.upsert({
            centralInstanceId: 'stable-uuid',
            centralApiUrl: 'https://central.example.com',
            callbackJwt: 'jwt-1',
            jwtIssuedAt: 1,
            jwtExpiresAt: 999999,
        });
        const events: Array<unknown> = [];
        reg.on('central-instance-changed', (e: unknown) => events.push(e));
        reg.upsert({
            centralInstanceId: 'stable-uuid',
            centralApiUrl: 'https://central.example.com',
            callbackJwt: 'jwt-2-rotated',
            jwtIssuedAt: 2,
            jwtExpiresAt: 999999,
        });
        expect(events).toHaveLength(0);
        // Same id, the JWT material is overwritten in place.
        expect(reg.getActive()?.callbackJwt).toBe('jwt-2-rotated');
    });
});
