/**
 * Correlate an effective field back to the authored declaration that produced
 * it. The model never reimplements Compose's merge: it collects every authored
 * candidate in layer order, then uses the effective value only to disambiguate.
 * When that cannot be decided, the result is an explicit ambiguous reason and
 * no origin.
 */
import { authoredLabelContributionValueOf, authoredNodeKey, authoredScalarOf } from './parseComposeDocument';
import {
  isActingReason, type AuthoredNode, type AuthoredProject, type CorrelationCandidate,
  type CorrelationOrigin, type CorrelationReason, type CorrelationResult, type LabelContribution,
  type ServiceAuthoredLabels, type SourceFileKind,
} from './types';

interface Candidate {
  file: string;
  node: AuthoredNode;
  layerIndex: number;
  writability: CorrelationOrigin['writability'];
}

const PROJECT_COMPOSE_KINDS: ReadonlySet<SourceFileKind> = new Set([
  'compose-primary', 'compose-additional', 'compose-override', 'compose-include',
]);

/**
 * The range to show. A scalar's value is what the operator edits; for a mapping
 * or sequence the key is the stable anchor, because its value range starts at
 * the first child rather than at the declaration.
 */
export function displayRange(node: AuthoredNode) {
  return (node.kind === 'scalar' || node.kind === 'alias' ? node.valueRange : node.keyRange)
    ?? node.valueRange
    ?? node.keyRange
    ?? { line: 1, column: 1, endLine: 1, endColumn: 1 };
}

function mergeCandidate(candidate: Candidate): CorrelationCandidate {
  return {
    file: candidate.file,
    range: displayRange(candidate.node),
    path: candidate.node.path,
    layerIndex: candidate.layerIndex,
  };
}

function originOf(candidate: Candidate): CorrelationOrigin {
  return {
    file: candidate.file,
    writability: candidate.writability,
    range: displayRange(candidate.node),
    path: candidate.node.path,
    layerIndex: candidate.layerIndex,
  };
}

export function hasOutsideComposeLayer(project: AuthoredProject): boolean {
  return project.files.some(file =>
    (file.kind === 'compose-primary' || file.kind === 'compose-additional' || file.kind === 'compose-override'
      || file.kind === 'compose-include' || file.kind === 'compose-extends')
    && file.state === 'outside-boundary');
}

/** Project layers this reader could not parse; an extends base is handled per service. */
function unparsedFiles(project: AuthoredProject): string[] {
  return project.files
    .filter(file => PROJECT_COMPOSE_KINDS.has(file.kind) && file.state !== 'parsed')
    .map(file => file.file);
}

export function hasUnparsedComposeLayer(project: AuthoredProject): boolean {
  return unparsedFiles(project).length > 0;
}

/**
 * A project layer at or after `layerIndex` could still supersede a declaration
 * that layer introduced, so no origin there is actionable.
 */
export function hasLaterUnparsedLayer(project: AuthoredProject, layerIndex: number): boolean {
  return project.files.some(file =>
    PROJECT_COMPOSE_KINDS.has(file.kind) && file.state !== 'parsed' && file.layerIndex >= layerIndex);
}

export function hasUnresolvedService(project: AuthoredProject, service: string): boolean {
  return project.unresolvedServices.has(service);
}

/**
 * A project include/extends cycle is rejected by Compose; the model cannot know
 * which layer order a deploy would have used, so no origin is decisive.
 */
export function hasProjectCycle(project: AuthoredProject): boolean {
  return project.partialReasons.includes('project-cycle');
}

/**
 * Structural segments for one field. A service's own field names are plain
 * Compose keys, but an `environment` or label key is data and may itself
 * contain a dot, so it stays one segment. Sequence fields keep their numeric
 * indices (`ports[0].published`), matching the walker's identity.
 */
function fieldSegments(field: string): Array<string | number> {
  if (field.startsWith('environment.')) return ['environment', field.slice('environment.'.length)];
  if (field.startsWith('labels.')) return ['labels', field.slice('labels.'.length)];
  const out: Array<string | number> = [];
  for (const part of field ? field.split('.') : []) {
    const match = /^([^[\]]+)((?:\[\d+\])*)$/.exec(part);
    if (!match) {
      out.push(part);
      continue;
    }
    out.push(match[1]);
    for (const index of match[2].matchAll(/\[(\d+)\]/g)) out.push(Number(index[1]));
  }
  return out;
}

/**
 * A `!reset`/`!override` on a field or one of its parent mappings
 * (`environment`, `labels`, ...) removes or replaces the declaration, so it is
 * not decisive. Only the winner's own layer or a later one can supersede it.
 */
function hasTaggedFieldOrAncestorAtOrAfter(
  project: AuthoredProject,
  service: string,
  field: string,
  layerIndex: number,
): boolean {
  if (!field) return false;
  const segments = fieldSegments(field);
  for (const definition of project.serviceDefinitions.get(service) ?? []) {
    if (definition.layerIndex < layerIndex) continue;
    const file = project.files.find(entry => entry.file === definition.file && entry.state === 'parsed');
    if (!file) continue;
    for (let length = 1; length <= segments.length; length += 1) {
      const path = authoredNodeKey(['services', definition.declaredService, ...segments.slice(0, length)]);
      if (file.nodes.get(path)?.customTag !== undefined) return true;
    }
  }
  return false;
}

function baseResult(project: AuthoredProject, path: string, candidates: Candidate[], reason: CorrelationReason): CorrelationResult {
  return {
    path,
    candidates: candidates.map(candidate => mergeCandidate(candidate)),
    reason,
  };
}

function refusal(
  project: AuthoredProject,
  path: string,
  candidates: Candidate[],
  reason: CorrelationReason,
  kind: string,
  detail: string,
): CorrelationResult {
  return { ...baseResult(project, path, candidates, reason), ambiguity: { kind, detail } };
}

/**
 * Every declaration of a service field, in merge order. The project's
 * file-scoped definitions are authoritative: a same-named service in an
 * unrelated file is not a declaration of this one, while an `extends` base is
 * included at the layer that inherits it, below that layer's own declaration.
 */
export function fieldCandidates(project: AuthoredProject, service: string, field: string): Candidate[] {
  const out: Candidate[] = [];
  // The graph is authoritative. A service it does not name has no authored
  // declaration, even if an unrelated file happens to reuse the service name.
  for (const definition of project.serviceDefinitions.get(service) ?? []) {
    const file = project.files.find(entry => entry.file === definition.file && entry.state === 'parsed');
    // A declared definition this model cannot read would shrink the candidate
    // set silently; refuse the field rather than claim the remainder.
    if (!file) return [];
    const node = file.nodes.get(authoredNodeKey([
      'services', definition.declaredService, ...fieldSegments(field),
    ]));
    if (!node) continue;
    out.push({ file: file.file, node, layerIndex: definition.layerIndex, writability: file.writability });
  }
  return out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Known Compose normalizations only: a short port entry gains its protocol,
 * an authored `$$` becomes `$`, and whitespace/quote noise is trimmed. Anything
 * else is compared literally.
 */
export function normalizeForCompare(field: string, text: string): string {
  const unescaped = text.replace(/\$\$/g, '$');
  if (field === 'ports') {
    const trimmed = unescaped.trim();
    const slash = trimmed.lastIndexOf('/');
    const base = slash === -1 ? trimmed : trimmed.slice(0, slash);
    const protocol = (slash === -1 ? '' : trimmed.slice(slash + 1)) || 'tcp';
    return `${base}/${protocol}`;
  }
  return unescaped.trim();
}

function matches(field: string, authored: string, effective: string): { matched: boolean; normalized: boolean } {
  const normalizedAuthored = normalizeForCompare(field, authored);
  const normalizedEffective = normalizeForCompare(field, effective);
  if (normalizedAuthored === normalizedEffective) return { matched: true, normalized: normalizedAuthored !== authored.trim() };
  return { matched: false, normalized: false };
}

/** Whether a candidate cannot be resolved to literal text at all. */
function isUnresolved(candidate: Candidate): boolean {
  return candidate.node.hasInterpolation || candidate.node.customTag !== undefined || candidate.node.kind === 'alias';
}

/** Correlate one scalar service field against its effective value. */
export function correlateField(
  project: AuthoredProject,
  service: string,
  field: string,
  effectiveValue?: string,
): CorrelationResult {
  const path = field ? `services.${service}.${field}` : `services.${service}`;
  const candidates = fieldCandidates(project, service, field);
  if (hasOutsideComposeLayer(project)) {
    return refusal(project, path, candidates, 'ambiguous-unparsed-source', 'outside-boundary',
      'A declared Compose layer is outside the managed boundary.');
  }
  if (hasProjectCycle(project)) {
    return refusal(project, path, candidates, 'ambiguous-unparsed-source', 'cycle',
      'The include or extends graph refers back to itself.');
  }
  if (hasUnresolvedService(project, service)) {
    return refusal(project, path, candidates, 'ambiguous-unparsed-source', 'unresolved-extends',
      'The service extends a declaration this reader could not resolve.');
  }
  if (candidates.length === 0) {
    if (project.generatedLayers.includes('mesh-override') && (field === 'networks' || field === 'extra_hosts')) {
      return baseResult(project, path, candidates, 'generated-layer');
    }
    if (unparsedFiles(project).length > 0) {
      return refusal(project, path, candidates, 'ambiguous-unparsed-source', 'unparsed-source',
        'One or more compose layers could not be parsed.');
    }
    return baseResult(project, path, candidates, 'no-authored-source');
  }

  const tagged = candidates.filter(candidate => candidate.node.customTag !== undefined);
  if (tagged.length === candidates.length) {
    const markers = tagged.every(candidate => candidate.node.customTag === '!reset' || candidate.node.customTag === '!override');
    return refusal(project, path, candidates, 'compose-tag', 'compose-tag',
      markers
        ? 'A Compose !reset or !override marker is present.'
        : 'The declaration uses a tag this reader does not follow.');
  }

  if (candidates.length === 1) {
    const only = candidates[0];
    if (only.node.hasInterpolation) {
      return refusal(project, path, candidates, 'interpolated', 'interpolated',
        'The authored value contains interpolation.');
    }
    if (only.node.kind === 'alias') {
      return refusal(project, path, candidates, 'ambiguous-multiple-sources', 'unresolved-candidate',
        'The declaration is an alias whose text is not resolved in this model.');
    }
    if (hasLaterUnparsedLayer(project, only.layerIndex)) {
      return refusal(project, path, candidates, 'ambiguous-unparsed-source', 'unparsed-source',
        'A later compose layer could not be parsed.');
    }
    if (hasTaggedFieldOrAncestorAtOrAfter(project, service, field, only.layerIndex)) {
      return refusal(project, path, candidates, 'compose-tag', 'compose-tag',
        'A parent mapping carries a Compose !reset or !override marker.');
    }
    // A mapping or sequence merges across layers: even an earlier unparsed
    // layer can contribute the subfield or item that caused the finding.
    if (only.node.kind !== 'scalar' && unparsedFiles(project).length > 0) {
      return refusal(project, path, candidates, 'ambiguous-unparsed-source', 'unparsed-source',
        'A compose layer could not be parsed.');
    }
    if (effectiveValue !== undefined) {
      const text = authoredScalarOf(only.node);
      if (text !== undefined) {
        const verdict = matches(field, text, effectiveValue);
        if (!verdict.matched) return baseResult(project, path, candidates, 'no-authored-source');
        const result = baseResult(project, path, candidates, verdict.normalized ? 'normalized' : 'unique');
        return { ...result, origin: originOf(only) };
      }
    }
    const result = baseResult(project, path, candidates, 'unique');
    return { ...result, origin: originOf(only) };
  }

  const comparable = candidates.filter(candidate => !isUnresolved(candidate));
  if (effectiveValue !== undefined) {
    const exact: Candidate[] = [];
    const normalized: Candidate[] = [];
    for (const candidate of comparable) {
      const text = authoredScalarOf(candidate.node);
      if (text === undefined) continue;
      const verdict = matches(field, text, effectiveValue);
      if (verdict.matched) (verdict.normalized ? normalized : exact).push(candidate);
    }
    if (exact.length === 1) {
      return matchedOrigin(project, service, field, path, candidates, exact[0], 'override-winner');
    }
    if (exact.length === 0 && normalized.length === 1) {
      return matchedOrigin(project, service, field, path, candidates, normalized[0], 'normalized');
    }
    if (exact.length + normalized.length > 1) {
      return refusal(project, path, candidates, 'ambiguous-multiple-sources', 'multiple-matches',
        'More than one authored declaration matches the effective value.');
    }
    // A literal candidate that does not match the effective value means the
    // effective model contradicts the authored chain (a later layer was not
    // applied, or a tag/interpolation changed it); no origin is defensible.
  }

  if (candidates.some(candidate => candidate.node.hasInterpolation)) {
    return refusal(project, path, candidates, 'interpolated', 'interpolated',
      'A candidate contains interpolation, so the winning literal cannot be decided.');
  }
  return refusal(project, path, candidates, 'ambiguous-multiple-sources', 'multiple-candidates',
    'Several layers declare this field and none uniquely matches.');
}

/**
 * A single matching literal is actionable only when nothing later can supersede
 * it: a later unresolved candidate, a later unparsed layer, or a later literal
 * that contradicts the effective value.
 */
function matchedOrigin(
  project: AuthoredProject,
  service: string,
  field: string,
  path: string,
  candidates: Candidate[],
  match: Candidate,
  reason: CorrelationReason,
): CorrelationResult {
  const index = candidates.indexOf(match);
  const later = index === -1 ? [] : candidates.slice(index + 1);
  if (hasTaggedFieldOrAncestorAtOrAfter(project, service, field, match.layerIndex)) {
    return refusal(project, path, candidates, 'compose-tag', 'compose-tag',
      'A parent mapping carries a Compose !reset or !override marker.');
  }
  if (later.some(candidate => candidate.node.hasInterpolation)) {
    return refusal(project, path, candidates, 'interpolated', 'interpolated',
      'A later candidate contains interpolation and could supersede the match.');
  }
  if (later.some(candidate => candidate.node.customTag !== undefined)) {
    return refusal(project, path, candidates, 'compose-tag', 'compose-tag',
      'A later candidate carries a Compose !reset or !override marker.');
  }
  if (later.some(candidate => candidate.node.kind === 'alias')) {
    return refusal(project, path, candidates, 'ambiguous-multiple-sources', 'unresolved-candidate',
      'A later declaration is an alias whose text is not resolved in this model.');
  }
  if (hasLaterUnparsedLayer(project, match.layerIndex)) {
    return refusal(project, path, candidates, 'ambiguous-unparsed-source', 'unparsed-source',
      'A later compose layer could not be parsed.');
  }
  if (later.length > 0) {
    return refusal(project, path, candidates, 'ambiguous-multiple-sources', 'later-candidate',
      'A later authored declaration contradicts the effective value.');
  }
  const result = baseResult(project, path, candidates, reason);
  return { ...result, origin: originOf(match) };
}

function labelReason(winner: LabelContribution, contributions: LabelContribution[]): CorrelationReason {
  if (winner.source === 'label-file') {
    return winner.shared ? 'shared-input' : 'label-file';
  }
  const fileContribution = contributions.some(contribution => contribution.source === 'label-file' && contribution.key === winner.key);
  return fileContribution ? 'inline-overrides-label-file' : 'unique';
}

/** Correlate one Compose-declared label key on one service. */
export function correlateLabel(
  project: AuthoredProject,
  service: string,
  key: string,
  effectiveValue?: string,
): CorrelationResult {
  const labels: ServiceAuthoredLabels | undefined = project.labels.get(service);
  const path = `services.${service}.labels.${key}`;
  if (hasOutsideComposeLayer(project)) {
    return refusal(project, path, [], 'ambiguous-unparsed-source', 'outside-boundary',
      'A declared Compose layer is outside the managed boundary.');
  }
  if (hasProjectCycle(project)) {
    return refusal(project, path, [], 'ambiguous-unparsed-source', 'cycle',
      'The include or extends graph refers back to itself.');
  }
  if (hasUnresolvedService(project, service)) {
    return refusal(project, path, [], 'ambiguous-unparsed-source', 'unparsed-source',
      'The service extends a declaration this reader could not resolve.');
  }
  if (!labels) {
    if (unparsedFiles(project).length > 0) {
      return refusal(project, path, [], 'ambiguous-unparsed-source', 'unparsed-source',
        'A compose layer could not be parsed.');
    }
    return baseResult(project, path, [], 'no-authored-source');
  }

  const ambiguity = labels.ambiguity[key];
  if (ambiguity !== undefined) {
    const reason: CorrelationReason = ambiguity === 'duplicate-key'
      ? 'ambiguous-multiple-sources'
      : ambiguity === 'interpolated'
        ? 'interpolated'
        : ambiguity === 'outside-boundary'
          ? 'no-authored-source'
          : 'ambiguous-unparsed-source';
    return refusal(project, path, [], reason, ambiguity,
      'The label source cannot be decided from the authored files.');
  }

  const winner = labels.winners[key];
  if (!winner) {
    if (labels.unparsedLabelFiles.length > 0) {
      return refusal(project, path, [], 'ambiguous-unparsed-source', 'unparsed-source',
        'A label file for this service could not be parsed.');
    }
    if (labels.outsideLabelFiles.length > 0) {
      return refusal(project, path, [], 'no-authored-source', 'outside-boundary',
        'A label declaration leaves the managed boundary.');
    }
    if (labels.interpolatedLabelFiles.length > 0) {
      return refusal(project, path, [], 'interpolated', 'interpolated',
        'A label file path is built from a variable and cannot be resolved.');
    }
    if (unparsedFiles(project).length > 0) {
      return refusal(project, path, [], 'ambiguous-unparsed-source', 'unparsed-source',
        'A compose layer could not be parsed.');
    }
    // A list-form key built from a variable could itself be this key. Compose
    // does not let this model resolve it, so no literal source is decisive.
    if (labels.hasDynamicKeys === true) {
      return refusal(project, path, [], 'interpolated', 'interpolated',
        'A label key is built from a variable, so the effective key cannot be decided.');
    }
    return baseResult(project, path, [], 'no-authored-source');
  }

  // A `labels: !reset`/`!override` at or after the winner removes or replaces
  // the whole map, so the child declaration is not decisive.
  if (hasTaggedFieldOrAncestorAtOrAfter(project, service, 'labels', winner.layerIndex)) {
    return refusal(project, path, [], 'compose-tag', 'compose-tag',
      'The labels mapping carries a Compose !reset or !override marker.');
  }

  // A label-file winner is never decisive while another label file for the same
  // service is unreadable, outside the boundary, or interpolated: that file
  // could declare the key or override it. An inline winner outranks every label
  // file, so only a later compose layer can supersede it.
  if (winner.source === 'label-file' && labels.unparsedLabelFiles.length > 0) {
    return refusal(project, path, [], 'ambiguous-unparsed-source', 'unparsed-source',
      'Another label file for this service could not be parsed.');
  }
  if (winner.source === 'label-file' && labels.outsideLabelFiles.length > 0) {
    return refusal(project, path, [], 'no-authored-source', 'outside-boundary',
      'A label declaration leaves the managed boundary.');
  }
  if (winner.source === 'label-file' && labels.interpolatedLabelFiles.length > 0) {
    return refusal(project, path, [], 'interpolated', 'interpolated',
      'A label file path is built from a variable and could override this key.');
  }
  // Inline labels outrank every label file, so any unparsed compose layer, even
  // an earlier one, could still hold a decisive inline declaration.
  if (winner.source === 'label-file' && unparsedFiles(project).length > 0) {
    return refusal(project, path, [], 'ambiguous-unparsed-source', 'unparsed-source',
      'A compose layer could not be parsed.');
  }
  if (hasLaterUnparsedLayer(project, winner.layerIndex)) {
    return refusal(project, path, [], 'ambiguous-unparsed-source', 'unparsed-source',
      'A later compose layer could not be parsed.');
  }
  const contributions = labels.contributionsByKey.get(key) ?? [];

  // A field declared in more than one place is located only when exactly one
  // candidate matches the effective value. Inline declarations outrank every
  // label file, so the only peers are declarations of the winning source. With
  // no effective value (an edit-origin request) two declarations that carry the
  // same text are still indistinguishable.
  const tier = contributions.filter(contribution => contribution.source === winner.source);
  const winnerValue = authoredLabelContributionValueOf(winner);
  if (winnerValue !== undefined) {
    const target = effectiveValue ?? winnerValue;
    const matches = tier.filter((contribution) => {
      const value = authoredLabelContributionValueOf(contribution);
      return value !== undefined && normalizeForCompare('labels', value) === normalizeForCompare('labels', target);
    });
    if (matches.length === 0) {
      return tier.length === 1
        ? baseResult(project, path, [], 'no-authored-source')
        : refusal(project, path, [], 'ambiguous-multiple-sources', 'multiple-candidates',
          'Several declarations exist and none matches the effective value.');
    }
    if (matches.length > 1) {
      return refusal(project, path, [], 'ambiguous-multiple-sources', 'multiple-matches',
        'More than one authored declaration matches the effective value.');
    }
    if (matches[0] !== winner) {
      return refusal(project, path, [], 'ambiguous-multiple-sources', 'later-candidate',
        'A later authored declaration contradicts the effective value.');
    }
  }

  const origin: CorrelationOrigin = {
    file: winner.file,
    writability: winner.writability,
    range: winner.range,
    path,
    layerIndex: winner.layerIndex,
  };
  return {
    path,
    origin,
    candidates: contributions.map(contribution => ({
      file: contribution.file,
      range: contribution.range,
      path,
      layerIndex: contribution.layerIndex,
    })),
    reason: labelReason(winner, contributions),
  };
}

/** Locate a `$VAR` / `${VAR}` reference by scanning authored scalar text. */
export function correlateVariableReference(
  project: AuthoredProject,
  variable: string,
  service?: string,
): CorrelationResult {
  const path = service ? `services.${service}` : 'env';
  if (hasProjectCycle(project)) {
    return refusal(project, path, [], 'ambiguous-unparsed-source', 'cycle',
      'The include or extends graph refers back to itself.');
  }
  const pattern = new RegExp(`(?<!\\$)\\$(?:\\{${escapeRegExp(variable)}(?::?[-+?][^}]*)?\\}|${escapeRegExp(variable)}(?![A-Za-z0-9_]))`);
  const found: Candidate[] = [];
  const definitions = service !== undefined ? project.serviceDefinitions.get(service) : undefined;
  if (service !== undefined && !definitions) {
    // The service has no authored declaration in this project; do not scan
    // unrelated files that happen to reuse its name.
    return baseResult(project, path, [], 'no-authored-source');
  }
  if (definitions) {
    for (const definition of definitions) {
      const file = project.files.find(entry => entry.file === definition.file && entry.state === 'parsed');
      if (!file) return baseResult(project, path, [], 'no-authored-source');
      for (const node of file.nodes.values()) {
        if (node.segments[0] !== 'services' || node.segments[1] !== definition.declaredService) continue;
        const text = authoredScalarOf(node);
        if (text === undefined || !pattern.test(text)) continue;
        found.push({ file: file.file, node, layerIndex: definition.layerIndex, writability: file.writability });
      }
    }
  } else {
    for (const file of project.files) {
      if (file.state !== 'parsed') continue;
      for (const node of file.nodes.values()) {
        if (service !== undefined
          && (node.segments[0] !== 'services' || node.segments[1] !== service)) continue;
        const text = authoredScalarOf(node);
        if (text === undefined || !pattern.test(text)) continue;
        found.push({ file: file.file, node, layerIndex: file.layerIndex, writability: file.writability });
      }
    }
  }
  if (service !== undefined && hasUnresolvedService(project, service)) {
    return refusal(project, path, found, 'ambiguous-unparsed-source', 'unresolved-extends',
      'The service extends a declaration this reader could not resolve.');
  }
  if (found.length === 1) {
    // Another reference in any unparsed layer would make this one not unique.
    if (unparsedFiles(project).length > 0 || (service === undefined && project.unresolvedServices.size > 0)) {
      return refusal(project, path, found, 'ambiguous-unparsed-source', 'unparsed-source',
        'A compose layer could not be parsed.');
    }
    return { ...baseResult(project, path, found, 'unique'), origin: originOf(found[0]) };
  }
  if (found.length > 1) {
    return refusal(project, path, found, 'ambiguous-multiple-sources', 'multiple-references',
      'The variable is referenced in more than one place.');
  }
  if (unparsedFiles(project).length > 0 || project.unresolvedServices.size > 0) {
    return refusal(project, path, [], 'ambiguous-unparsed-source', 'unparsed-source',
      'One or more compose layers could not be parsed.');
  }
  return baseResult(project, path, [], 'no-authored-source');
}

type AuthoredPathSplit =
  | { kind: 'found'; service: string; field: string }
  | { kind: 'ambiguous-multiple' }
  | { kind: 'ambiguous-unparsed' };

/**
 * Split `services.<name>.<field>` using the project's own service names. A
 * Compose service name may contain dots, so the same text can name a field of
 * `api` or the service `api.image`. An interpretation is viable when the
 * project authors that node or its file cannot be read; when more than one is
 * viable the path cannot say which structure was meant, so the edit origin is
 * refused with the reason that names the uncertainty.
 */
function splitAuthoredPath(project: AuthoredProject, path: string): AuthoredPathSplit | null {
  const prefix = 'services.';
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  const candidates: Array<{ service: string; field: string }> = [];
  for (const candidate of project.serviceDefinitions.keys()) {
    if (rest === candidate) candidates.push({ service: candidate, field: '' });
    else if (rest.startsWith(`${candidate}.`)) {
      candidates.push({ service: candidate, field: rest.slice(candidate.length + 1) });
    }
  }
  if (candidates.length === 0) return null;
  const viable = candidates.map(entry => ({
    ...entry,
    state: interpretationState(project, entry.service, entry.field),
  })).filter(entry => entry.state !== null);
  if (viable.length === 1) return { kind: 'found', service: viable[0].service, field: viable[0].field };
  if (viable.length > 1) {
    return viable.some(entry => entry.state === 'unread')
      ? { kind: 'ambiguous-unparsed' }
      : { kind: 'ambiguous-multiple' };
  }
  // No interpretation names a readable node: keep the historical longest-name
  // rule so a request for a missing field still reaches a typed refusal.
  candidates.sort((a, b) => b.service.length - a.service.length);
  return candidates[0] ? { kind: 'found', service: candidates[0].service, field: candidates[0].field } : null;
}

/**
 * Whether a label interpretation names an authored declaration, or one this
 * reader cannot rule out. Label keys can come from an inline map, an inline
 * list, or a managed label file, and a variable-built key can stand for any
 * effective key. Consulting the assembled label model is what keeps a display
 * path such as `services.api.labels.owner` from resolving to a different
 * service named `api.labels.owner`.
 */
function labelInterpretationState(
  project: AuthoredProject,
  service: string,
  key: string,
): 'authored' | 'unread' | null {
  const labels = project.labels.get(service);
  if (!labels) return null;
  if (labels.ambiguity[key] !== undefined) return 'authored';
  if (labels.winners[key] !== undefined) return 'authored';
  if ((labels.contributionsByKey.get(key)?.length ?? 0) > 0) return 'authored';
  // An `extends` base this reader could not resolve could declare the label.
  if (hasUnresolvedService(project, service)) return 'unread';
  // A list-form key built from a variable could resolve to this key, and a
  // label file this reader could not read (or was not allowed to read) could
  // declare it. Either way the interpretation is not ruled out.
  if (labels.hasDynamicKeys) return 'unread';
  if (labels.unparsedLabelFiles.length > 0 || labels.outsideLabelFiles.length > 0
    || labels.interpolatedLabelFiles.length > 0) return 'unread';
  if (unparsedFiles(project).length > 0) return 'unread';
  return null;
}

/** Whether an interpretation names an authored node, or a file we cannot read. */
function interpretationState(
  project: AuthoredProject,
  service: string,
  field: string,
): 'authored' | 'unread' | null {
  const labelPrefix = 'labels.';
  if (field.startsWith(labelPrefix)) {
    return labelInterpretationState(project, service, field.slice(labelPrefix.length));
  }
  const segments = fieldSegments(field);
  for (const definition of project.serviceDefinitions.get(service) ?? []) {
    const file = project.files.find(entry => entry.file === definition.file);
    if (!file || file.state !== 'parsed') return 'unread';
    if (file.nodes.has(authoredNodeKey(['services', definition.declaredService, ...segments]))) return 'authored';
  }
  return null;
}

/**
 * The only door an edit provider may use: it returns an origin solely for a
 * reason that may be acted on. Every other reason is a typed refusal.
 */
export function resolveEditOrigin(
  project: AuthoredProject,
  path: string,
): { ok: true; origin: CorrelationOrigin } | { ok: false; reason: CorrelationReason } {
  const split = splitAuthoredPath(project, path);
  if (!split) return { ok: false, reason: 'no-authored-source' };
  if (split.kind === 'ambiguous-multiple') return { ok: false, reason: 'ambiguous-multiple-sources' };
  if (split.kind === 'ambiguous-unparsed') return { ok: false, reason: 'ambiguous-unparsed-source' };
  const labelPrefix = 'labels.';
  const result = split.field.startsWith(labelPrefix)
    ? correlateLabel(project, split.service, split.field.slice(labelPrefix.length))
    : correlateField(project, split.service, split.field);
  if (!isActingReason(result.reason) || !result.origin) return { ok: false, reason: result.reason };
  // This door has no effective value, so it cannot tell two declarations of the
  // same key apart. An edit provider must not be sent to the one that merely
  // sorts last: only a key with a single candidate in the winning source tier
  // is safe to edit.
  if (split.field.startsWith(labelPrefix)) {
    const key = split.field.slice(labelPrefix.length);
    const labels = project.labels.get(split.service);
    const winner = labels?.winners[key];
    const tier = winner
      ? (labels?.contributionsByKey.get(key) ?? []).filter(contribution => contribution.source === winner.source)
      : [];
    if (tier.length > 1) return { ok: false, reason: 'ambiguous-multiple-sources' };
  }
  return { ok: true, origin: result.origin };
}
