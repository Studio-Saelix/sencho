/**
 * Build the authored project: resolve the deploy chain, read only the files a
 * declaration names, parse each with ranges, follow include/extends graphs
 * within bounds, and assemble the label contribution model.
 *
 * The model is read-only. The only values it ever holds are authored scalar
 * text kept in the parser's private WeakMap for in-memory comparison; nothing
 * here resolves interpolation or reads an env file, secret, or config body.
 */
import path from 'path';

import { FileSystemService } from '../FileSystemService';
import { getErrorMessage } from '../../utils/errors';
import { sanitizeForLog } from '../../utils/safeLog';
import { sha256Hex } from '../../utils/hashing';

import {
  parseComposeDocument, parseLabelFile, MAX_COMPOSE_PARSE_BYTES, diagnosticMessage,
  authoredInlineLabelValueOf, authoredLabelFileValueOf, setAuthoredLabelContributionValue,
} from './parseComposeDocument';
import { resolveProjectInputs, stackRelativePath } from './resolveProjectInputs';
import type {
  AuthoredDiagnostic, AuthoredFileSource, AuthoredProject, AuthoredServiceDefinition, LabelAmbiguity,
  LabelContribution, ParsedLabelFile, ServiceAuthoredLabels, SourceFileKind, SourceWritability,
} from './types';

const MAX_PROJECT_FILES = 64;
const MAX_PROJECT_BYTES = 8 * 1024 * 1024;
const MAX_GRAPH_DEPTH = 16;
/** Total `extends` edges one project may walk, across every service. */
const MAX_INHERITANCE_WORK = 2_000;

type ParsedComposeFile = ReturnType<typeof parseComposeDocument>;

interface LoadedComposeFile {
  file: string;
  projectBase: string;
  parsed: ParsedComposeFile;
  /** Files this document includes, so a later promotion can promote its subtree. */
  includes: string[];
}

interface BuildState {
  nodeId: number;
  stack: string;
  fsSvc: FileSystemService;
  files: AuthoredFileSource[];
  loadedCompose: Map<string, LoadedComposeFile>;
  /** Compose files reached from the project's own file chain (never extends-only bases). */
  projectMembers: Set<string>;
  loadedLabelFiles: Map<string, AuthoredFileSource>;
  labelEntries: Map<string, ParsedLabelFile>;
  loadedIdentity: Map<string, AuthoredFileSource>;
  diagnostics: AuthoredDiagnostic[];
  partialReasons: string[];
  bytes: number;
  nextLayer: number;
  serviceDefinitions: Map<string, AuthoredServiceDefinition[]>;
  unresolvedServices: Set<string>;
  inheritanceWork: number;
  inheritanceBudgetReported: boolean;
}

function resolveAgainst(base: string, raw: string): string | null {
  const relative = stackRelativePath(raw);
  if (relative === null) return null;
  const joined = base ? path.posix.join(base, relative) : relative;
  const normalized = path.posix.normalize(joined);
  if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) return null;
  return normalized === '.' ? '' : normalized;
}

function addPartial(state: BuildState, reason: string): void {
  if (!state.partialReasons.includes(reason)) state.partialReasons.push(reason);
}

function addDiagnostic(
  state: BuildState,
  file: string,
  code: AuthoredDiagnostic['code'],
  range?: AuthoredDiagnostic['range'],
): void {
  state.diagnostics.push({ file, code, message: diagnosticMessage(code), ...(range ? { range } : {}) });
}

/** A git-authoritative declaration wins when the same input is named from several layers. */
function strongerWritability(a: SourceWritability, b: SourceWritability): SourceWritability {
  return a === 'git-authoritative' || b === 'git-authoritative' ? 'git-authoritative' : a;
}

async function readProjectFile(
  state: BuildState,
  relPath: string,
): Promise<{ content?: string; contentHash?: string; state: 'parsed' | 'unreadable' | 'too-large' }> {
  if (state.files.length >= MAX_PROJECT_FILES || state.bytes >= MAX_PROJECT_BYTES) {
    addPartial(state, 'bounds-exceeded');
    addDiagnostic(state, relPath, 'bounds-exceeded');
    return { state: 'unreadable' };
  }
  try {
    const read = await state.fsSvc.readStackFile(state.stack, relPath, MAX_COMPOSE_PARSE_BYTES);
    if (read.oversized) {
      addDiagnostic(state, relPath, 'too-large');
      return { state: 'too-large' };
    }
    if (read.binary || read.content === undefined) {
      addDiagnostic(state, relPath, 'unreadable');
      return { state: 'unreadable' };
    }
    const bytes = Buffer.byteLength(read.content, 'utf8');
    if (state.bytes + bytes > MAX_PROJECT_BYTES) {
      addPartial(state, 'bounds-exceeded');
      addDiagnostic(state, relPath, 'bounds-exceeded');
      return { state: 'unreadable' };
    }
    state.bytes += bytes;
    return { content: read.content, contentHash: sha256Hex(read.content), state: 'parsed' };
  } catch (error) {
    addDiagnostic(state, relPath, 'unreadable');
    console.warn('[ComposeSource] Could not read %s for %s:',
      sanitizeForLog(relPath), sanitizeForLog(state.stack), sanitizeForLog(getErrorMessage(error, 'unknown')));
    return { state: 'unreadable' };
  }
}

/**
 * A file first reached through an extends graph can later appear in the
 * project's own file chain. It then becomes a real project layer: it needs a
 * fresh merge position (the chain order, not the earlier extends load), the
 * project kind, and its include subtree promoted with it.
 */
function promoteProjectFile(
  state: BuildState,
  relPath: string,
  kind: SourceFileKind,
  writability: SourceWritability,
): void {
  const loaded = state.loadedCompose.get(relPath);
  if (!loaded) {
    // A depth-refused descendant has no parsed document. Promote its refusal
    // placeholder so the project layer stays visible to the correlation guards.
    const placeholders = state.files.filter(file => file.file === relPath && file.state === 'parse-failed');
    if (placeholders.length === 0) return;
    state.projectMembers.add(relPath);
    const layerIndex = state.nextLayer++;
    for (const entry of placeholders) {
      entry.kind = kind;
      entry.layerIndex = layerIndex;
      entry.writability = strongerWritability(entry.writability, writability);
    }
    return;
  }
  const alreadyProject = state.projectMembers.has(relPath);
  state.projectMembers.add(relPath);
  const authority = strongerWritability(loaded.parsed.writability, writability);
  loaded.parsed.writability = authority;
  const entry = state.files.find(file => file.file === relPath);
  if (alreadyProject) {
    if (entry) entry.writability = authority;
    return;
  }
  const layerIndex = state.nextLayer++;
  loaded.parsed.layerIndex = layerIndex;
  loaded.parsed.kind = kind;
  if (entry) {
    entry.layerIndex = layerIndex;
    entry.kind = kind;
    entry.writability = authority;
  }
  for (const child of loaded.includes) {
    promoteProjectFile(state, child, 'compose-include', authority);
  }
}

/**
 * Load one compose document, its own supporting declarations, then its
 * include/extends graph. `trail` is the recursion stack (a repeat there is a
 * cycle); `loadedCompose` dedupes a shared base reached twice after completion.
 * `inProject` marks files reached from the project's own chain; an extends base
 * is deliberately not a project layer of its own.
 */
async function loadComposeFile(
  state: BuildState,
  relPath: string,
  kind: SourceFileKind,
  writability: SourceWritability,
  projectBase: string,
  depth: number,
  trail: Set<string>,
  inProject: boolean,
): Promise<void> {
  if (trail.has(relPath)) {
    addDiagnostic(state, relPath, 'cycle');
    addPartial(state, 'cycle');
    // Distinguish a project file-graph cycle from a service `extends` cycle:
    // only the former leaves the project's merge order unknowable.
    addPartial(state, 'project-cycle');
    return;
  }
  if (state.loadedCompose.has(relPath)) {
    if (inProject) promoteProjectFile(state, relPath, kind, writability);
    return;
  }
  if (depth > MAX_GRAPH_DEPTH) {
    addDiagnostic(state, relPath, 'too-deep');
    addPartial(state, 'too-deep');
    // The layer was not read. Record it so a correlation cannot claim an origin
    // it could still supersede; an extends-only placeholder is upgraded if its
    // base is later promoted into the project chain.
    state.files.push({
      file: relPath, kind: inProject ? kind : 'compose-extends', writability, layerIndex: state.nextLayer++,
      state: 'parse-failed', nodes: new Map(), diagnostics: [{
        file: relPath, code: 'too-deep', message: diagnosticMessage('too-deep'),
      }],
    });
    return;
  }
  const read = await readProjectFile(state, relPath);
  if (read.content === undefined) {
    state.files.push({
      file: relPath, kind, writability, layerIndex: state.nextLayer++,
      state: read.state === 'too-large' ? 'too-large' : 'unreadable', nodes: new Map(), diagnostics: [],
    });
    addPartial(state, read.state === 'too-large' ? 'too-large' : 'unreadable');
    return;
  }

  // A shallow path can reach a file a too-deep branch refused first; replace
  // that placeholder with the real layer rather than leaving two entries.
  state.files = state.files.filter(entry => !(
    entry.file === relPath && entry.state === 'parse-failed'
    && entry.diagnostics.some(diagnostic => diagnostic.code === 'too-deep')));
  const parsed = parseComposeDocument({
    file: relPath,
    kind,
    writability,
    layerIndex: state.nextLayer++,
    source: read.content,
  });
  state.loadedCompose.set(relPath, { file: relPath, projectBase, parsed, includes: [] });
  if (inProject) state.projectMembers.add(relPath);
  state.files.push({
    file: relPath,
    kind,
    writability,
    layerIndex: parsed.layerIndex,
    state: parsed.state,
    nodes: parsed.nodes,
    diagnostics: parsed.diagnostics,
    ...(parsed.serviceNamesKnown ? { serviceNames: parsed.serviceNames } : {}),
    ...(read.contentHash !== undefined ? { contentHash: read.contentHash } : {}),
  });
  if (parsed.state !== 'parsed') addPartial(state, parsed.state);

  // Supporting declarations resolve against THIS file's project base.
  await loadDeclarationsFor(state, parsed, projectBase);

  trail.add(relPath);

  for (const include of parsed.includes) {
    const resolved = include.paths.map(entry => resolveAgainst(projectBase, entry));
    const first = resolved.find((entry): entry is string => entry !== null);
    let childBase = projectBase;
    if (include.projectDirectory !== undefined) {
      const explicit = resolveAgainst(projectBase, include.projectDirectory);
      if (explicit === null) {
        // Without the project directory, every project-relative declaration in
        // the included project is unresolvable. Do not substitute the parent
        // directory and risk reading a same-named file from the wrong place.
        addPartial(state, 'outside-boundary');
        addDiagnostic(state, include.projectDirectory, 'unreadable');
        state.files.push({
          file: include.projectDirectory, kind: 'compose-include', writability: 'outside-boundary',
          layerIndex: state.nextLayer++, state: 'outside-boundary', nodes: new Map(), diagnostics: [],
        });
        continue;
      }
      childBase = explicit;
    } else if (first !== undefined) {
      childBase = path.posix.dirname(first) === '.' ? '' : path.posix.dirname(first);
    }
    for (const [index, child] of resolved.entries()) {
      if (child === null) {
        addPartial(state, 'outside-boundary');
        addDiagnostic(state, include.paths[index], 'unreadable');
        // An include this reader refuses is still a declared project layer: a
        // consumer must not claim an origin that file could supersede.
        state.files.push({
          file: include.paths[index], kind: 'compose-include', writability: 'outside-boundary',
          layerIndex: state.nextLayer++, state: 'outside-boundary', nodes: new Map(), diagnostics: [],
        });
        continue;
      }
      state.loadedCompose.get(relPath)!.includes.push(child);
      await loadComposeFile(state, child, 'compose-include', writability, childBase, depth + 1, trail, inProject);
    }
  }

  for (const declaration of parsed.extends) {
    if (declaration.file === undefined) continue; // same-file: no extra document to load
    const basePath = resolveAgainst(projectBase, declaration.file);
    if (basePath === null) {
      addPartial(state, 'outside-boundary');
      addDiagnostic(state, declaration.file, 'unreadable');
      state.unresolvedServices.add(declaration.service);
      continue;
    }
    const baseBase = path.posix.dirname(basePath) === '.' ? '' : path.posix.dirname(basePath);
    await loadComposeFile(state, basePath, 'compose-extends', writability, baseBase, depth + 1, trail, false);
  }

  trail.delete(relPath);
}

/** Label files are read; env/config/secret inputs are identity only. */
async function loadDeclarationsFor(
  state: BuildState,
  parsed: ParsedComposeFile,
  projectBase: string,
): Promise<void> {
  for (const declaration of parsed.labelFiles) {
    // A path built from a variable names no file this reader may read. It is
    // reported per service as interpolated, never as outside the boundary.
    if (declaration.interpolated) {
      addPartial(state, 'interpolated');
      continue;
    }
    const target = resolveAgainst(projectBase, declaration.rawPath);
    if (target === null) {
      addPartial(state, 'outside-boundary');
      addDiagnostic(state, declaration.rawPath, 'unreadable');
      continue;
    }
    await loadLabelFile(state, target, parsed.writability);
  }
  for (const declaration of parsed.envFiles) {
    addIdentityInput(state, declaration.rawPath, projectBase, 'env-file', parsed.writability);
  }
  for (const declaration of parsed.resources) {
    addIdentityInput(state, declaration.file, projectBase, declaration.kind, parsed.writability);
  }
}

function addIdentityInput(
  state: BuildState,
  rawPath: string,
  projectBase: string,
  kind: SourceFileKind,
  writability: SourceWritability,
): void {
  const target = resolveAgainst(projectBase, rawPath);
  if (target === null) {
    addDiagnostic(state, rawPath, 'unreadable');
    addPartial(state, 'outside-boundary');
    return;
  }
  if (state.loadedCompose.has(target) || state.loadedLabelFiles.has(target)) return;
  const existing = state.loadedIdentity.get(target);
  if (existing) {
    existing.writability = strongerWritability(existing.writability, writability);
    return;
  }
  const entry: AuthoredFileSource = {
    file: target, kind, writability, layerIndex: state.nextLayer++,
    state: 'identity-only', nodes: new Map(), diagnostics: [],
  };
  state.loadedIdentity.set(target, entry);
  state.files.push(entry);
}

async function loadLabelFile(state: BuildState, relPath: string, writability: SourceWritability): Promise<void> {
  const existing = state.loadedLabelFiles.get(relPath);
  if (existing) {
    existing.writability = strongerWritability(existing.writability, writability);
    return;
  }
  const read = await readProjectFile(state, relPath);
  if (read.content === undefined) {
    const entry: AuthoredFileSource = {
      file: relPath, kind: 'label-file', writability, layerIndex: state.nextLayer++,
      state: read.state === 'too-large' ? 'too-large' : 'unreadable', nodes: new Map(), diagnostics: [],
    };
    state.loadedLabelFiles.set(relPath, entry);
    state.files.push(entry);
    addPartial(state, read.state === 'too-large' ? 'too-large' : 'unreadable');
    return;
  }
  const parsed = parseLabelFile(relPath, read.content);
  state.labelEntries.set(relPath, parsed);
  const tooLarge = parsed.diagnostics.some(entry => entry.code === 'too-large');
  // A line this reader does not reproduce may be a valid Compose label entry,
  // so the file is not understood: no key in it can be treated as parsed.
  const unsupported = parsed.diagnostics.some(entry => entry.code === 'unsupported-syntax');
  const stateName = tooLarge ? 'too-large' : unsupported ? 'parse-failed' : 'parsed';
  const entry: AuthoredFileSource = {
    file: relPath, kind: 'label-file', writability, layerIndex: state.nextLayer++,
    state: stateName, nodes: new Map(), diagnostics: parsed.diagnostics,
    ...(read.contentHash !== undefined ? { contentHash: read.contentHash } : {}),
  };
  state.loadedLabelFiles.set(relPath, entry);
  state.files.push(entry);
  if (stateName !== 'parsed') addPartial(state, stateName);
}

function serviceKey(file: string, service: string): string {
  return `${file}\u0000${service}`;
}

/**
 * Walk one service's `extends` declarations, deepest base first. The returned
 * definitions all belong to the extending project layer (`layerIndex`) so an
 * inherited value sorts below that layer's own declaration and above earlier
 * layers, which is where Compose merges it.
 */
function collectInheritedDefinitions(
  state: BuildState,
  effectiveService: string,
  service: string,
  declaringFile: string,
  layerIndex: number,
  trail: Set<string>,
  out: AuthoredServiceDefinition[],
): boolean {
  const loaded = state.loadedCompose.get(declaringFile);
  if (!loaded) return false;
  let resolved = true;
  for (const declaration of loaded.parsed.extends) {
    if (declaration.service !== service) continue;
    // A long same-file chain is quadratic across services; one shared budget
    // keeps the synchronous build bounded and makes refusal explicit.
    state.inheritanceWork += 1;
    if (state.inheritanceWork > MAX_INHERITANCE_WORK) {
      if (!state.inheritanceBudgetReported) {
        state.inheritanceBudgetReported = true;
        addDiagnostic(state, declaringFile, 'bounds-exceeded');
        addPartial(state, 'bounds-exceeded');
      }
      return false;
    }
    let targetFile = declaringFile;
    if (declaration.file !== undefined) {
      const target = resolveAgainst(loaded.projectBase, declaration.file);
      if (target === null) {
        addDiagnostic(state, declaration.file, 'unreadable');
        addPartial(state, 'outside-boundary');
        resolved = false;
        continue;
      }
      targetFile = target;
    }
    const baseService = declaration.baseService ?? service;
    const key = serviceKey(targetFile, baseService);
    if (trail.has(key)) {
      addDiagnostic(state, targetFile, 'cycle');
      addPartial(state, 'cycle');
      resolved = false;
      continue;
    }
    const target = state.loadedCompose.get(targetFile);
    if (!target || target.parsed.state !== 'parsed' || !target.parsed.serviceNames.includes(baseService)) {
      addDiagnostic(state, targetFile, 'unreadable');
      addPartial(state, 'unreadable');
      resolved = false;
      continue;
    }
    trail.add(key);
    const nested = collectInheritedDefinitions(state, effectiveService, baseService, targetFile, layerIndex, trail, out);
    trail.delete(key);
    if (!nested) resolved = false;
    out.push({
      service: effectiveService,
      declaredService: baseService,
      file: targetFile,
      layerIndex,
      rank: 0,
    });
  }
  return resolved;
}

/** Build every effective service's file-scoped declaration chain. */
function buildServiceDefinitions(state: BuildState): void {
  const layers = [...state.loadedCompose.values()]
    .filter(loaded => state.projectMembers.has(loaded.file))
    .sort((a, b) => a.parsed.layerIndex - b.parsed.layerIndex);

  for (const layer of layers) {
    for (const service of layer.parsed.serviceNames) {
      const definitions = state.serviceDefinitions.get(service) ?? [];
      const inherited: AuthoredServiceDefinition[] = [];
      const complete = collectInheritedDefinitions(
        state,
        service,
        service,
        layer.file,
        layer.parsed.layerIndex,
        new Set([serviceKey(layer.file, service)]),
        inherited,
      );
      definitions.push(...inherited, {
        service,
        declaredService: service,
        file: layer.file,
        layerIndex: layer.parsed.layerIndex,
        rank: 1,
      });
      state.serviceDefinitions.set(service, definitions);
      if (!complete) {
        if (!state.unresolvedServices.has(service)) addPartial(state, 'unresolved-extends');
        state.unresolvedServices.add(service);
      }
    }
  }
}

/**
 * Turn parsed inline labels and label files into ordered contributions. Compose
 * gives `labels` precedence over `label_file` across the whole merged project,
 * so source kind sorts before layer; within one source, layer and declaration
 * order decide. An `extends` base sorts below the layer that inherits it.
 */
function assembleLabels(state: BuildState): Map<string, ServiceAuthoredLabels> {
  const labels = new Map<string, ServiceAuthoredLabels>();

  const getService = (service: string): ServiceAuthoredLabels => {
    const existing = labels.get(service);
    if (existing) return existing;
    const created: ServiceAuthoredLabels = {
      service,
      contributions: [],
      contributionsByKey: new Map(),
      winners: Object.create(null) as Record<string, LabelContribution>,
      sharedFiles: [],
      ambiguity: Object.create(null) as Record<string, LabelAmbiguity>,
      hasDynamicKeys: false,
      unparsedLabelFiles: [],
      outsideLabelFiles: [],
      interpolatedLabelFiles: [],
    };
    labels.set(service, created);
    return created;
  };

  const fileConsumers = new Map<string, Set<string>>();
  const contributionsByService = new Map<string, LabelContribution[]>();

  for (const [service, definitions] of state.serviceDefinitions) {
    const svc = getService(service);
    const bucket = contributionsByService.get(service) ?? [];
    contributionsByService.set(service, bucket);
    for (const definition of definitions) {
      const loaded = state.loadedCompose.get(definition.file);
      if (!loaded) continue;
      const via: LabelContribution['via'] = definition.rank === 0 ? 'extends' : 'own';
      let fileIndex = 0;
      for (const declaration of loaded.parsed.labelFiles) {
        if (declaration.service !== definition.declaredService) continue;
        if (declaration.interpolated) {
          svc.interpolatedLabelFiles.push(declaration.rawPath);
          fileIndex += 1;
          continue;
        }
        const target = resolveAgainst(loaded.projectBase, declaration.rawPath);
        if (target === null) {
          svc.outsideLabelFiles.push(declaration.rawPath);
          fileIndex += 1;
          continue;
        }
        const consumers = fileConsumers.get(target) ?? new Set<string>();
        consumers.add(service);
        fileConsumers.set(target, consumers);
        const parsed = state.labelEntries.get(target);
        const fileEntry = state.loadedLabelFiles.get(target);
        if (!parsed || !fileEntry || fileEntry.state !== 'parsed') {
          svc.unparsedLabelFiles.push(target);
          fileIndex += 1;
          continue;
        }
        for (const entry of parsed.entries) {
          if (parsed.duplicateKeys.has(entry.key)) {
            svc.ambiguity[entry.key] = 'duplicate-key';
            continue;
          }
          const contribution: LabelContribution = {
            key: entry.key,
            source: 'label-file',
            file: target,
            range: entry.range,
            form: 'map',
            fileIndex,
            layerIndex: definition.layerIndex,
            writability: fileEntry.writability,
            hasInterpolation: entry.hasInterpolation,
            keyHasInterpolation: false,
            overridden: false,
            via,
          };
          setAuthoredLabelContributionValue(contribution, authoredLabelFileValueOf(entry));
          bucket.push(contribution);
        }
        fileIndex += 1;
      }
      for (const declaration of loaded.parsed.inlineLabels) {
        if (declaration.service !== definition.declaredService) continue;
        if (declaration.unresolved) {
          svc.ambiguity[declaration.key] = 'unresolved-alias';
          // An unresolved list-form item whose key is built from a variable is
          // still a declaration with an unknown effective key. Keep its place in
          // the precedence order so a later literal can win and an earlier one
          // cannot be claimed.
          if (declaration.keyHasInterpolation === true) {
            svc.hasDynamicKeys = true;
            bucket.push({
              key: declaration.key,
              source: 'inline',
              file: definition.file,
              range: declaration.range,
              form: declaration.form,
              fileIndex: 0,
              layerIndex: definition.layerIndex,
              writability: loaded.parsed.writability,
              hasInterpolation: true,
              keyHasInterpolation: true,
              overridden: false,
              via,
            });
          }
          continue;
        }
        const contribution: LabelContribution = {
          key: declaration.key,
          source: 'inline',
          file: definition.file,
          range: declaration.range,
          form: declaration.form,
          fileIndex: 0,
          layerIndex: definition.layerIndex,
          writability: loaded.parsed.writability,
          hasInterpolation: declaration.hasInterpolation,
          keyHasInterpolation: declaration.keyHasInterpolation === true,
          overridden: false,
          via,
        };
        setAuthoredLabelContributionValue(contribution, authoredInlineLabelValueOf(declaration));
        bucket.push(contribution);
      }
    }
  }

  const sharedFiles = new Set<string>();
  for (const [file, consumers] of fileConsumers) {
    if (consumers.size > 1) sharedFiles.add(file);
  }
  for (const file of sharedFiles) {
    for (const consumer of fileConsumers.get(file) ?? []) {
      const svc = getService(consumer);
      if (!svc.sharedFiles.includes(file)) svc.sharedFiles.push(file);
    }
  }

  const sourceRank = (contribution: LabelContribution): number => contribution.source === 'label-file' ? 0 : 1;
  const viaRank = (contribution: LabelContribution): number => contribution.via === 'extends' ? 0 : 1;

  for (const [service, contributions] of contributionsByService) {
    const svc = getService(service);
    for (const contribution of contributions) {
      if (sharedFiles.has(contribution.file)) contribution.shared = true;
    }
    const sorted = [...contributions].sort((a, b) =>
      sourceRank(a) - sourceRank(b)
      || a.layerIndex - b.layerIndex
      || viaRank(a) - viaRank(b)
      || a.fileIndex - b.fileIndex);
    // A list-form label key built from a variable can resolve to any effective
    // key, so it has no literal name and can supersede a literal winner that
    // sorts before it. It never becomes a winner itself. Compose separates the
    // list item into an interpolated key and value, so the key is unknown while
    // the value stays unread; nothing here resolves it.
    const dynamicKeys = sorted.filter(contribution => contribution.keyHasInterpolation === true);
    svc.hasDynamicKeys = svc.hasDynamicKeys === true || dynamicKeys.length > 0;
    const position = new Map<LabelContribution, number>();
    sorted.forEach((contribution, index) => position.set(contribution, index));
    const latestDynamic = dynamicKeys.reduce((max, contribution) => Math.max(max, position.get(contribution)!), -1);
    const winnerByKey = new Map<string, LabelContribution>();
    for (const contribution of sorted) {
      if (contribution.keyHasInterpolation === true) continue;
      const prior = winnerByKey.get(contribution.key);
      if (prior) prior.overridden = true;
      winnerByKey.set(contribution.key, contribution);
    }
    for (const [key, winner] of winnerByKey) {
      const prior = svc.ambiguity[key];
      // A duplicate inside a label file cannot supersede an inline declaration:
      // inline labels outrank every label file in the merged project.
      if (prior === 'duplicate-key' && winner.source === 'inline') {
        delete svc.ambiguity[key];
      } else if (prior !== undefined) {
        continue;
      }
      // A dynamic key that sorts after the winner (a later inline declaration,
      // or any inline declaration against a label file) could resolve to this
      // key and supersede it. An earlier dynamic key is already overridden by
      // this literal winner, so that winner stays actionable.
      if (latestDynamic > position.get(winner)!) {
        svc.ambiguity[key] = 'interpolated';
        continue;
      }
      if (winner.hasInterpolation) {
        svc.ambiguity[key] = 'interpolated';
        continue;
      }
      svc.winners[key] = winner;
    }
    svc.contributions = sorted;
    const byKey = new Map<string, LabelContribution[]>();
    for (const contribution of sorted) {
      const list = byKey.get(contribution.key) ?? [];
      list.push(contribution);
      byKey.set(contribution.key, list);
    }
    svc.contributionsByKey = byKey;
  }

  return labels;
}

export async function buildAuthoredProject(nodeId: number, stackName: string): Promise<AuthoredProject> {
  const inputs = await resolveProjectInputs(nodeId, stackName);
  const state: BuildState = {
    nodeId,
    stack: stackName,
    fsSvc: FileSystemService.getInstance(nodeId),
    files: [],
    loadedCompose: new Map(),
    projectMembers: new Set(),
    loadedLabelFiles: new Map(),
    labelEntries: new Map(),
    loadedIdentity: new Map(),
    diagnostics: [...inputs.diagnostics],
    partialReasons: [...inputs.partialReasons],
    bytes: 0,
    nextLayer: inputs.files.length,
    serviceDefinitions: new Map(),
    unresolvedServices: new Set(),
    inheritanceWork: 0,
    inheritanceBudgetReported: false,
  };

  const primary = inputs.files[0];
  const projectBase = inputs.projectBase
    ?? (primary && !primary.outsideBoundary && path.posix.dirname(primary.file) !== '.'
      ? path.posix.dirname(primary.file)
      : '');

  for (const entry of inputs.files) {
    if (entry.outsideBoundary) {
      state.files.push({
        file: entry.file, kind: entry.kind, writability: 'outside-boundary',
        // Keep project order: a refusal placeholder must sort exactly where its
        // declared file sits, not at the pre-assigned input index. Parsed and
        // included files consume the same counter as they load, so an outside
        // file that appears after a parsed one is still "later" to every guard.
        layerIndex: state.nextLayer++, state: 'outside-boundary', nodes: new Map(), diagnostics: [],
      });
      addPartial(state, 'outside-boundary');
      continue;
    }
    await loadComposeFile(state, entry.file, entry.kind, entry.writability, projectBase, 0, new Set(), true);
  }

  buildServiceDefinitions(state);
  const labels = assembleLabels(state);

  return {
    stack: stackName,
    nodeId,
    files: state.files,
    generatedLayers: inputs.generatedLayers,
    labels,
    diagnostics: state.diagnostics,
    partial: state.partialReasons.length > 0,
    partialReasons: state.partialReasons,
    serviceDefinitions: state.serviceDefinitions,
    unresolvedServices: state.unresolvedServices,
  };
}
