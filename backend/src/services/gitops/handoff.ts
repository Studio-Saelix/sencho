import { randomUUID } from 'crypto';
import type { RepoIdentity } from './repoIdentity';
import type { RefKind } from '../git/types';
import type {
  FutureRolloutAuthorizationBinding,
  GitOpsApplicationRow,
  GitOpsGenerationRow,
  GitOpsTargetCurrentRow,
} from './types';
import { emptyTargetRow, GitOpsStore } from './store';
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
import { readAppliedComposeContent } from './gitManagedMaterialization';
import { decodeGitOpsRequiredTargetsJson } from './json';
import { configuredSnapshotFor, encodePolicySnapshot } from './policyComposition';
import { recoveryBindingForTarget } from './recoveryCapture';
import {
  DEFAULT_HEALTH_ROLLOUT_POLICY,
  decodeFrozenRolloutStrategy,
  decodeIntentHealthPolicy,
  encodeFrozenRolloutStrategy,
  gatesAdvancement,
  type HealthRolloutPolicy,
} from './healthPolicy';
import { probeRemoteCapability, type RemoteCapabilityProbe } from '../../helpers/remoteCapabilities';
import { HEALTH_ROLLOUT_POLICY_CAPABILITY } from '../CapabilityRegistry';
import { HealthGateService } from '../HealthGateService';
import type { HealthRolloutExecutor } from './healthRolloutExecutor';
import { DatabaseService, type Node } from '../DatabaseService';
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
  | {
      status: 'blocked';
      reason: string;
      /**
       * Whether a durable application hold is the right response. Required, so
       * every refusal site decides: a durable state (a missing node, a failed
       * deploy, a blocked gate) holds, while a transient refusal or the
       * caller's own staleness does not.
       */
      holdable: boolean;
      /**
       * True when the pause this refusal names is already on record: the
       * application is paused, or every remaining target is. A caller that
       * holds transient refusals still skips these, because a second pause
       * would need a second Resume to undo one decision.
       */
      alreadyPaused?: boolean;
    };

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
 * Whether any live target of this application has an operation in flight.
 *
 * Read from the target rows rather than from the application pointer, because a
 * target can be mid-deploy while the application itself has nothing running: the
 * two are separate machines and only the target knows about its own apply.
 *
 * Exported because the placement decision needs the same answer for the same
 * reason. A sequential rollout sets its stage on the target, so a check that only
 * reads the application pointer cannot see a rollout that is mid-deploy. An
 * automatic placement approved during one clears the authorization and
 * supersedes the generation that deploy is running under.
 *
 * An unresolved health run counts as in flight too. The stage covers the apply
 * and the acknowledgement that ends it, but not what follows: a rollout is acked
 * before its verdict lands, so its target sits acked-but-unsettled for the rest
 * of the observation window with the run still outstanding, and the stage alone
 * calls that idle. The pointer is the target's own record of the run it awaits,
 * the same one the dispatch queue and the startup reconciliation read, and the
 * gate does not care which policy reserved it: observe decides nothing from a
 * verdict and its queue does not wait for one, so the run it reserves is pure
 * observation, and the only thing an approval during that window displaces is
 * the rollout generation the run is bound to.
 *
 * A pointer that outlives its verdict does not hold anything up for ever. The
 * startup reconciliation walks every target still pointing at a run: a run that
 * went terminal has its recorded verdict replayed through the same transition a
 * live one takes, and only a run whose row is gone needs the pointer released.
 */
export function hasTargetOperationInFlight(store: GitOpsStore, applicationId: string): boolean {
  return store
    .listTargets(applicationId)
    .some(
      (target) =>
        target.target_status === 'active'
        && (target.active_operation_stage !== null || target.pending_health_run_id !== null),
    );
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

    // Whether authority already exists decides two gates below, because both of
    // them govern whether authority may be *created*, not what may be executed
    // with it. An operator who authorized a rollout and an operator who let a
    // policy authorize one have both granted it; neither grant is withdrawn by a
    // later configuration change, and neither should be re-litigated on every
    // dispatch. Skipping the gates also keeps a routine background source fetch
    // from pausing a rollout that is already authorized and running.
    //
    // The preflight evaluation and the drift remint still run either way, since
    // that is this function's other job and it is about evidence rather than
    // authority.
    const alreadyAuthorized = liveRolloutBinding(app) !== null;

    // A conflicting operation is a refusal, not a wait. The pause check above
    // only knows about a deliberate pause, so without this an authorization
    // could be minted while a fetch, apply, deploy, or recovery is still running
    // for the application, and the two would then disagree about what the next
    // operation acts on.
    if (!alreadyAuthorized && app.active_operation_stage) {
      return { ok: false, reason: 'An operation is already in flight for this application.' };
    }
    if (!alreadyAuthorized && hasTargetOperationInFlight(store, app.id)) {
      return { ok: false, reason: 'An operation is already in flight for a rollout target.' };
    }

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

    // Only now that the authorization ingredients are all in place is the policy
    // question worth answering: the gate is "may policy authorize this, or must a
    // human", and it has no meaning until there is something to authorize. Placed
    // earlier it masked the prerequisite that was actually missing, reporting a
    // policy statement where the actionable fact was an unapproved placement.
    // It is also a question about minting only, so an authorization that already
    // exists is not re-litigated against a policy that has since changed.
    //
    // The operator path is unaffected: an operator asking to authorize is itself
    // the authority, and no policy stands in the way of one.
    //
    // Without this the column is write-only. An operator could set the policy to
    // manual, get a success response and a history row, and then watch the next
    // dispatch mint anyway, under a generation frozen with a policy that did not
    // govern it.
    if (
      !alreadyAuthorized &&
      authority === 'configured_policy' &&
      app.rollout_authorization_policy !== 'automatic'
    ) {
      return { ok: false, reason: 'The rollout authorization policy requires an operator to authorize.' };
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
    // The strategy is frozen here, not read later: a rollout generation is
    // immutable once written, so this is the only moment the policy that governs
    // this rollout can be captured. A policy the operator changes afterwards
    // applies at the next authorization, never to a rollout already running.
    const strategyJson = frozenStrategyFor(store, app, ingredients.intentRevisionId);
    // The policy this mint is recorded under, read here rather than from the row
    // this function opened with. Reading after the preflight await is what
    // matters: that await is long enough for a policy edit to land, so a snapshot
    // taken from the row read before it would already be stale by the time the
    // write transaction compares it. What is left is the synchronous gap to the
    // write, and an operator mint records no snapshot because no policy decided
    // it.
    const policyProvenanceJson = authority === 'configured_policy'
      ? encodePolicySnapshot(configuredSnapshotFor(store.getApplication(applicationId) ?? app))
      : null;
    try {
      transitions.rolloutAuthorized({
        applicationId: app.id,
        approvalId,
        rolloutGenerationId,
        preflightFingerprint,
        preflightEvidenceJson,
        strategyJson,
        actor,
        envelope: envelopeFor(actor, trigger),
        authority,
        policyProvenanceJson,
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
          // Read again rather than reused from above: the failed attempt and the
          // invalidation both happened after that read, and the retry is a
          // separate mint that has to carry the snapshot for itself. Reading
          // here also keeps the window the agreement check guards down to the
          // write. The racing writer's row is preferred because it is the
          // freshest, and the caller's row is the fallback for an application
          // that could not be read at all.
          const racedPolicyProvenanceJson = authority === 'configured_policy'
            ? encodePolicySnapshot(configuredSnapshotFor(raced ?? app))
            : null;
          try {
            transitions.rolloutAuthorized({
              applicationId: app.id,
              approvalId: randomUUID(),
              rolloutGenerationId: randomUUID(),
              preflightFingerprint,
              preflightEvidenceJson,
              strategyJson,
              actor,
              envelope: envelopeFor(actor, `${trigger}:preflight_race`),
              authority,
              policyProvenanceJson: racedPolicyProvenanceJson,
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

/**
 * Whether a target has already acknowledged this exact rollout.
 *
 * The test reads the target's bound rollout identity, never its latest stage.
 * A stage is a moving label that every later observation overwrites, and a
 * health verdict overwrites it too: a target that passed and was then health
 * checked no longer reads as acked, so a queue that tested the stage would pick
 * the same target again and advance nowhere. The intent, applied generation, and
 * authorization ref are what the ack actually asserted, and they survive every
 * observation written after it.
 */
function targetAlreadyAcked(
  target: ReturnType<GitOpsStore['getTarget']>,
  binding: FutureRolloutAuthorizationBinding,
  liveAuthorizationRef: string,
): boolean {
  if (!target || target.target_status !== 'active') return false;
  return target.intent_revision_id === binding.intentRevisionId
    && target.applied_generation_id === binding.acceptedGenerationId
    && target.rollout_authorization_ref === liveAuthorizationRef;
}

/**
 * A target a health-gated rollout is still waiting on.
 *
 * Its health run was allocated before the apply went out, so the row outlives a
 * lost response. While that is set the target belongs to the gate, not to the
 * queue: dispatching it again would put two runs on one rollout attempt and
 * leave two verdicts fighting over one target.
 */
function awaitingHealthVerdict(
  target: ReturnType<GitOpsStore['getTarget']>,
): boolean {
  return target?.pending_health_run_id != null;
}

/**
 * A target whose health this rollout has already settled.
 *
 * Acknowledged is not verified. A target that acked its apply and is now waiting
 * on its verdict has the same applied generation as one that acked and passed,
 * so the ack test cannot tell them apart, and a queue built on it would run the
 * whole fleet while the first target is still unverified. Settled means a passing
 * verdict for the generation the target is running right now, which is exactly
 * what the health transition records when it promotes.
 *
 * A target that was already healthy on the generation it runs also reads as
 * settled, so a target whose verdict already passed is not verified twice inside
 * one rollout. Re-authorization is not covered: a new authorization mints a new
 * approval ref, so `targetAlreadyAcked` is false and every target is verified
 * again, which is the intent.
 */
function settledForGatedRollout(
  target: ReturnType<GitOpsStore['getTarget']>,
  binding: FutureRolloutAuthorizationBinding,
  liveAuthorizationRef: string,
): boolean {
  if (!target) return false;
  if (!targetAlreadyAcked(target, binding, liveAuthorizationRef)) return false;
  const running = target.applied_generation_id;
  if (!running) return false;
  if (target.healthy_generation_id === running) return true;
  return target.last_health_status === 'passed' && target.last_health_generation_id === running;
}

/**
 * Whether a fence ends this target's turn in the queue rather than asking for
 * another attempt.
 *
 * A policy that stopped, paused, or rolled back has said what it is going to do
 * with this target, and only `retry_once` asks for it to be deployed again. So
 * after an operator resumes, those targets are done: the queue moves past them
 * to the targets it never reached. Treating them as still waiting would make a
 * resume a silent no-op, because the first unsettled target is always the one
 * that failed.
 */
/** A fence that still holds the rollout, which an acknowledged one no longer does. */
function holdableHealthFence(target: GitOpsTargetCurrentRow | undefined): boolean {
  if (!target) return false;
  if (target.health_stop_reason === null) return false;
  return target.health_stop_reason !== 'health_retried'
    && target.health_stop_reason !== 'stop_acknowledged';
}

function fencedOutOfTheQueue(
  target: GitOpsTargetCurrentRow | undefined,
  app: GitOpsApplicationRow,
): boolean {
  if (!target) return false;
  if (target.health_stop_reason === null || target.health_stop_reason === 'health_retried') {
    return false;
  }
  // A fence belongs to the rollout that wrote it. A later authorization mints a
  // new rollout generation, and that rollout never stopped this target: without
  // the scoping the new rollout would skip the target for ever, and the screen
  // would report it complete without it. The reset at ack time cannot save it,
  // because a fenced target is filtered out of the queue before it can be re-acked.
  return target.rollout_generation_id === app.rollout_generation_id;
}

/**
 * Dispatch an accepted generation across the frozen Blueprint place set.
 *
 * Content comes from the generation's applied materialization, never from
 * blueprints.compose_content. Per-target stage rows are written before
 * transport so restart can skip committed acks.
 */
/**
 * The rollout strategy frozen into a new rollout generation.
 *
 * The health policy comes from the intent revision the rollout is authorized
 * against, not from the application's current pointer, so a rollout always
 * freezes the intent it was actually built for. The runtime drift pair is read
 * off the same row so the whole strategy comes from one authority record.
 */
export function frozenStrategyFor(
  store: GitOpsStore,
  app: GitOpsApplicationRow,
  intentRevisionId: string,
): string {
  const intent = store.getIntentRevision(intentRevisionId);
  const healthPolicy = decodeIntentHealthPolicy(intent?.health_failure_rollback_policy_json);
  return encodeFrozenRolloutStrategy({
    healthPolicy,
    // The mode in force when the rollout is authorized, not the one the intent
    // happened to be minted with. A drift-mode-only edit mints no intent by
    // design, so freezing the snapshot would record a mode the operator has
    // already changed.
    driftMode: liveDriftMode(app, intent?.runtime_drift_policy ?? null),
    enabled: intent ? decodeEnabled(intent.rollout_strategy_json) : null,
  });
}

/** The Blueprint's current drift mode, falling back to the intent's snapshot. */
function liveDriftMode(app: GitOpsApplicationRow, snapshot: string | null): string | null {
  if (app.blueprint_id === null) return snapshot;
  return DatabaseService.getInstance().getBlueprint(app.blueprint_id)?.drift_mode ?? snapshot;
}

/** Whether the intent's Blueprint was enabled when it was minted. */
function decodeEnabled(rolloutStrategyJson: string): boolean | null {
  try {
    return decodeFrozenRolloutStrategy(rolloutStrategyJson).enabled;
  } catch {
    return null;
  }
}

/**
 * Test-only injectable probe for the remote health-rollout capability check.
 * Production always uses the live probe.
 */
let healthCapabilityProbeForTests: ((nodeId: number) => Promise<RemoteCapabilityProbe>) | null = null;

export function setHealthCapabilityProbeForTests(
  fn: ((nodeId: number) => Promise<RemoteCapabilityProbe>) | null,
): void {
  healthCapabilityProbeForTests = fn;
}

/**
 * The health policy frozen into the rollout this dispatch is executing.
 *
 * Read from the live rollout generation rather than the intent revision, because
 * the generation is what was authorized. A policy the operator changed after
 * authorization belongs to the next rollout, not this one.
 *
 * An unreadable strategy throws, and the caller refuses the dispatch: the row is
 * an authority record, and defaulting it to `observe` would run a fleet-wide
 * rollout an operator had gated.
 *
 * A rollout with no generation row at all has no frozen policy to read, and
 * resolves to `observe` downstream: that is the compatibility default for a
 * rollout that was never gated, not a fallback for one that was.
 */
type FrozenHealthPolicy =
  | { kind: 'policy'; policy: HealthRolloutPolicy }
  /** No rollout generation: a rollout that was never gated. */
  | { kind: 'absent' }
  /** A rollout generation exists but no longer matches the live binding. */
  | { kind: 'moved_on' }
  /** A generation is named but cannot be read, or belongs to another application. */
  | { kind: 'unreadable' };
type DispatchPolicy =
  | { kind: 'policy'; policy: HealthRolloutPolicy }
  | { kind: 'refused' };

function frozenHealthPolicy(
  store: GitOpsStore,
  app: GitOpsApplicationRow,
  binding: FutureRolloutAuthorizationBinding,
): FrozenHealthPolicy {
  if (!app.rollout_generation_id) return { kind: 'absent' };
  const generation = store.getRolloutGeneration(app.rollout_generation_id);
  // A named generation that cannot be read is a damaged authority pointer, not
  // a rollout that was never gated. Reading it as absent would remove the gating
  // a damaged pointer cannot be trusted to have removed, and sweep the fleet.
  if (!generation || generation.application_id !== app.id) return { kind: 'unreadable' };
  if (generation.accepted_generation_id !== binding.acceptedGenerationId) {
    return { kind: 'moved_on' };
  }
  return { kind: 'policy', policy: decodeFrozenRolloutStrategy(generation.rollout_strategy_json).healthPolicy };
}

/**
 * The policy a dispatch executes, with the one case that must not be guessed.
 *
 * A rollout generation whose accepted generation no longer matches the live
 * binding is a rollout the application has moved past. Reading it as `observe`
 * would run the whole target sweep ungated, which is the opposite of what the
 * operator gated, so the dispatch refuses instead. An absent generation is a
 * rollout that was never gated and resolves to the default.
 */
function policyForDispatch(
  store: GitOpsStore,
  app: GitOpsApplicationRow,
  binding: FutureRolloutAuthorizationBinding,
): DispatchPolicy {
  let frozen: FrozenHealthPolicy;
  try {
    frozen = frozenHealthPolicy(store, app, binding);
  } catch (error) {
    // An unreadable frozen strategy is refused here rather than thrown onward.
    // `dispatchAcceptedGeneration` promises a blocked outcome instead of a throw,
    // and an uncaught one would abort reconstruction for every later application.
    console.error(
      '[GitOps] Frozen rollout strategy for %s could not be read; the dispatch is refused:',
      sanitizeForLog(app.id), sanitizeForLog(error instanceof Error ? error.message : String(error)),
    );
    return { kind: 'refused' };
  }
  if (frozen.kind === 'moved_on' || frozen.kind === 'unreadable') return { kind: 'refused' };
  return frozen.kind === 'policy'
    ? frozen
    : { kind: 'policy', policy: DEFAULT_HEALTH_ROLLOUT_POLICY };
}

/** The stack a Blueprint target is deployed under, as the intent names it. */
function deployStackNameFor(
  store: GitOpsStore,
  app: GitOpsApplicationRow,
  nodeId: number,
): string | null {
  const target = store.getTarget(app.id, nodeId);
  const targetIntent = target?.intent_revision_id
    ? store.getIntentRevision(target.intent_revision_id)
    : undefined;
  const appIntent = app.intent_revision_id ? store.getIntentRevision(app.intent_revision_id) : undefined;
  return targetIntent?.deploy_stack_name
    ?? app.configured_source_stack_name
    ?? appIntent?.deploy_stack_name
    ?? null;
}

/**
 * Refuse a non-observe health-gated rollout to a target this instance cannot
 * observe.
 *
 * The hub runs a health gate on a target's behalf by reading that target's
 * Docker directly, and a remote node's Docker is not directly reachable; all
 * access to it goes through the HTTP proxy. Sending non-observe health work to a
 * node that cannot serve the verdict would leave the rollout waiting on evidence
 * that can never arrive, so the refusal happens before the apply is dispatched
 * and before any run is reserved.
 *
 * A local target is not probed: this instance can already read it, so there is
 * nothing to confirm.
 */
async function refuseUngatedRemoteTarget(
  node: Node,
  policy: HealthRolloutPolicy,
): Promise<string | null> {
  if (node.type !== 'remote') return null;
  const probe = healthCapabilityProbeForTests
    ? await healthCapabilityProbeForTests(node.id)
    : await probeRemoteCapability(node.id, HEALTH_ROLLOUT_POLICY_CAPABILITY);
  if (probe.kind === 'supported') return null;
  if (probe.kind === 'unreachable') {
    return `Node ${node.name} could not be asked whether it supports health-gated rollout (${probe.detail}); the rollout policy "${policy}" was not applied.`;
  }
  return `Node ${node.name} does not support health-gated rollout, so the policy "${policy}" cannot run against it. Choose "observe" for this application, or move the target to a node that supports it.`;
}

type ReservedTargetRun =
  /** A run this dispatch opened. */
  | { status: 'reserved'; runId: string; stackName: string }
  /** This rollout's own earlier run, adopted so it keeps observing the attempt. */
  | { status: 'replayed'; runId: string; stackName: string }
  | { status: 'skip'; runId: null }
  | { status: 'blocked'; reason: string; holdable: boolean };

/**
 * Allocate the health run for one target, before its apply goes out.
 *
 * The row is written first on purpose: a lost apply response then still leaves a
 * durable run naming the application, intent, rollout generation, artifact set,
 * and frozen policy, which is what a restart reads to decide the attempt became
 * unknown instead of silently completing.
 *
 * The target's pending-run pointer is written by the same transition that opens
 * the deploy, so the queue cannot pick this target up again between the
 * reservation and the ack.
 */
function reserveTargetHealthRun(args: {
  app: GitOpsApplicationRow;
  binding: FutureRolloutAuthorizationBinding;
  node: Node;
  stackName: string | null;
  policy: HealthRolloutPolicy;
  actor: string | null;
}): ReservedTargetRun {
  if (!args.stackName) {
    return {
      status: 'blocked',
      holdable: true,
      reason: `The stack name for node ${args.node.id} could not be read, so no health run could be reserved.`,
    };
  }
  if (!args.binding.acceptedGenerationId) {
    return {
      status: 'blocked',
      holdable: true,
      reason: 'The accepted generation is missing, so no health run could be bound to this rollout.',
    };
  }
  const reservation = HealthGateService.getInstance().reserveRolloutRun({
    applicationId: args.app.id,
    intentRevisionId: args.binding.intentRevisionId,
    rolloutGenerationId: args.app.rollout_generation_id ?? '',
    acceptedGenerationId: args.binding.acceptedGenerationId,
    artifactSetId: args.binding.artifactSetId,
    healthPolicy: args.policy,
    nodeId: args.node.id,
    stackName: args.stackName,
    actor: args.actor,
  });
  if (reservation.outcome === 'disabled') {
    // Observe records nothing, so a rollout under it does not depend on the
    // gate and runs exactly as it did before this policy existed. A gated
    // rollout cannot be quietly downgraded to that, so it is refused instead.
    if (!gatesAdvancement(args.policy)) return { status: 'skip', runId: null };
    return {
      status: 'blocked',
      holdable: true,
      reason: 'The health gate is turned off, so a rollout that depends on health outcomes was not dispatched. Turn the health gate on, or set this application to observe.',
    };
  }
  if (reservation.outcome === 'replayed' && reservation.runId) {
    // The id is kept, not dropped. A process that stopped between reserving and
    // recording the pointer left a run nobody owns; reconstruction replays this
    // apply, and the run is the one that will observe it. Losing the id here
    // would apply the generation with nothing watching, and the startup sweep
    // would then find no target pointing at the run it has to finalize.
    return { status: 'replayed', runId: reservation.runId, stackName: args.stackName };
  }
  if (!reservation.runId) {
    return { status: 'blocked', reason: 'The health run for this target could not be reserved.', holdable: true };
  }
  return { status: 'reserved', runId: reservation.runId, stackName: args.stackName };
}

/**
 * Attach the poll timer to a run that was reserved before the apply.
 *
 * The stack name travels with the reservation rather than being looked up again:
 * two rollouts can be in flight for different stacks on one node, and an arm
 * addressed to whichever run happened to be newest would observe the wrong one.
 */
function armTargetHealthRun(node: Node, reserved: { runId: string; stackName: string }): void {
  const gate = HealthGateService.getInstance();
  try {
    gate.armRolloutRun(reserved.runId, node.id, reserved.stackName);
  } catch (error) {
    // A reservation this process cannot arm is finalized unknown by the same
    // path a crash would take, so the rollout pauses on missing evidence rather
    // than waiting on a run nothing is observing.
    gate.abandonReservedRun(
      reserved.runId,
      node.id,
      reserved.stackName,
      'The health run could not be started after the apply',
    );
    console.error(
      '[BlueprintTargetAdapter] could not arm the rollout health run for node=%s: %s',
      node.id,
      sanitizeForLog(errorMessage(error)),
    );
  }
}

function abandonTargetHealthRun(node: Node, reserved: { runId: string; stackName: string }): void {
  HealthGateService.getInstance().abandonReservedRun(
    reserved.runId,
    node.id,
    reserved.stackName,
    'The apply did not complete, so there was nothing to observe',
  );
}

export class BlueprintTargetAdapter implements TargetAdapter {
  async dispatch(generation: AcceptedGeneration, _context: DispatchContext): Promise<DispatchResult> {
    const store = GitOpsStore.getInstance();
    const app = store.getApplication(generation.applicationId);
    if (!app) {
      return { status: 'blocked', reason: 'The application could not be read; dispatch is unavailable.', holdable: false };
    }
    if (app.target_mode !== 'blueprint') {
      return { status: 'blocked', reason: 'Blueprint dispatch requires Blueprint target mode.', holdable: false };
    }
    // Suspension freezes automation for this source, the same way it stops the
    // SourceController's acceptance and GitSourceService.retry. Refusing here
    // covers every caller, including a future one that forgets to check.
    if (app.suspended_at) {
      return { status: 'blocked', reason: 'The source is suspended.', holdable: false };
    }
    const blueprintId = app.blueprint_id;
    if (blueprintId === null) {
      return { status: 'blocked', reason: 'No Blueprint is bound to this application.', holdable: false };
    }
    // A pause is an execution hold, not a rendering state: nothing dispatches
    // while it is set, including the boot-time reconstruction that resumes
    // authorized rollouts.
    if (app.pause_at) {
      return { status: 'blocked', reason: 'The rollout is paused.', holdable: false, alreadyPaused: true };
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
    if (!auth.ok) return { status: 'blocked', reason: auth.reason, holdable: false };
    const binding = auth.binding;

    if (generation.generationId !== binding.acceptedGenerationId) {
      // The caller dispatched a generation the live binding has moved past.
      // That is the caller's staleness, not a state of this rollout, so it must
      // not pause the successor the binding now names.
      return {
        status: 'blocked',
        reason: 'The accepted generation does not match the authorized application generation.',
        holdable: false,
      };
    }

    const liveApp = store.getApplication(app.id);
    if (!liveApp?.rollout_authorization_ref) {
      return { status: 'blocked', reason: 'Rollout authorization is missing after mint.', holdable: false };
    }
    if (!resolvesRolloutAuthorization(liveApp, binding)) {
      return {
        status: 'blocked',
        reason: 'The current rollout authorization no longer matches the live binding.',
        holdable: false,
      };
    }
    if (liveApp.pause_at) {
      return { status: 'blocked', reason: 'The rollout is paused.', holdable: false, alreadyPaused: true };
    }
    const liveAuthorizationRef = liveApp.rollout_authorization_ref;

    const genRow = store.getGeneration(binding.acceptedGenerationId);
    if (!genRow || genRow.application_id !== liveApp.id) {
      return { status: 'blocked', reason: 'The authorized generation row could not be read.', holdable: false };
    }

    let composeContent: string;
    try {
      composeContent = await readAppliedComposeContent(liveApp, genRow);
    } catch (err) {
      // Not held: a missing materialization is a file state rather than a
      // verdict on the rollout. A caller that can re-drive it does (the
      // reconciler retries preparation while the artifact is unresolved); the
      // health executor holds it because nothing else re-drives its queue.
      return { status: 'blocked', reason: errorMessage(err), holdable: false };
    }

    const blueprint = DatabaseService.getInstance().getBlueprint(blueprintId);
    if (!blueprint) {
      return { status: 'blocked', reason: 'The bound Blueprint could not be read.', holdable: false };
    }

    const tx = GitOpsTransitions.getInstance();
    const svc = BlueprintService.getInstance();
    const frozenForDispatch = policyForDispatch(store, liveApp, binding);
    if (frozenForDispatch.kind === 'refused') {
      return {
        status: 'blocked',
        holdable: true,
        reason: 'The rollout this application was authorized for is no longer the one on record.',
      };
    }
    const healthPolicy = frozenForDispatch.policy;
    const gated = gatesAdvancement(healthPolicy);
    const pausedTargets: number[] = [];
    let anyDispatched = false;
    // Under a health-gated policy the queue is one target deep: this call takes
    // the first target whose health this rollout has not settled, and that
    // target's verdict is what brings the next one. Unsettled rather than
    // unacked, because an acked target is still unverified until its verdict
    // passes. Observe keeps the whole-sweep loop it has always run, because
    // observing outcomes is not gating anything.
    const queue = gated
      ? binding.requiredNodeIds.filter((nodeId) => {
        const row = store.getTarget(liveApp.id, nodeId);
        return !settledForGatedRollout(row, binding, liveAuthorizationRef)
          && !fencedOutOfTheQueue(row, liveApp)
          && !row?.pause_at;
      }).slice(0, 1)
      : binding.requiredNodeIds;

    // A roll back that was decided but never finished stops the whole rollout,
    // not just that one target. Excluding a `rollback_pending` target from the
    // queue would let the queue step over it and deploy the next one, so the
    // fleet advances past a target that is still on the generation which failed,
    // with no restore done and nobody told. It has to be finished or undone
    // through the manual restore route before anything else runs.
    if (gated) {
      const unfinished = binding.requiredNodeIds
        .map((nodeId) => store.getTarget(liveApp.id, nodeId))
        .some((row) => row?.health_stop_reason === 'rollback_pending'
          && row.rollout_generation_id === liveApp.rollout_generation_id);
      if (unfinished) {
        return {
          status: 'blocked',
          holdable: true,
          reason: 'A roll back for this rollout has not finished. Finish or undo it before the rollout continues.',
        };
      }
    }

    // A gated rollout refuses a target set it cannot observe as a whole, before
    // the first apply rather than at the turn of each target. Refusing per target
    // would let an earlier local target deploy and pass, then refuse a later
    // remote one, leaving a partially deployed rollout the operator has to
    // unpick by hand.
    if (gated) {
      for (const nodeId of binding.requiredNodeIds) {
        const node = DatabaseService.getInstance().getNode(nodeId);
        if (!node) {
          return { status: 'blocked', reason: `Required target node ${nodeId} is missing.`, holdable: true };
        }
        const refusal = await refuseUngatedRemoteTarget(node, healthPolicy);
        if (refusal) return { status: 'blocked', reason: refusal, holdable: true };
      }
    }

    // Every frozen target gets its row before the first deploy, the same
    // first-contact write the Inline producer makes on `deploy_start`. A
    // Blueprint application has no targets until something is sent somewhere,
    // and this path sends to the frozen set rather than one node at a time:
    // without these rows a multi-node rollout dispatched against
    // `requiredNodeIds` fails on the first target whose row was never created,
    // because `blueprintDeployStarted` resolves through the target row and
    // refuses an unknown target. A node that no longer exists is skipped here;
    // the gated preflight refuses it before any row is created, and the deploy
    // loop refuses it by name for the other policies. A row already present is
    // left untouched, so a tombstoned target, a fence, or a spent retry budget
    // survives row creation and only an actual deploy revives the target.
    // Rows are written before the per-target lock and pause checks on purpose:
    // an authorized rollout whose first target is briefly held still has a
    // frozen set, and the projection should read it as queued rather than
    // absent.
    const now = Date.now();
    for (const nodeId of binding.requiredNodeIds) {
      if (store.getTarget(liveApp.id, nodeId)) continue;
      if (!DatabaseService.getInstance().getNode(nodeId)) continue;
      store.upsertTarget(emptyTargetRow(liveApp.id, nodeId, now));
    }

    for (const nodeId of queue) {
      // Re-read before every target: a pause that lands while this loop runs
      // stops the rollout at the next target rather than after the fleet.
      if (store.getApplication(liveApp.id)?.pause_at) {
        return { status: 'blocked', reason: 'The rollout was paused while it was running.', holdable: false, alreadyPaused: true };
      }
      const target = store.getTarget(liveApp.id, nodeId);
      // A per-target pause holds that target alone: the rest of the queue
      // continues, and this target is retried by the dispatch a later resume
      // triggers.
      if (target?.pause_at) {
        pausedTargets.push(nodeId);
        continue;
      }
      // A fence ends this target's part in the rollout: re-dispatching it would
      // re-apply the generation the policy just stopped, paused, or rolled
      // back. A retry is the one exception, because that fence is the policy
      // asking for exactly this dispatch.
      if (gated && fencedOutOfTheQueue(target, liveApp)) {
        continue;
      }
      if (gated && awaitingHealthVerdict(target)) {
        // The target owns a reserved run from this rollout, so a second apply
        // would put two observations and two verdicts on one attempt. Its queue
        // turn is the verdict's to bring, not this dispatch's.
        continue;
      }
      // Under a gated policy an acked-but-unsettled target is the retry the
      // policy asked for: it acked, its verdict failed, and nothing has
      // re-applied it yet. Skipping on the ack alone would leave the queue
      // permanently stuck behind the first failure, and both `retry_once` and a
      // resume after a pause would report a dispatch that never happened.
      const isRetry = gated && targetAlreadyAcked(target, binding, liveAuthorizationRef);
      if (!gated && targetAlreadyAcked(target, binding, liveAuthorizationRef)) {
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
        return { status: 'blocked', reason: `Required target node ${nodeId} is missing.`, holdable: true };
      }

      // Refused before the apply and before any run is reserved: sending
      // non-observe health work to a target whose verdict cannot come back
      // would leave the rollout waiting on evidence that never arrives.
      if (gated) {
        const refusal = await refuseUngatedRemoteTarget(node, healthPolicy);
        if (refusal) return { status: 'blocked', reason: refusal, holdable: true };
      }

      // A replayed reservation is this target's own earlier run for the same
      // rollout, which a resume or a restart re-entered. Adopt it rather than
      // opening a second observation of one attempt.
      const reserved = reserveTargetHealthRun({
        app: liveApp,
        binding,
        node,
        stackName: deployStackNameFor(store, liveApp, nodeId),
        policy: healthPolicy,
        actor: generation.actor ?? null,
      });
      if (reserved.status === 'blocked') return reserved;

      if (!svc.tryAcquireAuthorizedDeployLock(blueprint.id, nodeId)) {
        if (reserved.status === 'reserved') abandonTargetHealthRun(node, reserved);
        return {
          status: 'blocked',
          reason: `Deploy to node ${nodeId} is already in progress.`,
          holdable: false,
        };
      }

      try {
        try {
          tx.blueprintDeployStarted({
            applicationId: liveApp.id,
            nodeId,
            intentRevisionId: binding.intentRevisionId,
            rolloutCandidateId: binding.rolloutCandidateId,
            pendingHealthRunId: reserved.status === 'skip' ? null : reserved.runId,
            envelope: envelopeFor(generation.actor, trigger),
          });
        } catch (err) {
          // The reservation above is now armed by nobody, so this run has to be
          // abandoned here. Not for the reason the ack catch gives: that throw
          // happens after the deploy-start row is written, so the pointer is set
          // and a later dispatch really does skip this target. This one throws
          // *inside* the mutate, before `pending_health_run_id` is written, so
          // nothing is skipped. The hazard is the row itself: an observing run
          // for a deploy that was never opened, which reads as an open
          // observation of the accepted generation and would hide a health
          // failure on it until a later run replaced the row or a restart swept
          // it. Finalizing the row is what keeps that from being possible.
          if (reserved.status === 'reserved' || reserved.status === 'replayed') {
            abandonTargetHealthRun(node, reserved);
          }
          return {
            status: 'blocked',
            reason: `Could not open deploy for node ${nodeId}: ${errorMessage(err)}`,
            // Not held: a refused transition is a store contention or an
            // invariant refusal, not a verdict on the rollout. The health
            // executor holds it because nothing else re-drives its queue.
            holdable: false,
          };
        }

        // The marker is the only on-node record of what this deploy installed.
        // Naming the generation, its artifact set, and the rollout that
        // authorized it is what lets a later drift check prove what a repair
        // would overwrite instead of inferring it from the application's
        // current pointers.
        const marker = buildBlueprintMarker({
          blueprintId: blueprint.id,
          revision: blueprint.revision,
          lastApplied: Date.now(),
          applicationId: liveApp.id,
          bindingRevision: binding.intentRevisionId,
          generationId: binding.acceptedGenerationId,
          artifactSetId: binding.artifactSetId,
          rolloutGenerationId: liveApp.rollout_generation_id ?? undefined,
        });

        // Capture the pre-deploy state so this rollout can be rolled back later.
        // A retry must not re-capture: the recovery point the first attempt took
        // is the pre-rollout state, and capturing again would replace it with the
        // generation that just failed health, which is the one a rollback has to
        // restore *from*.
        const recoveryTarget = store.getTarget(liveApp.id, nodeId);
        const outcome = await svc.deployAuthorizedMaterialization({
          blueprint,
          node,
          composeContent,
          marker,
          auditPath: `/api/blueprints/${blueprint.id}/rollout/${liveApp.id}`,
          lockHeld: true,
          captureRecovery: !isRetry,
          recoveryBinding: recoveryBindingForTarget(liveApp, recoveryTarget),
        });

        if (outcome.status !== 'active') {
          // The stack never changed, so the reserved run has nothing to observe.
          // Finalized unknown rather than abandoned silently: a durable row that
          // says "this rollout allocated a health run it never got" is the
          // evidence a restart needs to tell a lost apply from a failed one.
          if (reserved.status === 'reserved') abandonTargetHealthRun(node, reserved);
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
            holdable: true,
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
            // The generation this target ran before the apply, and only on the
            // first attempt. It is what a policy-driven rollback restores, and
            // recording it here is what makes a rollback possible at all: the
            // node's recovery row is the hub's only other handle on that point,
            // and it never leaves the node.
            recoveryGenerationId: isRetry
              ? null
              : recoveryBindingForTarget(liveApp, recoveryTarget).gitops_generation_id,
            envelope: envelopeFor(generation.actor, trigger),
          });
        } catch (err) {
          // An adopted run is abandoned here too. It was never armed, and the
          // pointer is still set, so leaving it would make every later dispatch
          // skip the target as awaiting a verdict that nothing will ever report,
          // while still reporting the dispatch as successful.
          if (reserved.status === 'reserved' || reserved.status === 'replayed') {
            abandonTargetHealthRun(node, reserved);
          }
          return {
            status: 'blocked',
            reason: `Could not record ack for node ${nodeId}: ${errorMessage(err)}`,
            // Same as the deploy-open refusal: a store refusal is not a verdict
            // on the rollout, and the health executor holds it because nothing
            // else re-drives its queue.
            holdable: false,
          };
        }
        // A replayed run is armed too, for the same reason the id was kept: it is
        // the run observing this attempt, and an unarmed run never reports.
        if (reserved.status === 'reserved' || reserved.status === 'replayed') {
          armTargetHealthRun(node, reserved);
        }
        anyDispatched = true;
      } finally {
        svc.releaseAuthorizedDeployLock(blueprint.id, nodeId);
      }
    }

    // Nothing ran because every remaining target is paused: report the hold
    // rather than a dispatch, so the caller does not count it as progress. The
    // pause is already the durable record, and escalating a per-target pause to
    // an application pause would need two Resumes (the target's and the
    // fleet's) to undo one decision, so this refusal is not holdable.
    if (!anyDispatched && pausedTargets.length > 0) {
      return {
        status: 'blocked',
        reason: `The rollout is paused on ${pausedTargets.length} target${pausedTargets.length === 1 ? '' : 's'}.`,
        holdable: false,
        alreadyPaused: true,
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
/**
 * The production health-rollout follow-up.
 *
 * Both entry points are the same dispatch. The distinction between advancing to
 * the next target and retrying the one that just failed is already durable on
 * the target (its retry budget is spent, its pending run is consumed), and the
 * adapter reads durable state, so one call keeps the two paths from drifting
 * into different dispatch logic.
 */
export function liveHealthRolloutExecutor(): HealthRolloutExecutor {
  const dispatch = async (applicationId: string, nodeId: number | null): Promise<void> => {
    const store = GitOpsStore.getInstance();
    const application = store.getApplication(applicationId);
    if (!application?.accepted_generation_id) return;
    const generationRow = store.getGeneration(application.accepted_generation_id);
    if (!generationRow) return;
    const result = await new BlueprintTargetAdapter().dispatch(
      buildAcceptedGeneration(generationRow),
      { targetMode: 'blueprint', nodeId, bindingRevision: application.intent_revision_id },
    );
    if (result.status === 'blocked') {
      // Held, not just logged. There is no scheduler here: this dispatch is the
      // only thing that brings the next target, so a refusal left unheld is a
      // rollout that stops with no hold and no recorded reason, and a retry whose
      // budget is already spent. Transient refusals are held too, restoring what
      // this path always did; a pause that is already on record is skipped so one
      // decision never needs two Resumes.
      //
      // Origin `system`: this is a dispatch refusal, not a health verdict. A
      // stale or transient one describes the rollout it was about, so a source
      // acceptance that supersedes that rollout clears it. Only a real policy
      // decision (a stop, a pause, a rollback) carries the health origin.
      holdBlockedRolloutDispatch(applicationId, {
        reason: `The rollout could not advance: ${result.reason}`,
        holdable: result.holdable,
        alreadyPaused: result.alreadyPaused,
      }, {
        actor: 'system:health-rollout-policy',
        trigger: 'startup_reconstruct',
        requireLiveBinding: false,
        holdTransient: true,
        origin: 'system',
      });
      console.warn(
        '[GitOps] Health-gated rollout could not advance %s: %s',
        sanitizeForLog(applicationId),
        sanitizeForLog(result.reason),
      );
    }
  };
  return {
    advance: (applicationId) => dispatch(applicationId, null),
    retry: (applicationId, nodeId) => dispatch(applicationId, nodeId),
  };
}

/**
 * Hold an authorized rollout whose dispatch was refused.
 *
 * A refusal returned only as a note is a rollout that stops with no durable
 * reason: the projection still reads `rollout_queued`, and the workplace has
 * nothing to act on. The hold is the same application pause the health executor
 * uses, so there is one reason to read and one verb (Resume) to clear it. No-op
 * when the application is already paused (its reason is the current one) or
 * when no authorization is live: a refusal before the mint is the caller's to
 * report, and pausing there would hold a rollout nothing has authorized.
 *
 * The origin is chosen by the refusal's kind, never by the caller. A dispatch
 * refusal carries `system`, which is what lets a source acceptance clear it when
 * it supersedes the rollout the hold was about. A real health decision (a stop,
 * a pause, a rollback) carries `health` and survives until the operator resumes;
 * an operator pause carries `operator` and does the same.
 */
export function holdBlockedRolloutDispatch(
  applicationId: string,
  blocked: { reason: string; holdable: boolean; alreadyPaused?: boolean },
  options: {
    actor?: string;
    trigger?: string;
    requireLiveBinding?: boolean;
    /**
     * Hold transient refusals too. The health executor is the only caller that
     * needs this: its dispatch is the only thing that brings the next target,
     * and on this path a transient refusal used to hold, so dropping it would
     * leave the rollout queued with no reason and no re-drive. An
     * already-recorded pause is still skipped. This decides whether to hold, not
     * the origin: an executor dispatch refusal is still a `system` hold.
     */
    holdTransient?: boolean;
    /**
     * Who the hold belongs to. `system` for a dispatch refusal (cleared by a
     * source acceptance that supersedes the rollout), `health` for a policy
     * decision. Defaults to `system`.
     */
    origin?: 'system' | 'health';
  } = {},
): void {
  // A refusal that says nothing durable about the rollout is not a hold for the
  // callers that can be re-driven or that share the rollout with another
  // dispatch. Lock contention resolves when the holder finishes, and a pause is
  // already the durable record; pausing on either would stop a healthy rollout
  // another dispatch is advancing.
  if (!options.holdTransient && blocked.holdable === false) return;
  if (options.holdTransient && blocked.holdable === false && blocked.alreadyPaused === true) return;
  const store = GitOpsStore.getInstance();
  const app = store.getApplication(applicationId);
  if (!app || app.pause_at) return;
  if ((options.requireLiveBinding ?? true) && !liveRolloutBinding(app)) return;
  try {
    GitOpsTransitions.getInstance().rolloutPaused(applicationId, null, blocked.reason, {
      // Fresh per hold, not derived from the application: history and the
      // outbox dedupe on (application, operation, stage), so a deterministic id
      // would let a second hold after a resume commit the pause while writing
      // no history and announcing nothing.
      operationId: randomUUID(),
      actor: options.actor ?? 'system:rollout-dispatch',
      trigger: options.trigger ?? 'blueprint_dispatch',
      at: Date.now(),
    }, options.origin ?? 'system');
  } catch (err) {
    // A hold that cannot be recorded must not turn a refused dispatch into a
    // thrown one: the refusal is the answer, and the hold is only its durable
    // copy. A tombstoned application is the realistic case.
    console.error(
      '[GitOps] Could not hold blocked rollout %s: %s',
      sanitizeForLog(applicationId),
      sanitizeForLog(err instanceof Error ? err.message : String(err)),
    );
  }
}

/**
 * Whether an automatic-policy rollout still has dispatch work to do.
 *
 * The reconciler's content pass uses this to re-drive a handoff that skipped or
 * was transiently refused: a resolved generation with no live authorization
 * (the slow accept, the re-enabled Blueprint), or one whose authorized rollout
 * still has unacked targets (a refusal that nothing else retries).
 *
 * False when the artifact is not resolved, when every required target is
 * settled, or when a remaining target already has an open health run: the gate
 * owns that target, and a second dispatch would adopt the same run and race the
 * verdict for it.
 */
export function gitManagedDispatchWarranted(app: GitOpsApplicationRow): boolean {
  const store = GitOpsStore.getInstance();
  if (!app.accepted_generation_id) return false;
  const blueprint = app.blueprint_id !== null
    ? DatabaseService.getInstance().getBlueprint(app.blueprint_id)
    : undefined;
  if (!blueprint?.enabled) return false;
  const artifact = app.artifact_set_id ? store.getArtifactSet(app.artifact_set_id) : undefined;
  if (!artifact || (artifact.qualification !== 'exact' && artifact.qualification !== 'qualified')) {
    return false;
  }
  // A target with an operation in flight is already being advanced, so a second
  // dispatch would only race the per-target lock and re-run the preflight. A
  // stage left behind by a crash belongs to the boot sweep, which finalizes it.
  if (store.listTargets(app.id).some(
    (target) => target.target_status === 'active' && target.active_operation_stage !== null,
  )) {
    return false;
  }
  // A withdrawn authorization is an operator decision, not a pending handoff.
  // Only `rolloutSuperseded` writes `withdrawn_at`; a system supersede (a
  // preflight drift, a placement invalidation, a re-authorization) leaves it
  // null and stays eligible for the automatic policy to re-mint. The pointer
  // alone cannot tell the two apart, and a placement re-approval can move it
  // onto a generation that is not superseded.
  const latestAuthorization = store.latestRolloutAuthorizationForAcceptedGeneration(
    app.id,
    app.accepted_generation_id,
  );
  if (latestAuthorization && latestAuthorization.withdrawn_at !== null) return false;
  const binding = store.currentAuthorizationBinding(app);
  if (!binding) {
    // The handoff mints under the automatic policy, but only from a state that
    // is actually authorizable. A missing placement approval is the operator's
    // next step (the approve route is where that happens), so calling the
    // handoff every tick would only record its refusal. Once the approval is
    // there, this arm authorizes and dispatches without a person. An unfinished
    // rollback is refused inside the handoff itself, so every caller shares
    // that gate.
    return app.placement_approval_ref !== null;
  }
  const authRef = app.rollout_authorization_ref;
  if (!authRef) return true;
  let frozen: FrozenHealthPolicy;
  try {
    frozen = frozenHealthPolicy(store, app, binding);
  } catch {
    // A frozen policy that cannot be read is a damaged authority pointer; a
    // re-drive could run the wrong gating, so it waits for a person.
    return false;
  }
  const gated = frozen.kind === 'policy' && gatesAdvancement(frozen.policy);
  const remaining = binding.requiredNodeIds.filter((nodeId) => {
    const target = store.getTarget(app.id, nodeId);
    // A fenced target's turn is over: the dispatch queue moves past it, so
    // counting it as remaining would re-drive a rollout with nothing to do.
    if (fencedOutOfTheQueue(target, app)) return false;
    // A per-target pause is a recorded operator decision. The queue skips it,
    // so counting it as remaining would run the full authorization path on
    // every tick with nothing to deploy.
    if (target?.pause_at) return false;
    return gated
      ? !settledForGatedRollout(target, binding, authRef)
      : !targetAlreadyAcked(target, binding, authRef);
  });
  if (remaining.length === 0) return false;
  // An open run under a gating policy is already bringing this target its
  // verdict; a second dispatch would adopt the same run and race the gate.
  if (gated && remaining.some((nodeId) => awaitingHealthVerdict(store.getTarget(app.id, nodeId)))) {
    return false;
  }
  return true;
}

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

    // A target the policy fenced is the end of its own turn, and it holds the
    // rollout until an operator says otherwise. For an acked target the fence
    // commits before the executor's application-wide pause, so a process that
    // exits in that gap leaves a fenced target with no `pause_at`; reconstructing
    // past it here would deploy the targets that came after the one that failed,
    // which is exactly what stop and rollback promised would not happen. Held
    // from the fence itself, so the gap cannot exist.
    //
    // An unacked target's fence cannot be scoped this way, because its pointer
    // names an older rollout or none at all, so this scan cannot see it. Its hold
    // is the application pause, which the transition commits in the same
    // transaction as the fence and which the `pause_at` check above has already
    // honored.
    const fenced = binding.requiredNodeIds
      .map((nodeId) => store.getTarget(app.id, nodeId))
      .find((target) => holdableHealthFence(target) && target!.rollout_generation_id === app.rollout_generation_id);
    if (fenced) {
      // A fence is a health decision, so the hold carries the health origin and
      // waits for the operator even across a later source acceptance.
      holdBlockedRolloutDispatch(app.id, { reason: 'a target was fenced by its health rollout policy', holdable: true }, {
        actor: 'system:health-rollout-policy',
        trigger: 'startup_reconstruct',
        requireLiveBinding: false,
        origin: 'health',
      });
      continue;
    }
    // Under a health-gated policy an acked target is still unverified until its
    // verdict passes, so "unsettled" is the resume set rather than "unacked".
    // Reading it as unacked would drop every observing target from the set and
    // resume the rollout straight past the target that is still being verified.
    const frozen = frozenHealthPolicy(store, app, binding);
    const gated = frozen.kind === 'policy' && gatesAdvancement(frozen.policy);
    const remaining = binding.requiredNodeIds.filter((nodeId) => {
      const target = store.getTarget(app.id, nodeId);
      return gated
        ? !settledForGatedRollout(target, binding, app.rollout_authorization_ref!)
        : !targetAlreadyAcked(target, binding, app.rollout_authorization_ref!);
    });
    if (remaining.length === 0) continue;

    // A target whose reserved run is still open belongs to the boot sweep, not
    // to this queue. That sweep finalizes the run unknown, and the verdict that
    // follows applies the frozen policy, which for unknown is a pause. Re-
    // dispatching here would put a second apply on a target that already has one
    // run outstanding, and two verdicts would then fight over one attempt.
    if (gated && remaining.some((nodeId) => awaitingHealthVerdict(store.getTarget(app.id, nodeId)))) {
      continue;
    }

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
    // A restart is a place refusals cluster (locks still held, targets not yet
    // reachable), so the same durable hold the manual and automatic paths place
    // belongs here too: otherwise the rollout resumes as queued with the reason
    // only in the server log. The origin is explicit: a restart dispatch refusal
    // is a system hold, cleared by a source acceptance like any other.
    holdBlockedRolloutDispatch(app.id, { reason: `The rollout could not advance after a restart: ${result.reason}`, holdable: result.holdable }, {
      origin: 'system',
    });
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
 * rather than serialized. The callback contains every per-application failure,
 * including the live-binding read that decides whether there is anything to
 * evaluate, so one bad application can never reject the batch and abandon the
 * evaluations still in flight. The tally reads stored evidence rather than the
 * returned verdict, because evidence is what derive projects from.
 */
export async function backfillMissingPreflightEvaluations(
  authorize: BackfillAuthorizer = ensureRolloutAuthorization,
): Promise<number> {
  const store = GitOpsStore.getInstance();
  const apps = store.listAuthorizedBlueprintApplications().filter(
    (app) => app.latest_preflight_evidence_json == null,
  );
  let filled = 0;
  await mapWithConcurrency(apps, PREFLIGHT_BACKFILL_CONCURRENCY, async (app) => {
    let result: Awaited<ReturnType<BackfillAuthorizer>> | null = null;
    try {
      // Read inside the callback, not in the filter above: an authorization that
      // no longer resolves is a per-application skip, and a store that fails to
      // resolve one costs that application, never the batch.
      if (!liveRolloutBinding(app)) return;
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
