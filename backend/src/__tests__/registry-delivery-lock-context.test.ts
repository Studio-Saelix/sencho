import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb } from './helpers/setupTestDb';
import { StackOpLockService } from '../services/StackOpLockService';
import { RegistryDeliveryService } from '../services/RegistryDeliveryService';
import { NodeRegistry } from '../services/NodeRegistry';
import { resolveRegistryAuthAtSeam } from '../helpers/registryDeliverySeam';
import { hashActionSet, hashProjectSource } from '../helpers/registryDeliveryHashes';
import fs from 'fs';
import path from 'path';

describe('registry delivery stack lock context', () => {
  beforeEach(async () => {
    await setupTestDb();
    StackOpLockService.resetForTests();
    RegistryDeliveryService.resetForTests();
  });

  it('stores lock context on tryAcquire and clears it on release', () => {
    const locks = StackOpLockService.getInstance();
    const acquired = locks.tryAcquire(1, 'ctx-stack', 'deploy', 'admin', {
      opId: 'op-123',
      kind: 'stack-deploy',
    });
    expect(acquired.acquired).toBe(true);
    expect(locks.get(1, 'ctx-stack')?.context).toEqual({
      opId: 'op-123',
      kind: 'stack-deploy',
    });
    locks.release(1, 'ctx-stack');
    expect(locks.get(1, 'ctx-stack')).toBeUndefined();
  });

  it('rejects seam when held lock context does not match attestation', async () => {
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const stackName = 'ctx-seam-stack';
    const stackDir = path.join(process.env.COMPOSE_DIR!, stackName);
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n');

    const delivery = RegistryDeliveryService.getInstance();
    const sourceHash = hashProjectSource(stackDir);
    const attestation = delivery.signAttestation({
      nodeIdClaim: nodeId,
      stack: stackName,
      op: 'stack-deploy',
      sourceHash,
      referencedHostsHash: delivery.hashHostList([]),
      coveredHostsHash: delivery.hashHostList([]),
      actionSetHash: hashActionSet(['stack:deploy']),
    });

    StackOpLockService.getInstance().tryAcquire(nodeId, stackName, 'deploy', 'admin', {
      opId: 'wrong-op',
      kind: 'stack-deploy',
    });

    await expect(resolveRegistryAuthAtSeam({
      envelope: {
        attestation,
        auths: [],
        notAfter: Date.now() + 60_000,
        deliverySourceId: delivery.getDeliverySourceId(),
      },
      nodeId,
      stack: stackName,
      stage: 'stack-deploy',
    })).rejects.toThrow(/lock context mismatch/i);

    StackOpLockService.getInstance().release(nodeId, stackName);
  });
});
