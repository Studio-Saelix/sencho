/**
 * The authored Compose source model: the third model of a stack, separate from
 * the rendered effective model and from Docker runtime state.
 *
 * It answers one question only: where did an operator write the declaration
 * that produced an effective value? It never mutates a file, never resolves
 * interpolation, and never stores a rendered value. Ambiguity is a first-class
 * outcome; a consumer either gets a location it may act on or a typed refusal.
 */

export type SourceFileKind =
  | 'compose-primary'
  | 'compose-additional'
  | 'compose-override'
  | 'compose-include'
  | 'compose-extends'
  | 'label-file'
  | 'env-file'
  | 'config'
  | 'secret';

export type SourceWritability =
  | 'writable'
  | 'generated'
  | 'external'
  | 'git-authoritative'
  | 'outside-boundary';

/**
 * `identity-only` marks an input the model records but deliberately never reads
 * (env files, secrets, configs): its identity is provenance, its contents can
 * carry rendered values.
 */
export type SourceFileState =
  | 'parsed'
  | 'unreadable'
  | 'parse-failed'
  | 'too-large'
  | 'outside-boundary'
  | 'identity-only';

export interface SourceRange {
  /** 1-based. */
  line: number;
  /** 1-based UTF-16 column, matching Monaco's column model. */
  column: number;
  endLine: number;
  endColumn: number;
}

export type AuthoredNodeKind = 'mapping' | 'sequence' | 'scalar' | 'alias';

export interface AuthoredNode {
  /** Dot path, e.g. `services.api.image` or `services.api.ports[0]`. */
  path: string;
  kind: AuthoredNodeKind;
  keyRange?: SourceRange;
  valueRange?: SourceRange;
  /** Present for sequence items: short form (scalar) or long form (mapping). */
  form?: 'short' | 'long';
  /** Syntax only: a `$VAR` / `${VAR}` form is present. Never resolved. */
  hasInterpolation: boolean;
  via: 'own' | 'merge' | 'alias';
  anchor?: string;
  customTag?: '!reset' | '!override' | 'unsupported';
}

export type AuthoredDiagnosticCode =
  | 'duplicate-key'
  | 'malformed-yaml'
  | 'too-large'
  | 'too-deep'
  | 'cycle'
  | 'unsupported-tag'
  | 'unsupported-syntax'
  | 'bounds-exceeded'
  | 'unreadable';

export interface AuthoredDiagnostic {
  /** Stack-relative POSIX path. */
  file: string;
  code: AuthoredDiagnosticCode;
  /** Fixed text, derived from the code. Never quotes source content. */
  message: string;
  range?: SourceRange;
}

export interface AuthoredFileSource {
  /** Stack-relative POSIX path. */
  file: string;
  kind: SourceFileKind;
  writability: SourceWritability;
  /** Merge order, 0 first. */
  layerIndex: number;
  state: SourceFileState;
  nodes: ReadonlyMap<string, AuthoredNode>;
  diagnostics: AuthoredDiagnostic[];
}

export interface LabelContribution {
  key: string;
  source: 'inline' | 'label-file';
  /** Stack-relative POSIX path of the declaring file. */
  file: string;
  /** Range of the entry, or of the inline map key. */
  range: SourceRange;
  form?: 'map' | 'list';
  /** Order within the service's `label_file` list. */
  fileIndex: number;
  /** Merge order of the declaring compose file, 0 first. */
  layerIndex: number;
  hasInterpolation: boolean;
  overridden: boolean;
  via: 'own' | 'extends' | 'merge';
  /** True when the backing label file is used by more than one service. */
  shared?: boolean;
}

export type LabelAmbiguity =
  | 'duplicate-key'
  | 'unparsed-source'
  | 'interpolated'
  | 'outside-boundary';

export interface ServiceAuthoredLabels {
  service: string;
  contributions: LabelContribution[];
  winners: Record<string, LabelContribution>;
  sharedFiles: string[];
  ambiguity: Record<string, LabelAmbiguity>;
  /** Label files this service names that could not be parsed or read. */
  unparsedLabelFiles: string[];
  /** Label declarations this service names that leave the managed boundary. */
  outsideLabelFiles: string[];
}

export type CorrelationReason =
  | 'unique'
  | 'override-winner'
  | 'inline-overrides-label-file'
  | 'label-file'
  | 'interpolated'
  | 'normalized'
  | 'compose-tag'
  | 'generated-layer'
  | 'shared-input'
  | 'ambiguous-multiple-sources'
  | 'ambiguous-unparsed-source'
  | 'no-authored-source';

/** The reasons a consumer may act on. Everything else is a typed refusal. */
const ACTING_REASONS: ReadonlySet<CorrelationReason> = new Set<CorrelationReason>([
  'unique', 'override-winner', 'inline-overrides-label-file', 'label-file', 'shared-input', 'normalized',
]);

export function isActingReason(reason: CorrelationReason): boolean {
  return ACTING_REASONS.has(reason);
}

export interface CorrelationCandidate {
  file: string;
  range: SourceRange;
  path: string;
  layerIndex: number;
}

export interface CorrelationOrigin {
  file: string;
  writability: SourceWritability;
  range: SourceRange;
  path: string;
  layerIndex: number;
}

export interface CorrelationResult {
  path: string;
  origin?: CorrelationOrigin;
  candidates: CorrelationCandidate[];
  reason: CorrelationReason;
  /** Fixed structural detail. Never contains a value. */
  ambiguity?: { kind: string; detail: string };
}

export interface AuthoredProject {
  stack: string;
  nodeId: number;
  files: AuthoredFileSource[];
  generatedLayers: Array<'mesh-override'>;
  labels: Map<string, ServiceAuthoredLabels>;
  diagnostics: AuthoredDiagnostic[];
  partial: boolean;
  partialReasons: string[];
  /** Services an `extends` declaration inherits from, keyed by the extending service. */
  extendsServices?: Map<string, string[]>;
}

/** A location on the wire: stack-relative file plus a 1-based range. */
export interface AuthoredLocation {
  file: string;
  path?: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

/** A parsed label-file entry. The entry's value text never leaves the parser. */
export interface LabelFileEntry {
  key: string;
  range: SourceRange;
  keyRange: SourceRange;
  valueRange: SourceRange;
  hasInterpolation: boolean;
}

export interface ParsedLabelFile {
  file: string;
  entries: LabelFileEntry[];
  diagnostics: AuthoredDiagnostic[];
  /** Keys declared more than once in one file; no winner may be claimed. */
  duplicateKeys: Set<string>;
}
