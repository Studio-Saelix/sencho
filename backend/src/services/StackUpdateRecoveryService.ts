/**
 * Full-stack update recovery generations: capture, opaque rollback tags,
 * stack-local recovery override, handoff, compensation, and prune holds.
 *
 * Separate from ServiceUpdateRecoveryService (service-scoped snapshots).
 * Does not run Compose; ComposeService / orchestrator own Docker mutations.
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
import { isPathWithinBase } from '../utils/validation';

const SWEEP_INTERVAL_MS = 5 * 60_000;
const INITIAL_SWEEP_DELAY_MS = 30_000;
const MIN_RECOVERY_WINDOW_SECONDS = 90;
const RECOVERY_TTL_BUFFER_MS = 30 * 60_000;
const GATE_RETAIN_DEFAULT_MS = 2 * 60 * 60_000;

export interface StackRecoveryReplicaCapture {
  containerId: string | null;
  imageId: string | null;
  repoDigest: string | null;
  state: 'running' | 'stopped' | 'none';
  rollbackTag: string | null;
}

export interface StackRecoveryServiceCapture {
  serviceName: string;
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
   * Validate context, backup files, snapshot runtime, create opaque tags +
   * recovery override, insert candidate generation (is_current=0, phase=captured).
   */
  public async captureCandidate(input: CaptureStackUpdateInput): Promise<StackUpdateRecoveryGenerationRow> {
    const { nodeId, stackName, createdBy } = input;
    const context = await resolveComposeProjectContext(nodeId, stackName);
    await context.validateForMutation();
    const backupSlotId = await context.backupFromContext('update');

    const model = await buildEffectiveServiceModel(nodeId, stackName);
    if (!model.renderable) {
      throw new Error(model.error || 'Effective Compose model failed to render');
    }

    const generationId = randomUUID();
    const docker = DockerController.getInstance(nodeId).getDocker();
    const services: StackRecoveryServiceCapture[] = [];

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

      services.push({
        serviceName: spec.name,
        scale: spec.expectedReplicas,
        hasBuild: spec.hasBuild,
        declaredImageRef,
        referenceKind,
        replicas,
      });
    }

    // Fail closed: any existing replica without imageId already threw above.
    // Tag unique imageIds; scale-zero services without images are scale-only in the override YAML.
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
      }
      for (const replica of svc.replicas) {
        if (replica.imageId === primary.imageId) {
          replica.rollbackTag = tag;
        }
      }
    }

    const overridePath = await this.writeRecoveryOverride(nodeId, stackName, generationId, services);

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
    };
    DatabaseService.getInstance().insertStackUpdateRecoveryGeneration(row);
    return row;
  }

  private async writeRecoveryOverride(
    nodeId: number,
    stackName: string,
    generationId: string,
    services: StackRecoveryServiceCapture[],
  ): Promise<string> {
    const baseDir = FileSystemService.getInstance(nodeId).getBaseDir();
    const stackDir = path.resolve(baseDir, stackName);
    const short = generationId.replace(/-/g, '').slice(0, 12);
    const filename = `.sencho-recovery-${short}.yml`;
    const abs = path.resolve(stackDir, filename);
    if (!isPathWithinBase(abs, stackDir)) {
      throw new Error('Recovery override path escapes stack directory');
    }

    const lines: string[] = ['services:'];
    let wroteAny = false;
    for (const svc of services) {
      const tag = svc.replicas.find((r) => r.rollbackTag)?.rollbackTag ?? null;
      if (!tag && svc.scale !== 0) continue;
      const key = /^[a-zA-Z0-9._-]+$/.test(svc.serviceName) ? svc.serviceName : yamlQuote(svc.serviceName);
      lines.push(`  ${key}:`);
      if (tag) {
        lines.push(`    image: ${yamlQuote(tag)}`);
      }
      if (svc.scale === 0) {
        lines.push('    scale: 0');
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

  public abandon(id: string): boolean {
    return DatabaseService.getInstance().abandonStackUpdateRecoveryGeneration(id);
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
        getErrorMessage(error, 'unknown'),
      );
      try {
        this.setGateRetainUntil(id);
      } catch (retainError) {
        console.warn(
          '[StackUpdateRecovery] setGateRetainUntil failed for %s:',
          sanitizeForLog(id),
          getErrorMessage(retainError, 'unknown'),
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
        getErrorMessage(error, 'unknown'),
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
    // Fail closed: skip prune of every image when either lookup fails.
    if (serviceHeld === null || stackHeld === null) {
      return () => true;
    }
    return (imageId: string) => serviceHeld.has(imageId) || stackHeld.has(imageId);
  }

  /**
   * Post-handoff compensation: restore candidate backup + pinned up with
   * recovery override (--pull never --no-build), then mark restored_current.
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
      DatabaseService.getInstance().updateStackUpdateRecoveryGeneration(generationId, {
        status: 'restored_current',
        phase: 'immediate_verified',
        is_current: 1,
        artifact_expires_at: null,
      });
      return true;
    } catch (error) {
      console.error(
        '[StackUpdateRecovery] Compensation failed for %s:',
        sanitizeForLog(generationId),
        getErrorMessage(error, 'unknown'),
      );
      DatabaseService.getInstance().updateStackUpdateRecoveryGeneration(generationId, {
        status: 'recovery_required',
      });
      return false;
    }
  }

  /**
   * Abandon lease-expired pre-handoff candidates and flag stuck post-handoff
   * generations as recovery_required so holds remain until an operator acts.
   */
  public async reconcileIncomplete(): Promise<void> {
    if (!this.started) return;
    try {
      const db = DatabaseService.getInstance();
      const now = Date.now();
      let abandoned = 0;
      for (const row of db.listStaleStackUpdateRecoveryCandidates(now)) {
        if (this.abandon(row.id)) abandoned += 1;
      }
      let flagged = 0;
      for (const row of db.listStuckStackUpdateRecoveryGenerations(now)) {
        db.updateStackUpdateRecoveryGeneration(row.id, {
          status: 'recovery_required',
          operation_lease_expires_at: null,
        });
        flagged += 1;
      }
      if (abandoned > 0 || flagged > 0) {
        console.log(
          `[StackUpdateRecovery] Reconciled ${abandoned} stale candidate(s) and ${flagged} stuck generation(s)`,
        );
      }
    } catch (error) {
      console.error('[StackUpdateRecovery] Reconcile failed:', getErrorMessage(error, 'unknown'));
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
        '[StackUpdateRecovery] Settings read failed; using default window:',
        getErrorMessage(error, 'unknown'),
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
