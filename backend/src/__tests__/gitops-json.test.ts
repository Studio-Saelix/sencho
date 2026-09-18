import { describe, expect, it } from 'vitest';
import {
  computeArtifactSetFingerprint,
  decodeArtifactEvidenceJson,
  decodeGitOpsApprovedTargetEffectJson,
  decodeGitOpsRequiredTargetsJson,
  decodeObservedArtifactIdentity,
  encodeArtifactEvidenceJson,
  encodeGitOpsJson,
  encodeGitOpsRequiredTargetsJson,
  encodeObservedArtifactIdentity,
  GitOpsJsonError,
  type ServiceArtifactEvidence,
} from '../services/gitops/json';

describe('gitops json codecs', () => {
  it('rejects extra keys, non-integer ids, and non-canonical required targets', () => {
    expect(() => decodeGitOpsRequiredTargetsJson('{"nodeIds":[1],"extra":true}')).toThrow(GitOpsJsonError);
    expect(() => decodeGitOpsRequiredTargetsJson('{"nodeIds":["1"]}')).toThrow(GitOpsJsonError);
    expect(() => decodeGitOpsRequiredTargetsJson('{"nodeIds":[2,1]}')).toThrow(GitOpsJsonError);
    expect(() => decodeGitOpsRequiredTargetsJson('{"nodeIds":[1,1]}')).toThrow(GitOpsJsonError);
    expect(decodeGitOpsRequiredTargetsJson('{"nodeIds":[1,2]}')).toEqual({ nodeIds: [1, 2] });
    expect(() => encodeGitOpsRequiredTargetsJson([2, 1])).toThrow(GitOpsJsonError);
  });

  it('decodes placement blast as a canonical action effect', () => {
    expect(decodeGitOpsApprovedTargetEffectJson('[]')).toEqual([]);
    expect(decodeGitOpsApprovedTargetEffectJson(
      '[{"nodeId":1,"outcome":"place"},{"nodeId":3,"outcome":"remove"}]',
    )).toEqual([
      { nodeId: 1, outcome: 'place' },
      { nodeId: 3, outcome: 'remove' },
    ]);
    expect(() => decodeGitOpsApprovedTargetEffectJson(
      '[{"nodeId":2,"outcome":"place"},{"nodeId":1,"outcome":"remove"}]',
    )).toThrow(GitOpsJsonError);
    expect(() => decodeGitOpsApprovedTargetEffectJson(
      '[{"nodeId":1,"outcome":"place","extra":1}]',
    )).toThrow(GitOpsJsonError);
  });

  it('rejects contradictory artifact evidence', () => {
    expect(decodeArtifactEvidenceJson('{"kind":"unresolved"}')).toEqual({ kind: 'unresolved' });
    expect(() => decodeArtifactEvidenceJson('{"kind":"unresolved","identity":"x"}')).toThrow(GitOpsJsonError);
    expect(() => decodeArtifactEvidenceJson('{"kind":"exact"}')).toThrow(GitOpsJsonError);
    expect(decodeArtifactEvidenceJson('{"kind":"exact","identity":"sha256:abc"}')).toEqual({
      kind: 'exact',
      identity: 'sha256:abc',
    });
  });

  it('refuses to encode a value JSON.stringify drops', () => {
    // JSON.stringify returns undefined rather than throwing for these, and
    // every JSON column is NOT NULL, so the encoder has to reject them itself.
    expect(() => encodeGitOpsJson(undefined)).toThrow(GitOpsJsonError);
    expect(() => encodeGitOpsJson(() => 'x')).toThrow(GitOpsJsonError);
    expect(() => encodeGitOpsJson(Symbol('x'))).toThrow(GitOpsJsonError);
    expect(encodeGitOpsJson({ a: 1 })).toBe('{"a":1}');
  });

  it('treats null observation as unknown and rejects contradictory kinds', () => {
    expect(decodeObservedArtifactIdentity(null)).toEqual({ kind: 'unknown' });
    expect(() => decodeObservedArtifactIdentity('{"kind":"missing","identity":"x"}')).toThrow(GitOpsJsonError);
    expect(() => decodeObservedArtifactIdentity('{"kind":"exact","identity":"x"}')).toThrow(GitOpsJsonError);
  });

  it('round-trips per-service artifact evidence and keeps legacy rows decodable', () => {
    const services: ServiceArtifactEvidence[] = [{
      serviceName: 'web',
      authoredRef: 'nginx:latest',
      source: 'registry',
      platform: 'linux/amd64',
      indexDigest: 'sha256:aaa',
      platformDigest: 'sha256:aaa',
      buildContextFingerprint: null,
      producedImageId: null,
      failureClass: null,
      resolvedAt: 1,
    }];
    const encoded = encodeArtifactEvidenceJson({ kind: 'exact', identity: 'sha256:abc', services });
    expect(decodeArtifactEvidenceJson(encoded)).toEqual({ kind: 'exact', identity: 'sha256:abc', services });
    expect(decodeArtifactEvidenceJson('{"kind":"exact","identity":"sha256:abc"}')).toEqual({
      kind: 'exact',
      identity: 'sha256:abc',
    });
    expect(() => decodeArtifactEvidenceJson('{"kind":"exact","identity":"sha256:abc","extra":1}')).toThrow(GitOpsJsonError);
  });

  it('keeps artifact fingerprints stable under service reordering', () => {
    const a: ServiceArtifactEvidence = {
      serviceName: 'api',
      authoredRef: 'api:latest',
      source: 'registry',
      platform: 'linux/amd64',
      indexDigest: 'sha256:111',
      platformDigest: 'sha256:111',
      buildContextFingerprint: null,
      producedImageId: null,
      failureClass: null,
      resolvedAt: 1,
    };
    const b: ServiceArtifactEvidence = {
      serviceName: 'web',
      authoredRef: 'web:latest',
      source: 'registry',
      platform: 'linux/amd64',
      indexDigest: 'sha256:222',
      platformDigest: 'sha256:222',
      buildContextFingerprint: null,
      producedImageId: null,
      failureClass: null,
      resolvedAt: 1,
    };
    expect(computeArtifactSetFingerprint([a, b])).toBe(computeArtifactSetFingerprint([b, a]));
  });

  it('round-trips observed artifact identity with services', () => {
    const encoded = encodeObservedArtifactIdentity({
      kind: 'exact',
      identity: 'sha256:obs',
      observedAt: 99,
      services: [{
        serviceName: 'web',
        authoredRef: 'nginx:latest',
        source: 'registry',
        platform: 'linux/amd64',
        indexDigest: 'sha256:obs',
        platformDigest: 'sha256:obs',
        buildContextFingerprint: null,
        producedImageId: null,
        failureClass: null,
        resolvedAt: 99,
      }],
    });
    expect(decodeObservedArtifactIdentity(encoded).kind).toBe('exact');
  });
});
