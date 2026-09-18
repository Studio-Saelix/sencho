import { parse as parseYaml } from 'yaml';

const UNSUPPORTED_SOPS_BACKENDS = [
  'kms',
  'gcp_kms',
  'azure_kv',
  'hc_vault',
  'vault_kv',
  'pgp',
] as const;

const ENC_VALUE_RE = /^ENC\[AES256_GCM,data:/;
const ENC_SUBSTRING = 'ENC[AES256_GCM,data:';

export type SopsDetectionResult =
  | { kind: 'none' }
  | { kind: 'sops-age'; recipients: string[] }
  | { kind: 'sops-unsupported'; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectAgeRecipients(sopsMeta: Record<string, unknown>): string[] {
  const age = sopsMeta.age;
  if (!Array.isArray(age)) return [];
  const recipients: string[] = [];
  for (const entry of age) {
    if (!isRecord(entry)) continue;
    const recipient = entry.recipient;
    if (typeof recipient === 'string' && recipient.startsWith('age1')) {
      recipients.push(recipient);
    }
  }
  return recipients;
}

function hasUnsupportedBackend(sopsMeta: Record<string, unknown>): string | null {
  for (const backend of UNSUPPORTED_SOPS_BACKENDS) {
    const value = sopsMeta[backend];
    if (value !== undefined && value !== null) {
      if (Array.isArray(value) && value.length === 0) continue;
      return backend;
    }
  }
  return null;
}

function documentHasEncValues(node: unknown): boolean {
  if (typeof node === 'string') {
    return ENC_VALUE_RE.test(node);
  }
  if (Array.isArray(node)) {
    return node.some((item) => documentHasEncValues(item));
  }
  if (isRecord(node)) {
    if ('sops' in node) {
      const copy = { ...node };
      delete copy.sops;
      return documentHasEncValues(copy);
    }
    return Object.values(node).some((value) => documentHasEncValues(value));
  }
  return false;
}

function collectFlatAgeRecipients(content: string): string[] {
  const re = /^(?:sops_)?age__list_\d+__map_recipient\s*=\s*(age1[0-9a-z]+)\s*$/gim;
  return [...new Set([...content.matchAll(re)].map((match) => match[1]))];
}

/**
 * Detect SOPS dotenv/INI stores: flattened `sops_*` / `age__list_*` keys, a
 * `[sops]` section, or ENC[AES256_GCM,data: values. Returns null when none of
 * those markers are present. ENC values without metadata are unsupported, not plaintext.
 */
function detectUnstructuredSops(content: string): SopsDetectionResult | null {
  const hasFlatMeta = /^(?:sops_(?:mac|version|lastmodified|unencrypted_suffix|encrypted_regex|age__)|\[sops])/im.test(content);
  const hasEnc = content.includes(ENC_SUBSTRING);
  if (!hasFlatMeta && !hasEnc) return null;

  const unsupported = /^(?:sops_)?(kms|gcp_kms|azure_kv|hc_vault|vault_kv|pgp)(?:__list_|\s*=)/im.exec(content);
  if (unsupported) {
    return { kind: 'sops-unsupported', reason: `unsupported_backend:${unsupported[1]}` };
  }

  const recipients = collectFlatAgeRecipients(content);
  if (recipients.length > 0) {
    return { kind: 'sops-age', recipients };
  }
  if (hasFlatMeta) {
    return { kind: 'sops-unsupported', reason: 'no_age_recipients' };
  }
  return { kind: 'sops-unsupported', reason: 'encrypted_values_without_sops_metadata' };
}

function classifyYamlSopsRecord(sopsMeta: Record<string, unknown>): SopsDetectionResult {
  if (typeof sopsMeta.mac !== 'string' || sopsMeta.mac.length === 0) {
    return { kind: 'sops-unsupported', reason: 'missing_sops_mac' };
  }

  const unsupported = hasUnsupportedBackend(sopsMeta);
  if (unsupported) {
    return { kind: 'sops-unsupported', reason: `unsupported_backend:${unsupported}` };
  }

  const recipients = collectAgeRecipients(sopsMeta);
  if (recipients.length === 0) {
    return { kind: 'sops-unsupported', reason: 'no_age_recipients' };
  }

  return { kind: 'sops-age', recipients: [...new Set(recipients)] };
}

/**
 * Classify file bytes as plaintext, age-only SOPS, or unsupported SOPS.
 * Does not decrypt or execute plugins. YAML documents with a `sops:` map and
 * dotenv/INI stores that flatten age recipients are both recognized.
 */
export function detectSopsContent(content: string): SopsDetectionResult {
  const trimmed = content.trim();
  if (!trimmed) return { kind: 'none' };

  const unstructured = detectUnstructuredSops(trimmed);

  let doc: unknown;
  try {
    doc = parseYaml(trimmed);
  } catch {
    if (unstructured) return unstructured;
    if (trimmed.includes('sops:') || trimmed.includes('"sops"')) {
      return { kind: 'sops-unsupported', reason: 'invalid_sops_document' };
    }
    return { kind: 'none' };
  }

  if (isRecord(doc) && isRecord(doc.sops)) {
    return classifyYamlSopsRecord(doc.sops);
  }

  if (unstructured) return unstructured;

  if (documentHasEncValues(doc)) {
    return { kind: 'sops-unsupported', reason: 'encrypted_values_without_sops_metadata' };
  }
  return { kind: 'none' };
}

export function isComposePrimaryPath(role: string): boolean {
  return role === 'compose-primary' || role === 'compose-additional' || role === 'compose-override';
}
