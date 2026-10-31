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

  it('keeps a container-only port as a dynamic publication, and `expose` as none', () => {
    const r = parseComposeDependencies(svc('web', 'ports:\n  - "80"'));
    expect(r.services[0].ports).toEqual([
      { hostIp: '', publishedPort: 0, protocol: 'tcp', dynamic: true, targetStartPort: 80, targetEndPort: 80 },
    ]);
    expect(parseComposeDependencies(svc('web', 'expose:\n  - "80"')).services[0].ports).toEqual([]);
  });

  it.each<[string, string, { hostIp: string; protocol: string; target: [number, number] }]>([
    ['a container-only UDP port', '"51820/udp"', { hostIp: '', protocol: 'udp', target: [51820, 51820] }],
    ['an empty host port after an interface', '"127.0.0.1::51820/udp"', { hostIp: '127.0.0.1', protocol: 'udp', target: [51820, 51820] }],
    ['host port 0 after an interface', '"127.0.0.1:0:51820/udp"', { hostIp: '127.0.0.1', protocol: 'udp', target: [51820, 51820] }],
    ['host port 0', '"0:80"', { hostIp: '', protocol: 'tcp', target: [80, 80] }],
    ['an empty host port', '":80"', { hostIp: '', protocol: 'tcp', target: [80, 80] }],
    ['a bracketed IPv6 interface with an empty host port', '"[::1]::51820/udp"', { hostIp: '::1', protocol: 'udp', target: [51820, 51820] }],
    ['a container port range', '"9000-9002"', { hostIp: '', protocol: 'tcp', target: [9000, 9002] }],
    ['a long entry with no published port', '{ target: 51820, protocol: udp }', { hostIp: '', protocol: 'udp', target: [51820, 51820] }],
    ['a long entry published at 0', '{ target: 51820, published: 0, protocol: udp, host_ip: 127.0.0.1 }', { hostIp: '127.0.0.1', protocol: 'udp', target: [51820, 51820] }],
    ['a long entry published as an empty string', '{ target: 80, published: "" }', { hostIp: '', protocol: 'tcp', target: [80, 80] }],
    ['a range that starts at 0', '"0-80:80"', { hostIp: '', protocol: 'tcp', target: [80, 80] }],
  ])('keeps %s as a dynamic publication with no invented port number', (_label, entry, expected) => {
    const r = parseComposeDependencies(`services:\n  web:\n    ports:\n      - ${entry}\n`);
    const { target, ...rest } = expected;
    expect(r.services[0].ports).toEqual([
      { ...rest, publishedPort: 0, dynamic: true, targetStartPort: target[0], targetEndPort: target[1] },
    ]);
  });

  it.each<[string, string, { hostIp: string; publishedPort: number }]>([
    ['a bracketed IPv6 interface', '"[::1]:51820:51820/udp"', { hostIp: '::1', publishedPort: 51820 }],
    ['an unbracketed IPv6 interface', '"::1:51820:51820/udp"', { hostIp: '::1', publishedPort: 51820 }],
    ['a bracketed wildcard IPv6 interface', '"[::]:8443:443"', { hostIp: '::', publishedPort: 8443 }],
  ])('reads %s as the interface and a fixed host port', (_label, entry, expected) => {
    const r = parseComposeDependencies(`services:\n  web:\n    ports:\n      - ${entry}\n`);
    expect(r.services[0].ports).toEqual([expect.objectContaining(expected)]);
    expect(r.services[0].ports[0].dynamic).toBeUndefined();
  });

  it.each<[string, string, { hostIp: string; publishedPort: number }]>([
    ['a leading plus on the host port', '"+80:80"', { hostIp: '', publishedPort: 80 }],
    ['leading zeros on the host port', '"00080:80"', { hostIp: '', publishedPort: 80 }],
    ['leading zeros on a host port range', '"080-081:80"', { hostIp: '', publishedPort: 80 }],
    ['a leading plus on both ends of a range', '"+80-+81:80"', { hostIp: '', publishedPort: 80 }],
  ])('reads %s as the fixed host port Compose renders', (_label, entry, expected) => {
    const r = parseComposeDependencies(`services:\n  web:\n    ports:\n      - ${entry}\n`);
    expect(r.services[0].ports).toEqual([expect.objectContaining(expected)]);
    expect(r.services[0].ports[0].dynamic).toBeUndefined();
  });

  it.each<[string, string, string, number]>([
    ['a leading plus on a container-only port', '"+51820/udp"', 'udp', 51820],
    ['leading zeros on a container-only port', '"00051820/udp"', 'udp', 51820],
    ['a leading plus on host port zero', '"+0:80"', 'tcp', 80],
  ])('keeps %s as a dynamic publication, as Compose renders it', (_label, entry, protocol, target) => {
    const r = parseComposeDependencies(`services:\n  web:\n    ports:\n      - ${entry}\n`);
    expect(r.services[0].ports).toEqual([
      { hostIp: '', publishedPort: 0, protocol, dynamic: true, targetStartPort: target, targetEndPort: target },
    ]);
  });

  it.each([
    '"[::1]:80"', '"abc:80"', '"web"', '""', '"65536:80"', '"80-65536:80"', '"8002-8000:80"', '" 80:80"',
    '"8080x"', '"80-"', '"80-90-100"', '"65536"', '"0"', '"0-80"',
    '"8080:8080x"', '"8080:0"', '"8080:0-80"',
    '{ target: "8080x", published: 0 }', '{ target: "80-", protocol: udp }', '{ target: 0 }',
    '{ target: "x", published: 8080 }', '{ target: "80-", published: 8080 }',
  ])('drops %s, which Compose refuses', (entry) => {
    const r = parseComposeDependencies(`services:\n  web:\n    ports:\n      - ${entry}\n`);
    expect(r.services[0].ports).toEqual([]);
  });

  it('expands a template that leaves the host port empty into a dynamic publication', () => {
    const r = parseComposeDependencies(svc('web', 'ports:\n  - "${HOST_PORT}:51820/udp"'), { lookup: () => undefined });
    expect(r.services[0].ports).toEqual([
      { hostIp: '', publishedPort: 0, protocol: 'udp', dynamic: true, targetStartPort: 51820, targetEndPort: 51820 },
    ]);
  });

  it('drops a whole-entry port template, whose shape Compose decides only after interpolation', () => {
    // Without the environment the entry may be a fixed "8080:80" or an
    // auto-assigned "51820/udp", so there is no publication shape to record.
    for (const entry of ['"${PORTS}"', '"$PORT"', '"${PORTS}/udp"']) {
      expect(parseComposeDependencies(svc('web', `ports:\n  - ${entry}`)).services[0].ports).toEqual([]);
    }
  });

  it('reads a whole-entry port template once the lookup answers it', () => {
    const lookup = (name: string) => ({ PORTS: '8080:80' } as Record<string, string>)[name];
    expect(parseComposeDependencies(svc('web', 'ports:\n  - "${PORTS}"'), { lookup }).services[0].ports)
      .toEqual([{ hostIp: '', publishedPort: 8080, protocol: 'tcp' }]);
  });

  it('keeps a fixed publication whose container port is a template when no lookup can resolve it', () => {
    const yaml = 'services:\n  web:\n    ports:\n      - "8080:${APP_PORT}"\n      - { target: "${APP_PORT}", published: 8080 }\n';
    const r = parseComposeDependencies(yaml);
    expect(r.services[0].ports).toEqual([
      { hostIp: '', publishedPort: 8080, protocol: 'tcp' },
      { hostIp: '', publishedPort: 8080, protocol: 'tcp' },
    ]);
    // Once the lookup answers, the same numeric rule applies: Compose refuses a
    // bad value, so it is not kept as a publication.
    expect(parseComposeDependencies(yaml, { lookup: () => '8080x' }).services[0].ports).toEqual([]);
    expect(parseComposeDependencies(yaml, { lookup: name => (name === 'APP_PORT' ? '8443' : undefined) }).services[0].ports[0].publishedPort).toBe(8080);
    // The same rule holds for an auto-assigned host port: keep the publication
    // even though the container target is still a template.
    expect(parseComposeDependencies(svc('web', 'ports:\n  - "0:${APP_PORT}"')).services[0].ports)
      .toEqual([{ hostIp: '', publishedPort: 0, protocol: 'tcp', dynamic: true }]);
    expect(parseComposeDependencies(svc('web', 'ports:\n  - { target: "${APP_PORT}", published: 0 }')).services[0].ports)
      .toEqual([{ hostIp: '', publishedPort: 0, protocol: 'tcp', dynamic: true }]);
    // A written interface is a shape, so the declaration survives with its
    // interface and no target; a templated interface has none to record.
    expect(parseComposeDependencies(svc('web', 'ports:\n  - "127.0.0.1::${APP_PORT}"')).services[0].ports)
      .toEqual([{ hostIp: '127.0.0.1', publishedPort: 0, protocol: 'tcp', dynamic: true }]);
    expect(parseComposeDependencies(svc('web', 'ports:\n  - "${HOST_IP}::${APP_PORT}"')).services[0].ports).toEqual([]);
  });

  it('still drops a fixed publication whose container port Compose refuses without a template', () => {
    const r = parseComposeDependencies(svc('web', 'ports:\n  - "8080:8080x"\n  - { target: "80-", published: 8080 }'));
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

  it('interpolates a long-form protocol like the published port and host_ip, and defaults an empty one to tcp', () => {
    const yaml = 'services:\n  web:\n    ports:\n      - { target: 80, published: "${PORT}", host_ip: "${IP}", protocol: "${PROTO}" }\n';
    const vars: Record<string, string> = { PORT: '51820', IP: '127.0.0.1', PROTO: 'udp' };
    const lookup = (name: string) => vars[name];
    expect(parseComposeDependencies(yaml, { lookup }).services[0].ports).toEqual([{ hostIp: '127.0.0.1', publishedPort: 51820, protocol: 'udp' }]);
    expect(parseComposeDependencies(yaml, { lookup: name => (name === 'PROTO' ? '' : vars[name]) }).services[0].ports[0].protocol).toBe('tcp');
    // The short form expands the whole entry, so both forms agree.
    const short = 'services:\n  web:\n    ports:\n      - "${IP}:${PORT}:80/${PROTO}"\n';
    expect(parseComposeDependencies(short, { lookup }).services[0].ports).toEqual(parseComposeDependencies(yaml, { lookup }).services[0].ports);
    // A template Compose refuses stays visible to a caller that needs a complete answer.
    const required = 'services:\n  web:\n    ports:\n      - { target: 80, published: 51820, protocol: "${PROTO:?set it}" }\n';
    expect(parseComposeDependencies(required, { lookup: () => undefined }).services[0].unresolvedDetection).toBe(true);
  });
});

describe('parseComposeDependencies - environment keys', () => {
  const parse = (environment: string, lookup?: (name: string) => string | undefined) =>
    parseComposeDependencies(`services:\n  a:\n    image: a\n    environment:\n${environment}`, { lookup }).services[0];

  it('counts a key with a value, including an empty one, as set', () => {
    const svc = parse('      A: "1"\n      B: ""\n      C: 0\n', () => undefined);
    expect(svc.envKeys).toEqual(['A', 'B', 'C']);
    expect(svc.unsetEnvKeys).toEqual([]);
    expect(svc.needsInterpolation).toBe(false);
  });

  it('sets a value-less key only when the lookup answers it, in map and list form', () => {
    const vars: Record<string, string> = { ANSWERED: 'x', EMPTY: '' };
    const lookup = (name: string) => vars[name];
    for (const environment of [
      '      ANSWERED:\n      EMPTY: ~\n      MISSING:\n',
      '      - ANSWERED\n      - EMPTY\n      - MISSING\n',
    ]) {
      const svc = parse(environment, lookup);
      expect(svc.envKeys).toEqual(['ANSWERED', 'EMPTY']);
      expect(svc.unsetEnvKeys).toEqual(['MISSING']);
      expect(svc.needsInterpolation).toBe(true);
    }
  });

  it('cannot tell without a lookup, so it keeps the key and asks for one', () => {
    const svc = parse('      TUNNEL_TOKEN:\n');
    expect(svc.envKeys).toEqual(['TUNNEL_TOKEN']);
    expect(svc.unsetEnvKeys).toEqual([]);
    expect(svc.needsInterpolation).toBe(true);
  });

  it('lets a later layer replace an earlier layer\'s entry for a key, whichever way it goes', () => {
    const lookup = () => undefined;
    const layer = (environment: string) => parseComposeDependencies(`services:\n  a:\n    image: a\n    environment:\n${environment}`, { lookup });
    const unset = mergeDeclaredCompose([layer('      K: v\n      KEEP: v\n'), layer('      K:\n')]).services[0];
    expect(unset.envKeys).toEqual(['KEEP']);
    expect(unset.unsetEnvKeys).toEqual(['K']);
    const set = mergeDeclaredCompose([layer('      K:\n'), layer('      K: v\n')]).services[0];
    expect(set.envKeys).toEqual(['K']);
    expect(set.unsetEnvKeys).toEqual([]);
  });

  it('records an env_file written with format: raw', () => {
    const svc = parseComposeDependencies('services:\n  a:\n    image: a\n    env_file:\n      - plain.env\n      - path: raw.env\n        format: raw\n      - path: dotenv.env\n        format: dotenv\n').services[0];
    expect(svc.envFiles).toEqual([
      { path: 'plain.env', required: true },
      { path: 'raw.env', required: true, raw: true },
      { path: 'dotenv.env', required: true, unsupportedFormat: true },
    ]);
  });

  it('lets the last entry for a key decide whether it is set, in either order', () => {
    const keys = (entries: string[], lookup?: (name: string) => string | undefined) => {
      const svc = parseComposeDependencies(`services:\n  a:\n    image: a\n    environment:\n${entries.map(e => `      - ${e}\n`).join('')}`, { lookup }).services[0];
      return { set: svc.envKeys, unset: svc.unsetEnvKeys };
    };
    const none = () => undefined;
    expect(keys(['K=1', 'K'], none)).toEqual({ set: [], unset: ['K'] });
    expect(keys(['K', 'K=1'], none)).toEqual({ set: ['K'], unset: [] });
    expect(keys(['K=1', 'K'], name => (name === 'K' ? 'v' : undefined))).toEqual({ set: ['K'], unset: [] });
    expect(keys(['K', 'K'], none)).toEqual({ set: [], unset: ['K'] });
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
