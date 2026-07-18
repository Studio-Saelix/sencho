import { CryptoService } from '../services/CryptoService';
import { getErrorMessage } from '../utils/errors';
import { sanitizeForLog } from '../utils/safeLog';

const ENCRYPTED_PREFIX = 'enc:';
const HEX_RE = /^[0-9a-fA-F]+$/;
const HEX_OR_COLON_RE = /^[0-9a-fA-F:]+$/;

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

function isHexIsh(value: string): boolean {
    if (value.length === 0) return false;
    const hexChars = value.match(/[0-9a-fA-F]/g)?.length ?? 0;
    return hexChars / value.length >= 0.8;
}

/**
 * Detectable producer-envelope damage family (no DB provenance). Values that
 * look like CryptoService.encrypt output after truncation or field corruption
 * must fail closed. Clearly non-envelope enc: prose is not included here.
 */
export function isEnvelopeLikeDamage(value: string): boolean {
    if (!value.startsWith(ENCRYPTED_PREFIX)) return false;
    const payload = value.slice(ENCRYPTED_PREFIX.length);

    // Complete truncation to "enc:"
    if (payload === '') return true;

    // Hex-only of any length (short or long truncated IV with lost delimiters)
    if (HEX_RE.test(payload)) return true;

    // Hex and colon only with at least one delimiter
    if (HEX_OR_COLON_RE.test(payload) && payload.includes(':')) return true;

    const parts = payload.split(':');

    // Three-field producer skeleton with possible non-hex damage in any field
    if (parts.length === 3) {
        const hexishCount = parts.filter(isHexIsh).length;
        if (hexishCount >= 2) return true;
    }

    // Two fields: IV-shaped first + mostly-hex remainder (merged tag/cipher)
    if (parts.length === 2) {
        const [first, second] = parts;
        if (HEX_RE.test(first) && first.length <= 24 && isHexIsh(second)) return true;
    }

    return false;
}

export type SnapshotContentClass =
    | { kind: 'usable'; content: string }
    | { kind: 'unavailable'; reason: 'decrypt_failed' | 'envelope_damage'; detail?: string };

/**
 * Classify a stored snapshot file body. Perfect provenance is impossible
 * without a schema marker; this covers the detectable family in
 * isEnvelopeLikeDamage only.
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

    if (isEnvelopeLikeDamage(raw)) {
        return { kind: 'unavailable', reason: 'envelope_damage' };
    }

    // Clearly non-envelope legacy plaintext beginning with enc:
    return { kind: 'usable', content: raw };
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
