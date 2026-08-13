/**
 * BlueprintReconciler decision-logic tests.
 *
 * The reconciler's `computeDecision` is the load-bearing pure logic. Given
 * a blueprint, an actual deployment table, and a desired node set, it must
 * decide for each node whether to deploy, withdraw, drift-check, state-review,
 * or evict-block. We test that decision in isolation by accessing the
 * private method via a type-cast, mirroring the AutoHealService.shouldHeal
 * pattern.
 *
 * Local deploy / remote HTTP / actual `docker compose` invocation are not
 * exercised here; they're integration concerns covered by the manual
 * lifecycle in the plan.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import type { Blueprint, Node } from '../services/DatabaseService';
import type { ReconcileDecision } from '../services/BlueprintReconciler';

type ReconcilerWithCompute = { computeDecision: (blueprint: Blueprint, allNodes: Node[]) => ReconcileDecision };

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let BlueprintReconciler: typeof import('../services/BlueprintReconciler').BlueprintReconciler;
let NodeLabelService: typeof import('../services/NodeLabelService').NodeLabelService;
let BlueprintService: typeof import('../services/BlueprintService').BlueprintService;
let StackOpLockService: typeof import('../services/StackOpLockService').StackOpLockService;
let counter = 0;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ BlueprintReconciler } = await import('../services/BlueprintReconciler'));
    ({ NodeLabelService } = await import('../services/NodeLabelService'));
    ({ BlueprintService } = await import('../services/BlueprintService'));
    ({ StackOpLockService } = await import('../services/StackOpLockService'));
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
    const db = DatabaseService.getInstance().getDb();
    db.prepare('DELETE FROM role_assignments').run();
    db.prepare('DELETE FROM blueprint_deployments').run();
    db.prepare('DELETE FROM blueprints').run();
    db.prepare('DELETE FROM node_labels').run();
    db.prepare("DELETE FROM nodes WHERE is_default = 0").run();
    db.prepare("UPDATE global_settings SET value = '0' WHERE key = 'developer_mode'").run();
    StackOpLockService.resetForTests();
    vi.restoreAllMocks();
});

function seedNode(): number {
    counter += 1;
    const db = DatabaseService.getInstance().getDb();
    const result = db.prepare(
        `INSERT INTO nodes (name, type, mode, compose_dir, is_default, status, created_at)
         VALUES (?, 'local', 'proxy', '/tmp/compose', 0, 'online', ?)`
    ).run(`bp-test-${counter}`, Date.now());
    return result.lastInsertRowid as number;
}

function seedBlueprint(opts: {
    name?: string;
    classification?: 'stateless' | 'stateful' | 'unknown';
    drift_mode?: 'observe' | 'suggest' | 'enforce';
    nodeIds?: number[];
    revision?: number;
}) {
    counter += 1;
    const name = opts.name ?? `bp-${counter}`;
    return DatabaseService.getInstance().createBlueprint({
        name,
        description: null,
        compose_content: 'services:\n  app:\n    image: nginx\n',
        selector: { type: 'nodes', ids: opts.nodeIds ?? [] },
        drift_mode: opts.drift_mode ?? 'suggest',
        classification: opts.classification ?? 'stateless',
        classification_reasons: [],
        enabled: true,
        created_by: null,
    });
}

describe('BlueprintReconciler.computeDecision', () => {
    it('queues deploy for a stateless blueprint targeting a fresh node', () => {
        const nodeId = seedNode();
        const bp = seedBlueprint({ classification: 'stateless', nodeIds: [nodeId] });
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithCompute;
        const allNodes = DatabaseService.getInstance().getNodes();
        const decision = reconciler.computeDecision(bp, allNodes);
        expect(decision.deploy.map((n: { id: number }) => n.id)).toContain(nodeId);
        expect(decision.stateReview).toEqual([]);
    });

    it('queues state-review (not deploy) for a stateful blueprint targeting a fresh node', () => {
        const nodeId = seedNode();
        const bp = seedBlueprint({ classification: 'stateful', nodeIds: [nodeId] });
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithCompute;
        const allNodes = DatabaseService.getInstance().getNodes();
        const decision = reconciler.computeDecision(bp, allNodes);
        expect(decision.stateReview.map((n: { id: number }) => n.id)).toContain(nodeId);
        expect(decision.deploy).toEqual([]);
    });

    it('queues drift-check for an active deployment whose revision matches', () => {
        const nodeId = seedNode();
        const bp = seedBlueprint({ classification: 'stateless', nodeIds: [nodeId] });
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id,
            node_id: nodeId,
            status: 'active',
            applied_revision: bp.revision,
        });
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithCompute;
        const allNodes = DatabaseService.getInstance().getNodes();
        const decision = reconciler.computeDecision(bp, allNodes);
        expect(decision.check.map((n: { id: number }) => n.id)).toContain(nodeId);
        expect(decision.deploy).toEqual([]);
    });

    it('queues redeploy when the blueprint revision moved past the deployed revision', () => {
        const nodeId = seedNode();
        const bp = seedBlueprint({ classification: 'stateless', nodeIds: [nodeId] });
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id,
            node_id: nodeId,
            status: 'active',
            applied_revision: bp.revision - 1,
        });
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithCompute;
        const allNodes = DatabaseService.getInstance().getNodes();
        const decision = reconciler.computeDecision(bp, allNodes);
        expect(decision.deploy.map((n: { id: number }) => n.id)).toContain(nodeId);
    });

    it('queues state-review when a stateful deployment revision moves', () => {
        const nodeId = seedNode();
        const bp = seedBlueprint({ classification: 'stateful', nodeIds: [nodeId] });
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id,
            node_id: nodeId,
            status: 'active',
            applied_revision: bp.revision - 1,
        });
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithCompute;
        const allNodes = DatabaseService.getInstance().getNodes();
        const decision = reconciler.computeDecision(bp, allNodes);
        expect(decision.stateReview.map((n: { id: number }) => n.id)).toContain(nodeId);
        expect(decision.deploy).toEqual([]);
    });

    it('queues stateless eviction when a node leaves the selector', () => {
        const nodeId = seedNode();
        const bp = seedBlueprint({ classification: 'stateless', nodeIds: [] });
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id,
            node_id: nodeId,
            status: 'active',
            applied_revision: bp.revision,
        });
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithCompute;
        const allNodes = DatabaseService.getInstance().getNodes();
        const decision = reconciler.computeDecision(bp, allNodes);
        expect(decision.withdraw.map((n: { id: number }) => n.id)).toContain(nodeId);
        expect(decision.evictBlocked).toEqual([]);
    });

    it('queues evict_blocked (not auto-withdraw) when a STATEFUL deployment leaves the selector', () => {
        const nodeId = seedNode();
        const bp = seedBlueprint({ classification: 'stateful', nodeIds: [] });
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id,
            node_id: nodeId,
            status: 'active',
            applied_revision: bp.revision,
        });
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithCompute;
        const allNodes = DatabaseService.getInstance().getNodes();
        const decision = reconciler.computeDecision(bp, allNodes);
        expect(decision.evictBlocked.map((n: { id: number }) => n.id)).toContain(nodeId);
        expect(decision.withdraw).toEqual([]);
    });

    it('skips deployments already in pending_state_review or evict_blocked or name_conflict', () => {
        const nodeA = seedNode();
        const nodeB = seedNode();
        const nodeC = seedNode();
        const bp = seedBlueprint({ classification: 'stateless', nodeIds: [nodeA, nodeB, nodeC] });
        DatabaseService.getInstance().upsertDeployment({ blueprint_id: bp.id, node_id: nodeA, status: 'pending_state_review' });
        DatabaseService.getInstance().upsertDeployment({ blueprint_id: bp.id, node_id: nodeB, status: 'evict_blocked' });
        DatabaseService.getInstance().upsertDeployment({ blueprint_id: bp.id, node_id: nodeC, status: 'name_conflict' });
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithCompute;
        const allNodes = DatabaseService.getInstance().getNodes();
        const decision = reconciler.computeDecision(bp, allNodes);
        expect(decision.deploy).toEqual([]);
        expect(decision.check).toEqual([]);
        expect(decision.withdraw).toEqual([]);
    });

    it('skips new placements onto cordoned nodes (cordon filter)', () => {
        const nodeId = seedNode();
        DatabaseService.getInstance().setNodeCordoned(nodeId, true, 'maintenance');
        const bp = seedBlueprint({ classification: 'stateless', nodeIds: [nodeId] });
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithCompute;
        const allNodes = DatabaseService.getInstance().getNodes();
        const decision = reconciler.computeDecision(bp, allNodes);
        expect(decision.deploy).toEqual([]);
        expect(decision.stateReview).toEqual([]);
    });

    it('skips state-review for stateful blueprints landing on cordoned nodes', () => {
        const nodeId = seedNode();
        DatabaseService.getInstance().setNodeCordoned(nodeId, true, null);
        const bp = seedBlueprint({ classification: 'stateful', nodeIds: [nodeId] });
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithCompute;
        const allNodes = DatabaseService.getInstance().getNodes();
        const decision = reconciler.computeDecision(bp, allNodes);
        expect(decision.stateReview).toEqual([]);
        expect(decision.deploy).toEqual([]);
    });

    it('still redeploys for revision drift on a cordoned node (existing deployment, not a new placement)', () => {
        const nodeId = seedNode();
        DatabaseService.getInstance().setNodeCordoned(nodeId, true, null);
        const bp = seedBlueprint({ classification: 'stateless', nodeIds: [nodeId] });
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id,
            node_id: nodeId,
            status: 'active',
            applied_revision: bp.revision - 1,
        });
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithCompute;
        const allNodes = DatabaseService.getInstance().getNodes();
        const decision = reconciler.computeDecision(bp, allNodes);
        expect(decision.deploy.map((n: { id: number }) => n.id)).toContain(nodeId);
    });

    it('still drift-checks active deployments on a cordoned node', () => {
        const nodeId = seedNode();
        DatabaseService.getInstance().setNodeCordoned(nodeId, true, null);
        const bp = seedBlueprint({ classification: 'stateless', nodeIds: [nodeId] });
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id,
            node_id: nodeId,
            status: 'active',
            applied_revision: bp.revision,
        });
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithCompute;
        const allNodes = DatabaseService.getInstance().getNodes();
        const decision = reconciler.computeDecision(bp, allNodes);
        expect(decision.check.map((n: { id: number }) => n.id)).toContain(nodeId);
    });

    it('honors pin override: desired set is exactly the pinned node, regardless of selector', () => {
        const nodeA = seedNode();
        const nodeB = seedNode();
        const bp = seedBlueprint({ classification: 'stateless', nodeIds: [nodeA] });
        DatabaseService.getInstance().setBlueprintPinnedNode(bp.id, nodeB);
        const refreshed = DatabaseService.getInstance().getBlueprint(bp.id)!;
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithCompute;
        const allNodes = DatabaseService.getInstance().getNodes();
        const decision = reconciler.computeDecision(refreshed, allNodes);
        expect(decision.deploy.map((n: { id: number }) => n.id)).toContain(nodeB);
        expect(decision.deploy.map((n: { id: number }) => n.id)).not.toContain(nodeA);
    });

    it('pin overrides cordon: pinned blueprint deploys onto a cordoned node', () => {
        const nodeId = seedNode();
        DatabaseService.getInstance().setNodeCordoned(nodeId, true, null);
        const bp = seedBlueprint({ classification: 'stateless', nodeIds: [] });
        DatabaseService.getInstance().setBlueprintPinnedNode(bp.id, nodeId);
        const refreshed = DatabaseService.getInstance().getBlueprint(bp.id)!;
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithCompute;
        const allNodes = DatabaseService.getInstance().getNodes();
        const decision = reconciler.computeDecision(refreshed, allNodes);
        expect(decision.deploy.map((n: { id: number }) => n.id)).toContain(nodeId);
    });

    it('pin to a non-existent node yields an empty desired set', () => {
        const bp = seedBlueprint({ classification: 'stateless', nodeIds: [] });
        DatabaseService.getInstance().setBlueprintPinnedNode(bp.id, 999_999);
        const refreshed = DatabaseService.getInstance().getBlueprint(bp.id)!;
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithCompute;
        const allNodes = DatabaseService.getInstance().getNodes();
        const decision = reconciler.computeDecision(refreshed, allNodes);
        expect(decision.deploy).toEqual([]);
        expect(decision.stateReview).toEqual([]);
    });

    it('pin shrinks the desired set: stateless deployments on non-pinned nodes are queued for withdraw', () => {
        const nodeA = seedNode();
        const nodeB = seedNode();
        const bp = seedBlueprint({ classification: 'stateless', nodeIds: [nodeA, nodeB] });
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id, node_id: nodeA, status: 'active', applied_revision: bp.revision,
        });
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id, node_id: nodeB, status: 'active', applied_revision: bp.revision,
        });
        DatabaseService.getInstance().setBlueprintPinnedNode(bp.id, nodeA);
        const refreshed = DatabaseService.getInstance().getBlueprint(bp.id)!;
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithCompute;
        const allNodes = DatabaseService.getInstance().getNodes();
        const decision = reconciler.computeDecision(refreshed, allNodes);
        expect(decision.check.map((n: { id: number }) => n.id)).toContain(nodeA);
        expect(decision.withdraw.map((n: { id: number }) => n.id)).toContain(nodeB);
        expect(decision.evictBlocked).toEqual([]);
    });

    it('pin shrinks the desired set: stateful deployments on non-pinned nodes are queued for evict_blocked', () => {
        const nodeA = seedNode();
        const nodeB = seedNode();
        const bp = seedBlueprint({ classification: 'stateful', nodeIds: [nodeA, nodeB] });
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id, node_id: nodeA, status: 'active', applied_revision: bp.revision,
        });
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id, node_id: nodeB, status: 'active', applied_revision: bp.revision,
        });
        DatabaseService.getInstance().setBlueprintPinnedNode(bp.id, nodeA);
        const refreshed = DatabaseService.getInstance().getBlueprint(bp.id)!;
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithCompute;
        const allNodes = DatabaseService.getInstance().getNodes();
        const decision = reconciler.computeDecision(refreshed, allNodes);
        expect(decision.evictBlocked.map((n: { id: number }) => n.id)).toContain(nodeB);
        expect(decision.withdraw).toEqual([]);
    });

    it('deleting the pinned node clears the pin from the blueprint', () => {
        const nodeId = seedNode();
        const bp = seedBlueprint({ classification: 'stateless', nodeIds: [] });
        DatabaseService.getInstance().setBlueprintPinnedNode(bp.id, nodeId);
        expect(DatabaseService.getInstance().getBlueprint(bp.id)!.pinned_node_id).toBe(nodeId);
        DatabaseService.getInstance().deleteNode(nodeId);
        expect(DatabaseService.getInstance().getBlueprint(bp.id)!.pinned_node_id).toBeNull();
    });

    it('clearing the pin restores selector behavior on the next tick', () => {
        const nodeA = seedNode();
        const nodeB = seedNode();
        const bp = seedBlueprint({ classification: 'stateless', nodeIds: [nodeA] });
        DatabaseService.getInstance().setBlueprintPinnedNode(bp.id, nodeB);
        DatabaseService.getInstance().setBlueprintPinnedNode(bp.id, null);
        const refreshed = DatabaseService.getInstance().getBlueprint(bp.id)!;
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithCompute;
        const allNodes = DatabaseService.getInstance().getNodes();
        const decision = reconciler.computeDecision(refreshed, allNodes);
        expect(decision.deploy.map((n: { id: number }) => n.id)).toContain(nodeA);
        expect(decision.deploy.map((n: { id: number }) => n.id)).not.toContain(nodeB);
    });

    it('matches via labels selector and respects label changes', () => {
        const nodeA = seedNode();
        const nodeB = seedNode();
        NodeLabelService.getInstance().addLabel(nodeA, 'prod');
        NodeLabelService.getInstance().addLabel(nodeB, 'staging');
        const bp = DatabaseService.getInstance().createBlueprint({
            name: 'caddy-via-labels',
            description: null,
            compose_content: 'services:\n  caddy:\n    image: caddy\n',
            selector: { type: 'labels', any: ['prod'], all: [] },
            drift_mode: 'suggest',
            classification: 'stateless',
            classification_reasons: [],
            enabled: true,
            created_by: null,
        });
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithCompute;
        const allNodes = DatabaseService.getInstance().getNodes();
        const decision = reconciler.computeDecision(bp, allNodes);
        expect(decision.deploy.map((n: { id: number }) => n.id)).toContain(nodeA);
        expect(decision.deploy.map((n: { id: number }) => n.id)).not.toContain(nodeB);
    });
});

describe('BlueprintReconciler developer-mode diagnostics', () => {
    it('does not emit diagnostic logs when developer mode is off', async () => {
        const nodeId = seedNode();
        const bp = seedBlueprint({ classification: 'stateful', nodeIds: [nodeId] });
        const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

        await BlueprintReconciler.getInstance().reconcileOne(bp.id);

        expect(infoSpy.mock.calls.some(([message]) => String(message).includes('[BlueprintReconciler:diag]'))).toBe(false);
    });

    it('emits diagnostic decision logs when developer mode is on', async () => {
        DatabaseService.getInstance().updateGlobalSetting('developer_mode', '1');
        const nodeId = seedNode();
        const bp = seedBlueprint({ classification: 'stateful', nodeIds: [nodeId] });
        const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

        await BlueprintReconciler.getInstance().reconcileOne(bp.id);

        expect(infoSpy.mock.calls.some(([message]) => String(message).includes('[BlueprintReconciler:diag]'))).toBe(true);
    });
});

describe('BlueprintService per-stack lock', () => {
    it('deploy under a free lock writes compose, cleans siblings, deploys, then writes the marker', async () => {
        const nodeId = seedNode();
        const bp = seedBlueprint({ classification: 'stateless', nodeIds: [nodeId] });
        const node = DatabaseService.getInstance().getNode(nodeId)!;
        const { FileSystemService } = await import('../services/FileSystemService');
        const { ComposeService } = await import('../services/ComposeService');
        // Spy the file/deploy primitives so the locked critical section runs
        // without touching the real filesystem or Docker.
        vi.spyOn(FileSystemService.prototype, 'createStack').mockResolvedValue(undefined);
        const writeSpy = vi.spyOn(FileSystemService.prototype, 'writeStackFile').mockResolvedValue(undefined);
        const cleanupSpy = vi.spyOn(FileSystemService.prototype, 'removeAlternateRootComposeFiles').mockResolvedValue(undefined);
        const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack').mockResolvedValue({ recoveryId: null });

        const outcome = await BlueprintService.getInstance().deployToNode(bp, node);

        expect(outcome.status).toBe('active');
        expect(deploySpy).toHaveBeenCalledWith(bp.name, undefined, false, {
            source: 'blueprint',
            actor: 'system:blueprint',
        });
        // Compose is written first; the marker is deferred until after sibling cleanup and deploy.
        expect(writeSpy).toHaveBeenCalledTimes(2);
        expect(writeSpy.mock.calls[0][1]).toBe('compose.yaml');
        expect(writeSpy.mock.calls[0][2]).toBe(bp.compose_content);
        expect(writeSpy.mock.calls[1][1]).toBe('.blueprint.json');
        expect(writeSpy.mock.calls[1][2]).toContain('"blueprintId"');
        expect(cleanupSpy).toHaveBeenCalledWith(bp.name);
        const [composeOrder, markerOrder] = writeSpy.mock.invocationCallOrder;
        const [cleanupOrder] = cleanupSpy.mock.invocationCallOrder;
        const [deployOrder] = deploySpy.mock.invocationCallOrder;
        expect(composeOrder).toBeLessThan(cleanupOrder);
        expect(cleanupOrder).toBeLessThan(deployOrder);
        expect(deployOrder).toBeLessThan(markerOrder);
    });

    it('deploy skips, writes no stack files, and records failed when the stack lock is held', async () => {
        const nodeId = seedNode();
        const bp = seedBlueprint({ classification: 'stateless', nodeIds: [nodeId] });
        const node = DatabaseService.getInstance().getNode(nodeId)!;
        // A manual operation holds the lock; the reconcile deploy must not race
        // it, and must not mutate compose/marker files before owning the lock.
        StackOpLockService.getInstance().tryAcquire(nodeId, bp.name, 'update', 'admin');

        const outcome = await BlueprintService.getInstance().deployToNode(bp, node);

        expect(outcome.status).toBe('failed');
        expect(outcome.error).toContain('already in progress');
        // No marker file was written (the lock guards the file writes too).
        expect(await BlueprintService.getInstance().readMarker(bp.name, node)).toBeNull();
        // The manual op still holds the lock; the deploy never acquired it.
        expect(StackOpLockService.getInstance().get(nodeId, bp.name)?.action).toBe('update');
    });

    it('withdraw skips and records failed when a manual operation holds the stack lock', async () => {
        const nodeId = seedNode();
        const bp = seedBlueprint({ classification: 'stateless', nodeIds: [nodeId] });
        const node = DatabaseService.getInstance().getNode(nodeId)!;
        // A manual operation holds the lock; the withdraw must not race it.
        StackOpLockService.getInstance().tryAcquire(nodeId, bp.name, 'update', 'admin');

        const outcome = await BlueprintService.getInstance().withdrawFromNode(bp, node);

        expect(outcome.status).toBe('failed');
        expect(outcome.error).toContain('already in progress');
        // The lock is still held by the manual op (the withdraw never acquired it).
        expect(StackOpLockService.getInstance().get(nodeId, bp.name)?.action).toBe('update');
    });
});

describe('BlueprintService local withdraw clears stack-scoped role assignments', () => {
    function hasAssignment(userId: number, resourceType: string, resourceId: string): boolean {
        return DatabaseService.getInstance().getAllRoleAssignments(userId)
            .some((a) => a.resource_type === resourceType && a.resource_id === resourceId);
    }

    async function arrangeLocalWithdraw() {
        const db = DatabaseService.getInstance();
        const composeDir = process.env.COMPOSE_DIR!;
        const nodeId = seedNode();
        db.getDb().prepare('UPDATE nodes SET compose_dir = ? WHERE id = ?').run(composeDir, nodeId);

        const bp = seedBlueprint({ name: `rbac-wd-${counter}`, classification: 'stateless', nodeIds: [nodeId] });
        const node = db.getNode(nodeId)!;
        db.upsertDeployment({
            blueprint_id: bp.id,
            node_id: nodeId,
            status: 'active',
            applied_revision: bp.revision,
        });

        const hash = await bcrypt.hash('password123', 1);
        const userId = db.addUser({ username: `bp-rbac-${counter}`, password_hash: hash, role: 'viewer' });
        const otherNodeId = seedNode();
        db.addRoleAssignment({
            user_id: userId, role: 'deployer', resource_type: 'stack', resource_id: bp.name, node_id: nodeId,
        });
        db.addRoleAssignment({
            user_id: userId, role: 'deployer', resource_type: 'stack', resource_id: 'other-stack', node_id: nodeId,
        });
        db.addRoleAssignment({
            user_id: userId, role: 'deployer', resource_type: 'node', resource_id: String(otherNodeId),
        });

        // Matching on-disk marker so ownership passes; FS/down are stubbed.
        const fs = await import('fs');
        const path = await import('path');
        const stackDir = path.join(composeDir, bp.name);
        fs.mkdirSync(stackDir, { recursive: true });
        fs.writeFileSync(
            path.join(stackDir, '.blueprint.json'),
            JSON.stringify({ blueprintId: bp.id, revision: bp.revision, lastApplied: Date.now() }),
        );
        const { ComposeService } = await import('../services/ComposeService');
        const { FileSystemService } = await import('../services/FileSystemService');
        const downStackSpy = vi.spyOn(ComposeService.prototype, 'downStack').mockResolvedValue(undefined);
        const deleteStackSpy = vi.spyOn(FileSystemService.prototype, 'deleteStack').mockResolvedValue(undefined);

        return { bp, node, nodeId, userId, downStackSpy, deleteStackSpy, db };
    }

    it('clears the target assignment after successful filesystem deletion and preserves unrelated grants', async () => {
        const { bp, node, userId, downStackSpy, deleteStackSpy, db } = await arrangeLocalWithdraw();

        const outcome = await BlueprintService.getInstance().withdrawFromNode(bp, node);

        expect(outcome.status).toBe('withdrawn');
        expect(downStackSpy).toHaveBeenCalledWith(bp.name, { removeVolumes: false });
        expect(deleteStackSpy).toHaveBeenCalledWith(bp.name);
        expect(db.getDeployment(bp.id, node.id)).toBeUndefined();
        expect(hasAssignment(userId, 'stack', bp.name)).toBe(false);
        expect(hasAssignment(userId, 'stack', 'other-stack')).toBe(true);
        expect(db.getAllRoleAssignments(userId).some((a) => a.resource_type === 'node')).toBe(true);
        db.deleteUser(userId);
    });

    it('clears the target assignment when the stack directory is already absent', async () => {
        const { bp, node, userId, deleteStackSpy, db } = await arrangeLocalWithdraw();
        const fs = await import('fs');
        const path = await import('path');
        fs.rmSync(path.join(process.env.COMPOSE_DIR!, bp.name), { recursive: true, force: true });

        const outcome = await BlueprintService.getInstance().withdrawFromNode(bp, node);

        expect(outcome.status).toBe('withdrawn');
        expect(deleteStackSpy).not.toHaveBeenCalled();
        expect(hasAssignment(userId, 'stack', bp.name)).toBe(false);
        expect(db.getAllRoleAssignments(userId)).toHaveLength(2);
        db.deleteUser(userId);
    });

    it('preserves the grant when filesystem deletion fails with a non-ENOENT error', async () => {
        const { bp, node, nodeId, userId, deleteStackSpy, db } = await arrangeLocalWithdraw();
        const fsErr = Object.assign(new Error('permission denied'), { code: 'EACCES' });
        deleteStackSpy.mockRejectedValue(fsErr);
        const rbacSpy = vi.spyOn(db, 'deleteRoleAssignmentsByStack');

        try {
            const outcome = await BlueprintService.getInstance().withdrawFromNode(bp, node);

            expect(outcome.status).toBe('failed');
            expect(rbacSpy).not.toHaveBeenCalled();
            expect(db.getDeployment(bp.id, nodeId)?.status).toBe('failed');
            expect(hasAssignment(userId, 'stack', bp.name)).toBe(true);
        } finally {
            rbacSpy.mockRestore();
            db.deleteUser(userId);
        }
    });

    it('fails withdraw and keeps the deployment when role-assignment cleanup throws', async () => {
        const { bp, node, nodeId, userId, db } = await arrangeLocalWithdraw();
        const rbacSpy = vi.spyOn(db, 'deleteRoleAssignmentsByStack')
            .mockImplementation(() => { throw new Error('simulated rbac cleanup failure'); });
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            const outcome = await BlueprintService.getInstance().withdrawFromNode(bp, node);

            expect(outcome.status).toBe('failed');
            expect(db.getDeployment(bp.id, nodeId)).toBeDefined();
            expect(db.getDeployment(bp.id, nodeId)?.status).toBe('failed');
            expect(errorSpy.mock.calls.some((args) =>
                typeof args[0] === 'string' && args[0].includes('Secondary DB cleanup failed'),
            )).toBe(true);
            expect(hasAssignment(userId, 'stack', bp.name)).toBe(true);
        } finally {
            rbacSpy.mockRestore();
            errorSpy.mockRestore();
            db.deleteUser(userId);
        }
    });
});

describe('BlueprintService marker parsing + name-conflict guard', () => {
    it('parseMarker accepts a well-formed marker', () => {
        const marker = BlueprintService.parseMarker(JSON.stringify({ blueprintId: 7, revision: 3, lastApplied: 12345 }));
        expect(marker).toEqual({ blueprintId: 7, revision: 3, lastApplied: 12345 });
    });

    it('parseMarker rejects an invalid marker', () => {
        expect(BlueprintService.parseMarker('not json')).toBeNull();
        expect(BlueprintService.parseMarker(JSON.stringify({ revision: 1 }))).toBeNull();
        expect(BlueprintService.parseMarker(JSON.stringify({ blueprintId: 'nope', revision: 1 }))).toBeNull();
    });
});

describe('BlueprintReconciler drift alert node wording', () => {
    type ReconcilerWithDrift = {
        handleDrift: (blueprint: Blueprint, node: Node, reason: string) => Promise<void>;
    };

    function seedRemoteNode(name: string): number {
        counter += 1;
        const db = DatabaseService.getInstance().getDb();
        const result = db.prepare(
            `INSERT INTO nodes (name, type, mode, compose_dir, is_default, status, created_at)
             VALUES (?, 'remote', 'proxy', '/tmp/compose', 0, 'online', ?)`
        ).run(name, Date.now());
        return result.lastInsertRowid as number;
    }

    it('suggest-mode local drift uses on this node', async () => {
        const { NotificationService } = await import('../services/NotificationService');
        const dispatchSpy = vi.spyOn(NotificationService.getInstance(), 'dispatchAlert').mockResolvedValue({ persisted: true });
        const nodeId = seedNode();
        const bp = seedBlueprint({ name: 'drift-local', drift_mode: 'suggest', nodeIds: [nodeId] });
        const node = DatabaseService.getInstance().getNode(nodeId)!;
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithDrift;

        await reconciler.handleDrift(bp, node, 'compose changed');

        expect(dispatchSpy).toHaveBeenCalledWith(
            'warning',
            'blueprint_drift_detected',
            'Blueprint "drift-local" drifted on this node: compose changed',
            { stackName: 'drift-local', actor: 'system:blueprint' },
        );
    });

    it('suggest-mode remote drift keeps the authoritative node name', async () => {
        const { NotificationService } = await import('../services/NotificationService');
        const dispatchSpy = vi.spyOn(NotificationService.getInstance(), 'dispatchAlert').mockResolvedValue({ persisted: true });
        const nodeId = seedRemoteNode('sencho-test-02');
        const bp = seedBlueprint({ name: 'drift-remote', drift_mode: 'suggest', nodeIds: [nodeId] });
        const node = DatabaseService.getInstance().getNode(nodeId)!;
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithDrift;

        await reconciler.handleDrift(bp, node, 'compose changed');

        expect(dispatchSpy).toHaveBeenCalledWith(
            'warning',
            'blueprint_drift_detected',
            'Blueprint "drift-remote" drifted on node "sencho-test-02": compose changed',
            { stackName: 'drift-remote', actor: 'system:blueprint' },
        );
    });

    it('stateful marker-loss on local uses on this node', async () => {
        const { NotificationService } = await import('../services/NotificationService');
        const dispatchSpy = vi.spyOn(NotificationService.getInstance(), 'dispatchAlert').mockResolvedValue({ persisted: true });
        vi.spyOn(BlueprintService.getInstance(), 'readMarker').mockResolvedValue(null);
        const nodeId = seedNode();
        const bp = seedBlueprint({
            name: 'marker-local',
            drift_mode: 'enforce',
            classification: 'stateful',
            nodeIds: [nodeId],
        });
        const node = DatabaseService.getInstance().getNode(nodeId)!;
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithDrift;

        await reconciler.handleDrift(bp, node, 'volumes diverged');

        expect(dispatchSpy).toHaveBeenCalledWith(
            'warning',
            'blueprint_drift_detected',
            'Blueprint "marker-local" lost its marker on this node; auto-fix declined to avoid stomping unowned data. Reason: volumes diverged',
            { stackName: 'marker-local', actor: 'system:blueprint' },
        );
    });

    it('enforce correction-failure on local uses on this node', async () => {
        const { NotificationService } = await import('../services/NotificationService');
        const dispatchSpy = vi.spyOn(NotificationService.getInstance(), 'dispatchAlert').mockResolvedValue({ persisted: true });
        vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({
            status: 'failed',
            error: 'compose up failed',
        } as Awaited<ReturnType<typeof BlueprintService.prototype.deployToNode>>);
        const nodeId = seedNode();
        const bp = seedBlueprint({
            name: 'fix-local',
            drift_mode: 'enforce',
            classification: 'stateless',
            nodeIds: [nodeId],
        });
        const node = DatabaseService.getInstance().getNode(nodeId)!;
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithDrift;

        await reconciler.handleDrift(bp, node, 'compose changed');

        expect(dispatchSpy).toHaveBeenCalledWith(
            'error',
            'blueprint_drift_correction_failed',
            'Auto-fix for "fix-local" on this node failed: compose up failed',
            { stackName: 'fix-local', actor: 'system:blueprint' },
        );
    });
});
