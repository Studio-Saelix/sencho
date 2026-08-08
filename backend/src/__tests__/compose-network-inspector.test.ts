/**
 * The Compose Network Inspector: the normalized-model adapters (rendered vs raw
 * declared produce the same shape), the pure facts assembler, and the
 * runtime-vs-Compose drift comparison (system/default/external networks and
 * stopped containers are not flagged).
 */
import { describe, it, expect, vi } from 'vitest';
import type { EffectiveModel, EffService } from '../services/preflight/effectiveModel';
import type { DeclaredCompose } from '../helpers/composeDependencyParse';
import type { DependencySnapshot, DependencyContainer, DependencyNetwork } from '../services/DockerController';
import {
  fromEffectiveModel, fromDeclaredCompose, compareStackNetworks, runtimeResourceName, parseAccessUrlPorts,
  type ManagedNetworkAttachmentPredicate,
} from '../services/network/normalize';
import { assembleStackNetworkFacts, buildStackNetworkFacts } from '../services/network/composeNetworkInspector';
import { buildNodeNetworkingFindings } from '../services/network/networkingFindings';
import type { NetworkingNetworkBase } from '../services/network/networkingTypes';
import DockerController from '../services/DockerController';
import { ComposeService } from '../services/ComposeService';
import { DatabaseService } from '../services/DatabaseService';
import { FileSystemService } from '../services/FileSystemService';

function effSvc(over: Partial<EffService> = {}): EffService {
  const hasHealthcheck = over.hasHealthcheck ?? true;
  const composeHealthcheck = over.composeHealthcheck ?? (hasHealthcheck ? 'active' : 'absent');
  return {
    name: 'web', image: 'nginx:1.27', ports: [], binds: [], namedVolumes: [], storageMounts: [],
    privileged: false, restart: 'unless-stopped', envKeys: [],
    enabledProxyApiFlags: [],
    dockerEndpointHosts: [],
    networks: [], extraHosts: [], labelKeys: [],
    ...over,
    hasHealthcheck,
    composeHealthcheck,
  };
}

function container(over: Partial<DependencyContainer> = {}): DependencyContainer {
  return {
    id: 'c1', name: 'web1', service: 'web', composeProject: 'myapp', stack: 'myapp',
    state: 'running', exitCode: null, image: 'nginx:1.27', networks: [], volumes: [], ports: [], ...over,
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
        // External with no name override: the rendered model resolves the runtime
        // name to the key verbatim, so the raw adapter must agree (not myapp_extnet).
        extnet: { name: 'extnet', external: true, internal: false },
      },
      volumes: {},
    };
    const declared: DeclaredCompose = {
      services: [{ name: 'web', dependsOn: [], networks: ['backend', 'shared'], volumes: [], ports: [] }],
      networks: {
        backend: { external: false },
        shared: { external: true, name: 'shared_net' },
        custom: { external: false, name: 'custom_name' },
        extnet: { external: true },
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
    expect(runtimeResourceName('myapp', 'backend', 'myapp_backend')).toBe('myapp_backend');
    expect(runtimeResourceName('myapp', 'backend', 'backend')).toBe('backend');
    expect(runtimeResourceName('myapp', 'shared', 'shared_net')).toBe('shared_net');
  });

  it('resolves explicit name equal to the compose key (regression: #1581)', () => {
    expect(runtimeResourceName('network', 'tailscale', 'tailscale')).toBe('tailscale');
    expect(runtimeResourceName('network', 'proxy', 'proxy')).toBe('proxy');
  });

  it('never project-prefixes an external resource (runtime name is the key, or a name override)', () => {
    // Compose references an external network/volume by its real name and never
    // prefixes the project, so an external resource with no name override keeps
    // its key verbatim. Prefixing it invents a phantom `<project>_<key>` that no
    // runtime resource matches, which then reads as foreign-network drift.
    expect(runtimeResourceName('myapp', 'arr-net', undefined, true)).toBe('arr-net');
    expect(runtimeResourceName('myapp', 'arr-net', 'arr-net', true)).toBe('arr-net');
    expect(runtimeResourceName('myapp', 'shared', 'shared-prod', true)).toBe('shared-prod');
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

  it('does not flag an external network declared without a name override through the raw adapter', () => {
    // The plex/arr-net case: an external network declared `external: true` with no
    // name override. Its real runtime name is the key (arr-net), unprefixed, so an
    // attachment to it reads as in-sync, not as a foreign network owned elsewhere.
    const declaredFromCompose = fromDeclaredCompose({
      services: [{ name: 'plex', dependsOn: [], networks: ['arr-net'], volumes: [], ports: [] }],
      networks: { 'arr-net': { external: true } },
      volumes: {},
    }, 'plex');
    const snap = snapshot(
      [container({ name: 'plex', service: 'plex', composeProject: 'plex', stack: 'plex', networks: [{ name: 'arr-net', id: 'a', ip: '' }] })],
      [depNet({ name: 'arr-net', composeProject: null, stack: null })],
    );
    const drift = compareStackNetworks(declaredFromCompose, snap, 'plex');
    expect(drift.foreignNetworkAttachments).toEqual([]);
    expect(drift.runtimeOnlyAttachments).toEqual([]);
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

  it('removes managed Mesh drift before Networking findings while preserving advanced-driver info', () => {
    const meshOnlyModel: EffectiveModel = {
      projectName: 'myapp',
      services: [],
      networks: {},
      volumes: {},
    };
    const snap = snapshot(
      [container({ networks: [{ name: 'sencho_mesh', id: 'm', ip: '' }] })],
      [depNet({ id: 'm', name: 'sencho_mesh', driver: 'macvlan', composeProject: null, stack: null })],
    );
    const facts = assembleStackNetworkFacts(
      'myapp',
      meshOnlyModel,
      null,
      snap,
      (_runtimeContainer, networkName) => networkName === 'sencho_mesh',
    );
    const baseNetworks: NetworkingNetworkBase[] = [{
      id: 'm',
      name: 'sencho_mesh',
      driver: 'macvlan',
      scope: 'local',
      isSystem: false,
      ingress: false,
      composeProject: null,
      stack: null,
      connectedCount: 1,
      isSencho: true,
      ownership: 'sencho-managed',
      declaredByStacks: [],
      declaredExternalByStacks: [],
      isExternalDependency: false,
    }];

    const findings = buildNodeNetworkingFindings(1, snap, [facts], baseNetworks);

    expect(facts.drift.runtimeOnlyAttachments).toEqual([]);
    expect(facts.drift.foreignNetworkAttachments).toEqual([]);
    expect(findings.some(f => f.kind === 'network-undeclared' || f.kind === 'foreign-network-attachment')).toBe(false);
    expect(findings).toContainEqual(expect.objectContaining({
      kind: 'advanced-driver-caveat',
      severity: 'info',
      network: 'sencho_mesh',
    }));
  });

  it('keeps Networking facts available and Mesh drift actionable when opt-in authority fails', async () => {
    const snap = snapshot(
      [container({ networks: [{ name: 'sencho_mesh', id: 'm', ip: '' }] })],
      [depNet({ name: 'sencho_mesh', composeProject: null, stack: null })],
    );
    vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
      renderConfig: vi.fn().mockResolvedValue({
        rendered: JSON.stringify({ name: 'myapp', services: { web: { image: 'nginx:1.27' } } }),
        stderr: '',
        code: 0,
        timedOut: false,
      }),
    } as unknown as ComposeService);
    vi.spyOn(FileSystemService, 'getInstance').mockReturnValue({
      getStacks: vi.fn().mockResolvedValue(['myapp']),
    } as unknown as FileSystemService);
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      getDependencySnapshot: vi.fn().mockResolvedValue(snap),
    } as unknown as DockerController);
    vi.spyOn(DatabaseService, 'getInstance').mockImplementation(() => {
      throw new Error('database unavailable');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const facts = await buildStackNetworkFacts(1, 'myapp');

      expect(facts.runtime).toBe('available');
      expect(facts.drift.foreignNetworkAttachments).toEqual([{ container: 'web1', network: 'sencho_mesh' }]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('threads opted-in authority through Networking facts and preserves advanced-driver info', async () => {
    const snap = snapshot(
      [container({ networks: [{ name: 'sencho_mesh', id: 'm', ip: '' }] })],
      [depNet({ id: 'm', name: 'sencho_mesh', driver: 'macvlan', composeProject: null, stack: null })],
    );
    vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
      renderConfig: vi.fn().mockResolvedValue({
        rendered: JSON.stringify({ name: 'myapp', services: { web: { image: 'nginx:1.27' } } }),
        stderr: '',
        code: 0,
        timedOut: false,
      }),
    } as unknown as ComposeService);
    vi.spyOn(FileSystemService, 'getInstance').mockReturnValue({
      getStacks: vi.fn().mockResolvedValue(['myapp']),
    } as unknown as FileSystemService);
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      getDependencySnapshot: vi.fn().mockResolvedValue(snap),
    } as unknown as DockerController);
    vi.spyOn(DatabaseService, 'getInstance').mockReturnValue({
      isMeshStackEnabled: vi.fn().mockReturnValue(true),
      getStackExposureIntents: vi.fn().mockReturnValue([]),
      getStackDossier: vi.fn().mockReturnValue(null),
    } as unknown as DatabaseService);

    try {
      const facts = await buildStackNetworkFacts(1, 'myapp');
      const baseNetworks: NetworkingNetworkBase[] = [{
        id: 'm', name: 'sencho_mesh', driver: 'macvlan', scope: 'local', isSystem: false,
        ingress: false, composeProject: null, stack: null, connectedCount: 1, isSencho: true,
        ownership: 'sencho-managed', declaredByStacks: [], declaredExternalByStacks: [],
        isExternalDependency: false,
      }];
      const findings = buildNodeNetworkingFindings(1, snap, [facts], baseNetworks);

      expect(facts.drift.runtimeOnlyAttachments).toEqual([]);
      expect(facts.drift.foreignNetworkAttachments).toEqual([]);
      expect(findings.filter(f => f.kind === 'network-undeclared' || f.kind === 'foreign-network-attachment')).toEqual([]);
      expect(findings).toContainEqual(expect.objectContaining({
        kind: 'advanced-driver-caveat',
        severity: 'info',
        network: 'sencho_mesh',
      }));
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('ignores a verified Sencho Mesh attachment for the Sencho container', () => {
    const snap = snapshot(
      [container({ id: 'sencho-id', name: 'sencho', service: 'sencho', networks: [{ name: 'sencho_mesh', id: 'm', ip: '' }] })],
      [depNet({ name: 'sencho_mesh', composeProject: null, stack: null })],
    );
    const managed: ManagedNetworkAttachmentPredicate = (runtimeContainer, networkName) =>
      runtimeContainer.id === 'sencho-id' && networkName === 'sencho_mesh';

    const drift = compareStackNetworks(declared, snap, 'myapp', managed);

    expect(drift.runtimeOnlyAttachments).toEqual([]);
    expect(drift.foreignNetworkAttachments).toEqual([]);
  });

  it('ignores a verified Mesh attachment for an opted-in application stack', () => {
    const snap = snapshot(
      [container({ networks: [{ name: 'sencho_mesh', id: 'm', ip: '' }] })],
      [depNet({ name: 'sencho_mesh', composeProject: null, stack: null })],
    );
    const managed: ManagedNetworkAttachmentPredicate = (_runtimeContainer, networkName) =>
      networkName === 'sencho_mesh';

    const drift = compareStackNetworks(declared, snap, 'myapp', managed);

    expect(drift.runtimeOnlyAttachments).toEqual([]);
    expect(drift.foreignNetworkAttachments).toEqual([]);
  });

  it('keeps an unverified manual Mesh attachment actionable', () => {
    const snap = snapshot(
      [container({ networks: [{ name: 'sencho_mesh', id: 'm', ip: '' }] })],
      [depNet({ name: 'sencho_mesh', composeProject: null, stack: null })],
    );

    const drift = compareStackNetworks(declared, snap, 'myapp', () => false);

    expect(drift.runtimeOnlyAttachments).toEqual([]);
    expect(drift.foreignNetworkAttachments).toEqual([{ container: 'web1', network: 'sencho_mesh' }]);
  });

  it('keeps sencho_extra actionable even when the stack is Mesh-managed', () => {
    const snap = snapshot(
      [container({ networks: [{ name: 'sencho_extra', id: 'e', ip: '' }] })],
      [depNet({ name: 'sencho_extra', composeProject: null, stack: null })],
    );

    const drift = compareStackNetworks(declared, snap, 'myapp', () => true);

    expect(drift.runtimeOnlyAttachments).toEqual([]);
    expect(drift.foreignNetworkAttachments).toEqual([{ container: 'web1', network: 'sencho_extra' }]);
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
