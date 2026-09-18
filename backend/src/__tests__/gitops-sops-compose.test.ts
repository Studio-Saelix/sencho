import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { directApplicationFixture } from './helpers/gitopsFixtures';
import { GitOpsStore } from '../services/gitops/store';
import { DatabaseService } from '../services/DatabaseService';
import { ComposeService } from '../services/ComposeService';
import { NodeRegistry } from '../services/NodeRegistry';
import { SOPS_DIRECT_MUTATION_MESSAGE } from '../services/gitops/sops/prepareOverlay';
import type { GitOpsGenerationRow } from '../services/gitops/types';
import type { RollbackInvocationRecord } from '../types/rollbackGeneration';

let tmpDir: string;

function sopsGeneration(appId: string, genId: string): GitOpsGenerationRow {
  return {
    id: genId,
    application_id: appId,
    commit_sha: 'abc1234567890abcdef1234567890abcdef12345678',
    repo_url: 'https://github.com/example/repo.git',
    configured_ref: 'main',
    resolved_ref_kind: 'branch',
    repo_identity_json: '{"host":"github.com","pathname":"/example/repo.git"}',
    manifest_version: 1,
    candidate_dir: 'generations/candidate',
    applied_dir: 'generations/applied',
    expected_invocation_json: '{"composeFileOrder":["compose.yaml"],"projectName":null,"projectDirectory":null,"envFileOrder":[]}',
    materialization_fingerprint: 'c'.repeat(64),
    validation_ok: 1,
    plan_blocked: 0,
    change_plan_fingerprint: null,
    operation_id: `op-${genId}`,
    trigger: 'manual',
    actor: 'tester',
    previous_generation_id: null,
    redacted_limitations_json: '[]',
    portable_manifest_json: null,
    compose_inputs_json: null,
    source_policy_evidence_json: null,
    security_policy_evidence_json: null,
    support_requirements_json: null,
    compatibility_requirements_json: '{}',
    secret_capability_json: JSON.stringify({
      policy: 'allow_plaintext',
      inputs: [{
        role: 'env',
        encryption: 'sops-age',
        recipientIds: ['age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'],
        sourcePath: '.env',
        materializedPath: '.env',
      }],
      ready: false,
      requiredRecipients: ['age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'],
    }),
    created_at: Date.now(),
  };
}

function seedSopsStack(stackName: string, genId: string): void {
  const app = directApplicationFixture(`app-${stackName}`, stackName);
  GitOpsStore.getInstance().insertApplication(app);
  GitOpsStore.getInstance().insertGeneration(sopsGeneration(app.id, genId));
  DatabaseService.getInstance().getDb()
    .prepare('UPDATE gitops_applications SET accepted_generation_id = ? WHERE id = ?')
    .run(genId, app.id);
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

describe('ComposeService SOPS overlay args and mutation guards', () => {
  it('remaps captured absolute --env-file and --project-directory onto the overlay', async () => {
    const stackName = 'sops-captured-args';
    const compose = ComposeService.getInstance();
    const stackDir = path.join(process.env.COMPOSE_DIR!, stackName);
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  x:\n    image: nginx\n');
    const envAbs = path.join(stackDir, '.env');
    fs.writeFileSync(envAbs, 'KEY=ENC[AES256_GCM,data:abc,iv:abc,tag:abc,type:str]\n');
    const overlayDir = path.join(tmpDir, 'overlay-captured');
    fs.mkdirSync(overlayDir, { recursive: true });
    fs.writeFileSync(path.join(overlayDir, '.env'), 'KEY=decrypted\n');

    const invocation: RollbackInvocationRecord = {
      composeArgsPrefix: [
        '--env-file', envAbs,
        '--project-directory', stackDir,
        '-f', 'compose.yaml',
      ],
      projectDirectory: stackDir,
      projectName: stackName,
      explicitComposeFiles: ['compose.yaml'],
    };

    const args = await compose.buildComposeArgsWithRecoveryOverride(
      stackName,
      ['up', '-d'],
      null,
      invocation,
      overlayDir,
    );
    const envIdx = args.indexOf('--env-file');
    expect(envIdx).toBeGreaterThan(-1);
    expect(args[envIdx + 1]).toBe(path.resolve(overlayDir, '.env'));
    expect(args[envIdx + 1]).not.toBe(envAbs);
    const projIdx = args.indexOf('--project-directory');
    expect(projIdx).toBeGreaterThan(-1);
    expect(args[projIdx + 1]).toBe(path.resolve(overlayDir));
  });

  it('refuses a manual deploy of a SOPS-managed stack without an overlay', async () => {
    const stackName = 'sops-refuse-deploy';
    seedSopsStack(stackName, 'gen-sops-refuse-deploy');
    const compose = ComposeService.getInstance(NodeRegistry.getInstance().getDefaultNodeId());
    await expect(compose.deployStack(stackName)).rejects.toThrow(SOPS_DIRECT_MUTATION_MESSAGE);
  });

  it('refuses an image update of a SOPS-managed stack', async () => {
    const stackName = 'sops-refuse-update';
    seedSopsStack(stackName, 'gen-sops-refuse-update');
    const compose = ComposeService.getInstance(NodeRegistry.getInstance().getDefaultNodeId());
    await expect(compose.updateStack(stackName)).rejects.toThrow(SOPS_DIRECT_MUTATION_MESSAGE);
  });
});
