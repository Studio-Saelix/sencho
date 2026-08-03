/**
 * Deployed-stack deletion: ready transaction retires both recovery models;
 * blocking intents gate same-name create.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import path from 'path';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import type {
  StackUpdateRecoveryGenerationRow,
  ServiceUpdateRecoveryRow,
  StackUpdateCleanupPendingRow,
} from '../services/DatabaseService';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let DeployedStackDeletionService: typeof import('../services/DeployedStackDeletionService').DeployedStackDeletionService;
let overrideDeletionContainmentBase: typeof import('../services/DeployedStackDeletionService').overrideDeletionContainmentBase;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ DeployedStackDeletionService, overrideDeletionContainmentBase } = await import('../services/DeployedStackDeletionService'));
});

afterAll(() => cleanupTestDb(tmpDir));

function db() {
  return DatabaseService.getInstance();
}

beforeEach(() => {
  const raw = (db() as unknown as { db: { prepare: (s: string) => { run: () => void } } }).db;
  raw.prepare('DELETE FROM stack_update_recovery_generations').run();
  raw.prepare('DELETE FROM service_update_recovery').run();
  raw.prepare('DELETE FROM stack_update_cleanup_pending').run();
});

const NODE = 1;

describe('DeployedStackDeletionService ready transaction', () => {
  it('commitStackDeletionReadyTransaction deletes full-stack and service recovery rows', () => {
    const now = Date.now();
    const stackName = 'del-stack';
    const gen: StackUpdateRecoveryGenerationRow = {
      id: randomUUID(),
      node_id: NODE,
      stack_name: stackName,
      status: 'active',
      phase: 'immediate_verified',
      is_current: 1,
      backup_slot_id: null,
      override_path: null,
      services_json: '[]',
      health_gate_id: null,
      gate_retain_until: null,
      artifact_expires_at: null,
      operation_lease_expires_at: null,
      created_at: now,
      updated_at: now,
      created_by: null,
      artifacts_retired: 0,
      released_at: null,
      released_by: null,
    };
    db().insertStackUpdateRecoveryGeneration(gen);
    const svc: ServiceUpdateRecoveryRow = {
      id: randomUUID(),
      node_id: NODE,
      stack_name: stackName,
      service_name: 'web',
      replicas_json: '[]',
      majority_image_id: 'sha256:abc',
      declared_image_ref: 'nginx:latest',
      weak_floating_tag: 0,
      health_gate_id: null,
      status: 'active',
      expires_at: now + 60_000,
      claim_expires_at: null,
      created_at: now,
      created_by: null,
    };
    db().insertServiceUpdateRecovery(svc);
    const intentId = randomUUID();
    const intent: StackUpdateCleanupPendingRow = {
      id: intentId,
      node_id: NODE,
      stack_name: stackName,
      status: 'prepared',
      target_kind: 'local_socket',
      rollback_tags_json: '[]',
      override_paths_json: '[]',
      prune_volumes_requested: 0,
      required_blueprint_id: null,
      created_at: now,
      updated_at: now,
    };
    db().insertCleanupPending(intent);

    expect(db().commitStackDeletionReadyTransaction(intentId, NODE, stackName)).toBe(true);
    expect(db().listStackUpdateRecoveryForStack(NODE, stackName)).toHaveLength(0);
    expect(db().listActiveServiceUpdateRecoveries(NODE, stackName, 'web')).toHaveLength(0);
    expect(db().getCleanupPending(intentId)?.status).toBe('ready');
  });

  it('hasBlockingDeletionIntent is true for prepared intents', () => {
    const now = Date.now();
    db().insertCleanupPending({
      id: randomUUID(),
      node_id: NODE,
      stack_name: 'blocked',
      status: 'prepared',
      target_kind: 'local_socket',
      rollback_tags_json: '[]',
      override_paths_json: '[]',
      prune_volumes_requested: 0,
      required_blueprint_id: null,
      created_at: now,
      updated_at: now,
    });
    expect(db().hasBlockingDeletionIntent(NODE, 'blocked')).toBe(true);
    expect(db().hasBlockingDeletionIntent(NODE, 'other')).toBe(false);
  });

  it('assertNoBlockingDeletionIntent throws for prepared stacks', () => {
    const now = Date.now();
    db().insertCleanupPending({
      id: randomUUID(),
      node_id: NODE,
      stack_name: 'prep',
      status: 'prepared',
      target_kind: 'local_socket',
      rollback_tags_json: '[]',
      override_paths_json: '[]',
      prune_volumes_requested: 0,
      required_blueprint_id: null,
      created_at: now,
      updated_at: now,
    });
    expect(() => {
      DeployedStackDeletionService.getInstance().assertNoBlockingDeletionIntent(NODE, 'prep');
    }).toThrow(/deletion in progress/i);
  });
});

describe('overrideDeletionContainmentBase', () => {
  it('confines stack-scoped intents to the stack directory', () => {
    expect(overrideDeletionContainmentBase('/app/compose', 'my-stack')).toBe(
      path.resolve('/app/compose', 'my-stack'),
    );
    expect(overrideDeletionContainmentBase('/app/compose', null)).toBe(
      path.resolve('/app/compose'),
    );
  });

  it('rejects invalid stack names that could traverse', () => {
    expect(overrideDeletionContainmentBase('/app/compose', '../other')).toBeNull();
    expect(overrideDeletionContainmentBase('/app/compose', 'bad/name')).toBeNull();
  });
});

describe('DeployedStackDeletionService blueprint ownership probe', () => {
  it('returns failed (not name_conflict) when marker read fails with non-ENOENT I/O', async () => {
    const { promises: fsPromises } = await import('fs');
    const { vi } = await import('vitest');
    const composeDir = process.env.COMPOSE_DIR!;
    const stackName = `del-probe-${Date.now()}`;
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n');
    await fsPromises.writeFile(
      path.join(stackDir, '.blueprint.json'),
      JSON.stringify({ blueprintId: 7, revision: 1, lastApplied: 0 }),
    );

    const accessErr = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    const readSpy = vi.spyOn(fsPromises, 'readFile').mockRejectedValueOnce(accessErr);

    const result = await DeployedStackDeletionService.getInstance().deleteDeployedStack({
      nodeId: NODE,
      stackName,
      pruneVolumes: false,
      actor: 'test',
      requireBlueprintId: 7,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('failed');
      expect(result.error).toMatch(/EACCES|Failed to read|permission/i);
    }
    expect(readSpy).toHaveBeenCalled();
    readSpy.mockRestore();
    await fsPromises.rm(stackDir, { recursive: true, force: true });
  });
});

