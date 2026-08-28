import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { setupTestDb } from './helpers/setupTestDb';
import { GitSourceService } from '../services/GitSourceService';
import { RegistryDeliveryService } from '../services/RegistryDeliveryService';
import { PreparedSourceStore } from '../services/preparedSourceStore';
import { NodeRegistry } from '../services/NodeRegistry';
import { runWithRegistryDeliveryContext } from '../helpers/registryDeliveryContext';
import {
  writeGitCandidatePreparedMeta,
} from '../helpers/registryDeliveryGitCandidate';
import { hashDeliverySourceDir, hashActionSet } from '../helpers/registryDeliveryHashes';
import { candidateRelPathForSha } from '../services/gitops/createStagingMarker';
import type { FetchResult, MaterializationResult } from '../services/GitSourceService';

describe('createStackFromGit prepared git candidate consumption', () => {
  beforeEach(async () => {
    await setupTestDb();
    RegistryDeliveryService.resetForTests();
    const deliverySourceId = RegistryDeliveryService.getInstance().getDeliverySourceId();
    PreparedSourceStore.getInstance().configure(deliverySourceId);
  });

  it('uses the prepared git candidate instead of fetchFromGit when prepId is set', async () => {
    const svc = GitSourceService.getInstance();
    const fetchSpy = vi.spyOn(
      svc as unknown as { fetchFromGit: () => Promise<unknown> },
      'fetchFromGit',
    ).mockRejectedValue(new Error('fetchFromGit must not run when prepId is present'));

    const stagingDir = path.join(process.env.TMPDIR || '/tmp', `sencho-git-prep-${Date.now()}`);
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(
      path.join(stagingDir, 'compose.yaml'),
      'services:\n  app:\n    image: nginx:latest\n',
    );

    const commitSha = 'a'.repeat(40);
    const candidateRelPath = candidateRelPathForSha(commitSha);
    const materialization: MaterializationResult = {
      inventory: {
        inputs: [],
        refusals: [],
        buildContexts: [],
        dynamic: [],
        counts: { managed: 0, unmanaged: 0, refused: 0 },
      },
      contextCopyPlans: [],
      candidateRelPath,
      validation: { ok: true },
    };

    await writeGitCandidatePreparedMeta(stagingDir, {
      version: 1,
      commitSha,
      candidateRelPath,
      composeFiles: [{ path: 'compose.yaml', content: 'services:\n  app:\n    image: nginx:latest\n' }],
      envContent: null,
      materialization,
      warnings: [],
    });

    const sourceHash = hashDeliverySourceDir(stagingDir);
    const entry = await PreparedSourceStore.getInstance().prepareFromDirectory(
      'git-candidate',
      sourceHash,
      stagingDir,
    );

    const stackName = `from-git-prep-${Date.now()}`;
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const delivery = RegistryDeliveryService.getInstance();

    const restoreSpy = vi.spyOn(
      svc as unknown as {
        restoreCreateFromPreparedGitCandidate: (
          prepId: string,
          managedRoot: string,
          rootPreexisted: boolean,
          gitopsOperationId: string,
          staged: { candidateRelPath: string | null },
        ) => Promise<{ fetched: FetchResult; materialization: MaterializationResult }>;
      },
      'restoreCreateFromPreparedGitCandidate',
    ).mockResolvedValue({
      fetched: {
        composeFiles: [{ path: 'compose.yaml', content: 'services:\n  app:\n    image: nginx:latest\n' }],
        envContent: null,
        commitSha,
        warnings: [],
      },
      materialization,
    });

    try {
      await runWithRegistryDeliveryContext({
        envelope: {
          attestation: delivery.signAttestation({
            nodeIdClaim: nodeId,
            stack: stackName,
            op: 'from-git-deploy-now',
            sourceHash,
            referencedHostsHash: delivery.hashHostList([]),
            coveredHostsHash: delivery.hashHostList([]),
            actionSetHash: hashActionSet(['stack:create']),
            prepId: entry.prepId,
          }),
          prepId: entry.prepId,
          auths: [],
          notAfter: Date.now() + 60_000,
          deliverySourceId: delivery.getDeliverySourceId(),
        },
        nodeId,
        stack: stackName,
        stage: 'from-git-deploy-now',
      }, () => svc.createStackFromGit({
        stackName,
        repoUrl: 'https://github.com/example/demo.git',
        branch: 'main',
        composePaths: ['compose.yaml'],
        contextDir: null,
        syncEnv: false,
        envPath: null,
        authType: 'none',
        token: null,
        autoApplyOnWebhook: false,
        autoDeployOnApply: false,
      }));
    } catch {
      // Downstream create steps may fail in this isolated test; the contract
      // under test is the prepared-source branch before fetchFromGit.
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(restoreSpy).toHaveBeenCalledWith(
      entry.prepId,
      expect.any(String),
      false,
      expect.any(String),
      expect.objectContaining({ candidateRelPath: null }),
    );

    fetchSpy.mockRestore();
    restoreSpy.mockRestore();
  });
});
