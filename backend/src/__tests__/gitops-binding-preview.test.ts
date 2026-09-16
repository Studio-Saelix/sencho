import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions } from '../services/gitops/transitions';
import { commitBlueprintCreate } from '../services/gitops/blueprintProducers';
import { GitOpsBindingService } from '../services/gitops/binding';
import { directApplicationFixture } from './helpers/gitopsFixtures';

const SECRET_KEY = /token|deploy_key|ca_bundle|ssh|encrypted/i;

describe('GitOps binding previews', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    GitOpsStore.resetForTests();
    GitOpsTransitions.resetForTests();
  });

  afterAll(() => {
    GitOpsBindingService.resetForTests();
    GitOpsStore.resetForTests();
    GitOpsTransitions.resetForTests();
    cleanupTestDb(tmpDir);
  });

  it('omits credential material from conversion previews', async () => {
    const blueprint = commitBlueprintCreate({
      name: 'bp-preview',
      description: null,
      compose_content: 'services:\n  web:\n    image: nginx:1.27\n',
      selector: { type: 'nodes', ids: [1] },
      drift_mode: 'suggest',
      classification: 'stateless',
      classification_reasons: [],
      enabled: true,
      created_by: 'tester',
    }, () => [1]);
    const application = {
      ...directApplicationFixture('app-preview-web', 'preview-web'),
      configured_repo_url: 'https://github.com/example/preview-web.git',
    };
    GitOpsTransitions.getInstance().activateDirect({
      application,
      nodeId: 1,
      envelope: { operationId: 'op-preview', actor: 'tester', trigger: 'manual', at: Date.now() },
    });

    const svc = GitOpsBindingService.getInstance();
    const convertPreview = await svc.previewConvertInlineToGit({
      blueprintId: blueprint.id,
      applicationId: application.id,
    });
    expect(convertPreview.transition).toBe('convert');
    expect(convertPreview.proposedOrigin).toBe('git');
    expect(convertPreview.application.repoUrl).toBe('https://github.com/example/preview-web.git');
    expect(convertPreview.rollbackLimitations.length).toBeGreaterThan(0);
    assertNoSecrets(convertPreview);

    svc.convertInlineToGit({
      blueprintId: blueprint.id,
      applicationId: application.id,
      actor: 'tester',
    });
    const retirePreview = await svc.previewRetireToDirect(blueprint.id);
    expect(retirePreview.transition).toBe('retire');
    expect(retirePreview.proposedOrigin).toBe('inline');
    assertNoSecrets(retirePreview);
    const detachPreview = await svc.previewDetachToInline(blueprint.id);
    expect(detachPreview.transition).toBe('detach');
    expect(detachPreview.proposedOrigin).toBe('inline');
    assertNoSecrets(detachPreview);
  });
});

function assertNoSecrets(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) assertNoSecrets(entry);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    expect(key).not.toMatch(SECRET_KEY);
    assertNoSecrets(nested);
  }
}
