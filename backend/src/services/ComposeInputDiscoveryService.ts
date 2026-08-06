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
 * limitation note. Dynamic \${VAR} paths are reported in the pull response but
 * are never claimed as covered. Never claim coverage for anything else.
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

function hasGitMetaSegment(relPath: string): boolean {
    return posixRel(relPath)
        .split('/')
        .filter(Boolean)
        .some((seg) => seg.toLowerCase() === '.git');
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

    /** Resolve a declared input's repo-relative path per its base-dir rule. */
    private resolveDeclared(cloneDir: string, input: DeclaredInput): string | null {
        // repo-root inputs from the parser are already resolved (include/extends
        // and project-root-prefixed env forms); compose-file-dir inputs resolve
        // against the declaring file's dir, falling back to the repo root.
        if (input.baseDir === 'repo-root') {
            return input.sourcePath && !isUrl(input.sourcePath) && !hasGitMetaSegment(input.sourcePath)
                ? input.sourcePath
                : null;
        }
        const declaringDir =
            input.baseDir === 'compose-file-dir' && input.fromFile && input.fromFile.includes('/')
                ? input.fromFile.slice(0, input.fromFile.lastIndexOf('/'))
                : null;
        const first = resolveInRepo(input.sourcePath ?? '', declaringDir);
        if (first === null) return null;
        if (fs.existsSync(path.join(cloneDir, first))) return first;
        return resolveInRepo(input.sourcePath ?? '', null);
    }

    /** Plan build contexts with dockerignore semantics and byte accounting. */
    private async planBuildContexts(
        cloneDir: string,
        contextInputs: DeclaredInput[],
        submodules: string[],
        bounds: ManifestBounds,
        refusals: RefusalInfo[],
    ): Promise<{ plans: ContextCopyPlan[]; entries: ComposeInputEntry[] }> {
        const plans: ContextCopyPlan[] = [];
        const entries: ComposeInputEntry[] = [];
        const seen = new Set<string>();

        for (const input of contextInputs) {
            const resolved = this.resolveDeclared(cloneDir, input);
            if (resolved === null) {
                refusals.push(this.refusal(input.sourcePath, 'out-of-bounds', `Build context ${input.sourcePath ?? '(unnamed)'} is not inside the repository`, true));
                continue;
            }
            if (seen.has(caseKey(resolved))) continue;
            seen.add(caseKey(resolved));

            const abs = path.resolve(cloneDir, resolved);
            let stat: fs.Stats;
            try {
                stat = await fs.promises.lstat(abs);
            } catch {
                refusals.push(this.refusal(resolved, 'missing-file', `Build context ${resolved} does not exist in the repository`, true));
                continue;
            }
            if (stat.isSymbolicLink()) {
                refusals.push(this.refusal(resolved, 'unsafe-symlink', `Build context ${resolved} is a symbolic link`, true));
                continue;
            }
            if (!stat.isDirectory()) {
                refusals.push(this.refusal(resolved, 'not-a-directory', `Build context ${resolved} is not a directory`, true));
                continue;
            }

            // docker reads .dockerignore from the dockerfile's directory when the
            // dockerfile is declared, else from the context root.
            const dockerfileDecl = contextInputs.find(
                (i) => i.kind === 'dockerfile' && i.fromFile === input.fromFile,
            );
            // docker reads .dockerignore from the DOCKERFILE's directory when
            // the dockerfile is declared with a directory component, else from
            // the context root.
            let dockerignoreDir = abs;
            if (dockerfileDecl && typeof dockerfileDecl.sourcePath === 'string' && dockerfileDecl.sourcePath.includes('/')) {
                const safeDockerfileDir = dockerfileDecl.sourcePath.split('/').slice(0, -1).join('/');
                dockerignoreDir = path.join(abs, safeDockerfileDir);
            }
            const matcher = await loadDockerIgnore(dockerignoreDir);
            const dockerignoreRel = matcher !== null ? path.relative(cloneDir, path.join(dockerignoreDir, '.dockerignore')).replace(/\\/g, '/') : null;

            // Walk the context subtree: filtered bytes, ignored count, LFS and
            // special-file detection among files that would be copied.
            let contextBytes = 0;
            let ignoredCount = 0;
            let lfsInContext = false;
            let specialInContext: string | null = null;
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

            const isRepoRoot = resolved === '' || resolved === '.';
            const excluded = false;
            let note: string | null = null;
            if (specialInContext !== null) {
                refusals.push(this.refusal(resolved, 'unsafe-context', specialInContext, true));
                continue;
            }
            if (lfsInContext) {
                refusals.push(this.refusal(resolved, 'lfs-in-context', `Build context ${resolved} contains Git LFS pointers`, true));
                continue;
            }
            if (contextBytes > bounds.maxContextBytes) {
                refusals.push(
                    this.refusal(
                        resolved,
                        'context-unbounded',
                        `Build context ${resolved} is ${contextBytes} bytes after .dockerignore filtering; the maximum is ${bounds.maxContextBytes}`,
                        true,
                    ),
                );
                continue;
            }
            if (isRepoRoot) {
                note = `Context is the repository root; bounded by GITSOURCE_MAX_BUILD_CONTEXT_BYTES (${bounds.maxContextBytes} bytes)`;
            }

            const plan: BuildContextPlan = {
                repoPath: resolved,
                dockerfile: dockerfileDecl?.sourcePath ?? null,
                contextBytes,
                ignoredCount,
                dockerignoreApplied: matcher !== null,
                excludedFromCopy: excluded,
                note,
            };
            plans.push({
                context: plan,
                srcRel: resolved,
                destRel: resolved, // contexts keep their repo-relative path in the materialized layout
                matcher,
                dockerignoreRel,
            });
            entries.push({
                sourcePath: resolved,
                materializedPath: resolved,
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
        return { plans, entries };
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

        // Implicit override: only when the invocation passes a single explicit
        // -f (docker compose suppresses auto-discovery for explicit multi-file lists).
        let implicitOverridePath: string | null = null;
        if (composePaths.length === 1) {
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
                    sensitivity: kind === 'config' || kind === 'secret' || kind === 'env_file' || kind === 'include-env' || kind === 'interpolation-env' || kind === 'label_file' || kind === 'build-secret' ? 'high' : 'low',
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

            // Build contexts are planned separately below.
            if (kind === 'build-context' || kind === 'build-additional-context') continue;

            const resolved = this.resolveDeclared(cloneDir, input);
            if (resolved === null) {
                refusals.push(this.refusal(input.sourcePath, 'out-of-bounds', `${input.sourcePath} is outside the repository or project root`, true));
                continue;
            }

            // Submodule containment check.
            const inSubmodule = submodules.find((s) => resolved === s || resolved.startsWith(`${s}/`)) ?? null;
            if (inSubmodule !== null) {
                refusals.push(this.refusal(resolved, 'submodule', `${resolved} is inside Git submodule ${inSubmodule}; submodule contents are not fetched`, true));
                continue;
            }

            // When the synced stack-root .env owns the same path (no project
            // dir), the interpolation env must NOT be hash-guarded: the apply
            // stages the sync content over it, so a managed entry would record
            // the repo hash and the next apply would refuse .env as locally
            // modified forever. Record it unmanaged in that case.
            if (kind === 'interpolation-env' && params.syncEnv === true && resolved === '.env') {
                inputs.push({
                    sourcePath: resolved,
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
            if (kind === 'interpolation-env' && !fs.existsSync(path.join(cloneDir, resolved))) {
                inputs.push({
                    sourcePath: resolved,
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

            const classified = await this.classifyPath(cloneDir, resolved, bounds);
            if (!classified.ok) {
                refusals.push(classified.refusal);
                continue;
            }
            if (managedCount + 1 > bounds.maxFiles) {
                refusals.push(this.refusal(resolved, 'too-many-files', `Materialization would exceed ${bounds.maxFiles} files`, true));
                continue;
            }
            if (managedBytes + classified.sizeBytes > bounds.maxBytes) {
                refusals.push(this.refusal(resolved, 'too-many-bytes', `Materialization would exceed ${bounds.maxBytes} bytes (${managedBytes} so far)`, true));
                continue;
            }
            managedCount += 1;
            managedBytes += classified.sizeBytes;
            const sensitivity: InputSensitivity =
                kind === 'config' || kind === 'secret' || kind === 'env_file' || kind === 'include-env' || kind === 'interpolation-env' || kind === 'label_file' || kind === 'build-secret'
                    ? 'high'
                    : 'medium';
            inputs.push({
                sourcePath: resolved,
                materializedPath: resolved,
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

        // Build contexts.
        const contextInputs = parsed.inputs.filter((i) => i.kind === 'build-context' || i.kind === 'build-additional-context');
        const { plans, entries: contextEntries } = await this.planBuildContexts(cloneDir, contextInputs, submodules, bounds, refusals);
        inputs.push(...contextEntries);

        // Sync env entry (stack-root .env) is recorded by the caller (it knows
        // sync_env + env_path); interpolation-env classification is covered above.

        return {
            inputs,
            refusals,
            buildContexts: plans.map((p) => p.context),
            contextCopyPlans: plans,
            dynamic,
            counts: {
                managed: inputs.filter((i) => i.ownership === 'managed').length,
                unmanaged: inputs.filter((i) => i.ownership === 'unmanaged').length,
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
            const stack: Array<{ src: string; destRel: string }> = [];
            const walk = async (dir: string, rel: string): Promise<void> => {
                const entriesList = await fs.promises.readdir(dir, { withFileTypes: true });
                for (const entry of entriesList) {
                    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
                    if (entry.name === '.git' || (entry.name.toLowerCase() === '.git')) continue;
                    if (plan.matcher?.matches(childRel, entry.isDirectory())) {
                        if (!entry.isDirectory()) plan.context.ignoredCount += 1;
                        continue;
                    }
                    if (entry.isSymbolicLink()) {
                        throw new Error(`Symbolic link inside build context: ${childRel}`);
                    }
                    if (entry.isDirectory()) {
                        await walk(path.join(dir, entry.name), childRel);
                        continue;
                    }
                    if (entry.isCharacterDevice() || entry.isBlockDevice() || entry.isSocket() || entry.isFIFO()) {
                        throw new Error(`Special file inside build context: ${childRel}`);
                    }
                    stack.push({ src: path.join(dir, entry.name), destRel: plan.destRel ? `${plan.destRel}/${childRel}` : childRel });
                }
            };
            await walk(srcRoot, '');
            for (const item of stack) {
                await writeOne(item.src, item.destRel);
            }
        }

        return { copiedFiles, copiedBytes };
    }
}
