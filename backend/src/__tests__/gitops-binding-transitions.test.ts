import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions, GitOpsTransitionError, type EventEnvelope } from '../services/gitops/transitions';
import { directApplicationFixture } from './helpers/gitopsFixtures';
import { encodeGitOpsJson } from '../services/gitops/json';
import { parseStorableRepoUrl, serializeRepoIdentityFromStorable } from '../services/gitops/repoIdentity';
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

function app(id: string, stackName: string, repoUrl?: string): GitOpsApplicationRow {
  const url = repoUrl ?? `https://github.com/example/${stackName}.git`;
  return {
    ...directApplicationFixture(id, stackName),
    configured_repo_url: url,
    repo_identity_json: encodeGitOpsJson(identityOf(url)),
  };
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
