/**
 * Per-node and per-stack Docker/Compose label inventory with provenance and
 * optional value redaction for secret-like keys.
 */

import { ComposeService } from './ComposeService';
import DockerController from './DockerController';
import { redactLabelValue } from '../helpers/labelValueRedaction';

export type LabelSource = 'compose' | 'runtime' | 'image' | 'compose-system' | 'unknown';

export interface LabelValue {
  key: string;
  value: string;
  source: LabelSource;
  redacted?: boolean;
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
  containers: LabelIndexContainerRef[];
}

export interface NodeLabelInventory {
  nodeId: number;
  containers: ContainerLabelRow[];
  byLabel: LabelIndexRow[];
  partial: boolean;
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
  generatedAt: number;
}

export interface LabelInventoryOptions {
  revealSecrets?: boolean;
}

const INSPECT_CONCURRENCY = 8;
const COMPOSE_SYSTEM_PREFIX = 'com.docker.compose.';

function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

function runtimeSourceForKey(key: string): LabelSource {
  return key.startsWith(COMPOSE_SYSTEM_PREFIX) ? 'compose-system' : 'runtime';
}

function parseLabelsMap(labels: unknown): Record<string, string> {
  if (Array.isArray(labels)) {
    const out: Record<string, string> = {};
    for (const entry of labels) {
      const raw = str(entry);
      if (!raw) continue;
      const eq = raw.indexOf('=');
      if (eq === -1) {
        out[raw] = '';
      } else {
        out[raw.slice(0, eq)] = raw.slice(eq + 1);
      }
    }
    return out;
  }
  if (labels && typeof labels === 'object') {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(labels as Record<string, unknown>)) {
      const val = str(v);
      if (val !== undefined) out[k] = val;
    }
    return out;
  }
  return {};
}

function toLabelValue(
  key: string,
  value: string,
  source: LabelSource,
  revealSecrets: boolean,
): LabelValue {
  const redacted = redactLabelValue(key, value, revealSecrets);
  return { key, value: redacted.value, source, ...(redacted.redacted ? { redacted: true } : {}) };
}

function stripContainerName(names: string[] | undefined): string {
  const first = names?.[0];
  if (!first) return '';
  return first.replace(/^\//, '');
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

function buildByLabelIndex(
  containers: ContainerLabelRow[],
  nodeId?: number,
  nodeName?: string,
): LabelIndexRow[] {
  const map = new Map<string, LabelIndexRow>();
  for (const container of containers) {
    for (const label of container.labels) {
      const mapKey = `${label.key}\0${label.value}`;
      let row = map.get(mapKey);
      if (!row) {
        row = {
          key: label.key,
          value: label.value,
          source: label.source,
          ...(label.redacted ? { redacted: true } : {}),
          containers: [],
        };
        map.set(mapKey, row);
      }
      row.containers.push({
        id: container.id,
        name: container.name,
        stack: container.stack,
        service: container.service,
        ...(nodeId !== undefined ? { nodeId } : {}),
        ...(nodeName !== undefined ? { nodeName } : {}),
      });
    }
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key) || a.value.localeCompare(b.value));
}

function reconcileKeys(
  declared: Record<string, string>,
  runtime: Record<string, string>,
): { onlyInCompose: string[]; onlyOnContainer: string[]; inBoth: string[] } {
  const declaredKeys = new Set(Object.keys(declared));
  const runtimeKeys = new Set(Object.keys(runtime));
  const onlyInCompose: string[] = [];
  const onlyOnContainer: string[] = [];
  const inBoth: string[] = [];
  for (const k of declaredKeys) {
    if (runtimeKeys.has(k)) inBoth.push(k);
    else onlyInCompose.push(k);
  }
  for (const k of runtimeKeys) {
    if (!declaredKeys.has(k)) onlyOnContainer.push(k);
  }
  onlyInCompose.sort();
  onlyOnContainer.sort();
  inBoth.sort();
  return { onlyInCompose, onlyOnContainer, inBoth };
}

/** Node-wide Docker label inventory for fleet and system routes. */
export async function buildNodeLabelInventory(
  nodeId: number,
  options: LabelInventoryOptions = {},
): Promise<NodeLabelInventory> {
  const revealSecrets = options.revealSecrets === true;
  const docker = DockerController.getInstance(nodeId);
  const rows = await docker.listContainersForLabelInventory();

  const containers: ContainerLabelRow[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    stack: row.stack,
    service: row.service,
    state: row.state,
    labels: Object.entries(row.labels).map(([key, value]) =>
      toLabelValue(key, value, runtimeSourceForKey(key), revealSecrets),
    ).sort((a, b) => a.key.localeCompare(b.key)),
  }));

  return {
    nodeId,
    containers,
    byLabel: buildByLabelIndex(containers),
    partial: rows.some(r => r.inspectFailed),
    generatedAt: Date.now(),
  };
}

/** Per-stack declared vs runtime label reconciliation for Stack Anatomy. */
export async function buildStackLabelInventory(
  nodeId: number,
  stackName: string,
  options: LabelInventoryOptions = {},
): Promise<StackLabelInventory> {
  const revealSecrets = options.revealSecrets === true;
  const result = await ComposeService.getInstance(nodeId).renderConfig(stackName);
  let renderable = false;
  const declaredByService = new Map<string, Record<string, string>>();

  if (result.rendered !== null) {
    try {
      const parsed = JSON.parse(result.rendered) as { services?: Record<string, { labels?: unknown }> };
      for (const [serviceName, svc] of Object.entries(parsed.services ?? {})) {
        declaredByService.set(serviceName, parseLabelsMap(svc.labels));
      }
      renderable = true;
    } catch {
      renderable = false;
    }
  }

  const docker = DockerController.getInstance(nodeId);
  const stackContainers = await docker.getContainersByStack(stackName) as Array<{ Id?: string; Names?: string[]; State?: string; Service?: string }>;
  const inspected = await mapWithConcurrency(stackContainers, INSPECT_CONCURRENCY, async (c) => {
    const id = c.Id ?? '';
    const name = stripContainerName(c.Names);
    const state = c.State ?? 'unknown';
    const service = c.Service ?? null;
    const labels = id ? await docker.inspectContainerLabels(id) : {};
    return { id, name, state, service, labels };
  });

  const replicasByService = new Map<string, typeof inspected>();
  for (const replica of inspected) {
    const svc = replica.service ?? '_unknown';
    const list = replicasByService.get(svc) ?? [];
    list.push(replica);
    replicasByService.set(svc, list);
  }

  const serviceNames = new Set<string>([
    ...declaredByService.keys(),
    ...replicasByService.keys(),
  ]);
  serviceNames.delete('_unknown');

  const services: StackServiceLabelRow[] = [...serviceNames].sort().map((service) => {
    const declared = declaredByService.get(service) ?? {};
    const declaredLabels = Object.entries(declared)
      .map(([key, value]) => toLabelValue(key, value, 'compose', revealSecrets))
      .sort((a, b) => a.key.localeCompare(b.key));

    const replicas = (replicasByService.get(service) ?? []).map((rep) => {
      const runtimeLabels = Object.entries(rep.labels)
        .map(([key, value]) => toLabelValue(key, value, runtimeSourceForKey(key), revealSecrets))
        .sort((a, b) => a.key.localeCompare(b.key));
      const runtimeMap = Object.fromEntries(Object.entries(rep.labels));
      const { onlyInCompose, onlyOnContainer, inBoth } = reconcileKeys(declared, runtimeMap);
      return {
        id: rep.id,
        name: rep.name,
        state: rep.state,
        runtimeLabels,
        onlyInCompose,
        onlyOnContainer,
        inBoth,
      };
    });

    return { service, declaredLabels, replicas };
  });

  return {
    stackName,
    renderable,
    services,
    generatedAt: Date.now(),
  };
}
