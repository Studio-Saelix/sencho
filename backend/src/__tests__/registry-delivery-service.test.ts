import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb } from './helpers/setupTestDb';
import { RegistryDeliveryService } from '../services/RegistryDeliveryService';
import { hashActionSet } from '../helpers/registryDeliveryHashes';

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
});
