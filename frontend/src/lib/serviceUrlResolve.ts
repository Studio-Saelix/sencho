import { buildServiceUrl, type ServiceUrlOptions } from './serviceUrl';
import { serviceUrlFromLabelValue } from './serviceUrlLabel';

export interface AnatomyPortRef {
  host: string;
  proto: string;
  /** Container port. Empty host plus this target is a dynamically published port. */
  container?: string;
}

export type ServiceUrlStatus = 'loading' | 'ready' | 'unavailable' | 'unsupported';

/** Editability of a service's URL label from the resolved main compose file. */
export type ServiceUrlEditState = 'root' | 'other' | 'unknown';
export type ServiceUrlEditBlock = Exclude<ServiceUrlEditState, 'root'>;

export interface ServiceUrlEntry {
  status: ServiceUrlStatus;
  nodeId: number | null;
  stackName: string;
  serviceUrls: Record<string, string>;
  /** Per-service editability of the URL label from the open main compose file. */
  serviceUrlEdit: Record<string, ServiceUrlEditState>;
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

/** A service-keyed map that cannot read an inherited Object property (a service named `constructor`). */
export function createServiceKeyMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** Own-property lookup, so only a value stored for this service is returned. */
export function serviceKeyGet<T>(map: Record<string, T>, name: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, name) ? map[name] : undefined;
}

/** The editability state of one service on an entry, or undefined without metadata. */
export function serviceUrlEditState(entry: ServiceUrlEntry | null | undefined, serviceName: string): ServiceUrlEditState | undefined {
  return entry ? serviceKeyGet(entry.serviceUrlEdit, serviceName) : undefined;
}

/** Services whose URL cannot be edited from the open compose file, with the reason. */
export function lockedServiceUrlReasons(entry: ServiceUrlEntry | null): Map<string, ServiceUrlEditBlock> {
  const locked = new Map<string, ServiceUrlEditBlock>();
  if (!entry) return locked;
  for (const [name, state] of Object.entries(entry.serviceUrlEdit)) {
    if (state === 'other' || state === 'unknown') locked.set(name, state);
  }
  return locked;
}

/**
 * The refusal message for a service whose URL the open compose file does not
 * control, or null when saving a label there changes the effective URL.
 */
export function serviceUrlEditBlockedMessage(state: ServiceUrlEditState | undefined): string | null {
  if (state === 'root') return null;
  if (state === 'other') return 'This URL is set in another compose file.';
  return 'Sencho cannot verify which compose file sets this URL.';
}

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
  const withOverride = owners.filter(name => serviceKeyGet(entry.serviceUrls, name));
  // A named service uses only its own URL. The same host port on another bind
  // address still belongs to this service. A port the saved file gave to a
  // different service does not, including one Docker assigned later.
  if (serviceName && owners.includes(serviceName)) {
    const own = serviceKeyGet(entry.serviceUrls, serviceName);
    if (own) return { kind: 'link', href: own, portLabel, hostLabel: hostLabel(own) };
    return withoutOverride(generated, portLabel, false);
  }
  if (owners.length > 1 && withOverride.length > 0) {
    return { kind: 'text', portLabel, reason: AMBIGUOUS };
  }
  if (!serviceName) {
    const sole = owners.length === 1 ? serviceKeyGet(entry.serviceUrls, owners[0]) : undefined;
    if (sole) return { kind: 'link', href: sole, portLabel, hostLabel: hostLabel(sole) };
    return withoutOverride(generated, portLabel, false);
  }
  const dynamicOwner = owners.length === 0
    && privatePort !== undefined
    && dynamicTcpOwners(entry.ports, privatePort).includes(serviceName);
  const override = dynamicOwner ? serviceKeyGet(entry.serviceUrls, serviceName) : undefined;
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
  const withOverride = owners.filter(name => serviceKeyGet(entry.serviceUrls, name));
  if (owners.length > 1 && withOverride.length > 0) return { error: AMBIGUOUS };
  const override = owners.length === 1 ? serviceKeyGet(entry.serviceUrls, owners[0]) : undefined;
  if (override) return { url: override };
  if (owners.length === 0) {
    const dynamic = dynamicTcpOwners(entry.ports, undefined);
    if (dynamic.length === 1) {
      const only = serviceKeyGet(entry.serviceUrls, dynamic[0]);
      if (only) return { url: only };
    } else if (dynamic.filter(name => serviceKeyGet(entry.serviceUrls, name)).length > 1) {
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
  const empty = {
    nodeId,
    stackName,
    serviceUrls: createServiceKeyMap<string>(),
    serviceUrlEdit: createServiceKeyMap<ServiceUrlEditState>(),
    ports: createServiceKeyMap<AnatomyPortRef[]>(),
    renderable: false,
  };
  if (!ok || !body || typeof body !== 'object') {
    return { ...empty, status: 'unavailable' };
  }
  const record = body as Record<string, unknown>;
  const ports = readPortMap(record.ports);
  const services = Array.isArray(record.services)
    ? record.services.filter((name): name is string => typeof name === 'string')
    : [];
  const volumes = readVolumeMap(record.volumes);
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
  const serviceUrlEdit = readServiceUrlEdit(record.serviceUrlEdit);
  if (record.renderable === false) {
    return {
      status: 'unavailable',
      nodeId,
      stackName,
      serviceUrls: createServiceKeyMap<string>(),
      serviceUrlEdit: createServiceKeyMap<ServiceUrlEditState>(),
      ports,
      renderable: false,
    };
  }
  return {
    status: 'ready',
    nodeId,
    stackName,
    serviceUrls,
    serviceUrlEdit,
    ports,
    renderable: true,
    services,
    volumes,
    restart,
    networks,
  };
}

/** Copy a service-keyed map onto a null prototype; only array entries are kept. */
function readPortMap(value: unknown): Record<string, AnatomyPortRef[]> {
  const ports = createServiceKeyMap<AnatomyPortRef[]>();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ports;
  for (const [name, rows] of Object.entries(value)) {
    if (Array.isArray(rows)) ports[name] = rows as AnatomyPortRef[];
  }
  return ports;
}

function readVolumeMap(value: unknown): Record<string, { host: string; container: string }[]> {
  const volumes = createServiceKeyMap<{ host: string; container: string }[]>();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return volumes;
  for (const [name, rows] of Object.entries(value)) {
    if (Array.isArray(rows)) volumes[name] = rows as { host: string; container: string }[];
  }
  return volumes;
}

/** Only the three known states are kept; anything else is left absent (no metadata). */
function readServiceUrlEdit(value: unknown): Record<string, ServiceUrlEditState> {
  const states = createServiceKeyMap<ServiceUrlEditState>();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return states;
  for (const [name, raw] of Object.entries(value)) {
    if (raw === 'root' || raw === 'other' || raw === 'unknown') states[name] = raw;
  }
  return states;
}

function readServiceUrls(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return createServiceKeyMap<string>();
  const urls = createServiceKeyMap<string>();
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
