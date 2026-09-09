import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request } from 'express';
import { setupTestDb } from './helpers/setupTestDb';
import { RegistryDeliveryService } from '../services/RegistryDeliveryService';
import { NodeRegistry } from '../services/NodeRegistry';
import { DatabaseService } from '../services/DatabaseService';
import { RegistryService } from '../services/RegistryService';
import { REGISTRY_DELIVERY_BODY_FIELD, REGISTRY_DELIVERY_FIELD_LIMIT_BYTES } from '../helpers/registryDeliveryBodyLimits';
import { classifyRegistryDeliveryOp } from '../helpers/registryOpClassifier';
import { UnsafeRegistryHopError } from '../helpers/registrySafeProbe';
import { hashPullRefList } from '../helpers/registryDeliveryHashes';

const mockProbeRemoteCapability = vi.fn();
const mockProbeManifestAnonymous = vi.fn();
const mockAssertSafeRegistryHost = vi.fn();
const mockAxiosPost = vi.fn();
const mockIsProxyConfidential = vi.fn();
const mockIsTunnelConfidential = vi.fn();

vi.mock('../helpers/remoteCapabilities', () => ({
  probeRemoteCapability: (...args: unknown[]) => mockProbeRemoteCapability(...args),
}));

vi.mock('../helpers/registrySafeProbe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../helpers/registrySafeProbe')>();
  return {
    assertSafeRegistryHost: (...args: unknown[]) => mockAssertSafeRegistryHost(...args),
    probeManifestAnonymous: (...args: unknown[]) => mockProbeManifestAnonymous(...args),
    splitPullRefForProbe: actual.splitPullRefForProbe,
    UnsafeRegistryHopError: class UnsafeRegistryHopError extends Error {},
  };
});

vi.mock('axios', () => ({
  default: {
    post: (...args: unknown[]) => mockAxiosPost(...args),
    isCancel: () => false,
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
let wouldAttemptRegistryDelivery: typeof import('../helpers/registryDeliveryOutbound').wouldAttemptRegistryDelivery;
let augmentRemoteProxyWithRegistryDelivery: typeof import('../helpers/registryDeliveryProxy').augmentRemoteProxyWithRegistryDelivery;
let registryDeliveryRefusal: typeof import('../helpers/registryDeliveryOutbound').registryDeliveryRefusal;

const TEST_TARGET = { apiUrl: 'http://remote:1852', apiToken: 'token', trustedLoopback: false } as const;

function makeDiscover(delivery: RegistryDeliveryService) {
  return {
    contractVersion: 1,
    referencedHosts: ['ghcr.io'],
    referencedPullRefs: ['ghcr.io/acme/app:1.0.0'],
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
      referencedPullRefsHash: hashPullRefList(['ghcr.io/acme/app:1.0.0']),
      coveredHostsHash: delivery.hashHostList([]),
      actionSetHash: 'def',
      deliveryContractVersion: 1,
    }),
  };
}

function makeEnvelope(delivery: RegistryDeliveryService, discover: ReturnType<typeof makeDiscover>) {
  return {
    attestation: discover.attestation,
    auths: [{ host: 'ghcr.io', username: 'user', password: 'pass', expiresAt: Date.now() + 60_000 }],
    notAfter: Date.now() + 60_000,
    deliverySourceId: discover.deliverySourceId,
  };
}

function mockChallengedDelivery(delivery: RegistryDeliveryService): void {
  const discover = makeDiscover(delivery);
  mockAxiosPost.mockResolvedValue({ status: 200, data: discover });
  mockAssertSafeRegistryHost.mockResolvedValue(undefined);
  mockProbeManifestAnonymous.mockResolvedValue({ classification: 'challenged', status: 401 });
  vi.spyOn(delivery, 'buildHubEnvelope').mockResolvedValue(makeEnvelope(delivery, discover));
}

describe('registryDeliveryOutbound', () => {
  beforeEach(async () => {
    await setupTestDb();
    RegistryDeliveryService.resetForTests();
    vi.clearAllMocks();
    mockIsProxyConfidential.mockReturnValue(true);
    mockIsTunnelConfidential.mockReturnValue(true);
  });

  beforeEach(async () => {
    ({ augmentJsonBodyForRegistryDelivery, wouldAttemptRegistryDelivery, registryDeliveryRefusal } = await import('../helpers/registryDeliveryOutbound'));
    ({ augmentRemoteProxyWithRegistryDelivery } = await import('../helpers/registryDeliveryProxy'));
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
    mockProbeRemoteCapability.mockResolvedValue('unsupported');
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const node = DatabaseService.getInstance().getNode(nodeId)!;
    const body = { foo: 'bar' };

    const result = await augmentJsonBodyForRegistryDelivery({
      method: 'POST',
      apiPath: '/api/stacks/demo/deploy',
      nodeId,
      node,
      target: TEST_TARGET,
      body,
    });

    expect(result).toEqual({ ok: true, body, augmented: false });
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it('passes through unchanged when the remote is unreachable', async () => {
    mockProbeRemoteCapability.mockResolvedValue('unreachable');
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const node = DatabaseService.getInstance().getNode(nodeId)!;
    const body = { foo: 'bar' };

    const result = await augmentJsonBodyForRegistryDelivery({
      method: 'POST',
      apiPath: '/api/stacks/demo/deploy',
      nodeId,
      node,
      target: TEST_TARGET,
      body,
    });

    expect(result).toEqual({ ok: true, body, augmented: false });
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it('reuses a supplied capability probe instead of probing the remote again', async () => {
    const delivery = RegistryDeliveryService.getInstance();
    mockChallengedDelivery(delivery);

    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const node = DatabaseService.getInstance().getNode(nodeId)!;

    const result = await augmentJsonBodyForRegistryDelivery({
      method: 'POST',
      apiPath: '/api/stacks/demo/deploy',
      nodeId,
      node,
      target: TEST_TARGET,
      body: {},
      capabilityProbe: 'supported',
    });

    expect(mockProbeRemoteCapability).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({ ok: true, augmented: true }),
    );
  });

  it('returns 409 TRANSPORT_NOT_CONFIDENTIAL when challenged refs exist over a non-confidential transport', async () => {
    mockProbeRemoteCapability.mockResolvedValue('supported');
    mockIsProxyConfidential.mockReturnValue(false);
    const delivery = RegistryDeliveryService.getInstance();
    mockChallengedDelivery(delivery);

    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const node = DatabaseService.getInstance().getNode(nodeId)!;

    const result = await augmentJsonBodyForRegistryDelivery({
      method: 'POST',
      apiPath: '/api/stacks/demo/deploy',
      nodeId,
      node,
      target: TEST_TARGET,
      body: {},
    });

    expect(result).toEqual({
      ok: false,
      status: 409,
      code: 'REGISTRY_DELIVERY_TRANSPORT_NOT_CONFIDENTIAL',
      error: 'Registry credential delivery requires a confidential transport',
    });
  });

  it('returns 409 CREDENTIAL_UNAVAILABLE when one of two challenged hosts is uncovered', async () => {
    mockProbeRemoteCapability.mockResolvedValue('supported');
    const delivery = RegistryDeliveryService.getInstance();
    const discover = {
      ...makeDiscover(delivery),
      referencedHosts: ['ghcr.io', 'index.docker.io'],
      referencedPullRefs: ['ghcr.io/acme/app:1.0.0', 'index.docker.io/acme/other:2.0.0'],
    };
    discover.attestation = delivery.signAttestation({
      nodeIdClaim: 1,
      stack: 'demo',
      op: 'stack-deploy',
      sourceHash: 'abc',
      referencedHostsHash: delivery.hashHostList(['ghcr.io', 'index.docker.io']),
      referencedPullRefsHash: hashPullRefList(['ghcr.io/acme/app:1.0.0', 'index.docker.io/acme/other:2.0.0']),
      coveredHostsHash: delivery.hashHostList([]),
      actionSetHash: 'def',
      deliveryContractVersion: 1,
    });
    mockAxiosPost.mockResolvedValue({ status: 200, data: discover });
    mockAssertSafeRegistryHost.mockResolvedValue(undefined);
    mockProbeManifestAnonymous.mockResolvedValue({ classification: 'challenged', status: 401 });
    // Real envelope build: ghcr.io covered on the hub, index.docker.io not.
    const hostResolution = vi.spyOn(RegistryService.getInstance(), 'resolveDockerConfigForHostDetailed')
      .mockImplementation(async (host: string) =>
        host === 'ghcr.io'
          ? { state: 'available', auth: { username: 'user', password: 'pass' } }
          : { state: 'missing' });
    const probeWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const node = DatabaseService.getInstance().getNode(nodeId)!;

    const result = await augmentJsonBodyForRegistryDelivery({
      method: 'POST',
      apiPath: '/api/stacks/demo/deploy',
      nodeId,
      node,
      target: TEST_TARGET,
      body: {},
    });

    // All-or-nothing coverage: the partially covered envelope never ships.
    expect(result).toEqual({
      ok: false,
      status: 409,
      code: 'REGISTRY_DELIVERY_CREDENTIAL_UNAVAILABLE',
      error: 'Registry credentials unavailable for challenged image hosts',
    });
    // Only the discover hop ran; the augment refused before any forwarding hop.
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    expect(probeWarn).toHaveBeenCalledWith(
      '[registryDelivery] REGISTRY_DELIVERY_HOST_NOT_COVERED',
      expect.objectContaining({ host: 'index.docker.io', state: 'missing' }),
    );
    hostResolution.mockRestore();
  });

  it('does not probe or disclose sibling credentials on a service-scoped update', async () => {
    // Selected service's image is public; an unrelated sibling's is private
    // and hub-covered. Service-scoped discovery never lists the sibling host,
    // so the update passthroughs without probing it and without any envelope.
    mockProbeRemoteCapability.mockResolvedValue('supported');
    const delivery = RegistryDeliveryService.getInstance();
    const discover = {
      ...makeDiscover(delivery),
      referencedHosts: ['index.docker.io'],
      referencedPullRefs: ['index.docker.io/library/nginx:latest'],
    };
    discover.attestation = delivery.signAttestation({
      nodeIdClaim: 1,
      stack: 'demo',
      op: 'service-update',
      service: 'app',
      sourceHash: 'abc',
      referencedHostsHash: delivery.hashHostList(['index.docker.io']),
      referencedPullRefsHash: hashPullRefList(['index.docker.io/library/nginx:latest']),
      coveredHostsHash: delivery.hashHostList([]),
      actionSetHash: 'def',
      deliveryContractVersion: 1,
    });
    mockAxiosPost.mockResolvedValue({ status: 200, data: discover });
    mockAssertSafeRegistryHost.mockResolvedValue(undefined);
    mockProbeManifestAnonymous.mockResolvedValue({ classification: 'public', status: 200 });
    // The hub holds credentials for both hosts; scoping means the sibling's
    // credential must never be considered, let alone delivered.
    const hostResolution = vi.spyOn(RegistryService.getInstance(), 'resolveDockerConfigForHostDetailed')
      .mockResolvedValue({ state: 'available', auth: { username: 'user', password: 'pass' } });
    const buildSpy = vi.spyOn(delivery, 'buildHubEnvelope');

    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const node = DatabaseService.getInstance().getNode(nodeId)!;

    const result = await augmentJsonBodyForRegistryDelivery({
      method: 'POST',
      apiPath: '/api/stacks/demo/services/app/update',
      nodeId,
      node,
      target: TEST_TARGET,
      body: {},
    });

    expect(result).toEqual({ ok: true, body: {}, augmented: false });
    expect(mockProbeManifestAnonymous).toHaveBeenCalledWith(
      { host: 'index.docker.io', repo: 'library/nginx', tagOrDigest: 'latest' },
      undefined,
    );
    expect(buildSpy).not.toHaveBeenCalled();
    hostResolution.mockRestore();
  });

  it('delivers only the selected service host credential on a service-scoped update', async () => {
    // Selected service image is private and hub-covered; an unrelated sibling
    // is private and hub-covered too. The envelope carries only the selected
    // service host, proving sibling credentials stay undisclosed.
    mockProbeRemoteCapability.mockResolvedValue('supported');
    const delivery = RegistryDeliveryService.getInstance();
    const discover = {
      ...makeDiscover(delivery),
      referencedHosts: ['ghcr.io'],
      referencedPullRefs: ['ghcr.io/acme/app:1.0.0'],
    };
    discover.attestation = delivery.signAttestation({
      nodeIdClaim: 1,
      stack: 'demo',
      op: 'service-update',
      service: 'app',
      sourceHash: 'abc',
      referencedHostsHash: delivery.hashHostList(['ghcr.io']),
      referencedPullRefsHash: hashPullRefList(['ghcr.io/acme/app:1.0.0']),
      coveredHostsHash: delivery.hashHostList([]),
      actionSetHash: 'def',
      deliveryContractVersion: 1,
    });
    mockAxiosPost.mockResolvedValue({ status: 200, data: discover });
    mockAssertSafeRegistryHost.mockResolvedValue(undefined);
    mockProbeManifestAnonymous.mockResolvedValue({ classification: 'challenged', status: 401 });
    const hostResolution = vi.spyOn(RegistryService.getInstance(), 'resolveDockerConfigForHostDetailed')
      .mockImplementation(async (host: string) =>
        host === 'ghcr.io'
          ? { state: 'available', auth: { username: 'app-user', password: 'app-pass' } }
          : { state: 'available', auth: { username: 'sibling-user', password: 'sibling-pass' } });

    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const node = DatabaseService.getInstance().getNode(nodeId)!;

    const result = await augmentJsonBodyForRegistryDelivery({
      method: 'POST',
      apiPath: '/api/stacks/demo/services/app/update',
      nodeId,
      node,
      target: TEST_TARGET,
      body: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.augmented).toBe(true);
    const envelope = result.body[REGISTRY_DELIVERY_BODY_FIELD] as { auths: Array<{ host: string }> };
    const deliveredHosts = envelope.auths.map(a => a.host);
    expect(deliveredHosts).toEqual(['ghcr.io']);
    hostResolution.mockRestore();
  });

  it('returns 409 CREDENTIAL_UNAVAILABLE when the hub covers no challenged host', async () => {
    mockProbeRemoteCapability.mockResolvedValue('supported');
    const delivery = RegistryDeliveryService.getInstance();
    const discover = makeDiscover(delivery);
    mockAxiosPost.mockResolvedValue({ status: 200, data: discover });
    mockAssertSafeRegistryHost.mockResolvedValue(undefined);
    mockProbeManifestAnonymous.mockResolvedValue({ classification: 'challenged', status: 401 });
    vi.spyOn(delivery, 'buildHubEnvelope').mockResolvedValue(null);

    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const node = DatabaseService.getInstance().getNode(nodeId)!;

    const result = await augmentJsonBodyForRegistryDelivery({
      method: 'POST',
      apiPath: '/api/stacks/demo/deploy',
      nodeId,
      node,
      target: TEST_TARGET,
      body: {},
    });

    expect(result).toEqual({
      ok: false,
      status: 409,
      code: 'REGISTRY_DELIVERY_CREDENTIAL_UNAVAILABLE',
      error: 'Registry credentials unavailable for challenged image hosts',
    });
  });

  it('returns unsupported from wouldAttemptRegistryDelivery when remote lacks capability', async () => {
    mockProbeRemoteCapability.mockResolvedValue('unsupported');
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();

    const result = await wouldAttemptRegistryDelivery(
      nodeId,
      'POST',
      '/api/stacks/demo/deploy',
    );

    expect(result).toBe('unsupported');
  });

  it('returns supported from wouldAttemptRegistryDelivery even without confidentiality', async () => {
    mockProbeRemoteCapability.mockResolvedValue('supported');
    mockIsProxyConfidential.mockReturnValue(false);
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();

    const result = await wouldAttemptRegistryDelivery(
      nodeId,
      'POST',
      '/api/stacks/demo/deploy',
    );

    expect(result).toBe('supported');
  });

  it('returns aborted when discover is cancelled', async () => {
    mockProbeRemoteCapability.mockResolvedValue('supported');
    mockAxiosPost.mockImplementation(() => new Promise(() => {}));
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const node = DatabaseService.getInstance().getNode(nodeId)!;
    const controller = new AbortController();
    controller.abort();

    const result = await augmentJsonBodyForRegistryDelivery({
      method: 'POST',
      apiPath: '/api/stacks/demo/deploy',
      nodeId,
      node,
      target: TEST_TARGET,
      body: {},
      abortSignal: controller.signal,
    });

    expect(result).toEqual({ ok: false, status: 499, code: 'REGISTRY_DELIVERY_ABORTED', error: 'Request aborted' });
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it('augments deploy body when a challenged host is hub-covered over a confidential transport', async () => {
    mockProbeRemoteCapability.mockResolvedValue('supported');
    const delivery = RegistryDeliveryService.getInstance();
    mockChallengedDelivery(delivery);

    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const node = DatabaseService.getInstance().getNode(nodeId)!;

    const result = await augmentJsonBodyForRegistryDelivery({
      method: 'POST',
      apiPath: '/api/stacks/demo/deploy',
      nodeId,
      node,
      target: TEST_TARGET,
      body: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.augmented).toBe(true);
    expect(result.body[REGISTRY_DELIVERY_BODY_FIELD]).toBeDefined();
    expect(mockAxiosPost).toHaveBeenCalledOnce();
  });

  it('includes a mixed public/private host in the envelope only because a private exact ref challenged', async () => {
    mockProbeRemoteCapability.mockResolvedValue('supported');
    const delivery = RegistryDeliveryService.getInstance();
    const publicRef = 'ghcr.io/acme/public:1';
    const privateRef = 'ghcr.io/acme/private:1';
    const discover = {
      contractVersion: 1,
      referencedHosts: ['ghcr.io'],
      referencedPullRefs: [privateRef, publicRef],
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
        referencedPullRefsHash: hashPullRefList([privateRef, publicRef]),
        coveredHostsHash: delivery.hashHostList([]),
        actionSetHash: 'def',
        deliveryContractVersion: 1,
      }),
    };
    mockAxiosPost.mockResolvedValue({ status: 200, data: discover });
    mockAssertSafeRegistryHost.mockResolvedValue(undefined);
    mockProbeManifestAnonymous.mockImplementation(({ repo }: { repo: string }) =>
      Promise.resolve(
        repo === 'acme/private'
          ? { classification: 'challenged', status: 401 }
          : { classification: 'public', status: 200 },
      ),
    );
    const buildSpy = vi.spyOn(delivery, 'buildHubEnvelope').mockResolvedValue(makeEnvelope(delivery, discover));

    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const node = DatabaseService.getInstance().getNode(nodeId)!;

    const result = await augmentJsonBodyForRegistryDelivery({
      method: 'POST',
      apiPath: '/api/stacks/demo/deploy',
      nodeId,
      node,
      target: TEST_TARGET,
      body: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.augmented).toBe(true);
    expect(buildSpy).toHaveBeenCalledWith(nodeId, discover, ['ghcr.io']);
  });

  it('passes through when every ref on a mixed host is public, so no envelope is built', async () => {
    mockProbeRemoteCapability.mockResolvedValue('supported');
    const delivery = RegistryDeliveryService.getInstance();
    const publicRef = 'ghcr.io/acme/public:1';
    const privateRef = 'ghcr.io/acme/private:1';
    const discover = {
      contractVersion: 1,
      referencedHosts: ['ghcr.io'],
      referencedPullRefs: [privateRef, publicRef],
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
        referencedPullRefsHash: hashPullRefList([privateRef, publicRef]),
        coveredHostsHash: delivery.hashHostList([]),
        actionSetHash: 'def',
        deliveryContractVersion: 1,
      }),
    };
    mockAxiosPost.mockResolvedValue({ status: 200, data: discover });
    mockAssertSafeRegistryHost.mockResolvedValue(undefined);
    mockProbeManifestAnonymous.mockResolvedValue({ classification: 'public', status: 200 });
    const buildSpy = vi.spyOn(delivery, 'buildHubEnvelope').mockResolvedValue(null);

    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const node = DatabaseService.getInstance().getNode(nodeId)!;

    const result = await augmentJsonBodyForRegistryDelivery({
      method: 'POST',
      apiPath: '/api/stacks/demo/deploy',
      nodeId,
      node,
      target: TEST_TARGET,
      body: {},
    });

    expect(result).toEqual({ ok: true, body: {}, augmented: false });
    expect(buildSpy).not.toHaveBeenCalled();
  });

  it('passes through when no uncovered ref is challenged', async () => {
    mockProbeRemoteCapability.mockResolvedValue('supported');
    const delivery = RegistryDeliveryService.getInstance();
    const discover = makeDiscover(delivery);
    mockAxiosPost.mockResolvedValue({ status: 200, data: discover });
    mockAssertSafeRegistryHost.mockResolvedValue(undefined);
    mockProbeManifestAnonymous.mockResolvedValue({ classification: 'public', status: 200 });
    const buildSpy = vi.spyOn(delivery, 'buildHubEnvelope').mockResolvedValue(null);

    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const node = DatabaseService.getInstance().getNode(nodeId)!;

    const result = await augmentJsonBodyForRegistryDelivery({
      method: 'POST',
      apiPath: '/api/stacks/demo/deploy',
      nodeId,
      node,
      target: TEST_TARGET,
      body: {},
    });

    expect(result).toEqual({ ok: true, body: {}, augmented: false });
    expect(buildSpy).not.toHaveBeenCalled();
  });

  it('refuses a 2xx discover response whose ref list fails the canonical round-trip', async () => {
    mockProbeRemoteCapability.mockResolvedValue('supported');
    const delivery = RegistryDeliveryService.getInstance();
    const discover = makeDiscover(delivery);
    // The target canonicalizes before responding, so an unsorted ref list is a
    // body the target could not have produced.
    discover.referencedPullRefs = ['ghcr.io/acme/zebra:1', 'ghcr.io/acme/app:1.0.0'];
    mockAxiosPost.mockResolvedValue({ status: 200, data: discover });
    mockAssertSafeRegistryHost.mockResolvedValue(undefined);
    mockProbeManifestAnonymous.mockResolvedValue({ classification: 'public', status: 200 });
    const buildSpy = vi.spyOn(delivery, 'buildHubEnvelope').mockResolvedValue(null);
    const probeError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const node = DatabaseService.getInstance().getNode(nodeId)!;

    const result = await augmentJsonBodyForRegistryDelivery({
      method: 'POST',
      apiPath: '/api/stacks/demo/deploy',
      nodeId,
      node,
      target: TEST_TARGET,
      body: {},
    });

    expect(result).toEqual({ ok: false, status: 500, code: 'REGISTRY_DELIVERY_FAILED', error: 'Registry delivery failed' });
    expect(mockProbeManifestAnonymous).not.toHaveBeenCalled();
    expect(buildSpy).not.toHaveBeenCalled();
    expect(probeError).toHaveBeenCalledWith('[registryDeliveryOutbound] hop-1 failed:', expect.any(String));
  });

  it('refuses with 413 when the merged body exceeds the scheduler-selector route limit', async () => {
    mockProbeRemoteCapability.mockResolvedValue('supported');
    const delivery = RegistryDeliveryService.getInstance();
    mockChallengedDelivery(delivery);

    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const node = DatabaseService.getInstance().getNode(nodeId)!;
    // scheduler-selector routes cap the total body at 64 KiB; an original body
    // near that limit plus the envelope busts it after the merge.
    const bigBody = { payload: 'x'.repeat(65 * 1024) };
    const result = await augmentJsonBodyForRegistryDelivery({
      method: 'POST',
      apiPath: '/api/image-updates/selector',
      nodeId, node,
      target: TEST_TARGET,
      body: bigBody,
    });

    expect(result).toEqual({ ok: false, status: 413, code: 'REGISTRY_DELIVERY_BODY_LIMIT', error: 'Request body exceeds registry delivery limit' });
  });

  it('refuses an eligible route whose raw body is not valid JSON', async () => {
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const node = DatabaseService.getInstance().getNode(nodeId)!;
    const req = { path: '/stacks/demo/deploy', method: 'POST' } as unknown as Request;

    const result = await augmentRemoteProxyWithRegistryDelivery(
      req,
      nodeId,
      node,
      { apiUrl: 'http://remote:1852', apiToken: 'token', trustedLoopback: false },
      Buffer.from('{not json', 'utf-8'),
      'supported',
    );

    expect(result).toEqual({ forward: false, status: 400, error: 'Request body is not valid JSON', code: 'REGISTRY_DELIVERY_INVALID_BODY' });
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it('refuses with 413 when the hub envelope exceeds the delivery field limit', async () => {
    mockProbeRemoteCapability.mockResolvedValue('supported');
    const delivery = RegistryDeliveryService.getInstance();
    const discover = makeDiscover(delivery);
    mockAxiosPost.mockResolvedValue({ status: 200, data: discover });
    mockAssertSafeRegistryHost.mockResolvedValue(undefined);
    mockProbeManifestAnonymous.mockResolvedValue({ classification: 'challenged', status: 401 });
    const huge = 'x'.repeat(REGISTRY_DELIVERY_FIELD_LIMIT_BYTES);
    vi.spyOn(delivery, 'buildHubEnvelope').mockResolvedValue({
      attestation: discover.attestation,
      auths: [{ host: 'ghcr.io', username: huge, password: huge, expiresAt: Date.now() + 60_000 }],
      notAfter: Date.now() + 60_000,
      deliverySourceId: discover.deliverySourceId,
    });

    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const node = DatabaseService.getInstance().getNode(nodeId)!;
    const result = await augmentJsonBodyForRegistryDelivery({
      method: 'POST',
      apiPath: '/api/stacks/demo/deploy',
      nodeId, node,
      target: TEST_TARGET,
      body: {},
    });

    expect(result).toEqual({ ok: false, status: 413, code: 'REGISTRY_DELIVERY_ENVELOPE_TOO_LARGE', error: 'Registry delivery envelope too large' });
  });

  it('refuses 2xx discover responses failing the shape gate across contract versions and field types', async () => {
    mockProbeRemoteCapability.mockResolvedValue('supported');
    const delivery = RegistryDeliveryService.getInstance();
    const discover = makeDiscover(delivery);
    const variants: Array<{ name: string; data: Record<string, unknown> }> = [
      { name: 'wrong contract version', data: { ...discover, contractVersion: 2 } },
      { name: 'missing contract version', data: { ...discover, contractVersion: undefined } },
      { name: 'referencedPullRefs not an array', data: { ...discover, referencedPullRefs: 'ghcr.io/acme/app:1.0.0' } },
      { name: 'non-string ref entry', data: { ...discover, referencedPullRefs: [42] } },
      { name: 'ref list over the count bound', data: { ...discover, referencedPullRefs: ['ghcr.io/acme/app:1'].concat(Array.from({ length: 200 }, (_, i) => `ghcr.io/acme/app:1.${i}`)) } },
      { name: 'attestation not a string', data: { ...discover, attestation: 7 } },
    ];
    for (const variant of variants) {
      mockAxiosPost.mockResolvedValue({ status: 200, data: variant.data });
      mockProbeManifestAnonymous.mockClear();
      const buildSpy = vi.spyOn(delivery, 'buildHubEnvelope').mockResolvedValue(null);
      const probeError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = await augmentJsonBodyForRegistryDelivery({
        method: 'POST',
        apiPath: '/api/stacks/demo/deploy',
        nodeId: NodeRegistry.getInstance().getDefaultNodeId(),
        node: DatabaseService.getInstance().getNode(NodeRegistry.getInstance().getDefaultNodeId())!,
        target: TEST_TARGET,
        body: {},
      });
      expect(result, variant.name).toEqual({ ok: false, status: 500, code: 'REGISTRY_DELIVERY_FAILED', error: 'Registry delivery failed' });
      expect(mockProbeManifestAnonymous, variant.name).not.toHaveBeenCalled();
      expect(buildSpy, variant.name).not.toHaveBeenCalled();
      expect(probeError, variant.name).toHaveBeenCalledWith('[registryDeliveryOutbound] hop-1 failed:', expect.any(String));
    }
  });

  it('sends the discover request with the contract version and capped body sizes', async () => {
    mockProbeRemoteCapability.mockResolvedValue('supported');
    const delivery = RegistryDeliveryService.getInstance();
    mockChallengedDelivery(delivery);

    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const node = DatabaseService.getInstance().getNode(nodeId)!;
    await augmentJsonBodyForRegistryDelivery({
      method: 'POST',
      apiPath: '/api/stacks/demo/deploy',
      nodeId, node,
      target: TEST_TARGET,
      body: {},
    });

    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    const [url, body, config] = mockAxiosPost.mock.calls[0];
    expect(url).toBe('http://remote:1852/api/registry-delivery/discover');
    expect(body.contractVersion).toBe(1);
    expect(body.stack).toBe('demo');
    expect(config.maxBodyLength).toBe(REGISTRY_DELIVERY_FIELD_LIMIT_BYTES);
    expect(config.maxContentLength).toBe(REGISTRY_DELIVERY_FIELD_LIMIT_BYTES);
    expect(config.timeout).toBe(30_000);
  });

  it('maps a 5xx discover response to a generic failure without echoing hostile detail', async () => {
    mockProbeRemoteCapability.mockResolvedValue('supported');
    mockAxiosPost.mockResolvedValue({ status: 503, data: { error: 'hostile detail' } });
    const probeError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const node = DatabaseService.getInstance().getNode(nodeId)!;
    const result = await augmentJsonBodyForRegistryDelivery({
      method: 'POST',
      apiPath: '/api/stacks/demo/deploy',
      nodeId, node,
      target: TEST_TARGET,
      body: {},
    });

    expect(result).toEqual({ ok: false, status: 503, code: 'REGISTRY_DELIVERY_FAILED', error: 'Registry delivery failed' });
    expect(probeError).toHaveBeenCalledWith('[registryDeliveryOutbound] hop-1 failed:', 'hostile detail');
  });

  it('echoes the target message for a sub-500 discover failure', async () => {
    mockProbeRemoteCapability.mockResolvedValue('supported');
    mockAxiosPost.mockResolvedValue({ status: 400, data: { error: 'Registry delivery contract version not supported' } });
    const probeError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const node = DatabaseService.getInstance().getNode(nodeId)!;
    const result = await augmentJsonBodyForRegistryDelivery({
      method: 'POST',
      apiPath: '/api/stacks/demo/deploy',
      nodeId, node,
      target: TEST_TARGET,
      body: {},
    });

    expect(result).toEqual({ ok: false, status: 400, code: 'REGISTRY_DELIVERY_FAILED', error: 'Registry delivery contract version not supported' });
    expect(probeError).toHaveBeenCalledWith('[registryDeliveryOutbound] hop-1 failed:', 'Registry delivery contract version not supported');
  });

  it('skips probing and credentialed a host the target already covers', async () => {
    mockProbeRemoteCapability.mockResolvedValue('supported');
    const delivery = RegistryDeliveryService.getInstance();
    const discover = { ...makeDiscover(delivery), coveredHosts: ['ghcr.io'] };
    mockAxiosPost.mockResolvedValue({ status: 200, data: discover });
    mockAssertSafeRegistryHost.mockResolvedValue(undefined);
    mockProbeManifestAnonymous.mockResolvedValue({ classification: 'challenged', status: 401 });
    const buildSpy = vi.spyOn(delivery, 'buildHubEnvelope').mockResolvedValue(null);

    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const node = DatabaseService.getInstance().getNode(nodeId)!;
    const result = await augmentJsonBodyForRegistryDelivery({
      method: 'POST',
      apiPath: '/api/stacks/demo/deploy',
      nodeId, node,
      target: TEST_TARGET,
      body: {},
    });

    expect(result).toEqual({ ok: true, body: {}, augmented: false });
    expect(mockAssertSafeRegistryHost).not.toHaveBeenCalled();
    expect(mockProbeManifestAnonymous).not.toHaveBeenCalled();
    expect(buildSpy).not.toHaveBeenCalled();
  });

  it('probes a digest-pinned ref without mangling the digest into the manifest URL', async () => {
    mockProbeRemoteCapability.mockResolvedValue('supported');
    const delivery = RegistryDeliveryService.getInstance();
    const digest = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const discover = {
      ...makeDiscover(delivery),
      referencedPullRefs: [`ghcr.io/acme/app@${digest}`],
    };
    mockAxiosPost.mockResolvedValue({ status: 200, data: discover });
    mockAssertSafeRegistryHost.mockResolvedValue(undefined);
    mockProbeManifestAnonymous.mockResolvedValue({ classification: 'public', status: 200 });
    const buildSpy = vi.spyOn(delivery, 'buildHubEnvelope').mockResolvedValue(null);

    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const node = DatabaseService.getInstance().getNode(nodeId)!;
    const result = await augmentJsonBodyForRegistryDelivery({
      method: 'POST',
      apiPath: '/api/stacks/demo/deploy',
      nodeId, node,
      target: TEST_TARGET,
      body: {},
    });

    expect(mockProbeManifestAnonymous).toHaveBeenCalledWith({ host: 'ghcr.io', repo: 'acme/app', tagOrDigest: digest }, undefined);
    expect(result).toEqual({ ok: true, body: {}, augmented: false });
    expect(buildSpy).not.toHaveBeenCalled();
  });

  it('returns aborted when a registry probe is cancelled mid-discovery', async () => {
    mockProbeRemoteCapability.mockResolvedValue('supported');
    const delivery = RegistryDeliveryService.getInstance();
    const discover = makeDiscover(delivery);
    mockAxiosPost.mockResolvedValue({ status: 200, data: discover });
    mockAssertSafeRegistryHost.mockResolvedValue(undefined);
    const controller = new AbortController();
    mockProbeManifestAnonymous.mockImplementation(() => {
      controller.abort();
      return Promise.reject(new Error('Registry probe aborted'));
    });

    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const node = DatabaseService.getInstance().getNode(nodeId)!;

    const result = await augmentJsonBodyForRegistryDelivery({
      method: 'POST',
      apiPath: '/api/stacks/demo/deploy',
      nodeId,
      node,
      target: TEST_TARGET,
      body: {},
      abortSignal: controller.signal,
    });

    expect(result).toEqual({ ok: false, status: 499, code: 'REGISTRY_DELIVERY_ABORTED', error: 'Request aborted' });
  });

  it('skips an unsafe registry host without failing the hop and logs the reason', async () => {
    mockProbeRemoteCapability.mockResolvedValue('supported');
    const delivery = RegistryDeliveryService.getInstance();
    const discover = makeDiscover(delivery);
    mockAxiosPost.mockResolvedValue({ status: 200, data: discover });
    mockAssertSafeRegistryHost.mockRejectedValue(
      new UnsafeRegistryHopError('Registry host is not allowed for outbound probing: blocked address'),
    );
    const probeError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const node = DatabaseService.getInstance().getNode(nodeId)!;

    const result = await augmentJsonBodyForRegistryDelivery({
      method: 'POST',
      apiPath: '/api/stacks/demo/deploy',
      nodeId,
      node,
      target: TEST_TARGET,
      body: {},
    });

    expect(result).toEqual({ ok: true, body: {}, augmented: false });
    expect(mockProbeManifestAnonymous).not.toHaveBeenCalled();
    expect(probeError).toHaveBeenCalledWith(
      '[registryDeliveryOutbound] REGISTRY_DELIVERY_UNSAFE_REGISTRY_TARGET',
      expect.objectContaining({ host: 'ghcr.io', reason: expect.stringContaining('blocked address') }),
    );
  });

  it('passes through when a probe classifies inconclusive and logs the host', async () => {
    mockProbeRemoteCapability.mockResolvedValue('supported');
    const delivery = RegistryDeliveryService.getInstance();
    const discover = makeDiscover(delivery);
    mockAxiosPost.mockResolvedValue({ status: 200, data: discover });
    mockAssertSafeRegistryHost.mockResolvedValue(undefined);
    mockProbeManifestAnonymous.mockResolvedValue({ classification: 'inconclusive', status: 404 });
    const probeWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const node = DatabaseService.getInstance().getNode(nodeId)!;

    const result = await augmentJsonBodyForRegistryDelivery({
      method: 'POST',
      apiPath: '/api/stacks/demo/deploy',
      nodeId,
      node,
      target: TEST_TARGET,
      body: {},
    });

    expect(result).toEqual({ ok: true, body: {}, augmented: false });
    expect(probeWarn).toHaveBeenCalledWith(
      '[registryDeliveryOutbound] REGISTRY_DELIVERY_PROBE_INCONCLUSIVE',
      expect.objectContaining({ host: 'ghcr.io' }),
    );
  });

  it('returns aborted when hub envelope build is cancelled after discover', async () => {
    mockProbeRemoteCapability.mockResolvedValue('supported');
    const delivery = RegistryDeliveryService.getInstance();
    const discover = makeDiscover(delivery);
    mockAxiosPost.mockResolvedValue({ status: 200, data: discover });
    mockAssertSafeRegistryHost.mockResolvedValue(undefined);
    mockProbeManifestAnonymous.mockResolvedValue({ classification: 'challenged', status: 401 });

    let releaseEnvelope: (() => void) | undefined;
    vi.spyOn(delivery, 'buildHubEnvelope').mockImplementation(() => new Promise((resolve) => {
      releaseEnvelope = () => resolve(makeEnvelope(delivery, discover));
    }));

    const controller = new AbortController();
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const node = DatabaseService.getInstance().getNode(nodeId)!;
    const pending = augmentJsonBodyForRegistryDelivery({
      method: 'POST',
      apiPath: '/api/stacks/demo/deploy',
      nodeId,
      node,
      target: TEST_TARGET,
      body: {},
      abortSignal: controller.signal,
    });

    setTimeout(() => controller.abort(), 10);
    setTimeout(() => releaseEnvelope?.(), 50);

    const result = await pending;
    expect(result).toEqual({ ok: false, status: 499, code: 'REGISTRY_DELIVERY_ABORTED', error: 'Request aborted' });
  });

  it('registryDeliveryRefusal extracts nothing from non-Errors and non-refusal codes', () => {
    expect(registryDeliveryRefusal(null)).toBeNull();
    expect(registryDeliveryRefusal(new Error('no code attached'))).toBeNull();
    expect(registryDeliveryRefusal(Object.assign(new Error('other code'), { code: 'ECONNRESET' }))).toBeNull();
  });

  it('registryDeliveryRefusal defaults to 409 and passes a numeric status through', () => {
    expect(registryDeliveryRefusal(Object.assign(new Error('refused'), { code: 'REGISTRY_DELIVERY_ENVELOPE_TOO_LARGE' }))).toEqual({
      code: 'REGISTRY_DELIVERY_ENVELOPE_TOO_LARGE',
      status: 409,
    });
    expect(registryDeliveryRefusal(Object.assign(new Error('refused'), { code: 'REGISTRY_DELIVERY_BODY_LIMIT', status: 413 }))).toEqual({
      code: 'REGISTRY_DELIVERY_BODY_LIMIT',
      status: 413,
    });
  });

  it('refuses 409 TRANSPORT_NOT_CONFIDENTIAL when the pilot tunnel is not confidential', async () => {
    const delivery = RegistryDeliveryService.getInstance();
    const pilotNodeId = DatabaseService.getInstance().addNode({
      name: 'regdelivery-pilot-node',
      type: 'remote',
      mode: 'pilot_agent',
      compose_dir: '/tmp',
      is_default: false,
      api_url: 'http://remote:1852',
      api_token: 'token',
    });
    const pilotNode = DatabaseService.getInstance().getNode(pilotNodeId)!;
    mockProbeRemoteCapability.mockResolvedValue('supported');
    mockIsTunnelConfidential.mockReturnValue(false);
    mockChallengedDelivery(delivery);

    const result = await augmentJsonBodyForRegistryDelivery({
      method: 'POST',
      apiPath: '/api/stacks/demo/deploy',
      nodeId: pilotNodeId,
      node: pilotNode,
      target: TEST_TARGET,
      body: {},
    });

    expect(result).toEqual({
      ok: false,
      status: 409,
      code: 'REGISTRY_DELIVERY_TRANSPORT_NOT_CONFIDENTIAL',
      error: 'Registry credential delivery requires a confidential transport',
    });
    expect(mockIsTunnelConfidential).toHaveBeenCalledWith(pilotNodeId);
    expect(mockIsProxyConfidential).not.toHaveBeenCalled();
  });

  it('delivers over a confidential pilot tunnel', async () => {
    const delivery = RegistryDeliveryService.getInstance();
    const pilotNodeId = DatabaseService.getInstance().addNode({
      name: 'regdelivery-pilot-node-ok',
      type: 'remote',
      mode: 'pilot_agent',
      compose_dir: '/tmp',
      is_default: false,
      api_url: 'http://remote:1852',
      api_token: 'token',
    });
    const pilotNode = DatabaseService.getInstance().getNode(pilotNodeId)!;
    mockProbeRemoteCapability.mockResolvedValue('supported');
    mockChallengedDelivery(delivery);

    const result = await augmentJsonBodyForRegistryDelivery({
      method: 'POST',
      apiPath: '/api/stacks/demo/deploy',
      nodeId: pilotNodeId,
      node: pilotNode,
      target: TEST_TARGET,
      body: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.augmented).toBe(true);
    expect(result.body[REGISTRY_DELIVERY_BODY_FIELD]).toBeDefined();
    expect(mockIsTunnelConfidential).toHaveBeenCalledWith(pilotNodeId);
  });
});
