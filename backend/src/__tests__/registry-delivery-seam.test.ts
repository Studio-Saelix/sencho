import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import { setupTestDb } from './helpers/setupTestDb';
import { RegistryDeliveryService } from '../services/RegistryDeliveryService';
import { NodeRegistry } from '../services/NodeRegistry';
import { StackOpLockService } from '../services/StackOpLockService';
import { resolveRegistryAuthAtSeam } from '../helpers/registryDeliverySeam';
import { hashActionSet, hashProjectSource } from '../helpers/registryDeliveryHashes';
import { discoverRegistryReferences } from '../services/registryReferenceDiscovery';
import { normalizeImageHost } from '../services/RegistryService';

function acquireLockForAttestation(
  nodeId: number,
  stack: string,
  attestation: string,
  stage: string,
): void {
  const payload = jwt.decode(attestation) as jwt.JwtPayload;
  StackOpLockService.getInstance().tryAcquire(nodeId, stack, 'deploy', 'admin', {
    opId: String(payload.jti_t),
    kind: stage,
  });
}

describe('registryDeliverySeam', () => {
  beforeEach(async () => {
    await setupTestDb();
    RegistryDeliveryService.resetForTests();
    StackOpLockService.resetForTests();
  });

  it('merges delivered credentials for target-missing hosts at the seam', async () => {
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const stackName = 'regcred-test';
    const composeDir = NodeRegistry.getInstance().getComposeDir(nodeId);
    const stackDir = path.join(composeDir, stackName);
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(
      path.join(stackDir, 'compose.yaml'),
      'services:\n  app:\n    image: ghcr.io/example/private/app:latest\n',
    );

    const sourceHash = hashProjectSource(stackDir);
    const referencedHosts = discoverRegistryReferences(stackDir).referencedHosts;
    const delivery = RegistryDeliveryService.getInstance();
    const attestation = delivery.signAttestation({
      nodeIdClaim: nodeId,
      stack: stackName,
      op: 'stack-deploy',
      sourceHash,
      referencedHostsHash: delivery.hashHostList(referencedHosts),
      coveredHostsHash: delivery.hashHostList([]),
      actionSetHash: hashActionSet(['stack:deploy']),
    });

    const envelope = {
      attestation,
      auths: [{
        host: 'ghcr.io',
        username: 'hub-user',
        password: 'hub-pass',
      }],
      notAfter: Date.now() + 60_000,
      deliverySourceId: delivery.getDeliverySourceId(),
    };

    acquireLockForAttestation(nodeId, stackName, attestation, 'stack-deploy');

    const result = await resolveRegistryAuthAtSeam({
      envelope,
      nodeId,
      stack: stackName,
      stage: 'stack-deploy',
    });

    const ghcrKey = referencedHosts.map(normalizeImageHost).find(h => h.includes('ghcr')) ?? 'ghcr.io';
    expect(result.auths[ghcrKey]).toBeDefined();
  });

  it('rejects replayed jti at the seam', async () => {
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const stackName = 'regcred-replay';
    const composeDir = NodeRegistry.getInstance().getComposeDir(nodeId);
    const stackDir = path.join(composeDir, stackName);
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  app:\n    image: nginx\n');

    const sourceHash = hashProjectSource(stackDir);
    const referencedHosts = discoverRegistryReferences(stackDir).referencedHosts;
    const delivery = RegistryDeliveryService.getInstance();
    const attestation = delivery.signAttestation({
      nodeIdClaim: nodeId,
      stack: stackName,
      op: 'stack-deploy',
      sourceHash,
      referencedHostsHash: delivery.hashHostList(referencedHosts),
      coveredHostsHash: delivery.hashHostList([]),
      actionSetHash: hashActionSet(['stack:deploy']),
    });

    const envelope = {
      attestation,
      auths: [],
      notAfter: Date.now() + 60_000,
      deliverySourceId: delivery.getDeliverySourceId(),
    };

    acquireLockForAttestation(nodeId, stackName, attestation, 'stack-deploy');

    await resolveRegistryAuthAtSeam({
      envelope,
      nodeId,
      stack: stackName,
      stage: 'stack-deploy',
    });

    await expect(resolveRegistryAuthAtSeam({
      envelope,
      nodeId,
      stack: stackName,
      stage: 'stack-deploy',
    })).rejects.toThrow(/consumed/i);
  });

  it('rejects seam when stack lock is not held', async () => {
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const stackName = 'regcred-no-lock';
    const composeDir = NodeRegistry.getInstance().getComposeDir(nodeId);
    const stackDir = path.join(composeDir, stackName);
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  app:\n    image: nginx\n');

    const sourceHash = hashProjectSource(stackDir);
    const referencedHosts = discoverRegistryReferences(stackDir).referencedHosts;
    const delivery = RegistryDeliveryService.getInstance();
    const attestation = delivery.signAttestation({
      nodeIdClaim: nodeId,
      stack: stackName,
      op: 'stack-deploy',
      sourceHash,
      referencedHostsHash: delivery.hashHostList(referencedHosts),
      coveredHostsHash: delivery.hashHostList([]),
      actionSetHash: hashActionSet(['stack:deploy']),
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
    })).rejects.toThrow(/stack lock required/i);
  });
});
