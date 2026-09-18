import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { directApplicationFixture } from './helpers/gitopsFixtures';
import { GitOpsStore } from '../services/gitops/store';
import { DatabaseService } from '../services/DatabaseService';

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await setupTestDb();
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

describe('prepareRecoveryComposeOverlay', () => {
  it('fails closed with missing_key when required recipients are absent', async () => {
    const stackName = 'sops-recovery-stack';
    const app = directApplicationFixture('app-sops-recovery', stackName);
    GitOpsStore.getInstance().insertApplication(app);
    DatabaseService.getInstance().upsertGitSource({
      stack_name: stackName,
      repo_url: 'https://github.com/example/repo.git',
      branch: 'main',
      compose_path: 'compose.yaml',
      compose_paths: ['compose.yaml'],
      context_dir: null,
      sync_env: false,
      env_path: null,
      auth_type: 'none',
      encrypted_token: null,
      encrypted_deploy_key: null,
      ssh_known_hosts_entry: null,
      ssh_host_key_fingerprint: null,
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

    const genId = 'gen-sops-recovery';
    const missingRecipient = 'age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
    GitOpsStore.getInstance().insertGeneration({
      id: genId,
      application_id: app.id,
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
      operation_id: 'op-recovery',
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
        inputs: [{ role: 'env', encryption: 'sops-age', recipientIds: [missingRecipient], sourcePath: '.env' }],
        ready: false,
        failureClass: 'missing_key',
        requiredRecipients: [missingRecipient],
      }),
      created_at: Date.now(),
    });

    const { prepareRecoveryComposeOverlay } = await import('../services/gitops/sops/prepareOverlay');
    const result = await prepareRecoveryComposeOverlay({
      stackName,
      nodeId: 1,
      gitopsGenerationId: genId,
    });
    expect(result).toEqual(expect.objectContaining({
      failureClass: 'missing_key',
      error: expect.stringContaining(missingRecipient),
    }));
    expect(JSON.stringify(result)).not.toMatch(/AGE-SECRET-KEY/);
  });

  it('fails closed when the generation lacks encrypted file paths', async () => {
    const stackName = 'sops-recovery-nopath';
    const app = directApplicationFixture('app-sops-nopath', stackName);
    GitOpsStore.getInstance().insertApplication(app);
    const age = await import('age-encryption');
    const identity = await age.generateIdentity();
    const recipient = await age.identityToRecipient(identity);
    const { SopsIdentityStore } = await import('../services/gitops/sops/identityStore');
    await SopsIdentityStore.getInstance().importIdentity({
      applicationId: app.id,
      stackName,
      identity,
    });
    const genId = 'gen-sops-nopath';
    GitOpsStore.getInstance().insertGeneration({
      id: genId,
      application_id: app.id,
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
      operation_id: 'op-nopath',
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
        inputs: [{ role: 'env', encryption: 'sops-age', recipientIds: [recipient], sourcePath: '.env' }],
        ready: true,
        requiredRecipients: [recipient],
      }),
      created_at: Date.now(),
    });

    const { prepareRecoveryComposeOverlay } = await import('../services/gitops/sops/prepareOverlay');
    const result = await prepareRecoveryComposeOverlay({
      stackName,
      nodeId: 1,
      gitopsGenerationId: genId,
    });
    expect(result).toEqual(expect.objectContaining({
      failureClass: 'capability_mismatch',
    }));
  });

  it('decrypts the rollback generation path, not a later live filename', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const stackName = 'sops-recovery-genpath';
    const app = directApplicationFixture('app-sops-genpath', stackName);
    GitOpsStore.getInstance().insertApplication(app);
    const age = await import('age-encryption');
    const identity = await age.generateIdentity();
    const recipient = await age.identityToRecipient(identity);
    const { SopsIdentityStore } = await import('../services/gitops/sops/identityStore');
    await SopsIdentityStore.getInstance().importIdentity({
      applicationId: app.id,
      stackName,
      identity,
    });
    const { buildSopsAgeDocument } = await import('./helpers/sopsFixtures');
    const sopsDoc = await buildSopsAgeDocument({
      values: { DB_PASSWORD: 'from-generation-a' },
      identity,
      recipient,
    });
    const stackDir = path.join(process.env.COMPOSE_DIR || '', stackName);
    fs.mkdirSync(path.join(stackDir, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'secrets', 'db.env'), sopsDoc);
    fs.writeFileSync(path.join(stackDir, 'secrets', 'db2.env'), 'not-sops\n');

    const genId = 'gen-sops-genpath';
    GitOpsStore.getInstance().insertGeneration({
      id: genId,
      application_id: app.id,
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
      operation_id: 'op-genpath',
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
          recipientIds: [recipient],
          sourcePath: 'secrets/db.env',
          materializedPath: 'secrets/db.env',
        }],
        ready: true,
        requiredRecipients: [recipient],
      }),
      created_at: Date.now(),
    });

    const { prepareRecoveryComposeOverlay, destroyGitOpsOverlay } = await import('../services/gitops/sops/prepareOverlay');
    const result = await prepareRecoveryComposeOverlay({
      stackName,
      nodeId: 1,
      gitopsGenerationId: genId,
    });
    expect(result).not.toBeNull();
    expect(result && 'overlayDir' in result).toBe(true);
    if (!result || !('overlayDir' in result)) return;
    const overlayPlain = fs.readFileSync(path.join(result.overlayDir, 'secrets', 'db.env'), 'utf8');
    expect(overlayPlain).toContain('from-generation-a');
    expect(fs.readFileSync(path.join(stackDir, 'secrets', 'db.env'), 'utf8')).toBe(sopsDoc);
    await destroyGitOpsOverlay(result.binding);
  });

  it('rolls back with the generation recipient after a later identity rotation', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const stackName = 'sops-recovery-rotate';
    const app = directApplicationFixture('app-sops-rotate', stackName);
    GitOpsStore.getInstance().insertApplication(app);
    const age = await import('age-encryption');
    const oldIdentity = await age.generateIdentity();
    const oldRecipient = await age.identityToRecipient(oldIdentity);
    const newIdentity = await age.generateIdentity();
    const { SopsIdentityStore } = await import('../services/gitops/sops/identityStore');
    await SopsIdentityStore.getInstance().importIdentity({
      applicationId: app.id,
      stackName,
      identity: oldIdentity,
    });
    await SopsIdentityStore.getInstance().importIdentity({
      applicationId: app.id,
      stackName,
      identity: newIdentity,
    });
    const { buildSopsAgeDocument } = await import('./helpers/sopsFixtures');
    const sopsDoc = await buildSopsAgeDocument({
      values: { DB_PASSWORD: 'pre-rotation' },
      identity: oldIdentity,
      recipient: oldRecipient,
    });
    const stackDir = path.join(process.env.COMPOSE_DIR || '', stackName);
    fs.mkdirSync(path.join(stackDir, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'secrets', 'db.env'), sopsDoc);

    const genId = 'gen-sops-rotate';
    GitOpsStore.getInstance().insertGeneration({
      id: genId,
      application_id: app.id,
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
      operation_id: 'op-rotate',
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
          recipientIds: [oldRecipient],
          sourcePath: 'secrets/db.env',
          materializedPath: 'secrets/db.env',
        }],
        ready: true,
        requiredRecipients: [oldRecipient],
      }),
      created_at: Date.now(),
    });

    const { prepareRecoveryComposeOverlay, destroyGitOpsOverlay } = await import('../services/gitops/sops/prepareOverlay');
    const result = await prepareRecoveryComposeOverlay({
      stackName,
      nodeId: 1,
      gitopsGenerationId: genId,
    });
    expect(result && 'overlayDir' in result).toBe(true);
    if (!result || !('overlayDir' in result)) return;
    expect(fs.readFileSync(path.join(result.overlayDir, 'secrets', 'db.env'), 'utf8')).toContain('pre-rotation');
    await destroyGitOpsOverlay(result.binding);
  });
});
