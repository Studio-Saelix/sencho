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
import { hasTargetOperationInFlight } from './handoff';
import { targetConnectivity } from './derive';
import { GitOpsTransitions, type EventEnvelope } from './transitions';
import { newGitOpsId } from './directApplication';
import {
  decodeGitOpsRequiredTargetsJson,
  encodeGitOpsApprovedTargetEffectJson,
  encodeGitOpsRequiredTargetsJson,
} from './json';
import {
  decideBoundedAutoPlacement,
  type AffectedNodeState,
  type BoundedAutoInput,
  type PlacementPolicyReason,
  type WorkloadStatelessness,
} from './placementPolicy';
import { configuredSnapshotFor, encodePolicySnapshot } from './policyComposition';
import { readAppliedGenerationContents } from './statefulGuard';
import type { GitOpsApplicationRow, GitOpsLimitation } from './types';

export type AutomaticPlacementOutcome =
  | { status: 'auto_approved'; reason: 'stateless_addition' | 'stateless_removal' }
  | { status: 'operator_review'; reason: PlacementPolicyReason }
  | { status: 'no_action'; reason: 'no_placement_change' }
  | { status: 'skipped'; reason: 'no_current_candidate' | 'unexpected_error' };

/**
 * The last placement-approved target set, or the live one when nothing was ever
 * approved.
 *
 * Resolved from the most recent approval row rather than from the application's
 * `placement_approval_ref`, because an intent revision clears that pointer
 * before a new candidate opens. Reading the pointer here found nothing on the
 * normal path, which left the live-target fallback as the only reachable branch:
 * every application looked un-approved, and every multi-node candidate was
 * refused as a first placement. The approval row survives the pointer and is
 * still the authority record of the last set an operator accepted.
 */
function approvedBaseline(
    store: GitOpsStore,
    app: GitOpsApplicationRow,
): { ok: true; nodeIds: number[]; hasPriorApproval: boolean } | { ok: false } {
  const approval = store.latestPlacementApproval(app.id);
  if (!approval) {
    // No decomposed placement approval, so the honest baseline is what is
    // actually running. The first-placement rules apply on top of it only when
    // nothing ever authorized this application's placement, which is what keeps a
    // first placement across several nodes out of the automatic path.
    //
    // "Ever authorized" is not the same question as "has a decomposed approval".
    // A migration that carried a forward approval records a pre-decomposition
    // row, which names no target set and so cannot supply a baseline but does
    // prove the placement was not the first thing that ever happened to it.
    // Reading that as a first placement made every removal that left more than
    // one node an automatic refusal, for ever, on exactly the installations the
    // migration was written for.
    return {
      ok: true,
      nodeIds: store.listTargets(app.id)
        .filter((row) => row.target_status === 'active')
        .map((row) => row.node_id),
      hasPriorApproval: store.hasEverHadPlacementAuthority(app.id),
    };
  }
  if (approval.application_id !== app.id || !approval.required_targets_json) return { ok: false };
  try {
    return {
      ok: true,
      nodeIds: decodeGitOpsRequiredTargetsJson(approval.required_targets_json).nodeIds,
      hasPriorApproval: true,
    };
  } catch {
    return { ok: false };
  }
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
    blueprint: Blueprint | undefined,
): WorkloadStatelessness {
  // The stack identity the generations are actually staged under, which is the
  // same one the source path resolves. `intent.deploy_stack_name` is the
  // Blueprint's own name and is a different directory once a stack has been
  // renamed, so reading through it found nothing and every placement on a
  // renamed stack read as an unknown workload.
  const stackName = app.stack_name ?? app.configured_source_stack_name;
  if (app.accepted_generation_id && stackName) {
    const generation = GitOpsStore.getInstance().getGeneration(app.accepted_generation_id);
    if (!generation || generation.application_id !== app.id) return 'unknown';
    // The generation in force, not the candidate on disk. Promotion removes the
    // applied directory and renames the candidate over it, so a promoted
    // generation has an applied directory and no candidate directory at all.
    // Reading only the candidate found nothing there and every placement after
    // the first rollout read as an unknown workload, which confined bounded-auto
    // to the window between source acceptance and the first promotion.
    const inForce = readAppliedGenerationContents(stackName, app, generation);
    if (!inForce) return 'unknown';
    // Each file on its own. Concatenating them put the same service key in one
    // document twice, which does not parse, so a multi-file compose always read
    // as an unknown workload and the policy could never approve it.
    let stateful = false;
    for (const content of inForce.contents) {
      try {
        const names = BlueprintAnalyzer.statefulServiceNamesStrict(content);
        if (names === null) return 'unknown';
        if (names.size > 0) stateful = true;
      } catch (error) {
        console.warn(
          `[GitOps] compose classification failed for ${sanitizeForLog(app.id)}:`,
          error instanceof Error ? error.message : String(error),
        );
        return 'unknown';
      }
    }
    return stateful ? 'stateful' : 'stateless';
  }
  // No accepted generation yet, so the Blueprint's own content is what a first
  // placement would run. Absent or unparseable content is unknown, never
  // stateless: missing evidence must not become the reading that approves.
  const content = blueprint?.compose_content;
  if (typeof content !== 'string' || content.trim() === '') return 'unknown';
  try {
    const names = BlueprintAnalyzer.statefulServiceNamesStrict(content);
    if (names === null) return 'unknown';
    return names.size > 0 ? 'stateful' : 'stateless';
  } catch {
    return 'unknown';
  }
}

/**
 * The worst state across the nodes an addition touches.
 *
 * An added node has no target row, and never will until the placement lands, so
 * the target row cannot be the evidence here: reading it made every addition
 * resolve to `unknown` and refused the whole feature. The node registry is the
 * real evidence for a node that is about to receive a workload, and it is
 * maintained rather than seeded, so a node is judged by whether it is registered
 * and answering.
 *
 * `stale` and `unreachable` both mean the node cannot be counted on, and
 * `unknown` is not a pass either: a node that has not been seen is not a node
 * this system may place a workload on.
 */
function worstAddedNodeState(nodeIds: readonly number[]): AffectedNodeState {
  if (nodeIds.length === 0) return 'reachable';
  const db = DatabaseService.getInstance().getDb();
  for (const nodeId of nodeIds) {
    const node = db.prepare('SELECT status FROM nodes WHERE id = ?').get(nodeId) as
      | { status: string }
      | undefined;
    if (!node) return 'unknown';
    if (node.status !== 'online') return 'unreachable';
  }
  return 'reachable';
}

/**
 * The worst state across the nodes a removal touches.
 *
 * Two pieces of evidence, both required. The node registry says whether the
 * node is answering right now, the same gate an addition passes, so a
 * withdrawal is never approved against a node that is offline. The target's
 * observation says the workload Sencho is about to leave behind actually ran
 * there; the stored `connectivity` column cannot answer that, because it is
 * seeded to null and no producer ever wrote it, so every removal used to
 * resolve to unknown and the policy could never approve one.
 *
 * An observation that cannot be decoded is recorded as a limitation, so the
 * refusal names malformed evidence rather than sending the operator to check a
 * node that answered. The observation never ages out on its own: no
 * connectivity value is derived from elapsed time, so a `stale` reading can
 * only arrive from a stored negative claim that no current producer writes.
 */
function worstRemovedNodeState(
  store: GitOpsStore,
  appId: string,
  nodeIds: readonly number[],
  limitations: GitOpsLimitation[],
): AffectedNodeState {
  if (nodeIds.length === 0) return 'reachable';
  const db = DatabaseService.getInstance().getDb();
  let worst: AffectedNodeState = 'reachable';
  for (const nodeId of nodeIds) {
    const node = db.prepare('SELECT status FROM nodes WHERE id = ?').get(nodeId) as
      | { status: string }
      | undefined;
    if (!node) return 'unknown';
    if (node.status !== 'online') return 'unreachable';
    const target = store.getTarget(appId, nodeId);
    if (!target) return 'unknown';
    const connectivity = targetConnectivity(target, limitations);
    if (connectivity === 'unreachable' || connectivity === 'stale') return 'unreachable';
    if (connectivity === 'unknown') worst = 'unknown';
  }
  return worst;
}

/** The worse of two states, ordered reachable < unknown < unreachable. */
function worseState(a: AffectedNodeState, b: AffectedNodeState): AffectedNodeState {
  if (a === 'unreachable' || b === 'unreachable') return 'unreachable';
  if (a === 'unknown' || b === 'unknown') return 'unknown';
  return 'reachable';
}

/** Whether any of these nodes is cordoned for new placements. */
function hasCordonOverride(nodeIds: readonly number[]): boolean {
  if (nodeIds.length === 0) return false;
  const db = DatabaseService.getInstance().getDb();
  const row = db
    .prepare(
      `SELECT 1 AS found FROM nodes
       WHERE cordoned = 1 AND id IN (${nodeIds.map(() => '?').join(', ')})
       LIMIT 1`,
    )
    .get(...nodeIds);
  return row !== undefined;
}


/**
 * Why an approval the decision already allowed did not land.
 *
 * Each transition refusal keeps its own meaning, so the reason is derived from
 * the message rather than assumed. Evidence that moved under the decision
 * reports as malformed evidence rather than as a conflict, because that is what
 * happened: the sets the decision compared are no longer the sets on the row.
 */
/**
 * Record a bounded-auto refusal, never letting the record fail the decision.
 *
 * The placement is already standing unapproved either way, and the caller is a
 * producer that has committed its own write. A failure here must not turn a
 * decision the policy made into an exception the operator sees as a broken
 * Blueprint edit, so it is logged and the decision stands.
 */
function recordRefusal(applicationId: string, reason: PlacementPolicyReason, at: number): void {
  try {
    GitOpsTransitions.getInstance().placementPolicyRefused({ applicationId, reason, at });
  } catch (error) {
    console.error(
      `[GitOps] automatic placement refusal could not be recorded for ${sanitizeForLog(applicationId)}:`,
      sanitizeForLog(error instanceof Error ? error.message : String(error)),
    );
  }
}

function approvalFailureReason(message: string): PlacementPolicyReason {
  if (/is not current|could not be read|not found|does not match/.test(message)) {
    return 'malformed_evidence';
  }
  // An already-recorded approval is the replay guard, and a live operation is
  // the one state reachable from outside the transition's own checks.
  return 'conflicting_operation';
}

/**
 * Whether this candidate's placement moved because a pin moved.
 *
 * A pin still on the current intent is one direction. A clear is the other:
 * the current intent names no pin, so the standing approval has to be read.
 * An approval recorded on this intent already accepted the clear. An approval
 * recorded on an older unpinned intent does not, when a pin was written after
 * it and never confirmed. A missing approval intent fails closed.
 */
function pinDrivenPlacement(
  store: GitOpsStore,
  applicationId: string,
  intent: { id: string; pinned_node_id: number | null },
): boolean {
  if (intent.pinned_node_id !== null) return true;
  const approval = store.latestPlacementApproval(applicationId);
  if (!approval?.intent_revision_id) {
    const previous = store.previousIntentRevision(applicationId, intent.id);
    return (previous?.pinned_node_id ?? null) !== null;
  }
  if (approval.intent_revision_id === intent.id) return false;
  const approvedIntent = store.getIntentRevision(approval.intent_revision_id);
  if (!approvedIntent || approvedIntent.application_id !== applicationId) return true;
  if (approvedIntent.pinned_node_id !== null) return true;
  return store.hasPinnedIntentAfter(applicationId, approvedIntent.id, intent.id);
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
  } catch (error) {
    // Refused either way, but the reason has to be diagnosable: a corrupt
    // required-target set is a data problem someone has to find.
    console.warn(
      `[GitOps] candidate target set unreadable for ${sanitizeForLog(app.id)}:`,
      sanitizeForLog(error instanceof Error ? error.message : String(error)),
    );
    evidenceWellFormed = false;
  }
  const baseline = approvedBaseline(store, app);
  const baselineNodeIds = baseline.ok ? baseline.nodeIds : [];

  // The change itself, computed once so every evidence signal reads the same
  // two sets rather than each re-deriving them.
  const inBaseline = new Set(baselineNodeIds);
  const inCandidate = new Set(candidateNodeIds);
  const additions = candidateNodeIds.filter((nodeId) => !inBaseline.has(nodeId));
  const removals = baselineNodeIds.filter((nodeId) => !inCandidate.has(nodeId));

  // A removal's evidence is an observation, and one that cannot be decoded is a
  // data fault, not a node that never answered. Collecting the limitations lets
  // the decision report the truthful reason.
  const removalEvidenceLimitations: GitOpsLimitation[] = [];

  const input: BoundedAutoInput = {
    policy: app.placement_policy,
    approvedNodeIds: baselineNodeIds,
    candidateNodeIds,
    hasPriorApproval: baseline.ok ? baseline.hasPriorApproval : false,
    statelessness: deriveStatelessness(app, app.blueprint_id
      ? (DatabaseService.getInstance().getBlueprint(app.blueprint_id) ?? undefined)
      : undefined),
    // A set or a clear. The helper reads the standing approval, because a
    // clear leaves the current intent with no pin.
    pinDriven: pinDrivenPlacement(store, app.id, intent),
    // A cordon is an operator saying a node is not available for new placements,
    // so only a node being added to can override one. Reading a literal false
    // here would let an automatic approval place a workload onto a cordoned node
    // while the decision carried a refusal nobody could ever reach.
    cordonOverride: hasCordonOverride(additions),
    // A cordon on the node being withdrawn makes the withdrawal the cordon's doing,
    // not the policy's judgement about the workload.
    cordonDrivenRemoval: removals.length === 1 && hasCordonOverride(removals),
    // Each side judged by the evidence that actually exists for it: a node being
    // added is known from the registry, a node being left is known from the
    // observation of the workload that ran there.
    affectedNodeState: worseState(
      worstAddedNodeState(additions),
      worstRemovedNodeState(store, app.id, removals, removalEvidenceLimitations),
    ),
    // Both machines, not one. The application pointer covers a fetch or apply;
    // a target carries the stage for a deploy or a withdrawal, which is what a
    // sequential rollout sets. Missing the target side meant an automatic
    // placement could approve mid-deploy, clear the authorization, and supersede
    // the generation that deploy was running under.
    conflictingOperation: app.active_operation_stage !== null
      || hasTargetOperationInFlight(store, app.id),
    evidenceReadable: baseline.ok,
    // Unusable removal evidence (a corrupt observation, an illegal stored value)
    // is malformed, which the union reports differently from a node that did not
    // answer.
    evidenceWellFormed: evidenceWellFormed && removalEvidenceLimitations.length === 0,
  };

  const decision = decideBoundedAutoPlacement(input);
  if (decision.decision === 'no_action') {
    return { status: 'no_action', reason: 'no_placement_change' };
  }
  if (decision.decision === 'operator_review') {
    // `policy_is_operator` is not a decline, and recording it as one made the
    // default policy read as "declined by policy, waiting on an operator" on
    // every placement that was simply configured the way most installations are.
    // A refusal answers "the policy ran and said no"; the operator policy never
    // ran, so it has nothing to record. The projection reads a null reason as
    // awaiting an operator, which is what this actually is.
    if (decision.reason !== 'policy_is_operator') {
      recordRefusal(app.id, decision.reason, envelope.at);
    }
    return { status: 'operator_review', reason: decision.reason };
  }

  try {
    // A single stateless change approves exactly the target set the candidate
    // asked for, so the effect is derived here from that same set rather than
    // from anything a client supplied.
    //
    // Encoded through the shared encoder rather than assembled by hand. A
    // hand-built object was rejected by the transition's own decode, and because
    // that refusal is the safe direction it surfaced only as an operator review
    // with no approval ever landing, which is how a feature can look wired up
    // while doing nothing.
    const effect = [
      ...decision.effect.additions.map((nodeId) => ({ nodeId, outcome: 'place' as const })),
      ...decision.effect.removals.map((nodeId) => ({ nodeId, outcome: 'remove' as const })),
    ];
    const blastJson = encodeGitOpsApprovedTargetEffectJson(effect);
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
    // The reconciler tries this approval first when it covers the whole plan,
    // and falls back to the combined approval otherwise, so an operator's
    // approval stays in place for the ticks this one cannot run.
    return { status: 'auto_approved', reason: decision.reason };
  } catch (error) {
    // A refusal here is the safe direction: the candidate stands unapproved and
    // waits for an operator. The Blueprint write that triggered this already
    // committed and must not be undone.
    //
    // The reported reason is the actual cause, not a fixed one. Relabelling
    // every failure as a conflict would send an operator looking for an
    // operation that is not there, and would turn the replay guard's precise
    // signal into a lie on exactly the retry path this module relies on.
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[GitOps] automatic placement approval failed for ${sanitizeForLog(app.id)}:`,
      sanitizeForLog(message),
    );
    const reason = approvalFailureReason(message);
    recordRefusal(app.id, reason, envelope.at);
    return { status: 'operator_review', reason };
  }
}

/** Re-exported so callers can build the target set they hand to the approval. */
export { encodeGitOpsRequiredTargetsJson };
