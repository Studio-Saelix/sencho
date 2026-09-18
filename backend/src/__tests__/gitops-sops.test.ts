import { describe, expect, it } from 'vitest';
import { detectSopsContent } from '../services/gitops/sops/detect';
import { decryptSopsAgeDocument, SopsDecryptError } from '../services/gitops/sops/decode';
import {
  buildSecretCapability,
  lkgBlockedByMissingRecipients,
  parseSecretCapabilityFromJson,
} from '../services/gitops/sops/capability';
import type { ComposeInputEntry } from '../types/gitProjectManifest';
import { buildSopsAgeDocument } from './helpers/sopsFixtures';

describe('detectSopsContent', () => {
  it('returns none for plain YAML without sops metadata', () => {
    expect(detectSopsContent('api_key: hello\n')).toEqual({ kind: 'none' });
  });

  it('refuses unsupported KMS backends', () => {
    const doc = `secret: ENC[AES256_GCM,data:abc,iv:abc,tag:abc,type:str]
sops:
  kms:
    - arn:aws:kms:us-east-1:123:key/abc
  mac: ENC[AES256_GCM,data:abc,iv:abc,tag:abc,type:str]
  version: 3.9.0
`;
    const result = detectSopsContent(doc);
    expect(result.kind).toBe('sops-unsupported');
  });

  it('detects age recipients when mac and age stanzas are present', () => {
    const doc = `secret: ENC[AES256_GCM,data:abc,iv:abc,tag:abc,type:str]
sops:
  age:
    - recipient: age1example000000000000000000000000000000000000000000000000000
      enc: |
        -----BEGIN AGE ENCRYPTED FILE-----
        YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSBPlMNK...
        -----END AGE ENCRYPTED FILE-----
  mac: ENC[AES256_GCM,data:abc,iv:abc,tag:abc,type:str]
  version: 3.9.0
`;
    const result = detectSopsContent(doc);
    expect(result).toEqual({
      kind: 'sops-age',
      recipients: ['age1example000000000000000000000000000000000000000000000000000'],
    });
  });

  it('detects dotenv-format SOPS with flattened age recipients', () => {
    const doc = `DB_PASSWORD=ENC[AES256_GCM,data:abc,iv:abc,tag:abc,type:str]
sops_mac=ENC[AES256_GCM,data:abc,iv:abc,tag:abc,type:str]
sops_version=3.9.0
sops_age__list_0__map_recipient=age1example000000000000000000000000000000000000000000000000000
sops_age__list_0__map_enc=-----BEGIN AGE ENCRYPTED FILE-----\\nYWdlLWVuY3J5cHRpb24ub3JnL3Yx\\n-----END AGE ENCRYPTED FILE-----
`;
    expect(detectSopsContent(doc)).toEqual({
      kind: 'sops-age',
      recipients: ['age1example000000000000000000000000000000000000000000000000000'],
    });
  });

  it('does not classify plaintext dotenv as SOPS', () => {
    expect(detectSopsContent('DB_PASSWORD=hello\n')).toEqual({ kind: 'none' });
  });

  it('refuses dotenv SOPS with a KMS backend', () => {
    const doc = `DB_PASSWORD=ENC[AES256_GCM,data:abc,iv:abc,tag:abc,type:str]
sops_mac=ENC[AES256_GCM,data:abc,iv:abc,tag:abc,type:str]
sops_kms__list_0__map_arn=arn:aws:kms:us-east-1:123:key/abc
`;
    expect(detectSopsContent(doc).kind).toBe('sops-unsupported');
  });

  it('refuses ENC values without SOPS metadata instead of treating them as plaintext', () => {
    const result = detectSopsContent('DB_PASSWORD=ENC[AES256_GCM,data:abc,iv:abc,tag:abc,type:str]\n');
    expect(result.kind).toBe('sops-unsupported');
  });
});

describe('decryptSopsAgeDocument', () => {
  it('throws wrong_identity when no age entry matches', async () => {
    const doc = `secret: ENC[AES256_GCM,data:YWJj,iv:YWJj,tag:YWJj,type:str]
sops:
  age:
    - recipient: age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq
      enc: |
        -----BEGIN AGE ENCRYPTED FILE-----
        YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSBPbHkgdGVzdA==
        -----END AGE ENCRYPTED FILE-----
  mac: ENC[AES256_GCM,data:abc,iv:abc,tag:abc,type:str]
`;
    await expect(
      decryptSopsAgeDocument(doc, 'AGE-SECRET-KEY-1INVALID000000000000000000000000000000000000000000000'),
    ).rejects.toBeInstanceOf(SopsDecryptError);
  });

  it('decrypts an age-only SOPS document without leaking the identity', async () => {
    const age = await import('age-encryption');
    const identity = await age.generateIdentity();
    const recipient = await age.identityToRecipient(identity);
    const doc = await buildSopsAgeDocument({
      values: { DB_PASSWORD: 'supersecret' },
      identity,
      recipient,
    });
    const detection = detectSopsContent(doc);
    expect(detection.kind).toBe('sops-age');
    const decrypted = await decryptSopsAgeDocument(doc, identity);
    expect(decrypted).toContain('DB_PASSWORD: supersecret');
    expect(decrypted).not.toContain('AGE-SECRET-KEY');
  });

  it('decrypts a dotenv-format age SOPS document', async () => {
    const age = await import('age-encryption');
    const identity = await age.generateIdentity();
    const recipient = await age.identityToRecipient(identity);
    const { buildSopsAgeDotenvDocument } = await import('./helpers/sopsFixtures');
    const doc = await buildSopsAgeDotenvDocument({
      values: { DB_PASSWORD: 'supersecret' },
      identity,
      recipient,
    });
    expect(detectSopsContent(doc).kind).toBe('sops-age');
    const decrypted = await decryptSopsAgeDocument(doc, identity);
    expect(decrypted).toContain('DB_PASSWORD=supersecret');
    expect(decrypted).not.toContain('sops_age');
    expect(decrypted).not.toContain('AGE-SECRET-KEY');
  });

  it('detects and decrypts INI-format age SOPS with a [sops] section', async () => {
    const age = await import('age-encryption');
    const identity = await age.generateIdentity();
    const recipient = await age.identityToRecipient(identity);
    const { buildSopsAgeIniDocument } = await import('./helpers/sopsFixtures');
    const doc = await buildSopsAgeIniDocument({
      values: { DB_PASSWORD: 'supersecret' },
      identity,
      recipient,
    });
    expect(detectSopsContent(doc).kind).toBe('sops-age');
    const decrypted = await decryptSopsAgeDocument(doc, identity);
    expect(decrypted).toContain('DB_PASSWORD=supersecret');
    expect(decrypted).not.toContain('[sops]');
    expect(decrypted).not.toContain('age__list');
    expect(decrypted).not.toContain('AGE-SECRET-KEY');
  });
});

describe('buildSecretCapability', () => {
  const highPlainEnv: ComposeInputEntry = {
    sourcePath: '.env',
    materializedPath: '.env',
    role: 'env',
    dependencyKind: 'env_file',
    ownership: 'managed',
    provenance: 'fetch',
    sensitivity: 'high',
    contentSha256: null,
    sizeBytes: 10,
    state: 'present',
    deletionAuthority: 'sencho',
    note: null,
    encryption: 'none',
    sopsRecipients: [],
  };

  it('refuses plaintext high-sensitivity inputs when require_encrypted is set', () => {
    const result = buildSecretCapability({
      policy: 'require_encrypted',
      inputs: [highPlainEnv],
      applicationId: 'app-1',
      stackName: 'demo',
    });
    expect(result.refusal?.failureClass).toBe('invalid_ciphertext');
    expect(result.refusal?.reason).toMatch(/requires SOPS/i);
  });
});

describe('lkgBlockedByMissingRecipients', () => {
  it('returns true when a required recipient is absent', () => {
    const cap = {
      policy: 'allow_plaintext' as const,
      inputs: [],
      ready: false,
      requiredRecipients: ['age1abc'],
    };
    expect(lkgBlockedByMissingRecipients(JSON.stringify(cap), new Set(['age1other']))).toBe(true);
    expect(lkgBlockedByMissingRecipients(JSON.stringify(cap), new Set(['age1abc']))).toBe(false);
  });

  it('returns false for legacy rows without capability evidence', () => {
    expect(lkgBlockedByMissingRecipients(null, new Set())).toBe(false);
    expect(parseSecretCapabilityFromJson(null)).toBeNull();
  });
});
