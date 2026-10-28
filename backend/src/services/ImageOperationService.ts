import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import SelfUpdateService, {
  ENDPOINT_PROVIDER_HELPER_MAX_LIFETIME_MS,
  ENDPOINT_PROVIDER_LAUNCH_TIMEOUT_MS,
  ENDPOINT_PROVIDER_STAGE_TIMEOUT_MS,
  SELF_UPDATE_PULL_TIMEOUT_MS,
} from './SelfUpdateService';
import DockerController from './DockerController';
import { DatabaseService } from './DatabaseService';
import { FleetUpdateTrackerService } from './FleetUpdateTrackerService';
import { getSenchoVersion } from './CapabilityRegistry';
import { helperFiles, parseOutcome, endpointProviderHelperName, type ProviderAck, type ProviderOutcome } from '../helpers/endpointProviderReplace';
import { getErrorMessage } from '../utils/errors';
import { HardenedEntitlementService } from './HardenedEntitlementService';
import { RegistryService } from './RegistryService';
import type { ImagePinKind } from '../helpers/selfUpdateCompose';
import type { LocalRegistryAccess } from './hardenedEntitlementTypes';
import { getAuthToken, httpRequest } from './registry-api';

export type ImageOperationKind = 'switch' | 'update' | 'community_update' | 'compose_reapply';
export type ImageOperationState = 'pending_pull' | 'pulling' | 'patching' | 'recreating' | 'succeeded' | 'failed';
type FailureCode = 'self_update_unavailable' | 'entitlement_denied' | 'preflight_mismatch' | 'compose_unavailable' | 'registry_access_unavailable' | 'update_failed' | 'interrupted_by_restart'
  | EndpointProviderFailureCode;

/** Outcomes of a Docker endpoint replacement that failed after it started. */
export type EndpointProviderFailureCode = 'endpoint_provider_restored' | 'endpoint_provider_recovery_required';

/** The container carrying the Docker API that this operation also recreates. */
export interface OperationEndpointProvider {
  project: string;
  service: string;
  containerName: string;
  /**
   * `provider` recreates only that container and leaves Sencho running (a
   * Reapply), so this process verifies and answers the helper itself. `stack`
   * also recreates Sencho and the ack comes from the new process.
   */
  scope: 'provider' | 'stack';
}

export type ClaimResult =
  | { ok: true }
  | { ok: false; failureCode: 'IMAGE_OPERATION_IN_FLIGHT' }
  | { ok: false; failureCode: 'endpoint_provider_unavailable'; reason: string };

/** The Reapply/Update choice around the Docker endpoint container. */
export interface EndpointProviderClaim {
  replace: boolean;
  /** Recreate only the endpoint container (Reapply only). */
  only: boolean;
}

export interface ImageOperation {
  schemaVersion: 1;
  operationId: string;
  kind: ImageOperationKind;
  state: ImageOperationState;
  previousImageRef: string | null;
  targetImageRef: string | null;
  composeFilePath: string | null;
  serviceName: string | null;
  startedAt: string;
  resolvedAt?: string;
  acknowledgedAt?: string;
  failureCode?: FailureCode;
  /** Operator-facing reason for a failure, when one is known. */
  failureDetail?: string;
  /** Whether a failed replacement restored the previous container and Sencho then confirmed it reaches Docker through it. */
  rollback: { attempted: false } | { attempted: true; restored: boolean; error: string | null };
  preflightFingerprint?: string;
  /** Set when the operation also recreates the container carrying this node's Docker API. */
  endpointProvider?: OperationEndpointProvider;
  /**
   * Set when this version launched the helper with its operation label, so
   * reconciliation may conclude the helper is gone from Docker's container
   * list. Older records keep waiting out the full lifetime bound.
   */
  helperLabelVersion?: 1;
}

export type HardenedPreflight =
  | { ok: true; preflightFingerprint: string; currentImageRef: string; allowedImageRef: string; composeFilePath: string; pinKind: ImagePinKind; localRegistryAccess: LocalRegistryAccess }
  | { ok: false; code: FailureCode | 'entitlement_denied' };

const OPERATION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * One line of operator text from an error that may carry a proxy's HTML error
 * page or multi-line Compose output: tags dropped, whitespace collapsed, capped.
 */
function plainText(text: string): string {
  const flat = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > 400 ? `${flat.slice(0, 400)}...` : flat;
}

const NON_TERMINAL_STATES: ReadonlyArray<ImageOperationState> = ['pending_pull', 'pulling', 'patching', 'recreating'];

/** A Docker request that accepted the connection but did not answer before its bound. */
class DockerRequestTimeoutError extends Error {}

/**
 * Races one Docker request against a finite bound. A proxy that accepts TCP but
 * never answers must not defeat the verification deadline. The request itself
 * is cancelled by the abort signal the caller passes to dockerode; this race
 * only guarantees the caller stops waiting.
 */
function withRequestTimeout<T>(request: Promise<T>, milliseconds: number, label: string): Promise<T> {
  const bound = Math.max(1, Math.floor(milliseconds));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new DockerRequestTimeoutError(`${label} did not answer within ${bound} ms`)),
      bound,
    );
    request.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class ImageOperationService {
  private static instance: ImageOperationService;
  private claimed = false;
  private stateWriteQueue: Promise<void> = Promise.resolve();
  /** True while this process runs or reconciles a Docker endpoint replacement. */
  private endpointProviderPending = false;
  /**
   * True only while startup is still reading the previous operation. The first
   * /api/meta answer can arrive before that read resolves; reporting pending
   * during it stops Fleet from treating the restart alone as completion.
   */
  private startupReconciling = false;
  /** Wall-clock time of the last verified Docker endpoint replacement in this process. */
  private endpointProviderCompletedAt: number | null = null;
  /**
   * Bounds for a Docker endpoint replacement, in milliseconds. `verify` is how
   * long a new process retries Docker through the new provider before it
   * answers the helper; `outcome` is how long it then waits for the helper's
   * verdict; `watch` is how long the process that spawned the helper waits.
   * Overridden in tests.
   */
  public endpointProviderTimings = {
    pollMs: 2_000,
    /** Ceiling for one Docker request (ping, list, inspect) inside a verification loop. */
    requestMs: 10_000,
    verifyMs: 90_000,
    /**
     * How long a restarted process waits for the helper's phase marker and
     * verdict. It covers the claim's staging plus the helper's whole permitted
     * lifetime; the claim is never released while the helper can still mutate.
     */
    outcomeMs: SELF_UPDATE_PULL_TIMEOUT_MS + ENDPOINT_PROVIDER_STAGE_TIMEOUT_MS
      + ENDPOINT_PROVIDER_LAUNCH_TIMEOUT_MS + ENDPOINT_PROVIDER_HELPER_MAX_LIFETIME_MS + 60_000,
    /**
     * How long the process that spawned the helper waits. It must outlast the
     * helper's compose commands, ack wait and rollback, not only its marker.
     */
    watchMs: ENDPOINT_PROVIDER_HELPER_MAX_LIFETIME_MS,
    /** How long a restored endpoint gets to answer, when this process is still alive to check it. */
    recoveryMs: 15_000,
  };

  public static getInstance(): ImageOperationService {
    if (!ImageOperationService.instance) ImageOperationService.instance = new ImageOperationService();
    return ImageOperationService.instance;
  }

  public static isOperationId(operationId: string): boolean {
    return OPERATION_ID_RE.test(operationId);
  }

  public computePreflightFingerprint(composePath: string, currentImage: string, pinKind: ImagePinKind, allowedImageRef: string): string {
    return crypto.createHash('sha256')
      .update(JSON.stringify({ composePath, currentImage, pinKind, allowedImageRef }))
      .digest('hex');
  }

  public async preflightSwitch(): Promise<HardenedPreflight> {
    const entitlement = await HardenedEntitlementService.getInstance().getEntitlement('switch');
    if (!entitlement.success) return { ok: false, code: 'entitlement_denied' };

    const resolved = await SelfUpdateService.getInstance().getResolvedComposeImageForUpdate();
    if (!resolved) return { ok: false, code: 'compose_unavailable' };
    const localRegistryAccess = await this.getRegistryAccess(
      entitlement.entitlement.registry_requirement.registry_host,
      entitlement.entitlement.registry_requirement.package_scope,
    );
    return {
      ok: true,
      preflightFingerprint: this.computePreflightFingerprint(
        resolved.filePath,
        resolved.imageRef,
        resolved.pinKind,
        entitlement.entitlement.allowed_image_ref,
      ),
      currentImageRef: resolved.imageRef,
      allowedImageRef: entitlement.entitlement.allowed_image_ref,
      composeFilePath: resolved.filePath,
      pinKind: resolved.pinKind,
      localRegistryAccess,
    };
  }

  public async switchToHardened(
    preflightFingerprint: string,
    kind: 'switch' | 'update' = 'switch',
  ): Promise<{ ok: boolean; code?: FailureCode | 'IMAGE_OPERATION_IN_FLIGHT' | 'preflight_mismatch' }> {
    const entitlement = await HardenedEntitlementService.getInstance().getEntitlement('switch');
    if (!entitlement.success) return { ok: false, code: 'entitlement_denied' };
    const selfUpdate = SelfUpdateService.getInstance();
    const resolved = await selfUpdate.getResolvedComposeImageForUpdate();
    const serviceName = selfUpdate.getComposeServiceName();
    if (!resolved || !serviceName) return { ok: false, code: 'compose_unavailable' };

    const fingerprint = this.computePreflightFingerprint(
      resolved.filePath,
      resolved.imageRef,
      resolved.pinKind,
      entitlement.entitlement.allowed_image_ref,
    );
    if (fingerprint !== preflightFingerprint) return { ok: false, code: 'preflight_mismatch' };

    const operation = this.newOperation(kind, resolved.imageRef, entitlement.entitlement.allowed_image_ref, resolved.filePath, serviceName, fingerprint);
    if (!await this.tryClaim(operation)) return { ok: false, code: 'IMAGE_OPERATION_IN_FLIGHT' };

    try {
      const config = await RegistryService.getInstance().resolveDockerConfigForHost(
        entitlement.entitlement.registry_requirement.registry_host,
      );
      if (Object.keys(config.config.auths).length === 0) {
        await this.fail(operation, 'registry_access_unavailable');
        return { ok: false, code: 'registry_access_unavailable' };
      }
      const configDir = await this.writeDockerConfig(operation.operationId, config.config);
      operation.state = 'pulling';
      await this.persist(operation);
      // Register before triggerUpdate so a fast helper exit cannot drain listeners first.
      this.watchHelperExit(operation);
      await selfUpdate.triggerUpdate({
        targetImageRef: operation.targetImageRef!,
        dockerConfigPath: configDir,
        successMarkerFile: this.successMarkerFile(operation),
        successMarkerContent: JSON.stringify({ ok: true, operationId: operation.operationId }),
      });
      if (selfUpdate.getLastError()) {
        await this.fail(operation, 'update_failed');
        return { ok: false, code: 'update_failed' };
      }
      operation.state = 'recreating';
      await this.persist(operation);
      if (selfUpdate.getLastError()) {
        await this.fail(operation, 'update_failed');
        return { ok: false, code: 'update_failed' };
      }
      return { ok: true };
    } catch (error) {
      console.error('[ImageOperation] Hardened switch failed:', error);
      await this.fail(operation, 'update_failed');
      return { ok: false, code: 'update_failed' };
    } finally {
      this.claimed = false;
    }
  }

  public async claimCommunityUpdate(options?: { targetVersion?: string; replaceEndpointProvider?: boolean }): Promise<ClaimResult> {
    return this.claimComposeOperation('community_update', options?.targetVersion ?? null, {
      replace: options?.replaceEndpointProvider === true,
      // An image update always recreates Sencho; the routes refuse this
      // combination, so it is never silently reinterpreted here.
      only: false,
    });
  }

  public async executeClaimedCommunityUpdate(options?: { targetVersion?: string }): Promise<{ ok: boolean; failureCode?: string }> {
    const operation = await this.getActiveClaimedOperation('community_update');
    if (!operation) return { ok: false, failureCode: 'update_failed' };
    const selfUpdate = SelfUpdateService.getInstance();
    try {
      operation.state = 'pulling';
      await this.persist(operation);
      // Register before triggerUpdate so a fast helper exit cannot drain listeners first.
      if (operation.endpointProvider) this.endpointProviderPending = true;
      else this.watchHelperExit(operation);
      await selfUpdate.triggerUpdate({
        ...options,
        successMarkerFile: this.successMarkerFile(operation),
        successMarkerContent: JSON.stringify({ ok: true, operationId: operation.operationId }),
        ...(operation.endpointProvider ? { endpointProvider: this.endpointProviderRequest(operation, operation.endpointProvider) } : {}),
      });
      if (selfUpdate.getLastError()) {
        await this.failFromLastError(operation);
        return { ok: false, failureCode: 'update_failed' };
      }
      operation.state = 'recreating';
      await this.persist(operation);
      if (selfUpdate.getLastError()) {
        await this.failFromLastError(operation);
        return { ok: false, failureCode: 'update_failed' };
      }
      if (operation.endpointProvider) this.watchEndpointProviderOutcome(operation);
      return { ok: true };
    } catch (error) {
      console.error('[ImageOperation] Community update failed:', error);
      if (operation.endpointProvider) {
        void this.failEndpointProviderOperation(
          operation,
          'endpoint_provider_recovery_required',
          this.endpointProviderFailureText(operation, 'after its helper launched', error),
        ).catch(writeError => console.error('[ImageOperation] Could not settle the Docker endpoint failure:', writeError));
      } else {
        await this.fail(operation, 'update_failed');
      }
      return { ok: false, failureCode: 'update_failed' };
    }
  }

  public async runCommunityUpdate(options?: { targetVersion?: string }): Promise<{ ok: boolean; failureCode?: string }> {
    const claim = await this.claimCommunityUpdate(options);
    if (!claim.ok) return claim;
    return this.executeClaimedCommunityUpdate(options);
  }

  public async claimComposeReapply(options?: Partial<EndpointProviderClaim>): Promise<ClaimResult> {
    return this.claimComposeOperation('compose_reapply', null, {
      replace: options?.replace === true,
      only: options?.only === true,
    });
  }

  public async executeClaimedComposeReapply(): Promise<{ ok: boolean; failureCode?: string }> {
    const operation = await this.getActiveClaimedOperation('compose_reapply');
    if (!operation) return { ok: false, failureCode: 'update_failed' };
    const selfUpdate = SelfUpdateService.getInstance();
    try {
      // No pull/patch for reapply: jump straight to recreating.
      operation.state = 'recreating';
      await this.persist(operation);
      if (operation.endpointProvider) this.endpointProviderPending = true;
      else this.watchHelperExit(operation);
      await selfUpdate.triggerComposeReapply({
        successMarkerFile: this.successMarkerFile(operation),
        successMarkerContent: JSON.stringify({ ok: true, operationId: operation.operationId }),
        ...(operation.endpointProvider ? { endpointProvider: this.endpointProviderRequest(operation, operation.endpointProvider) } : {}),
      });
      if (selfUpdate.getLastError()) {
        await this.failFromLastError(operation);
        return { ok: false, failureCode: 'update_failed' };
      }
      if (operation.endpointProvider?.scope === 'provider') {
        this.reconcileInPlaceEndpointProvider(operation, operation.endpointProvider);
      } else if (operation.endpointProvider) {
        this.watchEndpointProviderOutcome(operation);
      }
      return { ok: true };
    } catch (error) {
      console.error('[ImageOperation] Compose reapply failed:', error);
      if (operation.endpointProvider) {
        void this.failEndpointProviderOperation(
          operation,
          'endpoint_provider_recovery_required',
          this.endpointProviderFailureText(operation, 'after its helper launched', error),
        ).catch(writeError => console.error('[ImageOperation] Could not settle the Docker endpoint failure:', writeError));
      } else {
        await this.fail(operation, 'update_failed');
      }
      return { ok: false, failureCode: 'update_failed' };
    }
  }

  public async getOperation(operationId: string): Promise<ImageOperation | null> {
    const filePath = this.operationFile(operationId);
    if (!filePath) return null;
    return this.readOperation(filePath);
  }

  public async getCurrentOperation(): Promise<ImageOperation | null> {
    return this.readOperation(this.currentFile());
  }

  public async acknowledge(operationId: string): Promise<boolean> {
    const operation = await this.getOperation(operationId);
    if (!operation || operation.state !== 'failed') return false;
    operation.acknowledgedAt = new Date().toISOString();
    // Write the history file always; only refresh the global current pointer when
    // this operation is still current. Otherwise acknowledging a stale failure can
    // replace an active claim and bypass single-flight locking.
    await this.enqueueStateWrite(async () => {
      const filePath = this.operationFile(operation.operationId);
      if (!filePath) throw new Error('Invalid image operation id');
      await fs.mkdir(this.operationsDir(), { recursive: true, mode: 0o700 });
      await this.atomicWrite(filePath, JSON.stringify(operation));
      const current = await this.readOperation(this.currentFile());
      if (current?.operationId === operation.operationId) {
        await this.atomicWrite(this.currentFile(), JSON.stringify(operation));
      }
    });
    return true;
  }

  /** True while a Docker endpoint replacement is running or being verified on this node. */
  public isEndpointProviderPending(): boolean {
    return this.endpointProviderPending || this.startupReconciling;
  }

  /**
   * When this process last verified a Docker endpoint replacement, or null.
   * Published in /api/meta so the hub can complete a remote provider-only
   * reapply, which never restarts the node's Sencho process.
   */
  public getEndpointProviderCompletedAt(): number | null {
    return this.endpointProviderCompletedAt;
  }

  public async reconcileOnStartup(): Promise<void> {
    // Set before the first await: /api/meta may answer while the operation file
    // is still being read, and a remote Reapply must not complete on the process
    // start alone during that window. It clears as soon as the operation type
    // is known; an endpoint replacement then holds endpointProviderPending.
    this.startupReconciling = true;
    const operation = await this.getCurrentOperation()
      .finally(() => { this.startupReconciling = false; });
    if (!operation || !NON_TERMINAL_STATES.includes(operation.state)) return;
    if (operation.endpointProvider) {
      await this.reconcileEndpointProvider(operation, operation.endpointProvider);
      return;
    }
    const markerPath = this.successMarkerFile(operation);
    for (let elapsed = 0; elapsed < 30_000; elapsed += 1_000) {
      const markerOk = await this.isSuccessMarkerForOperation(markerPath, operation.operationId);
      if (operation.kind === 'community_update' || operation.kind === 'compose_reapply') {
        // Marker-only success: community updates may leave floating tags that do
        // not equal targetImageRef, and reapply never sets a target image at all.
        if (markerOk) {
          operation.state = 'succeeded';
          operation.resolvedAt = new Date().toISOString();
          await this.persist(operation);
          await this.cleanupOperationArtifacts(operation);
          return;
        }
      } else {
        const pinMatchesTarget = (await SelfUpdateService.getInstance().getPinInfo({ fresh: true }))?.composeImageRef === operation.targetImageRef;
        if (markerOk && pinMatchesTarget) {
          operation.state = 'succeeded';
          operation.resolvedAt = new Date().toISOString();
          await this.persist(operation);
          await this.cleanupOperationArtifacts(operation);
          return;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
    await this.fail(operation, 'interrupted_by_restart');
  }

  /** Fails the operation with the helper's error; a Docker endpoint replacement keeps the text as its detail. */
  private async failFromLastError(operation: ImageOperation): Promise<void> {
    if (operation.endpointProvider) {
      const detail = SelfUpdateService.getInstance().getLastError() ?? undefined;
      // The trigger only records lastError for a refusal that proves the
      // detached helper never launched (staging, an absent create, or a
      // confirmed inert-container removal) or for a pull/repin that precedes
      // it. That is reliable cancellation evidence, so the claim may be
      // released even when Docker itself is unreachable.
      await this.fail(operation, 'update_failed', detail);
      this.setLocalTracker(operation, 'failed', detail);
      return;
    }
    await this.fail(operation, 'update_failed');
  }

  /**
   * Terminates a Docker endpoint operation only when releasing the claim is
   * safe. A refusal before the helper ran still fails immediately, but once a
   * labelled helper may exist the claim is held and reconciliation continues:
   * the helper can still be replacing or restoring the endpoint, and letting a
   * second operation claim it would put two helpers on the same endpoint. The
   * elapsed-time budget is never termination evidence by itself.
   */
  private async failEndpointProviderOperation(
    operation: ImageOperation,
    failureCode: FailureCode,
    detail: string | undefined,
  ): Promise<void> {
    if (!operation.endpointProvider) {
      await this.fail(operation, failureCode, detail);
      return;
    }
    if (await this.helperHasTerminated(operation)) {
      // The helper writes its verdict with an atomic rename before it exits. A
      // failed read just before that write can be followed by the helper
      // disappearing, so a check that sees it gone reads once more. A verdict
      // that exists is used to settle the failure; otherwise the caller's
      // failure stands.
      const settled = await this.readProviderOutcome(operation);
      if (settled) {
        await this.finalizeEndpointProvider(operation, settled, detail);
        return;
      }
      await this.fail(operation, failureCode, detail);
      this.setLocalTracker(operation, 'failed', detail);
      return;
    }
    this.endpointProviderPending = true;
    console.warn('[ImageOperation] Docker endpoint failure while the helper may still run; keeping the claim:', detail);
    const outcome = await this.awaitEndpointProviderMutationEnd(operation);
    await this.finalizeEndpointProvider(operation, outcome, detail);
  }

  /**
   * Waits until the labelled helper can no longer mutate the endpoint: it
   * published a verdict, or Docker conclusively shows no helper for this
   * operation. Docker being unreachable is not evidence either way, so this
   * keeps waiting rather than releasing the claim on a guess.
   */
  private async awaitEndpointProviderMutationEnd(operation: ImageOperation): Promise<ProviderOutcome | null> {
    for (;;) {
      const outcome = await this.readProviderOutcome(operation);
      if (outcome) return outcome;
      // The caller settles the result and re-reads the verdict after seeing
      // the helper gone; a null here is not yet the final answer.
      if (await this.helperHasTerminated(operation)) return null;
      await new Promise(resolve => setTimeout(resolve, this.endpointProviderTimings.pollMs));
    }
  }

  /** Operator text for an unexpected post-launch failure. */
  private endpointProviderFailureText(operation: ImageOperation, phase: string, error: unknown): string {
    const service = operation.endpointProvider?.service ?? 'the Docker endpoint';
    return `Replacing the Docker endpoint "${service}" failed ${phase}: ${plainText(getErrorMessage(error, 'unexpected error'))}. Check that "${service}" runs and that Sencho reaches Docker, then retry.`;
  }

  private endpointProviderRequest(operation: ImageOperation, provider: OperationEndpointProvider) {
    return {
      operationId: operation.operationId,
      service: provider.service,
      scope: provider.scope,
      handoffDir: path.dirname(helperFiles.plan(this.dataDir(), operation.operationId)),
      planFile: helperFiles.plan(this.dataDir(), operation.operationId),
    };
  }

  /**
   * In the process that spawned the helper: the helper recreates the provider
   * first, so a failure there (and its rollback) is reported while this
   * process still runs. Success arrives only after this process is replaced,
   * so the watch ends with the process; a helper that never reports within
   * the bound is a failure the operator must look at.
   */
  private watchEndpointProviderOutcome(operation: ImageOperation): void {
    void (async () => {
      const deadline = Date.now() + this.endpointProviderTimings.watchMs;
      const outcome = await this.waitForProviderOutcome(operation, deadline);
      await this.finalizeEndpointProvider(operation, outcome);
    })().catch(async error => {
      // The watcher is a finalizer too: an unexpected throw must not leave the
      // operation non-terminal with Fleet's timeout suppressed. The claim stays
      // held while the helper can still mutate; only a verdict or Docker's own
      // container list may release it.
      console.error('[ImageOperation] Docker endpoint outcome watch failed:', error);
      const current = await this.getCurrentOperation().catch(() => null);
      if (!current || current.operationId !== operation.operationId || !NON_TERMINAL_STATES.includes(current.state)) {
        this.endpointProviderPending = false;
        return;
      }
      await this.failEndpointProviderOperation(
        current,
        'endpoint_provider_recovery_required',
        this.endpointProviderFailureText(current, 'while Sencho was waiting for or applying the helper\'s outcome', error),
      ).catch(writeError => {
        // The claim intentionally stays held when even the failure cannot be
        // persisted: an on-disk non-terminal operation still blocks a new one.
        console.error('[ImageOperation] Could not settle the Docker endpoint failure:', writeError);
      });
    });
  }

  /**
   * In the new process after Sencho was recreated: wait for the helper's
   * durable marker proving the provider exists, check Docker through it,
   * answer the helper (its ack), then wait for the helper's verdict. Only a
   * positive verdict marks the operation succeeded.
   *
   * Without the marker the old provider may still be the one answering, so
   * nothing is verified or acknowledged: startup after an operation that never
   * reached its helper ends in recovery-required, not success.
   */
  private async reconcileEndpointProvider(operation: ImageOperation, provider: OperationEndpointProvider): Promise<void> {
    this.endpointProviderPending = true;
    this.setLocalTracker(operation, 'updating');
    try {
      // One lifecycle deadline covers the marker, the ack and the verdict. It is
      // measured from the claim so a process that restarts late does not grant
      // the helper a fresh lifetime, and never ends before the helper's own
      // bounds have elapsed.
      const deadline = this.endpointProviderDeadline(operation);
      let outcome = await this.readProviderOutcome(operation);
      if (!outcome) {
        const phase = await this.waitForProviderPhase(operation, deadline);
        if (phase.kind === 'outcome') {
          outcome = phase.outcome;
        } else if (phase.kind === 'recreated') {
          const ack = await this.verifyDockerThroughProvider(operation, provider);
          await this.writeProviderAck(operation, ack);
          outcome = await this.waitForProviderOutcome(operation, deadline);
        }
        // `timeout`: neither marker nor verdict, so the old provider must not be
        // acknowledged as the replacement. The absent outcome below is terminal.
      }
      await this.finalizeEndpointProvider(operation, outcome);
    } catch (error) {
      // An unexpected throw must not leave the node "verifying" forever. The
      // claim is held while the helper can still mutate and reconciliation
      // continues; the terminal failure is recorded only once it is gone.
      console.error('[ImageOperation] Docker endpoint startup reconcile failed:', error);
      const current = await this.getCurrentOperation().catch(() => null);
      if (!current || current.operationId !== operation.operationId || !NON_TERMINAL_STATES.includes(current.state)) {
        this.endpointProviderPending = false;
        return;
      }
      await this.failEndpointProviderOperation(
        current,
        'endpoint_provider_recovery_required',
        this.endpointProviderFailureText(current, 'while Sencho was verifying it', error),
      ).catch(writeError => {
        console.error('[ImageOperation] Could not settle the Docker endpoint failure:', writeError);
      });
    }
  }

  /**
   * In the process that stays alive (provider-only): the helper recreates only
   * the endpoint container, so nothing restarts this Sencho. Wait for the
   * helper's durable phase marker, prove Docker answers through the replacement,
   * answer the helper, then wait for its verdict. Nothing is reported successful
   * before that verdict.
   */
  private reconcileInPlaceEndpointProvider(operation: ImageOperation, provider: OperationEndpointProvider): void {
    void (async () => {
      this.endpointProviderPending = true;
      this.setLocalTracker(operation, 'updating');
      const deadline = Date.now() + this.endpointProviderTimings.watchMs;
      const phase = await this.waitForProviderPhase(operation, deadline);
      if (phase.kind === 'outcome') {
        await this.finalizeEndpointProvider(operation, phase.outcome);
        return;
      }
      if (phase.kind === 'recreated') {
        const ack = await this.verifyDockerThroughProvider(operation, provider);
        await this.writeProviderAck(operation, ack);
      }
      // No marker: the replacement may not exist yet, so nothing is answered.
      // The helper's own deadline decides, and its outcome carries the verdict.
      const outcome = await this.waitForProviderOutcome(operation, deadline);
      await this.finalizeEndpointProvider(operation, outcome);
    })().catch(async error => {
      // An unexpected throw must not leave the operation held silently: keep
      // reconciling while the helper can still mutate, then record the
      // recovery state the operator can act on.
      console.error('[ImageOperation] Docker endpoint in-place reconcile failed:', error);
      const current = await this.getCurrentOperation().catch(() => null);
      if (!current || current.operationId !== operation.operationId || !NON_TERMINAL_STATES.includes(current.state)) {
        this.endpointProviderPending = false;
        return;
      }
      await this.failEndpointProviderOperation(
        current,
        'endpoint_provider_recovery_required',
        this.endpointProviderFailureText(current, 'while Sencho was verifying it', error),
      ).catch(writeError => {
        console.error('[ImageOperation] Could not settle the Docker endpoint failure:', writeError);
      });
    });
  }

  /** Writes the helper's ack file; a write failure is logged and left to the helper's deadline. */
  private async writeProviderAck(operation: ImageOperation, ack: ProviderAck): Promise<void> {
    try {
      const ackFile = helperFiles.ack(this.dataDir(), operation.operationId);
      await fs.mkdir(path.dirname(ackFile), { recursive: true, mode: 0o700 });
      await this.atomicWrite(ackFile, JSON.stringify(ack));
    } catch (error) {
      console.error('[ImageOperation] Could not answer the Docker endpoint helper:', error);
    }
  }

  /**
   * Absolute deadline for an operation's helper. A fresh claim grants the
   * staging bound plus the helper's whole lifetime; a process that restarts
   * only gets what remains of that window. Test timings may shorten it, never
   * lengthen it past the helper's own bounds.
   */
  private endpointProviderDeadline(operation: ImageOperation): number {
    const now = Date.now();
    const configured = this.endpointProviderTimings.outcomeMs;
    const started = Date.parse(operation.startedAt);
    if (!Number.isFinite(started)) return now + configured;
    // A Community Update pulls Sencho's image before staging; a Reapply has no
    // pull. The window starts at the claim, so it includes whichever applies.
    const pullAllowance = operation.kind === 'community_update' ? SELF_UPDATE_PULL_TIMEOUT_MS : 0;
    const remaining = started + pullAllowance + ENDPOINT_PROVIDER_STAGE_TIMEOUT_MS
      + ENDPOINT_PROVIDER_LAUNCH_TIMEOUT_MS + ENDPOINT_PROVIDER_HELPER_MAX_LIFETIME_MS + 60_000 - now;
    return now + Math.max(0, Math.min(configured, remaining));
  }

  /**
   * True only when Docker conclusively shows no helper for this operation that
   * can still run. An unreadable answer is never treated as terminated.
   */
  private async helperHasTerminated(operation: ImageOperation): Promise<boolean> {
    if (operation.helperLabelVersion !== 1) {
      // Compatibility record from a build before the helper label existed but
      // after the helper was named deterministically. The name is the only
      // evidence available; a live container with that name blocks release.
      const helperName = endpointProviderHelperName(operation.operationId);
      try {
        const docker = DockerController.getInstance().getDocker();
        const containers = await this.boundedDockerCall(
          'Docker helper list',
          Date.now() + this.endpointProviderTimings.requestMs,
          signal => docker.listContainers({
            all: true,
            abortSignal: signal,
            filters: { name: [helperName] },
          }),
        );
        return !containers.some(container =>
          (container.Names ?? []).some(name => name.replace(/^\//, '') === helperName)
          && container.State !== 'exited'
          && container.State !== 'dead');
      } catch {
        try {
          DockerController.getInstance().resetDockerConnection();
        } catch {
          // DockerController itself may be unavailable in a torn-down process.
        }
        return false;
      }
    }
    try {
      const docker = DockerController.getInstance().getDocker();
      const containers = await this.boundedDockerCall(
        'Docker helper list',
        Date.now() + this.endpointProviderTimings.requestMs,
        signal => docker.listContainers({
          all: true,
          abortSignal: signal,
          filters: {
            label: [
              'io.sencho.helper=endpoint-provider',
              `io.sencho.operation=${operation.operationId}`,
            ],
          },
        }),
      );
      // `created` is about to run; exited/dead cannot mutate any more. `--rm`
      // helpers disappear entirely once they exit.
      return !containers.some(container => container.State !== 'exited' && container.State !== 'dead');
    } catch {
      // Docker may not be reachable through the replacement yet (the cached
      // client still points at the container that was just replaced). Drop it
      // and keep waiting; the next poll dials the current provider.
      try {
        DockerController.getInstance().resetDockerConnection();
      } catch {
        // DockerController itself may be unavailable in a torn-down process.
      }
      return false;
    }
  }

  /**
   * Waits for either the helper's durable phase marker (the provider exists) or
   * its outcome. A timeout is kept distinct: without the marker there is nothing
   * to verify yet, and answering would let a stalled recreate pass as a success.
   * The helper's disappearance without a verdict also ends the wait.
   */
  private async waitForProviderPhase(
    operation: ImageOperation,
    deadline: number,
  ): Promise<{ kind: 'outcome'; outcome: ProviderOutcome } | { kind: 'recreated' } | { kind: 'timeout' }> {
    for (;;) {
      const outcome = await this.readProviderOutcome(operation);
      if (outcome) return { kind: 'outcome', outcome };
      if (await this.providerWasRecreated(operation)) return { kind: 'recreated' };
      if (await this.helperHasTerminated(operation)) return { kind: 'timeout' };
      if (Date.now() >= deadline) return { kind: 'timeout' };
      await new Promise(resolve => setTimeout(resolve, this.endpointProviderTimings.pollMs));
    }
  }

  private async providerWasRecreated(operation: ImageOperation): Promise<boolean> {
    try {
      const raw: unknown = JSON.parse(await fs.readFile(helperFiles.recreated(this.dataDir(), operation.operationId), 'utf8'));
      return !!raw && typeof raw === 'object' && (raw as { operationId?: unknown }).operationId === operation.operationId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[ImageOperation] Failed to read the Docker endpoint phase marker:', error);
      }
      return false;
    }
  }

  /** Retries Docker through the new provider until it answers and the provider container is running and healthy. */
  private async verifyDockerThroughProvider(
    operation: ImageOperation,
    provider: OperationEndpointProvider,
    verifyMs = this.endpointProviderTimings.verifyMs,
  ): Promise<ProviderAck> {
    const deadline = Date.now() + verifyMs;
    let detail: string;
    // The endpoint container was just recreated: a pooled connection from the
    // previous one is dead, so start from a fresh client instead of waiting for
    // a request to fail against a stale socket. The controller itself may be
    // unavailable in a torn-down process; that is a failed verification, not an
    // exception that can escape the finalizer.
    try {
      DockerController.getInstance().resetDockerConnection();
    } catch (error) {
      console.warn('[ImageOperation] Could not reset the Docker client before verification:', getErrorMessage(error, 'unavailable'));
    }
    for (;;) {
      try {
        const docker = DockerController.getInstance().getDocker();
        await this.boundedDockerCall(
          'Docker ping',
          deadline,
          // dockerode forwards an abortSignal to ping, but its type has no options overload.
          signal => (docker.ping as unknown as (options: { abortSignal: AbortSignal }) => Promise<unknown>)({ abortSignal: signal }),
        );
        const containers = await this.boundedDockerCall('Docker container list', deadline, signal => docker.listContainers({
          all: true,
          abortSignal: signal,
          filters: { label: [`com.docker.compose.project=${provider.project}`, `com.docker.compose.service=${provider.service}`] },
        }));
        const running = containers.find(container => container.State === 'running');
        if (!running) {
          detail = `"${provider.service}" is not running`;
        } else {
          const health = (await this.boundedDockerCall(
            'Docker inspect',
            deadline,
            signal => docker.getContainer(running.Id).inspect({ abortSignal: signal }),
          )).State?.Health?.Status;
          if (!health || health === 'healthy') return { operationId: operation.operationId, ok: true, detail: null };
          detail = `"${provider.service}" healthcheck is ${health}`;
        }
      } catch (error) {
        detail = `Docker did not answer through "${provider.service}": ${plainText(getErrorMessage(error, 'request failed'))}`;
      }
      if (Date.now() >= deadline) return { operationId: operation.operationId, ok: false, detail };
      await new Promise(resolve => setTimeout(resolve, this.endpointProviderTimings.pollMs));
    }
  }

  /**
   * Runs one Docker request with the remaining verification budget as its
   * ceiling. The abort signal destroys a request that accepted the connection
   * but never answered, and the cached client is dropped so the next attempt
   * dials a new connection.
   */
  private async boundedDockerCall<T>(
    label: string,
    deadline: number,
    call: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const remaining = deadline - Date.now();
    const timeoutMs = Math.min(Math.max(1, remaining), this.endpointProviderTimings.requestMs);
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await withRequestTimeout(call(controller.signal), timeoutMs, label);
    } catch (error) {
      // The abort can reject the request before the race's own timer runs; report
      // and treat both as the same bounded timeout.
      if (controller.signal.aborted) {
        DockerController.getInstance().resetDockerConnection();
        throw error instanceof DockerRequestTimeoutError
          ? error
          : new DockerRequestTimeoutError(`${label} did not answer within ${timeoutMs} ms`);
      }
      throw error;
    } finally {
      clearTimeout(abortTimer);
    }
  }

  private async readProviderOutcome(operation: ImageOperation): Promise<ProviderOutcome | null> {
    try {
      const raw: unknown = JSON.parse(await fs.readFile(helperFiles.outcome(this.dataDir(), operation.operationId), 'utf8'));
      return parseOutcome(raw, operation.operationId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[ImageOperation] Failed to read the Docker endpoint outcome:', error);
      }
      return null;
    }
  }

  private async waitForProviderOutcome(operation: ImageOperation, deadline: number): Promise<ProviderOutcome | null> {
    for (;;) {
      const outcome = await this.readProviderOutcome(operation);
      if (outcome) return outcome;
      // The caller settles the result and re-reads the verdict after seeing
      // the helper gone; a null here is not yet the final answer.
      if (await this.helperHasTerminated(operation)) return null;
      if (Date.now() >= deadline) return null;
      await new Promise(resolve => setTimeout(resolve, this.endpointProviderTimings.pollMs));
    }
  }

  /** Persists the helper's verdict (or its absence) and mirrors it on the Fleet tracker and the update error. */
  private async finalizeEndpointProvider(
    operation: ImageOperation,
    outcome: ProviderOutcome | null,
    missingCause?: string,
  ): Promise<void> {
    // A deadline is not termination evidence. Without a verdict the claim may
    // only be released once Docker conclusively shows no labelled helper for
    // this operation can run any more; until then this keeps reconciling and a
    // second operation stays refused.
    if (!outcome) {
      if (await this.helperHasTerminated(operation)) {
        // The helper writes its verdict with an atomic rename before it exits.
        // A poll can read just before that write and then observe the helper
        // gone, so the settlement looks once more before deciding there is no
        // verdict.
        outcome = await this.readProviderOutcome(operation);
      } else {
        this.endpointProviderPending = true;
        console.warn('[ImageOperation] Docker endpoint helper still active; keeping the operation claim while it finishes');
        outcome = await this.awaitEndpointProviderMutationEnd(operation);
        if (!outcome) {
          // The wait also ends on termination; the rename may have landed
          // between the last poll and the check that saw the helper gone.
          outcome = await this.readProviderOutcome(operation);
        }
      }
    }
    const current = await this.getCurrentOperation();
    if (!current || current.operationId !== operation.operationId || !NON_TERMINAL_STATES.includes(current.state)) {
      this.endpointProviderPending = false;
      return;
    }
    const service = operation.endpointProvider?.service ?? 'the Docker endpoint';
    if (outcome?.ok) {
      current.state = 'succeeded';
      current.resolvedAt = new Date().toISOString();
      await this.persist(current);
      // Publish the completion stamp (used by a remote hub for a provider-only
      // replacement) only after the terminal state is durable.
      this.endpointProviderCompletedAt = Date.now();
      // Only release the claim once the terminal state is durable.
      this.endpointProviderPending = false;
      await this.cleanupOperationArtifacts(current);
      await fs.rm(path.dirname(helperFiles.plan(this.dataDir(), current.operationId)), { recursive: true, force: true })
        .catch(error => console.error('[ImageOperation] Failed to clean the Docker endpoint handoff files:', error));
      this.setLocalTracker(current, 'completed');
      console.log(`[ImageOperation] Docker endpoint "${service}" replaced and verified`);
      return;
    }
    const rollback = outcome?.rollback;
    const rollbackAttempted = rollback?.attempted === true;
    const helperRestored = rollback?.attempted === true && rollback.restored === true;
    let restored = helperRestored;
    const provider = operation.endpointProvider;
    // The helper proved the restored container runs. Whoever is finalizing can
    // also prove Sencho reaches Docker through it: the process that stayed
    // alive for an endpoint-only replace, the process that spawned the helper
    // when Sencho was never recreated, or the restarted process for a shared
    // one. Scope does not decide whether the connectivity claim is checked.
    let restoreDetail: string | null = null;
    if (helperRestored && provider) {
      const reachable = await this.verifyDockerThroughProvider(operation, provider, this.endpointProviderTimings.recoveryMs);
      if (!reachable.ok) {
        restored = false;
        restoreDetail = reachable.detail;
      }
    }
    const failureCode: FailureCode = restored
      ? 'endpoint_provider_restored'
      : outcome && !rollbackAttempted
        ? 'update_failed'
        : 'endpoint_provider_recovery_required';
    const cause = plainText(outcome?.error ?? missingCause ?? 'The replacement helper did not report an outcome in time.');
    const helperLogPath = path.dirname(helperFiles.plan('', current.operationId)).replace(/^\//, '');
    const recoveryHint = `Sencho may not reach Docker on this node until "${service}" runs again: on the host, run "docker compose up -d ${service}" in Sencho's Compose project directory, then check Fleet. The helper log is in the Sencho data directory under ${helperLogPath}.`;
    let detail: string;
    if (restored) {
      detail = `Replacing the Docker endpoint "${service}" failed: ${cause} The previous "${service}" container was restored and Sencho reaches Docker again. Fix the Compose configuration of "${service}", then run Reapply again.`;
    } else if (helperRestored) {
      detail = `Replacing the Docker endpoint "${service}" failed: ${cause} The previous "${service}" container was restored, but Sencho could not reach Docker through it (${restoreDetail ?? 'no detail'}). Check that service and its host socket on that node. ${recoveryHint}`;
    } else if (rollback?.attempted) {
      detail = `Replacing the Docker endpoint "${service}" failed: ${cause} The previous container could not be restored${rollback.error ? ` (${rollback.error})` : ''}. ${recoveryHint}`;
    } else if (outcome) {
      detail = `Replacing the Docker endpoint "${service}" did not start: ${cause} The previous "${service}" container was not touched by the helper. Check the Compose configuration and the helper log in the Sencho data directory under ${helperLogPath}, then try again.`;
    } else {
      detail = `The replacement helper did not report an outcome in time, so Sencho cannot confirm whether "${service}" was replaced or restored. Check that service and its host socket on that node. The helper log is in the Sencho data directory under ${helperLogPath}.`;
    }
    current.rollback = rollback?.attempted
      ? { attempted: true, restored, error: rollback.error }
      : { attempted: false };
    SelfUpdateService.getInstance().recordUpdateFailure(detail, failureCode);
    console.error('[ImageOperation] Docker endpoint replacement failed:', detail);
    await this.fail(current, failureCode, detail);
    this.setLocalTracker(current, 'failed', detail);
  }

  /** Mirrors a Docker endpoint replacement on the local node's Fleet tracker, which a restart otherwise empties. */
  private setLocalTracker(operation: ImageOperation, status: 'updating' | 'completed' | 'failed', error?: string): void {
    try {
      const local = DatabaseService.getInstance().getNodes().find(node => node.type === 'local');
      if (!local) return;
      const trackers = FleetUpdateTrackerService.getInstance();
      const kind = operation.kind === 'compose_reapply' ? 'reapply_configuration' : 'update';
      // Keep the seam that tells the tracker sweep this operation may outlive
      // the five-minute update ceiling. This row replaces the one the route
      // created, so dropping the flag would re-enable the early timeout.
      const endpointProviderPending = operation.endpointProvider !== undefined;
      const live = trackers.get(local.id);
      if (status === 'updating') {
        trackers.set(local.id, trackers.create(
          'updating', getSenchoVersion(), null, undefined, undefined, kind, endpointProviderPending,
        ));
      } else if (live?.status === 'updating') {
        trackers.set(local.id, trackers.resolve(live, status, error));
      } else {
        trackers.set(local.id, trackers.create(
          status, getSenchoVersion(), null, error, undefined, kind, endpointProviderPending,
        ));
      }
    } catch (trackerError) {
      console.error('[ImageOperation] Could not update the local Fleet tracker:', trackerError);
    }
  }

  private watchHelperExit(operation: ImageOperation): void {
    SelfUpdateService.getInstance().onceHelperExit((error) => {
      // Surviving the helper callback means recreate did not take over; treat
      // a null payload the same as an explicit survival failure.
      const exitError = error ?? 'Helper container exited without restarting Sencho';
      void (async () => {
        const current = await this.getCurrentOperation();
        if (!current || current.operationId !== operation.operationId) return;
        if (!['pending_pull', 'pulling', 'patching', 'recreating'].includes(current.state)) return;
        console.error('[ImageOperation] Helper exit while operation active:', exitError);
        await this.fail(current, 'update_failed');
      })().catch((listenerError) => {
        console.error('[ImageOperation] Helper exit terminalization failed:', listenerError);
      });
    });
  }

  private async claimComposeOperation(
    kind: 'community_update' | 'compose_reapply',
    targetImageRef: string | null,
    choice: EndpointProviderClaim,
  ): Promise<ClaimResult> {
    const selfUpdate = SelfUpdateService.getInstance();
    let endpointProvider: OperationEndpointProvider | undefined;
    if (choice.replace) {
      const option = await selfUpdate.getEndpointProviderOption();
      const project = selfUpdate.getComposeProject();
      if (option.state !== 'available' || !project) {
        return {
          ok: false,
          failureCode: 'endpoint_provider_unavailable',
          reason: option.state === 'unavailable'
            ? option.reason
            : 'Sencho does not reach Docker through a container on this node, so there is no Docker endpoint to recreate.',
        };
      }
      endpointProvider = {
        project,
        service: option.service,
        containerName: option.containerName,
        scope: choice.only ? 'provider' : 'stack',
      };
    }
    const resolved = await selfUpdate.getResolvedComposeImageForUpdate();
    const operation = this.newOperation(
      kind,
      resolved?.imageRef ?? null,
      targetImageRef,
      resolved?.filePath ?? null,
      selfUpdate.getComposeServiceName(),
    );
    if (endpointProvider) {
      operation.endpointProvider = endpointProvider;
      // The helper is launched with `io.sencho.operation=<id>`, so reconciliation
      // can distinguish "still running" from "gone without a verdict".
      operation.helperLabelVersion = 1;
    }
    if (!await this.tryClaim(operation)) {
      return { ok: false, failureCode: 'IMAGE_OPERATION_IN_FLIGHT' };
    }
    // Disk non-terminal state is the concurrency lock; clear the in-memory mutex
    // so a later claim can observe the persisted pending operation.
    this.claimed = false;
    return { ok: true };
  }

  private async getActiveClaimedOperation(kind: ImageOperationKind): Promise<ImageOperation | null> {
    const operation = await this.getCurrentOperation();
    if (!operation || operation.kind !== kind) return null;
    if (!['pending_pull', 'pulling', 'patching', 'recreating'].includes(operation.state)) return null;
    return operation;
  }

  private newOperation(kind: ImageOperationKind, previousImageRef: string | null, targetImageRef: string | null, composeFilePath: string | null, serviceName: string | null, preflightFingerprint?: string): ImageOperation {
    return {
      schemaVersion: 1,
      operationId: crypto.randomUUID(),
      kind,
      state: 'pending_pull',
      previousImageRef,
      targetImageRef,
      composeFilePath,
      serviceName,
      startedAt: new Date().toISOString(),
      rollback: { attempted: false },
      ...(preflightFingerprint ? { preflightFingerprint } : {}),
    };
  }

  private async tryClaim(operation: ImageOperation): Promise<boolean> {
    if (this.claimed) return false;
    this.claimed = true;
    try {
      const current = await this.getCurrentOperation();
      if (current && ['pending_pull', 'pulling', 'patching', 'recreating'].includes(current.state)) {
        this.claimed = false;
        return false;
      }
      await this.removeLegacySuccessMarkers();
      await this.persist(operation);
      return true;
    } catch (error) {
      this.claimed = false;
      throw error;
    }
  }

  private enqueueStateWrite<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.stateWriteQueue.then(fn, fn);
    this.stateWriteQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async fail(operation: ImageOperation, failureCode: FailureCode, detail?: string): Promise<void> {
    operation.state = 'failed';
    operation.failureCode = failureCode;
    if (detail) operation.failureDetail = detail;
    operation.resolvedAt = new Date().toISOString();
    await this.persist(operation);
    // Release the claim only after the terminal state is durable, so a write
    // failure leaves the on-disk non-terminal operation blocking new claims.
    if (operation.endpointProvider) this.endpointProviderPending = false;
    await this.cleanupOperationArtifacts(operation);
  }

  private async persist(operation: ImageOperation): Promise<void> {
    await this.enqueueStateWrite(async () => {
      const current = await this.readOperation(this.currentFile());
      const incomingTerminal = operation.state === 'failed' || operation.state === 'succeeded';
      const currentTerminal = current?.state === 'failed' || current?.state === 'succeeded';
      // Do not let a late non-terminal write (e.g. recreating) overwrite a
      // concurrent helper-exit failure for the same operation.
      if (
        current
        && current.operationId === operation.operationId
        && currentTerminal
        && !incomingTerminal
      ) {
        return;
      }
      const filePath = this.operationFile(operation.operationId);
      if (!filePath) throw new Error('Invalid image operation id');
      await fs.mkdir(this.operationsDir(), { recursive: true, mode: 0o700 });
      await this.atomicWrite(filePath, JSON.stringify(operation));
      await this.atomicWrite(this.currentFile(), JSON.stringify(operation));
    });
  }

  private async readOperation(filePath: string): Promise<ImageOperation | null> {
    try {
      return JSON.parse(await fs.readFile(filePath, 'utf8')) as ImageOperation;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
      console.error(`[ImageOperation] Failed to read operation (${code})`);
      return null;
    }
  }

  private async atomicWrite(filePath: string, content: string): Promise<void> {
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, filePath);
    await fs.chmod(filePath, 0o600);
  }

  private async writeDockerConfig(
    operationId: string,
    config: { auths?: Record<string, { auth?: string }> },
  ): Promise<string> {
    const configDir = this.resolveUnderBase(path.join(this.dataDir(), 'image-op-docker'), operationId);
    if (!configDir) throw new Error('Invalid image operation id');
    await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
    await fs.chmod(configDir, 0o700);
    // Allowlist-copy host keys and base64 auth tokens, then build JSON locally so
    // the on-disk DOCKER_CONFIG payload is not a direct write of network data.
    const parts: string[] = [];
    for (const [host, entry] of Object.entries(config.auths ?? {})) {
      const safeHost = this.allowlistedRegistryHostKey(host);
      const safeAuth = entry?.auth ? this.allowlistedBase64(entry.auth) : null;
      if (!safeHost || !safeAuth) continue;
      parts.push(`${JSON.stringify(safeHost)}:${JSON.stringify({ auth: safeAuth })}`);
    }
    const payload = `{"auths":{${parts.join(',')}}}`;
    await this.atomicWrite(path.join(configDir, 'config.json'), payload);
    return configDir;
  }

  /** Copy a Docker auth host key char-by-char through an allowlist. */
  private allowlistedRegistryHostKey(host: string): string | null {
    if (host.length === 0 || host.length > 512) return null;
    let out = '';
    for (let i = 0; i < host.length; i++) {
      const code = host.charCodeAt(i);
      const ok =
        (code >= 48 && code <= 57)
        || (code >= 65 && code <= 90)
        || (code >= 97 && code <= 122)
        || code === 43 || code === 45 || code === 46
        || code === 47 || code === 58 || code === 95;
      if (!ok) return null;
      out += String.fromCharCode(code);
    }
    return out;
  }

  /** Copy a base64 auth token char-by-char through an allowlist. */
  private allowlistedBase64(value: string): string | null {
    if (value.length === 0 || value.length > 8192) return null;
    let out = '';
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      const ok =
        (code >= 48 && code <= 57)
        || (code >= 65 && code <= 90)
        || (code >= 97 && code <= 122)
        || code === 43 || code === 47 || code === 61;
      if (!ok) return null;
      out += String.fromCharCode(code);
    }
    return out;
  }

  private async getRegistryAccess(registryHost: string, packageScope: string): Promise<LocalRegistryAccess> {
    try {
      const config = await RegistryService.getInstance().resolveDockerConfigForHost(registryHost);
      const auth = Object.values(config.config.auths)[0]?.auth;
      if (!auth) return 'missing';
      const decoded = Buffer.from(auth, 'base64').toString('utf8');
      const delimiter = decoded.indexOf(':');
      if (delimiter === -1) return 'rejected';
      const credentials = {
        username: decoded.slice(0, delimiter),
        password: decoded.slice(delimiter + 1),
      };
      const token = await getAuthToken(registryHost, packageScope, credentials);
      const headers: Record<string, string> = {
        Accept: 'application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json',
        Authorization: token
          ? `Bearer ${token}`
          : `Basic ${auth}`,
      };
      const manifestUrl = `https://${registryHost}/v2/${packageScope}/manifests/latest`;
      let response = await httpRequest(manifestUrl, 'HEAD', headers);
      if (response.statusCode === 405 || response.statusCode === 501) {
        response = await httpRequest(manifestUrl, 'GET', headers);
      }
      return response.statusCode === 200 ? 'ready' : 'rejected';
    } catch {
      console.warn('[ImageOperation] Registry package probe failed');
      return 'rejected';
    }
  }

  private dataDir(): string {
    return process.env.DATA_DIR || '/app/data';
  }

  private operationsDir(): string {
    return path.join(this.dataDir(), 'image-operations');
  }

  /** Resolve a path under baseDir; null if operationId is invalid or escapes the base. */
  private resolveUnderBase(baseDir: string, operationId: string): string | null {
    if (!ImageOperationService.isOperationId(operationId)) return null;
    const base = path.resolve(baseDir);
    const candidate = path.resolve(base, operationId);
    if (candidate !== base && !candidate.startsWith(base + path.sep)) return null;
    return candidate;
  }

  private operationFile(operationId: string): string | null {
    if (!ImageOperationService.isOperationId(operationId)) return null;
    const base = path.resolve(this.operationsDir());
    const candidate = path.resolve(base, `${operationId}.json`);
    if (!candidate.startsWith(base + path.sep)) return null;
    return candidate;
  }

  private currentFile(): string {
    return path.join(this.dataDir(), 'image-operation-current.json');
  }

  private successMarkerFile(operation: ImageOperation): string {
    if (!ImageOperationService.isOperationId(operation.operationId)) {
      throw new Error('Invalid image operation id');
    }
    return path.join(this.dataDir(), `image-op-success-${operation.operationId}.json`);
  }

  private async removeLegacySuccessMarkers(): Promise<void> {
    await Promise.all([
      fs.rm(path.join(this.dataDir(), 'image-op-success.json'), { force: true }),
      fs.rm(path.join(this.dataDir(), 'hardened-switch-success.json'), { force: true }),
    ]);
  }

  private async cleanupOperationArtifacts(operation: ImageOperation): Promise<void> {
    try {
      const dockerDir = this.resolveUnderBase(path.join(this.dataDir(), 'image-op-docker'), operation.operationId);
      await Promise.all([
        dockerDir ? fs.rm(dockerDir, { recursive: true, force: true }) : Promise.resolve(),
        fs.rm(this.successMarkerFile(operation), { force: true }),
      ]);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
      console.error(`[ImageOperation] Failed to clean operation artifacts (${code})`);
    }
  }

  private async isSuccessMarkerForOperation(markerPath: string, operationId: string): Promise<boolean> {
    try {
      const marker: unknown = JSON.parse(await fs.readFile(markerPath, 'utf8'));
      return typeof marker === 'object'
        && marker !== null
        && 'operationId' in marker
        && marker.operationId === operationId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[ImageOperation] Failed to read success marker:', error);
      }
      return false;
    }
  }
}
