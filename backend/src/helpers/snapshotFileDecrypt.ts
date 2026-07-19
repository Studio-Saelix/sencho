import { CryptoService } from '../services/CryptoService';
import { getErrorMessage } from '../utils/errors';
import { sanitizeForLog } from '../utils/safeLog';

const ENCRYPTED_PREFIX = 'enc:';
const HEX_RE = /^[0-9a-fA-F]+$/;
/** Identifier-like legacy body after enc: (e.g. enc:hello, enc:FOO_BAR). */
const LEGACY_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Database row shape for fleet_snapshot_files (content still ciphertext or legacy plaintext). */
export interface SnapshotFileRow {
    node_id: number;
    node_name: string;
    stack_name: string;
    filename: string;
    content: string;
}

type SnapshotFileMeta = Omit<SnapshotFileRow, 'content'>;

/**
 * Decrypted snapshot file read result. Unavailable rows carry no content so
 * callers cannot accidentally forward a placeholder into restore or archives.
 */
export type SnapshotFileReadResult =
    | (SnapshotFileMeta & { available: true; content: string })
    | (SnapshotFileMeta & { available: false });

export type AvailableSnapshotFile = Extract<SnapshotFileReadResult, { available: true }>;

export function isAvailableSnapshotFile(file: SnapshotFileReadResult): file is AvailableSnapshotFile {
    return file.available;
}

export function isStructurallyValidSnapshotEnvelope(value: string): boolean {
    if (!value.startsWith(ENCRYPTED_PREFIX)) return false;
    const parts = value.slice(ENCRYPTED_PREFIX.length).split(':');
    if (parts.length !== 3) return false;
    const [ivHex, authTagHex, encryptedHex] = parts;
    return (
        HEX_RE.test(ivHex) && ivHex.length === 24 &&
        HEX_RE.test(authTagHex) && authTagHex.length === 32 &&
        !!encryptedHex && encryptedHex.length % 2 === 0 && HEX_RE.test(encryptedHex)
    );
}

/**
 * Clear non-envelope legacy plaintext that happens to start with enc:.
 * Only these shapes stay usable when the payload is not a valid envelope.
 * Everything else with an enc: prefix fails closed as envelope damage.
 */
export function isClearlyLegacyEncProse(value: string): boolean {
    if (!value.startsWith(ENCRYPTED_PREFIX)) return false;
    const payload = value.slice(ENCRYPTED_PREFIX.length);
    if (payload === '') return false;

    // Env-style or free text (spaces) cannot be a producer envelope.
    if (payload.includes('=') || /\s/.test(payload)) return true;

    // Identifier body with no colons (enc:hello, enc:FOO_BAR). Pure hex
    // strings are producer truncations, not legacy prose.
    if (LEGACY_IDENT_RE.test(payload) && !HEX_RE.test(payload)) return true;

    return false;
}

/**
 * Producer-envelope damage (no DB provenance). Any enc: payload that is not
 * a structurally valid envelope and not clearly legacy prose is treated as
 * damage so delimiter substitution and similar corruption cannot fall through
 * as writable plaintext.
 */
export function isEnvelopeLikeDamage(value: string): boolean {
    if (!value.startsWith(ENCRYPTED_PREFIX)) return false;
    if (isStructurallyValidSnapshotEnvelope(value)) return false;
    if (isClearlyLegacyEncProse(value)) return false;
    return true;
}

export type SnapshotContentClass =
    | { kind: 'usable'; content: string }
    | { kind: 'unavailable'; reason: 'decrypt_failed' | 'envelope_damage'; detail?: string };

/**
 * Classify a stored snapshot file body. Without a provenance marker, enc:
 * values that are not valid envelopes and not clearly legacy prose fail closed.
 */
export function classifySnapshotFileContent(raw: string): SnapshotContentClass {
    if (!raw.startsWith(ENCRYPTED_PREFIX)) {
        return { kind: 'usable', content: raw };
    }

    if (isStructurallyValidSnapshotEnvelope(raw)) {
        try {
            return { kind: 'usable', content: CryptoService.getInstance().decrypt(raw) };
        } catch (err) {
            return {
                kind: 'unavailable',
                reason: 'decrypt_failed',
                detail: getErrorMessage(err, 'decrypt failed'),
            };
        }
    }

    if (isClearlyLegacyEncProse(raw)) {
        return { kind: 'usable', content: raw };
    }

    return { kind: 'unavailable', reason: 'envelope_damage' };
}

export function readSnapshotFileRow(
    row: SnapshotFileRow,
    snapshotId: number,
): SnapshotFileReadResult {
    const { content: raw, ...meta } = row;
    const classified = classifySnapshotFileContent(raw);

    if (classified.kind === 'usable') {
        return { ...meta, available: true, content: classified.content };
    }

    const reasonText = classified.detail
        ? `${classified.reason}: ${classified.detail}`
        : classified.reason;
    console.error(
        `[snapshotFileDecrypt] Failed to decrypt snapshot file ` +
            `snapshot=${sanitizeForLog(snapshotId)} ` +
            `node=${sanitizeForLog(meta.node_id)} ` +
            `stack=${sanitizeForLog(meta.stack_name)} ` +
            `file=${sanitizeForLog(meta.filename)}: ${reasonText}`,
    );
    return { ...meta, available: false };
}
