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

export type SenchoUpdatePolicy = 'auto' | 'manual' | 'disabled' | 'invalid';

export interface SenchoServiceLabels {
  /** At most one application link, listed first, then uniquely named links. */
  links: SenchoLink[];
  order: number | null;
  hidden: boolean;
  /** `null` when the service declares none; `invalid` when the declared value is unrecognized. */
  update: SenchoUpdatePolicy | null;
  /** The service's notification routing key, or null when it declares none. */
  notifyRoute: string | null;
  /** Whether Sencho checks the service's image for updates; true when the label is absent (or the node does not report it). */
  updateCheck: boolean;
  /** Digests and tags whose update the service skips; empty when none (or the node does not report it). */
  updateIgnore: string[];
  /** The service's release notes link, or null. */
  updateChangelog: string | null;
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

/**
 * Keys whose value Sencho also honors on a deployed container, mirroring the
 * backend registry's `trust: 'compose-or-deployed'`. Kept here so the client
 * never downgrades the node's report for the protective label to Inert.
 */
export const DEPLOYED_TRUSTED_LABEL_KEYS: readonly string[] = ['io.sencho.infrastructure'];

/** Keys Sencho stamps on containers it creates, mirroring the backend's SENCHO_MANAGED_LABELS. */
export const MANAGED_LABEL_KEYS: readonly string[] = ['io.sencho.mesh', 'io.sencho.helper', 'io.sencho.operation'];

/** The update-eligibility label, as the backend registry spells it. */
export const SENCHO_UPDATE_LABEL = 'io.sencho.update';

/** The notification routing-key label, as the backend registry spells it. */
export const SENCHO_NOTIFY_ROUTE_LABEL = 'io.sencho.notify.route';

/**
 * The two behavioral labels, mirroring the backend registry's
 * `sencho-label-policy-v1` entries. Used for copy and key echoes only; whether a
 * node acts on them comes from its capability, never from this list.
 */
export const POLICY_LABEL_KEYS: readonly string[] = [SENCHO_UPDATE_LABEL, SENCHO_NOTIFY_ROUTE_LABEL];

/** Whether Sencho checks a service's image for updates. */
export const SENCHO_UPDATE_CHECK_LABEL = 'io.sencho.update.check';

/** The pending updates (digests or tags) a service skips. */
export const SENCHO_UPDATE_IGNORE_LABEL = 'io.sencho.update.ignore';

/** The service's release notes link, shown with a pending update. */
export const SENCHO_UPDATE_CHANGELOG_LABEL = 'io.sencho.update.changelog';

/**
 * The update detection labels, mirroring the backend registry's
 * `sencho-label-detection-v1` entries. Whether a node acts on them comes from
 * its capability, never from this list.
 */
export const DETECTION_LABEL_KEYS: readonly string[] = [
  SENCHO_UPDATE_CHECK_LABEL, SENCHO_UPDATE_IGNORE_LABEL, SENCHO_UPDATE_CHANGELOG_LABEL,
];

/** One skip entry, mirroring the node's parser: an image digest or a tag. */
const IGNORE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const IGNORE_TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** The text of a skip entry the node reported (`{ kind, digest }` or `{ kind, tag }`), or null when malformed. */
function readIgnoreEntry(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'digest' && typeof value.digest === 'string' && IGNORE_DIGEST_PATTERN.test(value.digest)) return value.digest;
  if (value.kind === 'tag' && typeof value.tag === 'string' && IGNORE_TAG_PATTERN.test(value.tag)) return value.tag;
  return null;
}

export const MANAGED_LABEL_DECLARED_REASON = 'Reserved for containers Sencho creates; it has no effect in a Compose file.';
export const MANAGED_LABEL_DEPLOYED_REASON = 'Set by Sencho on a container it manages.';

const LINK_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const MAX_LINK_NAME_LENGTH = 32;
const UNREADABLE_STATE_REASON = 'The node reported a status this version of Sencho cannot read.';

/** 1 to 64 characters of `[a-z0-9._-]`, starting and ending with a letter or digit. */
const ROUTING_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const MAX_ROUTING_KEY_LENGTH = 64;

/** Mirrors the node's routing-key format, so a key this client shows is one the node accepted. */
export function isRoutingKey(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_ROUTING_KEY_LENGTH && ROUTING_KEY_PATTERN.test(value);
}

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
  // The node's fields must match the contract exactly: an absent, fractional, or
  // wrongly typed field means the answer is not usable, so no part of it is applied.
  // The order also stays within the nine digits the registry accepts.
  const order = typeof value.order === 'number' && Number.isInteger(value.order) && Math.abs(value.order) < 1_000_000_000
    ? value.order
    : null;
  if (value.order !== null && order === null) return null;
  if (typeof value.hidden !== 'boolean') return null;
  // The behavioral labels are absent on an older node (read as null), but a
  // present field with another shape rejects the answer like any other field.
  const update = value.update;
  if (update !== undefined && update !== null
    && update !== 'auto' && update !== 'manual' && update !== 'disabled' && update !== 'invalid') {
    return null;
  }
  const notifyRoute = value.notifyRoute;
  if (notifyRoute !== undefined && notifyRoute !== null && !isRoutingKey(notifyRoute)) return null;
  // The detection fields are absent on an older node and read as the defaults.
  if (value.updateCheck !== undefined && typeof value.updateCheck !== 'boolean') return null;
  let updateIgnore: string[] = [];
  if (value.updateIgnore !== undefined) {
    if (!Array.isArray(value.updateIgnore)) return null;
    const entries = value.updateIgnore.map(readIgnoreEntry);
    if (entries.some(entry => entry === null)) return null;
    updateIgnore = entries as string[];
  }
  let updateChangelog: string | null = null;
  if (value.updateChangelog !== undefined && value.updateChangelog !== null) {
    if (typeof value.updateChangelog !== 'string') return null;
    // Checked again before it can become an anchor, like every link.
    updateChangelog = serviceUrlFromLabelValue(value.updateChangelog) ?? null;
  }
  return {
    links: links.links,
    order,
    hidden: value.hidden,
    update: update ?? null,
    notifyRoute: notifyRoute ?? null,
    updateCheck: value.updateCheck ?? true,
    updateIgnore,
    updateChangelog,
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

/** The service's `io.sencho.update` policy, or null when it declares none (or the node does not report it). */
export function updatePolicyOf(resolution: SenchoLabelResolution | null | undefined, service: string | undefined): SenchoUpdatePolicy | null {
  return labelsFor(resolution, service)?.update ?? null;
}

/** The service's `io.sencho.notify.route` key, or null when it declares none (or the node does not report it). */
export function notifyRouteOf(resolution: SenchoLabelResolution | null | undefined, service: string | undefined): string | null {
  return labelsFor(resolution, service)?.notifyRoute ?? null;
}

/** Whether the service's image is checked for updates: false only when it declares `io.sencho.update.check: false`. */
export function updateCheckOf(resolution: SenchoLabelResolution | null | undefined, service: string | undefined): boolean {
  return labelsFor(resolution, service)?.updateCheck ?? true;
}

/**
 * Declared `io.sencho.*` labels of a service that Sencho ignored, with the
 * reason. A node that knows the update detection labels reports them active or
 * invalid; only a node too old to evaluate them reports them unrecognized, and
 * that is the node's version, not a problem with the label, so it is left out.
 * The Compose Labels tab shows those rows as Not evaluated.
 */
export function ignoredLabels(resolution: SenchoLabelResolution | null | undefined, service: string | undefined): SenchoLabelEntry[] {
  if (!resolution || !resolution.renderable || !service) return [];
  return resolution.entries.filter(entry => entry.service === service && entry.state !== 'active'
    && !(entry.state === 'unsupported' && DETECTION_LABEL_KEYS.includes(entry.key)));
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
