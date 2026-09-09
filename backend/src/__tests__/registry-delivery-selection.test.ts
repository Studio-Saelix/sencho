import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { resolveRegistryDeliverySelection, invocationBasisFromRecord } from '../helpers/registryDeliverySelection';
import { hashProjectSource, hashSelectionInputs } from '../helpers/registryDeliveryHashes';
import { discoverRegistryReferences } from '../services/registryReferenceDiscovery';
import { writeGitCandidatePreparedMeta } from '../helpers/registryDeliveryGitCandidate';
import { authoredComposeFileArgs, authoredComposeEnvFileArgs } from '../utils/authoredComposeArgs';
import { buildCandidateComposeInvocation } from '../utils/candidateComposeInvocation';
import { gitSourceLocalComposeFiles } from '../utils/gitComposeFiles';
import { candidateRelPathForSha } from '../services/gitops/createStagingMarker';
import { DatabaseService } from '../services/DatabaseService';
import { NodeRegistry } from '../services/NodeRegistry';
import type { RollbackInvocationRecord } from '../types/rollbackGeneration';
import type { MaterializationResult } from '../services/GitSourceService';

let tmpDir: string;

function extractFlagArgs(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === flag) out.push(args[i + 1]);
  }
  return out;
}

function materialization(commitSha: string): MaterializationResult {
  return {
    inventory: {
      inputs: [],
      refusals: [],
      buildContexts: [],
      dynamic: [],
      counts: { managed: 0, unmanaged: 0, refused: 0 },
    },
    contextCopyPlans: [],
    candidateRelPath: candidateRelPathForSha(commitSha),
    validation: { ok: true },
  };
}

function seedSource(stackName: string, composePaths: string[]): void {
  DatabaseService.getInstance().upsertGitSource({
    stack_name: stackName,
    repo_url: 'https://github.com/example/repo.git',
    branch: 'main',
    compose_path: composePaths[0],
    compose_paths: composePaths,
    context_dir: null,
    sync_env: false,
    env_path: null,
    auth_type: 'none',
    encrypted_token: null, encrypted_deploy_key: null, ssh_known_hosts_entry: null, ssh_host_key_fingerprint: null,
    encrypted_ca_bundle: null,
    auto_apply_on_webhook: false,
    auto_deploy_on_apply: false,
    last_applied_commit_sha: null,
    last_applied_content_hash: null,
    pending_commit_sha: null,
    pending_compose_content: null,
    pending_env_content: null,
    pending_fetched_at: null,
    last_debounce_at: null,
  });
}

beforeEach(async () => {
  tmpDir = await setupTestDb();
  const db = DatabaseService.getInstance();
  for (const s of db.getGitSources()) db.deleteGitSource(s.stack_name);
});

afterAll(() => {
  if (tmpDir) cleanupTestDb(tmpDir);
});

describe('registryDeliverySelection', () => {
  it('resolves the exact multi-file compose selection from prepared git-candidate meta', async () => {
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const stackName = 'sel-git';
    const stackDir = path.join(NodeRegistry.getInstance().getComposeDir(nodeId), stackName);
    fs.mkdirSync(stackDir, { recursive: true });

    const payloadDir = path.join(tmpDir, 'payload-git');
    fs.mkdirSync(payloadDir, { recursive: true });
    fs.writeFileSync(path.join(payloadDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n');
    fs.writeFileSync(path.join(payloadDir, 'compose.prod.yaml'), 'services:\n  web:\n    image: nginx:prod\n');

    const commitSha = 'c'.repeat(40);
    const meta = {
      version: 1 as const,
      commitSha,
      resolvedRefKind: 'branch' as const,
      candidateRelPath: candidateRelPathForSha(commitSha),
      composeFiles: [
        { path: 'compose.yaml', content: 'services:\n  web:\n    image: nginx\n' },
        { path: 'compose.prod.yaml', content: 'services:\n  web:\n    image: nginx:prod\n' },
      ],
      envContent: null,
      contextDir: 'deploy',
      syncEnv: false,
      materialization: materialization(commitSha),
      warnings: [] as string[],
    };
    await writeGitCandidatePreparedMeta(payloadDir, meta);

    const selection = await resolveRegistryDeliverySelection({
      kind: 'git-candidate',
      stackName,
      nodeId,
      rootDir: payloadDir,
    });

    expect(selection.composeFiles).toEqual(['compose.yaml', 'compose.prod.yaml']);
    expect(selection.envFiles).toEqual([]);

    // Equivalence against the authored candidate builder: the shared resolver
    // rebuilds exactly the argv the candidate invocation would emit.
    const invocation = buildCandidateComposeInvocation({
      stackName,
      composePaths: meta.composeFiles.map(f => f.path),
      contextDir: 'deploy',
      stackDir,
      syncEnv: false,
      envContentPresent: meta.envContent !== null,
    });
    expect(selection.composeFiles).toEqual(extractFlagArgs(invocation, '-f'));
    expect(selection.envFiles).toEqual(extractFlagArgs(invocation, '--env-file'));
  });

  it('resolves candidate env files from prepared git-candidate meta', async () => {
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const stackName = 'sel-git-env';
    const stackDir = path.join(NodeRegistry.getInstance().getComposeDir(nodeId), stackName);
    fs.mkdirSync(stackDir, { recursive: true });

    const payloadDir = path.join(tmpDir, 'payload-git-env');
    fs.mkdirSync(payloadDir, { recursive: true });
    fs.writeFileSync(path.join(payloadDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n');

    const commitSha = 'd'.repeat(40);
    const meta = {
      version: 1 as const,
      commitSha,
      resolvedRefKind: 'branch' as const,
      candidateRelPath: candidateRelPathForSha(commitSha),
      composeFiles: [{ path: 'compose.yaml', content: 'services:\n  web:\n    image: nginx\n' }],
      envContent: 'TAG=1\n',
      contextDir: 'app',
      syncEnv: true,
      materialization: materialization(commitSha),
      warnings: [] as string[],
    };
    await writeGitCandidatePreparedMeta(payloadDir, meta);

    const selection = await resolveRegistryDeliverySelection({
      kind: 'git-candidate',
      stackName,
      nodeId,
      rootDir: payloadDir,
    });

    expect(selection.envFiles.map(f => path.basename(f))).toEqual(['.env']);
  });

  it('service-scoped multi-file discovery uses the resolved compose file list', async () => {
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const stackName = 'sel-git-scoped';
    const stackDir = path.join(NodeRegistry.getInstance().getComposeDir(nodeId), stackName);
    fs.mkdirSync(stackDir, { recursive: true });

    const payloadDir = path.join(tmpDir, 'payload-git-scoped');
    fs.mkdirSync(payloadDir, { recursive: true });
    fs.writeFileSync(
      path.join(payloadDir, 'compose.yaml'),
      'services:\n  web:\n    image: ghcr.io/example/web:1\n  worker:\n    image: ghcr.io/example/worker:1\n',
    );
    fs.writeFileSync(
      path.join(payloadDir, 'compose.prod.yaml'),
      'services:\n  web:\n    image: ghcr.io/example/web:2\n',
    );

    const commitSha = 'e'.repeat(40);
    await writeGitCandidatePreparedMeta(payloadDir, {
      version: 1,
      commitSha,
      resolvedRefKind: 'branch',
      candidateRelPath: candidateRelPathForSha(commitSha),
      composeFiles: [
        { path: 'compose.yaml', content: 'x' },
        { path: 'compose.prod.yaml', content: 'x' },
      ],
      envContent: null,
      contextDir: null,
      syncEnv: false,
      materialization: materialization(commitSha),
      warnings: [],
    });

    const selection = await resolveRegistryDeliverySelection({
      kind: 'git-candidate',
      stackName,
      nodeId,
      rootDir: payloadDir,
    });

    expect(selection.composeFiles).toEqual(['compose.yaml', 'compose.prod.yaml']);

    const discovery = discoverRegistryReferences(
      payloadDir,
      selection.envVars,
      'web',
      selection.composeFiles,
    );

    const refs = discovery.referencedPullRefs;
    expect(refs.some(r => r.includes('web:1'))).toBe(true);
    expect(refs.some(r => r.includes('web:2'))).toBe(true);
    expect(refs.some(r => r.includes('worker'))).toBe(false);
  });

  it('resolves configured project env files into the live-project env selection', async () => {
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const stackName = 'sel-env';
    const stackDir = path.join(NodeRegistry.getInstance().getComposeDir(nodeId), stackName);
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n');
    fs.writeFileSync(path.join(stackDir, 'prod.env'), 'TAG=1\n');
    DatabaseService.getInstance().setStackProjectEnvFiles(nodeId, stackName, ['prod.env']);

    const selection = await resolveRegistryDeliverySelection({
      kind: 'live-project',
      stackName,
      nodeId,
      rootDir: stackDir,
    });

    expect(selection.envFiles.map(f => path.basename(f))).toEqual(['prod.env']);
    // The configured env file participates in the source hash, not just the scan.
    expect(hashSelectionInputs(stackDir, selection.composeFiles, selection.envFiles))
      .not.toBe(hashProjectSource(stackDir));
  });

  it('is digest-equivalent to hashProjectSource for a default single-root live project', async () => {
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const stackName = 'sel-single';
    const stackDir = path.join(NodeRegistry.getInstance().getComposeDir(nodeId), stackName);
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n');
    fs.writeFileSync(path.join(stackDir, '.env'), 'TAG=base\n');

    const selection = await resolveRegistryDeliverySelection({
      kind: 'live-project',
      stackName,
      nodeId,
      rootDir: stackDir,
    });

    expect(selection.composeFiles).toBeUndefined();
    expect(selection.envFiles).toEqual([]);
    expect(hashSelectionInputs(stackDir, selection.composeFiles, selection.envFiles))
      .toBe(hashProjectSource(stackDir));
  });

  it('matches the authored argv builders for a multi-file configured-env live stack', async () => {
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const stackName = 'sel-equiv';
    const stackDir = path.join(NodeRegistry.getInstance().getComposeDir(nodeId), stackName);
    fs.mkdirSync(stackDir, { recursive: true });
    fs.mkdirSync(path.join(stackDir, 'infra'), { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n');
    fs.writeFileSync(path.join(stackDir, 'infra/prod.yml'), 'services:\n  web:\n    image: nginx:prod\n');
    fs.writeFileSync(path.join(stackDir, 'prod.env'), 'TAG=1\n');

    seedSource(stackName, ['compose.yaml', 'infra/prod.yml']);
    DatabaseService.getInstance().setGitSourceAppliedSpec(stackName, {
      files: ['compose.yaml', 'infra/prod.yml'],
      contextDir: 'app',
    });
    DatabaseService.getInstance().setStackProjectEnvFiles(nodeId, stackName, ['prod.env']);

    const selection = await resolveRegistryDeliverySelection({
      kind: 'live-project',
      stackName,
      nodeId,
      rootDir: stackDir,
    });

    const fileArgs = authoredComposeFileArgs(stackName, nodeId);
    const envArgs = await authoredComposeEnvFileArgs(stackName, nodeId);
    expect(selection.composeFiles).toEqual(extractFlagArgs(fileArgs, '-f'));
    expect(selection.envFiles).toEqual(extractFlagArgs(envArgs, '--env-file'));
  });

  it('restore-candidate recovery discovers the primary compose.yaml for a git multi-file stack', async () => {
    // The git inventory stores explicitComposeFiles in the local materialized
    // layout (index 0 primary maps to compose.yaml at the stack root), matching
    // what copyPresentFilesToDir writes into the restore staging dir. A
    // repo-relative list here would resolve nothing in staging and silently
    // drop the primary compose file from the attested reference set.
    const repoPaths = ['deploy/docker-compose.yml', 'deploy/docker-compose.override.yml'];
    const localFiles = gitSourceLocalComposeFiles(repoPaths);
    expect(localFiles).toEqual(['compose.yaml', 'deploy/docker-compose.override.yml']);

    const invocation: RollbackInvocationRecord = {
      composeArgsPrefix: [
        '-f', 'compose.yaml',
        '-f', 'deploy/docker-compose.override.yml',
        '-p', 'sel-restore',
      ],
      projectDirectory: null,
      projectName: 'sel-restore',
      explicitComposeFiles: localFiles,
    };

    const basis = invocationBasisFromRecord(invocation);
    expect(basis.composeFiles).toEqual(localFiles);

    const stagingDir = path.join(tmpDir, 'payload-restore');
    fs.mkdirSync(path.join(stagingDir, 'deploy'), { recursive: true });
    fs.writeFileSync(
      path.join(stagingDir, 'compose.yaml'),
      'services:\n  web:\n    image: ghcr.io/example/web:1\n',
    );
    fs.writeFileSync(
      path.join(stagingDir, 'deploy/docker-compose.override.yml'),
      'services:\n  web:\n    image: ghcr.io/example/web:2\n',
    );

    const discovery = discoverRegistryReferences(stagingDir, {}, undefined, basis.composeFiles);
    const refs = discovery.referencedPullRefs;
    expect(refs.some(r => r.includes('web:1'))).toBe(true);
    expect(refs.some(r => r.includes('web:2'))).toBe(true);
  });
});
