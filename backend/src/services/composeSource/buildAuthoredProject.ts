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

import { parseComposeDocument, parseLabelFile, MAX_COMPOSE_PARSE_BYTES, diagnosticMessage } from './parseComposeDocument';
import { resolveProjectInputs, stackRelativePath } from './resolveProjectInputs';
import type {
  AuthoredDiagnostic, AuthoredFileSource, AuthoredProject, LabelContribution,
  ParsedLabelFile, ServiceAuthoredLabels, SourceFileKind, SourceWritability,
} from './types';

const MAX_PROJECT_FILES = 64;
const MAX_PROJECT_BYTES = 8 * 1024 * 1024;
const MAX_GRAPH_DEPTH = 16;

type ParsedComposeFile = ReturnType<typeof parseComposeDocument>;

interface LoadedComposeFile {
  file: string;
  projectBase: string;
  parsed: ParsedComposeFile;
}

interface BuildState {
  nodeId: number;
  stack: string;
  fsSvc: FileSystemService;
  files: AuthoredFileSource[];
  loadedCompose: Map<string, LoadedComposeFile>;
  loadedLabelFiles: Map<string, AuthoredFileSource>;
  labelEntries: Map<string, ParsedLabelFile>;
  loadedIdentity: Set<string>;
  diagnostics: AuthoredDiagnostic[];
  partialReasons: string[];
  bytes: number;
  nextLayer: number;
  extendsServices: Map<string, string[]>;
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

async function readProjectFile(
  state: BuildState,
  relPath: string,
): Promise<{ content?: string; state: 'parsed' | 'unreadable' | 'too-large' }> {
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
    return { content: read.content, state: 'parsed' };
  } catch (error) {
    addDiagnostic(state, relPath, 'unreadable');
    console.warn('[ComposeSource] Could not read %s for %s:',
      sanitizeForLog(relPath), sanitizeForLog(state.stack), sanitizeForLog(getErrorMessage(error, 'unknown')));
    return { state: 'unreadable' };
  }
}

/**
 * Load one compose document, its own supporting declarations, then its
 * include/extends graph. `trail` is the recursion stack (a repeat there is a
 * cycle); `loadedCompose` dedupes a shared base reached twice after completion.
 */
async function loadComposeFile(
  state: BuildState,
  relPath: string,
  kind: SourceFileKind,
  writability: SourceWritability,
  projectBase: string,
  depth: number,
  trail: Set<string>,
): Promise<void> {
  if (trail.has(relPath)) {
    addDiagnostic(state, relPath, 'cycle');
    addPartial(state, 'cycle');
    return;
  }
  if (state.loadedCompose.has(relPath)) return;
  if (depth > MAX_GRAPH_DEPTH) {
    addDiagnostic(state, relPath, 'too-deep');
    addPartial(state, 'too-deep');
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

  const parsed = parseComposeDocument({
    file: relPath,
    kind,
    writability,
    layerIndex: state.nextLayer++,
    source: read.content,
  });
  state.loadedCompose.set(relPath, { file: relPath, projectBase, parsed });
  state.files.push({
    file: relPath,
    kind,
    writability,
    layerIndex: parsed.layerIndex,
    state: parsed.state,
    nodes: parsed.nodes,
    diagnostics: parsed.diagnostics,
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
        continue;
      }
      await loadComposeFile(state, child, 'compose-include', writability, childBase, depth + 1, trail);
    }
  }

  for (const declaration of parsed.extends) {
    const basePath = resolveAgainst(projectBase, declaration.file);
    if (basePath === null) {
      addPartial(state, 'outside-boundary');
      addDiagnostic(state, declaration.file, 'unreadable');
      continue;
    }
    const baseBase = path.posix.dirname(basePath) === '.' ? '' : path.posix.dirname(basePath);
    await loadComposeFile(state, basePath, 'compose-extends', writability, baseBase, depth + 1, trail);
    if (declaration.baseService) {
      const bases = state.extendsServices.get(declaration.service) ?? [];
      if (!bases.includes(declaration.baseService)) bases.push(declaration.baseService);
      state.extendsServices.set(declaration.service, bases);
    }
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
    const target = resolveAgainst(projectBase, declaration.rawPath);
    if (target === null) {
      addPartial(state, 'outside-boundary');
      addDiagnostic(state, declaration.rawPath, 'unreadable');
      continue;
    }
    await loadLabelFile(state, target);
  }
  for (const declaration of parsed.envFiles) {
    addIdentityInput(state, declaration.rawPath, projectBase, 'env-file');
  }
  for (const declaration of parsed.resources) {
    addIdentityInput(state, declaration.file, projectBase, declaration.kind);
  }
}

function addIdentityInput(
  state: BuildState,
  rawPath: string,
  projectBase: string,
  kind: SourceFileKind,
): void {
  const target = resolveAgainst(projectBase, rawPath);
  if (target === null) {
    addDiagnostic(state, rawPath, 'unreadable');
    addPartial(state, 'outside-boundary');
    return;
  }
  if (state.loadedIdentity.has(target) || state.loadedCompose.has(target) || state.loadedLabelFiles.has(target)) return;
  state.loadedIdentity.add(target);
  state.files.push({
    file: target, kind, writability: 'writable', layerIndex: state.nextLayer++,
    state: 'identity-only', nodes: new Map(), diagnostics: [],
  });
}

async function loadLabelFile(state: BuildState, relPath: string): Promise<void> {
  if (state.loadedLabelFiles.has(relPath)) return;
  const read = await readProjectFile(state, relPath);
  if (read.content === undefined) {
    const entry: AuthoredFileSource = {
      file: relPath, kind: 'label-file', writability: 'writable', layerIndex: state.nextLayer++,
      state: read.state === 'too-large' ? 'too-large' : 'unreadable', nodes: new Map(), diagnostics: [],
    };
    state.loadedLabelFiles.set(relPath, entry);
    state.files.push(entry);
    addPartial(state, read.state === 'too-large' ? 'too-large' : 'unreadable');
    return;
  }
  const parsed = parseLabelFile(relPath, read.content);
  state.labelEntries.set(relPath, parsed);
  const stateName = parsed.diagnostics.some(entry => entry.code === 'too-large') ? 'too-large' : 'parsed';
  const entry: AuthoredFileSource = {
    file: relPath, kind: 'label-file', writability: 'writable', layerIndex: state.nextLayer++,
    state: stateName, nodes: new Map(), diagnostics: parsed.diagnostics,
  };
  state.loadedLabelFiles.set(relPath, entry);
  state.files.push(entry);
  if (stateName !== 'parsed') addPartial(state, stateName);
}

interface LabelDeclaration {
  service: string;
  file: string;
  layerIndex: number;
  rawPath: string;
  index: number;
}

/**
 * Turn parsed inline labels and label files into ordered contributions.
 * Compose precedence is: extended base first, then each layer in order, within
 * a layer label files in declared order (last wins) and inline `labels` last.
 * That order is reproduced here, never guessed from values.
 */
function assembleLabels(state: BuildState): Map<string, ServiceAuthoredLabels> {
  const labels = new Map<string, ServiceAuthoredLabels>();

  const getService = (service: string): ServiceAuthoredLabels => {
    const existing = labels.get(service);
    if (existing) return existing;
    const created: ServiceAuthoredLabels = {
      service,
      contributions: [],
      winners: {},
      sharedFiles: [],
      ambiguity: {},
      unparsedLabelFiles: [],
      outsideLabelFiles: [],
    };
    labels.set(service, created);
    return created;
  };

  const fileConsumers = new Map<string, Set<string>>();
  const declarations: LabelDeclaration[] = [];
  const indexByService = new Map<string, number>();

  for (const loaded of state.loadedCompose.values()) {
    for (const declaration of loaded.parsed.labelFiles) {
      const target = resolveAgainst(loaded.projectBase, declaration.rawPath);
      if (target === null) {
        const svc = getService(declaration.service);
        svc.outsideLabelFiles.push(declaration.rawPath);
        continue;
      }
      const consumers = fileConsumers.get(target) ?? new Set<string>();
      consumers.add(declaration.service);
      fileConsumers.set(target, consumers);
      const index = indexByService.get(declaration.service) ?? 0;
      indexByService.set(declaration.service, index + 1);
      declarations.push({
        service: declaration.service,
        file: target,
        layerIndex: loaded.parsed.layerIndex,
        rawPath: declaration.rawPath,
        index,
      });
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

  const contributionsByService = new Map<string, LabelContribution[]>();

  for (const declaration of declarations) {
    const parsed = state.labelEntries.get(declaration.file);
    const fileEntry = state.loadedLabelFiles.get(declaration.file);
    const bucket = contributionsByService.get(declaration.service) ?? [];
    contributionsByService.set(declaration.service, bucket);
    if (!parsed || !fileEntry || fileEntry.state !== 'parsed') {
      getService(declaration.service).unparsedLabelFiles.push(declaration.file);
      continue;
    }
    for (const entry of parsed.entries) {
      if (parsed.duplicateKeys.has(entry.key)) {
        getService(declaration.service).ambiguity[entry.key] = 'duplicate-key';
        continue;
      }
      bucket.push({
        key: entry.key,
        source: 'label-file',
        file: declaration.file,
        range: entry.range,
        form: 'map',
        fileIndex: declaration.index,
        layerIndex: declaration.layerIndex,
        hasInterpolation: entry.hasInterpolation,
        overridden: false,
        via: 'own',
        ...(sharedFiles.has(declaration.file) ? { shared: true } : {}),
      });
    }
  }

  for (const loaded of state.loadedCompose.values()) {
    for (const declaration of loaded.parsed.inlineLabels) {
      const bucket = contributionsByService.get(declaration.service) ?? [];
      contributionsByService.set(declaration.service, bucket);
      bucket.push({
        key: declaration.key,
        source: 'inline',
        file: loaded.file,
        range: declaration.range,
        form: declaration.form,
        fileIndex: 0,
        layerIndex: loaded.parsed.layerIndex,
        hasInterpolation: declaration.hasInterpolation,
        overridden: false,
        via: 'own',
      });
    }
  }

  // `extends` makes the base service's labels part of the extending service,
  // always below the extending service's own declarations.
  for (const loaded of state.loadedCompose.values()) {
    for (const declaration of loaded.parsed.extends) {
      if (!declaration.baseService) continue;
      const base = contributionsByService.get(declaration.baseService) ?? [];
      const bucket = contributionsByService.get(declaration.service) ?? [];
      for (const contribution of base) {
        bucket.push({
          ...contribution,
          via: 'extends',
          overridden: false,
        });
      }
      contributionsByService.set(declaration.service, bucket);
    }
  }

  for (const [service, contributions] of contributionsByService) {
    const svc = getService(service);
    svc.contributions = contributions;
    const sorted = [...contributions].sort((a, b) =>
      (a.via === 'extends' ? 0 : 1) - (b.via === 'extends' ? 0 : 1)
      || a.layerIndex - b.layerIndex
      || (a.source === 'label-file' ? 0 : 1) - (b.source === 'label-file' ? 0 : 1)
      || a.fileIndex - b.fileIndex);
    const winnerByKey = new Map<string, LabelContribution>();
    for (const contribution of sorted) {
      const prior = winnerByKey.get(contribution.key);
      if (prior) prior.overridden = true;
      winnerByKey.set(contribution.key, contribution);
    }
    for (const [key, winner] of winnerByKey) {
      if (svc.ambiguity[key] === 'duplicate-key') continue;
      if (winner.hasInterpolation) {
        svc.ambiguity[key] = 'interpolated';
        continue;
      }
      svc.winners[key] = winner;
    }
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
    loadedLabelFiles: new Map(),
    labelEntries: new Map(),
    loadedIdentity: new Set(),
    diagnostics: [...inputs.diagnostics],
    partialReasons: [...inputs.partialReasons],
    bytes: 0,
    nextLayer: inputs.files.length,
    extendsServices: new Map(),
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
        layerIndex: entry.layerIndex, state: 'outside-boundary', nodes: new Map(), diagnostics: [],
      });
      addPartial(state, 'outside-boundary');
      continue;
    }
    await loadComposeFile(state, entry.file, entry.kind, entry.writability, projectBase, 0, new Set());
  }

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
    extendsServices: state.extendsServices,
  };
}
