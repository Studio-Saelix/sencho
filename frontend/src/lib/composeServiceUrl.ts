import { isAlias, isMap, isSeq, parse, parseDocument, type YAMLMap } from 'yaml';
import { SERVICE_URL_LABEL } from './serviceUrlLabel';

/** Compose treats `$$` as a literal dollar. A URL typed by the operator is literal. */
export function escapeComposeLiteral(url: string): string {
  return url.replaceAll('$', '$$$$');
}

export type ServiceUrlPatch =
  | { ok: true; yaml: string }
  | { ok: false; reason: 'missing-service' | 'parse' };

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

/** Set or remove `sencho.service.url` on one service. Other keys and comments stay. */
export function patchServiceUrlLabel(source: string, serviceName: string, url: string | null): ServiceUrlPatch {
  const doc = parseDocument(source);
  if (doc.errors.length > 0) return { ok: false, reason: 'parse' };
  const services = doc.get('services');
  if (!isMap(services) || !services.has(serviceName)) return { ok: false, reason: 'missing-service' };

  const labels = doc.getIn(['services', serviceName, 'labels']);
  const serviceNode = doc.getIn(['services', serviceName]);
  const inherited = (labels == null && isMap(serviceNode) && mapHasMerge(serviceNode)) || isAlias(labels);
  const inheritedClear = isMap(labels) && mapHasMerge(labels) && url === null && !labels.has(SERVICE_URL_LABEL);
  if (inherited || inheritedClear) {
    let resolved: unknown;
    try {
      resolved = effectiveLabels(source, serviceName);
    } catch (error) {
      console.error('Failed to read inherited compose labels:', error);
      return { ok: false, reason: 'parse' };
    }
    const next = copyLabels(resolved, url);
    if (next === null) return { ok: true, yaml: String(doc) };
    doc.setIn(['services', serviceName, 'labels'], next);
    return { ok: true, yaml: String(doc) };
  }
  if (url === null) {
    if (isMap(labels)) labels.delete(SERVICE_URL_LABEL);
    if (isSeq(labels)) {
      for (let i = labels.items.length - 1; i >= 0; i -= 1) {
        const text = labelText(labels.items[i]);
        if (text.startsWith(`${SERVICE_URL_LABEL}=`)) labels.delete(i);
      }
    }
    return { ok: true, yaml: String(doc) };
  }

  const literal = escapeComposeLiteral(url);
  if (labels == null) {
    doc.setIn(['services', serviceName, 'labels'], { [SERVICE_URL_LABEL]: literal });
    return { ok: true, yaml: String(doc) };
  }
  if (isMap(labels)) {
    labels.set(SERVICE_URL_LABEL, literal);
    return { ok: true, yaml: String(doc) };
  }
  if (isSeq(labels)) {
    const line = `${SERVICE_URL_LABEL}=${literal}`;
    let replaced = false;
    for (let i = 0; i < labels.items.length; i += 1) {
      if (labelText(labels.items[i]).startsWith(`${SERVICE_URL_LABEL}=`)) {
        labels.set(i, line);
        replaced = true;
        break;
      }
    }
    if (!replaced) labels.add(line);
    return { ok: true, yaml: String(doc) };
  }
  return { ok: false, reason: 'parse' };
}
