import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import { setupTestDb } from './helpers/setupTestDb';
import { RegistryDeliveryService } from '../services/RegistryDeliveryService';
import { NodeRegistry } from '../services/NodeRegistry';
import { StackOpLockService } from '../services/StackOpLockService';
import { PreparedSourceStore } from '../services/preparedSourceStore';
import { resolveRegistryAuthAtSeam } from '../helpers/registryDeliverySeam';
import { hashActionSet, hashDeliverySourceDir } from '../helpers/registryDeliveryHashes';
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

describe('registryDeliverySeam prepared source claim', () => {
  beforeEach(async () => {
    await setupTestDb();
    RegistryDeliveryService.resetForTests();
    StackOpLockService.resetForTests();
    const deliverySourceId = RegistryDeliveryService.getInstance().getDeliverySourceId();
    PreparedSourceStore.getInstance().configure(deliverySourceId);
  });

  it('claims prepId and merges delivered credentials from prepared payload', async () => {
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const stackName = 'prep-claim-stack';
    const stagingDir = path.join(process.env.TMPDIR || '/tmp', `sencho-prep-${Date.now()}`);
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(
      path.join(stagingDir, 'compose.yaml'),
      'services:\n  app:\n    image: ghcr.io/example/private/app:latest\n',
    );

    const sourceHash = hashDeliverySourceDir(stagingDir);
    const entry = await PreparedSourceStore.getInstance().prepareFromDirectory(
      'request-generated',
      sourceHash,
      stagingDir,
    );
    const payloadPath = PreparedSourceStore.getInstance().peekPayloadPath(entry.prepId);
    const referencedHosts = discoverRegistryReferences(payloadPath).referencedHosts;
    const delivery = RegistryDeliveryService.getInstance();
    const attestation = delivery.signAttestation({
      nodeIdClaim: nodeId,
      stack: stackName,
      op: 'template-deploy',
      sourceHash,
      referencedHostsHash: delivery.hashHostList(referencedHosts),
      coveredHostsHash: delivery.hashHostList([]),
      actionSetHash: hashActionSet(['stack:create', 'stack:deploy']),
      prepId: entry.prepId,
    });

    const envelope = {
      attestation,
      prepId: entry.prepId,
      auths: [{
        host: 'ghcr.io',
        username: 'hub-user',
        password: 'hub-pass',
      }],
      notAfter: Date.now() + 60_000,
      deliverySourceId: delivery.getDeliverySourceId(),
    };

    acquireLockForAttestation(nodeId, stackName, attestation, 'template-deploy');

    const result = await resolveRegistryAuthAtSeam({
      envelope,
      nodeId,
      stack: stackName,
      stage: 'template-deploy',
    });

    const ghcrKey = referencedHosts.map(normalizeImageHost).find(h => h.includes('ghcr')) ?? 'ghcr.io';
    expect(result.auths[ghcrKey]).toBeDefined();
    expect(result.prepId).toBe(entry.prepId);
    expect(PreparedSourceStore.getInstance().getEntry(entry.prepId)?.state).toBe('claimed');
  });

  it('rejects a substituted prepId at the seam', async () => {
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const delivery = RegistryDeliveryService.getInstance();
    const attestation = delivery.signAttestation({
      nodeIdClaim: nodeId,
      stack: 'mismatch',
      op: 'template-deploy',
      sourceHash: 'abc',
      referencedHostsHash: delivery.hashHostList([]),
      coveredHostsHash: delivery.hashHostList([]),
      actionSetHash: hashActionSet(['stack:create', 'stack:deploy']),
      prepId: 'deadbeefdeadbeefdeadbeefdeadbeef',
    });

    acquireLockForAttestation(nodeId, 'mismatch', attestation, 'template-deploy');

    await expect(resolveRegistryAuthAtSeam({
      envelope: {
        attestation,
        prepId: 'cafebabe',
        auths: [],
        notAfter: Date.now() + 60_000,
        deliverySourceId: delivery.getDeliverySourceId(),
      },
      nodeId,
      stack: 'mismatch',
      stage: 'template-deploy',
    })).rejects.toThrow(/prepId/i);
  });
});
