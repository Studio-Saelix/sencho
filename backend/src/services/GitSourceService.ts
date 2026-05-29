import { promises as fsPromises } from 'fs';
import { spawn } from 'child_process';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import YAML from 'yaml';
import { CryptoService } from './CryptoService';
import { DatabaseService, type StackGitSource, type GitSourceAuthType } from './DatabaseService';
import { FileSystemService } from './FileSystemService';
import { ComposeService } from './ComposeService';
import { NodeRegistry } from './NodeRegistry';
import { assertPolicyGateAllows, buildSystemPolicyGateOptions } from '../helpers/policyGate';
import { isDebugEnabled } from '../utils/debug';
import { sanitizeForLog } from '../utils/safeLog';
import { isPathWithinBase } from '../utils/validation';
import type { GitHttpRequest, GitHttpResponse, HttpClient } from 'isomorphic-git/http/node';

// isomorphic-git is the heaviest dependency in the backend (~5 MB) and only
// fires when a stack is created from a Git source. Lazy-load it so cold
// boots without any Git-sourced stacks never parse the module.
type IsomorphicGit = typeof import('isomorphic-git')['default'];
type IsomorphicGitHttp = typeof import('isomorphic-git/http/node')['default'];

let cachedGit: IsomorphicGit | undefined;
let cachedGitHttp: IsomorphicGitHttp | undefined;

async function loadIsomorphicGit(): Promise<{ git: IsomorphicGit; gitHttp: IsomorphicGitHttp }> {
    if (!cachedGit || !cachedGitHttp) {
        const [gitMod, gitHttpMod] = await Promise.all([
            import('isomorphic-git'),
            import('isomorphic-git/http/node'),
        ]);
        cachedGit = gitMod.default;
        cachedGitHttp = gitHttpMod.default;
    }
    return { git: cachedGit, gitHttp: cachedGitHttp };
}

function cloneTimeoutError(): Error & { code: string } {
    return Object.assign(new Error('Clone timed out'), { code: 'ETIMEDOUT' });
}

async function collectGitBody(body: AsyncIterableIterator<Uint8Array>, signal: AbortSignal): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of body) {
        if (signal.aborted) throw cloneTimeoutError();
        chunks.push(chunk);
        size += chunk.byteLength;
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return result;
}

function responseBodyIterator(body: ReadableStream<Uint8Array> | null): AsyncIterableIterator<Uint8Array> {
    async function* iterate(): AsyncIterableIterator<Uint8Array> {
        if (!body) return;
        const reader = body.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) return;
                yield value;
            }
        } finally {
            reader.releaseLock();
        }
    }
    return iterate();
}

/**
 * Mutable counter shared across every request in one clone so the size cap
 * is cumulative, and so the caller can tell a size abort from a timeout via
 * `exceeded` rather than the thrown error (which isomorphic-git may wrap).
 */
interface CloneSizeState {
    exceeded: boolean;
    received: number;
}

/**
 * Wrap a response-body iterator with a cumulative byte counter shared
 * across every request in one clone. When the running total crosses
 * `maxBytes`, flip `state.exceeded`, abort the transport (closing the
 * socket so the download stops), and throw to unwind the stream. The
 * caller distinguishes a size abort from a timeout/transport abort via
 * `state.exceeded` rather than the thrown error, which isomorphic-git may
 * wrap.
 */
export function countingBodyIterator(
    src: AsyncIterableIterator<Uint8Array>,
    controller: AbortController,
    maxBytes: number,
    state: CloneSizeState,
): AsyncIterableIterator<Uint8Array> {
    async function* iterate(): AsyncIterableIterator<Uint8Array> {
        for await (const chunk of src) {
            state.received += chunk.byteLength;
            if (state.received > maxBytes) {
                state.exceeded = true;
                controller.abort();
                throw new Error('Clone exceeded the maximum allowed size');
            }
            yield chunk;
        }
    }
    return iterate();
}

function createAbortableGitHttp(
    controller: AbortController,
    maxBytes: number,
    state: CloneSizeState,
): HttpClient {
    const signal = controller.signal;
    return {
        async request(request: GitHttpRequest): Promise<GitHttpResponse> {
            if (signal.aborted) {
                throw cloneTimeoutError();
            }

            const response = await fetch(request.url, {
                method: request.method ?? 'GET',
                headers: request.headers,
                body: request.body ? await collectGitBody(request.body, signal) : undefined,
                signal,
            });

            return {
                url: response.url,
                method: request.method,
                statusCode: response.status,
                statusMessage: response.statusText,
                headers: Object.fromEntries(response.headers.entries()),
                body: countingBodyIterator(responseBodyIterator(response.body), controller, maxBytes, state),
            };
        },
    };
}

/**
 * GitSourceService - fetch compose files from a Git repository and apply
 * them to local stacks. Tokens are encrypted via CryptoService. Shallow
 * single-branch clones land in a per-fetch temp dir and are cleaned up
 * in a `finally` block. A startup sweep removes any leftover temp dirs
 * older than 1 hour in case a previous process crashed.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type GitSourceErrorCode =
    | 'REPO_NOT_FOUND'
    | 'AUTH_FAILED'
    | 'BRANCH_NOT_FOUND'
    | 'FILE_NOT_FOUND'
    | 'NETWORK_TIMEOUT'
    | 'GIT_ERROR';

export class GitSourceError extends Error {
    constructor(public code: GitSourceErrorCode, message: string) {
        super(message);
        this.name = 'GitSourceError';
    }
}

export interface FetchParams {
    repoUrl: string;
    branch: string;
    composePath: string;
    envPath?: string | null;
    token?: string | null;
    timeoutMs?: number;
}

export interface FetchResult {
    composeContent: string;
    envContent: string | null;
    commitSha: string;
    /**
     * Non-fatal issues detected during the fetch (e.g. the repo uses
     * submodules that are not cloned). The stack is still usable but the
     * UI should surface these so the user is not surprised later.
     */
    warnings: string[];
}

export interface UpsertInput {
    stackName: string;
    repoUrl: string;
    branch: string;
    composePath: string;
    syncEnv: boolean;
    envPath: string | null;
    authType: GitSourceAuthType;
    token?: string | null;  // undefined = keep existing, '' = clear, non-empty = replace
    autoApplyOnWebhook: boolean;
    autoDeployOnApply: boolean;
}

export interface CreateStackFromGitInput {
    stackName: string;
    repoUrl: string;
    branch: string;
    composePath: string;
    syncEnv: boolean;
    envPath: string | null;
    authType: GitSourceAuthType;
    token: string | null;
    autoApplyOnWebhook: boolean;
    autoDeployOnApply: boolean;
}

export interface CreateStackFromGitResult {
    source: PublicGitSource;
    commitSha: string;
    envWritten: boolean;
    warnings: string[];
}

export interface PullResult {
    commitSha: string;
    incomingCompose: string;
    incomingEnv: string | null;
    currentCompose: string;
    currentEnv: string | null;
    validation: { ok: boolean; error?: string };
    hasLocalChanges: boolean;
}

export interface PublicGitSource {
    id: number;
    stack_name: string;
    repo_url: string;
    branch: string;
    compose_path: string;
    sync_env: boolean;
    env_path: string | null;
    auth_type: GitSourceAuthType;
    has_token: boolean;
    auto_apply_on_webhook: boolean;
    auto_deploy_on_apply: boolean;
    last_applied_commit_sha: string | null;
    pending_commit_sha: string | null;
    pending_fetched_at: number | null;
    created_at: number;
    updated_at: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const TEMP_DIR_PREFIX = 'sencho-git-';
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const TEMP_DIR_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const WEBHOOK_DEBOUNCE_MS = 10_000;

// Ceiling on how many bytes a single clone may download (the compressed pack
// from the Git host) before it is aborted. This bounds network transfer and
// abuse, not the decompressed on-disk checkout; it is paired with
// MAX_REPO_FILE_BYTES and the 30s timeout. Generous default; operators with a
// legitimately large monorepo can raise it via GITSOURCE_MAX_CLONE_BYTES.
const DEFAULT_MAX_CLONE_BYTES = 100 * 1024 * 1024; // 100 MB

// Per-file ceiling for the compose/env file read into memory after the clone.
// These files are KB-scale in practice; the clone byte cap bounds the
// compressed download, not the decompressed working tree, so this guards the
// in-memory read against a single huge (or highly compressible) file.
const MAX_REPO_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

function maxCloneBytes(): number {
    const raw = process.env.GITSOURCE_MAX_CLONE_BYTES;
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_CLONE_BYTES;
}

function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
}

// ─── Credential scrubbing ────────────────────────────────────────────────────

/**
 * Remove any inline credentials and Authorization headers from an error
 * message before it lands in a log or an API response. isomorphic-git
 * tends to include the fetch URL in thrown errors; if a PAT ever leaks
 * into that URL (we try to avoid it via `onAuth`, but be defensive),
 * strip it here.
 */
function scrubCredentials(message: string): string {
    return message
        .replace(/https?:\/\/[^/\s:@]+:[^/\s@]+@/gi, 'https://***:***@')
        .replace(/(authorization[:=]\s*)[^\s,;]+/gi, '$1***')
        .replace(/(token[:=]\s*)[^\s,;]+/gi, '$1***')
        .replace(/(password[:=]\s*)[^\s,;]+/gi, '$1***');
}

/**
 * Extract just the hostname for log lines so we never echo a full
 * repo URL that could contain an inline credential. Falls back to
 * `unknown` for malformed URLs.
 */
export function repoHost(url: string): string {
    try {
        return new URL(url).host || 'unknown';
    } catch {
        return 'unknown';
    }
}

/**
 * Node's global `fetch()` reports every transport-level failure as a bare
 * `TypeError('fetch failed')` and hides the real reason on `error.cause`
 * (occasionally nested one level deeper through undici). Walk the cause
 * chain for the first Node error code so DNS / connection / TLS failures
 * can be translated into an actionable message instead of "fetch failed",
 * which reads like an internal Sencho bug.
 */
function findCauseCode(err: unknown): { code?: string } {
    let cur: unknown = err;
    for (let depth = 0; depth < 5 && cur; depth++) {
        const code = (cur as { code?: unknown }).code;
        if (typeof code === 'string' && code) {
            return { code };
        }
        cur = (cur as { cause?: unknown }).cause;
    }
    return {};
}

/**
 * Translate a Node transport error code into a GitSourceError with a
 * host-qualified, user-actionable message. Returns null for codes we do
 * not specifically recognise so the caller can fall through to its generic
 * handling. `host` is the bare hostname from `repoHost()` (never carries a
 * credential), so it is safe to surface.
 */
function transportError(code: string, host: string): GitSourceError | null {
    const dest = host && host !== 'unknown' ? ` ${host}` : ' the repository host';
    switch (code) {
        case 'ENOTFOUND':
        case 'EAI_AGAIN':
            return new GitSourceError('NETWORK_TIMEOUT', `Could not resolve${dest}. Check the repository URL and your network or DNS.`);
        case 'ECONNREFUSED':
            return new GitSourceError('NETWORK_TIMEOUT', `Connection refused by${dest}.`);
        case 'ECONNRESET':
            return new GitSourceError('NETWORK_TIMEOUT', `Connection to${dest} was reset. Retry; if it persists, check the host.`);
        case 'ETIMEDOUT':
        case 'UND_ERR_CONNECT_TIMEOUT':
        case 'UND_ERR_HEADERS_TIMEOUT':
        case 'UND_ERR_BODY_TIMEOUT':
            return new GitSourceError('NETWORK_TIMEOUT', `Timed out reaching${dest}.`);
        case 'DEPTH_ZERO_SELF_SIGNED_CERT':
        case 'SELF_SIGNED_CERT_IN_CHAIN':
        case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
        case 'CERT_HAS_EXPIRED':
        case 'ERR_TLS_CERT_ALTNAME_INVALID':
            return new GitSourceError('GIT_ERROR', `TLS certificate error reaching${dest} (${code}). The host certificate could not be verified.`);
        default:
            return null;
    }
}

/**
 * Git LFS stores large files as small pointer stubs in the working tree.
 * The pointer is a short text file that always begins with this line.
 * isomorphic-git does not resolve LFS, so if the compose or env file is
 * tracked through LFS we would silently write the pointer as content.
 * Detect this and refuse, with a clear error, before it ever lands on
 * disk.
 */
const LFS_POINTER_PREFIX = 'version https://git-lfs.github.com/spec/v';

function isLfsPointer(content: string): boolean {
    // Pointer files are a few lines of ASCII, always starting with the
    // version header on the first line. Check just the leading bytes so
    // a very large plain file does not trigger a full scan.
    return content.slice(0, LFS_POINTER_PREFIX.length) === LFS_POINTER_PREFIX;
}

/**
 * Check whether the cloned tree references Git submodules. We do not
 * fetch submodule contents (isomorphic-git does not support them), so
 * warn the caller that any paths inside submodule directories will be
 * empty at deploy time.
 */
async function hasSubmodules(dir: string): Promise<boolean> {
    try {
        const stat = await fsPromises.stat(path.join(dir, '.gitmodules'));
        return stat.isFile() && stat.size > 0;
    } catch {
        return false;
    }
}

async function readRepoFile(rootDir: string, relPath: string, label: string): Promise<string> {
    const root = path.resolve(rootDir);
    const safeRel = relPath.split('/').map(s => path.basename(s)).join('/');
    const abs = path.resolve(root, safeRel);
    if (!isPathWithinBase(abs, root)) {
        throw new GitSourceError('FILE_NOT_FOUND', `${label} resolves outside the repository.`);
    }

    let stat;
    try {
        stat = await fsPromises.lstat(abs);
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new GitSourceError('FILE_NOT_FOUND', `File not found in repository: ${relPath}`);
        }
        throw new GitSourceError('GIT_ERROR', scrubCredentials((e as Error).message));
    }
    if (stat.isSymbolicLink()) {
        throw new GitSourceError('FILE_NOT_FOUND', `${label} cannot be a symbolic link.`);
    }
    // Bound the in-memory read. The clone byte cap only limits the compressed
    // download; a single decompressed file can still be large, so reject an
    // oversized compose/env file before reading it into a string.
    if (stat.size > MAX_REPO_FILE_BYTES) {
        throw new GitSourceError('GIT_ERROR', `${label} is too large (${formatBytes(stat.size)}); the maximum is ${formatBytes(MAX_REPO_FILE_BYTES)}.`);
    }

    let real;
    try {
        real = await fsPromises.realpath(abs);
    } catch (e) {
        throw new GitSourceError('GIT_ERROR', scrubCredentials((e as Error).message));
    }
    if (!isPathWithinBase(real, root)) {
        throw new GitSourceError('FILE_NOT_FOUND', `${label} resolves outside the repository.`);
    }

    try {
        return await fsPromises.readFile(real, 'utf-8');
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new GitSourceError('FILE_NOT_FOUND', `File not found in repository: ${relPath}`);
        }
        throw new GitSourceError('GIT_ERROR', scrubCredentials((e as Error).message));
    }
}

const SUBMODULE_WARNING =
    'Repository contains Git submodules. Their contents are not cloned; any paths referenced from them will be missing at deploy time.';

/**
 * Reject any relative path that resolves into the `.git` metadata
 * directory. The path-traversal check in `fetchFromGit` already bounds
 * paths to the clone dir, but without this guard a caller could still
 * target `.git/config` (remote URL, potentially mis-configured inline
 * credentials) via a path that stays inside the clone. Matches on any
 * `.git` segment, case-insensitive, so `.GIT/config` is also rejected.
 */
function assertNotGitMeta(relPath: string, fieldName: string): void {
    const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
    const segments = normalized.split('/').filter(Boolean);
    if (segments.some(seg => seg === '.git')) {
        throw new GitSourceError('FILE_NOT_FOUND', `${fieldName} cannot target the .git metadata directory.`);
    }
}

// ─── Temp dir helpers ────────────────────────────────────────────────────────

async function createTempDir(): Promise<string> {
    const prefix = path.join(os.tmpdir(), TEMP_DIR_PREFIX);
    return fsPromises.mkdtemp(prefix);
}

async function removeTempDir(dir: string): Promise<void> {
    try {
        await fsPromises.rm(dir, { recursive: true, force: true });
    } catch (e) {
        console.warn('[GitSourceService] Failed to remove temp dir:', (e as Error).message);
    }
}

/**
 * Sweep any leftover sencho-git-* temp dirs older than 1 hour. Runs once at
 * service boot to clean up after a crashed process.
 */
export async function sweepStaleTempDirs(): Promise<void> {
    const tmp = os.tmpdir();
    let entries: string[];
    try {
        entries = await fsPromises.readdir(tmp);
    } catch {
        return;
    }
    const cutoff = Date.now() - TEMP_DIR_MAX_AGE_MS;
    for (const entry of entries) {
        if (!entry.startsWith(TEMP_DIR_PREFIX)) continue;
        const full = path.join(tmp, entry);
        try {
            const stat = await fsPromises.stat(full);
            if (stat.mtimeMs < cutoff) {
                await fsPromises.rm(full, { recursive: true, force: true });
            }
        } catch {
            // best effort
        }
    }
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class GitSourceService {
    private static instance: GitSourceService;
    private crypto: CryptoService;
    /** Per-stack serialization for the apply path. */
    private stackLocks = new Map<string, Promise<unknown>>();

    private constructor() {
        this.crypto = CryptoService.getInstance();
    }

    public static getInstance(): GitSourceService {
        if (!GitSourceService.instance) {
            GitSourceService.instance = new GitSourceService();
        }
        return GitSourceService.instance;
    }

    // ─── Public projections ──────────────────────────────────────────────────

    private toPublic(src: StackGitSource): PublicGitSource {
        return {
            id: src.id!,
            stack_name: src.stack_name,
            repo_url: src.repo_url,
            branch: src.branch,
            compose_path: src.compose_path,
            sync_env: src.sync_env,
            env_path: src.env_path,
            auth_type: src.auth_type,
            has_token: !!src.encrypted_token,
            auto_apply_on_webhook: src.auto_apply_on_webhook,
            auto_deploy_on_apply: src.auto_deploy_on_apply,
            last_applied_commit_sha: src.last_applied_commit_sha,
            pending_commit_sha: src.pending_commit_sha,
            pending_fetched_at: src.pending_fetched_at,
            created_at: src.created_at,
            updated_at: src.updated_at,
        };
    }

    public get(stackName: string): PublicGitSource | undefined {
        const row = DatabaseService.getInstance().getGitSource(stackName);
        return row ? this.toPublic(row) : undefined;
    }

    public list(): PublicGitSource[] {
        return DatabaseService.getInstance().getGitSources().map(s => this.toPublic(s));
    }

    // ─── CRUD ────────────────────────────────────────────────────────────────

    public async upsert(input: UpsertInput): Promise<PublicGitSource> {
        const db = DatabaseService.getInstance();
        const existing = db.getGitSource(input.stackName);

        // Determine the stored token.
        let encryptedToken: string | null;
        if (input.authType === 'none') {
            encryptedToken = null;
        } else if (input.token === undefined) {
            // Keep existing
            encryptedToken = existing?.encrypted_token ?? null;
        } else if (input.token === null || input.token === '') {
            encryptedToken = null;
        } else {
            encryptedToken = this.crypto.encrypt(input.token);
        }

        // Apply-matrix sanity: auto_deploy requires auto_apply.
        if (input.autoDeployOnApply && !input.autoApplyOnWebhook) {
            throw new GitSourceError('GIT_ERROR', 'Auto-deploy requires auto-apply-on-webhook to be enabled.');
        }

        // Dry-run reachability check before persisting.
        const token = encryptedToken ? this.crypto.decrypt(encryptedToken) : null;
        await this.fetchFromGit({
            repoUrl: input.repoUrl,
            branch: input.branch,
            composePath: input.composePath,
            envPath: input.syncEnv ? input.envPath : null,
            token,
        });

        db.upsertGitSource({
            stack_name: input.stackName,
            repo_url: input.repoUrl,
            branch: input.branch,
            compose_path: input.composePath,
            sync_env: input.syncEnv,
            env_path: input.syncEnv ? input.envPath : null,
            auth_type: input.authType,
            encrypted_token: encryptedToken,
            auto_apply_on_webhook: input.autoApplyOnWebhook,
            auto_deploy_on_apply: input.autoDeployOnApply,
            last_applied_commit_sha: existing?.last_applied_commit_sha ?? null,
            last_applied_content_hash: existing?.last_applied_content_hash ?? null,
            pending_commit_sha: existing?.pending_commit_sha ?? null,
            pending_compose_content: existing?.pending_compose_content ?? null,
            pending_env_content: existing?.pending_env_content ?? null,
            pending_fetched_at: existing?.pending_fetched_at ?? null,
            last_debounce_at: existing?.last_debounce_at ?? null,
        });

        return this.get(input.stackName)!;
    }

    public delete(stackName: string): void {
        DatabaseService.getInstance().deleteGitSource(stackName);
    }

    // ─── Fetch ───────────────────────────────────────────────────────────────

    public async fetchFromGit(params: FetchParams): Promise<FetchResult> {
        const { repoUrl, branch, composePath, envPath, token } = params;
        const timeoutMs = params.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;

        // Reject any compose/env target that resolves inside the `.git`
        // metadata directory BEFORE we spin up a clone. This blocks a
        // caller from reading `.git/config` (which leaks the remote URL
        // and any mis-configured inline credentials) via the fetch path.
        assertNotGitMeta(composePath, 'compose_path');
        if (envPath) assertNotGitMeta(envPath, 'env_path');

        const dir = await createTempDir();
        const startedAt = Date.now();
        const diag = isDebugEnabled();
        if (diag) {
            console.log(
                `[GitSource:diag] fetch start host=${sanitizeForLog(repoHost(repoUrl))} branch=${sanitizeForLog(branch)} compose=${sanitizeForLog(composePath)} envSync=${envPath ? 'true' : 'false'} timeoutMs=${timeoutMs}`
            );
        }

        // isomorphic-git's onAuth callback hands credentials to the HTTP
        // layer without them touching the URL string, which keeps tokens
        // out of any error messages generated during the clone.
        const onAuth = token
            ? () => ({ username: 'x-access-token', password: token })
            : undefined;

        try {
            const { git } = await loadIsomorphicGit();
            // Bound clone duration and abort the HTTP transport so timed-out
            // fetches do not keep sockets and packfile streams alive.
            let timer: NodeJS.Timeout | undefined;
            const controller = new AbortController();
            const maxBytes = maxCloneBytes();
            const sizeState = { exceeded: false, received: 0 };
            const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    controller.abort();
                    reject(cloneTimeoutError());
                }, timeoutMs);
            });
            try {
                await Promise.race([
                    git.clone({
                        fs: { promises: fsPromises },
                        http: createAbortableGitHttp(controller, maxBytes, sizeState),
                        dir,
                        url: repoUrl,
                        ref: branch,
                        singleBranch: true,
                        depth: 1,
                        noTags: true,
                        onAuth,
                    }),
                    timeout,
                ]);
            } catch (e) {
                // A size abort surfaces as a generic transport error once
                // isomorphic-git unwinds, so detect it via the shared flag.
                if (sizeState.exceeded) {
                    throw new GitSourceError(
                        'GIT_ERROR',
                        `Repository exceeds the maximum clone size of ${formatBytes(maxBytes)}.`,
                    );
                }
                throw this.mapGitError(e as Error, Boolean(token), repoHost(repoUrl));
            } finally {
                if (timer) clearTimeout(timer);
            }

            const log = await git.log({ fs: { promises: fsPromises }, dir, ref: branch, depth: 1 });
            if (!log.length) {
                throw new GitSourceError('GIT_ERROR', 'Repository has no commits on the requested branch.');
            }
            const commitSha = log[0].oid;

            const composeContent = await readRepoFile(dir, composePath, 'Compose path');
            if (isLfsPointer(composeContent)) {
                console.error(`[GitSource] LFS pointer detected in ${sanitizeForLog(composePath)}`);
                throw new GitSourceError(
                    'GIT_ERROR',
                    `Compose file at ${composePath} is stored in Git LFS, which is not supported. Commit the plain file or replace the LFS pointer before linking this repository.`,
                );
            }

            let envContent: string | null = null;
            if (envPath) {
                try {
                    envContent = await readRepoFile(dir, envPath, 'Env path');
                } catch (e) {
                    if (e instanceof GitSourceError && e.code === 'FILE_NOT_FOUND' && e.message.startsWith('File not found')) {
                        // A missing sibling .env is legitimate (repo may not carry one
                        // in the requested directory). Return null so the caller can
                        // decide whether to warn.
                        envContent = null;
                    } else {
                        throw e;
                    }
                }
                if (envContent !== null && isLfsPointer(envContent)) {
                    console.error(`[GitSource] LFS pointer detected in ${sanitizeForLog(envPath)}`);
                    throw new GitSourceError(
                        'GIT_ERROR',
                        `Env file at ${envPath} is stored in Git LFS, which is not supported. Commit the plain file or replace the LFS pointer before linking this repository.`,
                    );
                }
            }

            // Submodule detection: non-fatal, surfaced as a warning. isomorphic-git
            // does not recursively clone submodules, so any path that lives inside
            // a submodule directory will be empty after apply. Users need to know.
            const warnings: string[] = [];
            if (await hasSubmodules(dir)) {
                console.warn(`[GitSource] Submodules detected in ${repoHost(repoUrl)}; contents not cloned.`);
                warnings.push(SUBMODULE_WARNING);
            }

            if (diag) {
                console.log(
                    `[GitSource:diag] fetch ok host=${sanitizeForLog(repoHost(repoUrl))} branch=${sanitizeForLog(branch)} sha=${commitSha.slice(0, 7)} env=${envContent !== null ? 'present' : 'absent'} warnings=${warnings.length} elapsedMs=${Date.now() - startedAt}`
                );
            }
            return { composeContent, envContent, commitSha, warnings };
        } catch (err) {
            if (diag) {
                const msg = err instanceof GitSourceError ? `${err.code}: ${err.message}` : (err as Error).message;
                console.log(
                    `[GitSource:diag] fetch fail host=${sanitizeForLog(repoHost(repoUrl))} branch=${sanitizeForLog(branch)} elapsedMs=${Date.now() - startedAt} err=${sanitizeForLog(scrubCredentials(msg))}`
                );
            }
            throw err;
        } finally {
            await removeTempDir(dir);
        }
    }

    private mapGitError(err: Error, hasToken: boolean, host = 'unknown'): GitSourceError {
        const raw = scrubCredentials(err.message || String(err));
        const code = (err as Error & { code?: string }).code;
        // isomorphic-git's HttpError exposes the numeric status on .data; inspect
        // it directly so a 404 is not misclassified as auth failure. GitHub hides
        // private-repo existence by returning 404 to unauthenticated requests, so
        // we also treat 401/403 without a supplied token as "not found or private"
        // to guide the user to add a token rather than "check your token" when
        // they never provided one.
        const statusCode = (err as Error & { data?: { statusCode?: number } }).data?.statusCode;

        // GitHub returns 404 for both "repo genuinely missing" and "private repo
        // the caller cannot see". We cannot distinguish the two without a second
        // probe, so tailor the hint by whether credentials were supplied:
        //   - no token: suggest adding one for private repos
        //   - token present: suggest checking the URL and token scopes, since a
        //     valid token against a missing or wrong-scoped repo also lands here
        if (statusCode === 404) {
            if (hasToken) {
                return new GitSourceError('REPO_NOT_FOUND', 'Repository not found. Verify the URL and that your token has read access to this repo.');
            }
            return new GitSourceError('REPO_NOT_FOUND', 'Repository not found, or it is private. Add a Personal Access Token if the repo is private.');
        }
        if (statusCode === 401 || statusCode === 403) {
            if (hasToken) {
                return new GitSourceError('AUTH_FAILED', 'Repository authentication failed. Check your token.');
            }
            return new GitSourceError('REPO_NOT_FOUND', 'Repository not found, or it is private. Add a Personal Access Token if the repo is private.');
        }

        // Transport failures: Node's fetch() throws a bare "fetch failed"
        // TypeError with the real reason (ENOTFOUND, ECONNREFUSED, TLS, ...)
        // on err.cause. Translate the underlying code before falling through
        // to the generic branches, which only see the useless "fetch failed".
        if (!statusCode) {
            const cause = findCauseCode(err);
            if (cause.code) {
                const mapped = transportError(cause.code, host);
                if (mapped) return mapped;
            }
        }

        // Fallbacks for errors without a numeric status attached (e.g. git CLI
        // output, DNS/lib errors, or future isomorphic-git transports that do
        // not populate err.data.statusCode). Kept as defense-in-depth.
        if (/401|403|authentication/i.test(raw)) {
            return hasToken
                ? new GitSourceError('AUTH_FAILED', 'Repository authentication failed. Check your token.')
                : new GitSourceError('REPO_NOT_FOUND', 'Repository not found, or it is private. Add a Personal Access Token if the repo is private.');
        }
        if (code === 'NotFoundError' || /404|not found|could not resolve/i.test(raw)) {
            return new GitSourceError('REPO_NOT_FOUND', 'Repository not found or not accessible.');
        }
        if (code === 'ResolveRefError' || /resolve ref|unknown ref|couldn't find remote ref|reference not found/i.test(raw)) {
            return new GitSourceError('BRANCH_NOT_FOUND', 'Branch not found in the repository.');
        }
        if (code === 'ECONNABORTED' || /timeout|timed out|ETIMEDOUT|ENOTFOUND|ECONNREFUSED/i.test(raw)) {
            return new GitSourceError('NETWORK_TIMEOUT', 'Network timeout or host unreachable.');
        }
        // Last-resort: an HttpError with a status we did not specifically handle.
        if (code === 'HttpError') {
            return new GitSourceError('GIT_ERROR', `Unexpected HTTP response from git host${statusCode ? ` (${statusCode})` : ''}.`);
        }
        return new GitSourceError('GIT_ERROR', raw);
    }

    // ─── Validation ──────────────────────────────────────────────────────────

    /**
     * Validate a compose file by (a) parsing YAML and (b) handing the content
     * to `docker compose config --quiet` in a throwaway temp dir. This is the
     * same validator Compose runs at deploy time, so it catches interpolation
     * errors, invalid `include:` references, etc., which a shallow schema
     * check would miss.
     */
    public async validateCompose(composeContent: string, envContent: string | null): Promise<{ ok: boolean; error?: string }> {
        // Cheap syntax pre-check
        try {
            const parsed = YAML.parse(composeContent);
            if (parsed === null || parsed === undefined) {
                return { ok: false, error: 'Compose file is empty.' };
            }
            if (typeof parsed !== 'object' || Array.isArray(parsed)) {
                return { ok: false, error: 'Compose file must be a YAML mapping.' };
            }
        } catch (e) {
            return { ok: false, error: `YAML parse error: ${(e as Error).message}` };
        }

        // Semantic check via `docker compose config`
        const dir = await createTempDir();
        try {
            const composeFile = path.join(dir, 'compose.yaml');
            await fsPromises.writeFile(composeFile, composeContent, 'utf-8');
            const args = ['compose', '-f', composeFile];
            if (envContent !== null) {
                const envFile = path.join(dir, '.env');
                await fsPromises.writeFile(envFile, envContent, 'utf-8');
                args.push('--env-file', envFile);
            }
            args.push('config', '--quiet');
            const result = await this.runDockerCompose(args, dir, 10_000);
            if (result.code === 0) return { ok: true };
            return { ok: false, error: result.stderr.trim() || `docker compose exited with code ${result.code}` };
        } finally {
            await removeTempDir(dir);
        }
    }

    private runDockerCompose(args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
        return new Promise((resolve) => {
            const child = spawn('docker', args, { cwd });
            let stdout = '';
            let stderr = '';
            const timer = setTimeout(() => {
                try { child.kill('SIGKILL'); } catch { /* best effort */ }
                resolve({ code: -1, stdout, stderr: stderr + '\nValidation timed out.' });
            }, timeoutMs);
            child.stdout.on('data', d => { stdout += d.toString(); });
            child.stderr.on('data', d => { stderr += d.toString(); });
            child.on('close', (code) => {
                clearTimeout(timer);
                resolve({ code: code ?? -1, stdout, stderr });
            });
            child.on('error', (err) => {
                clearTimeout(timer);
                resolve({ code: -1, stdout, stderr: stderr + '\n' + err.message });
            });
        });
    }

    // ─── Hashing + diff ──────────────────────────────────────────────────────

    public hashContent(compose: string, env: string | null): string {
        return crypto.createHash('sha256')
            .update(compose)
            .update('\x00')
            .update(env ?? '')
            .digest('hex');
    }

    private async readDiskContent(stackName: string, syncEnv: boolean): Promise<{ compose: string; env: string | null }> {
        const fsSvc = FileSystemService.getInstance();
        let compose: string;
        try {
            compose = await fsSvc.getStackContent(stackName);
        } catch {
            compose = '';
        }
        let env: string | null = null;
        if (syncEnv) {
            try {
                env = await fsSvc.getEnvContent(stackName);
            } catch {
                env = null;
            }
        }
        return { compose, env };
    }

    // ─── Pull / apply ────────────────────────────────────────────────────────

    public async pull(stackName: string): Promise<PullResult> {
        // Guarded by the per-stack mutex (see withStackLock). Without this, a
        // concurrent delete-source + pull can land a pending row on a stack
        // whose config row has just been removed.
        return this.withStackLock(stackName, () => this.pullLocked(stackName));
    }

    /**
     * Body of pull(); assumes the caller already holds the per-stack lock.
     * handleWebhookPull calls this directly so that its debounce re-check,
     * this fetch, and the apply all run inside the single lock that
     * handleWebhookPull holds. Without that, a concurrent webhook fan-out
     * reads last_debounce_at while it is still unset on every request, slips
     * past the gate, and clones once per request.
     */
    private async pullLocked(stackName: string): Promise<PullResult> {
        const db = DatabaseService.getInstance();
        const src = db.getGitSource(stackName);
        if (!src) throw new GitSourceError('GIT_ERROR', 'No Git source configured for this stack.');

        const diag = isDebugEnabled();
        if (diag) {
            console.log(`[GitSource:diag] pull start stack=${stackName} branch=${src.branch} host=${repoHost(src.repo_url)}`);
        }

        const token = src.encrypted_token ? this.crypto.decrypt(src.encrypted_token) : null;
        const fetched = await this.fetchFromGit({
            repoUrl: src.repo_url,
            branch: src.branch,
            composePath: src.compose_path,
            envPath: src.sync_env ? src.env_path : null,
            token,
        });

        const validation = await this.validateCompose(fetched.composeContent, fetched.envContent);
        const disk = await this.readDiskContent(stackName, src.sync_env);
        const currentHash = this.hashContent(disk.compose, disk.env);
        const hasLocalChanges = src.last_applied_content_hash !== null
            && src.last_applied_content_hash !== currentHash;

        // Store pending so a subsequent apply doesn't re-fetch. Compose files
        // routinely contain secrets inlined as env interpolations or passwords,
        // so encrypt the pending buffers at rest.
        db.setGitSourcePending(
            stackName,
            fetched.commitSha,
            this.crypto.encrypt(fetched.composeContent),
            fetched.envContent !== null ? this.crypto.encrypt(fetched.envContent) : null,
        );

        console.log(`[GitSource] Pending update ready for ${stackName} at ${fetched.commitSha.slice(0, 7)} (validation=${validation.ok ? 'ok' : 'fail'}, localEdits=${hasLocalChanges})`);
        if (diag) {
            console.log(`[GitSource:diag] pull done stack=${stackName} sha=${fetched.commitSha.slice(0, 7)} validation=${validation.ok} localEdits=${hasLocalChanges}`);
        }

        return {
            commitSha: fetched.commitSha,
            incomingCompose: fetched.composeContent,
            incomingEnv: fetched.envContent,
            currentCompose: disk.compose,
            currentEnv: disk.env,
            validation,
            hasLocalChanges,
        };
    }

    /**
     * Apply a pending pull. Idempotent under the per-stack mutex: if two
     * clients hit /apply concurrently, the second one sees cleared pending
     * columns and gets a clean error rather than double-writing.
     *
     * Deploy failure policy: once the compose file has been written to
     * disk, we never throw. Instead we return `deployed: false,
     * deployError: <message>` so the UI can clearly show "applied, but
     * deploy failed" and the caller can retry the deploy without having
     * to re-pull. Throwing here would leave the user with a changed disk
     * file and a confusing "apply failed" error message.
     */
    public async apply(
        stackName: string,
        commitSha: string,
        opts: { deploy?: boolean; actor?: string; bypassPolicy?: boolean } = {},
    ): Promise<{ applied: boolean; deployed: boolean; deployError?: string }> {
        return this.withStackLock(stackName, () => this.applyLocked(stackName, commitSha, opts));
    }

    /** Body of apply(); assumes the caller already holds the per-stack lock. */
    private async applyLocked(
        stackName: string,
        commitSha: string,
        opts: { deploy?: boolean; actor?: string; bypassPolicy?: boolean },
    ): Promise<{ applied: boolean; deployed: boolean; deployError?: string }> {
        const diag = isDebugEnabled();
        const db = DatabaseService.getInstance();
        const src = db.getGitSource(stackName);
        if (!src) throw new GitSourceError('GIT_ERROR', 'No Git source configured for this stack.');

        if (!src.pending_commit_sha || !src.pending_compose_content) {
            throw new GitSourceError('GIT_ERROR', 'No pending pull to apply. Fetch the source again.');
        }
        if (src.pending_commit_sha !== commitSha) {
            if (diag) console.log('[GitSource:diag] apply sha mismatch stack=%s expected=%s pending=%s', sanitizeForLog(stackName), sanitizeForLog(commitSha.slice(0, 7)), sanitizeForLog(src.pending_commit_sha.slice(0, 7)));
            throw new GitSourceError('GIT_ERROR', 'Pending commit has changed since this pull was fetched. Please review the latest diff.');
        }

        // Pending buffers are stored encrypted; decrypt is a no-op for any
        // legacy plaintext rows (isEncrypted check inside CryptoService).
        const composeContent = this.crypto.decrypt(src.pending_compose_content);
        const envContent = src.pending_env_content !== null
            ? this.crypto.decrypt(src.pending_env_content)
            : null;

        // Re-validate before writing.
        const validation = await this.validateCompose(composeContent, envContent);
        if (!validation.ok) {
            if (diag) console.log(`[GitSource:diag] apply validation fail stack=${stackName}`);
            throw new GitSourceError('GIT_ERROR', `Compose validation failed: ${validation.error}`);
        }

        const fsSvc = FileSystemService.getInstance();
        await fsSvc.saveStackContent(stackName, composeContent);
        if (src.sync_env && envContent !== null) {
            await fsSvc.saveEnvContent(stackName, envContent);
        }

        const hash = this.hashContent(composeContent, envContent);
        db.markGitSourceApplied(stackName, commitSha, hash);

        const shouldDeploy = opts.deploy ?? src.auto_deploy_on_apply;
        if (diag) console.log('[GitSource:diag] apply wrote stack=%s sha=%s deploy=%s', sanitizeForLog(stackName), sanitizeForLog(commitSha.slice(0, 7)), sanitizeForLog(shouldDeploy));

        if (shouldDeploy) {
            try {
                const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
                await assertPolicyGateAllows(
                    stackName,
                    nodeId,
                    buildSystemPolicyGateOptions(opts.actor ?? 'git-source', {
                        bypass: opts.bypassPolicy === true,
                        auditPath: `/api/stacks/${stackName}/git-source/apply`,
                    }),
                );
                await ComposeService.getInstance().deployStack(stackName);
                console.log(`[GitSource] Applied and deployed ${stackName} at ${commitSha.slice(0, 7)}`);
                return { applied: true, deployed: true };
            } catch (e) {
                // File is on disk, DB is marked applied. Returning the
                // error separately lets the UI flag it as a partial
                // success rather than rolling back the disk.
                const scrubbed = scrubCredentials((e as Error).message || String(e));
                console.error(`[GitSource] Auto-deploy failed for ${stackName}: ${scrubbed}`);
                return { applied: true, deployed: false, deployError: scrubbed };
            }
        }
        console.log(`[GitSource] Applied ${stackName} at ${commitSha.slice(0, 7)}`);
        return { applied: true, deployed: false };
    }

    public dismissPending(stackName: string): void {
        DatabaseService.getInstance().clearGitSourcePending(stackName);
    }

    // ─── Create stack from Git ───────────────────────────────────────────────

    /**
     * Fetch a compose file from a Git repository and use it to create a
     * brand-new stack on disk + the matching git-source row. The caller is
     * responsible for rolling back (deleteStack + deleteGitSource) if a
     * later step such as an optional deploy fails; this method itself will
     * undo its own partial state if anything *before* the DB insert fails.
     *
     * Serialized under the same per-stack mutex as pull/apply so a racing
     * webhook cannot collide with a fresh create.
     */
    public async createStackFromGit(input: CreateStackFromGitInput): Promise<CreateStackFromGitResult> {
        return this.withStackLock(input.stackName, async () => {
            const fsSvc = FileSystemService.getInstance();
            const db = DatabaseService.getInstance();
            const diag = isDebugEnabled();

            if (input.autoDeployOnApply && !input.autoApplyOnWebhook) {
                throw new GitSourceError('GIT_ERROR', 'Auto-deploy requires auto-apply-on-webhook to be enabled.');
            }

            // 1. Fetch from git BEFORE touching disk or DB. If the fetch
            //    fails there is nothing to clean up.
            const fetched = await this.fetchFromGit({
                repoUrl: input.repoUrl,
                branch: input.branch,
                composePath: input.composePath,
                envPath: input.syncEnv ? input.envPath : null,
                token: input.token,
            });

            // 2. Validate against the same `docker compose config` check the
            //    apply path uses. Reject before creating anything on disk.
            const validation = await this.validateCompose(fetched.composeContent, fetched.envContent);
            if (!validation.ok) {
                throw new GitSourceError('GIT_ERROR', `Compose validation failed: ${validation.error}`);
            }

            // 3. Create directory + boilerplate, then overwrite with the
            //    fetched content. createStack() throws if the directory
            //    already exists, so a name collision is caught here.
            let stackCreated = false;
            try {
                await fsSvc.createStack(input.stackName);
                stackCreated = true;
                await fsSvc.saveStackContent(input.stackName, fetched.composeContent);
                let envWritten = false;
                if (input.syncEnv && fetched.envContent !== null) {
                    await fsSvc.saveEnvContent(input.stackName, fetched.envContent);
                    envWritten = true;
                }

                // 4. Insert the git-source row, then mark it applied so future
                //    pulls diff against the fetched commit rather than treating
                //    it as "local edits detected".
                const encryptedToken = input.authType === 'token' && input.token
                    ? this.crypto.encrypt(input.token)
                    : null;
                db.upsertGitSource({
                    stack_name: input.stackName,
                    repo_url: input.repoUrl,
                    branch: input.branch,
                    compose_path: input.composePath,
                    sync_env: input.syncEnv,
                    env_path: input.syncEnv ? input.envPath : null,
                    auth_type: input.authType,
                    encrypted_token: encryptedToken,
                    auto_apply_on_webhook: input.autoApplyOnWebhook,
                    auto_deploy_on_apply: input.autoDeployOnApply,
                    last_applied_commit_sha: fetched.commitSha,
                    last_applied_content_hash: this.hashContent(fetched.composeContent, fetched.envContent),
                    pending_commit_sha: null,
                    pending_compose_content: null,
                    pending_env_content: null,
                    pending_fetched_at: null,
                    last_debounce_at: null,
                });
                db.markGitSourceApplied(
                    input.stackName,
                    fetched.commitSha,
                    this.hashContent(fetched.composeContent, fetched.envContent),
                );

                const source = this.get(input.stackName);
                if (!source) {
                    throw new GitSourceError('GIT_ERROR', 'Failed to read back created git source.');
                }

                console.log(`[GitSource] Created stack ${input.stackName} from ${repoHost(input.repoUrl)} at ${fetched.commitSha.slice(0, 7)}`);
                if (diag) {
                    console.log(`[GitSource:diag] createStackFromGit ok stack=${input.stackName} sha=${fetched.commitSha.slice(0, 7)} envWritten=${envWritten} warnings=${fetched.warnings.length}`);
                }
                return { source, commitSha: fetched.commitSha, envWritten, warnings: fetched.warnings };
            } catch (e) {
                // Roll back any partial on-disk state so the caller can retry
                // cleanly. The DB row is only inserted at step 4, so an error
                // earlier leaves nothing to clean in the DB.
                if (stackCreated) {
                    try {
                        await fsSvc.deleteStack(input.stackName);
                    } catch (cleanupErr) {
                        console.error(`[GitSource] Rollback: failed to remove partial stack dir ${input.stackName}:`, cleanupErr);
                    }
                }
                db.deleteGitSource(input.stackName);
                throw e;
            }
        });
    }

    // ─── Webhook-triggered pull ──────────────────────────────────────────────

    /**
     * Invoked by the webhook dispatcher. Returns a short status string to
     * record in webhook_executions. Enforces the per-source debounce.
     */
    public async handleWebhookPull(stackName: string): Promise<{ status: 'success' | 'skipped' | 'error'; message: string }> {
        // Run the whole critical section under a single lock acquisition so a
        // concurrent fan-out (N webhooks for one push) serializes AND re-reads
        // last_debounce_at after acquiring the lock. The first request stamps
        // the window; every queued duplicate then sees the stamp and skips
        // instead of cloning again. The debounce is still stamped only after a
        // successful fetch, so a transient failure stays immediately retriable.
        return this.withStackLock<{ status: 'success' | 'skipped' | 'error'; message: string }>(stackName, async () => {
            const diag = isDebugEnabled();
            const db = DatabaseService.getInstance();
            const src = db.getGitSource(stackName);
            if (!src) {
                return { status: 'error', message: 'No Git source configured for this stack.' };
            }

            const now = Date.now();
            if (src.last_debounce_at !== null && (now - src.last_debounce_at) < WEBHOOK_DEBOUNCE_MS) {
                if (diag) console.log(`[GitSource:diag] webhook debounced stack=${stackName} age=${now - src.last_debounce_at}ms`);
                return { status: 'skipped', message: 'Rate limited (debounced).' };
            }

            try {
                const pullResult = await this.pullLocked(stackName);
                // Only burn the debounce window once the fetch actually produced
                // something. A transient network failure should be retriable
                // immediately rather than locked out for the debounce interval.
                db.touchGitSourceDebounce(stackName);
                if (!pullResult.validation.ok) {
                    // Webhooks are unattended, so always leave a server-side
                    // breadcrumb; the caller only sees the HTTP status.
                    console.warn(`[GitSource] Webhook pull validation failed for ${sanitizeForLog(stackName)}: ${sanitizeForLog(pullResult.validation.error ?? 'unknown')}`);
                    return { status: 'error', message: `Validation failed: ${pullResult.validation.error}` };
                }

                if (!src.auto_apply_on_webhook) {
                    if (diag) console.log(`[GitSource:diag] webhook pending-only stack=${stackName} sha=${pullResult.commitSha.slice(0, 7)}`);
                    return { status: 'success', message: `Pending update ready at ${pullResult.commitSha.slice(0, 7)}.` };
                }

                const applied = await this.applyLocked(stackName, pullResult.commitSha, { deploy: src.auto_deploy_on_apply });
                if (applied.deployError) {
                    // Apply wrote to disk but deploy failed. Surface it so the
                    // webhook_executions row records a degraded outcome instead
                    // of a clean success.
                    return { status: 'error', message: `Applied commit ${pullResult.commitSha.slice(0, 7)} but deploy failed: ${applied.deployError}` };
                }
                const suffix = applied.deployed ? ' and deployed' : '';
                return { status: 'success', message: `Applied commit ${pullResult.commitSha.slice(0, 7)}${suffix}.` };
            } catch (e) {
                const msg = e instanceof GitSourceError ? `${e.code}: ${e.message}` : (e as Error).message;
                const scrubbed = scrubCredentials(msg);
                // Unattended path: record the failure server-side so an operator
                // can diagnose without diag mode, since the Git provider only
                // logs the HTTP status.
                console.error(`[GitSource] Webhook pull failed for ${sanitizeForLog(stackName)}: ${sanitizeForLog(scrubbed)}`);
                return { status: 'error', message: scrubbed };
            }
        });
    }

    // ─── Concurrency ─────────────────────────────────────────────────────────

    private async withStackLock<T>(stackName: string, fn: () => Promise<T>): Promise<T> {
        const prev = this.stackLocks.get(stackName) ?? Promise.resolve();
        const next = prev.catch(() => { /* swallow previous errors */ }).then(fn);
        this.stackLocks.set(stackName, next);
        try {
            return await next;
        } finally {
            // Only clear if the current chain tip is still our promise; otherwise a
            // later caller has already queued behind us.
            if (this.stackLocks.get(stackName) === next) {
                this.stackLocks.delete(stackName);
            }
        }
    }
}
