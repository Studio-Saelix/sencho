import { describe, it, expect } from 'vitest';
import { classifyRegistryDeliveryOp } from '../helpers/registryOpClassifier';
import { classifyRegistryDeliveryRouteClass } from '../helpers/registryDeliveryBodyLimits';

describe('git-apply-auto-deploy route classification', () => {
  it('classifies git-source apply as git-apply-auto-deploy', () => {
    const result = classifyRegistryDeliveryOp(
      'POST',
      '/api/stacks/my-stack/git-source/apply',
    );
    expect(result).toEqual({
      eligible: true,
      stage: 'git-apply-auto-deploy',
      stack: 'my-stack',
    });
  });

  it('assigns bulk-label-git body budget to git-source apply', () => {
    expect(classifyRegistryDeliveryRouteClass(
      'POST',
      '/api/stacks/my-stack/git-source/apply',
    )).toBe('bulk-label-git');
  });
});
