/**
 * Per-network exposure counters must resolve a service's membership through
 * its namespace owner and count a public-edge tunnel as exposure. These are
 * pure unit tests over the same facts the overview builds.
 */
import { describe, it, expect, vi } from 'vitest';
import { parseEffectiveModel, type EffectiveModel } from '../services/preflight/effectiveModel';
import { assembleStackNetworkFacts } from '../services/network/composeNetworkInspector';
import { enrichNetworkRows } from '../services/network/networkingInventory';
import { DatabaseService } from '../services/DatabaseService';
import type { DependencySnapshot } from '../services/DockerController';
import type { NetworkingNetworkBase } from '../services/network/networkingTypes';

const STACK = 'proj';

function model(services: Record<string, Record<string, unknown>>, networks: Record<string, unknown> = { default: { name: 'proj_default' } }): EffectiveModel {
  return parseEffectiveModel({ name: STACK, services, networks }, STACK);
}

function baseRow(name: string, driver = 'bridge'): NetworkingNetworkBase {
  return {
    id: `id-${name}`,
    name,
    driver,
    scope: 'local',
    isSystem: name === 'bridge',
    ingress: false,
    composeProject: STACK,
    stack: STACK,
    connectedCount: 1,
    isSencho: false,
    ownership: 'compose-managed',
    declaredByStacks: [STACK],
    declaredExternalByStacks: [],
    isExternalDependency: false,
  };
}

function snapshot(service: string, network = 'proj_default', driver = 'bridge'): DependencySnapshot {
  return {
    containers: [{
      id: `c-${service}`,
      name: `${STACK}-${service}-1`,
      service,
      composeProject: STACK,
      stack: STACK,
      state: 'running',
      exitCode: null,
      image: 'example',
      networks: [{ name: network, id: `id-${network}`, ip: '172.18.0.2' }],
      volumes: [],
      ports: [],
    }],
    networks: [{ id: `id-${network}`, name: network, driver, scope: 'local', isSystem: network === 'bridge', composeProject: STACK, stack: STACK }],
    volumes: [],
  };
}

function rows(services: Record<string, Record<string, unknown>>, snap: DependencySnapshot, network = 'proj_default', intents: Array<{ service: string; intent: string }> = []) {
  vi.spyOn(DatabaseService, 'getInstance').mockReturnValue({
    getStackExposureIntents: vi.fn().mockReturnValue(intents),
  } as unknown as DatabaseService);
  const facts = assembleStackNetworkFacts(STACK, model(services), null, snap);
  return enrichNetworkRows(1, [baseRow(network)], [facts], snap, []);
}

describe('per-network exposure counters follow the namespace owner', () => {
  it('counts an application in the connector namespace as exposed and unclassified', () => {
    const snap = snapshot('cloudflared');
    const [row] = rows({
      cloudflared: { image: 'cloudflare/cloudflared', environment: { TUNNEL_TOKEN: 'secret' }, networks: { default: null } },
      app: { image: 'example/app:1', network_mode: 'service:cloudflared' },
    }, snap);
    expect(row.exposureSummary).toMatchObject({
      publishingStackCount: 1,
      broadExposureCount: 1,
      unclassifiedStackCount: 1,
    });
  });

  it('follows a namespace chain and counts every reached application', () => {
    const snap = snapshot('tailscale');
    const [row] = rows({
      tailscale: { image: 'tailscale/tailscale', environment: { TS_AUTHKEY: 'secret' }, networks: { default: null } },
      app: { image: 'example/app:1', network_mode: 'service:tailscale' },
      worker: { image: 'example/worker:1', network_mode: 'service:app' },
    }, snap);
    expect(row.exposureSummary).toMatchObject({ broadExposureCount: 0, unclassifiedStackCount: 1 });
  });

  it('counts reversed connector/application ownership the same way', () => {
    const snap = snapshot('app');
    const [row] = rows({
      app: { image: 'example/app:1', networks: { default: null } },
      cloudflared: { image: 'cloudflare/cloudflared', network_mode: 'service:app' },
    }, snap);
    expect(row.exposureSummary).toMatchObject({ broadExposureCount: 1, unclassifiedStackCount: 1 });
  });

  it('resolves default-bridge membership through network_mode: bridge', () => {
    const snap = snapshot('cloudflared', 'bridge');
    const [row] = rows({
      cloudflared: { image: 'cloudflare/cloudflared', network_mode: 'bridge', command: ['tunnel', 'run'] },
      legacy: { image: 'example/legacy:1', network_mode: 'bridge' },
    }, snap, 'bridge');
    expect(row.exposureSummary).toMatchObject({ publishingStackCount: 1, broadExposureCount: 1, unclassifiedStackCount: 1 });
  });

  it('keeps a classified namespace application out of the unclassified count', () => {
    const snap = snapshot('cloudflared');
    const [row] = rows({
      cloudflared: { image: 'cloudflare/cloudflared', networks: { default: null } },
      app: { image: 'example/app:1', network_mode: 'service:cloudflared' },
    }, snap, 'proj_default', [{ service: 'app', intent: 'public' }]);
    expect(row.exposureSummary?.unclassifiedStackCount).toBe(0);
    expect(row.exposureSummary?.broadExposureCount).toBe(1);
  });
});
