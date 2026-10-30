/**
 * Off-site snapshot archive envelope and tar walk.
 *
 * Layout, fixed bytes:
 *   magic    6  ASCII "SCENC1"
 *   version  1  u8 = 1
 *   salt    16
 *   iv      12
 *   ciphertext
 *   tag     16  AES-256-GCM, appended after the ciphertext
 *
 * The key is scrypt(passphrase, salt, N=2^15, r=8, p=1, 32 bytes).
 * The plaintext is the gzip tar CloudBackupService already builds.
 * Detection is the magic bytes. A gzip object without them stays plaintext.
 */
import crypto from 'crypto';
import { Readable, Transform } from 'stream';
import * as zlib from 'zlib';
import * as tar from 'tar-stream';
import type { ExtractEvents, Header } from 'tar-stream';
import {
    FLEET_SNAPSHOT_APPLY_FILENAMES,
    MAX_SNAPSHOT_FILE_BYTES,
} from '../utils/snapshot-capture';

const MAGIC = Buffer.from('SCENC1');
const VERSION = 1;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + 1 + SALT_LEN + IV_LEN;
const KEY_LEN = 32;
/** Bytes the seal adds to the plaintext object: header plus auth tag. */
export const ARCHIVE_ENVELOPE_OVERHEAD_BYTES = HEADER_LEN + TAG_LEN;
const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const SUPPORTED_ARCHIVE_VERSIONS = new Set([1, 2]);

export const MIN_PASSPHRASE_LENGTH = 12;
export const MAX_ARCHIVE_OBJECT_BYTES = 32 * 1024 * 1024;
/**
 * Entry ceiling. Two files per stack plus metadata and documentation, so this
 * covers roughly 2,500 captured stacks. The upload path enforces the same
 * number before it publishes anything, so a successful upload is always an
 * archive the importer accepts.
 */
export const MAX_ARCHIVE_ENTRIES = 5000;
export const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
/**
 * Aggregate documentation is one tar entry holding every stack's dossier
 * notes, so it needs its own bound instead of the per-Compose-file ceiling.
 */
export const MAX_ARCHIVE_DOCUMENTATION_BYTES = 8 * 1024 * 1024;
export const MAX_ARCHIVE_METADATA_BYTES = 1024 * 1024;
/**
 * Decompressed-tar ceiling. Tar headers and PAX records sit outside the file
 * payloads: at the 5,000-entry cap with long node names they add roughly
 * 10 MB, so the reader accepts the 64 MB payload bound plus this framing
 * allowance. The producer measures the tar it actually packed against the same
 * value, so a published archive is always one the importer accepts.
 */
const ARCHIVE_FRAMING_ALLOWANCE_BYTES = 8 * 1024 * 1024;

const FILE_NAMES = new Set<string>(FLEET_SNAPSHOT_APPLY_FILENAMES);

export type ArchiveErrorCode =
    | 'PASSPHRASE_REQUIRED'
    | 'INVALID_PASSPHRASE'
    | 'BAD_ARCHIVE'
    | 'TOO_LARGE'
    | 'INVALID_ENTRY_NAME';

export class ArchiveFormatError extends Error {
    readonly code: ArchiveErrorCode;

    constructor(code: ArchiveErrorCode, message: string) {
        super(message);
        this.name = 'ArchiveFormatError';
        this.code = code;
    }
}

export interface ArchiveLimits {
    maxObjectBytes: number;
    maxEntries: number;
    maxEntryBytes: number;
    maxDocumentationBytes: number;
    maxMetadataBytes: number;
    maxUncompressedBytes: number;
    /** Decompressed tar size the reader accepts: payloads plus framing. */
    maxTarBytes: number;
}

export const ARCHIVE_LIMITS: ArchiveLimits = {
    maxObjectBytes: MAX_ARCHIVE_OBJECT_BYTES,
    maxEntries: MAX_ARCHIVE_ENTRIES,
    maxEntryBytes: MAX_SNAPSHOT_FILE_BYTES,
    maxDocumentationBytes: MAX_ARCHIVE_DOCUMENTATION_BYTES,
    maxMetadataBytes: MAX_ARCHIVE_METADATA_BYTES,
    maxUncompressedBytes: MAX_ARCHIVE_UNCOMPRESSED_BYTES,
    maxTarBytes: MAX_ARCHIVE_UNCOMPRESSED_BYTES + ARCHIVE_FRAMING_ALLOWANCE_BYTES,
};

export interface ImportedSnapshotFile {
    nodeId: number;
    nodeName: string;
    stackName: string;
    filename: string;
    content: string;
}

export interface ImportedSnapshot {
    description: string;
    createdBy: string;
    createdAt: number;
    skippedNodes: string;
    skippedStacks: string;
    documentation: string;
    nodeCount: number;
    stackCount: number;
    /** Instance that captured the archive; null when the archive cannot say. */
    sourceInstanceId: string | null;
    /** False when the archive predates partial-capture warnings, so an empty
     *  skipped-stack list means "not recorded", not "nothing was skipped". */
    warningsKnown: boolean;
    files: ImportedSnapshotFile[];
}

/** What an archive would contain, checked against the reader's limits. */
export interface ArchiveSizePlan {
    metadataBytes: number;
    documentationBytes: number;
    fileBytes: number[];
}

export function isEncryptedArchive(bytes: Buffer): boolean {
    return bytes.length >= MAGIC.length && bytes.subarray(0, MAGIC.length).equals(MAGIC);
}

export function passphraseIsLongEnough(passphrase: string): boolean {
    return passphrase.length >= MIN_PASSPHRASE_LENGTH;
}

export async function encryptArchive(plaintext: Buffer, passphrase: string): Promise<Buffer> {
    return sealArchive(plaintext, passphrase, crypto.randomBytes(SALT_LEN), crypto.randomBytes(IV_LEN));
}

/** Deterministic seal used by the format vector. Production uploads use encryptArchive. */
export async function sealArchive(plaintext: Buffer, passphrase: string, salt: Buffer, iv: Buffer): Promise<Buffer> {
    if (salt.length !== SALT_LEN || iv.length !== IV_LEN) {
        throw new ArchiveFormatError('BAD_ARCHIVE', 'Archive seal parameters are the wrong length');
    }
    const key = await deriveKey(passphrase, salt);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([MAGIC, Buffer.from([VERSION]), salt, iv, ciphertext, tag]);
}

export async function decryptArchive(blob: Buffer, passphrase: string): Promise<Buffer> {
    if (!isEncryptedArchive(blob) || blob.length < HEADER_LEN + TAG_LEN) {
        throw new ArchiveFormatError('BAD_ARCHIVE', 'Archive header is incomplete');
    }
    if (blob[MAGIC.length] !== VERSION) {
        throw new ArchiveFormatError('BAD_ARCHIVE', 'Archive version is not supported');
    }
    const salt = blob.subarray(MAGIC.length + 1, MAGIC.length + 1 + SALT_LEN);
    const iv = blob.subarray(HEADER_LEN - IV_LEN, HEADER_LEN);
    const tag = blob.subarray(blob.length - TAG_LEN);
    const ciphertext = blob.subarray(HEADER_LEN, blob.length - TAG_LEN);
    const key = await deriveKey(passphrase, salt);
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (err) {
        const authFailure = err instanceof Error && /authenticate data/i.test(err.message);
        if (authFailure) {
            throw new ArchiveFormatError('INVALID_PASSPHRASE', 'Passphrase is incorrect');
        }
        throw new ArchiveFormatError('BAD_ARCHIVE', 'Archive could not be decrypted');
    }
}

export async function openSnapshotArchive(
    objectBytes: Buffer,
    passphrase: string | null,
    limits: ArchiveLimits = ARCHIVE_LIMITS,
): Promise<ImportedSnapshot> {
    if (objectBytes.length > limits.maxObjectBytes) {
        throw new ArchiveFormatError('TOO_LARGE', 'Archive is larger than the import limit');
    }
    const gzipBytes = await plaintextGzip(objectBytes, passphrase);
    const tarBytes = await gunzipLimited(gzipBytes, limits.maxTarBytes);
    const entries = await readTarEntries(tarBytes, limits);
    return snapshotFromEntries(entries);
}

/**
 * Producer-side check. An upload the recovery path necessarily rejects is not
 * a backup, so the upload path refuses it with the same TOO_LARGE code and
 * bound the importer would report. Both sides read the limits above, so they
 * cannot drift apart.
 */
export function assertArchiveFitsLimits(plan: ArchiveSizePlan, limits: ArchiveLimits = ARCHIVE_LIMITS): void {
    const entryCount = plan.fileBytes.length + 1 + (plan.documentationBytes > 0 ? 1 : 0);
    if (entryCount > limits.maxEntries) {
        throw new ArchiveFormatError(
            'TOO_LARGE',
            `Archive would have ${entryCount} entries, above the ${limits.maxEntries}-entry recovery limit`,
        );
    }
    if (plan.metadataBytes > limits.maxMetadataBytes) {
        throw new ArchiveFormatError('TOO_LARGE', 'Archive metadata is larger than the recovery limit');
    }
    if (plan.documentationBytes > limits.maxDocumentationBytes) {
        throw new ArchiveFormatError(
            'TOO_LARGE',
            `Snapshot documentation is ${formatMiB(plan.documentationBytes)}, above the ${formatMiB(limits.maxDocumentationBytes)} recovery limit`,
        );
    }
    for (const bytes of plan.fileBytes) {
        if (bytes > limits.maxEntryBytes) {
            throw new ArchiveFormatError(
                'TOO_LARGE',
                `A captured file is ${formatMiB(bytes)}, above the ${formatMiB(limits.maxEntryBytes)} per-file recovery limit`,
            );
        }
    }
    const total = plan.metadataBytes + plan.documentationBytes + plan.fileBytes.reduce((sum, bytes) => sum + bytes, 0);
    if (total > limits.maxUncompressedBytes) {
        throw new ArchiveFormatError(
            'TOO_LARGE',
            `Archive would expand to ${formatMiB(total)}, above the ${formatMiB(limits.maxUncompressedBytes)} recovery limit`,
        );
    }
}

/** Refuses an upload whose compressed object the importer would reject. */
export function assertArchiveObjectSize(bytes: number, limits: ArchiveLimits = ARCHIVE_LIMITS): void {
    if (bytes > limits.maxObjectBytes) {
        throw new ArchiveFormatError(
            'TOO_LARGE',
            `Archive is ${formatMiB(bytes)}, above the ${formatMiB(limits.maxObjectBytes)} upload limit`,
        );
    }
}

export interface ArchiveEntryPlan {
    name: string;
    content: string | Buffer;
}

/**
 * True when a string survives the tar writer byte-for-byte. The writer stores a
 * header name as NUL-terminated UTF-8, so an embedded NUL truncates the name
 * and an unpaired surrogate is replaced with U+FFFD. Either one makes the
 * stored entry differ from the planned one, which the importer then rejects.
 */
export function isArchiveStorableName(name: string): boolean {
    if (name.includes('\u0000')) return false;
    return Buffer.from(name, 'utf8').toString('utf8') === name;
}

/**
 * Refuse a plan the importer would reject before anything is packed or
 * published. The reader owns the name allowlist, so the producer checks its
 * own output with the same function instead of a second copy of the rules.
 */
function assertPublishableEntries(entries: ArchiveEntryPlan[]): void {
    for (const entry of entries) {
        if (isArchiveStorableName(entry.name) && isAllowedEntryName(entry.name)) continue;
        throw new ArchiveFormatError(
            'INVALID_ENTRY_NAME',
            `Archive entry ${JSON.stringify(entry.name)} cannot be stored in the archive format the import path reads. Rename the node or stack and upload again.`,
        );
    }
}

/**
 * Pack and compress the archive an upload publishes, then refuse it when the
 * reader would reject it. Entry names are checked against the same allowlist
 * and byte-fidelity rules the reader applies, so a stored object is always one
 * the import path can open. The tar is metered as it is produced rather than
 * estimated from the payloads: PAX headers for long entry paths are real bytes
 * the reader counts, and a payload-only estimate let a successful upload be an
 * archive the importer refuses. Metering during the stream also stops an
 * outsized entry path before it is buffered in memory.
 */
export async function packSnapshotArchive(
    entries: ArchiveEntryPlan[],
    limits: ArchiveLimits = ARCHIVE_LIMITS,
): Promise<Buffer> {
    assertPublishableEntries(entries);
    const pack = tar.pack();
    for (const entry of entries) pack.entry({ name: entry.name }, entry.content);
    pack.finalize();

    const gzip = zlib.createGzip();
    const chunks: Buffer[] = [];
    let tarBytes = 0;
    const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            tarBytes += chunk.byteLength;
            if (tarBytes > limits.maxTarBytes) {
                callback(new ArchiveFormatError(
                    'TOO_LARGE',
                    `Archive would expand past the ${formatMiB(limits.maxTarBytes)} recovery limit`,
                ));
                return;
            }
            callback(null, chunk);
        },
    });

    return new Promise<Buffer>((resolve, reject) => {
        let settled = false;
        const fail = (error: Error): void => {
            if (settled) return;
            settled = true;
            pack.destroy();
            gzip.destroy();
            reject(error);
        };
        gzip.on('data', (chunk: Buffer) => chunks.push(chunk));
        gzip.on('end', () => {
            if (settled) return;
            settled = true;
            try {
                const archive = Buffer.concat(chunks);
                assertArchiveObjectSize(archive.byteLength, limits);
                resolve(archive);
            } catch (error) {
                reject(error);
            }
        });
        gzip.on('error', fail);
        pack.on('error', fail);
        meter.on('error', fail);
        pack.pipe(meter).pipe(gzip);
    });
}

function formatMiB(bytes: number): string {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function plaintextGzip(objectBytes: Buffer, passphrase: string | null): Promise<Buffer> {
    if (!isEncryptedArchive(objectBytes)) return objectBytes;
    if (!passphrase) {
        throw new ArchiveFormatError('PASSPHRASE_REQUIRED', 'A passphrase is required to read this archive');
    }
    return decryptArchive(objectBytes, passphrase);
}

function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        crypto.scrypt(passphrase, salt, KEY_LEN, {
            N: SCRYPT_N,
            r: SCRYPT_R,
            p: SCRYPT_P,
            maxmem: SCRYPT_MAXMEM,
        }, (err, key) => {
            if (err) reject(err);
            else resolve(key);
        });
    });
}

function gunzipLimited(input: Buffer, maxOut: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const gunzip = zlib.createGunzip();
        const chunks: Buffer[] = [];
        let total = 0;
        let failed = false;
        const fail = (err: Error) => {
            if (failed) return;
            failed = true;
            gunzip.destroy();
            reject(err);
        };
        gunzip.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > maxOut) {
                fail(new ArchiveFormatError('TOO_LARGE', 'Archive expands past the size limit'));
                return;
            }
            chunks.push(chunk);
        });
        gunzip.on('end', () => {
            if (!failed) resolve(Buffer.concat(chunks));
        });
        gunzip.on('error', (err: Error) => {
            if (err instanceof ArchiveFormatError) fail(err);
            else fail(new ArchiveFormatError('BAD_ARCHIVE', 'Archive is not a valid gzip file'));
        });
        gunzip.end(input);
    });
}

type EntryStream = ExtractEvents['entry'][1];

function readTarEntries(tarBytes: Buffer, limits: ArchiveLimits): Promise<Map<string, Buffer>> {
    return new Promise((resolve, reject) => {
        const extract = tar.extract();
        const entries = new Map<string, Buffer>();
        let settled = false;
        let used = 0;
        const fail = (err: Error) => {
            if (settled) return;
            settled = true;
            extract.destroy();
            reject(err);
        };
        extract.on('entry', (header, stream, next) => {
            void takeEntry(header, stream, limits, used).then((row) => {
                if (settled) return;
                if (entries.has(row.name)) {
                    fail(new ArchiveFormatError('BAD_ARCHIVE', 'Archive contains a duplicate entry'));
                    return;
                }
                if (entries.size >= limits.maxEntries) {
                    fail(new ArchiveFormatError('TOO_LARGE', 'Archive has too many entries'));
                    return;
                }
                used += row.body.length;
                entries.set(row.name, row.body);
                next();
            }).catch((err: unknown) => {
                const error = err instanceof Error ? err : new ArchiveFormatError('BAD_ARCHIVE', 'Archive entry could not be read');
                fail(error);
            });
        });
        extract.on('finish', () => {
            if (settled) return;
            settled = true;
            resolve(entries);
        });
        extract.on('error', () => {
            fail(new ArchiveFormatError('BAD_ARCHIVE', 'Archive is not a valid tar file'));
        });
        Readable.from(tarBytes).pipe(extract);
    });
}

async function takeEntry(
    header: Header,
    stream: EntryStream,
    limits: ArchiveLimits,
    used: number,
): Promise<{ name: string; body: Buffer }> {
    if (header.type && header.type !== 'file') {
        stream.resume();
        throw new ArchiveFormatError('BAD_ARCHIVE', 'Archive contains a non-file entry');
    }
    const name = header.name;
    if (!isAllowedEntryName(name)) {
        stream.resume();
        throw new ArchiveFormatError('BAD_ARCHIVE', 'Archive contains an unexpected entry');
    }
    const entryLimit = entryByteLimit(name, limits);
    const declared = header.size ?? 0;
    if (declared > entryLimit || used + declared > limits.maxUncompressedBytes) {
        stream.resume();
        throw new ArchiveFormatError('TOO_LARGE', 'Archive entry exceeds the size limit');
    }
    const body = await readStream(stream, entryLimit);
    if (used + body.length > limits.maxUncompressedBytes) {
        throw new ArchiveFormatError('TOO_LARGE', 'Archive expands past the size limit');
    }
    return { name, body };
}

/** Aggregate entries carry their own bound; Compose files keep the per-file cap. */
function entryByteLimit(name: string, limits: ArchiveLimits): number {
    if (name === 'metadata.json') return limits.maxMetadataBytes;
    if (name === 'documentation.json') return limits.maxDocumentationBytes;
    return limits.maxEntryBytes;
}

function isAllowedEntryName(name: string): boolean {
    if (name.includes('\\') || name.startsWith('/') || name.split('/').includes('..')) return false;
    if (name === 'metadata.json' || name === 'documentation.json') return true;
    const match = /^nodes\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(name);
    if (!match) return false;
    const [, nodeSeg, stackName, filename] = match;
    if (!stackName || !FILE_NAMES.has(filename)) return false;
    return parseNodeSegment(nodeSeg) !== null;
}

function parseNodeSegment(segment: string): { nodeId: number; nodeName: string } | null {
    const splitAt = segment.indexOf('_');
    if (splitAt <= 0) return null;
    const idStr = segment.slice(0, splitAt);
    const nodeName = segment.slice(splitAt + 1);
    if (!/^[1-9]\d*$/.test(idStr) || !Number.isSafeInteger(Number(idStr))) return null;
    if (nodeName.length === 0) return null;
    return { nodeId: Number(idStr), nodeName };
}

function toBuffer(data: unknown): Buffer | null {
    if (Buffer.isBuffer(data)) return data;
    if (data instanceof Uint8Array) return Buffer.from(data);
    if (typeof data === 'string') return Buffer.from(data);
    return null;
}

function readStream(stream: EntryStream, maxBytes: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        stream.on('data', (data: unknown) => {
            const buf = toBuffer(data);
            if (!buf) {
                stream.destroy();
                reject(new ArchiveFormatError('BAD_ARCHIVE', 'Archive entry could not be read'));
                return;
            }
            total += buf.length;
            if (total > maxBytes) {
                stream.destroy();
                reject(new ArchiveFormatError('TOO_LARGE', 'Archive entry exceeds the size limit'));
                return;
            }
            chunks.push(buf);
        });
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', () => reject(new ArchiveFormatError('BAD_ARCHIVE', 'Archive entry could not be read')));
    });
}

function snapshotFromEntries(entries: Map<string, Buffer>): ImportedSnapshot {
    const rawMeta = entries.get('metadata.json');
    if (!rawMeta) throw new ArchiveFormatError('BAD_ARCHIVE', 'Archive is missing metadata.json');
    const meta = parseMetadata(rawMeta.toString('utf-8'));
    // Warning and documentation records are rendered verbatim by the snapshot
    // detail view. An element of the wrong shape would crash that view after the
    // import succeeded, so every record is checked here, before persistence.
    const rawDocumentation = entries.get('documentation.json');
    const documentation = rawDocumentation ? parseDocumentation(rawDocumentation.toString('utf-8')) : '';
    const files: ImportedSnapshotFile[] = [];
    for (const [name, body] of entries) {
        if (name === 'metadata.json' || name === 'documentation.json') continue;
        const match = /^nodes\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(name);
        if (!match) throw new ArchiveFormatError('BAD_ARCHIVE', 'Archive contains an unexpected entry');
        const node = parseNodeSegment(match[1]);
        if (!node) throw new ArchiveFormatError('BAD_ARCHIVE', 'Archive contains an unexpected entry');
        files.push({
            nodeId: node.nodeId,
            nodeName: node.nodeName,
            stackName: match[2],
            filename: match[3],
            content: body.toString('utf-8'),
        });
    }
    const derivedNodeCount = new Set(files.map(file => file.nodeId)).size;
    const derivedStackCount = new Set(files.map(file => `${file.nodeId}\0${file.stackName}`)).size;
    return {
        description: meta.description,
        createdBy: meta.createdBy,
        createdAt: meta.createdAt,
        skippedNodes: JSON.stringify(meta.skippedNodes),
        // A pre-warning archive has no skipped_stacks field. Importing it as
        // "[]" would claim the capture was complete, so it stays an empty list
        // plus warningsKnown=false and the snapshot says it does not know.
        skippedStacks: JSON.stringify(meta.skippedStacks ?? []),
        warningsKnown: meta.skippedStacks !== null,
        documentation,
        // Metadata counts cover captured nodes and stacks that produced no
        // files; never report fewer than the archive actually contains.
        nodeCount: Math.max(meta.nodeCount ?? 0, derivedNodeCount),
        stackCount: Math.max(meta.stackCount ?? 0, derivedStackCount),
        sourceInstanceId: meta.instanceId,
        files,
    };
}

/** A partial-capture warning for one node, as the snapshot detail renders it. */
interface ArchiveSkippedNode {
    nodeId: number;
    nodeName: string;
    reason: string;
}

/** A partial-capture warning for one stack, as the snapshot detail renders it. */
interface ArchiveSkippedStack extends ArchiveSkippedNode {
    stackName: string;
}

interface ParsedMetadata {
    description: string;
    createdBy: string;
    createdAt: number;
    skippedNodes: ArchiveSkippedNode[];
    /** null when the archive predates partial-capture warnings. */
    skippedStacks: ArchiveSkippedStack[] | null;
    nodeCount: number | null;
    stackCount: number | null;
    instanceId: string | null;
}

function parseMetadata(text: string): ParsedMetadata {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        throw new ArchiveFormatError('BAD_ARCHIVE', 'Archive metadata is not valid JSON');
    }
    if (!isRecord(value)) {
        throw new ArchiveFormatError('BAD_ARCHIVE', 'Archive metadata is not valid JSON');
    }
    const record = value;
    const version = record.archive_version;
    if (typeof version !== 'number' || !SUPPORTED_ARCHIVE_VERSIONS.has(version)) {
        throw new ArchiveFormatError('BAD_ARCHIVE', 'Archive version is not supported');
    }
    if (typeof record.description !== 'string' || typeof record.created_by !== 'string') {
        throw new ArchiveFormatError('BAD_ARCHIVE', 'Archive metadata is incomplete');
    }
    if (typeof record.created_at !== 'number' || !Number.isFinite(record.created_at)) {
        throw new ArchiveFormatError('BAD_ARCHIVE', 'Archive metadata is incomplete');
    }
    return {
        description: record.description,
        createdBy: record.created_by,
        createdAt: record.created_at,
        skippedNodes: parseSkippedNodes(record.skipped_nodes),
        skippedStacks: record.skipped_stacks === undefined ? null : parseSkippedStacks(record.skipped_stacks),
        nodeCount: asCount(record.node_count),
        stackCount: asCount(record.stack_count),
        instanceId: typeof record.instance_id === 'string' && record.instance_id !== '' ? record.instance_id : null,
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function malformedWarning(): never {
    throw new ArchiveFormatError('BAD_ARCHIVE', 'Archive metadata warning records are malformed');
}

function warningNodeId(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) malformedWarning();
    return value;
}

function warningText(value: unknown): string {
    if (typeof value !== 'string' || value === '') malformedWarning();
    return value;
}

function parseSkippedNodes(value: unknown): ArchiveSkippedNode[] {
    if (!Array.isArray(value)) throw new ArchiveFormatError('BAD_ARCHIVE', 'Archive metadata is incomplete');
    return value.map((entry) => {
        if (!isRecord(entry)) malformedWarning();
        return {
            nodeId: warningNodeId(entry.nodeId),
            nodeName: warningText(entry.nodeName),
            reason: warningText(entry.reason),
        };
    });
}

function parseSkippedStacks(value: unknown): ArchiveSkippedStack[] {
    if (!Array.isArray(value)) throw new ArchiveFormatError('BAD_ARCHIVE', 'Archive metadata is incomplete');
    return value.map((entry) => {
        if (!isRecord(entry)) malformedWarning();
        return {
            nodeId: warningNodeId(entry.nodeId),
            nodeName: warningText(entry.nodeName),
            stackName: warningText(entry.stackName),
            reason: warningText(entry.reason),
        };
    });
}

/**
 * Validate the documentation blob an archive carries before it is persisted.
 * The detail view renders these records directly, so an accepted malformed
 * record would crash the view instead of showing the snapshot.
 */
function parseDocumentation(text: string): string {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        throw new ArchiveFormatError('BAD_ARCHIVE', 'Archive documentation is not valid JSON');
    }
    if (!isRecord(value) || !Array.isArray(value.stacks) || !Array.isArray(value.warnings)) {
        throw new ArchiveFormatError('BAD_ARCHIVE', 'Archive documentation is incomplete');
    }
    const malformed = (): never => {
        throw new ArchiveFormatError('BAD_ARCHIVE', 'Archive documentation is malformed');
    };
    for (const stack of value.stacks) {
        if (!isRecord(stack)) malformed();
        if (typeof stack.nodeId !== 'number' || !Number.isSafeInteger(stack.nodeId) || stack.nodeId <= 0) malformed();
        if (typeof stack.nodeName !== 'string' || stack.nodeName === '') malformed();
        if (typeof stack.stackName !== 'string' || stack.stackName === '') malformed();
        if (stack.dossier !== undefined && !isRecord(stack.dossier)) malformed();
    }
    for (const warning of value.warnings) {
        if (!isRecord(warning)) malformed();
        if (typeof warning.nodeId !== 'number' || !Number.isSafeInteger(warning.nodeId) || warning.nodeId <= 0) malformed();
        if (typeof warning.nodeName !== 'string' || warning.nodeName === '') malformed();
        if (typeof warning.stackName !== 'string' || warning.stackName === '') malformed();
        if (typeof warning.reason !== 'string' || warning.reason === '') malformed();
    }
    return text;
}

/** A missing or malformed count stays unknown; the caller derives a floor. */
function asCount(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
    return value;
}
