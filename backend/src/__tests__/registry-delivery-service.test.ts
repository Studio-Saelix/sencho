import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { setupTestDb } from './helpers/setupTestDb';
import { RegistryDeliveryService } from '../services/RegistryDeliveryService';
import { NodeRegistry } from '../services/NodeRegistry';
import { hashActionSet, hashProjectSource } from '../helpers/registryDeliveryHashes';
import { discoverRegistryReferences } from '../services/registryReferenceDiscovery';
import { resolveComposeEnvForDiscovery } from '../helpers/registryDeliveryComposeEnv';

describe('RegistryDeliveryService', () => {
  beforeEach(async () => {
    await setupTestDb();
    RegistryDeliveryService.resetForTests();
  });

  it('evicts expired consumed jtis before accepting new ones', () => {
    const delivery = RegistryDeliveryService.getInstance();
    const now = Date.now();

    delivery.consumeAttestationJti('expired-a', now - 1_000);
    expect(() => delivery.consumeAttestationJti('fresh', now + 60_000)).not.toThrow();
  });

  it('reclaims replay-store capacity after expired jtis are evicted', () => {
    const delivery = RegistryDeliveryService.getInstance();
    delivery.setReplayStoreCapacityForTests(2);
    const now = Date.now();

    delivery.consumeAttestationJti('expired-slot', now - 1);
    delivery.consumeAttestationJti('active-slot', now + 60_000);
    expect(() => delivery.consumeAttestationJti('fresh-after-evict', now + 60_000)).not.toThrow();
    expect(() => delivery.consumeAttestationJti('overflow', now + 60_000)).toThrow(/capacity/i);
  });

  it('rejects a jti that is still within its replay window', () => {
    const delivery = RegistryDeliveryService.getInstance();
    delivery.consumeAttestationJti('active', Date.now() + 60_000);
    expect(() => delivery.consumeAttestationJti('active', Date.now() + 60_000)).toThrow(/consumed/i);
  });

  it('rejects restore-candidate discover when stack name is invalid', async () => {
    const delivery = RegistryDeliveryService.getInstance();

    await expect(delivery.discoverOnTarget({
      op: 'stack-deploy',
      sourceKind: 'restore-candidate',
      stack: '../escape',
      actionSetHash: hashActionSet(['stack:deploy']),
    })).rejects.toThrow(/invalid stack name/i);
  });

  it('blueprint body-content discover matches post-apply live-project hash and hosts', async () => {
    const delivery = RegistryDeliveryService.getInstance();
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const stackName = 'bp-regdisc-parity';
    const composeDir = NodeRegistry.getInstance().getComposeDir(nodeId);
    const stackDir = path.join(composeDir, stackName);
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(
      path.join(stackDir, 'compose.yaml'),
      'services:\n  old:\n    image: nginx:latest\n',
    );
    fs.writeFileSync(path.join(stackDir, '.env'), 'REGISTRY=ghcr.io\n');

    const incomingCompose = 'services:\n  app:\n    image: ${REGISTRY}/org/private:latest\n';
    const discover = await delivery.discoverOnTarget({
      op: 'blueprint-apply',
      sourceKind: 'body-content',
      stack: stackName,
      composeContent: incomingCompose,
      actionSetHash: hashActionSet(['stack:deploy']),
    });

    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), incomingCompose);
    const seamHash = hashProjectSource(stackDir);
    const seamHosts = discoverRegistryReferences(
      stackDir,
      resolveComposeEnvForDiscovery(stackDir),
    ).referencedHosts;

    expect(discover.sourceHash).toBe(seamHash);
    expect(discover.referencedHosts).toEqual(seamHosts);
    expect(discover.referencedHosts).toEqual(['ghcr.io']);
  });
});
