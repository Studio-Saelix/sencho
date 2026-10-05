import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import {
  buildSecretCapability,
  lkgBlockedByMissingRecipients,
  missingRecipientsForCapability,
} from '../services/gitops/sops/capability';
import { SopsIdentityStore } from '../services/gitops/sops/identityStore';
import type { ComposeInputEntry } from '../types/gitProjectManifest';

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
