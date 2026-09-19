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
  buildPreflightEvidence,
  encodePreflightEvidenceJson,
  fingerprintPreflightEvidence,
  isPreflightBlocked,
} from './preflight';
import { stackManagedRoot } from './directApplication';
import { decodeGitOpsRequiredTargetsJson } from './json';
import { DatabaseService } from '../DatabaseService';
import { BlueprintService } from '../BlueprintService';
import { buildBlueprintMarker } from '../../helpers/blueprintMarker';
import { sanitizeForLog } from '../../utils/safeLog';

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
 * one when every binding ingredient is present and preflight is not blocked.
 */
export function ensureRolloutAuthorization(
  applicationId: string,
  actor: string | null,
  trigger = 'blueprint_dispatch',
): { ok: true; binding: FutureRolloutAuthorizationBinding } | { ok: false; reason: string } {
  const store = GitOpsStore.getInstance();
  const app = store.getApplication(applicationId);
  if (!app) return { ok: false, reason: 'The application could not be read.' };
  if (app.target_mode !== 'blueprint') {
    return { ok: false, reason: 'Rollout authorization is only for Blueprint target mode.' };
  }

  const existing = liveRolloutBinding(app);
  if (existing) return { ok: true, binding: existing };
  // Stale or missing live ref: fall through and remint (same CAS as rolloutAuthorized).

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

  const preflight = buildPreflightEvidence();
  if (isPreflightBlocked(preflight)) {
    return { ok: false, reason: 'Preflight is blocked; rollout cannot be authorized.' };
  }
  const preflightFingerprint = fingerprintPreflightEvidence(preflight);
  const preflightEvidenceJson = encodePreflightEvidenceJson(preflight);
  const approvalId = randomUUID();
  const rolloutGenerationId = randomUUID();
  try {
    GitOpsTransitions.getInstance().rolloutAuthorized({
      applicationId: app.id,
      approvalId,
      rolloutGenerationId,
      preflightFingerprint,
      preflightEvidenceJson,
      actor,
      envelope: envelopeFor(actor, trigger),
    });
  } catch (err) {
    const message = errorMessage(err);
    if (/already live/i.test(message)) {
      const raced = store.getApplication(applicationId);
      const binding = raced ? liveRolloutBinding(raced) : null;
      if (binding) return { ok: true, binding };
    }
    return { ok: false, reason: `Rollout authorization failed: ${message}` };
  }

  const refreshed = store.getApplication(applicationId);
  if (!refreshed) return { ok: false, reason: 'The application could not be read after authorization.' };
  const binding = store.currentAuthorizationBinding(refreshed);
  if (!binding) return { ok: false, reason: 'Authorization was written but the live binding could not be formed.' };
  return { ok: true, binding };
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
      throw new Error('accepted generation materialization is missing compose.yaml');
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

    const trigger = generation.trigger || 'blueprint_dispatch';
    const auth = ensureRolloutAuthorization(app.id, generation.actor ?? null, trigger);
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

    for (const nodeId of binding.requiredNodeIds) {
      const target = store.getTarget(liveApp.id, nodeId);
      if (targetAlreadyAcked(target, binding, liveAuthorizationRef)) {
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

        const outcome = await svc.deployAuthorizedMaterialization({
          blueprint,
          node,
          composeContent,
          marker,
          auditPath: `/api/blueprints/${blueprint.id}/rollout/${liveApp.id}`,
          lockHeld: true,
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
      } finally {
        svc.releaseAuthorizedDeployLock(blueprint.id, nodeId);
      }
    }

    return { status: 'dispatched' };
  }
}

/**
 * After interrupted operations are reclassified, continue sequential rollout
 * for authorized Blueprint applications that still have unacked frozen targets.
 */
export async function reconstructBlueprintRolloutQueue(): Promise<number> {
  const store = GitOpsStore.getInstance();
  const apps = store.listAuthorizedBlueprintApplications();
  let resumed = 0;
  for (const app of apps) {
    if (!app.accepted_generation_id || !app.rollout_authorization_ref) continue;
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
