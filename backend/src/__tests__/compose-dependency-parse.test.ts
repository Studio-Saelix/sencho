/**
 * Unit tests for the dependency-map compose parser: depends_on / network /
 * named-volume / declared-port extraction, external + name: resolution, and
 * the fail-soft parseError paths.
 */
import { describe, it, expect } from 'vitest';
import { mergeDeclaredCompose, parseComposeDependencies } from '../helpers/composeDependencyParse';
import { fromDeclaredCompose } from '../services/network/normalize';

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

describe('parseComposeDependencies - effective fields', () => {
  it('keeps a top-level __proto__ network as an own key', () => {
    const r = parseComposeDependencies('services:\n  web:\n    image: nginx\n    networks:\n      - __proto__\nnetworks:\n  __proto__:\n    external: true\n');
    expect(Object.prototype.hasOwnProperty.call(r.networks, '__proto__')).toBe(true);
    expect(r.networks['__proto__']).toMatchObject({ external: true });
    expect(r.services[0].networks).toEqual(['__proto__']);
  });

  it('flags a long-form templated port for interpolation', () => {
    const r = parseComposeDependencies('services:\n  web:\n    image: nginx\n    ports:\n      - target: 80\n        published: "${WEB_PORT}"\n');
    expect(r.services[0].needsInterpolation).toBe(true);
  });

  it('merges command and entrypoint independently', () => {
    const base = parseComposeDependencies('services:\n  cf:\n    image: cloudflare/cloudflared\n    command: proxy-dns\n');
    const override = parseComposeDependencies('services:\n  cf:\n    entrypoint: /bin/sh\n');
    const merged = mergeDeclaredCompose([base, override]);
    expect(merged.services[0].commandHints).toEqual(['proxy-dns']);
    expect(merged.services[0].entrypointHints).toEqual([]);
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

  it('accepts a services-free layer when the caller merges layers', () => {
    const r = parseComposeDependencies('networks:\n  a:\n', { allowEmptyServices: true });
    expect(r.parseError).toBeUndefined();
    expect(r.services).toEqual([]);
    expect(Object.keys(r.networks)).toEqual(['a']);
  });

  it('reports a parseError for an oversized file', () => {
    const r = parseComposeDependencies('x'.repeat(1_048_577));
    expect(r.parseError).toBe('Compose file is too large to parse.');
  });
});

describe('parseComposeDependencies - what Compose resolves before the services are read', () => {
  it('resolves a YAML merge key into the service', () => {
    const r = parseComposeDependencies([
      'x-cf: &cf',
      '  image: cloudflare/cloudflared:latest',
      '  command: tunnel run',
      '  environment:',
      '    - TUNNEL_TOKEN=secret',
      'services:',
      '  tun:',
      '    <<: *cf',
      '',
    ].join('\n'), { mergeKeys: true });
    expect(r.services[0]).toMatchObject({ name: 'tun', image: 'cloudflare/cloudflared:latest', envKeys: ['TUNNEL_TOKEN'], commandHints: ['tunnel'] });
  });

  it('reads a merge key as written unless the caller opts in, so stored drift baselines keep their meaning', () => {
    const file = 'x-web: &web\n  ports:\n    - "8080:80"\n  networks: [front]\nservices:\n  web:\n    <<: *web\n';
    expect(parseComposeDependencies(file).services[0]).toMatchObject({ ports: [], networks: [] });
    expect(parseComposeDependencies(file, { mergeKeys: true }).services[0]).toMatchObject({ networks: ['front'] });
    expect(parseComposeDependencies(file, { mergeKeys: true }).services[0].ports).toHaveLength(1);
  });

  it('flags a layer that uses a !reset or !override tag, and carries the flag through a merge', () => {
    const tagged = parseComposeDependencies('services:\n  edge:\n    network_mode: !reset null\n');
    expect(tagged.hasLayerTags).toBe(true);
    expect(parseComposeDependencies('services:\n  edge:\n    image: a\n').hasLayerTags).toBe(false);
    const plain = parseComposeDependencies('services:\n  edge:\n    image: a\n');
    expect(mergeDeclaredCompose([plain, tagged]).hasLayerTags).toBe(true);
    expect(mergeDeclaredCompose([plain, plain]).hasLayerTags).toBe(false);
  });

  it('expands a volume source template before reading the mount target', () => {
    const lookup = (name: string) => (name === 'CF_DIR' ? '/srv/cf' : undefined);
    const r = parseComposeDependencies('services:\n  edge:\n    image: a\n    volumes:\n      - ${CF_DIR:-./cf}:/etc/cloudflared\n', { lookup });
    expect(r.services[0].binds).toEqual(['/etc/cloudflared']);
    expect(r.services[0].unresolvedDetection).toBe(false);
  });

  it('marks a volume source template unresolved when no lookup is given', () => {
    const r = parseComposeDependencies('services:\n  edge:\n    image: a\n    volumes:\n      - ${CF_DIR:-./cf}:/etc/cloudflared\n');
    expect(r.services[0].needsInterpolation).toBe(true);
    expect(r.services[0].unresolvedDetection).toBe(true);
  });

  it('does not treat a $$ escape as a template that stayed unresolved', () => {
    const lookup = (name: string) => (name === 'IMG' ? 'example/app:1' : undefined);
    const r = parseComposeDependencies('services:\n  app:\n    image: ${IMG}\n    command: ["sh", "-c", "exec app --home $$HOME"]\n', { lookup });
    expect(r.services[0].needsInterpolation).toBe(true);
    expect(r.services[0].unresolvedDetection).toBe(false);
  });

  it('keeps external: true from the base layer when an override only sets a name', () => {
    const base = parseComposeDependencies('services:\n  a:\n    image: a\nnetworks:\n  shared:\n    external: true\n');
    const override = parseComposeDependencies('networks:\n  shared:\n    name: lan\n', { allowEmptyServices: true });
    const merged = mergeDeclaredCompose([base, override]);
    expect(merged.networks.shared).toEqual({ name: 'lan', external: true });
  });

  it('keeps a network keyed __proto__ as plain data when normalizing', () => {
    const r = parseComposeDependencies('services:\n  a:\n    image: a\nnetworks:\n  constructor: {}\n');
    const model = fromDeclaredCompose(r, 'proj');
    expect(Object.keys(model.networks)).toEqual(['constructor']);
    expect(Object.getPrototypeOf(model.networks)).toBeNull();
  });
});
