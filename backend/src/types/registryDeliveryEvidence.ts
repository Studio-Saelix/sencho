export type RegistryDeliveryEventType =
  | 'operation_completed'
  | 'operation_aborted'
  | 'cleanup_failed'
  | 'swept_local'
  | 'swept_delivered'
  | 'swept_prepared'
  | 'legacy_orphan_observed'
  | 'retention_gap'
  | 'source_reset';

export interface RegistryDeliveryEventRow {
  seq: number;
  event_id: string;
  delivery_source_id: string;
  stack: string | null;
  op: string | null;
  attestation_jti: string | null;
  prep_id_sha256: string | null;
  temp_dir_id: string | null;
  event_type: RegistryDeliveryEventType | string;
  source_hash: string | null;
  pruned_through_seq: number | null;
  created_at: number;
}

export interface RegistryDeliveryEventInput {
  deliverySourceId: string;
  eventType: RegistryDeliveryEventType;
  stack?: string | null;
  op?: string | null;
  attestationJti?: string | null;
  prepIdSha256?: string | null;
  tempDirId?: string | null;
  sourceHash?: string | null;
  prunedThroughSeq?: number | null;
}

export interface RegistryDeliveryEvidencePage {
  deliverySourceId: string;
  events: RegistryDeliveryEventRow[];
  nextCursor: number;
  limit: number;
}
