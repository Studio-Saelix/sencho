import { createHash, randomUUID } from 'crypto';
import path from 'path';
import type Docker from 'dockerode';
import { getRecoveryAuthorityId, recoveryDb } from './recoveryDb';
import { errorMessageForLog } from '../../utils/safeLog';
import { RecoveryError } from './redaction';
import type { StorageDependent, StorageIdentity, StorageKind } from './types';

/**
 * Durable storage identity: the one place that decides which bytes a recovery
 * point belongs to.
 *
 * The key is authority + owning engine + kind + canonical locator. A stack name
 * is never part of it (a rename keeps the identity), nor is a node's integer id
 * or display name (each node records its own storage; the hub refers to it by
 * authority). A volume recreated under the same name changes its generation
 * token, which opens a new generation linked to the old one, so coverage of the
 * old data never reads as coverage of the new.
 */

/** Docker's own volume-name grammar. Case-sensitive, so no case folding. */
const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]+$/;

/**
 * Canonical form of a locator, or `invalid_request`. A bind root must be the
 * resolved absolute host path (the node-local adapter resolves symlinks before
 * calling); `..` segments and the filesystem root are refused rather than
 * normalized away, so two spellings of one directory cannot become two
 * identities and a traversal cannot become one.
 */
export function canonicalizeLocator(kind: StorageKind, raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.includes('\0')) {
    throw new RecoveryError('invalid_request');
  }
  if (kind === 'named_volume') {
    if (!VOLUME_NAME.test(raw)) throw new RecoveryError('invalid_request');
    return raw;
  }
  if (!path.posix.isAbsolute(raw) || raw.split('/').includes('..')) {
    throw new RecoveryError('invalid_request');
  }
  const normalized = path.posix.normalize(raw).replace(/\/+$/, '');
  if (normalized === '') throw new RecoveryError('invalid_request');
  return normalized;
}

export function deriveStorageKey(authorityId: string, ownerNodeKey: string, kind: StorageKind, locator: string): string {
  return createHash('sha256')
    .update(JSON.stringify([authorityId, ownerNodeKey, kind, locator]))
    .digest('hex');
}

/**
 * The owning engine's stable identity. Docker persists its engine id across
 * daemon restarts, and it changes when the node is rebuilt on a new engine,
 * which is exactly when storage on the old engine stops being this storage.
 */
export async function resolveOwnerNodeKey(docker: Pick<Docker, 'info'>): Promise<string> {
  let info: unknown;
  try {
    info = await docker.info();
  } catch (err) {
    console.warn('[Recovery] Could not read the Docker engine identity:', errorMessageForLog(err));
    throw new RecoveryError('identity_unknown');
  }
  const id = (info as { ID?: unknown } | null)?.ID;
  if (typeof id !== 'string' || id.trim() === '') throw new RecoveryError('identity_unknown');
  return `docker-engine:${id.trim()}`;
}

interface IdentityRow {
  id: string;
  authority_id: string;
  owner_node_key: string;
  kind: StorageKind;
  locator: string;
  storage_key: string;
  generation: number;
  generation_token: string;
  lineage_parent_id: string | null;
  state: 'current' | 'superseded';
  first_seen_at: number;
  last_seen_at: number;
}

function toIdentity(row: IdentityRow): StorageIdentity {
  return {
    id: row.id,
    authorityId: row.authority_id,
    ownerNodeKey: row.owner_node_key,
    kind: row.kind,
    locator: row.locator,
    storageKey: row.storage_key,
    generation: row.generation,
    generationToken: row.generation_token,
    lineageParentId: row.lineage_parent_id,
    state: row.state,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

export interface StorageObservation {
  ownerNodeKey: string;
  kind: StorageKind;
  locator: string;
  /** Adapter token that changes when the storage is recreated (a volume's CreatedAt). */
  generationToken: string;
  /** The complete set of stacks that reference this storage right now. */
  dependents: readonly StorageDependent[];
}

export class StorageIdentityStore {
  private static instance: StorageIdentityStore;

  static getInstance(): StorageIdentityStore {
    if (!StorageIdentityStore.instance) StorageIdentityStore.instance = new StorageIdentityStore();
    return StorageIdentityStore.instance;
  }

  /**
   * Record that a storage root exists now, with its current dependents, and
   * return its identity. Same key and token: the existing generation. Same key,
   * new token: the old generation is superseded and a new one is linked to it.
   * The dependent set is replaced as a whole, so a stack that stopped using the
   * storage stops being a dependent.
   */
  observe(observation: StorageObservation, now = Date.now()): StorageIdentity {
    const token = typeof observation.generationToken === 'string' ? observation.generationToken.trim() : '';
    if (token === '' || observation.ownerNodeKey.trim() === '') throw new RecoveryError('identity_unknown');
    const locator = canonicalizeLocator(observation.kind, observation.locator);
    const authorityId = getRecoveryAuthorityId();
    const storageKey = deriveStorageKey(authorityId, observation.ownerNodeKey, observation.kind, locator);
    const db = recoveryDb();

    return db.transaction((): StorageIdentity => {
      const current = db.prepare(
        "SELECT * FROM recovery_storage_identities WHERE storage_key = ? AND state = 'current'",
      ).get(storageKey) as IdentityRow | undefined;

      let id: string;
      if (current && current.generation_token === token) {
        db.prepare('UPDATE recovery_storage_identities SET last_seen_at = ? WHERE id = ?').run(now, current.id);
        id = current.id;
      } else {
        if (current) {
          db.prepare("UPDATE recovery_storage_identities SET state = 'superseded' WHERE id = ?").run(current.id);
        }
        const latest = db.prepare(
          'SELECT MAX(generation) AS g FROM recovery_storage_identities WHERE storage_key = ?',
        ).get(storageKey) as { g: number | null };
        id = randomUUID();
        db.prepare(`
          INSERT INTO recovery_storage_identities
            (id, authority_id, owner_node_key, kind, locator, storage_key, generation,
             generation_token, lineage_parent_id, state, first_seen_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'current', ?, ?)
        `).run(
          id, authorityId, observation.ownerNodeKey, observation.kind, locator, storageKey,
          (latest.g ?? 0) + 1, token, current?.id ?? null, now, now,
        );
      }
      this.replaceDependents(storageKey, observation.dependents, now);
      return toIdentity(db.prepare('SELECT * FROM recovery_storage_identities WHERE id = ?').get(id) as IdentityRow);
    })();
  }

  getById(id: string): StorageIdentity | null {
    const row = recoveryDb().prepare('SELECT * FROM recovery_storage_identities WHERE id = ?').get(id) as IdentityRow | undefined;
    return row ? toIdentity(row) : null;
  }

  getCurrent(storageKey: string): StorageIdentity | null {
    const row = recoveryDb().prepare(
      "SELECT * FROM recovery_storage_identities WHERE storage_key = ? AND state = 'current'",
    ).get(storageKey) as IdentityRow | undefined;
    return row ? toIdentity(row) : null;
  }

  /** Every generation of a key, oldest first. */
  listGenerations(storageKey: string): StorageIdentity[] {
    const rows = recoveryDb().prepare(
      'SELECT * FROM recovery_storage_identities WHERE storage_key = ? ORDER BY generation',
    ).all(storageKey) as IdentityRow[];
    return rows.map(toIdentity);
  }

  listDependents(storageKey: string): StorageDependent[] {
    const rows = recoveryDb().prepare(
      'SELECT stack_name, service_name FROM recovery_storage_dependents WHERE storage_key = ? ORDER BY stack_name, service_name',
    ).all(storageKey) as Array<{ stack_name: string; service_name: string }>;
    return rows.map((r) => ({ stackName: r.stack_name, serviceName: r.service_name === '' ? null : r.service_name }));
  }

  private replaceDependents(storageKey: string, dependents: readonly StorageDependent[], now: number): void {
    const db = recoveryDb();
    db.prepare('DELETE FROM recovery_storage_dependents WHERE storage_key = ?').run(storageKey);
    const insert = db.prepare(`
      INSERT OR IGNORE INTO recovery_storage_dependents (storage_key, stack_name, service_name, observed_at)
      VALUES (?, ?, ?, ?)
    `);
    for (const dependent of dependents) {
      if (typeof dependent.stackName !== 'string' || dependent.stackName === '') {
        throw new RecoveryError('invalid_request');
      }
      insert.run(storageKey, dependent.stackName, dependent.serviceName ?? '', now);
    }
  }
}
