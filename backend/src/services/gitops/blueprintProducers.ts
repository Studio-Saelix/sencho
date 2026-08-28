/**
 * The Blueprint operations that write to the revision state.
 *
 * Each one wraps the Blueprint source write and its GitOps rows in a single
 * transaction, so an operator never sees a Blueprint that exists with nothing
 * describing what it means, or an intent for a Blueprint that failed to save.
 *
 * Desired node ids arrive as an argument rather than being computed here. The
 * reconciler that knows how to compute them reaches this layer, so importing it
 * back would close a module cycle, and a cycle in this package has already
 * produced one silent defect on this branch.
 */
import { createHash, randomUUID } from 'crypto';
import { DatabaseService, type Blueprint, type BlueprintSelector } from '../DatabaseService';
import { GitOpsStore } from './store';
import { GitOpsTransitions, type EventEnvelope } from './transitions';
import type { GitOpsApplicationRow, GitOpsIntentRevisionRow, GitOpsRolloutCandidateRow } from './types';

/** What an operator changed, which decides whether a new intent is minted. */
export type BlueprintChangeKind = 'operational' | 'metadata_only' | 'none';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function envelopeFor(actor: string | null, trigger: string): EventEnvelope {
  return { operationId: randomUUID(), actor: actor ?? 'system:blueprint', trigger, at: Date.now() };
}

/**
 * Whether an application can be recorded against.
 *
 * `getLiveBlueprintApplication` answers with `active` or `creating`, because
 * its other callers ask "does this Blueprint already hold the live slot",
 * where a half-built row counts. The transitions that mint intents and
 * candidates accept only `active` and reject anything else by throwing, and
 * they run inside the caller's transaction, so a `creating` row reaching one
 * would fail the operator's edit and roll back the Blueprint write with it.
 *
 * **No current path produces that row.** Every Blueprint-mode application is
 * inserted through `blankInlineApplication`, which hardcodes `active`, and
 * `creating` is reachable only in `direct` mode. So this narrowing excludes
 * nothing today and is deliberately defensive: it exists because the getter's
 * slot-check semantics and the transitions' stricter requirement have already
 * drifted apart once, and the Git-backed `blueprint` mode is what will insert
 * a Blueprint application that is still being created. Narrowing here rather
 * than in the getter keeps the slot check correct for its own callers.
 */
export function recordableApplication(
  app: GitOpsApplicationRow | undefined,
): app is GitOpsApplicationRow {
  return !!app && app.lifecycle_status === 'active';
}

export type BlueprintUpdates = Parameters<DatabaseService['updateBlueprint']>[1];

/**
 * Which fields changed, in the only terms that matter here.
 *
 * Operational fields describe what gets deployed and where, so changing one
 * makes every existing acknowledgement stale. Description and classification
 * describe the Blueprint to a reader and change nothing a node runs, so they
 * must not mint an intent: a fresh identity would invalidate acknowledgements
 * that are still accurate.
 */
export function classifyBlueprintChange(
  before: Blueprint,
  updates: BlueprintUpdates,
): BlueprintChangeKind {
  const changedKeys = changedBlueprintKeys(before, updates);
  if (OPERATIONAL_KEYS.some((key) => changedKeys.has(key))) return 'operational';
  return changedKeys.size > 0 ? 'metadata_only' : 'none';
}

const OPERATIONAL_KEYS = ['name', 'compose_content', 'selector', 'drift_mode', 'enabled'] as const;

/**
 * A selector compared by value rather than by how it was written.
 *
 * The lists inside carry request order, so a multi-select that emits click
 * order would otherwise read as a placement change and invalidate every
 * acknowledgement over a reorder that selects the same nodes.
 */
function canonicalSelector(selector: BlueprintSelector): string {
  return selector.type === 'nodes'
    ? JSON.stringify({ type: 'nodes', ids: [...selector.ids].sort((a, b) => a - b) })
    : JSON.stringify({
      type: 'labels',
      any: [...selector.any].sort(),
      all: [...selector.all].sort(),
    });
}

/**
 * The keys whose submitted value actually differs from what is stored.
 *
 * The editor submits every field on every save, and the source layer decides
 * what to invalidate from which keys are *present*. Comparing values here and
 * handing that layer the untouched payload made the two disagree: a
 * description edit bumped the revision and cleared the approval while this
 * layer classified it as metadata and minted nothing, leaving the current
 * intent describing a revision that no longer existed.
 */
function changedBlueprintKeys(
  before: Blueprint,
  updates: BlueprintUpdates,
): Set<keyof BlueprintUpdates> {
  const changed = new Set<keyof BlueprintUpdates>();
  const differs = (key: keyof BlueprintUpdates): boolean => {
    const next = updates[key];
    if (next === undefined) return false;
    if (key === 'selector') {
      return canonicalSelector(next as BlueprintSelector) !== canonicalSelector(before.selector);
    }
    if (key === 'classification_reasons') {
      return JSON.stringify(next) !== JSON.stringify(before.classification_reasons);
    }
    return next !== before[key as keyof Blueprint];
  };
  for (const key of ['name', 'compose_content', 'selector', 'drift_mode', 'enabled', 'description', 'classification', 'classification_reasons'] as const) {
    if (differs(key)) changed.add(key);
  }
  return changed;
}

/** Only the keys that changed, so presence and difference mean the same thing. */
function prunedUpdates(before: Blueprint, updates: BlueprintUpdates): BlueprintUpdates {
  const changedKeys = changedBlueprintKeys(before, updates);
  const pruned: BlueprintUpdates = {};
  for (const key of changedKeys) {
    Object.assign(pruned, { [key]: updates[key] });
  }
  // The revision bump rides on the compose content. Pruned out, it would still
  // advance a revision no intent describes.
  if (changedKeys.has('compose_content') && updates.bumpRevision) pruned.bumpRevision = true;
  return pruned;
}

export function intentRowFor(
  applicationId: string,
  blueprint: Blueprint,
  operationId: string,
  actor: string | null,
  at: number,
): GitOpsIntentRevisionRow {
  return {
    id: randomUUID(),
    application_id: applicationId,
    blueprint_id: blueprint.id,
    compose_content_sha256: sha256(blueprint.compose_content),
    blueprint_revision: blueprint.revision,
    deploy_stack_name: blueprint.name,
    selector_json: JSON.stringify(blueprint.selector),
    pinned_node_id: blueprint.pinned_node_id,
    cordon_implications_json: JSON.stringify({ pinnedOverridesCordon: blueprint.pinned_node_id !== null }),
    rollout_strategy_json: JSON.stringify({ driftMode: blueprint.drift_mode, enabled: blueprint.enabled }),
    runtime_drift_policy: blueprint.drift_mode,
    stateful_policy_json: null,
    health_failure_rollback_policy_json: null,
    operation_id: operationId,
    actor,
    created_at: at,
  };
}

export function candidateRowFor(
  applicationId: string,
  intent: GitOpsIntentRevisionRow,
  desiredNodeIds: number[],
  provenance: GitOpsRolloutCandidateRow['provenance'],
  operationId: string,
  at: number,
): GitOpsRolloutCandidateRow {
  return {
    id: randomUUID(),
    application_id: applicationId,
    intent_revision_id: intent.id,
    compose_content_sha256: intent.compose_content_sha256,
    accepted_generation_id: null,
    artifact_set_id: null,
    // Canonical: the required set is compared across revisions, so an order
    // change must not read as a placement change.
    required_targets_json: JSON.stringify({ nodeIds: [...desiredNodeIds].sort((a, b) => a - b) }),
    authoritative: 1,
    provenance,
    operation_id: operationId,
    created_at: at,
  };
}

/**
 * Record a new Blueprint: the source row, its application, and the first
 * intent and candidate describing what it currently asks for.
 */
export function commitBlueprintCreate(
  input: Parameters<DatabaseService['createBlueprint']>[0],
  desiredNodeIdsFor: (blueprint: Blueprint) => number[],
): Blueprint {
  const db = DatabaseService.getInstance();
  const tx = GitOpsTransitions.getInstance();

  return db.getDb().transaction(() => {
    const blueprint = db.createBlueprint(input);
    const envelope = envelopeFor(input.created_by, 'blueprint_create');
    const applicationId = randomUUID();

    tx.activateInlineBlueprint({
      application: blankInlineApplication(applicationId, blueprint.id, envelope.at),
      envelope,
    });

    const intent = intentRowFor(applicationId, blueprint, envelope.operationId, input.created_by, envelope.at);
    tx.intentRevised({ applicationId, intent, envelope });
    tx.rolloutCandidateOpened({
      applicationId,
      candidate: candidateRowFor(
        applicationId, intent, desiredNodeIdsFor(blueprint), 'intent_change', envelope.operationId, envelope.at,
      ),
      envelope,
    });
    return blueprint;
  })();
}

/**
 * Record an edit to a Blueprint.
 *
 * A change that alters nothing writes nothing at all, and a change that only
 * alters how the Blueprint reads updates the source row alone. Only an
 * operational change mints a new intent, because only that makes what the
 * fleet already acknowledged out of date.
 */
export function commitBlueprintUpdate(
  blueprintId: number,
  updates: BlueprintUpdates,
  actor: string | null,
  desiredNodeIdsFor: (blueprint: Blueprint) => number[],
): { blueprint: Blueprint | undefined; change: BlueprintChangeKind } {
  const db = DatabaseService.getInstance();
  const store = GitOpsStore.getInstance();
  const tx = GitOpsTransitions.getInstance();

  return db.getDb().transaction(() => {
    const before = db.getBlueprint(blueprintId);
    if (!before) return { blueprint: undefined, change: 'none' as BlueprintChangeKind };

    const change = classifyBlueprintChange(before, updates);
    if (change === 'none') return { blueprint: before, change };

    const blueprint = db.updateBlueprint(blueprintId, prunedUpdates(before, updates));
    if (!blueprint || change === 'metadata_only') return { blueprint, change };

    const app = store.getLiveBlueprintApplication(blueprintId);
    // A Blueprint that predates the model has no application yet. Migration
    // brings it in; inventing one here would claim a first intent for a
    // Blueprint whose deployments nobody has reconciled.
    if (!recordableApplication(app)) return { blueprint, change };

    const envelope = envelopeFor(actor, 'blueprint_update');
    const intent = intentRowFor(app.id, blueprint, envelope.operationId, actor, envelope.at);
    tx.intentRevised({ applicationId: app.id, intent, envelope });
    tx.rolloutCandidateOpened({
      applicationId: app.id,
      candidate: candidateRowFor(
        app.id, intent, desiredNodeIdsFor(blueprint), 'intent_change', envelope.operationId, envelope.at,
      ),
      envelope,
    });
    return { blueprint, change };
  })();
}

/**
 * Record a pin change.
 *
 * Pinning moves where a Blueprint is allowed to run, so it revises placement
 * the same way a selector edit does. Re-pinning to the node already pinned
 * changes nothing and writes nothing.
 */
export function commitBlueprintPin(
  blueprintId: number,
  nodeId: number | null,
  actor: string | null,
  desiredNodeIdsFor: (blueprint: Blueprint) => number[],
): { blueprint: Blueprint | undefined; changed: boolean } {
  const db = DatabaseService.getInstance();
  const store = GitOpsStore.getInstance();
  const tx = GitOpsTransitions.getInstance();

  return db.getDb().transaction(() => {
    const before = db.getBlueprint(blueprintId);
    if (!before) return { blueprint: undefined, changed: false };
    if (before.pinned_node_id === nodeId) return { blueprint: before, changed: false };

    const blueprint = db.setBlueprintPinnedNode(blueprintId, nodeId);
    if (!blueprint) return { blueprint: undefined, changed: false };

    const app = store.getLiveBlueprintApplication(blueprintId);
    if (!recordableApplication(app)) return { blueprint, changed: true };

    const envelope = envelopeFor(actor, 'blueprint_pin');
    const intent = intentRowFor(app.id, blueprint, envelope.operationId, actor, envelope.at);
    tx.intentRevised({ applicationId: app.id, intent, envelope });
    tx.rolloutCandidateOpened({
      applicationId: app.id,
      candidate: candidateRowFor(
        app.id, intent, desiredNodeIdsFor(blueprint), 'roster_change', envelope.operationId, envelope.at,
      ),
      envelope,
    });
    return { blueprint, changed: true };
  })();
}

/**
 * Retire a Blueprint's application after its deployments have been withdrawn.
 *
 * Tombstones only. A deleted Blueprint must stop claiming its live-application
 * slot, or the name cannot be used again, but nothing here withdraws anything:
 * the caller has already done that, and doing it twice would report removals
 * that never happened.
 */
export function commitBlueprintDelete(blueprintId: number, actor: string | null): boolean {
  const db = DatabaseService.getInstance();
  const store = GitOpsStore.getInstance();
  const tx = GitOpsTransitions.getInstance();

  return db.getDb().transaction(() => {
    const app = store.getLiveBlueprintApplication(blueprintId);
    const removed = db.deleteBlueprint(blueprintId);
    if (!removed || !app) return removed;

    const envelope = envelopeFor(actor, 'blueprint_delete');
    for (const target of store.listTargets(app.id)) {
      if (target.target_status !== 'active') continue;
      tx.targetTombstoned(app.id, target.node_id, envelope);
    }
    tx.applicationTombstoned(app.id, 'deleted', envelope);
    return removed;
  })();
}

/** A Blueprint application before anything has been asked of it. */
export function blankInlineApplication(id: string, blueprintId: number, at: number) {
  return {
    id,
    lifecycle_key: `blueprint:${blueprintId}`,
    lifecycle_status: 'active' as const,
    target_mode: 'inline_blueprint' as const,
    stack_name: null,
    blueprint_id: blueprintId,
    configured_repo_url: null,
    repo_identity_json: null,
    configured_ref: null,
    compose_paths_json: null,
    context_dir: null,
    sync_env: 0,
    env_path: null,
    materialization_fingerprint: null,
    desired_commit_sha: null,
    fetched_commit_sha: null,
    fetched_resolved_ref_kind: null,
    candidate_generation_id: null,
    accepted_generation_id: null,
    candidate_plan_blocked: 0,
    review_required: 0,
    artifact_set_id: null,
    latest_artifact_set_id: null,
    intent_revision_id: null,
    rollout_candidate_id: null,
    rollout_generation_id: null,
    source_acceptance_ref: null,
    placement_approval_ref: null,
    rollout_authorization_ref: null,
    legacy_combined_approval_ref: null,
    preflight_fingerprint: null,
    latest_operation_id: null,
    active_operation_id: null,
    active_operation_stage: null,
    active_operation_at: null,
    active_generation_id: null,
    pause_at: null,
    pause_reason: null,
    partial_json: null,
    failure_stage: null,
    failure_class: null,
    failure_at: null,
    retry_at: null,
    retry_count: 0,
    suspended_at: null,
    recovery_ref: null,
    recovery_phase: null,
    interruption_stage: null,
    interruption_at: null,
    interruption_operation_id: null,
    interruption_generation_id: null,
    evidence_fresh_at: null,
    evidence_limitations_json: null,
    created_at: at,
    updated_at: at,
  };
}
