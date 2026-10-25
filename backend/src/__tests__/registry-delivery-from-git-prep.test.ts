import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { setupTestDb } from './helpers/setupTestDb';
import { GitSourceService } from '../services/GitSourceService';
import { RegistryDeliveryService } from '../services/RegistryDeliveryService';
import { PreparedSourceStore } from '../services/preparedSourceStore';
import { NodeRegistry } from '../services/NodeRegistry';
import { runWithRegistryDeliveryContext } from '../helpers/registryDeliveryContext';
import { prepareGitCandidateSource } from '../helpers/registryDeliveryPrepare';
import {
  writeGitCandidatePreparedMeta,
} from '../helpers/registryDeliveryGitCandidate';
import { hashDeliverySourceDir, hashActionSet, hashPullRefList } from '../helpers/registryDeliveryHashes';
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
      secretCapability: { policy: "allow_plaintext", inputs: [], ready: true, requiredRecipients: [] },
    };

    await writeGitCandidatePreparedMeta(stagingDir, {
      version: 1,
      commitSha,
      resolvedRefKind: 'branch',
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
        resolvedRefKind: 'branch',
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
            referencedPullRefsHash: hashPullRefList([]),
            coveredHostsHash: delivery.hashHostList([]),
            actionSetHash: hashActionSet(['stack:create']),
            deliveryContractVersion: 1,
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

  it('maps discover git credentials into the candidate input', async () => {
    const svc = GitSourceService.getInstance();
    const prepareSpy = vi.spyOn(svc, 'prepareRegistryDeliveryFromGit')
      .mockResolvedValue({ prepId: 'prep-1', sourceHash: 'hash-1' });

    const result = await prepareGitCandidateSource({
      op: 'from-git-deploy-now',
      sourceKind: 'git-candidate',
      stack: 'demo',
      stackName: 'demo',
      actionSetHash: hashActionSet(['stack:deploy', 'stack:create']),
      git: {
        repo_url: 'git@github.com:acme/demo.git',
        branch: 'main',
        compose_paths: ['compose.yaml'],
        auth_type: 'deploy_key',
        deploy_key: 'PRIVATE KEY MATERIAL',
        ssh_known_hosts_entry: 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestOnly',
        ssh_host_key_fingerprint: 'SHA256:test-only',
        ca_bundle: 'PEM CERTIFICATE MATERIAL',
      },
    });

    expect(result).toEqual({ prepId: 'prep-1', sourceHash: 'hash-1' });
    expect(prepareSpy).toHaveBeenCalledWith(expect.objectContaining({
      stackName: 'demo',
      repoUrl: 'git@github.com:acme/demo.git',
      branch: 'main',
      authType: 'deploy_key',
      deployKey: 'PRIVATE KEY MATERIAL',
      sshKnownHostsEntry: 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestOnly',
      sshHostKeyFingerprint: 'SHA256:test-only',
      caBundle: 'PEM CERTIFICATE MATERIAL',
    }));

    prepareSpy.mockRestore();
  });

  it('passes deploy-key ssh auth to the discovery fetch', async () => {
    const svc = GitSourceService.getInstance();
    const fetchSpy = vi.spyOn(
      svc as unknown as { fetchFromGit: (params: Record<string, unknown>) => Promise<unknown> },
      'fetchFromGit',
    ).mockResolvedValue({
      composeFiles: [],
      envContent: null,
      commitSha: 'a'.repeat(40),
      resolvedRefKind: 'branch',
      warnings: [],
    });

    await expect(svc.prepareRegistryDeliveryFromGit({
      stackName: 'demo',
      repoUrl: 'git@github.com:acme/demo.git',
      branch: 'main',
      composePaths: ['compose.yaml'],
      contextDir: null,
      syncEnv: false,
      envPath: null,
      authType: 'deploy_key',
      token: null,
      deployKey: 'PRIVATE KEY MATERIAL',
      sshKnownHostsEntry: 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestOnly',
      caBundle: null,
      autoApplyOnWebhook: false,
      autoDeployOnApply: false,
    })).rejects.toThrow(/compose validation failed/i);

    expect(fetchSpy).toHaveBeenCalledWith(expect.objectContaining({
      sshAuth: {
        privateKey: 'PRIVATE KEY MATERIAL',
        knownHostsEntry: 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestOnly',
      },
      caBundlePem: null,
    }));

    fetchSpy.mockRestore();
  });

  it('refuses deploy-key discovery without a key, host trust, or a matching fingerprint', async () => {
    const svc = GitSourceService.getInstance();
    const fetchSpy = vi.spyOn(
      svc as unknown as { fetchFromGit: (params: Record<string, unknown>) => Promise<unknown> },
      'fetchFromGit',
    ).mockRejectedValue(new Error('fetchFromGit must not run without valid deploy-key auth'));
    const base = {
      stackName: 'demo',
      repoUrl: 'git@github.com:acme/demo.git',
      branch: 'main',
      composePaths: ['compose.yaml'],
      contextDir: null,
      syncEnv: false,
      envPath: null,
      authType: 'deploy_key' as const,
      token: null,
      caBundle: null,
      autoApplyOnWebhook: false,
      autoDeployOnApply: false,
    };

    await expect(svc.prepareRegistryDeliveryFromGit({
      ...base,
      deployKey: null,
      sshKnownHostsEntry: null,
    })).rejects.toMatchObject({
      code: 'GIT_ERROR',
      message: 'Deploy key authentication requires a private key and a trusted SSH host key.',
    });

    await expect(svc.prepareRegistryDeliveryFromGit({
      ...base,
      deployKey: 'PRIVATE KEY MATERIAL',
      sshKnownHostsEntry: 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestOnly',
      sshHostKeyFingerprint: 'SHA256:does-not-match',
    })).rejects.toMatchObject({
      code: 'GIT_ERROR',
      message: 'SSH host key fingerprint does not match the trusted key entry.',
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('refuses a git candidate discovery that omits required fields', async () => {
    await expect(prepareGitCandidateSource({
      op: 'from-git-deploy-now',
      sourceKind: 'git-candidate',
      stack: 'demo',
      actionSetHash: hashActionSet(['stack:deploy', 'stack:create']),
      git: {},
    })).rejects.toMatchObject({
      code: 'GIT_ERROR',
      message: 'Git candidate discovery is missing required fields',
    });
  });
});
