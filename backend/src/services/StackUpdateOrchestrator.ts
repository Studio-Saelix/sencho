import WebSocket from 'ws';
import DockerController from './DockerController';
import { ComposeService } from './ComposeService';
import { HealthGateService } from './HealthGateService';
import { AutoHealService } from './AutoHealService';
import { ImageUpdateService } from './ImageUpdateService';
import {
  ServiceUpdateRecoveryService,
  type ServiceReplicaSnapshot,
} from './ServiceUpdateRecoveryService';
import type { ServiceUpdateRecoveryRow } from './DatabaseService';
import { buildEffectiveServiceModel } from './effectiveServiceModel';
import { DriftLedgerService } from './DriftLedgerService';
import { MeshService } from './MeshService';
import { DatabaseService } from './DatabaseService';
import { enforcePolicyForImageRefs, type PolicyEnforcementOptions } from './PolicyEnforcement';
import { describePolicyBlock } from '../helpers/policyGate';
import { getErrorMessage } from '../utils/errors';
import { sanitizeForLog } from '../utils/safeLog';
import type { EffectiveServiceSpec } from './effectiveServiceModel';

export type UpdateTarget =
  | { scope: 'stack' }
  | { scope: 'service'; serviceName: string };

export type UpdateTrigger =
  | 'manual' | 'scheduled' | 'automatic' | 'blueprint' | 'webhook' | 'bulk';

export interface UpdateOperationContext {
  nodeId: number;
  stackName: string;
  target: UpdateTarget;
  trigger: UpdateTrigger;
  actor: string | null;
}

export interface StackComposeOptions {
  atomic: boolean;
  terminalWs?: WebSocket | null;
}

export interface ServiceUpdateOptions {
  policyOptions: PolicyEnforcementOptions;
  terminalWs?: WebSocket | null;
  /** Restore only: binds the operation to a recovery snapshot. */
  recoveryId?: string;
}

export type OrchestratorResult =
  | { kind: 'stack_compose_done'; recoveryId: string | null }
  | {
      kind: 'service_done';
      serviceName: string;
      healthGateId: string | null;
      observing: boolean;
      recoveryId: string | null;
      recoveryAvailable: boolean;
      previousImageId?: string | null;
      newImageId?: string | null;
      recheckWarning?: string;
    }
  | {
      kind: 'service_failed';
      code: string;
      error: string;
      serviceName?: string;
      mutationStage?: string;
      recoveryId?: string | null;
    };

function serviceFailed(
  code: string,
  error: string,
  extra?: { serviceName?: string; mutationStage?: string; recoveryId?: string | null },
): Extract<OrchestratorResult, { kind: 'service_failed' }> {
  return { kind: 'service_failed', code, error, ...extra };
}

/** Shorten a local image id for activity copy (sha256:abcdef… → abcdef…). */
export function shortImageId(imageId: string | null | undefined): string | null {
  if (!imageId) return null;
  const bare = imageId.startsWith('sha256:') ? imageId.slice(7) : imageId;
  return bare.slice(0, 12);
}

/**
 * Post-mutation replica convergence rules shared by update and restore.
 * Requires the exact expected count of inspected running image ids and a
 * single shared image before success (independent of optional health gating).
 */
export function evaluateServiceReplicaConvergence(
  serviceName: string,
  expectedReplicas: number,
  ids: string[],
  inspectErrors: number,
):
  | { kind: 'converged'; imageId: string | null }
  | { kind: 'divergent'; error: string }
  | { kind: 'inspect_failed'; error: string } {
  if (expectedReplicas === 0) {
    return { kind: 'converged', imageId: null };
  }
  if (inspectErrors > 0 && ids.length === 0) {
    return {
      kind: 'inspect_failed',
      error: `Could not inspect replicas for service "${serviceName}" after the update.`,
    };
  }
  const distinct = new Set(ids);
  if (distinct.size === 0) {
    return { kind: 'divergent', error: `Service "${serviceName}" has no running replicas after the update.` };
  }
  if (ids.length !== expectedReplicas) {
    return {
      kind: 'divergent',
      error: `Service "${serviceName}" has ${ids.length} running replica(s); expected ${expectedReplicas}.`,
    };
  }
  if (distinct.size > 1) {
    return { kind: 'divergent', error: `Service "${serviceName}" replicas did not converge on a single image.` };
  }
  return { kind: 'converged', imageId: [...distinct][0] };
}

/** Parse a tag image ref into a Docker tag() repo + tag pair. */
function splitImageRef(ref: string): { repo: string; tag: string } {
  const lastSlash = ref.lastIndexOf('/');
  const lastColon = ref.lastIndexOf(':');
  if (lastColon > lastSlash) {
    return { repo: ref.slice(0, lastColon), tag: ref.slice(lastColon + 1) };
  }
  return { repo: ref, tag: 'latest' };
}

/**
 * Single entry point for stack-scope Compose updates and the manual
 * service-scoped update/restore flows.
 *
 * Ownership boundaries (§3): the five stack update callers keep every
 * side effect (policy, lock, clear status, invalidate, broadcast, notify,
 * post-scan, and the post-success `beginStack`); this orchestrator's stack
 * branch only runs `ComposeService.updateStack`. The service branch (nested
 * manual routes only) owns policy, the recovery snapshot, the pre-mutation
 * health gate (prepare/attach/beginPrepared), Auto-Heal suppression, and the
 * per-service recheck; the route holds the stack lock and maps the result to
 * HTTP. Expected failures never throw past `execute`; they return a
 * `service_failed` result.
 */
export class StackUpdateOrchestrator {
  private static instance: StackUpdateOrchestrator;

  public static getInstance(): StackUpdateOrchestrator {
    if (!StackUpdateOrchestrator.instance) {
      StackUpdateOrchestrator.instance = new StackUpdateOrchestrator();
    }
    return StackUpdateOrchestrator.instance;
  }

  public async execute(
    ctx: UpdateOperationContext,
    options: StackComposeOptions | ServiceUpdateOptions,
  ): Promise<OrchestratorResult> {
    if (ctx.target.scope === 'stack') {
      return this.executeStack(ctx, options as StackComposeOptions);
    }
    // Service scope: automation never selects this branch.
    if (ctx.trigger !== 'manual') {
      throw new Error('Service-scoped updates require a manual trigger');
    }
    const serviceOptions = options as ServiceUpdateOptions;
    if (serviceOptions.recoveryId) {
      return this.executeRestore(ctx, ctx.target.serviceName, serviceOptions);
    }
    return this.executeServiceUpdate(ctx, ctx.target.serviceName, serviceOptions);
  }

  /**
   * Stack branch: run the full-stack Compose update only. Side effects and the
   * post-success `beginStack(..., 'update')` stay with the caller.
   */
  private async executeStack(
    ctx: UpdateOperationContext,
    options: StackComposeOptions,
  ): Promise<OrchestratorResult> {
    const updateResult = await ComposeService.getInstance(ctx.nodeId).updateStack(
      ctx.stackName, options.terminalWs ?? undefined, options.atomic,
    );
    const recoveryId = updateResult?.recoveryId ?? null;
    return { kind: 'stack_compose_done', recoveryId };
  }

  private async executeServiceUpdate(
    ctx: UpdateOperationContext,
    serviceName: string,
    options: ServiceUpdateOptions,
  ): Promise<OrchestratorResult> {
    const { nodeId, stackName } = ctx;

    {
      const { StackUpdateRecoveryService } = await import('./StackUpdateRecoveryService');
      if (StackUpdateRecoveryService.getInstance().isRestoredCurrentPinActive(nodeId, stackName)) {
        return serviceFailed(
          'stack_recovery_pin_active',
          'This stack is pinned to a restored recovery generation. Run a full-stack Update to continue.',
        );
      }
    }

    const loaded = await this.loadServiceSpec(nodeId, stackName, serviceName);
    if (!loaded.ok) return loaded.result;
    const { spec, services } = loaded;

    if (services.length <= 1) {
      return serviceFailed(
        'service_update_single_service',
        'Service-scoped updates require a stack with more than one service.',
      );
    }
    if (!spec.hasBuild && !spec.declaredImage) {
      return serviceFailed(
        'service_not_updatable',
        `Service "${serviceName}" has neither an image nor a build, so it cannot be updated.`,
      );
    }

    AutoHealService.getInstance().suppress(nodeId, stackName, serviceName);
    let observing = false;
    let recoveryId: string | null = null;
    let recoveryAvailable = false;
    try {
      const policyFailure = await this.checkPolicyOrFail(
        stackName, nodeId, serviceName, spec.declaredImage ? [spec.declaredImage] : [], options.policyOptions, 'update',
      );
      if (policyFailure) return policyFailure;

      const prepared = await HealthGateService.getInstance().prepare({
        nodeId, stackName,
        target: { scope: 'service', serviceName },
        trigger: 'service_update',
        expectedReplicas: spec.expectedReplicas,
      });
      const prepareToken = prepared.prepareToken;
      const prepareSnapshotOk = prepared.snapshotOk;

      const replicas = await this.snapshotServiceReplicas(nodeId, stackName, serviceName);
      const recovery = ServiceUpdateRecoveryService.getInstance().createIfEligible({
        nodeId, stackName, serviceName,
        replicas,
        declaredImageRef: spec.declaredImage,
        createdBy: ctx.actor,
      });
      const previousImageId = recovery.eligible
        ? recovery.row.majority_image_id
        : (replicas[0]?.imageId ?? null);
      if (recovery.eligible) {
        recoveryId = recovery.row.id;
        recoveryAvailable = true;
      }

      try {
        await ComposeService.getInstance(nodeId).updateService(
          stackName, serviceName, spec.hasBuild, options.terminalWs ?? undefined,
        );
      } catch (composeError) {
        return serviceFailed(
          'service_update_compose_failed',
          getErrorMessage(composeError, 'Service update failed'),
          { serviceName, mutationStage: 'compose', recoveryId },
        );
      }

      const observed = await this.observePreparedService(
        prepareToken, nodeId, stackName, serviceName, spec.expectedReplicas, ctx.actor,
        'service_update_replica_divergence', recoveryId, prepareSnapshotOk,
      );
      if (!observed.ok) return observed.result;
      observing = observed.observing;
      const healthGateId = observed.healthGateId;

      if (recoveryId && healthGateId) {
        try {
          ServiceUpdateRecoveryService.getInstance().linkHealthGate(recoveryId, healthGateId);
        } catch (linkError) {
          console.warn(
            '[StackUpdateOrchestrator] Failed to link recovery %s to gate %s: %s',
            sanitizeForLog(recoveryId), sanitizeForLog(healthGateId),
            sanitizeForLog(getErrorMessage(linkError, 'unknown')),
          );
        }
      }
      const recheck = await ImageUpdateService.getInstance().recheckStack(nodeId, stackName, {
        updatedService: serviceName,
      });
      await DriftLedgerService.getInstance().reconcileServiceForStack(nodeId, stackName, serviceName);
      await this.refreshMeshIfEnabled(nodeId, stackName);

      const warnings = [observed.gateWarning, recheck.warning].filter((w): w is string => !!w);
      return {
        kind: 'service_done',
        serviceName,
        healthGateId,
        observing,
        recoveryId,
        recoveryAvailable,
        previousImageId,
        newImageId: observed.newImageId ?? null,
        recheckWarning: warnings.length > 0 ? warnings.join(' ') : undefined,
      };
    } finally {
      if (!observing) {
        AutoHealService.getInstance().clearSuppress(nodeId, stackName, serviceName);
      }
    }
  }

  private async executeRestore(
    ctx: UpdateOperationContext,
    serviceName: string,
    options: ServiceUpdateOptions,
  ): Promise<OrchestratorResult> {
    const { nodeId, stackName } = ctx;
    const recoveryId = options.recoveryId as string;

    {
      const { StackUpdateRecoveryService } = await import('./StackUpdateRecoveryService');
      if (StackUpdateRecoveryService.getInstance().isRestoredCurrentPinActive(nodeId, stackName)) {
        return serviceFailed(
          'stack_recovery_pin_active',
          'This stack is pinned to a restored recovery generation. Run a full-stack Update to continue.',
          { recoveryId },
        );
      }
    }
    const recovery = ServiceUpdateRecoveryService.getInstance().get(recoveryId);
    if (
      !recovery ||
      recovery.node_id !== nodeId ||
      recovery.stack_name !== stackName ||
      recovery.service_name !== serviceName
    ) {
      return serviceFailed('recovery_not_found', 'No matching recovery snapshot for this service.');
    }
    if (recovery.status !== 'active') {
      return serviceFailed(
        'recovery_not_restorable',
        `This recovery snapshot is ${recovery.status} and can no longer be restored.`,
        { recoveryId },
      );
    }

    AutoHealService.getInstance().suppress(nodeId, stackName, serviceName);
    let observing = false;
    let claimed = false;
    let consumed = false;
    try {
      const loaded = await this.loadServiceSpec(nodeId, stackName, serviceName, recoveryId);
      if (!loaded.ok) return loaded.result;
      const { spec, services } = loaded;
      if (services.length <= 1) {
        return serviceFailed(
          'service_update_single_service',
          'Service-scoped restore requires a stack with more than one service.',
          { recoveryId },
        );
      }

      const scanTarget = await this.resolveRestoreScanTarget(nodeId, recovery);
      const policyFailure = await this.checkPolicyOrFail(
        stackName, nodeId, serviceName, [scanTarget], options.policyOptions, 'rollback', recoveryId,
      );
      if (policyFailure) return policyFailure;

      const prepared = await HealthGateService.getInstance().prepare({
        nodeId, stackName,
        target: { scope: 'service', serviceName },
        trigger: 'service_restore',
        expectedReplicas: spec.expectedReplicas,
      });
      const prepareToken = prepared.prepareToken;
      const prepareSnapshotOk = prepared.snapshotOk;

      const claimedRow = ServiceUpdateRecoveryService.getInstance().claim(recoveryId);
      if (!claimedRow) {
        return serviceFailed(
          'recovery_claim_failed',
          'This recovery snapshot is being restored by another operation.',
          { recoveryId },
        );
      }
      claimed = true;
      ServiceUpdateRecoveryService.getInstance().startClaimRenewal(recoveryId);

      const previousImageId = (await this.snapshotServiceReplicas(nodeId, stackName, serviceName))[0]?.imageId ?? null;

      try {
        const { repo, tag } = splitImageRef(recovery.declared_image_ref);
        await DockerController.getInstance(nodeId).getDocker()
          .getImage(recovery.majority_image_id).tag({ repo, tag });
      } catch (retagError) {
        return serviceFailed(
          'restore_retag_failed',
          getErrorMessage(retagError, 'Could not retag the recovery image'),
          { serviceName, mutationStage: 'retag', recoveryId },
        );
      }
      try {
        await ComposeService.getInstance(nodeId).recreateServiceFromLocal(
          stackName, serviceName, options.terminalWs ?? undefined,
        );
      } catch (composeError) {
        return serviceFailed(
          'restore_compose_failed',
          getErrorMessage(composeError, 'Service restore failed'),
          { serviceName, mutationStage: 'compose', recoveryId },
        );
      }

      const observed = await this.observePreparedService(
        prepareToken, nodeId, stackName, serviceName, spec.expectedReplicas, ctx.actor,
        'restore_replica_divergence', recoveryId, prepareSnapshotOk,
      );
      if (!observed.ok) return observed.result;
      observing = observed.observing;
      const healthGateId = observed.healthGateId;

      try {
        ServiceUpdateRecoveryService.getInstance().markConsumed(recoveryId, healthGateId);
        consumed = true;
      } catch (consumeError) {
        console.warn(
          '[StackUpdateOrchestrator] Failed to mark recovery %s consumed: %s',
          sanitizeForLog(recoveryId), sanitizeForLog(getErrorMessage(consumeError, 'unknown')),
        );
        // Compose already succeeded; treat as consumed for lease/cleanup purposes so
        // we do not reactivate a snapshot that may no longer match the running image.
        consumed = true;
      }

      const recheck = await ImageUpdateService.getInstance().recheckStack(nodeId, stackName, {
        updatedService: serviceName,
      });
      await this.refreshMeshIfEnabled(nodeId, stackName);

      const warnings = [observed.gateWarning, recheck.warning].filter((w): w is string => !!w);
      return {
        kind: 'service_done',
        serviceName,
        healthGateId,
        observing,
        recoveryId,
        recoveryAvailable: false,
        previousImageId,
        newImageId: observed.newImageId ?? null,
        recheckWarning: warnings.length > 0 ? warnings.join(' ') : undefined,
      };
    } finally {
      ServiceUpdateRecoveryService.getInstance().stopClaimRenewal(recoveryId);
      if (claimed && !consumed) {
        const stillLocal = await this.imageIsLocal(nodeId, recovery.majority_image_id);
        if (stillLocal) {
          ServiceUpdateRecoveryService.getInstance().reactivate(recoveryId);
        } else {
          ServiceUpdateRecoveryService.getInstance().invalidate(recoveryId);
        }
      }
      if (!observing) {
        AutoHealService.getInstance().clearSuppress(nodeId, stackName, serviceName);
      }
    }
  }

  /** Best-effort mesh alias refresh when this stack is opted into Mesh. */
  private async refreshMeshIfEnabled(nodeId: number, stackName: string): Promise<void> {
    try {
      if (!DatabaseService.getInstance().isMeshStackEnabled(nodeId, stackName)) return;
      await MeshService.getInstance().refreshAliasCache();
    } catch (error) {
      console.warn(
        '[StackUpdateOrchestrator] Mesh alias refresh failed for %s on node %d: %s',
        sanitizeForLog(stackName), nodeId, sanitizeForLog(getErrorMessage(error, 'unknown')),
      );
    }
  }

  private async loadServiceSpec(
    nodeId: number,
    stackName: string,
    serviceName: string,
    recoveryId?: string | null,
  ): Promise<
    | { ok: true; spec: EffectiveServiceSpec; services: EffectiveServiceSpec[] }
    | { ok: false; result: Extract<OrchestratorResult, { kind: 'service_failed' }> }
  > {
    const model = await buildEffectiveServiceModel(nodeId, stackName);
    if (!model.renderable) {
      return { ok: false, result: serviceFailed(model.code, model.error, { recoveryId }) };
    }
    const spec = model.services.find(s => s.name === serviceName);
    if (!spec) {
      return {
        ok: false,
        result: serviceFailed(
          'service_not_found',
          `Service "${serviceName}" is not declared in this stack.`,
          { recoveryId },
        ),
      };
    }
    return { ok: true, spec, services: model.services };
  }

  private async checkPolicyOrFail(
    stackName: string,
    nodeId: number,
    serviceName: string,
    refs: string[],
    policyOptions: PolicyEnforcementOptions,
    action: 'update' | 'rollback',
    recoveryId?: string | null,
  ): Promise<Extract<OrchestratorResult, { kind: 'service_failed' }> | null> {
    if (refs.length === 0) return null;
    const gate = await enforcePolicyForImageRefs(stackName, nodeId, refs, policyOptions);
    if (gate.ok || gate.bypassed) return null;
    return serviceFailed(
      'policy_blocked',
      `Service "${serviceName}": ${describePolicyBlock(gate.policy, gate.violations, action)}`,
      { serviceName, mutationStage: 'policy', recoveryId },
    );
  }

  private async observePreparedService(
    prepareToken: string,
    nodeId: number,
    stackName: string,
    serviceName: string,
    expectedReplicas: number,
    actor: string | null,
    divergenceCode: string,
    recoveryId: string | null,
    prepareSnapshotOk: boolean,
  ): Promise<
    | { ok: true; healthGateId: string | null; observing: boolean; newImageId: string | null; gateWarning?: string }
    | { ok: false; result: Extract<OrchestratorResult, { kind: 'service_failed' }> }
  > {
    const convergence = await this.resolvePrimaryImage(nodeId, stackName, serviceName, expectedReplicas);
    if (convergence.kind === 'inspect_failed') {
      return {
        ok: false,
        result: serviceFailed('replica_inspect_failed', convergence.error, {
          serviceName, mutationStage: 'inspect', recoveryId,
        }),
      };
    }
    if (convergence.kind === 'divergent') {
      return {
        ok: false,
        result: serviceFailed(divergenceCode, convergence.error, {
          serviceName, mutationStage: 'inspect', recoveryId,
        }),
      };
    }
    if (!prepareSnapshotOk) {
      return {
        ok: true,
        healthGateId: null,
        observing: false,
        newImageId: convergence.imageId,
        gateWarning: 'Health gate skipped: pre-update container snapshot was unavailable.',
      };
    }
    const begin = this.beginPrepared(prepareToken, convergence.imageId, actor);
    return {
      ok: true,
      healthGateId: begin.runId,
      observing: begin.observing,
      newImageId: convergence.imageId,
    };
  }

  /** Attach the single converged image id (scale>0) and begin the prepared gate. */
  private beginPrepared(
    prepareToken: string,
    imageId: string | null,
    actor: string | null,
  ): { runId: string | null; observing: boolean } {
    if (imageId) {
      HealthGateService.getInstance().attachExpectedImage(prepareToken, imageId);
    }
    return HealthGateService.getInstance().beginPrepared({ prepareToken, actor });
  }

  /**
   * Post-mutation replica convergence check. Returns the single shared image id
   * when every expected primary replica agrees, null for a scale-0 service, or a
   * typed divergence when replicas are missing or run 2+ distinct images.
   */
  private async resolvePrimaryImage(
    nodeId: number,
    stackName: string,
    serviceName: string,
    expectedReplicas: number,
  ): Promise<
    | { kind: 'converged'; imageId: string | null }
    | { kind: 'divergent'; error: string }
    | { kind: 'inspect_failed'; error: string }
  > {
    if (expectedReplicas === 0) {
      return { kind: 'converged', imageId: null };
    }
    const inspected = await this.inspectServiceContainers(nodeId, stackName, serviceName);
    return evaluateServiceReplicaConvergence(
      serviceName, expectedReplicas, inspected.ids, inspected.inspectErrors,
    );
  }

  private async inspectPrimaryImageIds(nodeId: number, stackName: string, serviceName: string): Promise<string[]> {
    return (await this.inspectServiceContainers(nodeId, stackName, serviceName)).ids;
  }

  /** Snapshot the current per-replica image ids + repo digests for the recovery row. */
  private async snapshotServiceReplicas(
    nodeId: number,
    stackName: string,
    serviceName: string,
  ): Promise<ServiceReplicaSnapshot[]> {
    const docker = DockerController.getInstance(nodeId).getDocker();
    const snapshots: ServiceReplicaSnapshot[] = [];
    for (const imageId of (await this.inspectServiceContainers(nodeId, stackName, serviceName)).ids) {
      let repoDigest: string | null = null;
      try {
        const image = await docker.getImage(imageId).inspect();
        const digests = (image.RepoDigests ?? []) as string[];
        repoDigest = digests.length > 0 ? digests[0] : null;
      } catch {
        // The digest is optional context; a missing image inspect leaves it null.
      }
      snapshots.push({ imageId, repoDigest });
    }
    return snapshots;
  }

  private async inspectServiceContainers(
    nodeId: number,
    stackName: string,
    serviceName: string,
  ): Promise<{ ids: string[]; inspectErrors: number }> {
    const docker = DockerController.getInstance(nodeId).getDocker();
    const listed = await docker.listContainers({
      all: true,
      filters: { label: [`com.docker.compose.project=${stackName}`, `com.docker.compose.service=${serviceName}`] },
    });
    const ids: string[] = [];
    let inspectErrors = 0;
    for (const info of listed) {
      try {
        const inspect = await docker.getContainer(info.Id).inspect();
        // Convergence requires running replicas; exited/created leftovers must
        // not count toward the expected replica total or the shared image id.
        if (inspect.State?.Status !== 'running') continue;
        if (inspect.Image) ids.push(inspect.Image);
      } catch (error) {
        if ((error as { statusCode?: number })?.statusCode === 404) continue;
        inspectErrors += 1;
        console.warn('[Orchestrator] Replica inspect failed for %s/%s:',
          sanitizeForLog(stackName), sanitizeForLog(serviceName), getErrorMessage(error, 'unknown'));
      }
    }
    return { ids, inspectErrors };
  }

  /**
   * Immutable restore scan target: the captured repo digest when it resolves
   * locally to the majority image id, otherwise the majority image id directly.
   * Never the moving declared tag (RESTORE-POLICY-TARGET-2).
   */
  private async resolveRestoreScanTarget(nodeId: number, recovery: ServiceUpdateRecoveryRow): Promise<string> {
    let replicas: ServiceReplicaSnapshot[] = [];
    try {
      const parsed: unknown = JSON.parse(recovery.replicas_json);
      if (Array.isArray(parsed)) replicas = parsed as ServiceReplicaSnapshot[];
    } catch {
      // Corrupt snapshot: fall back to the majority image id below.
    }
    const withDigest = replicas.find(r => r.imageId === recovery.majority_image_id && r.repoDigest);
    if (withDigest?.repoDigest) {
      const resolvedId = await this.resolveImageId(nodeId, withDigest.repoDigest);
      if (resolvedId === recovery.majority_image_id) return withDigest.repoDigest;
    }
    return recovery.majority_image_id;
  }

  private async resolveImageId(nodeId: number, ref: string): Promise<string | null> {
    try {
      const inspect = await DockerController.getInstance(nodeId).getDocker().getImage(ref).inspect();
      return inspect.Id ?? null;
    } catch {
      return null;
    }
  }

  private async imageIsLocal(nodeId: number, imageId: string): Promise<boolean> {
    try {
      await DockerController.getInstance(nodeId).getDocker().getImage(imageId).inspect();
      return true;
    } catch {
      return false;
    }
  }
}
