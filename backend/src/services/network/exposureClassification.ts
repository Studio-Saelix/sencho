/**
 * Read-only classification of how each service in a stack APPEARS reachable,
 * derived from the rendered Compose model, the tunnel connectors detected in it,
 * and the runtime drift facts when a Docker snapshot is available. It sits next
 * to the operator's declared exposure intent: Sencho shows the detected answer,
 * says when a declared intent contradicts the facts, and never derives "safe",
 * "internal" or "verified" from the absence of evidence.
 *
 * Every evidence path is kept, not only the strongest one, so a service reached
 * by two connectors lists both. Tunnel detection stays canonical
 * (`detectTunnels`); this module reads its connectors and adds the host-port,
 * host-network and namespace facts the port badges already show.
 *
 * Nothing here is inferred beyond what the structural facts support:
 * `temporary`, `lan` and `reverse-proxy` are never inferred, reverse-proxy
 * labels are not read, and an all-interfaces bind is described as broad, never
 * as internet reachable. A connector in another stack that shares an external
 * network is a caveat, not a path.
 */
import type { DependencyContainer } from '../DockerController';
import type { EffectiveModel, EffPortSpec, EffService } from '../preflight/effectiveModel';
import { SENCHO_MESH_NETWORK } from '../MeshComposeOverride';
import { isAllInterfaces, isHostNetwork, isLoopback } from './normalize';
import { isCertainTunnelPath, type TunnelConnector, type TunnelPath, type TunnelProvider, type TunnelScope } from './tunnelDetection';
import { EXPOSURE_INTENTS, type ExposureIntent, type NetworkDriftFacts } from './types';

/** Who could plausibly reach a service, in Sencho's words for the panel. */
export type DetectedScope = 'public-edge' | 'private-overlay' | 'host-published' | 'host-loopback';

/** A host-published port, tagged with the namespace root it belongs to when the
 *  service only shares another service's namespace. */
export interface DetectedPortFacts {
  hostIp: string;
  startPort: number;
  endPort: number;
  /** Docker assigns the host port at start, so no number is known. */
  dynamic?: true;
  protocol: string;
  /** Set when the path belongs to the namespace root, not the service itself. */
  via?: string;
}

/** One piece of evidence that a service is reachable. */
export type DetectedPath =
  | {
    kind: 'tunnel';
    scope: TunnelScope;
    provider: TunnelProvider;
    connector: string;
    path: TunnelPath;
    /** True only when the provider's peers address the service directly. */
    certain: boolean;
  }
  | { kind: 'connector'; scope: 'private-overlay'; provider: 'tailscale' | 'wireguard' }
  | ({ kind: 'host-port'; scope: 'host-published'; bind: 'all-interfaces' | 'address' } & DetectedPortFacts)
  | ({ kind: 'host-port'; scope: 'host-loopback'; bind: 'loopback' } & DetectedPortFacts)
  | { kind: 'host-network'; scope: 'host-published'; via?: string };

/** Why the detected reach could not be fully established. */
export type UndeterminedReason =
  | 'foreign-namespace'
  | 'hidden-connector'
  | 'runtime-attachment'
  | 'runtime-ports-differ';

/** What a declared intent contradicts, or nearly contradicts. */
export type ConflictReason =
  | 'host-port'
  | 'loopback-port'
  | 'host-network'
  | 'tunnel'
  | 'broad-bind'
  | 'shared-namespace';

export interface IntentConflict {
  level: 'conflict' | 'possible' | 'note';
  reason: ConflictReason;
  /** Indexes into the service's `paths` the entry covers. */
  paths: number[];
}

interface DetectedCommon {
  /** One-line synthesis; the one copy source for the panel and the findings. */
  answer: string;
  /** External networks (resolved names, Sencho Mesh excluded) the service's
   *  namespace joins; a connector of another stack on one may reach it. */
  externalNetworks: string[];
  /** True only when a snapshot was available and the service has a running container. */
  runtimeChecked: boolean;
  /** Every intent value, evaluated: an empty array means nothing was found. */
  conflicts: Record<ExposureIntent, IntentConflict[]>;
  /** The one unambiguous adoption this evidence supports, or null. */
  suggestedIntent: 'same-node' | null;
}

export type DetectedServiceExposure = DetectedCommon & (
  | { status: 'paths'; paths: [DetectedPath, ...DetectedPath[]]; incomplete: UndeterminedReason[] }
  | { status: 'none-known'; paths: [] }
  | { status: 'undetermined'; paths: []; reasons: [UndeterminedReason, ...UndeterminedReason[]] }
);

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A detected value before the derived fields are added. */
export type DetectedExposureEvidence = DistributiveOmit<DetectedServiceExposure, 'answer' | 'conflicts' | 'suggestedIntent'>;

export interface ExposureRuntimeLookup {
  containersByService: Map<string, DependencyContainer[]>;
  /** The stack service a container belongs to, or null when it cannot be mapped. */
  serviceOfContainer: (name: string) => string | null;
}

export interface ClassifyStackExposureInput {
  model: EffectiveModel;
  connectors: TunnelConnector[];
  drift: NetworkDriftFacts;
  /** null when the Docker snapshot was unavailable. */
  runtime: ExposureRuntimeLookup | null;
}

const RUNNING_STATES: ReadonlySet<string> = new Set(['running', 'restarting']);
const SERVICE_MODE = /^service:(.+)$/;
const CONTAINER_MODE = /^container:(.+)$/;

/** A port range is expanded to one mapping per port for the runtime comparison;
 *  a pathological range stops here and is reported as differing (a caveat, never
 *  a claim). */
const MAX_PORT_RANGE = 1000;

/** The order scopes are named in a synthesized answer. */
const SCOPE_ORDER: readonly DetectedScope[] = ['public-edge', 'private-overlay', 'host-published', 'host-loopback'];

const SCOPE_WORD: Record<DetectedScope, string> = {
  'public-edge': 'public edge',
  'private-overlay': 'private overlay',
  'host-published': 'host-published',
  'host-loopback': 'same host only',
};

function bindClass(hostIp: string): 'all' | 'loopback' | 'address' {
  if (isAllInterfaces(hostIp)) return 'all';
  if (isLoopback(hostIp)) return 'loopback';
  return 'address';
}

function pathIsUnverified(path: DetectedPath): boolean {
  return path.kind === 'tunnel' && !path.certain;
}

/**
 * The service whose network namespace `name` runs in (itself when it owns one).
 * Only `service:` is followed; `container:` names a container, not a service, so
 * the namespace is opaque and reported as foreign instead.
 */
function namespaceRoot(name: string, byName: Map<string, EffService>): string {
  let current = name;
  for (let hops = 0; hops < byName.size; hops += 1) {
    const target = byName.get(current)?.networkMode?.match(SERVICE_MODE)?.[1];
    if (!target || !byName.has(target)) return current;
    current = target;
  }
  return current;
}

function isForeignNamespace(service: EffService | undefined): boolean {
  return CONTAINER_MODE.test(service?.networkMode ?? '');
}

/** Host-port paths for the ports of a namespace owner. */
function hostPortPaths(owner: EffService | undefined, via: string | undefined): DetectedPath[] {
  if (!owner) return [];
  return owner.ports.map((port: EffPortSpec): DetectedPath => {
    const facts: DetectedPortFacts = {
      hostIp: port.hostIp,
      startPort: port.startPort,
      endPort: port.endPort,
      protocol: port.protocol,
      ...(port.dynamic ? { dynamic: true as const } : {}),
      ...(via ? { via } : {}),
    };
    switch (bindClass(port.hostIp)) {
      case 'all': return { kind: 'host-port', scope: 'host-published', bind: 'all-interfaces', ...facts };
      case 'loopback': return { kind: 'host-port', scope: 'host-loopback', bind: 'loopback', ...facts };
      default: return { kind: 'host-port', scope: 'host-published', bind: 'address', ...facts };
    }
  });
}

function hostNetworkPath(via: string | undefined): DetectedPath {
  return { kind: 'host-network', scope: 'host-published', ...(via ? { via } : {}) };
}

/** Port keys a rendered `ports:` list publishes, fixed numbers separately from
 *  the auto-assigned ones (which Docker numbers at start). A range too large to
 *  expand is reported as truncated: the comparison then declines to claim a
 *  difference it cannot establish. */
function declaredPortKeys(ports: readonly EffPortSpec[]): {
  fixed: Set<string>;
  dynamic: Map<string, number>;
  truncated: boolean;
} {
  const fixed = new Set<string>();
  const dynamic = new Map<string, number>();
  let truncated = false;
  for (const port of ports) {
    const cls = bindClass(port.hostIp);
    const proto = port.protocol.toLowerCase();
    if (port.dynamic) {
      const key = `${cls}/${proto}`;
      dynamic.set(key, (dynamic.get(key) ?? 0) + 1);
      continue;
    }
    if (port.endPort - port.startPort >= MAX_PORT_RANGE) {
      truncated = true;
      continue;
    }
    for (let value = port.startPort; value <= port.endPort; value += 1) fixed.add(`${cls}:${value}/${proto}`);
  }
  return { fixed, dynamic, truncated };
}

/**
 * Whether the running containers of one service publish ports the Compose file
 * does not: the file was edited and not redeployed. An auto-assigned port is
 * compared by bind class and protocol only, since Docker picked the number, and
 * per container, because a scaled service gets one assignment per replica.
 * Docker reports one mapping on both `0.0.0.0` and `::`, so a repeated key
 * inside one container is the same binding.
 */
function runningPortsDiffer(declared: readonly EffPortSpec[], running: readonly DependencyContainer[]): boolean {
  const started = running.filter(container => RUNNING_STATES.has(container.state));
  // Nothing running means nothing to compare: a stopped service is not drift.
  if (started.length === 0) return false;
  const keys = declaredPortKeys(declared);
  // A range this large is not enumerable here; say nothing rather than report a
  // difference that may not exist.
  if (keys.truncated) return false;
  const fixedSeen = new Set<string>();
  for (const container of started) {
    const seen = new Set<string>();
    const remainingDynamic = new Map(keys.dynamic);
    for (const port of container.ports) {
      const cls = bindClass(port.ip);
      const proto = port.protocol.toLowerCase();
      const key = `${cls}:${port.publishedPort}/${proto}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (keys.fixed.has(key)) {
        fixedSeen.add(key);
        continue;
      }
      const dynamicKey = `${cls}/${proto}`;
      const left = remainingDynamic.get(dynamicKey) ?? 0;
      if (left > 0) {
        remainingDynamic.set(dynamicKey, left - 1);
        continue;
      }
      return true;
    }
    // A running replica that publishes fewer auto-assigned ports than the file
    // declares is a difference too.
    if ([...remainingDynamic.values()].some(count => count > 0)) return true;
  }
  for (const key of keys.fixed) if (!fixedSeen.has(key)) return true;
  return false;
}

/** Service names whose running containers sit on a network Compose does not
 *  declare, both of which arrive already Mesh-filtered. */
function runtimeAttachmentServices(drift: NetworkDriftFacts, runtime: ExposureRuntimeLookup): Set<string> {
  const services = new Set<string>();
  for (const attachment of drift.runtimeOnlyAttachments) {
    if (attachment.service) services.add(attachment.service);
  }
  for (const attachment of drift.foreignNetworkAttachments) {
    const service = runtime.serviceOfContainer(attachment.container);
    if (service) services.add(service);
  }
  return services;
}

function groupConflicts(entries: Array<{ level: IntentConflict['level']; reason: ConflictReason; index: number }>): IntentConflict[] {
  const rank: Record<IntentConflict['level'], number> = { conflict: 0, possible: 1, note: 2 };
  const grouped = new Map<string, IntentConflict>();
  for (const entry of entries) {
    const key = `${entry.level}:${entry.reason}`;
    const existing = grouped.get(key);
    if (existing) existing.paths.push(entry.index);
    else grouped.set(key, { level: entry.level, reason: entry.reason, paths: [entry.index] });
  }
  return [...grouped.values()].sort((a, b) => rank[a.level] - rank[b.level]);
}

/**
 * What a declared intent contradicts, at the certainty the existing engines use.
 * `via` and `connector` paths are notes, never conflicts, because no existing
 * engine counts them, and `lan`, `public` and `unknown` declare no contradiction.
 */
export function intentConflicts(intent: ExposureIntent, paths: readonly DetectedPath[]): IntentConflict[] {
  const entries: Array<{ level: IntentConflict['level']; reason: ConflictReason; index: number }> = [];
  const push = (level: IntentConflict['level'], reason: ConflictReason, index: number) => entries.push({ level, reason, index });

  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index];
    if (intent === 'internal' || intent === 'same-node') {
      const via = path.kind === 'host-port' || path.kind === 'host-network' ? path.via : undefined;
      if (path.kind === 'host-port') {
        if (via !== undefined) push('note', 'shared-namespace', index);
        else if (path.scope === 'host-published') push('conflict', 'host-port', index);
        else if (intent === 'internal') push('conflict', 'loopback-port', index);
        continue;
      }
      if (path.kind === 'host-network') {
        // A shared namespace's host network says nothing about this service's
        // own reach, so it stays a note like any other `via` path.
        if (via !== undefined) push('note', 'host-network', index);
        else push('conflict', 'host-network', index);
        continue;
      }
      if (path.kind === 'tunnel') {
        if (path.certain) push('conflict', 'tunnel', index);
        else push('possible', 'tunnel', index);
        continue;
      }
      // The service is itself a private-overlay node: its own peers reach it,
      // which no existing engine counts against the intent.
      if (path.kind === 'connector') push('note', 'tunnel', index);
    }
    if (intent === 'temporary' || intent === 'reverse-proxy') {
      if (path.kind === 'host-port' && path.bind === 'all-interfaces') push('note', 'broad-bind', index);
      else if (path.kind === 'host-network') push('note', 'host-network', index);
    }
  }

  return groupConflicts(entries);
}

function allConflicts(paths: readonly DetectedPath[]): Record<ExposureIntent, IntentConflict[]> {
  const record = Object.create(null) as Record<ExposureIntent, IntentConflict[]>;
  for (const intent of EXPOSURE_INTENTS) record[intent] = intentConflicts(intent, paths);
  return record;
}

/** Whether every path is an own loopback-only host port, so `same-node` is the
 *  one intent the evidence supports without a judgement call. */
function suggestedIntentFor(
  paths: readonly DetectedPath[],
  incomplete: readonly UndeterminedReason[],
  externalNetworks: readonly string[],
  runtimeChecked: boolean,
  conflicts: Record<ExposureIntent, IntentConflict[]>,
): 'same-node' | null {
  if (paths.length === 0) return null;
  if (incomplete.length > 0 || externalNetworks.length > 0 || !runtimeChecked) return null;
  const onlyOwnLoopback = paths.every(path => path.kind === 'host-port' && path.scope === 'host-loopback' && path.via === undefined);
  if (!onlyOwnLoopback) return null;
  return conflicts['same-node'].length === 0 ? 'same-node' : null;
}

/** The answer line: the detected scopes in words, an unverified marker where one
 *  applies, and a suffix when the reach is only partly determined. */
export function describeDetectedExposure(d: DetectedExposureEvidence): string {
  if (d.status === 'none-known') return 'no known exposure path';
  if (d.status === 'undetermined') return 'could not be determined';
  const parts: string[] = [];
  for (const scope of SCOPE_ORDER) {
    const inScope = d.paths.filter(path => path.scope === scope);
    if (inScope.length === 0) continue;
    const unverified = inScope.filter(pathIsUnverified).length;
    const marker = unverified === 0 ? '' : unverified === inScope.length ? ' (unverified)' : ' (partly unverified)';
    parts.push(`${SCOPE_WORD[scope]}${marker}`);
  }
  const answer = parts.join(' + ');
  return d.incomplete.length > 0 ? `${answer} · partly undetermined` : answer;
}

/**
 * The single constructor: it derives the status from the evidence it is given,
 * so a `paths` status always has a path and `undetermined` always has a reason.
 */
function constructDetected(
  paths: DetectedPath[],
  reasons: UndeterminedReason[],
  externalNetworks: string[],
  runtimeChecked: boolean,
): DetectedServiceExposure {
  const conflicts = allConflicts(paths);
  const common = { externalNetworks, runtimeChecked };
  const evidence: DetectedExposureEvidence = paths.length > 0
    ? { ...common, status: 'paths', paths: paths as [DetectedPath, ...DetectedPath[]], incomplete: reasons }
    : reasons.length > 0
      ? { ...common, status: 'undetermined', paths: [], reasons: reasons as [UndeterminedReason, ...UndeterminedReason[]] }
      : { ...common, status: 'none-known', paths: [] };
  const suggestedIntent = suggestedIntentFor(paths, reasons, externalNetworks, runtimeChecked, conflicts);
  return {
    ...evidence,
    conflicts,
    suggestedIntent,
    answer: describeDetectedExposure(evidence),
  };
}

/** External networks a service joins, seen through its namespace root. */
function externalNetworksOf(root: EffService | undefined, model: EffectiveModel): string[] {
  if (!root) return [];
  const names: string[] = [];
  for (const membership of root.networks) {
    const resource = model.networks[membership.key];
    if (!resource?.external) continue;
    if (resource.name === SENCHO_MESH_NETWORK) continue;
    names.push(resource.name);
  }
  return names;
}

/**
 * Classify every service in the stack. A service that is itself a tunnel
 * connector keeps its own overlay path, the tunnels that reach it, and any host
 * ports it publishes.
 */
export function classifyStackExposure(input: ClassifyStackExposureInput): Map<string, DetectedServiceExposure> {
  const { model, connectors, drift, runtime } = input;
  const byName = new Map(model.services.map(service => [service.name, service]));

  const tunnelPaths = new Map<string, DetectedPath[]>();
  for (const connector of connectors) {
    for (const reach of connector.reaches) {
      const path: DetectedPath = {
        kind: 'tunnel',
        scope: connector.scope,
        provider: connector.provider,
        connector: connector.service,
        path: reach.path,
        certain: isCertainTunnelPath({ provider: connector.provider, path: reach.path }),
      };
      const existing = tunnelPaths.get(reach.service);
      if (existing) existing.push(path);
      else tunnelPaths.set(reach.service, [path]);
    }
  }

  const overlayConnectors = new Map<string, 'tailscale' | 'wireguard'>();
  for (const connector of connectors) {
    if (connector.provider !== 'cloudflared') overlayConnectors.set(connector.service, connector.provider);
  }
  // A connector whose own reach lives in another container's namespace makes
  // every service without a path unknown rather than "no known exposure path".
  // Its namespace is resolved through any `service:` chain first, so a connector
  // that shares a service which itself joins a `container:` namespace counts.
  const hiddenConnector = connectors.some(connector =>
    isForeignNamespace(byName.get(namespaceRoot(connector.service, byName))));
  const attachedAtRuntime = runtime ? runtimeAttachmentServices(drift, runtime) : new Set<string>();

  const out = new Map<string, DetectedServiceExposure>();
  for (const service of model.services) {
    const root = namespaceRoot(service.name, byName);
    const owner = byName.get(root);
    const via = root === service.name ? undefined : root;
    const paths: DetectedPath[] = [];

    const ownOverlay = overlayConnectors.get(service.name);
    if (ownOverlay) paths.push({ kind: 'connector', scope: 'private-overlay', provider: ownOverlay });
    paths.push(...(tunnelPaths.get(service.name) ?? []));

    if (!isForeignNamespace(owner)) {
      if (isHostNetwork(owner?.networkMode)) paths.push(hostNetworkPath(via));
      else paths.push(...hostPortPaths(owner, via));
    }

    const reasons: UndeterminedReason[] = [];
    if (isForeignNamespace(owner)) reasons.push('foreign-namespace');
    if (attachedAtRuntime.has(service.name)) reasons.push('runtime-attachment');
    // Only the publisher's own container is compared: a shared namespace's
    // ports belong to its root, which is compared against its own container, and
    // host networking discards every published binding.
    const comparesPorts = via === undefined && !isForeignNamespace(service) && !isHostNetwork(owner?.networkMode);
    if (runtime && comparesPorts) {
      const containers = runtime.containersByService.get(service.name) ?? [];
      if (runningPortsDiffer(service.ports, containers)) reasons.push('runtime-ports-differ');
    }
    if (hiddenConnector && paths.length === 0) reasons.push('hidden-connector');

    const containers = runtime?.containersByService.get(service.name) ?? [];
    const runtimeChecked = runtime !== null && containers.some(container => RUNNING_STATES.has(container.state));

    out.set(service.name, constructDetected(paths, reasons, externalNetworksOf(owner, model), runtimeChecked));
  }
  return out;
}
