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

function copyLabels(labels: unknown, url: string | null): Record<string, string> | string[] | null {
  const literal = url === null ? null : escapeComposeLiteral(url);
  if (Array.isArray(labels)) {
    const next = labels.filter(item => typeof item === 'string' && !item.startsWith(`${SERVICE_URL_LABEL}=`));
    if (literal !== null) next.push(`${SERVICE_URL_LABEL}=${literal}`);
    return next;
  }
  if (!labels || typeof labels !== 'object') {
    return literal === null ? null : { [SERVICE_URL_LABEL]: literal };
  }
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (key === '<<' || key === SERVICE_URL_LABEL) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      next[key] = String(value);
    }
  }
  if (literal !== null) next[SERVICE_URL_LABEL] = literal;
  return next;
}

/** A private copy. Shared anchors stay on the original node. */
function unanchoredCopy(node: YamlNode): YamlNode {
  const copy = node.clone();
  const strip = (current: unknown): void => {
    if (!current || typeof current !== 'object') return;
    if ('anchor' in current) (current as { anchor?: string | null }).anchor = null;
    if (isAlias(current)) return;
    if (isMap(current)) {
      for (const item of current.items) strip(item.value);
      return;
    }
    if (isSeq(current)) {
      for (const item of current.items) strip(item);
    }
  };
  strip(copy);
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

/** Give every alias of this anchor its own copy of the value before it is edited. */
function detachSharedAnchor(doc: unknown, node: YamlNode): void {
  const anchor = anchorName(node);
  if (!anchor) return;
  for (const site of aliasSites(doc, anchor)) {
    replaceAlias(site.parent, site.node, unanchoredCopy(node));
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
