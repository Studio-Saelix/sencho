import { describe, expect, it } from 'vitest';
import { composeServiceNames, patchServiceUrlLabel, serviceUrlOwnedBySource } from './composeServiceUrl';
import { parseServiceUrlResponse, resolveOpenAppTarget, resolvePublishedPortClick, tcpOwners, type ServiceUrlEntry } from './serviceUrlResolve';
import { buildServiceUrl } from './serviceUrl';
import { serviceUrlFromLabelValue } from './serviceUrlLabel';
import { parse, parseDocument } from 'yaml';

const ready: ServiceUrlEntry = {
  status: 'ready',
  nodeId: 1,
  stackName: 'web',
  renderable: true,
  serviceUrls: { web: 'https://app.example.com' },
  ports: {
    web: [{ host: '8080', proto: 'tcp' }, { host: '8080', proto: 'udp' }],
  },
};

describe('buildServiceUrl override', () => {
  it('returns the override verbatim', () => {
    expect(buildServiceUrl({
      publicPort: 8080,
      privatePort: 32400,
      overrideUrl: 'https://app.example.com/library',
    })).toBe('https://app.example.com/library');
  });
});

describe('tcpOwners', () => {
  it('ignores UDP on the same port number', () => {
    expect(tcpOwners({
      web: [{ host: '8080', proto: 'udp' }],
      api: [{ host: '8080', proto: 'tcp' }],
    }, 8080)).toEqual(['api']);
  });
});

describe('resolvePublishedPortClick', () => {
  it('uses the override only for the single TCP owner', () => {
    const click = resolvePublishedPortClick({
      entry: ready,
      serviceName: 'web',
      publicPort: 8080,
      portLabel: '8080 → 80/tcp',
      node: { type: 'local' },
    });
    expect(click).toMatchObject({ kind: 'link', href: 'https://app.example.com', hostLabel: 'app.example.com' });
  });

  it('keeps the generated link when the URL list is missing, legacy, or failed', () => {
    const node = { type: 'local' as const };
    for (const entry of [
      { ...ready, status: 'unsupported' as const, serviceUrls: {} },
      { ...ready, status: 'loading' as const, serviceUrls: {}, renderable: false },
      { ...ready, status: 'unavailable' as const, serviceUrls: {}, renderable: false },
    ]) {
      const click = resolvePublishedPortClick({
        entry,
        serviceName: 'web',
        publicPort: 8080,
        portLabel: '8080 → 80/tcp',
        node,
      });
      expect(click).toMatchObject({ kind: 'link', href: 'http://localhost:8080' });
    }
  });

  it('keeps a plain label when a remote node has no host and no override', () => {
    const click = resolvePublishedPortClick({
      entry: { ...ready, serviceUrls: {} },
      serviceName: 'web',
      publicPort: 8080,
      portLabel: '8080',
      node: { type: 'remote', api_url: '' },
    });
    expect(click).toEqual({ kind: 'text', portLabel: '8080', reason: '' });
  });

  it('keeps the last ready override while the list is refreshing', () => {
    const click = resolvePublishedPortClick({
      entry: { ...ready, status: 'loading' },
      serviceName: 'web',
      publicPort: 8080,
      portLabel: '8080',
      node: { type: 'local' },
    });
    expect(click).toMatchObject({ kind: 'link', href: 'https://app.example.com' });
  });

  it('keeps a remote generated link when anatomy has no service URL field', () => {
    const entry = parseServiceUrlResponse(2, 'web', true, { renderable: true, ports: { web: [{ host: '8080', proto: 'tcp' }] } });
    expect(entry.status).toBe('unsupported');
    const click = resolvePublishedPortClick({
      entry,
      serviceName: 'web',
      publicPort: 8080,
      portLabel: '8080',
      node: { type: 'remote', api_url: 'http://10.0.0.5:1852' },
    });
    expect(click).toMatchObject({ kind: 'link', href: 'http://10.0.0.5:8080' });
  });

  it('does not open another service URL when the live service no longer owns the port', () => {
    const click = resolvePublishedPortClick({
      entry: {
        ...ready,
        serviceUrls: {
          web: 'https://web.example.com',
          api: 'https://api.example.com',
        },
        ports: {
          web: [{ host: '8081', proto: 'tcp' }],
          api: [{ host: '8080', proto: 'tcp' }],
        },
      },
      serviceName: 'web',
      publicPort: 8080,
      portLabel: '8080 → 80/tcp',
      node: { type: 'local' },
    });
    expect(click).toMatchObject({ kind: 'link', href: 'http://localhost:8080' });
  });

  it('uses the service URL for a dynamically published port', () => {
    // Short form `ports: ['80']` and long form `{ target: 80 }` both render with an empty host.
    const dynamic = {
      ...ready,
      ports: { web: [{ host: '', container: '80', proto: 'tcp' }] },
    };
    const local = resolvePublishedPortClick({
      entry: dynamic,
      serviceName: 'web',
      publicPort: 32768,
      privatePort: 80,
      portLabel: '32768 → 80/tcp',
      node: { type: 'local' },
    });
    expect(local).toMatchObject({ kind: 'link', href: 'https://app.example.com' });
    const remote = resolvePublishedPortClick({
      entry: dynamic,
      serviceName: 'web',
      publicPort: 32768,
      privatePort: 80,
      portLabel: '32768 → 80/tcp',
      node: { type: 'remote', api_url: 'http://node.example.com:1852' },
    });
    expect(remote).toMatchObject({ kind: 'link', href: 'https://app.example.com' });
  });

  it('does not use another service URL when a dynamic port was reassigned', () => {
    const click = resolvePublishedPortClick({
      entry: {
        ...ready,
        serviceUrls: { web: 'https://web.example.com', api: 'https://api.example.com' },
        ports: {
          web: [{ host: '', container: '80', proto: 'tcp' }],
          api: [{ host: '32768', container: '80', proto: 'tcp' }],
        },
      },
      serviceName: 'web',
      publicPort: 32768,
      privatePort: 80,
      portLabel: '32768',
      node: { type: 'local' },
    });
    expect(click).toMatchObject({ kind: 'link', href: 'http://localhost:32768' });
  });

  it('keeps the generated link when the named service has no URL', () => {
    const click = resolvePublishedPortClick({
      entry: {
        ...ready,
        serviceUrls: { api: 'https://api.example.com' },
        ports: { web: [{ host: '8080', proto: 'tcp' }] },
      },
      serviceName: 'web',
      publicPort: 8080,
      portLabel: '8080',
      node: { type: 'local' },
    });
    expect(click).toMatchObject({ kind: 'link', href: 'http://localhost:8080' });
  });

  it('uses the inferred owner when that service still publishes the port', () => {
    const click = resolvePublishedPortClick({
      entry: {
        ...ready,
        serviceUrls: {
          web: 'https://web.example.com',
          api: 'https://api.example.com',
        },
        ports: { api: [{ host: '8080', proto: 'tcp' }] },
      },
      serviceName: 'api',
      publicPort: 8080,
      portLabel: ':8080',
      node: { type: 'local' },
    });
    expect(click).toMatchObject({ kind: 'link', href: 'https://api.example.com' });
  });

  it('opens the named service URL when another service binds the same port number', () => {
    const entry: ServiceUrlEntry = {
      ...ready,
      serviceUrls: { web: 'https://web.example.com', api: 'https://api.example.com' },
      ports: {
        web: [{ host: '8080', proto: 'tcp', container: '80' }],
        api: [{ host: '8080', proto: 'tcp', container: '90' }],
      },
    };
    expect(resolvePublishedPortClick({
      entry,
      serviceName: 'web',
      publicPort: 8080,
      privatePort: 80,
      portLabel: '8080',
      node: { type: 'local' },
    })).toMatchObject({ kind: 'link', href: 'https://web.example.com' });
    expect(resolvePublishedPortClick({
      entry,
      serviceName: 'api',
      publicPort: 8080,
      privatePort: 90,
      portLabel: '8080',
      node: { type: 'remote', api_url: 'http://node.example.com:1852' },
    })).toMatchObject({ kind: 'link', href: 'https://api.example.com' });
  });

  it('stays ambiguous when a shared port has no single service', () => {
    const click = resolvePublishedPortClick({
      entry: {
        ...ready,
        serviceUrls: { web: 'https://web.example.com', api: 'https://api.example.com' },
        ports: {
          web: [{ host: '8080', proto: 'tcp' }],
          api: [{ host: '8080', proto: 'tcp' }],
        },
      },
      serviceName: undefined,
      publicPort: 8080,
      portLabel: '8080',
      node: { type: 'local' },
    });
    expect(click).toMatchObject({ kind: 'text', reason: 'More than one service publishes this port' });
  });
});

describe('resolveOpenAppTarget', () => {
  it('opens the only override when the stack publishes no port', () => {
    expect(resolveOpenAppTarget({
      entry: { ...ready, ports: {} },
      node: { type: 'remote' },
    })).toEqual({ url: 'https://app.example.com' });
  });

  it('does not open another service URL when this port has no generated link', () => {
    expect(resolveOpenAppTarget({
      entry: {
        ...ready,
        serviceUrls: { api: 'https://api.example.com' },
        ports: { web: [{ host: '8080', proto: 'tcp' }] },
      },
      publicPort: 8080,
      node: { type: 'remote' },
    })).toEqual({ error: 'Service URL unavailable' });
  });

  it('opens a dynamically published URL on a node with no generated host', () => {
    expect(resolveOpenAppTarget({
      entry: {
        ...ready,
        ports: { web: [{ host: '', container: '80', proto: 'tcp' }] },
      },
      publicPort: 32768,
      node: { type: 'remote', api_url: '' },
    })).toEqual({ url: 'https://app.example.com' });
  });

  it('does not open a labeled sibling when another service also has a dynamic port', () => {
    const entry: ServiceUrlEntry = {
      ...ready,
      serviceUrls: { api: 'https://api.example.com' },
      ports: {
        web: [{ host: '', container: '80', proto: 'tcp' }],
        api: [{ host: '', container: '90', proto: 'tcp' }],
      },
    };
    expect(resolveOpenAppTarget({
      entry,
      publicPort: 32768,
      node: { type: 'local' },
    })).toEqual({ url: 'http://localhost:32768' });
    expect(resolveOpenAppTarget({
      entry,
      publicPort: 32768,
      node: { type: 'remote', api_url: 'http://node.example.com:1852' },
    })).toEqual({ url: 'http://node.example.com:32768' });
  });

  it('refuses Open App when two dynamic bindings each have a URL', () => {
    expect(resolveOpenAppTarget({
      entry: {
        ...ready,
        serviceUrls: { web: 'https://web.example.com', api: 'https://api.example.com' },
        ports: {
          web: [{ host: '', container: '80', proto: 'tcp' }],
          api: [{ host: '', container: '90', proto: 'tcp' }],
        },
      },
      publicPort: 32768,
      node: { type: 'local' },
    })).toEqual({ error: 'More than one service publishes this port' });
  });
});

describe('parseServiceUrlResponse', () => {
  it('drops a URL the allowlist rejects', () => {
    const entry = parseServiceUrlResponse(1, 'web', true, {
      serviceUrls: { web: 'javascript:alert(1)', api: 'https://api.example.com' },
      renderable: true,
      ports: {},
    });
    expect(entry.status).toBe('ready');
    expect(entry.serviceUrls).toEqual({ api: 'https://api.example.com' });
  });

  it('keeps dossier facts when an older node omits service URLs', () => {
    const entry = parseServiceUrlResponse(2, 'web', true, {
      renderable: true,
      services: ['web', 'api'],
      ports: { web: [{ host: '8080', proto: 'tcp' }] },
      networks: ['proxy'],
    });
    expect(entry.status).toBe('unsupported');
    expect(entry.services).toEqual(['web', 'api']);
    expect(entry.ports.web).toEqual([{ host: '8080', proto: 'tcp' }]);
    expect(entry.networks).toEqual(['proxy']);
  });
});

describe('patchServiceUrlLabel', () => {
  it('writes a literal dollar as $$ and leaves unrelated keys', () => {
    const source = 'services:\n  web:\n    image: nginx\n    labels:\n      traefik.enable: "true"\n';
    const patched = patchServiceUrlLabel(source, 'web', 'https://app.example.com/a$b');
    expect(patched.ok).toBe(true);
    if (!patched.ok) return;
    expect(patched.yaml).toContain('traefik.enable');
    expect(patched.yaml).toContain('sencho.service.url');
    expect(patched.yaml).toContain('https://app.example.com/a$$b');
  });

  it('updates a list-form label and refuses a service that is not in the buffer', () => {
    const source = 'services:\n  web:\n    labels:\n      - traefik.enable=true\n';
    const patched = patchServiceUrlLabel(source, 'web', 'https://app.example.com');
    expect(patched.ok).toBe(true);
    if (patched.ok) expect(patched.yaml).toContain('sencho.service.url=https://app.example.com');
    expect(patchServiceUrlLabel(source, 'api', 'https://app.example.com')).toEqual({ ok: false, reason: 'missing-service' });
  });

  it('keeps labels inherited through a merge, and leaves the sibling alone', () => {
    const source = [
      'x-common: &common',
      '  labels:',
      '    traefik.enable: "true"',
      '    traefik.http.routers.web.rule: Host(`app.example.com`)',
      'services:',
      '  web:',
      '    <<: *common',
      '    image: nginx',
      '  api:',
      '    <<: *common',
      '    image: redis',
      '',
    ].join('\n');
    const added = patchServiceUrlLabel(source, 'web', 'https://app.example.com');
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const merged = parse(added.yaml, { merge: true }) as {
      services: { web: { labels: Record<string, string> }; api: { labels: Record<string, string> } };
    };
    expect(merged.services.web.labels['traefik.enable']).toBe('true');
    expect(merged.services.web.labels['sencho.service.url']).toBe('https://app.example.com');
    expect(merged.services.api.labels['sencho.service.url']).toBeUndefined();
    expect(added.yaml.split('services:')[0]).not.toContain('sencho.service.url');

    const cleared = patchServiceUrlLabel(added.yaml, 'web', null);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    const afterClear = parse(cleared.yaml, { merge: true }) as {
      services: { web: { labels: Record<string, string> }; api: { labels: Record<string, string> } };
    };
    expect(afterClear.services.web.labels['traefik.enable']).toBe('true');
    expect(afterClear.services.web.labels['sencho.service.url']).toBeUndefined();
    expect(afterClear.services.api.labels['sencho.service.url']).toBeUndefined();
  });

  it('copies an aliased label map onto the edited service only', () => {
    const source = [
      'x-labels: &labels',
      '  traefik.enable: "true"',
      'services:',
      '  web:',
      '    labels: *labels',
      '  api:',
      '    labels: *labels',
      '',
    ].join('\n');
    const patched = patchServiceUrlLabel(source, 'web', 'https://app.example.com');
    expect(patched.ok).toBe(true);
    if (!patched.ok) return;
    const merged = parse(patched.yaml, { merge: true }) as {
      services: { web: { labels: Record<string, string> }; api: { labels: Record<string, string> } };
    };
    expect(merged.services.web.labels).toMatchObject({
      'traefik.enable': 'true',
      'sencho.service.url': 'https://app.example.com',
    });
    expect(merged.services.api.labels).toEqual({ 'traefik.enable': 'true' });
  });

  it('edits the service that owns a shared label anchor without changing consumers', () => {
    const source = [
      'services:',
      '  web:',
      '    image: nginx',
      '    labels: &labels',
      '      keep: "yes"',
      '  api:',
      '    image: redis',
      '    labels: *labels',
      '',
    ].join('\n');
    const added = patchServiceUrlLabel(source, 'web', 'https://new.example.com');
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const merged = parse(added.yaml, { merge: true }) as {
      services: { web: { labels: Record<string, string> }; api: { labels: Record<string, string> } };
    };
    expect(merged.services.web.labels).toEqual({ keep: 'yes', 'sencho.service.url': 'https://new.example.com' });
    expect(merged.services.api.labels).toEqual({ keep: 'yes' });

    const cleared = patchServiceUrlLabel(added.yaml, 'web', null);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    const afterClear = parse(cleared.yaml, { merge: true }) as typeof merged;
    expect(afterClear.services.web.labels).toEqual({ keep: 'yes' });
    expect(afterClear.services.api.labels).toEqual({ keep: 'yes' });
  });

  it('edits a shared label list from its owner without changing the consumer', () => {
    const source = [
      'services:',
      '  web:',
      '    labels: &labels',
      '      - keep=yes',
      '  api:',
      '    labels: *labels',
      '',
    ].join('\n');
    const patched = patchServiceUrlLabel(source, 'web', 'https://new.example.com');
    expect(patched.ok).toBe(true);
    if (!patched.ok) return;
    const merged = parse(patched.yaml, { merge: true }) as {
      services: { web: { labels: string[] }; api: { labels: string[] } };
    };
    expect(merged.services.web.labels).toEqual(['keep=yes', 'sencho.service.url=https://new.example.com']);
    expect(merged.services.api.labels).toEqual(['keep=yes']);
  });

  it('clears a local override without restoring the merged URL', () => {
    const source = [
      'x-labels: &labels',
      '  keep: "yes"',
      '  sencho.service.url: https://default.example.com',
      'services:',
      '  web:',
      '    labels:',
      '      <<: *labels',
      '      sencho.service.url: https://web.example.com',
      '  api:',
      '    labels: *labels',
      '',
    ].join('\n');
    const cleared = patchServiceUrlLabel(source, 'web', null);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    const merged = parse(cleared.yaml, { merge: true }) as {
      services: { web: { labels: Record<string, string> }; api: { labels: Record<string, string> } };
    };
    expect(merged.services.web.labels['sencho.service.url']).toBeUndefined();
    expect(merged.services.web.labels.keep).toBe('yes');
    expect(merged.services.api.labels['sencho.service.url']).toBe('https://default.example.com');
    const click = resolvePublishedPortClick({
      entry: {
        ...ready,
        serviceUrls: {},
        ports: { web: [{ host: '8080', proto: 'tcp' }] },
      },
      serviceName: 'web',
      publicPort: 8080,
      portLabel: '8080',
      node: { type: 'local' },
    });
    expect(click).toMatchObject({ kind: 'link', href: 'http://localhost:8080' });
  });

  it('copies a whole-service alias before editing it', () => {
    const source = [
      'x-service: &svc',
      '  image: nginx',
      '  labels:',
      '    keep: "yes"',
      'services:',
      '  web: *svc',
      '  api: *svc',
      '',
    ].join('\n');
    const added = patchServiceUrlLabel(source, 'web', 'https://new.example.com');
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const merged = parse(added.yaml, { merge: true }) as {
      services: { web: { labels: Record<string, string> }; api: { labels: Record<string, string> } };
    };
    expect(merged.services.web.labels['sencho.service.url']).toBe('https://new.example.com');
    expect(merged.services.api.labels).toEqual({ keep: 'yes' });
    expect(added.yaml).toContain('x-service: &svc');
    expect(added.yaml.split('x-service:')[1]?.split('services:')[0]).not.toContain('sencho.service.url');

    const cleared = patchServiceUrlLabel(added.yaml, 'web', null);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    const afterClear = parse(cleared.yaml, { merge: true }) as typeof merged;
    expect(afterClear.services.web.labels['sencho.service.url']).toBeUndefined();
    expect(afterClear.services.web.labels.keep).toBe('yes');
    expect(afterClear.services.api.labels).toEqual({ keep: 'yes' });
  });

  it('copies a service that owns a shared anchor before editing it', () => {
    const source = [
      'services:',
      '  web: &svc',
      '    image: nginx',
      '    labels:',
      '      keep: "yes"',
      '  api: *svc',
      '',
    ].join('\n');
    const patched = patchServiceUrlLabel(source, 'web', 'https://new.example.com');
    expect(patched.ok).toBe(true);
    if (!patched.ok) return;
    const merged = parse(patched.yaml, { merge: true }) as {
      services: { web: { labels: Record<string, string> }; api: { labels: Record<string, string> } };
    };
    expect(merged.services.web.labels['sencho.service.url']).toBe('https://new.example.com');
    expect(merged.services.api.labels).toEqual({ keep: 'yes' });
  });

  it('keeps an empty inherited label when the URL is set or cleared', () => {
    const source = [
      'x-labels: &labels',
      '  KEEP:',
      '  keep-string: "yes"',
      'services:',
      '  web:',
      '    image: nginx',
      '    labels: *labels',
      '  api:',
      '    image: nginx',
      '    labels: *labels',
      '',
    ].join('\n');
    const added = patchServiceUrlLabel(source, 'web', 'https://app.example.com');
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const merged = parse(added.yaml, { merge: true }) as {
      services: { web: { labels: Record<string, string | null> }; api: { labels: Record<string, string | null> } };
    };
    expect('KEEP' in merged.services.web.labels).toBe(true);
    expect(merged.services.web.labels.KEEP ?? '').toBe('');
    expect(merged.services.web.labels['keep-string']).toBe('yes');
    expect(merged.services.web.labels['sencho.service.url']).toBe('https://app.example.com');
    expect(merged.services.api.labels.KEEP ?? '').toBe('');
    expect(merged.services.api.labels['sencho.service.url']).toBeUndefined();

    const cleared = patchServiceUrlLabel(added.yaml, 'web', null);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    const afterClear = parse(cleared.yaml, { merge: true }) as typeof merged;
    expect('KEEP' in afterClear.services.web.labels).toBe(true);
    expect(afterClear.services.web.labels.KEEP ?? '').toBe('');
    expect(afterClear.services.web.labels['sencho.service.url']).toBeUndefined();
  });

  it('keeps an empty label when a merged URL is cleared', () => {
    const source = [
      'x-labels: &labels',
      '  KEEP:',
      '  keep-string: "yes"',
      '  sencho.service.url: https://default.example.com',
      'services:',
      '  web:',
      '    image: nginx',
      '    labels:',
      '      <<: *labels',
      '      sencho.service.url: https://old.example.com',
      '  api:',
      '    image: nginx',
      '    labels: *labels',
      '',
    ].join('\n');
    const cleared = patchServiceUrlLabel(source, 'web', null);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    const merged = parse(cleared.yaml, { merge: true }) as {
      services: { web: { labels: Record<string, string | null> }; api: { labels: Record<string, string | null> } };
    };
    expect('KEEP' in merged.services.web.labels).toBe(true);
    expect(merged.services.web.labels.KEEP ?? '').toBe('');
    expect(merged.services.web.labels['keep-string']).toBe('yes');
    expect(merged.services.web.labels['sencho.service.url']).toBeUndefined();
    expect(merged.services.api.labels.KEEP ?? '').toBe('');
    expect(merged.services.api.labels['sencho.service.url']).toBe('https://default.example.com');
  });

  it('keeps a nested anchor that another service still uses', () => {
    const source = [
      'services:',
      '  web: &svc',
      '    image: nginx',
      '    environment: &env',
      '      FOO: bar',
      '    labels:',
      '      keep: "yes"',
      '  api:',
      '    <<: *svc',
      '    environment: *env',
      '',
    ].join('\n');
    const added = patchServiceUrlLabel(source, 'web', 'https://app.example.com');
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const merged = parse(added.yaml, { merge: true }) as {
      services: {
        web: { labels: Record<string, string>; environment: Record<string, string> };
        api: { labels: Record<string, string>; environment: Record<string, string> };
      };
    };
    expect(merged.services.web.labels['sencho.service.url']).toBe('https://app.example.com');
    expect(merged.services.web.labels.keep).toBe('yes');
    expect(merged.services.api.environment.FOO).toBe('bar');
    expect(merged.services.api.labels['sencho.service.url']).toBeUndefined();
    expect(merged.services.api.labels.keep).toBe('yes');

    const cleared = patchServiceUrlLabel(added.yaml, 'web', null);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    const afterClear = parse(cleared.yaml, { merge: true }) as typeof merged;
    expect(afterClear.services.web.labels['sencho.service.url']).toBeUndefined();
    expect(afterClear.services.web.labels.keep).toBe('yes');
    expect(afterClear.services.api.environment.FOO).toBe('bar');
    expect(afterClear.services.api.labels.keep).toBe('yes');
  });

  it('keeps a sibling value when the URL scalar is shared', () => {
    const mapSource = [
      'services:',
      '  web:',
      '    image: nginx',
      '    labels:',
      '      sencho.service.url: &address https://old.example.com',
      '  api:',
      '    image: nginx',
      '    environment:',
      '      APP_URL: *address',
      '',
    ].join('\n');
    const mapSet = patchServiceUrlLabel(mapSource, 'web', 'https://new.example.com');
    expect(mapSet.ok).toBe(true);
    if (!mapSet.ok) return;
    const mapMerged = parse(mapSet.yaml, { merge: true }) as {
      services: { web: { labels: Record<string, string> }; api: { environment: Record<string, string> } };
    };
    expect(mapMerged.services.web.labels['sencho.service.url']).toBe('https://new.example.com');
    expect(mapMerged.services.api.environment.APP_URL).toBe('https://old.example.com');
    const mapClear = patchServiceUrlLabel(mapSource, 'web', null);
    expect(mapClear.ok).toBe(true);
    if (!mapClear.ok) return;
    const mapCleared = parse(mapClear.yaml, { merge: true }) as typeof mapMerged;
    expect(mapCleared.services.web.labels['sencho.service.url']).toBeUndefined();
    expect(mapCleared.services.api.environment.APP_URL).toBe('https://old.example.com');

    const listSource = [
      'services:',
      '  web:',
      '    image: nginx',
      '    labels:',
      '      - &address sencho.service.url=https://old.example.com',
      '  api:',
      '    image: nginx',
      '    labels:',
      '      - *address',
      '',
    ].join('\n');
    const listSet = patchServiceUrlLabel(listSource, 'web', 'https://new.example.com');
    expect(listSet.ok).toBe(true);
    if (!listSet.ok) return;
    const listMerged = parse(listSet.yaml, { merge: true }) as {
      services: { web: { labels: string[] }; api: { labels: string[] } };
    };
    expect(listMerged.services.web.labels).toEqual(['sencho.service.url=https://new.example.com']);
    expect(listMerged.services.api.labels).toEqual(['sencho.service.url=https://old.example.com']);
    const listClear = patchServiceUrlLabel(listSource, 'web', null);
    expect(listClear.ok).toBe(true);
    if (!listClear.ok) return;
    const listCleared = parse(listClear.yaml, { merge: true }) as typeof listMerged;
    expect(listCleared.services.web.labels).toEqual([]);
    expect(listCleared.services.api.labels).toEqual(['sencho.service.url=https://old.example.com']);
  });

  it('replaces every repeated URL list entry', () => {
    const source = [
      'services:',
      '  web:',
      '    image: nginx',
      '    labels:',
      '      - sencho.service.url=https://first.example.com',
      '      - keep=yes',
      '      - sencho.service.url=https://last.example.com',
      '',
    ].join('\n');
    const set = patchServiceUrlLabel(source, 'web', 'https://new.example.com');
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    const merged = parse(set.yaml, { merge: true }) as { services: { web: { labels: string[] } } };
    expect(merged.services.web.labels).toEqual([
      'sencho.service.url=https://new.example.com',
      'keep=yes',
    ]);
    const cleared = patchServiceUrlLabel(source, 'web', null);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    const afterClear = parse(cleared.yaml, { merge: true }) as typeof merged;
    expect(afterClear.services.web.labels).toEqual(['keep=yes']);
  });

  it('clears a list alias without changing other consumers', () => {
    const source = [
      'x-url: &url sencho.service.url=https://old.example.com',
      'services:',
      '  web:',
      '    image: nginx',
      '    labels:',
      '      - *url',
      '  api:',
      '    image: nginx',
      '    labels:',
      '      - *url',
      '',
    ].join('\n');
    const cleared = patchServiceUrlLabel(source, 'web', null);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    const merged = parse(cleared.yaml, { merge: true }) as {
      services: { web: { labels?: string[] }; api: { labels: string[] } };
    };
    expect(merged.services.web.labels ?? []).toEqual([]);
    expect(merged.services.api.labels).toEqual(['sencho.service.url=https://old.example.com']);

    const mixed = [
      'x-url: &url sencho.service.url=https://old.example.com',
      'services:',
      '  web:',
      '    image: nginx',
      '    labels:',
      '      - *url',
      '      - keep=yes',
      '      - sencho.service.url=https://last.example.com',
      '  api:',
      '    image: nginx',
      '    labels:',
      '      - *url',
      '',
    ].join('\n');
    const set = patchServiceUrlLabel(mixed, 'web', 'https://new.example.com');
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    const afterSet = parse(set.yaml, { merge: true }) as {
      services: { web: { labels: string[] }; api: { labels: string[] } };
    };
    expect(afterSet.services.web.labels).toEqual([
      'sencho.service.url=https://new.example.com',
      'keep=yes',
    ]);
    expect(afterSet.services.api.labels).toEqual(['sencho.service.url=https://old.example.com']);
  });

  it('keeps keys inherited by a flow label map', () => {
    const source = [
      'x-labels: &labels',
      '  keep: "yes"',
      '  extra: "hold"',
      'services:',
      '  web:',
      '    image: nginx',
      '    labels: { <<: *labels, other: "x" }',
      '',
    ].join('\n');
    const patched = patchServiceUrlLabel(source, 'web', 'https://app.example.com');
    expect(patched.ok).toBe(true);
    if (!patched.ok) return;
    const merged = parse(patched.yaml, { merge: true }) as {
      services: { web: { labels: Record<string, string> } };
    };
    expect(merged.services.web.labels.keep).toBe('yes');
    expect(merged.services.web.labels.extra).toBe('hold');
    expect(merged.services.web.labels.other).toBe('x');
    expect(merged.services.web.labels['sencho.service.url']).toBe('https://app.example.com');
  });

  it('adds a label inside a flow-style service', () => {
    const source = 'services:\n  web: { image: nginx }\n  api:\n    image: redis\n';
    const patched = patchServiceUrlLabel(source, 'web', 'https://app.example.com');
    expect(patched.ok).toBe(true);
    if (!patched.ok) return;
    const merged = parse(patched.yaml, { merge: true }) as {
      services: { web: { image: string; labels: Record<string, string> }; api: { image: string } };
    };
    expect(merged.services.web.image).toBe('nginx');
    expect(merged.services.web.labels['sencho.service.url']).toBe('https://app.example.com');
    expect(merged.services.api.image).toBe('redis');
    expect(patched.yaml).not.toMatch(/^labels:/m);
  });

  it('clears a URL inherited only through a service merge', () => {
    const source = [
      'x-common: &common',
      '  labels:',
      '    keep: "yes"',
      '    sencho.service.url: https://default.example.com',
      'services:',
      '  web:',
      '    <<: *common',
      '    image: nginx',
      '  api:',
      '    <<: *common',
      '    image: redis',
      '',
    ].join('\n');
    const cleared = patchServiceUrlLabel(source, 'web', null);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    const merged = parse(cleared.yaml, { merge: true }) as {
      services: { web: { labels: Record<string, string> }; api: { labels: Record<string, string> } };
    };
    expect(merged.services.web.labels['sencho.service.url']).toBeUndefined();
    expect(merged.services.web.labels.keep).toBe('yes');
    expect(merged.services.api.labels['sencho.service.url']).toBe('https://default.example.com');
  });

  it('keeps an octal mode when a whole-service alias is copied', () => {
    const source = [
      'x-service: &svc',
      '  image: nginx',
      '  secrets:',
      '    - source: db',
      '      mode: 0440',
      'services:',
      '  web: *svc',
      '  api: *svc',
      '',
    ].join('\n');
    const patched = patchServiceUrlLabel(source, 'web', 'https://app.example.com');
    expect(patched.ok).toBe(true);
    if (!patched.ok) return;
    expect(patched.yaml).toContain('mode: 0440');
    expect(patched.yaml.split('services:')[0]).toContain('mode: 0440');
    const web = patched.yaml.split('web:')[1]?.split('api:')[0] ?? '';
    expect(web).toContain('mode: 0440');
    expect(web).toContain('https://app.example.com');
    expect(patched.yaml.split('api:')[1] ?? '').not.toContain('https://app.example.com');
  });

  it('leaves every byte outside the edited label unchanged', () => {
    const comment = '# keep this comment exactly, including the long sentence that would otherwise be folded by a yaml emitter once it passes eighty columns and then some more words';
    const source = [
      comment,
      'services:',
      '    web:',
      '        image: nginx',
      '        environment:',
      '            UMASK: 022',
      '            DIR_MODE: 0775',
      '            NOTE: "this scalar is deliberately long enough that a document emitter would fold it onto the next line if the whole file were rewritten"',
      '        labels:',
      '            traefik.enable: "true"',
      '        tmpfs:',
      '            - /run:mode=01777',
      'secrets:',
      '    db:',
      '        file: ./db',
      '        mode: 0440',
      'configs:',
      '    app:',
      '        file: ./app',
      '        mode: 0644',
      '',
    ].join('\r\n');
    const patched = patchServiceUrlLabel(source, 'web', 'https://app.example.com');
    expect(patched.ok).toBe(true);
    if (!patched.ok) return;
    const inserted = '            sencho.service.url: "https://app.example.com"\r\n';
    expect(patched.yaml.includes(inserted)).toBe(true);
    expect(patched.yaml.replace(inserted, '')).toBe(source);
  });

  it('does not treat an override URL as owned by the open file', () => {
    const base = [
      'services:',
      '  web:',
      '    image: nginx',
      '',
    ].join('\n');
    expect(serviceUrlOwnedBySource(base, 'web', 'https://old.example.com')).toBe(false);
    const owning = [
      'services:',
      '  web:',
      '    image: nginx',
      '    labels:',
      '      sencho.service.url: https://app.example.com',
      '',
    ].join('\n');
    expect(serviceUrlOwnedBySource(owning, 'web', 'https://app.example.com')).toBe(true);
    expect(serviceUrlOwnedBySource(owning, 'web', undefined)).toBe(true);
    const interpolated = [
      'services:',
      '  web:',
      '    labels:',
      '      sencho.service.url: https://${APP_HOST}',
      '',
    ].join('\n');
    expect(serviceUrlOwnedBySource(interpolated, 'web', 'https://app.example.com')).toBe(true);
  });
});

describe('patchServiceUrlLabel on flow, anchored, and edge layouts', () => {
  const URL = 'https://app.example.com';
  const patchTo = (source: string, service: string, url: string | null): string => {
    const patched = patchServiceUrlLabel(source, service, url);
    if (!patched.ok) throw new Error(`patch refused: ${patched.reason}`);
    expect(parseDocument(patched.yaml).errors).toEqual([]);
    return patched.yaml;
  };

  it('adds a label inside a flow services map without leaving flow syntax', () => {
    expect(patchTo('services: { web: { image: nginx }, api: { image: redis } }\n', 'web', URL))
      .toBe('services: { web: { image: nginx, labels: { sencho.service.url: "https://app.example.com" } }, api: { image: redis } }\n');
  });

  it('adds to flow labels inside a flow service', () => {
    expect(patchTo('services:\n  web: { image: nginx, labels: { keep: "1" } }\n', 'web', URL))
      .toBe('services:\n  web: { image: nginx, labels: { keep: "1", sencho.service.url: "https://app.example.com" } }\n');
  });

  it('keeps octal and numeric tokens in a flow service as written', () => {
    const source = 'services:\n  web: { image: nginx, secrets: [{ source: s, mode: 0440 }], environment: { UMASK: 022 } }\n';
    expect(patchTo(source, 'web', URL)).toBe(
      'services:\n  web: { image: nginx, secrets: [{ source: s, mode: 0440 }], environment: { UMASK: 022 }, labels: { sencho.service.url: "https://app.example.com" } }\n',
    );
  });

  it('removes a flow label with its comma and keeps the other tokens', () => {
    expect(patchTo('services:\n  web: { labels: { a: "1", sencho.service.url: "https://old", b: 0440 } }\n', 'web', null))
      .toBe('services:\n  web: { labels: { a: "1", b: 0440 } }\n');
  });

  it('copies a flow service anchor to its consumer without the defining key', () => {
    const source = 'services:\n  web: &svc { image: nginx, user: 0440 }\n  api: *svc\n';
    expect(patchTo(source, 'web', URL)).toBe(
      'services:\n  web: &svc { image: nginx, user: 0440, labels: { sencho.service.url: "https://app.example.com" } }\n  api: { image: nginx, user: 0440 }\n',
    );
    expect(patchTo(source, 'api', URL)).toBe(
      'services:\n  web: &svc { image: nginx, user: 0440 }\n  api: { image: nginx, user: 0440, labels: { sencho.service.url: "https://app.example.com" } }\n',
    );
  });

  it('copies a shared flow label anchor to the other service instead of nesting it', () => {
    const source = 'services:\n  web:\n    labels: &l { keep: 0440 }\n  api:\n    labels: *l\n';
    expect(patchTo(source, 'web', URL)).toBe(
      'services:\n  web:\n    labels: &l { keep: 0440, sencho.service.url: "https://app.example.com" }\n  api:\n    labels: { keep: 0440 }\n',
    );
    expect(patchTo(source, 'api', URL)).toBe(
      'services:\n  web:\n    labels: &l { keep: 0440 }\n  api:\n    labels:\n      keep: 0440\n      sencho.service.url: "https://app.example.com"\n',
    );
  });

  it('starts a new line when the last label has no final newline', () => {
    const map = 'services:\n  web:\n    labels:\n      keep: yes';
    expect(patchTo(map, 'web', URL)).toBe(`${map}\n      sencho.service.url: "https://app.example.com"`);
    const list = 'services:\n  web:\n    labels:\n      - keep=yes # note';
    expect(patchTo(list, 'web', URL)).toBe(`${list}\n      - sencho.service.url=https://app.example.com`);
    const crlf = 'services:\r\n  web:\r\n    labels:\r\n      keep: yes';
    expect(patchTo(crlf, 'web', URL)).toBe(`${crlf}\r\n      sencho.service.url: "https://app.example.com"`);
  });

  it('sets an empty or null URL label with its separator and keeps the neighbors', () => {
    const empty = 'services:\n  web:\n    labels:\n      sencho.service.url:\n      keep: yes\n';
    expect(patchTo(empty, 'web', URL)).toBe('services:\n  web:\n    labels:\n      sencho.service.url: "https://app.example.com"\n      keep: yes\n');
    expect(patchTo(empty, 'web', null)).toBe('services:\n  web:\n    labels:\n      keep: yes\n');
    const commented = 'services:\n  web:\n    labels:\n      sencho.service.url: # set later\n      keep: yes\n';
    expect(patchTo(commented, 'web', URL)).toBe('services:\n  web:\n    labels:\n      sencho.service.url: "https://app.example.com" # set later\n      keep: yes\n');
    const tilde = 'services:\n  web:\n    labels:\n      sencho.service.url: ~\n      keep: yes\n';
    expect(patchTo(tilde, 'web', URL)).toBe('services:\n  web:\n    labels:\n      sencho.service.url: "https://app.example.com"\n      keep: yes\n');
  });

  it('fills a `labels:` key that has no value yet', () => {
    expect(patchTo('services:\n  web:\n    labels:\n    image: nginx\n', 'web', URL))
      .toBe('services:\n  web:\n    labels:\n      sencho.service.url: "https://app.example.com"\n    image: nginx\n');
  });

  it('quotes a flow list entry and replaces or clears repeated entries', () => {
    expect(patchTo('services:\n  web: { labels: [ "a=1", b=2 ] }\n', 'web', 'https://app.example.com/x,y'))
      .toBe('services:\n  web: { labels: [ "a=1", b=2, "sencho.service.url=https://app.example.com/x,y" ] }\n');
    expect(patchTo('services:\n  web: { labels: [ sencho.service.url=https://o, keep=1, sencho.service.url=https://p ] }\n', 'web', URL))
      .toBe('services:\n  web: { labels: [ "sencho.service.url=https://app.example.com", keep=1 ] }\n');
    expect(patchTo('services:\n  web:\n    labels: [sencho.service.url=https://o, sencho.service.url=https://p, keep=1]\n', 'web', null))
      .toBe('services:\n  web:\n    labels: [keep=1]\n');
  });

  it('keeps a numeric inherited label token when the labels are copied', () => {
    const source = 'x-b: &b\n  labels:\n    port: 0440\nservices:\n  web:\n    <<: *b\n    image: nginx\n';
    expect(patchTo(source, 'web', URL)).toBe(
      'x-b: &b\n  labels:\n    port: 0440\nservices:\n  web:\n    labels:\n      port: 0440\n      sencho.service.url: "https://app.example.com"\n    <<: *b\n    image: nginx\n',
    );
  });

  it('appends before commented-out labels that close the block', () => {
    expect(patchTo('services:\n  web:\n    labels:\n      a: b\n      # traefik.enable: true\n  api:\n    image: x\n', 'web', URL))
      .toBe('services:\n  web:\n    labels:\n      a: b\n      sencho.service.url: "https://app.example.com"\n      # traefik.enable: true\n  api:\n    image: x\n');
    expect(patchTo('services:\n  web:\n    labels:\n      - a=b\n      # - traefik.enable=true\n    image: x\n', 'web', URL))
      .toBe('services:\n  web:\n    labels:\n      - a=b\n      - sencho.service.url=https://app.example.com\n      # - traefik.enable=true\n    image: x\n');
    expect(patchTo('services:\r\n  web:\r\n    labels:\r\n      a: b\r\n      # old: 1\r\n    image: x\r\n', 'web', URL))
      .toBe('services:\r\n  web:\r\n    labels:\r\n      a: b\r\n      sencho.service.url: "https://app.example.com"\r\n      # old: 1\r\n    image: x\r\n');
  });

  it('appends at the end of the file with or without a comment on the last label', () => {
    expect(patchTo('services:\n  web:\n    labels:\n      keep: yes # n', 'web', URL))
      .toBe('services:\n  web:\n    labels:\n      keep: yes # n\n      sencho.service.url: "https://app.example.com"');
    expect(patchTo('services:\n  web:\n    labels:\n      - keep=yes', 'web', URL))
      .toBe('services:\n  web:\n    labels:\n      - keep=yes\n      - sencho.service.url=https://app.example.com');
    expect(patchTo('services:\r\n  web:\r\n    labels:\r\n      - keep=yes # n\r\n', 'web', URL))
      .toBe('services:\r\n  web:\r\n    labels:\r\n      - keep=yes # n\r\n      - sencho.service.url=https://app.example.com\r\n');
  });

  it('keeps a comment on an empty `labels:` key', () => {
    expect(patchTo('services:\n  web:\n    image: y\n    labels: # none yet\n', 'web', URL))
      .toBe('services:\n  web:\n    image: y\n    labels: # none yet\n      sencho.service.url: "https://app.example.com"\n');
  });

  it('clears an empty, null, or commented URL label and keeps the next label in place', () => {
    expect(patchTo('services:\n  web:\n    labels:\n      sencho.service.url: # later\n      keep: yes\n', 'web', null))
      .toBe('services:\n  web:\n    labels:\n      keep: yes\n');
    expect(patchTo('services:\n  web:\n    labels:\n      sencho.service.url: ~\n      keep: yes\n', 'web', null))
      .toBe('services:\n  web:\n    labels:\n      keep: yes\n');
    expect(patchTo('services:\n  web:\n    labels:\n      sencho.service.url: null\n      keep: yes\n', 'web', URL))
      .toBe('services:\n  web:\n    labels:\n      sencho.service.url: "https://app.example.com"\n      keep: yes\n');
  });

  it('writes `labels: {}` on the key line when the only label is cleared', () => {
    expect(patchTo('services:\n  web:\n    labels:\n      sencho.service.url: x\n    image: y\n', 'web', null))
      .toBe('services:\n  web:\n    labels: {}\n    image: y\n');
  });

  it('never writes the emptied labels into a comment that ends in a colon', () => {
    expect(patchTo('services:\n  web:\n    labels:\n      # see:\n      sencho.service.url: "http://x"\n    image: x\n', 'web', null))
      .toBe('services:\n  web:\n    labels:\n      # see:\n      {}\n    image: x\n');
    expect(patchTo('services:\n  web:\n    labels: # note:\n      sencho.service.url: "http://x"\n', 'web', null))
      .toBe('services:\n  web:\n    labels: # note:\n      {}\n');
    expect(patchTo('services:\n  web:\n    labels:\n      # urls:\n      - sencho.service.url=http://x\n', 'web', null))
      .toBe('services:\n  web:\n    labels:\n      # urls:\n      []\n');
  });

  it('leaves the file as it is when there is no URL to clear', () => {
    const source = 'services:\n  web: &w { image: x }\n  api: *w\n';
    expect(patchServiceUrlLabel(source, 'web', null)).toEqual({ ok: true, yaml: source });
  });

  it('replaces a URL inside flow labels of a flow service', () => {
    expect(patchTo('services:\n  web: { image: nginx, labels: { sencho.service.url: "https://old", keep: 0440 } }\n', 'web', URL))
      .toBe('services:\n  web: { image: nginx, labels: { sencho.service.url: "https://app.example.com", keep: 0440 } }\n');
  });

  it('copies a flow extension anchor onto the edited service only', () => {
    expect(patchTo('x-svc: &svc { image: nginx, user: 0440 }\nservices:\n  web: *svc\n  api: *svc\n', 'web', URL))
      .toBe('x-svc: &svc { image: nginx, user: 0440 }\nservices:\n  web: { image: nginx, user: 0440, labels: { sencho.service.url: "https://app.example.com" } }\n  api: *svc\n');
  });

  it('keeps nested and repeated anchor consumers on their own values', () => {
    expect(patchTo('services:\n  web: &svc { image: nginx, labels: &l { a: 0440 } }\n  api: *svc\n  worker: { image: x, labels: *l }\n', 'web', URL))
      .toBe('services:\n  web: &svc { image: nginx, labels: &l { a: 0440, sencho.service.url: "https://app.example.com" } }\n  api: { image: nginx, labels: &l { a: 0440 } }\n  worker: { image: x, labels: { a: 0440 } }\n');
    expect(patchTo('services:\n  web: &svc { image: nginx }\n  api: *svc\n  worker: *svc\n', 'api', URL))
      .toBe('services:\n  web: &svc { image: nginx }\n  api: { image: nginx, labels: { sencho.service.url: "https://app.example.com" } }\n  worker: *svc\n');
  });

  it('keeps a comment before a removed first flow item', () => {
    expect(patchTo('services:\n  web:\n    labels: [  # important!\n      sencho.service.url=old, a=b ]\n', 'web', null))
      .toBe('services:\n  web:\n    labels: [  # important!\n      a=b ]\n');
  });

  it('removes an anchor or tag with the first flow item it belongs to', () => {
    expect(patchTo('services:\n  web:\n    labels: [ &u sencho.service.url=x, a=b ]\n', 'web', null))
      .toBe('services:\n  web:\n    labels: [ a=b ]\n');
    expect(patchTo('services:\n  web:\n    labels: [ !<tag:yaml.org,2002:str> sencho.service.url=x, a=b ]\n', 'web', null))
      .toBe('services:\n  web:\n    labels: [ a=b ]\n');
  });

  it('allows a standard YAML tag elsewhere in the file', () => {
    expect(patchTo('services:\n  web:\n    image: !!str nginx\n    labels:\n      a: b\n', 'web', URL))
      .toBe('services:\n  web:\n    image: !!str nginx\n    labels:\n      a: b\n      sencho.service.url: "https://app.example.com"\n');
  });

  it('refuses edits it cannot make without losing a comment or a custom tag', () => {
    expect(patchServiceUrlLabel('services:\n  web:\n    labels: [ # c\n      sencho.service.url=x ]\n', 'web', null))
      .toEqual({ ok: false, reason: 'unsupported' });
    const flowComment = 'services:\n  web:\n    labels: [\n      a=1, # keep me\n      sencho.service.url=http://x\n    ]\n';
    expect(patchServiceUrlLabel(flowComment, 'web', null)).toEqual({ ok: false, reason: 'unsupported' });
    expect(patchServiceUrlLabel('services:\n  web:\n    labels: !reset []\n', 'web', URL)).toEqual({ ok: false, reason: 'unsupported' });
    const overridden = 'services:\n  web:\n    labels: &l !override { a: b, sencho.service.url: "http://x" }\n  api:\n    labels: *l\n';
    expect(patchServiceUrlLabel(overridden, 'web', URL)).toEqual({ ok: false, reason: 'unsupported' });
  });

  it('reports a merge Compose would reject as a parse failure', () => {
    expect(patchServiceUrlLabel('services:\n  web:\n    <<: 5\n    image: nginx\n', 'web', URL)).toEqual({ ok: false, reason: 'parse' });
  });

  it('refuses a layout it cannot edit without changing another service', () => {
    const blockIntoFlow = 'services:\n  web:\n    image: nginx\n    labels: &l\n      keep: "1"\n  api: { image: redis, labels: *l }\n';
    expect(patchServiceUrlLabel(blockIntoFlow, 'web', URL)).toEqual({ ok: false, reason: 'unsupported' });
    const multiline = 'services:\n  web:\n    labels:\n      sencho.service.url: &u |\n        https://o\n  api:\n    labels:\n      x: *u\n';
    expect(patchServiceUrlLabel(multiline, 'web', URL)).toEqual({ ok: false, reason: 'unsupported' });
  });
});

describe('composeServiceNames', () => {
  it('reports services in the open buffer and omits one that was removed', () => {
    expect(composeServiceNames('services:\n  web:\n    image: nginx\n  api:\n    image: nginx\n')).toEqual(['web', 'api']);
    expect(composeServiceNames('services:\n  web:\n    image: nginx\n')).toEqual(['web']);
    expect(composeServiceNames('services: [')).toBeNull();
  });
});

describe('serviceUrlFromLabelValue', () => {
  it('rejects a scheme that is not an absolute http or https authority', () => {
    expect(serviceUrlFromLabelValue('https:app.example.com')).toBeNull();
    expect(serviceUrlFromLabelValue('https:/app.example.com')).toBeNull();
    expect(serviceUrlFromLabelValue('https://app.example.com/path')).toBe('https://app.example.com/path');
  });
});
