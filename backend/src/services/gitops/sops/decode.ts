import crypto from 'crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const ENC_FIELD_RE = /^ENC\[AES256_GCM,data:([^,]+),iv:([^,]+),tag:([^,]+),type:([^\]]+)\]$/;

export type SopsDecryptErrorCode =
  | 'invalid_ciphertext'
  | 'wrong_identity'
  | 'decrypt_failed';

export class SopsDecryptError extends Error {
  readonly code: SopsDecryptErrorCode;

  constructor(code: SopsDecryptErrorCode, message: string) {
    super(message);
    this.name = 'SopsDecryptError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decryptEncValue(encValue: string, key: Buffer): string {
  const match = ENC_FIELD_RE.exec(encValue);
  if (!match) {
    throw new SopsDecryptError('invalid_ciphertext', 'Malformed encrypted value');
  }
  const [, dataB64, ivB64, tagB64] = match;
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivB64, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

async function unwrapAgeFileKey(encArmored: string, identity: string): Promise<Buffer> {
  const age = await import('age-encryption');
  const d = new age.Decrypter();
  d.addIdentity(identity.trim());
  let decoded: Uint8Array;
  try {
    decoded = age.armor.decode(encArmored.trim());
  } catch {
    decoded = new TextEncoder().encode(encArmored.trim());
  }
  const fileKey = await d.decrypt(decoded);
  if (!(fileKey instanceof Uint8Array) || fileKey.length !== 32) {
    throw new SopsDecryptError('decrypt_failed', 'Age unwrap did not yield a 32-byte data key');
  }
  return Buffer.from(fileKey);
}

function decryptNode(node: unknown, key: Buffer): unknown {
  if (typeof node === 'string') {
    if (ENC_FIELD_RE.test(node)) {
      return decryptEncValue(node, key);
    }
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((item) => decryptNode(item, key));
  }
  if (isRecord(node)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'sops') continue;
      out[k] = decryptNode(v, key);
    }
    return out;
  }
  return node;
}

/**
 * Decrypt an age-only SOPS document using a single age identity string.
 * Returns plaintext file content (YAML without the sops metadata block).
 */
export async function decryptSopsAgeDocument(content: string, identity: string): Promise<string> {
  let doc: unknown;
  try {
    doc = parseYaml(content);
  } catch {
    throw new SopsDecryptError('invalid_ciphertext', 'SOPS document is not valid YAML');
  }
  if (!isRecord(doc) || !isRecord(doc.sops)) {
    throw new SopsDecryptError('invalid_ciphertext', 'SOPS metadata is missing');
  }

  const sopsMeta = doc.sops;
  const ageEntries = sopsMeta.age;
  if (!Array.isArray(ageEntries) || ageEntries.length === 0) {
    throw new SopsDecryptError('invalid_ciphertext', 'No age entries in SOPS metadata');
  }

  let fileKey: Buffer | null = null;
  let lastError: unknown = null;
  for (const entry of ageEntries) {
    if (!isRecord(entry) || typeof entry.enc !== 'string') continue;
    try {
      fileKey = await unwrapAgeFileKey(entry.enc, identity);
      break;
    } catch (err) {
      lastError = err;
      if (err instanceof SopsDecryptError && err.code === 'decrypt_failed') {
        throw err;
      }
    }
  }

  if (!fileKey) {
    if (lastError instanceof SopsDecryptError) throw lastError;
    throw new SopsDecryptError('wrong_identity', 'No matching age identity for this file');
  }

  const plaintextDoc = decryptNode(doc, fileKey);
  if (typeof plaintextDoc === 'string') {
    return plaintextDoc;
  }
  return stringifyYaml(plaintextDoc).replace(/\n$/, '') + '\n';
}
