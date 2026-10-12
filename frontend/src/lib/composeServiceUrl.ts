import { isAlias, isMap, isPair, isSeq, parse, parseDocument, visit, type YAMLMap } from 'yaml';
import { SERVICE_URL_LABEL } from './serviceUrlLabel';

/** Compose treats `$$` as a literal dollar. A URL typed by the operator is literal. */
export function escapeComposeLiteral(url: string): string {
  return url.replaceAll('$', '$$$$');
}

export type ServiceUrlPatch =
  | { ok: true; yaml: string }
  | { ok: false; reason: 'missing-service' | 'parse' };

type YamlNode = {
  anchor?: string | null;
  clone: () => YamlNode;
};

function labelText(item: unknown): string {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object' && 'value' in item) {
    const value = (item as { value: unknown }).value;
    return typeof value === 'string' ? value : '';
  }
  return '';
}

function mapHasMerge(map: YAMLMap): boolean {
  return map.items.some(item => labelText(item.key) === '<<');
}

function anchorName(node: unknown): string | null {
  if (!node || typeof node !== 'object' || !('anchor' in node)) return null;
  const anchor = (node as { anchor?: unknown }).anchor;
  return typeof anchor === 'string' && anchor.length > 0 ? anchor : null;
}

function effectiveLabels(source: string, serviceName: string): unknown {
  const merged: unknown = parse(source, { merge: true });
  if (!merged || typeof merged !== 'object') return null;
  const services = (merged as { services?: unknown }).services;
  if (!services || typeof services !== 'object') return null;
  const service = (services as Record<string, unknown>)[serviceName];
  if (!service || typeof service !== 'object') return null;
  return (service as { labels?: unknown }).labels ?? null;
}

function copyLabels(labels: unknown, url: string | null): Record<string, string | null> | string[] | null {
  const literal = url === null ? null : escapeComposeLiteral(url);
  if (Array.isArray(labels)) {
    const next = labels.filter(item => typeof item === 'string' && !item.startsWith(`${SERVICE_URL_LABEL}=`));
    if (literal !== null) next.push(`${SERVICE_URL_LABEL}=${literal}`);
    return next;
  }
  if (!labels || typeof labels !== 'object') {
    return literal === null ? null : { [SERVICE_URL_LABEL]: literal };
  }
  const next: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (key === '<<' || key === SERVICE_URL_LABEL) continue;
    // An empty label (`KEEP:`) is real metadata. Copying the map must keep it.
    if (value === null) {
      next[key] = null;
      continue;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      next[key] = String(value);
    }
  }
  if (literal !== null) next[SERVICE_URL_LABEL] = literal;
  return next;
}

function nodeSpan(node: unknown): [number, number] | null {
  if (!node || typeof node !== 'object' || !('range' in node)) return null;
  const range = (node as { range?: unknown }).range;
  if (!Array.isArray(range) || range.length < 2) return null;
  const start = range[0];
  const end = range[range.length - 1];
  if (typeof start !== 'number' || typeof end !== 'number' || start < 0) return null;
  return [start, end];
}

function isWithin(inner: unknown, outer: unknown): boolean {
  const innerSpan = nodeSpan(inner);
  const outerSpan = nodeSpan(outer);
  if (!innerSpan || !outerSpan) return false;
  return innerSpan[0] >= outerSpan[0] && innerSpan[1] <= outerSpan[1];
}

/** A private copy. Anchors defined inside it are removed, and aliases of those anchors are expanded. */
function unanchoredCopy(node: YamlNode): YamlNode {
  const copy = node.clone();
  const localAnchors = new Map<string, YamlNode>();
  const collect = (current: unknown): void => {
    if (!current || typeof current !== 'object' || isAlias(current)) return;
    const name = anchorName(current);
    if (name) localAnchors.set(name, current as YamlNode);
    if (isMap(current)) {
      for (const item of current.items) collect(item.value);
      return;
    }
    if (isSeq(current)) {
      for (const item of current.items) collect(item);
    }
  };
  collect(copy);
  const resolving = new Set<string>();
  const rewrite = (current: unknown, assign: (next: unknown) => void): void => {
    if (!current || typeof current !== 'object') return;
    if (isAlias(current)) {
      const source = (current as { source?: unknown }).source;
      if (typeof source !== 'string' || resolving.has(source)) return;
      const target = localAnchors.get(source);
      if (!target) return;
      resolving.add(source);
      const resolved = target.clone();
      resolved.anchor = null;
      assign(resolved);
      rewrite(resolved, () => undefined);
      resolving.delete(source);
      return;
    }
    if ('anchor' in current) (current as { anchor?: string | null }).anchor = null;
    if (isMap(current)) {
      for (const item of current.items) {
        rewrite(item.value, (next) => { item.value = next as typeof item.value; });
      }
      return;
    }
    if (isSeq(current)) {
      for (let index = 0; index < current.items.length; index += 1) {
        const item = current.items[index];
        rewrite(item, (next) => { current.items[index] = next as typeof item; });
      }
    }
  };
  rewrite(copy, () => undefined);
  return copy;
}

function aliasSites(doc: unknown, anchor: string): Array<{ parent: unknown; node: unknown }> {
  const sites: Array<{ parent: unknown; node: unknown }> = [];
  visit(doc as Parameters<typeof visit>[0], {
    Alias(_key, node, path) {
      if (node.source === anchor) sites.push({ parent: path[path.length - 1], node });
    },
  });
  return sites;
}

function replaceAlias(parent: unknown, node: unknown, replacement: unknown): void {
  if (isPair(parent) && parent.value === node) {
    parent.value = replacement as typeof parent.value;
    return;
  }
  if (isSeq(parent)) {
    const index = parent.items.indexOf(node as typeof parent.items[number]);
    if (index >= 0) parent.items[index] = replacement as typeof parent.items[number];
  }
}

function anchorsInside(node: unknown): YamlNode[] {
  const found: YamlNode[] = [];
  const walk = (current: unknown): void => {
    if (!current || typeof current !== 'object' || isAlias(current)) return;
    if (anchorName(current)) found.push(current as YamlNode);
    if (isMap(current)) {
      for (const item of current.items) walk(item.value);
      return;
    }
    if (isSeq(current)) {
      for (const item of current.items) walk(item);
    }
  };
  walk(node);
  return found;
}

/** Copy every outside alias before this node, including nested anchors, is edited. */
function detachSharedAnchor(doc: unknown, node: YamlNode): void {
  for (const anchored of anchorsInside(node)) {
    const anchor = anchorName(anchored);
    if (!anchor) continue;
    for (const site of aliasSites(doc, anchor)) {
      if (isWithin(site.node, node)) continue;
      replaceAlias(site.parent, site.node, unanchoredCopy(anchored));
    }
  }
}

/** Service names declared in this compose buffer. Null when the buffer cannot be parsed. */
export function composeServiceNames(source: string): string[] | null {
  try {
    const doc = parseDocument(source);
    if (doc.errors.length > 0) return null;
    const services = doc.get('services');
    if (!isMap(services)) return [];
    return services.items.map(item => labelText(item.key)).filter(name => name.length > 0);
  } catch (error) {
    console.error('Failed to read compose service names:', error);
    return null;
  }
}

function applyDirect(labels: unknown, url: string | null): boolean {
  if (url === null) {
    if (isMap(labels)) labels.delete(SERVICE_URL_LABEL);
    if (isSeq(labels)) {
      for (let i = labels.items.length - 1; i >= 0; i -= 1) {
        if (labelText(labels.items[i]).startsWith(`${SERVICE_URL_LABEL}=`)) labels.delete(i);
      }
    }
    return true;
  }
  const literal = escapeComposeLiteral(url);
  if (isMap(labels)) {
    labels.set(SERVICE_URL_LABEL, literal);
    return true;
  }
  if (isSeq(labels)) {
    const line = `${SERVICE_URL_LABEL}=${literal}`;
    for (let i = 0; i < labels.items.length; i += 1) {
      if (labelText(labels.items[i]).startsWith(`${SERVICE_URL_LABEL}=`)) {
        labels.set(i, line);
        return true;
      }
    }
    labels.add(line);
    return true;
  }
  return false;
}

function editLabels(docText: string, doc: unknown, service: YAMLMap, serviceName: string, url: string | null): void {
  const labelPair = service.items.find(item => labelText(item.key) === 'labels');
  const labels = labelPair ? labelPair.value : null;
  const anchor = anchorName(labels);
  if ((isMap(labels) || isSeq(labels)) && anchor && aliasSites(doc, anchor).length > 0) {
    const edited = unanchoredCopy(labels as YamlNode);
    if (url === null && isMap(edited) && mapHasMerge(edited)) {
      const next = copyLabels(effectiveLabels(docText, serviceName), null);
      detachSharedAnchor(doc, labels as YamlNode);
      if (next !== null) service.set('labels', next);
      return;
    }
    if (!applyDirect(edited, url)) throw new Error('Service labels are not a map or list');
    detachSharedAnchor(doc, labels as YamlNode);
    service.set('labels', edited);
    return;
  }
  const inherited = isAlias(labels)
    || (labels == null && mapHasMerge(service))
    || (isMap(labels) && mapHasMerge(labels) && url === null);
  if (inherited) {
    const next = copyLabels(effectiveLabels(docText, serviceName), url);
    if (next !== null) service.set('labels', next);
    return;
  }
  if (labels == null) {
    if (url !== null) service.set('labels', { [SERVICE_URL_LABEL]: escapeComposeLiteral(url) });
    return;
  }
  if (!applyDirect(labels, url)) throw new Error('Service labels are not a map or list');
}

/** Set or remove `sencho.service.url` on one service. Other services keep their labels. */
export function patchServiceUrlLabel(source: string, serviceName: string, url: string | null): ServiceUrlPatch {
  try {
    const doc = parseDocument(source);
    if (doc.errors.length > 0) return { ok: false, reason: 'parse' };
    const services = doc.get('services');
    if (!isMap(services)) return { ok: false, reason: 'missing-service' };
    const pair = services.items.find(item => labelText(item.key) === serviceName);
    if (!pair) return { ok: false, reason: 'missing-service' };

    let service = pair.value;
    if (isAlias(service)) {
      const resolved = service.resolve(doc);
      if (!isMap(resolved)) return { ok: false, reason: 'parse' };
      service = unanchoredCopy(resolved);
      pair.value = service;
    } else if (isMap(service)) {
      const anchor = anchorName(service);
      if (anchor && aliasSites(doc, anchor).length > 0) {
        detachSharedAnchor(doc, service);
        service = unanchoredCopy(service);
        pair.value = service;
      }
    }
    if (!isMap(service)) return { ok: false, reason: 'parse' };
    editLabels(source, doc, service, serviceName, url);
    return { ok: true, yaml: String(doc) };
  } catch (error) {
    console.error('Failed to update the service URL label:', error);
    return { ok: false, reason: 'parse' };
  }
}
