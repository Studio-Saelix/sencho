import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

function collectRelativeFiles(rootDir: string, current = ''): string[] {
  const abs = current ? path.join(rootDir, current) : rootDir;
  const entries = fs.readdirSync(abs, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const rel = current ? path.join(current, entry.name) : entry.name;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      files.push(...collectRelativeFiles(rootDir, rel));
      continue;
    }
    if (entry.isFile()) {
      files.push(rel.split(path.sep).join('/'));
    }
  }
  return files.sort();
}

const COMPOSE_FILENAMES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
  '.env',
];

/** Stable hash of the live project file bundle used for live-project delivery. */
export function hashProjectSource(projectDir: string): string {
  const hash = crypto.createHash('sha256');
  const baseResolved = path.resolve(projectDir);
  for (const name of COMPOSE_FILENAMES) {
    const filePath = path.resolve(baseResolved, name);
    if (!filePath.startsWith(baseResolved + path.sep)) continue;
    try {
      const content = fs.readFileSync(filePath);
      hash.update(name);
      hash.update('\0');
      hash.update(content);
      hash.update('\n');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
  return hash.digest('hex');
}

/** Stable hash of a prepared source bundle directory (all regular files). */
export function hashDeliverySourceDir(projectDir: string): string {
  const hash = crypto.createHash('sha256');
  for (const rel of collectRelativeFiles(projectDir)) {
    const filePath = path.join(projectDir, rel);
    hash.update(rel);
    hash.update('\0');
    hash.update(fs.readFileSync(filePath));
    hash.update('\n');
  }
  return hash.digest('hex');
}

export function hashActionSet(actions: readonly string[]): string {
  return crypto
    .createHash('sha256')
    .update(actions.slice().sort().join('\n'))
    .digest('hex');
}
