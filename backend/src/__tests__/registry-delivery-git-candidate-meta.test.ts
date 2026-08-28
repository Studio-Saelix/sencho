import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  fetchResultFromPreparedMeta,
  installGitCandidatePayloadToManagedRoot,
  readGitCandidatePreparedMeta,
  writeGitCandidatePreparedMeta,
  GIT_CANDIDATE_PREPARED_META_FILE,
} from '../helpers/registryDeliveryGitCandidate';
import { candidateRelPathForSha } from '../services/gitops/createStagingMarker';
import type { MaterializationResult } from '../services/GitSourceService';

describe('registryDeliveryGitCandidate helpers', () => {
  it('round-trips metadata and installs candidate bytes', async () => {
    const payloadDir = path.join(process.env.TMPDIR || '/tmp', `sencho-git-meta-${Date.now()}`);
    const managedRoot = path.join(process.env.TMPDIR || '/tmp', `sencho-git-managed-${Date.now()}`);
    fs.mkdirSync(payloadDir, { recursive: true });
    fs.mkdirSync(managedRoot, { recursive: true });
    fs.writeFileSync(path.join(payloadDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n');

    const commitSha = 'b'.repeat(40);
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

    await writeGitCandidatePreparedMeta(payloadDir, {
      version: 1,
      commitSha,
      candidateRelPath,
      composeFiles: [{ path: 'compose.yaml', content: 'services:\n  web:\n    image: nginx\n' }],
      envContent: null,
      materialization,
      warnings: ['submodule skipped'],
    });

    const meta = await readGitCandidatePreparedMeta(payloadDir);
    expect(meta.commitSha).toBe(commitSha);
    expect(fetchResultFromPreparedMeta(meta).warnings).toEqual(['submodule skipped']);

    await installGitCandidatePayloadToManagedRoot(payloadDir, managedRoot, candidateRelPath);
    const installedCompose = path.join(managedRoot, candidateRelPath, 'compose.yaml');
    expect(fs.existsSync(installedCompose)).toBe(true);
    expect(fs.existsSync(path.join(managedRoot, candidateRelPath, GIT_CANDIDATE_PREPARED_META_FILE))).toBe(false);
  });
});
