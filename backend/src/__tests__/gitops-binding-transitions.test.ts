import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions, GitOpsTransitionError, type EventEnvelope } from '../services/gitops/transitions';
import { directApplicationFixture } from './helpers/gitopsFixtures';
import { encodeGitOpsJson } from '../services/gitops/json';
import { parseStorableRepoUrl, secretFreeRepoUrlFromStorable, serializeRepoIdentityFromStorable } from '../services/gitops/repoIdentity';
import type { GitOpsApplicationRow } from '../services/gitops/types';

describe('gitops binding transitions', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    GitOpsStore.resetForTests();
    GitOpsTransitions.resetForTests();
  });

  afterAll(() => {
    cleanupTestDb(tmpDir);
  });

  it('converts a Direct application in place to Blueprint mode', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    const blueprintId = createBlueprint('bind-convert');
    tx.activateDirect({
      application: app('app-convert', 'source-web'),
      nodeId: 1,
      envelope: env('op-activate-convert'),
    });
    const sqlite = DatabaseService.getInstance().getDb();
    sqlite.prepare('UPDATE gitops_applications SET accepted_generation_id = ? WHERE id = ?')
      .run('gen-keep', 'app-convert');

    const result = tx.convertDirectToBlueprint({
      applicationId: 'app-convert',
      blueprintId,
      envelope: env('op-convert'),
    });
    expect(result.replayed).toBe(false);

    const converted = store.getApplication('app-convert')!;
    expect(converted.id).toBe('app-convert');
    expect(converted.target_mode).toBe('blueprint');
    expect(converted.stack_name).toBeNull();
    expect(converted.configured_source_stack_name).toBe('source-web');
    expect(converted.blueprint_id).toBe(blueprintId);
    expect(converted.configured_repo_url).toBe('https://github.com/example/source-web.git');
    expect(converted.accepted_generation_id).toBe('gen-keep');
    expect(store.getTarget('app-convert', 1)).toBeTruthy();
    expect(store.getLiveBlueprintApplicationBySourceStack('source-web')?.id).toBe('app-convert');

    const history = sqlite.prepare(
      "SELECT stage, before_json, after_json FROM gitops_history WHERE application_id = ? AND stage = 'application_retargeted'",
    ).get('app-convert') as { stage: string; before_json: string; after_json: string };
    expect(JSON.parse(history.before_json)).toMatchObject({ targetMode: 'direct' });
    expect(JSON.parse(history.after_json)).toMatchObject({ targetMode: 'blueprint' });
  });

  it('replays a conversion with the same operation id', () => {
    const tx = GitOpsTransitions.getInstance();
    const blueprintId = createBlueprint('bind-replay');
    tx.activateDirect({
      application: app('app-replay', 'replay-web'),
      nodeId: 1,
      envelope: env('op-activate-replay'),
    });
    const envelope = env('op-replay');
    const first = tx.convertDirectToBlueprint({ applicationId: 'app-replay', blueprintId, envelope });
    const second = tx.convertDirectToBlueprint({ applicationId: 'app-replay', blueprintId, envelope });
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(GitOpsStore.getInstance().getApplication('app-replay')?.configured_source_stack_name).toBe('replay-web');
  });

  it('refuses conversion when the current mode does not match', () => {
    const tx = GitOpsTransitions.getInstance();
    const blueprintId = createBlueprint('bind-wrong-mode');
    GitOpsStore.getInstance().insertApplication({
      ...app('app-inline-wrong', 'unused'),
      lifecycle_key: `blueprint:${blueprintId}`,
      target_mode: 'inline_blueprint',
      stack_name: null,
      blueprint_id: blueprintId,
      configured_repo_url: null,
      repo_identity_json: null,
      configured_ref: null,
    });
    expect(() => tx.convertDirectToBlueprint({
      applicationId: 'app-inline-wrong',
      blueprintId,
      envelope: env('op-wrong-mode'),
    })).toThrow(GitOpsTransitionError);
  });

  it('refuses a second live Blueprint claimant for the same Blueprint', () => {
    const tx = GitOpsTransitions.getInstance();
    const blueprintId = createBlueprint('bind-unique-bp');
    tx.activateDirect({
      application: app('app-unique-a', 'unique-a-web'),
      nodeId: 1,
      envelope: env('op-activate-unique-a'),
    });
    tx.activateDirect({
      application: { ...app('app-unique-b', 'unique-b-web'), configured_repo_url: 'https://github.com/example/other.git' },
      nodeId: 1,
      envelope: env('op-activate-unique-b'),
    });
    tx.convertDirectToBlueprint({
      applicationId: 'app-unique-a',
      blueprintId,
      envelope: env('op-unique-a'),
    });
    expect(() => tx.convertDirectToBlueprint({
      applicationId: 'app-unique-b',
      blueprintId,
      envelope: env('op-unique-b'),
    })).toThrow(/live blueprint/i);
  });

  it('refuses a second live Blueprint-mode application on the same repo URL', () => {
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({
      application: app('app-repo-a', 'repo-a-web', 'https://github.com/example/shared.git'),
      nodeId: 1,
      envelope: env('op-activate-repo-a'),
    });
    tx.activateDirect({
      application: app('app-repo-b', 'repo-b-web', 'https://github.com/example/shared.git'),
      nodeId: 1,
      envelope: env('op-activate-repo-b'),
    });
    tx.convertDirectToBlueprint({
      applicationId: 'app-repo-a',
      blueprintId: createBlueprint('bind-repo-a'),
      envelope: env('op-repo-a'),
    });
    expect(() => tx.convertDirectToBlueprint({
      applicationId: 'app-repo-b',
      blueprintId: createBlueprint('bind-repo-b'),
      envelope: env('op-repo-b'),
    })).toThrow(/repo/i);
  });

  it('refuses a second live Blueprint-mode application on a differently spelled repo', () => {
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({
      application: app('app-spelling-a', 'spelling-a-web', 'https://github.com/example/spelled.git'),
      nodeId: 1,
      envelope: env('op-activate-spelling-a'),
    });
    tx.activateDirect({
      application: app('app-spelling-b', 'spelling-b-web', 'git@github.com:example/spelled'),
      nodeId: 1,
      envelope: env('op-activate-spelling-b'),
    });
    tx.convertDirectToBlueprint({
      applicationId: 'app-spelling-a',
      blueprintId: createBlueprint('bind-spelling-a'),
      envelope: env('op-spelling-a'),
    });
    expect(() => tx.convertDirectToBlueprint({
      applicationId: 'app-spelling-b',
      blueprintId: createBlueprint('bind-spelling-b'),
      envelope: env('op-spelling-b'),
    })).toThrow(/repo/i);
    expect(GitOpsStore.getInstance().getApplication('app-spelling-b')?.target_mode).toBe('direct');
  });

  it('binds Blueprint mode for two applications on distinct repos', () => {
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({
      application: app('app-distinct-a', 'distinct-a-web', 'https://github.com/example/distinct-a.git'),
      nodeId: 1,
      envelope: env('op-activate-distinct-a'),
    });
    tx.activateDirect({
      application: app('app-distinct-b', 'distinct-b-web', 'https://github.com/example/distinct-b.git'),
      nodeId: 1,
      envelope: env('op-activate-distinct-b'),
    });
    tx.convertDirectToBlueprint({
      applicationId: 'app-distinct-a',
      blueprintId: createBlueprint('bind-distinct-a'),
      envelope: env('op-distinct-a'),
    });
    tx.convertDirectToBlueprint({
      applicationId: 'app-distinct-b',
      blueprintId: createBlueprint('bind-distinct-b'),
      envelope: env('op-distinct-b'),
    });
    expect(GitOpsStore.getInstance().getApplication('app-distinct-b')?.target_mode).toBe('blueprint');
  });

  it('refuses a new claim while a live Blueprint-mode repo cannot be identified', () => {
    const tx = GitOpsTransitions.getInstance();
    const store = GitOpsStore.getInstance();
    tx.activateDirect({
      application: app('app-opaque', 'opaque-web', 'https://github.com/example/opaque.git'),
      nodeId: 1,
      envelope: env('op-activate-opaque'),
    });
    tx.convertDirectToBlueprint({
      applicationId: 'app-opaque',
      blueprintId: createBlueprint('bind-opaque'),
      envelope: env('op-opaque'),
    });
    // A stored URL no parser accepts: the guard cannot prove this row is a
    // different repository, so it must not assume it. Restored in a finally
    // because this database is shared by every test in the file, and a failure
    // here must not leave a refusal reaching the tests below it.
    try {
      DatabaseService.getInstance().getDb()
        .prepare('UPDATE gitops_applications SET configured_repo_url = ? WHERE id = ?')
        .run('not a repo url', 'app-opaque');

      tx.activateDirect({
        application: app('app-after-opaque', 'after-opaque-web', 'https://github.com/example/after-opaque.git'),
        nodeId: 1,
        envelope: env('op-activate-after-opaque'),
      });
      expect(() => tx.convertDirectToBlueprint({
        applicationId: 'app-after-opaque',
        blueprintId: createBlueprint('bind-after-opaque'),
        envelope: env('op-after-opaque'),
      })).toThrow(/repo/i);
      expect(store.getApplication('app-after-opaque')?.target_mode).toBe('direct');
    } finally {
      DatabaseService.getInstance().getDb()
        .prepare('UPDATE gitops_applications SET configured_repo_url = ? WHERE id = ?')
        .run('https://github.com/example/opaque.git', 'app-opaque');
    }
  });

  it('refuses a claim whose own repo url cannot be identified', () => {
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({
      application: app('app-broken-a', 'broken-a-web', 'https://github.com/example/broken.git'),
      nodeId: 1,
      envelope: env('op-activate-broken-a'),
    });
    // Only a raw UPDATE can put this row in the store: ingress now refuses a
    // URL with no repository path, so the guard's refusal is a backstop for a
    // row written before that check existed, not a path an operator can walk.
    DatabaseService.getInstance().getDb()
      .prepare('UPDATE gitops_applications SET configured_repo_url = ? WHERE id = ?')
      .run('https://github.com', 'app-broken-a');
    expect(() => tx.convertDirectToBlueprint({
      applicationId: 'app-broken-a',
      blueprintId: createBlueprint('bind-broken-a'),
      envelope: env('op-broken-a'),
    })).toThrow(/repo/i);
  });

    it('retires a Blueprint-mode application back to Direct on the retained source stack', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    const blueprintId = createBlueprint('fleet-web');
    tx.activateDirect({
      application: app('app-retire', 'old-web'),
      nodeId: 1,
      envelope: env('op-activate-retire'),
    });
    tx.convertDirectToBlueprint({
      applicationId: 'app-retire',
      blueprintId,
      envelope: env('op-to-blueprint'),
    });
    tx.convertBlueprintToDirect({
      applicationId: 'app-retire',
      stackName: 'old-web',
      envelope: env('op-retire'),
    });
    const retired = store.getApplication('app-retire')!;
    expect(retired.target_mode).toBe('direct');
    expect(retired.stack_name).toBe('old-web');
    expect(retired.configured_source_stack_name).toBeNull();
    expect(retired.blueprint_id).toBeNull();
    expect(store.getLiveBlueprintApplicationBySourceStack('old-web')).toBeUndefined();
  });

  it('demotes Blueprint mode back to Inline on the same row', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    const blueprintId = createBlueprint('bind-flip');
    tx.activateDirect({
      application: app('app-flip', 'flip-web'),
      nodeId: 1,
      envelope: env('op-activate-flip'),
    });
    tx.convertDirectToBlueprint({
      applicationId: 'app-flip',
      blueprintId,
      envelope: env('op-flip-convert'),
    });
    tx.blueprintModeDemoted({ applicationId: 'app-flip', envelope: env('op-demote') });
    const demoted = store.getApplication('app-flip')!;
    expect(demoted.target_mode).toBe('inline_blueprint');
    expect(demoted.configured_source_stack_name).toBeNull();
    expect(demoted.configured_repo_url).toBeNull();
    expect(demoted.blueprint_id).toBe(blueprintId);
  });

  it('takes the Git-era rollout authorization evidence off the row on demotion', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    const blueprintId = createBlueprint('bind-demote-evidence');
    tx.activateDirect({
      application: app('app-demote-evidence', 'demote-evidence-web'),
      nodeId: 1,
      envelope: env('op-activate-demote-evidence'),
    });
    tx.convertDirectToBlueprint({
      applicationId: 'app-demote-evidence',
      blueprintId,
      envelope: env('op-demote-evidence-convert'),
    });
    // The shape a live Git-managed application carries: a placement approval,
    // an authorization policy other than manual, and the preflight evidence a
    // recorded evaluation left behind with its live fingerprint.
    const sqlite = DatabaseService.getInstance().getDb();
    sqlite.prepare(
      `UPDATE gitops_applications
       SET placement_approval_ref = ?, rollout_authorization_ref = ?, rollout_authorization_policy = 'automatic',
           latest_preflight_evidence_json = '{}', preflight_fingerprint = ?
       WHERE id = ?`,
    ).run('place-demote', 'auth-demote', 'f'.repeat(64), 'app-demote-evidence');

    tx.blueprintModeDemoted({
      applicationId: 'app-demote-evidence',
      envelope: env('op-demote-evidence'),
    });

    const demoted = store.getApplication('app-demote-evidence')!;
    // The evidence outlived nothing else on the row: without the clear it
    // describes a Git-managed authorization this mode can no longer be granted,
    // and the first placement an operator grants afterwards would be projected
    // against it.
    expect(demoted.placement_approval_ref).toBeNull();
    expect(demoted.rollout_authorization_ref).toBeNull();
    expect(demoted.rollout_authorization_policy).toBe('manual');
    expect(demoted.latest_preflight_evidence_json).toBeNull();
    expect(demoted.preflight_fingerprint).toBeNull();

    const history = sqlite.prepare(
      "SELECT after_json FROM gitops_history WHERE application_id = ? AND operation_id = ? AND stage = 'application_retargeted'",
    ).get('app-demote-evidence', 'op-demote-evidence') as { after_json: string };
    // The clear is auditable in the same row as the mode change it rides on,
    // so a reader can tell an evidence drop from a row that never had one.
    expect(JSON.parse(history.after_json)).toMatchObject({
      targetMode: 'inline_blueprint',
      latestPreflightEvidenceJson: null,
      preflightFingerprint: null,
    });
  });

  it('clears evidence that an invalidated placement left behind', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    const blueprintId = createBlueprint('bind-demote-invalidated');
    tx.activateDirect({
      application: app('app-demote-invalidated', 'demote-invalidated-web'),
      nodeId: 1,
      envelope: env('op-activate-demote-invalidated'),
    });
    tx.convertDirectToBlueprint({
      applicationId: 'app-demote-invalidated',
      blueprintId,
      envelope: env('op-demote-invalidated-convert'),
    });
    // The one reachable shape where the no-op conditions can disagree with
    // what the clear would write. `invalidatePlacementOnMaterialChange` nulls
    // the placement ref, the authorization ref and the fingerprint but leaves
    // the evidence column, so on a manual-policy row every gate except the
    // evidence one reads clean. A no-op condition that omitted the evidence
    // would return early here and strand it.
    const sqlite = DatabaseService.getInstance().getDb();
    sqlite.prepare(
      `UPDATE gitops_applications
       SET placement_approval_ref = NULL, rollout_authorization_ref = NULL,
           preflight_fingerprint = NULL, rollout_authorization_policy = 'manual',
           latest_preflight_evidence_json = '{}'
       WHERE id = ?`,
    ).run('app-demote-invalidated');

    tx.blueprintModeDemoted({
      applicationId: 'app-demote-invalidated',
      envelope: env('op-demote-invalidated'),
    });

    const demoted = store.getApplication('app-demote-invalidated')!;
    expect(demoted.latest_preflight_evidence_json).toBeNull();
    const history = sqlite.prepare(
      "SELECT after_json FROM gitops_history WHERE application_id = ? AND operation_id = ? AND stage = 'application_retargeted'",
    ).get('app-demote-invalidated', 'op-demote-invalidated') as { after_json: string };
    expect(JSON.parse(history.after_json)).toMatchObject({
      targetMode: 'inline_blueprint',
      latestPreflightEvidenceJson: null,
    });
  });

  it('leaves a demoted row with no evidence untouched', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    const blueprintId = createBlueprint('bind-demote-noop');
    tx.activateDirect({
      application: app('app-demote-noop', 'demote-noop-web'),
      nodeId: 1,
      envelope: env('op-activate-demote-noop'),
    });
    tx.convertDirectToBlueprint({
      applicationId: 'app-demote-noop',
      blueprintId,
      envelope: env('op-demote-noop-convert'),
    });
    const before = store.getApplication('app-demote-noop')!;

    tx.blueprintModeDemoted({ applicationId: 'app-demote-noop', envelope: env('op-demote-noop') });

    const demoted = store.getApplication('app-demote-noop')!;
    expect(demoted.latest_preflight_evidence_json).toBeNull();
    expect(demoted.preflight_fingerprint).toBeNull();
    expect(demoted.placement_approval_ref).toBe(before.placement_approval_ref);
    expect(demoted.rollout_authorization_policy).toBe(before.rollout_authorization_policy);
    const rows = DatabaseService.getInstance().getDb().prepare(
      "SELECT after_json FROM gitops_history WHERE application_id = ? AND operation_id = ? AND stage = 'application_retargeted'",
    ).all('app-demote-noop', 'op-demote-noop') as Array<{ after_json: string }>;
    // Nothing was cleared, so the retarget row names only the mode change.
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.after_json)).toEqual({ targetMode: 'inline_blueprint' });
  });
});

function createBlueprint(name: string): number {
  return DatabaseService.getInstance().createBlueprint({
    name,
    description: null,
    compose_content: 'services: {}',
    selector: { type: 'nodes', ids: [1] },
    drift_mode: 'observe',
    classification: 'stateless',
    classification_reasons: [],
    enabled: true,
    created_by: null,
  }).id;
}

/**
 * A Direct application row carrying the URL a real row would store.
 *
 * `directSourceIdentity` persists the secret-free derived form, not the URL the
 * operator typed, so an SSH source is stored as `ssh://git@host/path` and never
 * as the scp spelling. Passing the scp form through unchanged would store a row
 * production cannot create, and would leave the guard untested against the one
 * form it actually reads.
 */
function app(id: string, stackName: string, repoUrl?: string): GitOpsApplicationRow {
  const raw = repoUrl ?? `https://github.com/example/${stackName}.git`;
  return {
    ...directApplicationFixture(id, stackName),
    configured_repo_url: storedRepoUrl(raw),
    repo_identity_json: encodeGitOpsJson(identityOf(raw)),
  };
}

function storedRepoUrl(raw: string): string {
  const parsed = parseStorableRepoUrl(raw);
  if (!parsed.ok) throw new Error(`fixture repo url is not storable: ${parsed.reason}`);
  return secretFreeRepoUrlFromStorable(parsed);
}

/**
 * The stored identity a real row would carry for this URL.
 *
 * `directSourceIdentity` derives both columns from one URL, so a fixture that
 * overrides only `configured_repo_url` leaves the two disagreeing. That is
 * invisible while a guard reads the URL and wrong the moment one reads the
 * stored identity, so the pair is derived together here.
 */
function identityOf(url: string): { host: string; pathname: string } {
  const parsed = parseStorableRepoUrl(url);
  if (!parsed.ok) throw new Error(`fixture repo url is not storable: ${parsed.reason}`);
  return serializeRepoIdentityFromStorable(parsed);
}

function env(operationId: string): EventEnvelope {
  return { operationId, actor: 'tester', trigger: 'manual', at: Date.now() };
}
