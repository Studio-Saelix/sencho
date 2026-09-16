import { randomUUID } from 'crypto';
import { DatabaseService, type Blueprint } from '../DatabaseService';
import { BlueprintService } from '../BlueprintService';
import { buildBlueprintPreview, type BlueprintPreviewResult } from '../blueprintPreviewProjection';
import { GitOpsStore } from './store';
import { GitOpsTransitions, GitOpsTransitionError, type EventEnvelope } from './transitions';
import type { GitOpsApplicationRow } from './types';

export class GitManagedContentError extends Error {
  readonly code = 'git_managed_content';
  constructor(message = 'Blueprint content is Git-managed and cannot be edited inline') {
    super(message);
    this.name = 'GitManagedContentError';
  }
}

export class GitOpsBindingError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'GitOpsBindingError';
  }
}

export function isGitManagedBlueprint(blueprint: Pick<Blueprint, 'content_origin'>): boolean {
  return blueprint.content_origin === 'git';
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
    composePaths: string | null;
    contextDir: string | null;
    sourcePolicy: string | null;
    lifecycleStatus: string | null;
  };
  blueprintPreview: BlueprintPreviewResult | null;
  markers: Array<{ nodeId: number; nodeName: string; classification: BindingMarkerClassification }>;
  rollbackLimitations: string[];
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

  adoptDirectToBlueprint(args: BindingArgs): void {
    const blueprint = this.requireBlueprint(args.blueprintId);
    const live = GitOpsStore.getInstance().getLiveBlueprintApplication(args.blueprintId);
    if (live && live.target_mode === 'inline_blueprint') {
      throw new GitOpsBindingError(
        'live_inline_blueprint',
        'This Blueprint already has live Inline content; convert from the Blueprint instead of merging',
      );
    }
    DatabaseService.getInstance().getDb().transaction(() => {
      this.bindDirectApplication(blueprint, args.applicationId, args.actor);
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
    const applicationId = this.requireBoundApplication(blueprint).id;
    db.getDb().transaction(() => {
      GitOpsTransitions.getInstance().convertBlueprintToDirect({
        applicationId,
        stackName: blueprint.name,
        envelope: this.envelope(args.actor),
      });
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
  }

  private restoreInline(blueprintId: number): void {
    const db = DatabaseService.getInstance();
    db.updateBlueprintContentOrigin(blueprintId, 'inline', null);
    db.clearBlueprintApproval(blueprintId);
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
    stackName: app?.stack_name ?? app?.configured_source_stack_name ?? null,
    repoUrl: app?.configured_repo_url ?? null,
    ref: app?.configured_ref ?? null,
    composePaths: app?.compose_paths_json ?? null,
    contextDir: app?.context_dir ?? null,
    sourcePolicy: app?.source_policy ?? null,
    lifecycleStatus: app?.lifecycle_status ?? null,
  };
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
      'Retire restores Direct targeting using the Blueprint name as the stack identity.',
      'Active deployments must be withdrawn first; snapshots already on nodes are not evicted here.',
    ];
  }
  return [
    'Conversion changes placement authority only; the Git source and credentials stay on the original application.',
    'Git-managed Blueprints cannot deploy until Blueprint rollout generations are enabled.',
  ];
}
