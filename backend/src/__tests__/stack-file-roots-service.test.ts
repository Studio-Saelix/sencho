/**
 * StackFileRootsService discovery: bind classification (relative + absolute),
 * file-bind and inaccessible degradation, the dangerous-mount blocklist, the
 * managed-area overlap guard (stack-dir fold + sibling/ancestor suppression),
 * named-volume Docker-name resolution and unresolvable degradation, mixed
 * read-only aggregation, render-failure keeping only the stack-source root, and
 * the no-stale-allowlist guarantee. Real temp directories back the bind probe;
 * ComposeService / DockerController / FileSystemService are stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import {
  StackFileRootsService,
  isDangerousHostPath,
  STACK_SOURCE_ROOT_ID,
} from '../services/StackFileRootsService';
import { ComposeService } from '../services/ComposeService';
import DockerController from '../services/DockerController';
import { FileSystemService } from '../services/FileSystemService';

const STACK = 'app';
let baseDir: string;
let stackDir: string;
// The real OS temp, captured before beforeEach redirects os.tmpdir() for the
// service. Test scratch (baseDir, legitimate external binds) lives here and stays
// browsable, while the service's view of the OS temp root is pointed at a separate
// dir so the managed-temp containment can be exercised without flagging the
// test's own scratch.
const REAL_TMP = os.tmpdir();
let managedTmpDir: string;
// Env keys the managed-temp tests mutate. Snapshotted and restored around every
// case so an inherited value (CI or a developer shell) is never clobbered.
const MANAGED_ENV_KEYS = ['TMPDIR', 'TEMP', 'TMP', 'SENCHO_UPLOAD_DIR', 'TRIVY_BIN', 'TRIVY_CACHE_DIR'] as const;
let savedEnv: Partial<Record<(typeof MANAGED_ENV_KEYS)[number], string | undefined>>;

interface RawMount { type: 'bind' | 'volume' | 'tmpfs'; source?: string; target: string; read_only?: boolean }

function renderModel(servicesVolumes: Record<string, RawMount[]>, volumes: Record<string, { name: string }> = {}): string {
  const services: Record<string, unknown> = {};
  for (const [svc, vols] of Object.entries(servicesVolumes)) services[svc] = { volumes: vols };
  return JSON.stringify({ services, volumes });
}

/** Stub the three singletons the service depends on. */
function stub(opts: { rendered: string | null; volumeInspect?: (name: string) => Promise<unknown> }): void {
  vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
    renderConfig: vi.fn().mockResolvedValue({ rendered: opts.rendered, stderr: '', timedOut: false }),
  } as unknown as ReturnType<typeof ComposeService.getInstance>);

  vi.spyOn(FileSystemService, 'getInstance').mockReturnValue({
    getBaseDir: () => baseDir,
  } as unknown as ReturnType<typeof FileSystemService.getInstance>);

  vi.spyOn(DockerController, 'getInstance').mockReturnValue({
    getDocker: () => ({
      getVolume: (name: string) => ({
        inspect: () => (opts.volumeInspect ?? (async () => ({ Name: name })))(name),
      }),
    }),
  } as unknown as ReturnType<typeof DockerController.getInstance>);
}

beforeEach(async () => {
  baseDir = await fs.realpath(await fs.mkdtemp(path.join(REAL_TMP, 'sfr-base-')));
  stackDir = path.join(baseDir, STACK);
  await fs.mkdir(stackDir, { recursive: true });
  // Redirect os.tmpdir() (the service's "OS temp root") to a dedicated dir, kept
  // separate from REAL_TMP where the test scratch lives, so a bind to the OS temp
  // root can be asserted non-browsable while ordinary REAL_TMP binds stay browsable.
  managedTmpDir = await fs.realpath(await fs.mkdtemp(path.join(REAL_TMP, 'sfr-managed-tmp-')));
  savedEnv = {};
  for (const key of MANAGED_ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.TMPDIR = managedTmpDir;
  process.env.TEMP = managedTmpDir;
  process.env.TMP = managedTmpDir;
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const key of MANAGED_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await fs.rm(baseDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(managedTmpDir, { recursive: true, force: true }).catch(() => {});
  // The service cache is module-level; clear it between cases.
  StackFileRootsService.invalidate(1, STACK);
});

describe('isDangerousHostPath', () => {
  it('flags the root and protected system directories and their descendants', () => {
    for (const p of [
      '/', '/etc', '/etc/nginx', '/proc', '/sys/x', '/dev/sda', '/var/run', '/var/run/docker.sock', '/run/x',
      // System locations holding the executables/libraries Sencho's runtime
      // depends on: a bind here could overwrite a binary a deploy later runs.
      '/usr', '/usr/local/bin', '/usr/local/bin/node', '/usr/bin', '/usr/lib', '/bin', '/bin/sh',
      '/sbin', '/lib', '/lib64', '/boot', '/root', '/root/.ssh',
    ]) {
      expect(isDangerousHostPath(p)).toBe(true);
    }
  });
  it('allows ordinary host paths, including ones whose name only prefixes a protected root', () => {
    for (const p of ['/home/user/config', '/srv/app/data', '/opt/app', '/mnt/data', 'C:\\data', '/etcetera', '/usrdata', '/libreoffice', '/booted']) {
      expect(isDangerousHostPath(p)).toBe(false);
    }
  });
});

describe('StackFileRootsService.listRoots', () => {
  it('always includes a writable stack-source root', async () => {
    stub({ rendered: renderModel({}) });
    const roots = await StackFileRootsService.getInstance(1).listRoots(STACK, { fresh: true });
    const src = roots.find((r) => r.id === STACK_SOURCE_ROOT_ID);
    expect(src).toBeDefined();
    expect(src?.browsable && src?.writable && src?.backend === 'fs').toBe(true);
  });

  it('classifies a relative bind to a directory as a browsable, writable root', async () => {
    await fs.mkdir(path.join(stackDir, 'config'));
    stub({ rendered: renderModel({ web: [{ type: 'bind', source: './config', target: '/config', read_only: false }] }) });
    const roots = await StackFileRootsService.getInstance(1).listRoots(STACK, { fresh: true });
    const bind = roots.find((r) => r.kind === 'bind');
    expect(bind?.browsable).toBe(true);
    expect(bind?.writable).toBe(true);
    expect(bind?.hostPathOrName).toBe(await fs.realpath(path.join(stackDir, 'config')));
    expect(bind?.mounts[0]).toMatchObject({ service: 'web', containerPath: '/config', readOnly: false });
  });

  it('marks a bind to a single file as non-browsable', async () => {
    const file = path.join(stackDir, 'single.conf');
    await fs.writeFile(file, 'x');
    stub({ rendered: renderModel({ web: [{ type: 'bind', source: file, target: '/c', read_only: false }] }) });
    const roots = await StackFileRootsService.getInstance(1).listRoots(STACK, { fresh: true });
    const bind = roots.find((r) => r.kind === 'bind');
    expect(bind?.browsable).toBe(false);
    expect(bind?.warning).toBeTruthy();
  });

  it('marks an inaccessible absolute bind as non-browsable with a warning', async () => {
    const missing = path.join(baseDir, 'does-not-exist-xyz');
    stub({ rendered: renderModel({ web: [{ type: 'bind', source: missing, target: '/c' }] }) });
    const roots = await StackFileRootsService.getInstance(1).listRoots(STACK, { fresh: true });
    const bind = roots.find((r) => r.kind === 'bind');
    expect(bind?.accessible).toBe(false);
    expect(bind?.browsable).toBe(false);
  });

  it('classifies a reachable absolute bind outside the compose base as browsable and writable', async () => {
    // A config directory mounted into both the app and the Sencho container can
    // legitimately live outside the compose base. When Sencho can stat it, the
    // root must be fully browsable/editable, not silently dropped as unreachable.
    const outside = await fs.realpath(await fs.mkdtemp(path.join(REAL_TMP, 'sfr-ext-')));
    try {
      stub({ rendered: renderModel({ web: [{ type: 'bind', source: outside, target: '/config', read_only: false }] }) });
      const roots = await StackFileRootsService.getInstance(1).listRoots(STACK, { fresh: true });
      const bind = roots.find((r) => r.kind === 'bind');
      expect(bind?.accessible).toBe(true);
      expect(bind?.browsable).toBe(true);
      expect(bind?.writable).toBe(true);
      expect(bind?.managedSourceOverlap).toBe(false);
      expect(bind?.hostPathOrName).toBe(outside);
    } finally {
      await fs.rm(outside, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('marks an unreachable absolute bind outside the compose base as non-browsable', async () => {
    const outsideMissing = path.join(os.tmpdir(), 'sfr-ext-absent-xyz-12345');
    stub({ rendered: renderModel({ web: [{ type: 'bind', source: outsideMissing, target: '/config' }] }) });
    const roots = await StackFileRootsService.getInstance(1).listRoots(STACK, { fresh: true });
    const bind = roots.find((r) => r.kind === 'bind');
    expect(bind?.accessible).toBe(false);
    expect(bind?.browsable).toBe(false);
    expect(bind?.warning).toBeTruthy();
  });

  it('blocks a dangerous host bind (/etc) and never exposes it as browsable', async () => {
    stub({ rendered: renderModel({ web: [{ type: 'bind', source: '/etc', target: '/host-etc' }] }) });
    const roots = await StackFileRootsService.getInstance(1).listRoots(STACK, { fresh: true });
    const bind = roots.find((r) => r.kind === 'bind');
    expect(bind?.dangerous).toBe(true);
    expect(bind?.browsable).toBe(false);
  });

  it('blocks a bind into a system binary directory (/usr/local/bin) so Sencho binaries cannot be overwritten', async () => {
    // A stack author with stack:edit could otherwise declare /usr/local/bin as a
    // bind source, overwrite node/docker/the entrypoint, and have a later deploy
    // execute it. The declared source is dangerous regardless of how realpath
    // rewrites it (covered by the dangerousSource term), so this holds on any host.
    stub({ rendered: renderModel({ web: [{ type: 'bind', source: '/usr/local/bin', target: '/host-bin', read_only: false }] }) });
    const roots = await StackFileRootsService.getInstance(1).listRoots(STACK, { fresh: true });
    const bind = roots.find((r) => r.kind === 'bind');
    expect(bind?.dangerous).toBe(true);
    expect(bind?.browsable).toBe(false);
    expect(bind?.writable).toBe(false);
    expect(bind?.chmodable).toBe(false);
  });

  it('blocks a dangerous declared source even when realpath rewrites it to a benign canonical', async () => {
    // Guards the dangerousSource term: realpath can rewrite a dangerous POSIX
    // source to a benign-looking canonical (a non-existent POSIX path resolves
    // drive-prefixed on a non-Linux host), so isDangerousHostPath(canonical)
    // alone would miss it. The classification must also read the literal source.
    vi.spyOn(fs, 'realpath').mockResolvedValue('/srv/benign-canonical' as never);
    vi.spyOn(fs, 'stat').mockResolvedValue({ isDirectory: () => true } as never);
    stub({ rendered: renderModel({ web: [{ type: 'bind', source: '/etc', target: '/host-etc' }] }) });
    const roots = await StackFileRootsService.getInstance(1).listRoots(STACK, { fresh: true });
    const bind = roots.find((r) => r.kind === 'bind');
    expect(bind?.dangerous).toBe(true);
    expect(bind?.browsable).toBe(false);
  });

  it('folds a bind equal to the stack dir into stack-source (no second editable root)', async () => {
    stub({ rendered: renderModel({ web: [{ type: 'bind', source: stackDir, target: '/app' }] }) });
    const roots = await StackFileRootsService.getInstance(1).listRoots(STACK, { fresh: true });
    expect(roots.some((r) => r.kind === 'bind')).toBe(false);
    expect(roots.filter((r) => r.id === STACK_SOURCE_ROOT_ID)).toHaveLength(1);
  });

  it('suppresses a bind that points into a sibling stack as a managed-area overlap', async () => {
    const sibling = path.join(baseDir, 'other');
    await fs.mkdir(sibling);
    stub({ rendered: renderModel({ web: [{ type: 'bind', source: sibling, target: '/x' }] }) });
    const roots = await StackFileRootsService.getInstance(1).listRoots(STACK, { fresh: true });
    const bind = roots.find((r) => r.kind === 'bind');
    expect(bind?.managedSourceOverlap).toBe(true);
    expect(bind?.browsable).toBe(false);
  });

  it('suppresses a bind that is an ancestor of the compose base dir', async () => {
    stub({ rendered: renderModel({ web: [{ type: 'bind', source: baseDir, target: '/x' }] }) });
    const roots = await StackFileRootsService.getInstance(1).listRoots(STACK, { fresh: true });
    const bind = roots.find((r) => r.kind === 'bind');
    expect(bind?.managedSourceOverlap).toBe(true);
    expect(bind?.browsable).toBe(false);
  });

  it("suppresses a bind that overlaps Sencho's own application directory", async () => {
    // process.cwd() is Sencho's install root in the container (/app, holding
    // dist/, public/, node_modules). A non-admin must not be able to declare a
    // bind into it and reach Sencho's program files via the file explorer.
    const appDir = await fs.realpath(await fs.mkdtemp(path.join(process.cwd(), 'sfr-app-')));
    try {
      stub({ rendered: renderModel({ web: [{ type: 'bind', source: appDir, target: '/config', read_only: false }] }) });
      const roots = await StackFileRootsService.getInstance(1).listRoots(STACK, { fresh: true });
      const bind = roots.find((r) => r.kind === 'bind');
      expect(bind?.managedSourceOverlap).toBe(true);
      expect(bind?.browsable).toBe(false);
      expect(bind?.writable).toBe(false);
    } finally {
      await fs.rm(appDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("suppresses a bind to the OS temp root, where Sencho writes transient registry credentials", async () => {
    // ComposeService and TrivyService write a docker config.json (resolved
    // registry auth) under os.tmpdir(); a bind that exposes that dir would let
    // the file explorer read those secrets. (os.tmpdir() is managedTmpDir here.)
    stub({ rendered: renderModel({ web: [{ type: 'bind', source: managedTmpDir, target: '/host-tmp', read_only: false }] }) });
    const roots = await StackFileRootsService.getInstance(1).listRoots(STACK, { fresh: true });
    const bind = roots.find((r) => r.kind === 'bind');
    expect(bind?.managedSourceOverlap).toBe(true);
    expect(bind?.browsable).toBe(false);
    expect(bind?.writable).toBe(false);
    expect(bind?.chmodable).toBe(false);
  });

  it('suppresses a bind into a subdirectory of the OS temp root (the per-scan credential dir)', async () => {
    const sub = path.join(managedTmpDir, 'sencho-trivy-xyz');
    await fs.mkdir(sub);
    stub({ rendered: renderModel({ web: [{ type: 'bind', source: sub, target: '/c' }] }) });
    const roots = await StackFileRootsService.getInstance(1).listRoots(STACK, { fresh: true });
    const bind = roots.find((r) => r.kind === 'bind');
    expect(bind?.managedSourceOverlap).toBe(true);
    expect(bind?.browsable).toBe(false);
  });

  it('suppresses a bind to a relocated upload spool (SENCHO_UPLOAD_DIR outside the OS temp root)', async () => {
    const uploadDir = await fs.realpath(await fs.mkdtemp(path.join(REAL_TMP, 'sfr-upload-')));
    process.env.SENCHO_UPLOAD_DIR = uploadDir;
    try {
      stub({ rendered: renderModel({ web: [{ type: 'bind', source: uploadDir, target: '/u', read_only: false }] }) });
      const roots = await StackFileRootsService.getInstance(1).listRoots(STACK, { fresh: true });
      const bind = roots.find((r) => r.kind === 'bind');
      expect(bind?.managedSourceOverlap).toBe(true);
      expect(bind?.browsable).toBe(false);
      expect(bind?.writable).toBe(false);
    } finally {
      // env is restored by afterEach; only the scratch dir needs removing here.
      await fs.rm(uploadDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('suppresses a bind that exposes a relocated Trivy binary (TRIVY_BIN), so it cannot be overwritten then run', async () => {
    const binDir = await fs.realpath(await fs.mkdtemp(path.join(REAL_TMP, 'sfr-trivybin-')));
    process.env.TRIVY_BIN = path.join(binDir, 'trivy');
    try {
      // A bind to the directory that holds the configured Trivy binary is an
      // ancestor of that binary, so it must be suppressed.
      stub({ rendered: renderModel({ web: [{ type: 'bind', source: binDir, target: '/opt/trivy', read_only: false }] }) });
      const roots = await StackFileRootsService.getInstance(1).listRoots(STACK, { fresh: true });
      const bind = roots.find((r) => r.kind === 'bind');
      expect(bind?.managedSourceOverlap).toBe(true);
      expect(bind?.writable).toBe(false);
    } finally {
      await fs.rm(binDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('suppresses a bind that is an ancestor of a relocated Trivy cache (TRIVY_CACHE_DIR)', async () => {
    // The cache lives in a subdirectory; binding its parent is the reverse
    // overlap direction (the managed dir is within the bind), which must also
    // be caught so the cache cannot be reached through the parent bind.
    const parent = await fs.realpath(await fs.mkdtemp(path.join(REAL_TMP, 'sfr-cacheparent-')));
    process.env.TRIVY_CACHE_DIR = path.join(parent, 'trivy-cache');
    try {
      stub({ rendered: renderModel({ web: [{ type: 'bind', source: parent, target: '/cache', read_only: false }] }) });
      const roots = await StackFileRootsService.getInstance(1).listRoots(STACK, { fresh: true });
      const bind = roots.find((r) => r.kind === 'bind');
      expect(bind?.managedSourceOverlap).toBe(true);
      expect(bind?.browsable).toBe(false);
    } finally {
      await fs.rm(parent, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('resolves a named volume by its Docker name (not the compose key) and inspects that name', async () => {
    const inspected: string[] = [];
    stub({
      rendered: renderModel({ db: [{ type: 'volume', source: 'cache', target: '/c' }] }, { cache: { name: 'app_cache' } }),
      volumeInspect: async (name) => { inspected.push(name); return { Name: name }; },
    });
    const roots = await StackFileRootsService.getInstance(1).listRoots(STACK, { fresh: true });
    const vol = roots.find((r) => r.kind === 'volume');
    expect(vol?.hostPathOrName).toBe('app_cache');
    expect(vol?.backend).toBe('helper');
    expect(vol?.browsable).toBe(true);
    expect(inspected).toContain('app_cache');
  });

  it('degrades a named volume that cannot be inspected to non-browsable', async () => {
    stub({
      rendered: renderModel({ db: [{ type: 'volume', source: 'gone', target: '/c' }] }),
      volumeInspect: async () => { throw new Error('no such volume'); },
    });
    const roots = await StackFileRootsService.getInstance(1).listRoots(STACK, { fresh: true });
    const vol = roots.find((r) => r.kind === 'volume');
    expect(vol?.accessible).toBe(false);
    expect(vol?.browsable).toBe(false);
    expect(vol?.warning).toBeTruthy();
  });

  it('aggregates a source mounted :ro and :rw across services to a single writable root', async () => {
    await fs.mkdir(path.join(stackDir, 'shared'));
    const src = path.join(stackDir, 'shared');
    stub({
      rendered: renderModel({
        a: [{ type: 'bind', source: src, target: '/s', read_only: true }],
        b: [{ type: 'bind', source: src, target: '/s', read_only: false }],
      }),
    });
    const roots = await StackFileRootsService.getInstance(1).listRoots(STACK, { fresh: true });
    const binds = roots.filter((r) => r.kind === 'bind');
    expect(binds).toHaveLength(1);
    expect(binds[0].readonly).toBe(false);
    expect(binds[0].writable).toBe(true);
    expect(binds[0].mounts).toHaveLength(2);
  });

  it('returns only the stack-source root when the model render fails', async () => {
    stub({ rendered: null });
    const roots = await StackFileRootsService.getInstance(1).listRoots(STACK, { fresh: true });
    expect(roots).toHaveLength(1);
    expect(roots[0].id).toBe(STACK_SOURCE_ROOT_ID);
  });

  it('never serves a stale allowlist: a later render failure drops previously-discovered roots', async () => {
    await fs.mkdir(path.join(stackDir, 'config'));
    const ok = renderModel({ web: [{ type: 'bind', source: './config', target: '/config' }] });

    stub({ rendered: ok });
    const svc = StackFileRootsService.getInstance(1);
    expect((await svc.listRoots(STACK)).some((r) => r.kind === 'bind')).toBe(true);

    // Mounts change such that the model no longer renders; after invalidation the
    // recompute must not fall back to the prior good allowlist.
    vi.restoreAllMocks();
    stub({ rendered: null });
    StackFileRootsService.invalidate(1, STACK);
    const after = await StackFileRootsService.getInstance(1).listRoots(STACK);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(STACK_SOURCE_ROOT_ID);
  });

  it('resolveRoot rejects an unknown rootId and resolves stack-source without a render', async () => {
    stub({ rendered: renderModel({}) });
    const svc = StackFileRootsService.getInstance(1);
    await expect(svc.resolveRoot(STACK, 'bind:deadbeef', { fresh: true })).rejects.toMatchObject({ code: 'INVALID_ROOT' });
    const src = await svc.resolveRoot(STACK, STACK_SOURCE_ROOT_ID);
    expect(src.kind).toBe('stack-source');
  });

  it('invalidateNode clears the cached allowlist so a recreated stack cannot serve old roots', async () => {
    await fs.mkdir(path.join(stackDir, 'config'));
    stub({ rendered: renderModel({ web: [{ type: 'bind', source: './config', target: '/config' }] }) });
    expect((await StackFileRootsService.getInstance(1).listRoots(STACK)).some((r) => r.kind === 'bind')).toBe(true);

    // Stack deleted + recreated under the same name with no declared volume; a
    // node-level invalidation (as the lifecycle routes trigger) must drop the
    // cached bind root rather than serve it from the TTL cache.
    vi.restoreAllMocks();
    stub({ rendered: renderModel({}) });
    StackFileRootsService.invalidateNode(1);
    const after = await StackFileRootsService.getInstance(1).listRoots(STACK);
    expect(after.some((r) => r.kind === 'bind')).toBe(false);
    expect(after).toHaveLength(1);
  });
});
