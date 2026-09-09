import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import { setupTestDb } from './helpers/setupTestDb';
import { RegistryDeliveryService } from '../services/RegistryDeliveryService';
import { NodeRegistry } from '../services/NodeRegistry';
import { StackOpLockService } from '../services/StackOpLockService';
import { resolveRegistryAuthAtSeam } from '../helpers/registryDeliverySeam';
import { hashActionSet, hashProjectSource, hashPullRefList } from '../helpers/registryDeliveryHashes';
import { discoverRegistryReferences } from '../services/registryReferenceDiscovery';
import { normalizePullRefList } from '../helpers/registryPullReference';
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
    const discovery = discoverRegistryReferences(stackDir);
    const referencedHosts = discovery.referencedHosts;
    const delivery = RegistryDeliveryService.getInstance();
    const attestation = delivery.signAttestation({
      nodeIdClaim: nodeId,
      stack: stackName,
      op: 'stack-deploy',
      sourceHash,
      referencedHostsHash: delivery.hashHostList(referencedHosts),
      referencedPullRefsHash: hashPullRefList(normalizePullRefList(discovery.referencedPullRefs)),
      coveredHostsHash: delivery.hashHostList([]),
      actionSetHash: hashActionSet(['stack:deploy']),
      deliveryContractVersion: 1,
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
    const discovery = discoverRegistryReferences(stackDir);
    const referencedHosts = discovery.referencedHosts;
    const delivery = RegistryDeliveryService.getInstance();
    const attestation = delivery.signAttestation({
      nodeIdClaim: nodeId,
      stack: stackName,
      op: 'stack-deploy',
      sourceHash,
      referencedHostsHash: delivery.hashHostList(referencedHosts),
      referencedPullRefsHash: hashPullRefList(normalizePullRefList(discovery.referencedPullRefs)),
      coveredHostsHash: delivery.hashHostList([]),
      actionSetHash: hashActionSet(['stack:deploy']),
      deliveryContractVersion: 1,
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

  it('rejects an attestation whose referenced pull refs do not match the target project', async () => {
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const stackName = 'regcred-tampered-refs';
    const composeDir = NodeRegistry.getInstance().getComposeDir(nodeId);
    const stackDir = path.join(composeDir, stackName);
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  app:\n    image: ghcr.io/example/private/app:latest\n');

    const sourceHash = hashProjectSource(stackDir);
    const discovery = discoverRegistryReferences(stackDir);
    const delivery = RegistryDeliveryService.getInstance();
    const attestation = delivery.signAttestation({
      nodeIdClaim: nodeId,
      stack: stackName,
      op: 'stack-deploy',
      sourceHash,
      referencedHostsHash: delivery.hashHostList(discovery.referencedHosts),
      // A different ref list than the project actually references: the seam must
      // re-derive the real refs and refuse the mismatch.
      referencedPullRefsHash: hashPullRefList(normalizePullRefList(['ghcr.io/example/private/other:latest'])),
      coveredHostsHash: delivery.hashHostList([]),
      actionSetHash: hashActionSet(['stack:deploy']),
      deliveryContractVersion: 1,
    });
    const envelope = {
      attestation,
      auths: [],
      notAfter: Date.now() + 60_000,
      deliverySourceId: delivery.getDeliverySourceId(),
    };

    acquireLockForAttestation(nodeId, stackName, attestation, 'stack-deploy');

    await expect(resolveRegistryAuthAtSeam({
      envelope,
      nodeId,
      stack: stackName,
      stage: 'stack-deploy',
    })).rejects.toThrow(/referenced pull refs hash mismatch/i);
  });

  it('rejects an attestation with a non-current delivery contract version', async () => {
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const stackName = 'regcred-bad-contract';
    const composeDir = NodeRegistry.getInstance().getComposeDir(nodeId);
    const stackDir = path.join(composeDir, stackName);
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  app:\n    image: nginx\n');

    const sourceHash = hashProjectSource(stackDir);
    const discovery = discoverRegistryReferences(stackDir);
    const delivery = RegistryDeliveryService.getInstance();
    const attestation = delivery.signAttestation({
      nodeIdClaim: nodeId,
      stack: stackName,
      op: 'stack-deploy',
      sourceHash,
      referencedHostsHash: delivery.hashHostList(discovery.referencedHosts),
      referencedPullRefsHash: hashPullRefList(normalizePullRefList(discovery.referencedPullRefs)),
      coveredHostsHash: delivery.hashHostList([]),
      actionSetHash: hashActionSet(['stack:deploy']),
      deliveryContractVersion: 2,
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
    })).rejects.toThrow(/delivery contract version mismatch/i);
  });

  it('rejects seam when stack lock is not held', async () => {
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const stackName = 'regcred-no-lock';
    const composeDir = NodeRegistry.getInstance().getComposeDir(nodeId);
    const stackDir = path.join(composeDir, stackName);
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  app:\n    image: nginx\n');

    const sourceHash = hashProjectSource(stackDir);
    const discovery = discoverRegistryReferences(stackDir);
    const referencedHosts = discovery.referencedHosts;
    const delivery = RegistryDeliveryService.getInstance();
    const attestation = delivery.signAttestation({
      nodeIdClaim: nodeId,
      stack: stackName,
      op: 'stack-deploy',
      sourceHash,
      referencedHostsHash: delivery.hashHostList(referencedHosts),
      referencedPullRefsHash: hashPullRefList(normalizePullRefList(discovery.referencedPullRefs)),
      coveredHostsHash: delivery.hashHostList([]),
      actionSetHash: hashActionSet(['stack:deploy']),
      deliveryContractVersion: 1,
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

  it('verifies a service-scoped attestation against the service-filtered reference set', async () => {
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const stackName = 'regcred-service-scoped';
    const composeDir = NodeRegistry.getInstance().getComposeDir(nodeId);
    const stackDir = path.join(composeDir, stackName);
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(
      path.join(stackDir, 'compose.yaml'),
      'services:\n'
      + '  app:\n'
      + '    image: ghcr.io/example/private/app:latest\n'
      + '  sibling:\n'
      + '    image: registry.example.com/example/private/sibling:latest\n',
    );

    const sourceHash = hashProjectSource(stackDir);
    // Service-scoped discovery: only the selected service's refs are attested.
    const discovery = discoverRegistryReferences(stackDir, {}, 'app');
    const delivery = RegistryDeliveryService.getInstance();
    const attestation = delivery.signAttestation({
      nodeIdClaim: nodeId,
      stack: stackName,
      op: 'service-update',
      service: 'app',
      sourceHash,
      referencedHostsHash: delivery.hashHostList(discovery.referencedHosts),
      referencedPullRefsHash: hashPullRefList(normalizePullRefList(discovery.referencedPullRefs)),
      coveredHostsHash: delivery.hashHostList([]),
      actionSetHash: hashActionSet(['stack:deploy']),
      deliveryContractVersion: 1,
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

    acquireLockForAttestation(nodeId, stackName, attestation, 'service-update');

    const result = await resolveRegistryAuthAtSeam({
      envelope,
      nodeId,
      stack: stackName,
      stage: 'service-update',
      service: 'app',
    });

    expect(result.auths['ghcr.io']).toBeDefined();
    expect(result.auths['registry.example.com']).toBeUndefined();
  });

  it('refuses a whole-project attestation replayed against a service-scoped seam call', async () => {
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const stackName = 'regcred-service-replay';
    const composeDir = NodeRegistry.getInstance().getComposeDir(nodeId);
    const stackDir = path.join(composeDir, stackName);
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(
      path.join(stackDir, 'compose.yaml'),
      'services:\n'
      + '  app:\n'
      + '    image: ghcr.io/example/private/app:latest\n'
      + '  sibling:\n'
      + '    image: registry.example.com/example/private/sibling:latest\n',
    );

    const sourceHash = hashProjectSource(stackDir);
    // Whole-project discovery: includes the sibling host the service-scoped
    // seam call will not re-derive, so the hash claim must mismatch.
    const discovery = discoverRegistryReferences(stackDir);
    const delivery = RegistryDeliveryService.getInstance();
    const attestation = delivery.signAttestation({
      nodeIdClaim: nodeId,
      stack: stackName,
      op: 'service-update',
      service: 'app',
      sourceHash,
      referencedHostsHash: delivery.hashHostList(discovery.referencedHosts),
      referencedPullRefsHash: hashPullRefList(normalizePullRefList(discovery.referencedPullRefs)),
      coveredHostsHash: delivery.hashHostList([]),
      actionSetHash: hashActionSet(['stack:deploy']),
      deliveryContractVersion: 1,
    });

    acquireLockForAttestation(nodeId, stackName, attestation, 'service-update');

    await expect(resolveRegistryAuthAtSeam({
      envelope: {
        attestation,
        auths: [],
        notAfter: Date.now() + 60_000,
        deliverySourceId: delivery.getDeliverySourceId(),
      },
      nodeId,
      stack: stackName,
      stage: 'service-update',
      service: 'app',
    })).rejects.toThrow(/referenced hosts hash mismatch/i);
  });
});
