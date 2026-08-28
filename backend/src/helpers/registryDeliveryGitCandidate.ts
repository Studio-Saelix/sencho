import { promises as fsPromises } from 'fs';
import path from 'path';

import type { ComposeFile, FetchResult, MaterializationResult } from '../services/GitSourceService';

export const GIT_CANDIDATE_PREPARED_META_FILE = '.sencho-git-candidate-meta.json';

export interface GitCandidatePreparedMeta {
  version: 1;
  commitSha: string;
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
  const candidateDest = path.join(managedRoot, candidateRelPath);
  await fsPromises.mkdir(candidateDest, { recursive: true, mode: 0o700 });
  const entries = await fsPromises.readdir(payloadPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === GIT_CANDIDATE_PREPARED_META_FILE) continue;
    if (entry.isSymbolicLink()) continue;
    const src = path.join(payloadPath, entry.name);
    const dest = path.join(candidateDest, entry.name);
    if (entry.isDirectory()) {
      await copyTree(src, dest);
      continue;
    }
    if (entry.isFile()) {
      await fsPromises.copyFile(src, dest);
      await fsPromises.chmod(dest, 0o600);
    }
  }
}

async function copyTree(srcDir: string, destDir: string): Promise<void> {
  await fsPromises.mkdir(destDir, { recursive: true, mode: 0o700 });
  const entries = await fsPromises.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyTree(src, dest);
      continue;
    }
    if (entry.isFile()) {
      await fsPromises.copyFile(src, dest);
      await fsPromises.chmod(dest, 0o600);
    }
  }
}
