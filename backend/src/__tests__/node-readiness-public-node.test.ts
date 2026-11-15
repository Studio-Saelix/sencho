import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';
import { toPublicNode } from '../helpers/publicNode';

/**
 * The node list carries readiness only for nodes the bootstrap registered, so
 * Fleet can tell provisional, verifying, ready and unverified apart, while a
 * node enrolled by hand or connected over the API proxy keeps the shape and
 * meaning it always had.
 */

let tmpDir: string;
let db: DatabaseService;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  db = DatabaseService.getInstance();
});

afterAll(() => cleanupTestDb(tmpDir));

function addNode(name: string, mode: 'pilot_agent' | 'proxy'): number {
  return db.addNode({ name, type: 'remote', compose_dir: '/opt/docker/sencho', is_default: false, api_url: mode === 'proxy' ? 'https://remote.example.com' : '', api_token: mode === 'proxy' ? 'secret' : '', mode });
}

describe('public node readiness', () => {
  it('is null for a manual Pilot and an API proxy node', () => {
    for (const id of [addNode('manual-pilot', 'pilot_agent'), addNode('proxy-node', 'proxy')]) {
      const node = db.getNode(id);
      if (!node) throw new Error('node missing');
      expect(toPublicNode(node).readiness).toBeNull();
    }
  });

  it('follows a bootstrapped node from provisional to its last verdict', () => {
    const id = addNode('bootstrapped', 'pilot_agent');
    db.markNodeReadinessProvisional(id, 'op-1', 'https://hub.example.com', 1000);
    const node = db.getNode(id);
    if (!node) throw new Error('node missing');
    expect(toPublicNode(node).readiness).toEqual({ state: 'provisional', checkedAt: null, operationId: 'op-1', operationState: null });
    db.markNodeReadinessVerifying(id, 'op-1', 1500);
    db.recordNodeReadinessResult(id, 'op-1', { state: 'not_ready', gatesJson: '[]', agentVersion: '1.0.0', checkedAt: 2000 });
    expect(toPublicNode(node).readiness).toMatchObject({ state: 'not_ready', checkedAt: 2000 });
    expect(JSON.stringify(toPublicNode(node))).not.toContain('gates');
  });

  it('does not report ready in the node list when the stored evidence cannot back it', () => {
    const id = addNode('corrupt-evidence', 'pilot_agent');
    db.markNodeReadinessProvisional(id, 'op-2', 'https://hub.example.com', 1000);
    db.markNodeReadinessVerifying(id, 'op-2', 1500);
    db.recordNodeReadinessResult(id, 'op-2', { state: 'ready', gatesJson: 'not json', agentVersion: '1.0.0', checkedAt: 2000 });
    const node = db.getNode(id);
    if (!node) throw new Error('node missing');
    expect(toPublicNode(node).readiness?.state).toBe('not_ready');
  });
});
