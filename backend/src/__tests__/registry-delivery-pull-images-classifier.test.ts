import { describe, it, expect } from 'vitest';
import { classifyRegistryDeliveryOp } from '../helpers/registryOpClassifier';
import { classifyRegistryDeliveryRouteClass } from '../helpers/registryDeliveryBodyLimits';
import { buildRegistryDiscoverPayload } from '../helpers/registryDeliveryDiscoverPayload';

const PATH = '/api/stacks/my-stack/pull-images';

describe('pull-images registry delivery classification', () => {
  // Both classifiers gate the hop independently: the proxy's outer gate reads
  // the op classifier, and the body budget is required alongside it. Missing
  // either one silently forwards the request with no credentials attached, so
  // each is asserted on its own.
  it('classifies pull-images as a stack-pull-images delivery op', () => {
    expect(classifyRegistryDeliveryOp('POST', PATH)).toEqual({
      eligible: true,
      stage: 'stack-pull-images',
      stack: 'my-stack',
    });
  });

  it('assigns the stack-deploy-update body budget to pull-images', () => {
    expect(classifyRegistryDeliveryRouteClass('POST', PATH)).toBe('stack-deploy-update');
  });

  it('leaves reads ineligible, since delivery only augments mutations', () => {
    expect(classifyRegistryDeliveryOp('GET', PATH).eligible).toBe(false);
    expect(classifyRegistryDeliveryRouteClass('GET', PATH)).toBeNull();
  });

  // The route sends no request body, so the stack name can only reach the
  // remote through the URL match. If that regresses, the remote rejects
  // discovery with an invalid stack name instead of delivering credentials.
  it('resolves the stack from the URL for a bodyless pull', () => {
    expect(buildRegistryDiscoverPayload({ method: 'POST', apiPath: PATH, body: {} })).toMatchObject({
      stack: 'my-stack',
      op: 'stack-pull-images',
      sourceKind: 'live-project',
    });
  });

  it('does not treat a similarly named stack as a pull-images op', () => {
    expect(classifyRegistryDeliveryOp('POST', '/api/stacks/my-stack/pull-images-extra').eligible).toBe(false);
  });

  // Express routes the slashed form to the same handler, so the two gates have to
  // agree on it. When they disagreed the request was forwarded with no
  // credentials and failed late with an opaque "unauthorized".
  it.each([
    ['deploy', 'stack-deploy'],
    ['update', 'stack-update'],
    ['pull-update', 'stack-pull-update'],
    ['pull-images', 'stack-pull-images'],
    ['rollback', 'stack-deploy'],
  ])('agrees with the body classifier on the slashed %s form', (verb, stage) => {
    const slashed = `/api/stacks/my-stack/${verb}/`;
    expect(classifyRegistryDeliveryOp('POST', slashed)).toMatchObject({ eligible: true, stage, stack: 'my-stack' });
    expect(classifyRegistryDeliveryRouteClass('POST', slashed)).toBe('stack-deploy-update');
  });

  it('agrees with the body classifier on the slashed service-scoped forms', () => {
    for (const verb of ['update', 'pull-update']) {
      const slashed = `/api/stacks/my-stack/services/web/${verb}/`;
      expect(classifyRegistryDeliveryOp('POST', slashed).eligible).toBe(true);
      expect(classifyRegistryDeliveryRouteClass('POST', slashed)).toBe('stack-deploy-update');
    }
  });

  // Eligibility alone is not enough for rollback: its discover payload branches on
  // the raw path, so a widened classifier with an un-widened branch would answer a
  // slashed rollback with credentials for the live project instead of the restore
  // candidate. That fails late and quietly, because the action-set hash is the
  // same either way.
  it('keeps a slashed rollback on the restore-candidate source, not the live project', () => {
    const slashed = '/api/stacks/my-stack/rollback/';
    expect(buildRegistryDiscoverPayload({ method: 'POST', apiPath: slashed, body: {} })).toMatchObject({
      op: 'stack-deploy',
      sourceKind: 'restore-candidate',
      restoreVariant: 'backup',
    });
  });

  it('discovers an unslashed rollback the same way', () => {
    const plain = '/api/stacks/my-stack/rollback';
    expect(buildRegistryDiscoverPayload({ method: 'POST', apiPath: plain, body: {} })).toMatchObject({
      sourceKind: 'restore-candidate',
      restoreVariant: 'backup',
    });
  });
});
