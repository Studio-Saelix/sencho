import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import YAML from 'yaml';
import {
  extractImagesFromCompose,
  extractServiceImagesFromCompose,
  extractServiceImagesFromRenderedConfig,
} from './ImageUpdateService';
import { parsePullReference, pullReferenceHost } from '../helpers/registryPullReference';
import { sanitizeForLog } from '../utils/safeLog';
import { getErrorMessage } from '../utils/errors';

const MAX_DOCKERFILE_BYTES = 1_048_576;
const RENDER_TIMEOUT_MS = 20_000;
const RENDER_MAX_OUTPUT = 5 * 1024 * 1024;

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
  // Stage aliases declared so far, lowercased so COPY --from=ALIAS matches a
  // FROM ... AS alias case-insensitively (Dockerfile stage names are
  // case-insensitive). Valid Dockerfiles are order-constrained: an alias must
  // be declared by a FROM before a COPY can reference it, so a single top-down
  // pass is sufficient. The FROM base image is still an external pull; only an
  // alias-targeting COPY is a local reference and must be skipped.
  const declaredAliases = new Set<string>();
  const lines = content.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const fromMatch = /^FROM\s+(--platform=[^\s]+\s+)?([^\s]+)(?:\s+AS\s+([^\s]+))?/i.exec(line);
    if (fromMatch?.[2]) {
      collectRef(acc, fromMatch[2]);
      if (fromMatch[3]) {
        declaredAliases.add(fromMatch[3].toLowerCase());
      }
    }

    const copyFromMatch = /^COPY\s+--from=([^\s]+)/i.exec(line);
    if (copyFromMatch?.[1] && !/^\d+$/.test(copyFromMatch[1])) {
      const copyTarget = copyFromMatch[1].toLowerCase();
      if (!declaredAliases.has(copyTarget)) {
        collectRef(acc, copyFromMatch[1]);
      }
    }
  }
}

function parseDockerfileReferences(content: string): string[] {
  const acc: ReferenceAccumulator = { hosts: new Set(), pullRefs: new Set() };
  parseDockerfileReferencesInto(acc, content);
  return [...acc.hosts];
}

/**
 * Canonical containment classification for a candidate path. `within` carries
 * the realpath to open; a path that resolves outside the base (directly or
 * through a symlink) is `escaped`; a path that cannot be resolved at all
 * (dangling symlink, absent file) is `unresolvable`. Only `escaped` is an
 * escape to warn about; `unresolvable` contributes no refs and stays silent so
 * a missing Dockerfile does not masquerade as an escape. Callers open the
 * canonical path, never the lexical input, so a symlink inside the base cannot
 * redirect a read to a file outside it.
 */
type CanonicalContainment =
  | { status: 'within'; canonical: string }
  | { status: 'escaped' }
  | { status: 'unresolvable' };

function classifyCanonicalContainment(
  resolved: string,
  canonicalBase: string,
): CanonicalContainment {
  let canonical: string;
  try {
    canonical = fs.realpathSync(resolved);
  } catch {
    return { status: 'unresolvable' };
  }
  if (canonical === canonicalBase || canonical.startsWith(canonicalBase + path.sep)) {
    return { status: 'within', canonical };
  }
  return { status: 'escaped' };
}

function readRegularFileSync(filePath: string, canonicalBase: string): Buffer | null {
  // Containment is canonical: the path is realpath'd against the base before
  // the open, so a symlink inside the base cannot redirect the read to a
  // file outside it, and an unresolvable path is skipped without a throw.
  const resolved = path.resolve(filePath);
  const containment = classifyCanonicalContainment(resolved, canonicalBase);
  if (containment.status !== 'within') return null;
  const fd = fs.openSync(containment.canonical, 'r');
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
  canonicalBase: string,
  fileName: string,
  envVars: Record<string, string>,
  acc: ReferenceAccumulator,
  service?: string,
): void {
  const safePath = path.resolve(canonicalBase, fileName);
  if (!safePath.startsWith(canonicalBase + path.sep)) {
    return;
  }
  const content = readRegularFileSync(safePath, canonicalBase);
  if (!content) return;
  if (service) {
    // Service-scoped per-file pass: only the selected service's image refs
    // participate here. A service named in more than one file contributes its
    // image from each, so the conservative union never under-covers what
    // `compose pull <service>` may fetch. Build-context Dockerfile refs are
    // collected separately across all files by the caller.
    const images = extractServiceImagesFromCompose(content.toString('utf8'), envVars)
      .filter(entry => entry.service === service)
      .map(entry => entry.image);
    for (const image of images) {
      collectRef(acc, image);
    }
    return;
  }
  for (const image of extractImagesFromCompose(content.toString('utf8'), envVars)) {
    collectRef(acc, image);
  }
}

function discoverDockerfiles(canonicalBase: string, acc: ReferenceAccumulator): void {
  // Dirent classification does not follow symlinks, so a symlinked directory
  // is never descended and a symlinked Dockerfile is never opened here.
  const stack: string[] = [canonicalBase];
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
      if (!full.startsWith(canonicalBase + path.sep)) continue;
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

function readFileSyncOrNull(resolved: string, canonicalBase: string): Buffer | null {
  // A resolved Dockerfile path may equal the base itself (for example
  // `dockerfile: .` with the stack root as context), so the containment
  // check must accept equality, not just a strict descendant. Containment is
  // canonical: the open targets the realpath inside the base, so a symlink
  // inside the base cannot redirect the read to a file outside it.
  // Silent here: an escaped path was already warned upstream before this
  // guard, so that branch is defense in depth; an unresolvable path (a
  // missing or dangling-symlink Dockerfile) is the normal silent case,
  // like any absent file.
  const containment = classifyCanonicalContainment(resolved, canonicalBase);
  if (containment.status !== 'within') return null;
  let fd: number | undefined;
  try {
    fd = fs.openSync(containment.canonical, 'r');
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
  canonicalBase: string,
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
  // A build context or Dockerfile path that resolves outside the project is
  // never read; the warn keeps the narrowed coverage from being a silent
  // surprise. The stack root itself is in bounds: `build: .` resolves the
  // context to it, so only paths strictly outside the base reach this warn.
  // Containment is canonical, so a symlinked context or Dockerfile that
  // resolves outside the base is treated exactly like an authored escape,
  // while a missing file stays silent like any absent Dockerfile.
  const contextContainment = classifyCanonicalContainment(contextPath, canonicalBase);
  if (contextContainment.status === 'escaped') {
    console.warn('[registryReferenceDiscovery] REGISTRY_DELIVERY_DOCKERFILE_OUTSIDE_BASE', {
      context: spec.context,
    });
    return;
  }
  const dockerfileContainment = classifyCanonicalContainment(dockerfilePath, canonicalBase);
  if (dockerfileContainment.status === 'escaped') {
    console.warn('[registryReferenceDiscovery] REGISTRY_DELIVERY_DOCKERFILE_OUTSIDE_BASE', {
      dockerfile: spec.dockerfile ?? 'Dockerfile',
    });
    return;
  }
  const content = readFileSyncOrNull(dockerfilePath, canonicalBase);
  if (!content) return;
  parseDockerfileReferencesInto(acc, content.toString('utf8'));
}

/**
 * Collect the selected service's build-context Dockerfile refs across every
 * compose file of the project. The effective render carries merged image
 * refs but no Dockerfile contents, and the service's `build:` section may
 * live in any one file of a multi-file project, so each file is consulted
 * and a service that builds is found whichever file declares it.
 */
function collectServiceDockerfileRefsAcrossCompose(
  canonicalBase: string,
  composeNames: string[],
  serviceName: string,
  acc: ReferenceAccumulator,
): void {
  for (const name of composeNames) {
    const composePath = path.resolve(canonicalBase, name);
    const content = readRegularFileSync(composePath, canonicalBase);
    if (!content) continue;
    collectServiceDockerfileRefs(
      canonicalBase,
      path.dirname(composePath),
      content.toString('utf8'),
      serviceName,
      acc,
    );
  }
}

// A `docker compose config --format json` render must be well-formed JSON
// before it is trusted; a zero exit with garbage on stdout is a degraded
// render, not a clean model, so the caller's per-file union still applies.
function isRenderOutputJson(stdout: string): boolean {
  try {
    JSON.parse(stdout);
    return true;
  } catch {
    return false;
  }
}

/**
 * Render the effective merged compose model with `docker compose config`.
 * The spawned child runs in the project dir with the discovery envVars in
 * its process env; the shell environment has the highest Compose
 * interpolation precedence, so the render resolves exactly the variable map
 * the caller resolved and the hub-side discover and the target-side seam
 * cannot disagree on the model. PATH is set last so a PATH value arriving
 * through the project env can never redirect which docker binary runs.
 * Returns null on any render failure so the caller falls back to the
 * per-file union, which never under-covers.
 */

async function renderComposeEffectiveModel(
  projectDir: string,
  composeFiles: string[],
  envVars: Record<string, string>,
): Promise<string | null> {
  // The canonical base is computed inline, in the same scope as the spawn
  // cwd sink, so one containment boundary covers both the child's working
  // directory and every compose file resolved against it before either
  // reaches the child. Hoisting the canonicalization elsewhere would split
  // that boundary across scopes.
  let cwd: string;
  try {
    cwd = fs.realpathSync(path.resolve(projectDir));
  } catch {
    return null;
  }
  const args: string[] = ['compose'];
  for (const name of composeFiles) {
    const resolved = path.resolve(cwd, name);
    // The docker child resolves symlinks itself, so a lexical containment
    // check would be weaker than the canonical invariant every direct read in
    // this file already enforces: classify the file canonically and fall back
    // to the per-file union when it is not inside the base.
    const containment = classifyCanonicalContainment(resolved, cwd);
    if (containment.status !== 'within') {
      return null;
    }
    args.push('-f', containment.canonical);
  }
  args.push('config', '--format', 'json');
  const child = spawn('docker', args, {
    cwd,
    env: {
      ...process.env,
      ...envVars,
      // The deploy child receives project vars only through --env-file
      // interpolation, never as process env, so these docker-control vars are
      // pinned to the server's values and a project env file cannot redirect
      // the CLI binary, its credential config dir, or the daemon endpoint.
      DOCKER_CONFIG: process.env.DOCKER_CONFIG,
      DOCKER_HOST: process.env.DOCKER_HOST,
      DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
      PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    },
  });
  return new Promise<string | null>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let capped = false;
    let settled = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, RENDER_TIMEOUT_MS);
    const finish = (rendered: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(rendered);
    };
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
      if (stdout.length > RENDER_MAX_OUTPUT && !capped) { capped = true; child.kill('SIGKILL'); }
    });
    child.stderr.on('data', (data: Buffer) => {
      if (stderr.length < RENDER_MAX_OUTPUT) stderr += data.toString();
    });
    // A spawn error (most commonly a missing docker binary) is the same
    // degraded-fallback condition as a nonzero exit; it warns identically so
    // the operator can tell why discovery fell back to the per-file union.
    child.on('error', (error) => {
      console.warn('[registryReferenceDiscovery] REGISTRY_DELIVERY_EFFECTIVE_RENDER_FAILED', {
        code: null,
        timedOut: false,
        capped: false,
        spawnError: sanitizeForLog(getErrorMessage(error, 'spawn failed')),
      });
      finish(null);
    });
    child.on('close', (code) => {
      if (code === 0 && !timedOut && !capped && isRenderOutputJson(stdout)) {
        finish(stdout);
        return;
      }
      // The effective render failed (unset variable, bad include, missing
      // docker, timeout, output cap) or emitted output that is not valid JSON
      // (a successful exit does not guarantee a well-formed `--format json`
      // payload). The per-file fallback the caller applies never under-covers,
      // so the degradation is only logged for the operator; stderr is
      // sanitized because Compose error text can quote interpolated values.
      console.warn('[registryReferenceDiscovery] REGISTRY_DELIVERY_EFFECTIVE_RENDER_FAILED', {
        code,
        timedOut,
        capped,
        stderr: sanitizeForLog(stderr.trim()),
      });
      finish(null);
    });
  });
}

/**
 * Discover registry hosts and exact pull references referenced by compose files
 * and Dockerfiles in a project directory. Returns referenced entities, not
 * proven-private ones.
 *
 * When `service` is set, discovery is scoped to that one service: its image
 * ref comes from the effective merged compose model when the render succeeds
 * (so a multi-file merge or a Compose interpolation the per-file regexes
 * cannot reproduce still matches what `docker compose pull <service>` would
 * fetch), plus the Dockerfile its `build:` section points at. The set then
 * equals what `docker compose pull <service>` (or `build --pull <service>`)
 * will fetch for that service, excluding siblings' images and unrelated
 * Dockerfiles. Both the hub-side discover and the target-side seam call this
 * with the same service and the same env map, so their attested hash claims
 * cannot disagree; when the render fails, the conservative per-file union
 * applies instead, which never under-covers what a per-file parse finds.
 *
 * When `composeFiles` is provided and non-empty it names the exact compose
 * files to scan (for multi-file Git candidates), each relative to the project
 * dir; otherwise the default root compose names apply. The per-file existence
 * guard is unchanged so an absent file is a no-op, never a throw.
 */
export async function discoverRegistryReferences(
  projectDir: string,
  envVars: Record<string, string> = {},
  service?: string,
  composeFiles?: string[],
): Promise<RegistryReferenceDiscoveryResult> {
  const acc: ReferenceAccumulator = { hosts: new Set(), pullRefs: new Set() };

  let canonicalBase: string;
  try {
    canonicalBase = fs.realpathSync(path.resolve(projectDir));
  } catch {
    // A missing or unreadable project dir contributes no refs; the refusal
    // matrix treats missing coverage as a passthrough, not an error.
    return finalizeDiscovery(acc);
  }

  const composeNames =
    composeFiles !== undefined && composeFiles.length > 0
      ? composeFiles
      : ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
  const existingComposeNames: string[] = [];
  for (const name of composeNames) {
    const composePath = path.resolve(canonicalBase, name);
    if (!composePath.startsWith(canonicalBase + path.sep)) continue;
    if (!fs.existsSync(composePath)) continue;
    existingComposeNames.push(name);
  }

  if (service && existingComposeNames.length > 0) {
    const rendered = await renderComposeEffectiveModel(projectDir, existingComposeNames, envVars);
    if (rendered !== null) {
      const images = extractServiceImagesFromRenderedConfig(rendered)
        .filter(entry => entry.service === service)
        .map(entry => entry.image);
      for (const image of images) {
        collectRef(acc, image);
      }
      // The render carries merged image refs but not Dockerfile contents, so
      // the selected service's build-context Dockerfile is collected per
      // file; the union never misses a build section declared in any one
      // file.
      collectServiceDockerfileRefsAcrossCompose(canonicalBase, existingComposeNames, service, acc);
      return finalizeDiscovery(acc);
    }
  }

  for (const name of existingComposeNames) {
    discoverFromComposeFile(canonicalBase, name, envVars, acc, service);
  }
  if (service) {
    collectServiceDockerfileRefsAcrossCompose(canonicalBase, existingComposeNames, service, acc);
  } else {
    discoverDockerfiles(canonicalBase, acc);
  }

  return finalizeDiscovery(acc);
}

export { parseDockerfileReferences };
