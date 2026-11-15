/**
 * Host directories as recovery storage: which directories qualify, how their
 * host path is translated and proven, how a container or stack is matched as a
 * dependent, and what the generation token says.
 *
 * The helper is a fake here that answers a probe the way the daemon would: it
 * resolves the host path it is handed through a table (standing in for the
 * daemon's own namespace) and reports that directory's real device and inode.
 * That is what makes the mismatch cases real: a translation that lands on a
 * different directory reports a different inode.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { FsRootListing } from '../services/StackFileRootsService';
import type { HelperRunSpec } from '../services/recovery/restic/helperRunner';

let roots: typeof import('../services/recovery/fsRoots');
let hostRoots: typeof import('../services/recovery/hostRoots');
let scratch: string;

beforeAll(async () => {
  roots = await import('../services/recovery/fsRoots');
  hostRoots = await import('../services/recovery/hostRoots');
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fsroots-'));
});

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function dir(name: string): string {
  const full = path.join(scratch, name);
  fs.mkdirSync(full, { recursive: true });
  return fs.realpathSync(full);
}

interface FakeHelper {
  runs: HelperRunSpec[];
  runner: import('../services/recovery/restic/helperRunner').RecoveryHelperRunner;
}

/**
 * A helper whose daemon resolves host paths through `daemonView` (host path to
 * the directory it really is). `mounts` answers a `--mounts` probe.
 */
function fakeHelper(options: {
  daemonView?: Record<string, string>;
  mounts?: string[];
  mountsTruncated?: boolean;
  exitCode?: number;
  guardRefused?: boolean;
  btime?: string | null;
} = {}): FakeHelper {
  const runs: HelperRunSpec[] = [];
  const runner = {
    run: async (spec: HelperRunSpec) => {
      runs.push(spec);
      const source = spec.mounts.source;
      const hostPath = typeof source === 'string' || source === undefined ? '' : source.hostPath;
      const real = options.daemonView?.[hostPath] ?? hostPath;
      let line: string;
      if (options.exitCode && options.exitCode !== 0) {
        line = JSON.stringify({ error: 'no such file or directory' });
      } else {
        const stat = fs.statSync(real, { bigint: true });
        const report: Record<string, unknown> = {
          dev: Number(stat.dev), ino: Number(stat.ino), uid: 0, gid: 0, mode: 16877, free: 1024,
          dev_s: stat.dev.toString(), ino_s: stat.ino.toString(),
        };
        if (options.btime !== null) report.btime = options.btime ?? '1700000000.000000001';
        if (spec.cmd.includes('--mounts')) {
          report.mounts = options.mounts ?? [];
          if (options.mountsTruncated) report.mounts_truncated = true;
        }
        if (spec.cmd.includes('--work-dirs')) report.work_dirs = [];
        line = JSON.stringify(report);
      }
      spec.onStdoutLine?.(line);
      return {
        exitCode: options.guardRefused ? 86 : (options.exitCode ?? 0),
        stderrTail: '',
        aborted: false,
        killed: false,
        guardRefused: options.guardRefused === true,
      };
    },
  } as unknown as FakeHelper['runner'];
  return { runs, runner };
}

describe('path relations', () => {
  it('classifies equal, inside, ancestor and unrelated, after normalization', () => {
    expect(roots.relatePath('/srv/app/data', '/srv/app/data')).toBe('equal');
    expect(roots.relatePath('/srv/app/data/', '/srv/app/data')).toBe('equal');
    expect(roots.relatePath('/srv/app/data/db', '/srv/app/data')).toBe('inside');
    expect(roots.relatePath('/srv/app', '/srv/app/data')).toBe('ancestor');
    expect(roots.relatePath('/', '/srv/app/data')).toBe('ancestor');
    // A sibling that shares a prefix is not inside.
    expect(roots.relatePath('/srv/app/database', '/srv/app/data')).toBe('unrelated');
    // `..` is resolved lexically before the comparison, never trusted.
    expect(roots.relatePath('/srv/app/other/../data', '/srv/app/data')).toBe('equal');
    expect(roots.relatePath('relative/data', '/srv/app/data')).toBe('unrelated');
  });

  it('makes a read-write ancestor a dependent and a read-only one an observer', () => {
    expect(roots.dependsOnRoot('equal', false)).toBe(true);
    expect(roots.dependsOnRoot('inside', false)).toBe(true);
    expect(roots.dependsOnRoot('ancestor', true)).toBe(true);
    expect(roots.dependsOnRoot('ancestor', false)).toBe(false);
    expect(roots.dependsOnRoot('unrelated', true)).toBe(false);
  });
});

describe('namespace translation', () => {
  const mounts = [
    { source: '/opt/sencho/compose', destination: '/app/compose' },
    { source: '/srv/shared', destination: '/mnt/shared' },
  ];

  it('is the identity when Sencho is not in a container', () => {
    expect(roots.senchoToHostPath('/srv/app/data', null)).toBe('/srv/app/data');
    expect(roots.hostToSenchoPath('/srv/app/data', null)).toBe('/srv/app/data');
  });

  it('maps through the longest covering mount, both ways', () => {
    expect(roots.senchoToHostPath('/app/compose/web/data', mounts)).toBe('/opt/sencho/compose/web/data');
    expect(roots.hostToSenchoPath('/opt/sencho/compose/web/data', mounts)).toBe('/app/compose/web/data');
    expect(roots.senchoToHostPath('/mnt/shared', mounts)).toBe('/srv/shared');
  });

  it('answers null for a path no own mount covers', () => {
    expect(roots.senchoToHostPath('/var/lib/app', mounts)).toBeNull();
    expect(roots.hostToSenchoPath('/etc/app', mounts)).toBeNull();
  });

  it('reads Sencho\'s own mounts through the self identity, and fails retryable when they cannot be read', async () => {
    const SelfIdentityService = (await import('../services/SelfIdentityService')).default;
    const spy = vi.spyOn(SelfIdentityService.getInstance(), 'getBindMounts').mockRejectedValueOnce(new Error('inspect failed'));
    await expect(roots.readOwnMounts()).rejects.toMatchObject({ errorClass: 'identity_unknown', reason: 'path_mapping_unproven' });
    spy.mockResolvedValueOnce(mounts);
    await expect(roots.readOwnMounts()).resolves.toEqual(mounts);
    spy.mockRestore();
  });
});

function declaration(overrides: Partial<FsRootListing['roots'][number]> = {}): FsRootListing['roots'][number] {
  return {
    rootId: 'bind:0123456789abcdef',
    role: 'bind',
    senchoPath: '/srv/app/data',
    declaredSources: ['/srv/app/data'],
    mounts: [{ service: 'db', containerPath: '/var/lib/data', readOnly: false }],
    label: '/var/lib/data',
    accessible: true,
    isDirectory: true,
    dangerous: false,
    managedSourceOverlap: false,
    readonly: false,
    ...overrides,
  };
}

async function candidateFor(
  root: FsRootListing['roots'][number],
  options: { ownMounts?: import('../services/recovery/fsRoots').OwnMounts | 'unreadable'; dockerRoot?: string | null; base?: string } = {},
) {
  const [candidate] = await roots.candidatesFromListing({
    stackName: 'web',
    listing: { outcome: 'rendered', roots: [root] },
    composeBaseDir: options.base ?? '/srv/compose',
    ownMounts: options.ownMounts === undefined ? null : options.ownMounts,
    dockerRoot: options.dockerRoot === undefined ? '/var/lib/docker' : options.dockerRoot,
  });
  return candidate;
}

describe('candidates', () => {
  it('lists an eligible bind with its host path and no aliases when it is declared once', async () => {
    const candidate = await candidateFor(declaration());
    expect(candidate).toMatchObject({ hostPath: '/srv/app/data', aliases: [], ineligibleReason: null, writable: true });
  });

  it('lists every refused directory with its reason instead of leaving it out', async () => {
    expect((await candidateFor(declaration({ accessible: false }))).ineligibleReason).toBe('host_path_unreachable');
    expect((await candidateFor(declaration({ managedSourceOverlap: true }))).ineligibleReason).toBe('sencho_managed_path');
    expect((await candidateFor(declaration({ dangerous: true }))).ineligibleReason).toBe('protected_host_path');
    expect((await candidateFor(declaration({ isDirectory: false }))).ineligibleReason).toBe('not_a_directory');
    expect((await candidateFor(declaration(), { ownMounts: [{ source: '/x', destination: '/y' }] })).ineligibleReason)
      .toBe('path_mapping_unknown');
    expect((await candidateFor(declaration({ senchoPath: '/var/lib/docker/volumes/x/_data' }))).ineligibleReason)
      .toBe('docker_data_path');
  });

  it('applies the host-side guards after translation, so a mapping into a protected path is refused', async () => {
    const candidate = await candidateFor(
      declaration({ senchoPath: '/mnt/etc-copy' }),
      { ownMounts: [{ source: '/etc', destination: '/mnt/etc-copy' }] },
    );
    expect(candidate.hostPath).toBe('/etc');
    expect(candidate.ineligibleReason).toBe('protected_host_path');
    const dockerRoot = await candidateFor(
      declaration({ senchoPath: '/mnt/docker' }),
      { ownMounts: [{ source: '/var/lib/docker', destination: '/mnt/docker' }] },
    );
    expect(dockerRoot.ineligibleReason).toBe('docker_data_path');
  });

  it('keeps a mapping that cannot be read as retryable, not as unsupported', async () => {
    const candidate = await candidateFor(declaration(), { ownMounts: 'unreadable' });
    expect(candidate.status).toBe('mapping_unreadable');
    expect(candidate.hostPath).toBeNull();
    expect(candidate.ineligibleReason).toBeNull();
  });

  it('lists declared spellings that differ from the host path as aliases', async () => {
    const candidate = await candidateFor(declaration({ declaredSources: ['/srv/app/data', '/srv/link-to-data', '/srv/link-to-data/'] }));
    expect(candidate.aliases).toEqual(['/srv/link-to-data']);
  });

  it('refuses a stack source directory that resolves outside the compose base', async () => {
    const base = dir('compose-base');
    const inside = dir('compose-base/web');
    const outside = dir('elsewhere/web');
    const ok = await candidateFor(declaration({ role: 'stack_source', rootId: 'stack-source', senchoPath: inside }), { base });
    expect(ok.ineligibleReason).toBeNull();
    const escaped = await candidateFor(declaration({ role: 'stack_source', rootId: 'stack-source', senchoPath: outside }), { base });
    expect(escaped.ineligibleReason).toBe('outside_compose_base');
    // The compose base itself is not a stack source.
    const baseItself = await candidateFor(declaration({ role: 'stack_source', rootId: 'stack-source', senchoPath: base }), { base });
    expect(baseItself.ineligibleReason).toBe('outside_compose_base');
  });

  it('refuses every directory while Docker does not say where its data root is', async () => {
    // A socket proxy that refuses system info must not turn "could not ask" into
    // "not Docker's data": a bind of /var/lib/docker/volumes would pass otherwise.
    for (const senchoPath of ['/var/lib/docker/volumes/app/_data', '/srv/app/data']) {
      const candidate = await candidateFor(declaration({ senchoPath }), { dockerRoot: null });
      expect(candidate.ineligibleReason, senchoPath).toBe('docker_root_unknown');
      expect(candidate.status, senchoPath).toBe('ineligible');
    }
  });

  it('counts a bind as writable only when one declaration may write it', async () => {
    expect((await candidateFor(declaration({ readonly: true }))).writable).toBe(false);
  });
});

describe('the identity proof', () => {
  it('mints a proven root when the daemon\'s path is the directory Sencho sees', async () => {
    const real = dir('proof-ok');
    const helper = fakeHelper();
    const proven = await roots.proveHostRoot({ runner: helper.runner, operationId: 'op', senchoPath: real, hostPath: real });
    const stat = fs.statSync(real, { bigint: true });
    expect(proven.root).toBeInstanceOf(hostRoots.ProvenHostRoot);
    expect(proven.root.identity()).toBe(`${stat.dev}:${stat.ino}`);
    expect(proven.generationToken).toBe(`fs|${stat.ino}|1700000000.000000001`);
    // The proof itself binds an unproven path, so it runs without the guard.
    expect(helper.runs[0].mounts.source).toBeInstanceOf(hostRoots.UnprovenHostPath);
  });

  it('refuses when the host path the daemon resolves is a different directory', async () => {
    const seen = dir('proof-sencho-view');
    const elsewhere = dir('proof-daemon-view');
    const helper = fakeHelper({ daemonView: { '/host/data': elsewhere } });
    await expect(roots.proveHostRoot({ runner: helper.runner, operationId: 'op', senchoPath: seen, hostPath: '/host/data' }))
      .rejects.toMatchObject({ errorClass: 'identity_unknown', reason: 'path_mapping_unproven' });
  });

  it('accepts a mapped path that lands on the same directory', async () => {
    const real = dir('proof-mapped');
    const helper = fakeHelper({ daemonView: { '/host/elsewhere/data': real } });
    const proven = await roots.proveHostRoot({ runner: helper.runner, operationId: 'op', senchoPath: real, hostPath: '/host/elsewhere/data' });
    expect(proven.root.hostPath).toBe('/host/elsewhere/data');
  });

  it('refuses when the probe fails or the guard refuses, and when Sencho\'s own view is not a directory', async () => {
    const real = dir('proof-fails');
    await expect(roots.proveHostRoot({ runner: fakeHelper({ exitCode: 1 }).runner, operationId: 'op', senchoPath: real, hostPath: real }))
      .rejects.toMatchObject({ errorClass: 'identity_unknown', reason: 'path_mapping_unproven' });
    await expect(roots.proveHostRoot({ runner: fakeHelper({ guardRefused: true }).runner, operationId: 'op', senchoPath: real, hostPath: real }))
      .rejects.toMatchObject({ errorClass: 'identity_unknown' });
    const file = path.join(real, 'file');
    fs.writeFileSync(file, 'x');
    await expect(roots.proveHostRoot({ runner: fakeHelper().runner, operationId: 'op', senchoPath: file, hostPath: file }))
      .rejects.toMatchObject({ errorClass: 'identity_unknown' });
  });

  it('proves every declared alias, and refuses one that resolves elsewhere or too many', async () => {
    const real = dir('proof-alias');
    const other = dir('proof-alias-other');
    const same = fakeHelper({ daemonView: { '/srv/link': real } });
    await roots.proveHostRoot({ runner: same.runner, operationId: 'op', senchoPath: real, hostPath: real, aliases: ['/srv/link'] });
    expect(same.runs).toHaveLength(2);
    const diverging = fakeHelper({ daemonView: { '/srv/link': other } });
    await expect(roots.proveHostRoot({ runner: diverging.runner, operationId: 'op', senchoPath: real, hostPath: real, aliases: ['/srv/link'] }))
      .rejects.toMatchObject({ reason: 'path_mapping_unproven' });
    const tooMany = Array.from({ length: roots.MAX_DECLARED_ALIASES + 1 }, (_, i) => `/srv/alias-${i}`);
    const counted = fakeHelper();
    await expect(roots.proveHostRoot({ runner: counted.runner, operationId: 'op', senchoPath: real, hostPath: real, aliases: tooMany }))
      .rejects.toMatchObject({ errorClass: 'identity_unknown' });
    expect(counted.runs).toHaveLength(0);
  });

  it('compares identities as exact strings, so an inode past 2^53 is not rounded', () => {
    // The probe writes the inode as a JSON number too; past 2^53 that number is
    // rounded by JSON.parse, so only the string field may be compared.
    const report = roots.parseFsProbeReport(
      '{"dev":64768,"ino":18446744073709551557,"uid":0,"gid":0,"mode":16877,"free":1,"dev_s":"64768","ino_s":"18446744073709551557"}',
    );
    expect(report?.ino).toBe('18446744073709551557');
    expect(roots.parseFsProbeReport('{"dev_s":"1"}')).toBeNull();
    expect(roots.parseFsProbeReport('{"dev_s":"1","ino_s":"x"}')).toBeNull();
    expect(roots.parseFsProbeReport('{"dev_s":"1","ino_s":"2","btime":"soon"}')).toBeNull();
    expect(roots.parseFsProbeReport('not json')).toBeNull();
  });
});

describe('the generation token', () => {
  it('leaves the device out when a birth time exists, and uses it when none does', () => {
    expect(roots.fsGenerationToken({ dev: '45', ino: '12', btime: '1700000000.000000001' })).toBe('fs|12|1700000000.000000001');
    expect(roots.fsGenerationToken({ dev: '45', ino: '12', btime: null })).toBe('fs|45:12');
  });

  it('sees a recreated directory from Sencho\'s own stat, without a helper', async () => {
    const real = dir('generation');
    const stat = fs.statSync(real, { bigint: true });
    const btime = stat.birthtimeNs > 0n
      ? `${stat.birthtimeNs / 1_000_000_000n}.${(stat.birthtimeNs % 1_000_000_000n).toString().padStart(9, '0')}`
      : null;
    if (btime) {
      expect(await roots.fsGenerationChanged(`fs|${stat.ino}|${btime}`, real)).toBe(false);
      // The same inode with another birth time is a directory made again on a reused inode.
      expect(await roots.fsGenerationChanged(`fs|${stat.ino}|1700000000.000000001`, real)).toBe(true);
    } else {
      // Without a birth time in Sencho's own stat, a token that carries one is
      // compared by inode alone, so it never reads as a false change.
      expect(await roots.fsGenerationChanged(`fs|${stat.ino}|1700000000.000000001`, real)).toBe(false);
    }
    expect(await roots.fsGenerationChanged(`fs|${stat.dev}:${stat.ino}`, real)).toBe(false);
    expect(await roots.fsGenerationChanged(`fs|${stat.dev}:${stat.ino + 1n}`, real)).toBe(true);
    fs.rmSync(real, { recursive: true });
    fs.mkdirSync(path.join(scratch, 'spacer-generation'));
    fs.mkdirSync(real);
    const recreated = fs.statSync(real, { bigint: true });
    if (recreated.ino !== stat.ino) {
      expect(await roots.fsGenerationChanged(`fs|${stat.ino}|1700000000.000000001`, real)).toBe(true);
    }
    expect(await roots.fsGenerationChanged('fs|1|1', path.join(scratch, 'missing'))).toBe(true);
    expect(await roots.fsGenerationChanged('2024-01-01|1:2', real)).toBe(true);
  });
});

describe('nested mounts', () => {
  it('records each mount below the root as a nested_mount exclusion, through the guard', async () => {
    const real = dir('nested');
    const stat = fs.statSync(real, { bigint: true });
    const root = hostRoots.ProvenHostRoot.mint(real, stat.dev.toString(), stat.ino.toString());
    const helper = fakeHelper({ mounts: ['cache', 'cache/deeper', '../escape', ''] });
    const exclusions = await roots.nestedMountExclusions({ runner: helper.runner, operationId: 'op', root });
    expect(exclusions).toEqual([
      { path: 'cache', reason: 'nested_mount' },
      { path: 'cache/deeper', reason: 'nested_mount' },
    ]);
    expect(helper.runs[0].mounts).toMatchObject({ recursiveSource: true });
    expect(helper.runs[0].mounts.source).toBe(root);
  });

  it('fails a list that was truncated, because an unknown mount set cannot be described', async () => {
    const real = dir('nested-truncated');
    const stat = fs.statSync(real, { bigint: true });
    const root = hostRoots.ProvenHostRoot.mint(real, stat.dev.toString(), stat.ino.toString());
    await expect(roots.nestedMountExclusions({ runner: fakeHelper({ mountsTruncated: true }).runner, operationId: 'op', root }))
      .rejects.toMatchObject({ errorClass: 'identity_unknown' });
  });
});

describe('container matching', () => {
  const root = { senchoPath: '/srv/app/data', hostPath: '/srv/app/data', aliases: ['/srv/link-data'] };
  const bind = (Source: string, RW = true) => ({ Mounts: [{ Type: 'bind', Source, Destination: '/x', RW }] });

  it('matches equal, inside and read-write ancestor binds, and an alias spelling', async () => {
    expect((await roots.matchContainerToRoot(bind('/srv/app/data'), root, null)).depends).toBe(true);
    expect((await roots.matchContainerToRoot(bind('/srv/app/data/db', false), root, null)).depends).toBe(true);
    expect((await roots.matchContainerToRoot(bind('/srv/app'), root, null)).depends).toBe(true);
    expect((await roots.matchContainerToRoot(bind('/srv/link-data'), root, null)).depends).toBe(true);
    expect((await roots.matchContainerToRoot(bind('/srv/app/data/'), root, null)).depends).toBe(true);
  });

  it('makes a read-only ancestor an observer and a sibling with a shared prefix nothing', async () => {
    expect(await roots.matchContainerToRoot(bind('/', false), root, null)).toEqual({ depends: false, observes: true });
    expect(await roots.matchContainerToRoot(bind('/srv/app/database'), root, null)).toEqual({ depends: false, observes: false });
    expect(await roots.matchContainerToRoot({ Mounts: [{ Type: 'volume', Source: '/srv/app/data' }] }, root, null))
      .toEqual({ depends: false, observes: false });
  });

  it('catches a symlinked spelling by mapping the container source into Sencho\'s namespace', async () => {
    const real = dir('match-real');
    const linkParent = dir('match-links');
    const link = path.join(linkParent, 'data');
    fs.symlinkSync(real, link);
    const target = { senchoPath: real, hostPath: '/host/real', aliases: [] };
    // Not containerized: the container's source is Sencho's own path, resolved.
    expect((await roots.matchContainerToRoot(bind(link), target, null)).depends).toBe(true);
    // Containerized: the source maps through Sencho's mount, then resolves.
    const mounts = [{ source: '/hostside', destination: linkParent }];
    expect((await roots.matchContainerToRoot(bind('/hostside/data'), target, mounts)).depends).toBe(true);
  });
});

describe('overlap', () => {
  it('treats a directory and anything inside or around it as overlapping', () => {
    expect(roots.pathsOverlap('/srv/app', '/srv/app/data')).toBe(true);
    expect(roots.pathsOverlap('/srv/app/data/db', '/srv/app/data')).toBe(true);
    expect(roots.pathsOverlap('/srv/app/data', '/srv/app/database')).toBe(false);
  });
});

describe('a freshly derived root swapped for a symlink', () => {
  it('is refused by the proof, though the daemon and a followed stat would agree on the target', async () => {
    const parent = dir('fresh-swap');
    const data = path.join(parent, 'data');
    const foreign = dir('fresh-swap-foreign');
    fs.symlinkSync(foreign, data);
    // The daemon follows the symlink to the foreign directory, as Docker does.
    const helper = fakeHelper({ daemonView: { [data]: foreign } });
    await expect(roots.proveHostRoot({ runner: helper.runner, operationId: 'op', senchoPath: data, hostPath: data }))
      .rejects.toMatchObject({ errorClass: 'identity_unknown' });
    // A recorded spelling may be a symlink: it is followed, and its caller pins the token.
    await expect(roots.proveHostRoot({ runner: helper.runner, operationId: 'op', senchoPath: data, hostPath: data, followSenchoPath: true }))
      .resolves.toMatchObject({ root: expect.anything() });
  });
});

describe('the engine pins the directory admission authorized', () => {
  it('refuses to read a directory swapped in after admission, even when both namespaces agree on it', async () => {
    const SelfIdentityService = (await import('../services/SelfIdentityService')).default;
    const spy = vi.spyOn(SelfIdentityService.getInstance(), 'getBindMounts').mockResolvedValue(null);
    const { hostRootEngineDeps } = await import('../services/recovery/storageAdapters');
    const parent = dir('pin');
    const data = path.join(parent, 'data');
    fs.mkdirSync(data);
    const foreign = dir('pin-foreign');
    const stat = fs.statSync(data, { bigint: true });
    const storage = {
      id: 's', authorityId: 'a', ownerNodeKey: 'docker-engine:a', kind: 'bind_root' as const, locator: data,
      storageKey: 'k', generation: 1, generationToken: `fs|${stat.ino}|1700000000.000000001`, lineageParentId: null,
      state: 'current' as const, firstSeenAt: 1, lastSeenAt: 1,
    };
    const ctx = {
      operationId: 'op', pointId: 'p', signal: new AbortController().signal, onProgress: () => undefined,
      lock: { scope: 'repository' as const, resourceKey: 'r', ownerOperationId: 'op', processEpoch: 'e', acquiredAt: 1, staleSince: null },
    };
    const helperRun = fakeHelper();
    const deps = hostRootEngineDeps({ docker: {} as never, runner: () => helperRun.runner });
    // Admitted directory in place: the proof matches the stored token.
    await expect(deps.prepareSource(storage, ctx)).resolves.toMatchObject({ exclusions: [] });
    // Swapped for a symlink to another directory: the daemon and Sencho both
    // follow it and agree, so only the stored identity tells it apart.
    fs.rmSync(data, { recursive: true });
    fs.symlinkSync(foreign, data);
    await expect(deps.prepareSource(storage, ctx)).rejects.toMatchObject({ errorClass: 'identity_unknown' });
    spy.mockRestore();
  });
});
