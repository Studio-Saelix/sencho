/**
 * Read-only, node-scoped Docker socket access inventory.
 *
 * The inventory answers one bounded question per node: which containers on this
 * node act as Docker socket proxies, which consume the socket directly, which
 * container (if any) carries Sencho's own Docker connection, and which parts of
 * that picture could not be determined. It never mutates Docker, a Compose
 * file, or a provider, and it never treats a failed read as a clean result: a
 * top-level Docker failure throws (the route answers 503), and a partial scan
 * reports `status: 'partial'` with the stages that failed.
 *
 * Discovery deliberately does not reuse the endpoint guard's single protecting
 * provider: every matching container is reported, and only one of them can be
 * flagged as Sencho's endpoint. Provider identity is reused from
 * `resolveDockerEndpointProvider()` where the endpoint is a tcp address.
 */

import { DatabaseService, type Node } from '../DatabaseService';
import DockerController, {
  type SocketInventoryContainerRow,
  type SocketInventoryListResult,
  type SocketInventoryMountRow,
} from '../DockerController';
import SelfIdentityService, { type SelfIdentityState } from '../SelfIdentityService';
import {
  resolveDockerEndpointProvider,
  type DockerEndpointProvider,
} from '../DockerEndpointProvider';
import { FleetSyncService } from '../FleetSyncService';
import {
  hasSocketProxyNameHint,
  isDockerSocketDirectoryMount,
  isDockerSocketPath,
  socketProxyProviderForImage,
  type SocketProviderType,
} from '../../helpers/socketProxyIdentity';
import { redactLabelValue } from '../../helpers/labelValueRedaction';
import { SENCHO_INFRASTRUCTURE_LABEL } from '../../helpers/senchoLabels';
import { getErrorMessage } from '../../utils/errors';
import { errorMessageForLog, redactImageReference, redactSensitiveText } from '../../utils/safeLog';

/** Hard bound on containers inspected in one snapshot. */
export const MAX_INVENTORY_CONTAINERS = 1000;
const MAX_LABELS = 64;
const MAX_LABEL_KEY = 128;
const MAX_LABEL_VALUE = 256;
const MAX_ERRORS = 10;
const MAX_STATUS = 200;
const MAX_PATH = 512;
const MAX_PORTS = 16;
const MAX_MOUNTS = 8;
const MAX_NETWORKS = 16;
const MAX_EVIDENCE = 8;

const DEFAULT_DOCKER_SOCKET = '/var/run/docker.sock';

/**
 * Conventional host paths for the local Docker daemon socket. They are consulted
 * as possible access even when the client uses another endpoint: the host may
 * still serve a socket there, and reporting a directory mount of one of their
 * ancestors as undetermined is safer than dropping it.
 */
const CANONICAL_DOCKER_SOCKET_PATHS: readonly string[] = [
  DEFAULT_DOCKER_SOCKET,
  '/run/docker.sock',
];

export type SocketRole = 'proxy' | 'direct-socket-consumer' | 'undetermined';
export type SocketClassification = 'detected' | 'candidate' | 'unknown';
export type SocketEndpointTransport = 'unix' | 'tcp' | 'npipe' | 'ssh' | 'unknown';
export type SocketEndpointDetection = 'detected' | 'undetermined' | 'unsupported';

export interface SocketInventoryError {
  stage: 'list-containers' | 'inspect-container' | 'container-metadata' | 'self-identity' | 'endpoint-provider';
  message: string;
  containerId?: string;
}

export interface SocketInventoryLabel {
  key: string;
  value: string;
  redacted?: boolean;
}

export interface SocketInventoryMount {
  source: string | null;
  destination: string | null;
  readOnly: boolean;
}

export interface SocketInventoryPort {
  privatePort: number | null;
  publicPort: number | null;
  /** The binding address, null when Docker did not provide a readable one. */
  ip: string | null;
  /**
   * True when the binding is on every host interface ('' / 0.0.0.0 / ::).
   * False for a loopback or specific address, and for an unreadable address:
   * uncertainty is never reported as a wildcard.
   */
  allInterfaces: boolean;
  /** The reported transport, null when it was present but unreadable. */
  protocol: string | null;
}

export interface SocketInventoryNetwork {
  name: string;
  id: string | null;
}

export interface SocketInventoryContainer {
  id: string;
  name: string;
  /** Docker state, including `exited` and `created` for stopped containers. */
  state: string;
  status: string;
  image: string;
  imageId: string;
  role: SocketRole;
  classification: SocketClassification;
  providerType: SocketProviderType | null;
  senchoStack: string | null;
  compose: {
    project: string | null;
    service: string | null;
    workingDir: string | null;
  } | null;
  health: string | null;
  socketMounts: SocketInventoryMount[];
  /** Recognized proxy API group names enabled with the literal value `1`. */
  apiGroups: string[];
  publishedPorts: SocketInventoryPort[];
  exposedPorts: string[];
  networks: SocketInventoryNetwork[];
  /** null when the security fact was present but could not be read. */
  privileged: boolean | null;
  /** null when the security fact was present but could not be read. */
  readonlyRootfs: boolean | null;
  infrastructureLabel: boolean;
  isSencho: boolean;
  isSenchoEndpointProvider: boolean;
  labels: SocketInventoryLabel[];
  evidence: string[];
  inspectFailed: boolean;
  /**
   * A metadata list exceeded the collection or response bound (or could not be
   * read completely), so a mount, port, network, label, or proxy flag may be
   * missing.
   */
  metadataTruncated: boolean;
}

export interface SocketEndpointDescription {
  transport: SocketEndpointTransport;
  address: string | null;
  host: string | null;
  port: number | null;
  socketPath: string | null;
  addressSource: 'env' | 'default';
}

export interface SocketInventoryEndpoint {
  transport: SocketEndpointTransport;
  address: string | null;
  addressSource: 'env' | 'default';
  detection: SocketEndpointDetection;
  reason: string | null;
  provider: {
    kind: 'direct-socket' | 'container' | 'unknown';
    providerType: SocketProviderType | null;
    containerId: string | null;
    containerName: string | null;
    compose: { project: string | null; service: string | null } | null;
    socketBindSource: string | null;
  };
  sencho: {
    state: SelfIdentityState;
    inContainer: boolean | null;
    containerId: string | null;
    containerName: string | null;
    /** Host path bind-mounted at the configured socket inside Sencho, when resolvable. */
    socketBindSource: string | null;
    reason: string | null;
  };
  evidence: string[];
}

export interface SocketInventory {
  schemaVersion: 1;
  node: {
    id: number;
    name: string | null;
    type: Node['type'] | null;
    mode: Node['mode'] | null;
    /** Hashed control-instance identity; a hub must not relabel this inventory as another node's. */
    instanceIdentity: string | null;
  };
  generatedAt: number;
  durationMs: number;
  status: 'complete' | 'partial';
  truncated: boolean;
  counts: {
    listedContainers: number;
    matchedContainers: number;
    proxies: number;
    directSocketConsumers: number;
    undetermined: number;
    inspectFailures: number;
  };
  endpoint: SocketInventoryEndpoint;
  containers: SocketInventoryContainer[];
  errors: SocketInventoryError[];
}

/** A failed socket inventory read. The route maps this to 503, never to an empty 200. */
export class SocketInventoryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SocketInventoryUnavailableError';
  }
}

interface SocketSelfInfo {
  state: SelfIdentityState;
  reason: string | null;
  containerId: string | null;
  containerName: string | null;
  bindMounts: Array<{ source: string; destination: string }> | null;
}

export interface SocketInventoryBuildInput {
  nodeId: number;
  node: Node | undefined;
  instanceIdentity: string;
  listedContainers: number;
  truncated: boolean;
  containers: SocketInventoryContainerRow[];
  self: SocketSelfInfo;
  endpoint: SocketEndpointDescription;
  endpointProvider: DockerEndpointProvider | { state: 'error'; reason: string };
  generatedAt: number;
  durationMs: number;
  errors: SocketInventoryError[];
}

export interface SocketInventoryDeps {
  docker: Pick<DockerController, 'listContainersForSocketInventory' | 'getDockerSocketPath'>;
  self: Pick<
    SelfIdentityService,
    'ensureResolved' | 'getIdentity' | 'getBindMounts' | 'getUnresolvedReason'
  >;
  resolveEndpointProvider: () => Promise<DockerEndpointProvider>;
  node: (nodeId: number) => Node | undefined;
  instanceIdentity: () => string;
  now: () => number;
}

function defaultDeps(nodeId: number): SocketInventoryDeps {
  return {
    docker: DockerController.getInstance(nodeId),
    self: SelfIdentityService.getInstance(),
    resolveEndpointProvider: resolveDockerEndpointProvider,
    node: id => DatabaseService.getInstance().getNode(id),
    instanceIdentity: () => FleetSyncService.getControlIdentity(),
    now: () => Date.now(),
  };
}

function bound(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function safeText(value: string, max: number): string {
  return bound(redactSensitiveText(value), max);
}

function bindsAllInterfaces(ip: string | null): boolean {
  // An unreadable address is not proof of a wildcard binding.
  return ip !== null && (ip === '' || ip === '0.0.0.0' || ip === '::');
}

function idMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const left = a.replace(/^sha256:/, '');
  const right = b.replace(/^sha256:/, '');
  return left.length >= 12 && right.length >= 12 && (left.startsWith(right) || right.startsWith(left));
}

/**
 * Parse `DOCKER_HOST` for display. Credentials are dropped: a `tcp://user:pass@`
 * userinfo never leaves this function. An unset value follows the active Docker
 * client: dockerode resolves it lazily (Docker Desktop's
 * `~/.docker/run/docker.sock` can win over `/var/run/docker.sock`), so the
 * caller may pass that resolved path. When the caller marks the client socket
 * unresolved, the endpoint keeps a null address and socket path instead of
 * substituting the conventional path. Without a caller-supplied path, an unset
 * value is Docker's documented unix default and is labelled as such, not as an
 * observed setting.
 */
export function describeDockerEndpoint(
  raw: string | undefined,
  options: { defaultSocketPath?: string | null; defaultSocketUnresolved?: boolean } = {},
): SocketEndpointDescription {
  const value = raw?.trim();
  if (!value) {
    if (options.defaultSocketUnresolved) {
      return {
        transport: 'unix',
        address: null,
        host: null,
        port: null,
        socketPath: null,
        addressSource: 'default',
      };
    }
    const resolved = options.defaultSocketPath?.trim() || DEFAULT_DOCKER_SOCKET;
    const npipe = /^\/\/\.\/pipe\//i.test(resolved) || /^npipe:/i.test(resolved);
    if (npipe) {
      return {
        transport: 'npipe',
        address: safeText(`npipe://${resolved.replace(/^npipe:\/\//i, '')}`, MAX_PATH),
        host: null,
        port: null,
        socketPath: null,
        addressSource: 'default',
      };
    }
    return {
      transport: 'unix',
      address: `unix://${bound(resolved, MAX_PATH)}`,
      host: null,
      port: null,
      socketPath: bound(resolved, MAX_PATH),
      addressSource: 'default',
    };
  }
  const unix = /^unix:\/\/(.*)$/i.exec(value);
  if (unix) {
    const rawPath = unix[1] ?? '';
    if (rawPath === '' && options.defaultSocketUnresolved) {
      return {
        transport: 'unix',
        address: null,
        host: null,
        port: null,
        socketPath: null,
        addressSource: 'env',
      };
    }
    // Keep the client's actual path: a relative `unix://var/run/docker.sock`
    // resolves against the process working directory, and inventing a leading
    // slash would describe a different socket.
    const socketPath = rawPath === ''
      ? (options.defaultSocketPath?.trim() || DEFAULT_DOCKER_SOCKET)
      : rawPath;
    return {
      transport: 'unix',
      address: safeText(`unix://${socketPath}`, MAX_PATH),
      host: null,
      port: null,
      socketPath: bound(socketPath, MAX_PATH),
      addressSource: 'env',
    };
  }
  if (/^npipe:\/\//i.test(value)) {
    return {
      transport: 'npipe',
      address: safeText(value, MAX_PATH),
      host: null,
      port: null,
      socketPath: null,
      addressSource: 'env',
    };
  }
  if (/^ssh:\/\//i.test(value)) {
    const host = URL.canParse(value) ? new URL(value).hostname || null : null;
    return {
      transport: 'ssh',
      address: host ? safeText(`ssh://${host}`, MAX_PATH) : null,
      host,
      port: null,
      socketPath: null,
      addressSource: 'env',
    };
  }
  const tcp = /^(tcp|http|https):\/\/(.+)$/i.exec(value);
  if (tcp) {
    const scheme = (tcp[1] ?? 'tcp').toLowerCase();
    try {
      const url = new URL(`${scheme}://${tcp[2]}`);
      const host = url.hostname || null;
      const port = url.port ? Number.parseInt(url.port, 10) : null;
      return {
        transport: 'tcp',
        address: host ? safeText(`${scheme}://${host}${port ? `:${port}` : ''}`, MAX_PATH) : null,
        host,
        port: Number.isFinite(port) ? port : null,
        socketPath: null,
        addressSource: 'env',
      };
    } catch {
      return {
        transport: 'unknown',
        address: null,
        host: null,
        port: null,
        socketPath: null,
        addressSource: 'env',
      };
    }
  }
  return {
    transport: 'unknown',
    address: null,
    host: null,
    port: null,
    socketPath: null,
    addressSource: 'env',
  };
}

interface ClassifiedRow {
  row: SocketInventoryContainerRow;
  container: SocketInventoryContainer;
  proxyEvidence: boolean;
}

function normalizeLabels(row: SocketInventoryContainerRow): {
  labels: SocketInventoryLabel[];
  truncated: boolean;
} {
  const labels: SocketInventoryLabel[] = [];
  let truncated = false;
  for (const [key, value] of Object.entries(row.labels)) {
    if (!key) continue;
    if (labels.length >= MAX_LABELS) {
      truncated = true;
      break;
    }
    const redacted = redactLabelValue(key, value, false);
    labels.push({
      key: bound(key, MAX_LABEL_KEY),
      value: safeText(redacted.value, MAX_LABEL_VALUE),
      ...(redacted.redacted ? { redacted: true } : {}),
    });
  }
  return { labels: labels.sort((a, b) => a.key.localeCompare(b.key)), truncated };
}

function normalizePorts(row: SocketInventoryContainerRow): {
  ports: SocketInventoryPort[];
  truncated: boolean;
} {
  const published = row.ports.filter(port => port.publicPort !== null);
  return {
    ports: published.slice(0, MAX_PORTS).map(port => ({
      privatePort: port.privatePort,
      publicPort: port.publicPort,
      // Docker reports both strings as untrusted metadata; bound them before
      // they reach the API so one container cannot inflate the response.
      ip: port.ip === null ? null : safeText(port.ip, 64),
      allInterfaces: bindsAllInterfaces(port.ip),
      protocol: port.protocol === null ? null : safeText(port.protocol, 32),
    })),
    truncated: published.length > MAX_PORTS,
  };
}

interface SocketMountMatch {
  mount: SocketInventoryMountRow;
  /** The source or destination names a Docker socket path. */
  namesSocket: boolean;
  /** The host source is a directory that contains a Docker socket path. */
  directory: boolean;
}

/**
 * Socket mounts on a container, before presentation truncation. A `docker.sock`
 * source or target is certain. A mount that shares the host socket path Sencho
 * itself uses is certain too, which covers a proxy that listens on a custom
 * unix socket path. A bind of a directory that contains the socket (`/var/run`,
 * `/run`, `/var`, `/`, or a visible ancestor directory of a custom socket) is possible socket access:
 * the container can open the socket through it without naming it. Classification
 * reads the full list; the response projection bounds it and marks the row
 * incomplete.
 */
function socketMountsFor(
  row: SocketInventoryContainerRow,
  endpointBindSource: string | null,
): SocketMountMatch[] {
  const socketPaths: string[] = endpointBindSource
    ? [...CANONICAL_DOCKER_SOCKET_PATHS, endpointBindSource]
    : [...CANONICAL_DOCKER_SOCKET_PATHS];
  const matches: SocketMountMatch[] = [];
  for (const mount of row.mounts) {
    // An unreadable mount type is a possible bind: read it as one when its
    // source or destination names a Docker socket rather than dropping it.
    if (mount.type !== 'bind' && mount.type !== 'unknown') continue;
    const namesSocket = isDockerSocketPath(mount.source)
      || isDockerSocketPath(mount.destination)
      || (endpointBindSource !== null
        && (mount.source === endpointBindSource || mount.destination === endpointBindSource));
    if (namesSocket) {
      matches.push({ mount, namesSocket: true, directory: false });
      continue;
    }
    // Only the host source can contain the host socket. A destination directory
    // is whatever the source supplies at that path, not proof of host access.
    if (isDockerSocketDirectoryMount(mount.source, socketPaths)) {
      matches.push({ mount, namesSocket: false, directory: true });
    }
  }
  return matches;
}

function isDockerApiPortNumber(port: number | null): boolean {
  return port === 2375 || port === 2376;
}

/** An `exposedPorts` entry such as `2375/tcp` names a Docker API port. */
function isDockerApiExposedPortSpec(spec: string): boolean {
  const slash = spec.lastIndexOf('/');
  const rawPort = slash > 0 ? spec.slice(0, slash) : spec;
  return /^\d+$/.test(rawPort) && isDockerApiPortNumber(Number(rawPort));
}

/**
 * Docker API port facts for a row's evidence. A port with a host binding is
 * published. A private Docker API port without one, or an `exposedPorts` entry
 * when the port list is missing it, is exposed only. The tokens are mutually
 * exclusive: publishing a port also exposes it, so `docker-api-port-published`
 * states the stronger, host-reachable fact and the exposed token is reserved
 * for a row with no published Docker API port at all.
 */
function dockerApiPortFacts(row: SocketInventoryContainerRow): {
  any: boolean;
  evidence: string[];
} {
  let published = false;
  let exposedOnly = false;
  for (const port of row.ports) {
    if (isDockerApiPortNumber(port.publicPort)
      || (isDockerApiPortNumber(port.privatePort) && port.publicPort !== null)) {
      published = true;
    }
    if (isDockerApiPortNumber(port.privatePort) && port.publicPort === null) {
      exposedOnly = true;
    }
  }
  exposedOnly = exposedOnly || row.exposedPorts.some(isDockerApiExposedPortSpec);
  return {
    any: published || exposedOnly,
    evidence: [
      ...(published ? ['docker-api-port-published'] : []),
      ...(!published && exposedOnly ? ['docker-api-port-exposed'] : []),
    ],
  };
}

function classifyRow(
  row: SocketInventoryContainerRow,
  ctx: {
    endpointBindSource: string | null;
    senchoContainerId: string | null;
    senchoContainerName: string | null;
    endpointProvider: {
      containerId: string;
      containerName: string;
      project: string | null;
      service: string | null;
      socketBindSource: string | null;
    } | null;
  },
): ClassifiedRow | null {
  const socketMatches = socketMountsFor(row, ctx.endpointBindSource);
  const socketMounts = socketMatches.map(match => match.mount);
  // An unknown mount type is a possible bind, so the mount is kept visible. It
  // is not proof of a direct consumer: a tmpfs or another mount kind the daemon
  // mislabeled would look identical, so a socket mount whose type could not be
  // read stays undetermined rather than asserted.
  const unreadableMountType = socketMounts.some(mount => mount.type === 'unknown');
  // Access is proven only by a mount that names the socket with a readable
  // type. A directory that contains the socket, or a socket-naming mount whose
  // type could not be read, grants possible access but not proof the container
  // uses it: with neither, the row is undetermined rather than a direct
  // consumer. A stronger signal (a provider image, a proxy name, enabled API
  // groups) can still classify it as a proxy.
  const provesSocketAccess = socketMatches.some(match =>
    match.namesSocket && match.mount.type !== 'unknown');
  const possibleSocketAccessOnly = socketMatches.length > 0 && !provesSocketAccess;
  const socketEvidence = [
    'socket-bind-mount',
    ...(possibleSocketAccessOnly && socketMatches.some(match => match.directory)
      ? ['socket-mount-directory']
      : []),
  ];
  const imageProvider = socketProxyProviderForImage(row.image);
  const nameHint = hasSocketProxyNameHint([row.name, row.service]);
  const apiGroups = [...row.apiGroups];
  const infrastructureLabel = row.labels[SENCHO_INFRASTRUCTURE_LABEL] === 'true';
  const isSencho = idMatches(row.id, ctx.senchoContainerId)
    || (ctx.senchoContainerName !== null && row.name === ctx.senchoContainerName);
  const provider = ctx.endpointProvider;
  // A resolver-proven provider identity (id, name, or Compose) is itself
  // relevance: an unknown image, name, port set, or custom socket mount must
  // never drop the provider row before attribution can flag it.
  const isEndpointProvider = provider !== null && (
    idMatches(row.id, provider.containerId)
    || row.name === provider.containerName
    || (provider.project !== null && provider.service !== null
      && row.composeProject === provider.project && row.service === provider.service)
  );
  const dockerApiPorts = dockerApiPortFacts(row);
  const dockerApiPort = dockerApiPorts.any;
  const readOnlyMount = socketMounts.length > 0 && socketMounts.every(mount => mount.readOnly);

  // An uninspectable container could be the only proxy on the node. It stays
  // in the inventory as undetermined whatever its name or image, because a
  // missing row would read as "nothing there".
  if (row.inspectFailed) {
    return buildClassified(row, {
      role: 'undetermined',
      classification: 'unknown',
      providerType: imageProvider,
      socketMounts: [],
      apiGroups,
      evidence: [
        'inspect-failed',
        ...(imageProvider ? ['known-provider-image'] : []),
        ...(nameHint ? ['socket-proxy-name-hint'] : []),
        ...dockerApiPorts.evidence,
      ],
      infrastructureLabel,
      isSencho,
    });
  }

  if (socketMounts.length > 0) {
    if (imageProvider && imageProvider !== 'generic-socket-proxy') {
      return buildClassified(row, {
        role: 'proxy',
        classification: 'detected',
        providerType: imageProvider,
        socketMounts,
        apiGroups,
        evidence: [
          ...socketEvidence,
          'known-provider-image',
          ...(readOnlyMount ? [] : ['socket-mount-writable']),
        ],
        infrastructureLabel,
        isSencho,
      });
    }
    if (imageProvider === 'generic-socket-proxy') {
      // A generic `socket-proxy` image is strong intent, but the vendor (and so
      // its flag semantics) is unknown: candidate, never a confirmed provider.
      return buildClassified(row, {
        role: 'proxy',
        classification: 'candidate',
        providerType: 'generic-socket-proxy',
        socketMounts,
        apiGroups,
        evidence: [...socketEvidence, 'known-provider-image'],
        infrastructureLabel,
        isSencho,
      });
    }
    if (nameHint && (readOnlyMount || apiGroups.length > 0)) {
      return buildClassified(row, {
        role: 'proxy',
        classification: 'candidate',
        providerType: 'generic-socket-proxy',
        socketMounts,
        apiGroups,
        evidence: [...socketEvidence, 'socket-proxy-name-hint'],
        infrastructureLabel,
        isSencho,
      });
    }
    if (apiGroups.length >= 2 && readOnlyMount) {
      return buildClassified(row, {
        role: 'proxy',
        classification: 'candidate',
        providerType: 'generic-socket-proxy',
        socketMounts,
        apiGroups,
        evidence: [...socketEvidence, 'enabled-api-groups'],
        infrastructureLabel,
        isSencho,
      });
    }
    if (dockerApiPort) {
      // The socket is mounted and a Docker API port is exposed or published,
      // but nothing proves this is a proxy. Say so instead of guessing in
      // either direction.
      return buildClassified(row, {
        role: 'undetermined',
        classification: 'unknown',
        providerType: imageProvider,
        socketMounts,
        apiGroups,
        evidence: [...socketEvidence, ...dockerApiPorts.evidence],
        infrastructureLabel,
        isSencho,
      });
    }
    return buildClassified(row, {
      role: possibleSocketAccessOnly ? 'undetermined' : 'direct-socket-consumer',
      classification: possibleSocketAccessOnly ? 'unknown' : 'detected',
      providerType: null,
      socketMounts,
      apiGroups,
      evidence: [
        ...socketEvidence,
        ...(unreadableMountType ? ['socket-mount-type-unknown'] : []),
        ...(readOnlyMount ? [] : ['socket-mount-writable']),
      ],
      infrastructureLabel,
      isSencho,
    });
  }

  // No socket bind is visible. A provider image, a proxy-like name, or a Docker
  // API port is a candidate whose topology cannot be confirmed from here.
  if (imageProvider || nameHint || dockerApiPort) {
    return buildClassified(row, {
      role: 'undetermined',
      classification: 'unknown',
      providerType: imageProvider,
      socketMounts: [],
      apiGroups,
      evidence: [
        ...(imageProvider ? ['known-provider-image'] : []),
        ...(nameHint ? ['socket-proxy-name-hint'] : []),
        ...dockerApiPorts.evidence,
        'no-socket-bind-observed',
      ],
      infrastructureLabel,
      isSencho,
    });
  }

  if (infrastructureLabel || row.metadataTruncated || isEndpointProvider) {
    return buildClassified(row, {
      role: 'undetermined',
      classification: 'unknown',
      providerType: null,
      socketMounts: [],
      apiGroups,
      evidence: [
        ...(infrastructureLabel ? ['infrastructure-label'] : []),
        ...(row.metadataTruncated ? ['metadata-truncated'] : []),
        ...(isEndpointProvider ? ['endpoint-provider-identity'] : []),
      ],
      infrastructureLabel,
      isSencho,
    });
  }

  return null;
}

function buildClassified(
  row: SocketInventoryContainerRow,
  input: {
    role: SocketRole;
    classification: SocketClassification;
    providerType: SocketProviderType | null;
    socketMounts: SocketInventoryMountRow[];
    apiGroups: string[];
    evidence: string[];
    infrastructureLabel: boolean;
    isSencho: boolean;
  },
): ClassifiedRow {
  const compose = row.composeProject || row.service || row.composeWorkingDir
    ? {
      project: row.composeProject ? safeText(row.composeProject, 128) : null,
      service: row.service ? safeText(row.service, 128) : null,
      workingDir: row.composeWorkingDir ? safeText(row.composeWorkingDir, MAX_PATH) : null,
    }
    : null;
  const evidence = [...input.evidence];
  if (row.state !== 'running') evidence.push('not-running');
  if (compose) evidence.push('compose-owned');
  if (input.infrastructureLabel) evidence.push('infrastructure-label');
  if (input.isSencho) evidence.push('is-sencho');

  // Presentation bounds are smaller than the adapter's collection bounds. Any
  // evidence dropped here must turn the row incomplete: a hidden writable mount,
  // wildcard binding, or public port cannot be presented as a complete picture.
  const labels = normalizeLabels(row);
  const publishedPorts = normalizePorts(row);
  const socketMounts: SocketInventoryMount[] = input.socketMounts
    .slice(0, MAX_MOUNTS)
    .map(mount => ({
      source: mount.source ? safeText(mount.source, MAX_PATH) : null,
      destination: mount.destination ? safeText(mount.destination, MAX_PATH) : null,
      readOnly: mount.readOnly,
    }));
  const exposedPorts = row.exposedPorts.slice(0, MAX_PORTS);
  const networks = row.networks.slice(0, MAX_NETWORKS);
  const apiGroups = [...input.apiGroups].slice(0, 16);
  const projectionTruncated = input.socketMounts.length > MAX_MOUNTS
    || labels.truncated
    || publishedPorts.truncated
    || row.exposedPorts.length > MAX_PORTS
    || row.networks.length > MAX_NETWORKS
    || input.apiGroups.length > 16;
  const metadataTruncated = row.metadataTruncated || projectionTruncated;
  // Keep the reason token even when the evidence list is at its own cap.
  if (metadataTruncated) evidence.unshift('metadata-truncated');
  const boundedEvidence = [...new Set(evidence)].slice(0, MAX_EVIDENCE);
  return {
    row,
    proxyEvidence: input.role === 'proxy',
    container: {
      id: bound(row.id, 128),
      name: safeText(row.name, 256),
      state: bound(row.state, 32),
      status: safeText(row.status, MAX_STATUS),
      image: safeText(redactImageReference(row.image), 256),
      imageId: bound(row.imageId, 128),
      role: input.role,
      classification: input.classification,
      providerType: input.providerType,
      senchoStack: row.stack ? safeText(row.stack, 128) : null,
      compose,
      health: row.health ? bound(row.health, 32) : null,
      socketMounts,
      apiGroups,
      publishedPorts: publishedPorts.ports,
      exposedPorts: exposedPorts.map(port => bound(port, 32)),
      networks: networks.map(network => ({
        name: safeText(network.name, 128),
        id: network.id ? bound(network.id, 128) : null,
      })),
      privileged: row.privileged,
      readonlyRootfs: row.readonlyRootfs,
      infrastructureLabel: input.infrastructureLabel,
      isSencho: input.isSencho,
      isSenchoEndpointProvider: false,
      labels: labels.labels,
      evidence: boundedEvidence,
      inspectFailed: row.inspectFailed,
      metadataTruncated,
    },
  };
}

function endpointEvidenceFor(description: SocketEndpointDescription): string[] {
  if (description.addressSource === 'default') return ['docker-host-unset-default-socket'];
  return [`docker-host-${description.transport}`];
}

function buildEndpoint(
  input: SocketInventoryBuildInput,
  classified: ClassifiedRow[],
): { endpoint: SocketInventoryEndpoint; providerRow: ClassifiedRow | null; providerAmbiguous: boolean } {
  const { endpoint: description, self } = input;
  const senchoSocketBind = description.socketPath && self.bindMounts
    ? self.bindMounts.find(mount => mount.destination === description.socketPath)
    : undefined;
  const socketBindSource = senchoSocketBind
    ? bound(senchoSocketBind.source, MAX_PATH)
    : null;

  const sencho = {
    state: self.state,
    // `none` means no identity probe found the container: dev mode, or a
    // container whose id none of the probes shows. It is not proof that Sencho
    // runs outside a container, so it never becomes `false`.
    inContainer: self.state === 'resolved' ? true : null,
    containerId: self.containerId,
    containerName: self.containerName,
    socketBindSource,
    reason: self.reason,
  };

  if (description.transport === 'unix') {
    if (description.socketPath === null) {
      // The client could not be asked which socket it dials. Do not substitute
      // the conventional path: that would present an unverified endpoint as
      // direct daemon access.
      return {
        providerRow: null,
        providerAmbiguous: false,
        endpoint: {
          transport: description.transport,
          address: description.address,
          addressSource: description.addressSource,
          detection: 'undetermined',
          reason: 'The active Docker client socket could not be determined, so the provider type is undetermined.',
          provider: {
            kind: 'unknown',
            providerType: null,
            containerId: null,
            containerName: null,
            compose: null,
            socketBindSource,
          },
          sencho,
          evidence: [...endpointEvidenceFor(description), 'socket-client-endpoint-unresolved'],
        },
      };
    }
    // A relative client path resolves against the process working directory, so
    // it is not the host daemon socket however familiar its tail looks.
    const relativeSocket = !description.socketPath.startsWith('/');
    const canonicalSocket = description.socketPath === '/var/run/docker.sock'
      || description.socketPath === '/run/docker.sock';
    const canonicalBindSource = socketBindSource === '/var/run/docker.sock'
      || socketBindSource === '/run/docker.sock';
    // A canonical destination on its own does not prove direct daemon access:
    // a forwarder or proxy can mount its own socket at that path. `none` self
    // identity is not proof either: it also covers a container whose identity
    // no probe could see. Direct is only claimed when the observed host bind
    // source is itself a canonical daemon socket (a true passthrough).
    const directProven = canonicalSocket && (
      (socketBindSource !== null && socketBindSource === description.socketPath)
      || canonicalBindSource
    );
    if (directProven) {
      return {
        providerRow: null,
        providerAmbiguous: false,
        endpoint: {
          transport: description.transport,
          address: description.address,
          addressSource: description.addressSource,
          detection: 'detected',
          reason: null,
          provider: {
            kind: 'direct-socket',
            providerType: 'direct-unix-socket',
            containerId: null,
            containerName: null,
            compose: null,
            socketBindSource,
          },
          sencho,
          evidence: [...endpointEvidenceFor(description), ...(socketBindSource ? ['sencho-socket-bind-source'] : [])],
        },
      };
    }
    // A non-default unix path, or a default destination backed by a different
    // or unseen host file, can be served by the host daemon, a proxy, or a
    // host-level forwarder. Container metadata cannot prove which one, and a
    // shared bind source only says both mount the same host file.
    const sourceUnobserved = canonicalSocket && socketBindSource === null;
    return {
      providerRow: null,
      providerAmbiguous: false,
      endpoint: {
        transport: description.transport,
        address: description.address,
        addressSource: description.addressSource,
        detection: 'undetermined',
        reason: relativeSocket
          ? 'The Docker client selected a relative socket path, which resolves against the process working directory rather than a host socket path, so the provider type is undetermined.'
          : sourceUnobserved
            ? 'The socket destination is the host default, but its host source is not visible from inside the container, so the provider type is undetermined.'
            : canonicalSocket
              ? 'The socket destination is the host default, but its observed host source is different. Container metadata cannot prove which process serves it, so the provider type is undetermined.'
              : description.addressSource === 'default'
                ? 'The Docker client resolved a socket path that is not a canonical host daemon socket; container metadata cannot prove which process serves it, so the provider type is undetermined.'
                : socketBindSource
                  ? 'The configured socket path is not the host default. Its host path is visible, but container metadata cannot prove which process serves it, so the provider type is undetermined.'
                  : 'The configured socket path is not the host default and its host path is not visible, so the provider type cannot be determined.',
        provider: {
          kind: 'unknown',
          providerType: null,
          containerId: null,
          containerName: null,
          compose: null,
          socketBindSource,
        },
        sencho,
        evidence: [
          ...(relativeSocket
            ? ['socket-path-relative']
            : canonicalSocket
              ? [sourceUnobserved ? 'socket-destination-default-source-unobserved' : 'socket-destination-default-source-custom']
              : [description.addressSource === 'default' ? 'socket-path-client-default' : 'socket-path-custom']),
          ...(socketBindSource ? ['sencho-socket-bind-source'] : []),
        ],
      },
    };
  }

  if (description.transport === 'tcp') {
    const resolved = input.endpointProvider;
    if (resolved.state === 'resolved') {
      const provider = resolved.provider;
      const byId = classified.find(entry => idMatches(entry.row.id, provider.containerId));
      const byName = !byId && provider.containerName
        ? classified.filter(entry => entry.row.name === provider.containerName)
        : [];
      const byCompose = !byId && !byName.length && provider.project && provider.service
        ? classified.filter(entry => entry.row.composeProject === provider.project
          && entry.row.service === provider.service)
        : [];
      // A recreate changes the container id. Only a single current container
      // with the same name, or the same Compose identity, may stand in; two is
      // ambiguous, and a wrong attribution is worse than an open one.
      const providerRow = byId
        ?? (byName.length === 1 ? byName[0] : undefined)
        ?? (byCompose.length === 1 ? byCompose[0] : undefined);
      const ambiguousRecreate = byName.length > 1 || byCompose.length > 1;
      const reason = providerRow
        ? null
        : ambiguousRecreate
          ? 'The tcp endpoint resolved to a container that is gone, and more than one current container shares its name or Compose identity, so the provider row cannot be attributed.'
          : 'The tcp endpoint resolved, but its provider container is not in this inventory. If the list was truncated it may be outside the inspection bound; a recreated provider is attributed only by name or Compose identity.';
      return {
        providerRow: providerRow ?? null,
        providerAmbiguous: providerRow === undefined && ambiguousRecreate,
        endpoint: {
          transport: description.transport,
          address: description.address,
          addressSource: description.addressSource,
          detection: 'detected',
          reason: reason ? safeText(reason, MAX_STATUS) : null,
          provider: {
            kind: 'container',
            providerType: providerRow?.container.providerType ?? 'unknown',
            containerId: providerRow?.row.id ?? provider.containerId,
            containerName: providerRow?.container.name ?? safeText(provider.containerName, 256),
            compose: {
              project: providerRow?.container.compose?.project
                ?? (provider.project ? safeText(provider.project, 128) : null),
              service: providerRow?.container.compose?.service
                ?? (provider.service ? safeText(provider.service, 128) : null),
            },
            socketBindSource: provider.socketBindSource
              ? bound(provider.socketBindSource, MAX_PATH)
              : socketBindSource,
          },
          sencho,
          evidence: ['docker-host-tcp-address-matched-container'],
        },
      };
    }
    const reason = resolved.state === 'error'
      ? resolved.reason
      : resolved.reason || 'The container carrying the tcp Docker endpoint could not be identified.';
    return {
      providerRow: null,
      providerAmbiguous: false,
      endpoint: {
        transport: description.transport,
        address: description.address,
        addressSource: description.addressSource,
        detection: 'undetermined',
        reason: safeText(reason, MAX_STATUS),
        provider: {
          kind: 'unknown',
          providerType: null,
          containerId: null,
          containerName: null,
          compose: null,
          socketBindSource,
        },
        sencho,
        evidence: ['docker-host-tcp-address-unmatched'],
      },
    };
  }

  return {
    providerRow: null,
    providerAmbiguous: false,
    endpoint: {
      transport: description.transport,
      address: description.address,
      addressSource: description.addressSource,
      detection: description.transport === 'unknown' ? 'unsupported' : 'undetermined',
      reason: description.transport === 'unknown'
        ? 'The configured Docker endpoint is not a supported transport for discovery.'
        : `Discovery does not support the ${description.transport} Docker endpoint transport.`,
      provider: {
        kind: 'unknown',
        providerType: null,
        containerId: null,
        containerName: null,
        compose: null,
        socketBindSource,
      },
      sencho,
      evidence: [`docker-host-${description.transport}`],
    },
  };
}

/** Pure assembly of the API contract from already-collected evidence. */
export function buildSocketInventory(input: SocketInventoryBuildInput): SocketInventory {
  const errors: SocketInventoryError[] = [...input.errors];
  if (input.truncated && !errors.some(error => error.stage === 'list-containers')) {
    errors.push({
      stage: 'list-containers',
      message: `Inventory truncated at ${MAX_INVENTORY_CONTAINERS} containers; some targets may be missing.`,
    });
  }
  for (const row of input.containers.filter(entry => entry.inspectFailed)) {
    if (errors.length >= MAX_ERRORS) break;
    errors.push({
      stage: 'inspect-container',
      message: 'Container inspect failed; its mounts, environment, and health are unknown.',
      ...(row.id ? { containerId: row.id } : {}),
    });
  }

  const resolvedEndpointProvider = input.endpointProvider.state === 'resolved'
    ? input.endpointProvider.provider
    : null;

  // A tcp provider's socket mount is the node's Docker socket just as much as
  // Sencho's own unix bind is. Without it, a provider that mounts a custom
  // socket path would be retained but its mount evidence would be invisible.
  let endpointBindSource: string | null = null;
  if (input.endpoint.socketPath && input.self.bindMounts) {
    endpointBindSource = input.self.bindMounts
      .find(mount => mount.destination === input.endpoint.socketPath)?.source ?? null;
  }
  if (endpointBindSource === null && resolvedEndpointProvider?.socketBindSource) {
    endpointBindSource = resolvedEndpointProvider.socketBindSource;
  }

  const classified = input.containers
    .map(row => classifyRow(row, {
      endpointBindSource,
      senchoContainerId: input.self.containerId,
      senchoContainerName: input.self.containerName,
      endpointProvider: resolvedEndpointProvider
        ? {
          containerId: resolvedEndpointProvider.containerId,
          containerName: resolvedEndpointProvider.containerName,
          project: resolvedEndpointProvider.project,
          service: resolvedEndpointProvider.service,
          socketBindSource: resolvedEndpointProvider.socketBindSource,
        }
        : null,
    }))
    .filter((entry): entry is ClassifiedRow => entry !== null);

  const { endpoint, providerRow, providerAmbiguous } = buildEndpoint(input, classified);
  if (providerRow) {
    providerRow.container.isSenchoEndpointProvider = true;
    if (!providerRow.container.evidence.includes('sencho-endpoint-provider')) {
      providerRow.container.evidence = [...providerRow.container.evidence, 'sencho-endpoint-provider']
        .slice(0, MAX_EVIDENCE);
    }
  }

  const containers = classified
    .map(entry => entry.container)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  if (containers.some(container => container.metadataTruncated)
    && !errors.some(error => error.stage === 'container-metadata')) {
    errors.push({
      stage: 'container-metadata',
      message: 'A container metadata list exceeded the inventory bound or could not be read completely; some mounts, ports, labels, networks, or proxy flags may be missing.',
    });
  }
  const providerMissing = endpoint.provider.kind === 'container'
    && endpoint.provider.containerId !== null
    && !containers.some(container => idMatches(container.id, endpoint.provider.containerId)
      || (endpoint.provider.containerName !== null && container.name === endpoint.provider.containerName));
  if (providerMissing && !errors.some(error => error.stage === 'endpoint-provider')) {
    errors.push({
      stage: 'endpoint-provider',
      message: input.truncated
        ? 'The container carrying the Docker endpoint may be outside the bounded inventory.'
        : 'No container in this inventory could be identified as the Docker endpoint provider.',
    });
  }
  const inspectFailures = input.containers.filter(row => row.inspectFailed).length;
  const endpointKnown = endpoint.detection === 'detected';
  const undetermined = containers.some(container => container.role === 'undetermined');
  const status: SocketInventory['status'] = input.truncated || errors.length > 0
    || !endpointKnown || undetermined || providerMissing || providerAmbiguous
    || input.self.state === 'unresolved'
    ? 'partial'
    : 'complete';

  const node = input.node;
  return {
    schemaVersion: 1,
    node: {
      id: input.nodeId,
      name: node?.name ?? null,
      type: node?.type ?? null,
      mode: node?.mode ?? null,
      instanceIdentity: input.instanceIdentity ? bound(input.instanceIdentity, 64) : null,
    },
    generatedAt: input.generatedAt,
    durationMs: input.durationMs,
    status,
    truncated: input.truncated,
    counts: {
      listedContainers: input.listedContainers,
      matchedContainers: containers.length,
      proxies: containers.filter(container => container.role === 'proxy').length,
      directSocketConsumers: containers.filter(container => container.role === 'direct-socket-consumer').length,
      undetermined: containers.filter(container => container.role === 'undetermined').length,
      inspectFailures,
    },
    endpoint,
    containers,
    errors: errors.slice(0, MAX_ERRORS),
  };
}

async function readSelf(
  deps: SocketInventoryDeps,
  errors: SocketInventoryError[],
): Promise<SocketSelfInfo> {
  let state: SelfIdentityState;
  let reason: string | null;
  try {
    state = await deps.self.ensureResolved();
    reason = deps.self.getUnresolvedReason();
  } catch (error) {
    const message = `Self identification failed: ${getErrorMessage(error, 'unknown error')}`;
    errors.push({ stage: 'self-identity', message: safeText(message, MAX_STATUS) });
    return { state: 'unresolved', reason: safeText(message, MAX_STATUS), containerId: null, containerName: null, bindMounts: null };
  }
  if (state !== 'resolved') {
    return {
      state,
      reason: reason ? safeText(reason, MAX_STATUS) : null,
      containerId: null,
      containerName: null,
      bindMounts: null,
    };
  }
  const identity = deps.self.getIdentity();
  let bindMounts: Array<{ source: string; destination: string }> | null = null;
  try {
    bindMounts = await deps.self.getBindMounts();
  } catch (error) {
    errors.push({
      stage: 'self-identity',
      message: safeText(`Could not read Sencho's own bind mounts: ${getErrorMessage(error, 'unknown error')}`, MAX_STATUS),
    });
  }
  return {
    state,
    reason: reason ? safeText(reason, MAX_STATUS) : null,
    containerId: identity.containerId,
    containerName: identity.containerName,
    bindMounts: bindMounts?.map(mount => ({
      source: bound(mount.source, MAX_PATH),
      destination: bound(mount.destination, MAX_PATH),
    })) ?? null,
  };
}

/** Collect one node-scoped snapshot. Throws when the container list itself cannot be read. */
export async function loadSocketInventory(
  nodeId: number,
  deps: SocketInventoryDeps = defaultDeps(nodeId),
): Promise<SocketInventory> {
  const started = deps.now();
  const errors: SocketInventoryError[] = [];
  let listing: SocketInventoryListResult;
  try {
    listing = await deps.docker.listContainersForSocketInventory(MAX_INVENTORY_CONTAINERS);
  } catch (error) {
    const message = getErrorMessage(error, 'Docker list failed');
    console.error('[SocketInventory] Container list failed on node %d: %s', nodeId, errorMessageForLog(error));
    throw new SocketInventoryUnavailableError(message);
  }
  const { rows, listedContainers, truncated } = listing;

  const self = await readSelf(deps, errors);
  // Ask the active Docker client which socket it dials: with DOCKER_HOST unset
  // dockerode lazily picks between the conventional path and Docker Desktop's
  // per-user socket, and a bare `unix://` also falls back to that choice. A null
  // answer here means the unix client could not be inspected, which is
  // uncertainty rather than a reason to assume the conventional path.
  const dockerHost = process.env.DOCKER_HOST?.trim();
  const needsClientSocket = !dockerHost || /^unix:\/\//i.test(dockerHost);
  let defaultSocketPath: string | null = null;
  let defaultSocketUnresolved = false;
  if (needsClientSocket) {
    try {
      defaultSocketPath = await deps.docker.getDockerSocketPath();
    } catch {
      defaultSocketPath = null;
    }
    defaultSocketUnresolved = defaultSocketPath === null;
  }
  const endpoint = describeDockerEndpoint(process.env.DOCKER_HOST, {
    defaultSocketPath,
    defaultSocketUnresolved,
  });

  let endpointProvider: DockerEndpointProvider | { state: 'error'; reason: string };
  if (endpoint.transport === 'tcp') {
    try {
      endpointProvider = await deps.resolveEndpointProvider();
    } catch (error) {
      const reason = `The Docker endpoint provider lookup failed: ${getErrorMessage(error, 'unknown error')}`;
      errors.push({ stage: 'endpoint-provider', message: safeText(reason, MAX_STATUS) });
      endpointProvider = { state: 'error', reason };
    }
  } else {
    endpointProvider = { state: 'none', reason: 'The Docker endpoint is not a tcp address.' };
  }

  return buildSocketInventory({
    nodeId,
    node: deps.node(nodeId),
    instanceIdentity: deps.instanceIdentity(),
    listedContainers,
    truncated,
    containers: rows,
    self,
    endpoint,
    endpointProvider,
    generatedAt: deps.now(),
    durationMs: Math.max(0, deps.now() - started),
    errors,
  });
}
