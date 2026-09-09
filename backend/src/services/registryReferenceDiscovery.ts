import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { extractImagesFromCompose, extractServiceImagesFromCompose } from './ImageUpdateService';
import { parsePullReference, pullReferenceHost } from '../helpers/registryPullReference';

const MAX_DOCKERFILE_BYTES = 1_048_576;

export interface RegistryReferenceDiscoveryResult {
  referencedHosts: string[];
  referencedPullRefs: string[];
}

interface ReferenceAccumulator {
  hosts: Set<string>;
  pullRefs: Set<string>;
}

function collectRef(acc: ReferenceAccumulator, imageRef: string): void {
  const pullRef = parsePullReference(imageRef);
  if (!pullRef) return;
  // Hosts are derived from the same parse as the pull refs so the two sets can
  // never disagree: a ref the parser rejects contributes neither a host nor a
  // list entry.
  acc.hosts.add(pullReferenceHost(pullRef));
  acc.pullRefs.add(pullRef.value);
}

function parseDockerfileReferencesInto(acc: ReferenceAccumulator, content: string): void {
  const lines = content.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const fromMatch = /^FROM\s+(--platform=[^\s]+\s+)?([^\s]+)/i.exec(line);
    if (fromMatch?.[2]) {
      collectRef(acc, fromMatch[2]);
    }

    const copyFromMatch = /^COPY\s+--from=([^\s]+)/i.exec(line);
    if (copyFromMatch?.[1] && !/^\d+$/.test(copyFromMatch[1])) {
      collectRef(acc, copyFromMatch[1]);
    }
  }
}

function parseDockerfileReferences(content: string): string[] {
  const acc: ReferenceAccumulator = { hosts: new Set(), pullRefs: new Set() };
  parseDockerfileReferencesInto(acc, content);
  return [...acc.hosts];
}

function readRegularFileSync(filePath: string, baseResolved: string): Buffer | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(baseResolved + path.sep)) return null;
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
}

function discoverFromComposeFile(
  baseResolved: string,
  fileName: string,
  envVars: Record<string, string>,
  acc: ReferenceAccumulator,
  service?: string,
): void {
  const safePath = path.resolve(baseResolved, fileName);
  if (!safePath.startsWith(baseResolved + path.sep)) {
    return;
  }
  const content = readRegularFileSync(safePath, baseResolved);
  if (!content) return;
  if (service) {
    // Service-scoped discovery: only the selected service's refs participate.
    // Compose merges multi-file projects, so a service named in more than one
    // file contributes its image from each; the conservative union never
    // under-covers what `compose pull <service>` may fetch.
    const composeContent = content.toString('utf8');
    const images = extractServiceImagesFromCompose(composeContent, envVars)
      .filter(entry => entry.service === service)
      .map(entry => entry.image);
    for (const image of images) {
      collectRef(acc, image);
    }
    collectServiceDockerfileRefs(
      baseResolved,
      path.dirname(safePath),
      composeContent,
      service,
      acc,
    );
    return;
  }
  for (const image of extractImagesFromCompose(content.toString('utf8'), envVars)) {
    collectRef(acc, image);
  }
}

function discoverDockerfiles(baseResolved: string, acc: ReferenceAccumulator): void {
  const stack: string[] = [baseResolved];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      // An unreadable subdirectory contributes no refs, which lowers coverage
      // but never blocks discovery; the refusal matrix on the hub side treats
      // missing coverage as a passthrough, not an error.
      continue;
    }
    for (const entry of entries) {
      const full = path.resolve(current, entry.name);
      if (!full.startsWith(baseResolved + path.sep)) continue;
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (lower !== 'dockerfile' && !lower.startsWith('dockerfile.')) continue;
      const fd = fs.openSync(full, 'r');
      try {
        const stat = fs.fstatSync(fd);
        if (stat.size > MAX_DOCKERFILE_BYTES) {
          throw new Error(`Dockerfile exceeds size limit: ${entry.name}`);
        }
        const buf = Buffer.alloc(stat.size);
        fs.readSync(fd, buf, 0, stat.size, 0);
        parseDockerfileReferencesInto(acc, buf.toString('utf8'));
      } finally {
        fs.closeSync(fd);
      }
    }
  }
}

function finalizeDiscovery(acc: ReferenceAccumulator): RegistryReferenceDiscoveryResult {
  return {
    referencedHosts: [...acc.hosts].sort(),
    referencedPullRefs: [...acc.pullRefs].sort(),
  };
}

export function discoverRegistryReferencesFromComposeContent(
  composeContent: string,
  envVars: Record<string, string> = {},
  service?: string,
): RegistryReferenceDiscoveryResult {
  const acc: ReferenceAccumulator = { hosts: new Set(), pullRefs: new Set() };
  if (service) {
    // Body content has no project directory, so a build-context Dockerfile
    // cannot be read here; only the selected service's image ref participates.
    const images = extractServiceImagesFromCompose(composeContent, envVars)
      .filter(entry => entry.service === service)
      .map(entry => entry.image);
    for (const image of images) {
      collectRef(acc, image);
    }
    return finalizeDiscovery(acc);
  }
  for (const image of extractImagesFromCompose(composeContent, envVars)) {
    collectRef(acc, image);
  }
  return finalizeDiscovery(acc);
}

interface ComposeServiceBuildSpec {
  context: string;
  dockerfile?: string;
}

/**
 * Read the selected service's `build:` section from a compose document.
 * `build` may be a string context or an object with context/dockerfile keys;
 * relative paths resolve against the compose file's directory, absolute paths
 * are kept as-is but still confined by the caller's path checks.
 */
function composeServiceBuildSpec(
  yamlContent: string,
  serviceName: string,
): ComposeServiceBuildSpec | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = YAML.parse(yamlContent) as Record<string, unknown>;
  } catch {
    // An unparseable compose file contributes no build refs; the warn keeps
    // the narrowed coverage visible next to a later remote-side failure.
    console.warn('[registryReferenceDiscovery] REGISTRY_DELIVERY_COMPOSE_UNPARSEABLE', {
      service: serviceName,
    });
    return null;
  }
  const services = parsed?.services;
  if (!services || typeof services !== 'object') return null;
  const svc = (services as Record<string, unknown>)[serviceName];
  if (!svc || typeof svc !== 'object') return null;
  const build = (svc as Record<string, unknown>).build;
  if (typeof build === 'string') {
    return { context: build };
  }
  if (build && typeof build === 'object') {
    const b = build as Record<string, unknown>;
    const context = typeof b.context === 'string' && b.context ? b.context : '.';
    const dockerfile = typeof b.dockerfile === 'string' && b.dockerfile ? b.dockerfile : undefined;
    return { context, dockerfile };
  }
  return null;
}

function readFileSyncOrNull(resolved: string, baseResolved: string): Buffer | null {
  if (!resolved.startsWith(baseResolved + path.sep)) return null;
  let fd: number | undefined;
  try {
    fd = fs.openSync(resolved, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      console.warn('[registryReferenceDiscovery] REGISTRY_DELIVERY_DOCKERFILE_UNREADABLE', {
        dockerfile: path.basename(resolved),
        reason: 'not a regular file',
      });
      return null;
    }
    if (stat.size > MAX_DOCKERFILE_BYTES) {
      console.warn('[registryReferenceDiscovery] REGISTRY_DELIVERY_DOCKERFILE_OVERSIZED', {
        dockerfile: path.basename(resolved),
        bytes: stat.size,
      });
      return null;
    }
    const buf = Buffer.alloc(stat.size);
    fs.readSync(fd, buf, 0, stat.size, 0);
    return buf;
  } catch (error) {
    // An absent or unreadable Dockerfile contributes no refs: coverage
    // narrows and the refusal matrix treats missing coverage as passthrough.
    // Absence is the expected shape (a service may keep its build section
    // after switching to a prebuilt image), so it stays silent; every other
    // failure narrows coverage invisibly unless logged.
    const reason = (error as NodeJS.ErrnoException)?.code ?? 'unknown';
    if (reason !== 'ENOENT') {
      console.warn('[registryReferenceDiscovery] REGISTRY_DELIVERY_DOCKERFILE_UNREADABLE', {
        dockerfile: path.basename(resolved),
        reason,
      });
    }
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Collect refs from the Dockerfile the selected service builds from, if any.
 * Only that one Dockerfile participates: `compose pull <service>` never pulls
 * FROM images of a sibling service's build, so sibling Dockerfiles stay out
 * of the attested reference set.
 */
function collectServiceDockerfileRefs(
  baseResolved: string,
  composeDir: string,
  composeContent: string,
  serviceName: string,
  acc: ReferenceAccumulator,
): void {
  const spec = composeServiceBuildSpec(composeContent, serviceName);
  if (!spec) return;
  const contextPath = path.resolve(composeDir, spec.context);
  const dockerfilePath = spec.dockerfile
    ? path.resolve(contextPath, spec.dockerfile)
    : path.resolve(contextPath, 'Dockerfile');
  // A build context or Dockerfile path the project cannot contain is never
  // read; the warn keeps the narrowed coverage from being a silent surprise.
  if (!contextPath.startsWith(baseResolved + path.sep)) {
    console.warn('[registryReferenceDiscovery] REGISTRY_DELIVERY_DOCKERFILE_OUTSIDE_BASE', {
      context: spec.context,
    });
    return;
  }
  if (!dockerfilePath.startsWith(baseResolved + path.sep)) {
    console.warn('[registryReferenceDiscovery] REGISTRY_DELIVERY_DOCKERFILE_OUTSIDE_BASE', {
      dockerfile: spec.dockerfile ?? 'Dockerfile',
    });
    return;
  }
  const content = readFileSyncOrNull(dockerfilePath, baseResolved);
  if (!content) return;
  parseDockerfileReferencesInto(acc, content.toString('utf8'));
}

/**
 * Discover registry hosts and exact pull references referenced by compose files
 * and Dockerfiles in a project directory. Returns referenced entities, not
 * proven-private ones.
 *
 * When `service` is set, discovery is scoped to that one service: its compose
 * `image:` ref plus the Dockerfile its `build:` section points at. The set
 * then equals what `docker compose pull <service>` (or `build --pull
 * <service>`) will fetch for that service, excluding siblings' images and
 * unrelated Dockerfiles. Both the hub-side discover and the target-side seam
 * call this with the same service so their attested hash claims cannot
 * disagree.
 */
export function discoverRegistryReferences(
  projectDir: string,
  envVars: Record<string, string> = {},
  service?: string,
): RegistryReferenceDiscoveryResult {
  const acc: ReferenceAccumulator = { hosts: new Set(), pullRefs: new Set() };
  const baseResolved = path.resolve(projectDir);

  const composeNames = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
  for (const name of composeNames) {
    const composePath = path.resolve(baseResolved, name);
    if (!composePath.startsWith(baseResolved + path.sep)) continue;
    if (!fs.existsSync(composePath)) continue;
    discoverFromComposeFile(baseResolved, name, envVars, acc, service);
  }

  if (!service) {
    discoverDockerfiles(baseResolved, acc);
  }

  return finalizeDiscovery(acc);
}

export { parseDockerfileReferences };
