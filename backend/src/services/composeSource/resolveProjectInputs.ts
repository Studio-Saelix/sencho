/**
 * Resolve the authored project's main file chain exactly as deploy resolves it.
 *
 * Order mirrors `ComposeService`: an applied multi-file deploy spec wins, then
 * `COMPOSE_FILE` when the stack sets it, then Compose's own discovery (the
 * resolved root file plus the first existing implicit override). Paths are
 * validated the same way `authoredComposeFileArgs` validates them, and every
 * path that leaves the stack is recorded as `outside-boundary` and never read.
 */
import path from 'path';

import { FileSystemService } from '../FileSystemService';
import { authoredComposeFileArgs, composeFileEnvVarSelection } from '../../utils/authoredComposeArgs';
import { isHostAbsolutePath, isUrl, isDynamicPath } from '../../helpers/composeInputParse';
import { getErrorMessage } from '../../utils/errors';
import { sanitizeForLog } from '../../utils/safeLog';
import { isStackMeshManaged } from '../network/managedMeshAttachment';
import { DatabaseService } from '../DatabaseService';

import { diagnosticMessage } from './parseComposeDocument';
import type { AuthoredDiagnostic, SourceFileKind, SourceWritability } from './types';

export interface ProjectChainFile {
  /** Stack-relative POSIX path. */
  file: string;
  kind: SourceFileKind;
  writability: SourceWritability;
  layerIndex: number;
  /** The declaration named a path the model refuses to read. */
  outsideBoundary?: boolean;
}

export interface ProjectInputs {
  stack: string;
  nodeId: number;
  /** Stack-relative project directory, when a deploy spec pins one. */
  projectBase?: string;
  files: ProjectChainFile[];
  generatedLayers: Array<'mesh-override'>;
  diagnostics: AuthoredDiagnostic[];
  partial: boolean;
  partialReasons: string[];
}

/**
 * A stack-relative POSIX path, or null when the entry is absolute, a URL,
 * dynamic, or escapes the stack directory. Backslashes are normalized before
 * the escape check so a Windows-style spelling cannot slip through.
 */
export function stackRelativePath(entry: string): string | null {
  const trimmed = entry.trim();
  if (!trimmed || isHostAbsolutePath(trimmed) || isUrl(trimmed) || isDynamicPath(trimmed)) return null;
  const normalized = path.posix.normalize(trimmed.replace(/\\/g, '/')).replace(/^\.\//, '');
  if (normalized === '' || normalized === '.' || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    return null;
  }
  return normalized;
}

function outsideFile(entry: string, kind: SourceFileKind, layerIndex: number): ProjectChainFile {
  return { file: entry, kind, writability: 'outside-boundary', layerIndex, outsideBoundary: true };
}

function pushDiagnostic(
  diagnostics: AuthoredDiagnostic[],
  file: string,
  code: AuthoredDiagnostic['code'],
): void {
  diagnostics.push({ file, code, message: diagnosticMessage(code) });
}

export async function resolveProjectInputs(nodeId: number, stackName: string): Promise<ProjectInputs> {
  const files: ProjectChainFile[] = [];
  const diagnostics: AuthoredDiagnostic[] = [];
  const partialReasons: string[] = [];
  const generatedLayers: Array<'mesh-override'> = [];
  const fsSvc = FileSystemService.getInstance(nodeId);

  const addFile = (entry: string, kind: SourceFileKind, writability: SourceWritability): void => {
    const relative = stackRelativePath(entry);
    if (relative === null) {
      files.push(outsideFile(entry, kind, files.length));
      partialReasons.push('outside-boundary');
      return;
    }
    files.push({ file: relative, kind, writability: writability, layerIndex: files.length });
  };

  let specFiles: string[] | null = null;
  let specFailed = false;
  let specProjectBase: string | undefined;
  try {
    const spec = DatabaseService.getInstance().getGitSource(stackName)?.applied_deploy_spec ?? null;
    if (spec && spec.files.length > 0) specFiles = spec.files;
    // Throws on a malformed or escaping spec, exactly as a deploy would.
    const args = authoredComposeFileArgs(stackName, nodeId);
    const fromArgs: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === '-f' && args[i + 1] !== undefined) fromArgs.push(args[i + 1]);
    }
    if (fromArgs.length > 0) specFiles = fromArgs;
    const projectDirIndex = args.indexOf('--project-directory');
    if (projectDirIndex !== -1 && args[projectDirIndex + 1] !== undefined) {
      const stackDir = path.resolve(fsSvc.getBaseDir(), stackName);
      const relative = path.relative(stackDir, path.resolve(args[projectDirIndex + 1])).replace(/\\/g, '/');
      if (relative === '' || relative === '.' || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
        specFailed = true;
        pushDiagnostic(diagnostics, '', 'unreadable');
        partialReasons.push('project-directory-outside-stack');
      } else {
        specProjectBase = relative;
      }
    }
  } catch (error) {
    // A spec a deploy refuses is not one this reader may guess around. Falling
    // back to discovery would locate files the deploy never reads, so the model
    // reports the gap instead.
    specFailed = true;
    pushDiagnostic(diagnostics, '', 'unreadable');
    partialReasons.push('deploy-spec-unreadable');
    console.warn('[ComposeSource] Deploy spec unreadable for %s:',
      sanitizeForLog(stackName), sanitizeForLog(getErrorMessage(error, 'unknown')));
  }

  if (specFailed) {
    return {
      stack: stackName,
      nodeId,
      files,
      generatedLayers,
      diagnostics,
      partial: true,
      partialReasons,
    };
  }

  if (specFiles && specFiles.length > 0) {
    for (const [index, entry] of specFiles.entries()) {
      addFile(entry, index === 0 ? 'compose-primary' : 'compose-additional', 'git-authoritative');
    }
  } else {
    let selection;
    try {
      selection = await composeFileEnvVarSelection(stackName, nodeId);
    } catch (error) {
      pushDiagnostic(diagnostics, '', 'unreadable');
      partialReasons.push('compose-file-unreadable');
      console.warn('[ComposeSource] COMPOSE_FILE selection unreadable for %s:',
        sanitizeForLog(stackName), sanitizeForLog(getErrorMessage(error, 'unknown')));
      selection = { kind: 'unknown' as const, reason: 'selection unreadable', loadedEnvFiles: [] };
    }

    if (selection.kind === 'value') {
      // Compose splits COMPOSE_FILE with COMPOSE_PATH_SEPARATOR; empty entries
      // are ignored by the loader, so they are ignored here too.
      const entries = selection.value.split(selection.pathSeparator).filter(entry => entry !== '');
      for (const [index, entry] of entries.entries()) {
        addFile(entry, index === 0 ? 'compose-primary' : 'compose-additional', 'writable');
      }
      if (entries.length === 0) {
        pushDiagnostic(diagnostics, '', 'unreadable');
        partialReasons.push('compose-file-empty');
      }
    } else if (selection.kind === 'unknown' || selection.kind === 'invalid') {
      // The selection helper's contract says an unknown or invalid result is
      // decisive: Compose may load a file this reader cannot reproduce, or
      // cannot read a file it was told to load. Discovery would guess a chain
      // the deploy never ran, so the model reports the gap instead.
      pushDiagnostic(diagnostics, '', 'unreadable');
      partialReasons.push('compose-file-unknown');
    } else {
      try {
        const primary = await fsSvc.getComposeFilename(stackName);
        addFile(primary, 'compose-primary', 'writable');
        const override = await fsSvc.getOverrideFilename(stackName);
        if (override !== null) addFile(override, 'compose-override', 'writable');
      } catch (error) {
        pushDiagnostic(diagnostics, '', 'unreadable');
        partialReasons.push('compose-file-missing');
        console.warn('[ComposeSource] No readable compose file for %s:',
          sanitizeForLog(stackName), sanitizeForLog(getErrorMessage(error, 'unknown')));
      }
    }
  }

  try {
    if (await isStackMeshManaged(nodeId, stackName)) generatedLayers.push('mesh-override');
  } catch (error) {
    // Mesh state is additive context, not a reason to fail the model.
    console.warn('[ComposeSource] Mesh state unreadable for %s:',
      sanitizeForLog(stackName), sanitizeForLog(getErrorMessage(error, 'unknown')));
  }

  return {
    stack: stackName,
    nodeId,
    ...(specProjectBase !== undefined ? { projectBase: specProjectBase } : {}),
    files,
    generatedLayers,
    diagnostics,
    partial: partialReasons.length > 0,
    partialReasons,
  };
}
