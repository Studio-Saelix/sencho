/**
 * Fifth-audit regressions: structural services_json validation.
 */
import { describe, expect, it } from 'vitest';
import {
  parseServicesJsonStrict,
  scrapeRollbackTagsLenient,
  type StackRecoveryServiceCapture,
} from '../services/recoveryServicesJson';

function validService(over: Partial<StackRecoveryServiceCapture> = {}): StackRecoveryServiceCapture {
  return {
    serviceName: 'web',
    scale: 1,
    hasBuild: false,
    declaredImageRef: 'nginx:latest',
    referenceKind: 'moving_tag',
    replicas: [{
      containerId: 'c1',
      imageId: 'sha256:aaa',
      repoDigest: null,
      state: 'running',
      rollbackTag: 'sencho-rb/aaaaaaaaaaaa/web:hold',
    }],
    ...over,
  };
}

describe('parseServicesJsonStrict', () => {
  it('accepts a well-formed services array', () => {
    const parsed = parseServicesJsonStrict(JSON.stringify([validService()]));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.services[0].serviceName).toBe('web');
  });

  it('rejects empty object elements like [{}]', () => {
    expect(parseServicesJsonStrict('[{}]').ok).toBe(false);
  });

  it('rejects malformed replica arrays', () => {
    expect(parseServicesJsonStrict(JSON.stringify([{
      ...validService(),
      replicas: [{ state: 'running' }],
    }])).ok).toBe(false);

    expect(parseServicesJsonStrict(JSON.stringify([{
      ...validService(),
      replicas: 'nope',
    }])).ok).toBe(false);
  });

  it('scrapeRollbackTagsLenient recovers tags from near-valid JSON', () => {
    expect(scrapeRollbackTagsLenient(JSON.stringify([{
      serviceName: 'web',
      replicas: [{ rollbackTag: 'sencho-rb/aaaaaaaaaaaa/web:hold' }],
    }]))).toEqual(['sencho-rb/aaaaaaaaaaaa/web:hold']);
  });

  it('rejects invalid referenceKind or scale', () => {
    expect(parseServicesJsonStrict(JSON.stringify([{
      ...validService(),
      referenceKind: 'mystery',
    }])).ok).toBe(false);

    expect(parseServicesJsonStrict(JSON.stringify([{
      ...validService(),
      scale: -1,
    }])).ok).toBe(false);
  });
});
