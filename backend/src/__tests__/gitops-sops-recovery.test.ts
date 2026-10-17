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

/**
 * A generation row, with the capability under test recorded on it. A capability
 * that names no recipient is the legacy shape: the generation was stored before
 * the synced sibling `.env` was classified, so its inputs say nothing about it.
 */
function insertGenerationWithCapability(args: {
  appId: string;
  genId: string;
  capability: Record<string, unknown>;
}): void {
  GitOpsStore.getInstance().insertGeneration({
    id: args.genId,
    application_id: args.appId,
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
    operation_id: `op-${args.genId}`,
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
    secret_capability_json: JSON.stringify(args.capability),
    created_at: Date.now(),
  });
}

/**
 * The state a rollback finds on disk: a live application, its restored files,
 * the identities this node holds, and the generation that was stored for them.
 */
async function seedRecoveryGeneration(args: {
  stackName: string;
  appId: string;
  capability: Record<string, unknown>;
  files: Record<string, string>;
  identities?: string[];
}): Promise<{ stackDir: string; genId: string }> {
  const fs = await import('fs');
  const path = await import('path');
  const app = directApplicationFixture(args.appId, args.stackName);
  GitOpsStore.getInstance().insertApplication(app);
  const { SopsIdentityStore } = await import('../services/gitops/sops/identityStore');
  for (const identity of args.identities ?? []) {
    await SopsIdentityStore.getInstance().importIdentity({
      applicationId: app.id,
      stackName: args.stackName,
      identity,
    });
  }
  const stackDir = path.join(process.env.COMPOSE_DIR || '', args.stackName);
  for (const [rel, content] of Object.entries(args.files)) {
    fs.mkdirSync(path.dirname(path.join(stackDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(stackDir, rel), content, { mode: 0o600 });
  }
  const genId = `gen-${args.stackName}`;
  insertGenerationWithCapability({ appId: app.id, genId, capability: args.capability });
  return { stackDir, genId };
}

const ZERO_RECIPIENT_CAPABILITY = {
  policy: 'allow_plaintext',
  inputs: [{ role: 'env', encryption: 'none', recipientIds: [], sourcePath: '.env', materializedPath: '.env' }],
  ready: true,
  requiredRecipients: [],
};

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

  it('decrypts a restored synced .env whose generation recorded no recipients', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const stackName = 'sops-recovery-legacy-env';
    const app = directApplicationFixture('app-sops-legacy-env', stackName);
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
    const { buildSopsAgeDotenvDocument } = await import('./helpers/sopsFixtures');
    const ciphertext = await buildSopsAgeDotenvDocument({
      values: { TOKEN: 'from-the-restored-generation' },
      identity,
      recipient,
    });
    const stackDir = path.join(process.env.COMPOSE_DIR || '', stackName);
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, '.env'), ciphertext, { mode: 0o600 });

    const genId = 'gen-sops-legacy-env';
    insertGenerationWithCapability({ appId: app.id, genId, capability: ZERO_RECIPIENT_CAPABILITY });

    const { prepareRecoveryComposeOverlay, destroyGitOpsOverlay } = await import('../services/gitops/sops/prepareOverlay');
    const result = await prepareRecoveryComposeOverlay({ stackName, nodeId: 1, gitopsGenerationId: genId });
    expect(result && 'overlayDir' in result).toBe(true);
    if (!result || !('overlayDir' in result)) return;
    expect(fs.readFileSync(path.join(result.overlayDir, '.env'), 'utf8')).toContain('from-the-restored-generation');
    expect(fs.readFileSync(path.join(stackDir, '.env'), 'utf8')).toBe(ciphertext);
    await destroyGitOpsOverlay(result.binding);
    expect(fs.existsSync(result.overlayDir)).toBe(false);
    expect(fs.existsSync(path.join(stackDir, '.env'))).toBe(true);
  });

  it('refuses a restored synced .env that no identity on this node can decrypt', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const stackName = 'sops-recovery-legacy-missing';
    const app = directApplicationFixture('app-sops-legacy-missing', stackName);
    GitOpsStore.getInstance().insertApplication(app);
    const age = await import('age-encryption');
    const identity = await age.generateIdentity();
    const recipient = await age.identityToRecipient(identity);
    const { buildSopsAgeDotenvDocument } = await import('./helpers/sopsFixtures');
    const ciphertext = await buildSopsAgeDotenvDocument({
      values: { TOKEN: 'unreachable' },
      identity,
      recipient,
    });
    const stackDir = path.join(process.env.COMPOSE_DIR || '', stackName);
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, '.env'), ciphertext, { mode: 0o600 });

    const genId = 'gen-sops-legacy-missing';
    insertGenerationWithCapability({ appId: app.id, genId, capability: ZERO_RECIPIENT_CAPABILITY });

    const { prepareRecoveryComposeOverlay } = await import('../services/gitops/sops/prepareOverlay');
    const result = await prepareRecoveryComposeOverlay({ stackName, nodeId: 1, gitopsGenerationId: genId });
    expect(result).toEqual(expect.objectContaining({
      failureClass: 'missing_key',
      error: expect.stringContaining(recipient),
    }));
    expect(fs.readFileSync(path.join(stackDir, '.env'), 'utf8')).toBe(ciphertext);
  });

  it('leaves a plaintext restored env on the plain path', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const stackName = 'sops-recovery-legacy-plain';
    const app = directApplicationFixture('app-sops-legacy-plain', stackName);
    GitOpsStore.getInstance().insertApplication(app);
    const stackDir = path.join(process.env.COMPOSE_DIR || '', stackName);
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, '.env'), 'TOKEN=plain\n', { mode: 0o600 });

    const genId = 'gen-sops-legacy-plain';
    insertGenerationWithCapability({ appId: app.id, genId, capability: ZERO_RECIPIENT_CAPABILITY });

    const { prepareRecoveryComposeOverlay } = await import('../services/gitops/sops/prepareOverlay');
    const result = await prepareRecoveryComposeOverlay({ stackName, nodeId: 1, gitopsGenerationId: genId });
    expect(result).toBeNull();
  });

  it('decrypts a recorded secret under its own role and the synced env as Compose reads it', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const stackName = 'sops-recovery-legacy-role';
    const app = directApplicationFixture('app-sops-legacy-role', stackName);
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
    const { buildSopsAgeDotenvDocument } = await import('./helpers/sopsFixtures');
    const stackDir = path.join(process.env.COMPOSE_DIR || '', stackName);
    fs.mkdirSync(path.join(stackDir, 'secrets'), { recursive: true });
    const ciphertext = await buildSopsAgeDotenvDocument({
      values: { TOKEN: 'dollar$value' },
      identity,
      recipient,
    });
    fs.writeFileSync(path.join(stackDir, '.env'), ciphertext, { mode: 0o600 });
    fs.writeFileSync(path.join(stackDir, 'secrets', 'app.env'), ciphertext, { mode: 0o600 });

    const genId = 'gen-sops-legacy-role';
    insertGenerationWithCapability({
      appId: app.id,
      genId,
      capability: {
        policy: 'allow_plaintext',
        inputs: [
          { role: 'env', encryption: 'none', recipientIds: [], sourcePath: '.env', materializedPath: '.env' },
          {
            role: 'secret',
            encryption: 'none',
            recipientIds: [],
            sourcePath: 'secrets/app.env',
            materializedPath: 'secrets/app.env',
          },
        ],
        ready: true,
        requiredRecipients: [],
      },
    });

    const { prepareRecoveryComposeOverlay, destroyGitOpsOverlay } = await import('../services/gitops/sops/prepareOverlay');
    const result = await prepareRecoveryComposeOverlay({ stackName, nodeId: 1, gitopsGenerationId: genId });
    expect(result && 'overlayDir' in result).toBe(true);
    if (!result || !('overlayDir' in result)) return;
    // The project env file is read by Compose, so a value it would interpolate
    // is escaped for it. A file an application reads verbatim keeps the
    // plaintext byte for byte, which is the role the generation recorded.
    expect(fs.readFileSync(path.join(result.overlayDir, '.env'), 'utf8')).toContain('dollar$$value');
    expect(fs.readFileSync(path.join(result.overlayDir, 'secrets', 'app.env'), 'utf8')).toContain('dollar$value');
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

  it('decrypts a synced .env the generation never classified beside a recorded encrypted env file', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const { buildSopsAgeDotenvDocument } = await import('./helpers/sopsFixtures');
    const age = await import('age-encryption');
    const identity = await age.generateIdentity();
    const recipient = await age.identityToRecipient(identity);
    const stackName = 'sops-recovery-mixed-same';
    const { stackDir, genId } = await seedRecoveryGeneration({
      stackName,
      appId: 'app-sops-mixed-same',
      identities: [identity],
      files: {
        'extra.env': await buildSopsAgeDotenvDocument({ values: { EXTRA: 'from-extra' }, identity, recipient }),
        '.env': await buildSopsAgeDotenvDocument({ values: { TOKEN: 'from-root-env' }, identity, recipient }),
      },
      capability: {
        policy: 'allow_plaintext',
        inputs: [{
          role: 'env',
          encryption: 'sops-age',
          recipientIds: [recipient],
          sourcePath: 'extra.env',
          materializedPath: 'extra.env',
        }],
        ready: true,
        requiredRecipients: [recipient],
      },
    });

    const { prepareRecoveryComposeOverlay, destroyGitOpsOverlay } = await import('../services/gitops/sops/prepareOverlay');
    const result = await prepareRecoveryComposeOverlay({ stackName, nodeId: 1, gitopsGenerationId: genId });
    expect(result && 'overlayDir' in result).toBe(true);
    if (!result || !('overlayDir' in result)) return;
    expect(fs.readFileSync(path.join(result.overlayDir, 'extra.env'), 'utf8')).toContain('from-extra');
    expect(fs.readFileSync(path.join(result.overlayDir, '.env'), 'utf8')).toContain('from-root-env');
    expect(fs.readFileSync(path.join(stackDir, '.env'), 'utf8')).not.toContain('from-root-env');
    await destroyGitOpsOverlay(result.binding);
  });

  it('decrypts both restored env inputs when each was encrypted for a different held identity', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const { buildSopsAgeDotenvDocument } = await import('./helpers/sopsFixtures');
    const age = await import('age-encryption');
    const firstIdentity = await age.generateIdentity();
    const firstRecipient = await age.identityToRecipient(firstIdentity);
    const secondIdentity = await age.generateIdentity();
    const secondRecipient = await age.identityToRecipient(secondIdentity);
    const stackName = 'sops-recovery-mixed-distinct';
    const { genId } = await seedRecoveryGeneration({
      stackName,
      appId: 'app-sops-mixed-distinct',
      identities: [firstIdentity, secondIdentity],
      files: {
        'extra.env': await buildSopsAgeDotenvDocument({
          values: { EXTRA: 'from-extra' }, identity: firstIdentity, recipient: firstRecipient,
        }),
        '.env': await buildSopsAgeDotenvDocument({
          values: { TOKEN: 'from-root-env' }, identity: secondIdentity, recipient: secondRecipient,
        }),
      },
      capability: {
        policy: 'allow_plaintext',
        inputs: [{
          role: 'env',
          encryption: 'sops-age',
          recipientIds: [firstRecipient],
          sourcePath: 'extra.env',
          materializedPath: 'extra.env',
        }],
        ready: true,
        requiredRecipients: [firstRecipient],
      },
    });

    const { prepareRecoveryComposeOverlay, destroyGitOpsOverlay } = await import('../services/gitops/sops/prepareOverlay');
    const result = await prepareRecoveryComposeOverlay({ stackName, nodeId: 1, gitopsGenerationId: genId });
    expect(result && 'overlayDir' in result).toBe(true);
    if (!result || !('overlayDir' in result)) return;
    expect(fs.readFileSync(path.join(result.overlayDir, 'extra.env'), 'utf8')).toContain('from-extra');
    expect(fs.readFileSync(path.join(result.overlayDir, '.env'), 'utf8')).toContain('from-root-env');
    await destroyGitOpsOverlay(result.binding);
  });

  it('refuses a mixed legacy recovery when the sibling .env has no identity on this node', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const { buildSopsAgeDotenvDocument } = await import('./helpers/sopsFixtures');
    const age = await import('age-encryption');
    const identity = await age.generateIdentity();
    const recipient = await age.identityToRecipient(identity);
    const otherIdentity = await age.generateIdentity();
    const otherRecipient = await age.identityToRecipient(otherIdentity);
    const stackName = 'sops-recovery-mixed-missing';
    const { stackDir, genId } = await seedRecoveryGeneration({
      stackName,
      appId: 'app-sops-mixed-missing',
      identities: [identity],
      files: {
        'extra.env': await buildSopsAgeDotenvDocument({ values: { EXTRA: 'from-extra' }, identity, recipient }),
        '.env': await buildSopsAgeDotenvDocument({
          values: { TOKEN: 'unreachable' }, identity: otherIdentity, recipient: otherRecipient,
        }),
      },
      capability: {
        policy: 'allow_plaintext',
        inputs: [{
          role: 'env',
          encryption: 'sops-age',
          recipientIds: [recipient],
          sourcePath: 'extra.env',
          materializedPath: 'extra.env',
        }],
        ready: true,
        requiredRecipients: [recipient],
      },
    });

    const { prepareRecoveryComposeOverlay } = await import('../services/gitops/sops/prepareOverlay');
    const result = await prepareRecoveryComposeOverlay({ stackName, nodeId: 1, gitopsGenerationId: genId });
    expect(result).toEqual(expect.objectContaining({
      failureClass: 'missing_key',
      error: expect.stringContaining(otherRecipient),
    }));
    expect(fs.existsSync(path.join(stackDir, '.env'))).toBe(true);
  });

  it('rolls back a restored file this node can open with one of its recipients', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const { buildSopsAgeDotenvDocument } = await import('./helpers/sopsFixtures');
    const age = await import('age-encryption');
    const identity = await age.generateIdentity();
    const recipient = await age.identityToRecipient(identity);
    const otherRecipient = await age.identityToRecipient(await age.generateIdentity());
    const stackName = 'sops-recovery-any-recipient';
    const { genId } = await seedRecoveryGeneration({
      stackName,
      appId: 'app-sops-any-recipient',
      identities: [identity],
      files: {
        '.env': await buildSopsAgeDotenvDocument({
          values: { TOKEN: 'legacy-multi-recipient' },
          identity,
          recipient,
          extraRecipients: [otherRecipient],
        }),
      },
      capability: ZERO_RECIPIENT_CAPABILITY,
    });

    const { prepareRecoveryComposeOverlay, destroyGitOpsOverlay } = await import('../services/gitops/sops/prepareOverlay');
    const result = await prepareRecoveryComposeOverlay({ stackName, nodeId: 1, gitopsGenerationId: genId });
    expect(result && 'overlayDir' in result).toBe(true);
    if (!result || !('overlayDir' in result)) return;
    expect(fs.readFileSync(path.join(result.overlayDir, '.env'), 'utf8')).toContain('legacy-multi-recipient');
    await destroyGitOpsOverlay(result.binding);
  });

  it('rolls back the same restored file from its other recipient', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const { buildSopsAgeDotenvDocument } = await import('./helpers/sopsFixtures');
    const age = await import('age-encryption');
    const firstIdentity = await age.generateIdentity();
    const firstRecipient = await age.identityToRecipient(firstIdentity);
    const secondIdentity = await age.generateIdentity();
    const secondRecipient = await age.identityToRecipient(secondIdentity);
    const stackName = 'sops-recovery-other-recipient';
    const { genId } = await seedRecoveryGeneration({
      stackName,
      appId: 'app-sops-other-recipient',
      identities: [secondIdentity],
      files: {
        '.env': await buildSopsAgeDotenvDocument({
          values: { TOKEN: 'legacy-multi-recipient' },
          identity: firstIdentity,
          recipient: firstRecipient,
          extraRecipients: [secondRecipient],
        }),
      },
      capability: ZERO_RECIPIENT_CAPABILITY,
    });

    const { prepareRecoveryComposeOverlay, destroyGitOpsOverlay } = await import('../services/gitops/sops/prepareOverlay');
    const result = await prepareRecoveryComposeOverlay({ stackName, nodeId: 1, gitopsGenerationId: genId });
    expect(result && 'overlayDir' in result).toBe(true);
    if (!result || !('overlayDir' in result)) return;
    expect(fs.readFileSync(path.join(result.overlayDir, '.env'), 'utf8')).toContain('legacy-multi-recipient');
    await destroyGitOpsOverlay(result.binding);
  });

  it('refuses a multi-recipient restored file when no identity here opens it', async () => {
    const { buildSopsAgeDotenvDocument } = await import('./helpers/sopsFixtures');
    const age = await import('age-encryption');
    const firstIdentity = await age.generateIdentity();
    const firstRecipient = await age.identityToRecipient(firstIdentity);
    const secondRecipient = await age.identityToRecipient(await age.generateIdentity());
    const stackName = 'sops-recovery-no-recipient';
    const { genId } = await seedRecoveryGeneration({
      stackName,
      appId: 'app-sops-no-recipient',
      files: {
        '.env': await buildSopsAgeDotenvDocument({
          values: { TOKEN: 'unreachable' },
          identity: firstIdentity,
          recipient: firstRecipient,
          extraRecipients: [secondRecipient],
        }),
      },
      capability: ZERO_RECIPIENT_CAPABILITY,
    });

    const { prepareRecoveryComposeOverlay } = await import('../services/gitops/sops/prepareOverlay');
    const result = await prepareRecoveryComposeOverlay({ stackName, nodeId: 1, gitopsGenerationId: genId });
    expect(result).toEqual(expect.objectContaining({
      failureClass: 'missing_key',
      error: expect.stringContaining(firstRecipient),
    }));
  });
});
