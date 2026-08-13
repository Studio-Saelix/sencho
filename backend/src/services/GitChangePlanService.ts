/**
 * Classified compare of prior-manifest managed paths, the candidate Git
 * inventory, and live disk. Pure policy: it never writes the stack directory.
 * Promotion stays in GitProjectManifestService.
 */
import { createHash } from 'crypto';
import { FileSystemService } from './FileSystemService';
import { GitProjectManifestService } from './GitProjectManifestService';
import { collectManifestFilePaths } from '../helpers/manifestFilePaths';
import { sha256Hex } from '../utils/hashing';
import type {
    BuildContextPlan,
    ComposeInputEntry,
    DeletionAuthority,
    GitProjectManifest,
    InputOwnership,
    InputRole,
    InputSensitivity,
    ManifestProvenance,
} from '../types/gitProjectManifest';
import {
    BLOCKING_CHANGE_PLAN_OPS,
    GIT_CHANGE_PLAN_SCHEMA_VERSION,
    type GitChangePlan,
    type GitChangePlanCounts,
    type GitChangePlanMode,
    type GitChangePlanOp,
    type GitChangePlanOperation,
    type PublicGitChangePlan,
    type PublicGitChangePlanOperation,
    type PublicPendingPlan,
} from '../types/gitChangePlan';

const INVOCATION_PATH_KEY = '__invocation__';

interface PathMeta {
    hash: string | null;
    role: InputRole | 'build-context-file';
    deletionAuthority: DeletionAuthority | null;
    sensitivity: InputSensitivity;
    ownership?: InputOwnership;
    provenance?: ManifestProvenance;
    reason?: string | null;
}

export interface BuildGitChangePlanInput {
    stackName: string;
    commitSha: string;
    mode: GitChangePlanMode;
    priorManifest: GitProjectManifest | null;
    candidateInputs: ComposeInputEntry[];
    candidateBuildContexts: BuildContextPlan[];
    candidateInvocation: string[];
    liveInvocation: string[];
    /** Pre-manifest stacks: compose files + synced .env that Sencho already wrote. */
    legacyOwnedPaths?: string[];
    /** Live hashes captured when the pending plan was reviewed. A later mismatch is local-modified. */
    reviewedLiveHashes?: ReadonlyMap<string, string | null>;
    /** Stack-root project env files configured for deploy (live disk, not Git inventory). */
    projectEnvFiles?: string[];
}

export class GitChangePlanService {
    private static instance: GitChangePlanService;

    static getInstance(): GitChangePlanService {
        if (!GitChangePlanService.instance) {
            GitChangePlanService.instance = new GitChangePlanService();
        }
        return GitChangePlanService.instance;
    }

    async build(input: BuildGitChangePlanInput): Promise<GitChangePlan> {
        const priorIndex = input.priorManifest
            ? this.indexPaths(input.priorManifest.inputs, input.priorManifest.buildContexts)
            : new Map<string, PathMeta>();
        const candidateIndex = this.indexPaths(input.candidateInputs, input.candidateBuildContexts);
        const priorPaths = input.priorManifest
            ? collectManifestFilePaths(input.priorManifest)
            : [];
        const candidatePaths = collectManifestFilePaths({
            inputs: input.candidateInputs,
            buildContexts: input.candidateBuildContexts,
        });
        const contextExtras = await this.collectContextUniverseExtras({
            stackName: input.stackName,
            candidateInputs: input.candidateInputs,
            candidateBuildContexts: input.candidateBuildContexts,
            manifestSvc: GitProjectManifestService.getInstance(),
        });
        const projectEnvFiles = input.projectEnvFiles ?? [];
        const universe = this.mergePaths(
            this.mergePaths(priorPaths, candidatePaths),
            this.mergePaths(contextExtras, projectEnvFiles),
        );
        const contextExtraSet = new Set(contextExtras.map((p) => p.toLowerCase()));
        const projectEnvSet = new Set(projectEnvFiles.map((p) => p.toLowerCase()));
        const legacyOwned = new Set(input.legacyOwnedPaths ?? []);
        const fsSvc = FileSystemService.getInstance();
        const manifestSvc = GitProjectManifestService.getInstance();

        const classified: GitChangePlanOperation[] = [];
        for (const pathKey of universe) {
            const pathFold = pathKey.toLowerCase();
            const prior = priorIndex.get(pathFold);
            const candidate = candidateIndex.get(pathFold);
            classified.push(await this.classifyPath({
                stackName: input.stackName,
                pathKey,
                prior,
                candidate,
                mode: input.mode,
                legacyOwned,
                reviewedLiveHash: input.reviewedLiveHashes?.get(pathFold),
                hasReviewedLive: input.reviewedLiveHashes?.has(pathFold) === true,
                isContextExtra: contextExtraSet.has(pathFold)
                    && prior === undefined
                    && candidate === undefined,
                isProjectEnv: projectEnvSet.has(pathFold),
                sourceRevision: input.commitSha,
                fsSvc,
                manifestSvc,
            }));
        }

        const operations = this.pairRenames(classified);
        const invocationOp = this.classifyInvocation(
            input.priorManifest,
            input.candidateInvocation,
            input.liveInvocation,
        );
        if (invocationOp) operations.push(invocationOp);

        const counts = this.countOps(operations);
        const invocationBlocked = input.priorManifest !== null
            && this.invocationsDiffer(input.liveInvocation, input.priorManifest.project.invocation);
        const blocked = operations.some((op) => BLOCKING_CHANGE_PLAN_OPS.has(op.op)) || invocationBlocked;
        const fingerprint = this.fingerprint({
            commitSha: input.commitSha,
            priorManifestVersion: input.priorManifest?.manifestVersion ?? null,
            priorAppliedDir: input.priorManifest?.generation.appliedDir ?? null,
            operations,
        });

        return {
            schemaVersion: GIT_CHANGE_PLAN_SCHEMA_VERSION,
            fingerprint,
            blocked,
            invocationBlocked,
            candidateInvocation: input.candidateInvocation,
            liveInvocation: input.liveInvocation,
            priorInvocation: input.priorManifest?.project.invocation ?? [],
            operations,
            counts,
        };
    }

    toPublic(plan: GitChangePlan): PublicGitChangePlan {
        return {
            blocked: plan.blocked,
            counts: plan.counts,
            operations: plan.operations
                .filter((op) => op.op !== 'unchanged')
                .map((op) => this.toPublicOp(op)),
            invocation: {
                candidateChanged: this.invocationsDiffer(plan.candidateInvocation, plan.priorInvocation),
                liveDiverged: plan.invocationBlocked,
            },
        };
    }

    toPendingSummary(plan: GitChangePlan): PublicPendingPlan {
        const publicPlan = this.toPublic(plan);
        return {
            fingerprint: plan.fingerprint,
            blocked: publicPlan.blocked,
            counts: publicPlan.counts,
            operations: publicPlan.operations,
        };
    }

    private toPublicOp(op: GitChangePlanOperation): PublicGitChangePlanOperation {
        const redact = op.sensitivity === 'high';
        const publicOp: PublicGitChangePlanOperation = {
            path: redact || op.op === 'invocation' ? null : op.pathKey,
            op: op.op,
            role: op.role,
        };
        if (op.fromPath !== undefined) {
            publicOp.fromPath = redact ? null : op.fromPath;
        }
        return publicOp;
    }

    private fingerprint(input: {
        commitSha: string;
        priorManifestVersion: number | null;
        priorAppliedDir: string | null;
        operations: GitChangePlanOperation[];
    }): string {
        const ops = [...input.operations]
            .sort((a, b) => a.pathKey.localeCompare(b.pathKey))
            .map((op) => ({
                pathKey: op.pathKey,
                op: op.op,
                priorHash: op.priorHash,
                candidateHash: op.candidateHash,
                liveHash: op.liveHash,
                role: op.role,
                deletionAuthority: op.deletionAuthority,
            }));
        const canonical = {
            schemaVersion: GIT_CHANGE_PLAN_SCHEMA_VERSION,
            commitSha: input.commitSha,
            priorManifestVersion: input.priorManifestVersion,
            priorAppliedDir: input.priorAppliedDir,
            operations: ops,
        };
        return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
    }

    private indexPaths(inputs: ComposeInputEntry[], buildContexts: BuildContextPlan[]): Map<string, PathMeta> {
        const index = new Map<string, PathMeta>();
        const contextSensitivity = new Map<string, InputSensitivity>();
        for (const entry of inputs) {
            if (entry.materializedPath === null) continue;
            if (entry.dependencyKind === 'build-context' || entry.dependencyKind === 'build-additional-context') {
                contextSensitivity.set(entry.materializedPath.toLowerCase(), entry.sensitivity);
            }
            if (entry.ownership !== 'managed' || entry.state !== 'present' || entry.materializedPath === null) continue;
            if (entry.dependencyKind === 'build-context' || entry.dependencyKind === 'build-additional-context') continue;
            index.set(entry.materializedPath.toLowerCase(), {
                hash: entry.contentSha256,
                role: entry.role,
                deletionAuthority: entry.deletionAuthority,
                sensitivity: entry.sensitivity,
                ownership: entry.ownership,
                provenance: entry.provenance,
                reason: entry.note,
            });
        }
        for (const context of buildContexts) {
            const parentSensitivity = contextSensitivity.get(context.repoPath.toLowerCase()) ?? 'medium';
            for (const file of context.files) {
                const rel = context.repoPath ? `${context.repoPath}/${file.path}` : file.path;
                index.set(rel.toLowerCase(), {
                    hash: file.sha256,
                    role: 'build-context-file',
                    deletionAuthority: 'sencho',
                    sensitivity: parentSensitivity,
                    ownership: 'managed',
                    provenance: 'fetch',
                    reason: null,
                });
            }
        }
        return index;
    }

    private mergePaths(prior: string[], candidate: string[]): string[] {
        const byFold = new Map<string, string>();
        for (const rel of [...prior, ...candidate]) {
            const key = rel.toLowerCase();
            if (!byFold.has(key)) byFold.set(key, rel);
        }
        return [...byFold.values()].sort((a, b) => a.localeCompare(b));
    }

    private async classifyPath(args: {
        stackName: string;
        pathKey: string;
        prior: PathMeta | undefined;
        candidate: PathMeta | undefined;
        mode: GitChangePlanMode;
        legacyOwned: Set<string>;
        reviewedLiveHash?: string | null;
        hasReviewedLive: boolean;
        isContextExtra: boolean;
        isProjectEnv: boolean;
        sourceRevision: string;
        fsSvc: FileSystemService;
        manifestSvc: GitProjectManifestService;
    }): Promise<GitChangePlanOperation> {
        const { pathKey, prior, candidate, mode, legacyOwned, sourceRevision } = args;
        const role = candidate?.role ?? prior?.role ?? (args.isProjectEnv ? 'env' : 'other');
        const deletionAuthority = candidate?.deletionAuthority ?? prior?.deletionAuthority ?? null;
        const sensitivity = candidate?.sensitivity ?? prior?.sensitivity ?? (args.isProjectEnv ? 'high' : 'medium');
        const ownership = candidate?.ownership ?? prior?.ownership ?? (args.isProjectEnv ? 'unmanaged' : undefined);
        const provenance = candidate?.provenance ?? prior?.provenance ?? (args.isProjectEnv ? 'adopted' : undefined);
        const reason = candidate?.reason ?? prior?.reason ?? null;
        const metaBase = { ownership, provenance, sourceRevision, reason };
        const priorHash = prior?.hash ?? null;
        const candidateHash = candidate?.hash ?? null;
        const liveKind = await args.fsSvc.observeStackPath(args.stackName, pathKey);
        let liveHash: string | null = null;
        if (liveKind === 'file') {
            try {
                liveHash = await args.manifestSvc.hashStackFile(args.stackName, pathKey);
            } catch (err) {
                const kindAfter = await args.fsSvc.observeStackPath(args.stackName, pathKey);
                if (kindAfter === 'symlink' || kindAfter === 'directory' || kindAfter === 'special') {
                    return this.op(pathKey, 'type-changed', role, deletionAuthority, priorHash, candidateHash, null, sensitivity, metaBase);
                }
                throw err;
            }
        }

        const priorPresent = prior !== undefined && priorHash !== null;
        const candidatePresent = candidate !== undefined && candidateHash !== null;

        if (liveKind === 'symlink' || liveKind === 'directory' || liveKind === 'special') {
            return this.op(pathKey, 'type-changed', role, deletionAuthority, priorHash, candidateHash, null, sensitivity, metaBase);
        }

        if (args.hasReviewedLive && args.reviewedLiveHash !== liveHash) {
            return this.op(pathKey, 'local-modified', role, deletionAuthority, priorHash, candidateHash, liveHash, sensitivity, metaBase);
        }

        if (priorPresent && candidatePresent) {
            if (liveKind === null) {
                return this.op(pathKey, 'local-missing', role, deletionAuthority, priorHash, candidateHash, null, sensitivity, {
                    ...metaBase,
                    reason: reason ?? 'managed path absent on disk',
                });
            }
            if (liveHash !== priorHash) {
                return this.op(pathKey, 'local-modified', role, deletionAuthority, priorHash, candidateHash, liveHash, sensitivity, metaBase);
            }
            if (candidateHash === priorHash) {
                return this.op(pathKey, 'unchanged', role, deletionAuthority, priorHash, candidateHash, liveHash, sensitivity, metaBase);
            }
            return this.op(pathKey, 'modify', role, deletionAuthority, priorHash, candidateHash, liveHash, sensitivity, metaBase);
        }

        if (priorPresent && !candidatePresent) {
            if (liveKind === null) {
                return this.op(pathKey, 'local-missing', role, deletionAuthority, priorHash, null, null, sensitivity, {
                    ...metaBase,
                    reason: reason ?? 'managed path absent on disk',
                });
            }
            if (prior?.deletionAuthority !== 'sencho') {
                return this.op(pathKey, 'local-modified', role, deletionAuthority, priorHash, null, liveHash, sensitivity, metaBase);
            }
            if (liveKind === 'file' && liveHash !== priorHash) {
                return this.op(pathKey, 'local-modified', role, deletionAuthority, priorHash, null, liveHash, sensitivity, metaBase);
            }
            return this.op(pathKey, 'delete', role, deletionAuthority, priorHash, null, liveHash, sensitivity, metaBase);
        }

        if (!priorPresent && !candidatePresent) {
            if (args.isProjectEnv) {
                if (liveKind === null) {
                    return this.op(pathKey, 'local-missing', role, deletionAuthority, null, null, null, sensitivity, {
                        ...metaBase,
                        reason: 'configured project env file missing on disk',
                    });
                }
                return this.op(pathKey, 'unchanged', role, deletionAuthority, null, null, liveHash, sensitivity, {
                    ...metaBase,
                    reason: reason ?? 'configured project env file',
                });
            }
            if (args.isContextExtra) {
                return this.op(pathKey, 'unmanaged-collision', role, deletionAuthority, null, null, liveHash, sensitivity, {
                    ...metaBase,
                    reason: 'locally added in build context',
                });
            }
        }

        // Candidate-only path (add or collision).
        if (mode === 'create' || liveKind === null || legacyOwned.has(pathKey)) {
            return this.op(pathKey, 'add', role, deletionAuthority, null, candidateHash, liveHash, sensitivity, metaBase);
        }
        return this.op(pathKey, 'unmanaged-collision', role, deletionAuthority, null, candidateHash, liveHash, sensitivity, metaBase);
    }

    private pairRenames(ops: GitChangePlanOperation[]): GitChangePlanOperation[] {
        const deletes = ops.filter((o) => o.op === 'delete' && o.priorHash);
        const adds = ops.filter((o) => o.op === 'add' && o.candidateHash);
        const usedDeletes = new Set<string>();
        const usedAdds = new Set<string>();
        const renames: GitChangePlanOperation[] = [];

        const deletesByHash = new Map<string, GitChangePlanOperation[]>();
        for (const d of deletes) {
            const list = deletesByHash.get(d.priorHash!) ?? [];
            list.push(d);
            deletesByHash.set(d.priorHash!, list);
        }
        const addsByHash = new Map<string, GitChangePlanOperation[]>();
        for (const a of adds) {
            const list = addsByHash.get(a.candidateHash!) ?? [];
            list.push(a);
            addsByHash.set(a.candidateHash!, list);
        }

        for (const [hash, delList] of deletesByHash) {
            const addList = addsByHash.get(hash);
            if (!addList) continue;
            const leftoverDel = delList
                .filter((d) => !usedDeletes.has(d.pathKey))
                .sort((a, b) => a.pathKey.localeCompare(b.pathKey));
            const leftoverAdd = addList
                .filter((a) => !usedAdds.has(a.pathKey))
                .sort((a, b) => a.pathKey.localeCompare(b.pathKey));
            const pairs = Math.min(leftoverDel.length, leftoverAdd.length);
            for (let i = 0; i < pairs; i++) {
                const del = leftoverDel[i];
                const add = leftoverAdd[i];
                usedDeletes.add(del.pathKey);
                usedAdds.add(add.pathKey);
                renames.push({
                    pathKey: add.pathKey,
                    op: 'rename',
                    role: add.role,
                    deletionAuthority: del.deletionAuthority,
                    priorHash: del.priorHash,
                    candidateHash: add.candidateHash,
                    liveHash: add.liveHash,
                    sensitivity: add.sensitivity === 'high' || del.sensitivity === 'high' ? 'high' : add.sensitivity,
                    fromPath: del.pathKey,
                    ownership: add.ownership ?? del.ownership,
                    provenance: add.provenance ?? del.provenance,
                    sourceRevision: add.sourceRevision ?? del.sourceRevision,
                    reason: add.reason ?? del.reason ?? null,
                });
            }
        }

        const kept = ops.filter((o) =>
            !(o.op === 'delete' && usedDeletes.has(o.pathKey))
            && !(o.op === 'add' && usedAdds.has(o.pathKey)),
        );
        return [...kept, ...renames].sort((a, b) => a.pathKey.localeCompare(b.pathKey));
    }

    private classifyInvocation(
        prior: GitProjectManifest | null,
        candidateInvocation: string[],
        liveInvocation: string[],
    ): GitChangePlanOperation | null {
        if (prior === null) return null;
        const priorInv = prior.project.invocation;
        const liveDiverged = this.invocationsDiffer(liveInvocation, priorInv);
        const candidateChanged = this.invocationsDiffer(candidateInvocation, priorInv);
        if (!liveDiverged && !candidateChanged) return null;
        return {
            pathKey: INVOCATION_PATH_KEY,
            op: 'invocation',
            role: 'invocation',
            deletionAuthority: null,
            priorHash: sha256Hex(JSON.stringify(priorInv)),
            candidateHash: sha256Hex(JSON.stringify(candidateInvocation)),
            liveHash: sha256Hex(JSON.stringify(liveInvocation)),
            sensitivity: 'low',
        };
    }

    private invocationsEqual(a: string[], b: string[]): boolean {
        return JSON.stringify(a) === JSON.stringify(b);
    }

    private invocationsDiffer(a: string[], b: string[]): boolean {
        return !this.invocationsEqual(a, b);
    }

    private countOps(operations: GitChangePlanOperation[]): GitChangePlanCounts {
        const counts: GitChangePlanCounts = {
            add: 0,
            modify: 0,
            delete: 0,
            rename: 0,
            unchanged: 0,
            localModified: 0,
            localMissing: 0,
            typeChanged: 0,
            unmanagedCollision: 0,
            invocation: 0,
        };
        for (const op of operations) {
            switch (op.op) {
                case 'add': counts.add += 1; break;
                case 'modify': counts.modify += 1; break;
                case 'delete': counts.delete += 1; break;
                case 'rename': counts.rename += 1; break;
                case 'unchanged': counts.unchanged += 1; break;
                case 'local-modified': counts.localModified += 1; break;
                case 'local-missing': counts.localMissing += 1; break;
                case 'type-changed': counts.typeChanged += 1; break;
                case 'unmanaged-collision': counts.unmanagedCollision += 1; break;
                case 'invocation': counts.invocation += 1; break;
            }
        }
        return counts;
    }

    private async collectContextUniverseExtras(args: {
        stackName: string;
        candidateInputs: ComposeInputEntry[];
        candidateBuildContexts: BuildContextPlan[];
        manifestSvc: GitProjectManifestService;
    }): Promise<string[]> {
        const managedInputPaths = new Set(
            args.candidateInputs
                .filter((i) => i.ownership === 'managed' && i.state === 'present' && i.materializedPath !== null)
                .map((i) => i.materializedPath!),
        );
        const extras: string[] = [];
        for (const context of args.candidateBuildContexts) {
            const diverged = await args.manifestSvc.verifyContextOnDisk(
                args.stackName,
                context,
                managedInputPaths,
            );
            for (const entry of diverged) {
                const stackRel = this.stackPathFromContextDivergence(context.repoPath, entry);
                if (stackRel) extras.push(stackRel);
            }
        }
        return extras;
    }

    private stackPathFromContextDivergence(contextRepoPath: string, diverged: string): string | null {
        const locallyAdded = diverged.match(/^(.+) \(locally added, not in the managed context\)$/);
        if (locallyAdded) {
            return contextRepoPath ? `${contextRepoPath}/${locallyAdded[1]}` : locallyAdded[1];
        }
        const symlink = diverged.match(/^(.+) \(symbolic link\)$/);
        if (symlink) {
            return contextRepoPath ? `${contextRepoPath}/${symlink[1]}` : symlink[1];
        }
        const special = diverged.match(/^(.+) \(special file node\)$/);
        if (special) {
            return contextRepoPath ? `${contextRepoPath}/${special[1]}` : special[1];
        }
        const missing = diverged.match(/^(.+) \(missing\)$/);
        if (missing) {
            return contextRepoPath ? `${contextRepoPath}/${missing[1]}` : missing[1];
        }
        if (!diverged.includes('(')) {
            return contextRepoPath ? `${contextRepoPath}/${diverged}` : diverged;
        }
        return null;
    }

    private op(
        pathKey: string,
        op: GitChangePlanOp,
        role: GitChangePlanOperation['role'],
        deletionAuthority: DeletionAuthority | null,
        priorHash: string | null,
        candidateHash: string | null,
        liveHash: string | null,
        sensitivity: InputSensitivity,
        meta?: {
            fromPath?: string;
            ownership?: InputOwnership;
            provenance?: ManifestProvenance;
            sourceRevision?: string;
            reason?: string | null;
        },
    ): GitChangePlanOperation {
        return {
            pathKey,
            op,
            role,
            deletionAuthority,
            priorHash,
            candidateHash,
            liveHash,
            sensitivity,
            ...(meta?.fromPath !== undefined ? { fromPath: meta.fromPath } : {}),
            ...(meta?.ownership !== undefined ? { ownership: meta.ownership } : {}),
            ...(meta?.provenance !== undefined ? { provenance: meta.provenance } : {}),
            ...(meta?.sourceRevision !== undefined ? { sourceRevision: meta.sourceRevision } : {}),
            ...(meta?.reason !== undefined ? { reason: meta.reason } : {}),
        };
    }
}
