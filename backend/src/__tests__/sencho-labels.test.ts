/**
 * The io.sencho.* label contract: registry shape, value validation, and the
 * trusted resolver. Every case asserts what an operator observes (which links,
 * order, and hidden state become active, and what is reported instead), not
 * how the resolver walks the model.
 */
import { describe, it, expect } from 'vitest';
import {
  MANAGED_LABEL_DECLARED_REASON,
  MANAGED_LABEL_DEPLOYED_REASON,
  SENCHO_INFRASTRUCTURE_LABEL,
  SENCHO_LABEL_DEFINITIONS,
  SENCHO_LABELS_CAPABILITY,
  SENCHO_MANAGED_LABELS,
  declaredLabelBehavior,
  deployedCopyBehavior,
  findSenchoLabelDefinition,
  inertOriginOf,
  isDeployedTrustedLabel,
  isManagedSenchoLabel,
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

/** Every non-test TypeScript file under backend/src, for the registry coverage scan. */
function backendSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(full);
      } else if (entry.name.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(path.resolve(__dirname, '..'));
  return out;
}

describe('registry', () => {
  it('declares one definition per id, all service scoped, and capability gated', () => {
    const ids = SENCHO_LABEL_DEFINITIONS.map(d => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const def of SENCHO_LABEL_DEFINITIONS) {
      expect(def.scope).toBe('service');
      // A protective label may fail closed instead of being ignored.
      expect(['ignore-with-diagnostic', 'restrict-unattended']).toContain(def.onInvalid);
      expect(def.summary.length).toBeGreaterThan(0);
      expect(def.example.startsWith('io.sencho.')).toBe(true);
      expect(['compose', 'compose-or-deployed']).toContain(def.trust);
    }
    // Presentation is the rule; the protective label and the two behavioral ones
    // are the documented exceptions.
    expect(SENCHO_LABEL_DEFINITIONS.filter(d => d.effect !== 'presentation').map(d => d.id))
      .toEqual(['infrastructure', 'update', 'notify-route']);
    expect(CAPABILITIES).toContain(SENCHO_LABELS_CAPABILITY);
  });

  it('reads a deployed copy of only the protective label', () => {
    expect(SENCHO_LABEL_DEFINITIONS.filter(d => d.trust === 'compose-or-deployed').map(d => d.id)).toEqual(['infrastructure']);
    expect(isDeployedTrustedLabel(SENCHO_INFRASTRUCTURE_LABEL)).toBe(true);
    for (const key of ['io.sencho.url', 'io.sencho.url.docs', 'io.sencho.order', 'io.sencho.hidden']) {
      expect(isDeployedTrustedLabel(key)).toBe(false);
    }
    for (const key of SENCHO_MANAGED_LABELS) expect(isDeployedTrustedLabel(key)).toBe(false);
  });

  it('gives every definition the parser that reads its value type', () => {
    for (const def of SENCHO_LABEL_DEFINITIONS) {
      expect(typeof def.parse).toBe('function');
      const sample = def.valueType === 'url' ? 'https://a.example.com'
        : def.valueType === 'integer' ? '3'
        : def.valueType === 'enum' ? 'auto'
        : def.valueType === 'routing-key' ? 'production'
        : 'true';
      expect(def.parse(sample).ok).toBe(true);
      expect(def.parse('definitely not valid').ok).toBe(false);
    }
  });

  it('lists every registry key and every key Sencho sets itself on the public docs page', () => {
    const docs = fs.readFileSync(path.resolve(__dirname, '../../../docs/features/sencho-labels.mdx'), 'utf8');
    for (const def of SENCHO_LABEL_DEFINITIONS) {
      const key = def.match.kind === 'exact' ? def.match.key : `${def.match.prefix}<name>`;
      expect(docs, `docs page names ${key}`).toContain(key);
    }
    for (const key of SENCHO_MANAGED_LABELS) expect(docs, `docs page names ${key}`).toContain(key);
    expect(docs).toContain(SENCHO_LABELS_CAPABILITY);
  });

  it('knows every io.sencho key named in backend source', () => {
    // Every Sencho label is either a registry definition or one Sencho stamps itself,
    // so a new key cannot ship without declaring which it is.
    const keys = new Set<string>();
    for (const file of backendSourceFiles()) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(/io\.sencho\.[A-Za-z0-9._-]+/g)) {
        keys.add(match[0].replace(/[.-]+$/, ''));
      }
    }
    expect(keys.size).toBeGreaterThan(0);
    // A key is known when a definition owns it (exact, or the named-link prefix), when Sencho
    // stamps it, or when it is the bare namespace that comments and the constant spell.
    const unregistered = [...keys].filter(key =>
      key !== 'io.sencho' && !isManagedSenchoLabel(key) && findSenchoLabelDefinition(key) === null);
    expect(unregistered).toEqual([]);
  });

  it('agrees with the Docker endpoint guard on the accepted infrastructure value', async () => {
    const { readInfrastructureLabels } = await import('../helpers/dockerEndpointGuard');
    const def = findSenchoLabelDefinition(SENCHO_INFRASTRUCTURE_LABEL);
    expect(def).not.toBeNull();
    if (!def) return;
    for (const value of ['true', 'True', 'TRUE', ' true', 'true ', '1', 'yes', 'false', '']) {
      const rendered = `services:\n  web:\n    labels:\n      ${SENCHO_INFRASTRUCTURE_LABEL}: "${value}"\n`;
      const { marked, invalid } = readInfrastructureLabels(rendered);
      const parsed = def.parse(value).ok;
      expect(marked.includes('web'), `guard marks ${JSON.stringify(value)}`).toBe(parsed);
      expect(invalid.some(entry => entry.service === 'web')).toBe(!parsed);
    }
  });

  it('routes keys to their definition and leaves foreign keys unmatched', () => {
    expect(findSenchoLabelDefinition('io.sencho.url')?.id).toBe('url');
    expect(findSenchoLabelDefinition('io.sencho.url.docs')?.id).toBe('url-named');
    expect(findSenchoLabelDefinition('io.sencho.order')?.id).toBe('order');
    expect(findSenchoLabelDefinition('io.sencho.hidden')?.id).toBe('hidden');
    expect(findSenchoLabelDefinition(SENCHO_INFRASTRUCTURE_LABEL)?.id).toBe('infrastructure');
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
    expect(r.services.plain).toEqual({ links: [], order: null, hidden: false, update: null, notifyRoute: null });
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
    expect(r.services.web).toEqual({ links: [], order: null, hidden: false, update: null, notifyRoute: null });
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
    expect(deployedCopyBehavior('io.sencho.url', 'https://a.example.com', 'unrendered')?.state).toBe('inert');
  });

  it('explains each reason a copy is inert, with a distinct explanation', () => {
    const origins = ['image', 'runtime', 'stale-runtime', 'unknown', 'unrendered', 'node-wide', 'sencho-managed'] as const;
    const reasons = origins.map(origin => {
      const behavior = deployedCopyBehavior('io.sencho.url', 'x', origin);
      expect(behavior?.state).toBe('inert');
      return behavior?.reason;
    });
    expect(new Set(reasons).size).toBe(origins.length);
    expect(deployedCopyBehavior('traefik.enable', 'x', 'runtime')).toBeUndefined();
  });

  it('marks a declared infrastructure label active only for exactly true', () => {
    const marked = resolveRendered(model({ web: { [SENCHO_INFRASTRUCTURE_LABEL]: 'true' }, bad: { [SENCHO_INFRASTRUCTURE_LABEL]: 'True' } }));
    expect(declaredLabelBehavior(marked, 'web', SENCHO_INFRASTRUCTURE_LABEL)).toMatchObject({
      state: 'active',
      summary: expect.stringContaining('Docker connection'),
    });
    const invalid = declaredLabelBehavior(marked, 'bad', SENCHO_INFRASTRUCTURE_LABEL);
    expect(invalid?.state).toBe('invalid');
    expect(invalid?.reason).toContain('The only accepted value is true');
    // The protective label changes no presentation metadata.
    expect(marked.services.web).toEqual({ links: [], order: null, hidden: false, update: null, notifyRoute: null });
  });

  it('reports a deployed infrastructure copy as the guard reads it, not as inert', () => {
    expect(deployedCopyBehavior(SENCHO_INFRASTRUCTURE_LABEL, 'true', 'runtime')).toMatchObject({
      state: 'active',
      reason: expect.stringContaining('protects that container'),
    });
    expect(deployedCopyBehavior(SENCHO_INFRASTRUCTURE_LABEL, 'true', 'node-wide')?.state).toBe('active');
    expect(deployedCopyBehavior(SENCHO_INFRASTRUCTURE_LABEL, 'maybe', 'image')).toMatchObject({
      state: 'invalid',
      reason: expect.stringContaining('only accepted value is true'),
    });
    expect(deployedCopyBehavior(SENCHO_INFRASTRUCTURE_LABEL, 'true', 'stale-runtime')?.state).toBe('active');
    // Every other presentation label stays inert from the same copy.
    for (const key of ['io.sencho.url', 'io.sencho.order', 'io.sencho.hidden']) {
      expect(deployedCopyBehavior(key, 'true', 'runtime')?.state).toBe('inert');
    }
  });

  it('reserves the keys Sencho stamps on its own containers', () => {
    for (const key of SENCHO_MANAGED_LABELS) {
      const declared = resolveRendered(model({ web: { [key]: 'true' } }));
      expect(declaredLabelBehavior(declared, 'web', key)).toEqual({ state: 'invalid', reason: MANAGED_LABEL_DECLARED_REASON });
      expect(declared.services.web).toEqual({ links: [], order: null, hidden: false, update: null, notifyRoute: null });
      expect(deployedCopyBehavior(key, 'true', 'runtime')).toEqual({ state: 'inert', reason: MANAGED_LABEL_DEPLOYED_REASON });
    }
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
    expect(sanitizeRemoteBehavior('runtime', 'io.sencho.url', undefined)).toBeUndefined();
  });

  it('rebuilds a readable behavior field by field and drops extra properties', () => {
    const raw = { state: 'invalid', reason: 'Use true or false.', summary: 'Collapses a helper.', extra: { deep: 1 } };
    expect(sanitizeRemoteBehavior('compose', 'io.sencho.hidden', raw)).toEqual({ state: 'invalid', reason: 'Use true or false.', summary: 'Collapses a helper.' });
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
    expect(sanitizeRemoteBehavior('compose', 'io.sencho.url', raw)).toEqual({
      state: 'unsupported',
      reason: expect.stringContaining('cannot read'),
    });
  });

  it('forces every source other than the declared Compose copy to inert, except the protective label', () => {
    for (const source of ['runtime', 'image', 'unknown', 'compose-system'] as const) {
      expect(sanitizeRemoteBehavior(source, 'io.sencho.url', { state: 'active' })?.state).toBe('inert');
      expect(sanitizeRemoteBehavior(source, 'io.sencho.order', { state: 'active' })?.state).toBe('inert');
    }
    expect(sanitizeRemoteBehavior('compose', 'io.sencho.url', { state: 'active' })?.state).toBe('active');
    // A remote node reports the deployed infrastructure copy as active or invalid; keeping it is what makes the audit truthful.
    expect(sanitizeRemoteBehavior('runtime', SENCHO_INFRASTRUCTURE_LABEL, { state: 'active' })?.state).toBe('active');
    expect(sanitizeRemoteBehavior('image', SENCHO_INFRASTRUCTURE_LABEL, { state: 'invalid' })?.state).toBe('invalid');
    for (const key of SENCHO_MANAGED_LABELS) {
      expect(sanitizeRemoteBehavior('runtime', key, { state: 'active' })?.state).toBe('inert');
    }
  });

  it('bounds the text a remote can send', () => {
    const long = 'x'.repeat(5000);
    const out = sanitizeRemoteBehavior('compose', 'io.sencho.url', { state: 'invalid', reason: long, summary: long });
    expect(out?.reason?.length).toBe(240);
    expect(out?.summary?.length).toBe(240);
  });

  it('drops a behavior for a key outside the namespace and for a claim the hub does not honor', () => {
    expect(sanitizeRemoteBehavior('compose', 'traefik.enable', { state: 'active' })).toBeUndefined();
    // A presentation label cannot be active from a running container; the hub's reason replaces the node's text.
    expect(sanitizeRemoteBehavior('runtime', 'io.sencho.url', { state: 'active', reason: 'This link is active.' })).toEqual({
      state: 'inert',
      reason: expect.stringContaining('Present only on the running container'),
    });
    // A node that already reports inert keeps the reason that names the origin.
    expect(sanitizeRemoteBehavior('runtime', 'io.sencho.url', { state: 'inert', reason: 'Present only on the running container.' }))
      .toEqual({ state: 'inert', reason: 'Present only on the running container.' });
  });

  it('never trusts a remote about a key Sencho stamps on its own containers', () => {
    for (const key of SENCHO_MANAGED_LABELS) {
      expect(sanitizeRemoteBehavior('compose', key, { state: 'active' })).toEqual({ state: 'invalid', reason: MANAGED_LABEL_DECLARED_REASON });
      expect(sanitizeRemoteBehavior('runtime', key, { state: 'active' })).toEqual({ state: 'inert', reason: MANAGED_LABEL_DEPLOYED_REASON });
    }
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
