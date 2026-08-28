import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupTestDb } from './helpers/setupTestDb';
import { RegistryDeliveryService } from '../services/RegistryDeliveryService';
import { NodeRegistry } from '../services/NodeRegistry';
import { DatabaseService } from '../services/DatabaseService';
import { REGISTRY_DELIVERY_BODY_FIELD } from '../helpers/registryDeliveryBodyLimits';
import { classifyRegistryDeliveryOp } from '../helpers/registryOpClassifier';

const mockRemoteAdvertises = vi.fn();
const mockAxiosPost = vi.fn();
const mockIsProxyConfidential = vi.fn();
const mockIsTunnelConfidential = vi.fn();

vi.mock('../helpers/remoteCapabilities', () => ({
  remoteAdvertisesCapability: (...args: unknown[]) => mockRemoteAdvertises(...args),
}));

vi.mock('axios', () => ({
  default: {
    post: (...args: unknown[]) => mockAxiosPost(...args),
  },
}));

vi.mock('../services/PilotTunnelManager', () => ({
  PilotTunnelManager: {
    getInstance: () => ({
      isTunnelConfidential: (...args: unknown[]) => mockIsTunnelConfidential(...args),
    }),
  },
}));

let augmentJsonBodyForRegistryDelivery: typeof import('../helpers/registryDeliveryOutbound').augmentJsonBodyForRegistryDelivery;

describe('registryDeliveryOutbound', () => {
  beforeEach(async () => {
    await setupTestDb();
    RegistryDeliveryService.resetForTests();
    vi.clearAllMocks();
    mockIsProxyConfidential.mockReturnValue(true);
    mockIsTunnelConfidential.mockReturnValue(true);
  });

  beforeEach(async () => {
    ({ augmentJsonBodyForRegistryDelivery } = await import('../helpers/registryDeliveryOutbound'));
    const delivery = RegistryDeliveryService.getInstance();
    vi.spyOn(delivery, 'isProxyTransportConfidential').mockImplementation(
      () => mockIsProxyConfidential(),
    );
  });

  it('classifies blueprint apply-local as eligible', () => {
    const result = classifyRegistryDeliveryOp('POST', '/api/blueprints/apply-local');
    expect(result.eligible).toBe(true);
    expect(result.stage).toBe('blueprint-apply');
  });

  it('passes through unchanged when remote lacks delivery capability', async () => {
    mockRemoteAdvertises.mockResolvedValue(false);
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const node = DatabaseService.getInstance().getNode(nodeId)!;
    const body = { foo: 'bar' };

    const result = await augmentJsonBodyForRegistryDelivery({
      method: 'POST',
      apiPath: '/api/stacks/demo/deploy',
      nodeId,
      node,
      target: { apiUrl: 'http://remote:1852', apiToken: 'token' },
      body,
    });

    expect(result).toEqual({ ok: true, body, augmented: false });
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it('passes through unchanged when transport is not confidential', async () => {
    mockRemoteAdvertises.mockResolvedValue(true);
    mockIsProxyConfidential.mockReturnValue(false);
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const node = DatabaseService.getInstance().getNode(nodeId)!;
    const body = { foo: 'bar' };

    const result = await augmentJsonBodyForRegistryDelivery({
      method: 'POST',
      apiPath: '/api/stacks/demo/deploy',
      nodeId,
      node,
      target: { apiUrl: 'http://remote:1852', apiToken: 'token' },
      body,
    });

    expect(result).toEqual({ ok: true, body, augmented: false });
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it('augments deploy body when capability and transport are present', async () => {
    mockRemoteAdvertises.mockResolvedValue(true);
    const delivery = RegistryDeliveryService.getInstance();
    const discover = {
      referencedHosts: ['ghcr.io'],
      coveredHosts: [],
      sourceHash: 'abc',
      actionSetHash: 'def',
      deliverySourceId: delivery.getDeliverySourceId(),
      attestation: delivery.signAttestation({
        nodeIdClaim: 1,
        stack: 'demo',
        op: 'stack-deploy',
        sourceHash: 'abc',
        referencedHostsHash: delivery.hashHostList(['ghcr.io']),
        coveredHostsHash: delivery.hashHostList([]),
        actionSetHash: 'def',
      }),
    };
    mockAxiosPost.mockResolvedValue({ status: 200, data: discover });

    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const node = DatabaseService.getInstance().getNode(nodeId)!;

    const result = await augmentJsonBodyForRegistryDelivery({
      method: 'POST',
      apiPath: '/api/stacks/demo/deploy',
      nodeId,
      node,
      target: { apiUrl: 'http://remote:1852', apiToken: 'token' },
      body: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.augmented).toBe(true);
    expect(result.body[REGISTRY_DELIVERY_BODY_FIELD]).toBeDefined();
    expect(mockAxiosPost).toHaveBeenCalledOnce();
  });
});
