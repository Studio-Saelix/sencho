/**
 * Unit tests for the URL-label source authority: which compose file a service's
 * `sencho.service.url` label comes from, expressed as editability of the
 * resolved main file. A later file setting the key shadows the main file
 * whatever its value (valid, invalid, interpolated, or equal).
 */
import { describe, it, expect } from 'vitest';
import { chainFilesShadowsRoot, resolveServiceUrlEditState, serviceUrlFileFacts } from '../services/serviceUrlSource';

function state(override: string | null, services = ['web']): Record<string, string> {
  return resolveServiceUrlEditState({
    rootInChain: true,
    otherFiles: override === null ? [] : [{ name: 'compose.override.yaml', content: override }],
    services,
  });
}

describe('serviceUrlFileFacts', () => {
  it('reads map-form and list-form labels as set keys, with or without a valid value', () => {
    expect(serviceUrlFileFacts('services:\n  web:\n    labels:\n      sencho.service.url: not-a-url\n')?.sets.has('web')).toBe(true);
    expect(serviceUrlFileFacts('services:\n  web:\n    labels:\n      sencho.service.url:\n')?.sets.has('web')).toBe(true);
    expect(serviceUrlFileFacts('services:\n  web:\n    labels:\n      - sencho.service.url=https://app.example.com\n')?.sets.has('web')).toBe(true);
    expect(serviceUrlFileFacts('services:\n  web:\n    labels:\n      - sencho.service.url=\n')?.sets.has('web')).toBe(true);
    expect(serviceUrlFileFacts('services:\n  web:\n    labels:\n      other.label: x\n')?.sets.has('web')).toBe(false);
    expect(serviceUrlFileFacts('services:\n  web:\n    image: nginx\n')?.sets.has('web')).toBe(false);
  });

  it('resolves anchors and merge keys to a set key', () => {
    const source = [
      'x-labels: &labels',
      '  sencho.service.url: https://app.example.com',
      'services:',
      '  web:',
      '    labels: *labels',
      '',
    ].join('\n');
    expect(serviceUrlFileFacts(source)?.sets.has('web')).toBe(true);
  });

  it('is unverifiable for a top-level include, a custom tag, or malformed YAML', () => {
    expect(serviceUrlFileFacts('include:\n  - sub.yaml\nservices:\n  web:\n    image: nginx\n')).toBeNull();
    expect(serviceUrlFileFacts('services:\n  web:\n    labels: !reset []\n')).toBeNull();
    expect(serviceUrlFileFacts('services: [unclosed')).toBeNull();
  });

  it('marks a service with extends unknown without poisoning its siblings', () => {
    const source = [
      'services:',
      '  web:',
      '    extends:',
      '      file: common.yaml',
      '      service: base',
      '  api:',
      '    labels:',
      '      sencho.service.url: https://api.example.com',
      '',
    ].join('\n');
    const facts = serviceUrlFileFacts(source);
    expect(facts?.unknown.has('web')).toBe(true);
    expect(facts?.sets.has('api')).toBe(true);
    expect(facts?.sets.has('web')).toBe(false);
  });
});

describe('chainFilesShadowsRoot', () => {
  it('returns only the files merged after the open file', () => {
    // Discovered chain: the open main file is first, the override can shadow it.
    expect(chainFilesShadowsRoot(['compose.yaml', 'compose.override.yaml'], 'compose.yaml'))
      .toEqual({ rootInChain: true, shadowing: ['compose.override.yaml'] });
    // A file merged before the open file cannot shadow it.
    expect(chainFilesShadowsRoot(['base.yaml', 'compose.yaml'], 'compose.yaml'))
      .toEqual({ rootInChain: true, shadowing: [] });
    // A later file with the same basename in a subdirectory is still a shadower,
    // not the open file itself.
    expect(chainFilesShadowsRoot(['base.yaml', './compose.yaml', 'prod.yaml', 'sub/compose.yaml'], 'compose.yaml'))
      .toEqual({ rootInChain: true, shadowing: ['prod.yaml', 'sub/compose.yaml'] });
    // An open file the render does not merge is never editable.
    expect(chainFilesShadowsRoot(['other.yaml'], 'compose.yaml'))
      .toEqual({ rootInChain: false, shadowing: [] });
    // A chain that lists the same file twice anchors at the last occurrence, so
    // the file is not treated as its own shadower.
    expect(chainFilesShadowsRoot(['compose.yaml', 'prod.yaml', 'compose.yaml'], 'compose.yaml'))
      .toEqual({ rootInChain: true, shadowing: [] });
  });
});

describe('resolveServiceUrlEditState', () => {
  it('leaves every service editable when no other file sets the key', () => {
    expect(state(null)).toEqual({ web: 'root' });
    expect(state('services:\n  web:\n    image: nginx\n')).toEqual({ web: 'root' });
    expect(state('services:\n  api:\n    labels:\n      sencho.service.url: https://api.example.com\n', ['web'])).toEqual({ web: 'root', api: 'other' });
  });

  it('audit case 1: an invalid later label still shadows the main file', () => {
    expect(state('services:\n  web:\n    labels:\n      sencho.service.url: not-a-url\n')).toEqual({ web: 'other' });
  });

  it('audit case 2: an interpolated main label shadowed by a later file', () => {
    const override = 'services:\n  web:\n    labels:\n      sencho.service.url: https://override.example.com\n';
    expect(state(override)).toEqual({ web: 'other' });
    // The positive twin: the same interpolation with no later setter stays editable.
    expect(state(null)).toEqual({ web: 'root' });
  });

  it('audit case 3: equal labels in both layers still shadow the main file', () => {
    expect(state('services:\n  web:\n    labels:\n      sencho.service.url: https://same.example.com\n')).toEqual({ web: 'other' });
  });

  it('refuses unverifiable later files instead of guessing', () => {
    expect(state(null, ['web'])).toEqual({ web: 'root' });
    expect(resolveServiceUrlEditState({
      rootInChain: true,
      otherFiles: [{ name: 'compose.override.yaml', content: null }],
      services: ['web'],
    })).toEqual({ web: 'unknown' });
    expect(state('include:\n  - sub.yaml\nservices:\n  web:\n    image: nginx\n')).toEqual({ web: 'unknown' });
    expect(state('services:\n  web:\n    labels: !override []\n')).toEqual({ web: 'unknown' });
    expect(state('services:\n  web:\n    extends:\n      file: common.yaml\n      service: base\n')).toEqual({ web: 'unknown' });
  });

  it('reports every service unknown when the open file is not part of the chain', () => {
    expect(resolveServiceUrlEditState({
      rootInChain: false,
      otherFiles: [{ name: 'compose.override.yaml', content: 'services:\n  web:\n    image: nginx\n' }],
      services: ['web', 'api'],
    })).toEqual({ web: 'unknown', api: 'unknown' });
  });

  it('keys the state map safely for service names that shadow Object properties', () => {
    const states = state('services:\n  constructor:\n    labels:\n      sencho.service.url: https://c.example.com\n  __proto__:\n    labels:\n      sencho.service.url: https://p.example.com\n', []);
    expect(Object.keys(states).sort()).toEqual(['__proto__', 'constructor']);
    expect(states.constructor).toBe('other');
    expect(states.__proto__).toBe('other');
  });
});
