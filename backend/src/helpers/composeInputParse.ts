/**
 * Pure Compose input declaration parser for the Git managed-project
 * materializer. Walks compose YAML (explicit files plus recursive include /
 * extends.file graphs) and emits every repository-local input that can affect
 * validation or deployment, WITHOUT touching the filesystem: file contents are
 * injected via the `read` callback so this module stays side-effect free and
 * testable.
 *
 * Resolution rules (compose spec):
 * - `include:` and `extends.file` paths resolve relative to the declaring
 *   file's directory.
 * - include map-form `env_file` resolves relative to the project directory.
 * - service `env_file`, top-level `configs`/`secrets` `file:`, `label_file`
 *   and `build.context` are recorded with a base dir; the classifier resolves
 *   them against the effective project directory (the first compose file's
 *   directory, or the context dir when one is configured), except in files
 *   reached via include/extends, which keep their own directory. An omitted
 *   build context defaults to the project directory.
 * - relative bind-mount host sources resolve relative to the project dir.
 *
 * Never throws: parse errors are collected into `parseErrors` and surface as
 * refusals at classification time.
 */
import path from 'path';
import YAML from 'yaml';
import type {
    DeclaredInput,
    DynamicInput,
    InputDependencyKind,
    InputRole,
    ParsedDeclaredInputs,
} from '../types/gitProjectManifest';

// Refuse to parse anything beyond this bound so a malformed (or adversarial)
// compose file cannot exhaust heap while walking the project. Mirrors the cap
// in composeDependencyParse.ts / composePreview.ts.
const MAX_COMPOSE_PARSE_BYTES = 1_048_576; // 1 MiB

// Include/extends recursion bound; deeper graphs are refused as unsupported.
const MAX_INCLUDE_DEPTH = 16;

export interface ParseOptions {
    /** Repo-relative project root (today's context_dir); null = repo root. */
    projectRoot: string | null;
    /** Fetches a repo-relative file's content for include/extends recursion; null when unreadable. */
    read: (repoPath: string) => string | null;
}

interface ComposeRefs {
    inputs: DeclaredInput[];
    dynamic: DynamicInput[];
    parseErrors: string[];
}

function isDynamicPath(p: string): boolean {
    return p.includes('$');
}

function normalizeRepoPath(p: string): string {
    return path.posix.normalize(p).replace(/\\/g, '/').replace(/^\/+/, '');
}

function resolveRelative(declaringDir: string | null, target: string): string {
    // URL includes (http/https/git) are recorded verbatim; the classifier
    // refuses them as url-include.
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(target)) return target.trim();
    if (path.posix.isAbsolute(target)) return normalizeRepoPath(target);
    return normalizeRepoPath(declaringDir ? `${declaringDir}/${target}` : target);
}

function emitInput(
    refs: ComposeRefs,
    sourcePath: string | null,
    kind: InputDependencyKind,
    role: InputRole,
    fromFile: string,
    baseDir: DeclaredInput['baseDir'],
    service: string | null = null,
): void {
    if (sourcePath !== null && isDynamicPath(sourcePath)) {
        refs.dynamic.push({ sourcePath, kind, note: 'Path contains a variable; resolved by Compose at deploy time, not enumerated.' });
        return;
    }
    refs.inputs.push({ sourcePath, baseDir, kind, role, fromFile, service });
}

function asString(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    return undefined;
}

/** Normalize an env_file entry (string, list item, or map {path, required}) to its path. */
function envFilePath(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const p = (value as Record<string, unknown>).path;
        return asString(p);
    }
    return undefined;
}

/** Normalize a configs/secrets entry to a file path, or null for external/env forms. */
function resourceFilePath(value: unknown): string | null {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        if (record.external === true || record.external !== undefined) return null; // docker supplies it
        if ('env' in record || 'environment' in record) return null; // env-injected
        const f = record.file;
        if (f !== undefined) return asString(f) ?? null;
        return null; // plain {} or name-only reference
    }
    if (value === null) return null;
    return null;
}

function shortFormBindSource(volume: string): string | null {
    const colon = volume.indexOf(':');
    if (colon === -1) return null;
    const src = volume.slice(0, colon);
    // Named volumes have no path separators or leading dot/slash/tilde.
    if (/^[A-Za-z0-9_.-]+$/.test(src) && !src.startsWith('.') && !src.startsWith('~')) return null;
    return src;
}

/** Collect bind-mount host sources from a service volumes list. */
function collectBindMounts(volumes: unknown, fromFile: string, refs: ComposeRefs): void {
    if (!Array.isArray(volumes)) return;
    for (const entry of volumes) {
        if (typeof entry === 'string') {
            const src = shortFormBindSource(entry);
            if (src === null) continue;
            const hostAbs = src.startsWith('/') || src.startsWith('~') || /^[A-Za-z]:[\\/]/.test(src);
            emitInput(refs, hostAbs ? null : src, 'bind-mount', 'bind-mount', fromFile, hostAbs ? 'host' : 'project-root');
            continue;
        }
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
            const record = entry as Record<string, unknown>;
            if (record.type === 'bind' && typeof record.source === 'string') {
                const src = record.source;
                const hostAbs = src.startsWith('/') || src.startsWith('~') || /^[A-Za-z]:[\\/]/.test(src);
                emitInput(refs, hostAbs ? null : src, 'bind-mount', 'bind-mount', fromFile, hostAbs ? 'host' : 'project-root');
            }
        }
    }
}

/** Collect build declarations (context, dockerfile, secrets, additional contexts). */
function collectBuild(build: unknown, fromFile: string, refs: ComposeRefs, service: string | null): void {
    if (typeof build === 'string') {
        emitInput(refs, build, 'build-context', 'build-context', fromFile, 'compose-file-dir', service);
        return;
    }
    if (!build || typeof build !== 'object' || Array.isArray(build)) return;
    const record = build as Record<string, unknown>;
    if (typeof record.context === 'string') {
        emitInput(refs, record.context, 'build-context', 'build-context', fromFile, 'compose-file-dir', service);
    } else {
        // An omitted context defaults to the declaring file's project
        // directory (compose spec). The classifier resolves '.' against the
        // project directory: the context dir, the base file's directory for
        // merged (-f) files, or the declaring file's own directory for
        // include/extends-reached files.
        emitInput(refs, '.', 'build-context', 'build-context', fromFile, 'compose-file-dir', service);
    }
    if (typeof record.dockerfile === 'string') {
        // Dockerfile is relative to the context; the classifier rebases it.
        emitInput(refs, record.dockerfile, 'dockerfile', 'dockerfile', fromFile, 'compose-file-dir', service);
    }
    if (record.secrets && Array.isArray(record.secrets)) {
        // Long syntax carries only source/target/uid/gid/mode; `source` names
        // a TOP-LEVEL SECRET (compose errors if it is not defined in the
        // top-level secrets section), never a file path. The referenced
        // secret's file, when file-backed, is emitted by the top-level
        // secrets walk; the reference itself is recorded as unmanaged, the
        // same as the string form.
        record.secrets.forEach(() => {
            emitInput(refs, null, 'build-secret', 'build-secret', fromFile, 'host', service);
        });
    }
    if (record.additional_contexts && typeof record.additional_contexts === 'object' && !Array.isArray(record.additional_contexts)) {
        for (const [, ctxPath] of Object.entries(record.additional_contexts as Record<string, unknown>)) {
            const p = asString(ctxPath);
            if (p !== undefined) {
                emitInput(refs, p, 'build-additional-context', 'build-additional-context', fromFile, 'compose-file-dir', service);
            }
        }
    }
}

/** Walk one service definition for file-backed inputs. */
function walkService(serviceName: string, service: unknown, fromFile: string, refs: ComposeRefs): void {
    if (!service || typeof service !== 'object' || Array.isArray(service)) return;
    const record = service as Record<string, unknown>;

    // extends.file (map form); the string form extends a sibling service in the same file.
    if (record.extends && typeof record.extends === 'object' && !Array.isArray(record.extends)) {
        const ext = record.extends as Record<string, unknown>;
        if (typeof ext.file === 'string') {
            emitInput(refs, ext.file, 'extends', 'compose-additional', fromFile, 'compose-file-dir');
        }
    }

    const envFile = record.env_file;
    if (envFile !== undefined) {
        if (Array.isArray(envFile)) {
            for (const entry of envFile) {
                const p = envFilePath(entry);
                if (p !== undefined) emitInput(refs, p, 'env_file', 'env', fromFile, 'compose-file-dir');
            }
        } else {
            const p = envFilePath(envFile);
            if (p !== undefined) emitInput(refs, p, 'env_file', 'env', fromFile, 'compose-file-dir');
        }
    }

    if (typeof record.label_file === 'string') {
        emitInput(refs, record.label_file, 'label_file', 'label-file', fromFile, 'compose-file-dir');
    }

    if (record.build !== undefined) collectBuild(record.build, fromFile, refs, serviceName);
    collectBindMounts(record.volumes, fromFile, refs);

    // Per-service configs/secrets references are keys into the top-level
    // maps, which the top-level walk emits; nothing to record here.
    void serviceName;
}

/**
 * Parse one compose file into declarations, recursing into include/extends.
 * Cycle detection uses the RECURSION STACK (a file re-entered while still
 * being walked is a real cycle); a file reached again after completion is a
 * shared base (diamond / repeated include) and dedupes silently.
 */
function parseFile(
    repoPath: string,
    content: string,
    opts: ParseOptions,
    refs: ComposeRefs,
    visited: Set<string>,
    stack: Set<string>,
    depth: number,
): void {
    const normalized = normalizeRepoPath(repoPath);
    if (stack.has(normalized)) {
        refs.parseErrors.push(`Include/extends cycle detected at ${normalized}`);
        return;
    }
    if (visited.has(normalized)) {
        return; // shared base file, not a cycle
    }
    stack.add(normalized);
    try {
        parseFileInner(normalized, content, opts, refs, visited, stack, depth);
    } finally {
        stack.delete(normalized);
        visited.add(normalized);
    }
}

function parseFileInner(
    normalized: string,
    content: string,
    opts: ParseOptions,
    refs: ComposeRefs,
    visited: Set<string>,
    stack: Set<string>,
    depth: number,
): void {
    if (depth > MAX_INCLUDE_DEPTH) {
        refs.parseErrors.push(`Include/extends graph exceeds depth ${MAX_INCLUDE_DEPTH} at ${normalized}`);
        return;
    }
    if (content.length > MAX_COMPOSE_PARSE_BYTES) {
        refs.parseErrors.push(`Compose file ${normalized} exceeds the ${MAX_COMPOSE_PARSE_BYTES}-byte parse cap`);
        return;
    }

    let doc: unknown;
    try {
        doc = YAML.parse(content);
    } catch (e) {
        refs.parseErrors.push(`Cannot parse compose file ${normalized}: ${e instanceof Error ? e.message : String(e)}`);
        return;
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return;

    const root = doc as Record<string, unknown>;
    const declaringDir = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : null;

    // Top-level include: list of paths or map {path, env_file}.
    const include = root.include;
    if (include !== undefined) {
        const items = Array.isArray(include) ? include : [include];
        for (const item of items) {
            if (typeof item === 'string') {
                const resolved = resolveRelative(declaringDir, item);
                emitInput(refs, resolved, 'include', 'compose-additional', normalized, 'repo-root');
                const nested = opts.read(resolved);
                if (nested === null) {
                    refs.parseErrors.push(`Included compose file ${resolved} is unreadable`);
                } else {
                    parseFile(resolved, nested, opts, refs, visited, stack, depth + 1);
                }
            } else if (item && typeof item === 'object' && !Array.isArray(item)) {
                const map = item as Record<string, unknown>;
                const p = asString(map.path);
                if (p !== undefined) {
                    const resolved = resolveRelative(declaringDir, p);
                    emitInput(refs, resolved, 'include', 'compose-additional', normalized, 'repo-root');
                    const nested = opts.read(resolved);
                    if (nested === null) {
                        refs.parseErrors.push(`Included compose file ${resolved} is unreadable`);
                    } else {
                        parseFile(resolved, nested, opts, refs, visited, stack, depth + 1);
                    }
                }
                const includeEnv = asString(map.env_file);
                if (includeEnv !== undefined) {
                    // Relative to the project directory per the compose spec.
                    // The path is ALREADY resolved here, so it is emitted as a
                    // repo-root input; the classifier must not re-resolve it.
                    const base = opts.projectRoot ?? declaringDir ?? null;
                    emitInput(refs, base ? resolveRelative(base, includeEnv) : includeEnv, 'include-env', 'env', normalized, 'repo-root');
                }
            }
        }
    }

    // Per-file service walk (keeps declaring-file provenance for relative refs).
    if (root.services && typeof root.services === 'object' && !Array.isArray(root.services)) {
        for (const [serviceName, service] of Object.entries(root.services as Record<string, unknown>)) {
            walkService(serviceName, service, normalized, refs);
            // extends.file recursion after recording the declaration.
            if (service && typeof service === 'object' && !Array.isArray(service)) {
                const ext = (service as Record<string, unknown>).extends;
                if (ext && typeof ext === 'object' && !Array.isArray(ext) && typeof (ext as Record<string, unknown>).file === 'string') {
                    const fileTarget = (ext as Record<string, unknown>).file as string;
                    const resolved = resolveRelative(declaringDir, fileTarget);
                    const nested = opts.read(resolved);
                    if (nested === null) {
                        refs.parseErrors.push(`extends.file target ${resolved} is unreadable`);
                    } else {
                        parseFile(resolved, nested, opts, refs, visited, stack, depth + 1);
                    }
                }
            }
        }
    }

    // Top-level configs / secrets file forms.
    for (const [key, kind, role] of [
        ['configs', 'config', 'config'],
        ['secrets', 'secret', 'secret'],
    ] as const) {
        const resources = root[key];
        if (!resources || typeof resources !== 'object' || Array.isArray(resources)) continue;
        for (const [name, def] of Object.entries(resources as Record<string, unknown>)) {
            const file = resourceFilePath(def);
            if (file !== null) {
                emitInput(refs, file, kind, role, normalized, 'compose-file-dir');
            } else if (def !== null && def !== undefined) {
                // external / env / name-only forms are docker-supplied or
                // unresolvable; record an unmanaged placeholder.
                emitInput(refs, null, kind, role, normalized, 'host');
            }
            void name;
        }
    }
}

export function parseDeclaredInputs(
    orderedContents: Array<{ path: string; content: string }>,
    opts: ParseOptions,
): ParsedDeclaredInputs {
    const refs: ComposeRefs = { inputs: [], dynamic: [], parseErrors: [] };
    const visited = new Set<string>();
    const stack = new Set<string>();
    for (const file of orderedContents) {
        parseFile(file.path, file.content, opts, refs, visited, stack, 0);
    }

    // Interpolation env at the project root (compose loads it for variable
    // substitution). Always declared; classification decides managed vs absent.
    const interpRoot = opts.projectRoot ?? '';
    emitInput(refs, interpRoot ? `${interpRoot}/.env` : '.env', 'interpolation-env', 'env', '<project>', 'project-root');

    return { inputs: refs.inputs, dynamic: refs.dynamic, parseErrors: refs.parseErrors };
}
