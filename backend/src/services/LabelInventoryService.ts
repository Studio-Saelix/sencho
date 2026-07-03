/**
 * Per-node and per-stack Docker/Compose label inventory with provenance and
 * optional value redaction for secret-like keys.
 */

import { ComposeService } from './ComposeService';
import DockerController from './DockerController';
import { redactLabelValue } from '../helpers/labelValueRedaction';
import { sanitizeForLog } from '../utils/safeLog';

export type LabelSource = 'compose' | 'runtime' | 'image' | 'compose-system' | 'unknown';

/**
 * Every valid label source, typed as a set of strings so the wire validator can test an
 * untrusted `string` without a cast. The literals are `LabelSource` members, so the union
 * still documents the valid values.
 */
export const VALID_LABEL_SOURCES: ReadonlySet<string> = new Set<LabelSource>([
  'compose', 'runtime', 'image', 'compose-system', 'unknown',
]);

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
  /** Keys declared in Compose and present at runtime but with a different value. */
  changed: string[];
  /** Runtime labels could not be read for this replica; reconciliation is skipped. */
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
  /** A replica or its image could not be fully inspected; some provenance is unknown. */
  partial: boolean;
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

/**
 * Truthful provenance for a runtime label. Precedence: compose-system prefix, then
 * (stack path only) a Compose-declared key with the same value, then an exact image
 * label match, then plain runtime. When the image could not be inspected
 * (`imageLabels === null`) an otherwise-unattributable label is `unknown`, not `runtime`.
 */
function resolveLabelSource(
  key: string,
  value: string,
  imageLabels: Record<string, string> | null,
  declared?: Record<string, string>,
): LabelSource {
  if (key.startsWith(COMPOSE_SYSTEM_PREFIX)) return 'compose-system';
  if (declared && declared[key] === value) return 'compose';
  if (imageLabels) return imageLabels[key] === value ? 'image' : 'runtime';
  return 'unknown';
}

/**
 * Inspect each unique, non-empty image id once (deduped, bounded concurrency). Returns a
 * map from image id to its label map, or `null` for an image that could not be inspected,
 * and whether any inspection failed (so callers can mark the inventory partial).
 */
async function buildImageLabelMap(
  docker: DockerController,
  imageIds: string[],
): Promise<{ map: Map<string, Record<string, string> | null>; partial: boolean }> {
  const unique = [...new Set(imageIds.filter(id => id.length > 0))];
  const inspected = await mapWithConcurrency(unique, INSPECT_CONCURRENCY, async (imageId) => {
    const result = await docker.inspectImageLabels(imageId);
    return { imageId, labels: result ? result.labels : null };
  });
  const map = new Map<string, Record<string, string> | null>();
  let partial = false;
  for (const { imageId, labels } of inspected) {
    map.set(imageId, labels);
    if (labels === null) partial = true;
  }
  return { map, partial };
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
      const mapKey = `${label.key}\0${label.value}\0${label.source}`;
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
  return [...map.values()].sort((a, b) =>
    a.key.localeCompare(b.key) || a.value.localeCompare(b.value) || a.source.localeCompare(b.source));
}

function reconcileKeys(
  declared: Record<string, string>,
  runtime: Record<string, string>,
): { onlyInCompose: string[]; onlyOnContainer: string[]; inBoth: string[]; changed: string[] } {
  const runtimeKeys = new Set(Object.keys(runtime));
  const onlyInCompose: string[] = [];
  const onlyOnContainer: string[] = [];
  const inBoth: string[] = [];
  const changed: string[] = [];
  for (const k of Object.keys(declared)) {
    if (!runtimeKeys.has(k)) onlyInCompose.push(k);
    else if (declared[k] === runtime[k]) inBoth.push(k);
    else changed.push(k);
  }
  for (const k of runtimeKeys) {
    if (!(k in declared)) onlyOnContainer.push(k);
  }
  onlyInCompose.sort();
  onlyOnContainer.sort();
  inBoth.sort();
  changed.sort();
  return { onlyInCompose, onlyOnContainer, inBoth, changed };
}

/** Node-wide Docker label inventory for fleet and system routes. */
export async function buildNodeLabelInventory(
  nodeId: number,
  options: LabelInventoryOptions = {},
): Promise<NodeLabelInventory> {
  const revealSecrets = options.revealSecrets === true;
  const docker = DockerController.getInstance(nodeId);
  const rows = await docker.listContainersForLabelInventory();
  const { map: imageLabelMap, partial: imagePartial } = await buildImageLabelMap(docker, rows.map(r => r.imageId));

  let missingImage = false;
  const containers: ContainerLabelRow[] = rows.map((row) => {
    const imageLabels = row.imageId ? (imageLabelMap.get(row.imageId) ?? null) : null;
    if (!row.imageId) missingImage = true;
    return {
      id: row.id,
      name: row.name,
      stack: row.stack,
      service: row.service,
      state: row.state,
      labels: Object.entries(row.labels).map(([key, value]) =>
        toLabelValue(key, value, resolveLabelSource(key, value, imageLabels), revealSecrets),
      ).sort((a, b) => a.key.localeCompare(b.key)),
    };
  });

  return {
    nodeId,
    containers,
    byLabel: buildByLabelIndex(containers),
    partial: rows.some(r => r.inspectFailed) || imagePartial || missingImage,
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
  // A failed render leaves the declared map empty. Without the declared model we cannot
  // tell a Compose-declared label from a runtime one, so non-system runtime labels are
  // resolved to `unknown` and reconciliation is skipped rather than shown as false drift.
  // `renderable === false` (not `partial`) signals this to the UI; `partial` is reserved
  // for inspection failures so the two banners stay distinct.
  let renderFailed = false;
  const declaredByService = new Map<string, Record<string, string>>();

  if (result.rendered !== null) {
    try {
      const parsed = JSON.parse(result.rendered) as { services?: Record<string, { labels?: unknown }> };
      for (const [serviceName, svc] of Object.entries(parsed.services ?? {})) {
        declaredByService.set(serviceName, parseLabelsMap(svc.labels));
      }
      renderable = true;
    } catch (err) {
      console.error('[LabelInventory] Failed to parse rendered compose for stack %s:', sanitizeForLog(stackName), err);
      renderFailed = true;
    }
  } else {
    console.error('[LabelInventory] Compose render failed for stack %s (code %s): %s',
      sanitizeForLog(stackName), result.code, sanitizeForLog(result.stderr));
    renderFailed = true;
  }

  const docker = DockerController.getInstance(nodeId);
  const stackContainers = await docker.getContainersByStack(stackName) as Array<{ Id?: string; Names?: string[]; State?: string; Service?: string }>;
  const inspected = await mapWithConcurrency(stackContainers, INSPECT_CONCURRENCY, async (c) => {
    const id = c.Id ?? '';
    const name = stripContainerName(c.Names);
    const state = c.State ?? 'unknown';
    const service = c.Service ?? null;
    const result = id ? await docker.inspectContainerLabelsAndImage(id) : null;
    return { id, name, state, service, labels: result?.labels ?? {}, imageId: result?.imageId ?? '', inspectFailed: result === null };
  });

  const { map: imageLabelMap, partial: imagePartial } = await buildImageLabelMap(docker, inspected.map(r => r.imageId));
  let partial = imagePartial;

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

    const replicas: StackLabelReplica[] = (replicasByService.get(service) ?? []).map((rep) => {
      // A failed inspect has no runtime labels; reconciling against {} would falsely
      // report every declared label as Compose-only, so skip reconciliation and flag it.
      if (rep.inspectFailed) {
        partial = true;
        return {
          id: rep.id, name: rep.name, state: rep.state,
          runtimeLabels: [], onlyInCompose: [], onlyOnContainer: [], inBoth: [], changed: [],
          inspectFailed: true,
        };
      }
      const imageLabels = rep.imageId ? (imageLabelMap.get(rep.imageId) ?? null) : null;
      if (!rep.imageId) partial = true;
      // Without a declared model, only compose-system keys can be attributed with
      // confidence; everything else is unknown, and reconciliation is skipped.
      const runtimeLabels = Object.entries(rep.labels)
        .map(([key, value]) => {
          const source: LabelSource = renderFailed && !key.startsWith(COMPOSE_SYSTEM_PREFIX)
            ? 'unknown'
            : resolveLabelSource(key, value, imageLabels, declared);
          return toLabelValue(key, value, source, revealSecrets);
        })
        .sort((a, b) => a.key.localeCompare(b.key));
      const runtimeMap = Object.fromEntries(Object.entries(rep.labels));
      const { onlyInCompose, onlyOnContainer, inBoth, changed } = renderFailed
        ? { onlyInCompose: [], onlyOnContainer: [], inBoth: [], changed: [] }
        : reconcileKeys(declared, runtimeMap);
      return {
        id: rep.id,
        name: rep.name,
        state: rep.state,
        runtimeLabels,
        onlyInCompose,
        onlyOnContainer,
        inBoth,
        changed,
      };
    });

    return { service, declaredLabels, replicas };
  });

  return {
    stackName,
    renderable,
    services,
    partial,
    generatedAt: Date.now(),
  };
}
