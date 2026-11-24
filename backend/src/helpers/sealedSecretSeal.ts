import crypto from 'crypto';

import {
  deriveLocalKey,
  openEnvelope,
  sealEnvelope,
  type EnvelopeDerivation,
  type SealedAuthsV1,
} from './registryEnvelopeSeal';

/**
 * Sealed long-lived secrets reuse the node's registry sealing keypair, with
 * their own HKDF salt and info per purpose, so a registry envelope never opens
 * as a sealed secret and the reverse.
 */
const SEALED_SECRET_SALT = 'sencho-sealed-secret-v1';
const FINGERPRINT_KEY_INFO = 'sencho-sealed-secret-fingerprint';
const OPEN_FAILURE = 'Sealed secret failed to open';

export type SealedSecretEnvelope = SealedAuthsV1;

/** What the hub seals and the node checks against the route and body after opening. */
export interface SealedSecretPayload {
  v: 1;
  purpose: string;
  slot: string;
  generation: number;
  secret: string;
}

/** The fields one delivery is bound to. */
export interface SealedSecretBinding {
  purpose: string;
  deliverySourceId: string;
  slot: string;
  generation: number;
  operationId: string;
}

function derivationFor(purpose: string): EnvelopeDerivation {
  return { salt: SEALED_SECRET_SALT, info: `sencho-sealed-secret:${purpose}` };
}

/** AAD binding the ciphertext to node, purpose, slot, generation and operation. */
export function buildSealedSecretAad(binding: SealedSecretBinding): string {
  return [
    'sencho-sealed-secret-v1',
    binding.purpose,
    binding.deliverySourceId,
    binding.slot,
    String(binding.generation),
    binding.operationId,
  ].join('|');
}

export function sealSecret(
  recipientPublicKeyRaw: Buffer,
  binding: SealedSecretBinding,
  secret: string,
): SealedSecretEnvelope {
  const payload: SealedSecretPayload = {
    v: 1,
    purpose: binding.purpose,
    slot: binding.slot,
    generation: binding.generation,
    secret,
  };
  return sealEnvelope(
    recipientPublicKeyRaw,
    Buffer.from(JSON.stringify(payload), 'utf8'),
    buildSealedSecretAad(binding),
    derivationFor(binding.purpose),
  );
}

function isPayload(value: unknown): value is SealedSecretPayload {
  if (typeof value !== 'object' || value === null) return false;
  const raw = value as Record<string, unknown>;
  return raw.v === 1
    && typeof raw.purpose === 'string'
    && typeof raw.slot === 'string'
    && typeof raw.generation === 'number'
    && typeof raw.secret === 'string';
}

/**
 * Open a sealed secret addressed to this node and check that the sealed
 * payload names the same purpose, slot and generation as the request. Any
 * failure throws one generic message; nothing about the content is echoed.
 */
export function openSecret(sealed: unknown, binding: SealedSecretBinding): string {
  const plaintext = openEnvelope(sealed, buildSealedSecretAad(binding), derivationFor(binding.purpose), OPEN_FAILURE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new Error(OPEN_FAILURE);
  }
  if (
    !isPayload(parsed)
    || parsed.purpose !== binding.purpose
    || parsed.slot !== binding.slot
    || parsed.generation !== binding.generation
  ) {
    throw new Error(OPEN_FAILURE);
  }
  return parsed.secret;
}

/**
 * Node-keyed fingerprint of a stored secret. The key is derived from this
 * node's sealing private key, so the value cannot be computed or brute-forced
 * off the node, even for a low-entropy secret. Listed, never audited.
 */
export function secretFingerprint(purpose: string, slot: string, secret: string): string {
  return crypto
    .createHmac('sha256', deriveLocalKey(FINGERPRINT_KEY_INFO))
    .update(`${purpose}|${slot}|`)
    .update(secret, 'utf8')
    .digest('base64');
}
