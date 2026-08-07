/**
 * Two-phase Compose input discovery for the Git managed-project materializer.
 *
 * Phase 1 (pure) lives in helpers/composeInputParse.ts; this service runs
 * phase 2 against the cloned tree: resolving every declared input against the
 * authorized repo/project boundary, classifying it managed / unmanaged /
 * refused, planning dockerignore-aware build contexts, and enforcing the
 * materialization bounds. The copy loop (walkAndCopy) is shared with the
 * manifest service's candidate builder so discovery and promotion cannot drift.
 *
 * Refusal policy: actionable refusals (out-of-bounds, url-include, submodule,
 * LFS, unbounded context, missing files, unsafe links) are returned with
 * actionable: true so the caller aborts the pull; tolerated classes (host
 * binds, external resources) become unmanaged entries with a documented-
 * limitation note. Dynamic \${VAR} paths are recorded as explicit unmanaged
 * entries (they resolve at deploy time from the environment) and are never
 * claimed as covered. Never claim coverage for anything else.
 */
import path from 'path';
import fs from 'fs';
import { createHash } from 'crypto';
import { parseDeclaredInputs } from '../helpers/composeInputParse';
import { isPathWithinBase } from '../utils/validation';
import { isLfsPointer } from './GitSourceService';
import { loadDockerIgnore, type DockerIgnoreMatcher } from '../utils/dockerIgnoreMatch';
import { PRIMARY_COMPOSE_FILENAME } from '../utils/gitComposeFiles';
import type {
    BuildContextPlan,
    ComposeInputEntry,
    DeclaredInput,
    DynamicInput,
    InputDependencyKind,
    InputRole,
    InputSensitivity,
    InventoryResult,
    ManifestBounds,
    RefusalInfo,
} from '../types/gitProjectManifest';

// Compose override filenames docker compose can auto-discover, in priority
// order; mirrors FileSystemService.COMPOSE_OVERRIDE_FILENAMES. Only consulted
// when the invocation passes a single explicit -f (explicit multi-file lists
// suppress auto-discovery).
const COMPOSE_OVERRIDE_FILENAMES = [
    'compose.override.yaml',
    'compose.override.yml',
    'docker-compose.override.yaml',
    'docker-compose.override.yml',
];

const LFS_POINTER_PREFIX_LEN = 48;

// Include/extends recursion reads stay under this bound (the clone download
// cap bounds the pack, not the decompressed tree).
const MAX_REPO_READ_BYTES = 10 * 1024 * 1024;

export interface DiscoverFromCloneParams {
    /** Root of the cloned tree (immutable resolved revision). */
    cloneDir: string;
    /** Ordered explicit repo-relative compose paths. */
    composePaths: string[];
    /** Repo-relative project root (context_dir); null = repo root. */
    contextDir: string | null;
    /** True when a synced stack-root .env is deployed (owns that path). */
    syncEnv?: boolean;
    bounds: ManifestBounds;
}

export interface CopyEntry {
    srcRel: string;  // clone-relative source
    destRel: string; // candidate-relative destination
}

export interface ContextCopyPlan {
    context: BuildContextPlan;
    /** Clone-relative path of the context root. */
    srcRel: string;
    /** Candidate-relative destination (same layout as deploy). */
    destRel: string;
    matcher: DockerIgnoreMatcher | null;
    /** Clone-relative path of the dockerignore file applied (for diagnostics). */
    dockerignoreRel: string | null;
}

export interface CopyResult {
    copiedFiles: number;
    copiedBytes: number;
}

function posixRel(p: string): string {
    return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

function caseKey(s: string): string {
    return s.toLowerCase();
}

function isUrl(p: string): boolean {
    return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(p);
}

/** Map a dynamic declaration's dependency kind to its manifest role. */
function roleForDynamicKind(kind: DynamicInput['kind']): InputRole {
    switch (kind) {
        case 'env_file':
        case 'include-env':
        case 'interpolation-env':
            return 'env';
        case 'config':
            return 'config';
        case 'secret':
            return 'secret';
        case 'build-context':
            return 'build-context';
        case 'build-additional-context':
            return 'build-additional-context';
        case 'dockerfile':
            return 'dockerfile';
        case 'build-secret':
            return 'build-secret';
        case 'label_file':
            return 'label-file';
        case 'bind-mount':
            return 'bind-mount';
        case 'include':
        case 'extends':
            return 'compose-additional';
        default:
            return 'other';
    }
}

function hasGitMetaSegment(relPath: string): boolean {
    return posixRel(relPath)
        .split('/')
        .filter(Boolean)
        .some((seg) => seg.toLowerCase() === '.git');
}

/** The submodule whose directory contains the path, or undefined. */
function submoduleOwner(relPath: string, submodules: string[]): string | undefined {
    return submodules.find((s) => relPath === s || relPath.startsWith(`${s}/`));
}

function fileDir(p: string | null): string | null {
    return p && p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : null;
}

/** Kinds whose declared paths must be treated as sensitive. */
function isSensitiveKind(kind: InputDependencyKind): boolean {
    return kind === 'config' || kind === 'secret' || kind === 'env_file' || kind === 'include-env'
        || kind === 'interpolation-env' || kind === 'label_file' || kind === 'build-secret';
}

function resolveInRepo(relPath: string, base: string | null): string | null {
    const candidate = base ? `${posixRel(base)}/${posixRel(relPath)}` : posixRel(relPath);
    const normalized = path.posix.normalize(candidate).replace(/^\.\//, '');
    if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) return null;
    return normalized;
}

async function readSubmodulePaths(cloneDir: string): Promise<string[]> {
    const gitmodules = path.join(cloneDir, '.gitmodules');
    try {
        const raw = await fs.promises.readFile(gitmodules, 'utf8');
        const paths: string[] = [];
        for (const line of raw.split(/\r?\n/)) {
            const m = /^\s*path\s*=\s*(.+)$/.exec(line);
            if (m) paths.push(posixRel(m[1].trim()));
        }
        return paths;
    } catch {
        return [];
    }
}

export class ComposeInputDiscoveryService {
    private constructor() {
        // Stateless service; instantiate via getInstance().
    }

    private static instance: ComposeInputDiscoveryService | null = null;

    static getInstance(): ComposeInputDiscoveryService {
        if (!this.instance) this.instance = new ComposeInputDiscoveryService();
        return this.instance;
    }

    private refusal(sourcePath: string | null, kind: string, reason: string, actionable: boolean): RefusalInfo {
        return { sourcePath, kind, reason, actionable };
    }

    /**
     * Classify one resolved clone-relative path. Returns the refusal on
     * failure; callers record actionable refusals.
     */
    private async classifyPath(
        cloneDir: string,
        relPath: string,
        bounds: ManifestBounds,
    ): Promise<{ ok: true; sizeBytes: number; contentSha256: string } | { ok: false; refusal: RefusalInfo }> {
        const abs = path.resolve(cloneDir, relPath);
        if (!isPathWithinBase(abs, path.resolve(cloneDir))) {
            return { ok: false, refusal: this.refusal(relPath, 'out-of-bounds', `${relPath} resolves outside the repository`, true) };
        }
        if (hasGitMetaSegment(relPath)) {
            return { ok: false, refusal: this.refusal(relPath, 'git-meta', `${relPath} targets the .git metadata directory`, true) };
        }
        const depth = relPath.split('/').filter(Boolean).length;
        if (depth > bounds.maxPathDepth) {
            return { ok: false, refusal: this.refusal(relPath, 'path-too-deep', `${relPath} exceeds the path depth limit of ${bounds.maxPathDepth}`, true) };
        }

        let stat: fs.Stats;
        try {
            stat = await fs.promises.lstat(abs);
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
                return { ok: false, refusal: this.refusal(relPath, 'missing-file', `File not found in repository: ${relPath}`, true) };
            }
            return { ok: false, refusal: this.refusal(relPath, 'unreadable', `Cannot stat ${relPath}: ${(e as Error).message}`, true) };
        }
        if (stat.isSymbolicLink()) {
            return { ok: false, refusal: this.refusal(relPath, 'unsafe-symlink', `${relPath} is a symbolic link`, true) };
        }
        if (stat.isDirectory()) {
            return { ok: false, refusal: this.refusal(relPath, 'not-a-file', `${relPath} is a directory; a file is required`, true) };
        }
        if (stat.isCharacterDevice() || stat.isBlockDevice() || stat.isSocket() || stat.isFIFO()) {
            return { ok: false, refusal: this.refusal(relPath, 'special-file', `${relPath} is a device, socket or pipe`, true) };
        }
        if (stat.size > bounds.maxFileBytes) {
            return { ok: false, refusal: this.refusal(relPath, 'file-too-large', `${relPath} is too large (${stat.size} bytes; maximum ${bounds.maxFileBytes})`, true) };
        }
        let content: Buffer;
        try {
            content = await fs.promises.readFile(abs);
        } catch (e) {
            return { ok: false, refusal: this.refusal(relPath, 'unreadable', `Cannot read ${relPath}: ${(e as Error).message}`, true) };
        }
        if (isLfsPointer(content.toString('utf8', 0, LFS_POINTER_PREFIX_LEN + 64))) {
            return { ok: false, refusal: this.refusal(relPath, 'lfs-pointer', `${relPath} is a Git LFS pointer; LFS content is not fetched`, true) };
        }
        return { ok: true, sizeBytes: stat.size, contentSha256: createHash('sha256').update(content).digest('hex') };
    }

    /**
     * Resolve a declared input's repo-relative source path AND its materialized
     * path, deriving both from the effective invocation:
     *
     * - Project-relative declarations (env_file, configs/secrets file, build
     *   contexts, bind mounts) resolve against the project directory: the
     *   configured context dir, or for explicitly listed (-f) files the BASE
     *   FILE's directory (the first compose file), per the compose merge rules.
     *   Files reached via include/extends keep their own directory as their
     *   project directory.
     * - The materialized path uses the RUNTIME base (stack root or context
     *   dir): the primary compose file lands at the stack root, so a base file
     *   in a repo subdirectory has its relative paths live at the stack root,
     *   not under its repo directory. Include/extends files materialize at
     *   their repo paths, so their materialized path equals the source path.
     */
    private resolveDeclared(
        input: DeclaredInput,
        orderedPaths: string[],
        contextDir: string | null,
    ): { source: string; materialized: string } | null {
        if (input.baseDir === 'repo-root') {
            const p = input.sourcePath && !isUrl(input.sourcePath) && !hasGitMetaSegment(input.sourcePath)
                ? input.sourcePath
                : null;
            return p === null ? null : { source: p, materialized: p };
        }
        const fromFile = input.fromFile;
        const isOrdered = fromFile !== null && orderedPaths.some((p) => caseKey(p) === caseKey(fromFile));
        // The context dir applies to the top-level invocation only; compose
        // loads each included file with ITS OWN directory as its project
        // directory even when --project-directory is set.
        const sourceBase = isOrdered ? (contextDir ?? fileDir(orderedPaths[0] ?? null)) : fileDir(fromFile);
        const rel = input.sourcePath ?? '';
        const source = resolveInRepo(rel, sourceBase);
        if (source === null) return null;
        // The materialized path diverges only when a base file in a repo
        // subdirectory (no context dir) moves to the stack root at runtime.
        const materialized = isOrdered && contextDir === null ? resolveInRepo(rel, null) : source;
        if (materialized === null) return null;
        return { source, materialized };
    }

    /** Plan build contexts with dockerignore semantics and byte accounting. */
    private async planBuildContexts(
        params: DiscoverFromCloneParams,
        submodules: string[],
        contextInputs: DeclaredInput[],
        dockerfileInputs: DeclaredInput[],
        refusals: RefusalInfo[],
    ): Promise<{ plans: ContextCopyPlan[]; entries: ComposeInputEntry[] }> {
        const { cloneDir, composePaths, contextDir, bounds, syncEnv } = params;
        const plans: ContextCopyPlan[] = [];
        const entries: ComposeInputEntry[] = [];

        for (const input of contextInputs) {
            const resolved = this.resolveDeclared(input, composePaths, contextDir);
            if (resolved === null) {
                refusals.push(this.refusal(input.sourcePath, 'out-of-bounds', `Build context ${input.sourcePath ?? '(unnamed)'} is not inside the repository`, true));
                continue;
            }
            // A repo-root context (`build: .`) is canonicalized to the empty
            // relative path: materializedPath '' is valid per the manifest
            // path rules, promotes the candidate root, and never collides
            // with '.'-rejection in manifest validation.
            const sourceRoot = resolved.source === '.' || resolved.source === '' ? '' : resolved.source;
            const materializedRoot = resolved.materialized === '.' || resolved.materialized === '' ? '' : resolved.materialized;

            const abs = path.resolve(cloneDir, sourceRoot);
            let stat: fs.Stats;
            try {
                stat = await fs.promises.lstat(abs);
            } catch {
                refusals.push(this.refusal(sourceRoot, 'missing-file', `Build context ${sourceRoot} does not exist in the repository`, true));
                continue;
            }
            if (stat.isSymbolicLink()) {
                refusals.push(this.refusal(sourceRoot, 'unsafe-symlink', `Build context ${sourceRoot} is a symbolic link`, true));
                continue;
            }
            if (!stat.isDirectory()) {
                refusals.push(this.refusal(sourceRoot, 'not-a-directory', `Build context ${sourceRoot} is not a directory`, true));
                continue;
            }

            // An explicit dockerfile resolves RELATIVE TO THE BUILD CONTEXT
            // (docker compose build spec); the parser emits it with
            // compose-file-dir provenance, so it is rebased here against the
            // context root and validated for containment.
            const dockerfileDecl = dockerfileInputs.find(
                (i) =>
                    i.kind === 'dockerfile' &&
                    i.fromFile === input.fromFile &&
                    i.service === input.service,
            );
            let dockerfileRel: string | null = null;
            let dockerfileOutsideContext = false;
            // Additional contexts are not the primary build context and never
            // inherit the service's dockerfile.
            const isPrimaryContext = input.kind === 'build-context';
            if (isPrimaryContext && dockerfileDecl && typeof dockerfileDecl.sourcePath === 'string') {
                const rebased = path.posix.normalize(path.posix.join(sourceRoot, dockerfileDecl.sourcePath));
                if (rebased === '..' || rebased.startsWith('../') || path.posix.isAbsolute(rebased)) {
                    refusals.push(this.refusal(dockerfileDecl.sourcePath, 'out-of-bounds', `Dockerfile ${dockerfileDecl.sourcePath} resolves outside the repository`, true));
                    continue;
                }
                dockerfileRel = rebased;
                // Compose resolves the dockerfile relative to the context. A
                // `../` form that stays inside the repository is allowed: the
                // dockerfile lands outside the context subtree, so it is
                // materialized as its own managed input below. Root contexts
                // (`''` or `'.'`) contain every repo-relative path.
                const inContext = sourceRoot === ''
                    ? !dockerfileRel.startsWith('../')
                    : dockerfileRel === sourceRoot || dockerfileRel.startsWith(`${sourceRoot}/`);
                dockerfileOutsideContext = !inContext;
            }
            // Docker's ignore selection: the context-root .dockerignore applies
            // by default; a Dockerfile-specific ignore file named
            // `<DockerfileName>.dockerignore` next to the dockerfile takes
            // precedence when present.
            let matcher = await loadDockerIgnore(abs);
            let dockerignoreRel = matcher !== null ? path.relative(cloneDir, path.join(abs, '.dockerignore')).replace(/\\/g, '/') : null;
            if (dockerfileRel !== null && !dockerfileOutsideContext) {
                const dfBase = dockerfileRel.split('/').pop() ?? '';
                const dfRelDir = dockerfileRel.includes('/') ? dockerfileRel.slice(0, dockerfileRel.lastIndexOf('/')) : '';
                const specificAbs = path.join(cloneDir, dfRelDir);
                const specificFile = path.join(specificAbs, `${dfBase}.dockerignore`);
                const specificExists = await fs.promises.access(specificFile).then(() => true).catch(() => false);
                if (specificExists) {
                    const specificMatcher = await loadDockerIgnore(specificAbs, `${dfBase}.dockerignore`);
                    if (specificMatcher !== null) {
                        matcher = specificMatcher;
                        dockerignoreRel = path.relative(cloneDir, specificFile).replace(/\\/g, '/');
                    }
                }
            }
            // Submodule containment (mirrors the ordinary-input check below):
            // a context rooted inside a submodule, or a submodule directory
            // inside the context, omits content the author's build would
            // include (submodule contents are never fetched). Refuse rather
            // than materialize a context that silently lacks it. A submodule
            // excluded by the context's dockerignore is excluded by the
            // author's build too, so it is not a refusal.
            const owner = submoduleOwner(sourceRoot, submodules);
            if (owner !== undefined) {
                refusals.push(this.refusal(sourceRoot, 'submodule', `Build context ${sourceRoot} is inside Git submodule ${owner}; submodule contents are not fetched`, true));
                continue;
            }
            const submoduleInContext = submodules.find((s) => {
                if (s === sourceRoot) return false;
                const rel = sourceRoot ? (s.startsWith(`${sourceRoot}/`) ? s.slice(sourceRoot.length + 1) : null) : s;
                if (rel === null) return false;
                // The walk prunes a directory subtree when any ancestor (or
                // the directory itself) matches; mirror that for the submodule
                // path so an ignored submodule is not a refusal.
                let prefix = '';
                for (const seg of rel.split('/')) {
                    prefix = prefix ? `${prefix}/${seg}` : seg;
                    if (matcher?.matches(prefix, true) ?? false) return false;
                }
                return true;
            });
            if (submoduleInContext !== undefined) {
                refusals.push(this.refusal(sourceRoot, 'submodule', `Build context ${sourceRoot} contains Git submodule ${submoduleInContext}; submodule contents are not fetched`, true));
                continue;
            }

            if (dockerfileOutsideContext) {
                // Materialize the out-of-context dockerfile as its own managed
                // input (it is outside the context subtree the walk copies),
                // classified with the same lstat/symlink/containment/size/LFS
                // guards as every other repository input. Its materialized
                // path follows the same runtime base as the context itself
                // (compose resolves the dockerfile relative to the context at
                // its materialized location).
                const dfMaterialized = path.posix.normalize(path.posix.join(materializedRoot, dockerfileDecl!.sourcePath!));
                if (dfMaterialized === '..' || dfMaterialized.startsWith('../') || path.posix.isAbsolute(dfMaterialized)) {
                    refusals.push(this.refusal(dockerfileRel, 'out-of-bounds', `Dockerfile ${dockerfileRel} cannot be reproduced in the stack layout`, true));
                    continue;
                }
                const dfClassified = await this.classifyPath(cloneDir, dockerfileRel!, bounds);
                if (!dfClassified.ok) {
                    refusals.push(dfClassified.refusal);
                    continue;
                }
                entries.push({
                    sourcePath: dockerfileRel,
                    materializedPath: dfMaterialized,
                    role: 'dockerfile',
                    dependencyKind: 'dockerfile',
                    ownership: 'managed',
                    provenance: 'fetch',
                    sensitivity: 'medium',
                    contentSha256: dfClassified.contentSha256,
                    sizeBytes: dfClassified.sizeBytes,
                    state: 'present',
                    deletionAuthority: 'sencho',
                    note: 'Dockerfile outside the build context; materialized at its stack-relative path',
                });
            }

            // Walk the context subtree: filtered bytes, ignored count, LFS and
            // special-file detection, and the per-file hash inventory that
            // gives the context file-granular ownership.
            let contextBytes = 0;
            let ignoredCount = 0;
            let lfsInContext = false;
            let specialInContext: string | null = null;
            const contextFiles: Array<{ path: string; sha256: string; sizeBytes: number }> = [];
            const walk = async (dir: string, rel: string): Promise<void> => {
                let entriesList: fs.Dirent[];
                try {
                    entriesList = await fs.promises.readdir(dir, { withFileTypes: true });
                } catch (e) {
                    specialInContext = `Cannot read ${rel}: ${(e as Error).message}`;
                    return;
                }
                for (const entry of entriesList) {
                    // Never counted or copied: `.git` is excluded from the
                    // materialized context by the copier, and counting it here
                    // would trip the size caps on repo-root contexts.
                    if (entry.name.toLowerCase() === '.git') continue;
                    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
                    if (materializedRoot === '' && childRel === '.env' && syncEnv) {
                        // The synced stack-root .env owns this path; the repo
                        // copy must not be hash-guarded against it.
                        continue;
                    }
                    if (matcher?.matches(childRel, entry.isDirectory())) {
                        ignoredCount += 1;
                        continue;
                    }
                    if (entry.isSymbolicLink()) {
                        specialInContext = `${childRel} is a symbolic link inside the build context`;
                        return;
                    }
                    if (entry.isDirectory()) {
                        await walk(path.join(dir, entry.name), childRel);
                        if (specialInContext) return;
                        continue;
                    }
                    if (entry.isCharacterDevice() || entry.isBlockDevice() || entry.isSocket() || entry.isFIFO()) {
                        specialInContext = `${childRel} is a device, socket or pipe inside the build context`;
                        return;
                    }
                    const st = await fs.promises.stat(path.join(dir, entry.name));
                    if (st.size > bounds.maxFileBytes) {
                        specialInContext = `${childRel} is too large for the build context (${st.size} bytes)`;
                        return;
                    }
                    contextBytes += st.size;
                    const content = await fs.promises.readFile(path.join(dir, entry.name));
                    contextFiles.push({ path: childRel, sha256: createHash('sha256').update(content).digest('hex'), sizeBytes: st.size });
                    if (!lfsInContext) {
                        const handle = await fs.promises.open(path.join(dir, entry.name), 'r');
                        try {
                            const buf = Buffer.alloc(LFS_POINTER_PREFIX_LEN + 64);
                            const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
                            if (isLfsPointer(buf.toString('utf8', 0, bytesRead))) lfsInContext = true;
                        } finally {
                            await handle.close();
                        }
                    }
                }
            };
            await walk(abs, '');

            const isRepoRoot = sourceRoot === '';
            const excluded = false;
            let note: string | null = null;
            if (specialInContext !== null) {
                refusals.push(this.refusal(sourceRoot, 'unsafe-context', specialInContext, true));
                continue;
            }
            if (lfsInContext) {
                refusals.push(this.refusal(sourceRoot, 'lfs-in-context', `Build context ${sourceRoot} contains Git LFS pointers`, true));
                continue;
            }
            if (isRepoRoot) {
                note = `Context is the repository root; bounded by GITSOURCE_MAX_BUILD_CONTEXT_BYTES (${bounds.maxContextBytes} bytes)`;
            }

            const plan: BuildContextPlan = {
                repoPath: materializedRoot,
                dockerfile: dockerfileRel,
                contextBytes,
                ignoredCount,
                dockerignoreApplied: matcher !== null,
                excludedFromCopy: excluded,
                note,
                files: contextFiles,
            };
            plans.push({
                context: plan,
                srcRel: sourceRoot,
                destRel: materializedRoot,
                matcher,
                dockerignoreRel,
            });
            // Contexts are tracked in buildContexts with per-file inventories;
            // a materializedPath entry in the input list is only emitted for
            // non-root contexts (a directory on disk). The root context (empty
            // path) must never become a stack-relative path for promotion or
            // stale cleanup to write/delete.
            if (materializedRoot !== '') {
                entries.push({
                    sourcePath: sourceRoot,
                    materializedPath: materializedRoot,
                    role: 'build-context',
                    dependencyKind: 'build-context',
                    ownership: 'managed',
                    provenance: 'fetch',
                    sensitivity: 'low',
                    contentSha256: null,
                    sizeBytes: contextBytes,
                    state: 'present',
                    deletionAuthority: 'sencho',
                    note,
                });
            }
        }
        // Merge context plans sharing the same root: multiple services in
        // one compose file referencing the same context with different
        // Dockerfiles produce one plan with the union of all file inventories
        // so no service loses required files.
        const mergedPlans: ContextCopyPlan[] = [];
        for (const plan of plans) {
            const existing = mergedPlans.find((mp) => caseKey(mp.context.repoPath) === caseKey(plan.context.repoPath));
            if (existing) {
                for (const f of plan.context.files) {
                    if (!existing.context.files.some((ef) => caseKey(ef.path) === caseKey(f.path))) {
                        existing.context.files.push(f);
                        existing.context.contextBytes += f.sizeBytes;
                    }
                }
            } else {
                mergedPlans.push(plan);
            }
        }
        return { plans: mergedPlans, entries };
    }

    /**
     * Run full discovery against the clone. Returns the classified inventory
     * plus the copy plans (dockerignore matchers) the candidate builder needs;
     * actionable refusals are included and the caller decides abort vs
     * tolerate.
     */
    async discoverFromClone(
        params: DiscoverFromCloneParams,
    ): Promise<InventoryResult & { contextCopyPlans: ContextCopyPlan[] }> {
        const { cloneDir, composePaths, contextDir, bounds } = params;
        const projectRoot = contextDir ?? null;
        const refusals: RefusalInfo[] = [];
        const dynamic: DynamicInput[] = [];
        const submodules = await readSubmodulePaths(cloneDir);

        // Read the ordered explicit compose files (non-throwing).
        const ordered: Array<{ path: string; content: string }> = [];
        for (const p of composePaths) {
            const result = await this.classifyPath(cloneDir, p, bounds);
            if (!result.ok) {
                refusals.push(result.refusal);
                continue;
            }
            try {
                ordered.push({ path: p, content: await fs.promises.readFile(path.join(cloneDir, p), 'utf8') });
            } catch (e) {
                refusals.push(this.refusal(p, 'unreadable', `Cannot read ${p}: ${(e as Error).message}`, true));
            }
        }
        if (ordered.length === 0) {
            return { inputs: [], refusals, buildContexts: [], contextCopyPlans: [], dynamic, counts: { managed: 0, unmanaged: 0, refused: refusals.length } };
        }

        // Implicit override: only when the runtime invocation stays plain
        // `docker compose` auto-discovery. A single explicit -f with no project
        // directory keeps auto-discovery (deriveAppliedSpec returns null), but
        // a configured project directory forces explicit -f arguments, which
        // suppress auto-discovery (compose merge docs: explicit -f disables it).
        let implicitOverridePath: string | null = null;
        if (composePaths.length === 1 && !contextDir) {
            const overrideBase = projectRoot ?? '';
            for (const candidate of COMPOSE_OVERRIDE_FILENAMES) {
                const rel = overrideBase ? `${overrideBase}/${candidate}` : candidate;
                const result = await this.classifyPath(cloneDir, rel, bounds);
                if (result.ok) {
                    implicitOverridePath = rel;
                    ordered.push({ path: rel, content: await fs.promises.readFile(path.join(cloneDir, rel), 'utf8') });
                    break;
                }
            }
        }

        const parsed = parseDeclaredInputs(ordered, {
            projectRoot,
            read: (repoPath) => {
                // Containment + size bound at the read boundary: include/extends
                // targets can carry `..` segments, and an attacker-controlled
                // repo must never make the parser read outside the clone or pull
                // an unbounded file into memory.
                if (hasGitMetaSegment(repoPath)) return null;
                const abs = path.resolve(cloneDir, repoPath);
                if (!isPathWithinBase(abs, path.resolve(cloneDir))) return null;
                try {
                    const st = fs.statSync(abs);
                    if (!st.isFile() || st.size > MAX_REPO_READ_BYTES) return null;
                    return fs.readFileSync(abs, 'utf8');
                } catch {
                    return null;
                }
            },
        });
        for (const err of parsed.parseErrors) refusals.push(this.refusal(null, 'parse-error', err, true));
        dynamic.push(...parsed.dynamic);

        // Track running aggregate counts against the bounds (explicit compose
        // files and the implicit override count toward the caps too).
        let managedCount = 0;
        let managedBytes = 0;
        const inputs: ComposeInputEntry[] = [];

        // Explicit compose files (ordered). The content is already in memory,
        // so the content hash is computed here: the apply-time divergence guard
        // needs a sha for every managed present file, compose.yaml included, or
        // a hand-edited compose file would be silently overwritten.
        composePaths.forEach((p, index) => {
            const local = index === 0 ? PRIMARY_COMPOSE_FILENAME : posixRel(p);
            const role: InputRole = index === 0 ? 'compose-primary' : 'compose-additional';
            const content = ordered.find((o) => o.path === p)?.content ?? null;
            inputs.push({
                sourcePath: p,
                materializedPath: local,
                role,
                dependencyKind: 'explicit',
                ownership: 'managed',
                provenance: 'fetch',
                sensitivity: 'medium',
                contentSha256: content !== null ? createHash('sha256').update(content).digest('hex') : null,
                sizeBytes: content !== null ? Buffer.byteLength(content, 'utf8') : 0,
                state: 'present',
                deletionAuthority: 'sencho',
                note: null,
            });
            managedCount += 1;
            managedBytes += content !== null ? Buffer.byteLength(content, 'utf8') : 0;
        });
        if (implicitOverridePath) {
            const content = ordered.find((o) => o.path === implicitOverridePath)?.content ?? '';
            inputs.push({
                sourcePath: implicitOverridePath,
                materializedPath: posixRel(implicitOverridePath),
                role: 'compose-override',
                dependencyKind: 'implicit-override',
                ownership: 'managed',
                provenance: 'fetch',
                sensitivity: 'medium',
                contentSha256: createHash('sha256').update(content).digest('hex'),
                sizeBytes: Buffer.byteLength(content, 'utf8'),
                state: 'present',
                deletionAuthority: 'sencho',
                note: 'Implicit compose override auto-discovered for single-file stacks',
            });
            managedCount += 1;
            managedBytes += Buffer.byteLength(content, 'utf8');
        }

        // Classify the parser's declarations.
        for (const input of parsed.inputs) {
            const kind = input.kind;
            // Non-path or host forms: unmanaged, never copied, never deleted.
            if (input.sourcePath === null || input.baseDir === 'host') {
                inputs.push({
                    sourcePath: null,
                    materializedPath: null,
                    role: input.role,
                    dependencyKind: kind,
                    ownership: 'unmanaged',
                    provenance: 'fetch',
                    sensitivity: isSensitiveKind(kind) ? 'high' : 'low',
                    contentSha256: null,
                    sizeBytes: null,
                    state: 'present',
                    deletionAuthority: 'none',
                    note: input.baseDir === 'host'
                        ? kind === 'bind-mount'
                            ? 'Host bind mount; provided by the node, not materialized from the repository'
                            : 'External resource supplied by Docker or the node; not materialized from the repository'
                        : 'Declared without a resolvable file path',
                });
                continue;
            }
            if (isUrl(input.sourcePath)) {
                refusals.push(this.refusal(input.sourcePath, 'url-include', `${input.sourcePath} is a URL; remote includes are not fetched`, true));
                continue;
            }

            // Build contexts and their dockerfiles are planned separately
            // below (the dockerfile is rebased against its context there).
            if (kind === 'build-context' || kind === 'build-additional-context' || kind === 'dockerfile') continue;

            const resolved = this.resolveDeclared(input, composePaths, contextDir);
            if (resolved === null) {
                refusals.push(this.refusal(input.sourcePath, 'out-of-bounds', `${input.sourcePath} is outside the repository or project root`, true));
                continue;
            }

            // Submodule containment check.
            const inSubmodule = submoduleOwner(resolved.source, submodules) ?? null;
            if (inSubmodule !== null) {
                refusals.push(this.refusal(resolved.source, 'submodule', `${resolved.source} is inside Git submodule ${inSubmodule}; submodule contents are not fetched`, true));
                continue;
            }

            // When the synced stack-root .env owns the same path (no project
            // dir), the interpolation env must NOT be hash-guarded: the apply
            // stages the sync content over it, so a managed entry would record
            // the repo hash and the next apply would refuse .env as locally
            // modified forever. Record it unmanaged in that case.
            if (kind === 'interpolation-env' && params.syncEnv === true && resolved.source === '.env') {
                inputs.push({
                    sourcePath: resolved.source,
                    materializedPath: null,
                    role: 'env',
                    dependencyKind: 'interpolation-env',
                    ownership: 'unmanaged',
                    provenance: 'fetch',
                    sensitivity: 'high',
                    contentSha256: null,
                    sizeBytes: null,
                    state: 'present',
                    deletionAuthority: 'none',
                    note: 'Owned by the synced stack-root .env; not hash-guarded by the repository copy',
                });
                continue;
            }

            // A missing interpolation .env is not a refusal: compose tolerates an
            // absent project env (variables resolve from the environment), and the
            // synced stack-root .env covers the common case. Record it unmanaged.
            if (kind === 'interpolation-env' && !fs.existsSync(path.join(cloneDir, resolved.source))) {
                inputs.push({
                    sourcePath: resolved.source,
                    materializedPath: null,
                    role: 'env',
                    dependencyKind: 'interpolation-env',
                    ownership: 'unmanaged',
                    provenance: 'fetch',
                    sensitivity: 'high',
                    contentSha256: null,
                    sizeBytes: null,
                    state: 'present',
                    deletionAuthority: 'none',
                    note: 'No project .env in the repository; interpolation falls back to the environment at deploy time',
                });
                continue;
            }

            const classified = await this.classifyPath(cloneDir, resolved.source, bounds);
            if (!classified.ok) {
                refusals.push(classified.refusal);
                continue;
            }
            if (managedCount + 1 > bounds.maxFiles) {
                refusals.push(this.refusal(resolved.source, 'too-many-files', `Materialization would exceed ${bounds.maxFiles} files`, true));
                continue;
            }
            if (managedBytes + classified.sizeBytes > bounds.maxBytes) {
                refusals.push(this.refusal(resolved.source, 'too-many-bytes', `Materialization would exceed ${bounds.maxBytes} bytes (${managedBytes} so far)`, true));
                continue;
            }
            managedCount += 1;
            managedBytes += classified.sizeBytes;
            const sensitivity: InputSensitivity = isSensitiveKind(kind) ? 'high' : 'medium';
            inputs.push({
                sourcePath: resolved.source,
                materializedPath: resolved.materialized,
                role: input.role,
                dependencyKind: kind,
                ownership: 'managed',
                provenance: 'fetch',
                sensitivity,
                contentSha256: classified.contentSha256,
                sizeBytes: classified.sizeBytes,
                state: 'present',
                deletionAuthority: 'sencho',
                note: null,
            });
        }

        // Dynamic ${VAR} paths resolve at deploy time from the environment and
        // can never be enumerated against the clone. Persist each as an
        // explicit unmanaged entry so the manifest inventory never silently
        // drops a declared input (create and pull both consume this inventory).
        for (const dyn of dynamic) {
            inputs.push({
                sourcePath: dyn.sourcePath,
                materializedPath: null,
                role: roleForDynamicKind(dyn.kind),
                dependencyKind: dyn.kind,
                ownership: 'unmanaged',
                provenance: 'fetch',
                sensitivity: isSensitiveKind(dyn.kind) ? 'high' : 'medium',
                contentSha256: null,
                sizeBytes: null,
                state: 'present',
                deletionAuthority: 'none',
                note: dyn.note,
            });
        }

        // Build contexts.
        const contextInputs = parsed.inputs.filter((i) => i.kind === 'build-context' || i.kind === 'build-additional-context');
        const dockerfileInputs = parsed.inputs.filter((i) => i.kind === 'dockerfile');
        const { plans, entries: contextEntries } = await this.planBuildContexts(params, submodules, contextInputs, dockerfileInputs, refusals);
        inputs.push(...contextEntries);

        // Sync env entry (stack-root .env) is recorded by the caller (it knows
        // sync_env + env_path); interpolation-env classification is covered above.

        // Root contexts share the stack root with managed inputs (compose.yaml,
        // .env, configs). Remove context files that already have a managed-input
        // owner so the manifest collision check and candidate copy never dupe.
        const managedPaths = new Set(inputs.filter((i) => i.materializedPath !== null).map((i) => caseKey(i.materializedPath!)));
        const reconciledBuildContexts = plans.map((p) => {
            const files = p.context.files.filter((f) => {
                    const key = caseKey(p.context.repoPath ? `${p.context.repoPath}/${f.path}` : f.path);
                    return !managedPaths.has(key);
                });
            return {
                ...p,
                context: {
                    ...p.context,
                    files,
                    contextBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
                },
            };
        });
        for (const plan of reconciledBuildContexts) {
            if (plan.context.contextBytes > bounds.maxContextBytes) {
                refusals.push(
                    this.refusal(
                        plan.context.repoPath || '.',
                        'context-unbounded',
                        `Merged build context ${plan.context.repoPath || '.'} is ${plan.context.contextBytes} bytes after ownership reconciliation; the maximum is ${bounds.maxContextBytes}`,
                        true,
                    ),
                );
            }
        }

        // Deduplicate managed inputs by stack-relative path: two services
        // referencing the same file (shared env_file, config, or Dockerfile)
        // produce one entry so the candidate writer never rejects a duplicate.
        const dedupedInputs: ComposeInputEntry[] = [];
        const seenPaths = new Set<string>();
        for (const entry of inputs) {
            if (entry.materializedPath !== null) {
                const key = caseKey(entry.materializedPath);
                if (seenPaths.has(key)) continue;
                seenPaths.add(key);
            }
            dedupedInputs.push(entry);
        }

        return {
            inputs: dedupedInputs,
            refusals,
            buildContexts: reconciledBuildContexts.map((p) => p.context),
            contextCopyPlans: reconciledBuildContexts,
            dynamic,
            counts: {
                managed: dedupedInputs.filter((i) => i.ownership === 'managed').length,
                unmanaged: dedupedInputs.filter((i) => i.ownership === 'unmanaged').length,
                refused: refusals.length,
            },
        };
    }

    /**
     * Copy the materialized project into the candidate dir: managed files at
     * their stack-relative paths plus dockerignore-filtered build contexts.
     * Enforces aggregate bounds mid-copy and throws with running counts on
     * violation (callers convert to a refusal). Never copies `.git`.
     */
    async walkAndCopy(
        cloneDir: string,
        destDir: string,
        files: CopyEntry[],
        contexts: ContextCopyPlan[],
        bounds: ManifestBounds,
    ): Promise<CopyResult> {
        let copiedFiles = 0;
        let copiedBytes = 0;
        const seen = new Set<string>();

        const writeOne = async (srcAbs: string, destRel: string): Promise<void> => {
            const stat = await fs.promises.stat(srcAbs);
            if (!stat.isFile()) throw new Error(`Not a regular file: ${destRel}`);
            if (stat.size > bounds.maxFileBytes) {
                throw new Error(`File too large to materialize: ${destRel} (${stat.size} bytes)`);
            }
            if (copiedFiles + 1 > bounds.maxFiles) {
                throw new Error(`Materialization exceeds ${bounds.maxFiles} files`);
            }
            if (copiedBytes + stat.size > bounds.maxBytes) {
                throw new Error(`Materialization exceeds ${bounds.maxBytes} bytes (${copiedBytes} so far)`);
            }
            const destAbs = path.resolve(destDir, destRel);
            if (!isPathWithinBase(destAbs, path.resolve(destDir))) {
                throw new Error(`Destination escapes the candidate dir: ${destRel}`);
            }
            const key = caseKey(destRel);
            if (seen.has(key)) throw new Error(`Duplicate materialized path (case-insensitive): ${destRel}`);
            seen.add(key);
            await fs.promises.mkdir(path.dirname(destAbs), { recursive: true });
            await fs.promises.copyFile(srcAbs, destAbs);
            copiedFiles += 1;
            copiedBytes += stat.size;
        };

        for (const file of files) {
            await writeOne(path.join(cloneDir, file.srcRel), file.destRel);
        }

        for (const plan of contexts) {
            const srcRoot = path.resolve(cloneDir, plan.srcRel);
            // Context files are copied from the INVENTORY (plan.context.files),
            // not from a re-walk of the directory with the first plan's matcher.
            // This means merged plans (multiple services sharing a context with
            // different Dockerfiles) copy the exact union their manifests record.
            for (const f of plan.context.files) {
                const src = path.resolve(srcRoot, f.path);
                const destRel = plan.destRel && plan.destRel !== '.' ? `${plan.destRel}/${f.path}` : f.path;
                // Sencho metadata must never reach the live stack.
                if (f.path === '.candidate-complete') continue;
                // A repo-root context overlaps the managed file set: paths
                // already copied as managed inputs must not be copied again.
                if (seen.has(caseKey(destRel))) continue;
                await writeOne(src, destRel);
            }
        }

        return { copiedFiles, copiedBytes };
    }
}
