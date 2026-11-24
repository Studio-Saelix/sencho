import type Docker from 'dockerode';

import { SECRET_VOLUME_LABEL } from '../../helpers/secretVolume';
import { secretFingerprint } from '../../helpers/sealedSecretSeal';
import { getErrorMessage } from '../../utils/errors';
import { sanitizeForLog } from '../../utils/safeLog';
import { DatabaseService, type SealedSecretRecord } from '../DatabaseService';
import DockerController from '../DockerController';
import { NodeRegistry } from '../NodeRegistry';
import { recordSealedSecretAudit } from './audit';
import { SealedSecretError } from './errors';
import { getSealedSecretPurpose, type SealedSecretPurposeId } from './purposes';
import { removeLeftoverWriters, runSecretWriter, type SecretWriterOp } from './secretVolumeWriter';

export type AcceptStatus = 'accepted' | 'already_accepted';
export type RemoveStatus = 'deleted' | 'already_deleted' | 'not_current';

export interface StoreActor {
  /** Who asked on the hub, for the audit row. */
  actor: string;
  /** The route or call path, for the audit row. */
  path: string;
  method: string;
}

/** What a node reports for one purpose and slot. Never a value. */
export interface SealedSecretDescription {
  purpose: string;
  slot: string;
  /** The node's generation floor for the purpose, whatever the slot (0 when nothing was accepted). */
  purposeGeneration: number;
  state: 'present' | 'deleted' | 'absent';
  fingerprint: string | null;
  acceptedAt: number | null;
}

function stale(record: SealedSecretRecord): SealedSecretError {
  return new SealedSecretError(
    'SEALED_SECRET_GENERATION_STALE',
    409,
    `This node already recorded generation ${record.generation} for this secret.`,
    { purposeGeneration: record.generation },
  );
}

/**
 * The node's store for sealed secrets. One purpose has one file in one
 * labelled volume, so one live record and one generation counter per purpose.
 * Operations on a purpose are serialized in process.
 *
 * Whenever the file changes, the order is "change the file, then record": a
 * failed write leaves the generation unrecorded so the hub can retry it, and a
 * crash after a removal leaves the record `present` with no file, which the
 * hub's retry converges.
 */
export class SealedSecretStore {
  private static instance: SealedSecretStore | null = null;
  private readonly queues = new Map<string, Promise<unknown>>();
  private dockerOverride: Docker | null = null;

  static getInstance(): SealedSecretStore {
    if (!SealedSecretStore.instance) SealedSecretStore.instance = new SealedSecretStore();
    return SealedSecretStore.instance;
  }

  /** Test helper: drop the singleton (a node restart) and its Docker override. */
  static resetForTests(): void {
    SealedSecretStore.instance = null;
  }

  /** Test helper: run against a given Docker client. */
  setDockerForTests(docker: Docker | null): void {
    this.dockerOverride = docker;
  }

  private docker(): Docker {
    if (this.dockerOverride) return this.dockerOverride;
    return DockerController.getInstance(NodeRegistry.getInstance().getDefaultNodeId()).getDocker();
  }

  private serialize<T>(purpose: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(purpose) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.then(() => undefined, () => undefined);
    this.queues.set(purpose, settled);
    void settled.then(() => {
      if (this.queues.get(purpose) === settled) this.queues.delete(purpose);
    });
    return next;
  }

  describe(purpose: SealedSecretPurposeId, slot: string): SealedSecretDescription {
    const record = DatabaseService.getInstance().getSealedSecretRecord(purpose);
    if (!record) {
      return { purpose, slot, purposeGeneration: 0, state: 'absent', fingerprint: null, acceptedAt: null };
    }
    const current = record.slot === slot;
    return {
      purpose,
      slot,
      purposeGeneration: record.generation,
      state: current ? record.state : 'absent',
      fingerprint: current ? record.fingerprint : null,
      acceptedAt: current ? record.acceptedAt : null,
    };
  }

  list(): SealedSecretDescription[] {
    return DatabaseService.getInstance().listSealedSecretRecords().map((record) => ({
      purpose: record.purpose,
      slot: record.slot,
      purposeGeneration: record.generation,
      state: record.state,
      fingerprint: record.fingerprint,
      acceptedAt: record.acceptedAt,
    }));
  }

  accept(
    purposeId: SealedSecretPurposeId,
    slot: string,
    generation: number,
    secret: string,
    who: StoreActor,
  ): Promise<{ status: AcceptStatus; generation: number; fingerprint: string }> {
    return this.serialize(purposeId, async () => {
      const db = DatabaseService.getInstance();
      const purpose = getSealedSecretPurpose(purposeId);
      const record = db.getSealedSecretRecord(purposeId);
      const fingerprint = secretFingerprint(purposeId, slot, secret);
      const facts = { purpose: purposeId, slot, generation, actor: who.actor };

      if (Buffer.byteLength(secret, 'utf8') === 0 || Buffer.byteLength(secret, 'utf8') > purpose.maxSecretBytes) {
        this.audit('sealed_secret.refused', { ...facts, reason: 'size' }, who, 400);
        throw new SealedSecretError('SEALED_SECRET_REQUEST_INVALID', 400, 'The secret is empty or larger than this purpose allows.');
      }
      if (record && generation < record.generation) {
        this.audit('sealed_secret.refused', { ...facts, reason: 'stale' }, who, 409);
        throw stale(record);
      }
      if (record && generation === record.generation) {
        if (record.state === 'present' && record.slot === slot && record.fingerprint === fingerprint) {
          return { status: 'already_accepted' as const, generation, fingerprint };
        }
        this.audit('sealed_secret.refused', { ...facts, reason: 'stale' }, who, 409);
        throw stale(record);
      }

      try {
        await this.ensureVolume(purposeId, record !== null);
      } catch (error: unknown) {
        const reason = error instanceof SealedSecretError && error.code === 'SECRET_VOLUME_FOREIGN' ? 'foreign_volume' : 'store_unavailable';
        this.audit('sealed_secret.refused', { ...facts, reason }, who, error instanceof SealedSecretError ? error.status : 503);
        throw error;
      }
      await this.write(purposeId, { kind: 'write', secret }, facts, who);

      this.record(db, {
        purpose: purposeId,
        slot,
        generation,
        state: 'present',
        fingerprint,
        acceptedAt: Date.now(),
      }, 'The node wrote the secret but could not record it. Retry the delivery.');

      const replaced = record?.state === 'present';
      this.audit(replaced ? 'sealed_secret.replaced' : 'sealed_secret.accepted', {
        ...facts,
        previous_slot: replaced && record && record.slot !== slot ? record.slot : undefined,
      }, who, 200);
      return { status: 'accepted' as const, generation, fingerprint };
    });
  }

  remove(
    purposeId: SealedSecretPurposeId,
    slot: string,
    generation: number,
    who: StoreActor,
  ): Promise<{ status: RemoveStatus; generation: number; currentSlot: string | null }> {
    return this.serialize(purposeId, async () => {
      const db = DatabaseService.getInstance();
      const record = db.getSealedSecretRecord(purposeId);
      const facts = { purpose: purposeId, slot, generation, actor: who.actor };

      // Another slot is live (or nothing was ever accepted): a late removal of
      // an old secret id must never touch the file the live one is in.
      if (!record || record.slot !== slot) {
        this.audit('sealed_secret.remove_skipped', { ...facts, reason: 'not_current', current_slot: record?.slot }, who, 200);
        return { status: 'not_current' as const, generation: record?.generation ?? 0, currentSlot: record?.slot ?? null };
      }
      if (record.state === 'deleted') {
        if (generation === record.generation) {
          return { status: 'already_deleted' as const, generation, currentSlot: slot };
        }
        if (generation < record.generation) {
          this.audit('sealed_secret.refused', { ...facts, reason: 'stale' }, who, 409);
          throw stale(record);
        }
        // The file is already gone; only the generation moves.
        this.record(db, { ...record, generation, acceptedAt: Date.now() }, 'The node could not record the removal. Retry the removal.');
        this.audit('sealed_secret.removed', { ...facts, reason: 'already_absent' }, who, 200);
        return { status: 'deleted' as const, generation, currentSlot: slot };
      }
      if (generation <= record.generation) {
        this.audit('sealed_secret.refused', { ...facts, reason: 'stale' }, who, 409);
        throw stale(record);
      }

      // A volume removed outside Sencho holds no file to remove. Running the
      // writer would only make Docker create the volume again.
      let volumeExists: boolean;
      try {
        volumeExists = await this.inspectVolumeLabels(this.docker(), getSealedSecretPurpose(purposeId).volume) !== null;
      } catch (error: unknown) {
        this.audit('sealed_secret.refused', { ...facts, reason: 'store_unavailable' }, who, 503);
        throw error;
      }
      if (volumeExists) await this.write(purposeId, { kind: 'remove' }, facts, who);
      this.record(
        db,
        { ...record, generation, state: 'deleted', fingerprint: null, acceptedAt: Date.now() },
        'The node removed the secret but could not record it. Retry the removal.',
      );
      this.audit('sealed_secret.removed', facts, who, 200);
      return { status: 'deleted' as const, generation, currentSlot: slot };
    });
  }

  /** Write the purpose record; a failure answers 503 so the hub retries the same generation. */
  private record(db: DatabaseService, next: SealedSecretRecord, message: string): void {
    try {
      db.upsertSealedSecretRecord(next);
    } catch (error: unknown) {
      console.error('[SealedSecrets] Record write failed:', sanitizeForLog(getErrorMessage(error, 'unknown')));
      throw new SealedSecretError('SECRET_STORE_UNAVAILABLE', 503, message);
    }
  }

  private async write(
    purposeId: SealedSecretPurposeId,
    op: SecretWriterOp,
    facts: Record<string, string | number>,
    who: StoreActor,
  ): Promise<void> {
    const purpose = getSealedSecretPurpose(purposeId);
    try {
      await runSecretWriter(this.docker(), { name: purpose.volume, purposeId }, purpose, op);
    } catch (error: unknown) {
      const status = error instanceof SealedSecretError ? error.status : 503;
      this.audit('sealed_secret.refused', { ...facts, reason: 'write_failed' }, who, status);
      if (error instanceof SealedSecretError) throw error;
      console.error('[SealedSecrets] Writer failed:', sanitizeForLog(getErrorMessage(error, 'unknown')));
      throw new SealedSecretError('SECRET_STORE_UNAVAILABLE', 503, 'The node could not update its secret store.');
    }
  }

  /**
   * Make sure the purpose's volume exists and is the store's own. A volume
   * without the purpose's label, or a labelled one that a container already
   * mounts while this node holds no record for the purpose, was not made by
   * the store and may be read by someone else, so nothing is written into it.
   */
  private async ensureVolume(purposeId: SealedSecretPurposeId, hasRecord: boolean): Promise<void> {
    const { volume } = getSealedSecretPurpose(purposeId);
    const docker = this.docker();
    const labels = await this.inspectVolumeLabels(docker, volume);
    if (labels === null) {
      try {
        await docker.createVolume({ Name: volume, Labels: { [SECRET_VOLUME_LABEL]: purposeId } });
      } catch (error: unknown) {
        console.error('[SealedSecrets] Volume create failed:', sanitizeForLog(getErrorMessage(error, 'unknown')));
        throw new SealedSecretError('SECRET_STORE_UNAVAILABLE', 503, 'The node could not create its secret volume.');
      }
      // Docker answers an existing name with that volume, so check what we got.
      const created = await this.inspectVolumeLabels(docker, volume);
      if (created?.[SECRET_VOLUME_LABEL] !== purposeId) throw this.foreign(volume);
      return;
    }
    if (labels[SECRET_VOLUME_LABEL] !== purposeId) throw this.foreign(volume);
    // Labelled but no record: either the store's own first write failed after
    // creating the volume (safe to retry), or someone else made a look-alike
    // and may already have it mounted. Only an unmounted volume is adopted. A
    // writer a crashed run left behind is the store's own and is removed first,
    // so it never counts as a mount.
    if (!hasRecord) {
      await removeLeftoverWriters(docker, volume);
      if (await this.isMounted(docker, volume)) throw this.foreign(volume);
    }
  }

  private async isMounted(docker: Docker, volume: string): Promise<boolean> {
    try {
      const users = await docker.listContainers({ all: true, filters: { volume: [volume] } });
      return users.length > 0;
    } catch (error: unknown) {
      console.error('[SealedSecrets] Container list failed:', sanitizeForLog(getErrorMessage(error, 'unknown')));
      throw new SealedSecretError('SECRET_STORE_UNAVAILABLE', 503, 'The node could not check who uses its secret volume.');
    }
  }

  private async inspectVolumeLabels(docker: Docker, volume: string): Promise<Record<string, string> | null> {
    try {
      const info = await docker.getVolume(volume).inspect() as { Labels?: Record<string, string> | null };
      return info.Labels ?? {};
    } catch (error: unknown) {
      if ((error as { statusCode?: number }).statusCode === 404) return null;
      console.error('[SealedSecrets] Volume inspect failed:', sanitizeForLog(getErrorMessage(error, 'unknown')));
      throw new SealedSecretError('SECRET_STORE_UNAVAILABLE', 503, 'The node could not inspect its secret volume.');
    }
  }

  private foreign(volume: string): SealedSecretError {
    return new SealedSecretError(
      'SECRET_VOLUME_FOREIGN',
      409,
      `Volume "${volume}" exists on this node, but Sencho's secret store cannot confirm it made it, so nothing was written to it. `
        + 'On the node, stop and remove the containers that use that volume, remove the volume with the Docker CLI '
        + '(Sencho does not remove it), then deliver the secret again.',
    );
  }

  private audit(action: string, facts: Record<string, string | number | undefined>, who: StoreActor, statusCode: number): void {
    recordSealedSecretAudit(action, facts, { username: who.actor, path: who.path, method: who.method, statusCode });
  }
}
