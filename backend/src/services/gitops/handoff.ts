import { promises as fsPromises } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { RepoIdentity } from './repoIdentity';
import type { RefKind } from '../git/types';
import type {
  FutureRolloutAuthorizationBinding,
  GitOpsApplicationRow,
  GitOpsGenerationRow,
} from './types';
import { GitOpsStore } from './store';
import { GitOpsTransitions, type EventEnvelope } from './transitions';
import {
  decodePreflightEvidenceJson,
  encodePreflightEvidenceJson,
  executableArtifactRefusalReason,
  fingerprintPreflightEvidence,
  isPreflightBlocked,
  registryPreflightBlockReason,
} from './preflight';
import {
  evaluateRegistryReadiness,
  setRegistryReadinessDepsForTests,
  type RegistryReadinessDeps,
} from './registryReadiness';
import { stackManagedRoot } from './directApplication';
import { decodeGitOpsRequiredTargetsJson } from './json';
import { recoveryBindingForTarget } from './recoveryCapture';
import { DatabaseService } from '../DatabaseService';
import { BlueprintService } from '../BlueprintService';
import { buildBlueprintMarker } from '../../helpers/blueprintMarker';
import { errorMessageForLog, sanitizeForLog } from '../../utils/safeLog';
import { mapWithConcurrency } from '../../utils/mapWithConcurrency';

export { setRegistryReadinessDepsForTests };

const PREFLIGHT_EVAL_TIMEOUT_MS = 30_000;

/** Serialize one evaluation per application so concurrent dispatch cannot double-probe. */
type InflightEvaluation = { token: number; promise: Promise<unknown> };
const inflightEvaluations = new Map<string, InflightEvaluation>();
let inflightEvaluationToken = 0;

async function withSerializedEvaluation<T>(applicationId: string, fn: () => Promise<T>): Promise<T> {
  const prior = inflightEvaluations.get(applicationId)?.promise;
  const token = ++inflightEvaluationToken;
  const run = (async () => {
    if (prior) {
      try {
        await prior;
      } catch {
        // Prior failure must not block the next evaluation.
      }
    }
    return fn();
  })();
  inflightEvaluations.set(applicationId, { token, promise: run });
  try {
    return await run;
  } finally {
    // Only clear if we are still the latest queued evaluation for this app.
    if (inflightEvaluations.get(applicationId)?.token === token) {
      inflightEvaluations.delete(applicationId);
    }
  }
}
/**
 * A portable projection of the managed-project manifest: authored file set
 * and per-file content digests, without node id, stack name, or generation
 * directory. The real GitProjectManifest carries those identity fields;
 * this is deliberately narrower.
 */
export type PortableManifest = {
  files: Array<{ path: string; role: string; contentSha256?: string | null }>;
};

/** Authored Compose invocation shape, without a target project name. */
export type ComposeInputs = {
  composeFileOrder: string[];
  profiles?: string[];
  contextDir?: string | null;
};

/**
 * One accepted generation, described purely by what it contains. Direct and
 * Blueprint dispatch consume the exact same shape; current target mode,
 * binding revision, and any execution-local path travel separately in
 * DispatchContext, re-read under the dispatch lock rather than carried
 * here, so a stale acceptance can never authorize a routing decision made
 * after it.
 */
export type AcceptedGeneration = {
  contractVersion: 1;
  generationId: string;
  applicationId: string;
  repoIdentity: RepoIdentity;
  configuredRef: string;
  commitSha: string;
  resolvedRefKind: RefKind | null;
  manifestVersion: number;
  portableManifest: PortableManifest | null;
  composeInputs: ComposeInputs | null;
  materializationFingerprint: string;
  changePlanFingerprint: string | null;
  validationOk: boolean;
  sourcePolicyEvidence: unknown | null;
  securityPolicyEvidence: unknown | null;
  supportRequirements: unknown | null;
  compatibilityRequirements: unknown | null;
  /** Capability metadata only; never a secret value. Not yet populated by any producer. */
  secretCapability: unknown | null;
  trigger: string;
  actor: string | null;
  operationId: string;
  previousGenerationId: string | null;
  /** Why some field above could not be proven, recorded honestly rather than guessed. */
  limitations: string[];
};

function parseOptionalJson<T>(raw: string | null, limitationLabel: string, limitations: string[]): T | null {
  if (raw === null) {
    limitations.push(limitationLabel);
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    limitations.push(`${limitationLabel}_unparseable`);
    return null;
  }
}

/**
 * Build the portable accepted-generation contract from a persisted
 * generation row. A legacy row predating one of the portable-contract
 * columns decodes that field as null with an explicit limitation recorded,
 * never as invented evidence.
 */
export function buildAcceptedGeneration(row: GitOpsGenerationRow): AcceptedGeneration {
  let repoIdentity: RepoIdentity;
  try {
    repoIdentity = JSON.parse(row.repo_identity_json) as RepoIdentity;
  } catch {
    throw new Error(`Generation ${row.id} has an unparseable repo_identity_json; refusing to build an accepted-generation contract from corrupt evidence.`);
  }

  const limitations: string[] = JSON.parse(row.redacted_limitations_json) as string[];
  const portableManifest = parseOptionalJson<PortableManifest>(row.portable_manifest_json, 'portable_manifest_missing', limitations);
  const composeInputs = parseOptionalJson<ComposeInputs>(row.compose_inputs_json, 'compose_inputs_missing', limitations);
  const sourcePolicyEvidence = parseOptionalJson<unknown>(row.source_policy_evidence_json, 'source_policy_evidence_missing', limitations);
  const securityPolicyEvidence = parseOptionalJson<unknown>(row.security_policy_evidence_json, 'security_policy_evidence_missing', limitations);
  const supportRequirements = parseOptionalJson<unknown>(row.support_requirements_json, 'support_requirements_missing', limitations);
  const compatibilityRequirements = parseOptionalJson<unknown>(row.compatibility_requirements_json, 'compatibility_requirements_missing', limitations);
  const secretCapability = parseOptionalJson<unknown>(row.secret_capability_json, 'secret_capability_missing', limitations);

  return {
    contractVersion: 1,
    generationId: row.id,
    applicationId: row.application_id,
    repoIdentity,
    configuredRef: row.configured_ref,
    commitSha: row.commit_sha,
    resolvedRefKind: row.resolved_ref_kind,
    manifestVersion: row.manifest_version,
    portableManifest,
    composeInputs,
    materializationFingerprint: row.materialization_fingerprint,
    changePlanFingerprint: row.change_plan_fingerprint,
    validationOk: row.validation_ok === 1,
    sourcePolicyEvidence,
    securityPolicyEvidence,
    supportRequirements,
    compatibilityRequirements,
    secretCapability,
    trigger: row.trigger,
    actor: row.actor,
    operationId: row.operation_id,
    previousGenerationId: row.previous_generation_id,
    limitations,
  };
}

/**
 * Current target mode and binding, re-read under the dispatch lock rather
 * than carried on AcceptedGeneration, so a routing decision is always made
 * from the current state, never a value an earlier acceptance froze.
 */
export type DispatchContext = {
  targetMode: 'direct' | 'blueprint';
  nodeId: number | null;
  bindingRevision: string | null;
};

export type DispatchResult =
  | { status: 'dispatched' }
  | { status: 'blocked'; reason: string };

export interface TargetAdapter {
  dispatch(generation: AcceptedGeneration, context: DispatchContext): Promise<DispatchResult>;
}

function envelopeFor(actor: string | null, trigger: string): EventEnvelope {
  return {
    operationId: randomUUID(),
    actor: actor ?? 'system:blueprint-rollout',
    trigger,
    at: Date.now(),
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function resolvesRolloutAuthorization(
  app: GitOpsApplicationRow,
  binding: FutureRolloutAuthorizationBinding,
): boolean {
  if (!app.rollout_authorization_ref) return false;
  return !!GitOpsStore.getInstance().resolveApprovalRef(app.rollout_authorization_ref, {
    kind: 'rollout_authorization',
    applicationId: app.id,
    binding,
  });
}

/** Live binding only when the application's authorization ref still resolves. */
function liveRolloutBinding(app: GitOpsApplicationRow): FutureRolloutAuthorizationBinding | null {
  if (!app.rollout_authorization_ref) return null;
  const store = GitOpsStore.getInstance();
  const binding = store.currentAuthorizationBinding(app);
  if (!binding) return null;
  return resolvesRolloutAuthorization(app, binding) ? binding : null;
}

/**
 * Ensure a live rollout_authorization exists for the application, minting
 * one when every binding ingredient is present and registry preflight is ready.
 * Recomputes registry readiness on every call; remints when the fingerprint drifts.
 *
 * `authority` names who is minting: the automatic handoff acts on the
 * configured policy, an explicit operator authorization on the operator.
 *
 * `shouldAbort` lets a dispatch caller refuse to mint while a hold is placed.
 * It is re-read after the preflight await, because a pause that lands during
 * the evaluation must not mint or supersede an authorization the pause is
 * holding. Explicit operator authorizations do not pass it: the operator's own
 * decision is the authority there.
 */
export async function ensureRolloutAuthorization(
  applicationId: string,
  actor: string | null,
  trigger = 'blueprint_dispatch',
  depsPartial?: Partial<RegistryReadinessDeps>,
  authority: 'operator' | 'configured_policy' = 'configured_policy',
  shouldAbort?: () => boolean,
): Promise<{ ok: true; binding: FutureRolloutAuthorizationBinding } | { ok: false; reason: string }> {
  return withSerializedEvaluation(applicationId, async () => {
    const store = GitOpsStore.getInstance();
    const app = store.getApplication(applicationId);
    if (!app) return { ok: false, reason: 'The application could not be read.' };
    if (app.target_mode !== 'blueprint') {
      return { ok: false, reason: 'Rollout authorization is only for Blueprint target mode.' };
    }
    if (shouldAbort?.()) return { ok: false, reason: 'The rollout is paused.' };

    const ingredients = store.authorizationIngredients(app);
    if (!ingredients) {
      if (!app.placement_approval_ref) {
        return { ok: false, reason: 'Placement approval is required before rollout authorization.' };
      }
      return {
        ok: false,
        reason: 'Source acceptance, artifact set, and placement must all be current before rollout authorization.',
      };
    }

    const artifactRefusal = executableArtifactRefusalReason(
      store.getArtifactSet(ingredients.artifactSetId)?.qualification,
    );
    if (artifactRefusal) return { ok: false, reason: artifactRefusal };

    let composeContent: string | null = null;
    const genRow = store.getGeneration(ingredients.acceptedGenerationId);
    if (genRow) {
      try {
        composeContent = await readAppliedComposeContent(app, genRow);
      } catch (err) {
        console.warn(
          '[GitOps] Could not read applied compose for preflight:',
          sanitizeForLog(applicationId),
          sanitizeForLog(err instanceof Error ? err.message : String(err)),
        );
      }
    }

    const abortSignal = depsPartial?.abortSignal
      ?? AbortSignal.timeout(PREFLIGHT_EVAL_TIMEOUT_MS);
    const deps = { ...depsPartial, abortSignal };

    const preflight = await evaluateRegistryReadiness(
      {
        artifactSetId: ingredients.artifactSetId,
        requiredNodeIds: ingredients.requiredNodeIds,
        stackName: app.configured_source_stack_name,
        composeContent,
      },
      deps,
    );
    // Re-read after the await: a pause placed while preflight ran must not
    // mint, supersede, or invalidate the authorization it is holding.
    if (shouldAbort?.()) return { ok: false, reason: 'The rollout is paused.' };
    const preflightEvidenceJson = encodePreflightEvidenceJson(preflight);
    const preflightFingerprint = fingerprintPreflightEvidence(preflight);
    const transitions = GitOpsTransitions.getInstance();
    transitions.recordPreflightEvaluation({
      applicationId: app.id,
      evidenceJson: preflightEvidenceJson,
    });

    if (isPreflightBlocked(preflight)) {
      const existing = liveRolloutBinding(store.getApplication(applicationId) ?? app);
      if (existing) {
        transitions.invalidateAuthorizationOnPreflightDrift({
          applicationId: app.id,
          envelope: envelopeFor(actor, trigger),
        });
      }
      return { ok: false, reason: registryPreflightBlockReason(preflight) };
    }

    const live = liveRolloutBinding(store.getApplication(applicationId) ?? app);
    if (live && live.preflightFingerprint === preflightFingerprint) {
      return { ok: true, binding: live };
    }
    if (live && live.preflightFingerprint !== preflightFingerprint) {
      transitions.invalidateAuthorizationOnPreflightDrift({
        applicationId: app.id,
        envelope: envelopeFor(actor, trigger),
      });
    }

    const approvalId = randomUUID();
    const rolloutGenerationId = randomUUID();
    try {
      transitions.rolloutAuthorized({
        applicationId: app.id,
        approvalId,
        rolloutGenerationId,
        preflightFingerprint,
        preflightEvidenceJson,
        actor,
        envelope: envelopeFor(actor, trigger),
        authority,
      });
    } catch (err) {
      const message = errorMessage(err);
      if (/already live/i.test(message)) {
        const raced = store.getApplication(applicationId);
        const binding = raced ? liveRolloutBinding(raced) : null;
        if (binding && binding.preflightFingerprint === preflightFingerprint) {
          return { ok: true, binding };
        }
        if (binding && binding.preflightFingerprint !== preflightFingerprint) {
          transitions.invalidateAuthorizationOnPreflightDrift({
            applicationId: app.id,
            envelope: envelopeFor(actor, `${trigger}:preflight_race`),
          });
          try {
            transitions.rolloutAuthorized({
              applicationId: app.id,
              approvalId: randomUUID(),
              rolloutGenerationId: randomUUID(),
              preflightFingerprint,
              preflightEvidenceJson,
              actor,
              envelope: envelopeFor(actor, trigger),
              authority,
            });
          } catch (retryErr) {
            return { ok: false, reason: `Rollout authorization failed: ${errorMessage(retryErr)}` };
          }
        } else if (!binding) {
          return { ok: false, reason: `Rollout authorization failed: ${message}` };
        }
      } else {
        return { ok: false, reason: `Rollout authorization failed: ${message}` };
      }
    }

    const refreshed = store.getApplication(applicationId);
    if (!refreshed) return { ok: false, reason: 'The application could not be read after authorization.' };
    const binding = store.currentAuthorizationBinding(refreshed);
    if (!binding) return { ok: false, reason: 'Authorization was written but the live binding could not be formed.' };
    if (binding.preflightFingerprint !== preflightFingerprint) {
      return { ok: false, reason: 'Authorization fingerprint drifted during mint.' };
    }
    return { ok: true, binding };
  });
}

async function readAppliedComposeContent(
  app: GitOpsApplicationRow,
  genRow: GitOpsGenerationRow,
): Promise<string> {
  const stackName = app.configured_source_stack_name;
  if (!stackName) {
    throw new Error('Bound application has no retained source stack identity');
  }
  if (!genRow.applied_dir || genRow.applied_dir.trim() === '') {
    throw new Error('accepted generation has no applied materialization directory');
  }
  const managedRoot = stackManagedRoot(stackName);
  const appliedAbs = path.resolve(managedRoot, genRow.applied_dir);
  if (!appliedAbs.startsWith(managedRoot + path.sep)) {
    throw new Error('applied materialization path escapes the managed root');
  }
  const composePath = path.resolve(appliedAbs, 'compose.yaml');
  if (!composePath.startsWith(appliedAbs + path.sep)) {
    throw new Error('compose path escapes the applied materialization directory');
  }
  try {
    return await fsPromises.readFile(composePath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error('accepted generation materialization is missing compose.yaml', { cause: err });
    }
    throw err;
  }
}

function targetAlreadyAcked(
  target: ReturnType<GitOpsStore['getTarget']>,
  binding: FutureRolloutAuthorizationBinding,
  liveAuthorizationRef: string,
): boolean {
  if (!target || target.target_status !== 'active') return false;
  return target.latest_stage === 'blueprint_ack_recorded'
    && target.intent_revision_id === binding.intentRevisionId
    && target.applied_generation_id === binding.acceptedGenerationId
    && target.rollout_authorization_ref === liveAuthorizationRef;
}

/**
 * Dispatch an accepted generation across the frozen Blueprint place set.
 *
 * Content comes from the generation's applied materialization, never from
 * blueprints.compose_content. Per-target stage rows are written before
 * transport so restart can skip committed acks.
 */
export class BlueprintTargetAdapter implements TargetAdapter {
  async dispatch(generation: AcceptedGeneration, _context: DispatchContext): Promise<DispatchResult> {
    const store = GitOpsStore.getInstance();
    const app = store.getApplication(generation.applicationId);
    if (!app) {
      return { status: 'blocked', reason: 'The application could not be read; dispatch is unavailable.' };
    }
    if (app.target_mode !== 'blueprint') {
      return { status: 'blocked', reason: 'Blueprint dispatch requires Blueprint target mode.' };
    }
    const blueprintId = app.blueprint_id;
    if (blueprintId === null) {
      return { status: 'blocked', reason: 'No Blueprint is bound to this application.' };
    }
    // A pause is an execution hold, not a rendering state: nothing dispatches
    // while it is set, including the boot-time reconstruction that resumes
    // authorized rollouts.
    if (app.pause_at) {
      return { status: 'blocked', reason: 'The rollout is paused.' };
    }

    const trigger = generation.trigger || 'blueprint_dispatch';
    const auth = await ensureRolloutAuthorization(
      app.id,
      generation.actor ?? null,
      trigger,
      undefined,
      'configured_policy',
      () => !!store.getApplication(app.id)?.pause_at,
    );
    if (!auth.ok) return { status: 'blocked', reason: auth.reason };
    const binding = auth.binding;

    if (generation.generationId !== binding.acceptedGenerationId) {
      return {
        status: 'blocked',
        reason: 'The accepted generation does not match the authorized application generation.',
      };
    }

    const liveApp = store.getApplication(app.id);
    if (!liveApp?.rollout_authorization_ref) {
      return { status: 'blocked', reason: 'Rollout authorization is missing after mint.' };
    }
    if (!resolvesRolloutAuthorization(liveApp, binding)) {
      return { status: 'blocked', reason: 'The current rollout authorization no longer matches the live binding.' };
    }
    if (liveApp.pause_at) {
      return { status: 'blocked', reason: 'The rollout is paused.' };
    }
    const liveAuthorizationRef = liveApp.rollout_authorization_ref;

    const genRow = store.getGeneration(binding.acceptedGenerationId);
    if (!genRow || genRow.application_id !== liveApp.id) {
      return { status: 'blocked', reason: 'The authorized generation row could not be read.' };
    }

    let composeContent: string;
    try {
      composeContent = await readAppliedComposeContent(liveApp, genRow);
    } catch (err) {
      return { status: 'blocked', reason: errorMessage(err) };
    }

    const blueprint = DatabaseService.getInstance().getBlueprint(blueprintId);
    if (!blueprint) {
      return { status: 'blocked', reason: 'The bound Blueprint could not be read.' };
    }

    const tx = GitOpsTransitions.getInstance();
    const svc = BlueprintService.getInstance();
    const pausedTargets: number[] = [];
    let anyDispatched = false;

    for (const nodeId of binding.requiredNodeIds) {
      // Re-read before every target: a pause that lands while this loop runs
      // stops the rollout at the next target rather than after the fleet.
      if (store.getApplication(liveApp.id)?.pause_at) {
        return { status: 'blocked', reason: 'The rollout was paused while it was running.' };
      }
      const target = store.getTarget(liveApp.id, nodeId);
      if (targetAlreadyAcked(target, binding, liveAuthorizationRef)) {
        continue;
      }
      // A per-target pause holds that target alone: the rest of the queue
      // continues, and this target is retried by the dispatch a later resume
      // triggers.
      if (target?.pause_at) {
        pausedTargets.push(nodeId);
        continue;
      }

      const node = DatabaseService.getInstance().getNode(nodeId);
      if (!node) {
        try {
          tx.blueprintDeployFailed({
            applicationId: liveApp.id,
            nodeId,
            failureClass: 'target_missing',
            envelope: envelopeFor(generation.actor, trigger),
          });
        } catch (err) {
          console.error(
            '[BlueprintTargetAdapter] failed to record missing target node=%s: %s',
            nodeId,
            sanitizeForLog(errorMessage(err)),
          );
        }
        return { status: 'blocked', reason: `Required target node ${nodeId} is missing.` };
      }

      if (!svc.tryAcquireAuthorizedDeployLock(blueprint.id, nodeId)) {
        return {
          status: 'blocked',
          reason: `Deploy to node ${nodeId} is already in progress.`,
        };
      }

      try {
        try {
          tx.blueprintDeployStarted({
            applicationId: liveApp.id,
            nodeId,
            intentRevisionId: binding.intentRevisionId,
            rolloutCandidateId: binding.rolloutCandidateId,
            envelope: envelopeFor(generation.actor, trigger),
          });
        } catch (err) {
          return {
            status: 'blocked',
            reason: `Could not open deploy for node ${nodeId}: ${errorMessage(err)}`,
          };
        }

        const marker = buildBlueprintMarker({
          blueprintId: blueprint.id,
          revision: blueprint.revision,
          lastApplied: Date.now(),
          applicationId: liveApp.id,
          bindingRevision: binding.intentRevisionId,
        });

        // Capture the pre-deploy state so this rollout can be rolled back
        // later. The binding names the generation the target is running now,
        // which is the one a rollback would restore from here.
        const recoveryTarget = store.getTarget(liveApp.id, nodeId);
        const outcome = await svc.deployAuthorizedMaterialization({
          blueprint,
          node,
          composeContent,
          marker,
          auditPath: `/api/blueprints/${blueprint.id}/rollout/${liveApp.id}`,
          lockHeld: true,
          captureRecovery: true,
          recoveryBinding: recoveryBindingForTarget(liveApp, recoveryTarget),
        });

        if (outcome.status !== 'active') {
          try {
            tx.blueprintDeployFailed({
              applicationId: liveApp.id,
              nodeId,
              failureClass: outcome.status === 'name_conflict' ? 'name_conflict' : 'deploy_failed',
              envelope: envelopeFor(generation.actor, trigger),
            });
          } catch (err) {
            console.error(
              '[BlueprintTargetAdapter] failed to record deploy failure node=%s: %s',
              nodeId,
              sanitizeForLog(errorMessage(err)),
            );
          }
          return {
            status: 'blocked',
            reason: outcome.error
              ? `Deploy to node ${nodeId} failed: ${outcome.error}`
              : `Deploy to node ${nodeId} did not complete.`,
          };
        }

        try {
          tx.blueprintAckRecorded({
            applicationId: liveApp.id,
            nodeId,
            intentRevisionId: binding.intentRevisionId,
            rolloutCandidateId: binding.rolloutCandidateId,
            legacyAppliedRevision: blueprint.revision,
            envelope: envelopeFor(generation.actor, trigger),
          });
        } catch (err) {
          return {
            status: 'blocked',
            reason: `Could not record ack for node ${nodeId}: ${errorMessage(err)}`,
          };
        }
        anyDispatched = true;
      } finally {
        svc.releaseAuthorizedDeployLock(blueprint.id, nodeId);
      }
    }

    // Nothing ran because every remaining target is paused: report the hold
    // rather than a dispatch, so the caller does not count it as progress.
    if (!anyDispatched && pausedTargets.length > 0) {
      return {
        status: 'blocked',
        reason: `The rollout is paused on ${pausedTargets.length} target${pausedTargets.length === 1 ? '' : 's'}.`,
      };
    }
    return { status: 'dispatched' };
  }
}

/**
 * After interrupted operations are reclassified, continue sequential rollout
 * for authorized Blueprint applications that still have unacked frozen targets.
 * Does not probe: skips blocked or missing stored evidence (backfill owns those).
 */
export async function reconstructBlueprintRolloutQueue(): Promise<number> {
  const store = GitOpsStore.getInstance();
  const apps = store.listAuthorizedBlueprintApplications();
  let resumed = 0;
  for (const app of apps) {
    if (!app.accepted_generation_id || !app.rollout_authorization_ref) continue;
    // A pause survives a restart: reconstruction resumes only rollouts that
    // nothing is holding. A per-target pause is honored inside the adapter.
    if (app.pause_at) continue;
    if (!app.latest_preflight_evidence_json) continue;
    const stored = decodePreflightEvidenceJson(app.latest_preflight_evidence_json);
    if (isPreflightBlocked(stored)) continue;
    const binding = liveRolloutBinding(app);
    if (!binding) continue;

    const remaining = binding.requiredNodeIds.filter((nodeId) => {
      const target = store.getTarget(app.id, nodeId);
      return !targetAlreadyAcked(target, binding, app.rollout_authorization_ref!);
    });
    if (remaining.length === 0) continue;

    const genRow = store.getGeneration(binding.acceptedGenerationId);
    if (!genRow) continue;
    const generation = buildAcceptedGeneration(genRow);
    const result = await new BlueprintTargetAdapter().dispatch(generation, {
      targetMode: 'blueprint',
      nodeId: remaining[0] ?? null,
      bindingRevision: binding.intentRevisionId,
    });
    if (result.status === 'dispatched') {
      resumed += 1;
      continue;
    }
    console.warn(
      '[GitOps] Blueprint rollout reconstruction blocked for %s: %s',
      sanitizeForLog(app.id),
      sanitizeForLog(result.reason),
    );
  }
  return resumed;
}

/**
 * Max concurrent preflight evaluations during the startup backfill.
 *
 * Each evaluation is network-bound on registry probes, so overlapping a few
 * hides that latency, while the writes they finish with share one synchronous
 * SQLite connection and gain nothing from more overlap.
 */
export const PREFLIGHT_BACKFILL_CONCURRENCY = 3;

/** The per-application evaluation the backfill drives, injectable so tests can
 * drive the loop without a live registry probe. */
type BackfillAuthorizer = typeof ensureRolloutAuthorization;

/**
 * Whether stored preflight evidence exists for an application. Never throws:
 * a store read that fails must cost this one application, never the batch.
 */
function hasStoredPreflightEvidence(store: GitOpsStore, applicationId: string): boolean {
  try {
    return Boolean(store.getApplication(applicationId)?.latest_preflight_evidence_json);
  } catch (err) {
    console.warn(
      '[GitOps] Preflight backfill could not read evidence for %s: %s',
      sanitizeForLog(applicationId),
      errorMessageForLog(err),
    );
    return false;
  }
}

/**
 * One-shot startup backfill: live-authorized Blueprint apps that still lack
 * stored preflight evidence are evaluated once so derive can project honestly
 * without painting them blocked for a missing column.
 *
 * This runs on the startup path ahead of the HTTP bind, and each evaluation can
 * spend the full preflight timeout, so the work is spread over a small pool
 * rather than serialized. The callback contains every failure, so one bad
 * application can never reject the batch and abandon the evaluations still in
 * flight. The tally reads stored evidence rather than the returned verdict,
 * because evidence is what derive projects from.
 */
export async function backfillMissingPreflightEvaluations(
  authorize: BackfillAuthorizer = ensureRolloutAuthorization,
): Promise<number> {
  const store = GitOpsStore.getInstance();
  const apps = store.listAuthorizedBlueprintApplications().filter(
    (app) => app.latest_preflight_evidence_json == null && liveRolloutBinding(app) !== null,
  );
  let filled = 0;
  await mapWithConcurrency(apps, PREFLIGHT_BACKFILL_CONCURRENCY, async (app) => {
    let result: Awaited<ReturnType<BackfillAuthorizer>> | null = null;
    try {
      result = await authorize(app.id, null, 'preflight_backfill');
    } catch (err) {
      console.warn(
        '[GitOps] Preflight backfill failed for %s: %s',
        sanitizeForLog(app.id),
        errorMessageForLog(err),
      );
    }
    if (hasStoredPreflightEvidence(store, app.id)) {
      filled += 1;
    } else if (result && !result.ok) {
      console.warn(
        '[GitOps] Preflight backfill could not authorize %s: %s',
        sanitizeForLog(app.id),
        sanitizeForLog(result.reason),
      );
    } else if (result) {
      // No evaluation today can return ok without writing evidence first. If
      // one ever does, the app is unevaluable to derive and must say so.
      console.warn(
        '[GitOps] Preflight backfill stored no evidence for authorized %s',
        sanitizeForLog(app.id),
      );
    }
  });
  return filled;
}

/** Exported for tests that assert frozen-set decoding stays aligned with the adapter. */
export function frozenRequiredNodeIds(app: GitOpsApplicationRow): number[] | null {
  if (!app.rollout_candidate_id) return null;
  const candidate = GitOpsStore.getInstance().getRolloutCandidate(app.rollout_candidate_id);
  if (!candidate) return null;
  try {
    return decodeGitOpsRequiredTargetsJson(candidate.required_targets_json).nodeIds;
  } catch {
    return null;
  }
}
