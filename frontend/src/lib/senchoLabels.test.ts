import { describe, it, expect } from 'vitest';
import {
  applicationLink,
  ignoredLabels,
  namedLinks,
  presentServices,
  readSenchoLabels,
  unverifiedLinkCount,
} from './senchoLabels';
import { parseServiceUrlResponse, senchoLabelsOf } from './serviceUrlResolve';
import { serviceUrlFromLabelValue } from './serviceUrlLabel';

const wire = {
  renderable: true,
  services: {
    web: {
      links: [
        { name: null, url: 'https://app.example.com' },
        { name: 'docs', url: 'https://docs.example.com' },
      ],
      order: 10,
      hidden: false,
    },
    redis: { links: [], order: null, hidden: true },
    worker: { links: [], order: null, hidden: false },
  },
  entries: [
    { service: 'web', key: 'io.sencho.url', state: 'active' },
    { service: 'worker', key: 'io.sencho.order', state: 'invalid', reason: 'Use a whole number such as 10.' },
  ],
};

const withWebLinks = (links: unknown) => ({ ...wire, services: { web: { links, order: 1, hidden: false } } });
const chr = (code: number): string => String.fromCharCode(code);

describe('readSenchoLabels', () => {
  it('reads links, order, hidden, and diagnostics from the node answer', () => {
    const r = readSenchoLabels(wire);
    expect(r?.renderable).toBe(true);
    expect(applicationLink(r, 'web')?.url).toBe('https://app.example.com');
    expect(namedLinks(r, 'web')).toEqual([{ name: 'docs', url: 'https://docs.example.com' }]);
    expect(ignoredLabels(r, 'worker').map(e => e.key)).toEqual(['io.sencho.order']);
    expect(ignoredLabels(r, 'web')).toEqual([]);
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a string', 'x'],
    ['an array', []],
    ['an empty object', {}],
    ['a missing services map', { renderable: true, entries: [] }],
    ['a missing entries list, as a truncated answer would be', { renderable: true, services: {} }],
    ['a non-boolean renderable', { renderable: 'yes', services: {}, entries: [] }],
    ['a service record that is not an object', { renderable: true, services: { web: 'x' }, entries: [] }],
    ['a service whose links are not a list', { renderable: true, services: { web: { links: 'nope', order: 1, hidden: false } }, entries: [] }],
    ['a link that is not an object', withWebLinks(['https://a.example.com'])],
    ['an entry without a key', { ...wire, entries: [{ service: 'web' }] }],
    ['an entry that is not an object', { ...wire, entries: [7] }],
  ])('returns null for %s, so the node is treated as not supporting the contract', (_label, bad) => {
    expect(readSenchoLabels(bad)).toBeNull();
  });

  it('drops a link that is not a safe http(s) URL, whatever the node said, and counts it', () => {
    const r = readSenchoLabels(withWebLinks([
      { name: null, url: 'javascript:alert(1)' },
      { name: 'docs', url: 'data:text/html,x' },
      { name: 'admin', url: 'https://user:pw@admin.example.com' },
      { name: 'ok', url: 'https://ok.example.com' },
    ]));
    expect(applicationLink(r, 'web')).toBeUndefined();
    expect(namedLinks(r, 'web')).toEqual([{ name: 'ok', url: 'https://ok.example.com' }]);
    expect(unverifiedLinkCount(r, 'web')).toBe(3);
  });

  it('keeps one application link and each name once, and refuses a name the node would never send', () => {
    const r = readSenchoLabels(withWebLinks([
      { name: 'docs', url: 'https://docs.example.com' },
      { name: null, url: 'https://one.example.com' },
      { name: null, url: 'https://two.example.com' },
      { name: 'docs', url: 'https://again.example.com' },
      { name: 'Bad Name', url: 'https://bad.example.com' },
      { name: 'x'.repeat(33), url: 'https://long.example.com' },
      { name: '', url: 'https://empty.example.com' },
    ]));
    expect(r && r.renderable ? r.services.web.links : null).toEqual([
      { name: null, url: 'https://one.example.com' },
      { name: 'docs', url: 'https://docs.example.com' },
    ]);
    expect(unverifiedLinkCount(r, 'web')).toBe(5);
  });

  it('rejects an answer whose presentation fields do not match the contract, instead of applying part of it', () => {
    expect(readSenchoLabels({
      renderable: true,
      services: { web: { links: [], order: '3', hidden: false } },
      entries: [],
    })).toBeNull();
    expect(readSenchoLabels({
      renderable: true,
      services: { web: { links: [], order: 1.5, hidden: false } },
      entries: [],
    })).toBeNull();
    expect(readSenchoLabels({
      renderable: true,
      services: { web: { links: [], order: null, hidden: 'true' } },
      entries: [],
    })).toBeNull();
    expect(readSenchoLabels({
      renderable: true,
      services: { web: { links: [], hidden: false } },
      entries: [],
    })).toBeNull();
  });

  it('reads a state from a newer node as unsupported so the ignored count does not under-report', () => {
    const r = readSenchoLabels({
      renderable: true,
      services: { web: { links: [], order: null, hidden: false } },
      entries: [{ service: 'web', key: 'k', state: 'weird' }, { service: 'web', key: 'j', state: 'invalid', reason: 7 }],
    });
    expect(ignoredLabels(r, 'web')).toEqual([
      { service: 'web', key: 'k', state: 'unsupported', reason: expect.stringContaining('cannot read') },
      { service: 'web', key: 'j', state: 'invalid' },
    ]);
  });

  it('applies nothing from an unrenderable answer', () => {
    const r = readSenchoLabels({ ...wire, renderable: false });
    expect(r).toEqual({ renderable: false });
    expect(applicationLink(r, 'web')).toBeUndefined();
    expect(ignoredLabels(r, 'worker')).toEqual([]);
    expect(presentServices(['b', 'a'], r)).toEqual({ order: ['b', 'a'], hidden: new Set() });
  });

  it('does not read an inherited property for a service named like one', () => {
    const r = readSenchoLabels(wire);
    expect(applicationLink(r, 'constructor')).toBeUndefined();
    expect(namedLinks(r, 'toString')).toEqual([]);
    expect(unverifiedLinkCount(r, 'constructor')).toBe(0);
  });
});

describe('presentServices', () => {
  const r = readSenchoLabels(wire);
  const ranked = (orders: Record<string, number | null>, hidden: string[] = []) => readSenchoLabels({
    renderable: true,
    entries: [],
    services: Object.fromEntries(Object.entries(orders).map(([name, order]) => [name, { links: [], order, hidden: hidden.includes(name) }])),
  });

  it('puts ordered services first, then the node\'s other services by name, then unknown names in the given order', () => {
    expect(presentServices(['worker', 'extra', 'web', 'also', 'redis'], r).order).toEqual(['web', 'redis', 'worker', 'extra', 'also']);
  });

  it('sorts by value, then name, with unordered services last by name', () => {
    const resolution = ranked({ zeta: 1, alpha: 1, mid: -5, bad: null, none: null, big: 999999999 });
    expect(presentServices(['zeta', 'none', 'big', 'alpha', 'bad', 'mid'], resolution).order)
      .toEqual(['mid', 'alpha', 'zeta', 'big', 'bad', 'none']);
  });

  it('gives the same order whatever order the names arrive in', () => {
    const resolution = ranked({ a: 2, b: 2, c: null, d: null });
    const forward = presentServices(['a', 'b', 'c', 'd'], resolution).order;
    expect(presentServices(['d', 'c', 'b', 'a'], resolution).order).toEqual(forward);
    expect(forward).toEqual(['a', 'b', 'c', 'd']);
  });

  it('collapses hidden services but never every service', () => {
    expect(presentServices(['web', 'redis'], r).hidden).toEqual(new Set(['redis']));
    expect(presentServices(['redis'], r).hidden).toEqual(new Set());
    expect(presentServices(['a', 'b'], ranked({ a: null, b: null }, ['a', 'b'])).hidden).toEqual(new Set());
  });

  it('leaves the incoming order alone without a resolution', () => {
    expect(presentServices(['b', 'a'], null)).toEqual({ order: ['b', 'a'], hidden: new Set() });
    expect(presentServices(['b', 'a'], undefined).hidden.size).toBe(0);
  });
});

describe('link validation', () => {
  it.each([
    'https://app.example.com',
    'http://192.168.1.50:8080/web?x=1#top',
    '  https://app.example.com/path  ',
  ])('accepts %s', (value) => {
    expect(serviceUrlFromLabelValue(value)).not.toBeNull();
  });

  // The same vectors run against the backend validator (sencho-labels.test.ts), so the two cannot drift apart.
  it.each([
    ['javascript:alert(1)'],
    ['data:text/html,<b>x</b>'],
    ['file:///etc/passwd'],
    ['ftp://files.example.com'],
    ['https://user:pass@app.example.com'],
    ['https://user@app.example.com'],
    ['https://:@app.example.com'],
    ['/relative/path'],
    ['https://'],
    ['https:app.example.com'],
    ['https://app.example.com/a b'],
    ['https://app.example.com/a\tb'],
    ['https://app.example.com/a\nb'],
    [`https://app.example.com/${chr(7)}`],
    [`https://app.example.com/${chr(0x85)}`],
    [`https://app.example.com/${chr(0x202e)}gnp.exe`],
    [`https://app.example.com/${chr(0x200b)}`],
    [`https://app.example.com/a${chr(0x2028)}b`],
    [`https://app.example.com/${chr(0x2066)}x`],
    [`https://app.example.com/a${chr(0xfeff)}b`],
    [`https://app.example.com/${chr(0x00ad)}`],
    ['https:\\\\app.example.com'],
    [''],
    [`https://app.example.com/${'a'.repeat(2100)}`],
  ])('rejects %j', (value) => {
    expect(serviceUrlFromLabelValue(value)).toBeNull();
  });
});

describe('parseServiceUrlResponse', () => {
  const body = {
    renderable: true,
    services: ['web'],
    ports: { web: [{ host: '8080', container: '80', proto: 'tcp', published: true }] },
    volumes: {},
    networks: [],
    restart: null,
    serviceUrls: { web: 'https://app.example.com' },
    serviceUrlEdit: { web: 'root' },
    serviceUrlClear: { web: 'root' },
  };

  it('carries the resolution when the node reports one', () => {
    const entry = parseServiceUrlResponse(1, 'demo', true, { ...body, senchoLabels: wire });
    expect(entry.status).toBe('ready');
    expect(applicationLink(entry.senchoLabels, 'web')?.url).toBe('https://app.example.com');
    expect(senchoLabelsOf(entry)).toBe(entry.senchoLabels);
  });

  it('treats a node that predates the contract as unsupported as a whole, keeping only its facts', () => {
    // An earlier release answers with a URL map for the draft label and no resolution.
    const entry = parseServiceUrlResponse(1, 'demo', true, body);
    expect(entry.status).toBe('unsupported');
    expect(entry.serviceUrls).toEqual({});
    expect(entry.serviceUrlEdit).toEqual({});
    expect(entry.serviceUrlClear).toEqual({});
    expect(entry.senchoLabels).toBeUndefined();
    expect(entry.services).toEqual(['web']);
    expect(Object.keys(entry.ports)).toEqual(['web']);
    expect(senchoLabelsOf(entry)).toBeNull();
  });

  it('treats a malformed resolution the same way instead of applying part of it', () => {
    const entry = parseServiceUrlResponse(1, 'demo', true, { ...body, senchoLabels: { renderable: true, services: wire.services } });
    expect(entry.status).toBe('unsupported');
    expect(entry.serviceUrls).toEqual({});
  });

  it('reports a current node whose model did not render as unavailable', () => {
    const entry = parseServiceUrlResponse(1, 'demo', true, { ...body, renderable: false, senchoLabels: { renderable: false } });
    expect(entry.status).toBe('unavailable');
    expect(senchoLabelsOf(entry)).toBeNull();
  });
});
