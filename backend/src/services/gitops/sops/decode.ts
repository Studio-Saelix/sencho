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

async function unwrapMatchingAgeFileKey(encodings: string[], identity: string): Promise<Buffer> {
  let lastError: unknown = null;
  for (const enc of encodings) {
    try {
      return await unwrapAgeFileKey(enc, identity);
    } catch (err) {
      lastError = err;
      if (err instanceof SopsDecryptError && err.code === 'decrypt_failed') {
        throw err;
      }
    }
  }
  if (lastError instanceof SopsDecryptError) throw lastError;
  throw new SopsDecryptError('wrong_identity', 'No matching age identity for this file');
}

function withTrailingNewline(text: string): string {
  return text.replace(/\n$/, '') + '\n';
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

function unescapeDotenvValue(raw: string): string {
  let value = raw;
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
}

function parseFlatAgeEntries(content: string): Array<{ recipient: string; enc: string }> {
  const byIndex = new Map<string, { recipient?: string; enc?: string }>();
  const lineRe = /^(?:sops_)?age__list_(\d+)__map_(recipient|enc)\s*=\s*(.*)$/;
  for (const line of content.split(/\r?\n/)) {
    const match = lineRe.exec(line.trim());
    if (!match) continue;
    const entry = byIndex.get(match[1]) ?? {};
    if (match[2] === 'recipient') entry.recipient = unescapeDotenvValue(match[3]).trim();
    else entry.enc = unescapeDotenvValue(match[3]);
    byIndex.set(match[1], entry);
  }
  const out: Array<{ recipient: string; enc: string }> = [];
  for (const entry of byIndex.values()) {
    if (entry.recipient && entry.enc) out.push({ recipient: entry.recipient, enc: entry.enc });
  }
  return out;
}

async function decryptUnstructuredSops(content: string, identity: string): Promise<string> {
  const ageEntries = parseFlatAgeEntries(content);
  if (ageEntries.length === 0) {
    throw new SopsDecryptError('invalid_ciphertext', 'SOPS metadata is missing');
  }

  const fileKey = await unwrapMatchingAgeFileKey(ageEntries.map((entry) => entry.enc), identity);

  const lines: string[] = [];
  let inSopsSection = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (/^\[sops(?:\.[^\]]+)?\]$/i.test(trimmed)) {
      inSopsSection = true;
      continue;
    }
    if (inSopsSection) {
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) inSopsSection = false;
      else continue;
    }
    if (/^(?:sops_|age__list_)/.test(trimmed)) continue;
    const eq = rawLine.indexOf('=');
    if (eq <= 0) {
      if (rawLine.length > 0) lines.push(rawLine);
      continue;
    }
    const key = rawLine.slice(0, eq).trimEnd();
    const value = unescapeDotenvValue(rawLine.slice(eq + 1).trim());
    if (ENC_FIELD_RE.test(value)) {
      lines.push(`${key}=${decryptEncValue(value, fileKey)}`);
    } else {
      lines.push(rawLine);
    }
  }
  return withTrailingNewline(lines.join('\n'));
}

/**
 * Decrypt an age-only SOPS document using a single age identity string.
 * Returns plaintext file content (YAML without the sops metadata block, or
 * dotenv/INI without flattened sops_* keys).
 */
export async function decryptSopsAgeDocument(content: string, identity: string): Promise<string> {
  let doc: unknown;
  try {
    doc = parseYaml(content);
  } catch {
    return decryptUnstructuredSops(content, identity);
  }
  if (!isRecord(doc) || !isRecord(doc.sops)) {
    return decryptUnstructuredSops(content, identity);
  }

  const sopsMeta = doc.sops;
  const ageEntries = sopsMeta.age;
  if (!Array.isArray(ageEntries) || ageEntries.length === 0) {
    throw new SopsDecryptError('invalid_ciphertext', 'No age entries in SOPS metadata');
  }

  const encodings: string[] = [];
  for (const entry of ageEntries) {
    if (isRecord(entry) && typeof entry.enc === 'string') encodings.push(entry.enc);
  }
  const fileKey = await unwrapMatchingAgeFileKey(encodings, identity);

  const plaintextDoc = decryptNode(doc, fileKey);
  if (typeof plaintextDoc === 'string') {
    return plaintextDoc;
  }
  return withTrailingNewline(stringifyYaml(plaintextDoc));
}
