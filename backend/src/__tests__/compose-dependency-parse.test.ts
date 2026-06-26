/**
 * Unit tests for the dependency-map compose parser: depends_on / network /
 * named-volume / declared-port extraction, external + name: resolution, and
 * the fail-soft parseError paths.
 */
import { describe, it, expect } from 'vitest';
import { parseComposeDependencies } from '../helpers/composeDependencyParse';

const svc = (name: string, body: string) => `services:\n  ${name}:\n${body.split('\n').map((l) => l ? '    ' + l : l).join('\n')}\n`;

describe('parseComposeDependencies - services and depends_on', () => {
  it('extracts depends_on in list form', () => {
    const r = parseComposeDependencies(svc('web', 'image: nginx\ndepends_on:\n  - db\n  - cache'));
    expect(r.services[0].dependsOn).toEqual(['db', 'cache']);
  });

  it('extracts depends_on in map form', () => {
    const r = parseComposeDependencies('services:\n  web:\n    depends_on:\n      db:\n        condition: service_healthy\n');
    expect(r.services[0].dependsOn).toEqual(['db']);
  });

  it('extracts service networks in list and map form', () => {
    const list = parseComposeDependencies(svc('web', 'networks:\n  - frontend\n  - backend'));
    expect(list.services[0].networks).toEqual(['frontend', 'backend']);
    const map = parseComposeDependencies('services:\n  web:\n    networks:\n      frontend:\n        aliases: [w]\n');
    expect(map.services[0].networks).toEqual(['frontend']);
  });
});

describe('parseComposeDependencies - volumes', () => {
  it('keeps named volumes and drops binds and anonymous volumes', () => {
    const r = parseComposeDependencies(svc('web', 'volumes:\n  - db_data:/var/lib\n  - ./local:/app\n  - /abs/path:/data\n  - /anon-target'));
    expect(r.services[0].volumes).toEqual(['db_data']);
  });

  it('keeps a long-form named volume and drops a long-form bind', () => {
    const r = parseComposeDependencies('services:\n  web:\n    volumes:\n      - type: volume\n        source: data\n        target: /d\n      - type: bind\n        source: /host\n        target: /b\n');
    expect(r.services[0].volumes).toEqual(['data']);
  });

  it('drops env-var-interpolated bind sources and keeps real named volumes', () => {
    const r = parseComposeDependencies(svc('web', 'volumes:\n  - ${BACKUPS_PATH}:/backups\n  - $LEGACY_PATH:/legacy\n  - db_data:/var/lib'));
    expect(r.services[0].volumes).toEqual(['db_data']);
  });

  it('drops a bind source with an embedded (non-leading) env var', () => {
    const r = parseComposeDependencies(svc('web', 'volumes:\n  - prefix-${SUB}:/data'));
    expect(r.services[0].volumes).toEqual([]);
  });

  it('passes a long-form type: volume env-var source through unchanged', () => {
    // The long-form path never calls isNamedVolumeSource, so its contract is
    // unaffected by the short-form env-var fix; this guards that.
    const r = parseComposeDependencies('services:\n  web:\n    volumes:\n      - type: volume\n        source: ${MY_VOLUME}\n        target: /d\n');
    expect(r.services[0].volumes).toEqual(['${MY_VOLUME}']);
  });

  it('does not flag env-var bind mounts as named volumes (issue #1464 repro)', () => {
    const r = parseComposeDependencies(
      'services:\n' +
      '  core:\n' +
      '    volumes:\n' +
      '      - ${COMPOSE_KOMODO_BACKUPS_PATH}:/backups\n' +
      '      - keys:/config/keys\n' +
      '  periphery:\n' +
      '    volumes:\n' +
      '      - /var/run/docker.sock:/var/run/docker.sock\n' +
      '      - ${PERIPHERY_ROOT_DIRECTORY}:/root\n' +
      '      - ${PERIPHERY_STACK_DIR}:/stack\n',
    );
    const core = r.services.find((s) => s.name === 'core');
    const periphery = r.services.find((s) => s.name === 'periphery');
    expect(core?.volumes).toEqual(['keys']);
    expect(periphery?.volumes).toEqual([]);
  });
});

describe('parseComposeDependencies - ports', () => {
  it('parses short-form host:container with default tcp', () => {
    const r = parseComposeDependencies(svc('web', 'ports:\n  - "8080:80"'));
    expect(r.services[0].ports).toEqual([{ hostIp: '', publishedPort: 8080, protocol: 'tcp' }]);
  });

  it('parses ip:host:container and the /udp protocol', () => {
    const r = parseComposeDependencies(svc('web', 'ports:\n  - "127.0.0.1:5353:53/udp"'));
    expect(r.services[0].ports).toEqual([{ hostIp: '127.0.0.1', publishedPort: 5353, protocol: 'udp' }]);
  });

  it('drops a container-only port (no host publish)', () => {
    const r = parseComposeDependencies(svc('web', 'ports:\n  - "80"'));
    expect(r.services[0].ports).toEqual([]);
  });

  it('takes the low end of a published range', () => {
    const r = parseComposeDependencies(svc('web', 'ports:\n  - "8000-8002:80"'));
    expect(r.services[0].ports[0].publishedPort).toBe(8000);
  });

  it('parses long-form ports with host_ip and protocol', () => {
    const r = parseComposeDependencies('services:\n  web:\n    ports:\n      - target: 80\n        published: 8080\n        host_ip: 10.0.0.5\n        protocol: udp\n');
    expect(r.services[0].ports).toEqual([{ hostIp: '10.0.0.5', publishedPort: 8080, protocol: 'udp' }]);
  });
});

describe('parseComposeDependencies - network_mode', () => {
  it('captures network_mode and leaves it undefined when absent', () => {
    const host = parseComposeDependencies(svc('web', 'image: nginx\nnetwork_mode: host'));
    expect(host.services[0].networkMode).toBe('host');
    const none = parseComposeDependencies(svc('web', 'image: nginx'));
    expect(none.services[0].networkMode).toBeUndefined();
  });
});

describe('parseComposeDependencies - top-level resources', () => {
  it('normalizes external (bool), legacy external object, and name: override', () => {
    const r = parseComposeDependencies('services:\n  web:\n    image: nginx\nnetworks:\n  a:\n  b:\n    external: true\n  c:\n    external:\n      name: legacy_net\n  d:\n    name: custom_net\nvolumes:\n  v:\n    external: true\n');
    expect(r.networks.a).toEqual({ external: false });
    expect(r.networks.b).toEqual({ external: true });
    expect(r.networks.c).toEqual({ name: 'legacy_net', external: true });
    expect(r.networks.d).toEqual({ name: 'custom_net', external: false });
    expect(r.volumes.v).toEqual({ external: true });
  });
});

describe('parseComposeDependencies - fail soft', () => {
  it('reports a parseError for invalid YAML and never throws', () => {
    const r = parseComposeDependencies('services:\n  web:\n  - this: : is broken\n :::');
    expect(r.parseError).toBeTruthy();
    expect(r.services).toEqual([]);
  });

  it('reports a parseError when there are no services', () => {
    const r = parseComposeDependencies('networks:\n  a:\n');
    expect(r.parseError).toBe('No services found in this file.');
  });

  it('reports a parseError for an oversized file', () => {
    const r = parseComposeDependencies('x'.repeat(1_048_577));
    expect(r.parseError).toBe('Compose file is too large to parse.');
  });
});
