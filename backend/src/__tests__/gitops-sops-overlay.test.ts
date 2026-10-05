import { describe, expect, it, beforeEach, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { GitOpsDecryptOverlay } from '../services/gitops/sops/overlay';
import { buildGitOpsDecryptOverlay } from '../services/gitops/sops/prepareOverlay';
import { SopsDecryptError } from '../services/gitops/sops/decode';
import type { ComposeInputEntry } from '../types/gitProjectManifest';
import { buildSopsAgeDocument, buildSopsAgeDotenvDocument } from './helpers/sopsFixtures';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

async function importTestIdentity(identity: string): Promise<void> {
  const { SopsIdentityStore } = await import('../services/gitops/sops/identityStore');
  const { DatabaseService } = await import('../services/DatabaseService');
  DatabaseService.getInstance().getDb().exec(`
    CREATE TABLE IF NOT EXISTS gitops_sops_identities (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL,
      stack_name TEXT NOT NULL,
      recipient TEXT NOT NULL,
      encrypted_identity TEXT NOT NULL,
      label TEXT NULL,
      created_at INTEGER NOT NULL,
      rotated_at INTEGER NULL
    );
  `);
  await SopsIdentityStore.getInstance().importIdentity({
    applicationId: 'app-1',
    stackName: 'demo',
    identity,
  });
}

describe('GitOpsDecryptOverlay', () => {
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await setupTestDb();
  });

  afterAll(() => {
    cleanupTestDb(dataDir);
  });

  beforeEach(() => {
    GitOpsDecryptOverlay.resetForTests();
  });

  it('leaves durable source bytes unchanged while overlay holds plaintext', async () => {
    const age = await import('age-encryption');
    const identity = await age.generateIdentity();
    const recipient = await age.identityToRecipient(identity);
    const sopsDoc = await buildSopsAgeDocument({
      values: { DB_PASSWORD: 'plain' },
      identity,
      recipient,
    });

    const sourceRoot = path.join(dataDir, 'git-managed', '1', 'demo', 'candidate');
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, '.env'), sopsDoc, { mode: 0o600 });
    const sourceHash = crypto.createHash('sha256').update(sopsDoc).digest('hex');

    const inputs: ComposeInputEntry[] = [{
      sourcePath: '.env',
      materializedPath: '.env',
      role: 'env',
      dependencyKind: 'env_file',
      ownership: 'managed',
      provenance: 'fetch',
      sensitivity: 'high',
      contentSha256: sourceHash,
      sizeBytes: sopsDoc.length,
      state: 'present',
      deletionAuthority: 'sencho',
      note: null,
      encryption: 'sops-age',
      sopsRecipients: [recipient],
    }];

    await importTestIdentity(identity);

    const overlay = await buildGitOpsDecryptOverlay({
      stackName: 'demo',
      nodeId: 1,
      applicationId: 'app-1',
      generationId: 'gen-1',
      commitSha: 'b'.repeat(40),
      sourceRoot,
      manifest: { inputs },
    });
    expect(overlay).not.toBeNull();
    const overlayPlain = fs.readFileSync(path.join(overlay!.overlayDir, '.env'), 'utf8');
    expect(overlayPlain).toContain('DB_PASSWORD: plain');
    expect(fs.readFileSync(path.join(sourceRoot, '.env'), 'utf8')).toBe(sopsDoc);
    expect(crypto.createHash('sha256').update(fs.readFileSync(path.join(sourceRoot, '.env'))).digest('hex')).toBe(sourceHash);

    GitOpsDecryptOverlay.getInstance().assertBinding(overlay!.overlayDir, overlay!.binding);
    expect(() => GitOpsDecryptOverlay.getInstance().assertBinding(overlay!.overlayDir, {
      ...overlay!.binding,
      commitSha: 'd'.repeat(40),
    })).toThrow(/binding mismatch/i);
    await GitOpsDecryptOverlay.getInstance().destroy(1, 'demo', overlay!.binding.operationId);
    expect(fs.existsSync(overlay!.overlayDir)).toBe(false);
  });

  it('formats dotenv output for the consumer role', async () => {
    const age = await import('age-encryption');
    const identity = await age.generateIdentity();
    const recipient = await age.identityToRecipient(identity);
    const sopsDoc = await buildSopsAgeDotenvDocument({
      values: { PASSWORD: 'pa$word' },
      identity,
      recipient,
    });

    const sourceRoot = path.join(dataDir, 'git-managed', '1', 'demo', 'candidate');
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'svc.env'), sopsDoc, { mode: 0o600 });
    fs.writeFileSync(path.join(sourceRoot, 'cred.env'), sopsDoc, { mode: 0o600 });
    fs.writeFileSync(path.join(sourceRoot, 'sec.env'), sopsDoc, { mode: 0o600 });

    const base = {
      sourcePath: null as string | null,
      ownership: 'managed' as const,
      provenance: 'fetch' as const,
      sensitivity: 'high' as const,
      contentSha256: null as string | null,
      sizeBytes: null as number | null,
      state: 'present' as const,
      deletionAuthority: 'sencho' as const,
      note: null as string | null,
      encryption: 'sops-age' as const,
      sopsRecipients: [recipient],
    };
    const inputs: ComposeInputEntry[] = [
      { ...base, sourcePath: 'svc.env', materializedPath: 'svc.env', role: 'env', dependencyKind: 'env_file' },
      { ...base, sourcePath: 'cred.env', materializedPath: 'cred.env', role: 'config', dependencyKind: 'config' },
      { ...base, sourcePath: 'sec.env', materializedPath: 'sec.env', role: 'secret', dependencyKind: 'secret' },
    ];

    await importTestIdentity(identity);

    const overlay = await buildGitOpsDecryptOverlay({
      stackName: 'demo',
      nodeId: 1,
      applicationId: 'app-1',
      generationId: 'gen-role',
      commitSha: 'e'.repeat(40),
      sourceRoot,
      manifest: { inputs },
    });
    expect(overlay).not.toBeNull();
    expect(fs.readFileSync(path.join(overlay!.overlayDir, 'svc.env'), 'utf8'))
      .toBe('PASSWORD="pa$$word"\n');
    expect(fs.readFileSync(path.join(overlay!.overlayDir, 'cred.env'), 'utf8'))
      .toBe('PASSWORD=pa$word\n');
    expect(fs.readFileSync(path.join(overlay!.overlayDir, 'sec.env'), 'utf8'))
      .toBe('PASSWORD=pa$word\n');
  });

  it('preserves the decrypt failure class through the overlay', async () => {
    const age = await import('age-encryption');
    const identity = await age.generateIdentity();
    const recipient = await age.identityToRecipient(identity);
    const sopsDoc = await buildSopsAgeDocument({
      values: { DB_PASSWORD: 'plain' },
      identity,
      recipient,
    });
    const tampered = sopsDoc.replace(/^DB_PASSWORD:/m, 'RENAMED_PASSWORD:');
    expect(tampered).not.toBe(sopsDoc);

    const sourceRoot = path.join(dataDir, 'git-managed', '1', 'demo', 'candidate-tampered');
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, '.env'), tampered, { mode: 0o600 });

    const inputs: ComposeInputEntry[] = [{
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
      sopsRecipients: [recipient],
    }];

    await importTestIdentity(identity);
    const rejection = await buildGitOpsDecryptOverlay({
      stackName: 'demo',
      nodeId: 1,
      applicationId: 'app-1',
      generationId: 'gen-tampered',
      commitSha: 'f'.repeat(40),
      sourceRoot,
      manifest: { inputs },
    }).catch((err: unknown) => err);
    expect(rejection).toBeInstanceOf(SopsDecryptError);
    expect(rejection).toMatchObject({ code: 'decrypt_failed' });
  });

  it('sweepStale removes leftover overlay directories', async () => {
    const staleRoot = path.join(dataDir, 'git-secrets', '1', 'demo', 'stale-op');
    await fsPromises.mkdir(staleRoot, { recursive: true, mode: 0o700 });
    await fsPromises.writeFile(
      path.join(staleRoot, '.sencho-overlay.json'),
      JSON.stringify({ operationId: 'stale-op' }),
      { mode: 0o600 },
    );
    const old = Date.now() - (25 * 60 * 60 * 1000);
    await fsPromises.utimes(staleRoot, old / 1000, old / 1000);

    const removed = await GitOpsDecryptOverlay.getInstance().sweepStale(60 * 60 * 1000);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(staleRoot)).toBe(false);
  });
});
