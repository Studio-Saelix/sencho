import { Document, isAlias, isMap, isSeq, parse, parseDocument, visit, type YAMLMap } from 'yaml';
import { SERVICE_URL_LABEL, serviceUrlFromLabelValue } from './serviceUrlLabel';

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

/** A list entry may be an alias. Matching uses the resolved text and leaves the anchor alone. */
function resolvedLabelText(doc: unknown, item: unknown): string {
  if (isAlias(item)) {
    const resolved = (item as { resolve: (doc: unknown) => unknown }).resolve(doc);
    return labelText(resolved);
  }
  return labelText(item);
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

function aliasSites(doc: unknown, anchor: string): Array<{ parent: unknown; node: unknown }> {
  const sites: Array<{ parent: unknown; node: unknown }> = [];
  visit(doc as Parameters<typeof visit>[0], {
    Alias(_key, node, path) {
      if (node.source === anchor) sites.push({ parent: path[path.length - 1], node });
    },
  });
  return sites;
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

/** The URL this buffer itself sets for the service. Null when this file does not set one. */
export function serviceUrlInSource(source: string, serviceName: string): string | null {
  try {
    const merged: unknown = parse(source, { merge: true });
    if (!merged || typeof merged !== 'object') return null;
    const services = (merged as { services?: unknown }).services;
    if (!services || typeof services !== 'object') return null;
    const service = (services as Record<string, unknown>)[serviceName];
    if (!service || typeof service !== 'object') return null;
    const labels = (service as { labels?: unknown }).labels;
    if (Array.isArray(labels)) {
      let found: string | null = null;
      const prefix = `${SERVICE_URL_LABEL}=`;
      for (const item of labels) {
        if (typeof item !== 'string' || !item.startsWith(prefix)) continue;
        const url = serviceUrlFromLabelValue(item.slice(prefix.length));
        if (url) found = url;
      }
      return found;
    }
    if (!labels || typeof labels !== 'object') return null;
    const value = (labels as Record<string, unknown>)[SERVICE_URL_LABEL];
    return typeof value === 'string' ? serviceUrlFromLabelValue(value) : null;
  } catch (error) {
    console.error('Failed to read the service URL label:', error);
    return null;
  }
}

/** The label text this buffer sets, before it is checked as an absolute URL. */
function rawServiceUrlFrom(merged: unknown, serviceName: string): string | null {
  if (!merged || typeof merged !== 'object') return null;
  const services = (merged as { services?: unknown }).services;
  if (!services || typeof services !== 'object') return null;
  const service = (services as Record<string, unknown>)[serviceName];
  if (!service || typeof service !== 'object') return null;
  const labels = (service as { labels?: unknown }).labels;
  if (Array.isArray(labels)) {
    let found: string | null = null;
    const prefix = `${SERVICE_URL_LABEL}=`;
    for (const item of labels) {
      if (typeof item !== 'string' || !item.startsWith(prefix)) continue;
      found = item.slice(prefix.length);
    }
    return found;
  }
  if (!labels || typeof labels !== 'object') return null;
  const value = (labels as Record<string, unknown>)[SERVICE_URL_LABEL];
  return typeof value === 'string' ? value : null;
}

/**
 * True when saving this buffer can change the effective URL. A URL supplied by
 * another compose file is not owned here, so an edit of this file would not apply.
 * A value that still contains `$` is a Compose interpolation in this file.
 */
export function serviceUrlOwnedBySource(source: string, serviceName: string, effectiveUrl: string | undefined): boolean {
  try {
    return ownsRawUrl(rawServiceUrlFrom(parse(source, { merge: true }), serviceName), effectiveUrl);
  } catch (error) {
    console.error('Failed to read the service URL label:', error);
    return !effectiveUrl;
  }
}

function ownsRawUrl(own: string | null, effectiveUrl: string | undefined): boolean {
  if (!effectiveUrl) return true;
  if (own == null) return false;
  if (own.includes('$')) return true;
  return serviceUrlFromLabelValue(own) === effectiveUrl;
}

/** Services whose effective URL is not the label in this buffer. One parse for the whole file. */
export function lockedServiceNames(source: string, effectiveUrls: Record<string, string>): Set<string> {
  const locked = new Set<string>();
  let merged: unknown;
  try {
    merged = parse(source, { merge: true });
  } catch (error) {
    console.error('Failed to read the service URL label:', error);
    return locked;
  }
  for (const [name, url] of Object.entries(effectiveUrls)) {
    if (!ownsRawUrl(rawServiceUrlFrom(merged, name), url)) locked.add(name);
  }
  return locked;
}

interface Splice {
  start: number;
  end: number;
  text: string;
}

function nodeRange(node: unknown): [number, number, number] | null {
  if (!node || typeof node !== 'object' || !('range' in node)) return null;
  const range = (node as { range?: unknown }).range;
  if (!Array.isArray(range) || range.length < 3) return null;
  const start = range[0];
  const valueEnd = range[1];
  const nodeEnd = range[2];
  if (typeof start !== 'number' || typeof valueEnd !== 'number' || typeof nodeEnd !== 'number') return null;
  if (start < 0 || valueEnd < start || nodeEnd < valueEnd) return null;
  return [start, valueEnd, nodeEnd];
}

function applySplices(source: string, splices: Splice[]): string {
  const ordered = [...splices].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].start < ordered[index - 1].end) throw new Error('overlapping compose edit');
  }
  let out = source;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const splice = ordered[index];
    out = out.slice(0, splice.start) + splice.text + out.slice(splice.end);
  }
  return out;
}

function fileNewline(source: string): string {
  return source.includes('\r\n') ? '\r\n' : '\n';
}

function indentAt(source: string, index: number): number {
  const lineStart = source.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  let count = 0;
  while (source[lineStart + count] === ' ') count += 1;
  return count;
}

function quoteYaml(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function emitDocument(value: unknown): string {
  return new Document(value).toString({ lineWidth: 0 }).replace(/\r?\n$/, '');
}

function nodeToJs(node: unknown, doc: unknown): unknown {
  if (!node || typeof node !== 'object' || !('toJS' in node)) return undefined;
  return (node as { toJS: (doc: unknown) => unknown }).toJS(doc);
}

function renderBlock(source: string, indent: number, value: unknown, leadingBreak: boolean): string {
  const nl = fileNewline(source);
  const pad = ' '.repeat(indent);
  const body = emitDocument(value)
    .split(/\r?\n/)
    .map(line => (line.length === 0 ? line : pad + line))
    .join(nl);
  return leadingBreak ? `${nl}${body}` : body;
}

function replaceNode(source: string, node: unknown, value: unknown): Splice {
  const range = nodeRange(node);
  if (!range) throw new Error('missing compose range');
  const lineStart = source.lastIndexOf('\n', Math.max(0, range[0] - 1)) + 1;
  const prefix = source.slice(lineStart, range[0]);
  const onOwnLine = prefix.trim() === '' && prefix.length > 0;
  const indent = onOwnLine ? prefix.length : indentAt(source, range[0]) + 2;
  const scalar = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value == null;
  let text = scalar
    ? (value == null ? '' : typeof value === 'string' ? quoteYaml(value) : String(value))
    : renderBlock(source, indent, value, !onOwnLine);
  const start = !scalar && onOwnLine ? lineStart : range[0];
  if (source.slice(start, range[1]).endsWith('\n') && !text.endsWith('\n')) text += fileNewline(source);
  return { start, end: range[1], text };
}

function isFlow(source: string, node: unknown): boolean {
  const range = nodeRange(node);
  if (!range) return false;
  const ch = source[range[0]];
  return ch === '{' || ch === '[';
}

function collectionIndent(source: string, collection: { items: unknown[] }): number {
  for (const item of collection.items) {
    const keyed = item && typeof item === 'object' && 'key' in item
      ? (item as { key: unknown }).key
      : item;
    const range = nodeRange(keyed);
    if (range) return indentAt(source, range[0]);
  }
  const self = nodeRange(collection);
  return self ? indentAt(source, self[0]) + 2 : 2;
}

function appendLine(source: string, collection: { items: unknown[] }, line: string): Splice {
  const range = nodeRange(collection);
  if (!range) throw new Error('missing compose range');
  const nl = fileNewline(source);
  const indent = collectionIndent(source, collection);
  return { start: range[2], end: range[2], text: `${' '.repeat(indent)}${line}${nl}` };
}

function deleteSpan(source: string, from: unknown, to: unknown): Splice {
  const startRange = nodeRange(from);
  const endRange = nodeRange(to);
  if (!startRange || !endRange) throw new Error('missing compose range');
  const lineStart = source.lastIndexOf('\n', startRange[0] - 1) + 1;
  return { start: lineStart, end: endRange[2], text: '' };
}

function reindent(source: string, body: string, indent: number): string {
  const nl = fileNewline(source);
  const lines = body.replace(/(?:\r?\n)+$/, '').split(/\r?\n/);
  const widths = lines
    .filter(line => line.trim().length > 0)
    .map(line => line.match(/^ */)?.[0].length ?? 0);
  const base = widths.length > 0 ? Math.min(...widths) : 0;
  return lines.map(line => (line.trim().length === 0 ? '' : `${' '.repeat(indent)}${line.slice(base)}`)).join(nl);
}

/** Put a copy of existing source text where an alias stands, keeping that text's scalars. */
function placeCopy(source: string, alias: unknown, body: string): Splice {
  const range = nodeRange(alias);
  if (!range) throw new Error('missing compose range');
  const lineStart = source.lastIndexOf('\n', Math.max(0, range[0] - 1)) + 1;
  const prefix = source.slice(lineStart, range[0]);
  const inline = prefix.trim() !== '';
  const indent = inline ? indentAt(source, range[0]) + 2 : prefix.length;
  const text = reindent(source, body, indent);
  if (inline) {
    const start = source[range[0] - 1] === ' ' ? range[0] - 1 : range[0];
    return { start, end: range[1], text: `${fileNewline(source)}${text}` };
  }
  const nl = fileNewline(source);
  return { start: lineStart, end: range[1], text: text.endsWith('\n') ? text : `${text}${nl}` };
}

/** Replace aliases of this anchor that live outside it, so editing the anchor does not change them. */
function detachOutside(doc: unknown, source: string, owner: unknown, anchor: string | null, splices: Splice[]): void {
  if (!anchor) return;
  for (const site of aliasSites(doc, anchor)) {
    if (isWithin(site.node, owner)) continue;
    if (!nodeRange(site.node)) continue;
    const resolved = (site.node as { resolve: (doc: unknown) => unknown }).resolve(doc);
    const body = nodeRange(resolved);
    if ((isMap(resolved) || isSeq(resolved)) && body) {
      const contentStart = source.lastIndexOf('\n', Math.max(0, body[0] - 1)) + 1;
      splices.push(placeCopy(source, site.node, source.slice(contentStart, body[2])));
      continue;
    }
    splices.push(replaceNode(source, site.node, nodeToJs(resolved, doc)));
  }
}

function editMap(source: string, doc: unknown, labels: YAMLMap, url: string | null): Splice[] {
  const pair = labels.items.find(item => labelText(item.key) === SERVICE_URL_LABEL);
  const literal = url === null ? null : escapeComposeLiteral(url);
  if (literal === null) {
    if (!pair) return [];
    const splices: Splice[] = [];
    detachOutside(doc, source, pair.value, anchorName(pair.value), splices);
    if (labels.items.length === 1) splices.push(replaceNode(source, labels, {}));
    else splices.push(deleteSpan(source, pair.key, pair.value));
    return splices;
  }
  if (!pair) return [appendLine(source, labels, `${SERVICE_URL_LABEL}: ${quoteYaml(literal)}`)];
  const range = nodeRange(pair.value);
  if (!range) throw new Error('missing compose range');
  const splices: Splice[] = [];
  detachOutside(doc, source, pair.value, anchorName(pair.value), splices);
  splices.push({ start: range[0], end: range[1], text: quoteYaml(literal) });
  return splices;
}

function editSeq(source: string, doc: unknown, labels: { items: unknown[] }, url: string | null): Splice[] {
  const prefix = `${SERVICE_URL_LABEL}=`;
  const matches = labels.items.filter(item => resolvedLabelText(doc, item).startsWith(prefix));
  const literal = url === null ? null : escapeComposeLiteral(url);
  if (literal === null) {
    const splices: Splice[] = [];
    for (const item of matches) detachOutside(doc, source, item, anchorName(item), splices);
    if (matches.length > 0 && matches.length === labels.items.length) {
      splices.push(replaceNode(source, labels, []));
      return splices;
    }
    for (const item of matches) splices.push(deleteSpan(source, item, item));
    return splices;
  }
  const line = `${prefix}${literal}`;
  if (matches.length === 0) return [appendLine(source, labels, `- ${line}`)];
  const splices: Splice[] = [];
  matches.forEach((item, index) => {
    detachOutside(doc, source, item, anchorName(item), splices);
    const range = nodeRange(item);
    if (!range) throw new Error('missing compose range');
    if (index === 0) splices.push({ start: range[0], end: range[1], text: line });
    else splices.push(deleteSpan(source, item, item));
  });
  return splices;
}

function insertLabelsBlock(source: string, service: unknown, labels: unknown): Splice {
  const range = nodeRange(service);
  if (!range) throw new Error('missing compose range');
  const nl = fileNewline(source);
  const indent = collectionIndent(source, service as { items: unknown[] });
  const block = emitDocument({ labels })
    .split(/\r?\n/)
    .map(line => (line.length === 0 ? line : `${' '.repeat(indent)}${line}`))
    .join(nl);
  const lineStart = source.lastIndexOf('\n', Math.max(0, range[0] - 1)) + 1;
  return { start: lineStart, end: lineStart, text: `${block}${nl}` };
}

function editServiceLabels(source: string, doc: unknown, service: YAMLMap, serviceName: string, url: string | null): Splice[] {
  const labelPair = service.items.find(item => labelText(item.key) === 'labels');
  const labels = labelPair ? labelPair.value : null;
  if (isAlias(labels)) {
    const next = copyLabels(effectiveLabels(source, serviceName), url);
    return next == null ? [] : [replaceNode(source, labels, next)];
  }
  const splices: Splice[] = [];
  const anchor = anchorName(labels);
  if (anchor) detachOutside(doc, source, labels, anchor, splices);
  if (labels == null) {
    if (url == null && !mapHasMerge(service)) return splices;
    const next = url == null || mapHasMerge(service)
      ? copyLabels(effectiveLabels(source, serviceName), url)
      : { [SERVICE_URL_LABEL]: escapeComposeLiteral(url) };
    if (next == null) return splices;
    if (isFlow(source, service)) {
      const js = nodeToJs(service, doc);
      if (!js || typeof js !== 'object' || Array.isArray(js)) throw new Error('Service is not a map');
      splices.push(replaceNode(source, service, { ...(js as Record<string, unknown>), labels: next }));
      return splices;
    }
    splices.push(insertLabelsBlock(source, service, next));
    return splices;
  }
  if (isMap(labels) && mapHasMerge(labels) && url == null) {
    const next = copyLabels(effectiveLabels(source, serviceName), null);
    if (next != null) splices.push(replaceNode(source, labels, next));
    return splices;
  }
  if (isFlow(source, labels)) {
    const next = copyLabels(effectiveLabels(source, serviceName), url);
    if (next != null) splices.push(replaceNode(source, labels, next));
    return splices;
  }
  if (isMap(labels)) splices.push(...editMap(source, doc, labels, url));
  else if (isSeq(labels)) splices.push(...editSeq(source, doc, labels, url));
  else throw new Error('Service labels are not a map or list');
  return splices;
}

/** Set or remove `sencho.service.url` on one service. Bytes outside that edit stay as they were. */
export function patchServiceUrlLabel(source: string, serviceName: string, url: string | null): ServiceUrlPatch {
  try {
    const doc = parseDocument(source);
    if (doc.errors.length > 0) return { ok: false, reason: 'parse' };
    const services = doc.get('services');
    if (!isMap(services)) return { ok: false, reason: 'missing-service' };
    const pair = services.items.find(item => labelText(item.key) === serviceName);
    if (!pair) return { ok: false, reason: 'missing-service' };

    const splices: Splice[] = [];
    if (isAlias(pair.value)) {
      const resolved = pair.value.resolve(doc);
      if (!isMap(resolved)) return { ok: false, reason: 'parse' };
      const body = nodeRange(resolved);
      if (!body) return { ok: false, reason: 'parse' };
      const contentStart = source.lastIndexOf('\n', Math.max(0, body[0] - 1)) + 1;
      const local: Splice[] = [];
      for (const splice of editServiceLabels(source, doc, resolved, serviceName, url)) {
        if (splice.start >= contentStart && splice.end <= body[2]) {
          local.push({ start: splice.start - contentStart, end: splice.end - contentStart, text: splice.text });
        } else {
          splices.push(splice);
        }
      }
      splices.push(placeCopy(source, pair.value, applySplices(source.slice(contentStart, body[2]), local)));
    } else if (isMap(pair.value)) {
      const anchor = anchorName(pair.value);
      if (anchor) detachOutside(doc, source, pair.value, anchor, splices);
      splices.push(...editServiceLabels(source, doc, pair.value, serviceName, url));
    } else {
      return { ok: false, reason: 'parse' };
    }
    return { ok: true, yaml: applySplices(source, splices) };
  } catch (error) {
    console.error('Failed to update the service URL label:', error);
    return { ok: false, reason: 'parse' };
  }
}
