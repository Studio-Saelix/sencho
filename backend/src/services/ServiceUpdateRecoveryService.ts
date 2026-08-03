import { randomUUID } from 'crypto';
import { DatabaseService, type ServiceUpdateRecoveryRow } from './DatabaseService';
import { getComposeCommandTimeoutMs } from './ComposeService';
import { buildUnifiedHeldImagePredicate } from './recoveryHeldImages';
import { getErrorMessage } from '../utils/errors';

const SWEEP_INTERVAL_MS = 5 * 60_000;
const INITIAL_SWEEP_DELAY_MS = 30_000;
const CLAIM_RENEWAL_INTERVAL_MS = 5 * 60_000;
const MIN_CLAIM_WINDOW_MS = 30 * 60_000;
const CLAIM_RENEWAL_BUFFER_MS = 5 * 60_000;
const RECOVERY_TTL_BUFFER_MS = 30 * 60_000;
const MIN_RECOVERY_WINDOW_SECONDS = 90;
const DIGEST_PIN_PATTERN = /@sha256:[a-f0-9]{64}$/i;

/** A single pre-update replica snapshot for one service. */
export interface ServiceReplicaSnapshot {
  imageId: string;
  /** Repo digest captured from the running container, when known. */
  repoDigest: string | null;
}

export interface CreateServiceUpdateRecoveryInput {
  nodeId: number;
  stackName: string;
  serviceName: string;
  replicas: ServiceReplicaSnapshot[];
  /** EffectiveServiceSpec.declaredImage; null for a pure-build service with no image field. */
  declaredImageRef: string | null;
  createdBy: string | null;
}

export type ServiceUpdateRecoveryUnavailableReason =
  | 'no_replicas'
  | 'majority_tie'
  | 'build_only'
  | 'digest_pinned_declared_ref'
  | 'missing_local_id';

export type CreateServiceUpdateRecoveryResult =
  | { eligible: true; row: ServiceUpdateRecoveryRow }
  | { eligible: false; reason: ServiceUpdateRecoveryUnavailableReason };

/**
 * Pre-update image snapshots that let an operator manually restore a single
 * service after a service-scoped update, without touching its siblings.
 *
 * Purely a data/lifecycle layer: it decides whether a snapshot is eligible to
 * persist, holds the claimed row's image from prune while a restore is in
 * flight, and sweeps stale rows. It never runs Compose or touches Docker; the
 * update/restore orchestration (StackUpdateOrchestrator) calls into this
 * service at the right points and is responsible for policy, health gating,
 * and Auto-Heal suppression around those calls.
 */
export class ServiceUpdateRecoveryService {
  private static instance: ServiceUpdateRecoveryService;
  private started = false;
  private intervalId: NodeJS.Timeout | null = null;
  private initialTimer: NodeJS.Timeout | null = null;
  private readonly renewalTimers = new Map<string, NodeJS.Timeout>();

  private constructor() {}

  public static getInstance(): ServiceUpdateRecoveryService {
    if (!ServiceUpdateRecoveryService.instance) {
      ServiceUpdateRecoveryService.instance = new ServiceUpdateRecoveryService();
    }
    return ServiceUpdateRecoveryService.instance;
  }

  public start(): void {
    this.started = true;
    if (this.initialTimer || this.intervalId) return;
    this.initialTimer = setTimeout(() => {
      this.sweep();
      this.intervalId = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    }, INITIAL_SWEEP_DELAY_MS);
  }

  /** Clear the sweep timer and every in-flight claim renewal loop. No callbacks fire after this returns. */
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
    for (const timer of this.renewalTimers.values()) clearInterval(timer);
    this.renewalTimers.clear();
  }

  /** Expire active rows past their TTL and restoring rows abandoned by a dead claim. Never throws. */
  public sweep(): void {
    try {
      const now = Date.now();
      const db = DatabaseService.getInstance();
      const expiredActive = db.sweepExpiredActiveServiceUpdateRecoveries(now);
      const expiredAbandoned = db.sweepAbandonedRestoringServiceUpdateRecoveries(now);
      if (expiredActive > 0 || expiredAbandoned > 0) {
        console.log(
          `[ServiceUpdateRecovery] Swept ${expiredActive} expired active and ${expiredAbandoned} abandoned restoring record(s)`,
        );
      }
    } catch (error) {
      console.error('[ServiceUpdateRecovery] Sweep failed:', getErrorMessage(error, 'unknown'));
    }
  }

  /**
   * Decide whether a pre-update snapshot is eligible to persist and, if so,
   * insert it. Unavailable per §8: no replicas, a majority tie, a pure-build
   * service (no declared image ref), a digest-pinned declared ref, or a
   * replica missing its local image id.
   */
  public createIfEligible(input: CreateServiceUpdateRecoveryInput): CreateServiceUpdateRecoveryResult {
    const validReplicas = input.replicas.filter(r => r.imageId.trim().length > 0);
    if (validReplicas.length === 0) {
      return { eligible: false, reason: input.replicas.length === 0 ? 'no_replicas' : 'missing_local_id' };
    }

    const majority = this.computeMajorityImage(validReplicas);
    if (!majority) return { eligible: false, reason: 'majority_tie' };

    if (!input.declaredImageRef) return { eligible: false, reason: 'build_only' };
    if (DIGEST_PIN_PATTERN.test(input.declaredImageRef)) return { eligible: false, reason: 'digest_pinned_declared_ref' };

    const now = Date.now();
    const row: ServiceUpdateRecoveryRow = {
      id: randomUUID(),
      node_id: input.nodeId,
      stack_name: input.stackName,
      service_name: input.serviceName,
      replicas_json: JSON.stringify(input.replicas),
      majority_image_id: majority.imageId,
      declared_image_ref: input.declaredImageRef,
      weak_floating_tag: majority.weakFloatingTag ? 1 : 0,
      health_gate_id: null,
      status: 'active',
      expires_at: now + this.activeRecoveryTtlMs() + RECOVERY_TTL_BUFFER_MS,
      claim_expires_at: null,
      created_at: now,
      created_by: input.createdBy,
    };
    DatabaseService.getInstance().insertServiceUpdateRecovery(row);
    return { eligible: true, row };
  }

  /** Active, unexpired recovery rows for one service (drives `recoveryAvailable` in the update/restore responses). */
  public listActive(nodeId: number, stackName: string, serviceName: string): ServiceUpdateRecoveryRow[] {
    return DatabaseService.getInstance().listActiveServiceUpdateRecoveries(nodeId, stackName, serviceName);
  }

  public get(id: string): ServiceUpdateRecoveryRow | undefined {
    return DatabaseService.getInstance().getServiceUpdateRecovery(id);
  }

  /** Attach the update flow's own health gate run id while the row is still active. */
  public linkHealthGate(id: string, healthGateId: string): void {
    DatabaseService.getInstance().linkServiceUpdateRecoveryHealthGate(id, healthGateId);
  }

  /** Atomic claim: active -> restoring. Returns the claimed row, or undefined if another actor won the race. */
  public claim(id: string): ServiceUpdateRecoveryRow | undefined {
    const now = Date.now();
    return DatabaseService.getInstance().claimServiceUpdateRecovery(id, this.nextClaimExpiry(now), now);
  }

  /**
   * Start the mandatory 5-minute renewal loop for a claimed row (RECOVERY-CLAIM-2).
   * Idempotent per id. Each tick CAS-extends claim_expires_at only while the row
   * is still restoring; a renewal that finds the row no longer restoring (superseded,
   * consumed, or force-expired) stops itself rather than reviving a terminal row.
   */
  public startClaimRenewal(id: string): void {
    if (!this.started || this.renewalTimers.has(id)) return;
    const timer = setInterval(() => {
      try {
        const renewed = DatabaseService.getInstance().renewServiceUpdateRecoveryClaim(id, this.nextClaimExpiry(Date.now()));
        if (!renewed) this.stopClaimRenewal(id);
      } catch (error) {
        console.error('[ServiceUpdateRecovery] Claim renewal failed for %s:', id, getErrorMessage(error, 'unknown'));
      }
    }, CLAIM_RENEWAL_INTERVAL_MS);
    this.renewalTimers.set(id, timer);
  }

  /** Stop the renewal loop for a row. Callers must call this in the restore operation's `finally` regardless of outcome. */
  public stopClaimRenewal(id: string): void {
    const timer = this.renewalTimers.get(id);
    if (timer) {
      clearInterval(timer);
      this.renewalTimers.delete(id);
    }
  }

  /** Restore succeeded: restoring -> consumed, optionally linking the restore's own health gate run. */
  public markConsumed(id: string, healthGateId: string | null = null): boolean {
    return DatabaseService.getInstance().markServiceUpdateRecoveryConsumed(id, healthGateId);
  }

  /** Mid-flight restore failure with the image still local: restoring -> active, claim cleared. */
  public reactivate(id: string): boolean {
    return DatabaseService.getInstance().reactivateServiceUpdateRecovery(id);
  }

  /** Mid-flight restore failure with the image gone: restoring -> invalidated. */
  public invalidate(id: string): boolean {
    return DatabaseService.getInstance().invalidateServiceUpdateRecovery(id);
  }

  /**
   * Image IDs currently held for this node (active rows and restoring rows
   * with a live claim). Returns null when the held set cannot be read so
   * callers can fail closed (skip prune) instead of treating the miss as empty.
   */
  public getHeldImageIds(nodeId: number): Set<string> | null {
    try {
      return new Set(DatabaseService.getInstance().listHeldServiceUpdateRecoveryImageIds(nodeId, Date.now()));
    } catch (error) {
      console.warn(
        '[ServiceUpdateRecovery] Failed to compute held image ids for node %d:', nodeId, getErrorMessage(error, 'unknown'),
      );
      return null;
    }
  }

  /**
   * A predicate a pruner can call immediately before deleting each candidate
   * image. Re-reads the held set on every call (rather than snapshotting it
   * once, unlike recoveryHeldImages.buildUnifiedHeldImagePredicate) so a
   * generation that becomes eligible between plan and delete is still
   * honored. When the held set cannot be read, returns true for every id so
   * prune skips deletes (fail closed).
   */
  public buildHeldImagePredicate(nodeId: number): (imageId: string) => boolean {
    return (imageId: string) => buildUnifiedHeldImagePredicate(nodeId)(imageId);
  }

  private nextClaimExpiry(now: number): number {
    return now + Math.max(getComposeCommandTimeoutMs(), MIN_CLAIM_WINDOW_MS) + CLAIM_RENEWAL_BUFFER_MS;
  }

  /**
   * Active recovery must outlive both the Compose mutation and the post-update
   * health window. A raised SENCHO_COMPOSE_COMMAND_TIMEOUT_MS must not leave the
   * snapshot eligible for sweep while Compose is still running.
   */
  private activeRecoveryTtlMs(): number {
    return Math.max(getComposeCommandTimeoutMs(), this.readRecoveryWindowSeconds() * 1000);
  }

  private readRecoveryWindowSeconds(): number {
    try {
      const raw = parseInt(DatabaseService.getInstance().getGlobalSettings()['health_gate_window_seconds'] ?? '', 10);
      return Number.isFinite(raw) ? Math.max(raw, MIN_RECOVERY_WINDOW_SECONDS) : MIN_RECOVERY_WINDOW_SECONDS;
    } catch (error) {
      console.warn('[ServiceUpdateRecovery] Settings read failed; using default window:', getErrorMessage(error, 'unknown'));
      return MIN_RECOVERY_WINDOW_SECONDS;
    }
  }

  /** Majority image id among replicas, or null on a tie (no single winner). */
  private computeMajorityImage(replicas: ServiceReplicaSnapshot[]): { imageId: string; weakFloatingTag: boolean } | null {
    const counts = new Map<string, number>();
    for (const replica of replicas) {
      counts.set(replica.imageId, (counts.get(replica.imageId) ?? 0) + 1);
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    if (ranked.length === 0) return null;
    if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return null;
    const winner = ranked[0][0];
    const weakFloatingTag = !replicas.some(r => r.imageId === winner && r.repoDigest);
    return { imageId: winner, weakFloatingTag };
  }
}
