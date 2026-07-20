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
import { randomUUID } from 'crypto';
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
  type ImageReferenceKind,
  resolveComposeProjectContext,
} from './composeProjectContext';
import { getComposeCommandTimeoutMs } from './ComposeService';
import { getErrorMessage } from '../utils/errors';
import { sanitizeForLog } from '../utils/safeLog';
import { isValidStackName } from '../utils/validation';

const SWEEP_INTERVAL_MS = 5 * 60_000;
const INITIAL_SWEEP_DELAY_MS = 30_000;
const MIN_RECOVERY_WINDOW_SECONDS = 90;
const RECOVERY_TTL_BUFFER_MS = 30 * 60_000;
const GATE_RETAIN_DEFAULT_MS = 2 * 60 * 60_000;
const RECOVERY_PROBE_DELAY_MS = 3_000;

export interface StackRecoveryReplicaCapture {
  containerId: string | null;
  imageId: string | null;
  repoDigest: string | null;
  state: 'running' | 'stopped' | 'none';
  rollbackTag: string | null;
}

export interface StackRecoveryServiceCapture {
  serviceName: string;
  /** Observed running replica count at capture (supported restore scale). */
  scale: number;
  hasBuild: boolean;
  declaredImageRef: string | null;
  referenceKind: ImageReferenceKind;
  replicas: StackRecoveryReplicaCapture[];
}

export interface CaptureStackUpdateInput {
  nodeId: number;
  stackName: string;
  createdBy: string | null;
}

function yamlQuote(value: string): string {
  return JSON.stringify(value);
}

function sanitizeServiceSlug(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase() || 'svc';
}

function opaqueRollbackTag(generationId: string, serviceName: string): string {
  const short = generationId.replace(/-/g, '').slice(0, 12);
  return `sencho-rb/${short}/${sanitizeServiceSlug(serviceName)}:hold`;
}

function parseServicesJson(raw: string): StackRecoveryServiceCapture[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as StackRecoveryServiceCapture[];
  } catch {
    return [];
  }
}

export function collectImageIdsFromServicesJson(servicesJson: string): string[] {
  const ids = new Set<string>();
  for (const svc of parseServicesJson(servicesJson)) {
    for (const replica of svc.replicas ?? []) {
      if (replica.imageId && replica.imageId.trim()) ids.add(replica.imageId);
    }
  }
  return [...ids];
}

function collectRollbackTags(services: StackRecoveryServiceCapture[]): string[] {
  const tags = new Set<string>();
  for (const svc of services) {
    for (const replica of svc.replicas ?? []) {
      if (replica.rollbackTag) tags.add(replica.rollbackTag);
    }
  }
  return [...tags];
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
    this.initialTimer = setTimeout(() => {
      void this.reconcileIncomplete();
      this.intervalId = setInterval(() => {
        void this.reconcileIncomplete();
      }, SWEEP_INTERVAL_MS);
    }, INITIAL_SWEEP_DELAY_MS);
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
    if (!isValidStackName(stackName)) {
      throw new Error('Invalid stack name');
    }

    const context = await resolveComposeProjectContext(nodeId, stackName);
    await context.validateForMutation();
    // Exact mutating invocation (authored files + env + generated Mesh override)
    // must validate before any backup, tag, or override write.
    const { ComposeService } = await import('./ComposeService');
    await ComposeService.getInstance(nodeId).validateExactComposeInvocation(stackName);

    const backupSlotId = await context.backupFromContext('update');

    const model = await buildEffectiveServiceModel(nodeId, stackName);
    if (!model.renderable) {
      throw new Error(model.error || 'Effective Compose model failed to render');
    }

    const generationId = randomUUID();
    const docker = DockerController.getInstance(nodeId).getDocker();
    const services: StackRecoveryServiceCapture[] = [];
    const createdTags: string[] = [];
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
        backup_slot_id: backupSlotId,
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
      throw error;
    }
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

    const short = generationId.replace(/-/g, '').slice(0, 12);
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
   * Unified held-image predicate: service-scoped + full-stack holds.
   * Fail closed (skip prune) when either lookup fails.
   */
  public buildUnifiedHeldImagePredicate(nodeId: number): (imageId: string) => boolean {
    // Dynamic require avoids a static cycle with ServiceUpdateRecoveryService.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ServiceUpdateRecoveryService } = require('./ServiceUpdateRecoveryService') as typeof import('./ServiceUpdateRecoveryService');
    const serviceHeld = ServiceUpdateRecoveryService.getInstance().getHeldImageIds(nodeId);
    const stackHeld = this.getHeldImageIds(nodeId);
    if (serviceHeld === null || stackHeld === null) {
      return () => true;
    }
    return (imageId: string) => serviceHeld.has(imageId) || stackHeld.has(imageId);
  }

  /**
   * Post-handoff compensation: restore files + pinned up, then probe before
   * reporting restored_current / immediate_verified.
   */
  public async compensateWithCandidate(
    generationId: string,
    composeUp: (overridePath: string) => Promise<void>,
  ): Promise<boolean> {
    const row = this.get(generationId);
    if (!row) return false;
    try {
      const context = await resolveComposeProjectContext(row.node_id, row.stack_name);
      await context.restoreFromContext();
      if (!row.override_path) {
        throw new Error('Recovery generation has no override path');
      }
      await composeUp(row.override_path);
      const probeOk = await this.probeRecoveredStack(row.node_id, row.stack_name);
      if (!probeOk) {
        DatabaseService.getInstance().updateStackUpdateRecoveryGeneration(generationId, {
          status: 'recovery_required',
        });
        return false;
      }
      DatabaseService.getInstance().updateStackUpdateRecoveryGeneration(generationId, {
        status: 'restored_current',
        phase: 'immediate_verified',
        is_current: 1,
        artifact_expires_at: null,
      });
      return true;
    } catch (error) {
      console.error(
        '[StackUpdateRecovery] Compensation failed for %s: %s',
        sanitizeForLog(generationId),
        sanitizeForLog(getErrorMessage(error, 'unknown')),
      );
      DatabaseService.getInstance().updateStackUpdateRecoveryGeneration(generationId, {
        status: 'recovery_required',
      });
      return false;
    }
  }

  /** Same immediate probe used after a successful update recreate. */
  public async probeRecoveredStack(nodeId: number, stackName: string): Promise<boolean> {
    await new Promise((resolve) => setTimeout(resolve, RECOVERY_PROBE_DELAY_MS));
    try {
      const docker = DockerController.getInstance(nodeId).getDocker();
      const containers = await docker.listContainers({
        all: true,
        filters: { label: [`com.docker.compose.project=${stackName}`] },
      });
      for (const containerInfo of containers) {
        if (containerInfo.State === 'exited') {
          const inspectData = await docker.getContainer(containerInfo.Id).inspect();
          if (inspectData.State.ExitCode !== 0) return false;
        }
        if (containerInfo.State === 'dead') return false;
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

  /** Idempotent removal of opaque tags and override files for a generation. */
  public async retireGenerationArtifacts(row: StackUpdateRecoveryGenerationRow): Promise<void> {
    if (row.artifacts_retired === 1) return;
    const services = parseServicesJson(row.services_json);
    await this.bestEffortRemoveTags(row.node_id, collectRollbackTags(services));
    if (row.override_path) {
      try {
        await fs.unlink(row.override_path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn(
            '[StackUpdateRecovery] Failed to delete override %s: %s',
            sanitizeForLog(row.override_path),
            sanitizeForLog(getErrorMessage(error, 'unknown')),
          );
        }
      }
    }
    DatabaseService.getInstance().markStackUpdateRecoveryArtifactsRetired(row.id);
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
      let retired = 0;
      for (const row of db.listStackUpdateRecoveryGenerationsForArtifactRetirement(now)) {
        // Never retire an active/current or recovery_required hold target.
        if (row.is_current === 1 || row.status === 'recovery_required') continue;
        await this.retireGenerationArtifacts(row);
        retired += 1;
      }
      if (abandoned > 0 || flagged > 0 || retired > 0) {
        console.log(
          `[StackUpdateRecovery] Reconciled ${abandoned} stale candidate(s), `
          + `${flagged} stuck generation(s), retired ${retired} artifact set(s)`,
        );
      }
    } catch (error) {
      console.error(
        '[StackUpdateRecovery] Reconcile failed: %s',
        sanitizeForLog(getErrorMessage(error, 'unknown')),
      );
    }
  }

  private async bestEffortRemoveTags(nodeId: number, tags: string[]): Promise<void> {
    if (tags.length === 0) return;
    try {
      const docker = DockerController.getInstance(nodeId).getDocker();
      for (const tag of tags) {
        try {
          await docker.getImage(tag).remove({ force: true });
        } catch (error) {
          console.warn(
            '[StackUpdateRecovery] Failed to remove rollback tag %s: %s',
            sanitizeForLog(tag),
            sanitizeForLog(getErrorMessage(error, 'unknown')),
          );
        }
      }
    } catch (error) {
      console.warn(
        '[StackUpdateRecovery] Docker unavailable while removing tags: %s',
        sanitizeForLog(getErrorMessage(error, 'unknown')),
      );
    }
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
