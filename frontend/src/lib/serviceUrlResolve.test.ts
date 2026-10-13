import { describe, expect, it } from 'vitest';
import { composeServiceNames, patchServiceUrlLabel } from './composeServiceUrl';
import {
  dynamicTcpOwners,
  lockedServiceUrlReasons,
  parseServiceUrlResponse,
  resolveOpenAppTarget,
  resolvePublishedPortClick,
  serviceKeyGet,
  serviceUrlClearBlockedMessage,
  serviceUrlClearState,
  serviceUrlEditBlockedMessage,
  serviceUrlEditState,
  serviceUrlSaveBlockedMessage,
  tcpOwners,
  type ServiceUrlEntry,
} from './serviceUrlResolve';
import { buildServiceUrl } from './serviceUrl';
import { serviceUrlFromLabelValue } from './serviceUrlLabel';
import { parse, parseDocument } from 'yaml';

const ready: ServiceUrlEntry = {
  status: 'ready',
  nodeId: 1,
  stackName: 'web',
  renderable: true,
  serviceUrls: { web: 'https://app.example.com' },
  serviceUrlEdit: { web: 'root' },
  serviceUrlClear: { web: 'root' },
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

describe('dynamicTcpOwners', () => {
  it('audit F02: counts a published zero as automatic allocation', () => {
    // `ports: ["0:80"]` and `ports: [{ target: 80, published: 0 }]` both render
    // as `published: "0"`; Docker assigns the host port at run time.
    expect(dynamicTcpOwners({
      web: [{ host: '0', container: '80', proto: 'tcp' }],
      api: [{ host: '', container: '80', proto: 'tcp' }],
      udp: [{ host: '0', container: '80', proto: 'udp' }],
    }, undefined)).toEqual(['web', 'api']);
    expect(dynamicTcpOwners({ web: [{ host: '0', container: '80', proto: 'tcp' }] }, 80)).toEqual(['web']);
    expect(dynamicTcpOwners({ web: [{ host: '0', container: '80', proto: 'tcp' }] }, 81)).toEqual([]);
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

  it('audit F02: a published zero opens the named service URL at its assigned port', () => {
    // The rendered anatomy for `ports: ["0:80"]` keeps the Compose wire value
    // `published: "0"`; Docker then assigns the host port (here 49152).
    const entry = parseServiceUrlResponse(1, 'web', true, {
      renderable: true,
      services: ['web', 'api'],
      serviceUrls: { web: 'https://app.example.com', api: 'https://api.example.com' },
      serviceUrlEdit: { web: 'root', api: 'root' },
      serviceUrlClear: { web: 'root', api: 'root' },
      ports: {
        web: [{ host: '0', container: '80', proto: 'tcp' }],
        api: [{ host: '0', container: '90', proto: 'tcp' }],
      },
    });
    expect(resolvePublishedPortClick({
      entry,
      serviceName: 'web',
      publicPort: 49152,
      privatePort: 80,
      portLabel: '49152 → 80/tcp',
      node: { type: 'local' },
    })).toMatchObject({ kind: 'link', href: 'https://app.example.com', hostLabel: 'app.example.com' });
  });

  it('audit F02: keeps the generated link for a UDP published zero', () => {
    const click = resolvePublishedPortClick({
      entry: { ...ready, ports: { web: [{ host: '0', container: '80', proto: 'udp' }] } },
      serviceName: 'web',
      publicPort: 49152,
      privatePort: 80,
      portLabel: '49152 → 80/tcp',
      node: { type: 'local' },
    });
    expect(click).toMatchObject({ kind: 'link', href: 'http://localhost:49152' });
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

  it('audit F02: Open App resolves the sole published-zero owner at its assigned port', () => {
    const entry: ServiceUrlEntry = {
      ...ready,
      ports: { web: [{ host: '0', container: '80', proto: 'tcp' }] },
    };
    expect(resolveOpenAppTarget({ entry, publicPort: 49152, node: { type: 'local' } }))
      .toEqual({ url: 'https://app.example.com' });
    expect(resolveOpenAppTarget({ entry, publicPort: 49152, node: { type: 'remote', api_url: '' } }))
      .toEqual({ url: 'https://app.example.com' });
    // Two services publishing an automatic port each with a URL stay ambiguous.
    expect(resolveOpenAppTarget({
      entry: {
        ...ready,
        serviceUrls: { web: 'https://web.example.com', api: 'https://api.example.com' },
        ports: {
          web: [{ host: '0', container: '80', proto: 'tcp' }],
          api: [{ host: '0', container: '90', proto: 'tcp' }],
        },
      },
      publicPort: 49152,
      node: { type: 'local' },
    })).toEqual({ error: 'More than one service publishes this port' });
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

  it('treats a bare URL list item as the key: replaced on a set, removed on a clear', () => {
    // Compose reads the list into a map with later entries winning, so a bare
    // key after the value would otherwise leave the URL empty after a set.
    const source = [
      'services:',
      '  web:',
      '    image: nginx',
      '    labels:',
      '      - sencho.service.url=https://old.example.com',
      '      - sencho.service.url',
      '',
    ].join('\n');
    const set = patchServiceUrlLabel(source, 'web', 'https://new.example.com');
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    const afterSet = parse(set.yaml, { merge: true }) as { services: { web: { labels: string[] } } };
    expect(afterSet.services.web.labels).toEqual(['sencho.service.url=https://new.example.com']);

    const cleared = patchServiceUrlLabel(source, 'web', null);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.yaml).not.toContain('sencho.service.url');
  });

  it('clears a lone bare URL list item', () => {
    const source = 'services:\n  web:\n    image: nginx\n    labels:\n      - sencho.service.url\n';
    const cleared = patchServiceUrlLabel(source, 'web', null);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.yaml).not.toContain('sencho.service.url');
    const merged = parse(cleared.yaml, { merge: true }) as { services: { web: { labels?: string[] } } };
    expect(merged.services.web.labels ?? []).toEqual([]);
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

  it('parses and resolves with no URL and no ownership metadata for the open file', () => {
    // The ownership decision now comes from the backend's `serviceUrlEdit`; the
    // editor no longer infers it from the label value or its absence.
    const entry = parseServiceUrlResponse(1, 'web', true, {
      renderable: true,
      serviceUrls: {},
      serviceUrlEdit: { web: 'other' },
      ports: { web: [{ host: '8080', proto: 'tcp' }] },
    });
    expect(entry.serviceUrlEdit).toEqual({ web: 'other' });
    expect(serviceUrlEditBlockedMessage(entry.serviceUrlEdit.web)).toBe('This URL is set in another compose file.');
    expect(lockedServiceUrlReasons(entry).get('web')).toBe('other');
  });

  it('patches a service named __proto__ and never invents an absent reserved name', () => {
    const source = [
      'services:',
      '  "__proto__":',
      '    image: nginx',
      '  constructor:',
      '    image: nginx',
      '',
    ].join('\n');
    const added = patchServiceUrlLabel(source, '__proto__', 'https://proto.example.com');
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(parseDocument(added.yaml).errors).toEqual([]);
    expect(added.yaml.split('constructor:')[0]).toContain('https://proto.example.com');
    expect(added.yaml.split('constructor:')[1] ?? '').not.toContain('https://proto.example.com');
    const cleared = patchServiceUrlLabel(added.yaml, '__proto__', null);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.yaml).not.toContain('sencho.service.url');
    // A reserved name that is not a service in the file stays a refusal, and
    // clearing a label that is not there is the documented no-op.
    expect(patchServiceUrlLabel(source, 'toString', 'https://x.example.com'))
      .toEqual({ ok: false, reason: 'missing-service' });
    expect(patchServiceUrlLabel(source, '__proto__', null)).toEqual({ ok: true, yaml: source });
  });
});

describe('service URL maps are safe for every legal service name', () => {
  const node = { type: 'local' as const };

  function parseWith(serviceUrlsJson: string, portsJson: string): ServiceUrlEntry {
    // JSON.parse, like the /effective-anatomy response, keeps `__proto__` as an own key.
    return parseServiceUrlResponse(1, 'web', true, JSON.parse(
      `{"renderable":true,"services":[],"serviceUrls":${serviceUrlsJson},"serviceUrlEdit":{},"ports":${portsJson}}`,
    ) as unknown);
  }

  it('returns literal generated links and configured overrides for names that shadow Object properties', () => {
    for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      // Absent label: the generated host and port, never an inherited function.
      const absent = parseWith('{}', JSON.stringify({ [name]: [{ host: '8080', proto: 'tcp' }] }));
      const click = resolvePublishedPortClick({ entry: absent, serviceName: name, publicPort: 8080, portLabel: '8080', node });
      expect(click).toEqual({ kind: 'link', href: 'http://localhost:8080', portLabel: '8080', hostLabel: null });
      expect(resolveOpenAppTarget({ entry: absent, publicPort: 8080, node })).toEqual({ url: 'http://localhost:8080' });

      // Configured label: the override survives parse and resolution as an own key.
      const configured = parseWith(
        JSON.stringify({ [name]: 'https://custom.example.com' }),
        JSON.stringify({ [name]: [{ host: '8080', proto: 'tcp' }] }),
      );
      expect(Object.prototype.hasOwnProperty.call(configured.serviceUrls, name)).toBe(true);
      expect(resolvePublishedPortClick({ entry: configured, serviceName: name, publicPort: 8080, portLabel: '8080', node }))
        .toEqual({ kind: 'link', href: 'https://custom.example.com', portLabel: '8080', hostLabel: 'custom.example.com' });
      expect(resolveOpenAppTarget({ entry: configured, publicPort: 8080, node }))
        .toEqual({ url: 'https://custom.example.com' });
    }
  });

  it('exposes null-prototype lookups so nothing inherited can masquerade as a URL', () => {
    const entry = parseServiceUrlResponse(1, 'web', true, { renderable: true, serviceUrls: {}, serviceUrlEdit: {}, ports: {} });
    expect(serviceKeyGet(entry.serviceUrls, 'constructor')).toBeUndefined();
    expect(serviceKeyGet(entry.ports, 'toString')).toBeUndefined();
    expect(serviceKeyGet(entry.serviceUrlEdit, 'hasOwnProperty')).toBeUndefined();
  });

  it('reads one service state through an own-property lookup', () => {
    const entry = parseServiceUrlResponse(1, 'web', true, {
      renderable: true,
      serviceUrls: {},
      serviceUrlEdit: JSON.parse('{"constructor":"other","__proto__":"unknown"}') as Record<string, string>,
      ports: {},
    });
    expect(serviceUrlEditState(entry, 'constructor')).toBe('other');
    expect(serviceUrlEditState(entry, '__proto__')).toBe('unknown');
    // An absent name must not read Object.prototype.
    expect(serviceUrlEditState(entry, 'toString')).toBeUndefined();
    expect(serviceUrlEditState(entry, 'hasOwnProperty')).toBeUndefined();
    expect(serviceUrlEditState(null, 'constructor')).toBeUndefined();
  });

  it('reads the clear state through an own-property lookup too', () => {
    const entry = parseServiceUrlResponse(1, 'web', true, {
      renderable: true,
      serviceUrls: {},
      serviceUrlEdit: {},
      serviceUrlClear: JSON.parse('{"constructor":"other","__proto__":"unknown"}') as Record<string, string>,
      ports: {},
    });
    expect(serviceUrlClearState(entry, 'constructor')).toBe('other');
    expect(serviceUrlClearState(entry, '__proto__')).toBe('unknown');
    expect(serviceUrlClearState(entry, 'toString')).toBeUndefined();
    expect(serviceUrlClearState(null, 'constructor')).toBeUndefined();
  });
});

describe('service URL editability metadata', () => {
  it('locks only the services a later compose file shadows, with a reason', () => {
    const entry = parseServiceUrlResponse(1, 'web', true, {
      renderable: true,
      serviceUrls: {},
      serviceUrlEdit: { web: 'other', api: 'unknown', db: 'root' },
      ports: {},
    });
    const locked = lockedServiceUrlReasons(entry);
    expect(locked.size).toBe(2);
    expect(locked.get('web')).toBe('other');
    expect(locked.get('api')).toBe('unknown');
    expect(locked.has('db')).toBe(false);
    expect(serviceUrlEditBlockedMessage('other')).toBe('This URL is set in another compose file.');
    expect(serviceUrlEditBlockedMessage('unknown')).toBe('Sencho cannot verify which compose file sets this URL.');
    expect(serviceUrlEditBlockedMessage(undefined)).toBe('Sencho cannot verify which compose file sets this URL.');
    expect(serviceUrlEditBlockedMessage('root')).toBeNull();
  });

  it('audit F01: refuses the save and the clear the interpolated-key metadata marks unknown', () => {
    const entry = parseServiceUrlResponse(1, 'web', true, {
      renderable: true,
      serviceUrls: { web: 'https://later.example.com' },
      serviceUrlEdit: { web: 'unknown' },
      serviceUrlClear: { web: 'unknown' },
      ports: {},
    });
    // The save path reads this guard before it builds the write, so an
    // unverifiable source is refused instead of PUT.
    expect(serviceUrlSaveBlockedMessage(entry, 'web', 'https://new.example.com'))
      .toBe('Sencho cannot verify which compose file sets this URL.');
    expect(serviceUrlSaveBlockedMessage(entry, 'web', null))
      .toBe('Sencho cannot verify which compose file or inherited service sets this URL, so it cannot be cleared here.');
    expect(lockedServiceUrlReasons(entry).get('web')).toBe('unknown');
  });

  it('ignores unknown states and non-object payloads from an older or broken node', () => {
    const entry = parseServiceUrlResponse(1, 'web', true, {
      renderable: true,
      serviceUrls: {},
      serviceUrlEdit: { web: 'somewhere-else', api: 42 },
      ports: {},
    });
    expect(entry.serviceUrlEdit).toEqual({});
    expect(lockedServiceUrlReasons(null).size).toBe(0);
    expect(lockedServiceUrlReasons(entry).size).toBe(0);
  });
});

describe('service URL clear authority', () => {
  it('refuses the clear only when another contribution would survive it', () => {
    const entry = parseServiceUrlResponse(1, 'web', true, {
      renderable: true,
      serviceUrls: {},
      serviceUrlEdit: { web: 'root', api: 'root', db: 'other' },
      serviceUrlClear: { web: 'other', api: 'unknown', db: 'other' },
      ports: {},
    });
    expect(serviceUrlClearState(entry, 'web')).toBe('other');
    expect(serviceUrlClearState(entry, 'api')).toBe('unknown');
    expect(serviceUrlClearState(entry, 'db')).toBe('other');
    expect(serviceUrlClearState(entry, 'missing')).toBeUndefined();
    expect(serviceUrlClearBlockedMessage('root')).toBeNull();
    expect(serviceUrlClearBlockedMessage('other'))
      .toBe('This URL is also set in another compose file, so clearing it here cannot take effect.');
    expect(serviceUrlClearBlockedMessage('unknown'))
      .toBe('Sencho cannot verify which compose file or inherited service sets this URL, so it cannot be cleared here.');
    expect(serviceUrlClearBlockedMessage(undefined))
      .toBe('Sencho cannot verify which compose file or inherited service sets this URL, so it cannot be cleared here.');
  });

  it('treats a response without clear states as unverifiable for clearing', () => {
    // A node that predates the clear authority still reports set editability.
    const entry = parseServiceUrlResponse(1, 'web', true, {
      renderable: true,
      serviceUrls: { web: 'https://app.example.com' },
      serviceUrlEdit: { web: 'root' },
      ports: {},
    });
    expect(entry.serviceUrlClear).toEqual({});
    expect(serviceUrlSaveBlockedMessage(entry, 'web', 'https://app.example.com')).toBeNull();
    expect(serviceUrlSaveBlockedMessage(entry, 'web', null))
      .toBe('Sencho cannot verify which compose file or inherited service sets this URL, so it cannot be cleared here.');
  });

  it('picks the guard for the requested operation', () => {
    const entry = parseServiceUrlResponse(1, 'web', true, {
      renderable: true,
      serviceUrls: { web: 'https://app.example.com' },
      serviceUrlEdit: { web: 'root' },
      serviceUrlClear: { web: 'other' },
      ports: {},
    });
    // Setting is allowed even when clearing is not.
    expect(serviceUrlSaveBlockedMessage(entry, 'web', 'https://new.example.com')).toBeNull();
    expect(serviceUrlSaveBlockedMessage(entry, 'web', null))
      .toBe('This URL is also set in another compose file, so clearing it here cannot take effect.');

    const shadowed = parseServiceUrlResponse(1, 'web', true, {
      renderable: true,
      serviceUrls: {},
      serviceUrlEdit: { web: 'other' },
      serviceUrlClear: { web: 'other' },
      ports: {},
    });
    expect(serviceUrlSaveBlockedMessage(shadowed, 'web', 'https://new.example.com'))
      .toBe('This URL is set in another compose file.');
    expect(serviceUrlSaveBlockedMessage(null, 'web', null))
      .toBe('Sencho cannot verify which compose file or inherited service sets this URL, so it cannot be cleared here.');
  });
});

describe('patchServiceUrlLabel refuses a clear an inherited label would survive', () => {
  it('refuses clearing a service that extends another service', () => {
    const source = [
      'services:',
      '  base:',
      '    image: nginx',
      '    labels:',
      '      sencho.service.url: https://base.example.com',
      '  web:',
      '    extends:',
      '      service: base',
      '    labels:',
      '      sencho.service.url: https://web.example.com',
      '',
    ].join('\n');
    expect(patchServiceUrlLabel(source, 'web', null)).toEqual({ ok: false, reason: 'unsupported' });
    // Setting a URL still works: the direct label beats the inherited one.
    const set = patchServiceUrlLabel(source, 'web', 'https://new.example.com');
    expect(set.ok).toBe(true);
  });

  it('refuses clearing a service whose labels also come from label_file', () => {
    const source = [
      'services:',
      '  web:',
      '    image: nginx',
      '    label_file:',
      '      - url.labels',
      '    labels:',
      '      sencho.service.url: https://web.example.com',
      '',
    ].join('\n');
    expect(patchServiceUrlLabel(source, 'web', null)).toEqual({ ok: false, reason: 'unsupported' });
    const set = patchServiceUrlLabel(source, 'web', 'https://new.example.com');
    expect(set.ok).toBe(true);
  });

  it('refuses clearing any label in a file that includes another file', () => {
    const source = [
      'include:',
      '  - sub/included.yaml',
      'services:',
      '  web:',
      '    image: nginx',
      '    labels:',
      '      sencho.service.url: https://web.example.com',
      '',
    ].join('\n');
    expect(patchServiceUrlLabel(source, 'web', null)).toEqual({ ok: false, reason: 'unsupported' });
    const set = patchServiceUrlLabel(source, 'web', 'https://new.example.com');
    expect(set.ok).toBe(true);
  });

  it('still clears a label inherited through a YAML merge key, which the patch rewrites locally', () => {
    const source = [
      'x-labels: &labels',
      '  keep: "yes"',
      '  sencho.service.url: https://default.example.com',
      'services:',
      '  web:',
      '    image: nginx',
      '    labels: *labels',
      '',
    ].join('\n');
    const cleared = patchServiceUrlLabel(source, 'web', null);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    const merged = parse(cleared.yaml, { merge: true }) as {
      services: { web: { labels: Record<string, string> } };
    };
    expect(merged.services.web.labels['sencho.service.url']).toBeUndefined();
    expect(merged.services.web.labels.keep).toBe('yes');
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
