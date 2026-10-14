import { describe, it, expect } from 'vitest';
import * as zlib from 'zlib';
import * as tar from 'tar-stream';
import type { Header } from 'tar-stream';
import {
    ARCHIVE_LIMITS,
    ArchiveFormatError,
    decryptArchive,
    encryptArchive,
    isEncryptedArchive,
    openSnapshotArchive,
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
        skipped_nodes: [{ name: 'edge' }],
        skipped_stacks: [],
        archive_version: 2,
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
            { name: 'documentation.json', content: '{"notes":true}' },
        ]);
        const sealed = await encryptArchive(gzip, PASSPHRASE);
        const opened = await openSnapshotArchive(sealed, PASSPHRASE);
        expect(opened.description).toBe('nightly');
        expect(opened.createdBy).toBe('ada');
        expect(opened.createdAt).toBe(1_700_000_000_000);
        expect(JSON.parse(opened.skippedNodes)).toEqual([{ name: 'edge' }]);
        expect(opened.documentation).toBe('{"notes":true}');
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
            maxEntries: 2000,
            maxEntryBytes: 1_000_000,
            maxUncompressedBytes: 64 * 1024 * 1024,
        });
    });
});
