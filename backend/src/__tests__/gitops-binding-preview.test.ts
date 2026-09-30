import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions } from '../services/gitops/transitions';
import { commitBlueprintCreate } from '../services/gitops/blueprintProducers';
import { GitOpsBindingService } from '../services/gitops/binding';
import { directApplicationFixture } from './helpers/gitopsFixtures';
import type { MarkerRead } from '../services/BlueprintService';

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
    expect(retirePreview.application.stackName).toBeNull();
    expect(retirePreview.application.composePaths).toEqual(['compose.yaml']);
    assertNoSecrets(retirePreview);
    const detachPreview = await svc.previewDetachToInline(blueprint.id);
    expect(detachPreview.transition).toBe('detach');
    expect(detachPreview.proposedOrigin).toBe('inline');
    expect(detachPreview.application.stackName).toBeNull();
    assertNoSecrets(detachPreview);
  });

  it('reads a marker it could not fetch as unproven, not as no marker at all', async () => {
    // The create case is the one that matters: `missing` on a create reads as
    // `unmanaged`, which tells the operator the directory is clear to write to.
    // A transport failure is not evidence of that, and a create target that
    // cannot be read must not be reported as safe to take.
    const { BlueprintService } = await import('../services/BlueprintService');
    const { DatabaseService } = await import('../services/DatabaseService');
    const { vi } = await import('vitest');
    const blueprint = commitBlueprintCreate({
      name: 'bp-preview-unreadable',
      description: null,
      compose_content: 'services:\n  web:\n    image: nginx:1.27\n',
      selector: { type: 'nodes', ids: [1] },
      drift_mode: 'suggest',
      classification: 'stateless',
      classification_reasons: [],
      enabled: true,
      created_by: 'tester',
    }, () => [1]);
    const application = directApplicationFixture('app-preview-unreadable', 'preview-unreadable');
    GitOpsTransitions.getInstance().activateDirect({
      application,
      nodeId: 1,
      envelope: { operationId: 'op-preview-unreadable', actor: 'tester', trigger: 'manual', at: Date.now() },
    });

    // A real node row, because a change whose node cannot be found is reported
    // unproven before the marker is ever read, and this would then pass without
    // reaching the branch it is named for.
    const nodeId = DatabaseService.getInstance().getNodes()[0].id;
    const svc = GitOpsBindingService.getInstance();
    const classify = async (read: MarkerRead) => {
      vi.spyOn(BlueprintService.getInstance(), 'readMarker').mockResolvedValue(read);
      const preview = await svc.previewConvertInlineToGit({ blueprintId: blueprint.id, applicationId: application.id });
      const change = preview.blueprintPreview?.changes.find((c) => c.nodeId === nodeId);
      expect(change, 'the preview must reach the marker classification').toBeDefined();
      return { action: change!.action, marker: preview.markers.find((m) => m.nodeId === nodeId) };
    };

    const unreadable = await classify({ kind: 'failed', error: 'the node answered HTTP 502' });
    expect(unreadable.action, 'this test only discriminates on a create').toBe('create');
    expect(unreadable.marker?.classification).toBe('unproven');

    // The absent path is unchanged, and it is what makes the case above mean
    // something: `missing` on a create is genuinely an unmanaged directory.
    const absent = await classify({ kind: 'missing' });
    expect(absent.marker?.classification).toBe('unmanaged');
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
