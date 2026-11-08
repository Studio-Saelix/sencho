/**
 * The rule-to-authored-field table. Compose Doctor rules never see the authored
 * project: this module maps a finished hit onto the field its rule is about and
 * returns a location only for a reason a consumer may act on.
 */
import {
  correlateField, correlateLabel, correlateServiceKey, correlateVariableReference, displayRange,
  hasLaterUnparsedLayer, hasOutsideComposeLayer, hasProjectCycle, hasUnparsedComposeLayer, hasUnresolvedService,
} from './correlate';
import { authoredScalarOf } from './parseComposeDocument';
import { containerPortRange, isDynamicHostPort, isFixedHostPort, splitShortPortSpec } from '../../helpers/composePortSpec';
import { isActingReason, type AuthoredFileSource, type AuthoredLocation, type AuthoredNode, type AuthoredProject, type CorrelationResult } from './types';
import type { RuleHit } from '../preflight/types';
import type { EffectiveModel, EffPortSpec } from '../preflight/effectiveModel';

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

interface ItemCandidate {
  file: string;
  node: AuthoredNode;
  layerIndex: number;
  writability: AuthoredFileSource['writability'];
  /** Sequence index, when the candidate is one item of a list. */
  index?: number;
}

const ALL_INTERFACES = 'all';

function normalizedInterface(ip: string): string {
  return ip === '' || ip === '0.0.0.0' || ip === '::' ? ALL_INTERFACES : ip;
}

function sameInterface(a: string, b: string): boolean {
  const left = normalizedInterface(a);
  const right = normalizedInterface(b);
  return left === right;
}

/** An authored host port in the same text form the rule subject uses. */
function normalizedHostPart(hostPart: string): string {
  const trimmed = hostPart.trim();
  if (isDynamicHostPort(trimmed)) return 'dynamic';
  if (!isFixedHostPort(trimmed)) return trimmed;
  const [start, end] = trimmed.split('-');
  const first = String(parseInt(start, 10));
  return end === undefined ? first : `${first}-${String(parseInt(end, 10))}`;
}

interface ServiceScope {
  file: AuthoredFileSource;
  /** Service key inside `file`; differs for an `extends` base. */
  declaredService: string;
  /** Effective merge layer of the declaration that introduced it. */
  layerIndex: number;
}

/**
 * Every parsed file that declares this effective service, including an
 * `extends` base under its own declared name. A same-named service in an
 * unrelated file is never included.
 */
function serviceScopes(project: AuthoredProject, service: string): ServiceScope[] {
  const scopes: ServiceScope[] = [];
  for (const definition of project.serviceDefinitions.get(service) ?? []) {
    const file = project.files.find(entry => entry.file === definition.file && entry.state === 'parsed');
    // A definition whose file this model cannot read must not be skipped: the
    // remaining scopes could otherwise look decisive.
    if (!file) return [];
    scopes.push({ file, declaredService: definition.declaredService, layerIndex: definition.layerIndex });
  }
  return scopes;
}

/** A sequence item whose identity this reader cannot decide. */
function isUnresolvedItem(node: AuthoredNode | undefined, interpolationMatters: boolean): boolean {
  if (!node) return false;
  return node.kind === 'alias' || node.customTag !== undefined
    || (interpolationMatters && node.hasInterpolation);
}

/** The long-form fields that carry a sequence item's identity for its rule. */
const IDENTITY_FIELDS: Record<string, ReadonlySet<string>> = {
  ports: new Set(['published', 'target', 'host_ip', 'protocol']),
  volumes: new Set(['target']),
  env_file: new Set(['path']),
};

/**
 * Whether a declaration at or after `layerIndex` cannot be compared with the
 * hit: it could still supersede a literal item this reader managed to match.
 */
function hasUnresolvedSequenceItem(
  scopes: ServiceScope[],
  field: string,
  layerIndex: number,
  interpolationMatters: boolean,
): boolean {
  const identityFields = IDENTITY_FIELDS[field] ?? new Set<string>();
  for (const scope of scopes) {
    if (scope.layerIndex < layerIndex) continue;
    const prefix = `services.${scope.declaredService}.${field}[`;
    for (const [nodePath, node] of scope.file.nodes) {
      if (!nodePath.startsWith(prefix)) continue;
      const index = /^(\d+)\]/.exec(nodePath.slice(prefix.length));
      if (!index) continue;
      const itemPath = `${prefix}${index[1]}]`;
      if (nodePath === itemPath) {
        if (isUnresolvedItem(node, interpolationMatters)) return true;
        continue;
      }
      // Only the identity-bearing long-form fields; interpolating a bind source
      // says nothing about which target the finding names.
      if (!identityFields.has(nodePath.slice(itemPath.length + 1))) continue;
      if (isUnresolvedItem(node, interpolationMatters)) return true;
    }
  }
  return false;
}

/** A `!reset`/`!override`/unsupported tag on the field itself makes every item ambiguous. */
function fieldHasTag(scopes: ServiceScope[], field: string): boolean {
  return scopes.some(scope => scope.file.nodes.get(`services.${scope.declaredService}.${field}`)?.customTag !== undefined);
}

/** The largest sequence index any scope declares for one field. */
function scopedSequenceCount(scopes: ServiceScope[], field: string): number {
  let max = 0;
  for (const scope of scopes) {
    const prefix = `services.${scope.declaredService}.${field}[`;
    for (const nodePath of scope.file.nodes.keys()) {
      if (!nodePath.startsWith(prefix) || !nodePath.endsWith(']')) continue;
      const index = Number(nodePath.slice(prefix.length, -1));
      if (Number.isInteger(index)) max = Math.max(max, index + 1);
    }
  }
  return max;
}

/** One authored `ports` item, with the parts that identify a publication. */
interface AuthoredPortSpec {
  hostText: string;
  hostIp: string;
  protocol: string;
  dynamic: boolean;
  targetStartPort?: number;
  targetEndPort?: number;
}

function portItemValue(file: AuthoredFileSource, declaredService: string, index: number): AuthoredPortSpec | null {
  const item = file.nodes.get(`services.${declaredService}.ports[${index}]`);
  // An alias item's own text is not the publication, and this model does not
  // attribute the anchor's value to this item. Never read it as `dynamic`.
  if (!item || item.kind === 'alias') return null;
  const text = authoredScalarOf(item);
  if (text !== undefined) {
    const split = splitShortPortSpec(text.trim());
    if (!split) return null;
    const hostText = normalizedHostPart(split.hostPart);
    const target = containerPortRange(split.container);
    return {
      hostText,
      hostIp: split.hostIp,
      protocol: split.protocol,
      dynamic: hostText === 'dynamic',
      ...(target ? { targetStartPort: target.start, targetEndPort: target.end } : {}),
    };
  }
  const prefix = `services.${declaredService}.ports[${index}]`;
  const published = authoredScalarOf(file.nodes.get(`${prefix}.published`));
  const protocol = authoredScalarOf(file.nodes.get(`${prefix}.protocol`)) ?? 'tcp';
  const hostIp = authoredScalarOf(file.nodes.get(`${prefix}.host_ip`)) ?? '';
  const target = containerPortRange(authoredScalarOf(file.nodes.get(`${prefix}.target`)));
  const hostText = published === undefined ? 'dynamic' : normalizedHostPart(published);
  return {
    hostText,
    hostIp,
    protocol,
    dynamic: hostText === 'dynamic',
    ...(target ? { targetStartPort: target.start, targetEndPort: target.end } : {}),
  };
}

function effectiveHostText(spec: EffPortSpec): string {
  if (spec.dynamic) return 'dynamic';
  return spec.startPort === spec.endPort ? String(spec.startPort) : `${spec.startPort}-${spec.endPort}`;
}

function subjectMatchesSpec(spec: EffPortSpec, hostText: string, protocol: string): boolean {
  if (spec.protocol !== protocol) return false;
  if (spec.dynamic) return hostText === 'dynamic';
  if (hostText === 'dynamic') return false;
  if (hostText.includes('-')) return effectiveHostText(spec) === hostText;
  const port = Number(hostText);
  return Number.isInteger(port) && port >= spec.startPort && port <= spec.endPort;
}

function authoredHostMatchesEffective(author: AuthoredPortSpec, spec: EffPortSpec): boolean {
  if (author.dynamic !== (spec.dynamic === true)) return false;
  if (spec.dynamic) {
    if (spec.targetStartPort === undefined || author.targetStartPort === undefined) return true;
    return author.targetStartPort === spec.targetStartPort && author.targetEndPort === spec.targetEndPort;
  }
  return author.hostText === effectiveHostText(spec);
}

function authoredHostMatchesSubject(author: AuthoredPortSpec, hostText: string): boolean {
  if (hostText === 'dynamic') return author.dynamic;
  if (author.dynamic) return false;
  if (author.hostText === hostText) return true;
  const range = author.hostText.includes('-') ? author.hostText.split('-').map(Number) : null;
  if (range && !hostText.includes('-')) {
    const port = Number(hostText);
    return Number.isInteger(port) && port >= range[0] && port <= range[1];
  }
  return false;
}

/** Whether one authored item is the declaration that produced this effective spec. */
function authoredPortMatches(author: AuthoredPortSpec, spec: EffPortSpec, broadOnly: boolean): boolean {
  if (author.protocol !== spec.protocol) return false;
  if (broadOnly && normalizedInterface(author.hostIp) !== ALL_INTERFACES) return false;
  if (!broadOnly && !sameInterface(author.hostIp, spec.hostIp)) return false;
  return authoredHostMatchesEffective(author, spec);
}

/** A subject's `host/protocol` split; the host may be a range or `dynamic`. */
function splitPortSubject(key: string): { hostText: string; protocol: string } {
  const slash = key.lastIndexOf('/');
  return {
    hostText: slash === -1 ? key : key.slice(0, slash),
    protocol: slash === -1 ? 'tcp' : key.slice(slash + 1),
  };
}

/** The authored target of one `volumes` sequence item. */
function volumeItemTarget(file: AuthoredFileSource, declaredService: string, index: number): string | null {
  const item = file.nodes.get(`services.${declaredService}.volumes[${index}]`);
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
  return authoredScalarOf(file.nodes.get(`services.${declaredService}.volumes[${index}].target`)) ?? null;
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

/**
 * Locate the single `ports` item responsible for a hit. The rule subject names
 * the surviving publication, and the effective model supplies the interface and
 * (for dynamic publications) the container target, so a loopback override can
 * never stand in for the broad base declaration that caused the finding.
 */
function locatePort(project: AuthoredProject, hit: RuleHit, model: EffectiveModel | null): AuthoredLocation | undefined {
  if (!hit.service) return undefined;
  if (hasUnresolvedService(project, hit.service)) return undefined;
  const broadOnly = hit.ruleId === 'port-exposed-all-interfaces' || hit.ruleId === 'sensitive-service-broad-exposure';
  const subject = hit.subject?.kind === 'port' ? splitPortSubject(hit.subject.key) : undefined;
  const effective = model?.services.find(entry => entry.name === hit.service);
  if (!effective && !subject) return undefined;
  const specs = effective?.ports.filter(spec =>
    (!broadOnly || normalizedInterface(spec.hostIp) === ALL_INTERFACES)
    && (subject === undefined || subjectMatchesSpec(spec, subject.hostText, subject.protocol))) ?? [];
  // A subjectless hit (sensitive-service-broad-exposure) covers the whole
  // service; it is locatable only when exactly one surviving publication matches.
  if (subject === undefined && specs.length !== 1) return undefined;
  // One subject can cover several surviving publications (a broad and a
  // loopback entry on one host port). If their interface/target identity
  // differs, the hit does not say which one it came from: refuse.
  const specIdentities = new Set(specs.map(spec =>
    `${normalizedInterface(spec.hostIp)}|${spec.dynamic ? 'dynamic' : 'fixed'}|${spec.targetStartPort ?? ''}-${spec.targetEndPort ?? ''}`));
  if (subject !== undefined && specIdentities.size > 1) return undefined;

  const byLayer = new Map<number, ItemCandidate[]>();
  const scopes = serviceScopes(project, hit.service);
  if (fieldHasTag(scopes, 'ports')) return undefined;
  const count = scopedSequenceCount(scopes, 'ports');
  const identities = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    for (const scope of scopes) {
      const author = portItemValue(scope.file, scope.declaredService, index);
      if (!author) continue;
      const node = scope.file.nodes.get(`services.${scope.declaredService}.ports[${index}]`);
      if (!node) continue;
      const matched = subject !== undefined
        ? authoredHostMatchesSubject(author, subject.hostText)
          && author.protocol === subject.protocol
          && (!broadOnly || normalizedInterface(author.hostIp) === ALL_INTERFACES)
        : specs.some(spec => authoredPortMatches(author, spec, broadOnly));
      if (!matched) continue;
      // Two different publications (interface or target) on one subject cannot
      // both be the one the rule reported: refuse rather than pick a layer.
      identities.add(`${author.hostText}|${author.protocol}|${normalizedInterface(author.hostIp)}|${author.targetStartPort ?? ''}-${author.targetEndPort ?? ''}`);
      const list = byLayer.get(scope.layerIndex) ?? [];
      list.push({ file: scope.file.file, node, layerIndex: scope.layerIndex, writability: scope.file.writability, index });
      byLayer.set(scope.layerIndex, list);
    }
  }
  if (identities.size > 1) return undefined;

  // `ports` appends across Compose layers, so every matching authored item is a
  // live declaration of the publication the hit names. Selecting the latest
  // layer would silently discard an earlier identical declaration; the field is
  // locatable only when exactly one authored item can be its source.
  const matches = [...byLayer.values()].flat();
  if (matches.length !== 1) return undefined;
  // A later scalar replaces an earlier one, but `ports` appends: an unparsed
  // layer anywhere in the project could contribute another copy of this
  // publication, so no single layer is decisive.
  if (hasUnparsedComposeLayer(project)) return undefined;
  // An interpolated or aliased item in any layer could resolve to the same
  // publication; the literal item is not provably its only source.
  if (hasUnresolvedSequenceItem(scopes, 'ports', 0, true)) return undefined;
  return itemLocation(matches, `services.${hit.service}.ports`);
}

/** Locate the single `volumes` item a bind hit names, else the sequence key. */
function locateVolume(project: AuthoredProject, hit: RuleHit): AuthoredLocation | undefined {
  if (!hit.service) return undefined;
  if (hasUnresolvedService(project, hit.service)) return undefined;
  if (hit.subject?.kind === 'bind') {
    const target = hit.subject.key;
    const matches: ItemCandidate[] = [];
    const scopes = serviceScopes(project, hit.service);
    if (fieldHasTag(scopes, 'volumes')) return undefined;
    let matchedIndex: number | undefined;
    for (let index = 0; index < scopedSequenceCount(scopes, 'volumes'); index += 1) {
      for (const scope of scopes) {
        if (volumeItemTarget(scope.file, scope.declaredService, index) !== target) continue;
        const node = scope.file.nodes.get(`services.${scope.declaredService}.volumes[${index}]`);
        if (node) {
          matches.push({ file: scope.file.file, node, layerIndex: scope.layerIndex, writability: scope.file.writability, index });
          matchedIndex = index;
        }
      }
    }
    if (matches.length > 0 && matchedIndex !== undefined) {
      const latest = Math.max(...matches.map(match => match.layerIndex));
      if (hasLaterUnparsedLayer(project, latest)) return undefined;
      // Two declarations in the winning layer with the same target are not
      // distinguishable from the hit; an unresolved item there could be the
      // one that actually produced the effective bind.
      if (matches.filter(match => match.layerIndex === latest).length !== 1) return undefined;
      if (hasUnresolvedSequenceItem(scopes, 'volumes', latest, true)) return undefined;
      return itemLocation(matches, `services.${hit.service}.volumes`);
    }
    // The hit names a bind target no authored declaration matches: refuse to
    // point at the whole volumes field as if it were that mount.
    return undefined;
  }
  return toLocation(correlateField(project, hit.service, 'volumes'));
}

/** Locate the `env_file` entry naming the missing path, else the field. */
function locateEnvFile(project: AuthoredProject, hit: RuleHit): AuthoredLocation | undefined {
  if (!hit.service) return undefined;
  if (hasUnresolvedService(project, hit.service)) return undefined;
  const path = hit.sourcePath;
  if (path !== undefined) {
    const scopes = serviceScopes(project, hit.service);
    if (fieldHasTag(scopes, 'env_file')) return undefined;
    const count = scopedSequenceCount(scopes, 'env_file');
    const matches: ItemCandidate[] = [];
    for (let index = 0; index < count; index += 1) {
      for (const scope of scopes) {
        const prefix = `services.${scope.declaredService}.env_file[${index}]`;
        const shortNode = scope.file.nodes.get(prefix);
        const longNode = scope.file.nodes.get(`${prefix}.path`);
        const text = authoredScalarOf(shortNode) ?? authoredScalarOf(longNode);
        if (text !== undefined && (text === path || text.endsWith(`/${path}`) || path.endsWith(`/${text}`))) {
          const node = longNode ?? shortNode;
          if (node) {
            matches.push({
              file: scope.file.file, node, layerIndex: scope.layerIndex,
              writability: scope.file.writability, index,
            });
          }
        }
      }
    }
    if (matches.length > 0) {
      // `env_file` entries append across layers, so an identical path declared
      // twice is two live declarations of the missing file. A single authored
      // entry must match before the location may name a file.
      if (matches.length !== 1) return undefined;
      if (hasUnparsedComposeLayer(project)) return undefined;
      if (hasUnresolvedSequenceItem(scopes, 'env_file', 0, true)) return undefined;
      return itemLocation(matches, `services.${hit.service}.env_file`);
    }
    // The hit names a missing env file no authored entry matches.
    return undefined;
  }
  return toLocation(correlateField(project, hit.service, 'env_file'));
}

/** Locate the authored `environment` entry for one key, map or list form. */
function locateEnvironmentKey(project: AuthoredProject, service: string, key: string): AuthoredLocation | undefined {
  if (hasUnresolvedService(project, service)) return undefined;
  const candidates: ItemCandidate[] = [];
  const unresolvedLayers: number[] = [];
  const scopes = serviceScopes(project, service);
  if (fieldHasTag(scopes, 'environment')) return undefined;
  for (const scope of scopes) {
    const path = `services.${scope.declaredService}.environment`;
    const mapNode = scope.file.nodes.get(`${path}.${key}`);
    if (mapNode) {
      // An alias is a reference, not the declaration that holds the value; the
      // anchor cannot be attributed to this key from here.
      if (mapNode.kind === 'alias' || mapNode.customTag !== undefined) {
        unresolvedLayers.push(scope.layerIndex);
      } else {
        candidates.push({ file: scope.file.file, node: mapNode, layerIndex: scope.layerIndex, writability: scope.file.writability });
      }
      continue;
    }
    for (const [nodePath, node] of scope.file.nodes) {
      if (!nodePath.startsWith(`${path}[`) || !nodePath.endsWith(']')) continue;
      const text = authoredScalarOf(node);
      if (text === undefined) {
        // A list item this reader cannot read could be this key in another
        // spelling; it only matters if it is at or after the matched layer.
        if (node.kind === 'alias') unresolvedLayers.push(scope.layerIndex);
        continue;
      }
      if (!text.startsWith(`${key}=`)) continue;
      candidates.push({ file: scope.file.file, node, layerIndex: scope.layerIndex, writability: scope.file.writability });
    }
  }
  if (candidates.length !== 1) return undefined;
  if (hasLaterUnparsedLayer(project, candidates[0].layerIndex)) return undefined;
  if (unresolvedLayers.some(layer => layer >= candidates[0].layerIndex)) return undefined;
  return itemLocation(candidates, `services.${service}.environment.${key}`);
}

const COMPOSE_KINDS = new Set([
  'compose-primary', 'compose-additional', 'compose-override', 'compose-include', 'compose-extends',
]);

function locateParseFailure(project: AuthoredProject): AuthoredLocation | undefined {
  for (const file of project.files) {
    if (!COMPOSE_KINDS.has(file.kind)) continue;
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
  // A cyclic project is rejected by Compose and has no defensible layer order.
  if (hasProjectCycle(project)) return undefined;

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
      return locatePort(project, hit, model);
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
    // An extends base contributes services, never top-level resources, so it
    // is not a declaration of this project's networks or volumes.
    if (file.kind === 'compose-extends') continue;
    const node = file.nodes.get(path);
    if (node) candidates.push({ file: file.file, node, layerIndex: file.layerIndex, writability: file.writability });
  }
  if (hasOutsideComposeLayer(project)) {
    return {
      path,
      candidates: candidates.map(candidate => ({ file: candidate.file, range: displayRange(candidate.node), path, layerIndex: candidate.layerIndex })),
      reason: 'ambiguous-unparsed-source',
      ambiguity: { kind: 'outside-boundary', detail: 'A declared Compose layer is outside the managed boundary.' },
    };
  }
  if (candidates.length === 1) {
    if (candidates[0].node.customTag !== undefined) {
      return {
        path,
        candidates: candidates.map(candidate => ({ file: candidate.file, range: displayRange(candidate.node), path, layerIndex: candidate.layerIndex })),
        reason: 'compose-tag',
        ambiguity: { kind: 'compose-tag', detail: 'The declaration is a Compose !reset or !override marker.' },
      };
    }
    const node = candidates[0].node;
    // Top-level declarations are mappings that merge across layers, so any
    // unparsed layer can still contribute the key or one of its fields.
    if (node.kind === 'alias'
      || hasLaterUnparsedLayer(project, candidates[0].layerIndex)
      || (node.kind !== 'scalar' && hasUnparsedComposeLayer(project))) {
      return {
        path,
        candidates: candidates.map(candidate => ({ file: candidate.file, range: displayRange(candidate.node), path, layerIndex: candidate.layerIndex })),
        reason: 'ambiguous-unparsed-source',
        ambiguity: { kind: 'unparsed-source', detail: 'A compose layer could not be parsed.' },
      };
    }
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
