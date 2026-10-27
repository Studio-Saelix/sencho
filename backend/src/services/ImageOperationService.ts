import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import SelfUpdateService, { PROVIDER_ACK_SECONDS, PROVIDER_READY_SECONDS } from './SelfUpdateService';
import DockerController from './DockerController';
import { DatabaseService } from './DatabaseService';
import { FleetUpdateTrackerService } from './FleetUpdateTrackerService';
import { getSenchoVersion } from './CapabilityRegistry';
import { helperFiles, parseOutcome, type ProviderAck, type ProviderOutcome } from '../helpers/endpointProviderReplace';
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
}

export type ClaimResult =
  | { ok: true }
  | { ok: false; failureCode: 'IMAGE_OPERATION_IN_FLIGHT' }
  | { ok: false; failureCode: 'endpoint_provider_unavailable'; reason: string };

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
  /** Whether a failed Docker endpoint replacement put the previous container back. */
  rollback: { attempted: false } | { attempted: true; restored: boolean; error: string | null };
  preflightFingerprint?: string;
  /** Set when the operation also recreates the container carrying this node's Docker API. */
  endpointProvider?: OperationEndpointProvider;
}

export type HardenedPreflight =
  | { ok: true; preflightFingerprint: string; currentImageRef: string; allowedImageRef: string; composeFilePath: string; pinKind: ImagePinKind; localRegistryAccess: LocalRegistryAccess }
  | { ok: false; code: FailureCode | 'entitlement_denied' };

const OPERATION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const NON_TERMINAL_STATES: ReadonlyArray<ImageOperationState> = ['pending_pull', 'pulling', 'patching', 'recreating'];

export class ImageOperationService {
  private static instance: ImageOperationService;
  private claimed = false;
  private stateWriteQueue: Promise<void> = Promise.resolve();
  /** True while this process runs or reconciles a Docker endpoint replacement. */
  private endpointProviderPending = false;
  /**
   * Bounds for a Docker endpoint replacement, in milliseconds. `verify` is how
   * long a new process retries Docker through the new provider before it
   * answers the helper; `outcome` is how long it then waits for the helper's
   * verdict; `watch` is how long the process that spawned the helper waits.
   * Overridden in tests.
   */
  public endpointProviderTimings = {
    pollMs: 2_000,
    verifyMs: 90_000,
    outcomeMs: 180_000,
    watchMs: (PROVIDER_READY_SECONDS * 2 + PROVIDER_ACK_SECONDS + 120) * 1000,
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
    return this.claimComposeOperation('community_update', options?.targetVersion ?? null, options?.replaceEndpointProvider === true);
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
      await this.fail(operation, 'update_failed');
      return { ok: false, failureCode: 'update_failed' };
    }
  }

  public async runCommunityUpdate(options?: { targetVersion?: string }): Promise<{ ok: boolean; failureCode?: string }> {
    const claim = await this.claimCommunityUpdate(options);
    if (!claim.ok) return claim;
    return this.executeClaimedCommunityUpdate(options);
  }

  public async claimComposeReapply(options?: { replaceEndpointProvider?: boolean }): Promise<ClaimResult> {
    return this.claimComposeOperation('compose_reapply', null, options?.replaceEndpointProvider === true);
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
      if (operation.endpointProvider) this.watchEndpointProviderOutcome(operation);
      return { ok: true };
    } catch (error) {
      console.error('[ImageOperation] Compose reapply failed:', error);
      await this.fail(operation, 'update_failed');
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
    return this.endpointProviderPending;
  }

  public async reconcileOnStartup(): Promise<void> {
    const operation = await this.getCurrentOperation();
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
    const detail = operation.endpointProvider ? SelfUpdateService.getInstance().getLastError() ?? undefined : undefined;
    await this.fail(operation, 'update_failed', detail);
  }

  private endpointProviderRequest(operation: ImageOperation, provider: OperationEndpointProvider) {
    return {
      operationId: operation.operationId,
      service: provider.service,
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
      const outcome = await this.waitForProviderOutcome(operation, this.endpointProviderTimings.watchMs);
      await this.finalizeEndpointProvider(operation, outcome);
    })().catch(error => {
      console.error('[ImageOperation] Docker endpoint outcome watch failed:', error);
    });
  }

  /**
   * In the new process after Sencho was recreated: check Docker through the
   * new provider, answer the helper (its ack), then wait for the helper's
   * verdict. Only a positive verdict marks the operation succeeded.
   */
  private async reconcileEndpointProvider(operation: ImageOperation, provider: OperationEndpointProvider): Promise<void> {
    this.endpointProviderPending = true;
    this.setLocalTracker(operation, 'updating');
    let outcome = await this.readProviderOutcome(operation);
    if (!outcome) {
      const ack = await this.verifyDockerThroughProvider(operation, provider);
      try {
        const ackFile = helperFiles.ack(this.dataDir(), operation.operationId);
        await fs.mkdir(path.dirname(ackFile), { recursive: true, mode: 0o700 });
        await this.atomicWrite(ackFile, JSON.stringify(ack));
      } catch (error) {
        console.error('[ImageOperation] Could not answer the Docker endpoint helper:', error);
      }
      outcome = await this.waitForProviderOutcome(operation, this.endpointProviderTimings.outcomeMs);
    }
    await this.finalizeEndpointProvider(operation, outcome);
  }

  /** Retries Docker through the new provider until it answers and the provider container is running and healthy. */
  private async verifyDockerThroughProvider(operation: ImageOperation, provider: OperationEndpointProvider): Promise<ProviderAck> {
    const deadline = Date.now() + this.endpointProviderTimings.verifyMs;
    let detail: string;
    for (;;) {
      try {
        const docker = DockerController.getInstance().getDocker();
        await docker.ping();
        const containers = await docker.listContainers({
          all: true,
          filters: { label: [`com.docker.compose.project=${provider.project}`, `com.docker.compose.service=${provider.service}`] },
        });
        const running = containers.find(container => container.State === 'running');
        if (!running) {
          detail = `"${provider.service}" is not running`;
        } else {
          const health = (await docker.getContainer(running.Id).inspect()).State?.Health?.Status;
          if (!health || health === 'healthy') return { operationId: operation.operationId, ok: true, detail: null };
          detail = `"${provider.service}" healthcheck is ${health}`;
        }
      } catch (error) {
        detail = `Docker did not answer through "${provider.service}": ${getErrorMessage(error, 'request failed')}`;
      }
      if (Date.now() >= deadline) return { operationId: operation.operationId, ok: false, detail };
      await new Promise(resolve => setTimeout(resolve, this.endpointProviderTimings.pollMs));
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

  private async waitForProviderOutcome(operation: ImageOperation, timeoutMs: number): Promise<ProviderOutcome | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const outcome = await this.readProviderOutcome(operation);
      if (outcome || Date.now() >= deadline) return outcome;
      await new Promise(resolve => setTimeout(resolve, this.endpointProviderTimings.pollMs));
    }
  }

  /** Persists the helper's verdict (or its absence) and mirrors it on the Fleet tracker and the update error. */
  private async finalizeEndpointProvider(operation: ImageOperation, outcome: ProviderOutcome | null): Promise<void> {
    const current = await this.getCurrentOperation();
    if (!current || current.operationId !== operation.operationId || !NON_TERMINAL_STATES.includes(current.state)) {
      this.endpointProviderPending = false;
      return;
    }
    const service = operation.endpointProvider?.service ?? 'the Docker endpoint';
    if (outcome?.ok) {
      current.state = 'succeeded';
      current.resolvedAt = new Date().toISOString();
      this.endpointProviderPending = false;
      await this.persist(current);
      await this.cleanupOperationArtifacts(current);
      await fs.rm(path.dirname(helperFiles.plan(this.dataDir(), current.operationId)), { recursive: true, force: true })
        .catch(error => console.error('[ImageOperation] Failed to clean the Docker endpoint handoff files:', error));
      this.setLocalTracker(current, 'completed');
      console.log(`[ImageOperation] Docker endpoint "${service}" replaced and verified`);
      return;
    }
    const restored = outcome?.rollback.restored === true;
    const failureCode: EndpointProviderFailureCode = restored ? 'endpoint_provider_restored' : 'endpoint_provider_recovery_required';
    const cause = outcome?.error ?? 'The replacement helper did not report an outcome in time.';
    const detail = restored
      ? `Replacing the Docker endpoint "${service}" failed: ${cause} The previous "${service}" container was restored and Sencho reaches Docker again. Fix the Compose configuration of "${service}", then run Reapply again.`
      : `Replacing the Docker endpoint "${service}" failed: ${cause} The previous container could not be restored${outcome?.rollback.error ? ` (${outcome.rollback.error})` : ''}. Sencho may not reach Docker on this node until "${service}" runs again: on the host, run "docker compose up -d ${service}" in Sencho's Compose project directory, then check Fleet. The helper log is in the Sencho data directory under ${path.dirname(helperFiles.plan('', current.operationId)).replace(/^\//, '')}.`;
    current.rollback = outcome ? { attempted: true, restored, error: outcome.rollback.error } : { attempted: false };
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
      const live = trackers.get(local.id);
      if (status === 'updating') {
        trackers.set(local.id, trackers.create('updating', getSenchoVersion(), null, undefined, undefined, kind));
      } else if (live?.status === 'updating') {
        trackers.set(local.id, trackers.resolve(live, status, error));
      } else {
        trackers.set(local.id, trackers.create(status, getSenchoVersion(), null, error, undefined, kind));
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
    replaceEndpointProvider: boolean,
  ): Promise<ClaimResult> {
    const selfUpdate = SelfUpdateService.getInstance();
    let endpointProvider: OperationEndpointProvider | undefined;
    if (replaceEndpointProvider) {
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
      endpointProvider = { project, service: option.service, containerName: option.containerName };
    }
    const resolved = await selfUpdate.getResolvedComposeImageForUpdate();
    const operation = this.newOperation(
      kind,
      resolved?.imageRef ?? null,
      targetImageRef,
      resolved?.filePath ?? null,
      selfUpdate.getComposeServiceName(),
    );
    if (endpointProvider) operation.endpointProvider = endpointProvider;
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
    if (operation.endpointProvider) this.endpointProviderPending = false;
    await this.persist(operation);
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
