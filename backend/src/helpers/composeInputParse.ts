/**
 * Pure Compose input declaration parser for the Git managed-project
 * materializer. Walks compose YAML (explicit files plus recursive include /
 * extends.file graphs) and emits every repository-local input that can affect
 * validation or deployment, WITHOUT touching the filesystem: file contents are
 * injected via the `read` callback so this module stays side-effect free and
 * testable.
 *
 * Every declaration is resolved in TWO coordinate systems:
 * - source: the repository path of the file (what the clone contains), and
 * - materialized: the stack-relative path the file occupies at runtime.
 * They diverge when the runtime layout relocates a file: the primary compose
 * file always lands at the stack root, so its entire include/extends graph
 * (and every project-relative path declared in it) shifts by the primary's
 * repository directory prefix. Merged (-f) files keep their own repository
 * paths, but their include/extends graph resolves against the base file's
 * directory at source and shifts to the stack root at runtime when no context
 * dir is configured; include/extends-reached files keep their own project
 * directory unless a relocation applies.
 *
 * Resolution rules (compose spec / compose-go loader):
 * - `include:`, `extends.file`, and include map-form `env_file` paths resolve
 *   against the current level's EFFECTIVE PROJECT base (the compose-go local
 *   resource loader's WorkingDir is the project directory): the context dir,
 *   or the base file's directory for merged (-f) files at the top level; the
 *   including include-entry's project directory for nested includes.
 * - An included project's interpolation env defaults to `.env` in its project
 *   directory; absence is tolerated.
 * - For a long-form include path LIST, the FIRST resolved path is the
 *   included project's main file and defines its directory; later paths are
 *   overrides of the same project. include map-form `project_directory`
 *   overrides the included project's directory.
 * - service `env_file`, top-level `configs`/`secrets` `file:`, `label_file`
 *   and `build.context` resolve against the effective project directory: the
 *   context dir, or the base file's directory for merged (-f) files; files
 *   reached via include/extends keep their own project directory. An omitted
 *   build context defaults to that project directory.
 * - Absolute (POSIX, Windows drive/UNC, drive-relative, root-relative) and
 *   home-relative (`~`) paths are HOST paths: emitted with baseDir 'host' so
 *   the classifier records them as unmanaged (data inputs) or refuses them
 *   (include/extends), never adopting a same-named repository file.
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

/**
 * Walk context for one compose file: its repository path, its runtime
 * (materialized) path ('' = stack root), and the project bases used to
 * resolve project-relative declarations in both coordinate systems.
 */
interface FileContext {
    repoPath: string;
    runtimePath: string;
    projectBase: string | null;
    runtimeProjectBase: string | null;
}

function isDynamicPath(p: string): boolean {
    return p.includes('$');
}

/** Absolute (POSIX, Windows drive/UNC, drive-relative, root-relative) or home-relative host path. */
export function isHostAbsolutePath(p: string): boolean {
    return p.startsWith('/') || p.startsWith('~') || /^[A-Za-z]:/.test(p) || p.startsWith('\\');
}

export function isUrl(p: string): boolean {
    return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(p);
}

function dirOf(p: string): string | null {
    return p && p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : null;
}

/** Normalize a resolved path; null when it escapes its base (.. / absolute). */
function normalizeWithinBase(candidate: string): string | null {
    // Backslashes are normalized BEFORE collapse so `sub\..\x` (Windows-style
    // separators) collapses and escapes are detected, never emitted raw.
    const normalized = path.posix.normalize(candidate.replace(/\\/g, '/')).replace(/^\.\//, '');
    if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) return null;
    return normalized;
}

/** Resolve a path against a base; null when the result escapes the base. */
function resolveWithinBase(base: string | null, target: string): string | null {
    return normalizeWithinBase(base ? `${base}/${target}` : target);
}

function emitInput(
    refs: ComposeRefs,
    rawPath: string | null,
    sourcePath: string | null,
    materializedPath: string | null,
    kind: InputDependencyKind,
    role: InputRole,
    fromFile: string,
    baseDir: DeclaredInput['baseDir'],
    service: string | null = null,
    required = true,
): void {
    if (rawPath !== null && isDynamicPath(rawPath)) {
        refs.dynamic.push({ sourcePath: rawPath, kind, note: 'Path contains a variable; resolved by Compose at deploy time, not enumerated.' });
        return;
    }
    refs.inputs.push({ sourcePath, materializedPath, baseDir, kind, role, fromFile, service, required });
}

/**
 * Emit a project-relative declaration resolved in both coordinate systems.
 * Host/absolute paths and paths that escape either base are emitted as host
 * inputs (the classifier records them unmanaged or refuses include/extends).
 */
function emitProjectRelative(
    refs: ComposeRefs,
    raw: string,
    kind: InputDependencyKind,
    role: InputRole,
    fromFile: string,
    ctx: FileContext,
    baseDir: DeclaredInput['baseDir'],
    service: string | null = null,
    required = true,
): void {
    if (isHostAbsolutePath(raw)) {
        emitInput(refs, raw, raw, null, kind, role, fromFile, 'host', service, required);
        return;
    }
    const source = resolveWithinBase(ctx.projectBase, raw);
    const materialized = resolveWithinBase(ctx.runtimeProjectBase, raw);
    if (source === null || materialized === null) {
        emitInput(refs, raw, raw, null, kind, role, fromFile, 'host', service, required);
        return;
    }
    emitInput(refs, raw, source, materialized, kind, role, fromFile, baseDir, service, required);
}

function asString(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    return undefined;
}

/** Normalize a string-or-list-of-strings value into its string items. */
function asStringList(value: unknown): string[] {
    if (typeof value === 'string') return [value];
    if (typeof value === 'number') return [String(value)];
    if (Array.isArray(value)) {
        return value.map(asString).filter((p): p is string => p !== undefined);
    }
    return [];
}

/** Normalize an env_file entry (string, list item, or map {path, required}) to its path and optionality. */
function envFilePath(value: unknown): { path: string; required: boolean } | undefined {
    if (typeof value === 'string') return { path: value, required: true };
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const p = (value as Record<string, unknown>).path;
        const path = asString(p);
        if (path === undefined) return undefined;
        const required = (value as Record<string, unknown>).required;
        return { path, required: required !== false };
    }
    return undefined;
}


/** Normalize a configs/secrets entry to a file path, or null for external/env forms. */
function resourceFilePath(value: unknown): string | null {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        if (record.external === true) return null; // docker supplies it; only an explicit true applies
        if ('env' in record || 'environment' in record) return null; // env-injected
        const f = record.file;
        if (f !== undefined) return asString(f) ?? null;
        return null; // plain {} or name-only reference
    }
    return null;
}

function shortFormBindSource(volume: string): string | null {
    // A drive-letter prefix (C:\ or C:) keeps its colon as part of the
    // source; the source/target separator is the NEXT colon. UNC sources
    // (\\server\share) have no colon and split at the separator as usual.
    const separator = /^[A-Za-z]:/.test(volume) ? volume.indexOf(':', 2) : volume.indexOf(':');
    if (separator === -1) return null;
    const src = volume.slice(0, separator);
    // Named volumes have no path separators or leading dot/slash/tilde.
    if (/^[A-Za-z0-9_.-]+$/.test(src) && !src.startsWith('.') && !src.startsWith('~')) return null;
    return src;
}

/** Collect bind-mount host sources from a service volumes list. */
function collectBindMounts(volumes: unknown, fromFile: string, refs: ComposeRefs, ctx: FileContext): void {
    const emitBindSource = (src: string): void => {
        if (isHostAbsolutePath(src)) {
            emitInput(refs, src, null, null, 'bind-mount', 'bind-mount', fromFile, 'host');
        } else {
            emitProjectRelative(refs, src, 'bind-mount', 'bind-mount', fromFile, ctx, 'project-root');
        }
    };
    if (!Array.isArray(volumes)) return;
    for (const entry of volumes) {
        if (typeof entry === 'string') {
            const src = shortFormBindSource(entry);
            if (src !== null) emitBindSource(src);
            continue;
        }
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
            const record = entry as Record<string, unknown>;
            if (record.type === 'bind' && typeof record.source === 'string') {
                emitBindSource(record.source);
            }
        }
    }
}

/** Collect build declarations (context, dockerfile, secrets, additional contexts). */
function collectBuild(build: unknown, fromFile: string, refs: ComposeRefs, ctx: FileContext, service: string | null): void {
    if (typeof build === 'string') {
        emitProjectRelative(refs, build, 'build-context', 'build-context', fromFile, ctx, 'compose-file-dir', service);
        return;
    }
    if (!build || typeof build !== 'object' || Array.isArray(build)) return;
    const record = build as Record<string, unknown>;
    if (typeof record.context === 'string') {
        emitProjectRelative(refs, record.context, 'build-context', 'build-context', fromFile, ctx, 'compose-file-dir', service);
    } else {
        // An omitted context defaults to the declaring file's project
        // directory (compose spec); resolved by emitProjectRelative.
        emitProjectRelative(refs, '.', 'build-context', 'build-context', fromFile, ctx, 'compose-file-dir', service);
    }
    if (typeof record.dockerfile === 'string') {
        if (isHostAbsolutePath(record.dockerfile)) {
            emitInput(refs, record.dockerfile, record.dockerfile, null, 'dockerfile', 'dockerfile', fromFile, 'host', service);
        } else {
            // Dockerfile is relative to the context; the classifier rebases it.
            emitInput(refs, record.dockerfile, record.dockerfile, null, 'dockerfile', 'dockerfile', fromFile, 'compose-file-dir', service);
        }
    }
    if (record.secrets && Array.isArray(record.secrets)) {
        // Long syntax carries only source/target/uid/gid/mode; `source` names
        // a TOP-LEVEL SECRET (compose errors if it is not defined in the
        // top-level secrets section), never a file path. The referenced
        // secret's file, when file-backed, is emitted by the top-level
        // secrets walk; the reference itself is recorded as unmanaged, the
        // same as the string form.
        record.secrets.forEach(() => {
            emitInput(refs, null, null, null, 'build-secret', 'build-secret', fromFile, 'host', service);
        });
    }
    // additional_contexts: mapping (name -> value) or list of NAME=VALUE
    // strings (compose build spec). Path values are project-relative inputs;
    // type:// and service: values are supplied by the image builder at build
    // time and recorded unmanaged.
    let additional: Array<[string, unknown]> = [];
    if (record.additional_contexts && typeof record.additional_contexts === 'object' && !Array.isArray(record.additional_contexts)) {
        additional = Object.entries(record.additional_contexts as Record<string, unknown>);
    } else if (Array.isArray(record.additional_contexts)) {
        for (const item of record.additional_contexts) {
            const text = asString(item);
            if (text !== undefined) {
                const eq = text.indexOf('=');
                if (eq > 0) additional.push([text.slice(0, eq), text.slice(eq + 1)]);
            }
        }
    }
    for (const [, value] of additional) {
        const p = asString(value);
        if (p === undefined) continue;
        if (isUrl(p) || p.startsWith('service:')) {
            emitInput(refs, p, p, null, 'build-additional-context', 'build-additional-context', fromFile, 'host', service);
        } else {
            emitProjectRelative(refs, p, 'build-additional-context', 'build-additional-context', fromFile, ctx, 'compose-file-dir', service);
        }
    }
}

/** Walk one service definition for file-backed inputs. */
function walkService(serviceName: string, service: unknown, fromFile: string, refs: ComposeRefs, ctx: FileContext): void {
    if (!service || typeof service !== 'object' || Array.isArray(service)) return;
    const record = service as Record<string, unknown>;

    // extends.file (map form) is emitted and recursed by parseFileInner, which
    // needs the resolved target for the recursion; the string form extends a
    // sibling service in the same file.

    const envFile = record.env_file;
    if (envFile !== undefined) {
        const entries = Array.isArray(envFile) ? envFile : [envFile];
        for (const entry of entries) {
            const p = envFilePath(entry);
            if (p !== undefined) {
                emitProjectRelative(refs, p.path, 'env_file', 'env', fromFile, ctx, 'compose-file-dir', null, p.required);
            } else {
                refs.parseErrors.push(`env_file entry in ${fromFile} has no resolvable path`);
            }
        }
    }

    for (const labelFile of asStringList(record.label_file)) {
        emitProjectRelative(refs, labelFile, 'label_file', 'label-file', fromFile, ctx, 'compose-file-dir');
    }

    if (record.build !== undefined) collectBuild(record.build, fromFile, refs, ctx, serviceName);
    collectBindMounts(record.volumes, fromFile, refs, ctx);

    // Per-service configs/secrets references are keys into the top-level
    // maps, which the top-level walk emits; nothing to record here.
}

/**
 * Emit a file-relative declaration (include/extends/include-env), returning
 * the resolved source/materialized pair; the caller recurses via
 * readAndRecurse when the target is a repository file.
 */
function emitFileRelative(
    refs: ComposeRefs,
    raw: string,
    kind: InputDependencyKind,
    role: InputRole,
    fromFile: string,
    ctx: FileContext,
    baseDir: DeclaredInput['baseDir'] = 'repo-root',
): { source: string | null; materialized: string | null } {
    if (isHostAbsolutePath(raw)) {
        emitInput(refs, raw, raw, null, kind, role, fromFile, 'host');
        return { source: null, materialized: null };
    }
    if (isUrl(raw)) {
        emitInput(refs, raw, raw.trim(), null, kind, role, fromFile, baseDir);
        return { source: null, materialized: null };
    }
    // Include, include-env, and extends paths resolve against the current
    // level's EFFECTIVE PROJECT base (compose-go: the local resource
    // loader's WorkingDir is the project directory), not the declaring
    // file's own directory.
    const source = resolveWithinBase(ctx.projectBase, raw);
    const materialized = resolveWithinBase(ctx.runtimeProjectBase, raw);
    if (source === null || materialized === null) {
        emitInput(refs, raw, raw, null, kind, role, fromFile, 'host');
        return { source: null, materialized: null };
    }
    emitInput(refs, raw, source, materialized, kind, role, fromFile, baseDir);
    return { source, materialized };
}

/**
 * Parse one compose file into declarations, recursing into include/extends.
 * Cycle detection uses the RECURSION STACK (a file re-entered while still
 * being walked is a real cycle); a file reached again after completion is a
 * shared base (diamond / repeated include) and dedupes silently.
 */
function parseFile(
    ctx: FileContext,
    content: string,
    opts: ParseOptions,
    refs: ComposeRefs,
    visited: Set<string>,
    stack: Set<string>,
    depth: number,
): void {
    const normalized = normalizeRepoPath(ctx.repoPath);
    if (stack.has(normalized)) {
        refs.parseErrors.push(`Include/extends cycle detected at ${normalized}`);
        return;
    }
    if (visited.has(normalized)) {
        return; // shared base file, not a cycle
    }
    stack.add(normalized);
    try {
        parseFileInner(ctx, content, opts, refs, visited, stack, depth);
    } finally {
        stack.delete(normalized);
        visited.add(normalized);
    }
}

function normalizeRepoPath(p: string): string {
    return path.posix.normalize(p.replace(/\\/g, '/')).replace(/^\/+/, '');
}

function parseFileInner(
    ctx: FileContext,
    content: string,
    opts: ParseOptions,
    refs: ComposeRefs,
    visited: Set<string>,
    stack: Set<string>,
    depth: number,
): void {
    const normalized = normalizeRepoPath(ctx.repoPath);
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

    // Top-level include: list of paths or maps {path, env_file, project_directory}.
    const include = root.include;
    if (include !== undefined) {
        const items = Array.isArray(include) ? include : [include];
        for (const item of items) {
            if (typeof item === 'string') {
                processIncludeEntry(refs, [item], undefined, normalized, ctx, opts, visited, stack, depth);
            } else if (item && typeof item === 'object' && !Array.isArray(item)) {
                const map = item as Record<string, unknown>;
                // path accepts a string or a list of strings (merged in order).
                const paths = asStringList(map.path);
                if (paths.length === 0) {
                    refs.parseErrors.push(`Include entry in ${normalized} has no resolvable path`);
                    continue;
                }
                processIncludeEntry(refs, paths, map, normalized, ctx, opts, visited, stack, depth);
            }
        }
    }

    // Per-file service walk (keeps declaring-file provenance for relative refs).
    if (root.services && typeof root.services === 'object' && !Array.isArray(root.services)) {
        for (const [serviceName, service] of Object.entries(root.services as Record<string, unknown>)) {
            walkService(serviceName, service, normalized, refs, ctx);
            // extends.file recursion after recording the declaration.
            if (service && typeof service === 'object' && !Array.isArray(service)) {
                const ext = (service as Record<string, unknown>).extends;
                if (ext && typeof ext === 'object' && !Array.isArray(ext)) {
                    const fileTarget = asString((ext as Record<string, unknown>).file);
                    if (fileTarget !== undefined) {
                        const resolved = emitFileRelative(refs, fileTarget, 'extends', 'compose-additional', normalized, ctx);
                        readAndRecurse(resolved, ctx, opts, refs, visited, stack, depth, 'extends.file target');
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
        for (const def of Object.values(resources as Record<string, unknown>)) {
            const file = resourceFilePath(def);
            if (file !== null) {
                emitProjectRelative(refs, file, kind, role, normalized, ctx, 'compose-file-dir');
            } else if (def !== null && def !== undefined) {
                // external / env / name-only forms are docker-supplied or
                // unresolvable; record an unmanaged placeholder.
                emitInput(refs, null, null, null, kind, role, normalized, 'host');
            }
        }
    }
}

/**
 * Process one include entry (string path, or map with a path list): resolve
 * each path against the current level's project base, derive the included
 * project's bases (project_directory, or the FIRST resolved path's directory
 * per the compose-go "main file" rule), emit the included project's default
 * interpolation .env, and recurse.
 */
function processIncludeEntry(
    refs: ComposeRefs,
    paths: string[],
    map: Record<string, unknown> | undefined,
    fromFile: string,
    ctx: FileContext,
    opts: ParseOptions,
    visited: Set<string>,
    stack: Set<string>,
    depth: number,
): void {
    const resolvedPaths = paths.map((p) => emitFileRelative(refs, p, 'include', 'compose-additional', fromFile, ctx));
    const first = resolvedPaths[0];
    // interpolation: false disables interpolation for the included project,
    // so its default .env is never probed.
    const interpolate = map?.interpolation !== false;
    const projectDir = asString(map?.project_directory);
    let childProjectBase: string | null;
    let childRuntimeProjectBase: string | null;
    if (projectDir !== undefined) {
        childProjectBase = resolveWithinBase(ctx.projectBase, projectDir);
        childRuntimeProjectBase = resolveWithinBase(ctx.runtimeProjectBase, projectDir);
        if (childProjectBase === null || childRuntimeProjectBase === null) {
            refs.parseErrors.push(`Include project_directory ${projectDir} in ${fromFile} escapes its base`);
            return;
        }
    } else if (first !== undefined && first.source !== null && first.materialized !== null) {
        // Without project_directory, the FIRST resolved path is the included
        // project's main file and defines its directory; later paths are
        // overrides of the same project.
        childProjectBase = dirOf(first.source);
        childRuntimeProjectBase = dirOf(first.materialized);
    } else {
        return; // host/URL/escape: emitted, the classifier decides
    }

    // The included project's interpolation env defaults to .env in its
    // project directory (compose include spec); absence is tolerated.
    // interpolation: false disables it (handled above). When the included
    // project's bases equal the parent's (a same-directory include), the
    // entry would duplicate the parent's interpolation env, so it is skipped.
    if (interpolate && !(childProjectBase === ctx.projectBase && childRuntimeProjectBase === ctx.runtimeProjectBase)) {
        emitInput(refs, '.env', resolveWithinBase(childProjectBase, '.env')!, resolveWithinBase(childRuntimeProjectBase, '.env')!, 'interpolation-env', 'env', fromFile, 'repo-root');
    }

    const childOverride = { projectBase: childProjectBase, runtimeProjectBase: childRuntimeProjectBase };
    for (const resolved of resolvedPaths) {
        readAndRecurse(resolved, ctx, opts, refs, visited, stack, depth, 'Included compose file', childOverride);
    }

    // Explicit env_file accepts a string or a list of strings; resolves
    // against the current level's project base (compose-go include env).
    for (const env of asStringList(map?.env_file)) {
        emitFileRelative(refs, env, 'include-env', 'env', fromFile, ctx);
    }
}

/** Read a resolved include/extends target and recurse when it is a repository file. */
function readAndRecurse(
    resolved: { source: string | null; materialized: string | null },
    ctx: FileContext,
    opts: ParseOptions,
    refs: ComposeRefs,
    visited: Set<string>,
    stack: Set<string>,
    depth: number,
    errorLabel: string,
    childOverride?: { projectBase: string | null; runtimeProjectBase: string | null },
): void {
    // Host/URL/escape paths emit with both sides null; the classifier decides.
    if (resolved.source === null || resolved.materialized === null) return;
    const nested = opts.read(resolved.source);
    if (nested === null) {
        refs.parseErrors.push(`${errorLabel} ${resolved.source} is unreadable`);
        return;
    }
    parseFile(
        {
            repoPath: resolved.source,
            runtimePath: resolved.materialized,
            projectBase: childOverride?.projectBase ?? dirOf(resolved.source),
            runtimeProjectBase: childOverride?.runtimeProjectBase ?? dirOf(resolved.materialized),
        },
        nested,
        opts,
        refs,
        visited,
        stack,
        depth + 1,
    );
}

export function parseDeclaredInputs(
    orderedContents: Array<{ path: string; content: string }>,
    opts: ParseOptions,
): ParsedDeclaredInputs {
    const refs: ComposeRefs = { inputs: [], dynamic: [], parseErrors: [] };
    const visited = new Set<string>();
    const stack = new Set<string>();
    // Merged (-f) files share the TOP project's bases: the context dir, or
    // the base (first) file's directory. The primary file lands at the stack
    // root at runtime, so its runtime path is '' while additional files keep
    // their repository paths.
    const orderedProjectBase = opts.projectRoot ?? dirOf(orderedContents[0]?.path ?? '');
    const orderedRuntimeProjectBase = opts.projectRoot ?? null;
    for (const [index, file] of orderedContents.entries()) {
        parseFile(
            {
                repoPath: file.path,
                runtimePath: index === 0 ? '' : file.path,
                projectBase: orderedProjectBase,
                runtimeProjectBase: orderedRuntimeProjectBase,
            },
            file.content,
            opts,
            refs,
            visited,
            stack,
            0,
        );
    }

    // Interpolation env at the project root (compose loads it for variable
    // substitution). Always declared; classification decides managed vs absent.
    const interpRoot = opts.projectRoot ?? '';
    const interpPath = interpRoot ? `${interpRoot}/.env` : '.env';
    emitInput(refs, interpPath, interpPath, interpPath, 'interpolation-env', 'env', '<project>', 'project-root');

    return { inputs: refs.inputs, dynamic: refs.dynamic, parseErrors: refs.parseErrors };
}
