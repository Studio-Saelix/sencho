import { isAlias, isMap, isPair, isScalar, isSeq, parse, parseDocument, visit, type YAMLMap, type YAMLSeq } from 'yaml';
import { SERVICE_URL_LABEL } from './serviceUrlLabel';

/**
 * A custom YAML tag (`!reset`, `!override`) makes the parser warn about the tag it
 * cannot resolve. Those layouts are refused here deliberately, with their own
 * message, so the library warning would only add noise to every read and edit of
 * such a file. Parse errors still surface through `doc.errors`.
 */
const QUIET_TAGS = { logLevel: 'error' } as const;

/** Compose treats `$$` as a literal dollar. A URL typed by the operator is literal. */
export function escapeComposeLiteral(url: string): string {
  return url.replaceAll('$', '$$$$');
}

export type ServiceUrlPatch =
  | { ok: true; yaml: string }
  | { ok: false; reason: 'missing-service' | 'parse' | 'unsupported' };

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

/** A label list entry matches the URL key as `key=value`, or as the bare `key` (an empty value). */
function isUrlListItem(text: string): boolean {
  return text === SERVICE_URL_LABEL || text.startsWith(`${SERVICE_URL_LABEL}=`);
}

/**
 * True when the label list holds an item whose key part carries Compose
 * interpolation (any `$` but `$$`), like `- "${URL_LABEL}=https://app"`.
 * Compose resolves the key against the render environment before reading the
 * list, so neither whether that item writes the URL label nor its order
 * relative to a written direct label can be established here. The backend
 * source authority reports the same construct; this check covers an unsaved
 * draft the authority has not seen.
 */
function listLabelKeyInterpolated(labels: unknown): boolean {
  if (!Array.isArray(labels)) return false;
  return labels.some(item => {
    if (typeof item !== 'string') return false;
    const eq = item.indexOf('=');
    const key = eq === -1 ? item : item.slice(0, eq);
    for (let index = 0; index < key.length; index += 1) {
      if (key[index] !== '$') continue;
      // `$$` is Compose's literal dollar; anything else starts an interpolation.
      if (key[index + 1] === '$') {
        index += 1;
        continue;
      }
      return true;
    }
    return false;
  });
}

function mapHasMerge(map: YAMLMap): boolean {
  return map.items.some(item => labelText(item.key) === '<<');
}

function anchorName(node: unknown): string | null {
  if (!node || typeof node !== 'object' || !('anchor' in node)) return null;
  const anchor = (node as { anchor?: unknown }).anchor;
  return typeof anchor === 'string' && anchor.length > 0 ? anchor : null;
}

/** A layout this edit cannot make without changing something else. Reported as `unsupported`. */
class UnsupportedLayout extends Error {}

function serviceOf(parsed: unknown, serviceName: string): Record<string, unknown> | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const services = (parsed as { services?: unknown }).services;
  if (!services || typeof services !== 'object') return null;
  const service = (services as Record<string, unknown>)[serviceName];
  return service && typeof service === 'object' ? service as Record<string, unknown> : null;
}

function effectiveLabels(source: string, serviceName: string, schema?: 'failsafe'): unknown {
  return serviceOf(parse(source, { ...QUIET_TAGS, merge: true, schema }), serviceName)?.labels ?? null;
}

/**
 * Labels to write in place of inherited or shared ones. Values are already YAML text
 * (null is an empty label); keys are raw label names that `labelKey` quotes when needed.
 */
type LabelsCopy =
  | { kind: 'map'; entries: Array<[string, string | null]> }
  | { kind: 'list'; items: string[] };

/**
 * A string is written quoted. Any other plain value (a number, boolean or null) keeps
 * its source token, so `0440` stays `0440`. Anything else is refused.
 */
function labelToken(typed: unknown, text: unknown): string {
  if (typeof typed === 'string') return quoteYaml(typed);
  if (typeof text === 'string' && text.length > 0 && !/[\s#:,[\]{}]/.test(text)) return text;
  throw new UnsupportedLayout('Label value cannot be copied');
}

function copyLabels(source: string, serviceName: string, url: string | null): LabelsCopy | null {
  const literal = url === null ? null : escapeComposeLiteral(url);
  const typed = effectiveLabels(source, serviceName);
  const text = effectiveLabels(source, serviceName, 'failsafe');
  if (Array.isArray(typed)) {
    const prefix = `${SERVICE_URL_LABEL}=`;
    const texts = Array.isArray(text) ? text : [];
    const items: string[] = [];
    typed.forEach((item, index) => {
      if (typeof item === 'string' && isUrlListItem(item)) return;
      items.push(labelToken(item, texts[index]));
    });
    if (literal !== null) items.push(quoteYaml(`${prefix}${literal}`));
    return { kind: 'list', items };
  }
  if (!typed || typeof typed !== 'object') {
    return literal === null ? null : { kind: 'map', entries: [[SERVICE_URL_LABEL, quoteYaml(literal)]] };
  }
  const texts = text && typeof text === 'object' ? text as Record<string, unknown> : {};
  const entries: Array<[string, string | null]> = [];
  for (const [key, value] of Object.entries(typed)) {
    if (key === '<<' || key === SERVICE_URL_LABEL) continue;
    // An empty label (`KEEP:`) is real metadata. Copying the map must keep it.
    entries.push([key, value === null ? null : labelToken(value, texts[key])]);
  }
  if (literal !== null) entries.push([SERVICE_URL_LABEL, quoteYaml(literal)]);
  return { kind: 'map', entries };
}

function labelKey(key: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(key) ? key : quoteYaml(key);
}

/** One-line flow text for copied labels: `{ ... }` or `[ ... ]`, or `{}`/`[]` when empty. */
function flowLabels(copy: LabelsCopy): string {
  if (copy.kind === 'list') return copy.items.length === 0 ? '[]' : `[ ${copy.items.join(', ')} ]`;
  if (copy.entries.length === 0) return '{}';
  return `{ ${copy.entries.map(([key, token]) => (token === null ? `${labelKey(key)}:` : `${labelKey(key)}: ${token}`)).join(', ')} }`;
}

/** Block lines for copied labels at `indent`, without a trailing newline. */
function blockLabels(source: string, copy: LabelsCopy, indent: number): string {
  const pad = ' '.repeat(indent);
  const lines = copy.kind === 'list'
    ? copy.items.map(item => `${pad}- ${item}`)
    : copy.entries.map(([key, token]) => (token === null ? `${pad}${labelKey(key)}:` : `${pad}${labelKey(key)}: ${token}`));
  return lines.join(fileNewline(source));
}

function isEmptyCopy(copy: LabelsCopy): boolean {
  return copy.kind === 'list' ? copy.items.length === 0 : copy.entries.length === 0;
}

/** True when the label map's only entry is the service URL. */
function soleUrlMap(labels: YAMLMap): boolean {
  return labels.items.length === 1 && labelText(labels.items[0].key) === SERVICE_URL_LABEL;
}

/** True when every list entry is the service URL, so the labels key can go. */
function soleUrlSeq(doc: unknown, labels: { items: unknown[] }): boolean {
  return labels.items.length > 0 && labels.items.every(item => isUrlListItem(resolvedLabelText(doc, item)));
}

/**
 * True when `#` sits in `region` outside every URL value's own token, so it is a
 * comment. The token ends at the value's scalar: a comment after it on the same
 * line is outside it even though the node's own range covers that comment.
 */
function commentOutsideValues(region: string, regionStart: number, values: unknown[]): boolean {
  const cuts: Array<[number, number]> = [];
  for (const value of values) {
    const span = nodeRange(value);
    if (!span || span[0] < regionStart || span[2] > regionStart + region.length) return region.includes('#');
    cuts.push([span[0] - regionStart, span[1] - regionStart]);
  }
  cuts.sort((left, right) => left[0] - right[0]);
  let text = '';
  let cursor = 0;
  for (const [from, to] of cuts) {
    if (from > cursor) text += region.slice(cursor, from);
    cursor = Math.max(cursor, to);
  }
  return `${text}${region.slice(cursor)}`.includes('#');
}

/**
 * End of the run of comment-only lines below `from` that sit deeper than `indent`,
 * so a comment block that closes the labels counts as part of it. A blank line, an
 * entry, or a comment at the key's own indentation ends the run.
 */
function commentLinesEnd(source: string, from: number, indent: number): number {
  let end = from;
  for (;;) {
    const newline = source.indexOf('\n', end);
    const stop = newline === -1 ? source.length : newline;
    const line = source.slice(end, stop);
    if (!line.trimStart().startsWith('#') || line.search(/\S/) <= indent) return end;
    end = newline === -1 ? source.length : newline + 1;
  }
}

/** The empty flow text a labels collection narrows to when its entries are removed. */
function emptyLabelsText(isList: boolean): string {
  return isList ? '[]' : '{}';
}

/** The first non-space character of the line starting at `lineStart`. */
function lineContentStart(source: string, lineStart: number): number {
  let index = lineStart;
  while (source[index] === ' ' || source[index] === '\t') index += 1;
  return index;
}

/**
 * Replace a block labels collection's entries with an empty flow collection, so the
 * key line and every comment outside those entries stay exactly as written. The
 * entry's own line marker goes too: a list entry keeps its `-`, rather than
 * turning into a `- []` nested empty sequence. A comment between the entries
 * cannot be kept once they become one token, so that layout is refused.
 */
function emptyEntriesInPlace(source: string, items: unknown[], values: unknown[], isList: boolean): Splice {
  const head = itemSpan(source, items[0])[0];
  const start = lineContentStart(source, source.lastIndexOf('\n', Math.max(0, head - 1)) + 1);
  const end = itemSpan(source, items[items.length - 1])[1];
  if (commentOutsideValues(source.slice(start, end), start, values)) {
    throw new UnsupportedLayout('A comment sits between the labels being removed');
  }
  return { start, end, text: emptyLabelsText(isList) };
}

/**
 * Remove a labels key that is left with no entries. Compose does not render
 * `labels:` without a value, so the key itself goes; a comment the removal would
 * drop (on one of the removed lines, or a comment-only line that closes the block)
 * keeps the value in place as an empty map or list instead.
 */
function emptyLabelsKey(
  source: string,
  doc: unknown,
  labelPair: YAMLMap['items'][number],
  entries: { items: unknown[] },
  values: unknown[],
  isList: boolean,
  splices: Splice[],
): void {
  const removed = deleteSpan(source, labelPair.key, labelPair.value);
  const keyRange = nodeRange(labelPair.key);
  const regionEnd = keyRange === null ? removed.end : commentLinesEnd(source, removed.end, indentAt(source, keyRange[0]));
  if (commentOutsideValues(source.slice(removed.start, regionEnd), removed.start, values)) {
    splices.push(emptyEntriesInPlace(source, entries.items, values, isList));
    return;
  }
  for (const value of values) detachOutside(doc, source, value, anchorName(value), splices);
  splices.push(removed);
}

/**
 * Remove a labels key whose only entries are the service URL, or empty it in place
 * when a comment the removal would drop has to stay. Returns false when the caller
 * has to edit the collection itself: a flow labels value, or a flow service, keeps
 * its own flow edit and its own refusals there.
 */
function clearSoleLabelsKey(
  source: string,
  doc: unknown,
  service: YAMLMap,
  labelPair: YAMLMap['items'][number],
  values: unknown[],
  isList: boolean,
  flowService: boolean,
  splices: Splice[],
): boolean {
  const removed = flowService ? null : deleteSpan(source, labelPair.key, labelPair.value);
  const [regionStart, regionEnd] = removed ? [removed.start, removed.end] : itemSpan(source, labelPair);
  const keyRange = nodeRange(labelPair.key);
  const regionEndWithComments = removed !== null && keyRange !== null
    ? commentLinesEnd(source, regionEnd, indentAt(source, keyRange[0]))
    : regionEnd;
  const keepsComment = commentOutsideValues(source.slice(regionStart, regionEndWithComments), regionStart, values);
  // A comment has to stay, and only the caller's own flow edit can keep it where it
  // stands, so a flow service or a flow labels value is left to that path.
  if (keepsComment && (removed === null || isFlow(source, labelPair.value))) return false;
  for (const value of values) detachOutside(doc, source, value, anchorName(value), splices);
  if (removed === null) splices.push(...editFlow(source, service, new Set([labelPair]), null));
  else if (keepsComment) splices.push(emptyEntriesInPlace(source, (labelPair.value as YAMLMap | YAMLSeq).items, values, isList));
  else splices.push(removed);
  return true;
}

function isWithin(inner: unknown, outer: unknown): boolean {
  const innerSpan = nodeRange(inner);
  const outerSpan = nodeRange(outer);
  if (!innerSpan || !outerSpan) return false;
  return innerSpan[0] >= outerSpan[0] && innerSpan[2] <= outerSpan[2];
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
    const doc = parseDocument(source, QUIET_TAGS);
    if (doc.errors.length > 0) return null;
    const services = doc.get('services');
    if (!isMap(services)) return [];
    return services.items.map(item => labelText(item.key)).filter(name => name.length > 0);
  } catch (error) {
    console.error('Failed to read compose service names:', error);
    return null;
  }
}

/** True when the service's labels carry the URL key at all, even with an empty value. */
function hasUrlLabel(parsed: unknown, serviceName: string): boolean {
  const labels = serviceOf(parsed, serviceName)?.labels;
  if (Array.isArray(labels)) return labels.some(item => typeof item === 'string' && isUrlListItem(item));
  return !!labels && typeof labels === 'object' && SERVICE_URL_LABEL in labels;
}

/**
 * A clear can leave or reveal an inherited URL: a top-level `include`, or the
 * edited service's `extends` or `label_file`, can supply the key once the direct
 * label is gone. Those layouts are refused so a clear never writes a no-op.
 */
function clearUnverifiable(doc: ReturnType<typeof parseDocument>, parsed: unknown, serviceName: string): boolean {
  if (doc.get('include') !== undefined) return true;
  const service = serviceOf(parsed, serviceName);
  return !!service && (service.extends !== undefined || service.label_file !== undefined);
}

/** The label text this buffer sets, before it is checked as an absolute URL. */
function rawServiceUrlFrom(merged: unknown, serviceName: string): string | null {
  const labels = serviceOf(merged, serviceName)?.labels;
  if (Array.isArray(labels)) {
    // Compose reads a list into a map, later entries winning, so the last
    // matching entry is the effective text; a bare key is the empty value.
    let found: string | null = null;
    for (const item of labels) {
      if (typeof item !== 'string') continue;
      if (item === SERVICE_URL_LABEL) found = '';
      else if (item.startsWith(`${SERVICE_URL_LABEL}=`)) found = item.slice(SERVICE_URL_LABEL.length + 1);
    }
    return found;
  }
  if (!labels || typeof labels !== 'object') return null;
  const value = (labels as Record<string, unknown>)[SERVICE_URL_LABEL];
  return typeof value === 'string' ? value : null;
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
    if (ordered[index].start < ordered[index - 1].end) throw new UnsupportedLayout('overlapping compose edit');
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

/**
 * Text that replaces a value token. A value right after `key:` needs its space, and
 * an empty value right before `# comment` must stay apart from it.
 */
function spacedValue(source: string, start: number, end: number, text: string): string {
  const lead = source[start - 1] === ':' ? ' ' : '';
  const trail = start === end && source[end] === '#' ? ' ' : '';
  return `${lead}${text}${trail}`;
}

/** End of the line holding `index`, before its newline. */
function lineEndAt(source: string, index: number): number {
  const newline = source.indexOf('\n', index);
  if (newline === -1) return source.length;
  return source[newline - 1] === '\r' ? newline - 1 : newline;
}

/**
 * Put copied labels where `node` stands: flow text inside `{ }` or `[ ]`, `{}`/`[]`
 * after the key when empty, and block lines otherwise.
 */
function replaceNode(source: string, node: unknown, copy: LabelsCopy, flow: boolean): Splice {
  const range = nodeRange(node);
  if (!range) throw new UnsupportedLayout('missing compose range');
  const nl = fileNewline(source);
  const lineStart = source.lastIndexOf('\n', Math.max(0, range[0] - 1)) + 1;
  const prefix = source.slice(lineStart, range[0]);
  const onOwnLine = prefix.trim() === '' && prefix.length > 0;
  let start = range[0];
  let text: string;
  const keyColon = source.slice(0, lineStart).trimEnd();
  const keyLine = keyColon.slice(keyColon.lastIndexOf('\n') + 1);
  if (!flow && isEmptyCopy(copy) && onOwnLine && keyColon.endsWith(':') && !keyLine.includes('#')) {
    // A block body emptied out under a plain `key:` line: write `key: {}` there, not `{}` below it.
    start = keyColon.length;
    text = ` ${flowLabels(copy)}`;
  } else if (flow || isEmptyCopy(copy)) {
    text = spacedValue(source, range[0], range[1], flowLabels(copy));
  } else if (range[0] === range[1]) {
    // `labels:` with no value, maybe `labels: # note`: the block goes under that line.
    start = lineEndAt(source, range[0]);
    return { start, end: start, text: `${nl}${blockLabels(source, copy, indentAt(source, range[0]) + 2)}` };
  } else if (onOwnLine) {
    start = lineStart;
    text = blockLabels(source, copy, prefix.length);
  } else {
    if (source[start - 1] === ' ') start -= 1;
    text = `${nl}${blockLabels(source, copy, indentAt(source, range[0]) + 2)}`;
  }
  if (source.slice(start, range[1]).endsWith('\n') && !text.endsWith('\n')) text += nl;
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

/** Where the last entry's own text ends. Collection ranges also run over trailing comment lines. */
function lastEntryEnd(collection: { items: unknown[] }): number {
  const last = collection.items[collection.items.length - 1];
  const range = nodeRange(isPair(last) ? (last.value ?? last.key) : last);
  if (!range) throw new UnsupportedLayout('missing compose range');
  return range[1];
}

/** Add a line right after the last entry, before any comment lines that follow it. */
function appendLine(source: string, collection: { items: unknown[] }, line: string): Splice {
  const nl = fileNewline(source);
  const pad = ' '.repeat(collectionIndent(source, collection));
  const at = lastEntryEnd(collection);
  if (source[at - 1] === '\n') return { start: at, end: at, text: `${pad}${line}${nl}` };
  // Finish the last entry's line (it may keep a comment, or have no newline at EOF).
  const lineEnd = lineEndAt(source, at);
  return { start: lineEnd, end: lineEnd, text: `${nl}${pad}${line}` };
}

/** Remove the lines from `from`'s line through the line where `to`'s value ends. */
function deleteSpan(source: string, from: unknown, to: unknown): Splice {
  const startRange = nodeRange(from);
  const endRange = nodeRange(to);
  if (!startRange || !endRange) throw new UnsupportedLayout('missing compose range');
  const lineStart = source.lastIndexOf('\n', startRange[0] - 1) + 1;
  let end = endRange[1];
  if (source[end - 1] !== '\n') {
    end = lineEndAt(source, end);
    if (source.startsWith('\r\n', end)) end += 2;
    else if (source[end] === '\n') end += 1;
  }
  return { start: lineStart, end, text: '' };
}

/**
 * Node ranges start after `&anchor` and `!tag`. Removing a flow item takes those too.
 * Only a node that has props is scanned, so text before a plain item is never taken.
 */
function withProps(source: string, node: unknown, start: number): number {
  if (!anchorName(node) && !(node && typeof node === 'object' && 'tag' in node && node.tag)) return start;
  let cursor = start;
  for (;;) {
    const before = source.slice(0, cursor).trimEnd();
    const match = /(?:!<[^>]*>|[&!][^\s,[\]{}]*)$/.exec(before);
    if (!match) return cursor;
    cursor = before.length - match[0].length;
  }
}

function itemSpan(source: string, item: unknown): [number, number] {
  const head = isPair(item) ? item.key : item;
  const headRange = nodeRange(head);
  if (!headRange) throw new UnsupportedLayout('missing compose range');
  const tailRange = isPair(item) ? nodeRange(item.value) : null;
  return [withProps(source, head, headRange[0]), Math.max(headRange[1], tailRange ? tailRange[1] : 0)];
}

/** A removal that would also take a comment sitting between items is refused, not made silently. */
function removeGap(source: string, start: number, end: number, removed: Array<[number, number]>): Splice {
  let cursor = start;
  for (const [itemStart, itemEnd] of removed) {
    if (itemEnd <= start || itemStart >= end) continue;
    if (source.slice(cursor, itemStart).includes('#')) throw new UnsupportedLayout('Comment inside a flow edit');
    cursor = Math.max(cursor, itemEnd);
  }
  if (source.slice(cursor, end).includes('#')) throw new UnsupportedLayout('Comment inside a flow edit');
  return { start, end, text: '' };
}

/**
 * Remove items from a flow `{ }` or `[ ]` and optionally add one entry. Only those
 * items and their commas change, so the collection keeps its flow syntax and every
 * other token stays as written.
 */
function editFlow(source: string, collection: { items: unknown[] }, remove: Set<unknown>, append: string | null): Splice[] {
  const range = nodeRange(collection);
  if (!range) throw new UnsupportedLayout('missing compose range');
  const open = source[range[0]];
  const close = open === '{' ? '}' : ']';
  const items = collection.items;
  const spans = items.map(item => itemSpan(source, item));
  const kept = items.flatMap((item, index) => (remove.has(item) ? [] : [index]));
  const removed = spans.filter((_, index) => remove.has(items[index]));
  if (kept.length === 0) {
    removeGap(source, range[0] + 1, range[1] - 1, removed);
    return [{ start: range[0], end: range[1], text: append === null ? `${open}${close}` : `${open} ${append} ${close}` }];
  }
  const splices: Splice[] = [];
  for (let index = 0; index < items.length; index += 1) {
    if (!remove.has(items[index])) continue;
    let last = index;
    while (last + 1 < items.length && remove.has(items[last + 1])) last += 1;
    // A run after a kept item goes with the comma before it; a leading run goes with the comma after it.
    splices.push(index > 0
      ? removeGap(source, spans[index - 1][1], spans[last][1], removed)
      : removeGap(source, spans[0][0], spans[last + 1][0], removed));
    index = last;
  }
  if (append !== null) {
    const at = spans[kept[kept.length - 1]][1];
    splices.push({ start: at, end: at, text: `, ${append}` });
  }
  return splices;
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

/** Put a copy of existing block source text where an alias stands, keeping that text's scalars. */
function placeCopy(source: string, alias: unknown, body: string): Splice {
  const range = nodeRange(alias);
  if (!range) throw new UnsupportedLayout('missing compose range');
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

/**
 * The source an anchored map or list stands for, without the key or anchor that
 * defines it. A flow node is its `{ }` or `[ ]` token; a block node is its lines.
 */
function anchoredBody(source: string, node: unknown): { start: number; end: number; flow: boolean } | null {
  const range = nodeRange(node);
  if (!range) return null;
  if (isFlow(source, node)) return { start: range[0], end: range[1], flow: true };
  return { start: source.lastIndexOf('\n', Math.max(0, range[0] - 1)) + 1, end: range[2], flow: false };
}

function placeBody(source: string, alias: unknown, body: string, flow: boolean): Splice {
  if (!flow) return placeCopy(source, alias, body);
  const range = nodeRange(alias);
  if (!range) throw new UnsupportedLayout('missing compose range');
  return { start: range[0], end: range[1], text: body };
}

/** Replace aliases of this anchor that live outside it, so editing the anchor does not change them. */
function detachOutside(doc: unknown, source: string, owner: unknown, anchor: string | null, splices: Splice[]): void {
  if (!anchor) return;
  for (const site of aliasSites(doc, anchor)) {
    if (isWithin(site.node, owner)) continue;
    const aliasRange = nodeRange(site.node);
    if (!aliasRange) continue;
    const resolved = (site.node as { resolve: (doc: unknown) => unknown }).resolve(doc);
    if (isMap(resolved) || isSeq(resolved)) {
      const body = anchoredBody(source, resolved);
      if (!body) throw new UnsupportedLayout('missing compose range');
      splices.push(placeBody(source, site.node, source.slice(body.start, body.end), body.flow));
      continue;
    }
    // A scalar is copied as its own token, so `0440` stays `0440` and quoting is kept.
    const token = nodeRange(resolved);
    const text = isScalar(resolved) && token ? source.slice(token[0], token[1]) : '';
    if (text.length === 0 || text.includes('\n')) throw new UnsupportedLayout('Anchored value cannot be copied');
    splices.push({ start: aliasRange[0], end: aliasRange[1], text });
  }
}

function editMap(source: string, doc: unknown, labels: YAMLMap, url: string | null): Splice[] {
  const flow = isFlow(source, labels);
  const pair = labels.items.find(item => labelText(item.key) === SERVICE_URL_LABEL);
  const literal = url === null ? null : escapeComposeLiteral(url);
  if (literal === null) {
    if (!pair) return [];
    const splices: Splice[] = [];
    detachOutside(doc, source, pair.value, anchorName(pair.value), splices);
    if (flow) splices.push(...editFlow(source, labels, new Set([pair]), null));
    else if (labels.items.length === 1) splices.push(replaceNode(source, labels, { kind: 'map', entries: [] }, false));
    else splices.push(deleteSpan(source, pair.key, pair.value));
    return splices;
  }
  const entry = `${SERVICE_URL_LABEL}: ${quoteYaml(literal)}`;
  if (!pair) return flow ? editFlow(source, labels, new Set(), entry) : [appendLine(source, labels, entry)];
  const range = nodeRange(pair.value);
  if (!range) throw new UnsupportedLayout('missing compose range');
  const splices: Splice[] = [];
  detachOutside(doc, source, pair.value, anchorName(pair.value), splices);
  splices.push({ start: range[0], end: range[1], text: spacedValue(source, range[0], range[1], quoteYaml(literal)) });
  return splices;
}

function editSeq(source: string, doc: unknown, labels: { items: unknown[] }, url: string | null): Splice[] {
  const flow = isFlow(source, labels);
  const prefix = `${SERVICE_URL_LABEL}=`;
  const matches = labels.items.filter(item => isUrlListItem(resolvedLabelText(doc, item)));
  const literal = url === null ? null : escapeComposeLiteral(url);
  const splices: Splice[] = [];
  for (const item of matches) detachOutside(doc, source, item, anchorName(item), splices);
  if (literal === null) {
    if (matches.length === 0) return splices;
    if (flow) splices.push(...editFlow(source, labels, new Set(matches), null));
    else if (matches.length === labels.items.length) splices.push(replaceNode(source, labels, { kind: 'list', items: [] }, false));
    else for (const item of matches) splices.push(deleteSpan(source, item, item));
    return splices;
  }
  const line = `${prefix}${literal}`;
  // A URL may hold `,` or `]`, which end a plain item inside `[ ]`.
  const token = flow ? quoteYaml(line) : line;
  if (matches.length === 0) return flow ? editFlow(source, labels, new Set(), token) : [appendLine(source, labels, `- ${line}`)];
  const first = nodeRange(matches[0]);
  if (!first) throw new UnsupportedLayout('missing compose range');
  splices.push({ start: first[0], end: first[1], text: token });
  const rest = matches.slice(1);
  if (flow && rest.length > 0) splices.push(...editFlow(source, labels, new Set(rest), null));
  else if (!flow) for (const item of rest) splices.push(deleteSpan(source, item, item));
  return splices;
}

function insertLabelsBlock(source: string, service: unknown, copy: LabelsCopy): Splice {
  const range = nodeRange(service);
  if (!range) throw new UnsupportedLayout('missing compose range');
  const nl = fileNewline(source);
  const indent = collectionIndent(source, service as { items: unknown[] });
  const pad = ' '.repeat(indent);
  const block = isEmptyCopy(copy)
    ? `${pad}labels: ${flowLabels(copy)}`
    : `${pad}labels:${nl}${blockLabels(source, copy, indent + 2)}`;
  const lineStart = source.lastIndexOf('\n', Math.max(0, range[0] - 1)) + 1;
  return { start: lineStart, end: lineStart, text: `${block}${nl}` };
}

/** One label a `<<` merge supplies, with the map style its text is copied from. */
interface MergedLabel {
  pair: unknown;
  /** True when the pair is written in a flow map, where whole-line source text is not available. */
  flowSource: boolean;
}

/** True when a node carries a tag, so its token cannot be copied without the property. */
function taggedNode(node: unknown): boolean {
  return !!node && typeof node === 'object' && 'tag' in node && !!(node as { tag?: unknown }).tag;
}

/** Label key identity as Compose reads it, so quoted and plain spellings of one key match. */
function labelKeyName(node: unknown): string {
  if (!isScalar(node)) throw new UnsupportedLayout('A label key is not a scalar');
  const value = node.value;
  return value == null ? '' : String(value);
}

function resolveAlias(doc: unknown, node: unknown): unknown {
  return (node as { resolve: (doc: unknown) => unknown }).resolve(doc);
}

/** The maps a merge key supplies, refused unless the key is an alias or a list of aliases. */
function mergeSourceMaps(doc: unknown, value: unknown): YAMLMap[] {
  const resolved = isAlias(value) ? resolveAlias(doc, value) : value;
  const items = isSeq(resolved) ? resolved.items : [value];
  return items.map(item => {
    // An inline source is removed together with the merge key, so its own text
    // (and any comment in it) could not be kept.
    if (!isAlias(item)) throw new UnsupportedLayout('A merge source is written inline');
    const map = resolveAlias(doc, item);
    if (!isMap(map)) throw new UnsupportedLayout('A merge source is not a map');
    return map;
  });
}

/**
 * Every label a `<<` merge supplies, in the order YAML resolves them: a map's own
 * keys first, then its own merges, earlier entries of a merge list first. The first
 * occurrence of a key wins. Keys named in `skip` (the direct keys and the URL key)
 * are never copied. A value whose text cannot be copied faithfully is refused.
 */
function collectMergedLabels(
  source: string,
  doc: unknown,
  value: unknown,
  skip: Set<string>,
  seen: Set<unknown>,
  out: MergedLabel[],
): void {
  for (const map of mergeSourceMaps(doc, value)) {
    if (seen.has(map)) continue;
    seen.add(map);
    const flowSource = isFlow(source, map);
    for (const pair of map.items) {
      const name = labelKeyName(pair.key);
      if (name === '<<' || skip.has(name)) continue;
      if (anchorName(pair.key) || anchorName(pair.value) || isAlias(pair.value)
        || taggedNode(pair.key) || taggedNode(pair.value)) {
        throw new UnsupportedLayout('A merged label carries an anchor, alias, or tag');
      }
      skip.add(name);
      out.push({ pair, flowSource });
    }
    for (const pair of map.items) {
      if (labelKeyName(pair.key) === '<<') collectMergedLabels(source, doc, pair.value, skip, seen, out);
    }
  }
}

/** `key: value` from a pair's exact scalar tokens, refused when it cannot fit on one line. */
function flowPairText(source: string, pair: unknown): string {
  if (!isPair(pair)) throw new UnsupportedLayout('A merged label is not a pair');
  const key = nodeRange(pair.key);
  const value = nodeRange(pair.value);
  if (!key || !value) throw new UnsupportedLayout('missing compose range');
  const keyText = source.slice(key[0], key[1]);
  const valueText = source.slice(value[0], value[1]);
  if (keyText.includes('\n') || valueText.includes('\n')) {
    throw new UnsupportedLayout('A merged label does not fit on one line');
  }
  return valueText.length > 0 ? `${keyText}: ${valueText}` : `${keyText}:`;
}

/** The pair's own source lines, including a trailing comment on its last line. */
function blockPairText(source: string, pair: unknown): string {
  const [start, valueEnd] = itemSpan(source, pair);
  const lineStart = source.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  if (source.slice(lineStart, start).trim() !== '') throw new UnsupportedLayout('A merged label is not on its own line');
  return source.slice(lineStart, lineEndAt(source, valueEnd));
}

/**
 * One flow-label entry, refused when the copied text would drop a comment that
 * sits on the pair's own line in the merge source.
 */
function mergedFlowEntry(source: string, label: MergedLabel): string {
  if (!label.flowSource) {
    const span = itemSpan(source, label.pair);
    if (source.slice(span[1], lineEndAt(source, span[1])).includes('#')) {
      throw new UnsupportedLayout('A merged label carries a comment');
    }
  }
  return flowPairText(source, label.pair);
}

/**
 * The merge key of a label map, its direct URL pairs, and the direct keys a
 * merged clear must not copy. Refused when the map has more than one merge key.
 */
function mergedClearParts(labels: YAMLMap): {
  mergeItem: YAMLMap['items'][number];
  urlPairs: YAMLMap['items'][number][];
  skip: Set<string>;
} {
  type LabelPair = YAMLMap['items'][number];
  const urlPairs: LabelPair[] = [];
  let mergeItem: LabelPair | null = null;
  const skip = new Set<string>([SERVICE_URL_LABEL]);
  for (const pair of labels.items) {
    const name = labelKeyName(pair.key);
    if (name === '<<') {
      if (mergeItem !== null) throw new UnsupportedLayout('More than one merge key on the labels');
      mergeItem = pair;
    } else if (name === SERVICE_URL_LABEL) {
      urlPairs.push(pair);
    } else {
      skip.add(name);
    }
  }
  if (mergeItem === null) throw new UnsupportedLayout('missing merge key');
  return { mergeItem, urlPairs, skip };
}

/**
 * A clear inside a label map that also merges another map: the merge key is
 * replaced by the inherited entries, copied from their own source text, and the
 * direct URL label is removed. Direct entries, comments and tokens stay exactly
 * as written. A layout whose text cannot be copied faithfully is refused.
 */
function materializeMergedClear(
  source: string,
  doc: unknown,
  labels: YAMLMap,
  labelPair: YAMLMap['items'][number],
): Splice[] {
  const { mergeItem, urlPairs, skip } = mergedClearParts(labels);
  const inherited: MergedLabel[] = [];
  collectMergedLabels(source, doc, mergeItem.value, skip, new Set(), inherited);
  const splices: Splice[] = [];
  if (isFlow(source, labels)) {
    for (const pair of urlPairs) detachOutside(doc, source, pair.value, anchorName(pair.value), splices);
    const entries = inherited.map(label => mergedFlowEntry(source, label));
    splices.push(...editFlow(source, labels, new Set([mergeItem, ...urlPairs]), entries.length > 0 ? entries.join(', ') : null));
    return splices;
  }
  const mergeEnd = itemSpan(source, mergeItem)[1];
  // Replacing the merge key line cannot keep a comment that sits on it, so refuse
  // instead of dropping that comment.
  if (source.slice(mergeEnd, lineEndAt(source, mergeEnd)).includes('#')) {
    throw new UnsupportedLayout('A comment sits on the merge key line');
  }
  const direct = labels.items.filter(item => item !== mergeItem && !urlPairs.includes(item));
  if (inherited.length === 0 && direct.length === 0) {
    // Nothing is left in the map, and `labels:` without a value does not render:
    // the key goes, or the entries narrow to `{}` when a comment has to stay.
    const values = [mergeItem.value, ...urlPairs.map(pair => pair.value)];
    emptyLabelsKey(source, doc, labelPair, labels, values, false, splices);
    return splices;
  }
  for (const pair of urlPairs) detachOutside(doc, source, pair.value, anchorName(pair.value), splices);
  for (const pair of urlPairs) splices.push(deleteSpan(source, pair.key, pair.value));
  const span = deleteSpan(source, mergeItem.key, mergeItem.value);
  const nl = fileNewline(source);
  const indent = collectionIndent(source, labels);
  const text = inherited
    .map(label => (label.flowSource ? flowPairText(source, label.pair) : blockPairText(source, label.pair)))
    .map(entry => reindent(source, entry, indent))
    .join(nl);
  splices.push({ start: span.start, end: span.end, text: source[span.end - 1] === '\n' ? `${text}${nl}` : text });
  return splices;
}

function editServiceLabels(source: string, doc: unknown, service: YAMLMap, serviceName: string, url: string | null): Splice[] {
  const flowService = isFlow(source, service);
  const labelPair = service.items.find(item => labelText(item.key) === 'labels');
  const labels = labelPair ? labelPair.value : null;
  if (isAlias(labels)) {
    const next = copyLabels(source, serviceName, url);
    return next == null ? [] : [replaceNode(source, labels, next, flowService)];
  }
  const splices: Splice[] = [];
  const anchor = anchorName(labels);
  if (anchor) detachOutside(doc, source, labels, anchor, splices);
  // `labels:` with nothing after it is a null scalar: the service has no labels yet.
  if (labels == null || (isScalar(labels) && labels.value == null)) {
    if (url == null && !mapHasMerge(service)) return splices;
    const next = copyLabels(source, serviceName, url);
    if (next == null) return splices;
    if (labels != null) splices.push(replaceNode(source, labels, next, flowService));
    else if (flowService) splices.push(...editFlow(source, service, new Set(), `labels: ${flowLabels(next)}`));
    else splices.push(insertLabelsBlock(source, service, next));
    return splices;
  }
  if (isMap(labels) && mapHasMerge(labels) && url == null && labelPair) {
    splices.push(...materializeMergedClear(source, doc, labels, labelPair));
    return splices;
  }
  if (isMap(labels) && url == null && labelPair && soleUrlMap(labels)
    && clearSoleLabelsKey(source, doc, service, labelPair, [labels.items[0].value], false, flowService, splices)) {
    return splices;
  }
  if (isSeq(labels) && url == null && labelPair && soleUrlSeq(doc, labels)
    && clearSoleLabelsKey(source, doc, service, labelPair, labels.items, true, flowService, splices)) {
    return splices;
  }
  if (isMap(labels)) splices.push(...editMap(source, doc, labels, url));
  else if (isSeq(labels)) splices.push(...editSeq(source, doc, labels, url));
  else throw new UnsupportedLayout('Service labels are not a map or list');
  return splices;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The whole file as plain data, with the URL label taken off one service and that service's labels dropped when empty. */
function modelWithoutUrl(source: string, serviceName: string, schema?: 'failsafe'): string {
  const parsed: unknown = parse(source, { ...QUIET_TAGS, merge: true, schema });
  // A JSON copy splits aliased nodes apart, so removing one service's label leaves the rest.
  const model: unknown = JSON.parse(JSON.stringify(parsed ?? null));
  const record = serviceOf(model, serviceName);
  if (record) {
    let labels = record.labels;
    if (Array.isArray(labels)) {
      labels = labels.filter(item => !(typeof item === 'string' && isUrlListItem(item)));
    } else if (labels && typeof labels === 'object') {
      labels = Object.fromEntries(Object.entries(labels).filter(([key]) => key !== SERVICE_URL_LABEL));
    }
    const empty = !labels || typeof labels !== 'object' || Object.keys(labels).length === 0;
    if (empty) delete record.labels;
    else record.labels = labels;
  }
  return stableJson(model);
}

/**
 * Why the patched text cannot be saved, or null when it parses, reads like the source
 * everywhere except the one URL label, and sets that label as asked. The file is read
 * once with YAML types and once with every scalar as an untyped string (the failsafe
 * schema), so `0440` turning into `440` or `022` into `22` is caught too.
 */
function patchMismatch(source: string, patched: string, serviceName: string, literal: string | null): string | null {
  if (parseDocument(patched, QUIET_TAGS).errors.length > 0) return 'the patched text does not parse';
  for (const schema of [undefined, 'failsafe'] as const) {
    if (modelWithoutUrl(source, serviceName, schema) !== modelWithoutUrl(patched, serviceName, schema)) {
      return `the ${schema ?? 'typed'} model changed outside the URL label`;
    }
  }
  if (rawServiceUrlFrom(parse(patched, { ...QUIET_TAGS, merge: true }), serviceName) !== literal) return 'the URL label did not read back';
  return null;
}

/**
 * Compose gives `!reset` and `!override` meaning that the parsed model does not show,
 * so a copy that drops one could not be caught. A file that uses any non-standard tag,
 * anywhere, is refused.
 */
function hasCustomTag(doc: Parameters<typeof visit>[0]): boolean {
  let found = false;
  visit(doc, {
    Node(_key, node) {
      if ('tag' in node && typeof node.tag === 'string' && !node.tag.startsWith('tag:yaml.org,2002:')) {
        found = true;
        return visit.BREAK;
      }
      return undefined;
    },
  });
  return found;
}

/**
 * Set or remove `io.sencho.url` on one service. Only that label changes in the
 * parsed file. When the edited block is shared through an anchor, whichever side is not
 * edited keeps its values: a consumer of the edited anchor gets its own copy, and an
 * edited alias is replaced by an inline copy. Clearing a service with no URL label returns
 * the source unchanged. A layout that cannot be edited that way is refused as
 * `unsupported`, before the caller can write anything.
 */
export function patchServiceUrlLabel(source: string, serviceName: string, url: string | null): ServiceUrlPatch {
  let parsed: unknown;
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(source, QUIET_TAGS);
    if (doc.errors.length > 0) return { ok: false, reason: 'parse' };
    // Merges are resolved here too, so `<<: 5` is a parse failure, not an unsupported layout.
    parsed = parse(source, { ...QUIET_TAGS, merge: true });
  } catch (error) {
    console.error('Failed to read the compose file for a service URL edit:', error);
    return { ok: false, reason: 'parse' };
  }
  const services = doc.get('services');
  if (!isMap(services)) return { ok: false, reason: 'missing-service' };
  const pair = services.items.find(item => labelText(item.key) === serviceName);
  if (!pair) return { ok: false, reason: 'missing-service' };
  if (listLabelKeyInterpolated(serviceOf(parsed, serviceName)?.labels)) {
    console.warn(`Service URL edit on ${serviceName} refused: a label-list key is interpolated, so the effective label cannot be predicted.`);
    return { ok: false, reason: 'unsupported' };
  }
  if (url === null && clearUnverifiable(doc, parsed, serviceName)) {
    console.warn(`Service URL clear on ${serviceName} refused: the file or service inherits labels.`);
    return { ok: false, reason: 'unsupported' };
  }
  if (url === null && !hasUrlLabel(parsed, serviceName)) return { ok: true, yaml: source };

  try {
    if (hasCustomTag(doc)) throw new UnsupportedLayout('The compose file uses a custom YAML tag');
    const splices: Splice[] = [];
    if (isAlias(pair.value)) {
      const resolved = pair.value.resolve(doc);
      if (!isMap(resolved)) {
        console.warn(`Service URL edit refused: ${serviceName} is an alias to something that is not a map.`);
        return { ok: false, reason: 'parse' };
      }
      const body = anchoredBody(source, resolved);
      if (!body) throw new UnsupportedLayout('missing compose range');
      const local: Splice[] = [];
      for (const splice of editServiceLabels(source, doc, resolved, serviceName, url)) {
        if (splice.start >= body.start && splice.end <= body.end) {
          local.push({ start: splice.start - body.start, end: splice.end - body.start, text: splice.text });
        } else {
          splices.push(splice);
        }
      }
      splices.push(placeBody(source, pair.value, applySplices(source.slice(body.start, body.end), local), body.flow));
    } else if (isMap(pair.value)) {
      const anchor = anchorName(pair.value);
      if (anchor) detachOutside(doc, source, pair.value, anchor, splices);
      splices.push(...editServiceLabels(source, doc, pair.value, serviceName, url));
    } else {
      console.warn(`Service URL edit refused: ${serviceName} is not a map.`);
      return { ok: false, reason: 'parse' };
    }
    const yaml = applySplices(source, splices);
    const mismatch = patchMismatch(source, yaml, serviceName, url === null ? null : escapeComposeLiteral(url));
    if (mismatch) throw new UnsupportedLayout(`Refused a service URL edit: ${mismatch}`);
    return { ok: true, yaml };
  } catch (error) {
    if (error instanceof UnsupportedLayout) {
      console.warn(`Service URL edit on ${serviceName} refused:`, error.message);
      return { ok: false, reason: 'unsupported' };
    }
    console.error('Failed to update the service URL label:', error);
    return { ok: false, reason: 'parse' };
  }
}
