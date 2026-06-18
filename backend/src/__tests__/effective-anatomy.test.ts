/**
 * Unit tests for parseEffectiveAnatomy: the secret-safe structural extractor that
 * maps `docker compose config --format json` (the fully-merged effective model)
 * to the same anatomy facts the frontend derives from a single compose file, so a
 * multi-file Git source's dossier and doc-drift reflect every override file.
 *
 * The extractor must read ONLY structural fields (service keys, ports, volumes,
 * restart, network keys) and never an environment, label, or command value.
 */
import { describe, it, expect } from 'vitest';
import { parseEffectiveAnatomy } from '../services/effectiveAnatomy';

describe('parseEffectiveAnatomy', () => {
  it('returns an empty model for null / non-object input', () => {
    const empty = { services: [], ports: {}, volumes: {}, restart: null, networks: [] };
    expect(parseEffectiveAnatomy(null)).toEqual(empty);
    expect(parseEffectiveAnatomy('nope')).toEqual(empty);
    expect(parseEffectiveAnatomy(42)).toEqual(empty);
  });

  it('extracts services, published ports, and volumes from the long-form render', () => {
    const rendered = {
      name: 'demo',
      services: {
        web: {
          image: 'nginx',
          restart: 'always',
          ports: [
            { mode: 'ingress', host_ip: '0.0.0.0', target: 80, published: '8080', protocol: 'tcp' },
          ],
          volumes: [
            { type: 'bind', source: '/srv/web', target: '/usr/share/nginx/html' },
            { type: 'volume', source: 'webdata', target: '/var/cache' },
          ],
          networks: { default: null },
        },
      },
      networks: { default: { name: 'demo_default' } },
    };
    const anatomy = parseEffectiveAnatomy(rendered);
    expect(anatomy.services).toEqual(['web']);
    expect(anatomy.ports).toEqual({
      web: [{ host: '8080', container: '80', proto: 'tcp', published: true }],
    });
    expect(anatomy.volumes).toEqual({
      web: [
        { host: '/srv/web', container: '/usr/share/nginx/html' },
        { host: 'webdata', container: '/var/cache' },
      ],
    });
    expect(anatomy.restart).toBe('always');
    expect(anatomy.networks).toEqual(['default']);
  });

  it('merges ports that only an override file publishes (the blocker case)', () => {
    // The root file declared `app` with no ports; an override published 9000.
    // The rendered model is the merge, so the published port must appear here.
    const rendered = {
      services: {
        app: {
          ports: [{ target: 9000, published: '9000', protocol: 'tcp' }],
        },
      },
    };
    const anatomy = parseEffectiveAnatomy(rendered);
    expect(anatomy.ports.app).toEqual([{ host: '9000', container: '9000', proto: 'tcp', published: true }]);
  });

  it('marks a container-only port as unpublished and preserves UDP', () => {
    const rendered = {
      services: {
        svc: {
          ports: [
            { target: 53, published: '53', protocol: 'udp' },
            { target: 9090, published: '', protocol: 'tcp' },
          ],
        },
      },
    };
    const anatomy = parseEffectiveAnatomy(rendered);
    expect(anatomy.ports.svc).toEqual([
      { host: '53', container: '53', proto: 'udp', published: true },
      { host: '', container: '9090', proto: 'tcp', published: false },
    ]);
  });

  it('collects network keys from services and the top level, deduped', () => {
    const rendered = {
      services: {
        a: { networks: { frontend: null, backend: null } },
        b: { networks: ['backend'] },
      },
      networks: { frontend: {}, backend: {}, default: {} },
    };
    const anatomy = parseEffectiveAnatomy(rendered);
    expect(anatomy.networks).toEqual(['frontend', 'backend', 'default']);
  });

  it('never surfaces environment, label, or command values', () => {
    const rendered = {
      services: {
        web: {
          environment: { DB_PASSWORD: 'super-secret', API_KEY: 'leak-me' },
          labels: { 'traefik.http.routers.web.rule': 'Host(`secret.example.com`)' },
          command: ['--token', 'do-not-leak'],
          ports: [{ target: 80, published: '80', protocol: 'tcp' }],
        },
      },
    };
    const serialized = JSON.stringify(parseEffectiveAnatomy(rendered));
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('leak-me');
    expect(serialized).not.toContain('do-not-leak');
    expect(serialized).not.toContain('secret.example.com');
  });
});
