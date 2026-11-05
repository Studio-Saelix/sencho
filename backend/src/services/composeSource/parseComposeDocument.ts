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
  AuthoredDiagnostic, AuthoredNode, AuthoredDiagnosticCode, ParsedLabelFile,
  LabelFileEntry, SourceFileKind, SourceFileState, SourceRange, SourceWritability,
} from './types';

/** Same cap as every other compose parser in the backend. */
export const MAX_COMPOSE_PARSE_BYTES = 1_048_576;
/** At most this many nodes are recorded per file. */
export const MAX_NODES_PER_FILE = 20_000;
/** Alias/merge follow depth; the same bound as `composeInputParse`. */
export const MAX_ALIAS_DEPTH = 16;

const DIAGNOSTIC_MESSAGES: Record<AuthoredDiagnosticCode, string> = {
  'duplicate-key': 'The file declares the same key more than once.',
  'malformed-yaml': 'The file is not valid YAML.',
  'too-large': 'The file exceeds the 1 MiB parse cap.',
  'too-deep': 'The include or extends graph exceeds the supported depth.',
  cycle: 'The include or extends graph refers back to itself.',
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

const INTERPOLATION = /(^|[^$])\$(?:\{|[A-Za-z_])/;

export function hasInterpolationSyntax(text: string): boolean {
  return INTERPOLATION.test(text);
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
  /** The service it inherits from, when the declaration names one. */
  baseService?: string;
  file: string;
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
}

export interface InlineLabelDeclaration {
  service: string;
  key: string;
  range: SourceRange;
  form: 'map' | 'list';
  hasInterpolation: boolean;
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
}

function recordNode(
  ctx: WalkContext,
  path: string,
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
  // the first merge key wins (YAML merge semantics).
  const existing = ctx.nodes.get(path);
  if (existing && (via === 'merge' || (existing.via !== 'merge' && via === 'alias'))) return existing;
  ctx.nodes.set(path, authored);
  const text = scalarText(node);
  if (text !== undefined) SCALAR_TEXT.set(authored, text);
  return authored;
}

function walkValue(
  ctx: WalkContext,
  node: Node | null | undefined,
  path: string,
  keyRange: SourceRange | undefined,
  via: 'own' | 'merge' | 'alias',
  depth: number,
  form?: 'short' | 'long',
): void {
  if (!node) return;
  if (isAlias(node)) {
    const authored = recordNode(ctx, path, node, keyRange, 'alias', form);
    if (authored) SCALAR_TEXT.delete(authored);
    if (depth >= MAX_ALIAS_DEPTH) {
      ctx.diagnostics.push({ file: '', code: 'too-deep', message: diagnosticMessage('too-deep'), ...(nodeRange(ctx.lineCounter, node) ? { range: nodeRange(ctx.lineCounter, node) } : {}) });
      return;
    }
    const resolved: Node | null = (() => {
      try {
        return (node as Alias).resolve(ctx.doc) as Node | null;
      } catch {
        return null;
      }
    })();
    if (resolved) walkValue(ctx, resolved, path, keyRange, 'alias', depth + 1, form);
    return;
  }
  const authored = recordNode(ctx, path, node, keyRange, via, form);
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
    walkMap(ctx, node as YAMLMap, path, via, depth);
    return;
  }
  if (isSeq(node)) {
    const seq = node as YAMLSeq;
    seq.items.forEach((item, index) => {
      if (!item || typeof item !== 'object') return;
      walkValue(ctx, item as Node, `${path}[${index}]`, undefined, via, depth, isMap(item) ? 'long' : 'short');
    });
  }
}

function mergedPairs(ctx: WalkContext, value: Node | null | undefined, depth: number): Array<{ pair: Pair; via: 'merge' | 'alias' }> {
  if (!value) return [];
  if (depth >= MAX_ALIAS_DEPTH) {
    ctx.diagnostics.push({ file: '', code: 'too-deep', message: diagnosticMessage('too-deep'), ...(nodeRange(ctx.lineCounter, value) ? { range: nodeRange(ctx.lineCounter, value) } : {}) });
    return [];
  }
  if (isAlias(value)) {
    const resolved: Node | null = (() => {
      try {
        return (value as Alias).resolve(ctx.doc) as Node | null;
      } catch {
        return null;
      }
    })();
    return mergedPairs(ctx, resolved, depth + 1);
  }
  if (isMap(value)) {
    return (value as YAMLMap).items
      .filter((pair): pair is Pair => pair !== null && typeof pair === 'object' && 'key' in pair)
      .map(pair => ({ pair, via: 'merge' as const }));
  }
  if (isSeq(value)) {
    const out: Array<{ pair: Pair; via: 'merge' | 'alias' }> = [];
    for (const item of (value as YAMLSeq).items) {
      out.push(...mergedPairs(ctx, item as Node, depth + 1));
    }
    return out;
  }
  return [];
}

function walkMap(
  ctx: WalkContext,
  map: YAMLMap,
  path: string,
  via: 'own' | 'merge' | 'alias',
  depth: number,
): void {
  const own = map.items.filter((pair): pair is Pair => pair !== null && typeof pair === 'object' && 'key' in pair);
  const mergePairs = own.filter(pair => scalarText(pair.key as Node) === '<<');
  const ownPairs = own.filter(pair => scalarText(pair.key as Node) !== '<<');

  const emit = (pair: Pair, pairVia: 'own' | 'merge' | 'alias'): void => {
    const keyText = scalarText(pair.key as Node);
    if (keyText === undefined) return;
    const childPath = path ? `${path}.${keyText}` : keyText;
    if (pairVia === 'merge' && ctx.nodes.has(childPath)) return;
    const keyRange = nodeRange(ctx.lineCounter, pair.key as Node);
    walkValue(ctx, pair.value as Node, childPath, keyRange, pairVia, depth, isMap(pair.value) ? 'long' : undefined);
  };

  for (const pair of ownPairs) emit(pair, via);
  for (const pair of mergePairs) {
    for (const merged of mergedPairs(ctx, pair.value as Node, depth)) emit(merged.pair, 'merge');
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

function collectDeclarations(
  ctx: WalkContext,
  root: YAMLMap,
  result: Pick<ParsedComposeDocument, 'includes' | 'extends' | 'envFiles' | 'resources' | 'labelFiles' | 'inlineLabels'>,
): void {
  const readable = new Map<string, unknown>();

  for (const pair of root.items) {
    if (!pair || typeof pair !== 'object' || !('key' in pair)) continue;
    const key = scalarText(pair.key as Node);
    if (key === undefined) continue;
    readable.set(key, valueToPlain(pair.value as Node));
  }

  const include = readable.get('include');
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

  const services = readable.get('services');
  if (services && typeof services === 'object' && !Array.isArray(services)) {
    for (const [service, value] of Object.entries(services as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const svc = value as Record<string, unknown>;
      const ext = svc.extends;
      if (ext && typeof ext === 'object') {
        const map = ext as Record<string, unknown>;
        const file = asString(map.file);
        if (file !== undefined) {
          const baseService = asString(map.service);
          result.extends.push({ service, ...(baseService !== undefined ? { baseService } : {}), file });
        }
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
        result.labelFiles.push({ service, rawPath });
      }
      const labels = svc.labels;
      if (labels && typeof labels === 'object') {
        if (Array.isArray(labels)) {
          for (const item of labels) {
            const text = typeof item === 'string' ? item : undefined;
            if (text === undefined) continue;
            const eq = text.indexOf('=');
            if (eq <= 0) continue;
            result.inlineLabels.push({
              service,
              key: text.slice(0, eq),
              range: { line: 1, column: 1, endLine: 1, endColumn: 1 },
              form: 'list',
              hasInterpolation: hasInterpolationSyntax(text),
            });
          }
        } else {
          for (const [labelKey, labelValue] of Object.entries(labels as Record<string, unknown>)) {
            result.inlineLabels.push({
              service,
              key: labelKey,
              range: { line: 1, column: 1, endLine: 1, endColumn: 1 },
              form: 'map',
              hasInterpolation: hasInterpolationSyntax(labelKey)
                || (typeof labelValue === 'string' && hasInterpolationSyntax(labelValue)),
            });
          }
        }
      }
    }
  }

  for (const [key, kind] of [['configs', 'config'], ['secrets', 'secret']] as const) {
    const resources = readable.get(key);
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
 * paths, env_file entries, label lists). Values are structural here and are
 * never retained on the model: `labels` values are reduced to the key plus an
 * interpolation flag, and env/config/secret files are identity only.
 */
function valueToPlain(node: Node | null | undefined, depth = 0): unknown {
  if (!node || depth > 8) return undefined;
  if (isScalar(node)) return (node as Scalar).value;
  if (isSeq(node)) return (node as YAMLSeq).items.map(item => valueToPlain(item as Node, depth + 1));
  if (isMap(node)) {
    const out: Record<string, unknown> = {};
    for (const pair of (node as YAMLMap).items) {
      if (!pair || typeof pair !== 'object' || !('key' in pair)) continue;
      const key = scalarText(pair.key as Node);
      if (key !== undefined) out[key] = valueToPlain(pair.value as Node, depth + 1);
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
  };

  if (Buffer.byteLength(input.source, 'utf8') > MAX_COMPOSE_PARSE_BYTES) {
    addDiagnostic(empty.diagnostics, input.file, 'too-large');
    return { ...empty, state: 'too-large' };
  }

  const lineCounter = new LineCounter();
  const doc = parseDocument(input.source, { lineCounter });
  if (doc.errors.length > 0) {
    for (const error of doc.errors) {
      const code: AuthoredDiagnosticCode = error.code === 'DUPLICATE_KEY' ? 'duplicate-key' : 'malformed-yaml';
      addDiagnostic(empty.diagnostics, input.file, code, parseErrorRange(error));
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
  };

  // The root itself is not a compose declaration, so its children are the
  // documented paths (`services.api.image`, `networks.edge`, ...).
  walkMap(ctx, doc.contents as YAMLMap, '', 'own', 0);
  collectDeclarations(ctx, doc.contents as YAMLMap, empty);

  for (const diagnostic of ctx.diagnostics) diagnostic.file = input.file;
  for (const declaration of empty.includes) declaration.range = declaration.range ?? undefined;
  empty.diagnostics.push(...ctx.diagnostics);

  // Attach declaration ranges from the recorded nodes where a declaration has
  // a direct counterpart. The walker already recorded these paths; ranges stay
  // optional because a dynamic/map declaration may not expose a scalar.
  for (const declaration of empty.labelFiles) {
    const node = empty.nodes.get(`services.${declaration.service}.label_file`);
    declaration.range = node?.valueRange;
  }
  for (const declaration of empty.envFiles) {
    const node = empty.nodes.get(`services.${declaration.service}.env_file`);
    declaration.range = node?.valueRange;
  }
  for (const declaration of empty.resources) {
    const node = empty.nodes.get(`${declaration.kind === 'config' ? 'configs' : 'secrets'}.${declaration.key}.file`);
    declaration.range = node?.valueRange;
  }

  // Inline label ranges: map form uses the key/value pair; list form uses the
  // item itself. The declaration order matches the file's own order because
  // both the node walk and `valueToPlain` read the map in order.
  const mapKeys = new Map<string, AuthoredNode>();
  for (const [path, node] of empty.nodes) {
    const match = /^services\.([^.]+)\.labels\.(.+)$/.exec(path);
    if (match && node.kind === 'scalar') mapKeys.set(`${match[1]}\0${match[2]}`, node);
  }
  let listIndexByService = new Map<string, number>();
  const resolvedInline: typeof empty.inlineLabels = [];
  for (const declaration of empty.inlineLabels) {
    let node: AuthoredNode | undefined;
    if (declaration.form === 'map') {
      node = mapKeys.get(`${declaration.service}\0${declaration.key}`);
    } else {
      const next = listIndexByService.get(declaration.service) ?? 0;
      listIndexByService = listIndexByService.set(declaration.service, next + 1);
      node = empty.nodes.get(`services.${declaration.service}.labels[${next}]`);
    }
    // The node cap can stop the walk before a declaration. A missing range must
    // never fall back to line 1: the declaration is dropped instead.
    if (!node || (!node.valueRange && !node.keyRange)) continue;
    declaration.range = (node.kind === 'scalar' ? node.valueRange : node.keyRange) ?? node.valueRange ?? node.keyRange!;
    declaration.hasInterpolation = node.hasInterpolation;
    resolvedInline.push(declaration);
  }
  empty.inlineLabels = resolvedInline;

  return empty;
}

/**
 * Env-file-like label file: `key=value` per line, `#` comments and blank lines
 * ignored, split at the first `=`. One layer of matching quotes is stripped for
 * value comparison only; this reader never keeps the value. Anything outside
 * that subset is a fixed per-line diagnostic, never a guess.
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

    const eq = rawLine.indexOf('=');
    if (eq <= 0) {
      addDiagnostic(diagnostics, file, 'unsupported-syntax', {
        line: index + 1, column: 1, endLine: index + 1, endColumn: Math.max(1, rawLine.length),
      });
      continue;
    }
    const key = rawLine.slice(0, eq).trim();
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
    entries.push({
      key,
      range: { line: index + 1, column: 1, endLine: index + 1, endColumn: Math.max(1, rawLine.length + 1) },
      keyRange: { line: index + 1, column: 1, endLine: index + 1, endColumn: eq + 1 },
      valueRange: {
        line: index + 1,
        column: eq + 2,
        endLine: index + 1,
        endColumn: Math.max(eq + 2, valueEnd - lineStart + 1),
      },
      hasInterpolation: hasInterpolationSyntax(rawLine.slice(0, valueStart - lineStart)) || hasInterpolationSyntax(rawValue),
    });
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
