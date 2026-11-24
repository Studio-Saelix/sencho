import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import type { RegistryDeliveryAuthEntry } from './registryDeliveryContext';

const KEY_FILE_NAME = 'registry-seal.key';
const PUBLIC_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const HKDF_SALT = 'sencho-registry-envelope-v1';
const HKDF_INFO = 'sencho-registry-envelope-auths';
const SEAL_VERSION = 1 as const;

export interface SealedAuthsV1 {
  v: typeof SEAL_VERSION;
  epk: string;
  n: string;
  ct: string;
}

export interface SealingKeyPublic {
  publicKeyRaw: Buffer;
  publicKeyBase64: string;
  fingerprint: string;
}

interface LoadedSealingKey extends SealingKeyPublic {
  privateKey: crypto.KeyObject;
}

const ZERO_32 = Buffer.alloc(PUBLIC_KEY_BYTES, 0);

let cached: LoadedSealingKey | null = null;
let cachedKeyPath: string | null = null;

function dataDir(): string {
  return process.env.DATA_DIR || path.join(process.cwd(), 'data');
}

function keyPath(): string {
  return path.join(dataDir(), KEY_FILE_NAME);
}

function selfHealPermissions(filePath: string): void {
  try {
    const mode = fs.statSync(filePath).mode & 0o777;
    if (mode !== 0o600) {
      console.warn(
        `[registryEnvelopeSeal] Fixing permissive key file permissions (was 0o${mode.toString(8)}, set to 0o600)`,
      );
      fs.chmodSync(filePath, 0o600);
    }
  } catch (error) {
    console.warn(
      '[registryEnvelopeSeal] Could not enforce key file permissions (platform may not support chmod):',
      (error as Error).message,
    );
  }
}

type OkpPublicJwk = { x?: string };

function publicKeyRawFromPrivate(privateKey: crypto.KeyObject): Buffer {
  const jwk = privateKey.export({ format: 'jwk' }) as OkpPublicJwk;
  if (typeof jwk.x !== 'string') {
    throw new Error('X25519 private key missing public component');
  }
  const raw = Buffer.from(jwk.x, 'base64url');
  if (raw.length !== PUBLIC_KEY_BYTES) {
    throw new Error('X25519 public key has unexpected length');
  }
  return raw;
}

function publicKeyFromRaw(raw: Buffer): crypto.KeyObject {
  if (raw.length !== PUBLIC_KEY_BYTES) {
    throw new Error('X25519 public key must be 32 bytes');
  }
  if (raw.equals(ZERO_32)) {
    throw new Error('X25519 public key rejected');
  }
  return crypto.createPublicKey({
    key: {
      kty: 'OKP',
      crv: 'X25519',
      x: raw.toString('base64url'),
    },
    format: 'jwk',
  });
}

export function fingerprintOf(publicKeyRaw: Buffer): string {
  if (publicKeyRaw.length !== PUBLIC_KEY_BYTES) {
    throw new Error('X25519 public key must be 32 bytes');
  }
  return crypto.createHash('sha256').update(publicKeyRaw).digest('base64');
}

/**
 * Decode a discover-advertised sealing public key. Returns null when the value
 * is absent; throws a status-less Error when present but invalid so callers
 * report a generic hop failure instead of echoing hostile input.
 */
export function parseSealingKeyBase64(value: unknown): Buffer | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Registry delivery discovery response failed validation');
  }
  // Buffer.from(base64) never throws; reject bad length / non-canonical form below.
  const raw = Buffer.from(value, 'base64');
  if (raw.length !== PUBLIC_KEY_BYTES || raw.toString('base64') !== value) {
    throw new Error('Registry delivery discovery response failed validation');
  }
  if (raw.equals(ZERO_32)) {
    throw new Error('Registry delivery discovery response failed validation');
  }
  return raw;
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}

function isEexist(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'EEXIST';
}

function loadOrCreateKey(): LoadedSealingKey {
  const filePath = keyPath();
  if (cached && cachedKeyPath === filePath) {
    return cached;
  }

  try {
    const pem = fs.readFileSync(filePath, 'utf-8');
    const privateKey = crypto.createPrivateKey(pem);
    selfHealPermissions(filePath);
    return cacheLoadedKey(privateKey, filePath);
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }

  const generated = crypto.generateKeyPairSync('x25519');
  const privateKey = generated.privateKey;
  fs.mkdirSync(dataDir(), { recursive: true });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  try {
    // Exclusive create: if another process wins the race, load their key.
    fs.writeFileSync(filePath, pem, { mode: 0o600, flag: 'wx' });
    return cacheLoadedKey(privateKey, filePath);
  } catch (err) {
    if (!isEexist(err)) throw err;
    const existing = fs.readFileSync(filePath, 'utf-8');
    return cacheLoadedKey(crypto.createPrivateKey(existing), filePath);
  }
}

/** Load an existing keypair; never create. Used by openAuths so a missing key fails closed. */
function loadExistingKey(): LoadedSealingKey {
  const filePath = keyPath();
  if (cached && cachedKeyPath === filePath) {
    return cached;
  }
  try {
    const pem = fs.readFileSync(filePath, 'utf-8');
    const privateKey = crypto.createPrivateKey(pem);
    selfHealPermissions(filePath);
    return cacheLoadedKey(privateKey, filePath);
  } catch (err) {
    if (isEnoent(err)) {
      throw new Error('Registry sealing key not found');
    }
    throw err;
  }
}

function cacheLoadedKey(privateKey: crypto.KeyObject, filePath: string): LoadedSealingKey {
  if (privateKey.asymmetricKeyType !== 'x25519') {
    throw new Error('Registry sealing key is not X25519');
  }

  const publicKeyRaw = publicKeyRawFromPrivate(privateKey);
  const loaded: LoadedSealingKey = {
    privateKey,
    publicKeyRaw,
    publicKeyBase64: publicKeyRaw.toString('base64'),
    fingerprint: fingerprintOf(publicKeyRaw),
  };
  cached = loaded;
  cachedKeyPath = filePath;
  return loaded;
}

/** This instance's sealing key when it exists; never creates one. */
export function getExistingSealingKey(): SealingKeyPublic | null {
  try {
    const loaded = loadExistingKey();
    return {
      publicKeyRaw: Buffer.from(loaded.publicKeyRaw),
      publicKeyBase64: loaded.publicKeyBase64,
      fingerprint: loaded.fingerprint,
    };
  } catch (err) {
    if (err instanceof Error && err.message === 'Registry sealing key not found') return null;
    throw err;
  }
}

/** Lazily generate or load the target sealing keypair from DATA_DIR. */
export function getOrCreateSealingKey(): SealingKeyPublic {
  const loaded = loadOrCreateKey();
  return {
    publicKeyRaw: Buffer.from(loaded.publicKeyRaw),
    publicKeyBase64: loaded.publicKeyBase64,
    fingerprint: loaded.fingerprint,
  };
}

/** HKDF salt and info that separate one sealing purpose's keys from another's. */
export interface EnvelopeDerivation {
  salt: string;
  info: string;
}

const REGISTRY_DERIVATION: EnvelopeDerivation = { salt: HKDF_SALT, info: HKDF_INFO };

function deriveAesKey(ikm: Buffer, derivation: EnvelopeDerivation): Buffer {
  if (ikm.length !== PUBLIC_KEY_BYTES || ikm.equals(ZERO_32)) {
    throw new Error('X25519 shared secret rejected');
  }
  return Buffer.from(crypto.hkdfSync('sha256', ikm, derivation.salt, derivation.info, 32));
}

/**
 * Seal `plaintext` to the recipient's X25519 key: ephemeral DH, HKDF-SHA256
 * with the purpose's salt and info, AES-256-GCM bound to `aad`.
 */
export function sealEnvelope(
  recipientPublicKeyRaw: Buffer,
  plaintext: Buffer,
  aad: string,
  derivation: EnvelopeDerivation,
): SealedAuthsV1 {
  const recipient = publicKeyFromRaw(recipientPublicKeyRaw);
  const ephemeral = crypto.generateKeyPairSync('x25519');
  const ikm = crypto.diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: recipient,
  });
  const aesKey = deriveAesKey(ikm, derivation);
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const epkRaw = publicKeyRawFromPrivate(ephemeral.privateKey);
  return {
    v: SEAL_VERSION,
    epk: epkRaw.toString('base64'),
    n: nonce.toString('base64'),
    ct: Buffer.concat([ciphertext, tag]).toString('base64'),
  };
}

export function sealAuths(
  recipientPublicKeyRaw: Buffer,
  auths: RegistryDeliveryAuthEntry[],
  aad: string,
): SealedAuthsV1 {
  return sealEnvelope(recipientPublicKeyRaw, Buffer.from(JSON.stringify(auths), 'utf8'), aad, REGISTRY_DERIVATION);
}

function isSealedAuthsShape(value: unknown): value is SealedAuthsV1 {
  if (typeof value !== 'object' || value === null) return false;
  const raw = value as Record<string, unknown>;
  return raw.v === SEAL_VERSION
    && typeof raw.epk === 'string'
    && typeof raw.n === 'string'
    && typeof raw.ct === 'string';
}

/**
 * Open an envelope sealed to this instance's key with the given derivation.
 * Every failure (bad shape, wrong key, wrong AAD, missing key file) throws an
 * Error carrying `failureMessage` only, so a caller never echoes detail.
 */
export function openEnvelope(
  sealed: unknown,
  aad: string,
  derivation: EnvelopeDerivation,
  failureMessage: string,
): Buffer {
  if (!isSealedAuthsShape(sealed)) {
    throw new Error(failureMessage);
  }

  // Buffer.from(base64) never throws; length / zero-key checks reject bad input.
  const epk = Buffer.from(sealed.epk, 'base64');
  const nonce = Buffer.from(sealed.n, 'base64');
  const ctAndTag = Buffer.from(sealed.ct, 'base64');

  if (
    epk.length !== PUBLIC_KEY_BYTES
    || epk.equals(ZERO_32)
    || nonce.length !== NONCE_BYTES
    || ctAndTag.length <= GCM_TAG_BYTES
  ) {
    throw new Error(failureMessage);
  }

  const ciphertext = ctAndTag.subarray(0, ctAndTag.length - GCM_TAG_BYTES);
  const tag = ctAndTag.subarray(ctAndTag.length - GCM_TAG_BYTES);

  try {
    const local = loadExistingKey();
    const ephemeralPub = publicKeyFromRaw(epk);
    const ikm = crypto.diffieHellman({
      privateKey: local.privateKey,
      publicKey: ephemeralPub,
    });
    const aesKey = deriveAesKey(ikm, derivation);
    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, nonce);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error(failureMessage);
  }
}

export function openAuths(sealed: unknown, aad: string): RegistryDeliveryAuthEntry[] {
  const failure = 'Registry delivery envelope failed to decrypt';
  const plaintext = openEnvelope(sealed, aad, REGISTRY_DERIVATION, failure);
  try {
    return parseAuthEntries(JSON.parse(plaintext.toString('utf8')));
  } catch {
    throw new Error(failure);
  }
}

/**
 * A key derived from this instance's sealing private key for a named use. It
 * never leaves the instance, so a value keyed by it cannot be computed or
 * checked anywhere else.
 */
export function deriveLocalKey(info: string): Buffer {
  const local = loadOrCreateKey();
  const pkcs8 = local.privateKey.export({ type: 'pkcs8', format: 'der' });
  return Buffer.from(crypto.hkdfSync('sha256', pkcs8, 'sencho-local-key-v1', info, 32));
}

/** Validate a plaintext or decrypted auths array; throws on bad shape. */
export function parseAuthEntries(parsed: unknown): RegistryDeliveryAuthEntry[] {
  if (!Array.isArray(parsed)) {
    throw new Error('Registry delivery envelope auths must be an array');
  }
  for (const entry of parsed) {
    if (
      typeof entry !== 'object'
      || entry === null
      || typeof (entry as { host?: unknown }).host !== 'string'
      || typeof (entry as { username?: unknown }).username !== 'string'
      || typeof (entry as { password?: unknown }).password !== 'string'
    ) {
      throw new Error('Registry delivery envelope auths entry is invalid');
    }
  }
  return parsed as RegistryDeliveryAuthEntry[];
}

/** Build the AAD string that binds ciphertext to the delivery operation. */
export function buildSealedAuthsAad(
  deliverySourceId: string,
  jtiT: string,
  prepId: string | undefined,
): string {
  return `sencho-registry-envelope-v1|${deliverySourceId}|${jtiT}|${prepId ?? ''}`;
}

/** Test helper: drop the in-memory key cache so DATA_DIR swaps take effect. */
export function resetSealingKeyCacheForTests(): void {
  cached = null;
  cachedKeyPath = null;
}
