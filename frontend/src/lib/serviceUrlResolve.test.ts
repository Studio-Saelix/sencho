import { describe, expect, it } from 'vitest';
import { composeServiceNames, patchServiceUrlLabel } from './composeServiceUrl';
import { parseServiceUrlResponse, resolveOpenAppTarget, resolvePublishedPortClick, tcpOwners, type ServiceUrlEntry } from './serviceUrlResolve';
import { buildServiceUrl } from './serviceUrl';
import { serviceUrlFromLabelValue } from './serviceUrlLabel';
import { parse } from 'yaml';

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
