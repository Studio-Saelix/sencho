/**
 * Backend-local networking helpers and the normalized network model that lets
 * the Inspector (rendered EffectiveModel) and Drift (raw DeclaredCompose) feed
 * one comparison. The rendered model already resolves resource names; the raw
 * declared model does not, so each shape gets its own adapter and both emit the
 * same key-space NormalizedNetworkModel. Do not import the frontend's access-url
 * parser here; this is the backend copy.
 */
import type { EffectiveModel } from '../preflight/effectiveModel';
import type { DeclaredCompose } from '../../helpers/composeDependencyParse';
import type { DependencySnapshot } from '../DockerController';
import type { NetworkDriftFacts } from './types';

/** Container states that count as "deployed" for drift, matching DriftDetectionService. */
const RUNNING_STATES = new Set(['running', 'restarting']);
const SYSTEM_NETWORK_NAMES = new Set(['bridge', 'host', 'none']);

export function isAllInterfaces(ip: string): boolean {
  return ip === '' || ip === '0.0.0.0' || ip === '::' || ip === '[::]';
}

export function isLoopback(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '[::1]';
}

/** Resolved runtime name of a top-level network/volume: a `name:` override wins,
 *  otherwise compose prefixes the project (`<project>_<key>`). */
export function runtimeResourceName(projectName: string, key: string, declaredName: string | undefined): string {
  return declaredName && declaredName !== key ? declaredName : `${projectName}_${key}`;
}

/** Extract host port numbers referenced by free-text access URLs, for the
 *  port-vs-documented finding. Heuristic: matches `:PORT` boundaries. */
export function parseAccessUrlPorts(text: string): Set<number> {
  const ports = new Set<number>();
  const re = /:(\d{1,5})(?=[/\s)\];]|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const p = parseInt(m[1], 10);
    if (p > 0 && p <= 65535) ports.add(p);
  }
  return ports;
}

/** Key-space network model both adapters emit, so the comparison is shape-agnostic. */
export interface NormalizedNetworkModel {
  projectName: string;
  /** By network key → resolved runtime name + external flag. */
  networks: Record<string, { runtimeName: string; external: boolean }>;
  services: { name: string; networkKeys: string[]; networkMode?: string }[];
}

/** Rendered model: resource names are already resolved by `docker compose config`. */
export function fromEffectiveModel(m: EffectiveModel): NormalizedNetworkModel {
  const networks: NormalizedNetworkModel['networks'] = {};
  for (const [key, res] of Object.entries(m.networks)) {
    networks[key] = { runtimeName: res.name, external: res.external };
  }
  return {
    projectName: m.projectName,
    networks,
    services: m.services.map(s => ({ name: s.name, networkKeys: s.networks.map(n => n.key), networkMode: s.networkMode })),
  };
}

/** Raw declared model: resolve runtime names here (project prefix / `name:` override). */
export function fromDeclaredCompose(m: DeclaredCompose, projectName: string): NormalizedNetworkModel {
  const networks: NormalizedNetworkModel['networks'] = {};
  for (const [key, res] of Object.entries(m.networks)) {
    networks[key] = { runtimeName: runtimeResourceName(projectName, key, res.name), external: res.external };
  }
  return {
    projectName,
    networks,
    services: m.services.map(s => ({ name: s.name, networkKeys: s.networks })),
  };
}

/**
 * Compare declared networks against the live snapshot. Only running/restarting
 * containers of this stack count; system networks (bridge/host/none), the
 * implicit default network, and external (shared) networks are not flagged.
 */
export function compareStackNetworks(
  declared: NormalizedNetworkModel,
  snapshot: DependencySnapshot,
  stackName: string,
): NetworkDriftFacts {
  const runtimeOnlyAttachments: NetworkDriftFacts['runtimeOnlyAttachments'] = [];
  const foreignNetworkAttachments: NetworkDriftFacts['foreignNetworkAttachments'] = [];

  // Every declared network (external included) resolves into this set, so an
  // attachment to a declared external/shared network is treated as declared
  // below, not as foreign.
  const declaredRuntimeNames = new Set<string>();
  for (const net of Object.values(declared.networks)) declaredRuntimeNames.add(net.runtimeName);
  // The implicit default network compose always provisions counts as declared.
  declaredRuntimeNames.add(`${declared.projectName}_default`);

  const networkByName = new Map(snapshot.networks.map(n => [n.name, n]));
  const stackContainers = snapshot.containers.filter(c => c.stack === stackName && RUNNING_STATES.has(c.state));
  const usedRuntimeNames = new Set<string>();

  for (const c of stackContainers) {
    for (const attached of c.networks) {
      const net = networkByName.get(attached.name);
      if (SYSTEM_NETWORK_NAMES.has(attached.name) || net?.isSystem) continue;
      if (declaredRuntimeNames.has(attached.name)) { usedRuntimeNames.add(attached.name); continue; }
      if (net?.stack === stackName || attached.name.startsWith(`${declared.projectName}_`)) {
        runtimeOnlyAttachments.push({ container: c.name, service: c.service, network: attached.name });
      } else {
        foreignNetworkAttachments.push({ container: c.name, network: attached.name });
      }
    }
  }

  const runtimeNetworkNames = new Set(snapshot.networks.map(n => n.name));
  const declaredButUnused: string[] = [];
  const missingFromRuntime: string[] = [];
  for (const [key, net] of Object.entries(declared.networks)) {
    if (net.external || key === 'default') continue;
    if (!runtimeNetworkNames.has(net.runtimeName)) { missingFromRuntime.push(net.runtimeName); continue; }
    if (!usedRuntimeNames.has(net.runtimeName)) declaredButUnused.push(key);
  }

  return { runtimeOnlyAttachments, declaredButUnused, missingFromRuntime, foreignNetworkAttachments };
}
