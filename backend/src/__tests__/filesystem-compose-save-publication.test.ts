/**
 * Compose saves must publish whole files. The mesh declaration reader (and
 * every other consumer) treats a readable compose document as the stack's
 * authored state, so a save that exposes a truncated prefix can be read as a
 * service removal. Saving through a staging sibling and renaming it into place
 * means a reader sees the previous file or the new one, never a prefix.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fsp } from 'fs';
import fsSync from 'fs';
import path from 'path';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let FileSystemService: typeof import('../services/FileSystemService').FileSystemService;
let stackDir: string;
const STACK = 'atomic-save-stack';

function composeContent(services: string[]): string {
    return `services:\n${services.map((svc) => `  ${svc}:\n    image: busybox:latest`).join('\n')}\n`;
}

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ FileSystemService } = await import('../services/FileSystemService'));
    stackDir = path.join(process.env.COMPOSE_DIR as string, STACK);
    fsSync.mkdirSync(stackDir, { recursive: true });
    fsSync.writeFileSync(path.join(stackDir, 'compose.yaml'), composeContent(['web']), 'utf8');
});

beforeEach(() => {
    vi.restoreAllMocks();
    const target = path.join(stackDir, 'compose.yaml');
    fsSync.rmSync(target, { force: true });
    fsSync.writeFileSync(target, composeContent(['web']), 'utf8');
});

afterAll(() => {
    vi.restoreAllMocks();
    cleanupTestDb(tmpDir);
});

describe('compose save publication', () => {
    it('publishes the new document by renaming a staged file over it', async () => {
        const rename = vi.spyOn(fsp, 'rename');
        const svc = FileSystemService.getInstance();
        const before = await svc.getStackContentWithMtime(STACK);

        const saved = await svc.saveStackContentIfUnchanged(
            STACK,
            composeContent(['web', 'db']),
            before.mtimeMs,
            'compose.yaml',
        );

        expect(saved).toMatchObject({ ok: true, filename: 'compose.yaml' });
        expect(rename).toHaveBeenCalledTimes(1);
        const [staged, target] = rename.mock.calls[0] as [string, string];
        expect(path.basename(staged)).toContain('sencho-tmp');
        expect(target).toBe(path.join(stackDir, 'compose.yaml'));
        expect(fsSync.readFileSync(target, 'utf8')).toBe(composeContent(['web', 'db']));
        expect(fsSync.readdirSync(stackDir).filter((name) => name.includes('sencho-tmp'))).toEqual([]);
    });

    it('leaves the previous document intact when publication fails', async () => {
        vi.spyOn(fsp, 'rename').mockRejectedValue(new Error('rename failed'));
        const svc = FileSystemService.getInstance();
        const before = await svc.getStackContentWithMtime(STACK);
        const previous = fsSync.readFileSync(path.join(stackDir, 'compose.yaml'), 'utf8');

        await expect(svc.saveStackContentIfUnchanged(
            STACK,
            composeContent(['web', 'db']),
            before.mtimeMs,
            'compose.yaml',
        )).rejects.toThrow('rename failed');

        expect(fsSync.readFileSync(path.join(stackDir, 'compose.yaml'), 'utf8')).toBe(previous);
        expect(fsSync.readdirSync(stackDir).filter((name) => name.includes('sencho-tmp'))).toEqual([]);
    });

    describe('restricted targets', () => {
        const MARKER = 'POSTGRES_PASSWORD: hunter2-marker';
        const stagingFiles = () => fsSync.readdirSync(stackDir).filter((name) => name.includes('sencho-tmp'));

        it('never exposes restricted content through the staging file', async () => {
            const target = path.join(stackDir, 'compose.yaml');
            fsSync.chmodSync(target, 0o600);
            const openedModes: number[] = [];
            const realOpen = fsp.open.bind(fsp);
            vi.spyOn(fsp, 'open').mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
                const fh = await realOpen(...args);
                const file = String(args[0]);
                if (!file.includes('sencho-tmp')) return fh;
                const realWrite = fh.writeFile.bind(fh);
                // Sample the staging file's mode the moment its content lands.
                fh.writeFile = (async (...writeArgs: Parameters<typeof fh.writeFile>) => {
                    await realWrite(...writeArgs);
                    openedModes.push(fsSync.statSync(file).mode & 0o777);
                }) as typeof fh.writeFile;
                return fh;
            }) as typeof fsp.open);
            const svc = FileSystemService.getInstance();
            const before = await svc.getStackContentWithMtime(STACK);

            await svc.saveStackContentIfUnchanged(
                STACK,
                `${composeContent(['web'])}# ${MARKER}\n`,
                before.mtimeMs,
                'compose.yaml',
            );

            expect(openedModes).toHaveLength(1);
            expect(openedModes[0] & 0o077).toBe(0);
            expect(fsSync.statSync(target).mode & 0o777).toBe(0o600);
            expect(fsSync.readFileSync(target, 'utf8')).toContain(MARKER);
            expect(stagingFiles()).toEqual([]);
        });

        it('keeps a restricted target restricted when an upload replaces it', async () => {
            const target = path.join(stackDir, 'compose.yaml');
            fsSync.chmodSync(target, 0o600);
            const upload = path.join(path.dirname(stackDir), 'upload-spool.bin');
            fsSync.writeFileSync(upload, `${composeContent(['web'])}# ${MARKER}\n`);
            const stagedModes: number[] = [];
            const realRename = fsp.rename.bind(fsp);
            vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
                stagedModes.push(fsSync.statSync(String(from)).mode & 0o777);
                return realRename(from, to);
            });

            await FileSystemService.getInstance().writeScopedFileFromTemp(STACK, 'compose.yaml', upload);

            expect(stagedModes).toHaveLength(1);
            expect(stagedModes[0] & 0o077).toBe(0);
            expect(fsSync.statSync(target).mode & 0o777).toBe(0o600);
            expect(fsSync.readFileSync(target, 'utf8')).toContain(MARKER);
            expect(stagingFiles()).toEqual([]);
        });

        it('lets an upload replace a read-only file', async () => {
            // The staging file is reopened to sync, which a read-only creation
            // mode would refuse for a process that is not root.
            const target = path.join(stackDir, 'compose.yaml');
            fsSync.chmodSync(target, 0o444);
            const upload = path.join(path.dirname(stackDir), 'upload-spool-readonly.bin');
            fsSync.writeFileSync(upload, composeContent(['web', 'db']));

            await FileSystemService.getInstance().writeScopedFileFromTemp(STACK, 'compose.yaml', upload);

            expect(fsSync.readFileSync(target, 'utf8')).toBe(composeContent(['web', 'db']));
            expect(fsSync.statSync(target).mode & 0o222).toBe(0);
            expect(stagingFiles()).toEqual([]);
        });

        it('hands the replacement to the owner of the file it replaces', async () => {
            const target = path.join(stackDir, 'compose.yaml');
            const { uid, gid } = fsSync.statSync(target);
            const chown = vi.spyOn(fsp, 'chown');
            const upload = path.join(path.dirname(stackDir), 'upload-spool-owner.bin');
            fsSync.writeFileSync(upload, composeContent(['web']));

            const svc = FileSystemService.getInstance();
            await svc.writeScopedFileFromTemp(STACK, 'compose.yaml', upload);
            await svc.writeStackFile(STACK, 'compose.yaml', composeContent(['web', 'db']));

            const staged = chown.mock.calls.map((call) => [String(call[0]), call[1], call[2]]);
            expect(staged).toHaveLength(2);
            for (const [file, toUid, toGid] of staged) {
                expect(path.basename(file as string)).toContain('sencho-tmp');
                expect([toUid, toGid]).toEqual([uid, gid]);
            }
        });

        it('removes the staging file when restricted content fails to publish', async () => {
            const target = path.join(stackDir, 'compose.yaml');
            fsSync.chmodSync(target, 0o600);
            vi.spyOn(fsp, 'rename').mockRejectedValue(new Error('rename failed'));
            const svc = FileSystemService.getInstance();
            const before = await svc.getStackContentWithMtime(STACK);

            await expect(svc.saveStackContentIfUnchanged(
                STACK,
                `${composeContent(['web'])}# ${MARKER}\n`,
                before.mtimeMs,
                'compose.yaml',
            )).rejects.toThrow('rename failed');

            expect(fsSync.readFileSync(target, 'utf8')).not.toContain(MARKER);
            expect(fsSync.statSync(target).mode & 0o777).toBe(0o600);
            expect(stagingFiles()).toEqual([]);
        });
    });
});
