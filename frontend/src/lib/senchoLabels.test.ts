import { describe, it, expect } from 'vitest';
import {
  applicationLink,
  ignoredLabels,
  namedLinks,
  presentServices,
  readSenchoLabels,
} from './senchoLabels';
import { parseServiceUrlResponse } from './serviceUrlResolve';

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
  serviceOrder: ['web', 'redis', 'worker'],
};

describe('readSenchoLabels', () => {
  it('reads links, order, hidden, and diagnostics from the node answer', () => {
    const r = readSenchoLabels(wire);
    expect(r?.renderable).toBe(true);
    expect(applicationLink(r, 'web')?.url).toBe('https://app.example.com');
    expect(namedLinks(r, 'web')).toEqual([{ name: 'docs', url: 'https://docs.example.com' }]);
    expect(ignoredLabels(r, 'worker').map(e => e.key)).toEqual(['io.sencho.order']);
    expect(ignoredLabels(r, 'web')).toEqual([]);
  });

  it('returns null for an answer that is not a resolution, as an older node would send', () => {
    for (const bad of [undefined, null, 'x', [], {}, { renderable: true }, { renderable: 'yes', services: {} }]) {
      expect(readSenchoLabels(bad)).toBeNull();
    }
  });

  it('drops a link that is not a safe http(s) URL, whatever the node said', () => {
    const r = readSenchoLabels({
      ...wire,
      services: {
        web: {
          links: [
            { name: null, url: 'javascript:alert(1)' },
            { name: 'docs', url: 'data:text/html,x' },
            { name: 'admin', url: 'https://user:pw@admin.example.com' },
            { name: 'ok', url: 'https://ok.example.com' },
          ],
          order: 1,
          hidden: false,
        },
      },
    });
    expect(applicationLink(r, 'web')).toBeUndefined();
    expect(namedLinks(r, 'web')).toEqual([{ name: 'ok', url: 'https://ok.example.com' }]);
  });

  it('ignores malformed entries and non-numeric order', () => {
    const r = readSenchoLabels({
      renderable: true,
      services: { web: { links: 'nope', order: '3', hidden: 'true' } },
      entries: [{ service: 'web' }, { service: 'web', key: 'k', state: 'weird' }, 7],
      serviceOrder: ['web', 4],
    });
    expect(r?.services.web).toEqual({ links: [], order: null, hidden: false });
    expect(r?.entries).toEqual([]);
    expect(r?.serviceOrder).toEqual(['web']);
  });

  it('applies nothing from an unrenderable answer', () => {
    const r = readSenchoLabels({ ...wire, renderable: false });
    expect(applicationLink(r, 'web')).toBeUndefined();
    expect(ignoredLabels(r, 'worker')).toEqual([]);
    expect(presentServices(['b', 'a'], r)).toEqual({ order: ['b', 'a'], hidden: new Set() });
  });

  it('does not read an inherited property for a service named like one', () => {
    const r = readSenchoLabels(wire);
    expect(applicationLink(r, 'constructor')).toBeUndefined();
    expect(namedLinks(r, 'toString')).toEqual([]);
  });
});

describe('presentServices', () => {
  const r = readSenchoLabels(wire);

  it('orders by the node answer and keeps unknown names last in their given order', () => {
    expect(presentServices(['worker', 'extra', 'web', 'also'], r).order).toEqual(['web', 'worker', 'extra', 'also']);
  });

  it('collapses hidden services but never every service', () => {
    expect(presentServices(['web', 'redis'], r).hidden).toEqual(new Set(['redis']));
    expect(presentServices(['redis'], r).hidden).toEqual(new Set());
  });

  it('leaves the incoming order alone without a resolution', () => {
    expect(presentServices(['b', 'a'], null)).toEqual({ order: ['b', 'a'], hidden: new Set() });
    expect(presentServices(['b', 'a'], undefined).hidden.size).toBe(0);
  });
});

describe('parseServiceUrlResponse', () => {
  const body = {
    renderable: true,
    services: ['web'],
    ports: {},
    volumes: {},
    networks: [],
    restart: null,
    serviceUrls: { web: 'https://app.example.com' },
    serviceUrlEdit: {},
    serviceUrlClear: {},
  };

  it('carries the resolution when the node reports one', () => {
    const entry = parseServiceUrlResponse(1, 'demo', true, { ...body, senchoLabels: wire });
    expect(entry.status).toBe('ready');
    expect(applicationLink(entry.senchoLabels, 'web')?.url).toBe('https://app.example.com');
  });

  it('marks a node that reports none as not applying Sencho labels, without failing the entry', () => {
    const entry = parseServiceUrlResponse(1, 'demo', true, body);
    expect(entry.status).toBe('ready');
    expect(entry.senchoLabels).toBeNull();
  });
});
