/**
 * The connected-container section of the sanitized inspect DTO must expose only
 * the allowlisted fields and must never leak label values, MAC addresses, or
 * endpoint IDs from the raw Docker inspect payload.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeNetworkInspect } from '../services/network/sanitizeNetworkInspect';
import type { DependencySnapshot } from '../services/DockerController';

describe('sanitizeNetworkInspect connected containers', () => {
  it('exposes only name/service/stack/ipv4 (CIDR stripped) and no raw label values or MAC/endpoint data', () => {
    const snapshot: DependencySnapshot = {
      networks: [{ id: 'net1', name: 'app_net', driver: 'bridge', scope: 'local', isSystem: false, composeProject: 'app', stack: 'app' }],
      volumes: [],
      containers: [{
        id: 'c1', name: 'app-web-1', service: 'web', composeProject: 'app', stack: 'app', state: 'running', image: 'nginx',
        networks: [{ name: 'app_net', id: 'net1', ip: '172.20.0.5/16' }], volumes: [], ports: [],
      }],
    };
    const raw = {
      Id: 'net1', Name: 'app_net', Driver: 'bridge', Scope: 'local',
      Labels: { 'com.docker.compose.project': 'app', 'secret.token': 'do-not-leak' },
      Containers: { c1: { Name: 'app-web-1', MacAddress: '02:42:ac:14:00:05', EndpointID: 'endpoint-xyz', IPv4Address: '172.20.0.5/16' } },
    };

    const result = sanitizeNetworkInspect(raw, snapshot.networks[0], snapshot);

    expect(result.connectedContainers).toEqual([
      { name: 'app-web-1', service: 'web', stack: 'app', ipv4: '172.20.0.5' },
    ]);
    // Label keys are exposed, values never are.
    expect(result.labelKeys).toContain('secret.token');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('do-not-leak');
    expect(serialized).not.toContain('02:42:ac:14:00:05');
    expect(serialized).not.toContain('endpoint-xyz');
  });

  it('yields an empty connected list when no snapshot is provided', () => {
    const result = sanitizeNetworkInspect({ Id: 'net1', Name: 'app_net' }, undefined, undefined);
    expect(result.connectedContainers).toEqual([]);
  });
});
