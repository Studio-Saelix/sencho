/**
 * Client view of the node's `io.sencho.*` resolution. The node validates and
 * resolves every label (backend `helpers/senchoLabels.ts`); this module only
 * reads that answer defensively and derives presentation from it. Links are
 * checked again before they can become an anchor, so a node that returned an
 * unexpected scheme still cannot produce a clickable `javascript:` link.
 */
import { serviceUrlFromLabelValue } from './serviceUrlLabel';

export interface SenchoLink {
  /** `null` is the service's application link (`io.sencho.url`). */
  name: string | null;
  url: string;
}

export interface SenchoServiceLabels {
  links: SenchoLink[];
  order: number | null;
  hidden: boolean;
}

export type SenchoLabelState = 'active' | 'invalid' | 'unsupported';

export interface SenchoLabelEntry {
  service: string;
  key: string;
  state: SenchoLabelState;
  reason?: string;
}

export interface SenchoLabelResolution {
  renderable: boolean;
  services: Record<string, SenchoServiceLabels>;
  entries: SenchoLabelEntry[];
  serviceOrder: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readLinks(value: unknown): SenchoLink[] {
  if (!Array.isArray(value)) return [];
  const links: SenchoLink[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.url !== 'string') continue;
    const url = serviceUrlFromLabelValue(item.url);
    if (!url) continue;
    if (item.name === null) links.push({ name: null, url });
    else if (typeof item.name === 'string' && item.name !== '') links.push({ name: item.name, url });
  }
  return links;
}

function readEntries(value: unknown): SenchoLabelEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: SenchoLabelEntry[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.service !== 'string' || typeof item.key !== 'string') continue;
    if (item.state !== 'active' && item.state !== 'invalid' && item.state !== 'unsupported') continue;
    entries.push({
      service: item.service,
      key: item.key,
      state: item.state,
      ...(typeof item.reason === 'string' ? { reason: item.reason } : {}),
    });
  }
  return entries;
}

/** The resolution from an `effective-anatomy` body, or null when the node does not report one. */
export function readSenchoLabels(value: unknown): SenchoLabelResolution | null {
  if (!isRecord(value) || typeof value.renderable !== 'boolean' || !isRecord(value.services)) return null;
  const services: Record<string, SenchoServiceLabels> = Object.create(null) as Record<string, SenchoServiceLabels>;
  for (const [name, raw] of Object.entries(value.services)) {
    if (!isRecord(raw)) continue;
    services[name] = {
      links: readLinks(raw.links),
      order: typeof raw.order === 'number' && Number.isFinite(raw.order) ? raw.order : null,
      hidden: raw.hidden === true,
    };
  }
  return {
    renderable: value.renderable,
    services,
    entries: readEntries(value.entries),
    serviceOrder: Array.isArray(value.serviceOrder)
      ? value.serviceOrder.filter((name): name is string => typeof name === 'string')
      : [],
  };
}

function labelsFor(resolution: SenchoLabelResolution | null | undefined, service: string | undefined): SenchoServiceLabels | undefined {
  if (!resolution || !resolution.renderable || !service) return undefined;
  return Object.prototype.hasOwnProperty.call(resolution.services, service) ? resolution.services[service] : undefined;
}

/** The application link, when the service has a valid `io.sencho.url`. */
export function applicationLink(resolution: SenchoLabelResolution | null | undefined, service: string | undefined): SenchoLink | undefined {
  return labelsFor(resolution, service)?.links.find(link => link.name === null);
}

/** Valid named links in display order. */
export function namedLinks(resolution: SenchoLabelResolution | null | undefined, service: string | undefined): SenchoLink[] {
  return labelsFor(resolution, service)?.links.filter(link => link.name !== null) ?? [];
}

/** Declared `io.sencho.*` labels of a service that Sencho ignored, with the reason. */
export function ignoredLabels(resolution: SenchoLabelResolution | null | undefined, service: string | undefined): SenchoLabelEntry[] {
  if (!resolution || !resolution.renderable || !service) return [];
  return resolution.entries.filter(entry => entry.service === service && entry.state !== 'active');
}

export interface ServicePresentation {
  /** Every service, in the node's presentation order. */
  order: string[];
  /** Services collapsed out of the default list. Never every service. */
  hidden: Set<string>;
}

/**
 * Presentation order and hidden set for a list of service names. Names the node
 * did not order keep their incoming relative order after the ordered ones. When
 * every service is hidden none is, so a list never collapses to nothing.
 */
export function presentServices(names: readonly string[], resolution: SenchoLabelResolution | null | undefined): ServicePresentation {
  if (!resolution || !resolution.renderable) return { order: [...names], hidden: new Set() };
  const rank = new Map(resolution.serviceOrder.map((name, index) => [name, index]));
  const known = names.filter(name => rank.has(name)).sort((a, b) => (rank.get(a) as number) - (rank.get(b) as number));
  const order = [...known, ...names.filter(name => !rank.has(name))];
  const hidden = new Set(order.filter(name => labelsFor(resolution, name)?.hidden === true));
  return { order, hidden: hidden.size === order.length ? new Set() : hidden };
}
