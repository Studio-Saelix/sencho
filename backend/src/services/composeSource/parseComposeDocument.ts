/**
 * Pure, ranged reader for one authored Compose YAML document. It never touches
 * the filesystem and never resolves interpolation. It walks the `yaml` AST so
 * every node keeps exact start/end offsets, converts them to 1-based line and
 * UTF-16 column ranges, and records structural facts (short/long form, merge,
 * alias, custom tag) the correlation layer needs.
 *
 * A document `yaml` reports any error for is `parse-failed` and contributes no
 * nodes: a location must never be claimed from a file Compose itself rejects.
 * Library error text is discarded; only a code-derived message survives, so a
 * library message that quotes a source line cannot leak it.
 */
import {
  isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument,
  type Alias, type Document, type Node, type Pair, type Scalar, type YAMLMap, type YAMLSeq,
} from 'yaml';

import type {
  AuthoredDiagnostic, AuthoredNode, AuthoredDiagnosticCode, AuthoredPathSegment, LabelContribution,
  ParsedLabelFile, LabelFileEntry, SourceFileKind, SourceFileState, SourceRange, SourceWritability,
} from './types';

/** Same cap as every other compose parser in the backend. */
export const MAX_COMPOSE_PARSE_BYTES = 1_048_576;
/** At most this many nodes are recorded per file. */
export const MAX_NODES_PER_FILE = 20_000;
/** Alias/merge follow depth; the same bound as `composeInputParse`. */
export const MAX_ALIAS_DEPTH = 16;
/** Total alias/merge traversals one document may perform, across every walk. */
export const MAX_ALIAS_WORK = 10_000;

const DIAGNOSTIC_MESSAGES: Record<AuthoredDiagnosticCode, string> = {
  'duplicate-key': 'The file declares the same key more than once.',
  'malformed-yaml': 'The file is not valid YAML.',
  'too-large': 'The file exceeds the 1 MiB parse cap.',
  'too-deep': 'The include or extends graph exceeds the supported depth.',
  cycle: 'The include or extends graph refers back to itself.',
  'alias-cycle': 'The file expands an alias that refers back to itself.',
  'alias-budget': 'The file expands aliases beyond the supported work budget.',
  'alias-unresolved': 'The file uses an alias this reader cannot resolve.',
  'unsupported-tag': 'The file uses a tag this reader does not follow.',
  'unsupported-syntax': 'A line uses syntax this reader does not reproduce.',
  'bounds-exceeded': 'The file exceeds the node cap for a source model.',
  unreadable: 'The file could not be read.',
};

export function diagnosticMessage(code: AuthoredDiagnosticCode): string {
  return DIAGNOSTIC_MESSAGES[code];
}

/**
 * Authored scalar text, kept out of the node contract on purpose: the model is
 * in-memory only and a value must never reach a response, a log, or a database
 * row. Correlation is the only reader.
 */
const SCALAR_TEXT = new WeakMap<AuthoredNode, string>();

export function authoredScalarOf(node: AuthoredNode | undefined): string | undefined {
  return node === undefined ? undefined : SCALAR_TEXT.get(node);
}

/**
 * Authored label text, kept out of every public structure for the same reason:
 * it is compared with the effective value to decide whether two declarations
 * are distinguishable, and must never reach a response or a log.
 */
const INLINE_LABEL_VALUE = new WeakMap<InlineLabelDeclaration, string>();
const LABEL_FILE_VALUE = new WeakMap<LabelFileEntry, string>();
const LABEL_CONTRIBUTION_VALUE = new WeakMap<LabelContribution, string>();

export function authoredInlineLabelValueOf(declaration: InlineLabelDeclaration): string | undefined {
  return INLINE_LABEL_VALUE.get(declaration);
}

export function authoredLabelFileValueOf(entry: LabelFileEntry): string | undefined {
  return LABEL_FILE_VALUE.get(entry);
}

export function setAuthoredLabelContributionValue(contribution: LabelContribution, value: string | undefined): void {
  if (value !== undefined) LABEL_CONTRIBUTION_VALUE.set(contribution, value);
}

export function authoredLabelContributionValueOf(contribution: LabelContribution): string | undefined {
  return LABEL_CONTRIBUTION_VALUE.get(contribution);
}

/**
 * Collision-free map key for one structural path. A literal segment escapes
 * backslash, dot, and brackets, so a key containing them can never be mistaken
 * for a deeper path or a sequence item. Sequence indexes are the only
 * unescaped brackets.
 */
export function authoredNodeKey(segments: readonly AuthoredPathSegment[]): string {
  let key = '';
  for (const segment of segments) {
    if (typeof segment === 'number') {
      key += `[${segment}]`;
      continue;
    }
    // An empty key still has an identity; `\0` cannot be produced by a
    // non-empty key because a backslash is escaped below.
    const escaped = segment === ''
      ? '\\0'
      : segment
        .replace(/\\/g, '\\\\')
        .replace(/\./g, '\\.')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]');
    key = key === '' ? escaped : `${key}.${escaped}`;
  }
  return key;
}

/** The human dot path quoted by the edit-origin contract; never an identity. */
export function displayAuthoredPath(segments: readonly AuthoredPathSegment[]): string {
  let path = '';
  for (const segment of segments) {
    if (typeof segment === 'number') {
      path += `[${segment}]`;
      continue;
    }
    path = path === '' ? segment : `${path}.${segment}`;
  }
  return path;
}

const INTERPOLATION = /(^|[^$])\$(?:\{|[A-Za-z_])/;

export function hasInterpolationSyntax(text: string): boolean {
  return INTERPOLATION.test(text);
}

/**
 * Compose collapses `$$` to one literal dollar before interpolation, so an
 * escaped dollar must not be mistaken for a variable start (`$$$FOO` still
 * interpolates `FOO`).
 */
export function hasEffectiveInterpolation(text: string): boolean {
  return hasInterpolationSyntax(text.replace(/\$\$/g, ''));
}

export interface IncludeDeclaration {
  paths: string[];
  projectDirectory?: string;
  envFiles: string[];
  interpolation: boolean;
  range?: SourceRange;
}

export interface ExtendsDeclaration {
  /** The service that declares the extends. */
  service: string;
  /** The service it inherits from; defaults to the declaring service's name. */
  baseService?: string;
  /** The file the base is declared in; absent means this same file. */
  file?: string;
  range?: SourceRange;
}

export interface EnvFileDeclaration {
  service: string;
  rawPath: string;
  required: boolean;
  range?: SourceRange;
}

export interface ResourceFileDeclaration {
  kind: 'config' | 'secret';
  key: string;
  file: string;
  range?: SourceRange;
}

export interface LabelFileDeclaration {
  service: string;
  rawPath: string;
  range?: SourceRange;
  /** The path is built from a variable, so this reader cannot name the file it
   *  would read. A consumer must report the input as interpolated, never as
   *  outside the boundary. */
  interpolated?: boolean;
}

export interface InlineLabelDeclaration {
  service: string;
  key: string;
  range: SourceRange;
  form: 'map' | 'list';
  hasInterpolation: boolean;
  /** The list-form key text is interpolated, so Compose may resolve it to any
   *  effective key. A map key is a YAML key and is never interpolated. */
  keyHasInterpolation: boolean;
  /** List form only: the item's own index in the authored sequence. Entries a
   *  consumer does not model (an empty key, a non-string item) still occupy an
   *  index, so ranges must never be reconstructed from a filtered list. */
  listIndex?: number;
  /** The declaration point is an alias whose value cannot be attributed to this key. */
  unresolved?: boolean;
}

export interface ParsedComposeDocument {
  file: string;
  kind: SourceFileKind;
  writability: SourceWritability;
  layerIndex: number;
  state: SourceFileState;
  nodes: Map<string, AuthoredNode>;
  diagnostics: AuthoredDiagnostic[];
  includes: IncludeDeclaration[];
  extends: ExtendsDeclaration[];
  envFiles: EnvFileDeclaration[];
  resources: ResourceFileDeclaration[];
  labelFiles: LabelFileDeclaration[];
  inlineLabels: InlineLabelDeclaration[];
  /** Service keys enumerated under the top-level `services` map, in walk
   *  order (a file's own keys before keys it merges in). */
  serviceNames: string[];
  /**
   * Whether `serviceNames` is the complete set this file declares. False when
   * the reader stopped before it understood the document (malformed YAML, the
   * size cap, a non-map root, an empty document): an empty list then means
   * "unknown", never "zero services". A document refused only for a deep
   * alias/merge chain still enumerates its top-level service keys.
   */
  serviceNamesKnown: boolean;
}

export interface ParseComposeDocumentInput {
  /** Stack-relative POSIX path. */
  file: string;
  kind: SourceFileKind;
  writability: SourceWritability;
  layerIndex: number;
  source: string;
}

function toRange(lineCounter: LineCounter, start: number | undefined, end: number | undefined): SourceRange | undefined {
  if (start === undefined || end === undefined || start < 0 || end < start) return undefined;
  const from = lineCounter.linePos(start);
  const to = lineCounter.linePos(end);
  return {
    line: from.line,
    column: from.col,
    endLine: to.line,
    endColumn: to.col,
  };
}

function nodeRange(lineCounter: LineCounter, node: Node | null | undefined): SourceRange | undefined {
  return node?.range ? toRange(lineCounter, node.range[0], node.range[1]) : undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function asStringList(value: unknown): string[] {
  const one = asString(value);
  if (one !== undefined) return [one];
  if (Array.isArray(value)) return value.map(asString).filter((v): v is string => v !== undefined);
  return [];
}

/**
 * The authored text of one inline label value. Labels are strings in Compose,
 * so YAML scalars are compared in their string spelling. A value this reader
 * would have to interpolate has no fixed text and is not kept.
 */
function inlineLabelValueText(value: unknown): string | undefined {
  if (typeof value === 'string') return hasEffectiveInterpolation(value) ? undefined : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function scalarText(node: Node | null | undefined): string | undefined {
  return isScalar(node) ? asString((node as Scalar).value) : undefined;
}

interface WalkContext {
  lineCounter: LineCounter;
  doc: Document;
  nodes: Map<string, AuthoredNode>;
  diagnostics: AuthoredDiagnostic[];
  source: string;
  nodeCount: number;
  boundsExceeded: boolean;
  /** Service keys encountered under the top-level `services` map, in order. */
  serviceNames: Set<string>;
  /** The `services` mapping itself was fully walked (keys are complete). */
  servicesWalked: boolean;
  /** Aliases and resolved nodes on the current expansion path, for cycle detection. */
  aliasTrail: Set<Node>;
  /** Alias/merge traversals performed so far, across every walk of this document. */
  aliasWork: number;
  aliasBudgetExceeded: boolean;
  aliasCycleReported: boolean;
  aliasUnresolvedReported: boolean;
  tooDeepReported: boolean;
}

/**
 * Diagnostics that mean this reader stopped before it understood the document.
 * A location must never be claimed from a partial walk, so any of these makes
 * the file `parse-failed` even though the YAML library accepted it.
 */
const TRUNCATING_DIAGNOSTICS: ReadonlySet<AuthoredDiagnosticCode> = new Set<AuthoredDiagnosticCode>([
  'alias-cycle', 'alias-budget', 'alias-unresolved', 'too-deep', 'bounds-exceeded', 'unsupported-syntax',
]);

/** Charge one alias/merge traversal. False once the document's shared budget is spent. */
function chargeAliasWork(ctx: WalkContext): boolean {
  if (ctx.aliasBudgetExceeded) return false;
  ctx.aliasWork += 1;
  if (ctx.aliasWork > MAX_ALIAS_WORK) {
    ctx.aliasBudgetExceeded = true;
    ctx.diagnostics.push({ file: '', code: 'alias-budget', message: diagnosticMessage('alias-budget') });
    return false;
  }
  return true;
}

function reportAliasCycle(ctx: WalkContext, node: Node): void {
  if (ctx.aliasCycleReported) return;
  ctx.aliasCycleReported = true;
  ctx.diagnostics.push({
    file: '',
    code: 'alias-cycle',
    message: diagnosticMessage('alias-cycle'),
    ...(nodeRange(ctx.lineCounter, node) ? { range: nodeRange(ctx.lineCounter, node) } : {}),
  });
}

function reportAliasUnresolved(ctx: WalkContext, node: Node): void {
  if (ctx.aliasUnresolvedReported) return;
  ctx.aliasUnresolvedReported = true;
  ctx.diagnostics.push({
    file: '',
    code: 'alias-unresolved',
    message: diagnosticMessage('alias-unresolved'),
    ...(nodeRange(ctx.lineCounter, node) ? { range: nodeRange(ctx.lineCounter, node) } : {}),
  });
}

function reportTooDeep(ctx: WalkContext, node: Node): void {
  if (ctx.tooDeepReported) return;
  ctx.tooDeepReported = true;
  ctx.diagnostics.push({
    file: '',
    code: 'too-deep',
    message: diagnosticMessage('too-deep'),
    ...(nodeRange(ctx.lineCounter, node) ? { range: nodeRange(ctx.lineCounter, node) } : {}),
  });
}

/** Resolve an alias, reporting an anchor this reader cannot see as unresolved. */
function resolveAlias(ctx: WalkContext, alias: Alias): Node | null {
  let resolved: Node | null | undefined;
  try {
    resolved = alias.resolve(ctx.doc) as Node | null | undefined;
  } catch {
    reportAliasUnresolved(ctx, alias);
    return null;
  }
  // A forward or missing anchor resolves to undefined, not to a YAML null node.
  if (resolved === undefined) {
    reportAliasUnresolved(ctx, alias);
    return null;
  }
  return resolved;
}

/**
 * The text of a mapping key. Compose accepts an anchored scalar used as a key
 * (`? *key`), so an alias key must resolve to its scalar text; an alias this
 * reader cannot turn into a key marks the file unresolved rather than dropping
 * the declaration silently.
 */
function authoredKeyText(ctx: WalkContext, node: Node | null | undefined): string | undefined {
  if (!node) return undefined;
  const direct = scalarText(node);
  if (direct !== undefined) return direct;
  if (!isAlias(node)) return undefined;
  if (ctx.aliasTrail.has(node)) {
    reportAliasCycle(ctx, node);
    return undefined;
  }
  if (!chargeAliasWork(ctx)) return undefined;
  const resolved = resolveAlias(ctx, node as Alias);
  if (!resolved) return undefined;
  const text = scalarText(resolved);
  if (text !== undefined) return text;
  ctx.diagnostics.push({
    file: '',
    code: 'unsupported-syntax',
    message: diagnosticMessage('unsupported-syntax'),
    ...(nodeRange(ctx.lineCounter, node) ? { range: nodeRange(ctx.lineCounter, node) } : {}),
  });
  return undefined;
}

function recordNode(
  ctx: WalkContext,
  path: string,
  segments: readonly AuthoredPathSegment[],
  node: Node,
  keyRange: SourceRange | undefined,
  via: 'own' | 'merge' | 'alias',
  form?: 'short' | 'long',
): AuthoredNode | null {
  if (ctx.nodeCount >= MAX_NODES_PER_FILE) {
    if (!ctx.boundsExceeded) {
      ctx.boundsExceeded = true;
      ctx.diagnostics.push({
        file: '',
        code: 'bounds-exceeded',
        message: diagnosticMessage('bounds-exceeded'),
      });
    }
    return null;
  }
  ctx.nodeCount += 1;
  const kind = isMap(node) ? 'mapping' : isSeq(node) ? 'sequence' : isAlias(node) ? 'alias' : 'scalar';
  const tag = typeof (node as { tag?: unknown }).tag === 'string' ? (node as { tag: string }).tag : undefined;
  const customTag = tag === '!reset' || tag === '!override' ? tag : tag ? 'unsupported' : undefined;
  const authored: AuthoredNode = {
    path,
    segments,
    kind,
    ...(keyRange ? { keyRange } : {}),
    ...(nodeRange(ctx.lineCounter, node) ? { valueRange: nodeRange(ctx.lineCounter, node) } : {}),
    ...(form ? { form } : {}),
    hasInterpolation: scalarText(node) !== undefined && hasInterpolationSyntax(scalarText(node)!),
    via,
    ...(typeof (node as { anchor?: string }).anchor === 'string' ? { anchor: (node as { anchor?: string }).anchor } : {}),
    ...(customTag ? { customTag } : {}),
  };
  // An own declaration always wins over a merged one for the same path, and
  // the first merge key wins (YAML merge semantics). The identity is the
  // structural segment list, so a service named `api.image` never stands in
  // for `api`'s `image` field. An alias is replaced by the node it resolves to:
  // the resolved value is the declaration the operator wrote, and its range is
  // the anchor that holds it. The node keeps `via: 'alias'` so the provenance
  // stays visible.
  const identity = authoredNodeKey(segments);
  const existing = ctx.nodes.get(identity);
  if (existing && via === 'merge') return existing;
  ctx.nodes.set(identity, authored);
  const text = scalarText(node);
  if (text !== undefined) SCALAR_TEXT.set(authored, text);
  return authored;
}

function walkValue(
  ctx: WalkContext,
  node: Node | null | undefined,
  path: string,
  segments: readonly AuthoredPathSegment[],
  keyRange: SourceRange | undefined,
  via: 'own' | 'merge' | 'alias',
  depth: number,
  form?: 'short' | 'long',
): void {
  if (!node) return;
  if (isAlias(node)) {
    if (ctx.aliasTrail.has(node)) {
      reportAliasCycle(ctx, node);
      return;
    }
    if (!chargeAliasWork(ctx)) return;
    const authored = recordNode(ctx, path, segments, node, keyRange, 'alias', form);
    if (authored) SCALAR_TEXT.delete(authored);
    if (depth >= MAX_ALIAS_DEPTH) {
      reportTooDeep(ctx, node);
      return;
    }
    const resolved = resolveAlias(ctx, node as Alias);
    if (resolved && ctx.aliasTrail.has(resolved)) {
      reportAliasCycle(ctx, node);
      return;
    }
    ctx.aliasTrail.add(node);
    if (resolved) {
      ctx.aliasTrail.add(resolved);
      walkValue(ctx, resolved, path, segments, keyRange, 'alias', depth + 1, form);
      ctx.aliasTrail.delete(resolved);
    }
    ctx.aliasTrail.delete(node);
    return;
  }
  const authored = recordNode(ctx, path, segments, node, keyRange, via, form);
  if (!authored) return;
  if (isScalar(node)) {
    if (authored.customTag === 'unsupported') {
      ctx.diagnostics.push({
        file: '',
        code: 'unsupported-tag',
        message: diagnosticMessage('unsupported-tag'),
        ...(authored.valueRange ? { range: authored.valueRange } : {}),
      });
    }
    return;
  }
  if (isMap(node)) {
    walkMap(ctx, node as YAMLMap, segments, via, depth);
    return;
  }
  if (isSeq(node)) {
    const seq = node as YAMLSeq;
    seq.items.forEach((item, index) => {
      if (!item || typeof item !== 'object') return;
      const childSegments = [...segments, index];
      walkValue(
        ctx, item as Node, displayAuthoredPath(childSegments), childSegments, undefined, via, depth,
        isMap(item) ? 'long' : 'short',
      );
    });
  }
}

interface FlattenedPairs {
  pairs: Array<{ pair: Pair; via: 'merge' | 'alias' }>;
  /** False when a depth, cycle, or work bound stopped the flattening. */
  complete: boolean;
}

function mergedPairs(ctx: WalkContext, value: Node | null | undefined, depth: number): FlattenedPairs {
  if (!value) return { pairs: [], complete: true };
  if (!chargeAliasWork(ctx)) return { pairs: [], complete: false };
  if (depth >= MAX_ALIAS_DEPTH) {
    reportTooDeep(ctx, value);
    return { pairs: [], complete: false };
  }
  if (isAlias(value)) {
    if (ctx.aliasTrail.has(value)) {
      reportAliasCycle(ctx, value);
      return { pairs: [], complete: false };
    }
    const resolved = resolveAlias(ctx, value as Alias);
    if (resolved && ctx.aliasTrail.has(resolved)) {
      reportAliasCycle(ctx, value);
      return { pairs: [], complete: false };
    }
    ctx.aliasTrail.add(value);
    if (resolved) ctx.aliasTrail.add(resolved);
    const out = mergedPairs(ctx, resolved, depth + 1);
    if (resolved) ctx.aliasTrail.delete(resolved);
    ctx.aliasTrail.delete(value);
    return out;
  }
  if (isMap(value)) {
    const pairs = (value as YAMLMap).items
      .filter((pair): pair is Pair => pair !== null && typeof pair === 'object' && 'key' in pair);
    const merges = pairs.filter(pair => scalarText(pair.key as Node) === '<<');
    const own = pairs.filter(pair => scalarText(pair.key as Node) !== '<<');
    // A mapping used as a merge source can itself merge another anchor. Flatten
    // it here: recording its literal `<<` pair would lose every field it brings
    // in. Own keys take precedence over its merge sources, and earlier sources
    // over later ones, which is the order `walkMap` relies on.
    const out: Array<{ pair: Pair; via: 'merge' | 'alias' }> = own.map(pair => ({ pair, via: 'merge' as const }));
    let complete = true;
    for (const merge of merges) {
      const flattened = mergedPairs(ctx, merge.value as Node, depth + 1);
      out.push(...flattened.pairs);
      complete = complete && flattened.complete;
    }
    return { pairs: out, complete };
  }
  if (isSeq(value)) {
    const out: Array<{ pair: Pair; via: 'merge' | 'alias' }> = [];
    let complete = true;
    for (const item of (value as YAMLSeq).items) {
      if (!chargeAliasWork(ctx)) { complete = false; break; }
      const flattened = mergedPairs(ctx, item as Node, depth + 1);
      out.push(...flattened.pairs);
      complete = complete && flattened.complete;
    }
    return { pairs: out, complete };
  }
  return { pairs: [], complete: true };
}

function walkMap(
  ctx: WalkContext,
  map: YAMLMap,
  segments: readonly AuthoredPathSegment[],
  via: 'own' | 'merge' | 'alias',
  depth: number,
): void {
  const own = map.items.filter((pair): pair is Pair => pair !== null && typeof pair === 'object' && 'key' in pair);
  const mergePairs = own.filter(pair => scalarText(pair.key as Node) === '<<');
  const ownPairs = own.filter(pair => scalarText(pair.key as Node) !== '<<');

  const emit = (pair: Pair, pairVia: 'own' | 'merge' | 'alias'): void => {
    const keyText = authoredKeyText(ctx, pair.key as Node);
    if (keyText === undefined) return;
    // The service-name set comes from the walk, not from the plain projection:
    // a `services` map supplied through an alias or a root merge is still
    // enumerated here, and a deep VALUE never hides its own key. The check is
    // structural: an empty or dotted top-level key that contains a `services`
    // map is not the project's own services map.
    if (segments.length === 1 && segments[0] === 'services') ctx.serviceNames.add(keyText);
    const childSegments = [...segments, keyText];
    const childPath = displayAuthoredPath(childSegments);
    if (pairVia === 'merge' && ctx.nodes.has(authoredNodeKey(childSegments))) return;
    const keyRange = nodeRange(ctx.lineCounter, pair.key as Node);
    walkValue(
      ctx, pair.value as Node, childPath, childSegments, keyRange, pairVia, depth,
      isMap(pair.value) ? 'long' : undefined,
    );
  };

  for (const pair of ownPairs) emit(pair, via);
  let keysComplete = true;
  for (const pair of mergePairs) {
    const merged = mergedPairs(ctx, pair.value as Node, depth);
    if (!merged.complete) keysComplete = false;
    for (const entry of merged.pairs) emit(entry.pair, 'merge');
  }
  if (segments.length === 1 && segments[0] === 'services') {
    ctx.servicesWalked = keysComplete && !ctx.boundsExceeded;
  }
}

function addDiagnostic(
  diagnostics: AuthoredDiagnostic[],
  file: string,
  code: AuthoredDiagnosticCode,
  range?: SourceRange,
): void {
  diagnostics.push({ file, code, message: diagnosticMessage(code), ...(range ? { range } : {}) });
}

/**
 * The YAML library reports a document error with both ends of the offending
 * token. Since a document with any error is unusable for locations, one stable
 * diagnostic per error is enough; the text is ours.
 */
function parseErrorRange(error: { linePos?: Array<{ line: number; col: number }> }): SourceRange | undefined {
  const first = error.linePos?.[0];
  const last = error.linePos?.[1] ?? first;
  if (!first || !last) return undefined;
  return { line: first.line, column: first.col, endLine: last.line, endColumn: last.col };
}

/**
 * The full range of every mapping key, by its document offset. A duplicate-key
 * error points at the start of the second occurrence and reports only its first
 * character; the same traversal that finds the key's node gives the token range.
 * Walking once keeps a file full of duplicate keys from being quadratic.
 */
function keyRangesByStart(
  lineCounter: LineCounter,
  node: Node | null | undefined,
  out: Map<number, SourceRange> = new Map(),
): Map<number, SourceRange> {
  if (!node) return out;
  if (isMap(node)) {
    for (const pair of (node as YAMLMap).items) {
      if (!pair || typeof pair !== 'object' || !('key' in pair)) continue;
      const key = pair.key as Node | null;
      if (key?.range?.[0] !== undefined) {
        const range = nodeRange(lineCounter, key);
        if (range) out.set(key.range[0], range);
      }
      keyRangesByStart(lineCounter, key, out);
      keyRangesByStart(lineCounter, pair.value as Node | null, out);
    }
    return out;
  }
  if (isSeq(node)) {
    for (const item of (node as YAMLSeq).items) keyRangesByStart(lineCounter, item as Node, out);
  }
  return out;
}

function collectDeclarations(
  ctx: WalkContext,
  root: YAMLMap,
  result: Pick<ParsedComposeDocument, 'includes' | 'extends' | 'envFiles' | 'resources' | 'labelFiles' | 'inlineLabels'>,
): void {
  // Declarations are read through the same merge/alias interpretation as the
  // node walk: a root `<<:` that supplies `include` or `services` contributes
  // the same declarations Compose would apply. `valueToPlain` reports depth or
  // budget truncation as a diagnostic, so an unread declaration can never make
  // the project look complete.
  const readable = valueToPlain(ctx, root);
  if (!readable || typeof readable !== 'object' || Array.isArray(readable)) return;
  const rootMap = readable as Record<string, unknown>;

  const include = rootMap.include;
  if (include !== undefined) {
    const items = Array.isArray(include) ? include : [include];
    for (const item of items) {
      if (typeof item === 'string') {
        result.includes.push({ paths: [item], envFiles: [], interpolation: true });
      } else if (item && typeof item === 'object') {
        const map = item as Record<string, unknown>;
        const paths = asStringList(map.path);
        if (paths.length > 0) {
          result.includes.push({
            paths,
            ...(asString(map.project_directory) !== undefined ? { projectDirectory: asString(map.project_directory)! } : {}),
            envFiles: asStringList(map.env_file),
            interpolation: map.interpolation !== false,
          });
        }
      }
    }
  }

  const services = rootMap.services;
  if (services && typeof services === 'object' && !Array.isArray(services)) {
    for (const [service, value] of Object.entries(services as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const svc = value as Record<string, unknown>;
      const ext = svc.extends;
      if (typeof ext === 'string') {
        // Short form: the base service is in this same file.
        result.extends.push({ service, baseService: ext });
      } else if (ext && typeof ext === 'object' && !Array.isArray(ext)) {
        const map = ext as Record<string, unknown>;
        const file = asString(map.file);
        const baseService = asString(map.service);
        // A declaration with neither a file nor a named service still extends
        // the same-named service in this file; record it so it is resolved or
        // reported, never silently dropped.
        result.extends.push({
          service,
          ...(baseService !== undefined ? { baseService } : {}),
          ...(file !== undefined ? { file } : {}),
        });
      }
      const envFile = svc.env_file;
      if (envFile !== undefined) {
        const entries = Array.isArray(envFile) ? envFile : [envFile];
        for (const entry of entries) {
          if (typeof entry === 'string') {
            result.envFiles.push({ service, rawPath: entry, required: true });
          } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
            const raw = asString((entry as Record<string, unknown>).path);
            if (raw !== undefined) {
              result.envFiles.push({
                service,
                rawPath: raw,
                required: (entry as Record<string, unknown>).required !== false,
              });
            }
          }
        }
      }
      for (const rawPath of asStringList(svc.label_file)) {
        result.labelFiles.push({
          service,
          rawPath,
          // A path built from a variable names no file this reader can read.
          // It is an interpolation refusal, not an outside-boundary one.
          ...(hasEffectiveInterpolation(rawPath) ? { interpolated: true } : {}),
        });
      }
      const labels = svc.labels;
      if (labels && typeof labels === 'object') {
        if (Array.isArray(labels)) {
          labels.forEach((item, listIndex) => {
            const text = typeof item === 'string' ? item : undefined;
            // A non-string item is not label syntax Compose accepts; it still
            // occupies its sequence index, which later declarations keep.
            if (text === undefined) return;
            const eq = text.indexOf('=');
            // A bare item is a real Compose label with an empty value, and an
            // item beginning with `=` is a label with an empty key. Both are
            // accepted by Compose and keep their place in the list.
            const rawKey = eq === -1 ? text : text.slice(0, eq);
            // Compose interpolates the whole list item, so `$$` becomes one
            // literal dollar in the effective key. The key itself is unknown
            // only when a real variable (not an escaped dollar) is present.
            const key = rawKey.replace(/\$\$/g, '$');
            const declaration: InlineLabelDeclaration = {
              service,
              key,
              range: { line: 1, column: 1, endLine: 1, endColumn: 1 },
              form: 'list',
              hasInterpolation: hasEffectiveInterpolation(text),
              // Compose interpolates the whole list item, so a variable in the
              // key portion can resolve to any effective label key.
              keyHasInterpolation: hasEffectiveInterpolation(rawKey),
              listIndex,
            };
            if (!hasEffectiveInterpolation(text)) {
              INLINE_LABEL_VALUE.set(declaration, eq === -1 ? '' : text.slice(eq + 1));
            }
            result.inlineLabels.push(declaration);
          });
        } else {
          for (const [labelKey, labelValue] of Object.entries(labels as Record<string, unknown>)) {
            const declaration: InlineLabelDeclaration = {
              service,
              key: labelKey,
              range: { line: 1, column: 1, endLine: 1, endColumn: 1 },
              form: 'map',
              // A YAML mapping key is never interpolated; only its value is.
              hasInterpolation: typeof labelValue === 'string' && hasEffectiveInterpolation(labelValue),
              keyHasInterpolation: false,
            };
            const value = inlineLabelValueText(labelValue);
            if (value !== undefined) INLINE_LABEL_VALUE.set(declaration, value);
            result.inlineLabels.push(declaration);
          }
        }
      }
    }
  }

  for (const [key, kind] of [['configs', 'config'], ['secrets', 'secret']] as const) {
    const resources = rootMap[key];
    if (!resources || typeof resources !== 'object' || Array.isArray(resources)) continue;
    for (const [resourceKey, def] of Object.entries(resources as Record<string, unknown>)) {
      if (!def || typeof def !== 'object' || Array.isArray(def)) continue;
      const file = asString((def as Record<string, unknown>).file);
      if (file !== undefined) result.resources.push({ kind, key: resourceKey, file });
    }
  }
}

/**
 * A small plain-value projection used only to enumerate declarations (include
 * paths, env_file entries, label lists, extends). It follows aliases and merge
 * keys under the same cycle/work/depth budget as the node walk, because a
 * declaration behind an alias or a merge is still a declaration: dropping it
 * would let an earlier file look decisive. `mergeDepth` counts only alias and
 * merge hops, which is exactly what the walk bounds; ordinary nesting does not
 * consume the bound. A cycle, an unresolved anchor, or a merge deeper than the
 * supported graph is a truncating diagnostic: the file is not understood and
 * no origin may be claimed from it.
 */
function valueToPlain(
  ctx: WalkContext,
  node: Node | null | undefined,
  mergeDepth = 0,
  trail: Set<Node> = new Set(),
): unknown {
  if (!node) return undefined;
  if (isAlias(node)) {
    if (trail.has(node)) {
      reportAliasCycle(ctx, node);
      return undefined;
    }
    if (mergeDepth >= MAX_ALIAS_DEPTH) {
      reportTooDeep(ctx, node);
      return undefined;
    }
    if (!chargeAliasWork(ctx)) return undefined;
    const resolved = resolveAlias(ctx, node as Alias);
    if (!resolved) return undefined;
    if (trail.has(resolved)) {
      reportAliasCycle(ctx, node);
      return undefined;
    }
    trail.add(node);
    trail.add(resolved);
    const out = valueToPlain(ctx, resolved, mergeDepth + 1, trail);
    trail.delete(resolved);
    trail.delete(node);
    return out;
  }
  if (isScalar(node)) return (node as Scalar).value;
  if (isSeq(node)) return (node as YAMLSeq).items.map(item => valueToPlain(ctx, item as Node, mergeDepth, trail));
  if (isMap(node)) {
    // A null prototype keeps a document key such as `__proto__` as data.
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const pairs = (node as YAMLMap).items
      .filter((pair): pair is Pair => pair !== null && typeof pair === 'object' && 'key' in pair);
    // YAML merge semantics: merged keys first, then the map's own keys win.
    for (const pair of pairs.filter(entry => scalarText(entry.key as Node) === '<<')) {
      if (mergeDepth >= MAX_ALIAS_DEPTH) {
        reportTooDeep(ctx, pair.value as Node);
        continue;
      }
      if (!chargeAliasWork(ctx)) continue;
      const merged = valueToPlain(ctx, pair.value as Node, mergeDepth + 1, trail);
      const sources = Array.isArray(merged) ? merged : [merged];
      for (const source of sources) {
        if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
        // YAML merge: a key in an earlier source wins over a later source.
        for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
          if (!(key in out)) out[key] = value;
        }
      }
    }
    for (const pair of pairs.filter(entry => scalarText(entry.key as Node) !== '<<')) {
      const key = authoredKeyText(ctx, pair.key as Node);
      if (key !== undefined) out[key] = valueToPlain(ctx, pair.value as Node, mergeDepth, trail);
    }
    return out;
  }
  return undefined;
}

export function parseComposeDocument(input: ParseComposeDocumentInput): ParsedComposeDocument {
  const empty: ParsedComposeDocument = {
    file: input.file,
    kind: input.kind,
    writability: input.writability,
    layerIndex: input.layerIndex,
    state: 'parsed',
    nodes: new Map(),
    diagnostics: [],
    includes: [],
    extends: [],
    envFiles: [],
    resources: [],
    labelFiles: [],
    inlineLabels: [],
    serviceNames: [],
    serviceNamesKnown: false,
  };

  if (Buffer.byteLength(input.source, 'utf8') > MAX_COMPOSE_PARSE_BYTES) {
    addDiagnostic(empty.diagnostics, input.file, 'too-large');
    return { ...empty, state: 'too-large' };
  }

  const lineCounter = new LineCounter();
  const doc = parseDocument(input.source, { lineCounter });
  if (doc.errors.length > 0) {
    const keyRanges = doc.errors.some(error => error.code === 'DUPLICATE_KEY')
      ? keyRangesByStart(lineCounter, doc.contents as Node | null)
      : undefined;
    for (const error of doc.errors) {
      const duplicate = error.code === 'DUPLICATE_KEY';
      const code: AuthoredDiagnosticCode = duplicate ? 'duplicate-key' : 'malformed-yaml';
      const range = (duplicate && error.pos
        ? keyRanges?.get(error.pos[0])
        : undefined) ?? parseErrorRange(error);
      addDiagnostic(empty.diagnostics, input.file, code, range);
    }
    return { ...empty, state: 'parse-failed' };
  }

  if (doc.contents === null) return empty;
  if (!isMap(doc.contents)) {
    addDiagnostic(empty.diagnostics, input.file, 'malformed-yaml', nodeRange(lineCounter, doc.contents as Node));
    return { ...empty, state: 'parse-failed' };
  }

  const ctx: WalkContext = {
    lineCounter,
    doc,
    nodes: empty.nodes,
    diagnostics: [],
    source: input.source,
    nodeCount: 0,
    boundsExceeded: false,
    serviceNames: new Set<string>(),
    servicesWalked: false,
    aliasTrail: new Set(),
    aliasWork: 0,
    aliasBudgetExceeded: false,
    aliasCycleReported: false,
    aliasUnresolvedReported: false,
    tooDeepReported: false,
  };

  // The root itself is not a compose declaration, so its children are the
  // documented paths (`services.api.image`, `networks.edge`, ...).
  walkMap(ctx, doc.contents as YAMLMap, [], 'own', 0);
  collectDeclarations(ctx, doc.contents as YAMLMap, empty);
  // The walk owns the service-name list: it follows aliases and merge keys and
  // records each key as it is enumerated, so a chain that is too deep only
  // stops the values below that key, never the names above it.
  empty.serviceNames = [...ctx.serviceNames];
  empty.serviceNamesKnown = ctx.servicesWalked && !ctx.boundsExceeded;

  for (const diagnostic of ctx.diagnostics) diagnostic.file = input.file;
  for (const declaration of empty.includes) declaration.range = declaration.range ?? undefined;
  empty.diagnostics.push(...ctx.diagnostics);

  // Attach declaration ranges from the recorded nodes where a declaration has
  // a direct counterpart. The walker already recorded these paths; ranges stay
  // optional because a dynamic/map declaration may not expose a scalar.
  for (const declaration of empty.labelFiles) {
    const node = empty.nodes.get(authoredNodeKey(['services', declaration.service, 'label_file']));
    declaration.range = node?.valueRange;
  }
  for (const declaration of empty.envFiles) {
    const node = empty.nodes.get(authoredNodeKey(['services', declaration.service, 'env_file']));
    declaration.range = node?.valueRange;
  }
  for (const declaration of empty.resources) {
    const node = empty.nodes.get(authoredNodeKey([
      declaration.kind === 'config' ? 'configs' : 'secrets', declaration.key, 'file',
    ]));
    declaration.range = node?.valueRange;
  }

  // Inline label ranges: map form uses the key/value pair; list form uses the
  // item itself. Each declaration carries its own sequence index from the
  // authored list, so an item this model does not interpret can never shift a
  // later declaration onto another entry's range.
  const resolvedInline: typeof empty.inlineLabels = [];
  for (const declaration of empty.inlineLabels) {
    let node: AuthoredNode | undefined;
    if (declaration.form === 'map') {
      node = empty.nodes.get(authoredNodeKey(['services', declaration.service, 'labels', declaration.key]));
    } else {
      if (declaration.listIndex === undefined) continue;
      node = empty.nodes.get(authoredNodeKey([
        'services', declaration.service, 'labels', declaration.listIndex,
      ]));
    }
    // The node cap can stop the walk before a declaration. A missing range must
    // never fall back to line 1: the declaration is dropped instead.
    if (!node || (!node.valueRange && !node.keyRange)) continue;
    declaration.range = (node.kind === 'scalar' ? node.valueRange : node.keyRange) ?? node.valueRange ?? node.keyRange!;
    declaration.hasInterpolation = declaration.hasInterpolation || node.hasInterpolation;
    // The label key is declared through an alias. Its value is written at the
    // anchor, which this key cannot attribute, so no origin may be claimed.
    if (node.kind === 'alias') declaration.unresolved = true;
    resolvedInline.push(declaration);
  }
  empty.inlineLabels = resolvedInline;

  // A walk that hit a cycle, an unresolved anchor, a depth or work budget, or
  // the node cap did not see every declaration. Correlation must refuse the
  // whole file rather than claim an origin from the part it managed to read.
  const truncated = ctx.diagnostics.some(diagnostic => TRUNCATING_DIAGNOSTICS.has(diagnostic.code));
  return truncated ? { ...empty, state: 'parse-failed' } : empty;
}

/**
 * Env-file-like label file: `key=value` per line, `#` comments and blank lines
 * ignored, split at the first `=`. Compose accepts an `export ` prefix on an
 * env-file line, so it is accepted here and never becomes part of the key. One
 * layer of matching quotes is stripped for value comparison only; this reader
 * never keeps the value. Anything outside that subset is a fixed per-line
 * diagnostic, never a guess.
 */
export function parseLabelFile(file: string, source: string): ParsedLabelFile {
  const diagnostics: AuthoredDiagnostic[] = [];
  const entries: LabelFileEntry[] = [];
  const duplicateKeys = new Set<string>();
  if (Buffer.byteLength(source, 'utf8') > MAX_COMPOSE_PARSE_BYTES) {
    addDiagnostic(diagnostics, file, 'too-large');
    return { file, entries, diagnostics, duplicateKeys };
  }

  const seen = new Set<string>();
  const lines = source.split('\n');
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index].replace(/\r$/, '');
    const lineStart = offset;
    offset += lines[index].length + 1;
    const trimmed = rawLine.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    // Compose strips an env-file `export` keyword; it is syntax, not part of
    // the key. Leading whitespace is allowed before it, and a tab may separate
    // it from the key.
    const exportPrefix = /^\s*export[ \t]+/.exec(rawLine);
    const prefixLength = exportPrefix ? exportPrefix[0].length : 0;
    const eq = rawLine.indexOf('=', prefixLength);
    if (eq <= prefixLength) {
      addDiagnostic(diagnostics, file, 'unsupported-syntax', {
        line: index + 1, column: 1, endLine: index + 1, endColumn: Math.max(1, rawLine.length),
      });
      continue;
    }
    const keyPart = rawLine.slice(prefixLength, eq);
    const key = keyPart.trim();
    const keyLead = keyPart.length - keyPart.trimStart().length;
    const keyStart = prefixLength + keyLead;
    const rawValue = rawLine.slice(eq + 1);
    if (key === '' || !isSupportedLabelText(key) || !isSupportedLabelText(rawValue)) {
      addDiagnostic(diagnostics, file, 'unsupported-syntax', {
        line: index + 1, column: 1, endLine: index + 1, endColumn: Math.max(1, rawLine.length),
      });
      continue;
    }
    const valueStart = lineStart + eq + 1;
    const valueEnd = lineStart + rawLine.length;
    if (seen.has(key)) duplicateKeys.add(key);
    seen.add(key);
    const entry: LabelFileEntry = {
      key,
      range: {
        line: index + 1,
        column: keyStart + 1,
        endLine: index + 1,
        endColumn: Math.max(keyStart + 1, rawLine.length + 1),
      },
      keyRange: {
        line: index + 1,
        column: keyStart + 1,
        endLine: index + 1,
        endColumn: Math.max(keyStart + 1, eq + 1),
      },
      valueRange: {
        line: index + 1,
        column: eq + 2,
        endLine: index + 1,
        endColumn: Math.max(eq + 2, valueEnd - lineStart + 1),
      },
      // Compose collapses `$$` before interpolation, so `$$${FOO}` still
      // interpolates. The escaped-dollar form must be detected the same way the
      // node walk detects it, or a location would be claimed for a value whose
      // effective text this reader cannot know.
      hasInterpolation: hasEffectiveInterpolation(rawLine.slice(0, valueStart - lineStart))
        || hasEffectiveInterpolation(rawValue),
    };
    // The text is kept only for comparison with the effective value, and only
    // when neither the key nor the value needs interpolation. Compose strips
    // one layer of matching quotes from an env-file value; do the same here.
    if (!hasEffectiveInterpolation(rawLine.slice(prefixLength))) {
      const value = rawValue
        && (rawValue[0] === '"' || rawValue[0] === "'")
        && rawValue[rawValue.length - 1] === rawValue[0]
        ? rawValue.slice(1, -1)
        : rawValue;
      LABEL_FILE_VALUE.set(entry, value);
    }
    entries.push(entry);
  }
  return { file, entries, diagnostics, duplicateKeys };
}

/**
 * The accepted label-file subset: no unbalanced matching quotes, no escape
 * sequences. A quoted value is read literally, including any `$`, which is why
 * the entry is still flagged for interpolation rather than resolved.
 */
function isSupportedLabelText(value: string): boolean {
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' || first === "'") && last !== first) return false;
  if (value.includes('\\')) return false;
  return true;
}
