/**
 * Unit tests for the URL-label source authority: which compose file a service's
 * `sencho.service.url` label comes from, expressed as editability of the
 * resolved main file. A later file setting the key shadows the main file
 * whatever its value (valid, invalid, interpolated, or equal).
 */
import { describe, it, expect } from 'vitest';
import { chainFilesAroundRoot, resolveServiceUrlClearState, resolveServiceUrlEditState, serviceUrlFileFacts } from '../services/serviceUrlSource';

function state(override: string | null, services = ['web'], rootContent?: string | null): Record<string, string> {
  return resolveServiceUrlEditState({
    rootInChain: true,
    rootContent,
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
    // A bare list item sets the key to an empty value and shadows earlier files all the same.
    expect(serviceUrlFileFacts('services:\n  web:\n    labels:\n      - sencho.service.url\n')?.sets.has('web')).toBe(true);
    expect(serviceUrlFileFacts('services:\n  web:\n    labels: [sencho.service.url]\n')?.sets.has('web')).toBe(true);
    expect(serviceUrlFileFacts('services:\n  web:\n    labels:\n      other.label: x\n')?.sets.has('web')).toBe(false);
    expect(serviceUrlFileFacts('services:\n  web:\n    image: nginx\n')?.sets.has('web')).toBe(false);
  });

  it('audit F01: an interpolated list-label key is an unverifiable contribution', () => {
    // Compose resolves the key at render time: `- "${URL_LABEL}=..."` sets the
    // label when URL_LABEL names it, and the source alone cannot tell.
    const braced = 'services:\n  web:\n    labels:\n      - "${URL_LABEL}=https://later.example.com"\n';
    const bare = 'services:\n  web:\n    labels:\n      - "$URL_LABEL=https://later.example.com"\n';
    expect(serviceUrlFileFacts(braced)?.interpolated.has('web')).toBe(true);
    expect(serviceUrlFileFacts(braced)?.unknown.has('web')).toBe(false);
    expect(serviceUrlFileFacts(braced)?.sets.has('web')).toBe(false);
    expect(serviceUrlFileFacts(bare)?.interpolated.has('web')).toBe(true);
    // The uncertainty stays with the service that carries the item.
    const sibling = [
      'services:',
      '  web:',
      '    labels:',
      '      - "${URL_LABEL}=https://later.example.com"',
      '  api:',
      '    image: nginx',
      '',
    ].join('\n');
    expect(serviceUrlFileFacts(sibling)?.interpolated.has('web')).toBe(true);
    expect(serviceUrlFileFacts(sibling)?.interpolated.has('api')).toBe(false);
    // A literal key with an interpolated value is still a known set: the key
    // decides which label is written.
    const literal = 'services:\n  web:\n    labels:\n      - sencho.service.url=${APP_URL}\n';
    expect(serviceUrlFileFacts(literal)?.sets.has('web')).toBe(true);
    expect(serviceUrlFileFacts(literal)?.interpolated.has('web')).toBe(false);
    // Compose's `$$` escape writes a literal `${URL_LABEL}` key, not this label.
    const escaped = 'services:\n  web:\n    labels:\n      - "$${URL_LABEL}=https://later.example.com"\n';
    expect(serviceUrlFileFacts(escaped)?.sets.has('web')).toBe(false);
    expect(serviceUrlFileFacts(escaped)?.interpolated.has('web')).toBe(false);
    // Compose leaves map-form keys literal (`"${URL_LABEL}": value` stays that
    // exact label name), so only the list form carries the uncertainty.
    const mapForm = 'services:\n  web:\n    labels:\n      "${URL_LABEL}": https://later.example.com\n';
    expect(serviceUrlFileFacts(mapForm)?.sets.has('web')).toBe(false);
    expect(serviceUrlFileFacts(mapForm)?.interpolated.has('web')).toBe(false);
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
    const anchoredBare = [
      'x-url: &url sencho.service.url',
      'services:',
      '  web:',
      '    labels:',
      '      - *url',
      '',
    ].join('\n');
    expect(serviceUrlFileFacts(anchoredBare)?.sets.has('web')).toBe(true);
  });

  it('records services whose labels can also come from label_file', () => {
    const source = [
      'services:',
      '  web:',
      '    image: nginx',
      '    label_file:',
      '      - url.labels',
      '  api:',
      '    image: nginx',
      '',
    ].join('\n');
    const facts = serviceUrlFileFacts(source);
    expect(facts?.labelFiles.has('web')).toBe(true);
    expect(facts?.labelFiles.has('api')).toBe(false);
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

describe('chainFilesAroundRoot', () => {
  it('returns the files merged before and after the open file', () => {
    // Discovered chain: the open main file is first, the override can shadow it.
    expect(chainFilesAroundRoot(['compose.yaml', 'compose.override.yaml'], 'compose.yaml'))
      .toEqual({ rootInChain: true, earlier: [], shadowing: ['compose.override.yaml'] });
    // A file merged before the open file cannot shadow a set, but can surface after a clear.
    expect(chainFilesAroundRoot(['base.yaml', 'compose.yaml'], 'compose.yaml'))
      .toEqual({ rootInChain: true, earlier: ['base.yaml'], shadowing: [] });
    // A later file with the same basename in a subdirectory is still a shadower,
    // not the open file itself.
    expect(chainFilesAroundRoot(['base.yaml', './compose.yaml', 'prod.yaml', 'sub/compose.yaml'], 'compose.yaml'))
      .toEqual({ rootInChain: true, earlier: ['base.yaml'], shadowing: ['prod.yaml', 'sub/compose.yaml'] });
    // An open file the render does not merge is never editable.
    expect(chainFilesAroundRoot(['other.yaml'], 'compose.yaml'))
      .toEqual({ rootInChain: false, earlier: [], shadowing: [] });
    // A chain that lists the same file twice anchors at the last occurrence. The
    // same-file earlier occurrence is dropped (editing it edits both); an earlier
    // different file still counts, because it can surface after a clear.
    expect(chainFilesAroundRoot(['compose.yaml', 'prod.yaml', 'compose.yaml'], 'compose.yaml'))
      .toEqual({ rootInChain: true, earlier: ['prod.yaml'], shadowing: [] });
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

  it('audit F1: a later bare list label counts as a set key and shadows the main file', () => {
    expect(state('services:\n  web:\n    labels:\n      - sencho.service.url\n')).toEqual({ web: 'other' });
    // The anchored form resolves through the same parsed path.
    const anchored = [
      'x-url: &url sencho.service.url',
      'services:',
      '  web:',
      '    labels:',
      '      - *url',
      '',
    ].join('\n');
    expect(state(anchored)).toEqual({ web: 'other' });
  });

  it('audit case 2: a literal main label shadowed by a later file', () => {
    const override = 'services:\n  web:\n    labels:\n      sencho.service.url: https://override.example.com\n';
    expect(state(override)).toEqual({ web: 'other' });
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

  it('audit F01: a later interpolated list key refuses the set instead of reporting root', () => {
    expect(state('services:\n  web:\n    labels:\n      - "${URL_LABEL}=https://later.example.com"\n'))
      .toEqual({ web: 'unknown' });
    // A literal known key with an interpolated value still shadows like any set.
    expect(state('services:\n  web:\n    labels:\n      - sencho.service.url=${APP_URL}\n'))
      .toEqual({ web: 'other' });
    expect(state('services:\n  web:\n    labels:\n      sencho.service.url: "${APP_URL}"\n'))
      .toEqual({ web: 'other' });
  });

  it('audit F01: an interpolated list key in the open file refuses the set', () => {
    // The set replaces the literal item in place, leaving the interpolated one
    // after it. Compose reads the list into a map with later entries winning, so
    // the requested value would never be effective. It is caught before a write.
    const winning = [
      'services:',
      '  web:',
      '    labels:',
      '      - sencho.service.url=https://old.example.com',
      '      - "${URL_LABEL}=https://winning.example.com"',
      '',
    ].join('\n');
    expect(state(null, ['web'], winning)).toEqual({ web: 'unknown' });
    // Only the service carrying the item is uncertain.
    const sibling = [
      'services:',
      '  web:',
      '    labels:',
      '      - "${URL_LABEL}=https://winning.example.com"',
      '  api:',
      '    image: nginx',
      '',
    ].join('\n');
    expect(state(null, ['web', 'api'], sibling)).toEqual({ web: 'unknown', api: 'root' });
    // A `$$` escape and a map-form key stay literal, so both remain editable.
    expect(state(null, ['web'], 'services:\n  web:\n    labels:\n      - "$${URL_LABEL}=https://x.example.com"\n'))
      .toEqual({ web: 'root' });
    expect(state(null, ['web'], 'services:\n  web:\n    labels:\n      "${URL_LABEL}": https://x.example.com\n'))
      .toEqual({ web: 'root' });
    // An unreadable open file cannot be ruled out either: it is refused, the
    // same direction as an unreadable later file.
    expect(state(null, ['web'], null)).toEqual({ web: 'unknown' });
    // A top-level `include` does not block a set, but it makes the whole-file
    // facts null, so the interpolated item must be read independently.
    const included = [
      'include:',
      '  - common.yaml',
      'services:',
      '  web:',
      '    labels:',
      '      - "${URL_LABEL}=https://winning.example.com"',
      '',
    ].join('\n');
    expect(state(null, ['web'], included)).toEqual({ web: 'unknown' });
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

describe('resolveServiceUrlClearState', () => {
  const root = 'services:\n  web:\n    labels:\n      sencho.service.url: https://root.example.com\n';

  function clear(args: {
    rootContent?: string | null;
    rootInChain?: boolean;
    earlier?: Array<string | null>;
    later?: Array<string | null>;
    services?: string[];
  } = {}): Record<string, string> {
    return resolveServiceUrlClearState({
      rootInChain: args.rootInChain ?? true,
      rootContent: args.rootContent === undefined ? root : args.rootContent,
      earlierFiles: (args.earlier ?? []).map((content, index) => ({ name: `base${index}.yaml`, content })),
      otherFiles: (args.later ?? []).map((content, index) => ({ name: `later${index}.yaml`, content })),
      services: args.services ?? ['web'],
    });
  }

  it('allows a clear when the open file is the only contributor', () => {
    expect(clear()).toEqual({ web: 'root' });
  });

  it('audit F2: refuses a clear that would surface an earlier compose file', () => {
    expect(clear({ earlier: ['services:\n  web:\n    labels:\n      sencho.service.url: https://base.example.com\n'] }))
      .toEqual({ web: 'other' });
    // A bare earlier label (empty value) is still a contribution that keeps the clear from taking effect.
    expect(clear({ earlier: ['services:\n  web:\n    labels:\n      - sencho.service.url\n'] }))
      .toEqual({ web: 'other' });
  });

  it('refuses a clear that a later compose file would keep winning', () => {
    expect(clear({ later: ['services:\n  web:\n    labels:\n      sencho.service.url: https://later.example.com\n'] }))
      .toEqual({ web: 'other' });
  });

  it('audit F01: an interpolated list key blocks the clear at either end of the chain', () => {
    const braced = 'services:\n  web:\n    labels:\n      - "${URL_LABEL}=https://other.example.com"\n';
    expect(clear({ earlier: [braced] })).toEqual({ web: 'unknown' });
    expect(clear({ later: [braced] })).toEqual({ web: 'unknown' });
    // The interpolated item survives the patch helper's literal removal, so a
    // literal label beside it in the open file does not make the clear safe.
    expect(clear({
      rootContent: [
        'services:',
        '  web:',
        '    labels:',
        '      - sencho.service.url=https://root.example.com',
        '      - "${URL_LABEL}=https://other.example.com"',
        '',
      ].join('\n'),
    })).toEqual({ web: 'unknown' });
    // A literal key with an interpolated value is removed as a whole item.
    expect(clear({ rootContent: 'services:\n  web:\n    labels:\n      - sencho.service.url=${APP_URL}\n' }))
      .toEqual({ web: 'root' });
  });

  it('audit F2: refuses a clear when the open service inherits through extends, include, or label_file', () => {
    expect(clear({ rootContent: 'services:\n  web:\n    extends:\n      service: base\n' })).toEqual({ web: 'unknown' });
    expect(clear({ rootContent: 'services:\n  web:\n    image: nginx\n    label_file:\n      - url.labels\n' })).toEqual({ web: 'unknown' });
    expect(clear({ rootContent: 'include:\n  - common.yaml\nservices:\n  web:\n    image: nginx\n' })).toEqual({ web: 'unknown' });
  });

  it('refuses a clear when any chain file cannot be established', () => {
    expect(clear({ earlier: [null] })).toEqual({ web: 'unknown' });
    expect(clear({ later: [null] })).toEqual({ web: 'unknown' });
    expect(clear({ rootContent: null })).toEqual({ web: 'unknown' });
    expect(clear({ earlier: ['services:\n  web:\n    extends:\n      service: base\n'] })).toEqual({ web: 'unknown' });
    expect(clear({ earlier: ['services:\n  web:\n    image: nginx\n    label_file:\n      - url.labels\n'] })).toEqual({ web: 'unknown' });
    expect(clear({ later: ['services:\n  web:\n    label_file:\n      - url.labels\n'] })).toEqual({ web: 'unknown' });
  });

  it('reports every service unknown when the open file is not part of the chain', () => {
    expect(clear({ rootInChain: false, services: ['web', 'api'] })).toEqual({ web: 'unknown', api: 'unknown' });
  });

  it('does not let the open file block its own clear', () => {
    expect(clear({
      rootContent: [
        'services:',
        '  web:',
        '    labels:',
        '      sencho.service.url: https://root.example.com',
        '  api:',
        '    labels:',
        '      sencho.service.url: https://api.example.com',
        '',
      ].join('\n'),
      services: ['web', 'api'],
    })).toEqual({ web: 'root', api: 'root' });
  });

  it('keys the clear state map safely for service names that shadow Object properties', () => {
    const states = clear({
      services: [],
      later: ['services:\n  constructor:\n    labels:\n      sencho.service.url: https://c.example.com\n  __proto__:\n    labels:\n      sencho.service.url: https://p.example.com\n'],
    });
    expect(states.constructor).toBe('other');
    expect(states.__proto__).toBe('other');
  });
});
