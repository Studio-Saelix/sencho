/**
 * The `io.sencho.*` Compose label contract: one typed registry of every label
 * Sencho reads, and a resolver that turns a successfully rendered Compose model
 * into the active metadata. Docker owns `com.docker.compose.*`; this namespace
 * is Sencho's and is the only public one.
 *
 * Trust rule: only labels declared on a service of the rendered, authored
 * Compose model can become active. Image, runtime-only, and unknown-provenance
 * labels stay visible in the label audit but are inert (`deployedCopyBehavior`).
 * A model that did not render yields no metadata at all
 * (`unrenderableSenchoLabels`), never a guess from runtime state. The one
 * exception is `io.sencho.infrastructure` (`trust: 'compose-or-deployed'`): the
 * Docker endpoint guard reads it from deployed containers too, because a copy
 * there can only add protection.
 *
 * Sencho also stamps a few keys on containers it creates. Those are listed in
 * `SENCHO_MANAGED_LABELS`, never read as configuration, and never documented as
 * user-settable; a backend test fails if a Sencho label key exists outside these
 * two lists.
 *
 * Diagnostics carry the label key and a fixed reason, never the value: a value
 * can be an interpolated secret, and the audit already shows declared values
 * under its own redaction rules.
 */

export const SENCHO_LABEL_NAMESPACE = 'io.sencho.';

/** The application link label; the Compose editor and the URL pipeline key off it. */
export const SENCHO_URL_LABEL = 'io.sencho.url';

/** The protective label the Docker endpoint guard reads from the file and from deployed containers. */
export const SENCHO_INFRASTRUCTURE_LABEL = 'io.sencho.infrastructure';

/** Per-service image-refresh eligibility. Read by the one update-policy evaluator. */
export const SENCHO_UPDATE_LABEL = 'io.sencho.update';

/** Per-service notification routing key. Read by the one routing-key resolver. */
export const SENCHO_NOTIFY_ROUTE_LABEL = 'io.sencho.notify.route';

/** Capability advertised by nodes that resolve this contract. Older nodes degrade as a whole. */
export const SENCHO_LABELS_CAPABILITY = 'sencho-labels-v1';

/**
 * Capability advertised by nodes that evaluate the behavioral labels
 * (`io.sencho.update`, `io.sencho.notify.route`). Whether a node evaluates them
 * comes from this flag, never from the fields being absent in its answer.
 */
export const SENCHO_LABEL_POLICY_CAPABILITY = 'sencho-label-policy-v1';

export type SenchoLabelId = 'url' | 'url-named' | 'order' | 'hidden' | 'infrastructure' | 'update' | 'notify-route';
export type SenchoLabelEffect = 'presentation' | 'operations';

/** The accepted values of the update-eligibility label. */
export type UpdatePolicyLabel = 'auto' | 'manual' | 'disabled';

/**
 * Where a label may be read from. `compose` is the rendered, authored model;
 * `compose-or-deployed` also honors a copy on a deployed container, which is
 * only ever protective.
 */
export type SenchoLabelTrust = 'compose' | 'compose-or-deployed';

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Where a label on a running container came from; the label audit and the resolver share this vocabulary. */
export type LabelSource = 'compose' | 'runtime' | 'image' | 'compose-system' | 'unknown';

type ExactMatch = { kind: 'exact'; key: string };
type PrefixMatch = { kind: 'prefix'; prefix: string };

interface SenchoLabelDefinitionBase {
  /** Every current label is declared per Compose service and shared by all of its replicas. */
  scope: 'service';
  /** What an absent or invalid label means. */
  defaultBehavior: string;
  /** How competing sources resolve. */
  precedence: string;
  /** How duplicates and conflicting declarations resolve. */
  conflict: string;
  effect: SenchoLabelEffect;
  /** Where the label is read from; `compose-or-deployed` is the protective exception. */
  trust: SenchoLabelTrust;
  /**
   * What an invalid value does. `ignore-with-diagnostic` changes nothing;
   * `restrict-unattended` fails closed for unattended image refreshes while
   * leaving manual ones to the operator.
   */
  onInvalid: 'ignore-with-diagnostic' | 'restrict-unattended';
  minCapability: typeof SENCHO_LABELS_CAPABILITY | typeof SENCHO_LABEL_POLICY_CAPABILITY;
  summary: string;
  example: string;
}

/**
 * One entry per supported label. `parse` is the only place a raw value is
 * validated and normalized, so the resolver dispatches on the entry and a new
 * label cannot be added without declaring how its value is read.
 */
export type SenchoLabelDefinition =
  | (SenchoLabelDefinitionBase & { id: 'url'; match: ExactMatch; valueType: 'url'; parse: (raw: string) => ParseResult<string> })
  | (SenchoLabelDefinitionBase & { id: 'url-named'; match: PrefixMatch; valueType: 'url'; parse: (raw: string) => ParseResult<string> })
  | (SenchoLabelDefinitionBase & { id: 'order'; match: ExactMatch; valueType: 'integer'; parse: (raw: string) => ParseResult<number> })
  | (SenchoLabelDefinitionBase & { id: 'hidden'; match: ExactMatch; valueType: 'boolean'; parse: (raw: string) => ParseResult<boolean> })
  | (SenchoLabelDefinitionBase & { id: 'infrastructure'; match: ExactMatch; valueType: 'literal-true'; trust: 'compose-or-deployed'; effect: 'operations'; parse: (raw: string) => ParseResult<true> })
  | (SenchoLabelDefinitionBase & { id: 'update'; match: ExactMatch; valueType: 'enum'; effect: 'operations'; minCapability: typeof SENCHO_LABEL_POLICY_CAPABILITY; onInvalid: 'restrict-unattended'; parse: (raw: string) => ParseResult<UpdatePolicyLabel> })
  | (SenchoLabelDefinitionBase & { id: 'notify-route'; match: ExactMatch; valueType: 'routing-key'; effect: 'operations'; minCapability: typeof SENCHO_LABEL_POLICY_CAPABILITY; parse: (raw: string) => ParseResult<string> });

const MAX_URL_LENGTH = 2048;
const MAX_LINK_NAME_LENGTH = 32;
const LINK_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const INTEGER_PATTERN = /^[+-]?\d{1,9}$/;
// Spaces, C0/C1 controls, and invisible or direction-changing format characters
// (soft hyphen, zero-width and bidi marks, line and paragraph separators, BOM).
// The frontend validator carries the same set.
const UNSAFE_URL_CHARACTER = /[\u0000-\u0020\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/;

/** Compose writes a literal `$` as `$$` in rendered config. Undo that once. */
export function unescapeRenderedDollar(value: string): string {
  return value.replaceAll('$$', '$');
}

/** A literal http(s) URL with a host and no userinfo, or the reason it was refused. */
export function parseSenchoUrl(raw: string): ParseResult<string> {
  const value = raw.trim();
  if (!value) return { ok: false, reason: 'The value is empty.' };
  if (value.length > MAX_URL_LENGTH) return { ok: false, reason: 'The link is too long.' };
  if (UNSAFE_URL_CHARACTER.test(value)) return { ok: false, reason: 'The link contains spaces or control characters.' };
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
  // The raw check also catches an empty userinfo such as `https://:@host`, which URL normalizes away.
  if (parsed.username !== '' || parsed.password !== '' || /^https?:\/\/[^/?#]*@/i.test(value)) {
    return { ok: false, reason: 'The link must not contain a username or password.' };
  }
  if (!parsed.hostname) return { ok: false, reason: 'The link has no host.' };
  return { ok: true, value };
}

/** A link label value as it appears in rendered config: `$$` undone, then validated. */
export function parseSenchoUrlLabel(raw: string): ParseResult<string> {
  return parseSenchoUrl(unescapeRenderedDollar(raw));
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

/** The only accepted value of the protective label; case-sensitive, exactly as the Docker endpoint guard reads it. */
function parseSenchoLiteralTrue(raw: string): ParseResult<true> {
  // The reason never echoes the value; it matches the guard's advice, which is to fix the label before the stack is changed again.
  if (raw === 'true') return { ok: true, value: true };
  return { ok: false, reason: 'The only accepted value is true. Sencho refuses changes to this stack until it is fixed.' };
}

const UPDATE_POLICY_VALUES: readonly UpdatePolicyLabel[] = ['auto', 'manual', 'disabled'];

/**
 * The update-eligibility value, trimmed and case-insensitive. An unrecognized
 * value is not an error the operator can ignore: it restricts unattended image
 * refreshes, so a typo in a protective label can never cause an auto-update.
 * The reason never echoes the value.
 */
export function parseUpdatePolicy(raw: string): ParseResult<UpdatePolicyLabel> {
  const value = raw.trim().toLowerCase();
  const match = UPDATE_POLICY_VALUES.find(candidate => candidate === value);
  if (match) return { ok: true, value: match };
  return {
    ok: false,
    reason: 'Use auto, manual, or disabled. Sencho skips unattended updates for this stack until the value is fixed.',
  };
}

const MAX_ROUTING_KEY_LENGTH = 64;
const ROUTING_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
// A routing key is a short team or environment name, never an address. `:`, `/`
// and `@` are the three shapes a URL, host:port, or user@host carries, so a
// value with any of them is refused before the character class is applied.
const ROUTING_KEY_ADDRESS_SHAPE = /[:/@\s]/;

/**
 * A notification routing key, trimmed and lowercased. The format rejects
 * URL- and address-shaped values so a Compose label cannot smuggle a
 * destination or a credential into a routing rule. It cannot recognize every
 * secret; keys are shown in plain text in the UI and in history.
 */
export function parseRouteKey(raw: string): ParseResult<string> {
  const value = raw.trim().toLowerCase();
  if (!value) return { ok: false, reason: 'Use a routing key such as production.' };
  if (ROUTING_KEY_ADDRESS_SHAPE.test(value)) {
    return { ok: false, reason: 'Use a routing key such as production, not a URL or address.' };
  }
  if (value.length > MAX_ROUTING_KEY_LENGTH) {
    return { ok: false, reason: `Routing keys are at most ${MAX_ROUTING_KEY_LENGTH} characters.` };
  }
  if (!ROUTING_KEY_PATTERN.test(value)) {
    return {
      ok: false,
      reason: 'Use lowercase letters, digits, dots, hyphens, and underscores, starting and ending with a letter or digit.',
    };
  }
  return { ok: true, value };
}

/**
 * Keys Sencho stamps on containers it creates (mesh sidecars, endpoint-provider
 * helpers, and the operation that owns them). They are never configuration: a
 * Compose declaration is reserved, and a copy on a container is Sencho's own.
 */
export const SENCHO_MANAGED_LABELS: readonly string[] = [
  'io.sencho.mesh',
  'io.sencho.helper',
  'io.sencho.operation',
];

const MANAGED_LABELS: ReadonlySet<string> = new Set(SENCHO_MANAGED_LABELS);

/** True for a key in `SENCHO_MANAGED_LABELS`, which Sencho sets and nobody configures. */
export function isManagedSenchoLabel(key: string): boolean {
  return MANAGED_LABELS.has(key);
}

export const MANAGED_LABEL_DECLARED_REASON = 'Reserved for containers Sencho creates; it has no effect in a Compose file.';
export const MANAGED_LABEL_DEPLOYED_REASON = 'Set by Sencho on a container it manages.';

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

export const SENCHO_LABEL_DEFINITIONS: readonly SenchoLabelDefinition[] = [
  {
    id: 'url',
    match: { kind: 'exact', key: SENCHO_URL_LABEL },
    scope: 'service',
    valueType: 'url',
    parse: parseSenchoUrlLabel,
    defaultBehavior: 'No configured link; a published port opens the generated host and port.',
    precedence: 'A valid configured link wins over any address Sencho discovers about the service, which wins over the generated published-port link. It replaces that link for the service, unless Sencho cannot tell which service owns the port.',
    conflict: 'The merged Compose model decides the value; later files replace earlier ones.',
    effect: 'presentation',
    trust: 'compose',
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
    parse: parseSenchoUrlLabel,
    defaultBehavior: 'No extra link.',
    precedence: 'Named links are listed after the application link, sorted by name; they never replace a port link.',
    conflict: 'Names are lowercased; when two keys normalize to one name, the key that sorts first is kept and the other is ignored.',
    effect: 'presentation',
    trust: 'compose',
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
    parse: parseSenchoInteger,
    defaultBehavior: 'The service sorts after ordered services, by name.',
    precedence: 'Services with a valid order come first, ascending; services with the same number sort by name among themselves, and services without a valid order follow, sorted by name.',
    conflict: 'The merged Compose model decides the value. Equal values tie-break by service name.',
    effect: 'presentation',
    trust: 'compose',
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
    parse: parseSenchoBoolean,
    defaultBehavior: 'The service is listed.',
    precedence: 'Hides the service from default lists only; health, security, drift, updates, and lifecycle still include it.',
    conflict: 'The merged Compose model decides the value.',
    effect: 'presentation',
    trust: 'compose',
    onInvalid: 'ignore-with-diagnostic',
    minCapability: SENCHO_LABELS_CAPABILITY,
    summary: 'Collapses a helper service out of default lists.',
    example: 'io.sencho.hidden: "true"',
  },
  {
    id: 'infrastructure',
    match: { kind: 'exact', key: SENCHO_INFRASTRUCTURE_LABEL },
    scope: 'service',
    valueType: 'literal-true',
    parse: parseSenchoLiteralTrue,
    defaultBehavior: 'Sencho detects the container that carries its Docker connection on its own; the label only adds protection.',
    precedence: 'Protective only: a copy on a deployed container counts even when the Compose file no longer sets it, and a marked service is protected whatever the deployed copy says.',
    conflict: 'A second declaration cannot loosen it; one value other than true refuses changes to the stack until the label is fixed.',
    effect: 'operations',
    trust: 'compose-or-deployed',
    onInvalid: 'ignore-with-diagnostic',
    minCapability: SENCHO_LABELS_CAPABILITY,
    summary: 'Marks the service that carries this node\'s Docker connection.',
    example: 'io.sencho.infrastructure: "true"',
  },
  {
    id: 'update',
    match: { kind: 'exact', key: SENCHO_UPDATE_LABEL },
    scope: 'service',
    valueType: 'enum',
    parse: parseUpdatePolicy,
    defaultBehavior: 'Updates are allowed for this service, manual and unattended.',
    precedence: 'A whole-stack image refresh is refused when any rendered service is not eligible; Sencho never narrows the operation to the eligible services.',
    conflict: 'The merged Compose model decides the value. An unrecognized value restricts unattended updates and allows manual ones.',
    effect: 'operations',
    trust: 'compose',
    onInvalid: 'restrict-unattended',
    minCapability: SENCHO_LABEL_POLICY_CAPABILITY,
    summary: 'Whether Sencho may refresh this service\'s image.',
    example: 'io.sencho.update: manual',
  },
  {
    id: 'notify-route',
    match: { kind: 'exact', key: SENCHO_NOTIFY_ROUTE_LABEL },
    scope: 'service',
    valueType: 'routing-key',
    parse: parseRouteKey,
    defaultBehavior: 'Alerts from this service are not matched by a routing-key filter.',
    precedence: 'A stack-level alert carries the union of its services\' keys, and every routing rule whose keys intersect fires.',
    conflict: 'The merged Compose model decides the value. Keys are lowercased.',
    effect: 'operations',
    trust: 'compose',
    onInvalid: 'ignore-with-diagnostic',
    minCapability: SENCHO_LABEL_POLICY_CAPABILITY,
    summary: 'Routing key that notification rules match for this service.',
    example: 'io.sencho.notify.route: production',
  },
];

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
  /**
   * null: the label is absent. `invalid`: declared with an unrecognized value,
   * which restricts unattended image refreshes and allows manual ones.
   */
  update: UpdatePolicyLabel | 'invalid' | null;
  /** The service's notification routing key, or null when it declares none. */
  notifyRoute: string | null;
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

/**
 * Either the model did not render, so nothing is active and the audit says why,
 * or it rendered and every service has its metadata. Presentation order is not
 * stored: it follows from each service's `order` and name.
 */
export type SenchoLabelResolution =
  | { renderable: false }
  | {
    renderable: true;
    /** Active metadata for every rendered service. */
    services: Record<string, SenchoServiceLabels>;
    /** Every authored `io.sencho.*` label with its state, by service then key. */
    entries: SenchoLabelEntry[];
  };

/** Service-keyed maps use a null prototype so a service named `constructor` cannot read an inherited value. */
function serviceMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

export function unrenderableSenchoLabels(): SenchoLabelResolution {
  return { renderable: false };
}

function asLabelText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/**
 * The one reader of a rendered service's `labels`, in map or `key=value` list
 * syntax. The resolver and the label audit both go through it, so they cannot
 * disagree about which labels a service declares. In a list the last duplicate
 * wins, as in Compose.
 */
export function parseLabelEntries(labels: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (Array.isArray(labels)) {
    for (const item of labels) {
      const raw = asLabelText(item);
      if (!raw) continue;
      const eq = raw.indexOf('=');
      if (eq === -1) out.set(raw, '');
      else out.set(raw.slice(0, eq), raw.slice(eq + 1));
    }
  } else if (labels && typeof labels === 'object') {
    for (const [key, value] of Object.entries(labels as Record<string, unknown>)) {
      const text = asLabelText(value);
      if (text !== undefined) out.set(key, text);
    }
  }
  return out;
}

interface ServiceDraft {
  resolved: SenchoServiceLabels;
  named: SenchoLink[];
  namedSeen: Set<string>;
}

type EntryWriter = (state: SenchoLabelState, reason?: string) => void;

/** Apply one label to the draft. The switch is exhaustive over the registry. */
function applyLabel(def: SenchoLabelDefinition, key: string, raw: string, draft: ServiceDraft, entry: EntryWriter): void {
  switch (def.id) {
    case 'url': {
      const url = def.parse(raw);
      if (!url.ok) return entry('invalid', url.reason);
      draft.resolved.links.push({ name: null, url: url.value });
      return entry('active');
    }
    case 'url-named': {
      const url = def.parse(raw);
      if (!url.ok) return entry('invalid', url.reason);
      const name = normalizeLinkName(key.slice(def.match.prefix.length));
      if (!name.ok) return entry('invalid', name.reason);
      if (draft.namedSeen.has(name.value)) return entry('invalid', `Another label already defines the "${name.value}" link.`);
      draft.namedSeen.add(name.value);
      draft.named.push({ name: name.value, url: url.value });
      return entry('active');
    }
    case 'order': {
      const order = def.parse(raw);
      if (!order.ok) return entry('invalid', order.reason);
      draft.resolved.order = order.value;
      return entry('active');
    }
    case 'hidden': {
      const hidden = def.parse(raw);
      if (!hidden.ok) return entry('invalid', hidden.reason);
      draft.resolved.hidden = hidden.value;
      return entry('active');
    }
    case 'infrastructure': {
      // Protective only: it is not part of the presentation metadata, so it records a state and changes nothing here.
      const marked = def.parse(raw);
      return marked.ok ? entry('active') : entry('invalid', marked.reason);
    }
    case 'update': {
      // An unrecognized value is recorded as `invalid`, never as absent: the
      // policy evaluator must be able to fail closed on it.
      const policy = def.parse(raw);
      if (!policy.ok) {
        draft.resolved.update = 'invalid';
        return entry('invalid', policy.reason);
      }
      draft.resolved.update = policy.value;
      return entry('active');
    }
    case 'notify-route': {
      const key = def.parse(raw);
      if (!key.ok) return entry('invalid', key.reason);
      draft.resolved.notifyRoute = key.value;
      return entry('active');
    }
    default: {
      // Compile-time exhaustiveness: a new registry entry must get a case above.
      const unhandled: never = def;
      return unhandled;
    }
  }
}

function resolveService(service: string, labels: Map<string, string>, entries: SenchoLabelEntry[]): SenchoServiceLabels {
  const draft: ServiceDraft = {
    resolved: { links: [], order: null, hidden: false, update: null, notifyRoute: null },
    named: [],
    namedSeen: new Set(),
  };
  for (const key of [...labels.keys()].filter(isSenchoLabelKey).sort()) {
    const def = findSenchoLabelDefinition(key);
    const write: EntryWriter = (state, reason) => {
      entries.push({ service, key, state, definition: def?.id ?? null, ...(reason ? { reason } : {}) });
    };
    if (isManagedSenchoLabel(key)) write('invalid', MANAGED_LABEL_DECLARED_REASON);
    else if (!def) write('unsupported', 'Sencho does not recognize this label.');
    else applyLabel(def, key, labels.get(key) ?? '', draft, write);
  }
  draft.resolved.links.push(...draft.named.sort((a, b) => compareText(a.name ?? '', b.name ?? '')));
  return draft.resolved;
}

/** Code-unit comparison, so ordering never depends on the host locale. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
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
    services[name] = resolveService(name, parseLabelEntries(labels), entries);
  }
  return { renderable: true, services, entries };
}

export type LabelBehaviorState = SenchoLabelState | 'inert';

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

/** Why a label that is not read from the rendered Compose model has no effect, or how a deployed copy counts. */
export type InertOrigin = 'image' | 'runtime' | 'stale-runtime' | 'unknown' | 'unrendered' | 'node-wide' | 'sencho-managed';

const INERT_REASON: Record<InertOrigin, string> = {
  image: 'Set by the image, so Sencho does not act on it. Declare it in the Compose file instead.',
  runtime: 'Present only on the running container, so Sencho does not act on it. Declare it in the Compose file instead.',
  'stale-runtime': 'The running container has a different value than the Compose file. Sencho acts on the Compose file; recreate the container to apply it.',
  unknown: 'Its origin is unknown, so Sencho does not act on it.',
  unrendered: 'Compose could not be rendered, so Sencho does not act on Sencho labels.',
  'node-wide': 'Sencho reads io.sencho.* labels from a stack\'s Compose file, not from running containers. Open the stack\'s Compose Labels view for their status.',
  'sencho-managed': MANAGED_LABEL_DEPLOYED_REASON,
};

const DEPLOYED_INFRASTRUCTURE_ACTIVE_REASON =
  'Read from the deployed container, so it protects that container: every operation that would stop or recreate it is refused until it is recreated without the label.';
const DEPLOYED_INFRASTRUCTURE_INVALID_REASON =
  'The only accepted value is true. The container is protected anyway until it is recreated without the label.';

/** The inert origin of a runtime-side label, given where the audit attributed it. */
export function inertOriginOf(source: LabelSource, declaredHasKey: boolean): InertOrigin {
  if (source === 'image') return 'image';
  if (source === 'runtime') return declaredHasKey ? 'stale-runtime' : 'runtime';
  return 'unknown';
}

/** Whether a deployed copy of this key is honored, which is the registry's `compose-or-deployed` exception. */
export function isDeployedTrustedLabel(key: string): boolean {
  return !isManagedSenchoLabel(key) && findSenchoLabelDefinition(key)?.trust === 'compose-or-deployed';
}

/**
 * Annotation for an `io.sencho.*` label found on a deployed container or image.
 * A key Sencho itself stamps is inert with its own reason. A `compose-or-deployed`
 * key (the infrastructure label) keeps the state the Docker endpoint guard gives
 * it, because a deployed copy is honored. Every other key is inert.
 */
export function deployedCopyBehavior(key: string, value: string, origin: InertOrigin): LabelBehavior | undefined {
  if (!isSenchoLabelKey(key)) return undefined;
  if (isManagedSenchoLabel(key)) return { state: 'inert', reason: MANAGED_LABEL_DEPLOYED_REASON };
  const def = findSenchoLabelDefinition(key);
  if (def?.trust === 'compose-or-deployed') {
    const parsed = def.parse(value);
    return {
      state: parsed.ok ? 'active' : 'invalid',
      reason: parsed.ok ? DEPLOYED_INFRASTRUCTURE_ACTIVE_REASON : DEPLOYED_INFRASTRUCTURE_INVALID_REASON,
      summary: def.summary,
    };
  }
  return { state: 'inert', reason: INERT_REASON[origin] };
}

type RenderedResolution = Extract<SenchoLabelResolution, { renderable: true }>;

const entryIndexes = new WeakMap<RenderedResolution, Map<string, SenchoLabelEntry>>();

function entryIndex(resolution: RenderedResolution): Map<string, SenchoLabelEntry> {
  let index = entryIndexes.get(resolution);
  if (!index) {
    index = new Map(resolution.entries.map(e => [`${e.service}\0${e.key}`, e]));
    entryIndexes.set(resolution, index);
  }
  return index;
}

/** Annotation for an `io.sencho.*` label declared on a rendered service. */
export function declaredLabelBehavior(
  resolution: SenchoLabelResolution,
  service: string,
  key: string,
): LabelBehavior | undefined {
  if (!isSenchoLabelKey(key)) return undefined;
  if (!resolution.renderable) return { state: 'inert', reason: INERT_REASON.unrendered };
  const found = entryIndex(resolution).get(`${service}\0${key}`);
  if (!found) return undefined;
  const summary = found.definition
    ? SENCHO_LABEL_DEFINITIONS.find(d => d.id === found.definition)?.summary
    : undefined;
  return { state: found.state, ...(found.reason ? { reason: found.reason } : {}), ...(summary ? { summary } : {}) };
}

const MAX_REMOTE_BEHAVIOR_TEXT = 240;
const UNREADABLE_BEHAVIOR_REASON = 'The node reported a label status this version of Sencho cannot read.';

function boundedText(value: unknown): string | undefined {
  return typeof value === 'string' ? value.slice(0, MAX_REMOTE_BEHAVIOR_TEXT) : undefined;
}

/** The inert origin a remote copy's source implies, for a reason the hub owns. */
function remoteOriginOf(source: LabelSource): InertOrigin {
  if (source === 'image') return 'image';
  if (source === 'runtime') return 'runtime';
  return 'unknown';
}

/**
 * Rebuild a remote node's `behavior` field by field. Absent stays absent (an
 * older node), and a label outside the namespace never carries one. A value this
 * version cannot read degrades to `unsupported` with a fixed reason instead of
 * failing the node's whole inventory. Only the declared Compose copy of a
 * presentation label can be anything but inert; the protective infrastructure
 * label keeps its reported state from a deployed copy too.
 *
 * A claim the hub does not honor is dropped with the hub's own reason, so a
 * remote's text can never describe a state the audit does not show. A node that
 * already reports inert keeps its own reason, which names the origin (an image,
 * a stale container) better than the hub can.
 */
export function sanitizeRemoteBehavior(source: LabelSource, key: string, raw: unknown): LabelBehavior | undefined {
  if (raw === undefined || !isSenchoLabelKey(key)) return undefined;
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  const state = o && typeof o.state === 'string' && VALID_LABEL_BEHAVIOR_STATES.has(o.state)
    ? o.state as LabelBehaviorState
    : null;
  if (!o || !state || (o.reason !== undefined && typeof o.reason !== 'string') || (o.summary !== undefined && typeof o.summary !== 'string')) {
    return { state: 'unsupported', reason: UNREADABLE_BEHAVIOR_REASON };
  }
  // The keys Sencho stamps on its own containers are never configuration, whatever a node reports.
  if (isManagedSenchoLabel(key)) {
    return source === 'compose'
      ? { state: 'invalid', reason: MANAGED_LABEL_DECLARED_REASON }
      : { state: 'inert', reason: MANAGED_LABEL_DEPLOYED_REASON };
  }
  const honored = source === 'compose' || isDeployedTrustedLabel(key);
  if (!honored && state !== 'inert') return { state: 'inert', reason: INERT_REASON[remoteOriginOf(source)] };
  const reason = boundedText(o.reason);
  const summary = boundedText(o.summary);
  return {
    state: honored ? state : 'inert',
    ...(reason ? { reason } : {}),
    ...(summary ? { summary } : {}),
  };
}

const BEHAVIOR_SEVERITY: Record<LabelBehaviorState, number> = { invalid: 3, unsupported: 2, inert: 1, active: 0 };

/** The behavior to keep when two nodes report the same label row: one that says something beats none, then the more severe. */
export function mergeLabelBehavior(a: LabelBehavior | undefined, b: LabelBehavior | undefined): LabelBehavior | undefined {
  if (!a) return b;
  if (!b) return a;
  return BEHAVIOR_SEVERITY[b.state] > BEHAVIOR_SEVERITY[a.state] ? b : a;
}
