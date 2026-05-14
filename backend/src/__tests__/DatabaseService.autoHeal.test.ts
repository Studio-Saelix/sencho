/**
 * Integration tests for DatabaseService auto-heal CRUD.
 *
 * Uses a real temp SQLite database (same pattern as database-metrics.test.ts).
 * All operations are tested against live SQL; no mocking.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let db: any;

const makePolicy = (overrides: Record<string, unknown> = {}) => {
    const now = Date.now();
    return {
        node_id: 1,
        proxy_entitled_until: 0,
        stack_name: 'teststack',
        service_name: null,
        unhealthy_duration_mins: 5,
        cooldown_mins: 10,
        max_restarts_per_hour: 3,
        auto_disable_after_failures: 5,
        enabled: 1,
        consecutive_failures: 0,
        last_fired_at: 0,
        created_at: now,
        updated_at: now,
        ...overrides,
    };
};

beforeAll(async () => {
    tmpDir = await setupTestDb();
    const { DatabaseService } = await import('../services/DatabaseService');
    db = DatabaseService.getInstance();
});

afterAll(() => {
    cleanupTestDb(tmpDir);
});

describe('DatabaseService - auto-heal policy CRUD', () => {
    it('addAutoHealPolicy + getAutoHealPolicy round-trip preserves all fields', () => {
        const input = makePolicy({
            stack_name: 'roundtrip-stack',
            service_name: 'web',
            unhealthy_duration_mins: 3,
            cooldown_mins: 15,
            max_restarts_per_hour: 5,
            auto_disable_after_failures: 10,
            enabled: 1,
            consecutive_failures: 0,
            last_fired_at: 0,
        });

        const created = db.addAutoHealPolicy(input);
        expect(created.id).toBeDefined();
        expect(typeof created.id).toBe('number');

        const fetched = db.getAutoHealPolicy(created.id);
        expect(fetched).toBeDefined();
        expect(fetched.stack_name).toBe('roundtrip-stack');
        expect(fetched.node_id).toBe(1);
        expect(fetched.proxy_entitled_until).toBe(0);
        expect(fetched.service_name).toBe('web');
        expect(fetched.unhealthy_duration_mins).toBe(3);
        expect(fetched.cooldown_mins).toBe(15);
        expect(fetched.max_restarts_per_hour).toBe(5);
        expect(fetched.auto_disable_after_failures).toBe(10);
        expect(fetched.enabled).toBe(1);
        expect(fetched.consecutive_failures).toBe(0);
        expect(fetched.last_fired_at).toBe(0);
        expect(fetched.created_at).toBe(input.created_at);
    });

    it('getAutoHealPolicies without filter returns all policies', () => {
        const before = db.getAutoHealPolicies().length;

        db.addAutoHealPolicy(makePolicy({ stack_name: 'all-stack-a' }));
        db.addAutoHealPolicy(makePolicy({ stack_name: 'all-stack-b' }));

        const after = db.getAutoHealPolicies();
        expect(after.length).toBe(before + 2);
    });

    it('getAutoHealPolicies with stackName filter returns only matching rows', () => {
        db.addAutoHealPolicy(makePolicy({ stack_name: 'filter-stack-x' }));
        db.addAutoHealPolicy(makePolicy({ stack_name: 'filter-stack-y' }));

        const xPolicies = db.getAutoHealPolicies('filter-stack-x');
        const yPolicies = db.getAutoHealPolicies('filter-stack-y');

        expect(xPolicies.length).toBeGreaterThanOrEqual(1);
        expect(xPolicies.every((p: any) => p.stack_name === 'filter-stack-x')).toBe(true);

        expect(yPolicies.length).toBeGreaterThanOrEqual(1);
        expect(yPolicies.every((p: any) => p.stack_name === 'filter-stack-y')).toBe(true);
    });

    it('getAutoHealPolicies with nodeId filter returns only matching rows', () => {
        db.addAutoHealPolicy(makePolicy({ stack_name: 'node-filter-a', node_id: 1 }));
        db.addAutoHealPolicy(makePolicy({ stack_name: 'node-filter-b', node_id: 2 }));

        const nodeOnePolicies = db.getAutoHealPolicies(undefined, 1);
        const nodeTwoPolicies = db.getAutoHealPolicies(undefined, 2);

        expect(nodeOnePolicies.every((p: any) => p.node_id === 1)).toBe(true);
        expect(nodeTwoPolicies.every((p: any) => p.node_id === 2)).toBe(true);
    });

    it('auto-heal node migration does not rewrite already-scoped node 1 policies', () => {
        const created = db.addAutoHealPolicy(makePolicy({ stack_name: 'migration-node-one', node_id: 1 }));
        db.addNode({
            name: 'new-default-node',
            type: 'local',
            compose_dir: process.env.COMPOSE_DIR ?? '',
            is_default: true,
            api_url: '',
            api_token: '',
        });

        (db as any).migrateAutoHealNodeId();

        expect(db.getAutoHealPolicy(created.id).node_id).toBe(1);
    });

    it('auto-heal node migration resumes backfill when the completion marker is missing', () => {
        db.updateGlobalSetting('migration_auto_heal_node_scope_v1', '');
        const created = db.addAutoHealPolicy(makePolicy({ stack_name: 'migration-partial', node_id: 1 }));
        const newDefaultId = db.addNode({
            name: 'partial-new-default-node',
            type: 'local',
            compose_dir: process.env.COMPOSE_DIR ?? '',
            is_default: true,
            api_url: '',
            api_token: '',
        });

        (db as any).migrateAutoHealNodeId();

        expect(db.getAutoHealPolicy(created.id).node_id).toBe(newDefaultId);
        expect(db.getGlobalSettings().migration_auto_heal_node_scope_v1).toBe('1');
    });

    it('updateAutoHealPolicy partial update changes only specified fields', () => {
        const created = db.addAutoHealPolicy(makePolicy({ stack_name: 'update-stack', cooldown_mins: 10 }));

        db.updateAutoHealPolicy(created.id, { cooldown_mins: 30, max_restarts_per_hour: 7 });

        const updated = db.getAutoHealPolicy(created.id);
        // Changed fields
        expect(updated.cooldown_mins).toBe(30);
        expect(updated.max_restarts_per_hour).toBe(7);
        // Unchanged fields must be preserved
        expect(updated.stack_name).toBe('update-stack');
        expect(updated.unhealthy_duration_mins).toBe(5);
        // updated_at should be refreshed
        expect(updated.updated_at).toBeGreaterThanOrEqual(created.updated_at);
    });

    it('deleteAutoHealPolicy removes the policy row', () => {
        const created = db.addAutoHealPolicy(makePolicy({ stack_name: 'delete-stack' }));
        expect(db.getAutoHealPolicy(created.id)).toBeDefined();

        db.deleteAutoHealPolicy(created.id);

        expect(db.getAutoHealPolicy(created.id)).toBeUndefined();
    });

    it('deleteAutoHealPolicy cascades and removes history rows', () => {
        const created = db.addAutoHealPolicy(makePolicy({ stack_name: 'cascade-stack' }));
        const policyId: number = created.id;

        // Write a history entry tied to this policy
        db.recordAutoHealHistory({
            policy_id: policyId,
            stack_name: 'cascade-stack',
            service_name: null,
            container_name: 'cascade-stack-web-1',
            container_id: 'cascade-abc',
            action: 'restarted',
            reason: 'test cascade',
            success: 1,
            error: null,
            timestamp: Date.now(),
        });

        const beforeDelete = db.getAutoHealHistory(policyId);
        expect(beforeDelete.length).toBe(1);

        db.deleteAutoHealPolicy(policyId);

        const afterDelete = db.getAutoHealHistory(policyId);
        expect(afterDelete.length).toBe(0);
    });
});

describe('DatabaseService - auto-heal history', () => {
    it('recordAutoHealHistory + getAutoHealHistory orders results by timestamp DESC', () => {
        const policy = db.addAutoHealPolicy(makePolicy({ stack_name: 'history-order-stack' }));
        const policyId: number = policy.id;
        const baseTs = Date.now();

        db.recordAutoHealHistory({
            policy_id: policyId,
            stack_name: 'history-order-stack',
            service_name: null,
            container_name: 'history-order-stack-web-1',
            container_id: 'hist-001',
            action: 'restarted',
            reason: 'first',
            success: 1,
            error: null,
            timestamp: baseTs,
        });
        db.recordAutoHealHistory({
            policy_id: policyId,
            stack_name: 'history-order-stack',
            service_name: null,
            container_name: 'history-order-stack-web-1',
            container_id: 'hist-001',
            action: 'skipped_cooldown',
            reason: 'second',
            success: 0,
            error: null,
            timestamp: baseTs + 1_000,
        });

        const history = db.getAutoHealHistory(policyId);
        expect(history.length).toBe(2);
        // Most recent first
        expect(history[0].reason).toBe('second');
        expect(history[1].reason).toBe('first');
    });

    it('getAutoHealHistory respects the limit parameter', () => {
        const policy = db.addAutoHealPolicy(makePolicy({ stack_name: 'history-limit-stack' }));
        const policyId: number = policy.id;
        const baseTs = Date.now();

        for (let i = 0; i < 10; i++) {
            db.recordAutoHealHistory({
                policy_id: policyId,
                stack_name: 'history-limit-stack',
                service_name: null,
                container_name: 'history-limit-stack-web-1',
                container_id: 'hist-limit',
                action: 'restarted',
                reason: `entry-${i}`,
                success: 1,
                error: null,
                timestamp: baseTs + i,
            });
        }

        const limited = db.getAutoHealHistory(policyId, 3);
        expect(limited.length).toBe(3);
        // Should contain the 3 most recent entries (highest timestamps)
        expect(limited[0].reason).toBe('entry-9');
        expect(limited[1].reason).toBe('entry-8');
        expect(limited[2].reason).toBe('entry-7');
    });

    it('recordAutoHealHistory prunes old rows beyond the retained window', () => {
        const policy = db.addAutoHealPolicy(makePolicy({ stack_name: 'history-prune-stack' }));
        const policyId: number = policy.id;
        const baseTs = Date.now();

        for (let i = 0; i < 505; i++) {
            db.recordAutoHealHistory({
                policy_id: policyId,
                stack_name: 'history-prune-stack',
                service_name: null,
                container_name: 'history-prune-stack-web-1',
                container_id: 'hist-prune',
                action: 'skipped_cooldown',
                reason: `entry-${i}`,
                success: 0,
                error: null,
                timestamp: baseTs + i,
            });
        }

        const retained = db.getAutoHealHistory(policyId, 600);
        expect(retained.length).toBe(500);
        expect(retained[0].reason).toBe('entry-504');
        expect(retained[499].reason).toBe('entry-5');
    });
});

describe('DatabaseService - consecutive failure counters', () => {
    it('incrementConsecutiveFailures increments the counter each call', () => {
        const policy = db.addAutoHealPolicy(makePolicy({ stack_name: 'fail-inc-stack', consecutive_failures: 0 }));
        const id: number = policy.id;

        db.incrementConsecutiveFailures(id);
        expect(db.getAutoHealPolicy(id).consecutive_failures).toBe(1);

        db.incrementConsecutiveFailures(id);
        expect(db.getAutoHealPolicy(id).consecutive_failures).toBe(2);
    });

    it('resetConsecutiveFailures sets the counter back to 0', () => {
        const policy = db.addAutoHealPolicy(makePolicy({ stack_name: 'fail-reset-stack', consecutive_failures: 0 }));
        const id: number = policy.id;

        db.incrementConsecutiveFailures(id);
        db.incrementConsecutiveFailures(id);
        expect(db.getAutoHealPolicy(id).consecutive_failures).toBe(2);

        db.resetConsecutiveFailures(id);
        expect(db.getAutoHealPolicy(id).consecutive_failures).toBe(0);
    });
});

describe('DatabaseService - setPolicyEnabled', () => {
    it('setPolicyEnabled(id, false) sets enabled to 0', () => {
        const policy = db.addAutoHealPolicy(makePolicy({ stack_name: 'enable-toggle-stack', enabled: 1 }));
        const id: number = policy.id;

        db.setPolicyEnabled(id, false);
        expect(db.getAutoHealPolicy(id).enabled).toBe(0);
    });

    it('setPolicyEnabled(id, true) sets enabled to 1', () => {
        const policy = db.addAutoHealPolicy(makePolicy({ stack_name: 'enable-on-stack', enabled: 0 }));
        const id: number = policy.id;

        db.setPolicyEnabled(id, true);
        expect(db.getAutoHealPolicy(id).enabled).toBe(1);
    });

    it('getAutoHealPolicies returns only enabled policies after filtering', () => {
        const enabledPolicy = db.addAutoHealPolicy(makePolicy({ stack_name: 'enabled-filter-stack', enabled: 1 }));
        const disabledPolicy = db.addAutoHealPolicy(makePolicy({ stack_name: 'disabled-filter-stack', enabled: 0 }));

        const allPolicies = db.getAutoHealPolicies();
        const enabledIds = allPolicies.filter((p: any) => p.enabled === 1).map((p: any) => p.id);
        const disabledIds = allPolicies.filter((p: any) => p.enabled === 0).map((p: any) => p.id);

        expect(enabledIds).toContain(enabledPolicy.id);
        expect(disabledIds).toContain(disabledPolicy.id);
        expect(enabledIds).not.toContain(disabledPolicy.id);
    });
});
