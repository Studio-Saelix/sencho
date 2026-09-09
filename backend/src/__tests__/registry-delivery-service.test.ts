import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { setupTestDb } from './helpers/setupTestDb';
import { RegistryDeliveryService, type RegistryDeliveryDiscoverResponse } from '../services/RegistryDeliveryService';
import { NodeRegistry } from '../services/NodeRegistry';
import { hashActionSet, hashProjectSource } from '../helpers/registryDeliveryHashes';
import { discoverRegistryReferences } from '../services/registryReferenceDiscovery';
import { resolveComposeEnvForDiscovery } from '../helpers/registryDeliveryComposeEnv';
import { RegistryService } from '../services/RegistryService';

describe('RegistryDeliveryService', () => {
  beforeEach(async () => {
    await setupTestDb();
    RegistryDeliveryService.resetForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeEnvelopeDiscover(hosts: string[], refs: string[]): RegistryDeliveryDiscoverResponse {
    return {
      contractVersion: 1,
      referencedHosts: hosts,
      referencedPullRefs: refs,
      coveredHosts: [],
      sourceHash: 'abc',
      actionSetHash: 'def',
      deliverySourceId: RegistryDeliveryService.getInstance().getDeliverySourceId(),
      attestation: 'sig',
    };
  }

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

  it('rejects a discover request carrying an unsupported contract version', async () => {
    const delivery = RegistryDeliveryService.getInstance();

    await expect(delivery.discoverOnTarget({
      op: 'stack-deploy',
      sourceKind: 'restore-candidate',
      stack: 'demo',
      actionSetHash: hashActionSet(['stack:deploy']),
      contractVersion: 2,
    })).rejects.toMatchObject({ status: 400 });
  });

  it('refuses when one challenged host is covered and another is missing hub credentials', async () => {
    const delivery = RegistryDeliveryService.getInstance();
    const discover = makeEnvelopeDiscover(['ghcr.io', 'docker.io'], ['ghcr.io/acme/app:1.0.0', 'docker.io/acme/other:2.0.0']);
    vi.spyOn(RegistryService.getInstance(), 'resolveDockerConfigForHostDetailed')
      .mockImplementation(async (host: string) =>
        host === 'ghcr.io'
          ? { state: 'available', auth: { username: 'user', password: 'pass' } }
          : { state: 'missing' });
    const probeWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const envelope = await delivery.buildHubEnvelope(1, discover, ['ghcr.io', 'docker.io']);
    expect(envelope).toBeNull();
    expect(probeWarn).toHaveBeenCalledWith(
      '[registryDelivery] REGISTRY_DELIVERY_HOST_NOT_COVERED',
      expect.objectContaining({ nodeId: 1, host: 'docker.io', state: 'missing' }),
    );
  });

  it('refuses when every challenged host is missing hub credentials', async () => {
    const delivery = RegistryDeliveryService.getInstance();
    const discover = makeEnvelopeDiscover(['ghcr.io'], ['ghcr.io/acme/app:1.0.0']);
    vi.spyOn(RegistryService.getInstance(), 'resolveDockerConfigForHostDetailed')
      .mockResolvedValue({ state: 'missing' });
    const probeWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const envelope = await delivery.buildHubEnvelope(1, discover, ['ghcr.io']);
    expect(envelope).toBeNull();
    expect(probeWarn).toHaveBeenCalledWith(
      '[registryDelivery] REGISTRY_DELIVERY_HOST_NOT_COVERED',
      expect.objectContaining({ nodeId: 1, host: 'ghcr.io', state: 'missing' }),
    );
  });

  it('still refuses when a challenged host has a credential row that exists but fails to resolve', async () => {
    const delivery = RegistryDeliveryService.getInstance();
    const discover = makeEnvelopeDiscover(['ghcr.io'], ['ghcr.io/acme/app:1.0.0']);
    vi.spyOn(RegistryService.getInstance(), 'resolveDockerConfigForHostDetailed')
      .mockResolvedValue({ state: 'unavailable' });
    const probeWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const envelope = await delivery.buildHubEnvelope(1, discover, ['ghcr.io']);
    expect(envelope).toBeNull();
    expect(probeWarn).toHaveBeenCalledWith(
      '[registryDelivery] REGISTRY_DELIVERY_HOST_NOT_COVERED',
      expect.objectContaining({ nodeId: 1, host: 'ghcr.io', state: 'unavailable' }),
    );
  });

  it('still refuses when a challenged host resolves to a row without usable auth', async () => {
    const delivery = RegistryDeliveryService.getInstance();
    const discover = makeEnvelopeDiscover(['ghcr.io'], ['ghcr.io/acme/app:1.0.0']);
    vi.spyOn(RegistryService.getInstance(), 'resolveDockerConfigForHostDetailed')
      .mockResolvedValue({ state: 'available' });
    const probeWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const envelope = await delivery.buildHubEnvelope(1, discover, ['ghcr.io']);
    expect(envelope).toBeNull();
    expect(probeWarn).toHaveBeenCalledWith(
      '[registryDelivery] REGISTRY_DELIVERY_HOST_NOT_COVERED',
      expect.objectContaining({ nodeId: 1, host: 'ghcr.io', state: 'no-auth' }),
    );
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
    expect(discover.referencedPullRefs).toEqual(['ghcr.io/org/private:latest']);
    expect(discover.contractVersion).toBe(1);
  });

  it('discovers digest-pinned refs exactly and reports the contract version', async () => {
    const delivery = RegistryDeliveryService.getInstance();
    const digest = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
    const stackName = 'bp-regdisc-digest';
    const composeDir = NodeRegistry.getInstance().getComposeDir(NodeRegistry.getInstance().getDefaultNodeId());
    const stackDir = path.join(composeDir, stackName);
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  old:\n    image: nginx:latest\n');
    fs.writeFileSync(path.join(stackDir, '.env'), '');

    const discover = await delivery.discoverOnTarget({
      op: 'blueprint-apply',
      sourceKind: 'body-content',
      stack: stackName,
      composeContent: `services:\n  app:\n    image: ghcr.io/org/pinned@${digest}\n`,
      actionSetHash: hashActionSet(['stack:deploy']),
    });

    expect(discover.referencedPullRefs).toEqual([`ghcr.io/org/pinned@${digest}`]);
    expect(discover.contractVersion).toBe(1);
  });

  it('blueprint body-content discover matches seam hash when .env exists but is empty', async () => {
    const delivery = RegistryDeliveryService.getInstance();
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const stackName = 'bp-regdisc-empty-env';
    const composeDir = NodeRegistry.getInstance().getComposeDir(nodeId);
    const stackDir = path.join(composeDir, stackName);
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(
      path.join(stackDir, 'compose.yaml'),
      'services:\n  old:\n    image: nginx:latest\n',
    );
    fs.writeFileSync(path.join(stackDir, '.env'), '');

    const incomingCompose = 'services:\n  app:\n    image: nginx:alpine\n';
    const discover = await delivery.discoverOnTarget({
      op: 'blueprint-apply',
      sourceKind: 'body-content',
      stack: stackName,
      composeContent: incomingCompose,
      actionSetHash: hashActionSet(['stack:deploy']),
    });

    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), incomingCompose);
    const seamHash = hashProjectSource(stackDir);

    expect(discover.sourceHash).toBe(seamHash);
  });

  it('rejects an unsupported registry delivery source kind', async () => {
    const delivery = RegistryDeliveryService.getInstance();

    await expect(delivery.discoverOnTarget({
      op: 'stack-deploy',
      // An out-of-contract kind must hit the switch default rather than
      // pass silently as an empty discovery.
      sourceKind: 'bogus' as never,
      actionSetHash: hashActionSet(['stack:deploy']),
    })).rejects.toThrow(/Unsupported registry delivery source kind: bogus/);
  });

  it('clamps the envelope notAfter to the earliest provider expiry', async () => {
    const delivery = RegistryDeliveryService.getInstance();
    const discover = makeEnvelopeDiscover(['ghcr.io', 'docker.io'], ['ghcr.io/acme/app:1.0.0', 'docker.io/acme/other:2.0.0']);
    const earliest = Date.now() + 60_000;
    vi.spyOn(RegistryService.getInstance(), 'resolveDockerConfigForHostDetailed')
      .mockImplementation(async (host: string) =>
        host === 'ghcr.io'
          ? { state: 'available', auth: { username: 'user', password: 'pass' }, expiresAt: earliest }
          : { state: 'available', auth: { username: 'user', password: 'pass' }, expiresAt: Date.now() + 1_200_000 });

    const envelope = await delivery.buildHubEnvelope(1, discover, ['ghcr.io', 'docker.io']);

    expect(envelope?.notAfter).toBe(earliest);
  });

  it('bounds the envelope notAfter by the attestation TTL when providers set no expiry', async () => {
    const delivery = RegistryDeliveryService.getInstance();
    const discover = makeEnvelopeDiscover(['ghcr.io'], ['ghcr.io/acme/app:1.0.0']);
    vi.spyOn(RegistryService.getInstance(), 'resolveDockerConfigForHostDetailed')
      .mockImplementation(async () => ({ state: 'available', auth: { username: 'user', password: 'pass' } }));

    const start = Date.now();
    const envelope = await delivery.buildHubEnvelope(1, discover, ['ghcr.io']);
    const end = Date.now();

    // With no provider expiry, notAfter is one attestation TTL (the
    // module-private ATTESTATION_TTL_SECONDS) after the moment the envelope was built.
    expect(envelope?.notAfter).toBeGreaterThanOrEqual(start + 900_000);
    expect(envelope?.notAfter).toBeLessThanOrEqual(end + 900_000);
  });
});
