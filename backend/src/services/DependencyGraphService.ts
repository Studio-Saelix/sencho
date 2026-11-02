import DockerController from './DockerController';
import type {
  DependencySnapshot,
  DependencyContainer,
  DependencyNetwork,
  DependencyVolume,
} from './DockerController';
import { FileSystemService } from './FileSystemService';
import { parseComposeDependencies } from '../helpers/composeDependencyParse';
import { fixedPorts } from '../helpers/composePortSpec';
import type { DeclaredCompose } from '../helpers/composeDependencyParse';

export type DepNodeKind = 'host' | 'stack' | 'service' | 'network' | 'volume' | 'port';
export type DepFlagKind = 'missing-dependency' | 'port-conflict' | 'orphan' | 'cross-stack-shared';
export type DepEdgeKind =
  | 'stack-node'
  | 'stack-service'
  | 'depends-on'
  | 'service-network'
  | 'service-volume'
  | 'service-port';

export interface DepNode {
  id: string;
  kind: DepNodeKind;
  label: string;
  nodeId: number;
  nodeName: string;
  /** Owning stack, or null for the host and shared resources. */
  stack: string | null;
  managedStatus?: 'managed' | 'unmanaged' | 'system';
  /** Container/service state when applicable (e.g. running, exited, absent). */
  state?: string;
  flags: DepFlagKind[];
}

export interface DepEdge {
  id: string;
  source: string;
  target: string;
  kind: DepEdgeKind;
  /** Declared in compose but not observed at runtime. */
  declaredOnly?: boolean;
}

export interface DepFlag {
  kind: DepFlagKind;
  nodeId: number;
  nodeName: string;
  /** Graph-node ids the flag applies to. */
  subjects: string[];
  detail: string;
}

export interface LocalDependencyGraph {
  nodeId: number;
  nodeName: string;
  nodes: DepNode[];
  edges: DepEdge[];
  flags: DepFlag[];
  parseErrors: { stack: string; error: string }[];
}

export type FleetNodeGraphResult =
  | { nodeId: number; nodeName: string; status: 'ok'; graph: LocalDependencyGraph; error: null }
  | { nodeId: number; nodeName: string; status: 'error'; graph: null; error: string };

export interface FleetDependencyMap {
  nodes: DepNode[];
  edges: DepEdge[];
  flags: DepFlag[];
  nodeErrors: { nodeId: number; nodeName: string; error: string }[];
  parseErrors: { nodeId: number; nodeName: string; stack: string; error: string }[];
}

// --- ID helpers (local, pre-merge namespace) ---------------------------------

const hostId = (): string => 'host';
const stackId = (stack: string): string => `stack:${stack}`;
const serviceId = (stack: string, service: string): string => `svc:${stack}:${service}`;
const networkId = (name: string): string => `net:${name}`;
const volumeId = (name: string): string => `vol:${name}`;
/** Normalizes an all-interfaces host IP to '*' so equivalent binds collapse. */
const portScope = (ip: string): string => (ip === '' || ip === '0.0.0.0' || ip === '::' ? '*' : ip);
const portId = (ip: string, port: number, proto: string): string => `port:${portScope(ip)}:${port}/${proto}`;

/** Container states that count as "up" for depends_on satisfaction. */
const RUNNING_STATES = new Set(['running', 'restarting']);

// --- Pure flag detectors (unit-tested directly) ------------------------------

export interface PortClaim {
  stack: string;
  service: string;
  hostIp: string;
  publishedPort: number;
  protocol: string;
}

export interface PortConflict {
  port: number;
  protocol: string;
  /** Normalized host scopes that actually clash ('*' or a specific IP). */
  scopes: string[];
  claimants: { stack: string; service: string }[];
}

/**
 * Groups port claims by published port + protocol, then does pairwise
 * scope-overlap detection within each group. Two binds overlap when they share
 * a specific host IP or at least one binds all interfaces ('*'). Only the
 * claimants and scopes that genuinely clash are returned, so a same-stack
 * two-service collision is caught while tcp-vs-udp, distinct specific-IP binds,
 * and the two bindings of one service's single publish (IPv4 + IPv6) are not
 * over-flagged.
 */
export function detectPortConflicts(claims: PortClaim[]): PortConflict[] {
  const groups = new Map<string, PortClaim[]>();
  for (const claim of claims) {
    const key = `${claim.publishedPort}/${claim.protocol}`;
    const list = groups.get(key) ?? [];
    list.push(claim);
    groups.set(key, list);
  }

  const claimantKey = (c: PortClaim): string => JSON.stringify([c.stack, c.service]);
  const overlaps = (a: PortClaim, b: PortClaim): boolean => {
    const sa = portScope(a.hostIp);
    const sb = portScope(b.hostIp);
    return sa === sb || sa === '*' || sb === '*';
  };

  const conflicts: PortConflict[] = [];
  for (const list of groups.values()) {
    const conflicting = new Set<number>();
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (claimantKey(list[i]) === claimantKey(list[j])) continue;
        if (overlaps(list[i], list[j])) { conflicting.add(i); conflicting.add(j); }
      }
    }
    if (conflicting.size === 0) continue;

    const clashing = [...conflicting].map((i) => list[i]);
    const claimants = [...new Map(clashing.map((c) => [claimantKey(c), { stack: c.stack, service: c.service }])).values()];
    const scopes = [...new Set(clashing.map((c) => portScope(c.hostIp)))];
    conflicts.push({ port: clashing[0].publishedPort, protocol: clashing[0].protocol, scopes, claimants });
  }
  return conflicts;
}

/**
 * A declared network/volume key is present when a matching runtime resource
 * exists. External resources are operator-managed and not project-prefixed, so
 * their resolved name (a `name:` override or the key) must exist somewhere on
 * the host. Stack-owned resources match by exact `name:` or the `<project>_<key>`
 * suffix, which tolerates a top-level `name:` project override without false
 * positives.
 */
function declaredPresent(
  key: string,
  resource: { name?: string; external: boolean } | undefined,
  stackResourceNames: string[],
  allResourceNames: Set<string>,
): boolean {
  const explicit = resource?.name;
  if (resource?.external) return allResourceNames.has(explicit ?? key);
  if (explicit) return stackResourceNames.includes(explicit) || allResourceNames.has(explicit);
  return stackResourceNames.some((n) => n === key || n.endsWith(`_${key}`));
}

export interface MissingDepInput {
  stack: string;
  declared: DeclaredCompose;
  /** Service names with a running (or restarting) container in this stack. */
  runningServices: Set<string>;
  /** Whether this stack has any container at all (deployed). */
  hasContainers: boolean;
  /** Runtime network names owned by this stack. */
  stackNetworkNames: string[];
  /** Runtime volume names owned by this stack. */
  stackVolumeNames: string[];
  /** All runtime network names on the node. */
  allNetworkNames: Set<string>;
  /** All runtime volume names on the node. */
  allVolumeNames: Set<string>;
}

/**
 * Flags compose-declared dependencies that are not present at runtime: a
 * running service whose depends_on target is not running, or a declared
 * (non-external) network/volume that does not exist. Only evaluated for deployed
 * stacks (hasContainers), so a never-deployed stack flags nothing. The depends_on
 * check is additionally gated on the depending service itself running, so a
 * deliberately stopped stack does not flag its own internal service dependencies;
 * network/volume presence is still checked for any deployed stack.
 */
export function detectMissingDependencies(
  input: MissingDepInput,
): { kind: 'service' | 'network' | 'volume'; service: string; target: string; detail: string }[] {
  const out: { kind: 'service' | 'network' | 'volume'; service: string; target: string; detail: string }[] = [];
  if (!input.hasContainers) return out;

  for (const svc of input.declared.services) {
    if (input.runningServices.has(svc.name)) {
      for (const dep of svc.dependsOn) {
        if (!input.runningServices.has(dep)) {
          out.push({ kind: 'service', service: svc.name, target: dep, detail: `Service "${svc.name}" depends on "${dep}", which is not running.` });
        }
      }
    }
    for (const net of svc.networks) {
      if (!declaredPresent(net, input.declared.networks[net], input.stackNetworkNames, input.allNetworkNames)) {
        out.push({ kind: 'network', service: svc.name, target: net, detail: `Service "${svc.name}" references network "${net}", which does not exist.` });
      }
    }
    for (const vol of svc.volumes) {
      if (!declaredPresent(vol, input.declared.volumes[vol], input.stackVolumeNames, input.allVolumeNames)) {
        out.push({ kind: 'volume', service: svc.name, target: vol, detail: `Service "${svc.name}" references volume "${vol}", which does not exist.` });
      }
    }
  }
  return out;
}

// --- Local graph builder -----------------------------------------------------

/**
 * Builds the dependency graph for a single node from one Docker snapshot plus
 * the declared compose metadata of each stack. Edges and resource nodes come
 * from runtime (what is actually deployed); declared data drives the
 * missing-dependency and port-conflict flags. Per-stack compose parsing fails
 * soft: a malformed file is recorded in parseErrors and never aborts the graph.
 * Note: getStacks() itself fails soft (returns []), so a node whose compose
 * directory is unreadable or misconfigured shows no managed stacks rather than
 * an error; only Docker failures here surface as a node-level error.
 */
export async function buildLocalGraph(nodeId: number, nodeName: string): Promise<LocalDependencyGraph> {
  const docker = DockerController.getInstance(nodeId);
  const fs = FileSystemService.getInstance(nodeId);

  const stacks = await fs.getStacks();
  const snapshot = await docker.getDependencySnapshot(stacks);

  const declaredByStack = new Map<string, DeclaredCompose>();
  const parseErrors: { stack: string; error: string }[] = [];
  for (const stack of stacks) {
    try {
      const content = await fs.getStackContent(stack);
      const declared = parseComposeDependencies(content);
      if (declared.parseError) parseErrors.push({ stack, error: declared.parseError });
      declaredByStack.set(stack, declared);
    } catch (error) {
      parseErrors.push({ stack, error: (error as Error)?.message ?? 'Failed to read compose file' });
      declaredByStack.set(stack, { services: [], networks: {}, volumes: {} });
    }
  }

  return assembleGraph({ nodeId, nodeName, stacks, snapshot, declaredByStack, parseErrors });
}

interface AssembleInput {
  nodeId: number;
  nodeName: string;
  stacks: string[];
  snapshot: DependencySnapshot;
  declaredByStack: Map<string, DeclaredCompose>;
  parseErrors: { stack: string; error: string }[];
}

/** Pure assembly step (no Docker / FS access) so it is directly unit-testable. */
export function assembleGraph(input: AssembleInput): LocalDependencyGraph {
  const { nodeId, nodeName, stacks, snapshot } = input;
  const knownStacks = new Set(stacks);

  const nodes: DepNode[] = [];
  const edges: DepEdge[] = [];
  const flags: DepFlag[] = [];
  const nodeById = new Map<string, DepNode>();

  const addNode = (n: DepNode): DepNode => {
    const existing = nodeById.get(n.id);
    if (existing) return existing;
    nodeById.set(n.id, n);
    nodes.push(n);
    return n;
  };
  const addEdge = (e: DepEdge): void => {
    if (!edges.some((x) => x.id === e.id)) edges.push(e);
  };
  const addFlagToNode = (id: string, kind: DepFlagKind): void => {
    const n = nodeById.get(id);
    if (n && !n.flags.includes(kind)) n.flags.push(kind);
  };

  // Host root.
  addNode({ id: hostId(), kind: 'host', label: nodeName, nodeId, nodeName, stack: null, flags: [] });

  // Index snapshot.
  const networksById = new Map<string, DependencyNetwork>();
  const networksByName = new Map<string, DependencyNetwork>();
  for (const net of snapshot.networks) {
    networksById.set(net.id, net);
    networksByName.set(net.name, net);
  }
  const volumesByName = new Map<string, DependencyVolume>();
  for (const vol of snapshot.volumes) volumesByName.set(vol.name, vol);

  const knownContainers = snapshot.containers.filter((c) => c.stack && knownStacks.has(c.stack));
  const orphanContainers = snapshot.containers.filter((c) => c.composeProject && !c.stack);

  // Runtime reference maps for cross-stack and orphan detection.
  const networkStacks = new Map<string, Set<string>>();
  const volumeStacks = new Map<string, Set<string>>();
  const referencedNetworkIds = new Set<string>();
  const referencedNetworkNames = new Set<string>();
  const referencedVolumeNames = new Set<string>();
  const runtimeServicesByStack = new Map<string, Set<string>>();
  const runningServicesByStack = new Map<string, Set<string>>();
  const portClaims: PortClaim[] = [];

  const trackRef = (map: Map<string, Set<string>>, key: string, stack: string): void => {
    const set = map.get(key) ?? new Set<string>();
    set.add(stack);
    map.set(key, set);
  };

  for (const c of snapshot.containers) {
    for (const n of c.networks) {
      referencedNetworkIds.add(n.id);
      referencedNetworkNames.add(n.name);
    }
    for (const v of c.volumes) referencedVolumeNames.add(v);
  }

  // Stack and service nodes (union of runtime + declared services).
  for (const stack of stacks) {
    const declared = input.declaredByStack.get(stack) ?? { services: [], networks: {}, volumes: {} };
    const containers = knownContainers.filter((c) => c.stack === stack);
    const runtimeServices = new Set<string>();
    const runningServices = new Set<string>();
    runtimeServicesByStack.set(stack, runtimeServices);
    runningServicesByStack.set(stack, runningServices);

    const hasContainers = containers.length > 0;
    addNode({ id: stackId(stack), kind: 'stack', label: stack, nodeId, nodeName, stack, managedStatus: 'managed', state: hasContainers ? 'deployed' : 'not deployed', flags: [] });
    addEdge({ id: `e:host-${stackId(stack)}`, source: hostId(), target: stackId(stack), kind: 'stack-node' });

    // Service nodes from runtime containers.
    for (const c of containers) {
      const svcName = c.service ?? c.name;
      runtimeServices.add(svcName);
      if (RUNNING_STATES.has(c.state)) runningServices.add(svcName);
      const sid = serviceId(stack, svcName);
      addNode({ id: sid, kind: 'service', label: svcName, nodeId, nodeName, stack, managedStatus: 'managed', state: c.state, flags: [] });
      addEdge({ id: `e:${stackId(stack)}-${sid}`, source: stackId(stack), target: sid, kind: 'stack-service' });

      buildResourceEdges(c, stack, sid, { addNode, addEdge, networksById, networksByName, volumesByName, nodeId, nodeName, networkStacks, volumeStacks, trackRef, portClaims });
    }

    // Declared-only service nodes (in compose, no running container).
    for (const svc of declared.services) {
      if (runtimeServices.has(svc.name)) continue;
      const sid = serviceId(stack, svc.name);
      addNode({ id: sid, kind: 'service', label: svc.name, nodeId, nodeName, stack, managedStatus: 'managed', state: 'absent', flags: [] });
      addEdge({ id: `e:${stackId(stack)}-${sid}`, source: stackId(stack), target: sid, kind: 'stack-service' });
      // Declared ports with a known number still count as conflict claimants.
      for (const p of fixedPorts(svc.ports)) portClaims.push({ stack, service: svc.name, hostIp: p.hostIp, publishedPort: p.publishedPort, protocol: p.protocol });
    }

    // depends-on edges (declared).
    for (const svc of declared.services) {
      for (const dep of svc.dependsOn) {
        const from = serviceId(stack, svc.name);
        const to = serviceId(stack, dep);
        if (nodeById.has(from) && nodeById.has(to)) {
          addEdge({ id: `e:dep:${from}->${to}`, source: from, target: to, kind: 'depends-on', declaredOnly: true });
        }
      }
    }
  }

  // --- Flags ---

  // Missing dependencies.
  const allNetworkNames = new Set(snapshot.networks.map((n) => n.name));
  const allVolumeNames = new Set(snapshot.volumes.map((v) => v.name));
  for (const stack of stacks) {
    const declared = input.declaredByStack.get(stack) ?? { services: [], networks: {}, volumes: {} };
    const missing = detectMissingDependencies({
      stack,
      declared,
      runningServices: runningServicesByStack.get(stack) ?? new Set(),
      hasContainers: (runtimeServicesByStack.get(stack)?.size ?? 0) > 0,
      stackNetworkNames: snapshot.networks.filter((n) => n.stack === stack).map((n) => n.name),
      stackVolumeNames: snapshot.volumes.filter((v) => v.stack === stack).map((v) => v.name),
      allNetworkNames,
      allVolumeNames,
    });
    for (const m of missing) {
      const subject = serviceId(stack, m.service);
      addFlagToNode(subject, 'missing-dependency');
      flags.push({ kind: 'missing-dependency', nodeId, nodeName, subjects: [subject], detail: m.detail });
    }
  }

  // Port conflicts. Flag only the port node(s) whose scope actually clashes,
  // by rebuilding the exact scope-prefixed port id from the conflict scopes.
  for (const conflict of detectPortConflicts(portClaims)) {
    const portNodeIds = conflict.scopes
      .map((scope) => `port:${scope}:${conflict.port}/${conflict.protocol}`)
      .filter((id) => nodeById.has(id));
    const serviceSubjects = conflict.claimants.map((c) => serviceId(c.stack, c.service)).filter((id) => nodeById.has(id));
    const stacksInvolved = [...new Set(conflict.claimants.map((c) => c.stack))];
    for (const id of portNodeIds) addFlagToNode(id, 'port-conflict');
    for (const s of serviceSubjects) addFlagToNode(s, 'port-conflict');
    flags.push({ kind: 'port-conflict', nodeId, nodeName, subjects: [...portNodeIds, ...serviceSubjects], detail: `Port ${conflict.port}/${conflict.protocol} is claimed by ${stacksInvolved.join(', ')}.` });
  }

  // Cross-stack shared networks/volumes.
  for (const [name, stackSet] of networkStacks) {
    if (stackSet.size >= 2) {
      addFlagToNode(networkId(name), 'cross-stack-shared');
      flags.push({ kind: 'cross-stack-shared', nodeId, nodeName, subjects: [networkId(name)], detail: `Network "${name}" is shared by ${[...stackSet].join(', ')}.` });
    }
  }
  for (const [name, stackSet] of volumeStacks) {
    if (stackSet.size >= 2) {
      addFlagToNode(volumeId(name), 'cross-stack-shared');
      flags.push({ kind: 'cross-stack-shared', nodeId, nodeName, subjects: [volumeId(name)], detail: `Volume "${name}" is shared by ${[...stackSet].join(', ')}.` });
    }
  }

  // Orphaned networks/volumes (unmanaged, unreferenced, non-system).
  for (const net of snapshot.networks) {
    if (net.isSystem || net.stack) continue;
    if (referencedNetworkIds.has(net.id) || referencedNetworkNames.has(net.name)) continue;
    const id = networkId(net.name);
    addNode({ id, kind: 'network', label: net.name, nodeId, nodeName, stack: null, managedStatus: 'unmanaged', flags: ['orphan'] });
    flags.push({ kind: 'orphan', nodeId, nodeName, subjects: [id], detail: `Network "${net.name}" is not used by any container.` });
  }
  for (const vol of snapshot.volumes) {
    if (vol.stack) continue;
    if (referencedVolumeNames.has(vol.name)) continue;
    const id = volumeId(vol.name);
    addNode({ id, kind: 'volume', label: vol.name, nodeId, nodeName, stack: null, managedStatus: 'unmanaged', flags: ['orphan'] });
    flags.push({ kind: 'orphan', nodeId, nodeName, subjects: [id], detail: `Volume "${vol.name}" is not used by any container.` });
  }

  // Orphan containers (compose project not owned by any known stack).
  const orphanByProject = new Map<string, DependencyContainer[]>();
  for (const c of orphanContainers) {
    const project = c.composeProject as string;
    const list = orphanByProject.get(project) ?? [];
    list.push(c);
    orphanByProject.set(project, list);
  }
  for (const [project, containers] of orphanByProject) {
    const sId = `stack:__orphan__:${project}`;
    addNode({ id: sId, kind: 'stack', label: `${project} (unmanaged)`, nodeId, nodeName, stack: null, managedStatus: 'unmanaged', flags: ['orphan'] });
    addEdge({ id: `e:host-${sId}`, source: hostId(), target: sId, kind: 'stack-node' });
    flags.push({ kind: 'orphan', nodeId, nodeName, subjects: [sId], detail: `Stack "${project}" is running but not managed by Sencho.` });
    for (const c of containers) {
      const svcName = c.service ?? c.name;
      const svcNodeId = `svc:__orphan__:${project}:${svcName}`;
      addNode({ id: svcNodeId, kind: 'service', label: svcName, nodeId, nodeName, stack: null, managedStatus: 'unmanaged', state: c.state, flags: ['orphan'] });
      addEdge({ id: `e:${sId}-${svcNodeId}`, source: sId, target: svcNodeId, kind: 'stack-service' });
    }
  }

  return { nodeId, nodeName, nodes, edges, flags, parseErrors: input.parseErrors };
}

interface ResourceEdgeCtx {
  addNode: (n: DepNode) => DepNode;
  addEdge: (e: DepEdge) => void;
  networksById: Map<string, DependencyNetwork>;
  networksByName: Map<string, DependencyNetwork>;
  volumesByName: Map<string, DependencyVolume>;
  nodeId: number;
  nodeName: string;
  networkStacks: Map<string, Set<string>>;
  volumeStacks: Map<string, Set<string>>;
  trackRef: (map: Map<string, Set<string>>, key: string, stack: string) => void;
  portClaims: PortClaim[];
}

/** Emits a running container's network / volume / port nodes and edges. */
function buildResourceEdges(c: DependencyContainer, stack: string, sid: string, ctx: ResourceEdgeCtx): void {
  for (const n of c.networks) {
    const meta = ctx.networksById.get(n.id) ?? ctx.networksByName.get(n.name);
    if (meta?.isSystem) continue; // skip bridge/host/none noise
    const id = networkId(n.name);
    ctx.addNode({ id, kind: 'network', label: n.name, nodeId: ctx.nodeId, nodeName: ctx.nodeName, stack: meta?.stack ?? null, managedStatus: meta?.stack ? 'managed' : 'unmanaged', flags: [] });
    ctx.addEdge({ id: `e:${sid}-${id}`, source: sid, target: id, kind: 'service-network' });
    ctx.trackRef(ctx.networkStacks, n.name, stack);
  }
  for (const volName of c.volumes) {
    const meta = ctx.volumesByName.get(volName);
    const id = volumeId(volName);
    ctx.addNode({ id, kind: 'volume', label: volName, nodeId: ctx.nodeId, nodeName: ctx.nodeName, stack: meta?.stack ?? null, managedStatus: meta?.stack ? 'managed' : 'unmanaged', flags: [] });
    ctx.addEdge({ id: `e:${sid}-${id}`, source: sid, target: id, kind: 'service-volume' });
    ctx.trackRef(ctx.volumeStacks, volName, stack);
  }
  const svcName = c.service ?? c.name;
  for (const p of c.ports) {
    const id = portId(p.ip, p.publishedPort, p.protocol);
    ctx.addNode({ id, kind: 'port', label: `${portScope(p.ip)}:${p.publishedPort}/${p.protocol}`, nodeId: ctx.nodeId, nodeName: ctx.nodeName, stack, flags: [] });
    ctx.addEdge({ id: `e:${sid}-${id}`, source: sid, target: id, kind: 'service-port' });
    ctx.portClaims.push({ stack, service: svcName, hostIp: p.ip, publishedPort: p.publishedPort, protocol: p.protocol });
  }
}

// --- Fleet merge -------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';

/**
 * Validates a parsed remote node-graph payload deeply enough that mergeFleetGraph
 * cannot throw on it: nodes/edges/flags are arrays of the right shallow shape
 * (each flag carries a subjects array, each node a flags array), and parseErrors
 * is an array when present. A reachable-but-malformed remote thus degrades to a
 * single node error instead of crashing the whole fleet map.
 */
export function isLocalDependencyGraph(g: unknown): g is LocalDependencyGraph {
  if (!isObject(g)) return false;
  if (!Array.isArray(g.nodes) || !Array.isArray(g.edges) || !Array.isArray(g.flags)) return false;
  if (g.parseErrors !== undefined && !Array.isArray(g.parseErrors)) return false;
  if (!g.nodes.every((n) => isObject(n) && typeof n.id === 'string' && Array.isArray(n.flags))) return false;
  if (!g.edges.every((e) => isObject(e) && typeof e.id === 'string' && typeof e.source === 'string' && typeof e.target === 'string')) return false;
  // subjects elements must be strings (merge concatenates them) and parseErrors
  // elements must be {stack,error} objects (merge dereferences them), or a
  // payload could pass the array check yet still throw / corrupt ids in merge.
  if (!g.flags.every((f) => isObject(f) && Array.isArray(f.subjects) && f.subjects.every((s) => typeof s === 'string'))) return false;
  if (Array.isArray(g.parseErrors) && !g.parseErrors.every((pe) => isObject(pe) && typeof pe.stack === 'string' && typeof pe.error === 'string')) return false;
  return true;
}

/**
 * Merges each node's local graph into one fleet map. Every id is namespaced by
 * the node id so identically named stacks/resources on different nodes stay
 * distinct, and node attribution is re-stamped from the hub's node records (so
 * a remote's view of its own name does not leak through).
 */
export function mergeFleetGraph(results: FleetNodeGraphResult[]): FleetDependencyMap {
  const nodes: DepNode[] = [];
  const edges: DepEdge[] = [];
  const flags: DepFlag[] = [];
  const nodeErrors: { nodeId: number; nodeName: string; error: string }[] = [];
  const parseErrors: { nodeId: number; nodeName: string; stack: string; error: string }[] = [];

  for (const result of results) {
    if (result.status !== 'ok') {
      nodeErrors.push({ nodeId: result.nodeId, nodeName: result.nodeName, error: result.error });
      continue;
    }
    const prefix = `n${result.nodeId}:`;
    const g = result.graph;
    for (const n of g.nodes) {
      // The host node's label is the node's name; take it from the hub's
      // node records, never from the remote's self-reported name.
      const label = n.kind === 'host' ? result.nodeName : n.label;
      nodes.push({ ...n, id: prefix + n.id, label, nodeId: result.nodeId, nodeName: result.nodeName });
    }
    for (const e of g.edges) {
      edges.push({ ...e, id: prefix + e.id, source: prefix + e.source, target: prefix + e.target });
    }
    for (const f of g.flags) {
      flags.push({ ...f, nodeId: result.nodeId, nodeName: result.nodeName, subjects: f.subjects.map((s) => prefix + s) });
    }
    for (const pe of g.parseErrors ?? []) {
      parseErrors.push({ nodeId: result.nodeId, nodeName: result.nodeName, stack: pe.stack, error: pe.error });
    }
  }

  return { nodes, edges, flags, nodeErrors, parseErrors };
}
