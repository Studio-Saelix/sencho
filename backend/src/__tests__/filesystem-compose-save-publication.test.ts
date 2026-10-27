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
import { Readable } from 'stream';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let FileSystemService: typeof import('../services/FileSystemService').FileSystemService;
let stackDir: string;
const STACK = 'atomic-save-stack';

function composeContent(services: string[]): string {
    return `services:\n${services.map((svc) => `  ${svc}:\n    image: busybox:latest`).join('\n')}\n`;
}

/** Mode and content of a file read through one descriptor, so the two cannot describe different files. */
function modeAndContent(file: string): { mode: number; content: string } {
    const fd = fsSync.openSync(file, 'r');
    try {
        return { mode: fsSync.fstatSync(fd).mode & 0o777, content: fsSync.readFileSync(fd, 'utf8') };
    } finally {
        fsSync.closeSync(fd);
    }
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
            const published = modeAndContent(target);
            expect(published.mode).toBe(0o600);
            expect(published.content).toContain(MARKER);
            expect(stagingFiles()).toEqual([]);
        });

        it('keeps a group-readable target owner-only until the intended owner holds the staging file', async () => {
            // The staging file starts in the process's group. Group-read bits
            // applied at creation would expose the new contents to that group
            // until the descriptor is handed to the target's group, so the
            // staging file stays owner-only through every write and the
            // hand-off, and takes the published mode afterwards.
            const target = path.join(stackDir, 'compose.yaml');
            fsSync.chmodSync(target, 0o640);
            const upload = path.join(path.dirname(stackDir), 'upload-spool-group.bin');
            fsSync.writeFileSync(upload, `${composeContent(['web'])}# ${MARKER}\n`);
            const events: string[] = [];
            const exposed: number[] = [];
            const realOpen = fsp.open.bind(fsp);
            vi.spyOn(fsp, 'open').mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
                const fh = await realOpen(...args);
                const file = String(args[0]);
                if (!file.includes('sencho-tmp')) return fh;
                const sample = (event: string): void => {
                    events.push(event);
                    exposed.push(fsSync.statSync(file).mode & 0o077);
                };
                const realWrite = fh.writeFile.bind(fh);
                fh.writeFile = (async (...writeArgs: Parameters<typeof fh.writeFile>) => {
                    await realWrite(...writeArgs);
                    sample('write');
                }) as typeof fh.writeFile;
                const realChown = fh.chown.bind(fh);
                fh.chown = (async (uid: number, gid: number) => {
                    await realChown(uid, gid);
                    sample('chown');
                }) as typeof fh.chown;
                const realChmod = fh.chmod.bind(fh);
                fh.chmod = (async (mode: fsSync.Mode) => {
                    events.push('chmod');
                    await realChmod(mode);
                }) as typeof fh.chmod;
                return fh;
            }) as typeof fsp.open);
            const svc = FileSystemService.getInstance();

            // A buffered write, then a streamed upload that writes in chunks.
            await svc.writeStackFile(STACK, 'compose.yaml', `${composeContent(['web'])}# ${MARKER}\n`);
            expect(events).toEqual(['write', 'chown', 'chmod']);
            expect(exposed.every((bits) => bits === 0)).toBe(true);
            expect(modeAndContent(target).mode).toBe(0o640);

            events.length = 0;
            exposed.length = 0;
            await svc.writeScopedFileFromTemp(STACK, 'compose.yaml', upload);
            expect(events.at(-2)).toBe('chown');
            expect(events.at(-1)).toBe('chmod');
            expect(events.filter((event) => event === 'write').length).toBeGreaterThan(0);
            expect(exposed.every((bits) => bits === 0)).toBe(true);
            const published = modeAndContent(target);
            expect(published.mode).toBe(0o640);
            expect(published.content).toContain(MARKER);
            expect(stagingFiles()).toEqual([]);
        });

        describe('when the staging file cannot be handed to the intended owner', () => {
            // The staging file stays in the process's group while the target
            // belongs to another one, so its group bits would apply to the
            // wrong principals. The handle reports a different group and
            // refuses the chown, as a non-root process would see it.
            function refuseHandOver(sameGroup = false): void {
                const realOpen = fsp.open.bind(fsp);
                vi.spyOn(fsp, 'open').mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
                    const fh = await realOpen(...args);
                    if (!String(args[0]).includes('sencho-tmp')) return fh;
                    fh.chown = (async () => {
                        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
                    }) as typeof fh.chown;
                    const realStat = fh.stat.bind(fh);
                    fh.stat = (async (...statArgs: Parameters<typeof fh.stat>) => {
                        const st = await realStat(...statArgs);
                        return sameGroup ? { ...st, uid: Number(st.uid) + 1 } : { ...st, gid: Number(st.gid) + 1 };
                    }) as typeof fh.stat;
                    return fh;
                }) as typeof fsp.open);
            }

            it.each([
                ['a compose save', 0o640, 0o600],
                ['a compose save of a world-readable file', 0o644, 0o604],
            ])('drops the group bits for %s', async (_label, before, after) => {
                const target = path.join(stackDir, 'compose.yaml');
                fsSync.chmodSync(target, before);
                refuseHandOver();
                vi.spyOn(console, 'warn').mockImplementation(() => { /* the fallback is logged */ });

                await FileSystemService.getInstance().saveStackContent(STACK, `${composeContent(['web'])}# ${MARKER}\n`);

                const published = modeAndContent(target);
                expect(published.mode).toBe(after);
                expect(published.content).toContain(MARKER);
                expect(stagingFiles()).toEqual([]);
            });

            it('keeps the group bits when the staging file is already in the file\'s group', async () => {
                const target = path.join(stackDir, 'compose.yaml');
                fsSync.chmodSync(target, 0o664);
                refuseHandOver(true);
                vi.spyOn(console, 'warn').mockImplementation(() => { /* the fallback is logged */ });

                await FileSystemService.getInstance().saveStackContent(STACK, composeContent(['web', 'db']));

                expect(modeAndContent(target).mode).toBe(0o664);
            });

            it('applies an explicit mode with the group bits dropped', async () => {
                const target = path.join(stackDir, 'compose.yaml');
                fsSync.chmodSync(target, 0o600);
                refuseHandOver();
                vi.spyOn(console, 'warn').mockImplementation(() => { /* the fallback is logged */ });

                await FileSystemService.getInstance().writeStackFile(STACK, 'compose.yaml', composeContent(['web']), { mode: 0o640 });

                expect(modeAndContent(target).mode).toBe(0o600);
            });

            it('drops the group bits of a mode carried over from the replaced file', async () => {
                const target = path.join(stackDir, 'compose.yaml');
                fsSync.chmodSync(target, 0o640);
                refuseHandOver();
                vi.spyOn(console, 'warn').mockImplementation(() => { /* the fallback is logged */ });

                await FileSystemService.getInstance().writeStackFile(STACK, 'compose.yaml', composeContent(['web', 'db']));

                expect(modeAndContent(target).mode).toBe(0o600);
            });
        });

        describe('when the process cannot change the file\'s user', () => {
            // A non-root process may give a file to a group it belongs to but
            // not to another user. The handle refuses a change of user and
            // honours a change of group to the process's own, or refuses both.
            function refuseUserChange(refuseGroupToo: boolean): Array<[number, number]> {
                const ownUid = process.getuid?.() ?? 0;
                const ownGid = process.getgid?.() ?? 0;
                const attempts: Array<[number, number]> = [];
                const realOpen = fsp.open.bind(fsp);
                vi.spyOn(fsp, 'open').mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
                    const fh = await realOpen(...args);
                    if (!String(args[0]).includes('sencho-tmp')) return fh;
                    const realChown = fh.chown.bind(fh);
                    fh.chown = (async (uid: number, gid: number) => {
                        attempts.push([uid, gid]);
                        const refused = uid !== ownUid || (refuseGroupToo && gid !== ownGid);
                        if (refused) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
                        return realChown(uid, gid);
                    }) as typeof fh.chown;
                    return fh;
                }) as typeof fsp.open);
                return attempts;
            }

            it('keeps the file in the owner\'s group and keeps the group bits', async () => {
                const target = path.join(stackDir, 'compose.yaml');
                fsSync.chmodSync(target, 0o660);
                const ownUid = process.getuid?.() ?? 0;
                const ownGid = process.getgid?.() ?? 0;
                const attempts = refuseUserChange(false);
                const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* a dropped group would be logged */ });

                // The file belongs to another user, in a group the process is in.
                await FileSystemService.getInstance().writeStackFile(
                    STACK, 'compose.yaml', composeContent(['web', 'db']),
                    { mode: 0o660, owner: { uid: ownUid + 1, gid: ownGid } },
                );

                expect(attempts).toEqual([[ownUid + 1, ownGid], [ownUid, ownGid]]);
                expect(fsSync.statSync(target).gid).toBe(ownGid);
                expect(modeAndContent(target)).toEqual({ mode: 0o660, content: composeContent(['web', 'db']) });
                expect(warn).not.toHaveBeenCalled();
                expect(stagingFiles()).toEqual([]);
            });

            it('still drops the group bits when the group cannot be kept either', async () => {
                const target = path.join(stackDir, 'compose.yaml');
                fsSync.chmodSync(target, 0o660);
                const ownUid = process.getuid?.() ?? 0;
                const ownGid = process.getgid?.() ?? 0;
                const attempts = refuseUserChange(true);
                vi.spyOn(console, 'warn').mockImplementation(() => { /* the fallback is logged */ });

                await FileSystemService.getInstance().writeStackFile(
                    STACK, 'compose.yaml', composeContent(['web', 'db']),
                    { mode: 0o660, owner: { uid: ownUid + 1, gid: ownGid + 1 } },
                );

                expect(attempts).toEqual([[ownUid + 1, ownGid + 1], [ownUid, ownGid + 1]]);
                expect(modeAndContent(target).mode).toBe(0o600);
            });

            it('does not retry when the file already belongs to the process', async () => {
                const ownUid = process.getuid?.() ?? 0;
                const ownGid = process.getgid?.() ?? 0;
                const attempts = refuseUserChange(true);
                vi.spyOn(console, 'warn').mockImplementation(() => { /* the fallback is logged */ });

                await FileSystemService.getInstance().writeStackFile(
                    STACK, 'compose.yaml', composeContent(['web']),
                    { owner: { uid: ownUid, gid: ownGid + 1 } },
                );

                expect(attempts).toEqual([[ownUid, ownGid + 1]]);
            });
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
            const published = modeAndContent(target);
            expect(published.mode).toBe(0o600);
            expect(published.content).toContain(MARKER);
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

            const replaced = modeAndContent(target);
            expect(replaced.content).toBe(composeContent(['web', 'db']));
            expect(replaced.mode & 0o222).toBe(0);
            expect(stagingFiles()).toEqual([]);
        });

        it('hands the replacement to the owner of the file it replaces, through the open descriptor', async () => {
            const target = path.join(stackDir, 'compose.yaml');
            const { uid, gid } = fsSync.statSync(target);
            const pathChown = vi.spyOn(fsp, 'chown');
            const handleChowns: Array<[number, number]> = [];
            const realOpen = fsp.open.bind(fsp);
            vi.spyOn(fsp, 'open').mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
                const fh = await realOpen(...args);
                if (!String(args[0]).includes('sencho-tmp')) return fh;
                const realChown = fh.chown.bind(fh);
                fh.chown = (async (toUid: number, toGid: number) => {
                    handleChowns.push([toUid, toGid]);
                    return realChown(toUid, toGid);
                }) as typeof fh.chown;
                return fh;
            }) as typeof fsp.open);
            const upload = path.join(path.dirname(stackDir), 'upload-spool-owner.bin');
            fsSync.writeFileSync(upload, composeContent(['web']));

            const svc = FileSystemService.getInstance();
            await svc.writeScopedFileFromTemp(STACK, 'compose.yaml', upload);
            await svc.writeStackFile(STACK, 'compose.yaml', composeContent(['web', 'db']));

            // One per write, and never by path, which would follow a link
            // swapped in for the staging name.
            expect(handleChowns).toEqual([[uid, gid], [uid, gid]]);
            expect(pathChown).not.toHaveBeenCalled();
        });

        it('does not follow a link swapped in for the staging file during an upload', async () => {
            const target = path.join(stackDir, 'compose.yaml');
            fsSync.chmodSync(target, 0o666);
            const victim = path.join(path.dirname(stackDir), 'swap-victim.txt');
            fsSync.writeFileSync(victim, 'untouched', { mode: 0o600 });
            fsSync.chmodSync(victim, 0o600);
            const upload = path.join(path.dirname(stackDir), 'upload-spool-swap.bin');
            fsSync.writeFileSync(upload, composeContent(['web', 'db']));
            const realOpen = fsp.open.bind(fsp);
            // Another process sharing the directory replaces the staging name
            // with a link whenever Sencho creates or reopens it by name.
            const swapForLink = (file: string): void => {
                fsSync.rmSync(file, { force: true });
                fsSync.symlinkSync(victim, file);
            };
            vi.spyOn(fsp, 'open').mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
                const file = String(args[0]);
                const staging = file.includes('sencho-tmp');
                if (staging && args[1] === 'r+') swapForLink(file);
                const fh = await realOpen(...args);
                if (staging && args[1] === 'wx') swapForLink(file);
                return fh;
            }) as typeof fsp.open);

            await FileSystemService.getInstance().writeScopedFileFromTemp(STACK, 'compose.yaml', upload);

            const untouched = modeAndContent(victim);
            expect(untouched.mode).toBe(0o600);
            expect(untouched.content).toBe('untouched');
        });

        it('releases the upload source when the staging file cannot be created', async () => {
            const source = Readable.from([Buffer.from(composeContent(['web']))]);
            const realOpen = fsp.open.bind(fsp);
            vi.spyOn(fsp, 'open').mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
                if (String(args[0]).includes('sencho-tmp')) throw Object.assign(new Error('refused'), { code: 'EACCES' });
                return realOpen(...args);
            }) as typeof fsp.open);
            const writer = FileSystemService.getInstance() as unknown as {
                writeStackFileAtomic(target: string, data: Readable): Promise<void>;
            };

            await expect(writer.writeStackFileAtomic(path.join(stackDir, 'compose.yaml'), source))
                .rejects.toThrow('refused');

            expect(source.destroyed).toBe(true);
            expect(stagingFiles()).toEqual([]);
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

            const kept = modeAndContent(target);
            expect(kept.content).not.toContain(MARKER);
            expect(kept.mode).toBe(0o600);
            expect(stagingFiles()).toEqual([]);
        });
    });
});

describe('declaration set publication', () => {
    const fresh = (name: string) => FileSystemService.getInstance().declarationSetEpoch(name);

    it('stays unknown after an abandoned operation until a later one that wrote completes', async () => {
        const fsSvc = FileSystemService.getInstance();
        const name = 'declaration-set-heal';
        fsSvc.beginDeclarationSetPublication(name).abandon();
        expect(fresh(name)).toBeNull();

        await fsSvc.publishDeclarationSet(name, async () => 'nothing written', () => 'untouched');
        expect(fresh(name)).toBeNull();

        await fsSvc.publishDeclarationSet(name, async () => 'rewrote the layers');
        expect(fresh(name)).not.toBeNull();
    });

    it('abandons the bracket when classifying the result throws', async () => {
        const fsSvc = FileSystemService.getInstance();
        const name = 'declaration-set-settle-throws';
        await expect(
            fsSvc.publishDeclarationSet(name, async () => 1, () => { throw new Error('cannot classify'); }),
        ).rejects.toThrow('cannot classify');
        expect(fresh(name)).toBeNull();
        await fsSvc.publishDeclarationSet(name, async () => 1);
        expect(fresh(name)).not.toBeNull();
    });

    it('treats a write that reports a mixture as partial', async () => {
        const fsSvc = FileSystemService.getInstance();
        const name = 'declaration-set-partial';
        await fsSvc.publishDeclarationSet(name, async () => false, (restored) => (restored ? 'whole' : 'partial'));
        expect(fresh(name)).toBeNull();
    });

    it('does not carry an abandoned mixture over to a stack created under the same name', async () => {
        const fsSvc = FileSystemService.getInstance();
        const name = 'declaration-set-recreated';
        fsSync.mkdirSync(path.join(process.env.COMPOSE_DIR as string, name), { recursive: true });
        fsSvc.beginDeclarationSetPublication(name).abandon();
        expect(fresh(name)).toBeNull();

        await fsSvc.deleteStack(name);
        expect(fresh(name)).not.toBeNull();
    });
});
