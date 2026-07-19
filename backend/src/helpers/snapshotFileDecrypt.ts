import { CryptoService } from '../services/CryptoService';
import { getErrorMessage } from '../utils/errors';
import { sanitizeForLog } from '../utils/safeLog';

const ENCRYPTED_PREFIX = 'enc:';
const HEX_RE = /^[0-9a-fA-F]+$/;
/**
 * Producer envelopes are at least an IV worth of hex (24) plus delimiters /
 * ciphertext. Genuine legacy prose such as enc:hello is much shorter.
 */
const MIN_ENVELOPE_LIKE_LENGTH = 24;
/** Damaged encrypt() payloads remain mostly hex even after a one-byte mutation. */
const ENVELOPE_HEX_DENSITY = 0.75;

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

function hexDensity(payload: string): number {
    if (payload.length === 0) return 0;
    const hexChars = payload.match(/[0-9a-fA-F]/g)?.length ?? 0;
    return hexChars / payload.length;
}

/**
 * True when the payload still looks like CryptoService.encrypt output after
 * truncation or one-byte field/delimiter corruption (high length + hex density),
 * or is pure hex of any length.
 */
export function isEnvelopeShapedPayload(payload: string): boolean {
    if (payload === '') return true;
    if (HEX_RE.test(payload)) return true;
    return payload.length >= MIN_ENVELOPE_LIKE_LENGTH && hexDensity(payload) >= ENVELOPE_HEX_DENSITY;
}

/**
 * Non-envelope legacy plaintext that happens to start with enc:.
 * Any non-empty payload that is not encryption-shaped is preserved verbatim
 * (SEN-213). Envelope-shaped damage never qualifies, even with = or whitespace.
 */
export function isClearlyLegacyEncProse(value: string): boolean {
    if (!value.startsWith(ENCRYPTED_PREFIX)) return false;
    const payload = value.slice(ENCRYPTED_PREFIX.length);
    if (payload === '') return false;
    return !isEnvelopeShapedPayload(payload);
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
