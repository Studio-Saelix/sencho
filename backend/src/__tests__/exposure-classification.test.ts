/**
 * Detected exposure next to the declared intent: every evidence path kept, the
 * answer string, the per-intent conflict record, and the one adoption suggestion.
 * Fixtures go through parseEffectiveModel with `docker compose config` shaped
 * JSON, so the parse path the route uses is covered too. Fixtures that set a
 * token or auth key use real-looking values and assert none reaches the output.
 */
import { describe, expect, it, vi } from 'vitest';
import { parseEffectiveModel, type EffectiveModel } from '../services/preflight/effectiveModel';
import { detectTunnels, isCertainTunnelPath, type TunnelConnector } from '../services/network/tunnelDetection';
import {
  classifyStackExposure,
  describeDetectedExposure,
  intentConflicts,
  type DetectedServiceExposure,
  type ExposureRuntimeLookup,
} from '../services/network/exposureClassification';
import { assembleStackNetworkFacts } from '../services/network/composeNetworkInspector';
import { buildNodeNetworkingFindings } from '../services/network/networkingFindings';
import { DatabaseService } from '../services/DatabaseService';
import type { DependencyContainer, DependencySnapshot } from '../services/DockerController';
import type { NetworkDriftFacts } from '../services/network/types';

const CF_TOKEN = 'eyJhIjoiY2xvdWRmbGFyZS1zZWNyZXQtdG9rZW4ifQ';
const TS_KEY = 'tskey-auth-kSECRETVALUE-0123456789abcdef';
const LABEL_SECRET = 'LABEL-VALUE-MUST-NOT-LEAK';
const SECRETS = [CF_TOKEN, TS_KEY, LABEL_SECRET];

type RawService = Record<string, unknown>;

const EMPTY_DRIFT: NetworkDriftFacts = {
  runtimeOnlyAttachments: [], declaredButUnused: [], missingFromRuntime: [], foreignNetworkAttachments: [],
};

function render(services: Record<string, RawService>, networks: Record<string, unknown> = { default: { name: 'proj_default' } }): EffectiveModel {
  const withDefaults = Object.fromEntries(Object.entries(services).map(([name, svc]) => [
    name,
    svc.network_mode !== undefined || svc.networks !== undefined ? svc : { ...svc, networks: { default: null } },
  ]));
  return parseEffectiveModel({ name: 'proj', services: withDefaults, networks }, 'proj');
}

function container(service: string, over: Partial<DependencyContainer> = {}): DependencyContainer {
  return {
    id: `${service}-id`, name: `proj-${service}-1`, service, composeProject: 'proj', stack: 'proj',
    state: 'running', exitCode: null, image: 'example/app:1', networks: [], volumes: [], ports: [],
    ...over,
  };
}

function lookup(containers: DependencyContainer[]): ExposureRuntimeLookup {
  const containersByService = new Map<string, DependencyContainer[]>();
  const serviceOfContainer = new Map<string, string>();
  for (const c of containers) {
    if (!c.service) continue;
    const list = containersByService.get(c.service);
    if (list) list.push(c);
    else containersByService.set(c.service, [c]);
    serviceOfContainer.set(c.name, c.service);
  }
  return { containersByService, serviceOfContainer: (name: string) => serviceOfContainer.get(name) ?? null };
}

const app: RawService = { image: 'ghcr.io/example/app:1.2' };
const db: RawService = { image: 'postgres:16' };
const cloudflared: RawService = { image: 'cloudflare/cloudflared:latest', environment: { TUNNEL_TOKEN: CF_TOKEN } };

/** A loopback-only publisher with its container running, so adoption is offered. */
const LOOPBACK_MODEL = render({ web: { ...app, ports: ['127.0.0.1:3000:3000'] } });
const LOOPBACK_RUNTIME = lookup([container('web', { ports: [{ ip: '127.0.0.1', publishedPort: 3000, privatePort: 3000, protocol: 'tcp' }] })]);

interface Fixture {
  name: string;
  model: EffectiveModel;
  connectors?: TunnelConnector[];
  drift?: NetworkDriftFacts;
  runtime?: ExposureRuntimeLookup | null;
  expected: Record<string, string>;
}

const FIXTURES: Fixture[] = [
  {
    name: 'Cloudflare Tunnel: shared namespace, shared network, and the host network',
    model: render({
      cloudflared,
      app,
      ns: { ...app, network_mode: 'service:cloudflared' },
      host: { image: 'cloudflare/cloudflared', network_mode: 'host' },
      web: { ...app, ports: ['8080:80'] },
    }),
    expected: {
      cloudflared: 'no known exposure path',
      app: 'public edge (unverified)',
      ns: 'public edge (unverified)',
      host: 'host-published',
      web: 'public edge (unverified) + host-published',
    },
  },
  {
    name: 'Tailscale: a certain namespace, an unverified subnet route, and the node itself',
    model: render({
      tailscale: { image: 'tailscale/tailscale', environment: { TS_AUTHKEY: TS_KEY, TS_ROUTES: '10.0.0.0/24' } },
      admin: { ...app, network_mode: 'service:tailscale' },
      app,
    }),
    expected: { tailscale: 'private overlay', admin: 'private overlay', app: 'private overlay (unverified)' },
  },
  {
    name: 'WireGuard: a server in a namespace reaches its own peers and every service on its networks',
    model: render({
      wg: { image: 'ghcr.io/wg-easy/wg-easy', ports: ['51820/udp', '51821:51821'] },
      app: { ...app, network_mode: 'service:wg' },
      client: { image: 'lscr.io/linuxserver/wireguard' },
    }),
    // The namespace sharer inherits the server's published ports, and the
    // server can reach every service that shares a network with it.
    expected: { wg: 'private overlay + host-published', app: 'private overlay + host-published', client: 'private overlay (unverified)' },
  },
  {
    name: 'ports: broad v4, broad v6, an address bind, loopback-only, and auto-assigned',
    model: render({
      broad: { ...app, ports: ['0.0.0.0:8080:80'] },
      v6: { ...app, ports: [{ target: 443, published: 8443, host_ip: '::' }] },
      addr: { ...app, ports: ['192.168.1.5:9000:9000'] },
      local: { ...app, ports: ['127.0.0.1:3000:3000'] },
      auto: { ...app, ports: ['80'] },
    }),
    runtime: lookup([
      container('local', { ports: [{ ip: '127.0.0.1', publishedPort: 3000, privatePort: 3000, protocol: 'tcp' }] }),
    ]),
    expected: {
      broad: 'host-published', v6: 'host-published', addr: 'host-published', local: 'same host only', auto: 'host-published',
    },
  },
  {
    name: 'host networking',
    model: render({ host: { ...app, network_mode: 'host' } }),
    expected: { host: 'host-published' },
  },
  {
    name: 'a shared namespace, including a service:<y> -> service:<x> chain',
    model: render({
      db: { ...db, ports: ['5432:5432'] },
      mid: { ...app, network_mode: 'service:db' },
      top: { ...app, network_mode: 'service:mid' },
    }),
    expected: { db: 'host-published', mid: 'host-published', top: 'host-published' },
  },
  {
    name: 'container:<x> with x outside the stack',
    model: render({ app: { ...app, network_mode: 'container:other-web' } }),
    expected: { app: 'could not be determined' },
  },
  {
    name: 'a connector in another container namespace',
    model: render({ cf: { ...cloudflared, network_mode: 'container:proxy' }, app }),
    expected: { cf: 'could not be determined', app: 'could not be determined' },
  },
  {
    name: 'a connector whose shared namespace ends at another container',
    model: render({
      cf: { ...cloudflared, network_mode: 'service:mid' },
      mid: { ...app, network_mode: 'container:proxy' },
      web: app,
    }),
    expected: { cf: 'could not be determined', mid: 'public edge (unverified) · partly undetermined', web: 'could not be determined' },
  },
  {
    name: 'two connectors reaching one service, both kept',
    model: render({
      cf: cloudflared,
      ts: { image: 'tailscale/tailscale', environment: { TS_AUTHKEY: TS_KEY, TS_ROUTES: '10.0.0.0/24' } },
      app,
    }),
    expected: { cf: 'private overlay (unverified)', ts: 'public edge (unverified) + private overlay', app: 'public edge (unverified) + private overlay (unverified)' },
  },
  {
    name: 'no ingress at all',
    model: render({ app, db }),
    expected: { app: 'no known exposure path', db: 'no known exposure path' },
  },
  {
    name: 'a service on an external network',
    model: render({ web: { ...app, ports: ['127.0.0.1:8080:80'], networks: { shared: null } } }, {
      default: { name: 'proj_default' },
      shared: { name: 'shared', external: true },
    }),
    runtime: lookup([container('web', { ports: [{ ip: '127.0.0.1', publishedPort: 8080, privatePort: 80, protocol: 'tcp' }] })]),
    expected: { web: 'same host only' },
  },
  {
    name: 'runtime attachments on a declared network and on a foreign one',
    model: render({ app: { ...app, ports: ['8080:80'] }, web: app }),
    drift: {
      ...EMPTY_DRIFT,
      runtimeOnlyAttachments: [{ container: 'proj-app-1', service: 'app', network: 'proj_extra' }],
      foreignNetworkAttachments: [{ container: 'proj-web-1', network: 'other_net' }],
    },
    runtime: lookup([container('app'), container('web')]),
    expected: { app: 'host-published · partly undetermined', web: 'could not be determined' },
  },
  {
    name: 'a running container whose ports differ from Compose',
    model: LOOPBACK_MODEL,
    runtime: lookup([container('web', { ports: [{ ip: '0.0.0.0', publishedPort: 3000, privatePort: 3000, protocol: 'tcp' }] })]),
    expected: { web: 'same host only · partly undetermined' },
  },
  {
    name: 'a stopped service',
    model: LOOPBACK_MODEL,
    runtime: lookup([container('web', { state: 'exited' })]),
    expected: { web: 'same host only' },
  },
  {
    name: 'no runtime at all',
    model: LOOPBACK_MODEL,
    expected: { web: 'same host only' },
  },
  {
    name: 'secrets in environment and labels',
    model: render({
      cf: { ...cloudflared, labels: { 'traefik.http.routers.cf.rule': LABEL_SECRET } },
      ts: { image: 'tailscale/tailscale', environment: { TS_AUTHKEY: TS_KEY } },
      app,
    }),
    expected: { cf: 'no known exposure path', ts: 'public edge (unverified) + private overlay', app: 'public edge (unverified)' },
  },
];

function classify(fixture: Fixture): Map<string, DetectedServiceExposure> {
  return classifyStackExposure({
    model: fixture.model,
    connectors: fixture.connectors ?? detectTunnels(fixture.model),
    drift: fixture.drift ?? EMPTY_DRIFT,
    runtime: fixture.runtime === undefined ? null : fixture.runtime,
  });
}

describe('classifyStackExposure: answers', () => {
  for (const fixture of FIXTURES) {
    it(fixture.name, () => {
      const detected = classify(fixture);
      const actual = Object.fromEntries([...detected].map(([name, value]) => [name, value.answer]));
      expect(actual).toEqual(fixture.expected);
    });
  }
});

describe('classifyStackExposure: constructor invariants', () => {
  it('holds for every fixture', () => {
    for (const fixture of FIXTURES) {
      for (const [service, value] of classify(fixture)) {
        if (value.status === 'paths') expect(value.paths.length).toBeGreaterThan(0);
        else expect(value.paths).toEqual([]);
        if (value.status === 'undetermined') expect(value.reasons.length).toBeGreaterThan(0);
        for (const entries of Object.values(value.conflicts)) {
          for (const entry of entries) {
            expect(entry.paths.length).toBeGreaterThan(0);
            for (const index of entry.paths) {
              expect(index).toBeGreaterThanOrEqual(0);
              expect(index).toBeLessThan(value.paths.length);
            }
          }
        }
        const { answer: _answer, conflicts: _conflicts, suggestedIntent: _suggested, ...evidence } = value;
        expect(value.answer).toBe(describeDetectedExposure(evidence));
        expect(service).toBeTruthy();
      }
    }
  });
});

describe('classifyStackExposure: never claims more than it can see', () => {
  it('uses no reachability, safety or verified-routing language', () => {
    for (const fixture of FIXTURES) {
      for (const value of classify(fixture).values()) {
        const text = value.answer.toLowerCase();
        expect(text).not.toMatch(/\b(?:internet reachable|internet-reachable|safe|isolated)\b/);
        // "verified" may only appear inside "unverified".
        expect(text.replace(/unverified/g, '')).not.toMatch(/verified/);
      }
    }
  });
});

describe('classifyStackExposure: conflict record', () => {
  const model = render({
    web: { ...app, ports: ['8080:80', '127.0.0.1:9000:9000'] },
    via: { ...app, network_mode: 'service:web' },
    hostnet: { ...app, network_mode: 'host' },
  });
  const detected = classify({ name: 'conflicts', model, expected: {} });

  it('records conflicts for internal and same-node on own host ports', () => {
    expect(detected.get('web')?.conflicts.internal).toEqual([
      { level: 'conflict', reason: 'host-port', paths: [0] },
      { level: 'conflict', reason: 'loopback-port', paths: [1] },
    ]);
    // same-node tolerates a loopback binding.
    expect(detected.get('web')?.conflicts['same-node']).toEqual([
      { level: 'conflict', reason: 'host-port', paths: [0] },
    ]);
  });

  it('records host networking as a conflict for internal and same-node, a note for the broad intents', () => {
    expect(detected.get('hostnet')?.conflicts.internal).toEqual([{ level: 'conflict', reason: 'host-network', paths: [0] }]);
    expect(detected.get('hostnet')?.conflicts['same-node']).toEqual([{ level: 'conflict', reason: 'host-network', paths: [0] }]);
    expect(detected.get('hostnet')?.conflicts.temporary).toEqual([{ level: 'note', reason: 'host-network', paths: [0] }]);
    expect(detected.get('hostnet')?.conflicts['reverse-proxy']).toEqual([{ level: 'note', reason: 'host-network', paths: [0] }]);
  });

  it('keeps a shared-namespace path a note, never a conflict', () => {
    expect(detected.get('via')?.conflicts.internal).toEqual([{ level: 'note', reason: 'shared-namespace', paths: [0, 1] }]);
    expect(detected.get('via')?.conflicts['same-node']).toEqual([{ level: 'note', reason: 'shared-namespace', paths: [0, 1] }]);
    expect(detected.get('via')?.suggestedIntent).toBeNull();
  });

  it('notes a broad bind under temporary and reverse-proxy, and says nothing for lan, public or unknown', () => {
    expect(detected.get('web')?.conflicts.temporary).toEqual([{ level: 'note', reason: 'broad-bind', paths: [0] }]);
    expect(detected.get('web')?.conflicts['reverse-proxy']).toEqual([{ level: 'note', reason: 'broad-bind', paths: [0] }]);
    for (const intent of ['lan', 'public', 'unknown'] as const) {
      expect(detected.get('web')?.conflicts[intent]).toEqual([]);
    }
  });

  it('is a conflict for a certain tunnel and a possible one for an unverified tunnel', () => {
    const ts = render({
      tailscale: { image: 'tailscale/tailscale', environment: { TS_AUTHKEY: TS_KEY, TS_ROUTES: '10.0.0.0/24' } },
      admin: { ...app, network_mode: 'service:tailscale' },
      app,
    });
    const classified = classify({ name: 'tunnels', model: ts, expected: {} });
    expect(classified.get('admin')?.conflicts.internal).toEqual([{ level: 'conflict', reason: 'tunnel', paths: [0] }]);
    expect(classified.get('app')?.conflicts.internal).toEqual([{ level: 'possible', reason: 'tunnel', paths: [0] }]);
  });

  it('evaluates every intent value, so an absent entry is never read as unevaluated', () => {
    const value = classify({ name: 'evaluated', model: render({ app }), expected: {} }).get('app');
    expect(Object.keys(value?.conflicts ?? {}).sort()).toEqual(
      ['internal', 'lan', 'public', 'reverse-proxy', 'same-node', 'temporary', 'unknown'],
    );
  });
});

describe('classifyStackExposure: every path is kept', () => {
  it('lists both connectors that reach one service rather than the strongest', () => {
    const model = render({
      cf: cloudflared,
      ts: { image: 'tailscale/tailscale', environment: { TS_AUTHKEY: TS_KEY, TS_ROUTES: '10.0.0.0/24' } },
      app,
    });
    const paths = classify({ name: 'two', model, expected: {} }).get('app')?.paths ?? [];
    expect(paths).toEqual([
      { kind: 'tunnel', scope: 'public-edge', provider: 'cloudflared', connector: 'cf', path: 'shared-network', certain: false },
      { kind: 'tunnel', scope: 'private-overlay', provider: 'tailscale', connector: 'ts', path: 'shared-network', certain: false },
    ]);
  });

  it('keeps the certain namespace path and the unverified network path apart', () => {
    const model = render({
      ts: { image: 'tailscale/tailscale', environment: { TS_AUTHKEY: TS_KEY, TS_ROUTES: '10.0.0.0/24' } },
      admin: { ...app, network_mode: 'service:ts' },
      app,
    });
    const detected = classify({ name: 'certainty', model, expected: {} });
    const admin = detected.get('admin')?.paths[0];
    expect(admin).toMatchObject({ kind: 'tunnel', path: 'shared-namespace', certain: true });
    expect(admin && isCertainTunnelPath(admin as { provider: 'tailscale'; path: 'shared-namespace' })).toBe(true);
    expect(detected.get('app')?.paths[0]).toMatchObject({ certain: false });
  });
});

describe('classifyStackExposure: adoption', () => {
  it('suggests same-node only for an own loopback-only port with a running container and no external network', () => {
    expect(classify({ name: 'adopt', model: LOOPBACK_MODEL, runtime: LOOPBACK_RUNTIME, expected: {} }).get('web')?.suggestedIntent)
      .toBe('same-node');
  });

  it('never suggests from a stopped service, an absent runtime, or a namespace path', () => {
    const stopped = classify({ name: 'stopped', model: LOOPBACK_MODEL, runtime: lookup([container('web', { state: 'exited' })]), expected: {} });
    expect(stopped.get('web')?.runtimeChecked).toBe(false);
    expect(stopped.get('web')?.suggestedIntent).toBeNull();
    expect(classify({ name: 'absent', model: LOOPBACK_MODEL, runtime: null, expected: {} }).get('web')?.suggestedIntent).toBeNull();

    const chained = render({ web: { ...app, ports: ['127.0.0.1:3000:3000'] }, via: { ...app, network_mode: 'service:web' } });
    expect(classify({ name: 'chain', model: chained, runtime: LOOPBACK_RUNTIME, expected: {} }).get('via')?.suggestedIntent).toBeNull();
  });

  it('never suggests for a broad, address, host-network or tunnel path', () => {
    for (const model of [
      render({ web: { ...app, ports: ['8080:80'] } }),
      render({ web: { ...app, ports: ['192.168.1.5:9000:9000'] } }),
      render({ web: { ...app, network_mode: 'host' } }),
      render({ cf: cloudflared, web: app }),
    ]) {
      const found = classify({ name: 'notLoopback', model, runtime: lookup([container('web')]), expected: {} });
      expect(found.get('web')?.suggestedIntent).toBeNull();
    }
  });

  it('never suggests while any reason is undetermined', () => {
    const model = render({ web: { ...app, ports: ['127.0.0.1:3000:3000'] } });
    const detected = classify({
      name: 'doubt',
      model,
      runtime: lookup([container('web', { ports: [{ ip: '0.0.0.0', publishedPort: 3000, privatePort: 3000, protocol: 'tcp' }] })]),
      expected: {},
    });
    expect(detected.get('web')?.status).toBe('paths');
    expect(detected.get('web')?.suggestedIntent).toBeNull();
  });

  it('never suggests `internal` from the absence of a path', () => {
    const detected = classify({ name: 'empty', model: render({ app }), expected: {} }).get('app');
    expect(detected?.status).toBe('none-known');
    expect(detected?.suggestedIntent).toBeNull();
  });
});

describe('classifyStackExposure: external networks and caveats', () => {
  it('names an external network and withholds adoption', () => {
    const model = render({ web: { ...app, ports: ['127.0.0.1:3000:3000'], networks: { shared: null } } }, {
      default: { name: 'proj_default' },
      shared: { name: 'shared', external: true },
    });
    const detected = classify({ name: 'external', model, runtime: LOOPBACK_RUNTIME, expected: {} }).get('web');
    expect(detected?.externalNetworks).toEqual(['shared']);
    expect(detected?.suggestedIntent).toBeNull();
  });

  it('does not treat the Sencho Mesh network as an external-network caveat', () => {
    const model = render({ web: { ...app, networks: { mesh: null } } }, {
      default: { name: 'proj_default' },
      mesh: { name: 'sencho_mesh', external: true },
    });
    expect(classify({ name: 'mesh', model, expected: {} }).get('web')?.externalNetworks).toEqual([]);
  });
});

describe('classifyStackExposure: runtime facts', () => {
  it('reports a certificate-free comparison of an auto-assigned port by bind class only', () => {
    const model = render({ web: { ...app, ports: ['127.0.0.1::3000'] } });
    const same = classify({
      name: 'autoSame',
      model,
      runtime: lookup([container('web', { ports: [{ ip: '127.0.0.1', publishedPort: 49152, privatePort: 3000, protocol: 'tcp' }] })]),
      expected: {},
    });
    expect(same.get('web')?.status).toBe('paths');
    expect(same.get('web')?.suggestedIntent).toBe('same-node');

    const otherClass = classify({
      name: 'autoOther',
      model,
      runtime: lookup([container('web', { ports: [{ ip: '0.0.0.0', publishedPort: 49152, privatePort: 3000, protocol: 'tcp' }] })]),
      expected: {},
    });
    expect(otherClass.get('web')?.answer).toBe('same host only · partly undetermined');
  });

  it('collapses the IPv4 and IPv6 entry Docker reports for one mapping', () => {
    const model = render({ web: { ...app, ports: ['8080:80'] } });
    const detected = classify({
      name: 'dualStack',
      model,
      runtime: lookup([container('web', { ports: [
        { ip: '0.0.0.0', publishedPort: 8080, privatePort: 80, protocol: 'tcp' },
        { ip: '::', publishedPort: 8080, privatePort: 80, protocol: 'tcp' },
      ] })]),
      expected: {},
    });
    expect(detected.get('web')?.status).toBe('paths');
    expect(detected.get('web')?.runtimeChecked).toBe(true);
  });

  it('compares an auto-assigned port per replica, so a scaled service is not drift', () => {
    const model = render({ web: { ...app, ports: ['127.0.0.1::3000'] } });
    const detected = classify({
      name: 'scaledDynamic',
      model,
      runtime: lookup([
        container('web', { ports: [{ ip: '127.0.0.1', publishedPort: 49152, privatePort: 3000, protocol: 'tcp' }] }),
        container('web', { name: 'proj-web-2', ports: [{ ip: '127.0.0.1', publishedPort: 49153, privatePort: 3000, protocol: 'tcp' }] }),
      ]),
      expected: {},
    });
    expect(detected.get('web')).toMatchObject({ status: 'paths', incomplete: [], suggestedIntent: 'same-node' });
  });

  it('declines the port comparison for a range too large to enumerate', () => {
    const model = render({ web: { ...app, ports: ['127.0.0.1:1000-5000:1000-5000'] } });
    const detected = classify({
      name: 'wideRange',
      model,
      // Outside the declared range: a comparable range would flag this, but the
      // range is too large to compare reliably, so Sencho claims nothing.
      runtime: lookup([container('web', { ports: [{ ip: '127.0.0.1', publishedPort: 9000, privatePort: 9000, protocol: 'tcp' }] })]),
      expected: {},
    });
    expect(detected.get('web')).toMatchObject({ status: 'paths', incomplete: [] });
  });

  it('maps a foreign network attachment through the container-to-service lookup', () => {
    const model = render({ web: app });
    const detected = classify({
      name: 'foreign',
      model,
      drift: { ...EMPTY_DRIFT, foreignNetworkAttachments: [{ container: 'proj-web-1', network: 'other_net' }] },
      runtime: lookup([container('web')]),
      expected: {},
    });
    expect(detected.get('web')?.status).toBe('undetermined');
    expect(detected.get('web')).toMatchObject({ reasons: ['runtime-attachment'] });
  });

  it('leaves an attachment that maps to no service in the Runtime drift section only', () => {
    const model = render({ web: app });
    const detected = classify({
      name: 'unmapped',
      model,
      drift: { ...EMPTY_DRIFT, foreignNetworkAttachments: [{ container: 'not-a-service-1', network: 'other_net' }] },
      runtime: lookup([container('web')]),
      expected: {},
    });
    expect(detected.get('web')?.status).toBe('none-known');
  });
});

describe('assembleStackNetworkFacts: detected exposure', () => {
  function snapshot(containers: DependencyContainer[]): DependencySnapshot {
    return { containers, networks: [], volumes: [] };
  }

  it('attaches the classification to every service', () => {
    const model = render({ web: { ...app, ports: ['8080:80'] } });
    const facts = assembleStackNetworkFacts('proj', model, null, snapshot([
      container('web', { ports: [{ ip: '0.0.0.0', publishedPort: 8080, privatePort: 80, protocol: 'tcp' }] }),
    ]));
    expect(facts.services[0].detected).toMatchObject({ answer: 'host-published', runtimeChecked: true });
  });

  it('marks the runtime unavailable rather than assuming a clean result', () => {
    const facts = assembleStackNetworkFacts('proj', LOOPBACK_MODEL, null, null);
    expect(facts.services[0].detected).toMatchObject({ runtimeChecked: false, suggestedIntent: null });
  });

  it('does not flag a Mesh-opted stack whose containers sit on the Mesh network', () => {
    const model = render({ web: app });
    const meshContainer = container('web', { networks: [{ name: 'sencho_mesh', id: 'n1', ip: '10.9.0.2' }] });
    const facts = assembleStackNetworkFacts('proj', model, null, snapshot([meshContainer]), () => true, true);
    expect(facts.drift.runtimeOnlyAttachments).toEqual([]);
    expect(facts.services[0].detected?.status).toBe('none-known');
  });

  it('reclassifies when a connector is removed between two inputs', () => {
    const withTunnel = render({ cf: cloudflared, app });
    const withoutTunnel = render({ app });
    const before = assembleStackNetworkFacts('proj', withTunnel, null, null).services.find(s => s.name === 'app');
    const after = assembleStackNetworkFacts('proj', withoutTunnel, null, null).services.find(s => s.name === 'app');
    expect(before?.detected?.answer).toBe('public edge (unverified)');
    expect(after?.detected?.answer).toBe('no known exposure path');
  });

  it('carries no environment or label value', () => {
    const model = render({
      cf: { ...cloudflared, labels: { 'example.label': LABEL_SECRET } },
      ts: { image: 'tailscale/tailscale', environment: { TS_AUTHKEY: TS_KEY } },
      app,
    });
    const text = JSON.stringify(assembleStackNetworkFacts('proj', model, null, null));
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  });
});

describe('intentConflicts', () => {
  it('returns nothing for an intent with no contradiction', () => {
    expect(intentConflicts('public', [{ kind: 'host-port', scope: 'host-published', bind: 'all-interfaces', hostIp: '', startPort: 80, endPort: 80, protocol: 'tcp' }]))
      .toEqual([]);
  });
});

describe('the live Networking findings carry the detected answer', () => {
  /** A DB with no stored intent, so both unclassified card variants fire. */
  function stubNoIntents(): void {
    vi.spyOn(DatabaseService, 'getInstance').mockReturnValue({
      getStackExposureIntents: vi.fn().mockReturnValue([]),
      getStackDossier: vi.fn().mockReturnValue(null),
    } as unknown as DatabaseService);
  }

  function unclassified(model: EffectiveModel) {
    const facts = assembleStackNetworkFacts('proj', model, null, null);
    return buildNodeNetworkingFindings(1, null, [facts], []).filter(f => f.kind === 'exposure-unclassified');
  }

  it('appends the answer to the port card', () => {
    stubNoIntents();
    const [card] = unclassified(render({ web: { ...app, ports: ['8080:80'] } }));
    expect(card.message).toContain('Detected exposure: host-published.');
    expect(card.message).toBe('Stack "proj" publishes ports from "web" without a classified exposure intent. Detected exposure: host-published.');
  });

  it('appends the answer to the tunnel card', () => {
    stubNoIntents();
    const [card] = unclassified(render({ cf: cloudflared, app }));
    expect(card.message).toContain('Detected exposure: public edge (unverified).');
  });

  it('leaves the card id and fingerprint structural, so a reworded sentence cannot move a dismissal', () => {
    stubNoIntents();
    const [card] = unclassified(render({ web: { ...app, ports: ['8080:80'] } }));
    expect(card.id).toBe('exposure-unclassified|proj|web||');
    expect(card.fingerprint).not.toContain('Detected exposure');
    expect(card.severity).toBe('info');
    expect(card.dismissPolicy).toBe('any');
  });

  it('never claims reachability or safety in the sentence', () => {
    stubNoIntents();
    for (const model of [
      render({ web: { ...app, ports: ['8080:80'] } }),
      render({ cf: cloudflared, app }),
      render({ app }),
    ]) {
      for (const card of unclassified(model)) {
        const text = card.message.toLowerCase();
        expect(text).not.toMatch(/\b(?:internet reachable|internet-reachable|safe|isolated)\b/);
        expect(text.replace(/unverified/g, '')).not.toMatch(/verified/);
      }
    }
  });
});
