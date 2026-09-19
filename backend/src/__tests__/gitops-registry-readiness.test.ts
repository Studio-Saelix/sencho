import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { encodeArtifactEvidenceJson } from '../services/gitops/json';
import type { ServiceArtifactEvidence } from '../services/gitops/json';
import {
  aggregateRegistryReadiness,
  buildPreflightEvidence,
  encodePreflightEvidenceJson,
  isPreflightBlocked,
} from '../services/gitops/preflight';
import { runWithRegistryDeliveryContext } from '../helpers/registryDeliveryContext';
import type { RegistryDeliveryDiscoverRequest } from '../services/RegistryDeliveryService';
import type { RegistryReadinessDeps } from '../services/gitops/registryReadiness';

let tmpDir: string;
let GitOpsStore: typeof import('../services/gitops/store').GitOpsStore;
let evaluateRegistryReadiness: typeof import('../services/gitops/registryReadiness').evaluateRegistryReadiness;
let deriveRequiredRegistryHosts: typeof import('../services/gitops/registryReadiness').deriveRequiredRegistryHosts;
let ECR_CACHE_SAFETY_MS: typeof import('../services/RegistryService').ECR_CACHE_SAFETY_MS;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ GitOpsStore } = await import('../services/gitops/store'));
  ({
    evaluateRegistryReadiness,
    deriveRequiredRegistryHosts,
  } = await import('../services/gitops/registryReadiness'));
  ({ ECR_CACHE_SAFETY_MS } = await import('../services/RegistryService'));
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  vi.restoreAllMocks();
  GitOpsStore.resetForTests();
});

function service(
  overrides: Partial<ServiceArtifactEvidence> & Pick<ServiceArtifactEvidence, 'serviceName' | 'authoredRef' | 'source'>,
): ServiceArtifactEvidence {
  return {
    platform: null,
    indexDigest: null,
    platformDigest: null,
    buildContextFingerprint: null,
    producedImageId: null,
    failureClass: null,
    resolvedAt: null,
    ...overrides,
  };
}

function insertArtifact(
  id: string,
  services: ServiceArtifactEvidence[],
  kind: 'exact' | 'unresolved' = 'exact',
): void {
  const evidence = kind === 'exact'
    ? encodeArtifactEvidenceJson({ kind: 'exact', identity: 'sha256:abc', services })
    : encodeArtifactEvidenceJson({ kind: 'unresolved', services });
  GitOpsStore.getInstance().insertArtifactSet({
    id,
    generation_id: `gen-${id}`,
    evidence_version: 1,
    authoritative: 0,
    qualification: kind === 'exact' ? 'exact' : 'unresolved',
    evidence_json: evidence,
    created_at: 1,
  });
}

function readyDeps(overrides?: Partial<RegistryReadinessDeps>): RegistryReadinessDeps {
  return {
    probeRemoteCapability: vi.fn(async () => ({ kind: 'supported' as const })),
    probeManifestAnonymous: vi.fn(async () => ({
      classification: 'public' as const,
      status: 200,
    })),
    resolveHubDockerConfigForHost: vi.fn(async () => ({ state: 'missing' as const })),
    discoverOnTarget: vi.fn(async () => ({
      contractVersion: 1 as const,
      referencedHosts: [] as string[],
      referencedPullRefs: [] as string[],
      coveredHosts: [] as string[],
      sourceHash: 's',
      actionSetHash: 'a',
      deliverySourceId: 'd',
      attestation: 'tok',
    })),
    isControlNode: () => true,
    nowMs: () => 1_000_000,
    ...overrides,
  };
}

describe('deriveRequiredRegistryHosts', () => {
  it('returns only registry-backed hosts with authored refs', () => {
    insertArtifact('art-hosts', [
      service({
        serviceName: 'web',
        source: 'registry',
        authoredRef: 'ghcr.io/acme/web:1',
      }),
      service({
        serviceName: 'builder',
        source: 'build',
        authoredRef: null,
      }),
      service({
        serviceName: 'bad',
        source: 'unsupported',
        authoredRef: 'docker.io/library/busybox:latest',
      }),
    ]);
    expect(deriveRequiredRegistryHosts('art-hosts')).toEqual(['ghcr.io']);
  });

  it('returns null when the artifact set is missing or unresolved without services', () => {
    expect(deriveRequiredRegistryHosts(null)).toBeNull();
    expect(deriveRequiredRegistryHosts('missing')).toBeNull();
    GitOpsStore.getInstance().insertArtifactSet({
      id: 'art-empty',
      generation_id: 'gen-art-empty',
      evidence_version: 1,
      authoritative: 0,
      qualification: 'unresolved',
      evidence_json: encodeArtifactEvidenceJson({ kind: 'unresolved' }),
      created_at: 1,
    });
    expect(deriveRequiredRegistryHosts('art-empty')).toBeNull();
  });
});

describe('evaluateRegistryReadiness', () => {
  it('marks all-public hosts as not_required without discover', async () => {
    insertArtifact('art-public', [
      service({
        serviceName: 'web',
        source: 'registry',
        authoredRef: 'docker.io/library/nginx:latest',
      }),
    ]);
    const discoverOnTarget = vi.fn(async (_n: number, _p: RegistryDeliveryDiscoverRequest) => {
      throw new Error('discover must not run for control/public');
    });
    const body = await evaluateRegistryReadiness(
      { artifactSetId: 'art-public', requiredNodeIds: [1] },
      readyDeps({ discoverOnTarget }),
    );
    expect(body.registryReadiness).toBe('not_required');
    expect(body.targets).toEqual([
      expect.objectContaining({
        nodeId: 1,
        sourceClass: 'public',
        readiness: 'not_required',
        hosts: ['index.docker.io'],
        expired: false,
      }),
    ]);
    expect(discoverOnTarget).not.toHaveBeenCalled();
    expect(isPreflightBlocked(body)).toBe(false);
  });

  it('records unknown when the artifact set cannot supply hosts', async () => {
    const body = await evaluateRegistryReadiness(
      { artifactSetId: null, requiredNodeIds: [1, 2] },
      readyDeps(),
    );
    expect(body.registryReadiness).toBe('blocked');
    expect(body.targets).toHaveLength(2);
    expect(body.targets.every((t) => t.readiness === 'unknown')).toBe(true);
    expect(isPreflightBlocked(body)).toBe(true);
  });

  it('uses node_local when the target covers a challenged host', async () => {
    insertArtifact('art-private', [
      service({
        serviceName: 'api',
        source: 'registry',
        authoredRef: 'ghcr.io/acme/api:2',
      }),
    ]);
    const body = await evaluateRegistryReadiness(
      {
        artifactSetId: 'art-private',
        requiredNodeIds: [7],
        stackName: 'demo',
        composeContent: 'services:\n  api:\n    image: ghcr.io/acme/api:2\n',
      },
      readyDeps({
        isControlNode: () => false,
        probeManifestAnonymous: vi.fn(async () => ({ classification: 'challenged' as const, status: 401 })),
        discoverOnTarget: vi.fn(async () => ({
          contractVersion: 1 as const,
          referencedHosts: ['ghcr.io'],
          referencedPullRefs: ['ghcr.io/acme/api:2'],
          coveredHosts: ['ghcr.io'],
          sourceHash: 's',
          actionSetHash: 'a',
          deliverySourceId: 'd',
          attestation: 'tok',
        })),
        probeRemoteCapability: vi.fn(async () => ({ kind: 'supported' as const })),
      }),
    );
    expect(body.targets[0]).toEqual(expect.objectContaining({
      readiness: 'ready',
      sourceClass: 'node_local',
      hosts: ['ghcr.io'],
    }));
    expect(body.registryReadiness).toBe('ready');
  });

  it('maps capability unsupported vs unreachable distinctly', async () => {
    insertArtifact('art-cap', [
      service({
        serviceName: 'api',
        source: 'registry',
        authoredRef: 'ghcr.io/acme/api:2',
      }),
    ]);
    const unsupported = await evaluateRegistryReadiness(
      { artifactSetId: 'art-cap', requiredNodeIds: [3], stackName: 's' },
      readyDeps({
        isControlNode: () => false,
        probeManifestAnonymous: vi.fn(async () => ({ classification: 'challenged' as const, status: 401 })),
        probeRemoteCapability: vi.fn(async () => ({ kind: 'unsupported' as const })),
      }),
    );
    expect(unsupported.targets[0].readiness).toBe('capability_unsupported');

    const unreachable = await evaluateRegistryReadiness(
      { artifactSetId: 'art-cap', requiredNodeIds: [3], stackName: 's' },
      readyDeps({
        isControlNode: () => false,
        probeManifestAnonymous: vi.fn(async () => ({ classification: 'challenged' as const, status: 401 })),
        probeRemoteCapability: vi.fn(async () => ({
          kind: 'unreachable' as const,
          detail: 'transport_failure' as const,
        })),
      }),
    );
    expect(unreachable.targets[0].readiness).toBe('unknown');
  });

  it('reports auth_missing without envelope or local row', async () => {
    insertArtifact('art-miss', [
      service({
        serviceName: 'api',
        source: 'registry',
        authoredRef: 'ghcr.io/acme/api:2',
      }),
    ]);
    const body = await evaluateRegistryReadiness(
      { artifactSetId: 'art-miss', requiredNodeIds: [1] },
      readyDeps({
        probeManifestAnonymous: vi.fn(async () => ({ classification: 'challenged' as const, status: 401 })),
        resolveHubDockerConfigForHost: vi.fn(async () => ({ state: 'missing' as const })),
      }),
    );
    expect(body.targets[0]).toEqual(expect.objectContaining({
      readiness: 'auth_missing',
      sourceClass: 'hub_ephemeral',
    }));
  });

  it('treats inbound envelope hosts as hub_ephemeral ready (R5)', async () => {
    insertArtifact('art-env', [
      service({
        serviceName: 'api',
        source: 'registry',
        authoredRef: 'ghcr.io/acme/api:2',
      }),
    ]);
    const deps = readyDeps({
      probeManifestAnonymous: vi.fn(async () => ({ classification: 'challenged' as const, status: 401 })),
      resolveHubDockerConfigForHost: vi.fn(async () => ({ state: 'missing' as const })),
    });
    const body = await runWithRegistryDeliveryContext(
      {
        envelope: {
          attestation: 'x.y.z',
          notAfter: Date.now() + 60_000,
          deliverySourceId: 'hub-1',
          auths: [{ host: 'ghcr.io', username: 'u', password: 'p' }],
        },
        nodeId: 1,
        stack: 'demo',
        stage: 'git-apply-auto-deploy',
      },
      () => evaluateRegistryReadiness(
        { artifactSetId: 'art-env', requiredNodeIds: [1] },
        deps,
      ),
    );
    expect(body.targets[0]).toEqual(expect.objectContaining({
      readiness: 'ready',
      sourceClass: 'hub_ephemeral',
    }));
    const encoded = encodePreflightEvidenceJson(body);
    expect(encoded).not.toContain('password');
    expect(encoded).not.toContain('"u"');
    expect(encoded).not.toContain('"p"');
    expect(encoded).not.toMatch(/"username"|"token"|"secretValue"/i);
  });

  it('marks auth_expired inside the ECR safety window', async () => {
    insertArtifact('art-exp', [
      service({
        serviceName: 'api',
        source: 'registry',
        authoredRef: '123.dkr.ecr.us-east-1.amazonaws.com/api:1',
      }),
    ]);
    const now = 10_000_000;
    const body = await evaluateRegistryReadiness(
      { artifactSetId: 'art-exp', requiredNodeIds: [1] },
      readyDeps({
        nowMs: () => now,
        probeManifestAnonymous: vi.fn(async () => ({ classification: 'challenged' as const, status: 401 })),
        resolveHubDockerConfigForHost: vi.fn(async () => ({
          state: 'available' as const,
          auth: { username: 'AWS', password: 'tok' },
          expiresAt: now + ECR_CACHE_SAFETY_MS - 1,
        })),
      }),
    );
    expect(body.targets[0]).toEqual(expect.objectContaining({
      readiness: 'auth_expired',
      expired: true,
    }));
    expect(encodePreflightEvidenceJson(body)).not.toContain('tok');
  });

  it('skips discover and capability probe on the control node', async () => {
    insertArtifact('art-ctrl', [
      service({
        serviceName: 'api',
        source: 'registry',
        authoredRef: 'ghcr.io/acme/api:2',
      }),
    ]);
    const probeRemoteCapability = vi.fn(async () => ({ kind: 'supported' as const }));
    const discoverOnTarget = vi.fn(async () => {
      throw new Error('no discover');
    });
    await evaluateRegistryReadiness(
      { artifactSetId: 'art-ctrl', requiredNodeIds: [1] },
      readyDeps({
        isControlNode: () => true,
        probeManifestAnonymous: vi.fn(async () => ({ classification: 'challenged' as const, status: 401 })),
        resolveHubDockerConfigForHost: vi.fn(async () => ({
          state: 'available' as const,
          auth: { username: 'u', password: 'p' },
        })),
        probeRemoteCapability,
        discoverOnTarget,
      }),
    );
    expect(probeRemoteCapability).not.toHaveBeenCalled();
    expect(discoverOnTarget).not.toHaveBeenCalled();
  });

  it('aggregates mixed ready + unknown into a blocked registry slot', () => {
    const body = buildPreflightEvidence({
      artifactSetId: 'art',
      targets: [
        {
          nodeId: 1,
          sourceClass: 'public',
          readiness: 'ready',
          hosts: ['ghcr.io'],
          expired: false,
        },
        {
          nodeId: 2,
          sourceClass: 'hub_ephemeral',
          readiness: 'unknown',
          hosts: ['ghcr.io'],
          expired: false,
        },
      ],
    });
    expect(aggregateRegistryReadiness(body.targets)).toBe('blocked');
    expect(body.registryReadiness).toBe('blocked');
    expect(isPreflightBlocked(body)).toBe(true);
  });

  it('aggregates all not_required to not_required', () => {
    const body = buildPreflightEvidence({
      targets: [
        {
          nodeId: 1,
          sourceClass: 'public',
          readiness: 'not_required',
          hosts: [],
          expired: false,
        },
      ],
    });
    expect(body.registryReadiness).toBe('not_required');
    expect(isPreflightBlocked(body)).toBe(false);
  });

  it('never encodes credential-shaped keys', async () => {
    insertArtifact('art-safe', [
      service({
        serviceName: 'api',
        source: 'registry',
        authoredRef: 'ghcr.io/acme/api:2',
      }),
    ]);
    const body = await evaluateRegistryReadiness(
      { artifactSetId: 'art-safe', requiredNodeIds: [1] },
      readyDeps({
        probeManifestAnonymous: vi.fn(async () => ({ classification: 'challenged' as const, status: 401 })),
        resolveHubDockerConfigForHost: vi.fn(async () => ({
          state: 'available' as const,
          auth: { username: 'secret-user', password: 'hunter2' },
        })),
      }),
    );
    const encoded = encodePreflightEvidenceJson(body);
    expect(encoded).not.toMatch(/hunter2|secret-user|password|username|token|auth\b/i);
    const keys = Object.keys(JSON.parse(encoded)).sort();
    expect(keys).toEqual([
      'artifactSetId',
      'capability',
      'connectivity',
      'registryReadiness',
      'secretReadiness',
      'targets',
    ]);
  });
});
