import { promises as fsPromises } from 'fs';
import path from 'path';

import type { ComposeFile, FetchResult, MaterializationResult } from '../services/GitSourceService';
import type { RefKind } from '../services/git/types';
import { validateCandidateRelPath } from '../services/gitops/createStagingMarker';

export const GIT_CANDIDATE_PREPARED_META_FILE = '.sencho-git-candidate-meta.json';

export interface GitCandidatePreparedMeta {
  version: 1;
  commitSha: string;
  resolvedRefKind: RefKind;
  candidateRelPath: string;
  composeFiles: ComposeFile[];
  envContent: string | null;
  materialization: MaterializationResult;
  warnings: string[];
}

export async function writeGitCandidatePreparedMeta(
  stagingDir: string,
  meta: GitCandidatePreparedMeta,
): Promise<void> {
  const metaPath = path.join(stagingDir, GIT_CANDIDATE_PREPARED_META_FILE);
  await fsPromises.writeFile(metaPath, JSON.stringify(meta), { encoding: 'utf8', mode: 0o600 });
}

export async function readGitCandidatePreparedMeta(payloadPath: string): Promise<GitCandidatePreparedMeta> {
  const metaPath = path.join(payloadPath, GIT_CANDIDATE_PREPARED_META_FILE);
  let raw: string;
  try {
    raw = await fsPromises.readFile(metaPath, 'utf8');
  } catch {
    throw new Error('Prepared git candidate is missing metadata');
  }
  const parsed = JSON.parse(raw) as GitCandidatePreparedMeta;
  if (
    parsed.version !== 1
    || typeof parsed.commitSha !== 'string'
    || typeof parsed.resolvedRefKind !== 'string'
    || typeof parsed.candidateRelPath !== 'string'
    || !parsed.materialization
    || !Array.isArray(parsed.composeFiles)
    || !Array.isArray(parsed.warnings)
  ) {
    throw new Error('Invalid git candidate prepared metadata');
  }
  return parsed;
}

export function fetchResultFromPreparedMeta(meta: GitCandidatePreparedMeta): FetchResult {
  return {
    composeFiles: meta.composeFiles,
    envContent: meta.envContent,
    commitSha: meta.commitSha,
    resolvedRefKind: meta.resolvedRefKind,
    warnings: meta.warnings,
  };
}

/**
 * Restore prepared candidate bytes into the git-managed area for promotion.
 * Payload layout matches a flat copy of the candidate directory (meta file excluded).
 */
export async function installGitCandidatePayloadToManagedRoot(
  payloadPath: string,
  managedRoot: string,
  candidateRelPath: string,
): Promise<void> {
  const managedResolved = path.resolve(managedRoot);
  const pathReason = validateCandidateRelPath(candidateRelPath, managedResolved);
  if (pathReason) {
    throw new Error(pathReason);
  }
  const candidateDest = path.resolve(managedResolved, candidateRelPath);
  if (!candidateDest.startsWith(managedResolved + path.sep)) {
    throw new Error('Invalid candidate path');
  }
  // Canonical js/path-injection barrier inline with the mkdir sink.
  await fsPromises.mkdir(candidateDest, { recursive: true, mode: 0o700 });
  const entries = await fsPromises.readdir(payloadPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === GIT_CANDIDATE_PREPARED_META_FILE) continue;
    if (entry.isSymbolicLink()) continue;
    const src = path.join(payloadPath, entry.name);
    const dest = path.resolve(candidateDest, entry.name);
    if (!dest.startsWith(managedResolved + path.sep)) continue;
    if (entry.isDirectory()) {
      await copyTree(src, dest, managedResolved);
      continue;
    }
    if (entry.isFile()) {
      // Canonical js/path-injection barrier inline with the copy sink.
      await fsPromises.copyFile(src, dest);
      await fsPromises.chmod(dest, 0o600);
    }
  }
}

async function copyTree(srcDir: string, destDir: string, managedResolved: string): Promise<void> {
  const resolvedDestDir = path.resolve(destDir);
  if (!resolvedDestDir.startsWith(managedResolved + path.sep)) {
    return;
  }
  // Canonical js/path-injection barrier inline with the mkdir sink.
  await fsPromises.mkdir(resolvedDestDir, { recursive: true, mode: 0o700 });
  const entries = await fsPromises.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const src = path.join(srcDir, entry.name);
    const dest = path.resolve(resolvedDestDir, entry.name);
    if (!dest.startsWith(managedResolved + path.sep)) continue;
    if (entry.isDirectory()) {
      await copyTree(src, dest, managedResolved);
      continue;
    }
    if (entry.isFile()) {
      // Canonical js/path-injection barrier inline with the copy sink.
      await fsPromises.copyFile(src, dest);
      await fsPromises.chmod(dest, 0o600);
    }
  }
}
