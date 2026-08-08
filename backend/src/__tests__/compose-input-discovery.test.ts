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
            // Included files resolve their own relative paths against their
            // own directory (each included file is its own project).
            'common/redis.yaml': 'services:\n  redis:\n    image: redis\n    env_file: redis.env\n',
            'web.env': 'FOO=bar\n',
            'common/redis.env': 'REDIS=1\n',
            'nginx/nginx.conf': 'server {}\n',
            '.env': 'PROJECT=1\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals).toEqual([]);
        const byKind = (k: string) => result.inputs.filter((i) => i.dependencyKind === k);
        expect(byKind('explicit').map((i) => i.sourcePath)).toEqual(['compose.yaml']);
        expect(byKind('explicit')[0].materializedPath).toBe('compose.yaml');
        expect(byKind('include')[0].sourcePath).toBe('common/redis.yaml');
        const envFiles = byKind('env_file');
        expect(envFiles.some((i) => i.sourcePath === 'web.env')).toBe(true);
        // The included file's env_file resolves against its own directory.
        expect(envFiles.some((i) => i.sourcePath === 'common/redis.env')).toBe(true);
        expect(byKind('config')[0].sourcePath).toBe('nginx/nginx.conf');
        // The included project's default interpolation .env (common/.env) is
        // absent here, so it is recorded unmanaged and tolerated; every file
        // actually present in the repository is managed.
        const missingDefaultEnv = result.inputs.find((i) => i.dependencyKind === 'interpolation-env' && i.sourcePath === 'common/.env');
        expect(missingDefaultEnv?.ownership).toBe('unmanaged');
        expect(missingDefaultEnv?.note).toContain('No project .env');
        expect(result.inputs.filter((i) => i.ownership === 'unmanaged')).toHaveLength(1);
        expect(result.inputs.filter((i) => i.ownership === 'managed').every((i) => i.state === 'present')).toBe(true);
        // content hashes are computed for file-backed inputs.
        expect(envFiles[0].contentSha256).toBeTruthy();
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

    it('counts a shared-context union once per unique file', async () => {
        const clone = makeClone({
            'compose.yaml': `services:
  one:
    build:
      context: web
      dockerfile: Dockerfile.one
  two:
    build:
      context: web
      dockerfile: Dockerfile.two
`,
            'web/Dockerfile.one': 'FROM scratch\n',
            'web/Dockerfile.two': 'FROM scratch\n',
            'web/Dockerfile.one.dockerignore': 'b.bin\n',
            'web/Dockerfile.two.dockerignore': 'a.bin\n',
            'web/common.bin': 'c'.repeat(100),
            'web/a.bin': 'a'.repeat(100),
            'web/b.bin': 'b'.repeat(100),
        });
        const result = await discovery().discoverFromClone({
            cloneDir: clone,
            composePaths: ['compose.yaml'],
            contextDir: null,
            bounds: { ...BOUNDS, maxContextBytes: 350 },
        });

        expect(result.refusals.some((r) => r.kind === 'context-unbounded')).toBe(false);
        expect(result.buildContexts).toHaveLength(1);
        expect(result.buildContexts[0].contextBytes).toBe(338);
        expect(result.buildContexts[0].files).toHaveLength(7);

        const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-context-union-'));
        tmpRoots.push(dest);
        const managedFiles = result.inputs
            .filter((input) => input.ownership === 'managed'
                && input.materializedPath !== null
                && input.dependencyKind !== 'build-context'
                && input.dependencyKind !== 'build-additional-context')
            .map((input) => ({ srcRel: input.sourcePath!, destRel: input.materializedPath! }));
        await discovery().walkAndCopy(clone, dest, managedFiles, result.contextCopyPlans, BOUNDS);
        expect(fs.existsSync(path.join(dest, 'web/a.bin'))).toBe(true);
        expect(fs.existsSync(path.join(dest, 'web/b.bin'))).toBe(true);
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

describe('dynamic and submodule-backed inputs (audit round 8 B-2)', () => {
    it('persists dynamic ${VAR} paths as explicit unmanaged entries', async () => {
        const clone = makeClone({
            'compose.yaml': 'services:\n  web:\n    image: nginx\n    env_file: ${ENV_FILE:-default.env}\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals).toEqual([]);
        const dyn = result.inputs.filter((i) => i.dependencyKind === 'env_file' && i.sourcePath?.includes('${ENV_FILE'));
        expect(dyn).toHaveLength(1);
        expect(dyn[0].ownership).toBe('unmanaged');
        expect(dyn[0].materializedPath).toBeNull();
        expect(dyn[0].deletionAuthority).toBe('none');
        expect(dyn[0].note).toContain('resolved by Compose at deploy time');
        // The dynamic path is never searched for as a file in the clone.
        expect(result.refusals.some((r) => r.kind === 'missing-file')).toBe(false);
    });

    it('refuses a build context rooted inside a submodule', async () => {
        const clone = makeClone({
            '.gitmodules': '[submodule "vendor"]\n\tpath = vendor/lib\n',
            'compose.yaml': 'services:\n  web:\n    build: vendor/lib\n',
            'vendor/lib/Dockerfile': 'FROM nginx\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals.some((r) => r.kind === 'submodule' && String(r.sourcePath).includes('vendor/lib'))).toBe(true);
    });

    it('refuses a repo-root context containing a submodule directory', async () => {
        const clone = makeClone({
            '.gitmodules': '[submodule "vendor"]\n\tpath = vendor/lib\n',
            'compose.yaml': 'services:\n  web:\n    build: .\n',
            'Dockerfile': 'FROM nginx\n',
            'vendor/lib/Dockerfile': 'FROM nginx\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals.some((r) => r.kind === 'submodule' && String(r.reason).includes('vendor/lib'))).toBe(true);
    });

    it('allows a submodule directory excluded by the context dockerignore', async () => {
        const clone = makeClone({
            '.gitmodules': '[submodule "vendor"]\n\tpath = vendor/lib\n',
            'compose.yaml': 'services:\n  web:\n    build: .\n',
            'Dockerfile': 'FROM nginx\n',
            '.dockerignore': 'vendor\n',
            'vendor/lib/Dockerfile': 'FROM nginx\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals).toEqual([]);
    });
});

describe('effective invocation path resolution (audit round 8 B-3)', () => {
    it('resolves merged-file relative paths against the base file directory, never the declaring file', async () => {
        const clone = makeClone({
            'deploy/base.yaml': 'services:\n  web:\n    image: nginx\n    configs: [cfg]\nconfigs:\n  cfg:\n    file: nginx.conf\n',
            // The second -f file lives in a DIFFERENT directory: its relative
            // paths still resolve against the base file's directory (deploy/),
            // not its own.
            'configs/prod.yaml': 'services:\n  web:\n    env_file: prod.env\n',
            'deploy/nginx.conf': 'server {}\n',
            'deploy/prod.env': 'A=1\n',
            // Same-named files at the repo root must NOT be picked up.
            'nginx.conf': 'WRONG server {}\n',
            'prod.env': 'WRONG=1\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['deploy/base.yaml', 'configs/prod.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals).toEqual([]);
        const prodEnv = result.inputs.find((i) => i.dependencyKind === 'env_file');
        expect(prodEnv?.sourcePath).toBe('deploy/prod.env');
        // Materialized at the stack root (the runtime project dir).
        expect(prodEnv?.materializedPath).toBe('prod.env');
        const cfg = result.inputs.find((i) => i.dependencyKind === 'config');
        expect(cfg?.sourcePath).toBe('deploy/nginx.conf');
        expect(cfg?.materializedPath).toBe('nginx.conf');
    });

    it('refuses a base-dir-relative file that is missing instead of falling back to a same-named root file', async () => {
        const clone = makeClone({
            'deploy/base.yaml': 'services:\n  web:\n    image: nginx\n    env_file: app.env\n',
            // No deploy/app.env: the old declaring-dir-first + repo-root
            // fallback would silently materialize the root decoy.
            'app.env': 'WRONG=1\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['deploy/base.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals.some((r) => r.kind === 'missing-file' && r.sourcePath === 'deploy/app.env')).toBe(true);
        expect(result.inputs.some((i) => i.sourcePath === 'app.env' && i.ownership === 'managed')).toBe(false);
    });

    it('resolves the primary\'s includes against the context dir but keeps the included file\'s own paths on its own project directory', async () => {
        const clone = makeClone({
            // With --project-directory deploy, the primary's include path
            // resolves against deploy/ (the top-level project base).
            'compose.yaml': 'include:\n  - common/redis.yaml\nservices: {}\n',
            'deploy/common/redis.yaml': 'services:\n  redis:\n    image: redis\n    env_file: redis.env\n',
            // The included file's own env_file resolves against ITS project
            // directory (deploy/common), not the context dir.
            'deploy/common/redis.env': 'REDIS=1\n',
            'deploy/redis.env': 'WRONG=1\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: 'deploy', bounds: BOUNDS });
        expect(result.refusals).toEqual([]);
        const include = result.inputs.find((i) => i.dependencyKind === 'include');
        expect(include?.sourcePath).toBe('deploy/common/redis.yaml');
        expect(include?.materializedPath).toBe('deploy/common/redis.yaml');
        const env = result.inputs.find((i) => i.dependencyKind === 'env_file');
        expect(env?.sourcePath).toBe('deploy/common/redis.env');
        expect(env?.materializedPath).toBe('deploy/common/redis.env');
    });

    it('materializes base-file-relative paths at the stack root, stripping the base directory prefix', async () => {
        const clone = makeClone({
            'deploy/base.yaml': 'services:\n  web:\n    image: nginx\n    env_file: prod.env\n',
            'deploy/prod.env': 'A=1\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['deploy/base.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals).toEqual([]);
        const env = result.inputs.find((i) => i.dependencyKind === 'env_file');
        // The primary file lands at the stack root, so the runtime project dir
        // is the stack root: prod.env must live at the stack root, not under
        // deploy/.
        expect(env?.sourcePath).toBe('deploy/prod.env');
        expect(env?.materializedPath).toBe('prod.env');
    });

    it('resolves project-relative paths against the configured project directory', async () => {
        const clone = makeClone({
            'compose.yaml': 'services:\n  web:\n    image: nginx\n    env_file: app.env\n',
            'deploy/app.env': 'A=1\n',
            'app.env': 'WRONG=1\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: 'deploy', bounds: BOUNDS });
        expect(result.refusals).toEqual([]);
        const env = result.inputs.find((i) => i.dependencyKind === 'env_file');
        expect(env?.sourcePath).toBe('deploy/app.env');
        expect(env?.materializedPath).toBe('deploy/app.env');
    });

    it('does not auto-discover an override when the project directory makes the invocation explicit', async () => {
        const clone = makeClone({
            'compose.yaml': 'services:\n  web:\n    image: nginx\n',
            'compose.override.yaml': 'services:\n  web:\n    environment:\n      A: b\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: 'deploy', bounds: BOUNDS });
        // A context dir forces explicit -f at runtime, which suppresses
        // auto-discovery; the override must not enter the inventory.
        expect(result.inputs.some((i) => i.dependencyKind === 'implicit-override')).toBe(false);
    });

    it('rebases a subdir build context to the stack root for the materialized layout', async () => {
        const clone = makeClone({
            'deploy/base.yaml': 'services:\n  web:\n    build:\n      context: web\n      dockerfile: Dockerfile\n',
            'deploy/web/Dockerfile': 'FROM nginx\n',
            'deploy/web/app.js': 'console.log(1)\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['deploy/base.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals).toEqual([]);
        expect(result.buildContexts).toHaveLength(1);
        const ctx = result.buildContexts[0];
        expect(ctx.repoPath).toBe('web');
        expect(ctx.dockerfile).toBe('deploy/web/Dockerfile');
        const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-b3-ctx-'));
        tmpRoots.push(dest);
        const managed = result.inputs.filter((i) => i.ownership === 'managed' && i.materializedPath !== null && i.dependencyKind !== 'build-context')
            .map((i) => ({ srcRel: i.sourcePath!, destRel: i.materializedPath! }));
        await discovery().walkAndCopy(clone, dest, managed, result.contextCopyPlans, BOUNDS);
        expect(fs.existsSync(path.join(dest, 'web/Dockerfile'))).toBe(true);
        expect(fs.existsSync(path.join(dest, 'web/app.js'))).toBe(true);
    });
});

describe('nested-primary runtime path equivalence (audit round 9 B-3)', () => {
    it('materializes a nested primary\'s include graph at the stack root', async () => {
        const clone = makeClone({
            'deploy/base.yaml': 'include:\n  - common.yaml\nservices: {}\n',
            'deploy/common.yaml': 'services:\n  web:\n    image: nginx\n    env_file: web.env\n',
            'deploy/web.env': 'A=1\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['deploy/base.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals).toEqual([]);
        const include = result.inputs.find((i) => i.dependencyKind === 'include');
        expect(include?.sourcePath).toBe('deploy/common.yaml');
        expect(include?.materializedPath).toBe('common.yaml');
        // The included file's own project-relative input also moves to the
        // stack root: at runtime compose.yaml includes ./common.yaml, whose
        // env_file resolves against its own (relocated) directory.
        const env = result.inputs.find((i) => i.dependencyKind === 'env_file');
        expect(env?.sourcePath).toBe('deploy/web.env');
        expect(env?.materializedPath).toBe('web.env');

        // The candidate mirrors the runtime layout.
        const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-b3-graph-'));
        tmpRoots.push(dest);
        const managed = result.inputs.filter((i) => i.ownership === 'managed' && i.materializedPath !== null && i.dependencyKind !== 'build-context')
            .map((i) => ({ srcRel: i.sourcePath!, destRel: i.materializedPath! }));
        await discovery().walkAndCopy(clone, dest, managed, result.contextCopyPlans, BOUNDS);
        expect(fs.existsSync(path.join(dest, 'common.yaml'))).toBe(true);
        expect(fs.existsSync(path.join(dest, 'web.env'))).toBe(true);
        expect(fs.existsSync(path.join(dest, 'deploy/common.yaml'))).toBe(false);
    });

    it('recurses through a nested primary\'s include graph, stripping the prefix at every level', async () => {
        const clone = makeClone({
            'deploy/base.yaml': 'include:\n  - common.yaml\nservices: {}\n',
            'deploy/common.yaml': 'include:\n  - nested/inner.yaml\nservices: {}\n',
            'deploy/nested/inner.yaml': 'services:\n  web:\n    image: nginx\n    env_file: inner.env\n',
            'deploy/nested/inner.env': 'A=1\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['deploy/base.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals).toEqual([]);
        const inner = result.inputs.find((i) => i.dependencyKind === 'include' && i.sourcePath === 'deploy/nested/inner.yaml');
        expect(inner?.materializedPath).toBe('nested/inner.yaml');
        const env = result.inputs.find((i) => i.dependencyKind === 'env_file');
        expect(env?.sourcePath).toBe('deploy/nested/inner.env');
        expect(env?.materializedPath).toBe('nested/inner.env');
    });

    it('resolves an additional -f file\'s includes against the base file\'s directory', async () => {
        const clone = makeClone({
            'deploy/base.yaml': 'services: {}\n',
            // The merged project's base is deploy/ (the first -f file); an
            // include declared in the second file resolves against it.
            'infra/prod.yaml': 'include:\n  - prod-common.yaml\nservices: {}\n',
            'deploy/prod-common.yaml': 'services:\n  web:\n    image: nginx\n',
            'infra/prod-common.yaml': 'services:\n  WRONG:\n    image: nginx\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['deploy/base.yaml', 'infra/prod.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals).toEqual([]);
        const include = result.inputs.find((i) => i.dependencyKind === 'include');
        expect(include?.sourcePath).toBe('deploy/prod-common.yaml');
        // At runtime the project dir is the stack root, so the included file
        // moves there too.
        expect(include?.materializedPath).toBe('prod-common.yaml');
    });

    it('applies a divergent include project_directory to the subtree project base', async () => {
        const clone = makeClone({
            'compose.yaml': 'include:\n  - path: app/compose.yaml\n    project_directory: other\nservices: {}\n',
            'app/compose.yaml': 'services:\n  web:\n    image: nginx\n    env_file: x.env\n',
            'other/x.env': 'A=1\n',
            'app/x.env': 'WRONG=1\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals).toEqual([]);
        const env = result.inputs.find((i) => i.dependencyKind === 'env_file');
        // project_directory re-bases the subtree: the env file lives under
        // other/, not next to the included file.
        expect(env?.sourcePath).toBe('other/x.env');
        expect(env?.materializedPath).toBe('other/x.env');
    });

    it('materializes a nested primary\'s extends.file target at the stack root with its own inputs', async () => {
        const clone = makeClone({
            'deploy/base.yaml': 'services:\n  web:\n    extends:\n      file: web-base.yaml\n      service: web-base\n',
            'deploy/web-base.yaml': 'services:\n  web-base:\n    image: nginx\n    label_file: labels.txt\n',
            'deploy/labels.txt': 'a=b\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['deploy/base.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals).toEqual([]);
        const ext = result.inputs.find((i) => i.dependencyKind === 'extends');
        expect(ext?.sourcePath).toBe('deploy/web-base.yaml');
        expect(ext?.materializedPath).toBe('web-base.yaml');
        const label = result.inputs.find((i) => i.dependencyKind === 'label_file');
        expect(label?.sourcePath).toBe('deploy/labels.txt');
        expect(label?.materializedPath).toBe('labels.txt');
    });

    it('refuses a nested-primary include that escapes the stack root', async () => {
        const clone = makeClone({
            'deploy/base.yaml': 'include:\n  - ../shared.yaml\nservices: {}\n',
            'shared.yaml': 'services: {}\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['deploy/base.yaml'], contextDir: null, bounds: BOUNDS });
        // ../shared.yaml stays inside the repository (deploy/../shared.yaml)
        // but escapes the stack root at runtime; it must be refused, never
        // silently dropped or adopted from the repo root.
        expect(result.refusals.some((r) => r.actionable && r.kind === 'out-of-bounds' && String(r.sourcePath).includes('../shared.yaml'))).toBe(true);
        expect(result.inputs.some((i) => i.sourcePath === 'shared.yaml' && i.ownership === 'managed')).toBe(false);
    });
});

describe('included-project default env and project-base includes (audit round 10 B-1/B-2)', () => {
    it('materializes an included project\'s default .env as a managed sensitive input', async () => {
        const clone = makeClone({
            'compose.yaml': 'include:\n  - modules/app/compose.yaml\nservices: {}\n',
            'modules/app/compose.yaml': 'services:\n  app:\n    image: app:${TAG:-latest}\n',
            'modules/app/.env': 'TAG=production\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals).toEqual([]);
        const defaultEnv = result.inputs.find((i) => i.dependencyKind === 'interpolation-env' && i.sourcePath === 'modules/app/.env');
        expect(defaultEnv?.ownership).toBe('managed');
        expect(defaultEnv?.materializedPath).toBe('modules/app/.env');
        expect(defaultEnv?.contentSha256).toBeTruthy();
        expect(defaultEnv?.sensitivity).toBe('high');
    });

    it('tolerates a missing included-project default .env without refusing', async () => {
        const clone = makeClone({
            'compose.yaml': 'include:\n  - modules/app/compose.yaml\nservices: {}\n',
            'modules/app/compose.yaml': 'services:\n  app:\n    image: app:${TAG:-latest}\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals).toEqual([]);
        const defaultEnv = result.inputs.find((i) => i.dependencyKind === 'interpolation-env' && i.sourcePath === 'modules/app/.env');
        expect(defaultEnv?.ownership).toBe('unmanaged');
        expect(defaultEnv?.note).toContain('No project .env');
    });

    it('resolves extends.file in an additional -f file against the base file\'s directory', async () => {
        const clone = makeClone({
            'deploy/base.yaml': 'services: {}\n',
            'infra/prod.yaml': 'services:\n  web:\n    extends:\n      file: web-base.yaml\n      service: web-base\n',
            'deploy/web-base.yaml': 'services:\n  web-base:\n    image: nginx\n',
            'infra/web-base.yaml': 'services:\n  WRONG:\n    image: nginx\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['deploy/base.yaml', 'infra/prod.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals).toEqual([]);
        const ext = result.inputs.find((i) => i.dependencyKind === 'extends');
        expect(ext?.sourcePath).toBe('deploy/web-base.yaml');
        expect(ext?.materializedPath).toBe('web-base.yaml');
    });

    it('resolves extends.file against the context dir with the subtree on its own project directory', async () => {
        const clone = makeClone({
            'compose.yaml': 'services:\n  web:\n    extends:\n      file: web-base.yaml\n      service: web-base\n',
            'deploy/web-base.yaml': 'services:\n  web-base:\n    image: nginx\n    label_file: labels.txt\n',
            'deploy/labels.txt': 'a=b\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: 'deploy', bounds: BOUNDS });
        expect(result.refusals).toEqual([]);
        const ext = result.inputs.find((i) => i.dependencyKind === 'extends');
        expect(ext?.sourcePath).toBe('deploy/web-base.yaml');
        const label = result.inputs.find((i) => i.dependencyKind === 'label_file');
        expect(label?.sourcePath).toBe('deploy/labels.txt');
    });

    it('uses the first path as the included project\'s main file for a multi-directory path list', async () => {
        const clone = makeClone({
            'compose.yaml': 'include:\n  - path:\n      - modules/base/compose.yaml\n      - overrides/compose.yaml\nservices: {}\n',
            'modules/base/compose.yaml': 'services:\n  base:\n    image: nginx\n',
            'overrides/compose.yaml': 'services:\n  base:\n    env_file: shared.env\n',
            // The included project's base is modules/base (the first path);
            // the override's relative inputs resolve against it, never the
            // override's own directory.
            'modules/base/shared.env': 'A=1\n',
            'overrides/shared.env': 'WRONG=1\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals).toEqual([]);
        const env = result.inputs.find((i) => i.dependencyKind === 'env_file');
        expect(env?.sourcePath).toBe('modules/base/shared.env');
        expect(env?.materializedPath).toBe('modules/base/shared.env');
    });
});

describe('optional env_file and external: false semantics (audit round 10 S-1)', () => {
    it('does not refuse a missing optional env_file', async () => {
        const clone = makeClone({
            'compose.yaml': 'services:\n  web:\n    image: nginx\n    env_file:\n      - path: optional.env\n        required: false\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals).toEqual([]);
        const env = result.inputs.find((i) => i.dependencyKind === 'env_file');
        expect(env?.ownership).toBe('unmanaged');
        expect(env?.note).toContain('Optional env file');
    });

    it('materializes a present optional env_file as managed', async () => {
        const clone = makeClone({
            'compose.yaml': 'services:\n  web:\n    image: nginx\n    env_file:\n      - path: optional.env\n        required: false\n',
            'optional.env': 'A=1\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals).toEqual([]);
        const env = result.inputs.find((i) => i.dependencyKind === 'env_file');
        expect(env?.ownership).toBe('managed');
        expect(env?.contentSha256).toBeTruthy();
    });

    it('treats only external: true as external for file-backed configs', async () => {
        const clone = makeClone({
            'compose.yaml': 'configs:\n  app:\n    file: configs/app.conf\n    external: false\nservices:\n  web:\n    image: nginx\n    configs: [app]\n',
            'configs/app.conf': 'server {}\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals).toEqual([]);
        const cfg = result.inputs.find((i) => i.dependencyKind === 'config');
        expect(cfg?.sourcePath).toBe('configs/app.conf');
        expect(cfg?.ownership).toBe('managed');
        expect(cfg?.contentSha256).toBeTruthy();
    });

    it('treats only external: true as external for file-backed secrets', async () => {
        const clone = makeClone({
            'compose.yaml': 'secrets:\n  app-key:\n    file: secrets/app.key\n    external: false\nservices:\n  web:\n    image: nginx\n    secrets: [app-key]\n',
            'secrets/app.key': 'secret\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals).toEqual([]);
        const sec = result.inputs.find((i) => i.dependencyKind === 'secret');
        expect(sec?.sourcePath).toBe('secrets/app.key');
        expect(sec?.ownership).toBe('managed');
        expect(sec?.sensitivity).toBe('high');
    });
});

describe('absolute and home-relative path classification (audit round 9 B-4)', () => {
    it('records absolute env/config paths as unmanaged host entries, never adopting repo decoys', async () => {
        const clone = makeClone({
            'compose.yaml': `services:
  web:
    image: nginx
    env_file: /etc/secrets/web.env
    configs: [cfg]
configs:
  cfg:
    file: /etc/nginx/app.conf
`,
            // Repo decoys with the same basenames must never be adopted.
            'etc/secrets/web.env': 'WRONG=1\n',
            'etc/nginx/app.conf': 'WRONG server {}\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals).toEqual([]);
        const env = result.inputs.find((i) => i.dependencyKind === 'env_file');
        expect(env?.ownership).toBe('unmanaged');
        expect(env?.materializedPath).toBeNull();
        expect(env?.note).toContain('Host path');
        const cfg = result.inputs.find((i) => i.dependencyKind === 'config');
        expect(cfg?.ownership).toBe('unmanaged');
        expect(result.inputs.some((i) => i.ownership === 'managed' && i.materializedPath?.includes('etc/'))).toBe(false);
    });

    it('refuses absolute includes without adopting a repo decoy', async () => {
        const clone = makeClone({
            'compose.yaml': 'include:\n  - /etc/compose/extra.yaml\nservices: {}\n',
            'etc/compose/extra.yaml': 'services:\n  web:\n    image: nginx\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals.some((r) => r.actionable && r.kind === 'out-of-bounds' && String(r.sourcePath).includes('/etc/compose/extra.yaml'))).toBe(true);
        expect(result.inputs.some((i) => i.materializedPath === 'etc/compose/extra.yaml')).toBe(false);
    });

    it('records absolute build contexts and dockerfiles as unmanaged host entries', async () => {
        const clone = makeClone({
            'compose.yaml': `services:
  web:
    build:
      context: /opt/build/web
      dockerfile: /opt/build/Dockerfile
`,
            'opt/build/web/Dockerfile': 'FROM nginx\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals).toEqual([]);
        expect(result.buildContexts).toHaveLength(0);
        const ctx = result.inputs.find((i) => i.dependencyKind === 'build-context');
        expect(ctx?.ownership).toBe('unmanaged');
        expect(ctx?.note).toContain('Host path');
        const df = result.inputs.find((i) => i.dependencyKind === 'dockerfile');
        expect(df?.ownership).toBe('unmanaged');
    });

    it('records Windows drive, UNC, and home-relative paths as host inputs', async () => {
        const clone = makeClone({
            'compose.yaml': `services:
  web:
    image: nginx
    env_file:
      - C:\\\\config\\\\web.env
      - \\\\\\\\server\\\\share\\\\x.env
      - ~/web.env
`,
            'config/web.env': 'WRONG=1\n',
            'web.env': 'WRONG=1\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals).toEqual([]);
        const envFiles = result.inputs.filter((i) => i.dependencyKind === 'env_file');
        expect(envFiles).toHaveLength(3);
        expect(envFiles.every((e) => e.ownership === 'unmanaged' && e.materializedPath === null)).toBe(true);
    });
});

describe('default build context and build-secret grammar (audit round 8 B-1)', () => {
    it('materializes an omitted build context at the repo root', async () => {
        const clone = makeClone({
            'compose.yaml': 'services:\n  web:\n    build:\n      dockerfile: Dockerfile\n',
            'Dockerfile': 'FROM nginx\n',
            'src/app.js': 'console.log(1)\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals).toEqual([]);
        expect(result.buildContexts).toHaveLength(1);
        const ctx = result.buildContexts[0];
        expect(ctx.repoPath).toBe('');
        expect(ctx.dockerfile).toBe('Dockerfile');
        expect(ctx.files.some((f) => f.path === 'Dockerfile')).toBe(true);
        expect(ctx.files.some((f) => f.path === 'src/app.js')).toBe(true);
    });

    it('resolves an omitted build context against the configured project directory', async () => {
        const clone = makeClone({
            'compose.yaml': 'services:\n  web:\n    build:\n      dockerfile: Dockerfile\n',
            'deploy/Dockerfile': 'FROM nginx\n',
            'deploy/app.js': 'console.log(1)\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: 'deploy', bounds: BOUNDS });
        expect(result.refusals).toEqual([]);
        expect(result.buildContexts).toHaveLength(1);
        const ctx = result.buildContexts[0];
        expect(ctx.repoPath).toBe('deploy');
        expect(ctx.dockerfile).toBe('deploy/Dockerfile');
        expect(ctx.files.some((f) => f.path === 'app.js')).toBe(true);
    });

    it('resolves an omitted build context in an included file against the included file\'s directory', async () => {
        const clone = makeClone({
            'compose.yaml': 'include:\n  - services/app/compose.yaml\nservices: {}\n',
            'services/app/compose.yaml': 'services:\n  app:\n    build:\n      dockerfile: Dockerfile\n',
            'services/app/Dockerfile': 'FROM nginx\n',
            'services/app/app.js': 'console.log(1)\n',
            'root-decoy.txt': 'must not be in the context\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals).toEqual([]);
        expect(result.buildContexts).toHaveLength(1);
        const ctx = result.buildContexts[0];
        expect(ctx.repoPath).toBe('services/app');
        expect(ctx.dockerfile).toBe('services/app/Dockerfile');
        expect(ctx.files.some((f) => f.path === 'app.js')).toBe(true);
        expect(ctx.files.some((f) => f.path === 'root-decoy.txt')).toBe(false);
    });

    it('does not double-prefix an include map-form env_file from a subdirectory base file', async () => {
        const clone = makeClone({
            'deploy/base.yaml': 'include:\n  - path: web.yaml\n    env_file: e.env\nservices: {}\n',
            'deploy/web.yaml': 'services:\n  web:\n    image: nginx\n',
            'deploy/e.env': 'A=1\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['deploy/base.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals).toEqual([]);
        const includeEnv = result.inputs.find((i) => i.dependencyKind === 'include-env');
        // Repo-side the env file sits next to the base file; at runtime the
        // primary lands at the stack root, so the env file lives there too.
        expect(includeEnv?.sourcePath).toBe('deploy/e.env');
        expect(includeEnv?.materializedPath).toBe('e.env');
    });

    it('does not search for a file named after a build-secret source', async () => {
        const clone = makeClone({
            'compose.yaml': `secrets:
  build-key:
    file: keys/build.env
services:
  web:
    build:
      context: web
      secrets:
        - id: build-key
          source: build-key
`,
            'web/Dockerfile': 'FROM nginx\n',
            'keys/build.env': 'TOKEN=x\n',
        });
        const result = await discovery().discoverFromClone({ cloneDir: clone, composePaths: ['compose.yaml'], contextDir: null, bounds: BOUNDS });
        expect(result.refusals).toEqual([]);
        const secretEntry = result.inputs.find((i) => i.dependencyKind === 'secret' && i.sourcePath === 'keys/build.env');
        expect(secretEntry).toBeTruthy();
        expect(secretEntry?.ownership).toBe('managed');
        const buildSecret = result.inputs.find((i) => i.dependencyKind === 'build-secret');
        expect(buildSecret?.sourcePath).toBeNull();
        expect(buildSecret?.ownership).toBe('unmanaged');
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
