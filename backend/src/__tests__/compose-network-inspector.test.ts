/**
 * The Compose Network Inspector: the normalized-model adapters (rendered vs raw
 * declared produce the same shape), the pure facts assembler, and the
 * runtime-vs-Compose drift comparison (system/default/external networks and
 * stopped containers are not flagged).
 */
import { describe, it, expect } from 'vitest';
import type { EffectiveModel, EffService } from '../services/preflight/effectiveModel';
import type { DeclaredCompose } from '../helpers/composeDependencyParse';
import type { DependencySnapshot, DependencyContainer, DependencyNetwork } from '../services/DockerController';
import {
  fromEffectiveModel, fromDeclaredCompose, compareStackNetworks, runtimeResourceName, parseAccessUrlPorts,
} from '../services/network/normalize';
import { assembleStackNetworkFacts } from '../services/network/composeNetworkInspector';

function effSvc(over: Partial<EffService> = {}): EffService {
  return {
    name: 'web', image: 'nginx:1.27', ports: [], binds: [], namedVolumes: [],
    privileged: false, hasHealthcheck: true, restart: 'unless-stopped', envKeys: [],
    networks: [], extraHosts: [], labelKeys: [], ...over,
  };
}

function container(over: Partial<DependencyContainer> = {}): DependencyContainer {
  return {
    id: 'c1', name: 'web1', service: 'web', composeProject: 'myapp', stack: 'myapp',
    state: 'running', image: 'nginx:1.27', networks: [], volumes: [], ports: [], ...over,
  };
}

function depNet(over: Partial<DependencyNetwork> = {}): DependencyNetwork {
  return { id: 'n', name: 'myapp_backend', driver: 'bridge', scope: 'local', isSystem: false, composeProject: 'myapp', stack: 'myapp', ...over };
}

describe('normalized-model adapters', () => {
  it('rendered and raw declared models normalize to the same shape', () => {
    const eff: EffectiveModel = {
      projectName: 'myapp',
      services: [effSvc({ name: 'web', networks: [{ key: 'backend', aliases: [] }, { key: 'shared', aliases: [] }] })],
      networks: {
        backend: { name: 'myapp_backend', external: false, internal: false },
        shared: { name: 'shared_net', external: true, internal: false },
        custom: { name: 'custom_name', external: false, internal: false },
      },
      volumes: {},
    };
    const declared: DeclaredCompose = {
      services: [{ name: 'web', dependsOn: [], networks: ['backend', 'shared'], volumes: [], ports: [] }],
      networks: {
        backend: { external: false },
        shared: { external: true, name: 'shared_net' },
        custom: { external: false, name: 'custom_name' },
      },
      volumes: {},
    };
    expect(fromDeclaredCompose(declared, 'myapp')).toEqual(fromEffectiveModel(eff));
  });
});

describe('assembleStackNetworkFacts', () => {
  const model: EffectiveModel = {
    projectName: 'myapp',
    services: [effSvc({
      name: 'web',
      networks: [{ key: 'backend', aliases: ['www'] }],
      extraHosts: ['host.docker.internal:host-gateway'],
      ports: [
        { startPort: 8080, endPort: 8080, hostIp: '0.0.0.0', protocol: 'tcp' },
        { startPort: 9000, endPort: 9000, hostIp: '127.0.0.1', protocol: 'tcp' },
      ],
    })],
    networks: {
      default: { name: 'myapp_default', external: false, internal: false },
      backend: { name: 'myapp_backend', external: false, internal: true },
      shared: { name: 'shared_net', external: true, internal: false },
    },
    volumes: {},
  };

  it('reports networks with external/internal/createdByStack flags', () => {
    const facts = assembleStackNetworkFacts('myapp', model, null, null);
    expect(facts.renderable).toBe(true);
    expect(facts.networks).toEqual([
      { key: 'default', name: 'myapp_default', external: false, internal: false, createdByStack: false },
      { key: 'backend', name: 'myapp_backend', external: false, internal: true, createdByStack: true },
      { key: 'shared', name: 'shared_net', external: true, internal: false, createdByStack: false },
    ]);
  });

  it('reports service membership, aliases, extra_hosts, and port binding flags', () => {
    const svc = assembleStackNetworkFacts('myapp', model, null, null).services[0];
    expect(svc.networks).toEqual([{ key: 'backend', aliases: ['www'] }]);
    expect(svc.extraHosts).toEqual(['host.docker.internal:host-gateway']);
    expect(svc.publishedPorts[0]).toMatchObject({ startPort: 8080, allInterfaces: true, loopbackOnly: false });
    expect(svc.publishedPorts[1]).toMatchObject({ startPort: 9000, allInterfaces: false, loopbackOnly: true });
  });

  it('marks the runtime unavailable and leaves drift empty when there is no snapshot', () => {
    const facts = assembleStackNetworkFacts('myapp', model, null, null);
    expect(facts.runtime).toBe('unavailable');
    expect(facts.drift.runtimeOnlyAttachments).toEqual([]);
  });

  it('returns a non-renderable facts payload when the model is null', () => {
    const facts = assembleStackNetworkFacts('myapp', null, 'render failed', null);
    expect(facts.renderable).toBe(false);
    expect(facts.renderError).toBe('render failed');
    expect(facts.networks).toEqual([]);
  });

  it('computes real drift through to the payload when a snapshot is present', () => {
    const snapshot: DependencySnapshot = {
      containers: [container({ networks: [{ name: 'myapp_backend', id: 'a', ip: '' }, { name: 'myapp_rogue', id: 'b', ip: '' }] })],
      networks: [depNet({ name: 'myapp_backend' }), depNet({ name: 'myapp_rogue' })],
      volumes: [],
    };
    const facts = assembleStackNetworkFacts('myapp', model, null, snapshot);
    expect(facts.runtime).toBe('available');
    expect(facts.drift.runtimeOnlyAttachments).toEqual([{ container: 'web1', service: 'web', network: 'myapp_rogue' }]);
  });
});

describe('runtimeResourceName', () => {
  it('uses a name override, else the project prefix', () => {
    expect(runtimeResourceName('myapp', 'backend', undefined)).toBe('myapp_backend');
    expect(runtimeResourceName('myapp', 'backend', 'backend')).toBe('myapp_backend'); // name == key is not an override
    expect(runtimeResourceName('myapp', 'shared', 'shared_net')).toBe('shared_net');
  });
});

describe('parseAccessUrlPorts', () => {
  it('extracts host ports from access-URL text', () => {
    expect([...parseAccessUrlPorts('http://host:8080/path and https://host:443')].sort((a, b) => a - b)).toEqual([443, 8080]);
  });
  it('finds no port when the URL has none (implicit scheme port)', () => {
    expect([...parseAccessUrlPorts('https://app.example.com/dashboard')]).toEqual([]);
  });
  it('rejects out-of-range numbers and returns an empty set for empty input', () => {
    expect([...parseAccessUrlPorts('http://host:99999')]).toEqual([]);
    expect([...parseAccessUrlPorts('')]).toEqual([]);
  });
});

describe('compareStackNetworks', () => {
  const declared = fromEffectiveModel({
    projectName: 'myapp',
    services: [],
    networks: {
      backend: { name: 'myapp_backend', external: false, internal: false },
      shared: { name: 'shared_net', external: true, internal: false },
    },
    volumes: {},
  });

  function snapshot(containers: DependencyContainer[], networks: DependencyNetwork[]): DependencySnapshot {
    return { containers, networks, volumes: [] };
  }

  it('flags a runtime-only attachment to a stack-owned undeclared network', () => {
    const snap = snapshot(
      [container({ networks: [{ name: 'myapp_backend', id: 'a', ip: '' }, { name: 'myapp_extra', id: 'b', ip: '' }] })],
      [depNet({ name: 'myapp_backend' }), depNet({ name: 'myapp_extra' }), depNet({ name: 'shared_net', stack: null })],
    );
    const drift = compareStackNetworks(declared, snap, 'myapp');
    expect(drift.runtimeOnlyAttachments).toEqual([{ container: 'web1', service: 'web', network: 'myapp_extra' }]);
  });

  it('flags a foreign network owned by another stack', () => {
    const snap = snapshot(
      [container({ networks: [{ name: 'other_net', id: 'x', ip: '' }] })],
      [depNet({ name: 'other_net', stack: 'other', composeProject: 'other' })],
    );
    const drift = compareStackNetworks(declared, snap, 'myapp');
    expect(drift.foreignNetworkAttachments).toEqual([{ container: 'web1', network: 'other_net' }]);
  });

  it('treats a stack-owned network with no project prefix as runtime-only (ownership via snapshot.stack)', () => {
    const snap = snapshot(
      [container({ networks: [{ name: 'odd-named-net', id: 'x', ip: '' }] })],
      [depNet({ name: 'odd-named-net', stack: 'myapp', composeProject: 'myapp' })],
    );
    const drift = compareStackNetworks(declared, snap, 'myapp');
    expect(drift.runtimeOnlyAttachments).toEqual([{ container: 'web1', service: 'web', network: 'odd-named-net' }]);
    expect(drift.foreignNetworkAttachments).toEqual([]);
  });

  it('treats an attachment to a network absent from the snapshot as foreign', () => {
    const snap = snapshot(
      [container({ networks: [{ name: 'ghost-net', id: 'x', ip: '' }] })],
      [], // ghost-net is not in the snapshot network list
    );
    const drift = compareStackNetworks(declared, snap, 'myapp');
    expect(drift.foreignNetworkAttachments).toEqual([{ container: 'web1', network: 'ghost-net' }]);
  });

  it('drives the declared-compose adapter through the comparison (name override resolves)', () => {
    const declaredFromCompose = fromDeclaredCompose({
      services: [{ name: 'web', dependsOn: [], networks: ['edge'], volumes: [], ports: [] }],
      networks: { edge: { external: false, name: 'edge_override' } },
      volumes: {},
    }, 'myapp');
    const snap = snapshot(
      [container({ networks: [{ name: 'myapp_default', id: 'd', ip: '' }] })],
      [depNet({ name: 'myapp_default' })],
    );
    // edge_override is declared but missing from the runtime.
    expect(compareStackNetworks(declaredFromCompose, snap, 'myapp').missingFromRuntime).toEqual(['edge_override']);
  });

  it('ignores system networks, the default network, and external networks', () => {
    const snap = snapshot(
      [container({ networks: [
        { name: 'bridge', id: 's', ip: '' },
        { name: 'myapp_default', id: 'd', ip: '' },
        { name: 'shared_net', id: 'e', ip: '' },
      ] })],
      [depNet({ name: 'bridge', isSystem: true, stack: null }), depNet({ name: 'myapp_default' }), depNet({ name: 'shared_net', stack: null })],
    );
    const drift = compareStackNetworks(declared, snap, 'myapp');
    expect(drift.runtimeOnlyAttachments).toEqual([]);
    expect(drift.foreignNetworkAttachments).toEqual([]);
  });

  it('does not flag attachments from stopped containers', () => {
    const snap = snapshot(
      [container({ state: 'exited', networks: [{ name: 'myapp_extra', id: 'b', ip: '' }] })],
      [depNet({ name: 'myapp_extra' })],
    );
    expect(compareStackNetworks(declared, snap, 'myapp').runtimeOnlyAttachments).toEqual([]);
  });

  it('reports a declared network no running service uses', () => {
    const snap = snapshot(
      [container({ networks: [{ name: 'myapp_default', id: 'd', ip: '' }] })],
      [depNet({ name: 'myapp_backend' }), depNet({ name: 'myapp_default' })],
    );
    expect(compareStackNetworks(declared, snap, 'myapp').declaredButUnused).toEqual(['backend']);
  });

  it('reports a declared network missing from the runtime', () => {
    const snap = snapshot(
      [container({ networks: [{ name: 'myapp_default', id: 'd', ip: '' }] })],
      [depNet({ name: 'myapp_default' })],
    );
    expect(compareStackNetworks(declared, snap, 'myapp').missingFromRuntime).toEqual(['myapp_backend']);
  });
});
