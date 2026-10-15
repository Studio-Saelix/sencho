import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import {
  buildSecretCapability,
  capabilityUnderstatesEncryption,
  lkgBlockedByMissingRecipients,
  missingRecipientsForCapability,
  syncEnvInputEntry,
} from '../services/gitops/sops/capability';
import type { SecretCapability } from '../services/gitops/sops/types';
import { manifestInputsNeedOverlay } from '../services/gitops/sops/prepareOverlay';
import { SopsIdentityStore } from '../services/gitops/sops/identityStore';
import type { ComposeInputEntry } from '../types/gitProjectManifest';
import { buildSopsAgeDotenvDocument } from './helpers/sopsFixtures';

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await setupTestDb();
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

function encryptedInput(recipients: string[]): ComposeInputEntry {
  return {
    sourcePath: '.env',
    materializedPath: '.env',
    role: 'env',
    dependencyKind: 'env_file',
    ownership: 'managed',
    provenance: 'fetch',
    sensitivity: 'high',
    contentSha256: null,
    sizeBytes: null,
    state: 'present',
    deletionAuthority: 'sencho',
    note: null,
    encryption: 'sops-age',
    sopsRecipients: recipients,
  };
}

function plaintextInput(overrides: Partial<ComposeInputEntry> = {}): ComposeInputEntry {
  return {
    ...encryptedInput([]),
    encryption: 'none',
    sopsRecipients: [],
    ...overrides,
  };
}

const UNAVAILABLE_RECIPIENT = 'age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';

describe('SOPS capability readiness', () => {
  it('is ready when one recipient of a multi-recipient file is available', async () => {
    const age = await import('age-encryption');
    const identity = await age.generateIdentity();
    const recipient = await age.identityToRecipient(identity);
    await SopsIdentityStore.getInstance().importIdentity({
      applicationId: 'app-multi',
      stackName: 'stack-multi',
      identity,
    });

    const result = buildSecretCapability({
      policy: 'allow_plaintext',
      inputs: [encryptedInput([recipient, UNAVAILABLE_RECIPIENT])],
      applicationId: 'app-multi',
      stackName: 'stack-multi',
    });
    expect(result.refusal).toBeUndefined();
    expect(result.capability.ready).toBe(true);
    expect(result.capability.requiredRecipients).toEqual([recipient, UNAVAILABLE_RECIPIENT]);
  });

  it('refuses a file whose recipients are all unavailable', () => {
    const result = buildSecretCapability({
      policy: 'allow_plaintext',
      inputs: [encryptedInput([UNAVAILABLE_RECIPIENT])],
      applicationId: 'app-missing',
      stackName: 'stack-missing',
    });
    expect(result.refusal?.failureClass).toBe('missing_key');
    expect(result.capability.ready).toBe(false);
  });

  it('does not require encryption for unmanaged inputs', () => {
    const result = buildSecretCapability({
      policy: 'require_encrypted',
      inputs: [plaintextInput({ ownership: 'unmanaged', materializedPath: null, sourcePath: null })],
      applicationId: 'app-policy',
      stackName: 'stack-policy',
    });
    expect(result.refusal).toBeUndefined();
    expect(result.capability.ready).toBe(true);
  });

  it('still requires encryption for managed plaintext secret inputs', () => {
    const result = buildSecretCapability({
      policy: 'require_encrypted',
      inputs: [plaintextInput()],
      applicationId: 'app-policy-managed',
      stackName: 'stack-policy-managed',
    });
    expect(result.refusal?.failureClass).toBe('invalid_ciphertext');
  });

  it('still refuses a managed plaintext input without a materialized path', () => {
    const result = buildSecretCapability({
      policy: 'require_encrypted',
      inputs: [plaintextInput({ materializedPath: null })],
      applicationId: 'app-policy-null-path',
      stackName: 'stack-policy-null-path',
    });
    expect(result.refusal?.failureClass).toBe('invalid_ciphertext');
  });

  it('requires encryption for a managed synced stack-root .env', () => {
    const result = buildSecretCapability({
      policy: 'require_encrypted',
      inputs: [plaintextInput({ materializedPath: '.env', sourcePath: null, dependencyKind: 'sync-env' })],
      applicationId: 'app-policy-sync',
      stackName: 'stack-policy-sync',
    });
    expect(result.refusal?.failureClass).toBe('invalid_ciphertext');
  });

  it('classifies a SOPS dotenv sibling .env as an age secret input', async () => {
    const age = await import('age-encryption');
    const identity = await age.generateIdentity();
    const recipient = await age.identityToRecipient(identity);
    const content = await buildSopsAgeDotenvDocument({
      values: { TOKEN: 's3cret' },
      identity,
      recipient,
    });
    const entry = syncEnvInputEntry(content);
    expect(entry.dependencyKind).toBe('sync-env');
    expect(entry.sensitivity).toBe('high');
    expect(entry.materializedPath).toBe('.env');
    expect(entry.encryption).toBe('sops-age');
    expect(entry.sopsRecipients).toEqual([recipient]);
    const result = buildSecretCapability({
      policy: 'allow_plaintext',
      inputs: [entry],
      applicationId: 'app-sync-sops',
      stackName: 'stack-sync-sops',
    });
    expect(result.capability.requiredRecipients).toEqual([recipient]);
    expect(manifestInputsNeedOverlay({ inputs: [entry] })).toBe(true);
  });

  it('treats a plaintext capability as understating an age-encrypted synced .env', () => {
    const computed: SecretCapability = {
      policy: 'allow_plaintext',
      inputs: [{
        role: 'env',
        encryption: 'sops-age',
        recipientIds: ['age1aaa'],
        sourcePath: null,
        materializedPath: '.env',
      }],
      ready: true,
      requiredRecipients: ['age1aaa'],
    };
    const stored: SecretCapability = {
      ...computed,
      inputs: [{ ...computed.inputs[0], encryption: 'none', recipientIds: [] }],
      requiredRecipients: [],
    };
    expect(capabilityUnderstatesEncryption(stored, computed)).toBe(true);
    expect(capabilityUnderstatesEncryption(null, computed)).toBe(true);
    expect(capabilityUnderstatesEncryption(computed, computed)).toBe(false);
    const plaintext: SecretCapability = {
      policy: 'allow_plaintext',
      inputs: [{ ...computed.inputs[0], encryption: 'none', recipientIds: [] }],
      ready: true,
      requiredRecipients: [],
    };
    expect(capabilityUnderstatesEncryption(null, plaintext)).toBe(false);
    expect(capabilityUnderstatesEncryption(plaintext, plaintext)).toBe(false);
  });

  it('records a plaintext sibling .env with no recipients', () => {
    const entry = syncEnvInputEntry('KEY=value\n');
    expect(entry.encryption).toBe('none');
    expect(entry.sopsRecipients).toEqual([]);
    expect(entry.dependencyKind).toBe('sync-env');
    const result = buildSecretCapability({
      policy: 'allow_plaintext',
      inputs: [entry],
      applicationId: 'app-sync-plain',
      stackName: 'stack-sync-plain',
    });
    expect(result.capability.requiredRecipients).toEqual([]);
    expect(result.refusal).toBeUndefined();
    expect(manifestInputsNeedOverlay({ inputs: [entry] })).toBe(false);
  });

  it('blocks LKG only when no recipient of a file is available', () => {
    const cap = {
      policy: 'allow_plaintext' as const,
      inputs: [{
        role: 'env' as const,
        encryption: 'sops-age' as const,
        recipientIds: ['age1aaa', 'age1bbb'],
        sourcePath: '.env',
        materializedPath: '.env',
      }],
      ready: true,
      requiredRecipients: ['age1aaa', 'age1bbb'],
    };
    expect(lkgBlockedByMissingRecipients(JSON.stringify(cap), new Set(['age1aaa']))).toBe(false);
    expect(lkgBlockedByMissingRecipients(JSON.stringify(cap), new Set(['age1ccc']))).toBe(true);
    expect(missingRecipientsForCapability(cap, new Set(['age1ccc']))).toEqual(['age1aaa', 'age1bbb']);
  });

  it('falls back to the flat recipient list for legacy capabilities', () => {
    const legacy = {
      policy: 'allow_plaintext' as const,
      inputs: [],
      ready: false,
      requiredRecipients: ['age1aaa'],
    };
    expect(lkgBlockedByMissingRecipients(JSON.stringify(legacy), new Set(['age1aaa']))).toBe(false);
    expect(lkgBlockedByMissingRecipients(JSON.stringify(legacy), new Set(['age1bbb']))).toBe(true);
  });

  it('reports only the recipients of inputs no identity can decrypt', () => {
    const cap = {
      policy: 'allow_plaintext' as const,
      inputs: [
        {
          role: 'env' as const,
          encryption: 'sops-age' as const,
          recipientIds: ['age1aaa', 'age1bbb'],
          sourcePath: '.env',
          materializedPath: '.env',
        },
        {
          role: 'config' as const,
          encryption: 'sops-age' as const,
          recipientIds: ['age1ccc'],
          sourcePath: 'cfg.env',
          materializedPath: 'cfg.env',
        },
      ],
      ready: true,
      requiredRecipients: ['age1aaa', 'age1bbb', 'age1ccc'],
    };
    expect(missingRecipientsForCapability(cap, new Set(['age1aaa']))).toEqual(['age1ccc']);
    expect(lkgBlockedByMissingRecipients(JSON.stringify(cap), new Set(['age1aaa', 'age1ccc']))).toBe(false);
    expect(lkgBlockedByMissingRecipients(JSON.stringify(cap), new Set(['age1bbb']))).toBe(true);
  });
});
