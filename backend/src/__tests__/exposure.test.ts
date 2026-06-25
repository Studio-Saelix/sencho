import { describe, it, expect } from 'vitest';
import { deriveStackExposure, buildExposedImageMap, type StackExposure } from '../services/preflight/exposure';
import type { EffectiveModel } from '../services/preflight/effectiveModel';

function svc(overrides: Record<string, unknown>) {
  return {
    name: 'app',
    image: 'nginx:latest',
    ports: [] as Array<{ startPort: number; endPort: number; hostIp: string; protocol: string }>,
    binds: [],
    namedVolumes: [],
    storageMounts: [],
    privileged: false,
    networkMode: undefined as string | undefined,
    restart: undefined as string | undefined,
    hasHealthcheck: false,
    envKeys: [],
    networks: [],
    extraHosts: [],
    labelKeys: [],
    ...overrides,
  };
}

function model(overrides: Partial<EffectiveModel>): EffectiveModel {
  return {
    projectName: 'test',
    services: [],
    networks: {},
    volumes: {},
    ...overrides,
  };
}

const NOW = 1700000000000;

describe('deriveStackExposure', () => {
  it('marks a service with no ports and no host networking as not exposed', () => {
    const m = model({ services: [svc({ image: 'nginx:latest' })] });
    const r = deriveStackExposure(m, 'test', NOW);
    expect(r.services[0].publiclyExposed).toBe(false);
    expect(r.services[0].reason).toBeNull();
  });

  it('marks a service publishing on 0.0.0.0 as exposed', () => {
    const m = model({
      services: [
        svc({
          ports: [{ startPort: 8080, endPort: 8080, hostIp: '0.0.0.0', protocol: 'tcp' }],
        }),
      ],
    });
    const r = deriveStackExposure(m, 'test', NOW);
    expect(r.services[0].publiclyExposed).toBe(true);
    expect(r.services[0].reason).toBe('published-port');
    expect(r.services[0].bindings).toEqual(['0.0.0.0:8080/tcp']);
  });

  it('marks a service publishing on :: (IPv6 all-interfaces) as exposed', () => {
    const m = model({
      services: [
        svc({
          ports: [{ startPort: 3000, endPort: 3000, hostIp: '::', protocol: 'tcp' }],
        }),
      ],
    });
    const r = deriveStackExposure(m, 'test', NOW);
    expect(r.services[0].publiclyExposed).toBe(true);
  });

  it('marks a service publishing on an empty host IP as exposed (Docker default = all interfaces)', () => {
    const m = model({
      services: [
        svc({
          ports: [{ startPort: 5432, endPort: 5432, hostIp: '', protocol: 'tcp' }],
        }),
      ],
    });
    const r = deriveStackExposure(m, 'test', NOW);
    expect(r.services[0].publiclyExposed).toBe(true);
  });

  it('marks a service publishing on a specific LAN IP as exposed', () => {
    const m = model({
      services: [
        svc({
          ports: [{ startPort: 8080, endPort: 8080, hostIp: '192.168.1.50', protocol: 'tcp' }],
        }),
      ],
    });
    const r = deriveStackExposure(m, 'test', NOW);
    expect(r.services[0].publiclyExposed).toBe(true);
  });

  it('keeps a loopback-only service as not exposed', () => {
    const m = model({
      services: [
        svc({
          ports: [{ startPort: 8080, endPort: 8080, hostIp: '127.0.0.1', protocol: 'tcp' }],
        }),
      ],
    });
    const r = deriveStackExposure(m, 'test', NOW);
    expect(r.services[0].publiclyExposed).toBe(false);
  });

  it('marks ::1 (IPv6 loopback) as not exposed', () => {
    const m = model({
      services: [
        svc({
          ports: [{ startPort: 8080, endPort: 8080, hostIp: '::1', protocol: 'tcp' }],
        }),
      ],
    });
    const r = deriveStackExposure(m, 'test', NOW);
    expect(r.services[0].publiclyExposed).toBe(false);
  });

  it('marks any 127.0.0.0/8 address as loopback (not exposed)', () => {
    const m = model({
      services: [
        svc({
          ports: [{ startPort: 8080, endPort: 8080, hostIp: '127.0.0.2', protocol: 'tcp' }],
        }),
      ],
    });
    const r = deriveStackExposure(m, 'test', NOW);
    expect(r.services[0].publiclyExposed).toBe(false);
  });

  it('marks a host-network service as exposed even with no published ports', () => {
    const m = model({
      services: [
        svc({ networkMode: 'host' }),
      ],
    });
    const r = deriveStackExposure(m, 'test', NOW);
    expect(r.services[0].publiclyExposed).toBe(true);
    expect(r.services[0].reason).toBe('host-network');
    expect(r.services[0].bindings).toEqual([]);
  });

  it('does not mark network_mode: none as exposed', () => {
    const m = model({
      services: [
        svc({ networkMode: 'none' }),
      ],
    });
    const r = deriveStackExposure(m, 'test', NOW);
    expect(r.services[0].publiclyExposed).toBe(false);
  });

  it('carries the image reference through for downstream joins', () => {
    const m = model({
      services: [
        svc({
          image: 'postgres:15',
          ports: [{ startPort: 5432, endPort: 5432, hostIp: '0.0.0.0', protocol: 'tcp' }],
        }),
      ],
    });
    const r = deriveStackExposure(m, 'test', NOW);
    expect(r.services[0].image).toBe('postgres:15');
  });

  it('sets image to null for build-only services', () => {
    const m = model({
      services: [
        svc({
          image: undefined,
          ports: [{ startPort: 3000, endPort: 3000, hostIp: '0.0.0.0', protocol: 'tcp' }],
        }),
      ],
    });
    const r = deriveStackExposure(m, 'test', NOW);
    expect(r.services[0].image).toBeNull();
    expect(r.services[0].publiclyExposed).toBe(true); // still exposed via port
  });

  it('handles multi-service stacks with mixed exposure', () => {
    const m = model({
      services: [
        svc({
          name: 'frontend',
          ports: [{ startPort: 80, endPort: 80, hostIp: '0.0.0.0', protocol: 'tcp' }],
        }),
        svc({ name: 'backend', ports: [{ startPort: 4000, endPort: 4000, hostIp: '127.0.0.1', protocol: 'tcp' }] }),
        svc({ name: 'metrics', networkMode: 'host' }),
      ],
    });
    const r = deriveStackExposure(m, 'test', NOW);
    expect(r.services[0].publiclyExposed).toBe(true); // frontend
    expect(r.services[1].publiclyExposed).toBe(false); // backend (loopback)
    expect(r.services[2].publiclyExposed).toBe(true); // metrics (host network)
  });

  it('includes the stack name and timestamp in the descriptor', () => {
    const m = model({ services: [svc({})] });
    const r = deriveStackExposure(m, 'mystack', NOW);
    expect(r.stack).toBe('mystack');
    expect(r.computedAt).toBe(NOW);
  });

  it('produces bindings in host-only format without container target ports', () => {
    const m = model({
      services: [
        svc({
          ports: [
            { startPort: 8080, endPort: 8080, hostIp: '0.0.0.0', protocol: 'tcp' },
            { startPort: 9000, endPort: 9001, hostIp: '', protocol: 'udp' },
          ],
        }),
      ],
    });
    const r = deriveStackExposure(m, 'test', NOW);
    expect(r.services[0].bindings).toEqual([
      '0.0.0.0:8080/tcp',
      '0.0.0.0:9000-9001/udp',
    ]);
  });
});

describe('buildExposedImageMap', () => {
  function exp(stack: string, services: Array<{ image: string | null; publiclyExposed: boolean }>): StackExposure {
    return {
      stack,
      computedAt: NOW,
      services: services.map((s) => ({
        service: 's',
        image: s.image,
        publiclyExposed: s.publiclyExposed,
        reason: s.publiclyExposed ? 'published-port' : null,
        bindings: [],
      })),
    };
  }

  it('returns an empty map for no exposures', () => {
    expect(buildExposedImageMap([]).size).toBe(0);
  });

  it('maps an exposed image to true', () => {
    const map = buildExposedImageMap([
      exp('a', [{ image: 'nginx:latest', publiclyExposed: true }]),
    ]);
    expect(map.get('nginx:latest')).toBe(true);
  });

  it('maps an internal-only image to false', () => {
    const map = buildExposedImageMap([
      exp('a', [{ image: 'nginx:latest', publiclyExposed: false }]),
    ]);
    expect(map.get('nginx:latest')).toBe(false);
  });

  it('skips build-only services (no image)', () => {
    const map = buildExposedImageMap([
      exp('a', [{ image: null, publiclyExposed: true }]),
    ]);
    expect(map.has(null as unknown as string)).toBe(false);
    expect(map.size).toBe(0);
  });

  it('true wins over false when the same image appears in multiple stacks', () => {
    const map = buildExposedImageMap([
      exp('a', [{ image: 'nginx:latest', publiclyExposed: false }]),
      exp('b', [{ image: 'nginx:latest', publiclyExposed: true }]),
    ]);
    expect(map.get('nginx:latest')).toBe(true);
  });

  it('true stays true even when a later stack classifies the image internal', () => {
    const map = buildExposedImageMap([
      exp('a', [{ image: 'nginx:latest', publiclyExposed: true }]),
      exp('b', [{ image: 'nginx:latest', publiclyExposed: false }]),
    ]);
    expect(map.get('nginx:latest')).toBe(true);
  });

  it('returns false when the image appears only as internal across all stacks', () => {
    const map = buildExposedImageMap([
      exp('a', [{ image: 'postgres:15', publiclyExposed: false }]),
      exp('b', [{ image: 'postgres:15', publiclyExposed: false }]),
    ]);
    expect(map.get('postgres:15')).toBe(false);
  });

  it('leaves an absent image as undefined (no descriptor contains it)', () => {
    const map = buildExposedImageMap([
      exp('a', [{ image: 'redis:7', publiclyExposed: true }]),
    ]);
    expect(map.get('nginx:latest')).toBeUndefined();
  });

  it('handles mixed images in the same stack', () => {
    const map = buildExposedImageMap([
      exp('a', [
        { image: 'frontend:1', publiclyExposed: true },
        { image: 'backend:1', publiclyExposed: false },
      ]),
    ]);
    expect(map.get('frontend:1')).toBe(true);
    expect(map.get('backend:1')).toBe(false);
  });
});
