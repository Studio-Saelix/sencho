/**
 * Client view of the node's `io.sencho.*` resolution. The node validates and
 * resolves every label (backend `helpers/senchoLabels.ts`); this module only
 * reads that answer defensively and derives presentation from it. Links are
 * checked again before they can become an anchor, so a node that returned an
 * unexpected scheme still cannot produce a clickable `javascript:` link. An
 * answer that is not well formed is not partly used: `readSenchoLabels` returns
 * null and the caller treats the node as not supporting the contract.
 */
import { serviceUrlFromLabelValue } from './serviceUrlLabel';

export interface SenchoLink {
  /** `null` is the service's application link (`io.sencho.url`). */
  name: string | null;
  url: string;
}

export interface SenchoServiceLabels {
  /** At most one application link, listed first, then uniquely named links. */
  links: SenchoLink[];
  order: number | null;
  hidden: boolean;
  /** Links the node reported that this client refused to show (failed the second check). */
  unverifiedLinks: number;
}

export type SenchoLabelState = 'active' | 'invalid' | 'unsupported';

export interface SenchoLabelEntry {
  service: string;
  key: string;
  state: SenchoLabelState;
  reason?: string;
}

export type SenchoLabelResolution =
  | { renderable: false }
  | { renderable: true; services: Record<string, SenchoServiceLabels>; entries: SenchoLabelEntry[] };

const LINK_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const MAX_LINK_NAME_LENGTH = 32;
const UNREADABLE_STATE_REASON = 'The node reported a status this version of Sencho cannot read.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Valid links only, one application link and each name once; `unverified` counts what was refused. */
function readLinks(value: unknown): { links: SenchoLink[]; unverified: number } | null {
  if (!Array.isArray(value)) return null;
  const links: SenchoLink[] = [];
  const seen = new Set<string | null>();
  let unverified = 0;
  for (const item of value) {
    if (!isRecord(item) || typeof item.url !== 'string') return null;
    const url = serviceUrlFromLabelValue(item.url);
    const name = item.name;
    const nameOk = name === null
      || (typeof name === 'string' && name.length <= MAX_LINK_NAME_LENGTH && LINK_NAME_PATTERN.test(name));
    if (!url || !nameOk || seen.has(name as string | null)) {
      unverified += 1;
      continue;
    }
    seen.add(name as string | null);
    links.push({ name: name as string | null, url });
  }
  // The application link leads, as the node lists it; a node that put it elsewhere is normalized here.
  links.sort((a, b) => Number(b.name === null) - Number(a.name === null));
  return { links, unverified };
}

function readEntries(value: unknown): SenchoLabelEntry[] | null {
  if (!Array.isArray(value)) return null;
  const entries: SenchoLabelEntry[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.service !== 'string' || typeof item.key !== 'string') return null;
    const known = item.state === 'active' || item.state === 'invalid' || item.state === 'unsupported';
    // A state from a newer node counts as unsupported instead of vanishing from the ignored count.
    entries.push({
      service: item.service,
      key: item.key,
      state: known ? item.state as SenchoLabelState : 'unsupported',
      ...(known
        ? (typeof item.reason === 'string' ? { reason: item.reason } : {})
        : { reason: UNREADABLE_STATE_REASON }),
    });
  }
  return entries;
}

function readService(value: unknown): SenchoServiceLabels | null {
  if (!isRecord(value)) return null;
  const links = readLinks(value.links);
  if (!links) return null;
  return {
    links: links.links,
    order: typeof value.order === 'number' && Number.isFinite(value.order) ? value.order : null,
    hidden: value.hidden === true,
    unverifiedLinks: links.unverified,
  };
}

/**
 * The resolution from an `effective-anatomy` body, or null when the node does
 * not report a well-formed one (an older version, or a truncated answer).
 */
export function readSenchoLabels(value: unknown): SenchoLabelResolution | null {
  if (!isRecord(value) || typeof value.renderable !== 'boolean') return null;
  if (!value.renderable) return { renderable: false };
  const entries = readEntries(value.entries);
  if (!entries || !isRecord(value.services)) return null;
  const services: Record<string, SenchoServiceLabels> = Object.create(null) as Record<string, SenchoServiceLabels>;
  for (const [name, raw] of Object.entries(value.services)) {
    const service = readService(raw);
    if (!service) return null;
    services[name] = service;
  }
  return { renderable: true, services, entries };
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

/** Links the node reported for a service that this client refused to show. */
export function unverifiedLinkCount(resolution: SenchoLabelResolution | null | undefined, service: string | undefined): number {
  return labelsFor(resolution, service)?.unverifiedLinks ?? 0;
}

export interface ServicePresentation {
  /** Every service, in display order. */
  order: string[];
  /** Services collapsed out of the default list. Never every service. */
  hidden: Set<string>;
}

/** Code-unit comparison, so ordering never depends on the browser locale. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Display order and hidden set for a list of service names. Services with a
 * valid `io.sencho.order` come first, ascending, ties by name; the other
 * services the node knows follow by name; names the node did not report keep
 * their incoming relative order at the end. When every service is hidden none
 * is, so a list never collapses to nothing.
 */
export function presentServices(names: readonly string[], resolution: SenchoLabelResolution | null | undefined): ServicePresentation {
  if (!resolution || !resolution.renderable) return { order: [...names], hidden: new Set() };
  const orderOf = (name: string) => labelsFor(resolution, name)?.order ?? null;
  const known = names.filter(name => labelsFor(resolution, name) !== undefined);
  const ordered = known.filter(name => orderOf(name) !== null)
    .sort((a, b) => (orderOf(a) as number) - (orderOf(b) as number) || compareText(a, b));
  const unordered = known.filter(name => orderOf(name) === null).sort(compareText);
  const order = [...ordered, ...unordered, ...names.filter(name => labelsFor(resolution, name) === undefined)];
  const hidden = new Set(order.filter(name => labelsFor(resolution, name)?.hidden === true));
  return { order, hidden: hidden.size === order.length ? new Set() : hidden };
}
