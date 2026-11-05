/**
 * The rule-to-authored-field table. Compose Doctor rules never see the authored
 * project: this module maps a finished hit onto the field its rule is about and
 * returns a location only for a reason a consumer may act on.
 */
import {
  correlateField, correlateLabel, correlateServiceKey, correlateVariableReference, displayRange,
} from './correlate';
import { authoredScalarOf } from './parseComposeDocument';
import { splitShortPortSpec } from '../../helpers/composePortSpec';
import { isActingReason, type AuthoredFileSource, type AuthoredLocation, type AuthoredNode, type AuthoredProject, type CorrelationResult } from './types';
import type { RuleHit } from '../preflight/types';
import type { EffectiveModel } from '../preflight/effectiveModel';

function toLocation(result: CorrelationResult): AuthoredLocation | undefined {
  if (!isActingReason(result.reason) || !result.origin) return undefined;
  const { origin } = result;
  return {
    file: origin.file,
    path: result.path,
    line: origin.range.line,
    column: origin.range.column,
    endLine: origin.range.endLine,
    endColumn: origin.range.endColumn,
  };
}

/** A short port entry's host part, with an empty host left to Docker as `dynamic`. */
function shortPortHostPart(text: string): { hostPart: string; protocol: string } | null {
  const split = splitShortPortSpec(text.trim());
  if (!split) return null;
  const hostPart = split.hostPart === '' || /^\+?0+$/.test(split.hostPart) ? 'dynamic' : split.hostPart;
  return { hostPart, protocol: split.protocol };
}

interface ItemCandidate {
  file: string;
  node: AuthoredNode;
  layerIndex: number;
  writability: AuthoredFileSource['writability'];
  /** Sequence index, when the candidate is one item of a list. */
  index?: number;
}

/** The authored host part and protocol of one `ports` sequence item. */
function portItemValue(file: AuthoredFileSource, service: string, index: number): { hostPart: string; protocol: string } | null {
  const item = file.nodes.get(`services.${service}.ports[${index}]`);
  if (!item) return null;
  const text = authoredScalarOf(item);
  if (text !== undefined) return shortPortHostPart(text);
  const published = authoredScalarOf(file.nodes.get(`services.${service}.ports[${index}].published`));
  const protocol = authoredScalarOf(file.nodes.get(`services.${service}.ports[${index}].protocol`)) ?? 'tcp';
  const hostPart = published === undefined || /^\+?0+$/.test(published) ? 'dynamic' : published;
  return { hostPart, protocol };
}

/** The authored target of one `volumes` sequence item. */
function volumeItemTarget(file: AuthoredFileSource, service: string, index: number): string | null {
  const item = file.nodes.get(`services.${service}.volumes[${index}]`);
  if (item) {
    const text = authoredScalarOf(item);
    if (text !== undefined) {
      const parts = text.split(':');
      if (parts.length === 1) return parts[0];
      // A drive-letter source (C:\data:/data) keeps its colon.
      const offset = /^[A-Za-z]$/.test(parts[0]) ? 1 : 0;
      return parts[offset + 1] ?? null;
    }
  }
  return authoredScalarOf(file.nodes.get(`services.${service}.volumes[${index}].target`)) ?? null;
}

/** A location on the latest layer that declares a matching sequence item. */
function itemLocation(candidates: ItemCandidate[], basePath: string): AuthoredLocation | undefined {
  if (candidates.length === 0) return undefined;
  const winner = candidates.reduce((latest, candidate) => candidate.layerIndex > latest.layerIndex ? candidate : latest);
  const range = displayRange(winner.node);
  return {
    file: winner.file,
    path: winner.index !== undefined ? `${basePath}[${winner.index}]` : basePath,
    line: range.line,
    column: range.column,
    endLine: range.endLine,
    endColumn: range.endColumn,
  };
}

function sequenceItemCount(project: AuthoredProject, service: string, field: string): number {
  let max = 0;
  for (const file of project.files) {
    if (file.state !== 'parsed') continue;
    for (const path of file.nodes.keys()) {
      const match = new RegExp(`^services\\.${service.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.${field}\\[(\\d+)\\]$`).exec(path);
      if (match) max = Math.max(max, Number(match[1]) + 1);
    }
  }
  return max;
}

/** Locate the single `ports` item a hit's subject names, else the sequence key. */
function locatePort(project: AuthoredProject, hit: RuleHit): AuthoredLocation | undefined {
  if (!hit.service) return undefined;
  const subject = hit.subject?.kind === 'port' ? hit.subject.key : undefined;
  if (subject !== undefined) {
    const slash = subject.lastIndexOf('/');
    const host = slash === -1 ? subject : subject.slice(0, slash);
    const protocol = slash === -1 ? 'tcp' : subject.slice(slash + 1);
    const matches: ItemCandidate[] = [];
    let matchedIndex: number | undefined;
    for (let index = 0; index < sequenceItemCount(project, hit.service, 'ports'); index += 1) {
      for (const file of project.files) {
        if (file.state !== 'parsed') continue;
        const value = portItemValue(file, hit.service, index);
        if (!value || value.hostPart !== host || value.protocol !== protocol) continue;
        const node = file.nodes.get(`services.${hit.service}.ports[${index}]`);
        if (node) {
          matches.push({ file: file.file, node, layerIndex: file.layerIndex, writability: file.writability, index });
          matchedIndex = index;
        }
      }
    }
    if (matches.length > 0 && matchedIndex !== undefined) {
      return itemLocation(matches, `services.${hit.service}.ports`);
    }
  }
  return toLocation(correlateField(project, hit.service, 'ports'));
}

/** Locate the single `volumes` item a bind hit names, else the sequence key. */
function locateVolume(project: AuthoredProject, hit: RuleHit): AuthoredLocation | undefined {
  if (!hit.service) return undefined;
  if (hit.subject?.kind === 'bind') {
    const target = hit.subject.key;
    const matches: ItemCandidate[] = [];
    let matchedIndex: number | undefined;
    for (let index = 0; index < sequenceItemCount(project, hit.service, 'volumes'); index += 1) {
      for (const file of project.files) {
        if (file.state !== 'parsed') continue;
        if (volumeItemTarget(file, hit.service, index) !== target) continue;
        const node = file.nodes.get(`services.${hit.service}.volumes[${index}]`);
        if (node) {
          matches.push({ file: file.file, node, layerIndex: file.layerIndex, writability: file.writability, index });
          matchedIndex = index;
        }
      }
    }
    if (matches.length > 0 && matchedIndex !== undefined) {
      return itemLocation(matches, `services.${hit.service}.volumes`);
    }
  }
  return toLocation(correlateField(project, hit.service, 'volumes'));
}

/** Locate the `env_file` entry naming the missing path, else the field. */
function locateEnvFile(project: AuthoredProject, hit: RuleHit): AuthoredLocation | undefined {
  if (!hit.service) return undefined;
  const path = hit.sourcePath;
  if (path !== undefined) {
    const count = sequenceItemCount(project, hit.service, 'env_file');
    for (let index = 0; index < count; index += 1) {
      for (const file of project.files) {
        const node = file.nodes.get(`services.${hit.service}.env_file[${index}]`);
        const text = node ? authoredScalarOf(node) : undefined;
        if (text !== undefined && (text === path || text.endsWith(`/${path}`) || path.endsWith(`/${text}`))) {
          return toLocation(correlateField(project, hit.service, `env_file[${index}]`));
        }
      }
    }
  }
  return toLocation(correlateField(project, hit.service, 'env_file'));
}

/** Locate the authored `environment` entry for one key, map or list form. */
function locateEnvironmentKey(project: AuthoredProject, service: string, key: string): AuthoredLocation | undefined {
  const path = `services.${service}.environment`;
  const candidates: ItemCandidate[] = [];
  for (const file of project.files) {
    if (file.state !== 'parsed') continue;
    const mapNode = file.nodes.get(`${path}.${key}`);
    if (mapNode) {
      candidates.push({ file: file.file, node: mapNode, layerIndex: file.layerIndex, writability: file.writability });
      continue;
    }
    for (const [nodePath, node] of file.nodes) {
      if (!nodePath.startsWith(`${path}[`)) continue;
      const text = authoredScalarOf(node);
      if (text === undefined || !text.startsWith(`${key}=`)) continue;
      candidates.push({ file: file.file, node, layerIndex: file.layerIndex, writability: file.writability });
    }
  }
  if (candidates.length !== 1) return undefined;
  return itemLocation(candidates, `${path}.${key}`);
}

function locateParseFailure(project: AuthoredProject): AuthoredLocation | undefined {
  for (const file of project.files) {
    if (file.state !== 'parse-failed' && file.state !== 'too-large' && file.state !== 'unreadable') continue;
    const diagnostic = file.diagnostics[0];
    const range = diagnostic?.range ?? { line: 1, column: 1, endLine: 1, endColumn: 1 };
    return {
      file: file.file,
      line: range.line,
      column: range.column,
      endLine: range.endLine,
      endColumn: range.endColumn,
    };
  }
  return undefined;
}

function topLevelKey(sourcePath: string | undefined): string | undefined {
  if (!sourcePath) return undefined;
  const match = /^networks\.([^,\s]+)/.exec(sourcePath) ?? /^volumes\.([^,\s]+)/.exec(sourcePath);
  return match?.[1];
}

function locateEffective(project: AuthoredProject, service: string, field: string, model: EffectiveModel | null): AuthoredLocation | undefined {
  const effective = model?.services.find(entry => entry.name === service);
  let value: string | undefined;
  switch (field) {
    case 'image': value = effective?.image; break;
    case 'privileged': value = effective?.privileged ? 'true' : undefined; break;
    case 'network_mode': value = effective?.networkMode; break;
    case 'user': value = effective?.user; break;
    case 'restart': value = effective?.restart; break;
    case 'container_name': value = effective?.containerName; break;
    default: value = undefined;
  }
  return toLocation(correlateField(project, service, field, value));
}

/**
 * Locate one finished Doctor hit. `null` or an absent origin means no location
 * is shown; a consumer must treat that as "the source cannot be decided", never
 * as "there is no authored source".
 */
export function locateFinding(
  project: AuthoredProject | null,
  hit: RuleHit,
  model: EffectiveModel | null = null,
): AuthoredLocation | undefined {
  if (!project) return undefined;

  switch (hit.ruleId) {
    case 'render-failed':
      return locateParseFailure(project);
    case 'env-unset': {
      const variable = hit.sourcePath;
      if (!variable) return undefined;
      return toLocation(correlateVariableReference(project, variable, hit.service));
    }
    case 'env-literal-dollar': {
      // The hit's sourcePath is the affected environment KEY, not a variable
      // reference. Locate that key's authored declaration.
      if (!hit.service || !hit.sourcePath) return undefined;
      return locateEnvironmentKey(project, hit.service, hit.sourcePath);
    }
    case 'env-file-missing':
      return locateEnvFile(project, hit);
    case 'port-exposed-all-interfaces':
    case 'port-conflict-node':
    case 'sensitive-service-broad-exposure':
      return locatePort(project, hit);
    case 'bind-path-missing':
    case 'bind-path-permission':
    case 'docker-socket-mount':
    case 'docker-socket-proxy-writable':
    case 'anonymous-volume':
      return locateVolume(project, hit);
    case 'uid-gid-risk':
      if (!hit.service) return undefined;
      return locateEffective(project, hit.service, 'user', model);
    case 'privileged':
      if (!hit.service) return undefined;
      return locateEffective(project, hit.service, 'privileged', model);
    case 'network-mode-host':
      if (!hit.service) return undefined;
      return locateEffective(project, hit.service, 'network_mode', model);
    case 'image-latest':
    case 'image-not-digest-pinned':
      if (!hit.service) return undefined;
      return locateEffective(project, hit.service, 'image', model);
    case 'no-restart-policy':
    case 'no-healthcheck':
      if (!hit.service) return undefined;
      return toLocation(correlateServiceKey(project, hit.service));
    case 'healthcheck-disabled':
      if (!hit.service) return undefined;
      return toLocation(correlateField(project, hit.service, 'healthcheck'));
    case 'deploy-swarm-only':
      if (!hit.service) return undefined;
      return toLocation(correlateField(project, hit.service, 'deploy'));
    case 'container-name-collision':
      if (!hit.service) return undefined;
      return locateEffective(project, hit.service, 'container_name', model);
    case 'external-network-missing':
    case 'new-network': {
      const key = topLevelKey(hit.sourcePath);
      if (!key) return undefined;
      return toLocation(correlateTopLevel(project, 'networks', key));
    }
    case 'external-volume-missing':
    case 'new-volume': {
      const key = topLevelKey(hit.sourcePath);
      if (!key) return undefined;
      return toLocation(correlateTopLevel(project, 'volumes', key));
    }
    default:
      return undefined;
  }
}

/** Top-level collections are not service fields; correlate them directly. */
function correlateTopLevel(project: AuthoredProject, collection: string, key: string): CorrelationResult {
  const path = `${collection}.${key}`;
  const candidates = [];
  for (const file of project.files) {
    if (file.state !== 'parsed') continue;
    const node = file.nodes.get(path);
    if (node) candidates.push({ file: file.file, node, layerIndex: file.layerIndex, writability: file.writability });
  }
  if (candidates.length === 1) {
    const node = candidates[0].node;
    const range = displayRange(node);
    return {
      path,
      origin: { file: candidates[0].file, writability: candidates[0].writability, range, path, layerIndex: candidates[0].layerIndex },
      candidates: candidates.map(candidate => ({
        file: candidate.file,
        range: displayRange(candidate.node),
        path,
        layerIndex: candidate.layerIndex,
      })),
      reason: 'unique',
    };
  }
  if (candidates.length === 0) return { path, candidates: [], reason: 'no-authored-source' };
  return {
    path,
    candidates: candidates.map(candidate => ({
      file: candidate.file,
      range: displayRange(candidate.node),
      path,
      layerIndex: candidate.layerIndex,
    })),
    reason: 'ambiguous-multiple-sources',
  };
}

export { correlateLabel };
