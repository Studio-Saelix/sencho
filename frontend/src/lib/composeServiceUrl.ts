import { isMap, isSeq, parseDocument } from 'yaml';
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

/** Set or remove `sencho.service.url` on one service. Other keys and comments stay. */
export function patchServiceUrlLabel(source: string, serviceName: string, url: string | null): ServiceUrlPatch {
  const doc = parseDocument(source);
  if (doc.errors.length > 0) return { ok: false, reason: 'parse' };
  const services = doc.get('services');
  if (!isMap(services) || !services.has(serviceName)) return { ok: false, reason: 'missing-service' };

  const labels = doc.getIn(['services', serviceName, 'labels']);
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
