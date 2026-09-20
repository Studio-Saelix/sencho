import { describe, expect, it } from 'vitest';
import {
  buildPreflightEvidence,
  encodePreflightEvidenceJson,
  fingerprintPreflightEvidence,
  isPreflightBlocked,
} from '../services/gitops/preflight';
import { isPreflightFingerprint } from '../services/gitops/json';

const nonBlockingRegistryEvidence = () =>
  buildPreflightEvidence({
    registryReadiness: 'not_required',
    targets: [{
      nodeId: 1,
      sourceClass: 'public',
      readiness: 'not_required',
      hosts: [],
      expired: false,
    }],
  });

describe('gitops preflight evidence', () => {
  it('defaults every slot to unknown with no credential fields', () => {
    const body = buildPreflightEvidence();
    expect(body).toEqual({
      capability: 'unknown',
      secretReadiness: 'unknown',
      registryReadiness: 'unknown',
      connectivity: 'unknown',
      artifactSetId: null,
      targets: [],
    });
    const encoded = encodePreflightEvidenceJson(body);
    expect(encoded).not.toMatch(/credential|password|token|secretValue|apiKey/i);
    expect(JSON.parse(encoded)).toEqual({
      artifactSetId: null,
      capability: 'unknown',
      connectivity: 'unknown',
      registryReadiness: 'unknown',
      secretReadiness: 'unknown',
      targets: [],
    });
  });

  it('fingerprints stably and matches isPreflightFingerprint', () => {
    const body = buildPreflightEvidence({ registryReadiness: 'not_required' });
    const first = fingerprintPreflightEvidence(body);
    const second = fingerprintPreflightEvidence(buildPreflightEvidence({
      registryReadiness: 'not_required',
    }));
    expect(first).toBe(second);
    expect(isPreflightFingerprint(first)).toBe(true);
    expect(first).toHaveLength(64);
  });

  it('changes the fingerprint when a slot changes', () => {
    const baseline = fingerprintPreflightEvidence(buildPreflightEvidence());
    const changed = fingerprintPreflightEvidence(buildPreflightEvidence({
      registryReadiness: 'ready',
    }));
    expect(changed).not.toBe(baseline);
  });

  it('detects a blocked slot', () => {
    expect(isPreflightBlocked(buildPreflightEvidence())).toBe(true);
    expect(isPreflightBlocked(nonBlockingRegistryEvidence())).toBe(false);
    expect(isPreflightBlocked(buildPreflightEvidence({ connectivity: 'blocked' }))).toBe(true);
  });

  it('never encodes injected credential-shaped overrides into the body', () => {
    const sneaky = {
      capability: 'ready' as const,
      secretReadiness: 'ready' as const,
      registryReadiness: 'ready' as const,
      connectivity: 'ready' as const,
      password: 'hunter2',
      registryToken: 'tok',
    };
    const body = buildPreflightEvidence(sneaky);
    const encoded = encodePreflightEvidenceJson(body);
    expect(encoded).not.toContain('hunter2');
    expect(encoded).not.toContain('tok');
    expect(Object.keys(JSON.parse(encoded)).sort()).toEqual([
      'artifactSetId',
      'capability',
      'connectivity',
      'registryReadiness',
      'secretReadiness',
      'targets',
    ]);
  });
});
