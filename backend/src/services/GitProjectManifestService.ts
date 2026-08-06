/**
 * Managed-project manifest service: the single canonical inventory for
 * Git-managed stacks, stored OUTSIDE the stack directory at
 * <DATA_DIR>/git-managed/<nodeId>/<stackName>/ so it is unreachable from the
 * file explorer and never enters a Docker build context.
 *
 * The manifest file is the source of truth and is treated as UNTRUSTED on
 * every read: shape, enum membership, and the identity stamp (nodeId,
 * stackName, repo url, branch) are validated before any field is honored. A
 * mismatch is corruption, never partial trust.
 *
 * Promotion is transactional: a promotion.json marker records the mid-write
 * state; the boot sweep restores the previous applied generation under the
 * per-stack lock unless the stack dir was hand-repaired after the crash (then
 * it declines and flags migration_required).
 */
import path from 'path';
import fs from 'fs';
import { createHash } from 'crypto';
import YAML from 'yaml';
import { NodeRegistry } from './NodeRegistry';
import { FileSystemService } from './FileSystemService';
import { StackFileRootsService } from './StackFileRootsService';
import { DatabaseService } from './DatabaseService';
import { ComposeInputDiscoveryService, type ContextCopyPlan, type CopyEntry } from './ComposeInputDiscoveryService';
import { authoredComposeFileArgs, authoredComposeEnvFileArgs } from '../utils/authoredComposeArgs';
import type {
    BuildContextPlan,
    ComposeInputEntry,
    DeletionAuthority,
    GitProjectManifest,
    GitSourceManifestState,
    InputDependencyKind,
    InputOwnership,
    InputRole,
    InputSensitivity,
    InputState,
    ManifestBounds,
    ManifestIdentity,
    ManifestProvenance,
    ManifestState,
    ManifestSummary,
    RefusalInfo,
} from '../types/gitProjectManifest';

export const MANAGED_ROOT_NAME = 'git-managed';
export const MANIFEST_FILENAME = 'manifest.v1.json';
export const PROMOTION_MARKER = 'promotion.json';
export const CANDIDATE_COMPLETE_MARKER = '.candidate-complete';
export const GENERATIONS_DIR = 'generations';

// Retention: current applied generation + one previous.
const MAX_GENERATIONS = 2;
const ORPHAN_CANDIDATE_AGE_MS = 24 * 60 * 60 * 1000;

interface PromotionMarker {
    sha: string;
    candidateRelPath: string;
    /** Stack-relative paths already written before the crash. */
    written: string[];
}

const MANIFEST_STATES: readonly ManifestState[] = ['none', 'migrated', 'active', 'partial', 'unsupported'];
const DEPENDENCY_KINDS: readonly InputDependencyKind[] = [
    'explicit', 'implicit-override', 'include', 'include-env', 'extends', 'env_file',
    'interpolation-env', 'config', 'secret', 'label_file', 'build-context', 'dockerfile',
    'build-secret', 'build-additional-context', 'sync-env', 'bind-mount',
];
const INPUT_ROLES: readonly InputRole[] = [
    'compose-primary', 'compose-additional', 'compose-override', 'env', 'config', 'secret',
    'label-file', 'build-context', 'dockerfile', 'build-secret', 'build-additional-context',
    'bind-mount', 'other',
];
const OWNERSHIPS: readonly InputOwnership[] = ['managed', 'unmanaged'];
const PROVENANCES: readonly ManifestProvenance[] = ['fetch', 'migration', 'adopted'];
const SENSITIVITIES: readonly InputSensitivity[] = ['high', 'medium', 'low'];
const INPUT_STATES: readonly InputState[] = ['present', 'tombstoned'];
const DELETION_AUTHORITIES: readonly DeletionAuthority[] = ['sencho', 'user', 'none'];

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
    return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

function sha256Of(buf: Buffer): string {
    return createHash('sha256').update(buf).digest('hex');
}

/** A manifest path field must be relative and free of `..` / absolute escapes. Empty string is allowed (unset generation dirs). */
function isSafeRelPath(value: unknown): boolean {
    if (value === null) return true;
    if (typeof value !== 'string') return false;
    if (value === '') return true;
    const normalized = value.replace(/\\/g, '/');
    if (path.posix.isAbsolute(normalized)) return false;
    if (/^[A-Za-z]:/.test(normalized)) return false;
    const segments = normalized.split('/');
    return !segments.some((seg) => seg === '..' || seg === '.');
}

export class GitProjectManifestService {
    private constructor() {
        // Singleton; node scoping follows the executing node's default node id,
        // mirroring GitSourceService (proxied requests run on the owning node).
    }

    private static instance: GitProjectManifestService | null = null;

    static getInstance(): GitProjectManifestService {
        if (!this.instance) this.instance = new GitProjectManifestService();
        return this.instance;
    }

    private dataRoot(): string {
        return process.env.DATA_DIR || path.join(process.cwd(), 'data');
    }

    private managedRoot(stackName: string): string {
        const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
        return path.join(this.dataRoot(), MANAGED_ROOT_NAME, String(nodeId), stackName);
    }

    private generationsDir(stackName: string): string {
        return path.join(this.managedRoot(stackName), GENERATIONS_DIR);
    }

    // ─── Bounds ───────────────────────────────────────────────────────────────

    /** Materialization bounds; env-overridable following GITSOURCE_MAX_CLONE_BYTES. */
    boundsConfig(): ManifestBounds {
        const num = (key: string, fallback: number): number => {
            const raw = process.env[key];
            if (!raw) return fallback;
            const parsed = Number.parseInt(raw, 10);
            return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
        };
        return {
            maxFiles: num('GITSOURCE_MAX_MATERIALIZED_FILES', 10_000),
            maxBytes: num('GITSOURCE_MAX_MATERIALIZED_BYTES', 512 * 1024 * 1024),
            maxContextBytes: num('GITSOURCE_MAX_BUILD_CONTEXT_BYTES', 256 * 1024 * 1024),
            maxPathDepth: num('GITSOURCE_MAX_PATH_DEPTH', 64),
            maxFileBytes: num('GITSOURCE_MAX_FILE_BYTES', 10 * 1024 * 1024),
        };
    }

    // ─── Manifest read/write (untrusted on read) ─────────────────────────────

    private expectedIdentity(stackName: string, repoUrl: string, branch: string): ManifestIdentity {
        return {
            nodeId: String(NodeRegistry.getInstance().getDefaultNodeId()),
            stackName,
            repoUrl,
            branch,
        };
    }

    /**
     * Validate an untrusted manifest. Returns a reason when the manifest must
     * be treated as corrupt; the identity stamp must match the expected stack
     * so a same-named successor can never adopt an orphan.
     */
    private validateManifest(
        raw: unknown,
        stackName: string,
        expected: ManifestIdentity,
    ): string | null {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'not an object';
        const m = raw as Record<string, unknown>;
        if (m.schemaVersion !== 1) return `unsupported schemaVersion ${String(m.schemaVersion)}`;
        if (typeof m.manifestVersion !== 'number' || m.manifestVersion < 1) return 'invalid manifestVersion';
        if (!isOneOf(m.state, MANIFEST_STATES)) return `invalid state ${String(m.state)}`;
        if (typeof m.generatedAt !== 'number') return 'invalid generatedAt';

        const identity = m.identity as Record<string, unknown> | undefined;
        if (!identity || typeof identity !== 'object') return 'missing identity';
        if (identity.nodeId !== expected.nodeId) return `identity nodeId mismatch (${String(identity.nodeId)} vs ${expected.nodeId})`;
        if (identity.stackName !== stackName) return `identity stackName mismatch (${String(identity.stackName)} vs ${stackName})`;
        if (identity.repoUrl !== expected.repoUrl || identity.branch !== expected.branch) {
            return `identity repository mismatch (${String(identity.repoUrl)}#${String(identity.branch)})`;
        }

        const repo = m.repo as Record<string, unknown> | undefined;
        if (!repo || repo.url !== expected.repoUrl || repo.branch !== expected.branch) return 'repo mismatch';
        const revision = m.resolvedRevision as Record<string, unknown> | undefined;
        if (!revision || typeof revision.commitSha !== 'string' || typeof revision.fetchedAt !== 'number') {
            return 'invalid resolvedRevision';
        }
        const project = m.project as Record<string, unknown> | undefined;
        if (!project || typeof project !== 'object') return 'invalid project';
        if (!Array.isArray(project.composeFiles) || !project.composeFiles.every((f) => typeof f === 'string')) return 'invalid project.composeFiles';
        if (!Array.isArray(project.invocation) || !project.invocation.every((a) => typeof a === 'string')) return 'invalid project.invocation';
        if (typeof project.projectName !== 'string') return 'invalid project.projectName';

        if (!Array.isArray(m.inputs)) return 'invalid inputs';
        for (const entry of m.inputs as unknown[]) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'invalid input entry';
            const e = entry as Record<string, unknown>;
            if (e.sourcePath !== null && typeof e.sourcePath !== 'string') return 'invalid input sourcePath';
            if (!isSafeRelPath(e.materializedPath)) return `invalid input materializedPath ${String(e.materializedPath)}`;
            if (!isOneOf(e.dependencyKind, DEPENDENCY_KINDS)) return `invalid input kind ${String(e.dependencyKind)}`;
            if (!isOneOf(e.role, INPUT_ROLES)) return `invalid input role ${String(e.role)}`;
            if (!isOneOf(e.ownership, OWNERSHIPS)) return `invalid input ownership ${String(e.ownership)}`;
            if (!isOneOf(e.provenance, PROVENANCES)) return `invalid input provenance ${String(e.provenance)}`;
            if (!isOneOf(e.sensitivity, SENSITIVITIES)) return `invalid input sensitivity ${String(e.sensitivity)}`;
            if (!isOneOf(e.state, INPUT_STATES)) return `invalid input state ${String(e.state)}`;
            if (!isOneOf(e.deletionAuthority, DELETION_AUTHORITIES)) return `invalid deletionAuthority ${String(e.deletionAuthority)}`;
            if (e.contentSha256 !== null && typeof e.contentSha256 !== 'string') return 'invalid input contentSha256';
        }
        if (!Array.isArray(m.refusals) || !Array.isArray(m.buildContexts)) return 'invalid refusals/buildContexts';
        const generation = m.generation as Record<string, unknown> | undefined;
        if (!generation || typeof generation !== 'object') return 'invalid generation';
        if (!isSafeRelPath(generation.candidateDir) || !isSafeRelPath(generation.appliedDir) || !isSafeRelPath(generation.previousDir)) {
            return 'invalid generation paths';
        }
        if (!isSafeRelPath((m.project as Record<string, unknown> | undefined)?.root)) return 'invalid project.root';
        if (!m.counts || typeof m.counts !== 'object') return 'invalid counts';
        if (!m.bounds || typeof m.bounds !== 'object') return 'invalid bounds';
        return null;
    }

    /**
     * Read + validate the manifest. Returns the manifest, `{ corrupt: reason }`
     * when a file exists but cannot be trusted, or null when absent.
     */
    async readManifest(
        stackName: string,
        repoUrl: string,
        branch: string,
    ): Promise<GitProjectManifest | { corrupt: string } | null> {
        const manifestPath = path.join(this.managedRoot(stackName), MANIFEST_FILENAME);
        let raw: string;
        try {
            raw = await fs.promises.readFile(manifestPath, 'utf8');
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
            return { corrupt: `Cannot read manifest: ${(e as Error).message}` };
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch (e) {
            return { corrupt: `Manifest is not valid JSON: ${(e as Error).message}` };
        }
        const reason = this.validateManifest(parsed, stackName, this.expectedIdentity(stackName, repoUrl, branch));
        if (reason !== null) return { corrupt: `Manifest failed validation: ${reason}` };
        return parsed as GitProjectManifest;
    }

    /** Atomic manifest write (tmp + rename). */
    async writeManifest(stackName: string, manifest: GitProjectManifest): Promise<void> {
        const dir = this.managedRoot(stackName);
        await fs.promises.mkdir(dir, { recursive: true });
        const target = path.join(dir, MANIFEST_FILENAME);
        const tmp = path.join(dir, `${MANIFEST_FILENAME}.tmp`);
        await fs.promises.writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf8');
        await fs.promises.rename(tmp, target);
    }

    summaryFrom(manifest: GitProjectManifest): ManifestSummary {
        const actionable = manifest.refusals.filter((r) => r.actionable);
        return {
            state: manifest.state,
            manifestVersion: manifest.manifestVersion,
            resolvedCommitSha: manifest.resolvedRevision.commitSha,
            managedCount: manifest.counts.managed,
            unmanagedCount: manifest.counts.unmanaged,
            refusedCount: manifest.counts.refused,
            refused: actionable,
            hasBuildContexts: manifest.buildContexts.length > 0,
            generatedAt: manifest.generatedAt,
        };
    }

    /** Build a fresh manifest for a fetched revision (provenance: fetch). */
    buildManifest(opts: {
        stackName: string;
        repoUrl: string;
        branch: string;
        commitSha: string;
        projectRoot: string | null;
        composeFiles: string[];
        projectName: string;
        invocation: string[];
        inputs: ComposeInputEntry[];
        refusals: RefusalInfo[];
        buildContexts: BuildContextPlan[];
        bounds: ManifestBounds;
        priorManifest: GitProjectManifest | null;
        state: ManifestState;
    }): GitProjectManifest {
        const now = Date.now();
        return {
            schemaVersion: 1,
            manifestVersion: (opts.priorManifest?.manifestVersion ?? 0) + 1,
            state: opts.state,
            generatedAt: now,
            identity: this.expectedIdentity(opts.stackName, opts.repoUrl, opts.branch),
            repo: { url: opts.repoUrl, branch: opts.branch },
            resolvedRevision: { commitSha: opts.commitSha, fetchedAt: now },
            project: {
                root: opts.projectRoot,
                composeFiles: opts.composeFiles,
                effectiveProjectDir: opts.projectRoot,
                projectName: opts.projectName,
                invocation: opts.invocation,
            },
            inputs: opts.inputs,
            refusals: opts.refusals,
            buildContexts: opts.buildContexts,
            generation: {
                candidateDir: '',
                appliedDir: '',
                previousDir: null,
            },
            counts: {
                managed: opts.inputs.filter((i) => i.ownership === 'managed').length,
                unmanaged: opts.inputs.filter((i) => i.ownership === 'unmanaged').length,
                refused: opts.refusals.length,
            },
            bounds: opts.bounds,
        };
    }

    // ─── Candidate build ──────────────────────────────────────────────────────

    /**
     * Build the staged candidate for a sha: copy managed files + filtered
     * build contexts into the managed area, then write the completion marker.
     * Returns the generations-relative candidate path.
     */
    async buildCandidate(
        stackName: string,
        sha: string,
        cloneDir: string,
        files: CopyEntry[],
        contexts: ContextCopyPlan[],
        bounds: ManifestBounds,
    ): Promise<string> {
        const candidateRel = `${GENERATIONS_DIR}/candidate-${sha}`;
        const candidateAbs = path.join(this.managedRoot(stackName), candidateRel);
        await fs.promises.rm(candidateAbs, { recursive: true, force: true });
        await fs.promises.mkdir(candidateAbs, { recursive: true });
        await ComposeInputDiscoveryService.getInstance().walkAndCopy(cloneDir, candidateAbs, files, contexts, bounds);
        // Completion marker: candidate reuse is gated on this, never on
        // directory existence (a partial build must not be promoted).
        await fs.promises.writeFile(path.join(candidateAbs, CANDIDATE_COMPLETE_MARKER), sha, 'utf8');
        return candidateRel;
    }

    // ─── Promotion ───────────────────────────────────────────────────────────

    private async markerPath(stackName: string): Promise<string> {
        return path.join(this.managedRoot(stackName), PROMOTION_MARKER);
    }

    /**
     * Read the promotion marker. Distinguishes ABSENT (no crash happened) from
     * CORRUPT (a crash mid-marker-write): a corrupt marker must never be
     * treated as a clean slate, or recovery would skip a half-written stack.
     */
    private async readMarker(stackName: string): Promise<PromotionMarker | { corrupt: string } | null> {
        let raw: string;
        try {
            raw = await fs.promises.readFile(await this.markerPath(stackName), 'utf8');
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
            return { corrupt: `Cannot read promotion marker: ${(e as Error).message}` };
        }
        try {
            const parsed = JSON.parse(raw) as PromotionMarker;
            if (typeof parsed.sha !== 'string' || typeof parsed.candidateRelPath !== 'string' || !Array.isArray(parsed.written)) {
                return { corrupt: 'Promotion marker has an unexpected shape' };
            }
            return parsed;
        } catch (e) {
            return { corrupt: `Promotion marker is not valid JSON: ${(e as Error).message}` };
        }
    }

    /** Atomic marker write (tmp + rename) so a crash never leaves a half-written marker. */
    private async writeMarker(stackName: string, marker: PromotionMarker): Promise<void> {
        const target = await this.markerPath(stackName);
        const tmp = `${target}.tmp`;
        await fs.promises.writeFile(tmp, JSON.stringify(marker), 'utf8');
        await fs.promises.rename(tmp, target);
    }

    /** Hash of the stack-dir file at a materialized path, or null when absent. */
    async hashStackFile(stackName: string, relPath: string): Promise<string | null> {
        try {
            const abs = await this.stackFileAbs(stackName, relPath);
            return sha256Of(await fs.promises.readFile(abs));
        } catch {
            return null;
        }
    }

    private async stackFileAbs(stackName: string, relPath: string): Promise<string> {
        // Same resolution chain as FileSystemService: node.compose_dir ->
        // COMPOSE_DIR -> /app/compose. The stack name was validated upstream
        // (isValidStackName); writes still go through the guarded FS service.
        const composeDir = NodeRegistry.getInstance().getComposeDir(NodeRegistry.getInstance().getDefaultNodeId());
        return path.resolve(composeDir, stackName, relPath);
    }

    /**
     * Copy one candidate path into the stack dir through the guarded FS
     * service. Directory entries (build contexts) are copied recursively,
     * preserving the nested layout. Content is written BYTE-EXACT: build
     * contexts, configs, and secrets can be binary, and the manifest hashes
     * are computed over raw bytes, so a lossy string conversion would corrupt
     * files and permanently trip the divergence guard on re-apply.
     */
    private async writeStackFileFromCandidate(stackName: string, candidateAbs: string, destRel: string, maxFileBytes: number): Promise<void> {
        const src = path.join(candidateAbs, destRel);
        const stat = await fs.promises.stat(src);
        if (stat.isDirectory()) {
            const entries = await fs.promises.readdir(src, { withFileTypes: true });
            for (const entry of entries) {
                await this.writeStackFileFromCandidate(stackName, candidateAbs, `${destRel}/${entry.name}`, maxFileBytes);
            }
            return;
        }
        if (stat.size > maxFileBytes) {
            throw new Error(`Materialized file too large: ${destRel} (${stat.size} bytes)`);
        }
        const content = await fs.promises.readFile(src);
        const fsSvc = FileSystemService.getInstance();
        if (destRel === 'compose.yaml' || destRel === 'compose.yml' || destRel === 'docker-compose.yaml' || destRel === 'docker-compose.yml') {
            await fsSvc.saveStackContent(stackName, content);
        } else {
            await fsSvc.writeStackFile(stackName, destRel, content);
        }
    }

    /**
     * Promote the validated candidate into the live stack dir. Crash-safe:
     * the promotion marker records the intermediate state; any mid-write
     * failure restores the previous applied generation and rethrows.
     */
    async promoteGeneration(stackName: string, opts: {
        sha: string;
        candidateRelPath: string;
        manifest: GitProjectManifest;
        priorManifest: GitProjectManifest | null;
    }): Promise<void> {
        const { sha, candidateRelPath, manifest, priorManifest } = opts;
        const candidateAbs = path.join(this.managedRoot(stackName), candidateRelPath);
        const markerPath = await this.markerPath(stackName);
        const bounds = this.boundsConfig();

        try {
            // The candidate must be complete; a partial build is never promoted.
            try {
                await fs.promises.access(path.join(candidateAbs, CANDIDATE_COMPLETE_MARKER));
            } catch {
                throw new Error('Candidate is incomplete; pull again before applying');
            }

            await fs.promises.mkdir(this.managedRoot(stackName), { recursive: true });
            await this.writeMarker(stackName, { sha, candidateRelPath, written: [] });

            // 1. Write every managed, present input from the candidate. The
            //    marker is rewritten in BATCHES (every 25 files) with the full
            //    written list: per-file rewrites are O(n^2) I/O on the large
            //    projects this feature enables, and the recovery invariant only
            //    needs the marker to exist with the last-known written set.
            const managed = manifest.inputs.filter((i) => i.ownership === 'managed' && i.state === 'present' && i.materializedPath !== null);
            const written: string[] = [];
            for (const entry of managed) {
                await this.writeStackFileFromCandidate(stackName, candidateAbs, entry.materializedPath!, bounds.maxFileBytes);
                written.push(entry.materializedPath!);
                if (written.length % 25 === 0 || written.length === managed.length) {
                    await this.writeMarker(stackName, { sha, candidateRelPath, written });
                }
            }

            // 2. Stale cleanup: prior-manifest paths Sencho owns (deletionAuthority
            //    sencho), absent from the new set. Only sencho-authority paths are
            //    ever unlinked; user/none authority stays untouched. A failed
            //    unlink FAILS the promotion (the transaction restores the prior
            //    generation) rather than recording a tombstone for a file that
            //    still exists and can silently change the deployed model.
            const newPaths = new Set(managed.map((i) => i.materializedPath!));
            const removed: ComposeInputEntry[] = [];
            if (priorManifest) {
                for (const entry of priorManifest.inputs) {
                    if (entry.ownership !== 'managed' || entry.state !== 'present' || entry.materializedPath === null) continue;
                    if (entry.deletionAuthority !== 'sencho') continue; // never touch user/none authority
                    if (newPaths.has(entry.materializedPath)) continue;
                    const fsSvc = FileSystemService.getInstance();
                    // Directories (build contexts) need a recursive unlink; a
                    // non-recursive attempt would throw and fail the promotion
                    // even though the directory is legitimately removable.
                    const isDir = await fsSvc
                        .pathKind(stackName, entry.materializedPath)
                        .then((kind) => kind === 'directory')
                        .catch(() => false);
                    await fsSvc.deleteStackPath(stackName, entry.materializedPath, isDir);
                    removed.push({ ...entry, state: 'tombstoned', contentSha256: null, sizeBytes: null });
                }
            }

            // 3. Move candidate -> applied FIRST, then write the manifest.
            //    Ordering invariant: the sweep treats the on-disk manifest as
            //    the previous generation, so a crash before the manifest write
            //    must leave the OLD manifest on disk (restore works); a crash
            //    after the write restores the idempotently rewritten new
            //    generation, which is harmless.
            const appliedRel = `${GENERATIONS_DIR}/applied-${sha}`;
            const appliedAbs = path.join(this.managedRoot(stackName), appliedRel);
            manifest.generation = {
                candidateDir: candidateRelPath,
                appliedDir: appliedRel,
                previousDir: priorManifest?.generation.appliedDir ?? null,
            };
            manifest.inputs = [...manifest.inputs, ...removed];
            manifest.counts = {
                managed: manifest.inputs.filter((i) => i.ownership === 'managed' && i.state === 'present').length,
                unmanaged: manifest.inputs.filter((i) => i.ownership === 'unmanaged').length,
                refused: manifest.refusals.length,
            };
            await fs.promises.rm(appliedAbs, { recursive: true, force: true });
            await fs.promises.rename(candidateAbs, appliedAbs);
            await this.pruneGenerations(stackName, appliedRel, manifest.generation.previousDir);

            // 4. Write the manifest, then the DB cache + mount-root invalidation.
            await this.writeManifest(stackName, manifest);
            DatabaseService.getInstance().setGitSourceManifestState(stackName, manifest.manifestVersion, manifest.state, appliedRel);
            StackFileRootsService.invalidate(NodeRegistry.getInstance().getDefaultNodeId(), stackName);

            // 5. Clear the marker (last step; its presence means "recover").
            await fs.promises.rm(markerPath, { force: true });
        } catch (error) {
            // Mid-write failure: restore the previous applied generation and
            // rethrow so the caller reports the failure honestly.
            try {
                await this.restorePreviousGeneration(stackName, opts);
            } catch (restoreError) {
                console.error('[GitManifest] promotion failed and recovery restore also failed:', (restoreError as Error).message);
            }
            throw error;
        }
    }

    /**
     * Restore the previous applied generation's managed files AND the manifest
     * FILE into the stack dir, then clear the promotion marker. Used after a
     * mid-write crash or failed promotion. If any restore step fails, the
     * marker is KEPT and the DB state is set to migration_required so the boot
     * sweep retries and the UI flags the stack instead of declaring a false
     * recovery.
     */
    async restorePreviousGeneration(stackName: string, opts: { sha: string; candidateRelPath: string; manifest: GitProjectManifest; priorManifest: GitProjectManifest | null }): Promise<void> {
        const prior = opts.priorManifest;
        let failures = 0;
        if (prior) {
            const priorDir = path.join(this.managedRoot(stackName), prior.generation.appliedDir);
            for (const entry of prior.inputs) {
                if (entry.ownership !== 'managed' || entry.state !== 'present' || entry.materializedPath === null) continue;
                try {
                    await this.writeStackFileFromCandidate(stackName, priorDir, entry.materializedPath, this.boundsConfig().maxFileBytes);
                } catch (e) {
                    failures += 1;
                    console.error(`[GitManifest] restore could not write ${entry.materializedPath}:`, (e as Error).message);
                }
            }
            if (failures === 0) {
                // C1: the manifest FILE must agree with the restored disk state,
                // or the next apply would read the new manifest against the old
                // files and refuse every input as locally modified forever.
                await this.writeManifest(stackName, prior);
            }
            DatabaseService.getInstance().setGitSourceManifestState(
                stackName,
                failures === 0 ? prior.manifestVersion : null,
                failures === 0 ? prior.state : 'migration_required',
                failures === 0 ? prior.generation.appliedDir : null,
            );
        } else {
            // First-ever promotion failed with no prior generation to restore:
            // the stack dir holds a partial file set. Flag it and KEEP the
            // marker so the boot sweep reports the stack instead of silently
            // leaving a mixed state.
            DatabaseService.getInstance().setGitSourceManifestState(stackName, null, 'migration_required', null);
            failures = 1;
        }
        if (failures === 0) {
            await fs.promises.rm(await this.markerPath(stackName), { force: true });
        }
        StackFileRootsService.invalidate(NodeRegistry.getInstance().getDefaultNodeId(), stackName);
    }

    private async pruneGenerations(stackName: string, keepAppliedRel: string, previousDir: string | null): Promise<void> {
        const dir = this.generationsDir(stackName);
        let entries;
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        const keepBase = path.basename(keepAppliedRel);
        // Retention is previousDir-explicit, never lexicographic: sha hex order
        // says nothing about recency, and the manifest's previousDir is what a
        // crash restore reads from.
        const keep = new Set([keepBase, previousDir ? path.basename(previousDir) : null].filter((v): v is string => v !== null));
        for (const entry of entries) {
            if (!entry.isDirectory() || !entry.name.startsWith('applied-')) continue;
            if (keep.has(entry.name)) continue;
            await fs.promises.rm(path.join(dir, entry.name), { recursive: true, force: true });
        }
    }

    // ─── Boot sweep ──────────────────────────────────────────────────────────

    /**
     * One stack's crash-recovery + orphan sweep. Callers run this under the
     * per-stack lock. When a promotion marker exists, the stack-dir files
     * recorded as written are verified against the candidate; a match means
     * recovery restores the previous applied generation, a mismatch means the
     * operator hand-repaired after the crash: decline, flag migration_required,
     * and report. Candidates without the completion marker are deleted; the
     * whole managed area is dropped when the stack no longer exists.
     */
    async sweepManagedArea(stackName: string, opts: { repoUrl: string; branch: string; stackExists: boolean }): Promise<void> {
        const { repoUrl, branch, stackExists } = opts;
        if (!stackExists) {
            await this.deleteManagedArea(stackName);
            return;
        }
        const marker = await this.readMarker(stackName);
        if (marker) {
            if ('corrupt' in marker) {
                // A corrupt marker (crash mid-marker-write) is NOT a clean slate:
                // the stack dir may be half-written. Flag recovery-required.
                await fs.promises.rm(await this.markerPath(stackName), { force: true });
                DatabaseService.getInstance().setGitSourceManifestState(stackName, null, 'migration_required', null);
                console.warn(`[GitManifest] promotion marker for ${stackName} is corrupt (${marker.corrupt}); flagged migration_required`);
                return;
            }
            const candidateAbs = path.join(this.managedRoot(stackName), marker.candidateRelPath);
            let candidateOk = false;
            try {
                await fs.promises.access(path.join(candidateAbs, CANDIDATE_COMPLETE_MARKER));
                candidateOk = true;
            } catch {
                candidateOk = false;
            }
            if (!candidateOk) {
                // Candidate vanished; nothing to verify or restore against.
                await fs.promises.rm(await this.markerPath(stackName), { force: true });
                DatabaseService.getInstance().setGitSourceManifestState(stackName, null, 'migration_required', null);
                console.warn(`[GitManifest] promotion marker found for ${stackName} but the candidate is missing; flagged migration_required`);
                return;
            }
            const prior = await this.readManifest(stackName, repoUrl, branch);
            if (prior === null || 'corrupt' in prior) {
                await fs.promises.rm(await this.markerPath(stackName), { force: true });
                DatabaseService.getInstance().setGitSourceManifestState(stackName, null, 'migration_required', null);
                console.warn(`[GitManifest] promotion marker found for ${stackName} but no trustworthy prior manifest; flagged migration_required`);
                return;
            }
            // Verify the recorded mid-write state still matches the candidate.
            // A missing candidate file is a mismatch (decline + flag), never a
            // throw that would abort the sweep for the remaining stacks.
            let mismatch: string | null = null;
            for (const rel of marker.written) {
                let expected: string | null = null;
                try {
                    expected = sha256Of(await fs.promises.readFile(path.join(candidateAbs, rel)));
                } catch {
                    mismatch = `${rel} (candidate file missing)`;
                    break;
                }
                const actual = await this.hashStackFile(stackName, rel);
                if (actual !== expected) {
                    mismatch = `${rel} (${actual ?? 'missing'} != ${expected})`;
                    break;
                }
            }
            if (mismatch !== null) {
                // Hand-repaired after the crash: do NOT overwrite user work.
                await fs.promises.rm(await this.markerPath(stackName), { force: true });
                DatabaseService.getInstance().setGitSourceManifestState(stackName, null, 'migration_required', null);
                console.warn(`[GitManifest] promotion marker for ${stackName} does not match the stack dir (${mismatch}); restore declined, flagged migration_required`);
                return;
            }
            await this.restorePreviousGeneration(stackName, {
                sha: marker.sha,
                candidateRelPath: marker.candidateRelPath,
                manifest: prior,
                priorManifest: prior,
            });
            console.warn(`[GitManifest] restored previous applied generation for ${stackName} after a crash`);
        }

        // Orphan candidates: incomplete or stale.
        const dir = this.generationsDir(stackName);
        try {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            const now = Date.now();
            for (const entry of entries) {
                if (!entry.isDirectory() || !entry.name.startsWith('candidate-')) continue;
                const abs = path.join(dir, entry.name);
                const complete = await fs.promises
                    .access(path.join(abs, CANDIDATE_COMPLETE_MARKER))
                    .then(() => true)
                    .catch(() => false);
                if (!complete) {
                    await fs.promises.rm(abs, { recursive: true, force: true });
                    continue;
                }
                const st = await fs.promises.stat(abs);
                if (now - st.mtimeMs > ORPHAN_CANDIDATE_AGE_MS) {
                    await fs.promises.rm(abs, { recursive: true, force: true });
                }
            }
        } catch {
            // no generations dir yet
        }
    }

    /**
     * Delete the whole managed area. Failures are logged and reported as
     * false so callers can decide whether the operation should proceed
     * (stack deletion tolerates a lingering area; detach must not drop the
     * row while secret-bearing generations survive).
     */
    async deleteManagedArea(stackName: string): Promise<boolean> {
        const root = this.managedRoot(stackName);
        try {
            await fs.promises.rm(root, { recursive: true, force: true });
            return true;
        } catch (e) {
            console.warn(`[GitManifest] could not delete managed area for ${stackName}:`, (e as Error).message);
            return false;
        }
    }

    // ─── Migration ───────────────────────────────────────────────────────────

    /**
     * Build a conservative manifest from historical state (applied_deploy_spec
     * + disk). Deletion authority is granted ONLY for the exact paths
     * historical code wrote (spec files + synced .env); contextDir subtrees
     * were never enumerated, so their files get authority 'none'. Never infer
     * deletion authority from incomplete historical metadata.
     */
    async buildMigratedManifest(
        stackName: string,
        source: { repo_url: string; branch: string; sync_env: boolean; applied_deploy_spec: { files: string[]; contextDir: string | null } | null },
        priorVersion = 0,
    ): Promise<GitProjectManifest> {
        const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
        const bounds = this.boundsConfig();
        const now = Date.now();
        const inputs: ComposeInputEntry[] = [];
        const spec = source.applied_deploy_spec;

        const addEntry = async (
            materializedPath: string,
            role: InputRole,
            kind: InputDependencyKind,
            authority: DeletionAuthority,
            note: string | null,
        ): Promise<void> => {
            let hash: string | null = null;
            let size: number | null = null;
            try {
                const abs = await this.stackFileAbs(stackName, materializedPath);
                const buf = await fs.promises.readFile(abs);
                hash = sha256Of(buf);
                size = buf.length;
            } catch {
                // file absent on disk; entry records the historical intent
            }
            inputs.push({
                sourcePath: materializedPath,
                materializedPath,
                role,
                dependencyKind: kind,
                ownership: 'managed',
                provenance: 'migration',
                sensitivity: kind === 'sync-env' ? 'high' : 'medium',
                contentSha256: hash,
                sizeBytes: size,
                state: 'present',
                deletionAuthority: authority,
                note,
            });
        };

        if (spec && spec.files.length > 0) {
            for (const [index, file] of spec.files.entries()) {
                // Must be awaited: addEntry reads the disk before pushing, and
                // the manifest + counts below are built from the final array.
                await addEntry(file, index === 0 ? 'compose-primary' : 'compose-additional', 'explicit', 'sencho', null);
            }
            if (spec.contextDir) {
                inputs.push({
                    sourcePath: spec.contextDir,
                    materializedPath: spec.contextDir,
                    role: 'build-context',
                    dependencyKind: 'build-context',
                    ownership: 'managed',
                    provenance: 'migration',
                    sensitivity: 'low',
                    contentSha256: null,
                    sizeBytes: null,
                    state: 'present',
                    deletionAuthority: 'none',
                    note: 'Project directory subtree was not enumerated historically; no deletion authority inferred for files inside it',
                });
            }
        } else {
            await addEntry('compose.yaml', 'compose-primary', 'explicit', 'sencho', null);
        }
        if (source.sync_env) {
            await addEntry('.env', 'env', 'sync-env', 'sencho', null);
        }

        const invocation: string[] = [];
        try {
            invocation.push(...(await authoredComposeFileArgs(stackName, nodeId)));
            invocation.push(...(await authoredComposeEnvFileArgs(stackName, nodeId)));
        } catch {
            // invocation is best-effort at migration time; a fresh pull rebuilds it
        }

        const manifest: GitProjectManifest = {
            schemaVersion: 1,
            manifestVersion: priorVersion + 1,
            state: 'migrated',
            generatedAt: now,
            identity: this.expectedIdentity(stackName, source.repo_url, source.branch),
            repo: { url: source.repo_url, branch: source.branch },
            resolvedRevision: { commitSha: '', fetchedAt: now },
            project: {
                root: spec?.contextDir ?? null,
                composeFiles: spec?.files ?? ['compose.yaml'],
                effectiveProjectDir: spec?.contextDir ?? null,
                projectName: stackName,
                invocation,
            },
            inputs,
            refusals: [],
            buildContexts: [],
            generation: { candidateDir: '', appliedDir: '', previousDir: null },
            counts: {
                managed: inputs.filter((i) => i.ownership === 'managed').length,
                unmanaged: 0,
                refused: 0,
            },
            bounds,
        };
        // Backfill the previous applied generation so restore works after a
        // crash even before the first fresh pull.
        const appliedRel = `${GENERATIONS_DIR}/applied-migration`;
        const appliedAbs = path.join(this.managedRoot(stackName), appliedRel);
        await fs.promises.mkdir(appliedAbs, { recursive: true });
        for (const entry of inputs) {
            if (entry.materializedPath === null) continue;
            try {
                const abs = await this.stackFileAbs(stackName, entry.materializedPath);
                const dest = path.join(appliedAbs, entry.materializedPath);
                await fs.promises.mkdir(path.dirname(dest), { recursive: true });
                await fs.promises.copyFile(abs, dest);
            } catch {
                // best-effort snapshot of the migrated state
            }
        }
        manifest.generation.appliedDir = appliedRel;
        return manifest;
    }

    // ─── Detach/export ───────────────────────────────────────────────────────

    /**
     * Render the effective compose model with the exact authored invocation
     * (no mesh). Throws when the render fails or the output is not usable, so
     * the detach transaction aborts before anything changes.
     */
    async exportForDetach(stackName: string, render: () => Promise<string>): Promise<string> {
        let rendered: string;
        try {
            rendered = await render();
        } catch (e) {
            // A render failure aborts the detach transaction; tag it so the
            // route can answer 409 (row kept) rather than a generic 500.
            throw Object.assign(new Error(`Detach render failed: ${e instanceof Error ? e.message : String(e)}`), { code: 'RENDER_FAILED' });
        }
        if (!rendered || !rendered.trim()) {
            throw Object.assign(new Error('Detach render produced empty output; nothing exported'), { code: 'RENDER_FAILED' });
        }
        try {
            const parsed = YAML.parse(rendered);
            if (!parsed || typeof parsed !== 'object') {
                throw new Error('Detach render produced invalid YAML');
            }
        } catch (e) {
            throw Object.assign(new Error(`Detach render failed to parse: ${e instanceof Error ? e.message : String(e)}`), { code: 'RENDER_FAILED' });
        }
        return rendered;
    }
}
