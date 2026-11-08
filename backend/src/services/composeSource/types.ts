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

/**
 * One structural step of an authored path: a mapping key exactly as written, or
 * a sequence index. Dots and brackets inside a key stay data, so `services.api.image`
 * (a field of `api`) and `services.api.image` (a service whose name contains a
 * dot) are different identities.
 */
export type AuthoredPathSegment = string | number;

export interface AuthoredNode {
  /** Dot path for display and the edit-origin contract, e.g. `services.api.image`
   *  or `services.api.ports[0]`. Not an identity: a service name may contain a
   *  dot, so internal lookup uses `segments`. */
  path: string;
  /** Collision-free structural identity of this node. */
  segments: readonly AuthoredPathSegment[];
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
  | 'alias-cycle'
  | 'alias-budget'
  | 'alias-unresolved'
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
  /** Top-level service keys this file declares, when the walk enumerated the
   *  `services` map. Absent means "unknown" (malformed YAML, size cap), never
   *  "none": a deep alias or merge chain in a service value still leaves this
   *  list known. */
  serviceNames?: string[];
  /** sha256 of the UTF-8 content this build read, when it read the file. A
   *  location persisted from this build carries it so a later read can prove
   *  the file has not changed since. */
  contentHash?: string;
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
  /** Effective merge order of the declaration that introduced it, 0 first. */
  layerIndex: number;
  /** Authority of the file that carries the entry. */
  writability: SourceWritability;
  hasInterpolation: boolean;
  /** The key itself is built from a variable (list-form labels only): Compose
   *  may resolve it to any effective key, so it can supersede a literal winner. */
  keyHasInterpolation?: boolean;
  overridden: boolean;
  via: 'own' | 'extends' | 'merge';
  /** True when the backing label file is used by more than one service. */
  shared?: boolean;
}

export type LabelAmbiguity =
  | 'duplicate-key'
  | 'unparsed-source'
  | 'unresolved-alias'
  | 'interpolated'
  | 'outside-boundary';

export interface ServiceAuthoredLabels {
  service: string;
  contributions: LabelContribution[];
  /** The same contributions grouped by key, in the same order. Built once with
   *  the model so a per-key consumer never scans the whole service list. */
  contributionsByKey: Map<string, LabelContribution[]>;
  winners: Record<string, LabelContribution>;
  sharedFiles: string[];
  ambiguity: Record<string, LabelAmbiguity>;
  /** A label key is built from a variable, so some effective key this service
   *  declares has no known literal name. Consumers must refuse a key that has
   *  no literal winner for this service. */
  hasDynamicKeys?: boolean;
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

/**
 * One file-scoped service declaration that contributes to an effective service.
 * `extends` bases are copied into the extending layer: `layerIndex` is the
 * project layer that introduced them and `rank` records whether it is inherited
 * (0) or the layer's own declaration (1). The builder emits a deepest-base-first
 * array and consumers preserve that order. That keeps a same-named service in
 * an unrelated file from being treated as a declaration of this one.
 */
export interface AuthoredServiceDefinition {
  /** Effective service name in the project. */
  service: string;
  /** Service key in `file`; differs when an `extends` base is inherited. */
  declaredService: string;
  file: string;
  layerIndex: number;
  /** 0 = inherited through `extends`, 1 = the layer's own declaration. */
  rank: 0 | 1;
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
  /** File-scoped declarations of every effective service, in merge order. */
  serviceDefinitions: Map<string, AuthoredServiceDefinition[]>;
  /** Services whose `extends` graph could not be resolved (missing file, cycle, ...). */
  unresolvedServices: Set<string>;
}

/** A location on the wire: stack-relative file plus a 1-based range. */
export interface AuthoredLocation {
  file: string;
  path?: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  /** sha256 of the file content the range was computed against. Persisted
   *  with the location so a read can tell whether the range still applies. */
  fileHash?: string;
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
