import fs from 'fs';
import path from 'path';
import { parseImageRef } from './registry-api';
import { extractImagesFromCompose } from './ImageUpdateService';
import { normalizeImageHost } from './RegistryService';

const MAX_DOCKERFILE_BYTES = 1_048_576;

export interface RegistryReferenceDiscoveryResult {
  referencedHosts: string[];
}

function hostFromImageRef(imageRef: string): string | null {
  const parsed = parseImageRef(imageRef);
  if (!parsed) return null;
  return normalizeImageHost(parsed.registry);
}

function parseDockerfileReferences(content: string): string[] {
  const hosts = new Set<string>();
  const lines = content.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const fromMatch = /^FROM\s+(--platform=[^\s]+\s+)?([^\s]+)/i.exec(line);
    if (fromMatch?.[2]) {
      const host = hostFromImageRef(fromMatch[2]);
      if (host) hosts.add(host);
    }

    const copyFromMatch = /^COPY\s+--from=([^\s]+)/i.exec(line);
    if (copyFromMatch?.[1] && !/^\d+$/.test(copyFromMatch[1])) {
      const host = hostFromImageRef(copyFromMatch[1]);
      if (host) hosts.add(host);
    }
  }
  return [...hosts];
}

function discoverFromComposeFile(filePath: string, envVars: Record<string, string>): string[] {
  const content = fs.readFileSync(filePath, 'utf8');
  const images = extractImagesFromCompose(content, envVars);
  const hosts = new Set<string>();
  for (const image of images) {
    const host = hostFromImageRef(image);
    if (host) hosts.add(host);
  }
  return [...hosts];
}

function discoverDockerfiles(rootDir: string): string[] {
  const hosts = new Set<string>();
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (lower !== 'dockerfile' && !lower.startsWith('dockerfile.')) continue;
      const stat = fs.statSync(full);
      if (stat.size > MAX_DOCKERFILE_BYTES) {
        throw new Error(`Dockerfile exceeds size limit: ${entry.name}`);
      }
      for (const host of parseDockerfileReferences(fs.readFileSync(full, 'utf8'))) {
        hosts.add(host);
      }
    }
  }
  return [...hosts];
}

/**
 * Discover registry hosts referenced by compose files and Dockerfiles in a
 * project directory. Returns referenced hosts, not proven-private hosts.
 */
export function discoverRegistryReferences(
  projectDir: string,
  envVars: Record<string, string> = {},
): RegistryReferenceDiscoveryResult {
  const hosts = new Set<string>();

  const composeNames = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
  for (const name of composeNames) {
    const composePath = path.join(projectDir, name);
    if (!fs.existsSync(composePath)) continue;
    for (const host of discoverFromComposeFile(composePath, envVars)) {
      hosts.add(host);
    }
  }

  for (const host of discoverDockerfiles(projectDir)) {
    hosts.add(host);
  }

  return { referencedHosts: [...hosts].sort() };
}

export { parseDockerfileReferences };
