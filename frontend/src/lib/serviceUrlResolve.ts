import { buildServiceUrl, type ServiceUrlOptions } from './serviceUrl';
import { serviceUrlFromLabelValue } from './serviceUrlLabel';

export interface AnatomyPortRef {
  host: string;
  proto: string;
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

/** Services that publish this port over TCP. A UDP listener on the same number does not count. */
export function tcpOwners(ports: Record<string, AnatomyPortRef[]>, publicPort: number): string[] {
  const owners: string[] = [];
  for (const [service, rows] of Object.entries(ports)) {
    const owns = rows.some(row => (row.proto || 'tcp').toLowerCase() !== 'udp' && portCovers(row.host, publicPort));
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
  // A missing, legacy, or failed URL list has no override to apply, so the
  // generated host and port stays available. An override is used only after a
  // ready response names one owner.
  if (!entry || entry.status !== 'ready' || !entry.renderable) {
    return generated
      ? { kind: 'link', href: generated, portLabel, hostLabel: null }
      : { kind: 'text', portLabel, reason: UNAVAILABLE };
  }
  if (!serviceName) {
    return generated
      ? { kind: 'link', href: generated, portLabel, hostLabel: null }
      : { kind: 'text', portLabel, reason: UNAVAILABLE };
  }
  const owners = tcpOwners(entry.ports, publicPort);
  const withOverride = owners.filter(name => entry.serviceUrls[name]);
  if (owners.length > 1 && withOverride.length > 0) {
    return { kind: 'text', portLabel, reason: AMBIGUOUS };
  }
  // A named service uses only its own URL, and only when the saved file still
  // says it is the only owner of this port. A live container can publish a
  // port that the saved file has since given to another service.
  const namedIsSoleOwner = owners.length === 1 && owners[0] === serviceName;
  const override = namedIsSoleOwner ? entry.serviceUrls[serviceName] : undefined;
  if (override) {
    return { kind: 'link', href: override, portLabel, hostLabel: hostLabel(override) };
  }
  return generated
    ? { kind: 'link', href: generated, portLabel, hostLabel: null }
    : { kind: 'text', portLabel, reason: UNAVAILABLE };
}

export function resolveOpenAppTarget(args: {
  entry: ServiceUrlEntry | null;
  publicPort?: number;
  node: ServiceUrlOptions['node'];
}): { url: string } | { error: string } | null {
  const { entry, publicPort, node } = args;
  if (!entry || entry.status !== 'ready' || !entry.renderable) {
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
  if (!('serviceUrls' in record)) {
    return { ...empty, status: 'unsupported' };
  }
  const serviceUrls = readServiceUrls(record.serviceUrls);
  const ports = record.ports && typeof record.ports === 'object'
    ? record.ports as Record<string, AnatomyPortRef[]>
    : {};
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
    services: Array.isArray(record.services) ? record.services.filter((name): name is string => typeof name === 'string') : [],
    volumes: record.volumes && typeof record.volumes === 'object'
      ? record.volumes as ServiceUrlEntry['volumes']
      : {},
    restart: typeof record.restart === 'string' ? record.restart : null,
    networks: Array.isArray(record.networks) ? record.networks.filter((name): name is string => typeof name === 'string') : [],
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
