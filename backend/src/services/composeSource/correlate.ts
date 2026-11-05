/**
 * Correlate an effective field back to the authored declaration that produced
 * it. The model never reimplements Compose's merge: it collects every authored
 * candidate in layer order, then uses the effective value only to disambiguate.
 * When that cannot be decided, the result is an explicit ambiguous reason and
 * no origin.
 */
import { authoredScalarOf } from './parseComposeDocument';
import {
  isActingReason, type AuthoredNode, type AuthoredProject, type CorrelationCandidate,
  type CorrelationOrigin, type CorrelationReason, type CorrelationResult, type LabelContribution,
  type ServiceAuthoredLabels, type SourceWritability,
} from './types';

interface Candidate {
  file: string;
  node: AuthoredNode;
  layerIndex: number;
  writability: SourceWritability;
}

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

function hasOutsideComposeLayer(project: AuthoredProject): boolean {
  return project.files.some(file =>
    (file.kind === 'compose-primary' || file.kind === 'compose-additional' || file.kind === 'compose-override'
      || file.kind === 'compose-include' || file.kind === 'compose-extends')
    && file.state === 'outside-boundary');
}

function unparsedFiles(project: AuthoredProject): string[] {
  return project.files
    .filter(file => file.kind !== 'label-file' && file.kind !== 'env-file' && file.kind !== 'config' && file.kind !== 'secret'
      && file.state !== 'parsed' && file.state !== 'identity-only')
    .map(file => file.file);
}

function baseResult(project: AuthoredProject, path: string, candidates: Candidate[], reason: CorrelationReason): CorrelationResult {
  return {
    path,
    candidates: candidates.map(candidate => mergeCandidate(candidate)),
    reason,
  };
}

/**
 * Every declaration of a service field, in merge order. `extends` bases are
 * included below the extending service's own declarations.
 */
export function fieldCandidates(project: AuthoredProject, service: string, field: string): Candidate[] {
  const out: Candidate[] = [];
  const services = [service, ...(project.extendsServices?.get(service) ?? [])];
  for (const file of project.files) {
    if (file.state !== 'parsed') continue;
    for (const [index, candidateService] of services.entries()) {
      const path = field ? `services.${candidateService}.${field}` : `services.${candidateService}`;
      const node = file.nodes.get(path);
      if (!node) continue;
      out.push({
        file: file.file,
        node,
        // An extended base is always lower precedence than the extending
        // service's own file, even when the base file sorts later.
        layerIndex: index === 0 ? file.layerIndex : -1,
        writability: file.writability,
      });
    }
  }
  return out.sort((a, b) => a.layerIndex - b.layerIndex);
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
    return {
      ...baseResult(project, path, candidates, 'ambiguous-unparsed-source'),
      ambiguity: { kind: 'outside-boundary', detail: 'A declared Compose layer is outside the managed boundary.' },
    };
  }
  if (candidates.length === 0) {
    if (project.generatedLayers.includes('mesh-override') && (field === 'networks' || field === 'extra_hosts')) {
      return baseResult(project, path, candidates, 'generated-layer');
    }
    if (unparsedFiles(project).length > 0) {
      return {
        ...baseResult(project, path, candidates, 'ambiguous-unparsed-source'),
        ambiguity: { kind: 'unparsed-source', detail: 'One or more compose layers could not be parsed.' },
      };
    }
    return baseResult(project, path, candidates, 'no-authored-source');
  }

  const tagged = candidates.filter(candidate => candidate.node.customTag !== undefined);
  if (tagged.length > 0) {
    if (tagged.length === candidates.length || tagged.length === 1) {
      return {
        ...baseResult(project, path, candidates, 'compose-tag'),
        ambiguity: { kind: 'compose-tag', detail: 'The only declaration is a Compose !reset or !override marker.' },
      };
    }
  }

  if (candidates.length === 1) {
    const only = candidates[0];
    if (only.node.hasInterpolation) {
      return {
        ...baseResult(project, path, candidates, 'interpolated'),
        ambiguity: { kind: 'interpolated', detail: 'The authored value contains interpolation.' },
      };
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

  const comparable = candidates.filter(candidate => !candidate.node.hasInterpolation && candidate.node.customTag === undefined);
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
      const result = baseResult(project, path, candidates, 'override-winner');
      return { ...result, origin: originOf(exact[0]) };
    }
    if (exact.length === 0 && normalized.length === 1) {
      const result = baseResult(project, path, candidates, 'normalized');
      return { ...result, origin: originOf(normalized[0]) };
    }
    if (exact.length + normalized.length > 1) {
      return {
        ...baseResult(project, path, candidates, 'ambiguous-multiple-sources'),
        ambiguity: { kind: 'multiple-matches', detail: 'More than one authored declaration matches the effective value.' },
      };
    }
  }

  if (candidates.some(candidate => candidate.node.hasInterpolation)) {
    return {
      ...baseResult(project, path, candidates, 'interpolated'),
      ambiguity: { kind: 'interpolated', detail: 'A candidate contains interpolation, so the winning literal cannot be decided.' },
    };
  }
  return {
    ...baseResult(project, path, candidates, 'ambiguous-multiple-sources'),
    ambiguity: { kind: 'multiple-candidates', detail: 'Several layers declare this field and none uniquely matches.' },
  };
}

/** Correlate the declaration point of a service itself (absence rules). */
export function correlateServiceKey(project: AuthoredProject, service: string): CorrelationResult {
  return correlateField(project, service, '');
}

function labelReason(winner: LabelContribution, contributions: LabelContribution[]): CorrelationReason {
  if (winner.source === 'label-file') {
    return winner.shared ? 'shared-input' : 'label-file';
  }
  const fileContribution = contributions.some(contribution => contribution.source === 'label-file' && contribution.key === winner.key);
  return fileContribution ? 'inline-overrides-label-file' : 'unique';
}

function writabilityOf(project: AuthoredProject, file: string): SourceWritability {
  return project.files.find(entry => entry.file === file)?.writability ?? 'writable';
}

/** Correlate one Compose-declared label key on one service. */
export function correlateLabel(project: AuthoredProject, service: string, key: string): CorrelationResult {
  const labels: ServiceAuthoredLabels | undefined = project.labels.get(service);
  const path = `services.${service}.labels.${key}`;
  if (hasOutsideComposeLayer(project)) {
    return {
      ...baseResult(project, path, [], 'ambiguous-unparsed-source'),
      ambiguity: { kind: 'outside-boundary', detail: 'A declared Compose layer is outside the managed boundary.' },
    };
  }
  if (!labels) return baseResult(project, path, [], 'no-authored-source');

  const ambiguity = labels.ambiguity[key];
  if (ambiguity !== undefined) {
    const reason: CorrelationReason = ambiguity === 'duplicate-key'
      ? 'ambiguous-multiple-sources'
      : ambiguity === 'interpolated'
        ? 'interpolated'
        : ambiguity === 'outside-boundary'
          ? 'no-authored-source'
          : 'ambiguous-unparsed-source';
    return {
      ...baseResult(project, path, [], reason),
      ambiguity: { kind: ambiguity, detail: 'The label source cannot be decided from the authored files.' },
    };
  }

  const winner = labels.winners[key];
  if (!winner) {
    if (labels.unparsedLabelFiles.length > 0) {
      return {
        ...baseResult(project, path, [], 'ambiguous-unparsed-source'),
        ambiguity: { kind: 'unparsed-source', detail: 'A label file for this service could not be parsed.' },
      };
    }
    if (labels.outsideLabelFiles.length > 0) {
      return {
        ...baseResult(project, path, [], 'no-authored-source'),
        ambiguity: { kind: 'outside-boundary', detail: 'A label declaration leaves the managed boundary.' },
      };
    }
    return baseResult(project, path, [], 'no-authored-source');
  }

  if (winner.source === 'label-file' && labels.outsideLabelFiles.length > 0) {
    // An outside label file declared later could override this key, so a local
    // label-file winner is not decisive.
    return {
      ...baseResult(project, path, [], 'no-authored-source'),
      ambiguity: { kind: 'outside-boundary', detail: 'A label declaration leaves the managed boundary.' },
    };
  }
  const contributions = labels.contributions.filter(contribution => contribution.key === key);
  const origin: CorrelationOrigin = {
    file: winner.file,
    writability: writabilityOf(project, winner.file),
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
  const pattern = new RegExp(`(?<!\\$)\\$(?:\\{${escapeRegExp(variable)}(?::?[-+?][^}]*)?\\}|${escapeRegExp(variable)}(?![A-Za-z0-9_]))`);
  const found: Candidate[] = [];
  for (const file of project.files) {
    if (file.state !== 'parsed') continue;
    for (const node of file.nodes.values()) {
      if (service !== undefined && !node.path.startsWith(`services.${service}.`)) continue;
      const text = authoredScalarOf(node);
      if (text === undefined || !pattern.test(text)) continue;
      found.push({ file: file.file, node, layerIndex: file.layerIndex, writability: file.writability });
    }
  }
  if (found.length === 1) {
    return { ...baseResult(project, path, found, 'unique'), origin: originOf(found[0]) };
  }
  if (found.length > 1) {
    return {
      ...baseResult(project, path, found, 'ambiguous-multiple-sources'),
      ambiguity: { kind: 'multiple-references', detail: 'The variable is referenced in more than one place.' },
    };
  }
  if (unparsedFiles(project).length > 0) {
    return baseResult(project, path, [], 'ambiguous-unparsed-source');
  }
  return baseResult(project, path, [], 'no-authored-source');
}

/**
 * The only door an edit provider may use: it returns an origin solely for a
 * reason that may be acted on. Every other reason is a typed refusal.
 */
export function resolveEditOrigin(
  project: AuthoredProject,
  path: string,
): { ok: true; origin: CorrelationOrigin } | { ok: false; reason: CorrelationReason } {
  const labelMatch = /^services\.([^.]+)\.labels\.(.+)$/.exec(path);
  const fieldMatch = /^services\.([^.]+)\.([^.]+)$/.exec(path);
  const result = labelMatch
    ? correlateLabel(project, labelMatch[1], labelMatch[2])
    : fieldMatch
      ? correlateField(project, fieldMatch[1], fieldMatch[2])
      : undefined;
  if (!result) return { ok: false, reason: 'no-authored-source' };
  if (!isActingReason(result.reason) || !result.origin) return { ok: false, reason: result.reason };
  return { ok: true, origin: result.origin };
}
