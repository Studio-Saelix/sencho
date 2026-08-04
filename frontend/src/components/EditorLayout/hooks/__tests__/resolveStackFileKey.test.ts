import { describe, it, expect } from 'vitest';
import { resolveStackFileKey } from '../resolveStackFileKey';

describe('resolveStackFileKey', () => {
  const files = ['web.yml', 'api.yaml', 'plain'];

  it('returns an exact filename match', () => {
    expect(resolveStackFileKey(files, 'web.yml')).toBe('web.yml');
  });

  it('matches a bare name against a .yml file', () => {
    expect(resolveStackFileKey(files, 'web')).toBe('web.yml');
  });

  it('matches a bare name against a .yaml file', () => {
    expect(resolveStackFileKey(files, 'api')).toBe('api.yaml');
  });

  it('passes through when no match exists', () => {
    expect(resolveStackFileKey(files, 'missing')).toBe('missing');
  });
});
