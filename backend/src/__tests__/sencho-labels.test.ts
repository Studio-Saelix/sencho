/**
 * The io.sencho.* label contract: registry shape, value validation, and the
 * trusted resolver. Every case asserts what an operator observes (which links,
 * order, and hidden state become active, and what is reported instead), not
 * how the resolver walks the model.
 */
import { describe, it, expect } from 'vitest';
import {
  SENCHO_LABEL_DEFINITIONS,
  SENCHO_LABELS_CAPABILITY,
  declaredLabelBehavior,
  findSenchoLabelDefinition,
  inertLabelBehavior,
  normalizeLinkName,
  parseSenchoUrl,
  resolveSenchoLabels,
  unrenderableSenchoLabels,
} from '../helpers/senchoLabels';
import { CAPABILITIES } from '../services/CapabilityRegistry';

function model(services: Record<string, unknown>): unknown {
  return { name: 'demo', services: Object.fromEntries(Object.entries(services).map(([n, labels]) => [n, { labels }])) };
}

describe('registry', () => {
  it('declares one definition per id, all service scoped, presentation only, and capability gated', () => {
    const ids = SENCHO_LABEL_DEFINITIONS.map(d => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const def of SENCHO_LABEL_DEFINITIONS) {
      expect(def.scope).toBe('service');
      expect(def.effect).toBe('presentation');
      expect(def.onInvalid).toBe('ignore-with-diagnostic');
      expect(def.summary.length).toBeGreaterThan(0);
      expect(def.example.startsWith('io.sencho.')).toBe(true);
    }
    expect(CAPABILITIES).toContain(SENCHO_LABELS_CAPABILITY);
  });

  it('routes keys to their definition and leaves foreign keys unmatched', () => {
    expect(findSenchoLabelDefinition('io.sencho.url')?.id).toBe('url');
    expect(findSenchoLabelDefinition('io.sencho.url.docs')?.id).toBe('url-named');
    expect(findSenchoLabelDefinition('io.sencho.order')?.id).toBe('order');
    expect(findSenchoLabelDefinition('io.sencho.hidden')?.id).toBe('hidden');
    expect(findSenchoLabelDefinition('io.sencho.unknown')).toBeNull();
    expect(findSenchoLabelDefinition('sencho.service.url')).toBeNull();
    expect(findSenchoLabelDefinition('com.docker.compose.service')).toBeNull();
  });
});

describe('parseSenchoUrl', () => {
  it.each([
    'https://app.example.com',
    'http://192.168.1.50:8080/web?x=1#top',
    '  https://app.example.com/path  ',
  ])('accepts %s', (value) => {
    expect(parseSenchoUrl(value).ok).toBe(true);
  });

  it.each([
    ['javascript:alert(1)', 'Only http and https'],
    ['data:text/html,<b>x</b>', 'Only http and https'],
    ['file:///etc/passwd', 'Only http and https'],
    ['ftp://files.example.com', 'Only http and https'],
    ['https://user:pass@app.example.com', 'username or password'],
    ['https://user@app.example.com', 'username or password'],
    ['/relative/path', 'not a valid URL'],
    ['https://', 'not a valid URL'],
    ['https:app.example.com', 'must start with'],
    ['https://app.example.com/a b', 'spaces or control'],
    ['https://app.example.com/\u0007', 'spaces or control'],
    ['https://app.example.com/\u0085', 'spaces or control'],
    ['', 'empty'],
    [`https://app.example.com/${'a'.repeat(2100)}`, 'too long'],
  ])('rejects %j', (value, reason) => {
    const result = parseSenchoUrl(value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(reason);
  });
});

describe('normalizeLinkName', () => {
  it('lowercases and accepts letters, digits, and inner hyphens', () => {
    expect(normalizeLinkName('Docs')).toEqual({ ok: true, value: 'docs' });
    expect(normalizeLinkName('admin-2')).toEqual({ ok: true, value: 'admin-2' });
  });
  it.each(['', '-a', 'a-', 'a.b', 'a b', 'a_b', 'x'.repeat(33), '<b>'])('rejects %j', (name) => {
    expect(normalizeLinkName(name).ok).toBe(false);
  });
});

describe('resolveSenchoLabels', () => {
  it('activates links, order, and hidden for each service independently', () => {
    const r = resolveSenchoLabels(model({
      web: {
        'io.sencho.url': 'https://app.example.com',
        'io.sencho.url.docs': 'https://docs.example.com',
        'io.sencho.url.admin': 'https://admin.example.com',
        'io.sencho.order': '10',
      },
      redis: { 'io.sencho.hidden': 'true', 'io.sencho.order': '20' },
      plain: { 'traefik.enable': 'true' },
    }));
    expect(r.renderable).toBe(true);
    expect(r.services.web.links).toEqual([
      { name: null, url: 'https://app.example.com' },
      { name: 'admin', url: 'https://admin.example.com' },
      { name: 'docs', url: 'https://docs.example.com' },
    ]);
    expect(r.services.web.order).toBe(10);
    expect(r.services.redis.hidden).toBe(true);
    expect(r.services.plain).toEqual({ links: [], order: null, hidden: false });
    expect(r.entries.every(e => e.state === 'active')).toBe(true);
  });

  it('orders by value, then name, with unordered and invalid services last by name', () => {
    const r = resolveSenchoLabels(model({
      zeta: { 'io.sencho.order': '1' },
      alpha: { 'io.sencho.order': '1' },
      mid: { 'io.sencho.order': '-5' },
      bad: { 'io.sencho.order': 'soon' },
      none: {},
      big: { 'io.sencho.order': '999999999' },
    }));
    expect(r.serviceOrder).toEqual(['mid', 'alpha', 'zeta', 'big', 'bad', 'none']);
  });

  it('ignores an invalid value with a fixed reason and never echoes the value', () => {
    const secret = 'https://user:hunter2@app.example.com';
    const r = resolveSenchoLabels(model({
      web: { 'io.sencho.url': secret, 'io.sencho.hidden': 'maybe', 'io.sencho.order': '1.5' },
    }));
    expect(r.services.web).toEqual({ links: [], order: null, hidden: false });
    expect(r.entries.map(e => [e.key, e.state])).toEqual([
      ['io.sencho.hidden', 'invalid'],
      ['io.sencho.order', 'invalid'],
      ['io.sencho.url', 'invalid'],
    ]);
    expect(JSON.stringify(r)).not.toContain('hunter2');
    expect(JSON.stringify(r)).not.toContain('maybe');
  });

  it('keeps the key that sorts first when two named links normalize to one name', () => {
    const r = resolveSenchoLabels(model({
      web: { 'io.sencho.url.Docs': 'https://a.example.com', 'io.sencho.url.docs': 'https://b.example.com' },
    }));
    expect(r.services.web.links).toEqual([{ name: 'docs', url: 'https://a.example.com' }]);
    const dup = r.entries.find(e => e.key === 'io.sencho.url.docs');
    expect(dup?.state).toBe('invalid');
    expect(dup?.reason).toContain('already defines');
  });

  it('reports unknown io.sencho keys as unsupported and leaves foreign namespaces alone', () => {
    const r = resolveSenchoLabels(model({
      web: { 'io.sencho.future': '1', 'sencho.service.url': 'https://old.example.com', 'io.sencho.URL': 'x' },
    }));
    expect(r.entries.map(e => [e.key, e.state])).toEqual([
      ['io.sencho.URL', 'unsupported'],
      ['io.sencho.future', 'unsupported'],
    ]);
    expect(r.services.web.links).toEqual([]);
  });

  it('reads list syntax, numeric and boolean scalars, and the last duplicate in a list', () => {
    const r = resolveSenchoLabels(model({
      listed: ['io.sencho.url=https://a.example.com', 'io.sencho.url=https://b.example.com', 'io.sencho.hidden'],
      scalars: { 'io.sencho.order': 7, 'io.sencho.hidden': true },
    }));
    expect(r.services.listed.links).toEqual([{ name: null, url: 'https://b.example.com' }]);
    // A bare list item is an empty value, which is not a boolean.
    expect(r.services.listed.hidden).toBe(false);
    expect(r.services.scalars).toMatchObject({ order: 7, hidden: true });
  });

  it('accepts true and false in any case and rejects other spellings', () => {
    const r = resolveSenchoLabels(model({
      a: { 'io.sencho.hidden': 'TRUE' },
      b: { 'io.sencho.hidden': ' False ' },
      c: { 'io.sencho.hidden': 'yes' },
      d: { 'io.sencho.hidden': '1' },
    }));
    expect([r.services.a.hidden, r.services.b.hidden, r.services.c.hidden, r.services.d.hidden]).toEqual([true, false, false, false]);
    expect(r.entries.filter(e => e.state === 'invalid').map(e => e.service)).toEqual(['c', 'd']);
  });

  it('restores a rendered $$ to one dollar in link values only', () => {
    const r = resolveSenchoLabels(model({ web: { 'io.sencho.url': 'https://app.example.com/?a=$$b' } }));
    expect(r.services.web.links[0].url).toBe('https://app.example.com/?a=$b');
  });

  it('fails closed on a model that is not a rendered Compose model', () => {
    for (const bad of [null, undefined, 'x', 3, {}, { services: [] }, { services: 'x' }]) {
      expect(resolveSenchoLabels(bad)).toEqual(unrenderableSenchoLabels());
    }
    expect(unrenderableSenchoLabels().renderable).toBe(false);
  });

  it('keeps service names that shadow Object properties as own keys', () => {
    const rendered = JSON.parse('{"services":{"constructor":{"labels":{"io.sencho.order":"2"}},"__proto__":{"labels":{"io.sencho.hidden":"true"}},"toString":{}}}') as unknown;
    const r = resolveSenchoLabels(rendered);
    const own = (name: string) => Object.getOwnPropertyDescriptor(r.services, name)?.value as { order: number | null; hidden: boolean } | undefined;
    expect(own('constructor')?.order).toBe(2);
    expect(own('__proto__')?.hidden).toBe(true);
    expect(r.serviceOrder).toEqual(['constructor', '__proto__', 'toString']);
  });
});

describe('label behavior annotations', () => {
  const resolved = resolveSenchoLabels(model({ web: { 'io.sencho.url': 'https://a.example.com', 'io.sencho.order': 'x' } }));

  it('reports declared labels by their resolved state and ignores foreign keys', () => {
    expect(declaredLabelBehavior(resolved, 'web', 'io.sencho.url')).toMatchObject({ state: 'active', summary: expect.any(String) });
    expect(declaredLabelBehavior(resolved, 'web', 'io.sencho.order')).toMatchObject({ state: 'invalid' });
    expect(declaredLabelBehavior(resolved, 'web', 'traefik.enable')).toBeUndefined();
  });

  it('treats everything as inert when the model did not render', () => {
    expect(declaredLabelBehavior(unrenderableSenchoLabels(), 'web', 'io.sencho.url')?.state).toBe('inert');
    expect(inertLabelBehavior('io.sencho.url', 'compose', false)?.state).toBe('inert');
  });

  it('explains why image, runtime, and unknown copies are inert', () => {
    for (const source of ['image', 'runtime', 'unknown', 'compose-system']) {
      const behavior = inertLabelBehavior('io.sencho.url', source, true);
      expect(behavior?.state).toBe('inert');
      expect(behavior?.reason?.length).toBeGreaterThan(0);
    }
    expect(inertLabelBehavior('traefik.enable', 'runtime', true)).toBeUndefined();
  });
});
