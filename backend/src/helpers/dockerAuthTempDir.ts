import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ensureTrustedRoot, validateTrustedRoot } from './privateRootValidator';

export const DOCKER_AUTH_MARKER_FILE = '.sencho-docker-auth';
export const DOCKER_AUTH_PARENT_PREFIX = 'sencho-docker-auth-';
export const DOCKER_AUTH_LOCAL_CHILD_PREFIX = 'local-';
export const DOCKER_AUTH_DELIVERED_CHILD_PREFIX = 'delivered-';

export type DockerAuthChildKind = 'local' | 'delivered';

export interface DockerAuthTempDirHandle {
  dirPath: string;
  kind: DockerAuthChildKind;
  cleanup: () => void;
}

function deliverySourceHash(deliverySourceId: string): string {
  return crypto.createHash('sha256').update(`docker-auth:${deliverySourceId}`).digest('hex');
}

export function getDockerAuthParentPath(deliverySourceId: string): string {
  return path.join(os.tmpdir(), `${DOCKER_AUTH_PARENT_PREFIX}${deliverySourceHash(deliverySourceId)}`);
}

function childPrefixForKind(kind: DockerAuthChildKind): string {
  return kind === 'local' ? DOCKER_AUTH_LOCAL_CHILD_PREFIX : DOCKER_AUTH_DELIVERED_CHILD_PREFIX;
}

function isTypedChildName(name: string): DockerAuthChildKind | null {
  if (name.startsWith(DOCKER_AUTH_LOCAL_CHILD_PREFIX)) return 'local';
  if (name.startsWith(DOCKER_AUTH_DELIVERED_CHILD_PREFIX)) return 'delivered';
  return null;
}

function publishMarker(childDir: string): void {
  const markerPath = path.join(childDir, DOCKER_AUTH_MARKER_FILE);
  const fd = fs.openSync(markerPath, 'wx', 0o600);
  try {
    fs.writeSync(fd, 'docker-auth\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function removeChildDir(childDir: string): void {
  try {
    const configPath = path.join(childDir, 'config.json');
    try { fs.unlinkSync(configPath); } catch { /* may not exist */ }
    try { fs.unlinkSync(path.join(childDir, DOCKER_AUTH_MARKER_FILE)); } catch { /* may not exist */ }
    fs.rmdirSync(childDir);
  } catch {
    /* best effort */
  }
}

/**
 * Create a typed Docker-auth child directory with marker-before-payload publication.
 */
export function createDockerAuthTempDir(
  deliverySourceId: string,
  kind: DockerAuthChildKind,
  config: { auths: Record<string, { auth: string }> },
): DockerAuthTempDirHandle {
  const parentPath = getDockerAuthParentPath(deliverySourceId);
  const parentValidation = ensureTrustedRoot({ rootPath: parentPath, kind: 'docker-auth' });
  if (!parentValidation.ok) {
    throw new Error(parentValidation.reason);
  }

  const childName = `${childPrefixForKind(kind)}${crypto.randomBytes(8).toString('hex')}`;
  const childDir = path.join(parentPath, childName);

  if (fs.existsSync(childDir)) {
    throw new Error('docker-auth child collision');
  }

  fs.mkdirSync(childDir, { mode: 0o700 });
  try {
    publishMarker(childDir);
    const configPath = path.join(childDir, 'config.json');
    const fd = fs.openSync(configPath, 'wx', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(config));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    removeChildDir(childDir);
    throw error;
  }

  return {
    dirPath: childDir,
    kind,
    cleanup: () => removeChildDir(childDir),
  };
}

export interface DockerAuthSweepResult {
  swept: string[];
  preservedMarkerless: string[];
  legacyOrphansObserved: string[];
}

/**
 * Sweep marked crash remnants under the owned Docker-auth parent. Markerless
 * children are preserved because they contain no published payload.
 */
export async function sweepDockerAuthTempDirs(deliverySourceId: string): Promise<DockerAuthSweepResult> {
  const parentPath = getDockerAuthParentPath(deliverySourceId);
  const result: DockerAuthSweepResult = {
    swept: [],
    preservedMarkerless: [],
    legacyOrphansObserved: [],
  };

  const parentValidation = validateTrustedRoot({ rootPath: parentPath, kind: 'docker-auth' });
  if (!parentValidation.ok) {
    return result;
  }

  let entries: string[];
  try {
    entries = await fs.promises.readdir(parentPath);
  } catch {
    return result;
  }

  for (const entry of entries) {
    const childPath = path.join(parentPath, entry);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(childPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    if (!isTypedChildName(entry)) continue;

    const markerPath = path.join(childPath, DOCKER_AUTH_MARKER_FILE);
    if (!fs.existsSync(markerPath)) {
      result.preservedMarkerless.push(entry);
      continue;
    }

    removeChildDir(childPath);
    result.swept.push(entry);
  }

  // Observe but do not delete legacy top-level sencho-docker-* dirs.
  try {
    const tmpEntries = await fs.promises.readdir(os.tmpdir());
    for (const entry of tmpEntries) {
      if (entry.startsWith('sencho-docker-') && !entry.startsWith(DOCKER_AUTH_PARENT_PREFIX)) {
        result.legacyOrphansObserved.push(entry);
      }
    }
  } catch {
    /* ignore */
  }

  return result;
}

export function classifyDockerAuthChildName(name: string): DockerAuthChildKind | null {
  return isTypedChildName(name);
}
