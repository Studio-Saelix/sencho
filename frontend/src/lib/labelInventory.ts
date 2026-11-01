import { DEPLOYED_TRUSTED_LABEL_KEYS, type SenchoLabelState } from './senchoLabels';

export type LabelSource = 'compose' | 'runtime' | 'image' | 'compose-system' | 'unknown';

export type LabelBehaviorState = SenchoLabelState | 'inert';

/** Whether Sencho acts on an `io.sencho.*` label. Absent for every other label and on older nodes. */
export interface LabelBehavior {
  state: LabelBehaviorState;
  reason?: string;
  summary?: string;
}

export interface LabelValue {
  key: string;
  value: string;
  source: LabelSource;
  redacted?: boolean;
  behavior?: LabelBehavior;
}

export interface ContainerLabelRow {
  id: string;
  name: string;
  stack: string | null;
  service: string | null;
  state: string;
  labels: LabelValue[];
}

export interface LabelIndexContainerRef {
  id: string;
  name: string;
  stack: string | null;
  service: string | null;
  nodeId?: number;
  nodeName?: string;
}

export interface LabelIndexRow {
  key: string;
  value: string;
  redacted?: boolean;
  source: LabelSource;
  behavior?: LabelBehavior;
  containers: LabelIndexContainerRef[];
}

export interface FleetLabelInventoryResponse {
  nodes: Array<{
    nodeId: number;
    nodeName: string;
    status: 'ok' | 'error';
    inventory: {
      nodeId: number;
      containers: ContainerLabelRow[];
      byLabel: LabelIndexRow[];
      partial: boolean;
      generatedAt: number;
    } | null;
    error: string | null;
  }>;
  aggregatedByLabel: LabelIndexRow[];
  nodeErrors: Record<number, string>;
  generatedAt: number;
}

export interface StackLabelReplica {
  id: string;
  name: string;
  state: string;
  runtimeLabels: LabelValue[];
  onlyInCompose: string[];
  onlyOnContainer: string[];
  inBoth: string[];
  // Optional so older nodes (pre-provenance) still typecheck during mixed-version operation.
  changed?: string[];
  inspectFailed?: boolean;
}

export interface StackServiceLabelRow {
  service: string;
  declaredLabels: LabelValue[];
  replicas: StackLabelReplica[];
}

export interface StackLabelInventory {
  stackName: string;
  renderable: boolean;
  services: StackServiceLabelRow[];
  // Optional so older nodes still typecheck during mixed-version operation.
  partial?: boolean;
  generatedAt: number;
}

export const BEHAVIOR_LABELS: Record<LabelBehaviorState, string> = {
  active: 'Active',
  invalid: 'Ignored',
  unsupported: 'Unsupported',
  inert: 'Inert',
};

export const SENCHO_LABELS_NODE_COPY =
  'This node does not apply io.sencho.* labels. Update the node to use them.';

export const SENCHO_LABEL_NOT_REPORTED_COPY =
  'This node does not report whether Sencho acts on this label.';

const SENCHO_NAMESPACE = 'io.sencho.';
const UNREADABLE_BEHAVIOR_REASON = 'The node reported a label status this version of Sencho cannot read.';
const MAX_BEHAVIOR_TEXT = 240;

export function isSenchoLabelKey(key: string): boolean {
  return key.startsWith(SENCHO_NAMESPACE);
}

/**
 * Rebuild a node's `behavior` field by field before it reaches the screen. Absent
 * stays absent (an older node). Anything unreadable becomes `unsupported` with a
 * fixed reason. Only the declared Compose copy of a presentation label, or a
 * deployed copy of the protective infrastructure label, keeps the reported state;
 * everything else is inert, so one wrong answer neither crashes a row nor shows
 * an unearned Active.
 */
export function readLabelBehavior(source: LabelSource, key: string, raw: unknown): LabelBehavior | undefined {
  if (raw === undefined) return undefined;
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  const state = o && typeof o.state === 'string' && Object.prototype.hasOwnProperty.call(BEHAVIOR_LABELS, o.state)
    ? o.state as LabelBehaviorState
    : null;
  if (!o || !state || (o.reason !== undefined && typeof o.reason !== 'string') || (o.summary !== undefined && typeof o.summary !== 'string')) {
    return { state: 'unsupported', reason: UNREADABLE_BEHAVIOR_REASON };
  }
  const reason = typeof o.reason === 'string' ? o.reason.slice(0, MAX_BEHAVIOR_TEXT) : undefined;
  const summary = typeof o.summary === 'string' ? o.summary.slice(0, MAX_BEHAVIOR_TEXT) : undefined;
  const trustsDeployedCopy = DEPLOYED_TRUSTED_LABEL_KEYS.includes(key);
  return {
    state: source === 'compose' || trustsDeployedCopy ? state : 'inert',
    ...(reason ? { reason } : {}),
    ...(summary ? { summary } : {}),
  };
}

function readLabelValues(labels: LabelValue[]): LabelValue[] {
  return labels.map(({ behavior, ...rest }) => {
    const read = readLabelBehavior(rest.source, rest.key, behavior);
    return read ? { ...rest, behavior: read } : rest;
  });
}

/** A stack inventory with every `behavior` read defensively. The stack route is proxied to the node unchecked. */
export function withReadBehaviors(inventory: StackLabelInventory): StackLabelInventory {
  return {
    ...inventory,
    services: inventory.services.map(svc => ({
      ...svc,
      declaredLabels: readLabelValues(svc.declaredLabels),
      replicas: svc.replicas.map(rep => ({ ...rep, runtimeLabels: readLabelValues(rep.runtimeLabels) })),
    })),
  };
}

export const LABEL_DISAMBIGUATION_COPY =
  'Docker labels are metadata declared on Compose services or attached to running containers. Labels in the io.sencho.* namespace, when declared in the Compose file, tell Sencho how to present a service. They are different from Sencho Stack Labels used for organizing stacks and Node Labels used for Blueprint placement.';

export const SOURCE_LABELS: Record<LabelSource, string> = {
  compose: 'Declared in Compose',
  runtime: 'Present at runtime',
  image: 'Image',
  'compose-system': 'Docker Compose system label',
  unknown: 'Unknown',
};

/** Concise facet-chip labels (concept-aligned with SOURCE_LABELS, not a rename of the badges). */
export const SOURCE_FACET_LABELS: Record<LabelSource, string> = {
  compose: 'Compose File',
  runtime: 'Runtime',
  image: 'Image',
  'compose-system': 'System',
  unknown: 'Unknown',
};

/** Stable display order for source facets. */
const SOURCE_ORDER: LabelSource[] = ['compose', 'image', 'runtime', 'compose-system', 'unknown'];

/** The distinct sources present, in stable display order, for building data-driven facet rows. */
export function sourcesPresent(sources: Iterable<LabelSource>): LabelSource[] {
  const present = new Set(sources);
  return SOURCE_ORDER.filter(s => present.has(s));
}

/** Case-insensitive substring match across a variable list of fields; empty query matches all. */
export function matchesSearch(query: string, ...parts: (string | null | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return parts.some(p => (p ?? '').toLowerCase().includes(q));
}
