import { randomUUID } from 'crypto';
import { CryptoService } from '../CryptoService';
import { errorMessageForLog } from '../../utils/safeLog';
import { getRecoveryAuthorityId, recoveryDb } from './recoveryDb';
import { RecoveryError } from './redaction';
import { canonicalizeLocator } from './storageIdentity';
import type { FailureDomainRelation, RepositoryDescriptor, RepositoryKind } from './types';

/**
 * Recovery repositories and their secrets.
 *
 * A repository password is encrypted with the instance key (`CryptoService`,
 * the same lifecycle as every other stored credential) before it reaches the
 * database; the column refuses anything without the `enc:` prefix. The
 * plaintext is returned only by `readSecret`, for the node-local engine call
 * that needs it, and never by a descriptor, an API, an audit row or a log.
 */

interface RepositoryRow {
  id: string;
  authority_id: string;
  owner_node_key: string;
  kind: RepositoryKind;
  locator: string;
  repository_fingerprint: string | null;
  failure_domain: FailureDomainRelation;
  encrypted_secret: string | null;
  created_at: number;
}

function toDescriptor(row: RepositoryRow): RepositoryDescriptor {
  return {
    id: row.id,
    authorityId: row.authority_id,
    ownerNodeKey: row.owner_node_key,
    kind: row.kind,
    locator: row.locator,
    repositoryFingerprint: row.repository_fingerprint,
    failureDomain: row.failure_domain,
    secretState: row.encrypted_secret ? 'stored' : 'absent',
    createdAt: row.created_at,
  };
}

export interface RepositoryRegistration {
  ownerNodeKey: string;
  kind: RepositoryKind;
  /** For `local_volume`, the Docker volume that holds the repository. */
  locator: string;
  failureDomain: FailureDomainRelation;
}

export class RecoveryRepositoryStore {
  private static instance: RecoveryRepositoryStore;

  static getInstance(): RecoveryRepositoryStore {
    if (!RecoveryRepositoryStore.instance) RecoveryRepositoryStore.instance = new RecoveryRepositoryStore();
    return RecoveryRepositoryStore.instance;
  }

  /** Register a repository, or return the one already registered at that locator. */
  register(registration: RepositoryRegistration, now = Date.now()): RepositoryDescriptor {
    if (registration.ownerNodeKey.trim() === '') throw new RecoveryError('identity_unknown');
    const locator = canonicalizeLocator('named_volume', registration.locator);
    const authorityId = getRecoveryAuthorityId();
    const db = recoveryDb();
    db.prepare(`
      INSERT OR IGNORE INTO recovery_repositories
        (id, authority_id, owner_node_key, kind, locator, failure_domain, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), authorityId, registration.ownerNodeKey, registration.kind, locator, registration.failureDomain, now);
    const row = db.prepare(`
      SELECT * FROM recovery_repositories
      WHERE authority_id = ? AND owner_node_key = ? AND kind = ? AND locator = ?
    `).get(authorityId, registration.ownerNodeKey, registration.kind, locator) as RepositoryRow;
    return toDescriptor(row);
  }

  get(id: string): RepositoryDescriptor | null {
    const row = recoveryDb().prepare('SELECT * FROM recovery_repositories WHERE id = ?').get(id) as RepositoryRow | undefined;
    return row ? toDescriptor(row) : null;
  }

  /** Record the engine's repository id once the repository is initialized. */
  setFingerprint(id: string, fingerprint: string): void {
    const result = recoveryDb().prepare(
      'UPDATE recovery_repositories SET repository_fingerprint = ? WHERE id = ?',
    ).run(fingerprint, id);
    if (result.changes === 0) throw new RecoveryError('repository_unavailable');
  }

  storeSecret(id: string, plaintext: string): void {
    if (typeof plaintext !== 'string' || plaintext.length === 0) throw new RecoveryError('invalid_request');
    const encrypted = CryptoService.getInstance().encrypt(plaintext);
    const result = recoveryDb().prepare(
      'UPDATE recovery_repositories SET encrypted_secret = ? WHERE id = ?',
    ).run(encrypted, id);
    if (result.changes === 0) throw new RecoveryError('repository_unavailable');
  }

  /** The plaintext secret, for the node-local engine call only. */
  readSecret(id: string): string {
    const row = recoveryDb().prepare(
      'SELECT encrypted_secret FROM recovery_repositories WHERE id = ?',
    ).get(id) as { encrypted_secret: string | null } | undefined;
    if (!row) throw new RecoveryError('repository_unavailable');
    if (!row.encrypted_secret) throw new RecoveryError('repository_key_unavailable');
    try {
      return CryptoService.getInstance().decrypt(row.encrypted_secret);
    } catch (err) {
      // A key that no longer opens the secret (the instance key was replaced)
      // is a missing key, not a reason to fail open or to show the ciphertext.
      console.error('[Recovery] Repository secret could not be decrypted:', errorMessageForLog(err));
      throw new RecoveryError('repository_key_unavailable');
    }
  }
}
