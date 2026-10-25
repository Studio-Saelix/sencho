/**
 * The `io.sencho.*` Compose label contract: one typed registry of every label
 * Sencho reads, and a resolver that turns a successfully rendered Compose model
 * into the active metadata. Docker owns `com.docker.compose.*`; this namespace
 * is Sencho's and is the only public one.
 *
 * Trust rule: only labels declared on a service of the rendered, authored
 * Compose model can become active. Image, runtime-only, system, and
 * unknown-provenance labels stay visible in the label audit but are inert
 * (`inertLabelBehavior`). A model that did not render yields no metadata at all
 * (`unrenderableSenchoLabels`), never a guess from runtime state.
 *
 * Diagnostics carry the label key and a fixed reason, never the value: a value
 * can be an interpolated secret, and the audit already shows declared values
 * under its own redaction rules.
 */

export const SENCHO_LABEL_NAMESPACE = 'io.sencho.';

/** The application link label; the Compose editor and the URL pipeline key off it. */
export const SENCHO_URL_LABEL = 'io.sencho.url';

/** Capability advertised by nodes that resolve this contract. Older nodes degrade as a whole. */
export const SENCHO_LABELS_CAPABILITY = 'sencho-labels-v1';

export type SenchoLabelId = 'url' | 'url-named' | 'order' | 'hidden';
export type SenchoLabelEffect = 'presentation' | 'operations';

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface SenchoLabelDefinition {
  id: SenchoLabelId;
  /** Exact key, or a key prefix whose remainder names an instance (`io.sencho.url.docs`). */
  match: { kind: 'exact'; key: string } | { kind: 'prefix'; prefix: string };
  /** Every current label is declared per Compose service and shared by all of its replicas. */
  scope: 'service';
  valueType: 'url' | 'integer' | 'boolean';
  /** What an absent or invalid label means. */
  defaultBehavior: string;
  /** How competing sources resolve. */
  precedence: string;
  /** How duplicates and conflicting declarations resolve. */
  conflict: string;
  effect: SenchoLabelEffect;
  /** Every invalid value is ignored with a diagnostic; none breaks a view. */
  onInvalid: 'ignore-with-diagnostic';
  minCapability: typeof SENCHO_LABELS_CAPABILITY;
  summary: string;
  example: string;
}

export const SENCHO_LABEL_DEFINITIONS: readonly SenchoLabelDefinition[] = [
  {
    id: 'url',
    match: { kind: 'exact', key: SENCHO_URL_LABEL },
    scope: 'service',
    valueType: 'url',
    defaultBehavior: 'No configured link; a published port opens the generated host and port.',
    precedence: 'A valid configured link wins over the generated published-port link for that service.',
    conflict: 'The merged Compose model decides the value; later files replace earlier ones.',
    effect: 'presentation',
    onInvalid: 'ignore-with-diagnostic',
    minCapability: SENCHO_LABELS_CAPABILITY,
    summary: 'Application link for the service.',
    example: 'io.sencho.url: https://app.example.com',
  },
  {
    id: 'url-named',
    match: { kind: 'prefix', prefix: 'io.sencho.url.' },
    scope: 'service',
    valueType: 'url',
    defaultBehavior: 'No extra link.',
    precedence: 'Named links are listed after the application link, sorted by name; they never replace a port link.',
    conflict: 'Names are lowercased; when two keys normalize to one name, the key that sorts first is kept and the other is ignored.',
    effect: 'presentation',
    onInvalid: 'ignore-with-diagnostic',
    minCapability: SENCHO_LABELS_CAPABILITY,
    summary: 'Extra named link for the service (docs, admin, and so on).',
    example: 'io.sencho.url.docs: https://docs.example.com',
  },
  {
    id: 'order',
    match: { kind: 'exact', key: 'io.sencho.order' },
    scope: 'service',
    valueType: 'integer',
    defaultBehavior: 'The service sorts after ordered services, by name.',
    precedence: 'Services with a valid order come first, ascending; ties and unordered services sort by name.',
    conflict: 'The merged Compose model decides the value. Equal values tie-break by service name.',
    effect: 'presentation',
    onInvalid: 'ignore-with-diagnostic',
    minCapability: SENCHO_LABELS_CAPABILITY,
    summary: 'Display position of the service. Changes presentation only, never start order.',
    example: 'io.sencho.order: "10"',
  },
  {
    id: 'hidden',
    match: { kind: 'exact', key: 'io.sencho.hidden' },
    scope: 'service',
    valueType: 'boolean',
    defaultBehavior: 'The service is listed.',
    precedence: 'Hides the service from default lists only; health, security, drift, updates, and lifecycle still include it.',
    conflict: 'The merged Compose model decides the value.',
    effect: 'presentation',
    onInvalid: 'ignore-with-diagnostic',
    minCapability: SENCHO_LABELS_CAPABILITY,
    summary: 'Collapses a helper service out of default lists.',
    example: 'io.sencho.hidden: "true"',
  },
];

const MAX_URL_LENGTH = 2048;
const MAX_LINK_NAME_LENGTH = 32;
const LINK_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const INTEGER_PATTERN = /^[+-]?\d{1,9}$/;
const CONTROL_OR_SPACE = /[\u0000- \u007f-\u009f]/;

/** Compose writes a literal `$` as `$$` in rendered config. Undo that once. */
function unescapeRenderedDollar(value: string): string {
  return value.replaceAll('$$', '$');
}

/** A literal http(s) URL with a host and no userinfo, or the reason it was refused. */
export function parseSenchoUrl(raw: string): ParseResult<string> {
  const value = raw.trim();
  if (!value) return { ok: false, reason: 'The value is empty.' };
  if (value.length > MAX_URL_LENGTH) return { ok: false, reason: 'The link is too long.' };
  if (CONTROL_OR_SPACE.test(value)) return { ok: false, reason: 'The link contains spaces or control characters.' };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: 'The link is not a valid URL.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'Only http and https links are supported.' };
  }
  if (!/^https?:\/\//i.test(value)) return { ok: false, reason: 'The link must start with http:// or https://.' };
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, reason: 'The link must not contain a username or password.' };
  }
  if (!parsed.hostname) return { ok: false, reason: 'The link has no host.' };
  return { ok: true, value };
}

function parseSenchoInteger(raw: string): ParseResult<number> {
  const value = raw.trim();
  if (!INTEGER_PATTERN.test(value)) return { ok: false, reason: 'Use a whole number such as 10.' };
  return { ok: true, value: Number(value) };
}

function parseSenchoBoolean(raw: string): ParseResult<boolean> {
  const value = raw.trim().toLowerCase();
  if (value === 'true') return { ok: true, value: true };
  if (value === 'false') return { ok: true, value: false };
  return { ok: false, reason: 'Use true or false.' };
}

/** The normalized name of a named link, or the reason the key suffix is not a usable name. */
export function normalizeLinkName(rawName: string): ParseResult<string> {
  const name = rawName.trim().toLowerCase();
  if (!name) return { ok: false, reason: 'The link name is empty.' };
  if (name.length > MAX_LINK_NAME_LENGTH) return { ok: false, reason: `Link names are at most ${MAX_LINK_NAME_LENGTH} characters.` };
  if (!LINK_NAME_PATTERN.test(name)) {
    return { ok: false, reason: 'Link names use lowercase letters, digits, and hyphens.' };
  }
  return { ok: true, value: name };
}

/** The definition that owns a key, or null for a key the registry does not know. */
export function findSenchoLabelDefinition(key: string): SenchoLabelDefinition | null {
  for (const def of SENCHO_LABEL_DEFINITIONS) {
    if (def.match.kind === 'exact' ? def.match.key === key : key.startsWith(def.match.prefix)) return def;
  }
  return null;
}

export function isSenchoLabelKey(key: string): boolean {
  return key.startsWith(SENCHO_LABEL_NAMESPACE);
}

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
  definition: SenchoLabelId | null;
  /** Fixed text that never echoes the label value. */
  reason?: string;
}

export interface SenchoLabelResolution {
  /** False when the model did not render: nothing is active, and the audit says why. */
  renderable: boolean;
  /** Active metadata for every rendered service. */
  services: Record<string, SenchoServiceLabels>;
  /** Every authored `io.sencho.*` label with its state, by service then key. */
  entries: SenchoLabelEntry[];
  /** Every rendered service in presentation order. */
  serviceOrder: string[];
}

/** Service-keyed maps use a null prototype so a service named `constructor` cannot read an inherited value. */
function serviceMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

export function unrenderableSenchoLabels(): SenchoLabelResolution {
  return { renderable: false, services: serviceMap(), entries: [], serviceOrder: [] };
}

function asLabelText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return '';
  return undefined;
}

/** Map or `key=value` list syntax to one map; in a list the last duplicate wins, as in Compose. */
function labelMap(labels: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (Array.isArray(labels)) {
    for (const item of labels) {
      if (typeof item !== 'string') continue;
      const eq = item.indexOf('=');
      if (eq === -1) out.set(item, '');
      else out.set(item.slice(0, eq), item.slice(eq + 1));
    }
  } else if (labels && typeof labels === 'object') {
    for (const [key, value] of Object.entries(labels as Record<string, unknown>)) {
      const text = asLabelText(value);
      if (text !== undefined) out.set(key, text);
    }
  }
  return out;
}

function resolveService(service: string, labels: Map<string, string>, entries: SenchoLabelEntry[]): SenchoServiceLabels {
  const resolved: SenchoServiceLabels = { links: [], order: null, hidden: false };
  const keys = [...labels.keys()].filter(isSenchoLabelKey).sort();
  const namedSeen = new Set<string>();
  const named: SenchoLink[] = [];
  const entry = (key: string, state: SenchoLabelState, definition: SenchoLabelId | null, reason?: string) => {
    entries.push({ service, key, state, definition, ...(reason ? { reason } : {}) });
  };

  for (const key of keys) {
    const def = findSenchoLabelDefinition(key);
    if (!def) {
      entry(key, 'unsupported', null, 'Sencho does not recognize this label.');
      continue;
    }
    const raw = labels.get(key) ?? '';
    if (def.id === 'url' || def.id === 'url-named') {
      const url = parseSenchoUrl(unescapeRenderedDollar(raw));
      if (!url.ok) {
        entry(key, 'invalid', def.id, url.reason);
        continue;
      }
      if (def.id === 'url') {
        resolved.links.push({ name: null, url: url.value });
        entry(key, 'active', def.id);
        continue;
      }
      const name = normalizeLinkName(key.slice(def.match.kind === 'prefix' ? def.match.prefix.length : 0));
      if (!name.ok) {
        entry(key, 'invalid', def.id, name.reason);
      } else if (namedSeen.has(name.value)) {
        entry(key, 'invalid', def.id, `Another label already defines the "${name.value}" link.`);
      } else {
        namedSeen.add(name.value);
        named.push({ name: name.value, url: url.value });
        entry(key, 'active', def.id);
      }
    } else if (def.id === 'order') {
      const order = parseSenchoInteger(raw);
      if (order.ok) {
        resolved.order = order.value;
        entry(key, 'active', def.id);
      } else {
        entry(key, 'invalid', def.id, order.reason);
      }
    } else {
      const hidden = parseSenchoBoolean(raw);
      if (hidden.ok) {
        resolved.hidden = hidden.value;
        entry(key, 'active', def.id);
      } else {
        entry(key, 'invalid', def.id, hidden.reason);
      }
    }
  }

  resolved.links.push(...named.sort((a, b) => compareText(a.name ?? '', b.name ?? '')));
  return resolved;
}

/** Code-unit comparison, so ordering never depends on the host locale. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Ordered services first (ascending, ties by name), then the rest by name. */
function presentationOrder(services: Record<string, SenchoServiceLabels>): string[] {
  const names = Object.keys(services);
  const byName = compareText;
  const ordered = names.filter(n => services[n].order !== null)
    .sort((a, b) => (services[a].order as number) - (services[b].order as number) || byName(a, b));
  const rest = names.filter(n => services[n].order === null).sort(byName);
  return [...ordered, ...rest];
}

/**
 * Resolve the `io.sencho.*` metadata of a rendered Compose model
 * (`docker compose config --format json`). Tolerant of missing fields; an
 * unusable model is reported unrenderable, never partially trusted.
 */
export function resolveSenchoLabels(rendered: unknown): SenchoLabelResolution {
  if (!rendered || typeof rendered !== 'object') return unrenderableSenchoLabels();
  const rawServices = (rendered as Record<string, unknown>).services;
  if (!rawServices || typeof rawServices !== 'object' || Array.isArray(rawServices)) return unrenderableSenchoLabels();

  const services = serviceMap<SenchoServiceLabels>();
  const entries: SenchoLabelEntry[] = [];
  for (const name of Object.keys(rawServices).sort()) {
    const svc = (rawServices as Record<string, unknown>)[name];
    const labels = svc && typeof svc === 'object' ? (svc as Record<string, unknown>).labels : undefined;
    services[name] = resolveService(name, labelMap(labels), entries);
  }
  return { renderable: true, services, entries, serviceOrder: presentationOrder(services) };
}

export type LabelBehaviorState = 'active' | 'invalid' | 'unsupported' | 'inert';

/** Every valid behavior state, as strings so a wire validator can test an untrusted value without a cast. */
export const VALID_LABEL_BEHAVIOR_STATES: ReadonlySet<string> = new Set<LabelBehaviorState>([
  'active', 'invalid', 'unsupported', 'inert',
]);

/** How the label audit annotates an `io.sencho.*` label. */
export interface LabelBehavior {
  state: LabelBehaviorState;
  reason?: string;
  summary?: string;
}

const INERT_REASON: Record<string, string> = {
  image: 'Set by the image, so Sencho does not act on it. Declare it in the Compose file instead.',
  runtime: 'Present only on the running container, so Sencho does not act on it. Declare it in the Compose file instead.',
  unknown: 'Its origin is unknown, so Sencho does not act on it.',
  unrendered: 'Compose could not be rendered, so Sencho does not act on Sencho labels.',
};

/** Annotation for an `io.sencho.*` label that is not read from the rendered Compose model. */
export function inertLabelBehavior(key: string, source: string, renderable: boolean): LabelBehavior | undefined {
  if (!isSenchoLabelKey(key)) return undefined;
  if (!renderable) return { state: 'inert', reason: INERT_REASON.unrendered };
  return { state: 'inert', reason: INERT_REASON[source] ?? INERT_REASON.unknown };
}

/** Annotation for an `io.sencho.*` label declared on a rendered service. */
export function declaredLabelBehavior(
  resolution: SenchoLabelResolution,
  service: string,
  key: string,
): LabelBehavior | undefined {
  if (!isSenchoLabelKey(key)) return undefined;
  if (!resolution.renderable) return { state: 'inert', reason: INERT_REASON.unrendered };
  const found = resolution.entries.find(e => e.service === service && e.key === key);
  if (!found) return undefined;
  const summary = found.definition
    ? SENCHO_LABEL_DEFINITIONS.find(d => d.id === found.definition)?.summary
    : undefined;
  return { state: found.state, ...(found.reason ? { reason: found.reason } : {}), ...(summary ? { summary } : {}) };
}
