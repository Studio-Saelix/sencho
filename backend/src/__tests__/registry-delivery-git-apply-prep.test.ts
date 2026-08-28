import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { setupTestDb } from './helpers/setupTestDb';
import { GitSourceService } from '../services/GitSourceService';
import { RegistryDeliveryService } from '../services/RegistryDeliveryService';
import { PreparedSourceStore } from '../services/preparedSourceStore';
import {
  writeGitCandidatePreparedMeta,
} from '../helpers/registryDeliveryGitCandidate';
import { hashDeliverySourceDir } from '../helpers/registryDeliveryHashes';
import { candidateRelPathForSha } from '../services/gitops/createStagingMarker';
import { stackManagedRoot } from '../services/gitops/directApplication';
import type { MaterializationResult } from '../services/GitSourceService';

describe('restoreApplyFromPreparedGitCandidate', () => {
  beforeEach(async () => {
    await setupTestDb();
    RegistryDeliveryService.resetForTests();
    const deliverySourceId = RegistryDeliveryService.getInstance().getDeliverySourceId();
    PreparedSourceStore.getInstance().configure(deliverySourceId);
  });

  it('installs prepared bytes at the pending candidate path', async () => {
    const stagingDir = path.join(process.env.TMPDIR || '/tmp', `sencho-git-apply-prep-${Date.now()}`);
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(
      path.join(stagingDir, 'compose.yaml'),
      'services:\n  app:\n    image: nginx:latest\n',
    );

    const commitSha = 'd'.repeat(40);
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

    const stackName = `apply-restore-${Date.now()}`;
    const svc = GitSourceService.getInstance();
    await (
      svc as unknown as {
        restoreApplyFromPreparedGitCandidate: (
          prepId: string,
          stackName: string,
          commitSha: string,
          candidateRelPath: string,
        ) => Promise<void>;
      }
    ).restoreApplyFromPreparedGitCandidate(
      entry.prepId,
      stackName,
      commitSha,
      candidateRelPath,
    );

    const installed = path.join(stackManagedRoot(stackName), candidateRelPath, 'compose.yaml');
    expect(fs.existsSync(installed)).toBe(true);
    expect(PreparedSourceStore.getInstance().getEntry(entry.prepId)?.state).toBe('prepared');
  });

  it('rejects commit or candidate path mismatches', async () => {
    const stagingDir = path.join(process.env.TMPDIR || '/tmp', `sencho-git-apply-mismatch-${Date.now()}`);
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(path.join(stagingDir, 'compose.yaml'), 'services:\n  app:\n    image: nginx\n');

    const commitSha = 'e'.repeat(40);
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
      composeFiles: [{ path: 'compose.yaml', content: 'services:\n  app:\n    image: nginx\n' }],
      envContent: null,
      materialization,
      warnings: [],
    });

    const entry = await PreparedSourceStore.getInstance().prepareFromDirectory(
      'git-candidate',
      hashDeliverySourceDir(stagingDir),
      stagingDir,
    );

    const svc = GitSourceService.getInstance();
    const restore = (
      svc as unknown as {
        restoreApplyFromPreparedGitCandidate: (
          prepId: string,
          stackName: string,
          commitSha: string,
          candidateRelPath: string,
        ) => Promise<void>;
      }
    ).restoreApplyFromPreparedGitCandidate.bind(svc);

    await expect(restore(
      entry.prepId,
      `mismatch-${Date.now()}`,
      'f'.repeat(40),
      candidateRelPath,
    )).rejects.toThrow(/commit mismatch/i);
  });
});
