import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { GitOpsDecryptOverlay } from '../services/gitops/sops/overlay';
import { buildGitOpsDecryptOverlay } from '../services/gitops/sops/prepareOverlay';
import type { ComposeInputEntry } from '../types/gitProjectManifest';
import { buildSopsAgeDocument } from './helpers/sopsFixtures';

describe('GitOpsDecryptOverlay', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-sops-overlay-'));
    process.env.DATA_DIR = dataDir;
    GitOpsDecryptOverlay.resetForTests();
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
    fs.rmSync(dataDir, { recursive: true, force: true });
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

    const sourceRoot = fs.mkdtempSync(path.join(dataDir, 'source-'));
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
