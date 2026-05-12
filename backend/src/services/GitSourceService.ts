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
            const { git, gitHttp } = await loadIsomorphicGit();
            // isomorphic-git does not natively accept an AbortSignal, so we
            // wrap the clone in a Promise.race against a timeout rejection.
            // The clone will keep running in the background until the socket
            // resolves, but we will not block the caller indefinitely.
            let timer: NodeJS.Timeout | undefined;
            const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(Object.assign(new Error('Clone timed out'), { code: 'ETIMEDOUT' })),
                    timeoutMs,
                );
            });
            try {
                await Promise.race([
                    git.clone({
                        fs: { promises: fsPromises },
                        http: gitHttp,
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
                throw this.mapGitError(e as Error, Boolean(token));
            } finally {
                if (timer) clearTimeout(timer);
            }

            const log = await git.log({ fs: { promises: fsPromises }, dir, ref: branch, depth: 1 });
            if (!log.length) {
                throw new GitSourceError('GIT_ERROR', 'Repository has no commits on the requested branch.');
            }
            const commitSha = log[0].oid;

            const composeAbs = path.resolve(dir, composePath);
            if (!composeAbs.startsWith(path.resolve(dir))) {
                throw new GitSourceError('FILE_NOT_FOUND', 'Compose path resolves outside the repository.');
            }
            let composeContent: string;
            try {
                composeContent = await fsPromises.readFile(composeAbs, 'utf-8');
            } catch (e) {
                if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
                    throw new GitSourceError('FILE_NOT_FOUND', `File not found in repository: ${composePath}`);
                }
                throw new GitSourceError('GIT_ERROR', scrubCredentials((e as Error).message));
            }
            if (isLfsPointer(composeContent)) {
                console.error(`[GitSource] LFS pointer detected in ${sanitizeForLog(composePath)}`);
                throw new GitSourceError(
                    'GIT_ERROR',
                    `Compose file at ${composePath} is stored in Git LFS, which is not supported. Commit the plain file or replace the LFS pointer before linking this repository.`,
                );
            }

            let envContent: string | null = null;
            if (envPath) {
                const envAbs = path.resolve(dir, envPath);
                if (!envAbs.startsWith(path.resolve(dir))) {
                    throw new GitSourceError('FILE_NOT_FOUND', 'Env path resolves outside the repository.');
                }
                try {
                    envContent = await fsPromises.readFile(envAbs, 'utf-8');
                } catch (e) {
                    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
                        // A missing sibling .env is legitimate (repo may not carry one
                        // in the requested directory). Return null so the caller can
                        // decide whether to warn.
                        envContent = null;
                    } else {
                        throw new GitSourceError('GIT_ERROR', scrubCredentials((e as Error).message));
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

    private mapGitError(err: Error, hasToken: boolean): GitSourceError {
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
        // Guarded by the same per-stack mutex as apply(). Without this, a
        // concurrent delete-source + pull can land a pending row on a
        // stack whose config row has just been removed; the DELETE clears
        // the row but the subsequent setGitSourcePending re-inserts via
        // UPDATE failing silently (no row), and a later upsert would
        // inherit stale pending columns on read.
        return this.withStackLock(stackName, async () => {
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
        });
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
        return this.withStackLock(stackName, async () => {
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
        });
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
            const pullResult = await this.pull(stackName);
            // Only burn the debounce window once the fetch actually produced
            // something. A transient network failure should be retriable
            // immediately rather than locked out for the debounce interval.
            db.touchGitSourceDebounce(stackName);
            if (!pullResult.validation.ok) {
                return { status: 'error', message: `Validation failed: ${pullResult.validation.error}` };
            }

            if (!src.auto_apply_on_webhook) {
                if (diag) console.log(`[GitSource:diag] webhook pending-only stack=${stackName} sha=${pullResult.commitSha.slice(0, 7)}`);
                return { status: 'success', message: `Pending update ready at ${pullResult.commitSha.slice(0, 7)}.` };
            }

            const applied = await this.apply(stackName, pullResult.commitSha, { deploy: src.auto_deploy_on_apply });
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
            return { status: 'error', message: scrubCredentials(msg) };
        }
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
