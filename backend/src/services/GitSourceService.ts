import { promises as fsPromises, existsSync } from 'fs';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import YAML from 'yaml';
import { CryptoService } from './CryptoService';
import { DatabaseService, type StackGitSource, type GitSourceAuthType, type GitSourceAppliedSpec } from './DatabaseService';
import { FileSystemService } from './FileSystemService';
import { StackFileRootsService } from './StackFileRootsService';
import { ComposeService } from './ComposeService';
import { StackOpLockService } from './StackOpLockService';
import { HealthGateService } from './HealthGateService';
import { NodeRegistry } from './NodeRegistry';
import { assertPolicyGateAllows, buildSystemPolicyGateOptions, triggerPostDeployScan } from '../helpers/policyGate';
import { invalidateNodeCaches } from '../helpers/cacheInvalidation';
import { isDebugEnabled } from '../utils/debug';
import { sanitizeForLog } from '../utils/safeLog';
import { isPathWithinBase, isValidRelativeStackPath } from '../utils/validation';
import { gitSourceLocalComposeFiles, PRIMARY_COMPOSE_FILENAME } from '../utils/gitComposeFiles';
import { ComposeInputDiscoveryService, type ContextCopyPlan } from './ComposeInputDiscoveryService';
import { GitProjectManifestService, PromoteGenerationError } from './GitProjectManifestService';
import { GitChangePlanService } from './GitChangePlanService';
import { DriftLedgerService } from './DriftLedgerService';
import { StackUpdateRecoveryService } from './StackUpdateRecoveryService';
import { authoredComposeFileArgs, authoredComposeEnvFileArgs, candidateValidationEnvFileArgs } from '../utils/authoredComposeArgs';
import { buildCandidateComposeInvocation } from '../utils/candidateComposeInvocation';
import type { ComposeInputEntry, GitProjectManifest, GitSourceManifestState, InventoryResult, ManifestSummary, RefusalInfo } from '../types/gitProjectManifest';
import type { GitChangePlan, PublicGitChangePlan, GitChangePlanCounts, PublicGitChangePlanOperation } from '../types/gitChangePlan';
import { GIT_CHANGE_PLAN_SCHEMA_VERSION } from '../types/gitChangePlan';
import type { NotificationCategory } from './NotificationService';
import { classifyGitFailure, isTransportFailure, type TransportFailureReason } from './git/errors';
import type { RefKind, SshDeployKeyAuth } from './git/types';
import { nativeGitTransport, verifyFastForward } from './git/nativeGitTransport';
import { fingerprintFromKnownHostsLine } from './git/sshTrust';
import { validateCaBundlePem } from './git/caBundle';
import { GitOpsStore } from './gitops/store';
import type { GitOpsHistoryCursor } from './gitops/history';
import { projectApplication } from './gitops/derive';
import { outcomeFromSourceFacet, isNextAction, isReconcileOutcome, type ReconcileOutcome, type ReconcileResult } from './gitops/outcomes';
import { coalesceKey, deliveryKey, type ReconcileRequest, type ReconcileTrigger } from './gitops/triggers';
import { classifyFailure } from './gitops/backoff';
import { BlueprintTargetAdapter, type AcceptedGeneration, type DispatchContext, type DispatchResult } from './gitops/handoff';
import {
    GitOpsTransitions,
    GitOpsTransitionError,
    type EventEnvelope,
    type ReconcileDeliveryIntent,
} from './gitops/transitions';
import { decodeGitOpsJson, isRecord, GitOpsJsonError } from './gitops/json';
import {
    buildCreateCheckpointRow,
    buildDirectApplicationRow,
    buildGenerationRow,
    directSourceIdentity,
    newGitOpsId,
    stackManagedRoot,
} from './gitops/directApplication';
import type { GitOpsApplicationRow, GitOpsHistoryRow, SourcePolicy } from './gitops/types';
// Re-exported here because the route layer and legacy-boolean compatibility
// matrix consume it through this module; the definition lives with the row
// type in gitops/types.ts so the storage and service layers cannot drift.
export type { SourcePolicy } from './gitops/types';
import { appliedRelPathFor, candidateRelPathForSha, deleteStagingMarker, readStagingMarker, validateCandidateRelPath, writeStagingMarker } from './gitops/createStagingMarker';
import { cleanupUnclaimedManagedRoot, removeOperationOwnedPaths } from './gitops/createCleanup';
import { managedAreaBase } from './gitops/managedPaths';
import { getRegistryDeliveryContext, getRegistryDeliveryLockContext } from '../helpers/registryDeliveryContext';
import { copyPreparedPayloadDirectory } from '../helpers/registryDeliveryMaterialize';
import { runDockerCompose as spawnDockerCompose } from '../helpers/dockerComposeRunner';

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
    | 'REF_NOT_FOUND'
    | 'REF_DELETED'
    | 'UNSUPPORTED_REF'
    | 'SSH_HOST_KEY_FAILED'
    | 'FILE_NOT_FOUND'
    | 'RATE_LIMITED'
    | 'NETWORK_TIMEOUT'
    | 'GIT_ERROR'
    | 'STALE_PLAN'
    | 'PLAN_FINGERPRINT_REQUIRED'
    | 'PLAN_BLOCKED'
    | 'LEGACY_PENDING'
    | 'PLAN_UNAVAILABLE'
    | 'OPERATION_IN_FLIGHT';

export class GitSourceError extends Error {
    constructor(
        public code: GitSourceErrorCode,
        message: string,
        public extras?: {
            plan?: PublicGitChangePlan;
            planFingerprint?: string;
            /**
             * The raw structured reason from the native transport failure,
             * kept alongside the sanitized `code`/`message` operators see.
             * Consumed by GitOps retry/backoff classification, which needs
             * more than the public error code to tell a transient network
             * condition from a permanent configuration one.
             */
            transportReason?: TransportFailureReason;
        },
    ) {
        super(message);
        this.name = 'GitSourceError';
    }
}

/**
 * Merge the synthesized sync-env entry into the discovery inventory with a
 * one-entry-per-path invariant: the synced stack-root .env owns the path, so
 * any discovery entry for it is dropped. The discovery guard already marks the
 * repo's interpolation .env unmanaged when syncEnv is on; this dedupe enforces
 * the invariant regardless of which branch produced the entries.
 */
function mergeSyncEnvEntry(inputs: ComposeInputEntry[], syncEntry: ComposeInputEntry | null): ComposeInputEntry[] {
    if (!syncEntry) return inputs;
    return [...inputs.filter((i) => i.materializedPath !== syncEntry.materializedPath), syncEntry];
}

/** A single compose file fetched from a repo, keyed by its repo-relative path. */
export interface ComposeFile {
    path: string;
    content: string;
}

export interface FetchParams {
    repoUrl: string;
    branch: string;
    composePaths: string[];
    envPath?: string | null;
    token?: string | null;
    sshAuth?: SshDeployKeyAuth | null;
    caBundlePem?: string | null;
    timeoutMs?: number;
    /**
     * Runs inside the clone lifecycle (before the temp dir is removed) so the
     * caller can discover and stage the complete project from the checkout.
     * Used by the pull/create paths for complete-project materialization.
     */
    onClone?: (cloneDir: string, commitSha: string, envContent: string | null) => Promise<unknown>;
    /**
     * True when this source has fetched successfully before. Turns a ref that
     * now fails to resolve into REF_DELETED (removed or force-pushed) instead
     * of a plain REF_NOT_FOUND, which would read as a mis-typed ref.
     */
    hasPriorHistory?: boolean;
    /**
     * The commit and resolved namespace from the last successful fetch. Used to
     * detect force-pushes and ref-kind changes when the symbolic ref still exists.
     */
    priorIdentity?: { commitSha: string; kind: RefKind };
}

export interface FetchResult {
    composeFiles: ComposeFile[];
    envContent: string | null;
    commitSha: string;
    /**
     * The namespace the configured ref resolved through. Recorded wherever the
     * commit is persisted so "tag v1 -> <sha>" and "branch v1 -> <sha>" stay
     * distinguishable in revision state.
     */
    resolvedRefKind: RefKind;
    /**
     * Non-fatal issues detected during the fetch (e.g. the repo uses
     * submodules that are not cloned). The stack is still usable but the
     * UI should surface these so the user is not surprised later.
     */
    warnings: string[];
    /** Set when an onClone hook ran (complete-project materialization). */
    materialization?: MaterializationResult | null;
}

/** Result of discovery + candidate staging inside the clone lifecycle. */
export interface MaterializationResult {
    inventory: InventoryResult;
    contextCopyPlans: ContextCopyPlan[];
    candidateRelPath: string;
    validation: { ok: boolean; error?: string };
}

export interface UpsertInput {
    stackName: string;
    repoUrl: string;
    branch: string;
    composePaths: string[];
    contextDir: string | null;
    syncEnv: boolean;
    envPath: string | null;
    authType: GitSourceAuthType;
    token?: string | null;  // undefined = keep existing, '' = clear, non-empty = replace
    deployKey?: string | null;
    sshKnownHostsEntry?: string | null;
    sshHostKeyFingerprint?: string | null;
    caBundle?: string | null;  // undefined = keep existing, '' = clear, non-empty = replace
    removeCaBundle?: boolean;  // explicit user-initiated revocation; overrides caBundle omission
    autoApplyOnWebhook: boolean;
    autoDeployOnApply: boolean;
    sourcePolicy?: SourcePolicy;  // explicit tri-state policy; wins over the boolean
    auditContext?: {
        username: string;
        method: string;
        path: string;
        ipAddress: string;
    };
}

export interface CreateStackFromGitInput {
    stackName: string;
    repoUrl: string;
    branch: string;
    composePaths: string[];
    contextDir: string | null;
    syncEnv: boolean;
    envPath: string | null;
    authType: GitSourceAuthType;
    token: string | null;
    deployKey?: string | null;
    sshKnownHostsEntry?: string | null;
    sshHostKeyFingerprint?: string | null;
    caBundle?: string | null;
    autoApplyOnWebhook: boolean;
    autoDeployOnApply: boolean;
    /** Explicit tri-state policy; wins over the boolean (create defaults to review without one). */
    sourcePolicy?: SourcePolicy;
    auditContext?: {
        username: string;
        method: string;
        path: string;
        ipAddress: string;
    };
}

export interface CreateStackFromGitResult {
    source: PublicGitSource;
    commitSha: string;
    envWritten: boolean;
    warnings: string[];
}

export interface PullResult {
    commitSha: string;
    validation: { ok: boolean; error?: string };
    /** Tolerated (non-actionable) refusals from complete-project discovery. */
    refusals: RefusalInfo[];
    /** Projection of the current managed-project manifest, when one exists. */
    manifestSummary: ManifestSummary | null;
    /** True when a validated candidate is staged and ready to apply. */
    candidateReady: boolean;
    /** Clone-time warnings (submodules present, for example). */
    warnings: string[];
    plan: PublicGitChangePlan | null;
    planFingerprint: string | null;
}

export interface PublicPendingPlanView {
    fingerprint: string;
    blocked: boolean;
    counts: GitChangePlanCounts;
    operations: PublicGitChangePlanOperation[];
}

export interface PublicGitSource {
    id: number;
    stack_name: string;
    repo_url: string;
    branch: string;
    compose_path: string;
    compose_paths: string[];
    context_dir: string | null;
    sync_env: boolean;
    env_path: string | null;
    auth_type: GitSourceAuthType;
    has_token: boolean;
    has_deploy_key: boolean;
    has_ca_bundle: boolean;
    ssh_host_key_fingerprint: string | null;
    auto_apply_on_webhook: boolean;
    auto_deploy_on_apply: boolean;
    last_applied_commit_sha: string | null;
    pending_commit_sha: string | null;
    pending_fetched_at: number | null;
    created_at: number;
    updated_at: number;
    /** Managed-project manifest cache state (DB-only enum, see gitProjectManifest.ts). */
    manifest_state: GitSourceManifestState | null;
    pending_plan: PublicPendingPlanView | null;
    last_plan_fingerprint: string | null;
    last_plan_outcome: string | null;
}

export interface GitApplyOpts {
    deploy?: boolean;
    actor?: string;
    bypassPolicy?: boolean;
    planFingerprint?: string;
    /** Public apply requires a fingerprint. Webhook and internal callers pass false. */
    requirePlanFingerprint?: boolean;
}

type GitApplyResult = {
    applied: boolean;
    deployed: boolean;
    deployError?: string;
    recoveryId?: string;
};

type WorkOutcome<T> =
    | { status: 'fulfilled'; value: T }
    | { status: 'rejected'; reason: unknown };

type SharedExecution<T> = WorkOutcome<T> & { result: ReconcileResult };

type LeaderCompletion<T> = {
    execution: SharedExecution<T>;
    settled: boolean;
};

/**
 * In-process executions keyed by a request-derived execution key: the
 * operation id each reservation minted, and the promise a later joiner awaits
 * instead of repeating the work.
 */
type InFlightMap<T> = Map<string, { operationId: string; promise: Promise<LeaderCompletion<T>> }>;

type ExecutionSubmission<T> =
    | { kind: 'executed'; execution: SharedExecution<T> }
    | { kind: 'replayed'; result: ReconcileResult };

type WebhookPullResult = { status: 'success' | 'skipped' | 'error'; message: string };

// ─── Constants ───────────────────────────────────────────────────────────────

const TEMP_DIR_PREFIX = 'sencho-git-';
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const TEMP_DIR_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const WEBHOOK_DEBOUNCE_MS = 10_000;

// Ceiling on the on-disk size of a single clone workspace before the fetch
// is killed. Enforced by a watchdog that stats the workspace during the
// clone (the native git transport streams the pack straight to disk, so
// unlike the previous HTTP client there is no byte counter to hook). Paired
// with MAX_REPO_FILE_BYTES and the timeout. Generous default; operators
// with a legitimately large monorepo can raise it via GITSOURCE_MAX_CLONE_BYTES.
const DEFAULT_MAX_CLONE_BYTES = 100 * 1024 * 1024; // 100 MB

// Per-file ceiling for the compose/env file read into memory after the clone.
// These files are KB-scale in practice; the clone byte cap bounds the total
// on-disk workspace, not any single file within it, so this guards the
// in-memory read against one outsized file inside an otherwise in-budget
// checkout.
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
 * message before it lands in a log or an API response. Git errors tend to
 * include the fetch URL; if a PAT ever leaks into a URL (we never send one,
 * but be defensive), strip it here.
 */
function scrubCredentials(message: string): string {
    return message
        .replace(/https?:\/\/[^/\s:@]+:[^/\s@]+@/gi, 'https://***:***@')
        .replace(/(authorization[:=]\s*)[^\s,;]+/gi, '$1***')
        .replace(/(token[:=]\s*)[^\s,;]+/gi, '$1***')
        .replace(/(password[:=]\s*)[^\s,;]+/gi, '$1***');
}

/**
 * Strip absolute DATA_DIR / candidate paths from compose validation stderr
 * before it reaches the API, so operators never see host layout details.
 * Only remove directory prefixes (root + separator), never a bare substring
 * that could corrupt a longer path (for example `data` inside `database`).
 */
function scrubInternalPaths(message: string, ...roots: Array<string | null | undefined>): string {
    let out = message;
    for (const root of roots) {
        if (!root) continue;
        for (const variant of new Set([root, root.replace(/\\/g, '/'), root.replace(/\//g, '\\')])) {
            if (!variant) continue;
            const prefixes =
                variant.endsWith('/') || variant.endsWith('\\')
                    ? [variant]
                    : [`${variant}/`, `${variant}\\`];
            for (const prefix of prefixes) {
                out = out.split(prefix).join('');
            }
        }
    }
    // Catch any remaining absolute .../git-managed/... path (temp dirs, other nodes).
    out = out.replace(/(?:[A-Za-z]:)?(?:\/|\\)[^\s"']*?(?:\/|\\)git-managed(?:\/|\\)[^\s"']*/gi, '[managed-path]');
    return out.replace(/\/{2,}/g, '/').replace(/\\{2,}/g, '\\').trim();
}

function publicComposeValidationError(
    stderr: string,
    exitCode: number,
    ...roots: Array<string | null | undefined>
): string {
    const text = stderr.trim() || `docker compose exited with code ${exitCode}`;
    return scrubCredentials(scrubInternalPaths(text, ...roots));
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
 * The fetch does not resolve LFS, so if the compose or env file is
 * tracked through LFS we would silently write the pointer as content.
 * Detect this and refuse, with a clear error, before it ever lands on
 * disk.
 */
const LFS_POINTER_PREFIX = 'version https://git-lfs.github.com/spec/v';

export function isLfsPointer(content: string): boolean {
    // Pointer files are a few lines of ASCII, always starting with the
    // version header on the first line. Check just the leading bytes so
    // a very large plain file does not trigger a full scan.
    return content.slice(0, LFS_POINTER_PREFIX.length) === LFS_POINTER_PREFIX;
}

/**
 * Check whether the cloned tree references Git submodules. We do not
 * fetch submodule contents (clones run with --no-recurse-submodules), so
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
    // Bound the in-memory read. The clone byte cap only limits the total
    // on-disk workspace, not any single file within it, so reject an
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

const REF_DELETED_MESSAGE =
    'The configured branch, tag, or commit no longer points at the same revision as before. It may have been deleted, force-pushed, or moved to a different commit (for example a retagged release).';

function priorFetchIdentity(app: GitOpsApplicationRow | null | undefined): FetchParams['priorIdentity'] {
    if (!app?.fetched_commit_sha) return undefined;
    let kind = app.fetched_resolved_ref_kind;
    if (!kind) {
        const genId = app.candidate_generation_id ?? app.accepted_generation_id;
        if (genId) {
            kind = GitOpsStore.getInstance().getGeneration(genId)?.resolved_ref_kind ?? null;
        }
    }
    return {
        commitSha: app.fetched_commit_sha,
        kind: kind ?? 'branch',
    };
}

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

/** Module-level boot hook for the managed-area sweep (see sweepOrphans). */
export async function sweepGitManifestOrphans(): Promise<void> {
    await GitSourceService.getInstance().sweepOrphans();
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
            compose_paths: src.compose_paths,
            context_dir: src.context_dir,
            sync_env: src.sync_env,
            env_path: src.env_path,
            auth_type: src.auth_type,
            has_token: !!src.encrypted_token,
            has_deploy_key: !!src.encrypted_deploy_key,
            has_ca_bundle: !!src.encrypted_ca_bundle,
            ssh_host_key_fingerprint: src.ssh_host_key_fingerprint ?? null,
            // source_policy is authoritative; the legacy boolean is projected
            // from it (automatic only) so old clients keep working. When no
            // application row models the source yet, effectiveAutoApply falls
            // back to the stored boolean.
            auto_apply_on_webhook: this.effectiveAutoApply(src.stack_name, !!src.auto_apply_on_webhook),
            auto_deploy_on_apply: src.auto_deploy_on_apply,
            last_applied_commit_sha: src.last_applied_commit_sha,
            pending_commit_sha: src.pending_commit_sha,
            pending_fetched_at: src.pending_fetched_at,
            created_at: src.created_at,
            updated_at: src.updated_at,
            manifest_state: src.manifest_state ?? 'absent',
            pending_plan: this.parsePendingPlanSummary(src.pending_plan_summary),
            last_plan_fingerprint: src.last_plan_fingerprint,
            last_plan_outcome: src.last_plan_outcome,
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

    private resolveSshTrustFromKnownHostsEntry(
        knownHostsEntry: string,
        clientFingerprint?: string | null,
    ): { sshKnownHostsEntry: string; sshHostKeyFingerprint: string } {
        const sshKnownHostsEntry = knownHostsEntry.trim();
        const derived = fingerprintFromKnownHostsLine(sshKnownHostsEntry);
        if (!derived) {
            throw new GitSourceError('GIT_ERROR', 'SSH known_hosts entry is invalid or incomplete.');
        }
        const trimmedClient = clientFingerprint?.trim();
        if (trimmedClient && trimmedClient !== derived) {
            throw new GitSourceError('GIT_ERROR', 'SSH host key fingerprint does not match the trusted key entry.');
        }
        return { sshKnownHostsEntry, sshHostKeyFingerprint: derived };
    }

    private recordSshTrustAudit(args: {
        stackName: string;
        username: string;
        method: string;
        path: string;
        ipAddress: string;
        fingerprint: string;
        action: 'created' | 'rotated';
    }): void {
        try {
            DatabaseService.getInstance().insertAuditLog({
                timestamp: Date.now(),
                username: args.username,
                method: args.method,
                path: args.path,
                status_code: 200,
                node_id: null,
                ip_address: args.ipAddress,
                summary: `git_source.ssh_trust_${args.action}: stack=${args.stackName} fingerprint=${args.fingerprint}`,
            });
        } catch (err) {
            console.warn('[GitSource] SSH trust audit write failed:', sanitizeForLog(String(err)));
        }
    }

    private maybeRecordSshTrustAudit(
        auditContext: UpsertInput['auditContext'],
        stackName: string,
        fingerprint: string,
        action: 'created' | 'rotated',
    ): void {
        if (!auditContext) return;
        this.recordSshTrustAudit({ ...auditContext, stackName, fingerprint, action });
    }

    private resolveTransportAuth(src: Pick<StackGitSource, 'auth_type' | 'encrypted_token' | 'encrypted_deploy_key' | 'ssh_known_hosts_entry' | 'encrypted_ca_bundle'>): {
        token?: string | null;
        sshAuth?: SshDeployKeyAuth | null;
        caBundlePem?: string | null;
    } {
        const caBundlePem = src.encrypted_ca_bundle ? this.crypto.decrypt(src.encrypted_ca_bundle) : null;
        if (src.auth_type === 'token') {
            return {
                token: src.encrypted_token ? this.crypto.decrypt(src.encrypted_token) : null,
                caBundlePem,
            };
        }
        if (src.auth_type === 'deploy_key') {
            if (!src.encrypted_deploy_key || !src.ssh_known_hosts_entry) {
                return { sshAuth: null, caBundlePem };
            }
            return {
                sshAuth: {
                    privateKey: this.crypto.decrypt(src.encrypted_deploy_key),
                    knownHostsEntry: src.ssh_known_hosts_entry,
                },
                caBundlePem,
            };
        }
        return { token: null, caBundlePem };
    }

    private resolveEncryptedCaBundle(
        caBundle: string | null | undefined,
        removeCaBundle: boolean | undefined,
        existing?: StackGitSource,
    ): string | null {
        // Explicit revocation always wins, even when the field is omitted:
        // the operator clicked "Remove stored CA" and the value field is
        // left empty (matching the write-only input), so we must not silently
        // preserve the stored bundle.
        if (removeCaBundle === true) return null;
        if (caBundle === undefined) return existing?.encrypted_ca_bundle ?? null;
        if (caBundle === null || caBundle === '') return null;
        const validated = validateCaBundlePem(caBundle);
        if (!validated) {
            throw new GitSourceError(
                'GIT_ERROR',
                'Custom CA bundle must contain one or more PEM certificates.',
            );
        }
        return this.crypto.encrypt(validated);
    }

    private decryptCaBundlePem(encrypted: string | null | undefined): string | null {
        if (!encrypted) return null;
        return this.crypto.decrypt(encrypted);
    }

    public async upsert(input: UpsertInput): Promise<PublicGitSource> {
        const db = DatabaseService.getInstance();
        const existing = db.getGitSource(input.stackName);

        // Determine stored credentials per auth type.
        let encryptedToken: string | null = null;
        let encryptedDeployKey: string | null = null;
        let sshKnownHostsEntry: string | null = null;
        let sshHostKeyFingerprint: string | null = null;
        const encryptedCaBundle = this.resolveEncryptedCaBundle(input.caBundle, input.removeCaBundle, existing);
        const caBundlePem = this.decryptCaBundlePem(encryptedCaBundle);

        if (input.authType === 'none') {
            // all null
        } else if (input.authType === 'token') {
            if (input.token === undefined) {
                encryptedToken = existing?.encrypted_token ?? null;
            } else if (input.token === null || input.token === '') {
                encryptedToken = null;
            } else {
                encryptedToken = this.crypto.encrypt(input.token);
            }
        } else if (input.authType === 'deploy_key') {
            if (input.deployKey === undefined) {
                encryptedDeployKey = existing?.encrypted_deploy_key ?? null;
            } else if (input.deployKey === null || input.deployKey === '') {
                encryptedDeployKey = null;
            } else {
                encryptedDeployKey = this.crypto.encrypt(input.deployKey);
            }
            if (input.sshKnownHostsEntry === undefined) {
                sshKnownHostsEntry = existing?.ssh_known_hosts_entry ?? null;
                sshHostKeyFingerprint = existing?.ssh_host_key_fingerprint ?? null;
            } else if (input.sshKnownHostsEntry === null || input.sshKnownHostsEntry.trim() === '') {
                sshKnownHostsEntry = null;
                sshHostKeyFingerprint = null;
            } else {
                const trust = this.resolveSshTrustFromKnownHostsEntry(
                    input.sshKnownHostsEntry,
                    input.sshHostKeyFingerprint,
                );
                sshKnownHostsEntry = trust.sshKnownHostsEntry;
                sshHostKeyFingerprint = trust.sshHostKeyFingerprint;
            }
            if (!encryptedDeployKey || !sshKnownHostsEntry) {
                throw new GitSourceError(
                    'GIT_ERROR',
                    'Deploy key authentication requires a private key and a trusted SSH host key.',
                );
            }
        }

        // Apply-matrix sanity: auto-deploy requires the effective policy to be
        // automatic. Legacy clients express that through the boolean; existing
        // manual rows are protected by the no-silent-conversion derivation.
        const existingApp = this.gitopsApplicationFor(input.stackName);
        const effectivePolicy = GitSourceService.resolveSourcePolicy(
            existingApp?.source_policy ?? null,
            input,
        );
        if (input.autoDeployOnApply && effectivePolicy !== 'automatic') {
            throw new GitSourceError('GIT_ERROR', 'Auto-deploy requires the automatic source policy.');
        }

        // Repository identity changes on a managed stack deadlock: the manifest
        // file is stamped with the old repo/branch, and every subsequent apply
        // refuses it as untrusted forever (a pull stages a new pending blob but
        // never replaces the manifest file). Require a detach (the export
        // contract flattens the effective model into compose.yaml) before
        // re-pointing the source.
        const identityChanged = !!existing && (existing.repo_url !== input.repoUrl || existing.branch !== input.branch);
        if (identityChanged) {
            const manifestSvc = GitProjectManifestService.getInstance();
            const manifest = await manifestSvc.readManifest(input.stackName, existing.repo_url, existing.branch);
            if (manifest !== null) {
                throw new GitSourceError(
                    'GIT_ERROR',
                    'Changing the repository or branch of a stack with a managed project is not supported. Detach the Git source first (the effective compose model is exported to compose.yaml), then re-link the source to the new repository or branch.',
                );
            }
        }

        // Dry-run reachability check before persisting. Fetches every configured
        // file so a bad path in the ordered list is caught at save time.
        //
        // Skipped for an explicit CA removal: removing the one CA a server
        // needs to be reached makes this exact fetch fail, which would refuse
        // the removal itself with a TLS error and leave the operator unable to
        // retire a CA they no longer trust. The intent behind
        // `remove_ca_bundle: true` is unambiguous, so the save proceeds and the
        // next pull reports the real reachability state.
        if (!input.removeCaBundle) {
            const fetchAuth = input.authType === 'token'
                ? { token: encryptedToken ? this.crypto.decrypt(encryptedToken) : null }
                : input.authType === 'deploy_key'
                    ? {
                        sshAuth: {
                            privateKey: this.crypto.decrypt(encryptedDeployKey!),
                            knownHostsEntry: sshKnownHostsEntry!,
                        },
                    }
                    : { token: null };
            await this.fetchFromGit({
                repoUrl: input.repoUrl,
                branch: input.branch,
                composePaths: input.composePaths,
                envPath: input.syncEnv ? input.envPath : null,
                ...fetchAuth,
                caBundlePem,
            });
        }

        const resolvedEnvPath = input.syncEnv ? input.envPath : null;
        // A pending pull captured the files/contextDir for the previous config. If
        // any of those change, that pending blob would apply the wrong files, so
        // clear it; the user re-pulls against the new config.
        const configChanged = !!existing && (
            existing.repo_url !== input.repoUrl ||
            existing.branch !== input.branch ||
            JSON.stringify(existing.compose_paths) !== JSON.stringify(input.composePaths) ||
            existing.sync_env !== input.syncEnv ||
            (existing.env_path ?? null) !== resolvedEnvPath ||
            (existing.context_dir ?? null) !== input.contextDir
        );

        const gitopsConfig = {
            repoUrl: input.repoUrl,
            branch: input.branch,
            composePaths: input.composePaths,
            contextDir: input.contextDir,
            syncEnv: input.syncEnv,
            envPath: resolvedEnvPath,
        };
        const gitopsIdentity = directSourceIdentity(gitopsConfig);

        // The source row, the pending clear, and the GitOps transition commit
        // together. Clearing pending without invalidating the candidate would
        // leave the model offering an apply for files the operator can no
        // longer produce. A refused transition (an operation went in flight)
        // aborts the whole save; it is mapped below so the operator sees the
        // specific refusal, not a generic 500.
        try {
            db.getDb().transaction(() => {
            db.upsertGitSource({
                stack_name: input.stackName,
                repo_url: input.repoUrl,
                branch: input.branch,
                compose_path: input.composePaths[0],
                compose_paths: input.composePaths,
                context_dir: input.contextDir,
                sync_env: input.syncEnv,
                env_path: resolvedEnvPath,
                auth_type: input.authType,
                encrypted_token: encryptedToken,
                encrypted_deploy_key: encryptedDeployKey,
                ssh_known_hosts_entry: sshKnownHostsEntry,
                ssh_host_key_fingerprint: sshHostKeyFingerprint,
                encrypted_ca_bundle: encryptedCaBundle,
                auto_apply_on_webhook: effectivePolicy === 'automatic',
                auto_deploy_on_apply: input.autoDeployOnApply,
                last_applied_commit_sha: existing?.last_applied_commit_sha ?? null,
                last_applied_content_hash: existing?.last_applied_content_hash ?? null,
                pending_commit_sha: existing?.pending_commit_sha ?? null,
                pending_compose_content: existing?.pending_compose_content ?? null,
                pending_env_content: existing?.pending_env_content ?? null,
                pending_fetched_at: existing?.pending_fetched_at ?? null,
                last_debounce_at: existing?.last_debounce_at ?? null,
            });

            const app = this.gitopsApplicationFor(input.stackName);
            if (configChanged || !app) {
                db.clearGitSourcePending(input.stackName);
            }

            const envelope = this.gitopsEnvelope(crypto.randomUUID(), 'system:git-source', 'configure');
            if (!app && !this.gitopsNameHeld(input.stackName)) {
                // Linking a stack that already exists. Nothing is fetched or
                // accepted yet, so the application starts live with no desired
                // commit and the projection asks for a fetch.
                GitOpsTransitions.getInstance().activateDirect({
                    application: buildDirectApplicationRow({
                        id: newGitOpsId(),
                        stackName: input.stackName,
                        config: gitopsConfig,
                        identity: gitopsIdentity,
                        lifecycleStatus: 'active',
                        at: envelope.at,
                    }, effectivePolicy),
                    nodeId: NodeRegistry.getInstance().getDefaultNodeId(),
                    envelope,
                });
                return;
            }
            // Credential-only and policy-only edits change nothing material, so
            // they leave the candidate and every accepted pointer alone.
            if (app && configChanged) {
                GitOpsTransitions.getInstance().configChangedPendingCleared({
                    applicationId: app.id,
                    identity: {
                        repoUrl: gitopsIdentity.repoUrl,
                        repoIdentityJson: JSON.stringify(gitopsIdentity.identity),
                        configuredRef: input.branch,
                    },
                    material: {
                        composePathsJson: JSON.stringify([...input.composePaths]),
                        contextDir: input.contextDir,
                        syncEnv: input.syncEnv ? 1 : 0,
                        envPath: resolvedEnvPath,
                        fingerprint: gitopsIdentity.fingerprint,
                    },
                    envelope,
                });
            }
            // A boolean 0 or absent resolves to the existing policy and never
            // silently converts it; only an actual change writes the
            // transition.
            if (app && app.source_policy !== effectivePolicy) {
                GitOpsTransitions.getInstance().sourcePolicyChanged(app.id, effectivePolicy, envelope);
            }
        })();
        } catch (error) {
            if (error instanceof GitOpsTransitionError) {
                throw new GitSourceError('OPERATION_IN_FLIGHT', `Cannot save the Git source for ${input.stackName}: ${error.message}`);
            }
            throw error;
        }

        if (
            input.authType === 'deploy_key'
            && input.sshKnownHostsEntry !== undefined
            && sshKnownHostsEntry
            && sshHostKeyFingerprint
        ) {
            const priorKnownHosts = existing?.ssh_known_hosts_entry ?? null;
            if (priorKnownHosts !== sshKnownHostsEntry) {
                this.maybeRecordSshTrustAudit(
                    input.auditContext,
                    input.stackName,
                    sshHostKeyFingerprint,
                    priorKnownHosts ? 'rotated' : 'created',
                );
            }
        }

        return this.get(input.stackName)!;
    }

    /**
     * Detach a Git source under the export contract: render the effective
     * compose model into a single compose.yaml, keep the materialized files,
     * remove the managed area, then drop the row. Ordering guarantees every
     * failure leaves the stack and the row intact; the render is deterministic
     * per disk state, so a late failure leaves detach safely re-runnable.
     */
    public async detach(stackName: string): Promise<void> {
        return this.withStackLock(stackName, async () => {
            const src = DatabaseService.getInstance().getGitSource(stackName);
            if (!src) throw new GitSourceError('GIT_ERROR', 'No Git source configured for this stack.');
            const manifestSvc = GitProjectManifestService.getInstance();
            await manifestSvc.recoverInterruptedDetach(stackName, src.repo_url, src.branch);

            // Phase 1: render the effective model. A render failure aborts
            // before anything on disk changes.
            const rendered = await manifestSvc.exportForDetach(stackName, () =>
                ComposeService.getInstance().renderComposeYaml(stackName),
            );

            // Phase 2: snapshot compose.yaml and every managed override so a
            // mid-detach failure can restore the exact pre-detach state.
            const manifest = await manifestSvc.readManifest(stackName, src.repo_url, src.branch);
            // A corrupt manifest means the stack's ownership status is unknown:
            // detach cannot know which files are auto-discovered overrides and
            // must not proceed. A missing manifest means the stack was never
            // materialized, so there are no managed overrides to clean up.
            if (manifest !== null && 'corrupt' in manifest) {
                throw new GitSourceError('GIT_ERROR', 'Managed-project manifest cannot be trusted; detach aborted. Pull to rebuild before detaching.');
            }
            const snapshotFileLimit = manifest?.bounds.maxFileBytes ?? manifestSvc.boundsConfig().maxFileBytes;
            let priorCompose: Buffer | null = null;
            try {
                const content = await FileSystemService.getInstance().readStackFile(stackName, 'compose.yaml', snapshotFileLimit, { forceText: true });
                if (content.oversized || content.content === undefined) {
                    throw new GitSourceError('GIT_ERROR', 'compose.yaml cannot be snapshotted within the managed file-size limit; detach aborted.');
                }
                priorCompose = Buffer.from(content.content, 'utf8');
            } catch (e) {
                if (e instanceof GitSourceError) throw e;
                if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
                    const cause = e instanceof Error ? e.message : String(e);
                    console.error(`[GitSource] compose snapshot read failed for ${sanitizeForLog(stackName)}:`, sanitizeForLog(cause));
                    throw new GitSourceError('GIT_ERROR', 'Cannot read compose.yaml for snapshot; detach aborted.');
                }
            }
            const overrideSnapshots: Array<{ path: string; content: Buffer }> = [];
            // Only AUTO-DISCOVERED implicit overrides are removed: an explicit
            // compose file, config, secret, or include that happens to share the
            // basename is part of the rendered model and must survive detach.
            const managedOverridePaths = manifest?.inputs
                .flatMap((entry) => entry.ownership === 'managed' && entry.dependencyKind === 'implicit-override' && entry.materializedPath !== null ? [entry.materializedPath] : []) ?? [];
            for (const overridePath of managedOverridePaths) {
                try {
                    const content = await FileSystemService.getInstance().readStackFile(stackName, overridePath, snapshotFileLimit, { forceText: true });
                    if (content.oversized || content.content === undefined) {
                        throw new GitSourceError('GIT_ERROR', `Override ${overridePath} cannot be snapshotted within the managed file-size limit; detach aborted.`);
                    }
                    overrideSnapshots.push({ path: overridePath, content: Buffer.from(content.content, 'utf8') });
                } catch (e) {
                    if (e instanceof GitSourceError) throw e;
                    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
                        const cause = e instanceof Error ? e.message : String(e);
                        console.error(`[GitSource] override snapshot read failed for ${sanitizeForLog(stackName)}:`, sanitizeForLog(cause));
                        throw new GitSourceError('GIT_ERROR', `Cannot read override ${overridePath} for snapshot; detach aborted.`);
                    }
                    // ENOENT: file not present on disk; nothing to snapshot.
                }
            }

            // The snapshot lives in the managed area and is restored by the
            // boot sweep if the process exits before the database commit point.
            const detachSnapshots = [
                priorCompose !== null
                    ? { path: 'compose.yaml', existed: true as const, content: priorCompose }
                    : { path: 'compose.yaml', existed: false as const, content: null },
                ...overrideSnapshots.map((snapshot) => ({ path: snapshot.path, existed: true as const, content: snapshot.content })),
            ];
            await manifestSvc.prepareDetachRecovery(stackName, src.repo_url, src.branch, detachSnapshots);

            // Phase 3: write the flattened compose.yaml, then delete
            // overrides. If anything fails, restore compose.yaml and every
            // deleted override so the stack is byte-identical to pre-detach.
            let areaStaged = false;
            const rollback = async (): Promise<'complete' | 'missing' | 'failed'> => {
                try {
                    let restored: boolean;
                    if (areaStaged) {
                        restored = await manifestSvc.rollbackStagedDetach(stackName, src.repo_url, src.branch);
                        areaStaged = false;
                    } else {
                        restored = await manifestSvc.recoverInterruptedDetach(stackName, src.repo_url, src.branch);
                    }
                    if (!restored) {
                        console.error(`[GitSource] detach rollback for ${sanitizeForLog(stackName)} found no recovery snapshot`);
                        return 'missing';
                    }
                } catch (e) {
                    const cause = e instanceof Error ? e.message : String(e);
                    console.error(`[GitSource] detach rollback failed for ${sanitizeForLog(stackName)}:`, sanitizeForLog(cause));
                    return 'failed';
                }
                return 'complete';
            };
            const rollbackAndThrow = async (message: string, cause?: unknown): Promise<never> => {
                if (cause !== undefined) {
                    const causeMessage = cause instanceof Error ? cause.message : String(cause);
                    console.error(`[GitSource] detach failed for ${sanitizeForLog(stackName)}:`, sanitizeForLog(causeMessage));
                }
                const rollbackResult = await rollback();
                let outcome = 'detach rolled back.';
                if (rollbackResult === 'failed') {
                    outcome = 'detach rollback is incomplete; restart Sencho to retry recovery.';
                } else if (rollbackResult === 'missing') {
                    outcome = 'detach rollback could not find its recovery snapshot; inspect the stack files before retrying.';
                }
                throw new GitSourceError('GIT_ERROR', `${message}; ${outcome} Retry to complete it.`);
            };
            try {
                await FileSystemService.getInstance().saveStackContent(stackName, rendered);
            } catch (e) {
                await rollbackAndThrow('Could not write the detached compose model', e);
            }

            for (const snapshot of overrideSnapshots) {
                try {
                    await FileSystemService.getInstance().deleteStackPath(stackName, snapshot.path, false);
                } catch (e) {
                    await rollbackAndThrow(`Could not remove auto-discovered override ${snapshot.path}`, e);
                }
            }

            // Phase 4: stage the managed area, then delete the row as the
            // commit point. A database failure puts the area back and restores
            // the durable file snapshot. A crash before the commit is handled
            // by the boot sweep; a crash after it leaves an orphan stage that
            // the normal orphan sweep removes.
            try {
                areaStaged = await manifestSvc.stageManagedAreaForDetach(stackName);
            } catch (e) {
                await rollbackAndThrow('Could not stage the managed project data', e);
            }
            if (!areaStaged) {
                await rollbackAndThrow('Managed project data disappeared during detach');
            }
            try {
                // The source row and the GitOps tombstones commit together, so
                // a detached stack can never leave a live application pointing
                // at a source that no longer exists. Configured identity and
                // SHA pointers survive on the tombstone as frozen facts, and a
                // later reattach mints a new application rather than reviving
                // this one.
                const gitopsApp = this.gitopsApplicationFor(stackName);
                DatabaseService.getInstance().getDb().transaction(() => {
                    DatabaseService.getInstance().deleteGitSource(stackName);
                    if (!gitopsApp) return;
                    const tx = GitOpsTransitions.getInstance();
                    const envelope = this.gitopsEnvelope(crypto.randomUUID(), 'system:git-source', 'detach');
                    for (const target of GitOpsStore.getInstance().listTargets(gitopsApp.id)) {
                        if (target.target_status !== 'active') continue;
                        tx.targetTombstoned(gitopsApp.id, target.node_id, envelope);
                    }
                    tx.applicationTombstoned(gitopsApp.id, 'detached', envelope);
                })();
            } catch (e) {
                await rollbackAndThrow('Could not commit the Git source removal', e);
            }
            if (!(await manifestSvc.finalizeStagedDetach(stackName))) {
                console.warn(`[GitManifest] detach for ${sanitizeForLog(stackName)} committed with managed cleanup pending`);
            }
        });
    }

    /** The managed-project manifest for a stack, when it exists and is trusted. */
    public async getManifest(stackName: string): Promise<GitProjectManifest | null> {
        const src = DatabaseService.getInstance().getGitSource(stackName);
        if (!src) return null;
        const manifest = await GitProjectManifestService.getInstance().readManifest(stackName, src.repo_url, src.branch);
        return manifest !== null && !('corrupt' in manifest) ? manifest : null;
    }

    /**
     * Summary projection of the managed-project manifest. When the manifest
     * FILE is absent or cannot be trusted, the summary is synthesized from the
     * DB cache so the UI can render the actual state ('absent' /
     * 'migration_required') instead of treating corruption as "nothing".
     */
    public async getManifestSummary(stackName: string): Promise<ManifestSummary | null> {
        const src = DatabaseService.getInstance().getGitSource(stackName);
        if (!src) return null;
        const manifestSvc = GitProjectManifestService.getInstance();
        const manifest = await manifestSvc.readManifest(stackName, src.repo_url, src.branch);
        if (manifest !== null && !('corrupt' in manifest)) {
            return manifestSvc.summaryFrom(manifest);
        }
        // No manifest file (or an untrusted one). When the DB cache claims an
        // applied state but the file is gone, report migration_required
        // instead of manufacturing a healthy state: the manifest may have
        // been lost and the stack's ownership is unknown.
        let state: GitSourceManifestState;
        if (manifest !== null && 'corrupt' in manifest) {
            state = 'migration_required';
        } else {
            const cached = src.manifest_state ?? 'absent';
            state = cached === 'absent' || cached === 'none' ? 'absent' : 'migration_required';
        }
        // Heal the flat cache so the same GET payload cannot report
        // manifest_state:"active" beside manifest.state:"migration_required".
        // Synthesized absent/migration_required never carries a trusted version.
        if ((src.manifest_state ?? 'absent') !== state) {
            DatabaseService.getInstance().setGitSourceManifestState(stackName, null, state, null);
        }
        return {
            state,
            manifestVersion: 0,
            resolvedCommitSha: null,
            managedCount: 0,
            unmanagedCount: 0,
            refusedCount: 0,
            refused: [],
            hasBuildContexts: false,
            generatedAt: null,
        };
    }

    // ─── Fetch ───────────────────────────────────────────────────────────────

    /**
     * Resolve the configured branch to an immutable commit, clone exactly that
     * snapshot into a throwaway workspace, run `fn` against the checkout, and
     * always clean up. Centralizes resolution, the fetch timeout, the size
     * watchdog, commit verification, and the submodule warning so both
     * fetchFromGit (reads compose/env files) and listRepoTree (lists the
     * working tree) share one hardened path. Transport mechanics live in
     * `./git/nativeGitTransport`; failures arrive pre-classified or as
     * structured transport failures mapped below.
     */
    private async withClonedRepo<T>(
        params: {
            repoUrl: string;
            branch: string;
            token?: string | null;
            sshAuth?: SshDeployKeyAuth | null;
            caBundlePem?: string | null;
            timeoutMs?: number;
            hasPriorHistory?: boolean;
            priorIdentity?: { commitSha: string; kind: RefKind };
        },
        fn: (dir: string, commitSha: string, warnings: string[], resolvedRefKind: RefKind) => Promise<T>,
    ): Promise<T> {
        const { repoUrl, branch, token, sshAuth, caBundlePem } = params;
        const timeoutMs = params.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
        const root = await createTempDir();
        const hasPriorHistory = params.hasPriorHistory === true || params.priorIdentity != null;

        try {
            const resolved = await nativeGitTransport.resolveRef({
                repoUrl,
                ref: branch,
                token,
                sshAuth,
                caBundlePem,
                timeoutMs,
                workspaceRoot: root,
            });
            if (params.priorIdentity) {
                const prior = params.priorIdentity;
                if (prior.kind !== resolved.kind) {
                    throw new GitSourceError('REF_DELETED', REF_DELETED_MESSAGE);
                }
                if (prior.kind !== 'sha' && prior.commitSha !== resolved.commitSha) {
                    const fastForward = await verifyFastForward({
                        repoUrl,
                        ancestorSha: prior.commitSha,
                        descendantSha: resolved.commitSha,
                        token,
                        sshAuth,
                        caBundlePem,
                        timeoutMs,
                        workspaceRoot: root,
                        maxBytes: maxCloneBytes(),
                    });
                    if (!fastForward) {
                        throw new GitSourceError('REF_DELETED', REF_DELETED_MESSAGE);
                    }
                }
            }
            const fetched = await nativeGitTransport.fetchAtCommit({
                repoUrl,
                ref: branch,
                refKind: resolved.kind,
                token,
                sshAuth,
                caBundlePem,
                timeoutMs,
                commitSha: resolved.commitSha,
                workspaceRoot: root,
                maxBytes: maxCloneBytes(),
            });

            // Submodule detection: non-fatal, surfaced as a warning. Clones run
            // with --no-recurse-submodules, so any path that lives inside a
            // submodule directory will be empty after apply. Users need to know.
            const warnings: string[] = [];
            if (await hasSubmodules(fetched.dir)) {
                console.warn(`[GitSource] Submodules detected in ${repoHost(repoUrl)}; contents not cloned.`);
                warnings.push(SUBMODULE_WARNING);
            }

            return await fn(fetched.dir, fetched.commitSha, warnings, resolved.kind);
        } catch (e) {
            if (isTransportFailure(e)) {
                // The classified message operators see is deliberately
                // sanitized and may be generic (unrecognized stderr); always
                // keep the raw reason and scrubbed stderr tail in the server
                // log so new git wording is diagnosable.
                const detail = scrubCredentials(
                    `reason=${e.reason} exit=${'exitCode' in e ? e.exitCode : '-'} stderr=${('stderr' in e && e.stderr ? e.stderr : '').slice(-600)}`,
                );
                console.error(`[GitSource:transport] host=${sanitizeForLog(e.host)} ${detail}`);
                if (isDebugEnabled() && 'argv' in e && e.argv?.length) {
                    console.error(`[GitSource:transport] argv=[${e.argv.map((a) => sanitizeForLog(a)).join(' ')}]`);
                }
                const classified = classifyGitFailure(e);
                // A ref that resolved before but no longer does is a deletion
                // or force-push, distinct from a mis-typed ref on first link.
                if (classified.code === 'REF_NOT_FOUND' && hasPriorHistory) {
                    throw new GitSourceError('REF_DELETED', REF_DELETED_MESSAGE, { transportReason: e.reason });
                }
                throw new GitSourceError(classified.code, classified.message, { transportReason: e.reason });
            }
            throw e;
        } finally {
            await removeTempDir(root);
        }
    }

    public async fetchFromGit(params: FetchParams): Promise<FetchResult> {
        const { repoUrl, branch, composePaths, envPath, token, sshAuth } = params;

        // Reject any compose/env target that resolves inside the `.git`
        // metadata directory BEFORE we spin up a clone. This blocks a
        // caller from reading `.git/config` (which leaks the remote URL
        // and any mis-configured inline credentials) via the fetch path.
        for (const composePath of composePaths) assertNotGitMeta(composePath, 'compose_path');
        if (envPath) assertNotGitMeta(envPath, 'env_path');

        const startedAt = Date.now();
        const diag = isDebugEnabled();
        if (diag) {
            console.log(sanitizeForLog(
                `[GitSource:diag] fetch start host=${repoHost(repoUrl)} branch=${branch} files=${composePaths.length} envSync=${envPath ? 'true' : 'false'}`,
            ));
        }

        try {
            return await this.withClonedRepo({
                repoUrl,
                branch,
                token,
                sshAuth,
                caBundlePem: params.caBundlePem,
                timeoutMs: params.timeoutMs,
                hasPriorHistory: params.hasPriorHistory,
                priorIdentity: params.priorIdentity,
            }, async (dir, commitSha, warnings, resolvedRefKind) => {
                const composeFiles: ComposeFile[] = [];
                for (const composePath of composePaths) {
                    const content = await readRepoFile(dir, composePath, 'Compose path');
                    if (isLfsPointer(content)) {
                        console.error(`[GitSource] LFS pointer detected in ${sanitizeForLog(composePath)}`);
                        throw new GitSourceError(
                            'GIT_ERROR',
                            `Compose file at ${composePath} is stored in Git LFS, which is not supported. Commit the plain file or replace the LFS pointer before linking this repository.`,
                        );
                    }
                    composeFiles.push({ path: composePath, content });
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

                let materialization: MaterializationResult | null = null;
                if (params.onClone) {
                    materialization = (await params.onClone(dir, commitSha, envContent)) as MaterializationResult | null;
                }

                if (diag) {
                    console.log(
                        `[GitSource:diag] fetch ok host=${sanitizeForLog(repoHost(repoUrl))} branch=${sanitizeForLog(branch)} sha=${commitSha.slice(0, 7)} files=${composeFiles.length} env=${envContent !== null ? 'present' : 'absent'} warnings=${warnings.length} materialized=${materialization !== null} elapsedMs=${Date.now() - startedAt}`
                    );
                }
                return { composeFiles, envContent, commitSha, resolvedRefKind, warnings, materialization };
            });
        } catch (err) {
            if (diag) {
                const msg = err instanceof GitSourceError ? `${err.code}: ${err.message}` : (err as Error).message;
                console.log(
                    `[GitSource:diag] fetch fail host=${sanitizeForLog(repoHost(repoUrl))} branch=${sanitizeForLog(branch)} elapsedMs=${Date.now() - startedAt} err=${sanitizeForLog(scrubCredentials(msg))}`
                );
            }
            throw err;
        }
    }

    /**
     * Clone a repo and list its working-tree files (POSIX-relative, `.git`
     * skipped) for the "browse repository" compose-file picker. Bounded by the
     * same clone size/timeout guards as fetch, plus a file-count cap.
     */
    public async listRepoTree(
        params: {
            repoUrl: string;
            branch: string;
            token?: string | null;
            sshAuth?: SshDeployKeyAuth | null;
            caBundlePem?: string | null;
            timeoutMs?: number;
        },
    ): Promise<{ files: string[]; truncated: boolean; commitSha: string; warnings: string[] }> {
        return this.withClonedRepo(params, async (dir, commitSha, warnings) => {
            const { files, truncated } = await this.walkRepoFiles(dir);
            return { files, truncated, commitSha, warnings };
        });
    }

    private async walkRepoFiles(rootDir: string): Promise<{ files: string[]; truncated: boolean }> {
        const MAX_FILES = 2000;
        const files: string[] = [];
        let truncated = false;
        const walk = async (relDir: string): Promise<void> => {
            if (truncated) return;
            let entries: import('fs').Dirent[];
            try {
                entries = await fsPromises.readdir(path.join(rootDir, relDir), { withFileTypes: true });
            } catch (e) {
                // A readdir failure on a just-cloned subtree silently drops it from the
                // picker; log so a partial listing is traceable (the user can still
                // add paths manually).
                console.warn(`[GitSource] repo walk skipped ${sanitizeForLog(relDir || '.')}:`, (e as Error).message);
                return;
            }
            for (const entry of entries) {
                if (truncated) return;
                if (entry.name === '.git') continue;
                const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
                if (entry.isDirectory()) {
                    await walk(rel);
                } else if (entry.isFile()) {
                    if (files.length >= MAX_FILES) { truncated = true; return; }
                    files.push(rel);
                }
            }
        };
        await walk('');
        files.sort();
        return { files, truncated };
    }

    // ─── Validation ──────────────────────────────────────────────────────────

    /**
     * Validate a compose file by (a) parsing YAML and (b) handing the content
     * to `docker compose config --quiet` in a throwaway temp dir. This is the
     * same validator Compose runs at deploy time, so it catches interpolation
     * errors, invalid `include:` references, etc., which a shallow schema
     * check would miss.
     */
    public async validateCompose(composeFiles: ComposeFile[], envContent: string | null, contextDir: string | null): Promise<{ ok: boolean; error?: string }> {
        if (composeFiles.length === 0) return { ok: false, error: 'No compose files provided.' };

        // Cheap syntax pre-check per file
        for (const file of composeFiles) {
            try {
                const parsed = YAML.parse(file.content);
                if (parsed === null || parsed === undefined) {
                    return { ok: false, error: `Compose file ${file.path} is empty.` };
                }
                if (typeof parsed !== 'object' || Array.isArray(parsed)) {
                    return { ok: false, error: `Compose file ${file.path} must be a YAML mapping.` };
                }
            } catch (e) {
                return { ok: false, error: `YAML parse error in ${file.path}: ${(e as Error).message}` };
            }
        }

        // Semantic check via `docker compose config` over the ordered set, written
        // in the same local layout the deploy materializes (primary -> compose.yaml,
        // additional files under their repo-relative paths), with each path segment
        // re-sanitized for this throwaway dir. So the merge order, project directory,
        // and relative cross-references resolve from the same base the real deploy uses.
        const dir = await createTempDir();
        try {
            const localFiles = gitSourceLocalComposeFiles(composeFiles.map(f => f.path));
            const args = ['compose'];
            for (let i = 0; i < composeFiles.length; i++) {
                const safeRel = localFiles[i].replace(/\\/g, '/').split('/').map(s => path.basename(s)).join('/');
                const abs = path.resolve(dir, safeRel);
                if (!isPathWithinBase(abs, dir)) {
                    return { ok: false, error: `Compose path escapes the validation dir: ${composeFiles[i].path}` };
                }
                await fsPromises.mkdir(path.dirname(abs), { recursive: true });
                await fsPromises.writeFile(abs, composeFiles[i].content, 'utf-8');
                args.push('-f', safeRel);
            }
            if (contextDir) {
                // Inline path-injection barrier at the mkdir sink. CodeQL does not
                // credit the wrapped isPathWithinBase helper, so resolve against a
                // known-safe base and check containment with startsWith right here.
                const baseResolved = path.resolve(dir);
                const ctxAbs = path.resolve(baseResolved, contextDir);
                if (!ctxAbs.startsWith(baseResolved + path.sep)) {
                    return { ok: false, error: 'Context directory escapes the validation dir.' };
                }
                await fsPromises.mkdir(ctxAbs, { recursive: true });
                args.push('--project-directory', ctxAbs);
            }
            if (envContent !== null) {
                const envFile = path.join(dir, '.env');
                await fsPromises.writeFile(envFile, envContent, 'utf-8');
                args.push('--env-file', envFile);
            }
            args.push('config', '--quiet');
            const result = await this.runDockerCompose(args, dir, 10_000);
            if (result.code === 0) return { ok: true };
            return { ok: false, error: publicComposeValidationError(result.stderr, result.code, dir) };
        } finally {
            await removeTempDir(dir);
        }
    }

    /**
     * Complete-project materialization inside the clone lifecycle: discover +
     * classify every declared input, abort on actionable refusals, build the
     * staged candidate (managed files + filtered build contexts), and validate
     * it with candidateValidationEnvFileArgs (not a mix of staged and live
     * --env-file inputs). Includes -p. Runs only when the complete-project
     * contract applies.
     */
    private async buildMaterialization(
        stackName: string,
        cloneDir: string,
        commitSha: string,
        src: { compose_paths: string[]; context_dir: string | null; sync_env: boolean },
        envContent: string | null,
    ): Promise<MaterializationResult> {
        const manifestSvc = GitProjectManifestService.getInstance();
        const bounds = manifestSvc.boundsConfig();

        const inventory = await ComposeInputDiscoveryService.getInstance().discoverFromClone({
            cloneDir,
            composePaths: src.compose_paths,
            contextDir: src.context_dir,
            // The synced stack-root .env owns that path when sync_env is on; the
            // discovery guard makes the repo's interpolation .env unmanaged so it
            // is never hash-guarded against the staged sync content.
            syncEnv: src.sync_env,
            bounds,
        });

        const actionable = inventory.refusals.filter((r) => r.actionable);
        if (actionable.length > 0) {
            // The abort message is a public surface: high-sensitivity refusal
            // paths are redacted before they reach the API.
            const publicRefusals = manifestSvc.toPublicRefusals(actionable);
            const detail = publicRefusals.slice(0, 5).map((r) => r.reason).join('; ');
            throw new GitSourceError('GIT_ERROR', `Cannot materialize the complete project: ${detail}${publicRefusals.length > 5 ? ` (and ${publicRefusals.length - 5} more)` : ''}`);
        }

        // Build-context entries are directories; their content is copied via
        // the context copy plans (dockerignore-filtered), never as files.
        const managed = inventory.inputs.filter(
            (i) =>
                i.ownership === 'managed' &&
                i.materializedPath !== null &&
                i.state === 'present' &&
                i.dependencyKind !== 'build-context' &&
                i.dependencyKind !== 'build-additional-context',
        );
        const candidateRel = await manifestSvc.buildCandidate(
            stackName,
            commitSha,
            cloneDir,
            managed.map((i) => ({ srcRel: i.sourcePath!, destRel: i.materializedPath! })),
            inventory.contextCopyPlans,
            bounds,
        );

        // Stage the synced env into the candidate so validation exercises the
        // exact deploy layout (stack-root .env).
        if (src.sync_env && envContent !== null) {
            const candidateAbs = path.join(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'git-managed', String(NodeRegistry.getInstance().getDefaultNodeId()), stackName, candidateRel);
            await fsPromises.mkdir(candidateAbs, { recursive: true });
            await fsPromises.writeFile(path.join(candidateAbs, '.env'), envContent, 'utf8');
        }

        const validation = await this.validateCandidate(stackName, candidateRel, src.compose_paths, src.context_dir, src.sync_env);
        return { inventory, contextCopyPlans: inventory.contextCopyPlans, candidateRelPath: candidateRel, validation };
    }

    /**
     * Validate the staged candidate with the same -f order, -p project name,
     * and --project-directory deploy will use, run inside the candidate dir.
     * --env-file comes from candidateValidationEnvFileArgs. Candidate
     * validation gets a 30s budget.
     */
    private async validateCandidate(
        stackName: string,
        candidateRelPath: string,
        composePaths: string[],
        contextDir: string | null,
        syncEnv: boolean,
    ): Promise<{ ok: boolean; error?: string }> {
        const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
        const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
        const candidateAbs = path.join(dataDir, 'git-managed', String(nodeId), stackName, candidateRelPath);
        const localFiles = gitSourceLocalComposeFiles(composePaths);

        const args = ['compose'];
        for (const local of localFiles) {
            // The candidate mirrors the stack layout 1:1 (primary -> compose.yaml,
            // additional files at their repo-relative path), so the -f path is
            // used AS-IS; basename-collapsing would break nested additional files.
            const safeRel = local.replace(/\\/g, '/');
            const abs = path.resolve(candidateAbs, safeRel);
            if (!isPathWithinBase(abs, candidateAbs)) {
                return { ok: false, error: `Compose path escapes the candidate dir: ${local}` };
            }
            args.push('-f', safeRel);
        }
        args.push('-p', stackName);
        if (contextDir) {
            const baseResolved = path.resolve(candidateAbs);
            const ctxAbs = path.resolve(baseResolved, contextDir);
            if (!ctxAbs.startsWith(baseResolved + path.sep)) {
                return { ok: false, error: 'Context directory escapes the candidate dir.' };
            }
            args.push('--project-directory', ctxAbs);
        }
        try {
            args.push(...(await candidateValidationEnvFileArgs({
                stackName,
                nodeId,
                candidateAbs,
                contextDir,
                syncEnv,
            })));
        } catch (err) {
            return { ok: false, error: (err as Error).message || 'Invalid project env file configuration.' };
        }
        args.push('config', '--quiet');
        const result = await this.runDockerCompose(args, candidateAbs, 30_000);
        if (result.code === 0) return { ok: true };
        const timeoutHint = result.stderr.includes('Validation timed out') ? ' (docker compose config timed out after 30s)' : '';
        return {
            ok: false,
            error: `${publicComposeValidationError(result.stderr, result.code, candidateAbs, dataDir)}${timeoutHint}`,
        };
    }

    private runDockerCompose(args: string[], cwd: string, timeoutMs: number) {
        return spawnDockerCompose(args, cwd, timeoutMs);
    }

    // ─── Hashing + diff ──────────────────────────────────────────────────────

    public hashContent(files: ComposeFile[], env: string | null): string {
        // Hash the ordered file CONTENTS (NUL-separated) plus env. Paths are
        // deliberately excluded: create/apply hash the fetched files (repo paths)
        // while pull hashes the on-disk files (materialized paths, primary ->
        // compose.yaml), so including paths would make the two disagree and flag a
        // clean multi-file stack as locally edited. Content order already changes
        // the hash on reorder, and a reorder is a config change that re-applies.
        // Single-file keeps the legacy (content + env) shape, byte-stable on upgrade.
        const h = crypto.createHash('sha256');
        if (files.length === 1) {
            h.update(files[0].content);
        } else {
            for (const f of files) {
                h.update(f.content);
                h.update('\x00');
            }
        }
        h.update('\x00');
        h.update(env ?? '');
        return h.digest('hex');
    }

    /**
     * The deploy-time spec for an ordered file set. Single-file stacks with no
     * context dir get `null`, so runtime stays plain `docker compose` auto-discovery.
     */
    private deriveAppliedSpec(composePaths: string[], contextDir: string | null): GitSourceAppliedSpec | null {
        if (composePaths.length <= 1 && !contextDir) return null;
        return { files: gitSourceLocalComposeFiles(composePaths), contextDir: contextDir ?? null };
    }

    /** Encrypt the candidate as a v4 pending blob (files + inventory + plan identity). */
    private encodePendingCompose(
        files: ComposeFile[],
        contextDir: string | null,
        candidateRelPath: string | null,
        inventory: InventoryResult | null,
        plan: {
            fingerprint: string;
            schemaVersion: number;
            operationId: string;
            reviewedLive?: Array<{ pathKey: string; liveHash: string | null }>;
        },
    ): string {
        return this.crypto.encrypt(JSON.stringify({
            v: 4,
            files,
            contextDir,
            candidateRelPath,
            inventory,
            planFingerprint: plan.fingerprint,
            planSchemaVersion: plan.schemaVersion,
            operationId: plan.operationId,
            reviewedLive: plan.reviewedLive ?? [],
        }));
    }

    /**
     * Decrypt a stored pending compose blob. v4 is the classified-plan format.
     * v3 / v2 / plaintext are recognized so apply can refuse them as LEGACY_PENDING
     * instead of treating them as a reviewable plan.
     */
    private decodePendingCompose(stored: string): {
        version: 2 | 3 | 4 | 'plaintext';
        files: ComposeFile[];
        contextDir: string | null;
        candidateRelPath: string | null;
        inventory: InventoryResult | null;
        planFingerprint: string | null;
        planSchemaVersion: number | null;
        operationId: string | null;
        reviewedLive: Array<{ pathKey: string; liveHash: string | null }>;
    } {
        const raw = this.crypto.decrypt(stored);
        if (raw.startsWith('{"v":4')) {
            try {
                const parsed = JSON.parse(raw) as {
                    v: number;
                    files?: ComposeFile[];
                    contextDir?: string | null;
                    candidateRelPath?: string | null;
                    inventory?: InventoryResult | null;
                    planFingerprint?: string;
                    planSchemaVersion?: number;
                    operationId?: string;
                    reviewedLive?: Array<{ pathKey: string; liveHash: string | null }>;
                };
                const inventoryValid =
                    parsed.inventory === null ||
                    (parsed.inventory !== undefined &&
                        Array.isArray(parsed.inventory.inputs) &&
                        Array.isArray(parsed.inventory.refusals) &&
                        Array.isArray(parsed.inventory.buildContexts));
                const reviewedLive = this.parseReviewedLive(parsed.reviewedLive);
                if (Array.isArray(parsed.files) && parsed.files.length > 0 && inventoryValid && reviewedLive !== null) {
                    return {
                        version: 4,
                        files: parsed.files,
                        contextDir: parsed.contextDir ?? null,
                        candidateRelPath: typeof parsed.candidateRelPath === 'string' ? parsed.candidateRelPath : null,
                        inventory: parsed.inventory ?? null,
                        planFingerprint: typeof parsed.planFingerprint === 'string' ? parsed.planFingerprint : null,
                        planSchemaVersion: typeof parsed.planSchemaVersion === 'number' ? parsed.planSchemaVersion : null,
                        operationId: typeof parsed.operationId === 'string' ? parsed.operationId : null,
                        reviewedLive,
                    };
                }
            } catch (e) {
                console.error('[GitSource] pending compose blob carried the v4 marker but failed to parse:', (e as Error).message);
            }
            throw new GitSourceError('PLAN_UNAVAILABLE', 'Pending update cannot be reviewed; pull again.');
        }
        if (raw.startsWith('{"v":3')) {
            try {
                const parsed = JSON.parse(raw) as { v: number; files?: ComposeFile[]; contextDir?: string | null; candidateRelPath?: string | null; inventory?: InventoryResult | null };
                const inventoryValid =
                    parsed.inventory === null ||
                    (parsed.inventory !== undefined &&
                        Array.isArray(parsed.inventory.inputs) &&
                        Array.isArray(parsed.inventory.refusals) &&
                        Array.isArray(parsed.inventory.buildContexts));
                if (Array.isArray(parsed.files) && parsed.files.length > 0 && inventoryValid) {
                    return {
                        version: 3,
                        files: parsed.files,
                        contextDir: parsed.contextDir ?? null,
                        candidateRelPath: typeof parsed.candidateRelPath === 'string' ? parsed.candidateRelPath : null,
                        inventory: parsed.inventory ?? null,
                        planFingerprint: null,
                        planSchemaVersion: null,
                        operationId: null,
                        reviewedLive: [],
                    };
                }
            } catch (e) {
                console.error('[GitSource] pending compose blob carried the v3 marker but failed to parse:', (e as Error).message);
            }
            throw new GitSourceError('PLAN_UNAVAILABLE', 'Pending update cannot be reviewed; pull again.');
        }
        if (raw.startsWith('{"v":2')) {
            try {
                const parsed = JSON.parse(raw) as { v: number; files?: ComposeFile[]; contextDir?: string | null };
                if (Array.isArray(parsed.files) && parsed.files.length > 0) {
                    return {
                        version: 2,
                        files: parsed.files,
                        contextDir: parsed.contextDir ?? null,
                        candidateRelPath: null,
                        inventory: null,
                        planFingerprint: null,
                        planSchemaVersion: null,
                        operationId: null,
                        reviewedLive: [],
                    };
                }
            } catch (e) {
                console.error('[GitSource] pending compose blob carried the v2 marker but failed to parse; treating as legacy:', (e as Error).message);
            }
        }
        return {
            version: 'plaintext',
            files: [{ path: PRIMARY_COMPOSE_FILENAME, content: raw }],
            contextDir: null,
            candidateRelPath: null,
            inventory: null,
            planFingerprint: null,
            planSchemaVersion: null,
            operationId: null,
            reviewedLive: [],
        };
    }

    private parseReviewedLive(
        raw: Array<{ pathKey: string; liveHash: string | null }> | undefined,
    ): Array<{ pathKey: string; liveHash: string | null }> | null {
        if (!Array.isArray(raw)) return null;
        const parsed: Array<{ pathKey: string; liveHash: string | null }> = [];
        for (const row of raw) {
            if (!row || typeof row.pathKey !== 'string') return null;
            if (row.liveHash !== null && typeof row.liveHash !== 'string') return null;
            parsed.push({ pathKey: row.pathKey, liveHash: row.liveHash });
        }
        return parsed;
    }

    private reviewedLiveFromPlan(plan: GitChangePlan): Array<{ pathKey: string; liveHash: string | null }> {
        return plan.operations
            .filter((op) => op.op !== 'invocation')
            .map((op) => ({ pathKey: op.pathKey, liveHash: op.liveHash }));
    }

    private reviewedLiveMap(
        rows: Array<{ pathKey: string; liveHash: string | null }> | null | undefined,
    ): Map<string, string | null> {
        const map = new Map<string, string | null>();
        for (const row of rows ?? []) {
            map.set(row.pathKey.toLowerCase(), row.liveHash);
        }
        return map;
    }

    /**
     * Write an ordered compose file set to a stack on disk: the primary to the
     * root compose.yaml, each additional file to its repo-relative path. Creates
     * the context dir when set, writes the env file when syncing, removes files
     * that the previous applied spec materialized but the new set drops, and
     * returns the deploy spec to persist.
     */
    private async materialize(
        stackName: string,
        composeFiles: ComposeFile[],
        contextDir: string | null,
        syncEnv: boolean,
        envContent: string | null,
        prevSpec: GitSourceAppliedSpec | null,
    ): Promise<GitSourceAppliedSpec | null> {
        const fsSvc = FileSystemService.getInstance();
        const localFiles = gitSourceLocalComposeFiles(composeFiles.map(f => f.path));

        await fsSvc.saveStackContent(stackName, composeFiles[0].content);
        for (let i = 1; i < composeFiles.length; i++) {
            await fsSvc.writeStackFile(stackName, localFiles[i], composeFiles[i].content);
        }

        if (contextDir) {
            await fsSvc.mkdirStackPath(stackName, contextDir);
        }

        if (syncEnv && envContent !== null) {
            await fsSvc.saveEnvContent(stackName, envContent);
        }

        // Stale cleanup: remove additional files the previous apply wrote that are
        // no longer in the set. Re-validate each as a safe relative path and never
        // touch the primary compose.yaml.
        if (prevSpec) {
            const keep = new Set(localFiles);
            for (const old of prevSpec.files) {
                if (old === PRIMARY_COMPOSE_FILENAME || keep.has(old)) continue;
                if (!isValidRelativeStackPath(old) || old === '') continue;
                await fsSvc.deleteStackPath(stackName, old);
            }
        }

        // Materializing changes the compose/env files on disk, which can add or
        // remove declared mounts, so the file-root allowlist must be recomputed.
        // GitSourceService is default-node scoped (it uses the default
        // FileSystemService instance), so invalidate the default node's cache.
        StackFileRootsService.getInstance().invalidate(stackName);

        return this.deriveAppliedSpec(composeFiles.map(f => f.path), contextDir);
    }

    // ─── Pull / apply ────────────────────────────────────────────────────────

    /**
     * A short, log-friendly token for an operation id. A reserved id
     * (`<applicationId>:attempt:<seq>` or `<trigger>:<intent>:<deliveryId>`)
     * repeats the same prefix across every attempt on one stack, so only the
     * suffix after the last colon tells two attempts apart. A plain UUID has
     * no such suffix, so its leading characters are used instead.
     */
    private static shortOperationId(operationId: string): string {
        const lastColon = operationId.lastIndexOf(':');
        return lastColon === -1 ? operationId.slice(0, 8) : operationId.slice(lastColon + 1);
    }

    public async pull(stackName: string, opts: { actor?: string } = {}): Promise<PullResult> {
        // Guarded by the per-stack mutex (see withStackLock). Without this, a
        // concurrent delete-source + pull can land a pending row on a stack
        // whose config row has just been removed.
        const actor = opts.actor ?? 'unknown';

        // Reservation and coalescing need a real gitops application to attach a
        // durable attempt to, the same definition pullLocked itself uses to
        // decide whether it has any gitops bookkeeping to do at all.
        const gitopsApp = this.gitopsApplicationFor(stackName);
        const doPull = this.doPullWork(stackName, actor, gitopsApp?.id);
        if (!gitopsApp) {
            this.refuseUntrackedSource(stackName, actor, 'fetch', true);
            return doPull();
        }

        const request: ReconcileRequest = { intent: 'fetch', applicationId: gitopsApp.id, stackName, trigger: 'manual', actor };
        const submission = await this.submitExecution(
            this.inFlightFetches,
            request,
            doPull,
            (outcome) => this.fetchExecutionResult(stackName, outcome),
        );
        return GitSourceService.valueFromSubmission(submission);
    }

    /**
     * The shared fetch work closure: the per-stack lock plus pullLocked
     * itself, reporting a real failure to the server console and to the
     * stack's activity feed here rather than in each producer, so it is
     * recorded exactly once no matter which fetch-intent producer (pull(),
     * reconcile()) owns the reservation that ends up leading. Kept as one
     * factory so pull() and reconcile()'s fetch path run the literal same
     * closure shape, which is what lets them join the same coalescing map
     * (inFlightFetches) in the first place: two producers can only coalesce
     * onto one execution if that execution really is the same work.
     */
    private doPullWork(stackName: string, actor: string, applicationId?: string): (operationId?: string) => Promise<PullResult> {
        return (operationId?: string) => this.withStackLock(stackName, async () => {
            try {
                if (applicationId) this.assertLiveApplication(stackName, applicationId);
                return await this.pullLocked(stackName, actor, operationId);
            } catch (e) {
                console.error(`[GitSource] fetch failed for ${sanitizeForLog(stackName)}:`, e instanceof Error ? e.message : String(e));
                this.recordGitActivity(stackName, 'git_pull_failed', `Git pull failed for ${stackName}`, actor, 'error');
                throw e;
            }
        });
    }

    /**
     * The GitOps application tracking this stack, or null when there is none.
     *
     * Stacks that predate the revision-state model have no application until
     * migration runs, so every producer is a no-op for them rather than
     * inventing an application from configuration alone.
     */
    private gitopsApplicationFor(stackName: string): GitOpsApplicationRow | null {
        const app = GitOpsStore.getInstance().getLiveDirectApplication(stackName);
        return app && app.lifecycle_status === 'active' ? app : null;
    }

    /**
     * Whether any application still holds this stack name.
     *
     * Wider than `gitopsApplicationFor`, which only reports usable applications.
     * A `creating` row left by a crash the boot sweep could not settle still
     * occupies the unique live-application index, so activating over it would
     * fail the whole save with an internal constraint message.
     */
    private gitopsNameHeld(stackName: string): boolean {
        return !!GitOpsStore.getInstance().getLiveDirectApplication(stackName);
    }

    private gitopsEnvelope(operationId: string, actor: string, trigger: string) {
        return { operationId, actor, trigger, at: Date.now() };
    }

    /**
     * Record a GitOps transition without letting it break the operation it
     * describes.
     *
     * The store is the record of what happened, not the mechanism that makes it
     * happen, so a rejected transition must not fail a fetch or an apply that
     * has already touched the filesystem. The rejection is logged loudly
     * because it means the recorded state has drifted from reality.
     */
    private recordGitOps(stackName: string, what: string, write: () => void): boolean {
        try {
            write();
            return true;
        } catch (error) {
            console.error(
                `[GitOps] Could not record ${what} for ${sanitizeForLog(stackName)}:`,
                error instanceof Error ? error.stack ?? error.message : String(error),
            );
            return false;
        }
    }

    /**
     * Close an operation whose terminal transition was rejected.
     *
     * A start that never terminates leaves the source reporting work in
     * progress and offering no actions, permanently. When the real terminal
     * event cannot be recorded, the next best truth is that we lost track:
     * clear the operation and stamp a failure the projection can render, so the
     * operator sees an error they can retry instead of a spinner.
     */
    private abandonGitOpsOperation(
        stackName: string,
        applicationId: string,
        envelope: ReturnType<GitSourceService['gitopsEnvelope']>,
    ): void {
        this.recordGitOps(stackName, 'lost-track fallback', () => {
            GitOpsTransitions.getInstance().applyFailed(applicationId, 'bookkeeping_rejected', envelope);
        });
    }

    private async pullLocked(stackName: string, actor: string, operationId?: string): Promise<PullResult> {
        const db = DatabaseService.getInstance();
        const src = db.getGitSource(stackName);
        if (!src) throw new GitSourceError('GIT_ERROR', 'No Git source configured for this stack.');
        const gitopsApp = this.gitopsApplicationFor(stackName);
        // fetchStarted has its own suspension guard, but recordGitOps swallows
        // its rejection (so a fetch that already touched the filesystem is never
        // failed out from under itself), which would let a suspended source keep
        // cloning and staging pending updates. Stop before any of that starts.
        if (gitopsApp?.suspended_at) {
            throw new GitSourceError('OPERATION_IN_FLIGHT', `Reconciliation is suspended for ${stackName}.`);
        }
        // A caller that reserved a durable attempt for this fetch passes its own
        // operation id in, so the attempt and every stage of gitops evidence it
        // produces share one identity. A direct low-level call that reserved
        // nothing still gets an id of its own.
        const gitopsOperationId = operationId ?? crypto.randomUUID();
        const gitopsEnv = this.gitopsEnvelope(gitopsOperationId, actor, 'pull');
        // A fetch that starts and never terminates is worse than one that is
        // never recorded: fetchStarted refuses to open a second operation, so
        // every later pull silently stops being tracked until a restart.
        let fetchOpen = false;
        if (gitopsApp) {
            fetchOpen = this.recordGitOps(stackName, 'fetch start', () => {
                GitOpsTransitions.getInstance().fetchStarted(gitopsApp.id, gitopsEnv);
            });
        }
        // The classified error code travels with the failure transition so the
        // controller can later tell a transient network condition from a
        // permanent one when it decides whether to schedule a retry.
        let fetchFailureCode: GitSourceErrorCode | undefined;
        const closeFetch = (): void => {
            if (!gitopsApp || !fetchOpen) return;
            fetchOpen = false;
            this.recordGitOps(stackName, 'fetch failure', () => {
                GitOpsTransitions.getInstance().fetchFailed(gitopsApp.id, gitopsEnv, fetchFailureCode);
            });
        };

        try {
            return await this.pullLockedBody(stackName, actor, src, {
                app: gitopsApp,
                operationId: gitopsOperationId,
                envelope: gitopsEnv,
                markSettled: () => { fetchOpen = false; },
                abandon: closeFetch,
            });
        } catch (e) {
            if (e instanceof GitSourceError) fetchFailureCode = e.code;
            closeFetch();
            throw e;
        }
    }

    private async pullLockedBody(
        stackName: string,
        actor: string,
        src: StackGitSource,
        gitops: {
            app: GitOpsApplicationRow | null;
            operationId: string;
            envelope: ReturnType<GitSourceService['gitopsEnvelope']>;
            markSettled: () => void;
            abandon: () => void;
        },
    ): Promise<PullResult> {
        const db = DatabaseService.getInstance();
        const diag = isDebugEnabled();
        const gitopsApp = gitops.app;
        const gitopsOperationId = gitops.operationId;
        const gitopsEnv = gitops.envelope;

        if (diag) {
            console.log(`[GitSource:diag] pull start stack=${stackName} branch=${src.branch} host=${repoHost(src.repo_url)}`);
        }

        const transportAuth = this.resolveTransportAuth(src);
        const manifestSvc = GitProjectManifestService.getInstance();
        // Object holder: property access is not narrowed by control-flow
        // analysis, so the closure assignment below stays visible.
        const materialization: { value: MaterializationResult | null } = { value: null };
        // Every throw from here on, including this fetch, is closed by the
        // caller's handler, so nothing is recorded locally.
        const priorIdentity = priorFetchIdentity(gitopsApp);
        const fetched: FetchResult = await this.fetchFromGit({
            repoUrl: src.repo_url,
            branch: src.branch,
            composePaths: src.compose_paths,
            envPath: src.sync_env ? src.env_path : null,
            token: transportAuth.token,
            sshAuth: transportAuth.sshAuth,
            caBundlePem: transportAuth.caBundlePem,
            hasPriorHistory: priorIdentity != null,
            priorIdentity,
            onClone: async (cloneDir, commitSha, envContent) => {
                materialization.value = await this.buildMaterialization(stackName, cloneDir, commitSha, src, envContent);
            },
        });

        const validation = materialization.value
            ? materialization.value.validation
            : await this.validateCompose(fetched.composeFiles, fetched.envContent, src.context_dir);

        let manifestSummary: ManifestSummary | null = null;
        const priorRead = await manifestSvc.readManifest(stackName, src.repo_url, src.branch);
        if (priorRead !== null && 'corrupt' in priorRead) {
            const identityMismatch = priorRead.corrupt.includes('identity');
            throw new GitSourceError(
                'GIT_ERROR',
                identityMismatch
                    ? `The managed-project manifest for ${stackName} is stamped for a different repository or branch. Detach the Git source, then re-link it to the current repository and branch.`
                    : `The managed-project manifest for ${stackName} cannot be trusted (${priorRead.corrupt}). Detach the Git source and re-link it to rebuild the managed project.`,
            );
        }
        const prior = priorRead;
        if (prior) manifestSummary = manifestSvc.summaryFrom(prior);

        let plan: GitChangePlan | null = null;
        if (materialization.value?.inventory) {
            plan = await this.computeChangePlan({
                stackName,
                commitSha: fetched.commitSha,
                mode: 'update',
                src,
                inventory: materialization.value.inventory,
                envContent: fetched.envContent,
                prior,
            });
        }

        // Record what this fetch resolved before the pending blob is written,
        // so the durable pointers and the operational pending store agree.
        if (gitopsApp) {
            const outcomeRecorded = this.recordGitOps(stackName, 'fetch outcome', () => {
                const tx = GitOpsTransitions.getInstance();
                // One transaction: a candidate that exists without the fetch
                // that produced it would let a later apply accept the wrong
                // generation while the projection reports the older commit.
                DatabaseService.getInstance().getDb().transaction(() => {
                if (!validation.ok) {
                    tx.fetchedInvalid(gitopsApp.id, fetched.commitSha, gitopsEnv, fetched.resolvedRefKind);
                    return;
                }
                tx.fetched(gitopsApp.id, fetched.commitSha, gitopsEnv, fetched.resolvedRefKind);
                if (!materialization.value) return;
                const identity = directSourceIdentity({
                    repoUrl: src.repo_url,
                    branch: src.branch,
                    composePaths: src.compose_paths,
                    contextDir: src.context_dir,
                    syncEnv: src.sync_env,
                    envPath: src.env_path,
                });
                // A pull that resolves to exactly what the live candidate
                // already proposes (same commit, source fingerprint, plan
                // verdict, review requirement) must not mint a lookalike
                // generation and rewrite the candidate pointers. The staged
                // generation stands; only the fetch above is new. A candidate
                // for a different commit, or no candidate at all, mints anew:
                // staging after an apply is a new dispatch cycle and needs its
                // own generation to accept.
                const reviewRequired = gitopsApp.source_policy !== 'automatic';
                const staged = gitopsApp.candidate_generation_id
                    ? GitOpsStore.getInstance().getGeneration(gitopsApp.candidate_generation_id)
                    : undefined;
                if (
                    staged &&
                    staged.commit_sha === fetched.commitSha &&
                    staged.materialization_fingerprint === identity.fingerprint &&
                    staged.plan_blocked === (plan?.blocked === true ? 1 : 0) &&
                    gitopsApp.review_required === (reviewRequired ? 1 : 0)
                ) {
                    return;
                }
                const generationId = newGitOpsId();
                const nextManifestVersion = (prior?.manifestVersion ?? 0) + 1;
                GitOpsStore.getInstance().insertGeneration(buildGenerationRow({
                    id: generationId,
                    applicationId: gitopsApp.id,
                    commitSha: fetched.commitSha,
                    identity,
                    configuredRef: src.branch,
                    resolvedRefKind: fetched.resolvedRefKind,
                    candidateRelPath: materialization.value.candidateRelPath,
                    appliedRelPath: appliedRelPathFor(fetched.commitSha, nextManifestVersion),
                    manifestVersion: nextManifestVersion,
                    // The candidate's own invocation. Recording the prior
                    // generation's would attribute one generation's facts to
                    // another, which is the whole failure this model prevents.
                    expectedInvocation: plan?.candidateInvocation ?? prior?.project.invocation ?? null,
                    changePlanFingerprint: plan?.fingerprint ?? null,
                    operationId: gitopsOperationId,
                    trigger: gitopsEnv.trigger,
                    actor,
                    at: gitopsEnv.at,
                    planBlocked: plan?.blocked === true,
                }));
                if (plan?.blocked) tx.sourceConflictBlocker(gitopsApp.id, generationId, gitopsEnv);
                else tx.candidateReady(gitopsApp.id, generationId, reviewRequired, gitopsEnv);
                })();
                gitops.markSettled();
            });
            // The pull itself succeeded; the files and the pending blob are
            // real. Closing the operation is what stops the source reporting a
            // fetch in flight for ever and locking out every later pull.
            if (!outcomeRecorded) gitops.abandon();
        }

        const publicPlan = plan ? GitChangePlanService.getInstance().toPublic(plan) : null;
        const summary = plan ? GitChangePlanService.getInstance().toPendingSummary(plan) : null;
        db.setGitSourcePending(
            stackName,
            fetched.commitSha,
            this.encodePendingCompose(
                fetched.composeFiles,
                src.context_dir,
                materialization.value?.candidateRelPath ?? null,
                materialization.value?.inventory ?? null,
                {
                    fingerprint: plan?.fingerprint ?? '',
                    schemaVersion: GIT_CHANGE_PLAN_SCHEMA_VERSION,
                    // This fetch attempt's own id, not an independent one:
                    // applyLockedBody falls back to pending.operationId for
                    // its gitops transitions when its caller reserved no
                    // attempt, so that fallback has to inherit the real fetch
                    // attempt's lineage rather than an identity nothing else
                    // knows about.
                    operationId: gitopsOperationId,
                    reviewedLive: plan ? this.reviewedLiveFromPlan(plan) : [],
                },
            ),
            fetched.envContent !== null ? this.crypto.encrypt(fetched.envContent) : null,
            summary ? { fingerprint: summary.fingerprint, blocked: summary.blocked, summary: JSON.stringify(summary) } : undefined,
        );

        if (plan) {
            this.upsertGitPlanDrift(stackName, plan);
            const shortSha = fetched.commitSha.slice(0, 7);
            const fpPrefix = plan.fingerprint.slice(0, 12);
            if (plan.blocked) {
                this.recordGitActivity(
                    stackName,
                    'git_plan_blocked',
                    `Git plan blocked for ${stackName} (${shortSha}, op ${GitSourceService.shortOperationId(gitopsOperationId)}, plan ${fpPrefix})`,
                    actor,
                    'warning',
                );
            } else {
                this.recordGitActivity(
                    stackName,
                    'git_pull_ready',
                    `Git pull ready for ${stackName} (${shortSha}, op ${GitSourceService.shortOperationId(gitopsOperationId)}, plan ${fpPrefix})`,
                    actor,
                );
            }
        }

        console.log(`[GitSource] Pending update ready for ${stackName} at ${fetched.commitSha.slice(0, 7)} (validation=${validation.ok ? 'ok' : 'fail'}, blocked=${plan?.blocked ?? 'n/a'}, candidate=${materialization.value?.candidateRelPath ?? "none"})`);
        if (diag) {
            console.log(`[GitSource:diag] pull done stack=${stackName} sha=${fetched.commitSha.slice(0, 7)} validation=${validation.ok} blocked=${plan?.blocked ?? 'n/a'} candidate=${materialization.value !== null}`);
        }

        return {
            commitSha: fetched.commitSha,
            validation,
            refusals: manifestSvc.toPublicRefusals(materialization.value?.inventory.refusals ?? []),
            manifestSummary,
            candidateReady: materialization.value !== null && materialization.value.validation.ok,
            warnings: fetched.warnings,
            plan: publicPlan,
            planFingerprint: plan?.fingerprint ?? null,
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
        opts: GitApplyOpts = {},
    ): Promise<GitApplyResult> {
        // Resolved once, with applyLockedBody's own formula (its shouldDeploy),
        // so the coalesce key below and the deploy behavior actually executed
        // can never disagree: two calls that resolve to different deploy
        // behavior must never share a coalesce key, or one could silently
        // receive the other's deployed/not-deployed result.
        const resolvedDeploy = opts.deploy ?? DatabaseService.getInstance().getGitSource(stackName)?.auto_deploy_on_apply ?? false;
        const finalOpts: GitApplyOpts = { ...opts, deploy: resolvedDeploy, requirePlanFingerprint: opts.requirePlanFingerprint !== false };
        const doApply = (applicationId?: string, operationId?: string) => this.withStackLock(
            stackName,
            async () => {
                if (applicationId) this.assertLiveApplication(stackName, applicationId);
                return this.applyWithSharedLock(stackName, commitSha, finalOpts, operationId);
            },
        );

        // Same reasoning as pull(): reservation needs a real gitops
        // application to attach a durable attempt to.
        const gitopsApp = this.gitopsApplicationFor(stackName);
        if (!gitopsApp) {
            this.refuseUntrackedSource(stackName, opts.actor ?? 'unknown', 'apply', true);
            return doApply();
        }

        const request: ReconcileRequest = {
            intent: 'apply',
            applicationId: gitopsApp.id,
            stackName,
            trigger: 'manual',
            actor: opts.actor ?? 'unknown',
            commitSha,
            planFingerprint: opts.planFingerprint ?? '',
            deploy: resolvedDeploy,
        };
        // A policy-bypassing apply must never coalesce with anything else:
        // bypassPolicy changes behavior but is not part of the coalesce key (a
        // plain policy-gate bypass has no natural identity to key on), so
        // joining could hand a non-bypassing caller someone else's bypassed
        // result, or silently drop an admin's explicit bypass onto a request
        // that never asked for one. A call-local key suffix guarantees this
        // call can neither join an existing leader nor be joined by a later one.
        const baseKey = GitSourceService.applyExecutionKey(request, finalOpts.requirePlanFingerprint === true);
        const key = opts.bypassPolicy
            ? `${baseKey}:policy-bypass:${crypto.randomUUID()}`
            : baseKey;
        const submission = await this.submitExecution(
            this.inFlightApplies,
            request,
            (operationId) => doApply(gitopsApp.id, operationId),
            (outcome) => this.applyExecutionResult(stackName, outcome),
            key,
        );
        return GitSourceService.valueFromSubmission(submission);
    }

    /**
     * Outcomes the application row already reflects truthfully, so reconcile
     * trusts the derived result over a classified fallback. Most throw sites
     * in pullLocked/applyLockedBody fire before any transition opens (missing
     * config, stale commitSha, lock contention) and leave the row saying
     * nothing about the failure, which is what the fallback covers;
     * 'suspended' belongs here because its guards throw only when the row
     * already, correctly, says so.
     */
    private static readonly FAILURE_REFLECTED_OUTCOMES: ReadonlySet<ReconcileOutcome> = new Set<ReconcileOutcome>([
        'failed_previous_intact',
        'retry_scheduled',
        'recovery_required',
        'blocked',
        'suspended',
    ]);

    /** The settled result for a stack that carries no GitOps application at all. */
    private static noApplicationResult(): ReconcileResult {
        return { outcome: 'unknown', reason: 'No GitOps application exists for this stack.', nextAction: 'none' };
    }

    /**
     * The settled result for a request naming an application id that is no
     * longer the live one for its stack. Failing closed here (rather than
     * proceeding against whatever application now holds the stack name)
     * keeps a request from settling against an application it never named.
     */
    private static staleApplicationResult(): ReconcileResult {
        return {
            outcome: 'unknown',
            reason: 'The live application for this stack no longer matches the requested application id.',
            nextAction: 'none',
        };
    }

    /** Refuse work when the application resolved before locking is no longer live. */
    private assertLiveApplication(stackName: string, applicationId: string): void {
        if (GitOpsStore.getInstance().getLiveDirectApplication(stackName)?.id === applicationId) return;
        throw new GitSourceError('OPERATION_IN_FLIGHT', GitSourceService.staleApplicationResult().reason);
    }

    /**
     * Shared fetch and apply executions. Manual routes, controller requests,
     * and webhooks all use these maps so producer choice cannot create a
     * duplicate side effect or a different normalized result.
     */
    private readonly inFlightFetches: InFlightMap<PullResult> = new Map();
    private readonly inFlightApplies: InFlightMap<GitApplyResult> = new Map();
    private readonly inFlightWebhookDeliveries = new Map<string, { promise: Promise<WebhookPullResult> }>();

    /**
     * The controller-facing entry point: one normalized submission in,
     * one normalized result out, for any trigger (manual, poll, retry,
     * API, config change, startup, resume).
     *
     * Every submission against a real application row gets a durable
     * attempt, reserved before any side effect and settled with the
     * normalized result once execution finishes -- reserved but never
     * settled is exactly what startup recovery looks for after a crash.
     * A submission naming an application id that does not exist at all
     * (a fabricated id, or a stack with no GitOps application) reserves
     * nothing: there is no row to attach a durable attempt to, and the
     * identity/no-application guards below already produce a truthful
     * result for it without doing any work worth protecting.
     */
    public async reconcile(request: ReconcileRequest): Promise<ReconcileResult> {
        if (!GitOpsStore.getInstance().getApplication(request.applicationId)) {
            // request.applicationId does not exist as any row, so it can
            // never equal a real live application's id: the identity guard
            // alone already produces the truthful result, without a stack
            // lock or any work worth protecting.
            const liveApp = GitOpsStore.getInstance().getLiveDirectApplication(request.stackName);
            return liveApp ? GitSourceService.staleApplicationResult() : GitSourceService.noApplicationResult();
        }

        if (request.intent === 'fetch') {
            return this.reconcileFetch(request);
        }

        const submission = await this.submitExecution(
            this.inFlightApplies,
            request,
            (operationId) => this.withStackLock(request.stackName, async () => {
                this.assertLiveApplication(request.stackName, request.applicationId);
                return this.applyWithSharedLock(request.stackName, request.commitSha, {
                    actor: request.actor,
                    deploy: request.deploy,
                    planFingerprint: request.planFingerprint,
                    requirePlanFingerprint: false,
                }, operationId);
            }),
            (outcome) => this.applyExecutionResult(request.stackName, outcome),
            GitSourceService.applyExecutionKey(request, false),
        );
        return GitSourceService.resultFromSubmission(submission);
    }

    private static applyExecutionKey(
        request: ReconcileRequest & { intent: 'apply' },
        requirePlanFingerprint: boolean,
    ): string {
        return `${coalesceKey(request)}:fingerprint-${requirePlanFingerprint ? 'required' : 'optional'}`;
    }

    /**
     * The in-flight execution in `map` whose reservation minted exactly this
     * operation id, regardless of which coalesce key it is running under.
     * Coalesce keys and operation ids are not co-extensive (an apply's key
     * includes its commitSha/planFingerprint/deploy, which a shared external
     * delivery id does not carry), so two submissions can collide on operation
     * id while running under different keys.
     */
    private static findByOperationId<T>(map: InFlightMap<T>, operationId: string): Promise<LeaderCompletion<T>> | undefined {
        for (const entry of map.values()) {
            if (entry.operationId === operationId) return entry.promise;
        }
        return undefined;
    }

    private static resultFromSubmission<T>(submission: ExecutionSubmission<T>): ReconcileResult {
        return submission.kind === 'replayed' ? submission.result : submission.execution.result;
    }

    /** Preserve manual route return and throw behavior after settlement is attempted. */
    private static valueFromSubmission<T>(submission: ExecutionSubmission<T>): T {
        if (submission.kind === 'replayed') {
            throw new GitSourceError('GIT_ERROR', 'This operation was already recorded and cannot be replayed as a new manual request.');
        }
        if (submission.execution.status === 'rejected') throw submission.execution.reason;
        return submission.execution.value;
    }

    /**
     * Reserve one submission, join equivalent work when possible, and attempt
     * to settle each reservation from the leader's single normalized result.
     * A failed leader settlement leaves its followers unsettled for recovery.
     */
    private async submitExecution<T>(
        map: InFlightMap<T>,
        request: ReconcileRequest,
        work: (operationId: string) => Promise<T>,
        normalize: (outcome: WorkOutcome<T>) => ReconcileResult,
        key = coalesceKey(request),
        deliveryIntent?: ReconcileDeliveryIntent,
    ): Promise<ExecutionSubmission<T>> {
        const leader = map.get(key);
        const { envelope, reserved } = this.reserveOwnAttemptOrFailClosed(request, leader?.operationId, deliveryIntent);

        if (leader && (reserved || leader.operationId === envelope.operationId)) {
            const completion = await leader.promise;
            if (reserved && completion.settled) {
                this.settleAttempt(request.applicationId, envelope, completion.execution.result);
            }
            return { kind: 'executed', execution: completion.execution };
        }

        if (!reserved) {
            const byOperationId = GitSourceService.findByOperationId(map, envelope.operationId);
            if (byOperationId) {
                return { kind: 'executed', execution: (await byOperationId).execution };
            }
            return {
                kind: 'replayed',
                result: this.resolveAlreadyReservedAttempt(
                    request.applicationId,
                    envelope.operationId,
                    request.actor,
                    request.trigger,
                ),
            };
        }

        const promise = this.captureExecution(request, envelope, work, normalize)
            .then((execution): LeaderCompletion<T> => ({
                execution,
                settled: this.settleAttempt(request.applicationId, envelope, execution.result),
            }));
        const entry = { operationId: envelope.operationId, promise };
        map.set(key, entry);
        try {
            const completion = await promise;
            return { kind: 'executed', execution: completion.execution };
        } finally {
            if (map.get(key) === entry) map.delete(key);
        }
    }

    /** Capture raw producer behavior and compute one normalized result for all followers. */
    private async captureExecution<T>(
        request: ReconcileRequest,
        envelope: EventEnvelope,
        work: (operationId: string) => Promise<T>,
        normalize: (outcome: WorkOutcome<T>) => ReconcileResult,
    ): Promise<SharedExecution<T>> {
        let outcome: WorkOutcome<T>;
        try {
            outcome = { status: 'fulfilled', value: await work(envelope.operationId) };
        } catch (reason) {
            outcome = { status: 'rejected', reason: reason ?? new Error('Rejected with no reason.') };
        }
        try {
            return { ...outcome, result: normalize(outcome) };
        } catch (e) {
            console.error(
                '[GitSource] Failed to derive a settlement result for attempt %s on application %s:',
                sanitizeForLog(envelope.operationId),
                sanitizeForLog(request.applicationId),
                e instanceof Error ? e.message : String(e),
            );
            return {
                ...outcome,
                result: { outcome: 'unknown', reason: 'This attempt could not be resolved.', nextAction: 'none' },
            };
        }
    }

    /**
     * Reserve this request's durable attempt, failing closed when the
     * reservation bookkeeping itself fails: no fetch, apply, promotion, or
     * deploy may run without a durable record of it, so a failure here stops
     * the operation rather than letting it proceed as an untracked side
     * effect. Two failure shapes, reported differently: an application torn
     * down in the window between resolving it and reserving against it (a
     * GitOpsTransitionError from requireApp) can never succeed on retry, so
     * it gets its own message; anything else (a transient DB error) is worth
     * retrying. The refusal is recorded to the stack's own activity history
     * as well as the server console, since it is itself an event an operator
     * needs to see later. Callers (an HTTP route, or handleWebhookPull's own
     * try/catch) already handle a thrown GitSourceError the same way they
     * handle any other failure from the work itself.
     */
    private reserveOwnAttemptOrFailClosed(
        request: ReconcileRequest,
        followerOf: string | undefined,
        deliveryIntent?: ReconcileDeliveryIntent,
    ): { envelope: EventEnvelope; reserved: boolean } {
        try {
            return this.reserveOwnAttempt(request, followerOf, deliveryIntent);
        } catch (e) {
            console.error(
                `[GitSource] Failed to reserve a durable attempt for application ${sanitizeForLog(request.applicationId)}; refusing to proceed without one:`,
                e instanceof Error ? e.stack ?? e.message : String(e),
            );
            const isFetch = request.intent === 'fetch';
            this.recordGitActivity(
                request.stackName,
                isFetch ? 'git_pull_failed' : 'git_apply_failed',
                `Git ${request.intent} for ${request.stackName} was refused: could not durably record the attempt.`,
                request.actor,
                'error',
            );
            if (e instanceof GitOpsTransitionError) {
                throw new GitSourceError(
                    'GIT_ERROR',
                    `This stack's GitOps tracking is unavailable; reconfigure the source before ${isFetch ? 'pulling' : 'applying'} again.`,
                );
            }
            throw new GitSourceError('GIT_ERROR', 'Could not durably record this operation. Please try again.');
        }
    }

    /** Refuse any configured source whose work cannot receive a durable attempt. */
    private refuseUntrackedSource(stackName: string, actor: string, intent: 'fetch' | 'apply', recordActivity: boolean): void {
        if (!DatabaseService.getInstance().getGitSource(stackName)) return;
        const wasDetached = GitOpsStore.getInstance().hasDetachedDirectApplication(stackName);
        const message = wasDetached
            ? `This stack's GitOps tracking was removed but its Git source configuration still exists; delete the Git source configuration to finish detaching before ${intent === 'fetch' ? 'pulling' : 'applying'} again.`
            : `This stack's GitOps tracking is unavailable; reconfigure the source before ${intent === 'fetch' ? 'pulling' : 'applying'} again.`;
        if (recordActivity) {
            this.recordGitActivity(stackName, intent === 'fetch' ? 'git_pull_failed' : 'git_apply_failed', message, actor, 'error');
        }
        throw new GitSourceError('GIT_ERROR', message);
    }

    /**
     * Reserve this submission's own durable attempt. A request carrying a
     * stable external delivery id (webhook redelivery) reserves under a
     * producer-namespaced key derived from it, so a redelivery of the same
     * event reuses the same operation id and reports `reserved: false`
     * rather than minting a second attempt. Any other submission has no
     * such stable identity, so its operation id is freshly allocated from
     * the row's own attemptSeq, which is always a first-time reservation.
     */
    private reserveOwnAttempt(
        request: ReconcileRequest,
        followerOf: string | undefined,
        deliveryIntent?: ReconcileDeliveryIntent,
    ): { envelope: EventEnvelope; reserved: boolean } {
        const tx = GitOpsTransitions.getInstance();
        if (request.deliveryId) {
            const operationId = deliveryKey(request.trigger, request.intent, request.deliveryId);
            const envelope = this.gitopsEnvelope(operationId, request.actor, request.trigger);
            const { reserved } = tx.reserveReconcileAttempt(request.applicationId, envelope, followerOf, deliveryIntent);
            return { envelope, reserved };
        }
        const allocated = tx.allocateReconcileAttempt(request.applicationId, request.actor, request.trigger, Date.now(), followerOf);
        return {
            envelope: this.gitopsEnvelope(allocated.operationId, request.actor, request.trigger),
            reserved: allocated.reserved,
        };
    }

    /**
     * Settle a durable attempt with its already-computed result, tolerating
     * a settlement failure rather than letting it turn a correctly-computed
     * result (up to and including a real fetch or apply that already
     * touched the filesystem) into a thrown error for the caller. The
     * attempt is left unsettled on this path, which is exactly the signal
     * startup recovery looks for, so nothing here is lost, only deferred.
     */
    private settleAttempt(applicationId: string, envelope: EventEnvelope, result: ReconcileResult): boolean {
        try {
            const { settled } = GitOpsTransitions.getInstance().settleReconcileAttempt(applicationId, envelope, result);
            return settled || !!GitOpsStore.getInstance().getSettledAttempt(applicationId, envelope.operationId);
        } catch (e) {
            console.error(
                '[GitSource] Failed to settle reconcile attempt %s for application %s:',
                sanitizeForLog(envelope.operationId),
                sanitizeForLog(applicationId),
                e instanceof Error ? e.message : String(e),
            );
            return false;
        }
    }

    /**
     * A submission whose operation id was already reserved elsewhere, with
     * no leader for it running in this process: a settled row means a
     * duplicate delivery arrived after its original attempt finished, so
     * its stored result is returned rather than repeating the work. No
     * settled row means the original attempt was orphaned by a crash (in
     * this process or another); either way this call must not re-execute a
     * fetch or apply someone else may already have run, so it resolves
     * from whatever is already durably recorded, settling when that
     * yields a real answer and otherwise reporting truthfully that the
     * outcome is not yet known rather than guessing one.
     */
    private resolveAlreadyReservedAttempt(applicationId: string, operationId: string, actor: string | null, trigger: string): ReconcileResult {
        try {
            const store = GitOpsStore.getInstance();
            const settled = store.getSettledAttempt(applicationId, operationId);
            if (settled) return GitSourceService.resultFromSettledAttempt(settled);
            return this.settleFromDurableState(applicationId, operationId, actor, trigger);
        } catch (e) {
            console.error(
                '[GitSource] Failed to resolve already-reserved attempt %s for application %s:',
                sanitizeForLog(operationId),
                sanitizeForLog(applicationId),
                e instanceof Error ? e.message : String(e),
            );
            return { outcome: 'unknown', reason: 'This attempt could not be resolved from durable state.', nextAction: 'none' };
        }
    }

    /**
     * Resolve one reconcile attempt purely from what is already recorded,
     * never by re-executing a fetch or apply, settling it durably when that
     * yields a real answer. A follower is settled from its leader; anything
     * else is derived from the application's current row state. A follower
     * whose leader is still unresolved is left unsettled for a later call
     * (a future recovery pass, or the leader itself finally settling) to
     * resolve, for the reason resolveFollowerOutcome states.
     */
    private settleFromDurableState(
        applicationId: string,
        operationId: string,
        actor: string | null,
        trigger: string,
    ): ReconcileResult {
        const started = GitOpsStore.getInstance().getStartedAttempt(applicationId, operationId);
        // Prefer the reservation's own recorded actor/trigger over this
        // call's, so the settled row's audit trail reflects who and what
        // actually reserved the attempt rather than whoever happened to
        // resolve it later.
        const envelope: EventEnvelope = {
            operationId,
            actor: started?.actor ?? actor,
            trigger: started?.trigger ?? trigger,
            at: Date.now(),
        };
        const followerOf = started ? GitSourceService.followerOfFromRow(started) : undefined;
        if (followerOf) {
            const outcome = this.resolveFollowerOutcome(applicationId, followerOf);
            if (!outcome.known) {
                return { outcome: 'unknown', reason: 'This attempt is waiting on its leader to settle.', nextAction: 'none' };
            }
            if (!this.settleAttempt(applicationId, envelope, outcome.result)) {
                return GitSourceService.durableResolutionFailureResult();
            }
            return outcome.result;
        }
        const result = this.deriveResultForApplication(applicationId);
        if (!this.settleAttempt(applicationId, envelope, result)) {
            return GitSourceService.durableResolutionFailureResult();
        }
        return result;
    }

    private static durableResolutionFailureResult(): ReconcileResult {
        return { outcome: 'unknown', reason: 'This attempt could not be durably resolved.', nextAction: 'none' };
    }

    /**
     * A follower's outcome from its leader alone: the leader's settled
     * result when it has one. When the leader has no settled row but its
     * own reservation genuinely exists, its fate is still unresolved
     * (`known: false`) and must not be guessed at independently, since it
     * could settle to something else later and the follower would then
     * durably disagree with it. Only when the leader's own reservation
     * cannot be found at all (nothing durable to ever wait for) does
     * independent derivation apply, logged distinctly since it means the
     * leader/follower agreement invariant could not be honored here.
     */
    private resolveFollowerOutcome(
        applicationId: string,
        leaderOperationId: string,
    ): { known: true; result: ReconcileResult } | { known: false } {
        const store = GitOpsStore.getInstance();
        const leaderSettled = store.getSettledAttempt(applicationId, leaderOperationId);
        if (leaderSettled) return { known: true, result: GitSourceService.resultFromSettledAttempt(leaderSettled) };
        if (store.getStartedAttempt(applicationId, leaderOperationId)) return { known: false };
        console.error(
            `[GitSource] follower's leader ${sanitizeForLog(leaderOperationId)} has no recorded reservation for application ${sanitizeForLog(applicationId)}; deriving independently`,
        );
        return { known: true, result: this.deriveResultForApplication(applicationId) };
    }

    /**
     * The current truthful result for an application, independent of any
     * specific attempt. Fails closed on a superseded application id for the
     * same reason every live execution revalidates identity under its lock.
     */
    private deriveResultForApplication(applicationId: string): ReconcileResult {
        const store = GitOpsStore.getInstance();
        const app = store.getApplication(applicationId);
        if (!app?.stack_name) return GitSourceService.noApplicationResult();
        if (store.getLiveDirectApplication(app.stack_name)?.id !== applicationId) {
            return GitSourceService.staleApplicationResult();
        }
        return this.deriveReconcileResult(app.stack_name);
    }

    /** The follower-link operation id recorded on a reservation, if any. */
    private static followerOfFromRow(row: GitOpsHistoryRow): string | undefined {
        const decoded = decodeGitOpsJson(row.after_json);
        if (!isRecord(decoded)) throw new GitOpsJsonError('reserved attempt metadata must be an object');
        if (!('followerOf' in decoded)) return undefined;
        if (typeof decoded.followerOf !== 'string') {
            throw new GitOpsJsonError('reserved attempt followerOf must be a string');
        }
        return decoded.followerOf;
    }

    private static deliveryIntentFromStartedAttempt(row: GitOpsHistoryRow): ReconcileDeliveryIntent {
        const decoded = decodeGitOpsJson(row.after_json);
        if (!isRecord(decoded) || !isRecord(decoded.deliveryIntent)) {
            throw new GitOpsJsonError('reserved webhook attempt has no delivery intent');
        }
        const { autoApply, deploy } = decoded.deliveryIntent;
        if (typeof autoApply !== 'boolean' || typeof deploy !== 'boolean') {
            throw new GitOpsJsonError('reserved webhook attempt has an invalid delivery intent');
        }
        return GitSourceService.deliveryIntent(autoApply, deploy);
    }

    private static deliveryIntent(autoApply: boolean, deploy: boolean): ReconcileDeliveryIntent {
        return autoApply ? { autoApply: true, deploy } : { autoApply: false, deploy: false };
    }

    /**
     * Legacy-boolean to tri-state derivation. An explicit sourcePolicy wins;
     * boolean true means automatic; boolean false leaves an existing policy
     * alone and only defaults to review when the row has none (webhooks always
     * fetched before consulting the boolean, so 0 was review, not manual).
     */
    public static resolveSourcePolicy(
        existing: SourcePolicy | null,
        input: { sourcePolicy?: SourcePolicy; autoApplyOnWebhook: boolean },
    ): SourcePolicy {
        if (input.sourcePolicy) return input.sourcePolicy;
        if (input.autoApplyOnWebhook) return 'automatic';
        return existing ?? 'review';
    }

    /**
     * Effective auto-apply for the live application, falling back to the
     * stored legacy boolean when no application row models the source. When a
     * row exists its policy is authoritative, so a stale `1` boolean on a
     * manual or review row never re-enables automation behind the projection.
     */
    private effectiveAutoApply(stackName: string, fallback: boolean): boolean {
        const policy = this.gitopsApplicationFor(stackName)?.source_policy;
        return policy !== undefined ? policy === 'automatic' : fallback;
    }

    /**
     * Decode a settled attempt's recorded result back into a
     * ReconcileResult. Unreadable JSON and a well-formed-but-wrong-shaped
     * payload are both logged: a corrupt or unexpected settled row is a
     * storage or encoding bug an operator needs to see, not a routine
     * response variation, matching decodeHistoryDelta's own rule for this
     * exact column.
     */
    private static resultFromSettledAttempt(row: GitOpsHistoryRow): ReconcileResult {
        const unreadable: ReconcileResult = {
            outcome: 'unknown',
            reason: 'The settled attempt result could not be read.',
            nextAction: 'none',
        };

        let decoded: unknown;
        try {
            decoded = decodeGitOpsJson(row.after_json);
        } catch (e) {
            if (!(e instanceof GitOpsJsonError)) throw e;
            console.error(`[GitSource] settled attempt ${sanitizeForLog(row.operation_id)} is not decodable JSON: ${e.message}`);
            return unreadable;
        }
        if (
            !isRecord(decoded)
            || !isReconcileOutcome(decoded.outcome)
            || typeof decoded.reason !== 'string'
            || !isNextAction(decoded.nextAction)
        ) {
            console.error(`[GitSource] settled attempt ${sanitizeForLog(row.operation_id)} decoded to an unexpected shape`);
            return unreadable;
        }
        return {
            outcome: decoded.outcome,
            reason: decoded.reason,
            nextAction: decoded.nextAction,
            retryAt: typeof decoded.retryAt === 'number' ? decoded.retryAt : undefined,
            nextPollAt: typeof decoded.nextPollAt === 'number' ? decoded.nextPollAt : undefined,
            commitSha: typeof decoded.commitSha === 'string' ? decoded.commitSha : undefined,
        };
    }

    /**
     * Startup recovery: settle every reconcile attempt that reserved but
     * never settled, most likely because the process crashed between the
     * two. Never re-executes a fetch or apply. Must run before
     * SourceController starts, so no live poll or retry tick can race a
     * recovery pass over the same attempts.
     *
     * Pages by cursor rather than by "still unsettled" status, so a row
     * this run cannot recover never blocks the rest of the backlog; see
     * listUnsettledReconcileAttempts for why that matters.
     *
     * Two passes. Pass 1 settles every independent (non-follower) attempt
     * by deriving the application's current truthful state, and defers
     * every follower rather than settling it yet, so its leader (which
     * can only be earlier in this same backlog, since a follower's own
     * reservation records that its leader was already in flight) gets a
     * chance to settle first. Pass 2 then settles each deferred follower
     * from its leader's now-settled result, so a leader and its followers
     * always agree; a follower whose leader is still unresolved is left
     * for a later recovery run, per resolveFollowerOutcome.
     *
     * One row failing to recover (a transient DB error, an application
     * deleted between listing and processing) is isolated: logged and
     * counted, never allowed to block any other row.
     */
    public async recoverUnsettledReconcileAttempts(pageSize = 200): Promise<void> {
        const store = GitOpsStore.getInstance();
        const tx = GitOpsTransitions.getInstance();
        let recovered = 0;
        let failed = 0;
        let stillWaiting = 0;
        const deferredFollowers: { row: GitOpsHistoryRow; followerOf: string }[] = [];

        const settle = (row: GitOpsHistoryRow, result: ReconcileResult): void => {
            tx.settleReconcileAttempt(
                row.application_id,
                { operationId: row.operation_id, actor: row.actor, trigger: row.trigger, at: Date.now() },
                result,
            );
            recovered++;
        };
        const noteFailure = (row: GitOpsHistoryRow, e: unknown): void => {
            failed++;
            console.error(
                `[GitSource] Failed to recover reconcile attempt ${sanitizeForLog(row.operation_id)} for application ${sanitizeForLog(row.application_id)}:`,
                e instanceof Error ? e.message : String(e),
            );
        };

        // Last-resort guard: the cursor advances strictly past every page, so
        // the loop is already bounded by the size of the backlog itself.
        const MAX_PAGES = 10_000;
        let cursor: GitOpsHistoryCursor | undefined;
        let pagesRead = 0;
        for (; pagesRead < MAX_PAGES; pagesRead++) {
            const page = store.listUnsettledReconcileAttempts(pageSize, cursor);
            if (page.length === 0) break;
            const last = page[page.length - 1];
            cursor = { createdAt: last.created_at, id: last.id };
            for (const row of page) {
                try {
                    const followerOf = GitSourceService.followerOfFromRow(row);
                    if (followerOf) {
                        deferredFollowers.push({ row, followerOf });
                        continue;
                    }
                    settle(row, this.deriveResultForApplication(row.application_id));
                } catch (e) {
                    noteFailure(row, e);
                }
            }
            if (page.length < pageSize) break;
        }
        if (pagesRead === MAX_PAGES) {
            console.warn(`[GitSource] Reconcile-attempt recovery stopped at its per-run page cap (${MAX_PAGES} pages); remaining rows will be retried on the next startup.`);
        }

        for (const { row, followerOf } of deferredFollowers) {
            try {
                const outcome = this.resolveFollowerOutcome(row.application_id, followerOf);
                if (!outcome.known) {
                    stillWaiting++;
                    continue;
                }
                settle(row, outcome.result);
            } catch (e) {
                noteFailure(row, e);
            }
        }

        if (recovered > 0 || failed > 0 || stillWaiting > 0) {
            console.log(`[GitSource] Reconcile-attempt recovery: ${recovered} settled, ${failed} could not be recovered, ${stillWaiting} still waiting on their leader.`);
        }
    }

    /** Run fetch-intent reconcile through the same durable execution as pull(). */
    private async reconcileFetch(request: ReconcileRequest & { intent: 'fetch' }): Promise<ReconcileResult> {
        const liveApp = GitOpsStore.getInstance().getLiveDirectApplication(request.stackName);
        if (!liveApp) return GitSourceService.noApplicationResult();
        if (liveApp.id !== request.applicationId) return GitSourceService.staleApplicationResult();

        const submission = await this.submitExecution(
            this.inFlightFetches,
            request,
            this.doPullWork(request.stackName, request.actor, request.applicationId),
            (outcome) => this.fetchExecutionResult(request.stackName, outcome),
        );
        return GitSourceService.resultFromSubmission(submission);
    }

    /** Normalize one shared fetch execution for its leader and all followers. */
    private fetchExecutionResult(stackName: string, outcome: WorkOutcome<PullResult>): ReconcileResult {
        return this.finalizeReconcileOutcome(stackName, outcome.status === 'rejected' ? outcome.reason : undefined);
    }

    /** Normalize one shared apply execution for its leader and all followers. */
    private applyExecutionResult(stackName: string, outcome: WorkOutcome<GitApplyResult>): ReconcileResult {
        if (outcome.status === 'fulfilled' && outcome.value.deployError) {
            return {
                outcome: 'recovery_required',
                reason: `The source applied, but the deploy failed: ${outcome.value.deployError}`,
                nextAction: 'view_target_results',
            };
        }
        return this.finalizeReconcileOutcome(stackName, outcome.status === 'rejected' ? outcome.reason : undefined);
    }

    /**
     * The result derived from the application's own row state, unless a
     * failure occurred that the derived state does not already reflect, in
     * which case the failure itself is classified instead.
     */
    private finalizeReconcileOutcome(stackName: string, failure: unknown): ReconcileResult {
        const derived = this.deriveReconcileResult(stackName);
        if (failure === undefined || GitSourceService.FAILURE_REFLECTED_OUTCOMES.has(derived.outcome)) {
            return derived;
        }
        return this.reconcileFailureResult(failure);
    }

    /**
     * A truthful fallback for a reconcile failure the application row does
     * not yet reflect. Routes through the same classifyFailure disposition
     * table the controller's own retry/backoff logic uses, so an unretryable
     * failure is never reported with nextAction: 'retry'.
     */
    private reconcileFailureResult(failure: unknown): ReconcileResult {
        if (!(failure instanceof GitSourceError)) {
            return {
                outcome: 'failed_previous_intact',
                reason: 'The reconcile attempt failed unexpectedly.',
                nextAction: 'retry',
            };
        }
        const disposition = classifyFailure({
            kind: 'git_source_error',
            code: failure.code,
            transportReason: failure.extras?.transportReason,
        });
        switch (disposition.class) {
            case 'supersession':
                return { outcome: 'superseded', reason: failure.message, nextAction: 'none' };
            case 'permanent':
                return { outcome: 'failed_previous_intact', reason: failure.message, nextAction: 'configure_credentials' };
            case 'operator_action_required':
                return { outcome: 'blocked', reason: failure.message, nextAction: 'resolve_conflict' };
            case 'reconcile':
                return { outcome: 'unknown', reason: failure.message, nextAction: 'none' };
            // 'degraded'/'target_*'/'blocked' are not reachable from a
            // git_source_error classification today, but are grouped with
            // 'transient' so this switch stays exhaustive if that changes.
            case 'transient':
            case 'degraded':
            case 'target_permanent':
            case 'target_transient':
            case 'target_mutation_failed':
            case 'blocked':
                return { outcome: 'failed_previous_intact', reason: failure.message, nextAction: 'retry' };
        }
    }

    private deriveReconcileResult(stackName: string): ReconcileResult {
        const app = GitOpsStore.getInstance().getLiveDirectApplication(stackName);
        if (!app) {
            return GitSourceService.noApplicationResult();
        }
        const projection = projectApplication(app.id, false);
        if (projection.targetMode === 'not_applicable') {
            if (projection.limitations.some((l) => l.code === 'application_row_missing')) {
                return {
                    outcome: 'recovery_required',
                    reason: 'The application this reconcile was resolved from is no longer present.',
                    nextAction: 'view_target_results',
                };
            }
            return GitSourceService.noApplicationResult();
        }
        return outcomeFromSourceFacet(projection.facets.source);
    }

    /**
     * Stop acting on a source without forgetting anything about it: no new
     * fetch, acceptance, or dispatch until resumed (enforced by the
     * suspended_at checks at the top of pullLocked/applyLockedBody, not by
     * this method itself). Takes the per-stack mutex not to reject a
     * concurrent fetch or apply, but because sourceSuspended interrupts and
     * clears any in-flight operation's active state, which would corrupt a
     * genuinely running apply's own terminal transition; a suspend queued
     * behind one instead takes effect once that work settles.
     *
     * A refused suspend is surfaced as a real error rather than swallowed:
     * silently no-op'ing here would leave an operator believing a source is
     * suspended when it is not, which is the same false-safety failure this
     * method exists to prevent.
     */
    public async suspend(stackName: string, opts: { actor: string; reason?: string }): Promise<ReconcileResult> {
        return this.withStackLock(stackName, async () => {
            const app = GitOpsStore.getInstance().getLiveDirectApplication(stackName);
            if (!app) return GitSourceService.noApplicationResult();
            const envelope = this.gitopsEnvelope(crypto.randomUUID(), opts.actor, 'suspend');
            const reason = opts.reason?.trim() || 'Suspended by operator.';
            try {
                GitOpsTransitions.getInstance().sourceSuspended(app.id, reason, envelope);
            } catch (error) {
                if (error instanceof GitOpsTransitionError) {
                    throw new GitSourceError('OPERATION_IN_FLIGHT', `Cannot suspend ${stackName}: ${error.message}`);
                }
                throw error;
            }
            return this.deriveReconcileResult(stackName);
        });
    }

    /**
     * Resume acting on a source. Does not itself fetch; the next scheduled
     * poll, retry, or manual reconcile picks the source back up.
     *
     * Unlike suspend(), a refused resume is tolerated rather than surfaced.
     * The result is read back from the row after the attempted write, so a
     * resume that did not take (already not suspended, the application
     * vanished, a transient persistence failure) still truthfully reports
     * {outcome:'suspended', nextAction:'resume'} rather than a false
     * "resumed". The caller cannot be told the source is unsuspended when it
     * is not, so there is no false-safety risk to mirror suspend()'s rethrow.
     */
    public async resume(stackName: string, opts: { actor: string }): Promise<ReconcileResult> {
        return this.withStackLock(stackName, async () => {
            const app = GitOpsStore.getInstance().getLiveDirectApplication(stackName);
            if (!app) return GitSourceService.noApplicationResult();
            const envelope = this.gitopsEnvelope(crypto.randomUUID(), opts.actor, 'resume');
            this.recordGitOps(stackName, 'source resume', () => {
                GitOpsTransitions.getInstance().sourceUnsuspended(app.id, envelope);
            });
            return this.deriveReconcileResult(stackName);
        });
    }

    /**
     * An explicit, operator-initiated re-evaluation: resolves the live
     * application server-side rather than trusting a caller-supplied id, for
     * callers that hold only a stack name, and drives a fresh fetch-intent
     * reconcile through it.
     *
     * The 'retry' trigger is recorded on the durable attempt for audit and
     * recovery. It does not yet change fetch behavior; a later permanent-
     * failure gate can use it to authorize an explicit operator retry.
     */
    public async retry(stackName: string, opts: { actor: string }): Promise<ReconcileResult> {
        const app = GitOpsStore.getInstance().getLiveDirectApplication(stackName);
        if (!app) return GitSourceService.noApplicationResult();
        return this.reconcile({
            intent: 'fetch',
            applicationId: app.id,
            stackName,
            trigger: 'retry',
            actor: opts.actor,
        });
    }

    /**
     * Route an accepted generation to its target. Blueprint mode always
     * blocks (BlueprintTargetAdapter; rollout orchestration does not exist
     * yet). Direct mode has no separate generation-based promotion pipeline
     * today, so it dispatches by driving the same reconcile()/apply path a
     * manual or webhook apply already uses, translating the normalized
     * ReconcileResult into the narrower dispatched/blocked shape a target
     * adapter reports.
     */
    public async dispatchAcceptedGeneration(
        generation: AcceptedGeneration,
        context: DispatchContext,
        opts: { trigger: ReconcileTrigger; actor: string },
    ): Promise<DispatchResult> {
        if (context.targetMode === 'blueprint') {
            return new BlueprintTargetAdapter().dispatch(generation, context);
        }
        const app = GitOpsStore.getInstance().getApplication(generation.applicationId);
        if (!app?.stack_name) {
            return { status: 'blocked', reason: 'No Direct stack is bound to this application.' };
        }
        const source = DatabaseService.getInstance().getGitSource(app.stack_name);
        const result = await this.reconcile({
            intent: 'apply',
            applicationId: generation.applicationId,
            stackName: app.stack_name,
            trigger: opts.trigger,
            actor: opts.actor,
            commitSha: generation.commitSha,
            planFingerprint: generation.changePlanFingerprint ?? '',
            deploy: source?.auto_deploy_on_apply ?? false,
        });
        // 'converged' is not produced by reconcile() today (it requires
        // target + health evidence this source-only path does not have),
        // but it is a declared success member of ReconcileOutcome; treating
        // only 'no_source_change' as success would silently misreport it as
        // blocked the day a broader derivation starts emitting it.
        if (result.outcome === 'no_source_change' || result.outcome === 'converged') {
            return { status: 'dispatched' };
        }
        return { status: 'blocked', reason: result.reason };
    }

    /**
     * Acquire the shared stack-operation lock then run applyLocked.
     * Callers that already hold the Git per-stack mutex (public apply, webhook
     * auto-apply) use this so capture/promote/handoff/deploy cannot race other
     * lifecycle ops. Do not nest withStackLock here.
     */
    private async applyWithSharedLock(
        stackName: string,
        commitSha: string,
        opts: GitApplyOpts,
        operationId?: string,
    ): Promise<{ applied: boolean; deployed: boolean; deployError?: string; recoveryId?: string }> {
        const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
        const lock = await StackOpLockService.getInstance().runExclusive(
            nodeId,
            stackName,
            'git_apply',
            opts.actor ?? 'system:git-source',
            () => this.applyLocked(stackName, commitSha, opts, operationId),
            getRegistryDeliveryLockContext(),
        );
        if (!lock.ran) {
            throw new GitSourceError(
                'GIT_ERROR',
                `Another operation (${lock.existing.action}) is already in progress for ${stackName}.`,
            );
        }
        return lock.result;
    }

    /** Body of apply(); assumes the caller already holds Git mutex + shared stack lock. */
    /**
     * Apply a pending pull, recording the attempt as a GitOps operation.
     *
     * The wrapper exists so a throw anywhere in the body still closes the
     * operation. An apply that started and never terminated would leave the
     * source projecting `applying` until the next restart reclassified it as an
     * interruption, which reads as "still working" when nothing is.
     */
    private async applyLocked(
        stackName: string,
        commitSha: string,
        opts: GitApplyOpts,
        operationId?: string,
    ): Promise<{ applied: boolean; deployed: boolean; deployError?: string; recoveryId?: string }> {
        const started: { app: GitOpsApplicationRow | null; env: ReturnType<GitSourceService['gitopsEnvelope']> | null; settled: boolean } = {
            app: null,
            env: null,
            settled: false,
        };
        try {
            return await this.applyLockedBody(stackName, commitSha, opts, started, operationId);
        } catch (e) {
            if (started.app && started.env && !started.settled) {
                const app = started.app;
                const env = started.env;
                this.recordGitOps(stackName, 'apply failure', () => {
                    GitOpsTransitions.getInstance().applyFailed(
                        app.id,
                        e instanceof GitSourceError ? e.code : 'apply',
                        env,
                    );
                });
            }
            throw e;
        }
    }

    private async applyLockedBody(
        stackName: string,
        commitSha: string,
        opts: GitApplyOpts,
        started: { app: GitOpsApplicationRow | null; env: ReturnType<GitSourceService['gitopsEnvelope']> | null; settled: boolean },
        operationId?: string,
    ): Promise<{ applied: boolean; deployed: boolean; deployError?: string; recoveryId?: string }> {
        const diag = isDebugEnabled();
        const db = DatabaseService.getInstance();
        const src = db.getGitSource(stackName);
        if (!src) throw new GitSourceError('GIT_ERROR', 'No Git source configured for this stack.');
        // Same reasoning as pullLocked's guard: applyStarted's own suspension
        // check is swallowed by recordGitOps once promotion is already
        // underway, so stop the promotion before it starts, not after.
        if (this.gitopsApplicationFor(stackName)?.suspended_at) {
            throw new GitSourceError('OPERATION_IN_FLIGHT', `Reconciliation is suspended for ${stackName}.`);
        }

        if (!src.pending_commit_sha || !src.pending_compose_content) {
            throw new GitSourceError('GIT_ERROR', 'No pending pull to apply. Fetch the source again.');
        }
        if (src.pending_commit_sha !== commitSha) {
            if (diag) console.log('[GitSource:diag] apply sha mismatch stack=%s expected=%s pending=%s', sanitizeForLog(stackName), sanitizeForLog(commitSha.slice(0, 7)), sanitizeForLog(src.pending_commit_sha.slice(0, 7)));
            throw new GitSourceError('GIT_ERROR', 'Pending commit has changed since this pull was fetched. Please review the latest diff.');
        }

        // Materialize from the pending blob (its files + contextDir), never the
        // live config: a config edit between pull and apply must not change what
        // gets written.
        const pending = this.decodePendingCompose(src.pending_compose_content);
        if (pending.version === 2 || pending.version === 3 || pending.version === 'plaintext') {
            throw new GitSourceError('LEGACY_PENDING', 'Pending update was stored before classified review. Pull again to rebuild it.');
        }
        if (
            pending.version !== 4
            || pending.inventory === null
            || !pending.planFingerprint
            || pending.planSchemaVersion !== GIT_CHANGE_PLAN_SCHEMA_VERSION
            || !pending.operationId
        ) {
            throw new GitSourceError('PLAN_UNAVAILABLE', 'Pending update cannot be reviewed; pull again.');
        }
        const requireFingerprint = opts.requirePlanFingerprint !== false;
        if (requireFingerprint && (!opts.planFingerprint || !opts.planFingerprint.trim())) {
            throw new GitSourceError('PLAN_FINGERPRINT_REQUIRED', 'planFingerprint is required to apply this pull.');
        }
        const envContent = src.pending_env_content !== null
            ? this.crypto.decrypt(src.pending_env_content)
            : null;
        const manifestSvc = GitProjectManifestService.getInstance();
        const recoverySvc = StackUpdateRecoveryService.getInstance();
        const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
        const actor = opts.actor ?? 'system:git-source';
        let recoveryId: string | undefined;

        // The apply is bound to the candidate the pull recorded. Without one
        // there is nothing to accept, so the acceptance below is skipped rather
        // than inventing a generation from the pending blob.
        const gitopsApp = this.gitopsApplicationFor(stackName);
        // The candidate must be the generation built from the commit being
        // applied. Without this check a candidate left behind by a swallowed
        // fetch outcome would be accepted for files from a different commit,
        // and the projection would confidently report the wrong one.
        const candidateId = gitopsApp?.candidate_generation_id ?? null;
        const candidateGeneration = candidateId
            ? GitOpsStore.getInstance().getGeneration(candidateId)
            : undefined;
        const gitopsGenerationId = candidateGeneration?.commit_sha === commitSha ? candidateId : null;
        if (candidateId && !gitopsGenerationId) {
            console.warn(
                '[GitOps] Skipping acceptance for %s: the recorded candidate is not built from %s',
                sanitizeForLog(stackName), sanitizeForLog(commitSha.slice(0, 7)),
            );
        }
        // A caller that reserved a durable attempt for this apply passes its own
        // operation id in, so the attempt and its gitops transitions
        // (applyStarted/applied/applyFailed) share one identity. A caller that
        // reserved none falls back to the fetch-time pending.operationId, as
        // every caller did before reservation existed. The activity messages
        // below reuse this same value, not pending.operationId directly, so
        // they report the id the durable evidence for this apply actually
        // carries rather than the earlier fetch attempt's.
        const applyOperationId = operationId ?? pending.operationId;
        const gitopsEnv = this.gitopsEnvelope(applyOperationId, actor, 'apply');
        if (gitopsApp && gitopsGenerationId) {
            this.recordGitOps(stackName, 'apply start', () => {
                GitOpsTransitions.getInstance().applyStarted(gitopsApp.id, gitopsGenerationId, gitopsEnv);
                started.app = gitopsApp;
                started.env = gitopsEnv;
            });
        }

        let appliedSpec: GitSourceAppliedSpec | null;
        if (pending.candidateRelPath !== null && pending.inventory !== null) {
            // ── Complete-project path (v4 pending) ───────────────────────────
            const prior = await manifestSvc.readManifest(stackName, src.repo_url, src.branch);
            if (prior !== null && 'corrupt' in prior) {
                // Any identity-stamp corruption (missing identity, node/stack/
                // repo/branch mismatch) is unrecoverable by pulling (a pull
                // never replaces the manifest file); the actionable escape is
                // detach + re-link.
                const identityMismatch = prior.corrupt.includes('identity');
                throw new GitSourceError(
                    'GIT_ERROR',
                    identityMismatch
                        ? `The managed-project manifest for ${stackName} is stamped for a different repository or branch. Detach the Git source, then re-link it to the current repository and branch.`
                        : `The managed-project manifest for ${stackName} cannot be trusted (${prior.corrupt}). Detach the Git source and re-link it to rebuild the managed project.`,
                );
            }

            // The staged candidate must still exist and be complete; a deleted
            // candidate (or a node restart that swept it) invalidates the pull.
            const deliveryPrepId = getRegistryDeliveryContext()?.envelope.prepId;
            if (deliveryPrepId) {
                await this.restoreApplyFromPreparedGitCandidate(
                    deliveryPrepId,
                    stackName,
                    commitSha,
                    pending.candidateRelPath,
                );
            }
            const managedRoot = path.resolve(stackManagedRoot(stackName));
            const pathReason = validateCandidateRelPath(pending.candidateRelPath, managedRoot);
            if (pathReason) throw new GitSourceError('GIT_ERROR', pathReason);
            // Inline barrier at the access sink (CodeQL path-injection).
            const candidateAbs = path.resolve(managedRoot, pending.candidateRelPath);
            if (!candidateAbs.startsWith(managedRoot + path.sep)) {
                throw new GitSourceError('GIT_ERROR', 'candidateRelPath escapes the managed root');
            }
            try {
                await fsPromises.access(candidateAbs);
            } catch (accessErr: unknown) {
                const code = (accessErr as NodeJS.ErrnoException).code;
                if (code !== 'ENOENT') {
                    console.error(
                        `[GitSource] candidate access failed for ${sanitizeForLog(stackName)}:`,
                        accessErr instanceof Error ? accessErr.message : String(accessErr),
                    );
                    throw new GitSourceError('GIT_ERROR', 'Cannot read the pending candidate; try again.');
                }
                throw new GitSourceError('GIT_ERROR', 'Pending update was invalidated; pull again.');
            }

            // Re-validate the exact candidate before touching the live project.
            const candValidation = await this.validateCandidate(
                stackName,
                pending.candidateRelPath,
                src.compose_paths,
                src.context_dir,
                src.sync_env,
            );
            if (!candValidation.ok) {
                if (diag) console.log(`[GitSource:diag] apply candidate validation fail stack=${stackName}`);
                throw new GitSourceError('GIT_ERROR', `Candidate validation failed: ${candValidation.error}`);
            }

            const plan = await this.computeChangePlan({
                stackName,
                commitSha,
                mode: 'update',
                src,
                inventory: pending.inventory,
                envContent,
                prior: prior ?? null,
                reviewedLiveHashes: this.reviewedLiveMap(pending.reviewedLive),
            });
            const publicPlan = GitChangePlanService.getInstance().toPublic(plan);
            if (plan.fingerprint !== pending.planFingerprint || plan.blocked !== (src.pending_plan_blocked === true)) {
                db.updateGitSourcePendingPlan(
                    stackName,
                    this.encodePendingCompose(
                        pending.files,
                        pending.contextDir,
                        pending.candidateRelPath,
                        pending.inventory,
                        {
                            fingerprint: plan.fingerprint,
                            schemaVersion: GIT_CHANGE_PLAN_SCHEMA_VERSION,
                            operationId: pending.operationId,
                            reviewedLive: pending.reviewedLive,
                        },
                    ),
                    {
                        fingerprint: plan.fingerprint,
                        blocked: plan.blocked,
                        summary: JSON.stringify(GitChangePlanService.getInstance().toPendingSummary(plan)),
                    },
                );
            }
            if (requireFingerprint && opts.planFingerprint !== plan.fingerprint) {
                throw new GitSourceError(
                    'STALE_PLAN',
                    'The change plan is stale. Review the updated plan before applying.',
                    { plan: publicPlan, planFingerprint: plan.fingerprint },
                );
            }
            const blockedPlanActivity = `Git plan blocked for ${stackName} (${commitSha.slice(0, 7)}, op ${GitSourceService.shortOperationId(applyOperationId)}, plan ${plan.fingerprint.slice(0, 12)})`;
            if (plan.blocked) {
                this.upsertGitPlanDrift(stackName, plan);
                db.setGitSourceLastPlan(stackName, plan.fingerprint, 'blocked');
                if (src.pending_plan_blocked !== true) {
                    this.recordGitActivity(
                        stackName,
                        'git_plan_blocked',
                        blockedPlanActivity,
                        actor,
                        'warning',
                    );
                }
                throw new GitSourceError(
                    'PLAN_BLOCKED',
                    'The change plan is blocked by local conflicts. Resolve them before applying.',
                    { plan: publicPlan, planFingerprint: plan.fingerprint },
                );
            }
            // Unattended apply (webhook auto-write) still refuses invocation drift.
            if (!requireFingerprint && plan.invocationBlocked) {
                db.setGitSourceLastPlan(stackName, plan.fingerprint, 'blocked');
                this.recordGitActivity(
                    stackName,
                    'git_plan_blocked',
                    blockedPlanActivity,
                    actor,
                    'warning',
                );
                throw new GitSourceError(
                    'PLAN_BLOCKED',
                    'The live Compose invocation no longer matches the last applied generation. Review the change plan and apply it to record the incoming invocation.',
                    { plan: publicPlan, planFingerprint: plan.fingerprint },
                );
            }

            // Assemble the new manifest from the pull-time inventory.
            const syncEnvEntry: ComposeInputEntry | null =
                src.sync_env && envContent !== null
                    ? {
                          sourcePath: null,
                          materializedPath: '.env',
                          role: 'env',
                          dependencyKind: 'sync-env',
                          ownership: 'managed',
                          provenance: 'fetch',
                          sensitivity: 'high',
                          contentSha256: crypto.createHash('sha256').update(envContent).digest('hex'),
                          sizeBytes: Buffer.byteLength(envContent, 'utf8'),
                          state: 'present',
                          deletionAuthority: 'sencho',
                          note: null,
                      }
                    : null;
            const invocation = plan.candidateInvocation;
            const manifest = manifestSvc.buildManifest({
                stackName,
                repoUrl: src.repo_url,
                branch: src.branch,
                commitSha,
                projectRoot: src.context_dir,
                composeFiles: src.compose_paths,
                projectName: stackName,
                invocation,
                inputs: mergeSyncEnvEntry(pending.inventory.inputs, syncEnvEntry),
                refusals: pending.inventory.refusals,
                buildContexts: pending.inventory.buildContexts,
                bounds: manifestSvc.boundsConfig(),
                priorManifest: prior ?? null,
                state: pending.inventory.refusals.length > 0 ? 'partial' : 'active',
            });
            // An existing pre-manifest stack (legacy Git source) adopts ONLY
            // the paths the legacy format owned: the applied compose files and
            // the synced .env. Every other existing file at an introduced path
            // is a local file the incoming generation must not overwrite.
            const legacyOwnedPaths = prior
                ? undefined
                : [
                      ...(src.applied_deploy_spec?.files ?? [PRIMARY_COMPOSE_FILENAME]),
                      ...(src.sync_env ? ['.env'] : []),
                  ];
            try {
                const candidate = await recoverySvc.captureCandidate({
                    nodeId,
                    stackName,
                    createdBy: opts.actor ?? 'git-source',
                    operationKind: 'git_apply',
                });
                recoveryId = candidate.id;
            } catch (captureError) {
                const detail = captureError instanceof Error ? captureError.message : String(captureError);
                console.error(
                    `[GitSource] Recovery capture failed before apply of ${sanitizeForLog(stackName)}:`,
                    detail,
                );
                throw new GitSourceError(
                    'GIT_ERROR',
                    `Rollback capture failed before apply; refusing to promote without recovery coverage: ${scrubCredentials(detail)}`,
                );
            }
            try {
                await manifestSvc.promoteGeneration(stackName, {
                    sha: commitSha,
                    candidateRelPath: pending.candidateRelPath,
                    manifest,
                    priorManifest: prior ?? null,
                    adoptExistingMaterializedPaths: legacyOwnedPaths,
                });
            } catch (e) {
                // Pre-mutation refusals and promotion failures surface as
                // GitSourceErrors. Typed PromoteGenerationError records whether
                // restore confirmed so last_plan_outcome never claims a rollback
                // that did not happen.
                if (recoveryId) {
                    try {
                        await recoverySvc.abandon(recoveryId);
                    } catch (abandonError) {
                        console.warn(
                            `[GitSource] Failed to abandon recovery after promote failure for ${sanitizeForLog(stackName)}:`,
                            abandonError instanceof Error ? abandonError.message : String(abandonError),
                        );
                    }
                }
                if (e instanceof GitSourceError) throw e;
                const raw = e instanceof Error ? e.message : String(e);
                console.error(`[GitSource] promotion failed for ${sanitizeForLog(stackName)}:`, e instanceof Error ? e.stack ?? e.message : raw);
                const sensitivePaths = manifest.inputs
                    .filter((i) => i.sensitivity === 'high' && i.materializedPath !== null)
                    .map((i) => i.materializedPath!);
                let redacted = raw;
                for (const rel of sensitivePaths) {
                    redacted = redacted.split(rel).join('[redacted]');
                }
                const phase = e instanceof PromoteGenerationError ? e.phase : 'pre_mutation';
                if (phase === 'restored') {
                    db.setGitSourceLastPlan(stackName, plan.fingerprint, 'rolled_back');
                    this.recordGitActivity(
                        stackName,
                        'git_apply_rolled_back',
                        `Git apply rolled back for ${stackName} (${commitSha.slice(0, 7)}, op ${GitSourceService.shortOperationId(applyOperationId)}, plan ${plan.fingerprint.slice(0, 12)})`,
                        actor,
                        'warning',
                    );
                } else {
                    db.setGitSourceLastPlan(stackName, plan.fingerprint, 'failed');
                    this.recordGitActivity(
                        stackName,
                        'git_apply_failed',
                        `Git apply failed for ${stackName} (${commitSha.slice(0, 7)}, op ${GitSourceService.shortOperationId(applyOperationId)}, plan ${plan.fingerprint.slice(0, 12)})`,
                        actor,
                        'error',
                    );
                }
                throw new GitSourceError('GIT_ERROR', scrubCredentials(redacted));
            }
            appliedSpec = this.deriveAppliedSpec(src.compose_paths, src.context_dir);
            db.setGitSourceLastPlan(stackName, plan.fingerprint, 'applied');
            DriftLedgerService.getInstance().resolveManagedPathConflicts(nodeId, stackName);
            this.recordGitActivity(
                stackName,
                'git_apply',
                `Git apply succeeded for ${stackName} (${commitSha.slice(0, 7)}, op ${GitSourceService.shortOperationId(applyOperationId)}, plan ${plan.fingerprint.slice(0, 12)})`,
                actor,
            );
            // Promotion has committed and rewritten the authoritative Compose
            // files, so cached stats/statuses/project-name state is stale here
            // whether or not a deploy follows. This must fire exactly once per
            // successful promotion, from every trigger, not only the manual
            // apply route (which used to invalidate here itself).
            invalidateNodeCaches(nodeId);
        } else {
            throw new GitSourceError('PLAN_UNAVAILABLE', 'Pending update cannot be reviewed; pull again.');
        }

        const hash = this.hashContent(pending.files, envContent);
        db.markGitSourceApplied(stackName, commitSha, hash);
        db.setGitSourceAppliedSpec(stackName, appliedSpec);

        // The files are on disk and the source row now points at this commit,
        // so this is where the generation becomes the accepted one.
        if (gitopsApp && gitopsGenerationId) {
            const recorded = this.recordGitOps(stackName, 'acceptance', () => {
                GitOpsTransitions.getInstance().applied({
                    applicationId: gitopsApp.id,
                    generationId: gitopsGenerationId,
                    artifactSetId: newGitOpsId(),
                    sourceAcceptanceId: newGitOpsId(),
                    authority: actor === 'system:webhook' ? 'configured_policy' : 'operator',
                    envelope: gitopsEnv,
                });
            });
            started.settled = true;
            // The files are on disk either way. What we can still control is
            // not leaving the operation open when the acceptance was rejected.
            if (!recorded) this.abandonGitOpsOperation(stackName, gitopsApp.id, gitopsEnv);
        }

        const shouldDeploy = opts.deploy ?? src.auto_deploy_on_apply;
        if (diag) console.log('[GitSource:diag] apply wrote stack=%s sha=%s deploy=%s', sanitizeForLog(stackName), sanitizeForLog(commitSha.slice(0, 7)), sanitizeForLog(shouldDeploy));

        const finalizeRecoveryCurrent = async (id: string, immediateVerified: boolean): Promise<void> => {
            if (!recoverySvc.markAcquired(id)) {
                await recoverySvc.abandon(id);
                throw new Error('Failed to mark recovery generation as acquired');
            }
            if (!recoverySvc.handoff(id, nodeId, stackName)) {
                await recoverySvc.abandon(id);
                throw new Error('Failed to hand off recovery generation');
            }
            if (!recoverySvc.markReconciling(id)) {
                throw new Error('Failed to mark recovery generation as reconciling');
            }
            if (immediateVerified && !recoverySvc.markImmediateVerified(id)) {
                console.warn(`[GitSource] Could not CAS immediate_verified for recovery ${sanitizeForLog(id)}`);
            }
        };

        if (shouldDeploy) {
            try {
                await assertPolicyGateAllows(
                    stackName,
                    nodeId,
                    buildSystemPolicyGateOptions(opts.actor ?? 'git-source', {
                        bypass: opts.bypassPolicy === true,
                        auditPath: `/api/stacks/${stackName}/git-source/apply`,
                    }),
                );
                if (recoveryId) {
                    await finalizeRecoveryCurrent(recoveryId, false);
                }
                // Shared stack lock already held as git_apply for capture→deploy.
                const autoDeploy = await ComposeService.getInstance(nodeId).deployStack(
                    stackName,
                    undefined,
                    undefined,
                    { source: 'git_apply', actor: opts.actor ?? 'system:git-source' },
                );
                if (recoveryId) {
                    if (!recoverySvc.markImmediateVerified(recoveryId)) {
                        console.warn(`[GitSource] Could not CAS immediate_verified for recovery ${sanitizeForLog(recoveryId)}`);
                    }
                }
                const healthGateId = HealthGateService.getInstance().beginStack(
                    nodeId,
                    stackName,
                    'deploy',
                    'system:git-source',
                    { deployedGenerationId: autoDeploy.deployedGenerationId },
                );
                if (recoveryId) {
                    recoverySvc.linkGateOrRetain(recoveryId, healthGateId);
                }
                console.log(`[GitSource] Applied and deployed ${stackName} at ${commitSha.slice(0, 7)}`);
                // Fire-and-forget, matching the manual apply route's prior
                // placement: the scan runs only after a successful deploy and
                // must never delay or fail the apply response.
                triggerPostDeployScan(stackName, nodeId).catch((err) =>
                    console.error(`[Security] Post-deploy scan failed for ${sanitizeForLog(stackName)}:`, err),
                );
                return { applied: true, deployed: true, recoveryId };
            } catch (e) {
                // R1: do not auto-compensate. Keep applied files and leave the
                // pre-promote generation is_current for manual rollback.
                if (recoveryId) {
                    const row = recoverySvc.get(recoveryId);
                    if (row && row.is_current !== 1) {
                        try {
                            await finalizeRecoveryCurrent(recoveryId, false);
                        } catch (handoffError) {
                            console.warn(
                                `[GitSource] Failed to hand off recovery after deploy failure for ${sanitizeForLog(stackName)}:`,
                                handoffError instanceof Error ? handoffError.message : String(handoffError),
                            );
                        }
                    }
                }
                const scrubbed = scrubCredentials((e as Error).message || String(e));
                console.error(`[GitSource] Auto-deploy failed for ${stackName}: ${scrubbed}`);
                return { applied: true, deployed: false, deployError: scrubbed, recoveryId };
            }
        }

        if (recoveryId) {
            try {
                await finalizeRecoveryCurrent(recoveryId, true);
            } catch (finalizeError) {
                const detail = finalizeError instanceof Error ? finalizeError.message : String(finalizeError);
                console.error(
                    `[GitSource] Failed to finalize recovery for apply-only ${sanitizeForLog(stackName)}:`,
                    detail,
                );
                return {
                    applied: true,
                    deployed: false,
                    deployError: `Recovery finalization failed after apply: ${scrubCredentials(detail)}`,
                    recoveryId,
                };
            }
        }
        console.log(`[GitSource] Applied ${stackName} at ${commitSha.slice(0, 7)}`);
        return { applied: true, deployed: false, recoveryId };
    }

    public dismissPending(stackName: string, actor?: string): void {
        const app = GitOpsStore.getInstance().getLiveDirectApplication(stackName);
        if (app?.candidate_generation_id) {
            try {
                GitOpsTransitions.getInstance().dismissed(
                    app.id,
                    this.gitopsEnvelope(crypto.randomUUID(), actor ?? 'system:git-source', 'dismiss'),
                );
            } catch (error) {
                // The refusal is the outcome the operator must see. Swallowing it
                // here would leave the projection offering a candidate they just
                // declined, which is exactly the stale state dismissal exists to
                // prevent.
                if (error instanceof GitOpsTransitionError) {
                    throw new GitSourceError(
                        'OPERATION_IN_FLIGHT',
                        `Cannot dismiss the pending update for ${stackName}: ${error.message}`,
                    );
                }
                throw error;
            }
        }
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

            // Apply-matrix sanity for create: auto-deploy requires the effective
            // policy to be automatic. Create defaults to review when no explicit
            // policy arrives, so a legacy boolean of false stays review.
            const effectivePolicy = GitSourceService.resolveSourcePolicy(null, input);
            if (input.autoDeployOnApply && effectivePolicy !== 'automatic') {
                throw new GitSourceError('GIT_ERROR', 'Auto-deploy requires the automatic source policy.');
            }

            const gitopsOperationId = crypto.randomUUID();
            // Inline containment barrier at the stat sink. CodeQL does not
            // credit the wrapped isPathWithinBase helper, so resolve against the
            // managed-area base and check containment right here.
            const areaBase = managedAreaBase();
            const managedRoot = path.resolve(stackManagedRoot(input.stackName));
            if (!managedRoot.startsWith(areaBase + path.sep)) {
                throw new GitSourceError('GIT_ERROR', 'Invalid stack path');
            }
            // Whether the managed root is ours to delete is decided once, here,
            // before anything can create it. Cleanup later reads this answer
            // rather than re-probing a directory it may itself have made.
            const rootPreexisted = existsSync(managedRoot);
            const gitopsIdentity = directSourceIdentity({
                repoUrl: input.repoUrl,
                branch: input.branch,
                composePaths: input.composePaths,
                contextDir: input.contextDir,
                syncEnv: input.syncEnv,
                envPath: input.envPath,
            });
            const staged: { candidateRelPath: string | null } = { candidateRelPath: null };

            const createDeployKeyTrust = input.authType === 'deploy_key'
                ? (() => {
                    if (!input.deployKey?.trim() || !input.sshKnownHostsEntry?.trim()) {
                        throw new GitSourceError(
                            'GIT_ERROR',
                            'Deploy key authentication requires a private key and a trusted SSH host key.',
                        );
                    }
                    return {
                        encryptedDeployKey: this.crypto.encrypt(input.deployKey.trim()),
                        ...this.resolveSshTrustFromKnownHostsEntry(
                            input.sshKnownHostsEntry,
                            input.sshHostKeyFingerprint,
                        ),
                    };
                })()
                : null;

            const encryptedCaBundle = this.resolveEncryptedCaBundle(input.caBundle, undefined);
            const caBundlePem = this.decryptCaBundlePem(encryptedCaBundle);

            // 1. Fetch from git BEFORE touching disk or DB. If the fetch
            //    fails there is nothing to clean up. The onClone hook stages
            //    the complete-project candidate inside the clone lifecycle.
            const manifestSvc = GitProjectManifestService.getInstance();
            const materialization: { value: MaterializationResult | null } = { value: null };
            const deliveryPrepId = getRegistryDeliveryContext()?.envelope.prepId;
            let fetched: FetchResult;
            const createFetchAuth = input.authType === 'token'
                ? { token: input.token, caBundlePem }
                : createDeployKeyTrust
                    ? {
                        sshAuth: {
                            privateKey: input.deployKey!.trim(),
                            knownHostsEntry: createDeployKeyTrust.sshKnownHostsEntry,
                        },
                        caBundlePem,
                    }
                    : { token: null, caBundlePem };
            try {
                if (deliveryPrepId) {
                    const restored = await this.restoreCreateFromPreparedGitCandidate(
                        deliveryPrepId,
                        managedRoot,
                        rootPreexisted,
                        gitopsOperationId,
                        staged,
                    );
                    fetched = restored.fetched;
                    materialization.value = restored.materialization;
                } else {
                    fetched = await this.fetchFromGit({
                        repoUrl: input.repoUrl,
                        branch: input.branch,
                        composePaths: input.composePaths,
                        envPath: input.syncEnv ? input.envPath : null,
                        ...createFetchAuth,
                        onClone: async (cloneDir, commitSha, envContent) => {
                            // The candidate path is recorded before the build that
                            // creates it, so a crash mid-build still names exactly one
                            // directory this operation owns.
                            staged.candidateRelPath = candidateRelPathForSha(commitSha);
                            await writeStagingMarker(managedRoot, {
                                schemaVersion: 1,
                                operationId: gitopsOperationId,
                                rootPreexisted,
                                candidateRelPath: staged.candidateRelPath,
                                createdAt: Date.now(),
                            });
                            materialization.value = await this.buildMaterialization(input.stackName, cloneDir, commitSha, {
                                compose_paths: input.composePaths,
                                context_dir: input.contextDir,
                                sync_env: input.syncEnv,
                            }, envContent);
                        },
                    });
                }
            } catch (e) {
                // Materialization refuses routinely, not just on crashes. The
                // marker has to come off with the staged files, or it would
                // claim this managed area against every later attempt and make
                // the stack name uncreatable until the next restart.
                await this.cleanupStagedCreate(managedRoot, staged.candidateRelPath, rootPreexisted);
                throw e;
            }

            // 2. Validate against the same `docker compose config` check the
            //    apply path uses. Reject before creating anything on disk.
            const validation = materialization.value
                ? materialization.value.validation
                : await this.validateCompose(fetched.composeFiles, fetched.envContent, input.contextDir);
            if (!validation.ok) {
                await this.cleanupStagedCreate(managedRoot, staged.candidateRelPath, rootPreexisted);
                throw new GitSourceError('GIT_ERROR', `Compose validation failed: ${validation.error}`);
            }

            // 3. Classify the candidate against live disk (the stack directory
            //    does not exist yet), then create the stack and promote.
            //    createStack() throws if the directory already exists.
            let stackCreated = false;
            let rowInserted = false;
            // Promotion persists the manifest cache columns BEFORE the row
            // exists (zero rows updated); the cache is written again after the
            // insert below so list and immediate projections report the real
            // state instead of 'absent'.
            let completeProjectManifest: GitProjectManifest | null = null;
            let recordedCreatePlan: GitChangePlan | null = null;
            // Set once the activation transaction commits. Before that there is
            // nothing in the database to tear down; after it, cleanup has to go
            // through create_failed so the checkpoint and tombstone stay
            // consistent with what was removed from disk.
            let gitopsApplicationId: string | null = null;
            let gitopsCommitted = false;
            try {
                let appliedSpec: GitSourceAppliedSpec | null;
                if (materialization.value) {
                    const inputs = materialization.value.inventory.inputs.filter(
                        (i) => i.ownership === 'managed' && i.state === 'present' && i.materializedPath !== null,
                    );
                    const syncEnvEntry: ComposeInputEntry | null =
                        input.syncEnv && fetched.envContent !== null
                            ? {
                                  sourcePath: null,
                                  materializedPath: '.env',
                                  role: 'env',
                                  dependencyKind: 'sync-env',
                                  ownership: 'managed',
                                  provenance: 'fetch',
                                  sensitivity: 'high',
                                  contentSha256: crypto.createHash('sha256').update(fetched.envContent).digest('hex'),
                                  sizeBytes: Buffer.byteLength(fetched.envContent, 'utf8'),
                                  state: 'present',
                                  deletionAuthority: 'sencho',
                                  note: null,
                              }
                            : null;
                    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
                    const stackDir = path.resolve(NodeRegistry.getInstance().getComposeDir(nodeId), input.stackName);
                    const invocation = buildCandidateComposeInvocation({
                        stackName: input.stackName,
                        composePaths: input.composePaths,
                        contextDir: input.contextDir,
                        stackDir,
                        syncEnv: input.syncEnv,
                        envContentPresent: fetched.envContent !== null,
                        projectEnvFiles: db.getStackProjectEnvFiles(nodeId, input.stackName),
                        rootEnvFilePresent: fetched.envContent !== null,
                    });
                    const manifest = manifestSvc.buildManifest({
                        stackName: input.stackName,
                        repoUrl: input.repoUrl,
                        branch: input.branch,
                        commitSha: fetched.commitSha,
                        projectRoot: input.contextDir,
                        composeFiles: input.composePaths,
                        projectName: input.stackName,
                        invocation,
                        inputs: mergeSyncEnvEntry(inputs, syncEnvEntry),
                        refusals: materialization.value.inventory.refusals,
                        buildContexts: materialization.value.inventory.buildContexts,
                        bounds: manifestSvc.boundsConfig(),
                        priorManifest: null,
                        state: materialization.value.inventory.refusals.length > 0 ? 'partial' : 'active',
                    });
                    const createPlan = await this.computeChangePlan({
                        stackName: input.stackName,
                        commitSha: fetched.commitSha,
                        mode: 'create',
                        src: {
                            stack_name: input.stackName,
                            repo_url: input.repoUrl,
                            branch: input.branch,
                            compose_path: input.composePaths[0],
                            compose_paths: input.composePaths,
                            context_dir: input.contextDir,
                            sync_env: input.syncEnv,
                            env_path: input.syncEnv ? input.envPath : null,
                            auth_type: input.authType,
                            encrypted_token: null,
                            auto_apply_on_webhook: false,
                            auto_deploy_on_apply: false,
                            last_applied_commit_sha: null,
                            last_applied_content_hash: null,
                            pending_commit_sha: null,
                            pending_compose_content: null,
                            pending_env_content: null,
                            pending_fetched_at: null,
                            last_debounce_at: null,
                            applied_deploy_spec: this.deriveAppliedSpec(input.composePaths, input.contextDir),
                        } as StackGitSource,
                        inventory: materialization.value.inventory,
                        envContent: fetched.envContent,
                        prior: null,
                    });
                    if (createPlan.blocked) {
                        throw new GitSourceError(
                            'GIT_ERROR',
                            `Git create blocked for ${input.stackName}: the managed-file change plan reported blocking operations.`,
                        );
                    }
                    recordedCreatePlan = createPlan;
                    completeProjectManifest = manifest;
                }

                // 3b. Persist the GitOps identity of this create. Everything
                //     above is still reversible by deleting files; from here on
                //     recovery is driven by the checkpoint instead of guesswork.
                if (completeProjectManifest && materialization.value && staged.candidateRelPath) {
                    const applicationId = newGitOpsId();
                    const envelope = {
                        operationId: gitopsOperationId,
                        actor: 'system:git-source',
                        trigger: 'create',
                        at: Date.now(),
                    };
                    const sourceConfig = {
                        repoUrl: input.repoUrl,
                        branch: input.branch,
                        composePaths: input.composePaths,
                        contextDir: input.contextDir,
                        syncEnv: input.syncEnv,
                        envPath: input.envPath,
                    };
                    GitOpsTransitions.getInstance().activateCreateFromGit({
                        application: buildDirectApplicationRow({
                            id: applicationId,
                            stackName: input.stackName,
                            config: sourceConfig,
                            identity: gitopsIdentity,
                            lifecycleStatus: 'creating',
                            at: envelope.at,
                        }, effectivePolicy),
                        nodeId: NodeRegistry.getInstance().getDefaultNodeId(),
                        commitSha: fetched.commitSha,
                        generation: buildGenerationRow({
                            id: newGitOpsId(),
                            applicationId,
                            commitSha: fetched.commitSha,
                            identity: gitopsIdentity,
                            configuredRef: input.branch,
                            resolvedRefKind: fetched.resolvedRefKind,
                            candidateRelPath: staged.candidateRelPath,
                            appliedRelPath: appliedRelPathFor(fetched.commitSha, completeProjectManifest.manifestVersion),
                            manifestVersion: completeProjectManifest.manifestVersion,
                            expectedInvocation: completeProjectManifest.project.invocation,
                            changePlanFingerprint: recordedCreatePlan?.fingerprint ?? null,
                            operationId: gitopsOperationId,
                            trigger: envelope.trigger,
                            actor: envelope.actor,
                            at: envelope.at,
                        }),
                        checkpoint: buildCreateCheckpointRow({
                            applicationId,
                            stackName: input.stackName,
                            operationId: gitopsOperationId,
                            config: sourceConfig,
                            identity: gitopsIdentity,
                            authType: input.authType,
                            encryptedToken: input.authType === 'token' && input.token
                                ? this.crypto.encrypt(input.token)
                                : null,
                            encryptedDeployKey: createDeployKeyTrust?.encryptedDeployKey ?? null,
                            sshKnownHostsEntry: createDeployKeyTrust?.sshKnownHostsEntry ?? null,
                            sshHostKeyFingerprint: createDeployKeyTrust?.sshHostKeyFingerprint ?? null,
                            encryptedCaBundle,
                            autoApplyOnWebhook: input.autoApplyOnWebhook,
                            autoDeployOnApply: input.autoDeployOnApply,
                            commitSha: fetched.commitSha,
                            createdManagedRoot: !rootPreexisted,
                            at: envelope.at,
                        }),
                        envelope,
                    });
                    gitopsApplicationId = applicationId;
                    await deleteStagingMarker(managedRoot);
                }

                await fsSvc.createStack(input.stackName);
                stackCreated = true;
                if (gitopsApplicationId) {
                    GitOpsStore.getInstance().updateCreateCheckpoint(
                        gitopsApplicationId, { phase: 'stack_created' }, Date.now(),
                    );
                }

                if (completeProjectManifest && materialization.value) {
                    if (gitopsApplicationId) {
                        GitOpsStore.getInstance().updateCreateCheckpoint(
                            gitopsApplicationId, { phase: 'promoting' }, Date.now(),
                        );
                    }
                    await manifestSvc.promoteGeneration(input.stackName, {
                        sha: fetched.commitSha,
                        candidateRelPath: materialization.value.candidateRelPath,
                        manifest: completeProjectManifest,
                        priorManifest: null,
                        adoptExistingMaterializedPaths: 'all',
                    });
                    appliedSpec = this.deriveAppliedSpec(input.composePaths, input.contextDir);
                    if (gitopsApplicationId) {
                        GitOpsStore.getInstance().updateCreateCheckpoint(
                            gitopsApplicationId,
                            { phase: 'manifest_committed', appliedSpecJson: JSON.stringify(appliedSpec) },
                            Date.now(),
                        );
                    }
                } else {
                    appliedSpec = await this.materialize(
                        input.stackName, fetched.composeFiles, input.contextDir, input.syncEnv, fetched.envContent, null,
                    );
                }
                const envWritten = input.syncEnv && fetched.envContent !== null;

                // 4. Insert the git-source row, then mark it applied so future
                //    pulls diff against the fetched commit rather than treating
                //    it as "local edits detected".
                const encryptedToken = input.authType === 'token' && input.token
                    ? this.crypto.encrypt(input.token)
                    : null;
                const hash = this.hashContent(fetched.composeFiles, fetched.envContent);
                // The source row, the applied pointers, and the checkpoint
                // advance together. This commit is the success boundary: once
                // it lands the stack is live, and any later error is reported
                // without deleting anything.
                const commitCreate = db.getDb().transaction(() => {
                db.upsertGitSource({
                    stack_name: input.stackName,
                    repo_url: input.repoUrl,
                    branch: input.branch,
                    compose_path: input.composePaths[0],
                    compose_paths: input.composePaths,
                    context_dir: input.contextDir,
                    sync_env: input.syncEnv,
                    env_path: input.syncEnv ? input.envPath : null,
                    auth_type: input.authType,
                    encrypted_token: encryptedToken,
                    encrypted_deploy_key: createDeployKeyTrust?.encryptedDeployKey ?? null,
                    ssh_known_hosts_entry: createDeployKeyTrust?.sshKnownHostsEntry ?? null,
                    ssh_host_key_fingerprint: createDeployKeyTrust?.sshHostKeyFingerprint ?? null,
                    encrypted_ca_bundle: encryptedCaBundle,
                    auto_apply_on_webhook: effectivePolicy === 'automatic',
                    auto_deploy_on_apply: input.autoDeployOnApply,
                    last_applied_commit_sha: fetched.commitSha,
                    last_applied_content_hash: hash,
                    pending_commit_sha: null,
                    pending_compose_content: null,
                    pending_env_content: null,
                    pending_fetched_at: null,
                    last_debounce_at: null,
                });
                db.markGitSourceApplied(input.stackName, fetched.commitSha, hash);
                db.setGitSourceAppliedSpec(input.stackName, appliedSpec);
                if (completeProjectManifest) {
                    // The promotion's cache write predated the row; persist the
                    // cache now so list and response projections are truthful.
                    db.setGitSourceManifestState(
                        input.stackName,
                        completeProjectManifest.manifestVersion,
                        completeProjectManifest.state,
                        completeProjectManifest.generation.appliedDir,
                    );
                }
                if (gitopsApplicationId) {
                    const checkpoint = GitOpsStore.getInstance().getCreateCheckpoint(gitopsApplicationId);
                    if (!checkpoint?.generation_id) {
                        throw new GitSourceError('GIT_ERROR', 'Create checkpoint lost its generation before acceptance.');
                    }
                    GitOpsTransitions.getInstance().applied({
                        applicationId: gitopsApplicationId,
                        generationId: checkpoint.generation_id,
                        artifactSetId: newGitOpsId(),
                        sourceAcceptanceId: newGitOpsId(),
                        authority: 'operator',
                        envelope: {
                            operationId: gitopsOperationId,
                            actor: 'system:git-source',
                            trigger: 'create',
                            at: Date.now(),
                        },
                        activateCreating: true,
                    });
                    GitOpsStore.getInstance().updateCreateCheckpoint(
                        gitopsApplicationId, { phase: 'pointers_committed' }, Date.now(),
                    );
                }
                });
                commitCreate();
                gitopsCommitted = true;
                // The checkpoint has done its job. Dropping it here keeps the
                // boot sweep reporting only genuine interruptions, and stops a
                // copy of the encrypted token living past the create.
                if (gitopsApplicationId) {
                    GitOpsStore.getInstance().deleteCreateCheckpoint(gitopsApplicationId);
                }

                rowInserted = true;
                if (completeProjectManifest && materialization.value && recordedCreatePlan) {
                    db.setGitSourceLastPlan(input.stackName, recordedCreatePlan.fingerprint, 'applied');
                    this.recordGitActivity(
                        input.stackName,
                        'git_create',
                        `Git create succeeded for ${input.stackName} (${fetched.commitSha.slice(0, 7)}, op ${GitSourceService.shortOperationId(gitopsOperationId)}, plan ${recordedCreatePlan.fingerprint.slice(0, 12)})`,
                        'system:git-source',
                    );
                } else {
                    this.recordGitActivity(
                        input.stackName,
                        'git_create',
                        `Git create succeeded for ${input.stackName} (${fetched.commitSha.slice(0, 7)}, op ${GitSourceService.shortOperationId(gitopsOperationId)})`,
                        'system:git-source',
                    );
                }

                const source = this.get(input.stackName);
                if (!source) {
                    throw new GitSourceError('GIT_ERROR', 'Failed to read back created git source.');
                }

                console.log(`[GitSource] Created stack ${input.stackName} from ${repoHost(input.repoUrl)} at ${fetched.commitSha.slice(0, 7)}`);
                if (diag) {
                    console.log(`[GitSource:diag] createStackFromGit ok stack=${input.stackName} sha=${fetched.commitSha.slice(0, 7)} envWritten=${envWritten} warnings=${fetched.warnings.length}`);
                }
                if (createDeployKeyTrust?.sshHostKeyFingerprint) {
                    this.maybeRecordSshTrustAudit(
                        input.auditContext,
                        input.stackName,
                        createDeployKeyTrust.sshHostKeyFingerprint,
                        'created',
                    );
                }
                return { source, commitSha: fetched.commitSha, envWritten, warnings: fetched.warnings };
            } catch (e) {
                // Past the success boundary the stack is live and owned by the
                // operator. A later error is reported, never compensated: the
                // leftover marker or checkpoint is finished by the boot sweep.
                if (gitopsCommitted) {
                    const detail = e instanceof Error ? e.message : String(e);
                    console.error(
                        `[GitSource] Create for ${sanitizeForLog(input.stackName)} succeeded but a later step failed:`,
                        detail,
                    );
                    this.recordGitActivity(
                        input.stackName,
                        'git_create',
                        `Git create for ${input.stackName} completed, but a follow-up step failed: ${detail}`,
                        'system:git-source',
                        'warning',
                    );
                    // Say plainly that the stack exists. The raw downstream
                    // error reads as a failed create, and an operator acting on
                    // it retries and hits "stack already exists", which looks
                    // like corruption rather than success.
                    throw new GitSourceError(
                        'GIT_ERROR',
                        `The stack was created from Git, but a follow-up step failed: ${detail}`,
                    );
                }
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
                // R6: the managed area must not outlive a create THIS invocation
                // staged. A pre-existing stack (TOCTOU race or a create failure
                // for a non-existence reason) must never lose its previous
                // applied generations to someone else's rollback: when the stack
                // dir was NOT created by us, remove only the candidate we staged.
                if (stackCreated && !rootPreexisted) {
                    // Only legal because this operation created the managed
                    // root. A root that predated the create holds retained
                    // generations of its own and is cleaned path by path below.
                    await GitProjectManifestService.getInstance().deleteManagedArea(input.stackName);
                } else if (materialization.value) {
                    const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
                    const stagedCandidate = path.join(
                        dataDir,
                        'git-managed',
                        String(NodeRegistry.getInstance().getDefaultNodeId()),
                        input.stackName,
                        materialization.value.candidateRelPath,
                    );
                    await fsPromises.rm(stagedCandidate, { recursive: true, force: true });
                }
                if (rowInserted) {
                    db.deleteGitSource(input.stackName);
                }
                // Filesystem cleanup has to succeed before the tombstone, so a
                // create whose files could not be removed keeps its checkpoint
                // and is retried by the next boot rather than being recorded as
                // cleanly failed.
                if (gitopsApplicationId) {
                    try {
                        await removeOperationOwnedPaths({
                            stackManagedRoot: managedRoot,
                            candidateRelPath: staged.candidateRelPath,
                            appliedRelPath: completeProjectManifest?.generation.appliedDir ?? null,
                            ownsManagedRoot: !rootPreexisted,
                        });
                        GitOpsTransitions.getInstance().createFailed(
                            gitopsApplicationId,
                            e instanceof GitSourceError ? e.code : 'create',
                            { operationId: gitopsOperationId, actor: 'system:git-source', trigger: 'create', at: Date.now() },
                        );
                    } catch (cleanupErr) {
                        console.error(
                            `[GitSource] Could not finish tearing down the failed create for ${sanitizeForLog(input.stackName)}; leaving it for the next boot sweep:`,
                            cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
                        );
                    }
                }
                throw e;
            }
        });
    }

    /**
     * Remove what a create staged before any GitOps row existed.
     *
     * Best-effort by design: the caller is already throwing the real error, and
     * a leftover directory here is picked up by the boot sweep, which has the
     * marker to tell it what this operation owned.
     */
    private async cleanupStagedCreate(
        managedRoot: string,
        candidateRelPath: string | null,
        rootPreexisted: boolean,
    ): Promise<void> {
        try {
            await removeOperationOwnedPaths({
                stackManagedRoot: managedRoot,
                candidateRelPath,
                ownsManagedRoot: !rootPreexisted,
            });
        } catch (error) {
            console.warn(
                '[GitSource] Could not remove the staged create area:',
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    /**
     * Boot sweep for every managed-project area, under the per-stack lock:
     * crash-recovery restore, orphan candidates, and areas whose stack no
     * longer exists (the row is gone, or the directory is gone). A stack
     * whose directory exists but has no discoverable compose file is left in
     * place (the managed area lingers until the row is removed), a deliberate
     * fail-safe trade: never delete on uncertainty.
     *
     * The stack listing is read STRICTLY: a listing failure (EIO, EACCES,
     * ENOMEM on the compose base dir) must never look like every stack
     * disappeared, or the sweep would delete the manifest and every retained
     * recovery generation of live Git-managed stacks. A failed listing aborts
     * the whole sweep (orphan cleanup is deferred to the next boot), and each
     * candidate is verified to be genuinely gone before its area is deleted
     * (this also covers the per-stack read errors the listing's compose-file
     * probe swallows).
     */
    /**
     * Whether the stack directory still exists. Read errors other than
     * ENOENT are logged and treated as "exists": the sweep must never delete
     * a managed area it could not verify was gone.
     */
    private async stackDirExists(stackRoot: string, stackName: string): Promise<boolean> {
        try {
            await fsPromises.lstat(stackRoot);
            return true;
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
                console.warn(`[GitSource] cannot verify stack ${stackName} is gone; skipping managed cleanup:`, (e as Error).message);
                return true;
            }
            return false;
        }
    }

    /**
     * The candidate directory basenames (e.g. "candidate-<sha>") the boot
     * sweep must not reap for this stack: a row still points at each one, so
     * it is still needed no matter how old or how incomplete it looks on
     * disk. Direct-mode only, matching the candidate/generation model itself.
     */
    private claimedCandidateDirsFor(stackName: string): { dirs: Set<string>; complete: boolean } {
        const store = GitOpsStore.getInstance();
        const claimed = new Set<string>();
        let complete = true;
        const app = store.getLiveDirectApplication(stackName);
        if (app) {
            // candidate_generation_id names the currently staged candidate.
            // accepted_generation_id is set by applySourceAcceptanceMutation
            // and never cleared, so after an ordinary apply it names an
            // already-promoted generation whose candidate directory has been
            // moved away (harmless to check, just not load-bearing). It earns
            // its place for the sourceAccepted-committed-but-targetApplied-
            // not-yet-committed window, where the generation is accepted and
            // genuinely still unpromoted on disk. Nothing calls sourceAccepted
            // or targetApplied yet, so that is forward-looking coverage rather
            // than dead code.
            for (const generationId of [app.candidate_generation_id, app.accepted_generation_id]) {
                if (!generationId) continue;
                const generation = store.getGeneration(generationId);
                if (generation) {
                    claimed.add(path.basename(generation.candidate_dir));
                } else {
                    complete = false;
                    console.warn(
                        `[GitSource] Generation claimant ${sanitizeForLog(generationId)} for ${sanitizeForLog(stackName)} could not be resolved during the sweep.`,
                    );
                }
            }
            try {
                for (const generation of store.listGenerationsClaimedByUnsettledAttempts(app.id)) {
                    claimed.add(path.basename(generation.candidate_dir));
                }
            } catch (e) {
                complete = false;
                console.warn(
                    `[GitSource] Could not read unsettled-attempt candidate claims for ${sanitizeForLog(stackName)} during the sweep:`,
                    e instanceof Error ? e.message : String(e),
                );
            }
        }
        // The pending blob's own candidateRelPath is a third, independent
        // claimant: it is written outside the transaction that mints a
        // generation, so a candidate can be staged and recorded as pending
        // with no generation row at all (fetchedInvalid) or with no live
        // application to read a pointer from (a stack whose boot migration
        // failed). A decode failure must not abort the sweep; it only means
        // this extra claim is unavailable.
        try {
            const src = DatabaseService.getInstance().getGitSource(stackName);
            if (src?.pending_compose_content) {
                const pending = this.decodePendingCompose(src.pending_compose_content);
                if (pending.candidateRelPath) claimed.add(path.basename(pending.candidateRelPath));
            }
        } catch (e) {
            complete = false;
            console.warn(
                `[GitSource] Could not read the pending candidate reference for ${sanitizeForLog(stackName)} while computing sweep claimants:`,
                e instanceof Error ? e.message : String(e),
            );
        }
        return { dirs: claimed, complete };
    }

    public async sweepOrphans(): Promise<void> {
        const fsSvc = FileSystemService.getInstance();
        const manifestSvc = GitProjectManifestService.getInstance();
        const rows = DatabaseService.getInstance().getGitSources();
        const composeDir = NodeRegistry.getInstance().getComposeDir(NodeRegistry.getInstance().getDefaultNodeId());
        const stackRootBase = path.resolve(composeDir);
        let stacks: Set<string>;
        try {
            stacks = new Set(await fsSvc.getStacksStrict());
        } catch (e) {
            console.error('[GitSource] stack listing failed; aborting the orphan sweep to protect managed areas:', e instanceof Error ? e.stack ?? e.message : String(e));
            return;
        }
        for (const row of rows) {
            // One failing stack must never abort recovery for the rest.
            try {
                if (!stacks.has(row.stack_name)) {
                    const stackRoot = path.resolve(composeDir, row.stack_name);
                    if (!isPathWithinBase(stackRoot, stackRootBase)) {
                        console.warn(`[GitSource] stack ${row.stack_name} escapes the compose directory; skipping managed cleanup`);
                        continue;
                    }
                    // The probe and the delete run under the per-stack lock so
                    // a concurrent create for the same row cannot stage a
                    // candidate into the area this branch is about to reap.
                    await this.withStackLock(row.stack_name, async () => {
                        if (await this.stackDirExists(stackRoot, row.stack_name)) {
                            console.warn(`[GitSource] stack ${row.stack_name} is missing from the listing but its directory exists; skipping managed cleanup`);
                            return;
                        }
                        console.log(`[GitSource] removing managed area for vanished stack ${row.stack_name}: not listed and the stack directory is gone`);
                        const liveRemoved = await manifestSvc.deleteManagedArea(row.stack_name);
                        const stagedRemoved = await manifestSvc.finalizeStagedDetach(row.stack_name);
                        if (!liveRemoved || !stagedRemoved) throw new Error('Could not remove orphaned managed project data');
                    });
                    continue;
                }
                await this.withStackLock(row.stack_name, () => {
                    const claims = this.claimedCandidateDirsFor(row.stack_name);
                    return manifestSvc.sweepManagedArea(row.stack_name, {
                        repoUrl: row.repo_url,
                        branch: row.branch,
                        stackExists: true,
                        candidateClaims: claims.complete
                            ? { complete: true, dirs: claims.dirs }
                            : { complete: false },
                    });
                });
            } catch (e) {
                console.error(`[GitManifest] sweep failed for ${row.stack_name}:`, (e as Error).message);
            }
        }
        // Areas whose stack row is gone entirely (source deleted, stack kept)
        // must not linger either.
        const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
        const managedRoot = path.join(dataDir, 'git-managed', String(NodeRegistry.getInstance().getDefaultNodeId()));
        const known = new Set(rows.map((r) => r.stack_name));
        let entries;
        try {
            entries = await fsPromises.readdir(managedRoot, { withFileTypes: true });
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
                console.error('[GitManifest] could not read the managed project root:', (e as Error).message);
            }
            return;
        }
        // A managed area with no git-source row is not automatically an orphan.
        // An in-flight or crashed create owns its area through a checkpoint or
        // a creating application before the source row exists, so both count as
        // known and must survive the sweep.
        for (const checkpoint of GitOpsStore.getInstance().listCreateCheckpoints()) {
            known.add(checkpoint.stack_name);
        }
        for (const app of GitOpsStore.getInstance().listCreatingDirectApplications()) {
            if (app.stack_name) known.add(app.stack_name);
        }

        for (const entry of entries) {
            if (!entry.isDirectory() || known.has(entry.name)) continue;
            // Detach staging areas carry their own ownership proof in the
            // detach journal, not a create marker. They are reaped exactly as
            // before once their stack is gone.
            if (entry.name.startsWith('.detach-')) {
                if (known.has(entry.name.slice('.detach-'.length))) continue;
                try {
                    await fsPromises.rm(path.join(managedRoot, entry.name), { recursive: true, force: true });
                } catch (e) {
                    console.error(`[GitManifest] could not remove staged detach area ${sanitizeForLog(entry.name)}:`, (e as Error).message);
                }
                continue;
            }
            // Nothing in the database claims this directory: no git-source row,
            // no create checkpoint, no creating application. What happens next
            // turns on the staging marker, and the distinction between its two
            // failure states is the whole rule.
            //
            //   valid   an in-flight create owns this area. Remove only what
            //           that operation staged.
            //   missing nothing ever claimed it. This is the ordinary orphan a
            //           crashed stack deletion leaves behind, and reaping it is
            //           the long-standing behavior that keeps managed data from
            //           outliving its stack.
            //   corrupt something claimed it and we cannot read the claim.
            //           Preserve: an unexplained directory is far cheaper than a
            //           wrongly deleted generation.
            const area = path.join(managedRoot, entry.name);
            try {
                const marker = await readStagingMarker(area);
                if (marker.state === 'corrupt') {
                    console.warn(
                        `[GitManifest] preserving unclaimed managed area ${sanitizeForLog(entry.name)}: its staging marker is unreadable (${marker.reason}), so ownership cannot be established`,
                    );
                    continue;
                }
                if (marker.state === 'missing') {
                    await fsPromises.rm(area, { recursive: true, force: true });
                    console.log(`[GitManifest] removed orphaned managed area ${sanitizeForLog(entry.name)}: no stack, no create, no marker claims it`);
                    continue;
                }
                const outcome = await cleanupUnclaimedManagedRoot(area, marker.marker);
                console.log(`[GitManifest] unclaimed managed area ${sanitizeForLog(entry.name)}: ${outcome}`);
            } catch (e) {
                console.error(`[GitManifest] could not clean unclaimed area ${sanitizeForLog(entry.name)}:`, (e as Error).message);
            }
        }
    }

    // ─── Webhook-triggered pull ──────────────────────────────────────────────

    /** Whether this delivery's effective intent requires deploy permission. */
    public webhookDeliveryRequiresDeploy(stackName: string, deliveryId?: string): boolean {
        const source = DatabaseService.getInstance().getGitSource(stackName);
        if (!source) return false;
        const app = this.gitopsApplicationFor(stackName);
        const started = app && deliveryId
            ? GitOpsStore.getInstance().getStartedAttempt(
                app.id,
                deliveryKey('webhook', 'fetch', deliveryId),
            )
            : undefined;
        if (started) return GitSourceService.deliveryIntentFromStartedAttempt(started).deploy;
        return this.effectiveAutoApply(stackName, source.auto_apply_on_webhook) && source.auto_deploy_on_apply;
    }

    /**
     * Invoked by the webhook dispatcher. A provider-scoped delivery id resolves
     * redeliveries durably. Debounce still rate-limits new deliveries and is
     * the only deduplication mechanism when no stable id is available. The
     * caller must explicitly pass whether the principal is authorized to
     * execute a requested deploy.
     */
    public async handleWebhookPull(
        stackName: string,
        deployAuthorized: boolean,
        deliveryId?: string,
    ): Promise<WebhookPullResult> {
        if (!deliveryId) return this.handleWebhookPullOnce(stackName, undefined, deployAuthorized);
        const key = `${stackName}:${deliveryId}`;
        const leader = this.inFlightWebhookDeliveries.get(key);
        if (leader) return leader.promise;

        const promise = this.handleWebhookPullOnce(stackName, deliveryId, deployAuthorized);
        const entry = { promise };
        this.inFlightWebhookDeliveries.set(key, entry);
        try {
            return await promise;
        } finally {
            if (this.inFlightWebhookDeliveries.get(key) === entry) {
                this.inFlightWebhookDeliveries.delete(key);
            }
        }
    }

    private async handleWebhookPullOnce(
        stackName: string,
        deliveryId: string | undefined,
        deployAuthorized: boolean,
    ): Promise<WebhookPullResult> {
        const actor = 'system:webhook';
        const diag = isDebugEnabled();
        const deliverySuffix = deliveryId ? ` (delivery ${sanitizeForLog(deliveryId)})` : '';
        const db = DatabaseService.getInstance();
        const src = db.getGitSource(stackName);
        if (!src) return { status: 'error', message: 'No Git source configured for this stack.' };

        const gitopsApp = this.gitopsApplicationFor(stackName);
        const startedDelivery = gitopsApp && deliveryId
            ? GitOpsStore.getInstance().getStartedAttempt(
                gitopsApp.id,
                deliveryKey('webhook', 'fetch', deliveryId),
            )
            : undefined;
        const existingDelivery = !!startedDelivery;
        const now = Date.now();
        if (!existingDelivery && src.last_debounce_at !== null && (now - src.last_debounce_at) < WEBHOOK_DEBOUNCE_MS) {
            if (diag) console.log(`[GitSource:diag] webhook debounced stack=${stackName} age=${now - src.last_debounce_at}ms`);
            return { status: 'skipped', message: 'Rate limited (debounced).' };
        }
        if (!existingDelivery && gitopsApp?.suspended_at) {
            return { status: 'skipped', message: 'Reconciliation is suspended for this source.' };
        }
        if (!gitopsApp) {
            try {
                this.refuseUntrackedSource(stackName, actor, 'fetch', false);
            } catch (e) {
                const msg = e instanceof GitSourceError ? e.message : (e as Error).message;
                console.warn(`[GitSource] Webhook delivery skipped for ${sanitizeForLog(stackName)}: ${sanitizeForLog(msg)}`);
                return { status: 'skipped', message: msg };
            }
            return { status: 'error', message: 'GitOps tracking is unavailable for this source.' };
        }

        let deliveryIntent = GitSourceService.deliveryIntent(
            // The live application's tri-state policy is authoritative; the
            // stored boolean only matters when no application models the source.
            this.effectiveAutoApply(stackName, src.auto_apply_on_webhook),
            src.auto_deploy_on_apply,
        );
        if (startedDelivery) {
            try {
                deliveryIntent = GitSourceService.deliveryIntentFromStartedAttempt(startedDelivery);
            } catch (e) {
                console.error(
                    '[GitSource] Could not recover webhook delivery intent for %s%s:',
                    sanitizeForLog(stackName),
                    deliverySuffix,
                    e instanceof Error ? e.message : String(e),
                );
                return { status: 'error', message: 'Could not recover the original webhook delivery intent.' };
            }
        }
        if (deliveryIntent.deploy && !deployAuthorized) {
            return { status: 'error', message: 'Deploy permission is required for this webhook delivery.' };
        }

        let pullResult: PullResult | undefined;
        let fetchResult: ReconcileResult | undefined;
        let replayedFetch: boolean;
        try {
            const request: ReconcileRequest = {
                intent: 'fetch',
                applicationId: gitopsApp.id,
                stackName,
                trigger: 'webhook',
                actor,
                deliveryId,
            };
            const submission = await this.submitExecution(
                this.inFlightFetches,
                request,
                this.doPullWork(stackName, actor, gitopsApp.id),
                (outcome) => this.fetchExecutionResult(stackName, outcome),
                coalesceKey(request),
                deliveryId ? deliveryIntent : undefined,
            );
            fetchResult = GitSourceService.resultFromSubmission(submission);
            replayedFetch = submission.kind === 'replayed';
            if (submission.kind === 'executed') {
                if (submission.execution.status === 'rejected') throw submission.execution.reason;
                pullResult = submission.execution.value;
            }
        } catch (e) {
            return this.webhookFailure(stackName, deliverySuffix, 'pull', e);
        }

        if (fetchResult && !pullResult) {
            const replayResult = GitSourceService.webhookResultFromReconcile(fetchResult);
            if (replayResult.status !== 'success') return replayResult;
        }
        if (!replayedFetch) db.touchGitSourceDebounce(stackName);
        if (pullResult && !pullResult.validation.ok) {
            console.warn(`[GitSource] Webhook pull validation failed for ${sanitizeForLog(stackName)}: ${sanitizeForLog(pullResult.validation.error ?? 'unknown')}`);
            return { status: 'error', message: `Validation failed: ${pullResult.validation.error}` };
        }

        const commitSha = pullResult?.commitSha ?? fetchResult?.commitSha;
        if (!commitSha) {
            return { status: 'error', message: fetchResult?.reason ?? 'The fetch completed without a candidate commit.' };
        }
        const currentSource = db.getGitSource(stackName);
        if (!currentSource) return { status: 'error', message: 'The Git source configuration was removed during reconciliation.' };
        if (!deliveryIntent.autoApply) {
            if (diag) console.log(`[GitSource:diag] webhook pending-only stack=${stackName} sha=${commitSha.slice(0, 7)}`);
            return { status: 'success', message: `Pending update ready at ${commitSha.slice(0, 7)}.` };
        }

        try {
            const request: ReconcileRequest = {
                intent: 'apply',
                applicationId: gitopsApp.id,
                stackName,
                trigger: 'webhook',
                actor,
                deliveryId,
                commitSha,
                planFingerprint: '',
                deploy: deliveryIntent.deploy,
            };
            const submission = await this.submitExecution(
                this.inFlightApplies,
                request,
                (operationId) => this.withStackLock(stackName, async () => {
                    this.assertLiveApplication(stackName, gitopsApp.id);
                    return this.applyWithSharedLock(stackName, commitSha, {
                        deploy: deliveryIntent.deploy,
                        actor,
                        requirePlanFingerprint: false,
                    }, operationId);
                }),
                (outcome) => this.applyExecutionResult(stackName, outcome),
                GitSourceService.applyExecutionKey(request, false),
            );
            if (submission.kind === 'replayed') {
                return GitSourceService.webhookResultFromReconcile(submission.result);
            }
            if (submission.execution.status === 'rejected') throw submission.execution.reason;
            const applied = submission.execution.value;
            if (applied.deployError) {
                return { status: 'error', message: `Applied commit ${commitSha.slice(0, 7)} but deploy failed: ${applied.deployError}` };
            }
            const suffix = applied.deployed ? ' and deployed' : '';
            return { status: 'success', message: `Applied commit ${commitSha.slice(0, 7)}${suffix}.` };
        } catch (e) {
            return this.webhookFailure(stackName, deliverySuffix, 'apply', e);
        }
    }

    private webhookFailure(stackName: string, deliverySuffix: string, phase: 'pull' | 'apply', error: unknown): WebhookPullResult {
        const msg = error instanceof GitSourceError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);
        const scrubbed = scrubCredentials(msg);
        console.error(`[GitSource] Webhook ${phase} failed for ${sanitizeForLog(stackName)}${deliverySuffix}: ${sanitizeForLog(scrubbed)}`);
        return { status: 'error', message: scrubbed };
    }

    private static webhookResultFromReconcile(result: ReconcileResult): WebhookPullResult {
        switch (result.outcome) {
            case 'converged':
            case 'no_source_change':
            case 'candidate_already_fetched':
            case 'pending_review':
                return { status: 'success', message: result.reason };
            case 'suspended':
                return { status: 'skipped', message: result.reason };
            default:
                return { status: 'error', message: result.reason };
        }
    }

    // ─── Change plan helpers ─────────────────────────────────────────────────

    private parsePendingPlanSummary(raw: string | null): PublicPendingPlanView | null {
        if (!raw) return null;
        try {
            const parsed = JSON.parse(raw) as PublicPendingPlanView;
            if (typeof parsed.fingerprint !== 'string' || typeof parsed.blocked !== 'boolean') return null;
            return parsed;
        } catch {
            return null;
        }
    }

    private async liveInvocationArgs(stackName: string, nodeId: number): Promise<string[]> {
        try {
            return [
                ...authoredComposeFileArgs(stackName, nodeId),
                ...(await authoredComposeEnvFileArgs(stackName, nodeId)),
            ];
        } catch (e) {
            const detail = e instanceof Error ? e.message : String(e);
            console.warn(`[GitSource] live invocation read failed for ${stackName}:`, detail);
            throw new GitSourceError('GIT_ERROR', `Cannot read the live compose invocation for ${stackName}.`);
        }
    }

    private candidateInvocationArgs(stackName: string, src: StackGitSource, envContentPresent: boolean): string[] {
        const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
        // Canonical js/path-injection barrier inline with the existsSync sink.
        // CodeQL does not credit a wrapped helper or a check separated from the sink.
        const baseResolved = path.resolve(NodeRegistry.getInstance().getComposeDir(nodeId));
        const stackDir = path.resolve(baseResolved, stackName);
        let rootEnvFilePresent = false;
        if (!src.sync_env) {
            const envPath = path.resolve(stackDir, '.env');
            if (envPath.startsWith(baseResolved + path.sep) && existsSync(envPath)) {
                rootEnvFilePresent = true;
            }
        }
        return buildCandidateComposeInvocation({
            stackName,
            composePaths: src.compose_paths,
            contextDir: src.context_dir,
            stackDir,
            syncEnv: src.sync_env,
            envContentPresent,
            projectEnvFiles: DatabaseService.getInstance().getStackProjectEnvFiles(nodeId, stackName),
            rootEnvFilePresent,
        });
    }

    private async computeChangePlan(opts: {
        stackName: string;
        commitSha: string;
        mode: 'update' | 'create';
        src: StackGitSource;
        inventory: InventoryResult;
        envContent: string | null;
        prior: GitProjectManifest | null;
        reviewedLiveHashes?: ReadonlyMap<string, string | null>;
    }): Promise<GitChangePlan> {
        const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
        const syncEnvEntry: ComposeInputEntry | null =
            opts.src.sync_env && opts.envContent !== null
                ? {
                    sourcePath: null,
                    materializedPath: '.env',
                    role: 'env',
                    dependencyKind: 'sync-env',
                    ownership: 'managed',
                    provenance: 'fetch',
                    sensitivity: 'high',
                    contentSha256: crypto.createHash('sha256').update(opts.envContent).digest('hex'),
                    sizeBytes: Buffer.byteLength(opts.envContent, 'utf8'),
                    state: 'present',
                    deletionAuthority: 'sencho',
                    note: null,
                }
                : null;
        const inputs = mergeSyncEnvEntry(opts.inventory.inputs, syncEnvEntry);
        const liveInvocation = await this.liveInvocationArgs(opts.stackName, nodeId);
        const candidateInvocation = this.candidateInvocationArgs(opts.stackName, opts.src, opts.envContent !== null);
        const legacyOwnedPaths = opts.prior
            ? undefined
            : [
                ...(opts.src.applied_deploy_spec?.files ?? [PRIMARY_COMPOSE_FILENAME]),
                ...(opts.src.sync_env ? ['.env'] : []),
            ];
        return GitChangePlanService.getInstance().build({
            stackName: opts.stackName,
            commitSha: opts.commitSha,
            mode: opts.mode,
            priorManifest: opts.prior,
            candidateInputs: inputs,
            candidateBuildContexts: opts.inventory.buildContexts,
            candidateInvocation,
            liveInvocation,
            legacyOwnedPaths,
            reviewedLiveHashes: opts.reviewedLiveHashes,
            projectEnvFiles: DatabaseService.getInstance().getStackProjectEnvFiles(nodeId, opts.stackName),
        });
    }

    private upsertGitPlanDrift(stackName: string, plan: GitChangePlan): void {
        const blocking = plan.operations.filter((op) =>
            op.op === 'local-modified' || op.op === 'local-missing' || op.op === 'type-changed' || op.op === 'unmanaged-collision',
        );
        if (blocking.length === 0) return;
        const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
        DriftLedgerService.getInstance().upsertManagedPathConflicts(
            nodeId,
            stackName,
            blocking.map((op) => ({
                path: op.pathKey,
                op: op.op,
                role: String(op.role),
                sensitivity: op.sensitivity,
            })),
        );
    }

    private recordGitActivity(
        stackName: string,
        category: NotificationCategory,
        message: string,
        actor: string,
        level: 'info' | 'warning' | 'error' = 'info',
    ): void {
        try {
            DatabaseService.getInstance().addNotificationHistory(
                NodeRegistry.getInstance().getDefaultNodeId(),
                {
                    level,
                    category,
                    message,
                    timestamp: Date.now(),
                    stack_name: stackName,
                    actor_username: actor,
                },
            );
        } catch (error) {
            console.error('[GitSource] Failed to record activity for %s:', sanitizeForLog(stackName), error);
        }
    }

    // ─── Registry delivery preparation ─────────────────────────────────────

    private async loadPreparedGitCandidate(
        prepId: string,
        managedRoot: string,
        expectations?: { commitSha?: string; candidateRelPath?: string },
    ): Promise<import('../helpers/registryDeliveryGitCandidate').GitCandidatePreparedMeta> {
        const { PreparedSourceStore } = await import('./preparedSourceStore');
        const {
            installGitCandidatePayloadToManagedRoot,
            readGitCandidatePreparedMeta,
        } = await import('../helpers/registryDeliveryGitCandidate');
        const payloadPath = PreparedSourceStore.getInstance().peekPayloadPath(prepId);
        const meta = await readGitCandidatePreparedMeta(payloadPath);
        if (!meta.materialization.validation.ok) {
            throw new GitSourceError(
                'GIT_ERROR',
                `Compose validation failed: ${meta.materialization.validation.error ?? 'unknown'}`,
            );
        }
        if (expectations?.commitSha && meta.commitSha !== expectations.commitSha) {
            throw new GitSourceError('GIT_ERROR', 'Prepared git candidate commit mismatch');
        }
        if (expectations?.candidateRelPath && meta.candidateRelPath !== expectations.candidateRelPath) {
            throw new GitSourceError('GIT_ERROR', 'Prepared git candidate path mismatch');
        }
        await installGitCandidatePayloadToManagedRoot(payloadPath, managedRoot, meta.candidateRelPath);
        return meta;
    }

    private async restoreCreateFromPreparedGitCandidate(
        prepId: string,
        managedRoot: string,
        rootPreexisted: boolean,
        gitopsOperationId: string,
        staged: { candidateRelPath: string | null },
    ): Promise<{ fetched: FetchResult; materialization: MaterializationResult }> {
        const { fetchResultFromPreparedMeta } = await import('../helpers/registryDeliveryGitCandidate');
        const meta = await this.loadPreparedGitCandidate(prepId, managedRoot);
        staged.candidateRelPath = meta.candidateRelPath;
        await writeStagingMarker(managedRoot, {
            schemaVersion: 1,
            operationId: gitopsOperationId,
            rootPreexisted,
            candidateRelPath: staged.candidateRelPath,
            createdAt: Date.now(),
        });
        return {
            fetched: fetchResultFromPreparedMeta(meta),
            materialization: meta.materialization,
        };
    }

    private async restoreApplyFromPreparedGitCandidate(
        prepId: string,
        stackName: string,
        commitSha: string,
        candidateRelPath: string,
    ): Promise<void> {
        const managedRoot = path.resolve(stackManagedRoot(stackName));
        await this.loadPreparedGitCandidate(prepId, managedRoot, { commitSha, candidateRelPath });
    }

    public async prepareRegistryDeliveryFromGit(
        input: CreateStackFromGitInput,
    ): Promise<{ prepId: string; sourceHash: string }> {
        const materialization: { value: MaterializationResult | null } = { value: null };
        const encryptedCaBundle = this.resolveEncryptedCaBundle(input.caBundle, undefined);
        const caBundlePem = this.decryptCaBundlePem(encryptedCaBundle);
        const fetched = await this.fetchFromGit({
            repoUrl: input.repoUrl,
            branch: input.branch,
            composePaths: input.composePaths,
            envPath: input.syncEnv ? input.envPath : null,
            token: input.token,
            caBundlePem,
            onClone: async (cloneDir, commitSha, envContent) => {
                materialization.value = await this.buildMaterialization(
                    input.stackName,
                    cloneDir,
                    commitSha,
                    {
                        compose_paths: input.composePaths,
                        context_dir: input.contextDir,
                        sync_env: input.syncEnv,
                    },
                    envContent,
                );
            },
        });
        if (!materialization.value?.validation.ok) {
            throw new GitSourceError(
                'GIT_ERROR',
                `Compose validation failed: ${materialization.value?.validation.error ?? 'unknown'}`,
            );
        }
        const managedRoot = path.resolve(stackManagedRoot(input.stackName));
        const candidateRel = materialization.value.candidateRelPath;
        const pathReason = validateCandidateRelPath(candidateRel, managedRoot);
        if (pathReason) {
            throw new GitSourceError('GIT_ERROR', pathReason);
        }
        const candidateAbs = path.resolve(managedRoot, candidateRel);
        if (!candidateAbs.startsWith(managedRoot + path.sep)) {
            throw new GitSourceError('GIT_ERROR', 'Invalid candidate path');
        }
        const stagingDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-regprep-'));
        try {
            await copyPreparedPayloadDirectory(candidateAbs, stagingDir);
            const { writeGitCandidatePreparedMeta } = await import('../helpers/registryDeliveryGitCandidate');
            await writeGitCandidatePreparedMeta(stagingDir, {
                version: 1,
                commitSha: fetched.commitSha,
                resolvedRefKind: fetched.resolvedRefKind,
                candidateRelPath: materialization.value.candidateRelPath,
                composeFiles: fetched.composeFiles,
                envContent: fetched.envContent,
                materialization: materialization.value,
                warnings: fetched.warnings,
            });
            const { hashDeliverySourceDir } = await import('../helpers/registryDeliveryHashes');
            const { PreparedSourceStore } = await import('./preparedSourceStore');
            const sourceHash = hashDeliverySourceDir(stagingDir);
            const entry = await PreparedSourceStore.getInstance().prepareFromDirectory(
                'git-candidate',
                sourceHash,
                stagingDir,
            );
            return { prepId: entry.prepId, sourceHash };
        } catch (error) {
            await fsPromises.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
            throw error;
        } finally {
            const rmTarget = path.resolve(candidateAbs);
            if (rmTarget.startsWith(managedRoot + path.sep)) {
                // Canonical js/path-injection barrier inline with the rm sink.
                await fsPromises.rm(rmTarget, { recursive: true, force: true }).catch(() => undefined);
            }
        }
    }

    public async prepareRegistryDeliveryFromPending(
        stackName: string,
    ): Promise<{ prepId: string; sourceHash: string }> {
        const src = DatabaseService.getInstance().getGitSource(stackName);
        if (!src?.pending_commit_sha || !src.pending_compose_content) {
            throw new GitSourceError('GIT_ERROR', 'No pending pull to prepare');
        }
        const pending = this.decodePendingCompose(src.pending_compose_content);
        if (!pending.candidateRelPath || pending.inventory === null) {
            throw new GitSourceError('GIT_ERROR', 'No staged candidate for pending apply');
        }
        const envContent = src.pending_env_content !== null
            ? this.crypto.decrypt(src.pending_env_content)
            : null;
        const managedRoot = path.resolve(stackManagedRoot(stackName));
        const pathReason = validateCandidateRelPath(pending.candidateRelPath, managedRoot);
        if (pathReason) {
            throw new GitSourceError('GIT_ERROR', pathReason);
        }
        const candidateAbs = path.resolve(managedRoot, pending.candidateRelPath);
        if (!candidateAbs.startsWith(managedRoot + path.sep)) {
            throw new GitSourceError('GIT_ERROR', 'Invalid candidate path');
        }
        const stagingDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-regprep-'));
        try {
            await copyPreparedPayloadDirectory(candidateAbs, stagingDir);
            const { writeGitCandidatePreparedMeta } = await import('../helpers/registryDeliveryGitCandidate');
            await writeGitCandidatePreparedMeta(stagingDir, {
                version: 1,
                commitSha: src.pending_commit_sha,
                resolvedRefKind: priorFetchIdentity(this.gitopsApplicationFor(stackName))?.kind ?? 'branch',
                candidateRelPath: pending.candidateRelPath,
                composeFiles: pending.files,
                envContent,
                materialization: {
                    inventory: pending.inventory,
                    contextCopyPlans: [],
                    candidateRelPath: pending.candidateRelPath,
                    validation: { ok: true },
                },
                warnings: [],
            });
            const { hashDeliverySourceDir } = await import('../helpers/registryDeliveryHashes');
            const { PreparedSourceStore } = await import('./preparedSourceStore');
            const sourceHash = hashDeliverySourceDir(stagingDir);
            const entry = await PreparedSourceStore.getInstance().prepareFromDirectory(
                'git-candidate',
                sourceHash,
                stagingDir,
            );
            return { prepId: entry.prepId, sourceHash };
        } catch (error) {
            await fsPromises.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
            throw error;
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
