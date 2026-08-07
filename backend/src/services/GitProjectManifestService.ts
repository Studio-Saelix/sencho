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
 * Promotion is transactional: a promotion.json marker records the full file
 * journal and commit phase. The boot sweep either finalizes a committed
 * manifest or restores the previous applied generation under the per-stack
 * lock. If live files match neither snapshot, it declines and flags recovery.
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
import { sanitizeForLog } from '../utils/safeLog';
import { isPathWithinBase, isValidStackName } from '../utils/validation';
import type {
    BuildContextPlan,
    ComposeInputEntry,
    DeletionAuthority,
    GitProjectManifest,
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
    PublicManifest,
    RefusalInfo,
} from '../types/gitProjectManifest';

export const MANAGED_ROOT_NAME = 'git-managed';
export const MANIFEST_FILENAME = 'manifest.v1.json';
export const PROMOTION_MARKER = 'promotion.json';
export const CANDIDATE_COMPLETE_MARKER = '.candidate-complete';
export const GENERATIONS_DIR = 'generations';
const DETACH_RECOVERY_MARKER = 'detach-recovery.v1.json';

// Retention: current applied generation + one previous (prune keeps the
// manifest's previousDir explicitly, not by count).
const ORPHAN_CANDIDATE_AGE_MS = 24 * 60 * 60 * 1000;

type PromotionPhase = 'applying' | 'committing';

interface PromotionMarker {
    schemaVersion: 2;
    phase: PromotionPhase;
    sha: string;
    manifestVersion: number;
    candidateRelPath: string;
    appliedRelPath: string;
    /**
     * Complete stack-relative file operation journal, persisted before the
     * first live write. Recovery validates every path against either the prior
     * or incoming snapshot, including writes after the last marker flush.
     */
    affected: string[];
    /** Incoming files absent from the prior generation. */
    introduced: string[];
}

const PROMOTION_PHASES: readonly PromotionPhase[] = ['applying', 'committing'];

type DetachRecoveryFile =
    | { path: string; existed: true; contentBase64: string }
    | { path: string; existed: false; contentBase64: null };

type DetachRecoveryInput =
    | { path: string; existed: true; content: Buffer }
    | { path: string; existed: false; content: null };

interface DetachRecoveryMarker {
    schemaVersion: 1;
    identity: { stackName: string; repoUrl: string; branch: string };
    managedAreaExisted: boolean;
    files: DetachRecoveryFile[];
}

type RecoveryIncoming =
    | { inputs: ComposeInputEntry[]; buildContexts: BuildContextPlan[] }
    | { introducedPaths: string[] };

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

/**
 * A file-level path in a marker or manifest must be non-empty because an
 * empty path resolves to the stack root and would delete/overwrite it.
 */
function isNonEmptyRelPath(value: unknown): value is string {
    if (typeof value !== 'string' || value.length === 0) return false;
    return isSafeRelPath(value);
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isSha256(value: unknown): value is string {
    return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
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
        if (!isValidStackName(stackName)) throw new Error('Invalid stack name for managed project data');
        const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
        return path.join(this.dataRoot(), MANAGED_ROOT_NAME, String(nodeId), stackName);
    }

    private generationsDir(stackName: string): string {
        return path.join(this.managedRoot(stackName), GENERATIONS_DIR);
    }

    private async pathExists(absPath: string): Promise<boolean> {
        try {
            await fs.promises.access(absPath);
            return true;
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
            throw e;
        }
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
        if (!isPositiveInteger(m.manifestVersion)) return 'invalid manifestVersion';
        if (!isOneOf(m.state, MANIFEST_STATES)) return `invalid state ${String(m.state)}`;
        if (!isNonNegativeInteger(m.generatedAt)) return 'invalid generatedAt';

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
        if (!revision
            || typeof revision.commitSha !== 'string'
            || (revision.commitSha.length === 0 && m.state !== 'migrated')
            || !isNonNegativeInteger(revision.fetchedAt)) {
            return 'invalid resolvedRevision';
        }
        const project = m.project as Record<string, unknown> | undefined;
        if (!project || typeof project !== 'object') return 'invalid project';
        if (!Array.isArray(project.composeFiles) || !project.composeFiles.every((f) => isNonEmptyRelPath(f))) return 'invalid project.composeFiles';
        if (!Array.isArray(project.invocation) || !project.invocation.every((a) => typeof a === 'string')) return 'invalid project.invocation';
        if (typeof project.projectName !== 'string' || project.projectName.length === 0) return 'invalid project.projectName';

        if (!Array.isArray(m.inputs)) return 'invalid inputs';
        for (const entry of m.inputs as unknown[]) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'invalid input entry';
            const e = entry as Record<string, unknown>;
            if (e.sourcePath !== null && typeof e.sourcePath !== 'string') return 'invalid input sourcePath';
            if (e.materializedPath !== null && !isNonEmptyRelPath(e.materializedPath)) return `invalid input materializedPath ${String(e.materializedPath)}`;
            if (!isOneOf(e.dependencyKind, DEPENDENCY_KINDS)) return `invalid input kind ${String(e.dependencyKind)}`;
            if (!isOneOf(e.role, INPUT_ROLES)) return `invalid input role ${String(e.role)}`;
            if (!isOneOf(e.ownership, OWNERSHIPS)) return `invalid input ownership ${String(e.ownership)}`;
            if (!isOneOf(e.provenance, PROVENANCES)) return `invalid input provenance ${String(e.provenance)}`;
            if (!isOneOf(e.sensitivity, SENSITIVITIES)) return `invalid input sensitivity ${String(e.sensitivity)}`;
            if (!isOneOf(e.state, INPUT_STATES)) return `invalid input state ${String(e.state)}`;
            if (!isOneOf(e.deletionAuthority, DELETION_AUTHORITIES)) return `invalid deletionAuthority ${String(e.deletionAuthority)}`;
            if (e.contentSha256 !== null && !isSha256(e.contentSha256)) return 'invalid input contentSha256';
            if (e.sizeBytes !== null && !isNonNegativeInteger(e.sizeBytes)) return 'invalid input sizeBytes';
            if (e.note !== null && typeof e.note !== 'string') return 'invalid input note';
        }
        if (!Array.isArray(m.refusals) || !Array.isArray(m.buildContexts)) return 'invalid refusals/buildContexts';
        for (const refusal of m.refusals as unknown[]) {
            if (!refusal || typeof refusal !== 'object' || Array.isArray(refusal)) return 'invalid refusal entry';
            const r = refusal as Record<string, unknown>;
            if (r.sourcePath !== null && typeof r.sourcePath !== 'string') return 'invalid refusal sourcePath';
            if (typeof r.kind !== 'string' || r.kind.length === 0 || typeof r.reason !== 'string' || typeof r.actionable !== 'boolean') {
                return 'invalid refusal fields';
            }
        }
        for (const ctx of m.buildContexts as unknown[]) {
            if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx)) return 'invalid build context entry';
            const c = ctx as Record<string, unknown>;
            if (!isSafeRelPath(c.repoPath)) return `invalid build context root ${String(c.repoPath)}`;
            if (c.dockerfile !== null && !isNonEmptyRelPath(c.dockerfile)) return `invalid build context dockerfile ${String(c.dockerfile)}`;
            if (!isNonNegativeInteger(c.contextBytes) || !isNonNegativeInteger(c.ignoredCount)) return 'invalid build context counters';
            if (typeof c.dockerignoreApplied !== 'boolean' || typeof c.excludedFromCopy !== 'boolean') return 'invalid build context flags';
            if (c.note !== null && typeof c.note !== 'string') return 'invalid build context note';
            const files = c.files;
            if (files !== undefined) {
                if (!Array.isArray(files)) return 'invalid build context files';
                const seenPaths = new Set<string>();
                let inventoryBytes = 0;
                let inventoryHasSizes = true;
                for (const f of files as unknown[]) {
                    if (!f || typeof f !== 'object' || Array.isArray(f)) return 'invalid build context file entry';
                    const fe = f as Record<string, unknown>;
                    if (!isNonEmptyRelPath(fe.path)) return `invalid build context file path ${String(fe.path)}`;
                    if (!isSha256(fe.sha256)) return 'invalid build context file hash';
                    if (fe.sizeBytes !== undefined && !isNonNegativeInteger(fe.sizeBytes)) return 'invalid build context file size';
                    if (typeof fe.sizeBytes === 'number') inventoryBytes += fe.sizeBytes;
                    else inventoryHasSizes = false;
                    const key = String(fe.path).toLowerCase();
                    if (seenPaths.has(key)) return `duplicate build context file ${String(fe.path)}`;
                    seenPaths.add(key);
                }
                if (inventoryHasSizes && inventoryBytes !== c.contextBytes) return 'build context byte count does not match its file inventory';
            }
        }
        const generation = m.generation as Record<string, unknown> | undefined;
        if (!generation || typeof generation !== 'object') return 'invalid generation';
        if (!isSafeRelPath(generation.candidateDir) || !isSafeRelPath(generation.appliedDir) || !isSafeRelPath(generation.previousDir)) {
            return 'invalid generation paths';
        }
        if (!isSafeRelPath((m.project as Record<string, unknown> | undefined)?.root)) return 'invalid project.root';
        if (!m.counts || typeof m.counts !== 'object') return 'invalid counts';
        const counts = m.counts as Record<string, unknown>;
        if (!isNonNegativeInteger(counts.managed) || !isNonNegativeInteger(counts.unmanaged) || !isNonNegativeInteger(counts.refused)) {
            return 'invalid counts';
        }
        const inputEntries = m.inputs as Record<string, unknown>[];
        const expectedManaged = inputEntries.filter((entry) => entry.ownership === 'managed' && entry.state === 'present').length;
        const expectedUnmanaged = inputEntries.filter((entry) => entry.ownership === 'unmanaged').length;
        if (counts.managed !== expectedManaged || counts.unmanaged !== expectedUnmanaged || counts.refused !== (m.refusals as unknown[]).length) {
            return 'manifest counts do not match its inventory';
        }
        if (!m.bounds || typeof m.bounds !== 'object') return 'invalid bounds';
        const bounds = m.bounds as Record<string, unknown>;
        if (!isPositiveInteger(bounds.maxFiles) || !isPositiveInteger(bounds.maxBytes) || !isPositiveInteger(bounds.maxContextBytes)
            || !isPositiveInteger(bounds.maxPathDepth) || !isPositiveInteger(bounds.maxFileBytes)) {
            return 'invalid bounds';
        }
        // Cross-check: no managed input path collides with any context file path.
        const inputSeen = new Set<string>();
        for (const e of m.inputs as Record<string, unknown>[]) {
            if (e.materializedPath === null || e.materializedPath === undefined) continue;
            const key = String(e.materializedPath).toLowerCase();
            if (inputSeen.has(key)) return `duplicate input path ${String(e.materializedPath)}`;
            inputSeen.add(key);
        }
        for (const c of m.buildContexts as Record<string, unknown>[]) {
            if (!c || typeof c !== 'object') continue;
            const files = (c as Record<string, unknown>).files;
            if (!Array.isArray(files)) continue;
            for (const f of files as Record<string, unknown>[]) {
                const ctxPath = String((c as Record<string, unknown>).repoPath ?? '');
                const filePath = String(f.path ?? '');
                const key = (ctxPath ? `${ctxPath}/${filePath}` : filePath).toLowerCase();
                if (inputSeen.has(key)) return `context file path ${key} collides with an input path`;
                inputSeen.add(key);
            }
        }
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
        // Normalize pre-correction manifests: context entries written before
        // the per-file inventory existed have no `files` array; degrade them
        // to directory granularity instead of rejecting or throwing later.
        const manifest = parsed as GitProjectManifest;
        manifest.buildContexts = manifest.buildContexts.map((ctx) => ({
            ...ctx,
            files: Array.isArray(ctx.files) && ctx.files.every((file) => isNonNegativeInteger(file.sizeBytes))
                ? ctx.files
                : [],
        }));
        return manifest;
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

    /**
     * Public projection for the manifest read endpoint: hashes, size metadata,
     * provenance, and deletion authority are internal-only, and for
     * high-sensitivity inputs the display path AND the note are redacted
     * (null) so secret file names never cross the API.
     */
    toPublicManifest(manifest: GitProjectManifest): PublicManifest {
        return {
            manifestVersion: manifest.manifestVersion,
            state: manifest.state,
            resolvedCommitSha: manifest.resolvedRevision.commitSha,
            projectRoot: manifest.project.root,
            composeFiles: manifest.project.composeFiles,
            projectName: manifest.project.projectName,
            inputs: manifest.inputs.map((entry) => ({
                path: entry.sensitivity === 'high' ? null : (entry.materializedPath ?? entry.sourcePath),
                role: entry.role,
                dependencyKind: entry.dependencyKind,
                ownership: entry.ownership,
                sensitivity: entry.sensitivity,
                state: entry.state,
                note: entry.sensitivity === 'high' ? null : entry.note,
            })),
            counts: manifest.counts,
        };
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
            const parsed: unknown = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { corrupt: 'Promotion marker is not an object' };
            const marker = parsed as Record<string, unknown>;
            if (marker.schemaVersion !== 2) return { corrupt: 'Promotion marker has an unsupported schema version' };
            if (!isOneOf(marker.phase, PROMOTION_PHASES)) return { corrupt: 'Promotion marker has an invalid phase' };
            if (typeof marker.sha !== 'string' || marker.sha.length === 0) return { corrupt: 'Promotion marker has an invalid sha' };
            if (!isPositiveInteger(marker.manifestVersion)) return { corrupt: 'Promotion marker has an invalid manifest version' };
            if (!isNonEmptyRelPath(marker.candidateRelPath)) return { corrupt: 'Promotion marker has an invalid candidate path' };
            if (!isNonEmptyRelPath(marker.appliedRelPath)) return { corrupt: 'Promotion marker has an invalid applied path' };
            if (!Array.isArray(marker.affected) || !marker.affected.every((w) => isNonEmptyRelPath(w))) {
                return { corrupt: 'Promotion marker has an invalid affected set' };
            }
            if (!Array.isArray(marker.introduced) || !marker.introduced.every((w) => isNonEmptyRelPath(w))) {
                return { corrupt: 'Promotion marker has an invalid introduced set' };
            }
            const affected = marker.affected.filter((value): value is string => typeof value === 'string');
            const introduced = marker.introduced.filter((value): value is string => typeof value === 'string');
            const markerPathLimit = this.boundsConfig().maxFiles * 2;
            if (affected.length > markerPathLimit || introduced.length > markerPathLimit) {
                return { corrupt: 'Promotion marker exceeds the path journal bound' };
            }
            if (new Set(affected.map((w) => w.toLowerCase())).size !== affected.length) {
                return { corrupt: 'Promotion marker has duplicate affected paths' };
            }
            if (new Set(introduced.map((w) => w.toLowerCase())).size !== introduced.length) {
                return { corrupt: 'Promotion marker has duplicate introduced paths' };
            }
            const affectedKeys = new Set(affected.map((w) => w.toLowerCase()));
            if (!introduced.every((w) => affectedKeys.has(w.toLowerCase()))) {
                return { corrupt: 'Promotion marker introduced paths are not in the affected set' };
            }
            return {
                schemaVersion: 2,
                phase: marker.phase,
                sha: marker.sha,
                manifestVersion: marker.manifestVersion,
                candidateRelPath: marker.candidateRelPath,
                appliedRelPath: marker.appliedRelPath,
                affected,
                introduced,
            };
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
        const abs = await this.stackFileAbs(stackName, relPath);
        try {
            return sha256Of(await fs.promises.readFile(abs));
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw e;
        }
    }

    /**
     * Verify a build-context subtree on disk against the manifest's file-level
     * inventory. Returns the context-relative paths that diverge: files whose
     * hash differs, files missing from the stack, and files present in the
     * stack that the manifest does not own (locally added). This gives contexts
     * the same local-modification protection as plain managed files.
     */
    async verifyContextOnDisk(stackName: string, context: BuildContextPlan, managedInputPaths?: Set<string>): Promise<string[]> {
        const abs = await this.stackFileAbs(stackName, context.repoPath);
        const diverged: string[] = [];
        const owned = new Set(context.files.map((f) => f.path));
        const walk = async (dir: string, rel: string): Promise<void> => {
            let entriesList: fs.Dirent[];
            try {
                entriesList = await fs.promises.readdir(dir, { withFileTypes: true });
            } catch {
                return; // missing context dir reported by the owned-file loop below
            }
            for (const entry of entriesList) {
                const childRel = rel ? `${rel}/${entry.name}` : entry.name;
                if (entry.isDirectory()) {
                    await walk(path.join(dir, entry.name), childRel);
                    continue;
                }
                if (entry.isSymbolicLink()) {
                    diverged.push(`${childRel} (symbolic link)`);
                    continue;
                }
                // Files not in the context inventory: if they have a
                // managed-input owner (stack-relative path), they are owned
                // by another manifest entry. The managed set uses stack-
                // relative paths; the walk uses context-relative paths.
                if (!owned.has(childRel)) {
                    const stackRel = context.repoPath ? `${context.repoPath}/${childRel}` : childRel;
                    if (managedInputPaths && managedInputPaths.has(stackRel)) continue;
                    diverged.push(`${childRel} (locally added, not in the managed context)`);
                    continue;
                }
                const expected = context.files.find((f) => f.path === childRel)?.sha256;
                const actual = await this.hashStackFile(stackName, context.repoPath ? `${context.repoPath}/${childRel}` : childRel);
                if (expected === undefined || actual !== expected) {
                    diverged.push(childRel);
                }
            }
        };
        await walk(abs, '');
        for (const ownedFile of context.files) {
            if (!owned.has(ownedFile.path)) continue;
            const present = await fs.promises
                .access(path.join(abs, ownedFile.path))
                .then(() => true)
                .catch(() => false);
            if (!present) diverged.push(`${ownedFile.path} (missing)`);
        }
        return diverged;
    }

    private async stackFileAbs(stackName: string, relPath: string): Promise<string> {
        // Same resolution chain as FileSystemService: node.compose_dir ->
        // COMPOSE_DIR -> /app/compose. The stack name was validated upstream
        // (isValidStackName); writes still go through the guarded FS service.
        const composeDir = NodeRegistry.getInstance().getComposeDir(NodeRegistry.getInstance().getDefaultNodeId());
        if (!isValidStackName(stackName) || !isSafeRelPath(relPath)) throw new Error('Invalid stack file path');
        const stackRoot = path.resolve(composeDir, stackName);
        const resolved = path.resolve(stackRoot, relPath);
        if (!isPathWithinBase(resolved, stackRoot)) throw new Error('Stack file path escapes the stack root');
        return resolved;
    }

    /** Exact file paths owned by one manifest, excluding directory inventory entries. */
    private manifestFilePaths(manifest: Pick<GitProjectManifest, 'inputs' | 'buildContexts'>): string[] {
        const paths = new Map<string, string>();
        for (const entry of manifest.inputs) {
            if (entry.ownership !== 'managed' || entry.state !== 'present' || entry.materializedPath === null) continue;
            if (entry.dependencyKind === 'build-context' || entry.dependencyKind === 'build-additional-context') continue;
            paths.set(entry.materializedPath.toLowerCase(), entry.materializedPath);
        }
        for (const context of manifest.buildContexts) {
            for (const file of context.files) {
                const rel = context.repoPath ? `${context.repoPath}/${file.path}` : file.path;
                paths.set(rel.toLowerCase(), rel);
            }
        }
        return [...paths.values()].sort((a, b) => a.localeCompare(b));
    }

    /** Hash one snapshot file, preserving the distinction between missing and unreadable. */
    private async hashSnapshotFile(baseDir: string, relPath: string): Promise<string | null> {
        const resolved = path.resolve(baseDir, relPath);
        if (!isPathWithinBase(resolved, baseDir)) throw new Error(`Snapshot path escapes its generation: ${relPath}`);
        try {
            return sha256Of(await fs.promises.readFile(resolved));
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw e;
        }
    }

    /**
     * Copy one candidate path into the stack dir through the guarded FS
     * service. Content is written BYTE-EXACT: build
     * contexts, configs, and secrets can be binary, and the manifest hashes
     * are computed over raw bytes, so a lossy string conversion would corrupt
     * files and permanently trip the divergence guard on re-apply.
     */
    private async writeStackFileFromCandidate(stackName: string, candidateAbs: string, destRel: string, maxFileBytes: number): Promise<void> {
        if (!isNonEmptyRelPath(destRel)) throw new Error('Invalid candidate file path');
        const src = path.resolve(candidateAbs, destRel);
        if (!isPathWithinBase(src, candidateAbs)) throw new Error(`Candidate file path escapes its generation: ${destRel}`);
        const stat = await fs.promises.stat(src);
        if (stat.isDirectory()) {
            throw new Error(`Expected a materialized file but found a directory: ${destRel}`);
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
        const appliedRel = `${GENERATIONS_DIR}/applied-${sha}-${manifest.manifestVersion}`;
        const appliedAbs = path.join(this.managedRoot(stackName), appliedRel);
        const incomingFiles = this.manifestFilePaths(manifest);
        const priorFiles = priorManifest ? this.manifestFilePaths(priorManifest) : [];
        const priorKeys = new Set(priorFiles.map((rel) => rel.toLowerCase()));
        const priorByCaseFold = new Map(priorFiles.map((rel) => [rel.toLowerCase(), rel]));
        const caseOnlyChange = incomingFiles.find((rel) => {
            const priorRel = priorByCaseFold.get(rel.toLowerCase());
            return priorRel !== undefined && priorRel !== rel;
        });
        if (caseOnlyChange !== undefined) {
            throw new Error(`Case-only managed path changes are not supported: ${priorByCaseFold.get(caseOnlyChange.toLowerCase())} -> ${caseOnlyChange}`);
        }
        const introduced = incomingFiles.filter((rel) => !priorKeys.has(rel.toLowerCase()));
        const affected = [...new Map([...priorFiles, ...incomingFiles].map((rel) => [rel.toLowerCase(), rel])).values()]
            .sort((a, b) => a.localeCompare(b));
        const markerBase: Omit<PromotionMarker, 'phase'> = {
            schemaVersion: 2,
            sha,
            manifestVersion: manifest.manifestVersion,
            candidateRelPath,
            appliedRelPath: appliedRel,
            affected,
            introduced,
        };
        let liveMutationStarted = false;

        try {
            // The candidate must be complete; a partial build is never promoted.
            if (!(await this.pathExists(path.join(candidateAbs, CANDIDATE_COMPLETE_MARKER)))) {
                throw new Error('Candidate is incomplete; pull again before applying');
            }

            // Introduced-path collision guard: a path the incoming generation
            // owns that the prior generation did not, and that ALREADY EXISTS
            // in the live stack, is a local file Sencho never owned.
            // Overwriting it would destroy user data, so refuse BEFORE the
            // first live mutation. The synced stack-root .env is excluded:
            // enabling sync_env is the explicit adoption of that path (its
            // content is staged by design). Fresh creation (priorManifest
            // null) is exempt: the stack dir was just created and every file
            // is adoption boilerplate.
            if (priorManifest) {
                const fsSvc = FileSystemService.getInstance();
                const syncEnvOwnsEnv = manifest.inputs.some((i) => i.dependencyKind === 'sync-env' && i.materializedPath === '.env');
                const colliding: string[] = [];
                for (const rel of introduced) {
                    if (rel === '.env' && syncEnvOwnsEnv) continue;
                    const kind = await fsSvc.pathKind(stackName, rel);
                    if (kind !== null) colliding.push(rel);
                }
                if (colliding.length > 0) {
                    throw new Error(
                        `Refusing to overwrite ${colliding.length > 1 ? 'files' : 'a file'} that Sencho does not manage: ${colliding.join(', ')}. Remove or rename ${colliding.length > 1 ? 'them' : 'it'} in the stack directory, or detach the Git source first.`,
                    );
                }
            }

            await fs.promises.mkdir(this.managedRoot(stackName), { recursive: true });
            // Persist the complete journal before the first live write. This
            // covers every write and deletion even if the process exits between
            // individual operations.
            await this.writeMarker(stackName, { ...markerBase, phase: 'applying' });
            liveMutationStarted = true;

            // 1. Write every owned file exactly once. Context directory input
            // entries are inventory only; their files are listed explicitly by
            // manifestFilePaths.
            const managed = manifest.inputs.filter((i) => i.ownership === 'managed' && i.state === 'present' && i.materializedPath !== null);
            for (const rel of incomingFiles) {
                await this.writeStackFileFromCandidate(stackName, candidateAbs, rel, bounds.maxFileBytes);
            }

            // 2. Stale cleanup: prior-manifest paths Sencho owns (deletionAuthority
            //    sencho), absent from the new set. Only sencho-authority paths are
            //    ever unlinked; user/none authority stays untouched. A failed
            //    unlink FAILS the promotion (the transaction restores the prior
            //    generation) rather than recording a tombstone for a file that
            //    still exists and can silently change the deployed model.
            const newPaths = new Set(managed.map((i) => i.materializedPath!));
            const removed: ComposeInputEntry[] = [];
            const fsSvc = FileSystemService.getInstance();
            // Context files are reconciled FILE-LEVEL: a file removed from the
            // repository inside a retained context must disappear from the
            // stack context too, or the deployed/build context would keep
            // deleted (possibly secret-bearing) content.
            const newContextFiles = new Map<string, Set<string>>();
            for (const ctx of manifest.buildContexts) {
                newContextFiles.set(ctx.repoPath, new Set(ctx.files.map((f) => f.path)));
            }
            if (priorManifest) {
                for (const entry of priorManifest.inputs) {
                    if (entry.ownership !== 'managed' || entry.state !== 'present' || entry.materializedPath === null) continue;
                    if (entry.deletionAuthority !== 'sencho') continue; // never touch user/none authority
                    if (newPaths.has(entry.materializedPath)) continue;
                    // Directories (build contexts) need a recursive unlink; a
                    // non-recursive attempt would throw and fail the promotion
                    // even though the directory is legitimately removable.
                    const isDir = await fsSvc
                        .pathKind(stackName, entry.materializedPath)
                        .then((kind) => kind === 'directory')
                        .catch(() => false);
                    await fsSvc.deleteStackPath(stackName, entry.materializedPath, isDir, { protectedEnabled: false });
                    removed.push({ ...entry, state: 'tombstoned', contentSha256: null, sizeBytes: null });
                }
                // Context-file reconciliation for contexts retained in both sets.
                for (const priorCtx of priorManifest.buildContexts) {
                    const newFiles = newContextFiles.get(priorCtx.repoPath);
                    if (!newFiles) continue; // context removed entirely; handled above
                    for (const priorFile of priorCtx.files) {
                        if (newFiles.has(priorFile.path)) continue;
                        const rel = priorCtx.repoPath ? `${priorCtx.repoPath}/${priorFile.path}` : priorFile.path;
                        await fsSvc.deleteStackPath(stackName, rel, false, { protectedEnabled: false });
                    }
                }
            }

            // 3. Move candidate to a versioned applied snapshot. The manifest
            // version keeps a same-revision re-apply from deleting its own
            // previous recovery snapshot.
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

            // 4. Mark the commit phase before replacing the manifest. Recovery
            // can now distinguish an old-manifest rollback from a committed
            // manifest that only needs its DB cache finalized.
            await this.writeMarker(stackName, { ...markerBase, phase: 'committing' });
            DatabaseService.getInstance().setGitSourceManifestState(stackName, manifest.manifestVersion, manifest.state, appliedRel);
            await this.writeManifest(stackName, manifest);
            StackFileRootsService.invalidate(NodeRegistry.getInstance().getDefaultNodeId(), stackName);

            // Marker cleanup is post-commit housekeeping. If it fails, the
            // next boot recognizes the committed manifest and finalizes it.
            try {
                await fs.promises.rm(markerPath, { force: true });
            } catch (e) {
                console.warn('[GitManifest] committed promotion marker cleanup failed:', (e as Error).message);
            }
        } catch (error) {
            if (!liveMutationStarted) throw error;
            // Mid-write failure: restore the previous applied generation and
            // rethrow so the caller reports the failure honestly.
            try {
                await this.restorePreviousGeneration(stackName, {
                    priorManifest: opts.priorManifest,
                    incoming: { inputs: opts.manifest.inputs, buildContexts: opts.manifest.buildContexts },
                });
            } catch (restoreError) {
                console.error('[GitManifest] promotion failed and recovery restore also failed:', (restoreError as Error).message);
            }
            throw error;
        }
    }

    /**
     * Exact introduced-set computation: every path the incoming generation
     * owns that the prior generation did not. Includes context files so a
     * failed promotion cannot leave a mixed file set inside a retained
     * context. Stack-relative paths.
     */
    private introducedPaths(
        prior: GitProjectManifest | null,
        incoming: { inputs: ComposeInputEntry[]; buildContexts: BuildContextPlan[] },
    ): string[] {
        const priorPaths = new Set((prior ? this.manifestFilePaths(prior) : []).map((rel) => rel.toLowerCase()));
        return this.manifestFilePaths(incoming).filter((rel) => !priorPaths.has(rel.toLowerCase()));
    }

    /**
     * Restore the previous applied generation's managed files AND the manifest
     * FILE into the stack dir, then clear the promotion marker. Used after a
     * mid-write crash or failed promotion. Files the incoming generation
     * introduced (top-level or inside retained contexts) are removed so the
     * prior generation is exact. If any restore step fails, the marker is KEPT
     * and the DB state is set to migration_required so the boot sweep retries
     * and the UI flags the stack instead of declaring a false recovery.
     */
    async restorePreviousGeneration(
        stackName: string,
        opts: { priorManifest: GitProjectManifest | null; incoming?: RecoveryIncoming | null },
    ): Promise<boolean> {
        const prior = opts.priorManifest;
        let failures = 0;
        const fsSvc = FileSystemService.getInstance();
        const removeStackPath = async (relPath: string): Promise<void> => {
            const kind = await fsSvc.pathKind(stackName, relPath);
            if (kind !== null) {
                await fsSvc.deleteStackPath(stackName, relPath, kind === 'directory', { protectedEnabled: false });
            }
        };
        if (prior) {
            const priorDir = path.join(this.managedRoot(stackName), prior.generation.appliedDir);
            for (const rel of this.manifestFilePaths(prior)) {
                try {
                    await this.writeStackFileFromCandidate(stackName, priorDir, rel, this.boundsConfig().maxFileBytes);
                } catch (e) {
                    failures += 1;
                    console.error(`[GitManifest] restore could not write ${rel}:`, (e as Error).message);
                }
            }
            // Exact-generation restore: paths the failed promotion introduced
            // (present in the incoming inventory, absent from the prior one)
            // must be removed, or the stack would keep a mixed old/new file
            // set. Context files are included.
            if (failures === 0 && opts.incoming) {
                const removeList = 'introducedPaths' in opts.incoming
                    ? opts.incoming.introducedPaths
                    : this.introducedPaths(prior, opts.incoming);
                for (const rel of removeList) {
                    try {
                        await removeStackPath(rel);
                    } catch (e) {
                        failures += 1;
                        console.error(`[GitManifest] restore could not remove ${rel}:`, (e as Error).message);
                    }
                }
            }
            if (failures === 0) {
                // The manifest FILE must agree with the restored disk state,
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
            // remove everything the failed promotion wrote and flag the row.
            if (opts.incoming && failures === 0) {
                const removeList = 'introducedPaths' in opts.incoming
                    ? opts.incoming.introducedPaths
                    : this.introducedPaths(null, opts.incoming);
                for (const rel of removeList) {
                    try {
                        await removeStackPath(rel);
                    } catch (e) {
                        failures += 1;
                        console.error(`[GitManifest] restore could not remove ${rel}:`, (e as Error).message);
                    }
                }
            }
            DatabaseService.getInstance().setGitSourceManifestState(stackName, null, 'migration_required', null);
        }
        if (failures === 0) {
            await fs.promises.rm(await this.markerPath(stackName), { force: true });
        }
        StackFileRootsService.invalidate(NodeRegistry.getInstance().getDefaultNodeId(), stackName);
        return failures === 0;
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

    private async flagRecoveryRequired(stackName: string, reason: string): Promise<void> {
        DatabaseService.getInstance().setGitSourceManifestState(stackName, null, 'migration_required', null);
        await fs.promises.rm(await this.markerPath(stackName), { force: true });
        console.warn(`[GitManifest] ${reason}; flagged migration_required`);
    }

    // ─── Boot sweep ──────────────────────────────────────────────────────────

    /**
     * One stack's crash recovery and orphan sweep. Callers run this under the
     * per-stack lock. Every journaled path must match either the prior or the
     * incoming snapshot before recovery writes anything. A committed manifest
     * is finalized; an uncommitted promotion restores the prior generation.
     * A third state is treated as an operator edit, so recovery declines and
     * flags migration_required. Interrupted detach snapshots are restored first.
     */
    async sweepManagedArea(
        stackName: string,
        opts: { repoUrl: string; branch: string; stackExists: boolean },
    ): Promise<void> {
        const { repoUrl, branch, stackExists } = opts;
        if (!stackExists) {
            await this.deleteManagedArea(stackName);
            return;
        }
        await this.recoverInterruptedDetach(stackName, repoUrl, branch);
        const marker = await this.readMarker(stackName);
        if (marker) {
            if ('corrupt' in marker) {
                // A corrupt marker (crash mid-marker-write) is NOT a clean slate:
                // the stack dir may be half-written. Flag recovery-required.
                await this.flagRecoveryRequired(stackName, `promotion marker for ${sanitizeForLog(stackName)} is corrupt (${marker.corrupt})`);
                return;
            }
            const current = await this.readManifest(stackName, repoUrl, branch);

            // Once the incoming manifest is visible, promotion is committed.
            // A remaining marker only means DB cache or marker cleanup did not
            // finish, so finalize without touching live stack files.
            if (marker.phase === 'committing'
                && current !== null
                && !('corrupt' in current)
                && current.manifestVersion === marker.manifestVersion
                && current.resolvedRevision.commitSha === marker.sha
                && current.generation.appliedDir === marker.appliedRelPath) {
                DatabaseService.getInstance().setGitSourceManifestState(
                    stackName,
                    current.manifestVersion,
                    current.state,
                    current.generation.appliedDir,
                );
                StackFileRootsService.invalidate(NodeRegistry.getInstance().getDefaultNodeId(), stackName);
                await fs.promises.rm(await this.markerPath(stackName), { force: true });
                console.warn(`[GitManifest] finalized committed promotion for ${sanitizeForLog(stackName)} after a crash`);
            } else {
                const candidateAbs = path.join(this.managedRoot(stackName), marker.candidateRelPath);
                const appliedAbs = path.join(this.managedRoot(stackName), marker.appliedRelPath);
                let incomingAbs: string | null = null;
                if (await this.pathExists(path.join(candidateAbs, CANDIDATE_COMPLETE_MARKER))) {
                    incomingAbs = candidateAbs;
                } else if (await this.pathExists(path.join(appliedAbs, CANDIDATE_COMPLETE_MARKER))) {
                    incomingAbs = appliedAbs;
                }
                if (incomingAbs === null) {
                    await this.flagRecoveryRequired(stackName, `promotion snapshots for ${sanitizeForLog(stackName)} are missing`);
                    return;
                }
                if (current !== null && 'corrupt' in current) {
                    await this.flagRecoveryRequired(stackName, `promotion marker found for ${sanitizeForLog(stackName)} but the prior manifest is corrupt`);
                    return;
                }

                const prior = current;
                const priorAbs = prior ? path.join(this.managedRoot(stackName), prior.generation.appliedDir) : null;
                let mismatch: string | null = null;
                for (const rel of marker.affected) {
                    try {
                        const actual = await this.hashStackFile(stackName, rel);
                        const before = priorAbs ? await this.hashSnapshotFile(priorAbs, rel) : null;
                        const after = await this.hashSnapshotFile(incomingAbs, rel);
                        if (actual !== before && actual !== after) {
                            mismatch = `${rel} does not match either recovery snapshot`;
                            break;
                        }
                    } catch (e) {
                        mismatch = `${rel} could not be verified: ${(e as Error).message}`;
                        break;
                    }
                }
                if (mismatch !== null) {
                    await this.flagRecoveryRequired(
                        stackName,
                        `promotion marker for ${sanitizeForLog(stackName)} does not match the stack dir (${mismatch}); restore declined`,
                    );
                    return;
                }
                const restored = await this.restorePreviousGeneration(stackName, {
                    priorManifest: prior,
                    incoming: marker.introduced.length > 0 ? { introducedPaths: marker.introduced } : null,
                });
                if (restored) {
                    console.warn(`[GitManifest] restored previous applied generation for ${sanitizeForLog(stackName)} after a crash`);
                }
            }
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

    private detachStagedRoot(stackName: string): string {
        const root = this.managedRoot(stackName);
        return path.join(path.dirname(root), `.detach-${stackName}`);
    }

    /** Persist exact stack-file snapshots before detach mutates the live files. */
    async prepareDetachRecovery(
        stackName: string,
        repoUrl: string,
        branch: string,
        files: DetachRecoveryInput[],
    ): Promise<void> {
        const root = this.managedRoot(stackName);
        const managedAreaExisted = await this.pathExists(root);
        const bounds = this.boundsConfig();
        if (files.length > bounds.maxFiles) throw new Error('Detach recovery snapshot exceeds the file bound');
        if (files.some((file) => !isNonEmptyRelPath(file.path))) throw new Error('Invalid detach recovery path');
        if (new Set(files.map((file) => file.path.toLowerCase())).size !== files.length) {
            throw new Error('Detach recovery snapshot has duplicate paths');
        }
        let snapshotBytes = 0;
        for (const file of files) {
            if (!file.existed) continue;
            if (file.content.length > bounds.maxFileBytes) throw new Error(`Detach recovery file exceeds the size bound: ${file.path}`);
            snapshotBytes += file.content.length;
            if (snapshotBytes > bounds.maxBytes) throw new Error('Detach recovery snapshot exceeds the byte bound');
        }
        const marker: DetachRecoveryMarker = {
            schemaVersion: 1,
            identity: { stackName, repoUrl, branch },
            managedAreaExisted,
            files: files.map((file): DetachRecoveryFile => file.existed
                ? { path: file.path, existed: true, contentBase64: file.content.toString('base64') }
                : { path: file.path, existed: false, contentBase64: null }),
        };
        await fs.promises.mkdir(root, { recursive: true });
        const target = path.join(root, DETACH_RECOVERY_MARKER);
        const tmp = `${target}.tmp`;
        await fs.promises.writeFile(tmp, JSON.stringify(marker), 'utf8');
        await fs.promises.rename(tmp, target);
    }

    /** Restore a detach snapshot and remove its marker after every file succeeds. */
    private async restoreDetachRecoveryFromRoot(stackName: string, repoUrl: string, branch: string, root: string): Promise<boolean> {
        const markerPath = path.join(root, DETACH_RECOVERY_MARKER);
        let raw: string;
        try {
            raw = await fs.promises.readFile(markerPath, 'utf8');
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
            throw e;
        }
        const rawMarker: unknown = JSON.parse(raw);
        if (!rawMarker || typeof rawMarker !== 'object' || Array.isArray(rawMarker)) throw new Error('Detach recovery marker is invalid');
        const marker = rawMarker as Record<string, unknown>;
        const identity = marker.identity as Record<string, unknown> | undefined;
        const bounds = this.boundsConfig();
        if (marker.schemaVersion !== 1
            || !identity
            || identity.stackName !== stackName
            || identity.repoUrl !== repoUrl
            || identity.branch !== branch
            || typeof marker.managedAreaExisted !== 'boolean'
            || !Array.isArray(marker.files)
            || marker.files.length > bounds.maxFiles) {
            throw new Error('Detach recovery marker is invalid');
        }
        let snapshotBytes = 0;
        for (const file of marker.files as unknown[]) {
            if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error('Detach recovery file entry is invalid');
            const entry = file as Record<string, unknown>;
            if (!isNonEmptyRelPath(entry.path) || typeof entry.existed !== 'boolean') throw new Error('Detach recovery file entry is invalid');
            if (entry.existed && typeof entry.contentBase64 !== 'string') throw new Error('Detach recovery content is missing');
            if (!entry.existed && entry.contentBase64 !== null) throw new Error('Detach recovery absent file has content');
            if (typeof entry.contentBase64 === 'string') {
                const maxEncodedLength = Math.ceil(bounds.maxFileBytes / 3) * 4;
                if (entry.contentBase64.length > maxEncodedLength
                    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.contentBase64)) {
                    throw new Error('Detach recovery content is invalid');
                }
                const contentBytes = Buffer.byteLength(entry.contentBase64, 'base64');
                if (contentBytes > bounds.maxFileBytes) throw new Error('Detach recovery content exceeds the file-size bound');
                snapshotBytes += contentBytes;
                if (snapshotBytes > bounds.maxBytes) throw new Error('Detach recovery content exceeds the byte bound');
            }
        }
        const parsed = marker as unknown as DetachRecoveryMarker;
        if (new Set(parsed.files.map((file) => file.path.toLowerCase())).size !== parsed.files.length) {
            throw new Error('Detach recovery marker has duplicate paths');
        }

        const fsSvc = FileSystemService.getInstance();
        for (const file of parsed.files) {
            if (file.existed) {
                const content = Buffer.from(file.contentBase64, 'base64');
                if (file.path === 'compose.yaml') {
                    await fsSvc.saveStackContent(stackName, content);
                } else {
                    await fsSvc.writeStackFile(stackName, file.path, content);
                }
            } else {
                try {
                    await fsSvc.deleteStackPath(stackName, file.path, false, { protectedEnabled: false });
                } catch (e) {
                    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
                }
            }
        }
        await fs.promises.rm(markerPath, { force: true });
        if (!parsed.managedAreaExisted) {
            await fs.promises.rm(root, { recursive: true, force: true });
        }
        return true;
    }

    /** Recover an interrupted detach while its Git source row still exists. */
    async recoverInterruptedDetach(stackName: string, repoUrl: string, branch: string): Promise<boolean> {
        const root = this.managedRoot(stackName);
        const staged = this.detachStagedRoot(stackName);
        const stagedExists = await this.pathExists(staged);
        if (stagedExists) {
            const rootExists = await this.pathExists(root);
            if (rootExists) throw new Error('Detach recovery has both live and staged managed areas');
            await fs.promises.rename(staged, root);
            try {
                return await this.restoreDetachRecoveryFromRoot(stackName, repoUrl, branch, root);
            } catch (e) {
                try {
                    const restoredRootExists = await this.pathExists(root);
                    if (restoredRootExists) await fs.promises.rename(root, staged);
                } catch (cleanupError) {
                    const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
                    console.error('[GitManifest] detach recovery restaging failed:', sanitizeForLog(cleanupMessage));
                }
                throw e;
            }
        }
        return this.restoreDetachRecoveryFromRoot(stackName, repoUrl, branch, root);
    }

    /** Move the managed area aside until the Git source row deletion commits. */
    async stageManagedAreaForDetach(stackName: string): Promise<boolean> {
        const root = this.managedRoot(stackName);
        const staged = this.detachStagedRoot(stackName);
        await fs.promises.rm(staged, { recursive: true, force: true });
        try {
            await fs.promises.rename(root, staged);
            return true;
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
            throw e;
        }
    }

    /** Put a staged managed area back, then restore its durable file snapshot. */
    async rollbackStagedDetach(stackName: string, repoUrl: string, branch: string): Promise<boolean> {
        const root = this.managedRoot(stackName);
        const staged = this.detachStagedRoot(stackName);
        await fs.promises.rename(staged, root);
        return this.restoreDetachRecoveryFromRoot(stackName, repoUrl, branch, root);
    }

    /** Delete a staged managed area after the database row is gone. */
    async finalizeStagedDetach(stackName: string): Promise<boolean> {
        try {
            await fs.promises.rm(this.detachStagedRoot(stackName), { recursive: true, force: true });
            return true;
        } catch (e) {
            console.warn('[GitManifest] staged detach cleanup failed:', sanitizeForLog(stackName), (e as Error).message);
            return false;
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
            console.warn('[GitManifest] could not delete managed area:', sanitizeForLog(stackName), (e as Error).message);
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
