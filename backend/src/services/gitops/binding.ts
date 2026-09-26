import { createHash, randomUUID } from 'crypto';
import { DatabaseService, type Blueprint } from '../DatabaseService';
import { BlueprintService } from '../BlueprintService';
import { buildBlueprintPreview, type BlueprintPreviewResult } from '../blueprintPreviewProjection';
import { GitOpsStore } from './store';
import { GitOpsTransitions, GitOpsTransitionError, type EventEnvelope } from './transitions';
import type { GitOpsApplicationRow, GitOpsIntentRevisionRow, GitOpsRolloutCandidateRow } from './types';
import { decodeGitOpsEvidenceLimitations, decodeGitOpsJson, encodeGitOpsEvidenceLimitations } from './json';
import { carriedHealthPolicyJson } from './healthPolicy';
import { isGitManagedBlueprint } from './gitManaged';

export { GitManagedContentError, isGitManagedBlueprint } from './gitManaged';

export class GitOpsBindingError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'GitOpsBindingError';
  }
}

export type BindingMarkerClassification = 'managed' | 'unmanaged' | 'conflicting' | 'unproven';

export type BindingPreview = {
  transition: 'adopt' | 'convert' | 'retire' | 'detach';
  currentOrigin: 'inline' | 'git';
  proposedOrigin: 'inline' | 'git';
  application: {
    id: string | null;
    stackName: string | null;
    repoUrl: string | null;
    ref: string | null;
    composePaths: string[] | null;
    contextDir: string | null;
    sourcePolicy: string | null;
    lifecycleStatus: string | null;
  };
  blueprintPreview: BlueprintPreviewResult | null;
  markers: Array<{ nodeId: number; nodeName: string; classification: BindingMarkerClassification }>;
  rollbackLimitations: string[];
};

export type ContentBindingView = {
  contentOrigin: 'inline' | 'git';
  applicationId: string | null;
  repoUrl: string | null;
  ref: string | null;
  composePaths: string[] | null;
  contextDir: string | null;
  sourcePolicy: string | null;
  lifecycleStatus: string | null;
  blockedRollout: boolean;
  snapshotPresent: boolean;
};

type BindingArgs = {
  blueprintId: number;
  applicationId: string;
  actor: string | null;
};

export class GitOpsBindingService {
  private static instance: GitOpsBindingService | undefined;

  static getInstance(): GitOpsBindingService {
    if (!GitOpsBindingService.instance) GitOpsBindingService.instance = new GitOpsBindingService();
    return GitOpsBindingService.instance;
  }

  static resetForTests(): void {
    GitOpsBindingService.instance = undefined;
  }

  async previewAdoptDirectToBlueprint(args: Omit<BindingArgs, 'actor'>): Promise<BindingPreview> {
    return this.buildPreview('adopt', args.blueprintId, args.applicationId);
  }

  async previewConvertInlineToGit(args: Omit<BindingArgs, 'actor'>): Promise<BindingPreview> {
    return this.buildPreview('convert', args.blueprintId, args.applicationId);
  }

  async previewRetireToDirect(blueprintId: number): Promise<BindingPreview> {
    return this.buildPreview('retire', blueprintId);
  }

  async previewDetachToInline(blueprintId: number): Promise<BindingPreview> {
    return this.buildPreview('detach', blueprintId);
  }

  describeContentBinding(blueprintId: number): ContentBindingView | null {
    const blueprint = DatabaseService.getInstance().getBlueprint(blueprintId);
    if (!blueprint) return null;
    const app = blueprint.application_id
      ? GitOpsStore.getInstance().getApplication(blueprint.application_id)
      : undefined;
    return {
      contentOrigin: blueprint.content_origin,
      applicationId: blueprint.application_id,
      repoUrl: app?.configured_repo_url ?? null,
      ref: app?.configured_ref ?? null,
      composePaths: parseComposePathList(app?.compose_paths_json),
      contextDir: app?.context_dir ?? null,
      sourcePolicy: app?.source_policy ?? null,
      lifecycleStatus: app?.lifecycle_status ?? null,
      blockedRollout: app?.rollout_candidate_id != null,
      snapshotPresent: blueprint.compose_content !== '',
    };
  }

  adoptDirectToBlueprint(args: BindingArgs): void {
    DatabaseService.getInstance().getDb().transaction(() => {
      const live = GitOpsStore.getInstance().getLiveBlueprintApplication(args.blueprintId);
      if (live && live.id !== args.applicationId) {
        GitOpsTransitions.getInstance().applicationTombstoned(live.id, 'deleted', this.envelope(args.actor));
      }
      this.bindDirectApplication(this.requireBlueprint(args.blueprintId), args.applicationId, args.actor);
    })();
  }

  convertInlineToGit(args: BindingArgs): void {
    DatabaseService.getInstance().getDb().transaction(() => {
      const live = GitOpsStore.getInstance().getLiveBlueprintApplication(args.blueprintId);
      if (live && live.id !== args.applicationId) {
        GitOpsTransitions.getInstance().applicationTombstoned(live.id, 'deleted', this.envelope(args.actor));
      }
      this.bindDirectApplication(this.requireBlueprint(args.blueprintId), args.applicationId, args.actor);
    })();
  }

  retireToDirect(args: { blueprintId: number; actor: string | null }): void {
    const db = DatabaseService.getInstance();
    const blueprint = this.requireGitManaged(args.blueprintId);
    if (db.hasNonWithdrawnBlueprintDeployments(blueprint.id)) {
      throw new GitOpsBindingError(
        'deployments_active',
        'Retire is blocked while this Blueprint still has active deployments',
      );
    }
    const app = this.requireBoundApplication(blueprint);
    const stackName = app.configured_source_stack_name;
    if (!stackName) {
      throw new GitOpsBindingError(
        'application_not_bound',
        'Bound application has no retained source stack identity',
      );
    }
    db.getDb().transaction(() => {
      GitOpsTransitions.getInstance().convertBlueprintToDirect({
        applicationId: app.id,
        stackName,
        envelope: this.envelope(args.actor),
      });
      this.clearGitManagedRolloutEvidence(app.id);
      this.restoreInline(blueprint.id);
    })();
  }

  detachToInline(args: { blueprintId: number; actor: string | null }): void {
    const blueprint = this.requireGitManaged(args.blueprintId);
    if (blueprint.compose_content === '') {
      throw new GitOpsBindingError(
        'git_managed_content_unmaterialized',
        'Detach is blocked until a generation exists to restore as Inline content',
      );
    }
    const applicationId = this.requireBoundApplication(blueprint).id;
    DatabaseService.getInstance().getDb().transaction(() => {
      GitOpsTransitions.getInstance().blueprintModeDemoted({
        applicationId,
        envelope: this.envelope(args.actor),
      });
      this.restoreInline(blueprint.id);
    })();
  }

  private bindDirectApplication(blueprint: Blueprint, applicationId: string, actor: string | null): void {
    const app = GitOpsStore.getInstance().getApplication(applicationId);
    if (!app || app.target_mode !== 'direct' || app.lifecycle_status !== 'active') {
      throw new GitOpsBindingError('application_not_direct', 'Select a live Direct GitOps application');
    }
    try {
      GitOpsTransitions.getInstance().convertDirectToBlueprint({
        applicationId,
        blueprintId: blueprint.id,
        envelope: this.envelope(actor),
      });
    } catch (error) {
      if (error instanceof GitOpsTransitionError) {
        const code = error.message.includes('repo') ? 'live_blueprint_repo' : 'live_blueprint_application';
        throw new GitOpsBindingError(code, error.message);
      }
      throw error;
    }
    const db = DatabaseService.getInstance();
    db.updateBlueprintContentOrigin(blueprint.id, 'git', applicationId);
    db.clearBlueprintApproval(blueprint.id);
    this.markRolloutBlocked(blueprint, applicationId, actor);
  }

  private markRolloutBlocked(blueprint: Blueprint, applicationId: string, actor: string | null): void {
    const envelope = this.envelope(actor);
    const tx = GitOpsTransitions.getInstance();
    const store = GitOpsStore.getInstance();
    let app = store.getApplication(applicationId);
    if (!app) return;

    if (!app.intent_revision_id) {
      tx.intentRevised({
        applicationId,
        intent: blockedIntentRow(applicationId, blueprint, envelope),
        envelope,
      });
      app = store.getApplication(applicationId);
      if (!app) return;
    }

    if (!app.rollout_candidate_id && app.intent_revision_id) {
      tx.rolloutCandidateOpened({
        applicationId,
        candidate: blockedCandidateRow(applicationId, app.intent_revision_id, blueprint, envelope),
        envelope,
      });
    }

    app = store.getApplication(applicationId);
    if (!app) return;
    const code = 'git_managed_rollout_not_enabled';
    store.replaceApplicationEvidenceLimitations(
      applicationId,
      encodeGitOpsEvidenceLimitations(
        decodeGitOpsEvidenceLimitations(app.evidence_limitations_json),
        code,
        { code, detail: 'Blueprint rollout generations are not enabled' },
      ),
      envelope.at,
    );
  }

  private restoreInline(blueprintId: number): void {
    const db = DatabaseService.getInstance();
    db.updateBlueprintContentOrigin(blueprintId, 'inline', null);
    db.clearBlueprintApproval(blueprintId);
  }

  private clearGitManagedRolloutEvidence(applicationId: string): void {
    const store = GitOpsStore.getInstance();
    const app = store.getApplication(applicationId);
    if (!app) return;
    store.replaceApplicationEvidenceLimitations(
      applicationId,
      encodeGitOpsEvidenceLimitations(
        decodeGitOpsEvidenceLimitations(app.evidence_limitations_json),
        'git_managed_rollout_not_enabled',
        null,
      ),
      Date.now(),
    );
  }

  private requireBlueprint(blueprintId: number): Blueprint {
    const blueprint = DatabaseService.getInstance().getBlueprint(blueprintId);
    if (!blueprint) throw new GitOpsBindingError('blueprint_not_found', 'Blueprint not found');
    return blueprint;
  }

  private requireGitManaged(blueprintId: number): Blueprint {
    const blueprint = this.requireBlueprint(blueprintId);
    if (!isGitManagedBlueprint(blueprint)) {
      throw new GitOpsBindingError('not_git_managed', 'Blueprint content is not Git-managed');
    }
    return blueprint;
  }

  private requireBoundApplication(blueprint: Blueprint): GitOpsApplicationRow {
    if (!blueprint.application_id) {
      throw new GitOpsBindingError('application_not_bound', 'Blueprint has no bound application');
    }
    const app = GitOpsStore.getInstance().getApplication(blueprint.application_id);
    if (!app) throw new GitOpsBindingError('application_not_found', 'Bound application not found');
    return app;
  }

  private envelope(actor: string | null): EventEnvelope {
    return { operationId: randomUUID(), actor: actor ?? 'system:binding', trigger: 'manual', at: Date.now() };
  }

  private async buildPreview(
    transition: BindingPreview['transition'],
    blueprintId: number,
    applicationId?: string,
  ): Promise<BindingPreview> {
    const blueprint = this.requireBlueprint(blueprintId);
    const resolvedId = applicationId ?? blueprint.application_id;
    const app = resolvedId ? GitOpsStore.getInstance().getApplication(resolvedId) ?? null : null;
    const blueprintPreview = await buildBlueprintPreview(blueprintId);
    return {
      transition,
      currentOrigin: blueprint.content_origin,
      proposedOrigin: proposedOriginFor(transition),
      application: applicationPreview(app),
      blueprintPreview,
      markers: await this.classifyMarkers(blueprint, blueprintPreview),
      rollbackLimitations: rollbackLimitationsFor(transition),
    };
  }

  private async classifyMarkers(
    blueprint: Blueprint,
    preview: BlueprintPreviewResult | null,
  ): Promise<BindingPreview['markers']> {
    if (!preview) return [];
    const svc = BlueprintService.getInstance();
    const nodes = DatabaseService.getInstance().getNodes();
    const out: BindingPreview['markers'] = [];
    for (const change of preview.changes) {
      const node = nodes.find((item) => item.id === change.nodeId);
      if (!node) {
        out.push({ nodeId: change.nodeId, nodeName: change.nodeName, classification: 'unproven' });
        continue;
      }
      const marker = await svc.readMarker(blueprint.name, node);
      out.push({
        nodeId: node.id,
        nodeName: node.name,
        classification: classifyMarker(marker, change.action, blueprint.id),
      });
    }
    return out;
  }
}

function proposedOriginFor(transition: BindingPreview['transition']): 'inline' | 'git' {
  if (transition === 'retire' || transition === 'detach') return 'inline';
  return 'git';
}

function applicationPreview(app: GitOpsApplicationRow | null): BindingPreview['application'] {
  return {
    id: app?.id ?? null,
    stackName: app?.stack_name ?? null,
    repoUrl: app?.configured_repo_url ?? null,
    ref: app?.configured_ref ?? null,
    composePaths: parseComposePathList(app?.compose_paths_json),
    contextDir: app?.context_dir ?? null,
    sourcePolicy: app?.source_policy ?? null,
    lifecycleStatus: app?.lifecycle_status ?? null,
  };
}

function parseComposePathList(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  try {
    const parsed = decodeGitOpsJson(raw);
    if (!Array.isArray(parsed) || !parsed.every((entry): entry is string => typeof entry === 'string')) {
      return null;
    }
    return parsed;
  } catch (error) {
    console.error('[GitOpsBinding] compose_paths_json is not valid JSON:', error);
    return null;
  }
}

function classifyMarker(
  marker: { blueprintId: number } | null,
  action: string,
  blueprintId: number,
): BindingMarkerClassification {
  if (marker == null) return action === 'create' ? 'unmanaged' : 'unproven';
  if (marker.blueprintId === blueprintId) return 'managed';
  return 'conflicting';
}

function rollbackLimitationsFor(transition: BindingPreview['transition']): string[] {
  if (transition === 'detach') {
    return [
      'Detach restores the frozen Inline snapshot; later Git commits are not written back.',
      'Existing node directories keep their current marker until a later rollout.',
    ];
  }
  if (transition === 'retire') {
    return [
      'Retire restores Direct targeting on the original Git source stack.',
      'Active deployments must be withdrawn first; snapshots already on nodes are not evicted here.',
    ];
  }
  return [
    transition === 'adopt'
      ? 'Adoption moves this live Git source onto the Blueprint. Credentials stay with that source.'
      : 'Conversion moves a live Git source onto this Blueprint. Credentials stay with that source.',
    'Git-managed Blueprints cannot deploy from the stored snapshot.',
  ];
}

function composeContentSha256(blueprint: Blueprint): string {
  return createHash('sha256').update(blueprint.compose_content).digest('hex');
}

function blockedIntentRow(
  applicationId: string,
  blueprint: Blueprint,
  envelope: EventEnvelope,
): GitOpsIntentRevisionRow {
  const store = GitOpsStore.getInstance();
  const current = store.getApplication(applicationId);
  const previous = current?.intent_revision_id
    ? store.getIntentRevision(current.intent_revision_id)
    : undefined;
  return {
    id: randomUUID(),
    application_id: applicationId,
    blueprint_id: blueprint.id,
    compose_content_sha256: composeContentSha256(blueprint),
    blueprint_revision: blueprint.revision,
    deploy_stack_name: blueprint.name,
    selector_json: JSON.stringify(blueprint.selector),
    pinned_node_id: blueprint.pinned_node_id,
    cordon_implications_json: JSON.stringify({ pinnedOverridesCordon: blueprint.pinned_node_id !== null }),
    rollout_strategy_json: JSON.stringify({ driftMode: blueprint.drift_mode, enabled: blueprint.enabled }),
    runtime_drift_policy: blueprint.drift_mode,
    stateful_policy_json: null,
    health_failure_rollback_policy_json: carriedHealthPolicyJson(previous),
    operation_id: envelope.operationId,
    actor: envelope.actor,
    created_at: envelope.at,
  };
}

function blockedCandidateRow(
  applicationId: string,
  intentRevisionId: string,
  blueprint: Blueprint,
  envelope: EventEnvelope,
): GitOpsRolloutCandidateRow {
  const nodeIds = blueprint.selector.type === 'nodes' ? [...blueprint.selector.ids].sort((a, b) => a - b) : [];
  return {
    id: randomUUID(),
    application_id: applicationId,
    intent_revision_id: intentRevisionId,
    compose_content_sha256: composeContentSha256(blueprint),
    accepted_generation_id: null,
    artifact_set_id: null,
    required_targets_json: JSON.stringify({ nodeIds }),
    authoritative: 1,
    provenance: 'intent_change',
    operation_id: envelope.operationId,
    created_at: envelope.at,
  };
}
