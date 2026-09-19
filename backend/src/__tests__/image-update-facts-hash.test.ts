import { describe, expect, it } from 'vitest';
import { hashImageUpdateFacts, type ImageUpdateBoundFacts } from '../services/imageUpdateFacts';

const facts = {
  model: { renderable: true as const },
  services: [
    { name: 'web', declaredImage: 'nginx:1.27', runtimeImages: ['nginx:1.27', 'nginx:1.26'], hasBuild: false },
    { name: 'cache', declaredImage: 'redis:7', runtimeImages: ['redis:7'], hasBuild: false },
  ],
  images: [
    { ref: 'nginx:1.27', localDigests: ['sha256:bbb', 'sha256:aaa'], platform: { os: 'linux', architecture: 'amd64' }, emptyReason: 'none' as const },
    { ref: 'redis:7', localDigests: ['sha256:ccc'], platform: { os: 'linux', architecture: 'amd64' }, emptyReason: 'none' as const },
  ],
};

describe('image update observation facts hash', () => {
  const changes: Array<[string, (value: ImageUpdateBoundFacts) => void]> = [
    ['model rendering', value => { value.model = { renderable: false, code: 'effective_model_render_failed', error: 'Render failed' }; }],
    ['service name', value => { value.services[0].name = 'renamed'; }],
    ['declared image', value => { value.services[0].declaredImage = 'nginx:1.28'; }],
    ['runtime image', value => { value.services[0].runtimeImages = ['nginx:1.28']; }],
    ['build flag', value => { value.services[0].hasBuild = true; }],
    ['image reference', value => { value.images[0].ref = 'nginx:1.28'; }],
    ['local digest', value => { value.images[0].localDigests = ['sha256:changed']; }],
    ['platform OS', value => { value.images[0].platform = { os: 'windows', architecture: 'amd64' }; }],
    ['platform architecture', value => { value.images[0].platform = { os: 'linux', architecture: 'arm64' }; }],
    ['missing platform', value => { value.images[0].platform = null; }],
    ['inspection outcome', value => { value.images[0].emptyReason = 'inspect_failed'; }],
  ];

  it.each(changes)('binds changes to %s', (_name, change) => {
    const changed: ImageUpdateBoundFacts = structuredClone(facts);
    change(changed);
    expect(hashImageUpdateFacts(changed)).not.toBe(hashImageUpdateFacts(facts));
  });

  it('ignores duplicate runtime references and digests', () => {
    const duplicated = structuredClone(facts);
    duplicated.services[0].runtimeImages.push(...duplicated.services[0].runtimeImages);
    duplicated.images[0].localDigests.push(...duplicated.images[0].localDigests);
    expect(hashImageUpdateFacts(duplicated)).toBe(hashImageUpdateFacts(facts));
  });

  it('excludes registry authority and observation metadata', () => {
    const enriched = {
      ...facts, name: 'site', observationRevision: 42, observationToken: 'not-persisted',
      images: facts.images.map(image => ({
        ...image, authority: { source: 'unchecked', result: null, observedAt: Date.now() },
      })),
    };
    expect(hashImageUpdateFacts(enriched)).toBe(hashImageUpdateFacts(facts));
  });

  it('ignores collection ordering but binds local image digests', () => {
    const reordered = {
      model: facts.model,
      services: [...facts.services].reverse().map(service => ({
        ...service, runtimeImages: [...service.runtimeImages].reverse(),
      })),
      images: [...facts.images].reverse().map(image => ({
        ...image, localDigests: [...image.localDigests].reverse(),
      })),
    };
    const changed = {
      ...facts,
      images: facts.images.map(image => ({ ...image, localDigests: ['sha256:changed'] })),
    };

    expect(hashImageUpdateFacts(facts)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashImageUpdateFacts(reordered)).toBe(hashImageUpdateFacts(facts));
    expect(hashImageUpdateFacts(changed)).not.toBe(hashImageUpdateFacts(facts));
  });
});
