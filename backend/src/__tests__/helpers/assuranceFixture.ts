/**
 * Shared Compose Assurance fixtures.
 *
 * `maximalContext()` is a single context in which every active Compose Doctor
 * rule fires, except the rules that are mutually exclusive with it (the
 * degraded-state rules and the dossier-versus-reverse-proxy pair), which have
 * their own variants below. `dropEvidence()` removes one evidence source the
 * way the service does when collection fails, so the coverage declarations can
 * be checked against the rules' own guards.
 */
import type { PreflightContext } from '../../services/preflight/types';
import type { EffService, EffectiveModel } from '../../services/preflight/effectiveModel';
import type { EvidenceRequirement } from '../../services/assurance/types';

export function svc(over: Partial<EffService> = {}): EffService {
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

function port(start: number, hostIp = '', protocol = 'tcp') {
  return { startPort: start, endPort: start, hostIp, protocol };
}

function socketMount(readOnly: boolean) {
  return {
    binds: [{ source: '/var/run/docker.sock', target: '/var/run/docker.sock' }],
    storageMounts: [{ type: 'bind' as const, source: '/var/run/docker.sock', target: '/var/run/docker.sock', readOnly }],
  };
}

/** Every service the maximal fixture needs, with the evidence each rule reads. */
function maximalServices(): EffService[] {
  return [
    // Publishes on all interfaces, mounts the socket directly, runs privileged
    // with a UID, has no restart policy, and is the third service on 9090.
    svc({
      name: 'web',
      image: 'nginx:latest',
      privileged: true,
      user: '1000',
      envKeys: ['PUID'],
      restart: undefined,
      ports: [port(8080), port(9090)],
      networks: [{ key: 'frontend', aliases: [] }],
      ...socketMount(false),
    }),
    // A socket proxy that is writable, published, mutating, and non-internal.
    svc({
      name: 'socketproxy',
      image: 'tecnativa/docker-socket-proxy:0.2',
      ports: [port(2375, '127.0.0.1')],
      networks: [{ key: 'frontend', aliases: [] }],
      enabledProxyApiFlags: ['POST'],
      ...socketMount(false),
    }),
    // Points at the proxy and carries reverse-proxy labels with no documented URL.
    svc({
      name: 'client',
      image: 'curlimages/curl:8.10.0',
      dockerEndpointHosts: ['socketproxy'],
      networks: [{ key: 'frontend', aliases: [] }],
      labelKeys: ['traefik.enable'],
    }),
    // A database on all interfaces, with its healthcheck explicitly disabled.
    svc({
      name: 'db',
      image: 'postgres:16.4',
      ports: [port(5432), port(9090)],
      networks: [{ key: 'frontend', aliases: [] }],
    }),
    // Runs in the tunnel connector's namespace and is classified internal.
    svc({
      name: 'tunneled',
      image: 'alpine:3.20',
      networkMode: 'service:ts',
    }),
    // The tunnel connector itself.
    svc({
      name: 'ts',
      image: 'tailscale/tailscale:stable',
      envKeys: ['TS_AUTHKEY'],
      networks: [{ key: 'frontend', aliases: [] }],
    }),
    // Swarm-only deploy fields.
    svc({
      name: 'swarmy',
      image: 'busybox:1.36',
      deploy: { placement: { constraints: [] } },
    }),
    // Two services sharing a container_name.
    svc({ name: 'one', image: 'busybox:1.36', containerName: 'dup-name' }),
    svc({ name: 'two', image: 'busybox:1.36', containerName: 'dup-name' }),
    // A container_name another stack already holds.
    svc({ name: 'three', image: 'busybox:1.36', containerName: 'taken' }),
    // An anonymous volume.
    svc({
      name: 'anon',
      image: 'busybox:1.36',
      storageMounts: [{ type: 'anonymous', target: '/var/data', readOnly: false }],
    }),
    // Host networking.
    svc({ name: 'hosty', image: 'busybox:1.36', networkMode: 'host' }),
  ];
}

function maximalModel(): EffectiveModel {
  return {
    projectName: 'proj',
    services: maximalServices(),
    networks: {
      frontend: { name: 'proj_frontend', external: false, internal: false },
      ext: { name: 'ext-net', external: true, internal: false },
    },
    volumes: {
      cache: { name: 'proj_cache', external: false, internal: false },
      extvol: { name: 'ext-vol', external: true, internal: false },
    },
  };
}

const HEALTHCHECKS: PreflightContext['healthchecks'] = {
  web: { state: 'absent', origin: 'none', consistentReplicas: null },
  socketproxy: { state: 'runtime-inherited', origin: 'runtime', consistentReplicas: null },
  client: { state: 'absent', origin: 'none', consistentReplicas: null },
  db: { state: 'explicitly-disabled', origin: 'compose', consistentReplicas: null },
  tunneled: { state: 'unverifiable', origin: 'none', consistentReplicas: null },
  ts: { state: 'inconsistent-replicas', origin: 'compose', consistentReplicas: false },
};

export function maximalContext(over: Partial<PreflightContext> = {}): PreflightContext {
  const model = maximalModel();
  return {
    stackName: 'proj',
    platform: 'linux',
    model,
    renderable: true,
    renderError: null,
    unsetEnvVars: ['UNSET_VAR'],
    literalDollarWarnings: [{ envKey: 'BCRYPT_HASH', likelySecret: true, service: 'web' }],
    missingEnvFiles: [{ rawPath: './missing.env', services: ['web'] }],
    // Only one authored service name, so the effective model reads as expanded.
    sourceServiceNames: ['web'],
    sourceReadable: true,
    nodePorts: [{ publishedPort: 8080, protocol: 'tcp', ip: '', stack: 'other' }],
    existingNetworkNames: new Set(),
    existingVolumeNames: new Set(),
    existingContainers: [{ name: 'taken', stack: 'other' }],
    nodeStateAvailable: true,
    bindChecks: [
      { service: 'web', source: '/base/missing', target: '/missing', withinBase: true, exists: false, ownerUid: null },
      { service: 'web', source: '/base/owned', target: '/owned', withinBase: true, exists: true, ownerUid: 0 },
      { service: 'web', source: '/outside/data', target: '/outside', withinBase: false, exists: false, ownerUid: null },
    ],
    stackIntent: null,
    serviceIntents: { web: 'internal', tunneled: 'internal' },
    accessUrlPorts: new Set(),
    hasAccessUrls: false,
    exposureAvailable: true,
    envContextAvailable: true,
    isSelfStack: true,
    meshManaged: false,
    healthchecks: HEALTHCHECKS,
    composeVersionSkew: { runningVersion: '2.39.0', services: [{ service: 'web', createdBy: ['2.38.1'] }] },
    ...over,
  };
}

/**
 * The maximal context with a second instance of the repeatable subjects that
 * seven rules report per item: node port conflicts, missing external networks
 * and volumes, new networks and volumes, and duplicate or taken container
 * names. A rule that emits one hit per subject then emits several hits, which
 * is where a missing subject collides. Only the port conflict rule gives one
 * service several hits; the others vary by network, volume, or container name.
 */
export function wideContext(): PreflightContext {
  const base = maximalContext();
  const model = base.model as EffectiveModel;
  return maximalContext({
    model: {
      ...model,
      services: [
        ...model.services,
        svc({ name: 'four', image: 'busybox:1.36', containerName: 'dup-name-2' }),
        svc({ name: 'five', image: 'busybox:1.36', containerName: 'dup-name-2' }),
        svc({ name: 'six', image: 'busybox:1.36', containerName: 'taken-2' }),
      ],
      networks: {
        ...model.networks,
        ext2: { name: 'ext-net-2', external: true, internal: false },
        backend: { name: 'proj_backend', external: false, internal: false },
      },
      volumes: {
        ...model.volumes,
        extvol2: { name: 'ext-vol-2', external: true, internal: false },
        data: { name: 'proj_data', external: false, internal: false },
      },
    },
    nodePorts: [8080, 9090, 5432, 2375].map(publishedPort => ({ publishedPort, protocol: 'tcp', ip: '', stack: 'other' })),
    existingContainers: [{ name: 'taken', stack: 'other' }, { name: 'taken-2', stack: 'other' }],
  });
}

/** The maximal context, minus the node snapshot: `node-state-unavailable` fires. */
export function degradedNodeStateContext(): PreflightContext {
  return maximalContext({
    nodeStateAvailable: false,
    nodePorts: [],
    existingNetworkNames: new Set(),
    existingVolumeNames: new Set(),
    existingContainers: [],
  });
}

/** The maximal context, minus a renderable model: `render-failed` fires. */
export function unrenderableContext(): PreflightContext {
  return maximalContext({
    model: null,
    renderable: false,
    renderError: 'boom',
    bindChecks: [],
    healthchecks: {},
    sourceServiceNames: [],
  });
}

/**
 * The maximal context with documented access URLs: `exposure-port-vs-dossier`
 * fires, and `reverse-proxy-undocumented` cannot (it requires no access URLs).
 */
export function dossierContext(): PreflightContext {
  return maximalContext({ hasAccessUrls: true, accessUrlPorts: new Set([5432]) });
}

/**
 * Remove one evidence source the way `ComposeDoctorService` does when collection
 * fails, so the remaining findings show exactly what that evidence produced.
 */
export function dropEvidence(ctx: PreflightContext, requirement: EvidenceRequirement): PreflightContext {
  switch (requirement) {
    case 'source':
      return { ...ctx, sourceReadable: false, sourceServiceNames: [] };
    case 'effective-model':
      return { ...ctx, model: null, bindChecks: [], healthchecks: {} };
    case 'env-context':
      // The service still emits a generic literal-dollar warning from the raw
      // stderr names when the authored env context is unreadable, so only the
      // rules that read that context lose their input.
      return {
        ...ctx,
        envContextAvailable: false,
        unsetEnvVars: [],
        literalDollarWarnings: ctx.literalDollarWarnings.length > 0 ? [{ likelySecret: false }] : [],
        missingEnvFiles: [],
      };
    case 'node-state':
      return {
        ...ctx,
        nodeStateAvailable: false,
        nodePorts: [],
        existingNetworkNames: new Set(),
        existingVolumeNames: new Set(),
        existingContainers: [],
      };
    case 'exposure-context':
      return {
        ...ctx,
        exposureAvailable: false,
        stackIntent: null,
        serviceIntents: {},
        accessUrlPorts: new Set(),
        hasAccessUrls: false,
      };
    case 'compose-version':
      return { ...ctx, composeVersionSkew: null };
  }
}
