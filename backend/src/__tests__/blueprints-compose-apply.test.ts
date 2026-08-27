/**
 * Regression: Blueprint apply must write canonical compose.yaml (overwriting
 * createStack's nginx scaffold) and remove alternate root Compose filenames so
 * Docker Compose discovery cannot prefer a leftover docker-compose.yml.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let BlueprintService: typeof import('../services/BlueprintService').BlueprintService;
let FileSystemService: typeof import('../services/FileSystemService').FileSystemService;
let ComposeService: typeof import('../services/ComposeService').ComposeService;
let StackOpLockService: typeof import('../services/StackOpLockService').StackOpLockService;
let counter = 0;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ BlueprintService } = await import('../services/BlueprintService'));
    ({ FileSystemService } = await import('../services/FileSystemService'));
    ({ ComposeService } = await import('../services/ComposeService'));
    ({ StackOpLockService } = await import('../services/StackOpLockService'));
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
    counter += 1;
    StackOpLockService.resetForTests();
    vi.restoreAllMocks();
});

function seedLocalNode(): number {
    const composeDir = process.env.COMPOSE_DIR!;
    const result = DatabaseService.getInstance().getDb().prepare(
        `INSERT INTO nodes (name, type, mode, compose_dir, is_default, status, created_at)
         VALUES (?, 'local', 'proxy', ?, 0, 'online', ?)`,
    ).run(`bp-compose-node-${counter}`, composeDir, Date.now());
    return result.lastInsertRowid as number;
}

function defaultNodeId(): number {
    const id = DatabaseService.getInstance().getNodes().find(n => n.is_default)?.id;
    if (id === undefined) throw new Error('default node missing');
    return id;
}

/** Point the default node at the test COMPOSE_DIR (FileSystemService.getInstance uses it). */
function bindDefaultComposeDir(): number {
    const composeDir = process.env.COMPOSE_DIR!;
    DatabaseService.getInstance().getDb()
        .prepare('UPDATE nodes SET compose_dir = ? WHERE is_default = 1')
        .run(composeDir);
    return defaultNodeId();
}

async function expectMissing(filePath: string): Promise<void> {
    await expect(fsPromises.access(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
}

async function anyExists(...paths: string[]): Promise<boolean> {
    const results = await Promise.all(
        paths.map((p) => fsPromises.access(p).then(() => true, () => false)),
    );
    return results.some(Boolean);
}

describe('Blueprint compose apply (real filesystem)', () => {
    it('first-time apply overwrites createStack nginx scaffold with blueprint content in compose.yaml', async () => {
        const nodeId = seedLocalNode();
        const stackName = `bp-first-${counter}`;
        const composeContent = 'services:\n  web:\n    image: traefik:v3\n';
        const markerContent = JSON.stringify({ blueprintId: 1, revision: 1, lastApplied: Date.now() }, null, 2);

        const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack').mockResolvedValue({ recoveryId: null, deployedGenerationId: null });

        const outcome = await BlueprintService.getInstance().applyLocalUnderLock(
            nodeId,
            stackName,
            composeContent,
            markerContent,
            '/api/blueprints/test/apply',
        );
        expect(outcome).toEqual({ ran: true });

        const stackDir = path.join(process.env.COMPOSE_DIR!, stackName);
        expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf-8')).toBe(composeContent);
        await expectMissing(path.join(stackDir, 'docker-compose.yml'));
        expect(await fsPromises.readFile(path.join(stackDir, '.blueprint.json'), 'utf-8')).toBe(markerContent);

        const resolved = await FileSystemService.getInstance(nodeId).getComposeFilename(stackName);
        expect(resolved).toBe('compose.yaml');
        expect(deploySpy).toHaveBeenCalledTimes(1);
    });

    it('re-apply on a dual-file stack replaces compose.yaml and removes alternate root Compose files before deploy', async () => {
        const nodeId = seedLocalNode();
        const stackName = `bp-heal-${counter}`;
        const stackDir = path.join(process.env.COMPOSE_DIR!, stackName);
        await fsPromises.mkdir(stackDir, { recursive: true });
        await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services:\n  stale:\n    image: nginx:latest\n');
        await fsPromises.writeFile(path.join(stackDir, 'compose.yml'), 'services:\n  a:\n    image: a\n');
        await fsPromises.writeFile(path.join(stackDir, 'docker-compose.yaml'), 'services:\n  b:\n    image: b\n');
        await fsPromises.writeFile(path.join(stackDir, 'docker-compose.yml'), 'services:\n  c:\n    image: c\n');
        await fsPromises.writeFile(
            path.join(stackDir, '.blueprint.json'),
            JSON.stringify({ blueprintId: 2, revision: 2, lastApplied: 1 }, null, 2),
        );

        const composeContent = 'services:\n  app:\n    image: redis:7\n';
        const markerContent = JSON.stringify({ blueprintId: 2, revision: 3, lastApplied: Date.now() }, null, 2);

        let alternatesPresentAtDeploy = true;
        const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack').mockImplementation(async () => {
            alternatesPresentAtDeploy = await anyExists(
                path.join(stackDir, 'compose.yml'),
                path.join(stackDir, 'docker-compose.yaml'),
                path.join(stackDir, 'docker-compose.yml'),
            );
            return { recoveryId: null, deployedGenerationId: null };
        });

        const outcome = await BlueprintService.getInstance().applyLocalUnderLock(
            nodeId,
            stackName,
            composeContent,
            markerContent,
            '/api/blueprints/test/apply',
        );
        expect(outcome).toEqual({ ran: true });

        expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf-8')).toBe(composeContent);
        expect(alternatesPresentAtDeploy).toBe(false);
        await expectMissing(path.join(stackDir, 'compose.yml'));
        await expectMissing(path.join(stackDir, 'docker-compose.yaml'));
        await expectMissing(path.join(stackDir, 'docker-compose.yml'));
        expect(await fsPromises.readFile(path.join(stackDir, '.blueprint.json'), 'utf-8')).toBe(markerContent);
        expect(deploySpy).toHaveBeenCalledTimes(1);
    });

    it('does not write a new marker when deploy fails; rolls back a newly created stack', async () => {
        const nodeId = seedLocalNode();
        const stackName = `bp-partial-${counter}`;
        const composeContent = 'services:\n  web:\n    image: traefik:v3\n';
        const markerContent = JSON.stringify({ blueprintId: 7, revision: 1, lastApplied: Date.now() }, null, 2);
        const stackDir = path.join(process.env.COMPOSE_DIR!, stackName);

        vi.spyOn(ComposeService.prototype, 'deployStack').mockRejectedValue(new Error('docker unavailable'));

        await expect(
            BlueprintService.getInstance().applyLocalUnderLock(
                nodeId,
                stackName,
                composeContent,
                markerContent,
                '/api/blueprints/test/apply',
            ),
        ).rejects.toThrow(/docker unavailable/);

        await expectMissing(path.join(stackDir, '.blueprint.json'));
        await expectMissing(stackDir);
    });

    it('keeps the prior marker when a re-apply deploy fails', async () => {
        const nodeId = seedLocalNode();
        const stackName = `bp-reapply-fail-${counter}`;
        const stackDir = path.join(process.env.COMPOSE_DIR!, stackName);
        const priorMarker = JSON.stringify({ blueprintId: 8, revision: 2, lastApplied: 1 }, null, 2);
        await fsPromises.mkdir(stackDir, { recursive: true });
        await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services:\n  old:\n    image: nginx\n');
        await fsPromises.writeFile(path.join(stackDir, '.blueprint.json'), priorMarker);

        vi.spyOn(ComposeService.prototype, 'deployStack').mockRejectedValue(new Error('deploy blew up'));

        await expect(
            BlueprintService.getInstance().applyLocalUnderLock(
                nodeId,
                stackName,
                'services:\n  new:\n    image: redis:7\n',
                JSON.stringify({ blueprintId: 8, revision: 3, lastApplied: Date.now() }, null, 2),
                '/api/blueprints/test/apply',
            ),
        ).rejects.toThrow(/deploy blew up/);

        expect(await fsPromises.readFile(path.join(stackDir, '.blueprint.json'), 'utf-8')).toBe(priorMarker);
        expect(await fsPromises.access(stackDir).then(() => true, () => false)).toBe(true);
    });

    it('refuses to overwrite an existing unmanaged stack directory inside the lock', async () => {
        const { BlueprintNameConflictError } = await import('../services/BlueprintService');
        const nodeId = seedLocalNode();
        const stackName = `bp-hijack-${counter}`;
        const stackDir = path.join(process.env.COMPOSE_DIR!, stackName);
        await fsPromises.mkdir(stackDir, { recursive: true });
        const original = 'services:\n  mine:\n    image: nginx:alpine\n';
        await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), original);

        const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack').mockResolvedValue({ recoveryId: null, deployedGenerationId: null });

        await expect(
            BlueprintService.getInstance().applyLocalUnderLock(
                nodeId,
                stackName,
                'services:\n  bp:\n    image: redis:7\n',
                JSON.stringify({ blueprintId: 99, revision: 1, lastApplied: Date.now() }, null, 2),
                '/api/blueprints/test/apply',
            ),
        ).rejects.toBeInstanceOf(BlueprintNameConflictError);

        expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf-8')).toBe(original);
        await expectMissing(path.join(stackDir, '.blueprint.json'));
        expect(deploySpy).not.toHaveBeenCalled();
    });
});

describe('FileSystemService.removeAlternateRootComposeFiles', () => {
    it('removes all three alternate filenames and leaves compose.yaml', async () => {
        const nodeId = bindDefaultComposeDir();
        const stackName = `bp-alts-${counter}`;
        const stackDir = path.join(process.env.COMPOSE_DIR!, stackName);
        await fsPromises.mkdir(stackDir, { recursive: true });
        await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services:\n  keep:\n    image: keep\n');
        await fsPromises.writeFile(path.join(stackDir, 'compose.yml'), 'x');
        await fsPromises.writeFile(path.join(stackDir, 'docker-compose.yaml'), 'y');
        await fsPromises.writeFile(path.join(stackDir, 'docker-compose.yml'), 'z');

        await FileSystemService.getInstance(nodeId).removeAlternateRootComposeFiles(stackName);

        expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf-8')).toContain('image: keep');
        await expectMissing(path.join(stackDir, 'compose.yml'));
        await expectMissing(path.join(stackDir, 'docker-compose.yaml'));
        await expectMissing(path.join(stackDir, 'docker-compose.yml'));
    });

    it('treats absent alternate files as success', async () => {
        const nodeId = bindDefaultComposeDir();
        const stackName = `bp-absent-${counter}`;
        const stackDir = path.join(process.env.COMPOSE_DIR!, stackName);
        await fsPromises.mkdir(stackDir, { recursive: true });
        await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services:\n  keep:\n    image: keep\n');

        await expect(
            FileSystemService.getInstance(nodeId).removeAlternateRootComposeFiles(stackName),
        ).resolves.toBeUndefined();
        expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf-8')).toContain('image: keep');
    });

    it('logs and continues when a non-ENOENT unlink failure occurs', async () => {
        const nodeId = bindDefaultComposeDir();
        const stackName = `bp-eacces-${counter}`;
        const stackDir = path.join(process.env.COMPOSE_DIR!, stackName);
        await fsPromises.mkdir(stackDir, { recursive: true });
        await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services:\n  keep:\n    image: keep\n');
        await fsPromises.writeFile(path.join(stackDir, 'docker-compose.yml'), 'services:\n  stale:\n    image: stale\n');
        await fsPromises.writeFile(path.join(stackDir, 'compose.yml'), 'services:\n  other:\n    image: other\n');

        const originalUnlink = fsPromises.unlink.bind(fsPromises);
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.spyOn(fsPromises, 'unlink').mockImplementation(async (target) => {
            const asString = String(target);
            if (asString.endsWith(`${path.sep}docker-compose.yml`) || asString.endsWith('/docker-compose.yml')) {
                const err = new Error('permission denied') as NodeJS.ErrnoException;
                err.code = 'EACCES';
                throw err;
            }
            return originalUnlink(target);
        });

        await FileSystemService.getInstance(nodeId).removeAlternateRootComposeFiles(stackName);

        expect(warnSpy.mock.calls.some((args) => {
            const label = String(args[0] ?? '');
            const detail = String(args[1] ?? '');
            return label.includes('Could not remove alternate compose file')
                && label.includes('docker-compose.yml')
                && detail.includes('permission denied');
        })).toBe(true);
        expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf-8')).toContain('image: keep');
        await expectMissing(path.join(stackDir, 'compose.yml'));
        expect(await fsPromises.readFile(path.join(stackDir, 'docker-compose.yml'), 'utf-8')).toContain('image: stale');
    });
});
