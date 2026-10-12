import { describe, expect, it } from 'vitest';
import { patchServiceUrlLabel } from './composeServiceUrl';
import { parseServiceUrlResponse, resolveOpenAppTarget, resolvePublishedPortClick, tcpOwners, type ServiceUrlEntry } from './serviceUrlResolve';
import { buildServiceUrl } from './serviceUrl';

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

  it('stays text while the service URL is unavailable', () => {
    const click = resolvePublishedPortClick({
      entry: { ...ready, status: 'unsupported', serviceUrls: {} },
      serviceName: 'web',
      publicPort: 8080,
      portLabel: '8080 → 80/tcp',
      node: { type: 'local' },
    });
    expect(click).toMatchObject({ kind: 'text', reason: 'Service URL unavailable' });
  });

  it('does not open when two services publish the port and one has an override', () => {
    const click = resolvePublishedPortClick({
      entry: {
        ...ready,
        ports: {
          web: [{ host: '8080', proto: 'tcp' }],
          api: [{ host: '8080', proto: 'tcp' }],
        },
      },
      serviceName: 'web',
      publicPort: 8080,
      portLabel: '8080 → 80/tcp',
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
});
