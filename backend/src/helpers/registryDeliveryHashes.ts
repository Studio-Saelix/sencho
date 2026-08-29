import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const COMPOSE_FILENAMES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
  '.env',
];

/** Stable hash of inline compose body content (body-content discovery). */
export function hashComposeBodyContent(composeContent: string): string {
  const hash = crypto.createHash('sha256');
  hash.update('compose.yaml');
  hash.update('\0');
  hash.update(composeContent);
  hash.update('\n');
  return hash.digest('hex');
}

/** Stable hash of the live project file bundle used for live-project delivery. */
export function hashProjectSource(projectDir: string): string {
  const hash = crypto.createHash('sha256');
  const baseResolved = path.resolve(projectDir);
  for (const name of COMPOSE_FILENAMES) {
    const filePath = path.resolve(baseResolved, name);
    if (!filePath.startsWith(baseResolved + path.sep)) continue;
    const content = readRegularFileSync(filePath, baseResolved);
    if (!content) continue;
    hash.update(name);
    hash.update('\0');
    hash.update(content);
    hash.update('\n');
  }
  return hash.digest('hex');
}

function readRegularFileSync(filePath: string, baseResolved: string): Buffer | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(baseResolved + path.sep)) return null;
  try {
    const fd = fs.openSync(resolved, 'r');
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) return null;
      const buf = Buffer.alloc(stat.size);
      fs.readSync(fd, buf, 0, stat.size, 0);
      return buf;
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function hashDirectoryTree(rootDir: string, hash: crypto.Hash, current = ''): void {
  const baseResolved = path.resolve(rootDir);
  const abs = current ? path.resolve(baseResolved, current) : baseResolved;
  if (current && !abs.startsWith(baseResolved + path.sep)) {
    return;
  }
  const entries = fs.readdirSync(abs, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const rel = current ? path.join(current, entry.name) : entry.name;
    const filePath = path.resolve(baseResolved, rel);
    if (!filePath.startsWith(baseResolved + path.sep)) continue;
    if (entry.isDirectory()) {
      hashDirectoryTree(rootDir, hash, rel);
      continue;
    }
    if (!entry.isFile()) continue;
    const content = readRegularFileSync(filePath, baseResolved);
    if (!content) continue;
    hash.update(rel.split(path.sep).join('/'));
    hash.update('\0');
    hash.update(content);
    hash.update('\n');
  }
}

/** Stable hash of a prepared source bundle directory (all regular files). */
export function hashDeliverySourceDir(projectDir: string): string {
  const hash = crypto.createHash('sha256');
  hashDirectoryTree(projectDir, hash);
  return hash.digest('hex');
}

export function hashActionSet(actions: readonly string[]): string {
  return crypto
    .createHash('sha256')
    .update(actions.slice().sort().join('\n'))
    .digest('hex');
}
