/**
 * Applying a bounded automatic placement decision.
 *
 * The decision itself lives in `placementPolicy.ts` and is pure. This module
 * gathers the evidence it needs, calls it, and applies the result. It runs
 * *after* the caller's transaction has committed, in a transaction of its own,
 * for two reasons.
 *
 * It must not be able to fail the caller's write. A Blueprint create, update, or
 * pin is the operator's work; a refusal or a defect in the decision code must not
 * roll it back. So nothing here throws at the caller: an unexpected error is
 * logged and the placement is left for review, which is the safe direction
 * because an unapproved candidate waits for an operator either way.
 *
 * It must not nest a transaction inside the caller's. The producers open one
 * around the Blueprint write and the GitOps rows together, and
 * `placementApproved` runs its own single-writer transaction, so evaluating
 * inside the producer would nest them.
 *
 * Atomicity is therefore not the mechanism here. Idempotency is:
 * `placementApproved` refuses when an approval already exists for the same
 * intent and candidate, so a retry after a crash detects the existing decision
 * rather than minting a second one.
 */
import { DatabaseService, type Blueprint } from '../DatabaseService';
import { BlueprintAnalyzer } from '../BlueprintAnalyzer';
import { sanitizeForLog } from '../../utils/safeLog';
import { GitOpsStore } from './store';
import { GitOpsTransitions, type EventEnvelope } from './transitions';
import { newGitOpsId } from './directApplication';
import { encodeGitOpsRequiredTargetsJson, decodeGitOpsRequiredTargetsJson } from './json';
import {
  decideBoundedAutoPlacement,
  type AffectedNodeState,
  type BoundedAutoInput,
  type PlacementPolicyReason,
  type WorkloadStatelessness,
} from './placementPolicy';
import { configuredSnapshotFor, encodePolicySnapshot } from './policyComposition';
import { readStagedGeneration } from './statefulGuard';
import type { GitOpsApplicationRow, GitOpsIntentRevisionRow } from './types';

export type AutomaticPlacementOutcome =
  | { status: 'auto_approved'; reason: 'stateless_addition' | 'stateless_removal' }
  | { status: 'operator_review'; reason: PlacementPolicyReason }
  | { status: 'no_action'; reason: 'no_placement_change' }
  | { status: 'skipped'; reason: 'no_current_candidate' | 'unexpected_error' };

/** The last placement-approved target set, or the live one when nothing was ever approved. */
function approvedBaseline(
    store: GitOpsStore,
    app: GitOpsApplicationRow,
): { ok: true; nodeIds: number[]; hasPriorApproval: boolean } | { ok: false } {
  if (app.placement_approval_ref) {
    // A direct read, not resolveApprovalRef: that one answers "does this prove
    // authority", which needs the expected intent and target set, and here the
    // question is only "what set did the standing approval name".
    const approval = store.getApproval(app.placement_approval_ref);
    if (!approval || approval.kind !== 'placement_approval' || approval.application_id !== app.id) {
      return { ok: false };
    }
    if (!approval.required_targets_json) return { ok: false };
    try {
      return { ok: true, nodeIds: decodeGitOpsRequiredTargetsJson(approval.required_targets_json).nodeIds, hasPriorApproval: true };
    } catch {
      return { ok: false };
    }
  }
  // Never approved, so the honest baseline is what is actually running. The
  // first-placement rules apply on top of it, which is what keeps a first
  // placement across several nodes out of the automatic path.
  return { ok: true, nodeIds: store.listTargets(app.id).filter((row) => row.target_status === 'active').map((row) => row.node_id), hasPriorApproval: false };
}

/**
 * Statelessness of the workload that would be placed or withdrawn, derived from
 * compose content rather than from the Blueprint row.
 *
 * The stored classification is what the editor last wrote. Compose edits are
 * refused for a Git-managed Blueprint, so a repository push that gives a service
 * a volume never updates it, and reading that column would approve a stateful
 * placement off a stale label. The accepted generation's content is what is
 * actually running and what a new target would receive, so that is what is read.
 */
function deriveStatelessness(
    app: GitOpsApplicationRow,
    intent: GitOpsIntentRevisionRow,
    blueprint: Blueprint | undefined,
): WorkloadStatelessness {
  if (app.accepted_generation_id && intent.deploy_stack_name) {
    const generation = GitOpsStore.getInstance().getGeneration(app.accepted_generation_id);
    if (!generation || generation.application_id !== app.id) return 'unknown';
    const staged = readStagedGeneration(intent.deploy_stack_name, app, generation);
    if (!staged) return 'unknown';
    try {
      const names = BlueprintAnalyzer.statefulServiceNames(staged.contents.join('\n'));
      if (names === null) return 'unknown';
      return names.size > 0 ? 'stateful' : 'stateless';
    } catch (error) {
      console.warn(
        `[GitOps] compose classification failed for ${sanitizeForLog(app.id)}:`,
        error instanceof Error ? error.message : String(error),
      );
      return 'unknown';
    }
  }
  // No accepted generation yet, so the Blueprint's own content is what a first
  // placement would run. Absent or unparseable content is unknown, never
  // stateless: missing evidence must not become the reading that approves.
  const content = blueprint?.compose_content;
  if (typeof content !== 'string' || content.trim() === '') return 'unknown';
  try {
    const names = BlueprintAnalyzer.statefulServiceNames(content);
    if (names === null) return 'unknown';
    return names.size > 0 ? 'stateful' : 'stateless';
  } catch {
    return 'unknown';
  }
}

/** The worst state across the nodes the change touches. */
function worstNodeState(store: GitOpsStore, appId: string, nodeIds: readonly number[]): AffectedNodeState {
  let worst: AffectedNodeState = 'reachable';
  for (const nodeId of nodeIds) {
    const target = store.getTarget(appId, nodeId);
    if (!target) return 'unknown';
    const connectivity = target.connectivity;
    if (connectivity === 'unreachable') return 'unreachable';
    if (connectivity === 'unknown' || connectivity === null) worst = 'unknown';
  }
  return worst;
}

/** Whether a live content binding or marker already owns an affected node. */
function hasMarkerConflict(app: GitOpsApplicationRow, nodeIds: readonly number[]): boolean {
  if (app.target_mode !== 'blueprint' || !app.blueprint_id) return false;
  const db = DatabaseService.getInstance().getDb();
  const row = db
    .prepare(
      `SELECT 1 AS found FROM gitops_intent_revisions
       WHERE application_id = ? AND blueprint_id = ?
         AND pinned_node_id IS NOT NULL AND pinned_node_id IN (${nodeIds.map(() => '?').join(', ') || 'NULL'})
       LIMIT 1`,
    )
    .get(app.id, app.blueprint_id, ...nodeIds);
  return row !== undefined;
}

/**
 * Decide, and apply an approval when the decision allows one.
 *
 * Safe to call on every placement event. It refuses without writing whenever the
 * application has no current candidate, whenever the policy is not bounded auto,
 * and whenever any evidence is missing or unusable.
 */
export function applyAutomaticPlacement(
    applicationId: string,
    envelope: EventEnvelope,
): AutomaticPlacementOutcome {
  const store = GitOpsStore.getInstance();
  const db = DatabaseService.getInstance();
  const app = store.getApplication(applicationId);
  if (!app || app.lifecycle_status !== 'active' || !app.rollout_candidate_id || !app.intent_revision_id) {
    return { status: 'skipped', reason: 'no_current_candidate' };
  }
  const candidate = store.getRolloutCandidate(app.rollout_candidate_id);
  const intent = store.getIntentRevision(app.intent_revision_id);
  if (!candidate || candidate.application_id !== app.id || !intent) {
    return { status: 'skipped', reason: 'no_current_candidate' };
  }

  let candidateNodeIds: number[] = [];
  let evidenceWellFormed = true;
  try {
    candidateNodeIds = decodeGitOpsRequiredTargetsJson(candidate.required_targets_json).nodeIds;
  } catch {
    evidenceWellFormed = false;
  }
  const baseline = approvedBaseline(store, app);

  const input: BoundedAutoInput = {
    policy: app.placement_policy,
    approvedNodeIds: baseline.ok ? baseline.nodeIds : [],
    candidateNodeIds,
    hasPriorApproval: baseline.ok ? baseline.hasPriorApproval : false,
    statelessness: deriveStatelessness(app, intent, app.blueprint_id
      ? (DatabaseService.getInstance().getBlueprint(app.blueprint_id) ?? undefined)
      : undefined),
    // A pin is an operator's choice of where a workload may run, so placement
    // that moved because a pin moved is never automatic. Read from the intent
    // rather than from the column name: `pinnedOverridesCordon` records that the
    // Blueprint is pinned, not that a node is cordoned.
    pinDriven: intent.pinned_node_id !== null,
    cordonOverride: false,
    markerConflict: hasMarkerConflict(app, candidateNodeIds),
    affectedNodeState: worstNodeState(store, app.id, candidateNodeIds),
    conflictingOperation: app.active_operation_stage !== null,
    evidenceReadable: baseline.ok,
    evidenceWellFormed,
  };

  const decision = decideBoundedAutoPlacement(input);
  if (decision.decision === 'no_action') {
    return { status: 'no_action', reason: 'no_placement_change' };
  }
  if (decision.decision === 'operator_review') {
    return { status: 'operator_review', reason: decision.reason };
  }

  try {
    // A single stateless change approves exactly the target set the candidate
    // asked for, so the effect is derived here from that same set rather than
    // from anything a client supplied.
    const placed = decision.effect.additions.map((nodeId) => ({ nodeId, outcome: 'place' as const }));
    const removed = decision.effect.removals.map((nodeId) => ({ nodeId, outcome: 'remove' as const }));
    const effect = [...placed, ...removed];
    const blastJson = JSON.stringify({ entries: effect });
    GitOpsTransitions.getInstance().placementApproved({
      applicationId: app.id,
      approvalId: newGitOpsId(),
      intentRevisionId: intent.id,
      blastJson,
      requiredNodeIds: candidateNodeIds,
      fingerprint: null,
      actor: null,
      envelope: { ...envelope, trigger: 'placement_policy' },
      rolloutGenerationId: newGitOpsId(),
      candidateId: candidate.id,
      authority: 'configured_policy',
      policyProvenanceJson: encodePolicySnapshot(configuredSnapshotFor(app)),
      strategyJson: intent.rollout_strategy_json,
      provenance: 'placement_approval',
    });
    return { status: 'auto_approved', reason: decision.reason };
  } catch (error) {
    // A refusal here is the safe direction: the candidate stands unapproved and
    // waits for an operator. The Blueprint write that triggered this already
    // committed and must not be undone.
    console.error(
      `[GitOps] automatic placement approval failed for ${sanitizeForLog(app.id)}:`,
      sanitizeForLog(error instanceof Error ? error.message : String(error)),
    );
    return { status: 'operator_review', reason: 'conflicting_operation' };
  }
}

/** Re-exported so callers can build the target set they hand to the approval. */
export { encodeGitOpsRequiredTargetsJson };
