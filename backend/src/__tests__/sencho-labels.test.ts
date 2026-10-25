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
  inertOriginOf,
  mergeLabelBehavior,
  normalizeLinkName,
  parseLabelEntries,
  parseSenchoUrl,
  resolveSenchoLabels,
  sanitizeRemoteBehavior,
  unrenderableSenchoLabels,
  type LabelBehavior,
} from '../helpers/senchoLabels';
import { CAPABILITIES } from '../services/CapabilityRegistry';
import { serviceUrlFromLabels } from '../helpers/serviceUrlLabel';
import fs from 'fs';
import path from 'path';

const chr = (code: number): string => String.fromCharCode(code);

/** The resolution of a model that is expected to render; fails the test otherwise. */
function resolveRendered(rendered: unknown) {
  const resolved = resolveSenchoLabels(rendered);
  if (!resolved.renderable) throw new Error('expected a rendered model');
  return resolved;
}

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

  it('gives every definition the parser that reads its value type', () => {
    for (const def of SENCHO_LABEL_DEFINITIONS) {
      expect(typeof def.parse).toBe('function');
      const sample = def.valueType === 'url' ? 'https://a.example.com' : def.valueType === 'integer' ? '3' : 'true';
      expect(def.parse(sample).ok).toBe(true);
      expect(def.parse('definitely not valid').ok).toBe(false);
    }
  });

  it('lists every registry key, example, and summary on the public docs page', () => {
    const docs = fs.readFileSync(path.resolve(__dirname, '../../../docs/features/sencho-labels.mdx'), 'utf8');
    for (const def of SENCHO_LABEL_DEFINITIONS) {
      const key = def.match.kind === 'exact' ? def.match.key : `${def.match.prefix}<name>`;
      expect(docs, `docs page names ${key}`).toContain(key);
    }
    expect(docs).toContain(SENCHO_LABELS_CAPABILITY);
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
    ['https://app.example.com/a\tb', 'spaces or control'],
    ['https://app.example.com/a\nb', 'spaces or control'],
    [`https://app.example.com/${chr(0x202e)}gnp.exe`, 'spaces or control'],
    [`https://app.example.com/${chr(0x200b)}`, 'spaces or control'],
    [`https://app.example.com/a${chr(0x2028)}b`, 'spaces or control'],
    [`https://app.example.com/${chr(0x2066)}x`, 'spaces or control'],
    [`https://app.example.com/a${chr(0xfeff)}b`, 'spaces or control'],
    [`https://app.example.com/${chr(0x00ad)}`, 'spaces or control'],
    ['https:\\\\app.example.com', 'must start with'],
    ['https://:@app.example.com', 'username or password'],
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
    const r = resolveRendered(model({
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

  it('reports each service\'s own order value, and none for an unordered or invalid one', () => {
    const r = resolveRendered(model({
      zeta: { 'io.sencho.order': '1' },
      mid: { 'io.sencho.order': '-5' },
      bad: { 'io.sencho.order': 'soon' },
      none: {},
      big: { 'io.sencho.order': '999999999' },
    }));
    expect(Object.fromEntries(Object.entries(r.services).map(([name, labels]) => [name, labels.order])))
      .toEqual({ big: 999999999, bad: null, mid: -5, none: null, zeta: 1 });
    // The resolution carries no second copy of the presentation order.
    expect(Object.keys(r).sort()).toEqual(['entries', 'renderable', 'services']);
  });

  it('ignores an invalid value with a fixed reason and never echoes the value', () => {
    const secret = 'https://user:hunter2@app.example.com';
    const r = resolveRendered(model({
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
    const r = resolveRendered(model({
      web: { 'io.sencho.url.Docs': 'https://a.example.com', 'io.sencho.url.docs': 'https://b.example.com' },
    }));
    expect(r.services.web.links).toEqual([{ name: 'docs', url: 'https://a.example.com' }]);
    const dup = r.entries.find(e => e.key === 'io.sencho.url.docs');
    expect(dup?.state).toBe('invalid');
    expect(dup?.reason).toContain('already defines');
  });

  it('reports unknown io.sencho keys as unsupported and leaves foreign namespaces alone', () => {
    const r = resolveRendered(model({
      web: { 'io.sencho.future': '1', 'sencho.service.url': 'https://old.example.com', 'io.sencho.URL': 'x' },
    }));
    expect(r.entries.map(e => [e.key, e.state])).toEqual([
      ['io.sencho.URL', 'unsupported'],
      ['io.sencho.future', 'unsupported'],
    ]);
    expect(r.services.web.links).toEqual([]);
  });

  it('reads list syntax, numeric and boolean scalars, and the last duplicate in a list', () => {
    const r = resolveRendered(model({
      listed: ['io.sencho.url=https://a.example.com', 'io.sencho.url=https://b.example.com', 'io.sencho.hidden'],
      scalars: { 'io.sencho.order': 7, 'io.sencho.hidden': true },
    }));
    expect(r.services.listed.links).toEqual([{ name: null, url: 'https://b.example.com' }]);
    // A bare list item is an empty value, which is not a boolean.
    expect(r.services.listed.hidden).toBe(false);
    expect(r.services.scalars).toMatchObject({ order: 7, hidden: true });
  });

  it('accepts true and false in any case and rejects other spellings', () => {
    const r = resolveRendered(model({
      a: { 'io.sencho.hidden': 'TRUE' },
      b: { 'io.sencho.hidden': ' False ' },
      c: { 'io.sencho.hidden': 'yes' },
      d: { 'io.sencho.hidden': '1' },
    }));
    expect([r.services.a.hidden, r.services.b.hidden, r.services.c.hidden, r.services.d.hidden]).toEqual([true, false, false, false]);
    expect(r.entries.filter(e => e.state === 'invalid').map(e => e.service)).toEqual(['c', 'd']);
  });

  it('restores a rendered $$ to one dollar in link values only', () => {
    const r = resolveRendered(model({ web: { 'io.sencho.url': 'https://app.example.com/?a=$$b' } }));
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
    const r = resolveRendered(rendered);
    const own = (name: string) => Object.getOwnPropertyDescriptor(r.services, name)?.value as { order: number | null; hidden: boolean } | undefined;
    expect(own('constructor')?.order).toBe(2);
    expect(own('__proto__')?.hidden).toBe(true);
    expect(Object.keys(r.services).sort()).toEqual(['__proto__', 'constructor', 'toString']);
  });
});

describe('label reading', () => {
  it('reads map and list syntax through one parser, skipping empty list items and non-scalars', () => {
    expect([...parseLabelEntries({ a: 'x', b: 1, c: true, d: null, e: { nested: 1 } })]).toEqual([['a', 'x'], ['b', '1'], ['c', 'true']]);
    expect([...parseLabelEntries(['a=x', 'bare', '', 'a=y', 7])]).toEqual([['a', 'y'], ['bare', ''], ['7', '']]);
    expect(parseLabelEntries(undefined).size).toBe(0);
    expect(parseLabelEntries('nope').size).toBe(0);
  });

  it('lets the preflight reader agree with the resolver on duplicates and rendered dollars', () => {
    const listed = ['io.sencho.url=https://a.example.com', 'io.sencho.url=https://b.example.com/?x=$$y'];
    expect(serviceUrlFromLabels(listed)).toBe('https://b.example.com/?x=$y');
    expect(resolveRendered(model({ web: listed })).services.web.links[0].url).toBe('https://b.example.com/?x=$y');
    expect(serviceUrlFromLabels({ 'io.sencho.url': 'javascript:alert(1)' })).toBeNull();
    expect(serviceUrlFromLabels({ other: 'https://a.example.com' })).toBeNull();
  });

  it('unescapes every rendered dollar pair once and leaves a lone dollar', () => {
    const url = (raw: string) => resolveRendered(model({ web: { 'io.sencho.url': raw, 'io.sencho.url.docs': raw } })).services.web.links;
    expect(url('https://a.example.com/$$$$')[0].url).toBe('https://a.example.com/$$');
    expect(url('https://a.example.com/$$$')[0].url).toBe('https://a.example.com/$$');
    expect(url('https://a.example.com/$$a$$b')[1].url).toBe('https://a.example.com/$a$b');
  });

  it('reads whole-number orders within nine digits, with an optional sign', () => {
    const order = (raw: string) => resolveRendered(model({ web: { 'io.sencho.order': raw } })).services.web.order;
    expect([order('+5'), order('007'), order('-0'), order(' 12 ')]).toEqual([5, 7, -0, 12]);
    expect([order('1234567890'), order('1e3'), order('0x10'), order('')]).toEqual([null, null, null, null]);
  });

  it('keeps the interpolated value of a label that no other file sets', () => {
    // Compose resolves ${WEB_ORDER:-20} before the resolver sees the model.
    const r = resolveRendered(model({ api: { 'io.sencho.order': '20', 'io.sencho.url.docs': 'https://docs.example.com/v/1' } }));
    expect(r.services.api).toMatchObject({ order: 20, links: [{ name: 'docs', url: 'https://docs.example.com/v/1' }] });
  });
});

describe('label behavior annotations', () => {
  const resolved = resolveRendered(model({ web: { 'io.sencho.url': 'https://a.example.com', 'io.sencho.order': 'x' } }));

  it('reports declared labels by their resolved state and ignores foreign keys', () => {
    expect(declaredLabelBehavior(resolved, 'web', 'io.sencho.url')).toMatchObject({ state: 'active', summary: expect.any(String) });
    expect(declaredLabelBehavior(resolved, 'web', 'io.sencho.order')).toMatchObject({ state: 'invalid' });
    expect(declaredLabelBehavior(resolved, 'web', 'traefik.enable')).toBeUndefined();
  });

  it('treats everything as inert when the model did not render', () => {
    expect(declaredLabelBehavior(unrenderableSenchoLabels(), 'web', 'io.sencho.url')?.state).toBe('inert');
    expect(inertLabelBehavior('io.sencho.url', 'unrendered')?.state).toBe('inert');
  });

  it('explains each reason a copy is inert, with a distinct explanation', () => {
    const origins = ['image', 'runtime', 'stale-runtime', 'unknown', 'unrendered', 'node-wide'] as const;
    const reasons = origins.map(origin => {
      const behavior = inertLabelBehavior('io.sencho.url', origin);
      expect(behavior?.state).toBe('inert');
      return behavior?.reason;
    });
    expect(new Set(reasons).size).toBe(origins.length);
    expect(inertLabelBehavior('traefik.enable', 'runtime')).toBeUndefined();
  });

  it('attributes a runtime copy that differs from a declared one to a stale container', () => {
    expect(inertOriginOf('runtime', true)).toBe('stale-runtime');
    expect(inertOriginOf('runtime', false)).toBe('runtime');
    expect(inertOriginOf('image', true)).toBe('image');
    expect(inertOriginOf('compose-system', false)).toBe('unknown');
    expect(inertOriginOf('unknown', true)).toBe('unknown');
  });

  it('finds a declared label by service and key, even for a service named like an Object property', () => {
    const odd = resolveRendered(JSON.parse('{"services":{"constructor":{"labels":{"io.sencho.order":"1"}}}}') as unknown);
    expect(declaredLabelBehavior(odd, 'constructor', 'io.sencho.order')?.state).toBe('active');
    expect(declaredLabelBehavior(odd, 'toString', 'io.sencho.order')).toBeUndefined();
  });
});

describe('remote behavior sanitizing', () => {
  it('keeps an absent behavior absent, so an older node reads as not reporting', () => {
    expect(sanitizeRemoteBehavior('runtime', undefined)).toBeUndefined();
  });

  it('rebuilds a readable behavior field by field and drops extra properties', () => {
    const raw = { state: 'invalid', reason: 'Use true or false.', summary: 'Collapses a helper.', extra: { deep: 1 } };
    expect(sanitizeRemoteBehavior('compose', raw)).toEqual({ state: 'invalid', reason: 'Use true or false.', summary: 'Collapses a helper.' });
  });

  it.each([
    ['an unknown state', { state: 'trusted' }],
    ['a string', 'active'],
    ['null', null],
    ['an array', ['active']],
    ['a non-string reason', { state: 'invalid', reason: 123 }],
    ['a non-string summary', { state: 'active', summary: {} }],
    ['no state', { reason: 'x' }],
  ])('degrades %s to unsupported with a fixed reason', (_label, raw) => {
    expect(sanitizeRemoteBehavior('compose', raw)).toEqual({
      state: 'unsupported',
      reason: expect.stringContaining('cannot read'),
    });
  });

  it('forces every source other than the declared Compose copy to inert', () => {
    for (const source of ['runtime', 'image', 'unknown', 'compose-system'] as const) {
      expect(sanitizeRemoteBehavior(source, { state: 'active' })?.state).toBe('inert');
    }
    expect(sanitizeRemoteBehavior('compose', { state: 'active' })?.state).toBe('active');
  });

  it('bounds the text a remote can send', () => {
    const long = 'x'.repeat(5000);
    const out = sanitizeRemoteBehavior('compose', { state: 'invalid', reason: long, summary: long });
    expect(out?.reason?.length).toBe(240);
    expect(out?.summary?.length).toBe(240);
  });

  it('keeps the more informative behavior when two nodes report one row', () => {
    const inert: LabelBehavior = { state: 'inert', reason: 'a' };
    const invalid: LabelBehavior = { state: 'invalid', reason: 'b' };
    const active: LabelBehavior = { state: 'active' };
    expect(mergeLabelBehavior(undefined, inert)).toBe(inert);
    expect(mergeLabelBehavior(inert, undefined)).toBe(inert);
    expect(mergeLabelBehavior(active, inert)).toBe(inert);
    expect(mergeLabelBehavior(inert, active)).toBe(inert);
    expect(mergeLabelBehavior(inert, invalid)).toBe(invalid);
    expect(mergeLabelBehavior(invalid, inert)).toBe(invalid);
    expect(mergeLabelBehavior(undefined, undefined)).toBeUndefined();
  });
});
