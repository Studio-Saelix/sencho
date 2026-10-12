import { buildServiceUrl, type ServiceUrlOptions } from './serviceUrl';
import { serviceUrlFromLabelValue } from './serviceUrlLabel';

export interface AnatomyPortRef {
  host: string;
  proto: string;
  /** Container port. Empty host plus this target is a dynamically published port. */
  container?: string;
}

export type ServiceUrlStatus = 'loading' | 'ready' | 'unavailable' | 'unsupported';

export interface ServiceUrlEntry {
  status: ServiceUrlStatus;
  nodeId: number | null;
  stackName: string;
  serviceUrls: Record<string, string>;
  ports: Record<string, AnatomyPortRef[]>;
  renderable: boolean;
  services?: string[];
  volumes?: Record<string, { host: string; container: string }[]>;
  restart?: string | null;
  networks?: string[];
}

export type PortClick =
  | { kind: 'link'; href: string; portLabel: string; hostLabel: string | null }
  | { kind: 'text'; portLabel: string; reason: string };

const UNAVAILABLE = 'Service URL unavailable';
const AMBIGUOUS = 'More than one service publishes this port';

function portCovers(host: string, port: number): boolean {
  if (!host) return false;
  const [startText, endText] = host.split('-');
  const start = Number(startText);
  const end = endText === undefined ? start : Number(endText);
  return Number.isInteger(start) && Number.isInteger(end) && port >= start && port <= end;
}

function isTcp(row: AnatomyPortRef): boolean {
  return (row.proto || 'tcp').toLowerCase() !== 'udp';
}

/** Services that publish this port over TCP. A UDP listener on the same number does not count. */
export function tcpOwners(ports: Record<string, AnatomyPortRef[]>, publicPort: number): string[] {
  const owners: string[] = [];
  for (const [service, rows] of Object.entries(ports)) {
    const owns = rows.some(row => isTcp(row) && portCovers(row.host, publicPort));
    if (owns) owners.push(service);
  }
  return owners;
}

/**
 * Services with a target-only TCP binding. Docker assigns the host port later,
 * so the saved file has no host number to match. When privatePort is omitted,
 * every such binding counts.
 */
export function dynamicTcpOwners(
  ports: Record<string, AnatomyPortRef[]>,
  privatePort: number | undefined,
): string[] {
  const owners: string[] = [];
  for (const [service, rows] of Object.entries(ports)) {
    const owns = rows.some(row => {
      if (!isTcp(row) || row.host || !row.container) return false;
      return privatePort === undefined || portCovers(row.container, privatePort);
    });
    if (owns) owners.push(service);
  }
  return owners;
}

function hostLabel(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** A refresh that still holds the last rendered model can keep using that model. */
function usableOverride(entry: ServiceUrlEntry | null): boolean {
  if (!entry || !entry.renderable) return false;
  if (entry.status === 'ready') return true;
  return entry.status === 'loading'
    && (Object.keys(entry.serviceUrls).length > 0 || Object.keys(entry.ports).length > 0);
}

function withoutOverride(generated: string | null, portLabel: string, failed: boolean): PortClick {
  if (generated) return { kind: 'link', href: generated, portLabel, hostLabel: null };
  return { kind: 'text', portLabel, reason: failed ? UNAVAILABLE : '' };
}

export function resolvePublishedPortClick(args: {
  entry: ServiceUrlEntry | null;
  serviceName: string | undefined;
  publicPort: number;
  privatePort?: number;
  portLabel: string;
  node: ServiceUrlOptions['node'];
}): PortClick {
  const { entry, serviceName, publicPort, privatePort, portLabel, node } = args;
  const generated = buildServiceUrl({ node, publicPort, privatePort });
  // A missing or legacy URL list has no override to apply, so the generated
  // host and port stays available. A failed load is the only case with no
  // generated link that offers a retry. A refresh keeps the last ready model.
  if (!entry || !usableOverride(entry)) {
    return withoutOverride(generated, portLabel, entry?.status === 'unavailable');
  }
  const owners = tcpOwners(entry.ports, publicPort);
  const withOverride = owners.filter(name => entry.serviceUrls[name]);
  // A named service uses only its own URL. The same host port on another bind
  // address still belongs to this service. A port the saved file gave to a
  // different service does not, including one Docker assigned later.
  if (serviceName && owners.includes(serviceName)) {
    const own = entry.serviceUrls[serviceName];
    if (own) return { kind: 'link', href: own, portLabel, hostLabel: hostLabel(own) };
    return withoutOverride(generated, portLabel, false);
  }
  if (owners.length > 1 && withOverride.length > 0) {
    return { kind: 'text', portLabel, reason: AMBIGUOUS };
  }
  if (!serviceName) {
    const sole = owners.length === 1 ? entry.serviceUrls[owners[0]] : undefined;
    if (sole) return { kind: 'link', href: sole, portLabel, hostLabel: hostLabel(sole) };
    return withoutOverride(generated, portLabel, false);
  }
  const dynamicOwner = owners.length === 0
    && privatePort !== undefined
    && dynamicTcpOwners(entry.ports, privatePort).includes(serviceName);
  const override = dynamicOwner ? entry.serviceUrls[serviceName] : undefined;
  if (override) {
    return { kind: 'link', href: override, portLabel, hostLabel: hostLabel(override) };
  }
  return withoutOverride(generated, portLabel, false);
}

export function resolveOpenAppTarget(args: {
  entry: ServiceUrlEntry | null;
  publicPort?: number;
  node: ServiceUrlOptions['node'];
}): { url: string } | { error: string } | null {
  const { entry, publicPort, node } = args;
  if (!entry || !usableOverride(entry)) {
    if (publicPort === undefined) return null;
    const generated = buildServiceUrl({ node, publicPort });
    return generated ? { url: generated } : { error: UNAVAILABLE };
  }
  const urls = Object.values(entry.serviceUrls);
  if (publicPort === undefined) {
    if (urls.length === 1) return { url: urls[0] };
    if (urls.length > 1) return { error: AMBIGUOUS };
    return null;
  }
  const owners = tcpOwners(entry.ports, publicPort);
  const withOverride = owners.filter(name => entry.serviceUrls[name]);
  if (owners.length > 1 && withOverride.length > 0) return { error: AMBIGUOUS };
  const override = owners.length === 1 ? entry.serviceUrls[owners[0]] : undefined;
  if (override) return { url: override };
  if (owners.length === 0) {
    const dynamic = dynamicTcpOwners(entry.ports, undefined);
    if (dynamic.length === 1) {
      const only = entry.serviceUrls[dynamic[0]];
      if (only) return { url: only };
    } else if (dynamic.filter(name => entry.serviceUrls[name]).length > 1) {
      return { error: AMBIGUOUS };
    }
  }
  const generated = buildServiceUrl({ node, publicPort });
  return generated ? { url: generated } : { error: UNAVAILABLE };
}

export function parseServiceUrlResponse(
  nodeId: number | null,
  stackName: string,
  ok: boolean,
  body: unknown,
): ServiceUrlEntry {
  const empty = { nodeId, stackName, serviceUrls: {}, ports: {}, renderable: false };
  if (!ok || !body || typeof body !== 'object') {
    return { ...empty, status: 'unavailable' };
  }
  const record = body as Record<string, unknown>;
  const ports = record.ports && typeof record.ports === 'object' && !Array.isArray(record.ports)
    ? record.ports as Record<string, AnatomyPortRef[]>
    : {};
  const services = Array.isArray(record.services)
    ? record.services.filter((name): name is string => typeof name === 'string')
    : [];
  const volumes = record.volumes && typeof record.volumes === 'object' && !Array.isArray(record.volumes)
    ? record.volumes as ServiceUrlEntry['volumes']
    : {};
  const restart = typeof record.restart === 'string' ? record.restart : null;
  const networks = Array.isArray(record.networks)
    ? record.networks.filter((name): name is string => typeof name === 'string')
    : [];
  const facts = { ports, services, volumes, restart, networks };
  // An older node has the dossier facts and no service URL field. Keep the
  // facts and mark the URL list unsupported so the generated link stays.
  if (!('serviceUrls' in record)) {
    return { ...empty, ...facts, status: 'unsupported', renderable: record.renderable === true };
  }
  const serviceUrls = readServiceUrls(record.serviceUrls);
  if (record.renderable === false) {
    return { status: 'unavailable', nodeId, stackName, serviceUrls: {}, ports, renderable: false };
  }
  return {
    status: 'ready',
    nodeId,
    stackName,
    serviceUrls,
    ports,
    renderable: true,
    services,
    volumes,
    restart,
    networks,
  };
}

function readServiceUrls(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const urls: Record<string, string> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (typeof raw !== 'string') continue;
    const url = serviceUrlFromLabelValue(raw);
    if (url) urls[name] = url;
  }
  return urls;
}

/** Drop a response whose generation is older than the latest request for that key. */
export function acceptServiceUrlGeneration(requestGeneration: number, latestGeneration: number): boolean {
  return requestGeneration === latestGeneration;
}
