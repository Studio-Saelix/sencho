/**
 * Inline Blueprint migration.
 *
 * Migration records what a Blueprint asks for. It never records agreement: a
 * Blueprint revision and a deployment's applied revision both look like
 * progress, but neither proves a node is running the intent this pass just
 * minted, and writing them as an acknowledgement would report convergence
 * nobody verified.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { DatabaseService, type Blueprint } from '../services/DatabaseService';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions } from '../services/gitops/transitions';
import { migrateInlineBlueprints } from '../services/gitops/migrate';
import { commitBlueprintCreate } from '../services/gitops/blueprintProducers';
import { decodeGitOpsEvidenceLimitations } from '../services/gitops/json';

describe('gitops inline blueprint migration', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    GitOpsStore.resetForTests();
    GitOpsTransitions.resetForTests();
  });

  afterAll(() => {
    cleanupTestDb(tmpDir);
  });

  it('brings a pre-existing Blueprint in without claiming anyone agreed to it', () => {
    const db = DatabaseService.getInstance();
    const store = GitOpsStore.getInstance();
    const blueprint = seedLegacy('mig-plain');

    expect(outcomeFor(blueprint)).toBe('migrated_inline');

    const app = store.getLiveBlueprintApplication(blueprint.id)!;
    expect(app.target_mode).toBe('inline_blueprint');
    const intent = store.getIntentRevision(app.intent_revision_id!)!;
    // Carried for display, never as an acknowledgement.
    expect(intent.blueprint_revision).toBe(blueprint.revision);

    const candidate = store.getRolloutCandidate(app.rollout_candidate_id!)!;
    expect(candidate.provenance).toBe('legacy_inline');
    // Placement is not resolved by migration.
    expect(JSON.parse(candidate.required_targets_json)).toEqual({ nodeIds: [] });

    // No target, so nothing claims a node is running this.
    expect(store.listTargets(app.id)).toEqual([]);
    expect(db.getBlueprint(blueprint.id)!.revision).toBe(blueprint.revision);
  });

  it('says why an unapproved Blueprint carries no authority', () => {
    const store = GitOpsStore.getInstance();
    const blueprint = seedLegacy('mig-unapproved');
    migrateInlineBlueprints();

    const app = store.getLiveBlueprintApplication(blueprint.id)!;
    const limitations = decodeGitOpsEvidenceLimitations(app.evidence_limitations_json);
    // Recorded rather than left blank: an absent approval and an approval that
    // no longer authorizes this intent are otherwise indistinguishable.
    expect(limitations.map(l => l.code)).toContain('blueprint_reapproval_required');
  });

  it('is a no-op on replay', () => {
    const store = GitOpsStore.getInstance();
    const blueprint = seedLegacy('mig-replay');
    migrateInlineBlueprints();
    const app = store.getLiveBlueprintApplication(blueprint.id)!;

    expect(outcomeFor(blueprint)).toBe('skipped_current');
    const after = store.getLiveBlueprintApplication(blueprint.id)!;
    expect(after.intent_revision_id).toBe(app.intent_revision_id);
    expect(after.rollout_candidate_id).toBe(app.rollout_candidate_id);
  });

  it('leaves a Blueprint the new path already described alone', () => {
    const store = GitOpsStore.getInstance();
    const blueprint = commitBlueprintCreate({
      name: 'mig-live',
      description: null,
      compose_content: 'services:\n  web:\n    image: nginx:1.27\n',
      selector: { type: 'nodes', ids: [1] },
      drift_mode: 'suggest',
      classification: 'stateless',
      classification_reasons: [],
      enabled: true,
      created_by: 'tester',
    }, () => [1]);
    const app = store.getLiveBlueprintApplication(blueprint.id)!;

    expect(outcomeFor(blueprint)).toBe('skipped_live_application');
    // Its rows were written with proof this pass does not have.
    expect(store.getLiveBlueprintApplication(blueprint.id)!.intent_revision_id)
      .toBe(app.intent_revision_id);
  });
});

function outcomeFor(blueprint: Blueprint): string {
  return migrateInlineBlueprints().find(r => r.stackName === blueprint.name)!.outcome;
}

/** A Blueprint as an install carries it across an upgrade: no GitOps rows. */
function seedLegacy(name: string): Blueprint {
  return DatabaseService.getInstance().createBlueprint({
    name,
    description: null,
    compose_content: `services:\n  web:\n    image: nginx:1.27\n# ${name}\n`,
    selector: { type: 'nodes', ids: [1] },
    drift_mode: 'suggest',
    classification: 'stateless',
    classification_reasons: [],
    enabled: true,
    created_by: null,
  });
}
