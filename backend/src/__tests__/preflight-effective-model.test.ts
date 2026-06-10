/**
 * parseEffectiveModel: turns `docker compose config --format json` output into
 * the structural facts the preflight rules need. The critical property is that
 * it never retains an environment VALUE (only key names).
 */
import { describe, it, expect } from 'vitest';
import { parseEffectiveModel } from '../services/preflight/effectiveModel';

const SECRET = 'topsecret-9f3a-value';

function render() {
  return {
    name: 'myapp',
    services: {
      web: {
        image: 'nginx:latest',
        ports: [
          { mode: 'ingress', target: 80, published: '8080', protocol: 'tcp' },
          { target: 53, published: '5300', protocol: 'udp', host_ip: '127.0.0.1' },
          { target: 90, published: '9000-9002', protocol: 'tcp' },
        ],
        volumes: [
          { type: 'bind', source: '/srv/data', target: '/data' },
          { type: 'volume', source: 'cache', target: '/var/cache' },
        ],
        privileged: true,
        network_mode: 'host',
        restart: 'unless-stopped',
        healthcheck: { test: ['CMD', 'true'] },
        deploy: { placement: { constraints: [] } },
        container_name: 'web1',
        user: '1000:1000',
        environment: { DB_PASSWORD: SECRET, PUID: '1000' },
      },
    },
    networks: {
      default: { name: 'myapp_default' },
      shared: { name: 'shared_net', external: true },
    },
    volumes: {
      cache: { name: 'myapp_cache' },
      ext: { name: 'shared_vol', external: true },
    },
  };
}

describe('parseEffectiveModel', () => {
  it('extracts structural facts from the rendered model', () => {
    const m = parseEffectiveModel(render(), 'fallback');
    expect(m.projectName).toBe('myapp');
    const web = m.services[0];
    expect(web.name).toBe('web');
    expect(web.image).toBe('nginx:latest');
    expect(web.privileged).toBe(true);
    expect(web.networkMode).toBe('host');
    expect(web.restart).toBe('unless-stopped');
    expect(web.hasHealthcheck).toBe(true);
    expect(web.deploy).toBeDefined();
    expect(web.containerName).toBe('web1');
    expect(web.user).toBe('1000:1000');
    expect(web.binds).toEqual([{ source: '/srv/data', target: '/data' }]);
    expect(web.namedVolumes).toEqual(['cache']);
  });

  it('parses ports with host IP, protocol, and ranges', () => {
    const web = parseEffectiveModel(render(), 'fallback').services[0];
    expect(web.ports).toEqual([
      { startPort: 8080, endPort: 8080, hostIp: '', protocol: 'tcp' },
      { startPort: 5300, endPort: 5300, hostIp: '127.0.0.1', protocol: 'udp' },
      { startPort: 9000, endPort: 9002, hostIp: '', protocol: 'tcp' },
    ]);
  });

  it('resolves top-level networks and volumes with external flags', () => {
    const m = parseEffectiveModel(render(), 'fallback');
    expect(m.networks.shared).toEqual({ name: 'shared_net', external: true });
    expect(m.networks.default).toEqual({ name: 'myapp_default', external: false });
    expect(m.volumes.ext).toEqual({ name: 'shared_vol', external: true });
    expect(m.volumes.cache).toEqual({ name: 'myapp_cache', external: false });
  });

  it('reads environment KEY names only, never values', () => {
    const m = parseEffectiveModel(render(), 'fallback');
    expect(m.services[0].envKeys).toEqual(['DB_PASSWORD', 'PUID']);
    // The secret value must not survive anywhere in the parsed model.
    expect(JSON.stringify(m)).not.toContain(SECRET);
  });

  it('reads env key names from the array form without keeping the value', () => {
    const m = parseEffectiveModel(
      { services: { api: { environment: [`TOKEN=${SECRET}`, 'MODE=prod'] } } },
      'fallback',
    );
    expect(m.services[0].envKeys).toEqual(['TOKEN', 'MODE']);
    expect(JSON.stringify(m)).not.toContain(SECRET);
  });

  it('parses the short-string port form and drops container-only EXPOSE', () => {
    const m = parseEffectiveModel({ services: { s: { ports: ['127.0.0.1:8080:80/udp', '8443:443', '90'] } } }, 'p');
    expect(m.services[0].ports).toEqual([
      { startPort: 8080, endPort: 8080, hostIp: '127.0.0.1', protocol: 'udp' },
      { startPort: 8443, endPort: 8443, hostIp: '', protocol: 'tcp' },
    ]);
  });

  it('treats a disabled healthcheck as none', () => {
    const m = parseEffectiveModel({ services: { web: { healthcheck: { disable: true } } } }, 'fallback');
    expect(m.services[0].hasHealthcheck).toBe(false);
  });

  it('falls back to the provided project name and yields an empty model for garbage', () => {
    const m = parseEffectiveModel({ services: {} }, 'mystack');
    expect(m.projectName).toBe('mystack');
    expect(m.services).toEqual([]);
    const empty = parseEffectiveModel(null, 'mystack');
    expect(empty.services).toEqual([]);
    expect(empty.networks).toEqual({});
  });
});
