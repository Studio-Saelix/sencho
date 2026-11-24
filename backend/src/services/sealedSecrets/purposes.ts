/**
 * The closed set of sealed-secret purposes a node accepts.
 *
 * A purpose names one storage location on the node: one labelled Docker
 * volume and one file inside it. So a node holds at most one live secret per
 * purpose, and the slot (for the edge tunnel, the tunnel id) says which
 * secret id that file currently holds. Writing a different slot replaces the
 * file at a higher generation.
 */
export interface SealedSecretPurpose {
  /** Docker volume that holds the secret file. Created by the store with the secret label. */
  volume: string;
  /** File name inside the volume. */
  file: string;
  /** Owner of the file: the user the consuming container runs as. */
  ownerUid: number;
  ownerGid: number;
  /** File mode, owner read only. */
  mode: number;
  /** Largest secret the node accepts for this purpose, in bytes. */
  maxSecretBytes: number;
  /** Shape a slot must match. */
  slotPattern: RegExp;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const EDGE_TUNNEL_RUN_TOKEN_PURPOSE = 'edge-tunnel-run-token' as const;

export const SEALED_SECRET_PURPOSES = {
  [EDGE_TUNNEL_RUN_TOKEN_PURPOSE]: {
    volume: 'sencho_edge_secret',
    file: 'token',
    // cloudflared's distroless image runs as nonroot (65532). The slice that
    // ships the edge stack confirms this against its pinned image digest.
    ownerUid: 65532,
    ownerGid: 65532,
    mode: 0o400,
    maxSecretBytes: 4096,
    slotPattern: UUID,
  },
} as const satisfies Record<string, SealedSecretPurpose>;

export type SealedSecretPurposeId = keyof typeof SEALED_SECRET_PURPOSES;

export function isSealedSecretPurpose(value: unknown): value is SealedSecretPurposeId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SEALED_SECRET_PURPOSES, value);
}

export function getSealedSecretPurpose(purpose: SealedSecretPurposeId): SealedSecretPurpose {
  return SEALED_SECRET_PURPOSES[purpose];
}

export function isValidSlot(purpose: SealedSecretPurposeId, slot: unknown): slot is string {
  return typeof slot === 'string' && getSealedSecretPurpose(purpose).slotPattern.test(slot);
}
