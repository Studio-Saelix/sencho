/**
 * Full-stack update recovery generations: capture, opaque rollback tags,
 * stack-local recovery override, handoff, compensation, and prune holds.
 *
 * Separate from ServiceUpdateRecoveryService (service-scoped snapshots).
 * Does not run Compose; ComposeService / orchestrator own Docker mutations.
 *
 * Recovery fidelity contract (supported):
 * - Prior images are restored via opaque hold tags (`--pull never --no-build`).
 * - Observed running replica count is restored via compose `scale`.
 * - Services that were fully stopped at capture are kept at `scale: 0`.
 * - Authored replica counts are not used when they diverge from observed state.
 */
import fs from 'fs/promises';
import path from 'path';
import {
  DatabaseService,
  type StackUpdateRecoveryGenerationRow,
} from './DatabaseService';
import DockerController from './DockerController';
import { FileSystemService } from './FileSystemService';
import { buildEffectiveServiceModel } from './effectiveServiceModel';
import {
  classifyReferenceKind,
  resolveComposeProjectContext,
  resolveComposeProjectContextForGeneration,
} from './composeProjectContext';
import {
  collectImageIds,
  collectRollbackTags,
  parseServicesJsonStrict,
  scrapeRollbackTagsLenient,
  type StackRecoveryReplicaCapture,
  type StackRecoveryServiceCapture,
} from './recoveryServicesJson';
import { getComposeCommandTimeoutMs } from './ComposeService';
import { assessGenerationEligibility } from './rollbackEligibility';
import { enforcePolicyForImageRefs, type PolicyEnforcementOptions } from './PolicyEnforcement';
import { describePolicyBlock } from '../helpers/policyGate';
import type { GitSourceAppliedSpec } from './DatabaseService';
import type { GitSourceManifestState } from '../types/gitProjectManifest';
import type {
  RollbackGenerationManifest,
  RollbackGitDbSnapshot,
  RollbackImageIdentity,
  RollbackInvocationRecord,
  RollbackOperationKind,
  RollbackRestoreTransactionMeta,
} from '../types/rollbackGeneration';
import { getBackupBaseDir, RollbackGenerationStore } from './RollbackGenerationStore';
import { getErrorMessage } from '../utils/errors';
import { sanitizeForLog } from '../utils/safeLog';
import { isValidStackName } from '../utils/validation';

export type { StackRecoveryReplicaCapture, StackRecoveryServiceCapture } from './recoveryServicesJson';
export { parseServicesJsonStrict } from './recoveryServicesJson';

const GENERATION_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const STAGING_MAX_AGE_MS = 60 * 60 * 1000;

function looksLikeGenerationUuid(value: string): boolean {
  return GENERATION_UUID_RE.test(value);
}

function isComposeOneOff(labels: Record<string, string> | undefined): boolean {
  const value = labels?.['com.docker.compose.oneoff'];
  return typeof value === 'string' && value.toLowerCase() === 'true';
}

function formatImagePlatform(inspect: {
  Os?: string;
  Architecture?: string;
  Variant?: string;
}): string | null {
  const os = typeof inspect.Os === 'string' ? inspect.Os.trim() : '';
  const arch = typeof inspect.Architecture === 'string' ? inspect.Architecture.trim() : '';
  if (!os || !arch) return null;
  const variant = typeof inspect.Variant === 'string' ? inspect.Variant.trim() : '';
  return variant ? `${os}/${arch}/${variant}` : `${os}/${arch}`;
}

/** New content-store generations always set content_path. Never infer from UUID shape. */
function expectsGenerationContent(row: StackUpdateRecoveryGenerationRow): boolean {
  return typeof row.content_path === 'string' && row.content_path.length > 0;
}

async function generationContentPresent(
  nodeId: number,
  stackName: string,
  generationId: string,
): Promise<boolean> {
  try {
    const genDir = RollbackGenerationStore.getGenerationDir(nodeId, stackName, generationId);
    await fs.access(path.join(genDir, 'generation.json'));
    return true;
  } catch {
    return false;
  }
}

async function resolveRestoreContext(row: StackUpdateRecoveryGenerationRow) {
  if (expectsGenerationContent(row)) {
    const contentKey = row.content_path!;
    if (!looksLikeGenerationUuid(contentKey)) {
      throw Object.assign(
        new Error('Recovery generation content key is missing or invalid'),
        { code: 'GENERATION_CONTENT_MISSING' },
      );
    }
    const present = await generationContentPresent(row.node_id, row.stack_name, contentKey);
    if (!present) {
      throw Object.assign(
        new Error('Recovery generation content is missing or incomplete'),
        { code: 'GENERATION_CONTENT_MISSING' },
      );
    }
    return resolveComposeProjectContextForGeneration(
      row.node_id,
      row.stack_name,
      contentKey,
    );
  }
  // Pre-migration rows: content_path null (even when backup_slot_id is a UUID).
  return resolveComposeProjectContext(row.node_id, row.stack_name);
}

async function restoreCapturedGitDatabaseState(
  stackName: string,
  manifest: RollbackGenerationManifest,
): Promise<void> {
  const db = DatabaseService.getInstance();
  const src = db.getGitSource(stackName);
  if (!src) return;

  const rawSpec = manifest.priorRecords?.appliedDeploySpec;
  if (rawSpec === null) {
    db.setGitSourceAppliedSpec(stackName, null);
  } else if (typeof rawSpec === 'string' && rawSpec.length > 0) {
    try {
      const parsed = JSON.parse(rawSpec) as GitSourceAppliedSpec;
      if (parsed && Array.isArray(parsed.files)) {
        db.setGitSourceAppliedSpec(stackName, parsed);
      }
    } catch (e) {
      throw new Error(
        `Stored applied deploy specification is corrupt: ${(e as Error).message}`,
        { cause: e },
      );
    }
  }

  if (!manifest.git) return;

  const commitSha = manifest.git.commitSha?.trim() || null;
  const contentHash =
    typeof manifest.priorRecords?.lastAppliedContentHash === 'string'
      ? manifest.priorRecords.lastAppliedContentHash
      : null;

  if (commitSha) {
    db.markGitSourceApplied(stackName, commitSha, contentHash ?? '');
  } else {
    // First-apply preimage: clear any SHA written after capture.
    db.clearGitSourceAppliedRevision(stackName);
  }

  const capturedGeneration =
    typeof manifest.priorRecords?.manifestGeneration === 'string'
      ? manifest.priorRecords.manifestGeneration
      : null;
  const manifestStateRaw = manifest.priorRecords?.manifestState;
  db.setGitSourceManifestState(
    stackName,
    manifest.git.manifestVersion ?? null,
    (typeof manifestStateRaw === 'string'
      ? manifestStateRaw
      : null) as GitSourceManifestState | null,
    capturedGeneration,
  );
}

function snapshotGitDb(src: NonNullable<ReturnType<DatabaseService['getGitSource']>>): RollbackGitDbSnapshot {
  return {
    appliedDeploySpec: src.applied_deploy_spec
      ? {
          files: [...src.applied_deploy_spec.files],
          contextDir: src.applied_deploy_spec.contextDir,
        }
      : null,
    lastAppliedCommitSha: src.last_applied_commit_sha,
    lastAppliedContentHash: src.last_applied_content_hash,
    manifestVersion: src.manifest_version,
    manifestState: src.manifest_state,
    manifestGeneration: src.manifest_generation,
  };
}

async function captureGitSidePreimage(stackName: string): Promise<RollbackRestoreTransactionMeta> {
  const priorGit = DatabaseService.getInstance().getGitSource(stackName);
  if (!priorGit) {
    return { gitDbBefore: null, managedManifestBefore: null };
  }
  const { GitProjectManifestService } = await import('./GitProjectManifestService');
  return {
    gitDbBefore: snapshotGitDb(priorGit),
    managedManifestBefore: await GitProjectManifestService.getInstance().readRawManifestText(stackName),
  };
}

async function applyRestoredGenerationGitSide(
  stackName: string,
  nodeId: number,
  contentPath: string,
  restoredManifest: RollbackGenerationManifest,
): Promise<void> {
  const genDir = RollbackGenerationStore.getGenerationDir(nodeId, stackName, contentPath);
  await RollbackGenerationStore.restoreCapturedGitManifest(stackName, genDir, restoredManifest);
  await restoreCapturedGitDatabaseState(stackName, restoredManifest);
}

const SWEEP_INTERVAL_MS = 5 * 60_000;
const INITIAL_SWEEP_DELAY_MS = 30_000;
const MIN_RECOVERY_WINDOW_SECONDS = 90;
const RECOVERY_TTL_BUFFER_MS = 30 * 60_000;
const GATE_RETAIN_DEFAULT_MS = 2 * 60 * 60_000;
const RECOVERY_PROBE_DELAY_MS = 3_000;

export interface CaptureStackUpdateInput {
  nodeId: number;
  stackName: string;
  createdBy: string | null;
  /** Capture trigger; defaults to 'update'. */
  operationKind?: RollbackOperationKind;
}

function yamlQuote(value: string): string {
  return JSON.stringify(value);
}

function sanitizeServiceSlug(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase() || 'svc';
}

/** Same short form used in the opaque rollback tag, so the UI's "Generation" label matches the Docker tag. */
export function shortGenerationId(generationId: string): string {
  return generationId.replace(/-/g, '').slice(0, 12);
}

function opaqueRollbackTag(generationId: string, serviceName: string): string {
  return `sencho-rb/${shortGenerationId(generationId)}/${sanitizeServiceSlug(serviceName)}:hold`;
}

export class StackUpdateRecoveryService {
  private static instance: StackUpdateRecoveryService;
  private started = false;
  private intervalId: NodeJS.Timeout | null = null;
  private initialTimer: NodeJS.Timeout | null = null;

  private constructor() {}

  public static getInstance(): StackUpdateRecoveryService {
    if (!StackUpdateRecoveryService.instance) {
      StackUpdateRecoveryService.instance = new StackUpdateRecoveryService();
    }
    return StackUpdateRecoveryService.instance;
  }

  public static resetForTests(): void {
    if (StackUpdateRecoveryService.instance) {
      StackUpdateRecoveryService.instance.stop();
    }
    StackUpdateRecoveryService.instance = new StackUpdateRecoveryService();
  }

  public start(): void {
    this.started = true;
    if (this.initialTimer || this.intervalId) return;
    // Startup already awaits reconcileInterruptedRestoresAtStartup before
    // HTTP/mutators. Periodic full reconcile (abandon/TTL) starts after delay.
    this.initialTimer = setTimeout(() => {
      void this.reconcileIncomplete();
      this.intervalId = setInterval(() => {
        void this.reconcileIncomplete();
      }, SWEEP_INTERVAL_MS);
    }, INITIAL_SWEEP_DELAY_MS);
  }

  /**
   * Revert any crash-interrupted generation restores (files + Git side state)
   * before background mutators or HTTP accept traffic.
   */
  public async reconcileInterruptedRestoresAtStartup(): Promise<void> {
    await this.sweepInterruptedRestores(DatabaseService.getInstance());
  }

  private async sweepInterruptedRestores(db: DatabaseService): Promise<void> {
    const failures: string[] = [];
    for (const node of db.getNodes()) {
      for (const row of db.listStackUpdateRecoveryGenerationsForNode(node.id)) {
        if (!row.content_path) continue;
        try {
          const reverted = await RollbackGenerationStore.reconcileInterruptedRestore(
            row.node_id,
            row.stack_name,
            row.content_path,
          );
          if (reverted) {
            db.updateStackUpdateRecoveryGeneration(row.id, { status: 'recovery_required' });
          }
          if (await RollbackGenerationStore.hasPendingRestoreIntent(
            row.node_id,
            row.stack_name,
            row.content_path,
          )) {
            failures.push(row.id);
          }
        } catch (e) {
          console.warn(
            '[StackUpdateRecovery] Interrupted restore reconcile failed for %s: %s',
            sanitizeForLog(row.id),
            sanitizeForLog(getErrorMessage(e, 'unknown')),
          );
          this.markGenerationRecoveryRequiredBestEffort(db, row.id);
          failures.push(row.id);
        }
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `Unresolved interrupted restore intent(s) remain for generation(s): ${failures.join(', ')}`,
      );
    }
  }

  private markGenerationRecoveryRequiredBestEffort(
    db: DatabaseService,
    generationId: string,
  ): void {
    try {
      db.updateStackUpdateRecoveryGeneration(generationId, { status: 'recovery_required' });
    } catch (updateErr) {
      console.warn(
        '[StackUpdateRecovery] Failed to mark recovery_required after reconcile error: %s',
        sanitizeForLog(getErrorMessage(updateErr, 'unknown')),
      );
    }
  }

  /**
   * Block mutations while a restore intent is still on disk for any generation
   * of this stack (mirrors deletion-intent gating).
   */
  public async assertNoBlockingRestoreIntent(nodeId: number, stackName: string): Promise<void> {
    if (!isValidStackName(stackName)) {
      throw new Error('Invalid stack name');
    }
    const db = DatabaseService.getInstance();
    for (const row of db.listStackUpdateRecoveryGenerationsForNode(nodeId)) {
      if (row.stack_name !== stackName || !row.content_path) continue;
      const pending = await RollbackGenerationStore.hasPendingRestoreIntent(
        nodeId,
        stackName,
        row.content_path,
      );
      if (!pending) continue;
      throw Object.assign(
        new Error(
          `Stack "${stackName}" has an interrupted restore in progress; resolve recovery before mutating`,
        ),
        { code: 'RESTORE_INTENT_BLOCKING' },
      );
    }
  }

  public stop(): void {
    this.started = false;
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Validate exact Compose invocation, backup files, snapshot runtime, create
   * opaque tags + recovery override, insert candidate generation.
   */
  public async captureCandidate(input: CaptureStackUpdateInput): Promise<StackUpdateRecoveryGenerationRow> {
    const { nodeId, stackName, createdBy } = input;
    const operationKind: RollbackOperationKind = input.operationKind ?? 'update';
    if (!isValidStackName(stackName)) {
      throw new Error('Invalid stack name');
    }
    await this.assertNoBlockingRestoreIntent(nodeId, stackName);

    const context = await resolveComposeProjectContext(nodeId, stackName);
    await context.validateForMutation();
    // Exact mutating invocation (authored files + env + generated Mesh override)
    // must validate before any backup, tag, or override write.
    const { ComposeService } = await import('./ComposeService');
    await ComposeService.getInstance(nodeId).validateExactComposeInvocation(stackName);

    // Content-store generation id becomes the row id, backup_slot_id, and content_path.
    const generationId = await context.backupFromContext(operationKind);

    const model = await buildEffectiveServiceModel(nodeId, stackName);
    if (!model.renderable) {
      throw new Error(model.error || 'Effective Compose model failed to render');
    }
    const docker = DockerController.getInstance(nodeId).getDocker();
    const services: StackRecoveryServiceCapture[] = [];
    const createdTags: string[] = [];
    const platformByImageId = new Map<string, string | null>();
    let overridePath: string | null = null;

    try {
      for (const spec of model.services) {
        const declaredImageRef = spec.declaredImage;
        const referenceKind = classifyReferenceKind(declaredImageRef);
        const listed = await docker.listContainers({
          all: true,
          filters: {
            label: [
              `com.docker.compose.project=${stackName}`,
              `com.docker.compose.service=${spec.name}`,
            ],
          },
        });

        const replicas: StackRecoveryReplicaCapture[] = [];
        for (const info of listed) {
          const labels = (info.Labels ?? {}) as Record<string, string>;
          if (isComposeOneOff(labels)) continue;
          try {
            const inspect = await docker.getContainer(info.Id).inspect();
            const status = inspect.State?.Status;
            const state: StackRecoveryReplicaCapture['state'] =
              status === 'running' ? 'running' : status ? 'stopped' : 'none';
            const imageId = typeof inspect.Image === 'string' && inspect.Image.length > 0
              ? inspect.Image
              : null;
            if ((state === 'running' || state === 'stopped') && !imageId) {
              throw new Error(
                `Service "${spec.name}" replica ${info.Id.slice(0, 12)} has no protectable image id`,
              );
            }
            let repoDigest: string | null = null;
            if (imageId) {
              try {
                const image = await docker.getImage(imageId).inspect();
                const digests = (image.RepoDigests ?? []) as string[];
                repoDigest = digests.length > 0 ? digests[0] : null;
                if (!platformByImageId.has(imageId)) {
                  platformByImageId.set(imageId, formatImagePlatform(image));
                }
              } catch {
                repoDigest = null;
              }
            }
            replicas.push({
              containerId: info.Id,
              imageId,
              repoDigest,
              state,
              rollbackTag: null,
            });
          } catch (error) {
            if ((error as { statusCode?: number })?.statusCode === 404) continue;
            throw error;
          }
        }

        const runningCount = replicas.filter((r) => r.state === 'running').length;
        services.push({
          serviceName: spec.name,
          scale: runningCount,
          hasBuild: spec.hasBuild,
          declaredImageRef,
          referenceKind,
          replicas,
        });
      }

      for (const svc of services) {
        const imageIds = new Set<string>();
        for (const replica of svc.replicas) {
          if ((replica.state === 'running' || replica.state === 'stopped') && replica.imageId?.trim()) {
            imageIds.add(replica.imageId);
          }
        }
        if (imageIds.size > 1) {
          throw Object.assign(
            new Error(
              `Service "${svc.serviceName}" has mixed replica images; refusing recovery capture that cannot restore exact prior identity`,
            ),
            { code: 'MIXED_REPLICA_IMAGES' },
          );
        }
      }

      const images: RollbackImageIdentity[] = services.map((svc) => {
        const primary = svc.replicas.find((r) => r.imageId) ?? null;
        const imageId = primary?.imageId ?? null;
        return {
          serviceName: svc.serviceName,
          imageId,
          repoDigest: primary?.repoDigest ?? null,
          platform: imageId ? (platformByImageId.get(imageId) ?? null) : null,
          declaredImageRef: svc.declaredImageRef,
        };
      });
      await RollbackGenerationStore.attachImages(nodeId, stackName, generationId, images);

      const taggedIds = new Set<string>();
      for (const svc of services) {
        const primary = svc.replicas.find((r) => r.imageId) ?? null;
        if (!primary?.imageId) continue;

        const tag = opaqueRollbackTag(generationId, svc.serviceName);
        const tagKey = `${primary.imageId}|${tag}`;
        if (!taggedIds.has(tagKey)) {
          const { repo, tagName } = splitOpaqueTag(tag);
          await docker.getImage(primary.imageId).tag({ repo, tag: tagName });
          taggedIds.add(tagKey);
          createdTags.push(tag);
        }
        for (const replica of svc.replicas) {
          if (replica.imageId === primary.imageId) {
            replica.rollbackTag = tag;
          }
        }
      }

      overridePath = await this.writeRecoveryOverride(nodeId, stackName, generationId, services);

      const now = Date.now();
      const row: StackUpdateRecoveryGenerationRow = {
        id: generationId,
        node_id: nodeId,
        stack_name: stackName,
        status: 'candidate',
        phase: 'captured',
        is_current: 0,
        backup_slot_id: generationId,
        content_path: generationId,
        operation_kind: operationKind,
        override_path: overridePath,
        services_json: JSON.stringify(services),
        health_gate_id: null,
        gate_retain_until: null,
        artifact_expires_at: null,
        operation_lease_expires_at: now + getComposeCommandTimeoutMs() + RECOVERY_TTL_BUFFER_MS,
        created_at: now,
        updated_at: now,
        created_by: createdBy,
        artifacts_retired: 0,
        released_at: null,
        released_by: null,
      };
      DatabaseService.getInstance().insertStackUpdateRecoveryGeneration(row);
      return row;
    } catch (error) {
      await this.bestEffortRemoveTags(nodeId, createdTags);
      if (overridePath) {
        try {
          await fs.unlink(overridePath);
        } catch {
          // Best-effort mid-capture cleanup.
        }
      }
      try {
        await RollbackGenerationStore.retireGenerationContent(nodeId, stackName, generationId);
      } catch (retireError) {
        console.warn(
          '[StackUpdateRecovery] Failed to retire staged generation content after capture error: %s',
          sanitizeForLog(getErrorMessage(retireError, 'unknown')),
        );
      }
      throw error;
    }
  }

  /**
   * Capture the live authored project as the current recovery generation.
   * Shares captureCandidate with deploy/update (files, holds, override), then
   * hands off immediately without compose or a runtime probe.
   */
  public async captureCurrentBackup(input: Omit<CaptureStackUpdateInput, 'operationKind'>): Promise<StackUpdateRecoveryGenerationRow> {
    const current = this.getCurrent(input.nodeId, input.stackName);
    if (current?.health_gate_id) {
      const gate = DatabaseService.getInstance().getHealthGateRun(
        current.node_id,
        current.stack_name,
        current.health_gate_id,
      );
      if (gate?.status === 'observing') {
        throw Object.assign(
          new Error('Cannot replace the current recovery generation while a health gate is observing'),
          { code: 'HEALTH_GATE_OBSERVING' },
        );
      }
    }

    const row = await this.captureCandidate({
      ...input,
      operationKind: 'manual_backup',
    });
    try {
      if (!this.markAcquired(row.id)) {
        throw new Error('Could not acquire the backup generation');
      }
      if (!this.handoff(row.id, row.node_id, row.stack_name)) {
        throw new Error('Could not hand off the backup generation');
      }
    } catch (error) {
      try {
        await this.abandon(row.id);
      } catch (abandonErr) {
        console.warn(
          '[StackUpdateRecovery] Failed to abandon backup generation after handoff error: %s',
          sanitizeForLog(getErrorMessage(abandonErr, 'unknown')),
        );
      }
      throw error;
    }

    if (!this.markReconciling(row.id)) {
      console.warn(
        '[StackUpdateRecovery] Backup generation handed off but reconciling CAS failed for %s',
        sanitizeForLog(row.id),
      );
    } else if (!this.markImmediateVerified(row.id)) {
      console.warn(
        '[StackUpdateRecovery] Backup generation handed off but immediate_verified CAS failed for %s',
        sanitizeForLog(row.id),
      );
    }
    const verified = this.get(row.id);
    if (!verified) {
      throw new Error('Backup generation missing after handoff');
    }
    return verified;
  }

  private async writeRecoveryOverride(
    nodeId: number,
    stackName: string,
    generationId: string,
    services: StackRecoveryServiceCapture[],
  ): Promise<string> {
    if (!isValidStackName(stackName)) {
      throw new Error('Invalid stack name');
    }
    // Canonical inline path barrier (same pattern as ComposeService.renderConfig).
    const baseResolved = path.resolve(FileSystemService.getInstance(nodeId).getBaseDir());
    const stackDir = path.resolve(baseResolved, stackName);
    if (!stackDir.startsWith(baseResolved + path.sep)) {
      throw new Error('Invalid stack path');
    }
    let stackDirReal: string;
    let baseReal: string;
    try {
      [stackDirReal, baseReal] = await Promise.all([
        fs.realpath(stackDir),
        fs.realpath(baseResolved),
      ]);
    } catch {
      throw new Error('Stack directory not found');
    }
    if (stackDirReal !== baseReal && !stackDirReal.startsWith(baseReal + path.sep)) {
      throw new Error('Stack directory escapes compose base');
    }

    const short = shortGenerationId(generationId);
    if (!/^[a-f0-9]{12}$/i.test(short)) {
      throw new Error('Invalid recovery generation id');
    }
    const filename = `.sencho-recovery-${short}.yml`;
    const abs = path.resolve(stackDirReal, filename);
    if (!abs.startsWith(stackDirReal + path.sep)) {
      throw new Error('Recovery override path escapes stack directory');
    }

    const lines: string[] = ['services:'];
    let wroteAny = false;
    for (const svc of services) {
      const tag = svc.replicas.find((r) => r.rollbackTag)?.rollbackTag ?? null;
      const stoppedOnly =
        svc.replicas.length > 0
        && svc.replicas.every((r) => r.state === 'stopped' || r.state === 'none');
      if (!tag && svc.scale !== 0 && !stoppedOnly) continue;
      const key = /^[a-zA-Z0-9._-]+$/.test(svc.serviceName) ? svc.serviceName : yamlQuote(svc.serviceName);
      lines.push(`  ${key}:`);
      if (tag) {
        lines.push(`    image: ${yamlQuote(tag)}`);
      }
      // Observed running count; fully stopped services stay at scale 0.
      if (svc.scale === 0 || stoppedOnly) {
        lines.push('    scale: 0');
      } else if (svc.scale > 0) {
        lines.push(`    scale: ${svc.scale}`);
      }
      wroteAny = true;
    }
    const body = wroteAny ? `${lines.join('\n')}\n` : 'services: {}\n';
    await fs.writeFile(abs, body, 'utf8');
    return abs;
  }

  public markAcquired(id: string): boolean {
    return DatabaseService.getInstance().casStackUpdateRecoveryPhase(id, 'captured', 'acquired');
  }

  public handoff(candidateId: string, nodeId: number, stackName: string): boolean {
    return DatabaseService.getInstance().casHandoffGeneration(candidateId, nodeId, stackName);
  }

  public markReconciling(id: string): boolean {
    return DatabaseService.getInstance().casStackUpdateRecoveryPhase(id, 'handoff_committed', 'reconciling');
  }

  public markImmediateVerified(id: string): boolean {
    const ok = DatabaseService.getInstance().casStackUpdateRecoveryPhase(id, 'reconciling', 'immediate_verified');
    if (ok) {
      DatabaseService.getInstance().updateStackUpdateRecoveryGeneration(id, {
        artifact_expires_at: Date.now() + this.activeRecoveryTtlMs() + RECOVERY_TTL_BUFFER_MS,
        operation_lease_expires_at: null,
      });
    }
    return ok;
  }

  /** Mark candidate abandoned in DB and retire Docker/FS artifacts. */
  public async abandon(id: string): Promise<boolean> {
    const row = this.get(id);
    const ok = DatabaseService.getInstance().abandonStackUpdateRecoveryGeneration(id);
    if (ok && row) {
      await this.retireGenerationArtifacts({ ...row, status: 'abandoned', artifacts_retired: 0 });
    }
    return ok;
  }

  /**
   * Informational mirror of releaseStackUpdateRecoveryGeneration's WHERE
   * clause, for the list endpoint to grey out a row it already knows is
   * ineligible. Not authoritative: releaseGeneration revalidates for real.
   */
  public isReleaseEligible(row: StackUpdateRecoveryGenerationRow): boolean {
    if (row.released_at !== null || row.artifacts_retired !== 0) return false;
    if (row.phase !== 'immediate_verified') return false;
    if (!['active', 'restored_current', 'superseded'].includes(row.status)) return false;
    if (row.health_gate_id) {
      const gate = DatabaseService.getInstance().getHealthGateRun(row.node_id, row.stack_name, row.health_gate_id);
      if (gate?.status === 'observing') return false;
    }
    return true;
  }

  /**
   * Operator-initiated release of rollback protection, current generation
   * included. The DB transition (releaseStackUpdateRecoveryGeneration)
   * atomically revalidates eligibility and clears is_current, which is what
   * stops getCurrent()/isRestoredCurrentPinActive() from reporting a released
   * row as the live rollback point. Docker tag + override cleanup reuses the
   * same idempotent retireGenerationArtifacts() that abandon() already relies
   * on, so a mid-cleanup Docker failure leaves artifacts_retired at 0 and is
   * retried by the next reconcileIncomplete() sweep rather than silently
   * "succeeding" in the UI.
   */
  public async releaseGeneration(
    id: string,
    releasedBy: string | null,
  ): Promise<
    | { ok: true; row: StackUpdateRecoveryGenerationRow; artifactsCleaned: boolean }
    | { ok: false; reason: 'not_found' | 'already_released' | 'not_eligible' }
  > {
    const before = this.get(id);
    if (!before) return { ok: false, reason: 'not_found' };
    if (before.released_at !== null) return { ok: false, reason: 'already_released' };

    const released = DatabaseService.getInstance().releaseStackUpdateRecoveryGeneration(id, releasedBy);
    if (!released) return { ok: false, reason: 'not_eligible' };

    const row = this.get(id);
    if (!row) return { ok: false, reason: 'not_found' };
    const artifactsCleaned = await this.retireGenerationArtifacts(row);

    const wasCurrent = before.is_current === 1;
    try {
      DatabaseService.getInstance().addNotificationHistory(row.node_id, {
        level: wasCurrent ? 'warning' : 'info',
        category: 'rollback_generation_released',
        message: wasCurrent
          ? `${row.stack_name}: current rollback protection released. Automatic rollback is unavailable until the next successful full-stack update.`
          : `${row.stack_name}: rollback protection released for generation ${shortGenerationId(row.id)}.`,
        timestamp: Date.now(),
        stack_name: row.stack_name,
        actor_username: releasedBy,
      });
    } catch (error) {
      console.warn(
        '[StackUpdateRecovery] Failed to record release activity for %s:',
        sanitizeForLog(id),
        sanitizeForLog(getErrorMessage(error, 'unknown')),
      );
    }

    return { ok: true, row, artifactsCleaned };
  }

  public linkHealthGate(id: string, healthGateId: string): void {
    DatabaseService.getInstance().linkStackUpdateRecoveryHealthGate(id, healthGateId);
  }

  public setGateRetainUntil(id: string, until: number = Date.now() + GATE_RETAIN_DEFAULT_MS): void {
    DatabaseService.getInstance().setStackUpdateRecoveryGateRetainUntil(id, until);
  }

  /** Link a health gate when present; otherwise set bounded gate_retain_until. */
  public linkGateOrRetain(id: string, healthGateId: string | null): void {
    try {
      if (healthGateId) {
        this.linkHealthGate(id, healthGateId);
      } else {
        this.setGateRetainUntil(id);
      }
    } catch (error) {
      console.warn(
        '[StackUpdateRecovery] linkGateOrRetain failed for %s; setting retain window:',
        sanitizeForLog(id),
        sanitizeForLog(getErrorMessage(error, 'unknown')),
      );
      try {
        this.setGateRetainUntil(id);
      } catch (retainError) {
        console.warn(
          '[StackUpdateRecovery] setGateRetainUntil failed for %s:',
          sanitizeForLog(id),
          sanitizeForLog(getErrorMessage(retainError, 'unknown')),
        );
      }
    }
  }

  public get(id: string): StackUpdateRecoveryGenerationRow | undefined {
    return DatabaseService.getInstance().getStackUpdateRecoveryGeneration(id);
  }

  public getCurrent(nodeId: number, stackName: string): StackUpdateRecoveryGenerationRow | undefined {
    return DatabaseService.getInstance().getCurrentStackUpdateRecovery(nodeId, stackName);
  }

  public isRestoredCurrentPinActive(nodeId: number, stackName: string): boolean {
    const current = this.getCurrent(nodeId, stackName);
    return !!current && current.status === 'restored_current';
  }

  public getHeldImageIds(nodeId: number): Set<string> | null {
    try {
      const now = Date.now();
      const fromStack = DatabaseService.getInstance().listHeldStackUpdateRecoveryImageIds(nodeId, now);
      return new Set(fromStack);
    } catch (error) {
      console.warn(
        '[StackUpdateRecovery] Failed to compute held image ids for node %d:',
        nodeId,
        sanitizeForLog(getErrorMessage(error, 'unknown')),
      );
      return null;
    }
  }

  /**
   * Post-handoff compensation: restore files + pinned up, then probe before
   * reporting restored_current / immediate_verified.
   */
  public async compensateWithCandidate(
    generationId: string,
    composeUp: (
      overridePath: string,
      invocation: RollbackInvocationRecord | null,
    ) => Promise<void>,
    policyOptions?: PolicyEnforcementOptions,
  ): Promise<boolean> {
    const row = this.get(generationId);
    if (!row) return false;
    // Finish any leftover restore transaction for this generation before a new
    // restore can overwrite pre-restore/ with an already-restored tree.
    if (row.content_path) {
      try {
        const reverted = await RollbackGenerationStore.reconcileInterruptedRestore(
          row.node_id,
          row.stack_name,
          row.content_path,
        );
        if (reverted) {
          DatabaseService.getInstance().updateStackUpdateRecoveryGeneration(generationId, {
            status: 'recovery_required',
          });
        }
      } catch (e) {
        console.warn(
          '[StackUpdateRecovery] Pre-compensate reconcile failed for %s: %s',
          sanitizeForLog(generationId),
          sanitizeForLog(getErrorMessage(e, 'unknown')),
        );
      }
    }
    await this.assertNoBlockingRestoreIntent(row.node_id, row.stack_name);

    const db = DatabaseService.getInstance();
    const transactionMeta = await captureGitSidePreimage(row.stack_name);
    const generationContentPath =
      expectsGenerationContent(row) && row.content_path ? row.content_path : null;

    let filesRestored = false;
    try {
      // Eligibility (integrity + held images + security posture) before mutation.
      const integrityVerdict = await assessGenerationEligibility(row);
      if (integrityVerdict === 'prohibited') {
        throw Object.assign(
          new Error('Rollback is prohibited for this generation'),
          { code: 'ROLLBACK_PROHIBITED' },
        );
      }

      // Validate recovery image state before mutating the live project.
      const servicesParsed = parseServicesJsonStrict(row.services_json);
      if (!servicesParsed.ok) {
        throw Object.assign(
          new Error('Recovery generation has malformed services state; refusing rollback'),
          { code: 'ROLLBACK_PROHIBITED' },
        );
      }
      const rollbackTags = collectRollbackTags(servicesParsed.services);
      const heldRefs = rollbackTags.length > 0
        ? rollbackTags
        : collectImageIds(servicesParsed.services);
      if (heldRefs.length === 0 && servicesParsed.services.some((s) => s.scale > 0)) {
        throw Object.assign(
          new Error('Recovery generation has no held image references for running services'),
          { code: 'ROLLBACK_PROHIBITED' },
        );
      }

      const context = await resolveRestoreContext(row);
      const restoredManifest = await context.restoreFromContext(transactionMeta);
      filesRestored = true;

      // Evaluate current policy against the exact held images rollback will launch
      // (opaque tags / image ids), not the restored authored moving tags.
      const restoredInvocation = restoredManifest?.invocation ?? null;
      const gate = await enforcePolicyForImageRefs(row.stack_name, row.node_id, heldRefs, {
        bypass: policyOptions?.bypass ?? false,
        actor: policyOptions?.actor ?? 'recovery-compensate',
        ip: policyOptions?.ip,
        auditMethod: policyOptions?.auditMethod ?? 'POST',
        auditPath: policyOptions?.auditPath ?? '/api/stacks/rollback',
      });
      if (!gate.ok) {
        throw Object.assign(
          new Error(describePolicyBlock(gate.policy, gate.violations, 'rollback')),
          { code: 'ROLLBACK_PROHIBITED', policy: gate.policy, violations: gate.violations },
        );
      }

      if (!row.override_path) {
        throw new Error('Recovery generation has no override path');
      }
      await composeUp(row.override_path, restoredInvocation);
      const probeOk = await this.probeRecoveredStack(
        row.node_id,
        row.stack_name,
        row.services_json,
      );
      if (!probeOk) {
        // Revert files via the existing catch path. Do not apply Git or commit
        // the restore transaction; a leftover crash-intent would later undo
        // files while recovered containers stay running.
        throw Object.assign(new Error('Recovery health probe failed'), { code: 'RECOVERY_PROBE_FAILED' });
      }

      if (restoredManifest) {
        if (generationContentPath) {
          await applyRestoredGenerationGitSide(
            row.stack_name,
            row.node_id,
            generationContentPath,
            restoredManifest,
          );
        } else {
          await restoreCapturedGitDatabaseState(row.stack_name, restoredManifest);
        }
      }
      if (generationContentPath) {
        await RollbackGenerationStore.commitRestoreTransaction(
          row.node_id,
          row.stack_name,
          generationContentPath,
        );
      }
      db.updateStackUpdateRecoveryGeneration(generationId, {
        status: 'restored_current',
        phase: 'immediate_verified',
        is_current: 1,
        artifact_expires_at: null,
      });
      return true;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (filesRestored && generationContentPath) {
        try {
          await RollbackGenerationStore.reconcileInterruptedRestore(
            row.node_id,
            row.stack_name,
            generationContentPath,
          );
        } catch (revertErr) {
          console.error(
            '[StackUpdateRecovery] Failed to revert files after compensation error: %s',
            sanitizeForLog(getErrorMessage(revertErr, 'unknown')),
          );
        }
      }
      if (code === 'ROLLBACK_PROHIBITED') {
        throw error;
      }
      console.error(
        '[StackUpdateRecovery] Compensation failed for %s: %s',
        sanitizeForLog(generationId),
        sanitizeForLog(getErrorMessage(error, 'unknown')),
      );
      db.updateStackUpdateRecoveryGeneration(generationId, {
        status: 'recovery_required',
      });
      if (code === 'GENERATION_CONTENT_MISSING') {
        throw error;
      }
      return false;
    }
  }

  /**
   * Restore generation project files + Git manifesto/DB without compose-up.
   * Used when legacy Git materialize fails mid-write and must reinstate the
   * pre-apply capture before abandoning the recovery candidate.
   */
  public async revertToGenerationContent(generationId: string): Promise<boolean> {
    const row = this.get(generationId);
    if (!row || !expectsGenerationContent(row) || !row.content_path) return false;
    await this.assertNoBlockingRestoreIntent(row.node_id, row.stack_name);

    const transactionMeta = await captureGitSidePreimage(row.stack_name);

    try {
      const context = await resolveComposeProjectContextForGeneration(
        row.node_id,
        row.stack_name,
        row.content_path,
      );
      const restoredManifest = await context.restoreFromContext(transactionMeta);
      if (restoredManifest) {
        await applyRestoredGenerationGitSide(
          row.stack_name,
          row.node_id,
          row.content_path,
          restoredManifest,
        );
      }
      await RollbackGenerationStore.commitRestoreTransaction(
        row.node_id,
        row.stack_name,
        row.content_path,
      );
      return true;
    } catch (error) {
      try {
        await RollbackGenerationStore.reconcileInterruptedRestore(
          row.node_id,
          row.stack_name,
          row.content_path,
        );
      } catch (revertErr) {
        console.error(
          '[StackUpdateRecovery] Failed to revert after revertToGenerationContent error: %s',
          sanitizeForLog(getErrorMessage(revertErr, 'unknown')),
        );
      }
      console.error(
        '[StackUpdateRecovery] revertToGenerationContent failed for %s: %s',
        sanitizeForLog(generationId),
        sanitizeForLog(getErrorMessage(error, 'unknown')),
      );
      return false;
    }
  }

  public async probeRecoveredStack(
    nodeId: number,
    stackName: string,
    servicesJson: string,
  ): Promise<boolean> {
    await new Promise((resolve) => setTimeout(resolve, RECOVERY_PROBE_DELAY_MS));
    try {
      const expectedParsed = parseServicesJsonStrict(servicesJson);
      if (!expectedParsed.ok) return false;
      const expected = expectedParsed.services;
      const expectedRunning = new Map<string, number>();
      const expectedImageIds = new Map<string, Set<string>>();
      const scaleZeroServices = new Set<string>();

      for (const svc of expected) {
        const imageIds = new Set<string>();
        for (const replica of svc.replicas) {
          if (replica.imageId?.trim()) imageIds.add(replica.imageId);
        }
        if (svc.scale > 0) {
          // Fail closed when we cannot verify image identity for expected runners.
          if (imageIds.size === 0) return false;
          expectedRunning.set(svc.serviceName, svc.scale);
          expectedImageIds.set(svc.serviceName, imageIds);
        } else {
          scaleZeroServices.add(svc.serviceName);
        }
      }

      const docker = DockerController.getInstance(nodeId).getDocker();
      const containers = await docker.listContainers({
        all: true,
        filters: { label: [`com.docker.compose.project=${stackName}`] },
      });

      if (expectedRunning.size > 0 && containers.length === 0) {
        return false;
      }

      const runningByService = new Map<string, number>();
      for (const containerInfo of containers) {
        const labels = (containerInfo.Labels ?? {}) as Record<string, string>;
        if (isComposeOneOff(labels)) continue;
        const serviceName = labels['com.docker.compose.service'];
        const state = (containerInfo.State || '').toLowerCase();

        if (state === 'restarting' || state === 'dead') {
          return false;
        }

        if (state === 'exited' || state === 'created' || state === 'removing') {
          if (serviceName && expectedRunning.has(serviceName)) {
            return false;
          }
          continue;
        }

        if (state !== 'running') {
          if (serviceName && expectedRunning.has(serviceName)) {
            return false;
          }
          continue;
        }

        // Captured at scale 0 must stay stopped; any running replica fails the probe.
        if (serviceName && scaleZeroServices.has(serviceName)) {
          return false;
        }

        const inspectData = await docker.getContainer(containerInfo.Id).inspect();
        const health = inspectData.State?.Health?.Status;
        if (health === 'unhealthy') {
          return false;
        }

        if (serviceName && expectedImageIds.has(serviceName)) {
          const allowedIds = expectedImageIds.get(serviceName)!;
          const actualImageId = typeof inspectData.Image === 'string' ? inspectData.Image : '';
          if (!actualImageId || !allowedIds.has(actualImageId)) {
            return false;
          }
        }

        if (serviceName) {
          runningByService.set(serviceName, (runningByService.get(serviceName) ?? 0) + 1);
        }
      }

      for (const [serviceName, need] of expectedRunning) {
        if ((runningByService.get(serviceName) ?? 0) !== need) {
          return false;
        }
      }
      // Scale-zero services never enter runningByService (failed above if running).
      for (const serviceName of runningByService.keys()) {
        if (!expectedRunning.has(serviceName)) return false;
      }
      return true;
    } catch (error) {
      console.warn(
        '[StackUpdateRecovery] Recovery probe failed for %s: %s',
        sanitizeForLog(stackName),
        sanitizeForLog(getErrorMessage(error, 'unknown')),
      );
      return false;
    }
  }

  /**
   * Idempotent removal of opaque tags and override files for a generation.
   * Marks artifacts_retired only when every artifact is removed or confirmed absent,
   * so transient failures remain retryable via reconcileIncomplete.
   */
  public async retireGenerationArtifacts(row: StackUpdateRecoveryGenerationRow): Promise<boolean> {
    if (row.artifacts_retired === 1) return true;
    const servicesParsed = parseServicesJsonStrict(row.services_json);
    const tags = servicesParsed.ok
      ? collectRollbackTags(servicesParsed.services)
      : scrapeRollbackTagsLenient(row.services_json);
    if (!servicesParsed.ok) {
      console.warn(
        '[StackUpdateRecovery] Malformed services_json for %s; using best-effort tag scrape before override/content retirement',
        sanitizeForLog(row.id),
      );
    }
    const tagsOk = await this.removeRollbackTags(row.node_id, tags);
    let overrideOk = true;
    if (row.override_path) {
      try {
        await fs.unlink(row.override_path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          overrideOk = false;
          console.warn(
            '[StackUpdateRecovery] Failed to delete override %s: %s',
            sanitizeForLog(row.override_path),
            sanitizeForLog(getErrorMessage(error, 'unknown')),
          );
        }
      }
    }
    let contentOk = true;
    const contentKey = row.content_path;
    if (contentKey) {
      try {
        await RollbackGenerationStore.retireGenerationContent(
          row.node_id,
          row.stack_name,
          contentKey,
        );
      } catch (error) {
        contentOk = false;
        console.warn(
          '[StackUpdateRecovery] Failed to retire generation content %s: %s',
          sanitizeForLog(contentKey),
          sanitizeForLog(getErrorMessage(error, 'unknown')),
        );
      }
    }
    if (!tagsOk || !overrideOk || !contentOk) return false;
    try {
      DatabaseService.getInstance().markStackUpdateRecoveryArtifactsRetired(row.id);
    } catch (error) {
      // Tags/override are already gone at this point; a DB write failure here
      // must not surface as "release/abandon failed" to the caller (the
      // mutation it asked for already happened). Leave artifacts_retired at 0
      // so the next reconcileIncomplete() sweep retries the DB write alone.
      console.warn(
        '[StackUpdateRecovery] Failed to mark artifacts retired for %s: %s',
        sanitizeForLog(row.id),
        sanitizeForLog(getErrorMessage(error, 'unknown')),
      );
      return false;
    }
    return true;
  }

  /**
   * Abandon lease-expired candidates, flag stuck post-handoff generations,
   * and retire expired abandoned/superseded artifacts.
   */
  public async reconcileIncomplete(): Promise<void> {
    if (!this.started) return;
    try {
      const db = DatabaseService.getInstance();
      const now = Date.now();
      // Revert any crash-interrupted content-store restores (intent still present).
      try {
        await this.sweepInterruptedRestores(db);
      } catch (e) {
        console.warn(
          '[StackUpdateRecovery] Interrupted restore sweep failed: %s',
          sanitizeForLog(getErrorMessage(e, 'unknown')),
        );
      }
      let abandoned = 0;
      for (const row of db.listStaleStackUpdateRecoveryCandidates(now)) {
        if (await this.abandon(row.id)) abandoned += 1;
      }
      let flagged = 0;
      for (const row of db.listStuckStackUpdateRecoveryGenerations(now)) {
        db.updateStackUpdateRecoveryGeneration(row.id, {
          status: 'recovery_required',
          operation_lease_expires_at: null,
        });
        flagged += 1;
      }
      let capped = 0;
      const maxGenerations = db.getRecoveryMaxGenerations();
      if (maxGenerations > 0) {
        // The current generation always counts as one of the cap, so the
        // superseded budget is one less; it can never itself be evicted here.
        const supersededBudget = Math.max(0, maxGenerations - 1);
        const byStack = new Map<string, StackUpdateRecoveryGenerationRow[]>();
        for (const row of db.listActiveSupersededGenerations()) {
          const key = `${row.node_id}:${row.stack_name}`;
          const list = byStack.get(key) ?? [];
          list.push(row);
          byStack.set(key, list);
        }
        for (const rows of byStack.values()) {
          for (const row of rows.slice(supersededBudget)) {
            if (row.artifact_expires_at === null || row.artifact_expires_at > now) {
              db.updateStackUpdateRecoveryGeneration(row.id, { artifact_expires_at: now });
              capped += 1;
            }
          }
        }
      }
      let retired = 0;
      for (const row of db.listStackUpdateRecoveryGenerationsForArtifactRetirement(now)) {
        // Never retire an active/current or recovery_required hold target.
        if (row.is_current === 1 || row.status === 'recovery_required') continue;
        if (await this.retireGenerationArtifacts(row)) retired += 1;
      }

      let orphansRetired = 0;
      let incompleteFlagged = 0;
      try {
        ({ orphansRetired, incompleteFlagged } = await this.reconcileGenerationContentDirs(db));
      } catch (contentError) {
        console.warn(
          '[StackUpdateRecovery] Generation content reconcile failed: %s',
          sanitizeForLog(getErrorMessage(contentError, 'unknown')),
        );
      }

      if (
        abandoned > 0
        || flagged > 0
        || capped > 0
        || retired > 0
        || orphansRetired > 0
        || incompleteFlagged > 0
      ) {
        console.log(
          `[StackUpdateRecovery] Reconciled ${abandoned} stale candidate(s), `
          + `${flagged} stuck generation(s), ${capped} generation(s) over cap, retired ${retired} artifact set(s), `
          + `${orphansRetired} orphan dir(s), ${incompleteFlagged} incomplete generation(s)`,
        );
      }
    } catch (error) {
      console.error(
        '[StackUpdateRecovery] Reconcile failed: %s',
        sanitizeForLog(getErrorMessage(error, 'unknown')),
      );
    }
  }

  /**
   * Retire orphan generation content dirs with no live row, and flag active rows
   * whose content dir is missing or incomplete as recovery_required.
   */
  private async reconcileGenerationContentDirs(
    db: DatabaseService,
  ): Promise<{ orphansRetired: number; incompleteFlagged: number }> {
    let orphansRetired = 0;
    let incompleteFlagged = 0;
    const backupsRoot = getBackupBaseDir();
    let nodeEntries: string[] = [];
    try {
      nodeEntries = await fs.readdir(backupsRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { orphansRetired, incompleteFlagged };
      }
      throw error;
    }

    const incompleteStatuses = new Set(['active', 'restored_current', 'candidate']);

    for (const nodeEntry of nodeEntries) {
      const nodeId = Number(nodeEntry);
      if (!Number.isFinite(nodeId)) continue;
      const nodeDir = path.join(backupsRoot, nodeEntry);
      let stackEntries: string[] = [];
      try {
        stackEntries = await fs.readdir(nodeDir);
      } catch {
        continue;
      }
      for (const stackName of stackEntries) {
        if (!isValidStackName(stackName)) continue;
        const gensRoot = path.join(nodeDir, stackName, 'generations');
        let genIds: string[] = [];
        try {
          genIds = await fs.readdir(gensRoot);
        } catch {
          continue;
        }
        const rows = db.listStackUpdateRecoveryForStack(nodeId, stackName);
        const liveKeys = new Set<string>();
        for (const row of rows) {
          if (row.artifacts_retired !== 0) continue;
          if (row.content_path) liveKeys.add(row.content_path);
          if (row.backup_slot_id) liveKeys.add(row.backup_slot_id);
          liveKeys.add(row.id);
        }
        const nowMs = Date.now();
        for (const genId of genIds) {
          if (genId.startsWith('staging-')) {
            const stagingDir = path.join(gensRoot, genId);
            try {
              const st = await fs.stat(stagingDir);
              if (nowMs - st.mtimeMs > STAGING_MAX_AGE_MS) {
                await fs.rm(stagingDir, { recursive: true, force: true });
                orphansRetired += 1;
              }
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
              console.warn(
                '[StackUpdateRecovery] Failed to retire stale staging dir %s/%s: %s',
                sanitizeForLog(stackName),
                sanitizeForLog(genId),
                sanitizeForLog(getErrorMessage(error, 'unknown')),
              );
            }
            continue;
          }
          if (!looksLikeGenerationUuid(genId) || liveKeys.has(genId)) continue;
          try {
            await RollbackGenerationStore.retireGenerationContent(nodeId, stackName, genId);
            orphansRetired += 1;
          } catch (error) {
            console.warn(
              '[StackUpdateRecovery] Failed to retire orphan generation %s/%s: %s',
              sanitizeForLog(stackName),
              sanitizeForLog(genId),
              sanitizeForLog(getErrorMessage(error, 'unknown')),
            );
          }
        }
        for (const row of rows) {
          if (row.artifacts_retired !== 0) continue;
          if (row.status === 'abandoned' || row.status === 'superseded') continue;
          if (!incompleteStatuses.has(row.status) && row.is_current !== 1) continue;
          const contentKey = row.content_path;
          if (!contentKey || !looksLikeGenerationUuid(contentKey)) continue;
          const present = await generationContentPresent(row.node_id, row.stack_name, contentKey);
          if (!present && row.status !== 'recovery_required') {
            db.updateStackUpdateRecoveryGeneration(row.id, { status: 'recovery_required' });
            incompleteFlagged += 1;
          }
        }
      }
    }
    return { orphansRetired, incompleteFlagged };
  }

  /** Returns true when every tag is removed or already absent. */
  private async removeRollbackTags(nodeId: number, tags: string[]): Promise<boolean> {
    if (tags.length === 0) return true;
    try {
      const docker = DockerController.getInstance(nodeId).getDocker();
      let allOk = true;
      for (const tag of tags) {
        try {
          await docker.getImage(tag).remove({ force: true });
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode;
          const message = getErrorMessage(error, 'unknown').toLowerCase();
          if (status === 404 || message.includes('no such image') || message.includes('not found')) {
            continue;
          }
          allOk = false;
          console.warn(
            '[StackUpdateRecovery] Failed to remove rollback tag %s: %s',
            sanitizeForLog(tag),
            sanitizeForLog(getErrorMessage(error, 'unknown')),
          );
        }
      }
      return allOk;
    } catch (error) {
      console.warn(
        '[StackUpdateRecovery] Docker unavailable while removing tags: %s',
        sanitizeForLog(getErrorMessage(error, 'unknown')),
      );
      return false;
    }
  }

  private async bestEffortRemoveTags(nodeId: number, tags: string[]): Promise<void> {
    await this.removeRollbackTags(nodeId, tags);
  }

  private activeRecoveryTtlMs(): number {
    return Math.max(getComposeCommandTimeoutMs(), this.readRecoveryWindowSeconds() * 1000);
  }

  private readRecoveryWindowSeconds(): number {
    try {
      const raw = parseInt(
        DatabaseService.getInstance().getGlobalSettings()['health_gate_window_seconds'] ?? '',
        10,
      );
      return Number.isFinite(raw) ? Math.max(raw, MIN_RECOVERY_WINDOW_SECONDS) : MIN_RECOVERY_WINDOW_SECONDS;
    } catch (error) {
      console.warn(
        '[StackUpdateRecovery] Settings read failed; using default window: %s',
        sanitizeForLog(getErrorMessage(error, 'unknown')),
      );
      return MIN_RECOVERY_WINDOW_SECONDS;
    }
  }
}

function splitOpaqueTag(tag: string): { repo: string; tagName: string } {
  const lastColon = tag.lastIndexOf(':');
  if (lastColon > 0) {
    return { repo: tag.slice(0, lastColon), tagName: tag.slice(lastColon + 1) };
  }
  return { repo: tag, tagName: 'hold' };
}
