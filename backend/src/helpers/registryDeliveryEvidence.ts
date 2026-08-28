import crypto from 'crypto';
import jwt from 'jsonwebtoken';

import { DatabaseService } from '../services/DatabaseService';
import type {
  RegistryDeliveryEventInput,
  RegistryDeliveryEventRow,
  RegistryDeliveryEvidencePage,
} from '../types/registryDeliveryEvidence';

export function hashPrepId(prepId: string): string {
  return crypto.createHash('sha256').update(prepId).digest('hex');
}

export function attestationJtiFromToken(attestation: string | undefined): string | null {
  if (!attestation) return null;
  try {
    const decoded = jwt.decode(attestation);
    if (!decoded || typeof decoded === 'string') return null;
    return typeof decoded.jti_t === 'string' ? decoded.jti_t : null;
  } catch {
    return null;
  }
}

export function recordRegistryDeliveryEvent(input: RegistryDeliveryEventInput): number {
  return DatabaseService.getInstance().insertRegistryDeliveryEvent({
    deliverySourceId: input.deliverySourceId,
    eventType: input.eventType,
    stack: input.stack ?? null,
    op: input.op ?? null,
    attestationJti: input.attestationJti ?? null,
    prepIdSha256: input.prepIdSha256 ?? null,
    tempDirId: input.tempDirId ?? null,
    sourceHash: input.sourceHash ?? null,
    prunedThroughSeq: input.prunedThroughSeq ?? null,
  });
}

export function listRegistryDeliveryEvidencePage(
  deliverySourceId: string,
  cursor: number,
  limit: number,
): RegistryDeliveryEvidencePage {
  const events = DatabaseService.getInstance().listRegistryDeliveryEvents(
    deliverySourceId,
    cursor,
    limit,
  );
  const nextCursor = events.length > 0
    ? events[events.length - 1]!.seq
    : cursor;
  return {
    deliverySourceId,
    events,
    nextCursor,
    limit,
  };
}

export function importRegistryDeliveryEvidencePage(
  hubNodeIdSnapshot: number,
  deliverySourceId: string,
  events: RegistryDeliveryEventRow[],
): { imported: number; lastSeq: number } {
  return DatabaseService.getInstance().importRegistryDeliveryEventPage(
    hubNodeIdSnapshot,
    deliverySourceId,
    events,
  );
}
