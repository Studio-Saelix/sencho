import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ComposeInputDiscoveryService } from '../services/ComposeInputDiscoveryService';
import type { ManifestBounds } from '../types/gitProjectManifest';

const BOUNDS: ManifestBounds = {
    maxFiles: 10_000,
    maxBytes: 512 * 1024 * 1024,
    maxContextBytes: 256 * 1024 * 1024,
    maxPathDepth: 64,
    maxFileBytes: 10 * 1024 * 1024,
};

let tmpRoots: string[] = [];

function makeClone(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-disc-'));
    tmpRoots.push(dir);
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
    }
    return dir;
}

afterEach(() => {
    for (const dir of tmpRoots) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch {
            // best-effort cleanup
        }
    }
    tmpRoots = [];
    vi.restoreAllMocks();
});

function discovery() {
    return ComposeInputDiscoveryService.getInstance();
}

describe('discoverFromClone', () => {
    it('classifies include, env_file and config inputs as managed', async () => {
        const clone = makeClone({
            'compose.yaml': 'include:\n  - common/redis.yaml\nservices:\n  web:\n    image: nginx\n    env_file: web.env\n    configs: [cfg]\nconfigs:\n  cfg:\n    file: nginx/nginx.conf\n',
            'common/redis.yaml': 'services:\n  redis:\n    image: redis\n',
            'web.env': 'FOO=bar\n',
            'nginx/nginx.conf': 'server {}\n',
            '.env': 'PROJECT=1\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals).toEqual([]);
        const byKind = (k: string) => result.inputs.filter((i) => i.dependencyKind === k);
        expect(byKind('explicit').map((i) => i.sourcePath)).toEqual(['compose.yaml']);
        expect(byKind('explicit')[0].materializedPath).toBe('compose.yaml');
        expect(byKind('include')[0].sourcePath).toBe('common/redis.yaml');
        expect(byKind('env_file')[0].sourcePath).toBe('web.env');
        expect(byKind('config')[0].sourcePath).toBe('nginx/nginx.conf');
        expect(result.inputs.every((i) => i.ownership === 'managed')).toBe(true);
        // content hashes are computed for file-backed inputs.
        expect(byKind('env_file')[0].contentSha256).toBeTruthy();
    });

    it('refuses out-of-bound ../ include targets', async () => {
        const clone = makeClone({
            'compose.yaml': 'include:\n  - ../outside.yaml\nservices: {}\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals.some((r) => r.kind === 'out-of-bounds' && r.actionable)).toBe(true);
    });

    it('refuses URL includes', async () => {
        const clone = makeClone({
            'compose.yaml': 'include:\n  - https://example.com/remote.yaml\nservices: {}\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals.some((r) => r.kind === 'url-include')).toBe(true);
    });

    it('refuses symlink inputs as unsafe-symlink', async () => {
        const clone = makeClone({ 'compose.yaml': 'services:\n  web:\n    image: nginx\n    env_file: linked.env\n' });
        // Create a real target and a symlink pointing at it.
        fs.writeFileSync(path.join(clone, 'target.env'), 'X=1\n');
        try {
            fs.symlinkSync('target.env', path.join(clone, 'linked.env'));
        } catch {
            // Symlinks unavailable (Windows perms); skip.
            return;
        }
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals.some((r) => r.kind === 'unsafe-symlink')).toBe(true);
    });

    it('refuses special files as special-file', async () => {
        const clone = makeClone({ 'compose.yaml': 'services:\n  web:\n    image: nginx\n    env_file: fifo.env\n' });
        // FIFOs cannot be created on Windows; mock the lstat result instead.
        fs.writeFileSync(path.join(clone, 'fifo.env'), 'X=1\n');
        const originalLstat = fs.promises.lstat.bind(fs.promises);
        vi.spyOn(fs.promises, 'lstat').mockImplementation(async (p) => {
            if (String(p).endsWith('fifo.env')) {
                return {
                    isSymbolicLink: () => false,
                    isDirectory: () => false,
                    isFile: () => true,
                    isCharacterDevice: () => true,
                    isBlockDevice: () => false,
                    isSocket: () => false,
                    isFIFO: () => false,
                    size: 4,
                } as unknown as fs.Stats;
            }
            return originalLstat(p);
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals.some((r) => r.kind === 'special-file')).toBe(true);
    });

    it('refuses paths inside submodules', async () => {
        const clone = makeClone({
            '.gitmodules': '[submodule "vendor"]\n\tpath = vendor/lib\n',
            'compose.yaml': 'services:\n  web:\n    image: nginx\n    env_file: vendor/lib/settings.env\n',
            'vendor/lib/settings.env': 'X=1\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals.some((r) => r.kind === 'submodule' && r.sourcePath === 'vendor/lib/settings.env')).toBe(true);
    });

    it('refuses LFS pointer content for file-backed inputs', async () => {
        const clone = makeClone({
            'compose.yaml': 'services:\n  web:\n    image: nginx\n    env_file: lfs.env\n',
            'lfs.env': 'version https://git-lfs.github.com/spec/v1\noid sha256:abcd\ntype file\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals.some((r) => r.kind === 'lfs-pointer')).toBe(true);
    });

    it('records host binds and external resources as unmanaged', async () => {
        const clone = makeClone({
            'compose.yaml': `services:
  web:
    image: nginx
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./data:/data
configs:
  ext:
    external: true
`,
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        const unmanaged = result.inputs.filter((i) => i.ownership === 'unmanaged');
        expect(unmanaged.some((i) => i.dependencyKind === 'bind-mount')).toBe(true);
        expect(unmanaged.some((i) => i.dependencyKind === 'config' && i.sourcePath === null)).toBe(true);
        expect(unmanaged.every((i) => i.deletionAuthority === 'none')).toBe(true);
    });

    it('materializes build contexts with dockerignore filtering and stable byte accounting', async () => {
        const clone = makeClone({
            'compose.yaml': 'services:\n  web:\n    build:\n      context: web\n',
            'web/.dockerignore': 'node_modules\n*.log\n',
            'web/Dockerfile': 'FROM node\n',
            'web/index.js': 'console.log(1)\n',
            'web/node_modules/pkg/index.js': 'big\n',
            'web/debug.log': 'trace\n',
        });
        const first = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        expect(first.refusals).toEqual([]);
        expect(first.buildContexts).toHaveLength(1);
        const ctx = first.buildContexts[0];
        expect(ctx.repoPath).toBe('web');
        expect(ctx.dockerignoreApplied).toBe(true);
        // node_modules + *.log ignored: only Dockerfile + index.js + .dockerignore counted.
        expect(ctx.ignoredCount).toBeGreaterThanOrEqual(2);
        expect(ctx.contextBytes).toBeGreaterThan(0);

        // Context byte accounting is stable across pulls of the same revision.
        const second = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        expect(second.buildContexts[0].contextBytes).toBe(first.buildContexts[0].contextBytes);
    });

    it('refuses a repo-root build context that exceeds the context cap', async () => {
        const clone = makeClone({
            'compose.yaml': 'services:\n  web:\n    build: .\n',
            'a.bin': 'a'.repeat(500),
            'b.bin': 'b'.repeat(500),
            'c.bin': 'c'.repeat(500),
        });
        const bounds = { ...BOUNDS, maxContextBytes: 1000 };
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, bounds });
        expect(result.refusals.some((r) => r.kind === 'context-unbounded')).toBe(true);
    });

    it('refuses LFS pointers inside a build context', async () => {
        const clone = makeClone({
            'compose.yaml': 'services:\n  web:\n    build: web\n',
            'web/Dockerfile': 'FROM node\n',
            'web/model.bin': 'version https://git-lfs.github.com/spec/v1\noid sha256:abcd\ntype file\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals.some((r) => r.kind === 'lfs-in-context')).toBe(true);
    });

    it('discovers the implicit compose override for single-file stacks only', async () => {
        const clone = makeClone({
            'compose.yaml': 'services:\n  web:\n    image: nginx\n',
            'compose.override.yaml': 'services:\n  web:\n    environment:\n      A: b\n',
        });
        const single = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        expect(single.inputs.some((i) => i.dependencyKind === 'implicit-override' && i.sourcePath === 'compose.override.yaml')).toBe(true);

        const multi = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml', 'compose.override.yaml'], contextDir: null, bounds: BOUNDS });
        expect(multi.inputs.some((i) => i.dependencyKind === 'implicit-override')).toBe(false);
    });

    it('enforces the aggregate file and byte caps during classification', async () => {
        const clone = makeClone({
            'compose.yaml': 'services:\n  web:\n    image: nginx\n    env_file:\n      - a.env\n      - b.env\n      - c.env\n',
            'a.env': 'A=1\n',
            'b.env': 'B=1\n',
            'c.env': 'C=1\n',
        });
        const fileBounds = { ...BOUNDS, maxFiles: 3 }; // compose.yaml + a.env + b.env fit; c.env crosses
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, bounds: fileBounds });
        expect(result.refusals.some((r) => r.kind === 'too-many-files')).toBe(true);
    });
});

describe('walkAndCopy', () => {
    it('copies managed files preserving the nested layout, skipping .git', async () => {
        const clone = makeClone({
            'compose.yaml': 'services: {}\n',
            'deploy/prod.yaml': 'services: {}\n',
            '.git/config': '[remote]\n',
        });
        const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-cand-'));
        tmpRoots.push(dest);
        const result = await discovery().walkAndCopy(clone, dest, [
            { srcRel: 'compose.yaml', destRel: 'compose.yaml' },
            { srcRel: 'deploy/prod.yaml', destRel: 'deploy/prod.yaml' },
        ], [], BOUNDS);
        expect(result.copiedFiles).toBe(2);
        expect(fs.existsSync(path.join(dest, 'compose.yaml'))).toBe(true);
        expect(fs.existsSync(path.join(dest, 'deploy/prod.yaml'))).toBe(true);
        expect(fs.existsSync(path.join(dest, '.git'))).toBe(false);
    });

    it('copies build contexts with dockerignore filtering', async () => {
        const clone = makeClone({
            'compose.yaml': 'services:\n  web:\n    build:\n      context: web\n',
            'web/.dockerignore': 'node_modules\n',
            'web/Dockerfile': 'FROM node\n',
            'web/index.js': 'console.log(1)\n',
            'web/node_modules/pkg/index.js': 'big\n',
        });
        const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-cand-'));
        tmpRoots.push(dest);
        const discovery = ComposeInputDiscoveryService.getInstance();
        const inventory = await discovery.discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        await discovery.walkAndCopy(clone, dest, [], inventory.contextCopyPlans, BOUNDS);
        expect(fs.existsSync(path.join(dest, 'web/Dockerfile'))).toBe(true);
        expect(fs.existsSync(path.join(dest, 'web/index.js'))).toBe(true);
        expect(fs.existsSync(path.join(dest, 'web/node_modules'))).toBe(false);
    });

    it('throws with running counts when the byte cap is crossed mid-copy', async () => {
        const clone = makeClone({
            'a.bin': 'a'.repeat(1024),
            'b.bin': 'b'.repeat(1024),
        });
        const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-cand-'));
        tmpRoots.push(dest);
        const bounds = { ...BOUNDS, maxBytes: 1500 };
        await expect(
            discovery().walkAndCopy(clone, dest, [
                { srcRel: 'a.bin', destRel: 'a.bin' },
                { srcRel: 'b.bin', destRel: 'b.bin' },
            ], [], bounds),
        ).rejects.toThrow(/exceeds 1500 bytes/);
    });

    it('rejects case-colliding destination paths', async () => {
        const clone = makeClone({ 'A.TXT': '1\n', 'a.txt': '2\n' });
        const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-cand-'));
        tmpRoots.push(dest);
        await expect(
            discovery().walkAndCopy(clone, dest, [
                { srcRel: 'A.TXT', destRel: 'A.TXT' },
                { srcRel: 'a.txt', destRel: 'a.txt' },
            ], [], BOUNDS),
        ).rejects.toThrow(/case-insensitive/);
    });
});

describe('syncEnv ownership (audit C-2)', () => {
    it('marks the repo-root .env unmanaged and unhashed when syncEnv owns the path', async () => {
        const clone = makeClone({
            'compose.yaml': 'services:\n  web:\n    image: nginx\n',
            '.env': 'REPO=1\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, syncEnv: true, bounds: BOUNDS });
        const envEntries = result.inputs.filter((i) => i.materializedPath === '.env' || i.dependencyKind === 'interpolation-env');
        expect(envEntries).toHaveLength(1);
        expect(envEntries[0].ownership).toBe('unmanaged');
        expect(envEntries[0].contentSha256).toBeNull();
        expect(envEntries[0].deletionAuthority).toBe('none');
    });

    it('keeps the repo .env managed when syncEnv is off', async () => {
        const clone = makeClone({
            'compose.yaml': 'services:\n  web:\n    image: nginx\n',
            '.env': 'REPO=1\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, syncEnv: false, bounds: BOUNDS });
        const envEntries = result.inputs.filter((i) => i.dependencyKind === 'interpolation-env');
        expect(envEntries).toHaveLength(1);
        expect(envEntries[0].ownership).toBe('managed');
        expect(envEntries[0].contentSha256).toBeTruthy();
    });
});

describe('explicit dockerfile resolution (audit round 2 C-3)', () => {
    it('rebases the dockerfile against its build context', async () => {
        const clone = makeClone({
            'compose.yaml': 'services:\n  web:\n    build:\n      context: web\n      dockerfile: Dockerfile.dev\n',
            'web/Dockerfile.dev': 'FROM nginx\n',
            'web/app.js': 'console.log(1)\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals).toEqual([]);
        expect(result.buildContexts).toHaveLength(1);
        expect(result.buildContexts[0].repoPath).toBe('web');
        expect(result.buildContexts[0].dockerfile).toBe('web/Dockerfile.dev');
        // The dockerfile's files are part of the context inventory.
        expect(result.buildContexts[0].files.some((f) => f.path === 'Dockerfile.dev')).toBe(true);
    });

    it('allows a ../ dockerfile inside the repository and materializes it separately', async () => {
        const clone = makeClone({
            'compose.yaml': 'services:\n  web:\n    build:\n      context: web\n      dockerfile: ../shared/Dockerfile\n',
            'web/app.js': 'x\n',
            'shared/Dockerfile': 'FROM nginx\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals).toEqual([]);
        const dockerfileEntry = result.inputs.find((i) => i.dependencyKind === 'dockerfile' && i.materializedPath === 'shared/Dockerfile');
        expect(dockerfileEntry).toBeTruthy();
        expect(dockerfileEntry?.ownership).toBe('managed');
        expect(dockerfileEntry?.contentSha256).toBeTruthy();
    });

    it('refuses a dockerfile that escapes the repository', async () => {
        const clone = makeClone({
            'compose.yaml': 'services:\n  web:\n    build:\n      context: web\n      dockerfile: ../../outside/Dockerfile\n',
            'web/app.js': 'x\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals.some((r) => r.kind === 'out-of-bounds' && String(r.sourcePath).includes('Dockerfile'))).toBe(true);
    });
});

describe('repo-root build context overlap (audit round 2)', () => {
    it('copies a repo-root context without duplicating managed files', async () => {
        const clone = makeClone({
            'compose.yaml': 'services:\n  web:\n    build: .\n',
            'src/main.go': 'package main\n',
        });
        const inv = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        const managed = inv.inputs.filter((i) => i.ownership === 'managed' && i.materializedPath !== null && i.dependencyKind !== 'build-context');
        const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-rootctx-'));
        tmpRoots.push(dest);
        const result = await discovery().walkAndCopy(clone, dest, managed.map((i) => ({ srcRel: i.sourcePath!, destRel: i.materializedPath! })), inv.contextCopyPlans, BOUNDS);
        // compose.yaml + src/main.go: no duplicate-path failure, no double copy.
        expect(result.copiedFiles).toBe(2);
        expect(fs.readFileSync(path.join(dest, 'src/main.go'), 'utf8')).toBe('package main\n');
    });
});
