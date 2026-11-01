import { describe, it, expect } from 'vitest';
import * as zlib from 'zlib';
import * as tar from 'tar-stream';
import type { Header } from 'tar-stream';
import {
    ARCHIVE_ENVELOPE_OVERHEAD_BYTES,
    ARCHIVE_LIMITS,
    ArchiveFormatError,
    assertArchiveFitsLimits,
    assertArchiveObjectSize,
    decryptArchive,
    encryptArchive,
    isArchiveStorableName,
    isEncryptedArchive,
    openSnapshotArchive,
    packSnapshotArchive,
    sealArchive,
    type ArchiveLimits,
} from '../services/cloudBackupArchive';

const PASSPHRASE = 'correct-horse';
const SALT = Buffer.alloc(16, 1);
const IV = Buffer.alloc(12, 2);

function gzipTar(files: Array<{ name: string; content: string | Buffer; type?: Header['type']; linkname?: string }>): Promise<Buffer> {
    const pack = tar.pack();
    for (const file of files) {
        const header: { name: string; type?: Header['type']; linkname?: string } = { name: file.name };
        if (file.type) header.type = file.type;
        if (file.linkname) header.linkname = file.linkname;
        if (file.type && file.type !== 'file') pack.entry(header);
        else pack.entry(header, file.content);
    }
    pack.finalize();
    const gzip = zlib.createGzip();
    const chunks: Buffer[] = [];
    return new Promise((resolve, reject) => {
        gzip.on('data', (chunk: Buffer) => chunks.push(chunk));
        gzip.on('end', () => resolve(Buffer.concat(chunks)));
        gzip.on('error', reject);
        pack.on('error', reject);
        pack.pipe(gzip);
    });
}

function metadata(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        description: 'nightly',
        created_by: 'ada',
        created_at: 1_700_000_000_000,
        skipped_nodes: [{ nodeId: 9, nodeName: 'edge', reason: 'unreachable during capture' }],
        skipped_stacks: [],
        archive_version: 2,
        ...overrides,
    });
}

function documentation(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        generated_at: '2026-01-01T00:00:00Z',
        stacks: [{ nodeId: 3, nodeName: 'edge_gw', stackName: 'api', dossier: { purpose: 'payments' } }],
        warnings: [{ nodeId: 9, nodeName: 'edge', stackName: 'api', reason: 'dossier fetch failed' }],
        ...overrides,
    });
}

const SAMPLE_FILES = [
    { name: 'metadata.json', content: metadata() },
    { name: 'nodes/3_edge_gw/api/compose.yaml', content: 'services: {}\n' },
    { name: 'nodes/3_edge_gw/api/.env', content: 'TOKEN=secret\n' },
];

describe('cloud backup archive envelope', () => {
    it('seals a fixed vector', async () => {
        const sealed = await sealArchive(Buffer.from('hello'), PASSPHRASE, SALT, IV);
        expect(sealed.subarray(0, 6).toString('utf-8')).toBe('SCENC1');
        expect(sealed[6]).toBe(1);
        expect(sealed.subarray(7, 23)).toEqual(SALT);
        expect(sealed.subarray(23, 35)).toEqual(IV);
        expect(sealed.toString('hex')).toBe(
            '5343454e4331010101010101010101010101010101010102020202020202020202020202ff654c63d429e09b4d2bac2c2cf2cf651f3f2958',
        );
    });

    it('round-trips a gzip buffer and rejects a tampered ciphertext', async () => {
        const plain = Buffer.from('services: {}\nTOKEN=secret\n');
        const sealed = await encryptArchive(plain, PASSPHRASE);
        expect(isEncryptedArchive(sealed)).toBe(true);
        expect(await decryptArchive(sealed, PASSPHRASE)).toEqual(plain);
        const tampered = Buffer.from(sealed);
        tampered[40] ^= 0xff;
        await expect(decryptArchive(tampered, PASSPHRASE)).rejects.toMatchObject({ code: 'INVALID_PASSPHRASE' });
    });

    it('does not treat a plaintext gzip as encrypted', async () => {
        const gzip = zlib.gzipSync(Buffer.from('not-an-envelope'));
        expect(isEncryptedArchive(gzip)).toBe(false);
    });
});

describe('openSnapshotArchive', () => {
    it('reads an encrypted archive, including a node name that contains an underscore', async () => {
        const gzip = await gzipTar([
            ...SAMPLE_FILES,
            { name: 'documentation.json', content: documentation() },
        ]);
        const sealed = await encryptArchive(gzip, PASSPHRASE);
        const opened = await openSnapshotArchive(sealed, PASSPHRASE);
        expect(opened.description).toBe('nightly');
        expect(opened.createdBy).toBe('ada');
        expect(opened.createdAt).toBe(1_700_000_000_000);
        expect(JSON.parse(opened.skippedNodes)).toEqual([
            { nodeId: 9, nodeName: 'edge', reason: 'unreachable during capture' },
        ]);
        expect(opened.documentation).toBe(documentation());
        expect(opened.nodeCount).toBe(1);
        expect(opened.stackCount).toBe(1);
        expect(opened.files).toEqual([
            { nodeId: 3, nodeName: 'edge_gw', stackName: 'api', filename: 'compose.yaml', content: 'services: {}\n' },
            { nodeId: 3, nodeName: 'edge_gw', stackName: 'api', filename: '.env', content: 'TOKEN=secret\n' },
        ]);
        expect(JSON.stringify(opened)).not.toContain('enc:');
    });

    it('reads a legacy plaintext archive without a passphrase', async () => {
        const gzip = await gzipTar(SAMPLE_FILES);
        const opened = await openSnapshotArchive(gzip, null);
        expect(opened.files[0]?.content).toBe('services: {}\n');
    });

    it('requires a passphrase for an encrypted archive and rejects the wrong one', async () => {
        const sealed = await encryptArchive(await gzipTar(SAMPLE_FILES), PASSPHRASE);
        await expect(openSnapshotArchive(sealed, null)).rejects.toMatchObject({ code: 'PASSPHRASE_REQUIRED' });
        await expect(openSnapshotArchive(sealed, '')).rejects.toMatchObject({ code: 'PASSPHRASE_REQUIRED' });
        await expect(openSnapshotArchive(sealed, 'wrong-passphrase-value')).rejects.toMatchObject({ code: 'INVALID_PASSPHRASE' });
    });

    it('rejects traversal, unexpected names, links, duplicates, and unsupported versions', async () => {
        const limits: ArchiveLimits = { ...ARCHIVE_LIMITS, maxObjectBytes: 1024 * 1024 };
        await expect(openSnapshotArchive(await gzipTar([
            { name: 'metadata.json', content: metadata() },
            { name: 'nodes/1_a/../web/compose.yaml', content: 'x' },
        ]), null, limits)).rejects.toMatchObject({ code: 'BAD_ARCHIVE' });

        await expect(openSnapshotArchive(await gzipTar([
            { name: 'metadata.json', content: metadata() },
            { name: 'nodes/1_a/web/notes.txt', content: 'x' },
        ]), null, limits)).rejects.toMatchObject({ code: 'BAD_ARCHIVE' });

        await expect(openSnapshotArchive(await gzipTar([
            { name: 'metadata.json', content: metadata() },
            { name: 'link', content: '', type: 'symlink', linkname: 'metadata.json' },
        ]), null, limits)).rejects.toMatchObject({ code: 'BAD_ARCHIVE' });

        await expect(openSnapshotArchive(await gzipTar([
            { name: 'metadata.json', content: metadata() },
            { name: 'metadata.json', content: metadata() },
        ]), null, limits)).rejects.toMatchObject({ code: 'BAD_ARCHIVE' });

        await expect(openSnapshotArchive(await gzipTar([
            { name: 'metadata.json', content: metadata({ archive_version: 9 }) },
        ]), null, limits)).rejects.toMatchObject({ code: 'BAD_ARCHIVE' });

        await expect(openSnapshotArchive(await gzipTar([
            { name: 'nodes/1_a/web/compose.yaml', content: 'x' },
        ]), null, limits)).rejects.toMatchObject({ code: 'BAD_ARCHIVE' });
    });

    it('rejects an object past the size limit before parsing it', async () => {
        const limits: ArchiveLimits = { ...ARCHIVE_LIMITS, maxObjectBytes: 32 };
        const big = Buffer.alloc(33, 0);
        await expect(openSnapshotArchive(big, null, limits)).rejects.toBeInstanceOf(ArchiveFormatError);
        await expect(openSnapshotArchive(big, null, limits)).rejects.toMatchObject({ code: 'TOO_LARGE' });
    });

    it('rejects an entry past the per-file cap and a walk past the uncompressed cap', async () => {
        const fat = await gzipTar([
            { name: 'metadata.json', content: metadata() },
            { name: 'nodes/1_a/web/compose.yaml', content: 'x'.repeat(50) },
        ]);
        await expect(openSnapshotArchive(fat, null, {
            ...ARCHIVE_LIMITS,
            maxEntryBytes: 40,
            maxObjectBytes: fat.length,
        })).rejects.toMatchObject({ code: 'TOO_LARGE' });

        await expect(openSnapshotArchive(fat, null, {
            ...ARCHIVE_LIMITS,
            maxUncompressedBytes: 20,
            maxObjectBytes: fat.length,
        })).rejects.toMatchObject({ code: 'TOO_LARGE' });
    });

    it('rejects more entries than the cap', async () => {
        const files = [{ name: 'metadata.json', content: metadata() }];
        for (let i = 0; i < 3; i++) {
            files.push({ name: `nodes/1_a/web${i}/compose.yaml`, content: 'x' });
        }
        const gzip = await gzipTar(files);
        await expect(openSnapshotArchive(gzip, null, {
            ...ARCHIVE_LIMITS,
            maxEntries: 3,
            maxObjectBytes: gzip.length,
        })).rejects.toMatchObject({ code: 'TOO_LARGE' });
    });

    it('publishes the production limits', () => {
        expect(ARCHIVE_LIMITS).toEqual({
            maxObjectBytes: 32 * 1024 * 1024,
            maxEntries: 5000,
            maxEntryBytes: 1_000_000,
            maxDocumentationBytes: 8 * 1024 * 1024,
            maxMetadataBytes: 1024 * 1024,
            maxUncompressedBytes: 64 * 1024 * 1024,
            maxTarBytes: 72 * 1024 * 1024,
        });
    });
});

describe('archive metadata fidelity', () => {
    it('round-trips skipped stacks, counts, and source identity', async () => {
        const gzip = await gzipTar([
            { name: 'metadata.json', content: metadata({
                node_count: 3,
                stack_count: 7,
                skipped_stacks: [{ nodeId: 9, nodeName: 'edge', stackName: 'db', reason: 'compose.yaml over the size cap' }],
                instance_id: 'source-instance',
            }) },
            { name: 'nodes/3_edge_gw/api/compose.yaml', content: 'services: {}\n' },
        ]);
        for (const sealed of [gzip, await encryptArchive(gzip, PASSPHRASE)]) {
            const opened = await openSnapshotArchive(sealed, sealed === gzip ? null : PASSPHRASE);
            expect(JSON.parse(opened.skippedStacks)).toEqual([
                { nodeId: 9, nodeName: 'edge', stackName: 'db', reason: 'compose.yaml over the size cap' },
            ]);
            expect(opened.warningsKnown).toBe(true);
            // Counts cover captured nodes and stacks that produced no files.
            expect(opened.nodeCount).toBe(3);
            expect(opened.stackCount).toBe(7);
            expect(opened.sourceInstanceId).toBe('source-instance');
        }
    });

    it('keeps a legacy archive without warning fields truthful', async () => {
        const legacy = metadata();
        const parsed = JSON.parse(legacy) as Record<string, unknown>;
        delete parsed.skipped_stacks;
        const gzip = await gzipTar([
            { name: 'metadata.json', content: JSON.stringify(parsed) },
            { name: 'nodes/1_a/web/compose.yaml', content: 'services: {}\n' },
        ]);
        const opened = await openSnapshotArchive(gzip, null);
        expect(opened.warningsKnown).toBe(false);
        expect(opened.skippedStacks).toBe('[]');
        // No instance id in a legacy archive means foreign: mapping required.
        expect(opened.sourceInstanceId).toBeNull();
    });

    it('never reports fewer nodes or stacks than the archive contains', async () => {
        const gzip = await gzipTar([
            { name: 'metadata.json', content: metadata({ node_count: 0, stack_count: 1 }) },
            { name: 'nodes/1_a/web/compose.yaml', content: 'services: {}\n' },
            { name: 'nodes/2_b/api/compose.yaml', content: 'services: {}\n' },
        ]);
        const opened = await openSnapshotArchive(gzip, null);
        expect(opened.nodeCount).toBe(2);
        expect(opened.stackCount).toBe(2);
    });

    it('gives aggregate documentation its own bound', async () => {
        const doc = JSON.stringify({ generated_at: 'x', stacks: [], warnings: [] });
        const gzip = await gzipTar([
            { name: 'metadata.json', content: metadata() },
            { name: 'documentation.json', content: doc },
            { name: 'nodes/1_a/web/compose.yaml', content: 'x'.repeat(20) },
        ]);
        // A documentation entry larger than the per-Compose-file cap still parses.
        const opened = await openSnapshotArchive(gzip, null, {
            ...ARCHIVE_LIMITS,
            maxEntryBytes: 40,
            maxDocumentationBytes: doc.length,
            maxObjectBytes: gzip.length,
        });
        expect(opened.documentation).toBe(doc);

        await expect(openSnapshotArchive(gzip, null, {
            ...ARCHIVE_LIMITS,
            maxEntryBytes: 40,
            maxDocumentationBytes: doc.length - 1,
            maxObjectBytes: gzip.length,
        })).rejects.toMatchObject({ code: 'TOO_LARGE' });
    });
});

describe('archive warning and documentation records', () => {
    const fileEntry = { name: 'nodes/1_a/web/compose.yaml', content: 'services: {}\n' };

    it.each([
        ['a null node warning', { skipped_nodes: [null] }],
        ['a primitive node warning', { skipped_nodes: ['edge'] }],
        ['a node warning with a string id', { skipped_nodes: [{ nodeId: '9', nodeName: 'edge', reason: 'down' }] }],
        ['a node warning without a name', { skipped_nodes: [{ nodeId: 9, reason: 'down' }] }],
        ['a node warning without a reason', { skipped_nodes: [{ nodeId: 9, nodeName: 'edge' }] }],
        ['a null stack warning', { skipped_stacks: [null] }],
        ['a stack warning without a stack name', { skipped_stacks: [{ nodeId: 9, nodeName: 'edge', reason: 'down' }] }],
        ['a stack warning with a numeric reason', { skipped_stacks: [{ nodeId: 9, nodeName: 'edge', stackName: 'web', reason: 7 }] }],
        ['a skipped_nodes value that is not an array', { skipped_nodes: null }],
    ])('rejects %s', async (_label, overrides) => {
        const gzip = await gzipTar([
            { name: 'metadata.json', content: metadata(overrides) },
            fileEntry,
        ]);
        await expect(openSnapshotArchive(gzip, null)).rejects.toMatchObject({ code: 'BAD_ARCHIVE' });
    });

    it.each([
        ['documentation that is not JSON', 'not json'],
        ['documentation without a stacks array', JSON.stringify({ generated_at: 'x', warnings: [] })],
        ['documentation without a warnings array', JSON.stringify({ generated_at: 'x', stacks: [] })],
        ['a null documentation stack', JSON.stringify({ generated_at: 'x', stacks: [null], warnings: [] })],
        ['a null documentation warning', JSON.stringify({ generated_at: 'x', stacks: [], warnings: [null] })],
        ['a stack whose dossier is not an object', JSON.stringify({ generated_at: 'x', stacks: [{ nodeId: 1, nodeName: 'a', stackName: 'b', dossier: 'notes' }], warnings: [] })],
        ['a warning whose reason is numeric', JSON.stringify({ generated_at: 'x', stacks: [], warnings: [{ nodeId: 1, nodeName: 'a', stackName: 'b', reason: 7 }] })],
    ])('rejects %s', async (_label, documentationJson) => {
        const gzip = await gzipTar([
            { name: 'metadata.json', content: metadata() },
            { name: 'documentation.json', content: documentationJson },
            fileEntry,
        ]);
        await expect(openSnapshotArchive(gzip, null)).rejects.toMatchObject({ code: 'BAD_ARCHIVE' });
    });

    it('keeps valid warning and documentation records', async () => {
        const gzip = await gzipTar([
            {
                name: 'metadata.json',
                content: metadata({
                    skipped_nodes: [{ nodeId: 9, nodeName: 'edge', reason: 'unreachable' }],
                    skipped_stacks: [{ nodeId: 3, nodeName: 'edge_gw', stackName: 'api', reason: 'compose unreadable' }],
                }),
            },
            { name: 'documentation.json', content: documentation() },
            fileEntry,
        ]);
        const opened = await openSnapshotArchive(gzip, null);
        expect(JSON.parse(opened.skippedNodes)).toEqual([{ nodeId: 9, nodeName: 'edge', reason: 'unreachable' }]);
        expect(JSON.parse(opened.skippedStacks)).toEqual([
            { nodeId: 3, nodeName: 'edge_gw', stackName: 'api', reason: 'compose unreadable' },
        ]);
        expect(opened.documentation).toBe(documentation());
    });
});

describe('producer archive limits', () => {
    it('accepts a plan at the importer bounds and rejects each overrun', () => {
        expect(() => assertArchiveFitsLimits({
            metadataBytes: 100,
            documentationBytes: 200,
            fileBytes: [1000, 1000],
        })).not.toThrow();

        expect(() => assertArchiveFitsLimits({
            metadataBytes: 100,
            documentationBytes: 0,
            fileBytes: [1000],
        }, { ...ARCHIVE_LIMITS, maxEntries: 1 })).toThrow(/entries/);

        expect(() => assertArchiveFitsLimits({
            metadataBytes: 100,
            documentationBytes: 0,
            fileBytes: [100],
        }, { ...ARCHIVE_LIMITS, maxEntryBytes: 50 })).toThrow(/per-file/);

        expect(() => assertArchiveFitsLimits({
            metadataBytes: 100,
            documentationBytes: 100,
            fileBytes: [],
        }, { ...ARCHIVE_LIMITS, maxDocumentationBytes: 50 })).toThrow(/documentation/);

        expect(() => assertArchiveFitsLimits({
            metadataBytes: 100,
            documentationBytes: 0,
            fileBytes: [100],
        }, { ...ARCHIVE_LIMITS, maxUncompressedBytes: 150 })).toThrow(/expand/);
    });

    it('refuses an upload object past the reader size limit', () => {
        expect(() => assertArchiveObjectSize(1024)).not.toThrow();
        expect(() => assertArchiveObjectSize(1025, { ...ARCHIVE_LIMITS, maxObjectBytes: 1024 }))
            .toThrow(/upload limit/);
    });

    it('counts the seal envelope against the object limit', async () => {
        const plain = Buffer.alloc(100, 7);
        const sealed = await sealArchive(plain, PASSPHRASE, SALT, IV);
        expect(sealed.byteLength).toBe(plain.byteLength + ARCHIVE_ENVELOPE_OVERHEAD_BYTES);
        const limit = sealed.byteLength - 1;
        expect(() => assertArchiveObjectSize(plain.byteLength, { ...ARCHIVE_LIMITS, maxObjectBytes: limit })).not.toThrow();
        expect(() => assertArchiveObjectSize(sealed.byteLength, { ...ARCHIVE_LIMITS, maxObjectBytes: limit }))
            .toThrow(/upload limit/);
    });

    it('refuses a packed tar whose PAX framing pushes it past the reader bound', async () => {
        // Long entry paths make tar-stream emit a PAX extended header per file.
        // The payloads alone fit the payload bound; the framed tar does not.
        const entries = Array.from({ length: 40 }, (_, index) => ({
            name: `nodes/1_${'n'.repeat(180)}/stack-${index}/compose.yaml`,
            content: Buffer.alloc(400, 120),
        }));
        const limits: ArchiveLimits = {
            ...ARCHIVE_LIMITS,
            maxUncompressedBytes: 20 * 1024,
            maxTarBytes: 24 * 1024,
        };
        expect(() => assertArchiveFitsLimits(
            { metadataBytes: 0, documentationBytes: 0, fileBytes: entries.map(entry => entry.content.byteLength) },
            limits,
        )).not.toThrow();
        await expect(packSnapshotArchive(entries, limits)).rejects.toMatchObject({ code: 'TOO_LARGE' });
    });

    it('packs to exactly the tar bound the reader accepts and refuses one byte more', async () => {
        const entries = [
            { name: 'metadata.json', content: metadata() },
            ...Array.from({ length: 20 }, (_, index) => ({
                name: `nodes/1_${'n'.repeat(150)}/stack-${index}/compose.yaml`,
                content: Buffer.alloc(200, 7),
            })),
        ];
        const packed = await packSnapshotArchive(entries);
        const tarBytes = zlib.gunzipSync(packed).byteLength;

        const exact: ArchiveLimits = { ...ARCHIVE_LIMITS, maxTarBytes: tarBytes };
        await expect(packSnapshotArchive(entries, exact)).resolves.toBeInstanceOf(Buffer);
        await expect(packSnapshotArchive(entries, { ...exact, maxTarBytes: tarBytes - 1 }))
            .rejects.toMatchObject({ code: 'TOO_LARGE' });

        // The reader accepts exactly what the producer published at that bound.
        await expect(openSnapshotArchive(packed, null, exact)).resolves.toMatchObject({ description: 'nightly' });
        await expect(openSnapshotArchive(packed, null, { ...exact, maxTarBytes: tarBytes - 1 }))
            .rejects.toMatchObject({ code: 'TOO_LARGE' });
    });

    it('refuses a production-boundary archive of long-named files the importer would reject', async () => {
        // The shape an audit probe used: the payloads sit under the 64 MiB
        // content bound, but PAX records for 200-character node names push the
        // framed tar past the reader's decompression bound.
        const nodeName = 'n'.repeat(200);
        const entries = Array.from({ length: 4999 }, (_, index) => ({
            name: `nodes/1_${nodeName}/stack-${index}/compose.yaml`,
            content: Buffer.alloc(13_400, 120),
        }));
        await expect(packSnapshotArchive(entries)).rejects.toMatchObject({ code: 'TOO_LARGE' });
    }, 60_000);
});

describe('producer entry name fidelity', () => {
    function planned(name: string): Array<{ name: string; content: string }> {
        return [
            { name: 'metadata.json', content: metadata() },
            { name, content: 'services: {}\n' },
        ];
    }

    it.each([
        ['an embedded NUL', 'nodes/1_edge\u0000hidden/web/compose.yaml'],
        ['a leading NUL', 'nodes/1_\u0000leading/web/compose.yaml'],
        ['an unpaired high surrogate', 'nodes/1_edge\uD800hidden/web/compose.yaml'],
        ['an unpaired low surrogate', 'nodes/1_edge\uDC00hidden/web/compose.yaml'],
        ['an empty node segment', 'nodes/1_/web/compose.yaml'],
        ['an empty stack segment', 'nodes/1_edge//compose.yaml'],
        ['a NUL stack segment', 'nodes/1_edge/web\u0000hidden/compose.yaml'],
        ['a NUL filename segment', 'nodes/1_edge/web/compose.yaml\u0000hidden'],
        ['a disallowed filename', 'nodes/1_edge/web/other.yaml'],
        ['a backslash separator', 'nodes/1_edge\\web/compose.yaml'],
        ['a traversal segment', 'nodes/1_edge/../compose.yaml'],
    ])('refuses %s before packing', async (_label, name) => {
        await expect(packSnapshotArchive(planned(name))).rejects.toMatchObject({
            code: 'INVALID_ENTRY_NAME',
            message: expect.stringContaining('cannot be stored'),
        });
    });

    it('packs ordinary, Unicode, and PAX-length names the importer reads back unchanged', async () => {
        const cases = [
            { name: 'nodes/1_gateway/web/compose.yaml', nodeName: 'gateway', stackName: 'web', filename: 'compose.yaml' },
            { name: 'nodes/1_café/web/.env', nodeName: 'café', stackName: 'web', filename: '.env' },
            {
                name: `nodes/1_${'復旧'.repeat(40)}/stäck-${'x'.repeat(90)}/compose.yaml`,
                nodeName: '復旧'.repeat(40),
                stackName: `stäck-${'x'.repeat(90)}`,
                filename: 'compose.yaml',
            },
        ];
        for (const testCase of cases) {
            const packed = await packSnapshotArchive(planned(testCase.name));
            const opened = await openSnapshotArchive(packed, null);
            expect(opened.files).toHaveLength(1);
            expect(opened.files[0]).toMatchObject({
                nodeName: testCase.nodeName,
                stackName: testCase.stackName,
                filename: testCase.filename,
                content: 'services: {}\n',
            });
        }
    });

    it('recognises the strings the tar writer cannot store byte-for-byte', () => {
        expect(isArchiveStorableName('gateway')).toBe(true);
        expect(isArchiveStorableName('café')).toBe(true);
        expect(isArchiveStorableName('edge\u0000hidden')).toBe(false);
        expect(isArchiveStorableName('\u0000leading')).toBe(false);
        expect(isArchiveStorableName('edge\uD800')).toBe(false);
        expect(isArchiveStorableName('edge\uDC00')).toBe(false);
    });
});
