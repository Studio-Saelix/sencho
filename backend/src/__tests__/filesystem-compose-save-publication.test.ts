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
    fsSync.writeFileSync(path.join(stackDir, 'compose.yaml'), composeContent(['web']), 'utf8');
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
});
