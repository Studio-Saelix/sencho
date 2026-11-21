/**
 * How SelfUpdateService reads Sencho's own Compose files to classify the image
 * pin. Routine status and monitor reads must never create a throwaway container
 * once every config file has been read; fresh reads (update decisions) stay
 * authoritative and read the current file, directly when a bind mount covers it
 * and through the helper otherwise.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STAGED_PATCH_FILE = '/app/data/.sencho-compose-patch';

const { mockExecFile, mockExecFileAsync, stagedWrites } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockExecFileAsync: vi.fn(),
  stagedWrites: [] as unknown[],
}));

// The staged repin file lives under /app/data, which does not exist here:
// capture that one write and leave every other fs call real.
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  const writeFileSync = ((file: unknown, data: unknown, ...rest: unknown[]) => {
    if (file === STAGED_PATCH_FILE) {
      stagedWrites.push(data);
      return;
    }
    return (actual.writeFileSync as (...args: unknown[]) => void)(file, data, ...rest);
  }) as typeof actual.writeFileSync;
  const patched = { ...actual, writeFileSync };
  return { ...patched, default: patched };
});

vi.mock('child_process', () => ({ exec: vi.fn(), execFile: mockExecFile }));
vi.mock('util', () => ({ promisify: () => mockExecFileAsync }));
vi.mock('../services/DatabaseService', () => ({
  DatabaseService: { getInstance: () => ({ getGlobalSettings: () => ({ prune_on_update: '1' }) }) },
}));

import SelfUpdateService from '../services/SelfUpdateService';
import { patchComposeServiceImage } from '../helpers/selfUpdateCompose';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-pin-read-'));
const coveredDir = path.join(scratch, 'covered');
const outsideDir = path.join(scratch, 'outside');
const siblingDir = `${coveredDir}-evil`;
const coveredFile = path.join(coveredDir, 'compose.yaml');
const uncoveredFile = '/srv/uncovered/compose.yaml';
const overrideFile = '/srv/uncovered/override.yaml';
const FIVE_MIN = 5 * 60 * 1000;
const TICK = 30_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = 1_000_000;

const sameMount = { source: coveredDir, destination: coveredDir };

afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

function compose(image: string): string {
  return `services:\n  sencho:\n    image: ${image}\n`;
}

/** Contents the fake helper container serves for a host path. */
const hostFiles = new Map<string, string>();
let clock = T0;
/** What the container's `/proc/self/mountinfo` says; empty means unreadable, so recorded destinations are resolved instead. */
let mountinfo = '';

type Mount = { source: string; destination: string };
type Internals = {
  composeContext: Record<string, unknown> | null;
  canSelfUpdate: boolean;
  pinCache: unknown;
  pinInflight: unknown;
  lastFullReadAt: number;
  incompleteReads: number;
  incompleteReadsAt: number;
  applyDetection(code: null): void;
};

/** `otherDestinations` are further mounts of the container (a volume, or a bind mount that is not the config file's own). */
function setup(configFiles: string[], mounts: Mount[], otherDestinations: string[] = []): SelfUpdateService {
  const instance = SelfUpdateService.getInstance();
  const internals = instance as unknown as Internals;
  internals.composeContext = {
    workingDir: path.dirname(configFiles[0]),
    configFiles: configFiles.join(','),
    serviceName: 'sencho',
    imageName: 'saelix/sencho:0.99.0',
    dataDirHost: '/srv/data',
    hostBindMounts: mounts,
    mountDestinations: [...mounts.map(m => m.destination), ...otherDestinations],
    project: 'stack',
    runningImageId: 'sha256:running',
  };
  internals.canSelfUpdate = true;
  internals.pinCache = null;
  internals.pinInflight = null;
  internals.lastFullReadAt = 0;
  internals.incompleteReads = 0;
  internals.incompleteReadsAt = 0;
  return instance;
}

function isReadHelper(call: unknown[]): boolean {
  const args = call[1] as string[];
  return call[0] === 'docker' && args[0] === 'run' && args.includes('cat');
}

function helperCalls(): unknown[][] {
  return mockExecFileAsync.mock.calls.filter(isReadHelper);
}

/** A stand-in for an open file handle that serves `content`. */
function fakeHandle(content: string, over: {
  isFile?: boolean;
  size?: number;
  readFile?: () => Promise<string>;
  close?: () => Promise<void>;
} = {}): unknown {
  return {
    stat: async () => ({ isFile: () => over.isFile ?? true, size: over.size ?? content.length }),
    readFile: over.readFile ?? (async () => content),
    close: over.close ?? (async () => undefined),
  };
}

function writeCovered(image: string): void {
  fs.writeFileSync(coveredFile, compose(image));
}

beforeEach(() => {
  vi.clearAllMocks();
  stagedWrites.length = 0;
  fs.rmSync(coveredDir, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });
  fs.rmSync(siblingDir, { recursive: true, force: true });
  fs.mkdirSync(coveredDir, { recursive: true });
  fs.mkdirSync(siblingDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  hostFiles.clear();
  clock = T0;
  mountinfo = '';
  const readFile = fs.promises.readFile;
  vi.spyOn(fs.promises, 'readFile').mockImplementation(((file: unknown, ...rest: unknown[]) =>
    file === '/proc/self/mountinfo'
      ? Promise.resolve(mountinfo)
      : (readFile as (...args: unknown[]) => Promise<unknown>).call(fs.promises, file, ...rest)) as typeof fs.promises.readFile);
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  mockExecFileAsync.mockImplementation(async (_cmd: string, args: string[]) => {
    if (args[0] === 'run' && args.includes('cat')) {
      const content = hostFiles.get(args[args.length - 1]);
      if (content === undefined) throw new Error('No such file');
      return { stdout: content, stderr: '' };
    }
    return { stdout: '', stderr: '' };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a Compose file covered by one of Sencho\'s bind mounts', () => {
  it('is read directly for routine and fresh reads, with no helper container', async () => {
    writeCovered('saelix/sencho:0.99.0');
    const service = setup([coveredFile], [sameMount]);

    await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ pinKind: 'semver', composeImageRef: 'saelix/sencho:0.99.0' });
    clock += FIVE_MIN + TICK;
    await expect(service.getPinInfo()).resolves.toMatchObject({ pinKind: 'semver' });
    await expect(service.getResolvedComposeImageForUpdate()).resolves.toMatchObject({ imageRef: 'saelix/sencho:0.99.0' });

    expect(helperCalls()).toHaveLength(0);
  });

  it('maps a host path through a mount whose container path differs', async () => {
    writeCovered('saelix/sencho:0.99.0');
    const service = setup(['/host/opt/sencho/compose.yaml'], [{ source: '/host/opt/sencho', destination: coveredDir }]);

    await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({
      composeImageRef: 'saelix/sencho:0.99.0',
      filePath: '/host/opt/sencho/compose.yaml',
    });
    expect(helperCalls()).toHaveLength(0);
  });

  it('shows a live edit to a routine read after five minutes and to a fresh read at once', async () => {
    writeCovered('saelix/sencho:0.99.0');
    const service = setup([coveredFile], [sameMount]);
    await service.getPinInfo({ fresh: true });

    writeCovered('saelix/sencho:0.99.1');
    clock += TICK;
    await expect(service.getPinInfo()).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.0' });
    await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.1' });

    writeCovered('saelix/sencho:0.99.2');
    clock += FIVE_MIN;
    await expect(service.getPinInfo()).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.2' });
    expect(helperCalls()).toHaveLength(0);
  });

  it('keeps the cached classification when the direct re-read fails, and starts no helper', async () => {
    writeCovered('saelix/sencho:0.99.0');
    hostFiles.set(coveredFile, compose('saelix/sencho:0.50.0'));
    const service = setup([coveredFile], [sameMount]);
    await service.getPinInfo({ fresh: true });

    clock += FIVE_MIN + TICK;
    vi.spyOn(fs.promises, 'open').mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
    await expect(service.getPinInfo()).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.0' });
    expect(helperCalls()).toHaveLength(0);
  });

  it('falls back to the helper on a fresh read when the direct read fails', async () => {
    writeCovered('saelix/sencho:0.99.0');
    hostFiles.set(coveredFile, compose('saelix/sencho:0.99.1'));
    const service = setup([coveredFile], [sameMount]);

    vi.spyOn(fs.promises, 'open').mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
    await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.1' });
    expect(helperCalls()).toHaveLength(1);
  });

  it('is treated as uncovered when the real path leaves the mount', async () => {
    const secret = path.join(outsideDir, 'secret.yaml');
    fs.writeFileSync(secret, compose('saelix/sencho:9.9.9'));
    fs.symlinkSync(secret, coveredFile);
    hostFiles.set(coveredFile, compose('saelix/sencho:0.99.0'));
    const service = setup([coveredFile], [sameMount]);

    await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.0' });
    expect(helperCalls()).toHaveLength(1);
  });

  it('does not trust a single-file mount, which keeps showing the old file after an editor replaces it', async () => {
    writeCovered('saelix/sencho:0.99.0');
    hostFiles.set(coveredFile, compose('saelix/sencho:0.99.1'));
    const service = setup([coveredFile], [{ source: coveredFile, destination: coveredFile }]);

    await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.1' });
    expect(helperCalls()).toHaveLength(1);
  });

  it('does not read a file over the size limit directly', async () => {
    writeCovered('saelix/sencho:0.99.0');
    fs.truncateSync(coveredFile, 11 * 1024 * 1024);
    hostFiles.set(coveredFile, compose('saelix/sencho:0.99.1'));
    const service = setup([coveredFile], [sameMount]);

    await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.1' });
    expect(helperCalls()).toHaveLength(1);
  });

  it('opens the file with the no-follow and non-blocking flags', async () => {
    writeCovered('saelix/sencho:0.99.0');
    const service = setup([coveredFile], [sameMount]);
    const open = vi.spyOn(fs.promises, 'open');

    await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.0' });

    const flags = open.mock.calls[0][1] as number;
    expect(flags & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW);
    expect(flags & fs.constants.O_NONBLOCK).toBe(fs.constants.O_NONBLOCK);
  });

  describe('the open file handle', () => {
    const setupCovered = () => {
      writeCovered('saelix/sencho:0.99.0');
      hostFiles.set(coveredFile, compose('saelix/sencho:0.99.1'));
      return setup([coveredFile], [sameMount]);
    };
    const serve = (handle: unknown) => vi.spyOn(fs.promises, 'open').mockResolvedValue(handle as Awaited<ReturnType<typeof fs.promises.open>>);

    it('is closed once after a successful read', async () => {
      const close = vi.fn(async () => undefined);
      serve(fakeHandle(compose('saelix/sencho:0.99.0'), { close }));

      await expect(setupCovered().getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.0' });
      expect(close).toHaveBeenCalledTimes(1);
      expect(helperCalls()).toHaveLength(0);
    });

    it('is closed when reading it throws, and the helper reads the file instead', async () => {
      const close = vi.fn(async () => undefined);
      serve(fakeHandle('', { close, readFile: async () => { throw Object.assign(new Error('io'), { code: 'EIO' }); } }));

      await expect(setupCovered().getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.1' });
      expect(close).toHaveBeenCalledTimes(1);
      expect(helperCalls()).toHaveLength(1);
    });

    it('keeps what was read when closing it fails', async () => {
      serve(fakeHandle(compose('saelix/sencho:0.99.0'), { close: async () => { throw new Error('close failed'); } }));

      await expect(setupCovered().getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.0' });
      expect(helperCalls()).toHaveLength(0);
    });

    it('is closed and treated as uncovered when it is not a plain file', async () => {
      const close = vi.fn(async () => undefined);
      const readFile = vi.fn(async () => compose('saelix/sencho:0.99.0'));
      serve(fakeHandle('', { close, readFile, isFile: false }));
      const service = setupCovered();

      await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.1' });
      expect(readFile).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
      expect((service as unknown as { pinCache: { needsHelper: boolean } }).pinCache.needsHelper).toBe(true);
    });

    it('is not read when its size is over the limit', async () => {
      const readFile = vi.fn(async () => compose('saelix/sencho:0.99.0'));
      serve(fakeHandle('', { readFile, size: 11 * 1024 * 1024 }));

      await expect(setupCovered().getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.1' });
      expect(readFile).not.toHaveBeenCalled();
    });
  });

  it('reads directly when the mount is the host root', async () => {
    writeCovered('saelix/sencho:0.99.0');
    const service = setup([coveredFile], [{ source: '/', destination: '/' }]);

    await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.0' });
    expect(helperCalls()).toHaveLength(0);
  });

  describe('another mount shadows the mapped path', () => {
    const hostApps = '/host/apps';
    const hostFile = `${hostApps}/sencho/compose.yaml`;
    const nested = path.join(coveredDir, 'sencho');
    const appsMount = { source: hostApps, destination: coveredDir };
    const shadowImage = 'saelix/sencho@sha256:' + 'a'.repeat(64);

    /** What Sencho sees at the mapped path: the nested mount's file, not the host's. */
    function writeShadow(): void {
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(nested, 'compose.yaml'), compose(shadowImage));
    }

    it('reads the host file through the helper, not the nested mount\'s file', async () => {
      writeShadow();
      hostFiles.set(hostFile, compose('saelix/sencho:0.99.0'));
      const service = setup([hostFile], [appsMount], [nested]);

      await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({
        pinKind: 'semver', composeImageRef: 'saelix/sencho:0.99.0', filePath: hostFile,
      });
      expect(helperCalls()).toHaveLength(1);
      expect((helperCalls()[0][1] as string[]).at(-1)).toBe(hostFile);
    });

    it('uses the helper for every fresh caller: the update preflight and the update-time resolve', async () => {
      writeShadow();
      hostFiles.set(hostFile, compose('saelix/sencho:0.99.0'));
      const service = setup([hostFile], [appsMount], [nested]);

      await expect(service.canSelfUpdateTarget('0.99.1')).resolves.toEqual({ ok: true });
      await expect(service.getResolvedComposeImageForUpdate()).resolves.toMatchObject({ imageRef: 'saelix/sencho:0.99.0', filePath: hostFile });
      expect(helperCalls()).toHaveLength(2);
    });

    it('stages a repin patched from the host file, never from the nested mount\'s file', async () => {
      writeShadow();
      hostFiles.set(hostFile, compose('saelix/sencho:0.99.0'));
      const service = setup([hostFile], [appsMount], [nested]);

      await service.triggerUpdate({ targetVersion: '0.99.1' });

      expect(stagedWrites).toHaveLength(1);
      expect(stagedWrites[0]).toBe(patchComposeServiceImage(compose('saelix/sencho:0.99.0'), 'sencho', 'saelix/sencho:0.99.1'));
      expect(String(stagedWrites[0])).not.toContain('sha256');
    });

    it('refuses to update when only the shadowing file could be read as a digest pin and the host file cannot be read', async () => {
      writeShadow();
      const service = setup([hostFile], [appsMount], [nested]);

      // Read through the shadow it would be a digest pin (the blocked reason); the host file is what counts, and it is unreadable.
      await expect(service.canSelfUpdateTarget('0.99.1')).resolves.toEqual({
        ok: false,
        reason: expect.stringContaining('Could not read the Sencho compose file'),
      });
      expect(helperCalls()).toHaveLength(1);
      expect(stagedWrites).toHaveLength(0);
    });

    it('does not classify a routine read from the nested mount\'s file either', async () => {
      writeShadow();
      hostFiles.set(hostFile, compose('saelix/sencho:0.99.0'));
      const service = setup([hostFile], [appsMount], [nested]);
      await service.getPinInfo({ fresh: true });

      clock += 3 * FIVE_MIN;
      await expect(service.getPinInfo()).resolves.toMatchObject({ pinKind: 'semver' });
      await expect(service.getPinInfo({ cacheOnly: true })).resolves.toMatchObject({ pinKind: 'semver' });
      expect(helperCalls()).toHaveLength(1);
    });

    it('is treated as uncovered when a symlink inside the mount leads into the nested mount', async () => {
      writeShadow();
      fs.symlinkSync('sencho/compose.yaml', path.join(coveredDir, 'link.yaml'));
      hostFiles.set(`${hostApps}/link.yaml`, compose('saelix/sencho:0.99.0'));
      const service = setup([`${hostApps}/link.yaml`], [appsMount], [nested]);

      await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ pinKind: 'semver', composeImageRef: 'saelix/sencho:0.99.0' });
      expect(helperCalls()).toHaveLength(1);
    });

    it('reads directly with a realistic live mount list: the container\'s own mounts, the bound folder once', async () => {
      const root = realCovered();
      mountinfo = ['/', '/proc', '/dev', '/sys', root, '/etc/hosts'].map((point, i) => `${i} 1 0:1 / ${point} rw - tmpfs tmpfs rw`).join('\n');
      writeShadow();
      const service = setup([hostFile], [appsMount]);

      await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: shadowImage });
      clock += 3 * FIVE_MIN;
      await expect(service.getPinInfo()).resolves.toMatchObject({ composeImageRef: shadowImage });
      expect(helperCalls()).toHaveLength(0);
    });

    it('still reads directly when the same layout has no mount over the file', async () => {
      writeShadow();
      hostFiles.set(hostFile, compose('saelix/sencho:0.99.9'));
      fs.symlinkSync('sencho/compose.yaml', path.join(coveredDir, 'link.yaml'));
      const unrelated = path.join(coveredDir, 'elsewhere');

      const service = setup([hostFile], [appsMount], [unrelated]);
      await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: shadowImage, pinKind: 'digest' });
      expect(helperCalls()).toHaveLength(0);

      const viaLink = setup([`${hostApps}/link.yaml`], [appsMount], [unrelated]);
      await expect(viaLink.getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: shadowImage });
      expect(helperCalls()).toHaveLength(0);
    });

    const realCovered = () => fs.realpathSync(coveredDir);

    describe('whose recorded destination runs through a symlink', () => {
      // Docker lists the nested mount at `covered/current/sencho`; with `current -> v2`
      // the runtime mounts it at `covered/v2/sencho`, where the host label points.
      const v2File = `${hostApps}/v2/sencho/compose.yaml`;
      const recorded = path.join(coveredDir, 'current', 'sencho');

      beforeEach(() => {
        fs.symlinkSync('v2', path.join(coveredDir, 'current'));
        fs.mkdirSync(path.join(coveredDir, 'v2', 'sencho'), { recursive: true });
        fs.writeFileSync(path.join(coveredDir, 'v2', 'sencho', 'compose.yaml'), compose(shadowImage));
        hostFiles.set(v2File, compose('saelix/sencho:0.99.0'));
      });

      it('reads the host file through the helper, not the file the nested mount shows', async () => {
        const service = setup([v2File], [appsMount], [recorded]);

        await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({
          pinKind: 'semver', composeImageRef: 'saelix/sencho:0.99.0', filePath: v2File,
        });
        expect(helperCalls()).toHaveLength(1);
      });

      it('uses the helper for the update preflight and the update-time resolve', async () => {
        const service = setup([v2File], [appsMount], [recorded]);

        await expect(service.canSelfUpdateTarget('0.99.1')).resolves.toEqual({ ok: true });
        await expect(service.getResolvedComposeImageForUpdate()).resolves.toMatchObject({ imageRef: 'saelix/sencho:0.99.0', filePath: v2File });
        expect(helperCalls()).toHaveLength(2);
      });

      it('stages a repin patched from the host file', async () => {
        const service = setup([v2File], [appsMount], [recorded]);

        await service.triggerUpdate({ targetVersion: '0.99.1' });

        expect(stagedWrites).toHaveLength(1);
        expect(stagedWrites[0]).toBe(patchComposeServiceImage(compose('saelix/sencho:0.99.0'), 'sencho', 'saelix/sencho:0.99.1'));
        expect(String(stagedWrites[0])).not.toContain('sha256');
      });

      it('does not classify a routine re-read from the nested mount\'s file either', async () => {
        const service = setup([v2File], [appsMount], [recorded]);
        await service.getPinInfo({ fresh: true });

        clock += 3 * FIVE_MIN;
        await expect(service.getPinInfo()).resolves.toMatchObject({ pinKind: 'semver' });
        await expect(service.getPinInfo({ cacheOnly: true })).resolves.toMatchObject({ pinKind: 'semver' });
        expect(helperCalls()).toHaveLength(1);
      });

      it('reads the host file through the helper after the link is retargeted, because the mount stayed where it was', async () => {
        fs.mkdirSync(path.join(coveredDir, 'v3', 'sencho'), { recursive: true });
        fs.rmSync(path.join(coveredDir, 'current'));
        fs.symlinkSync('v3', path.join(coveredDir, 'current'));
        mountinfo = [coveredDir, path.join(realCovered(), 'v2', 'sencho')].map((point, i) => `${i} 1 0:1 / ${point} rw - tmpfs tmpfs rw`).join('\n');
        const service = setup([v2File], [appsMount], [recorded]);

        await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.0', filePath: v2File });
        expect(helperCalls()).toHaveLength(1);
      });

      it('stages a repin from the host file, and the preflight and a routine re-read use it, after the link is retargeted', async () => {
        fs.mkdirSync(path.join(coveredDir, 'v3', 'sencho'), { recursive: true });
        fs.rmSync(path.join(coveredDir, 'current'));
        fs.symlinkSync('v3', path.join(coveredDir, 'current'));
        mountinfo = [realCovered(), path.join(realCovered(), 'v2', 'sencho')].map((point, i) => `${i} 1 0:1 / ${point} rw - tmpfs tmpfs rw`).join('\n');
        const service = setup([v2File], [appsMount], [recorded]);

        await expect(service.canSelfUpdateTarget('0.99.1')).resolves.toEqual({ ok: true });
        clock += 3 * FIVE_MIN;
        await expect(service.getPinInfo()).resolves.toMatchObject({ pinKind: 'semver' });
        await service.triggerUpdate({ targetVersion: '0.99.1' });

        expect(stagedWrites[0]).toBe(patchComposeServiceImage(compose('saelix/sencho:0.99.0'), 'sencho', 'saelix/sencho:0.99.1'));
        expect(helperCalls()).toHaveLength(2);
      });

      it('reads the host file through the helper when the link was replaced by a folder after the start', async () => {
        fs.rmSync(path.join(coveredDir, 'current'));
        fs.mkdirSync(path.join(coveredDir, 'current', 'sencho'), { recursive: true });
        mountinfo = [realCovered(), path.join(realCovered(), 'v2', 'sencho')].map((point, i) => `${i} 1 0:1 / ${point} rw - tmpfs tmpfs rw`).join('\n');
        const service = setup([v2File], [appsMount], [recorded]);

        await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.0', filePath: v2File });
        expect(helperCalls()).toHaveLength(1);
      });

      it('reads the host file through the helper when the mount root is not a live mount point', async () => {
        // The chosen mount was hidden by a later mount whose own link leads elsewhere.
        mountinfo = `0 1 0:1 / ${path.dirname(realCovered())} rw - tmpfs tmpfs rw`;
        fs.writeFileSync(path.join(coveredDir, 'compose.yaml'), compose(shadowImage));
        hostFiles.set(`${hostApps}/compose.yaml`, compose('saelix/sencho:0.99.0'));
        const service = setup([`${hostApps}/compose.yaml`], [appsMount]);

        await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.0' });
        expect(helperCalls()).toHaveLength(1);
      });

      it('reads the host file through the helper when the link is retargeted to a missing folder', async () => {
        fs.rmSync(path.join(coveredDir, 'current'));
        fs.symlinkSync('gone', path.join(coveredDir, 'current'));
        mountinfo = [coveredDir, path.join(realCovered(), 'v2', 'sencho')].map((point, i) => `${i} 1 0:1 / ${point} rw - tmpfs tmpfs rw`).join('\n');
        const service = setup([v2File], [appsMount], [recorded]);

        await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.0', filePath: v2File });
        expect(helperCalls()).toHaveLength(1);
      });

      it('reads the host file through the helper when a nested destination resolves onto the mount root', async () => {
        // `covered/x/sencho -> ..`: the second mount lands on `covered` itself and hides the first.
        fs.mkdirSync(path.join(coveredDir, 'x'), { recursive: true });
        fs.symlinkSync('..', path.join(coveredDir, 'x', 'sencho'));
        fs.writeFileSync(path.join(coveredDir, 'compose.yaml'), compose(shadowImage));
        hostFiles.set(`${hostApps}/compose.yaml`, compose('saelix/sencho:0.99.0'));
        const service = setup([`${hostApps}/compose.yaml`], [appsMount], [path.join(coveredDir, 'x', 'sencho')]);

        await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.0' });
        expect(helperCalls()).toHaveLength(1);
      });

      it('reads the host file through the helper when a mount on a parent path was mounted after the chosen one', async () => {
        const root = realCovered();
        mountinfo = [root, path.dirname(root)].map((point, i) => `${i} 1 0:1 / ${point} rw - tmpfs tmpfs rw`).join('\n');
        fs.writeFileSync(path.join(coveredDir, 'compose.yaml'), compose(shadowImage));
        hostFiles.set(`${hostApps}/compose.yaml`, compose('saelix/sencho:0.99.0'));
        const service = setup([`${hostApps}/compose.yaml`], [appsMount]);

        await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.0' });
        expect(helperCalls()).toHaveLength(1);
      });

      it('still reads directly when the parent path was mounted before the chosen mount', async () => {
        const root = realCovered();
        mountinfo = [path.dirname(root), root].map((point, i) => `${i} 1 0:1 / ${point} rw - tmpfs tmpfs rw`).join('\n');
        fs.writeFileSync(path.join(coveredDir, 'compose.yaml'), compose(shadowImage));
        const service = setup([`${hostApps}/compose.yaml`], [appsMount]);

        await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: shadowImage });
        expect(helperCalls()).toHaveLength(0);
      });

      it('reads directly through a submount of the bound folder that Docker did not record', async () => {
        // A dataset mounted under the bound folder shows the host's own file at that path.
        const dataset = path.join(realCovered(), 'sencho');
        mountinfo = [realCovered(), dataset].map((point, i) => `${i} 1 0:1 / ${point} rw - zfs pool rw`).join('\n');
        writeShadow();
        const service = setup([hostFile], [appsMount]);

        await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: shadowImage });
        expect(helperCalls()).toHaveLength(0);
      });

      it('reads the host file through the helper when the live mount list has two mounts on the root', async () => {
        mountinfo = [realCovered(), realCovered()].map((point, i) => `${i} 1 0:1 / ${point} rw - tmpfs tmpfs rw`).join('\n');
        fs.writeFileSync(path.join(coveredDir, 'compose.yaml'), compose(shadowImage));
        hostFiles.set(`${hostApps}/compose.yaml`, compose('saelix/sencho:0.99.0'));
        const service = setup([`${hostApps}/compose.yaml`], [appsMount]);

        await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.0' });
        expect(helperCalls()).toHaveLength(1);
      });

      it('still reads directly when the recorded destination is not over the file', async () => {
        const service = setup([v2File], [appsMount], [path.join(coveredDir, 'current', 'other')]);

        await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: shadowImage, pinKind: 'digest' });
        expect(helperCalls()).toHaveLength(0);
      });
    });
  });

  describe('a symlink with an absolute target', () => {
    const hostApps = '/host/apps';
    const hostFile = `${hostApps}/current/compose.yaml`;
    const v2 = path.join(coveredDir, 'v2');

    beforeEach(() => {
      fs.mkdirSync(v2, { recursive: true });
      fs.writeFileSync(path.join(v2, 'compose.yaml'), compose('saelix/sencho:9.9.9'));
      // On the host the link points into the host's tree; Sencho resolves the same text in its own.
      fs.symlinkSync(v2, path.join(coveredDir, 'current'));
      hostFiles.set(hostFile, compose('saelix/sencho:0.99.0'));
    });

    it('is read through the helper when the mount shows the folder at another path', async () => {
      const service = setup([hostFile], [{ source: hostApps, destination: coveredDir }]);

      await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.0', filePath: hostFile });
      expect(helperCalls()).toHaveLength(1);
    });

    it('is read through the helper for a routine re-read and stages the host file on update', async () => {
      const service = setup([hostFile], [{ source: hostApps, destination: coveredDir }]);
      await service.getPinInfo({ fresh: true });

      clock += 3 * FIVE_MIN;
      await expect(service.getPinInfo()).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.0' });
      await service.triggerUpdate({ targetVersion: '0.99.1' });

      expect(helperCalls()).toHaveLength(2);
      expect(stagedWrites[0]).toBe(patchComposeServiceImage(compose('saelix/sencho:0.99.0'), 'sencho', 'saelix/sencho:0.99.1'));
    });

    it('answers the update preflight, the update-time resolve and cacheOnly from the host file', async () => {
      const service = setup([hostFile], [{ source: hostApps, destination: coveredDir }]);

      await expect(service.canSelfUpdateTarget('0.99.1')).resolves.toEqual({ ok: true });
      await expect(service.getResolvedComposeImageForUpdate()).resolves.toMatchObject({ imageRef: 'saelix/sencho:0.99.0', filePath: hostFile });
      await expect(service.getPinInfo({ cacheOnly: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.0' });
      expect(helperCalls()).toHaveLength(2);
    });

    it('is read directly when the mount shows the folder at the same path', async () => {
      const service = setup([path.join(coveredDir, 'current', 'compose.yaml')], [sameMount]);

      await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:9.9.9' });
      expect(helperCalls()).toHaveLength(0);
    });

    it('does not stop a relative link that stays inside the mount from being read directly', async () => {
      fs.rmSync(path.join(coveredDir, 'current'));
      fs.symlinkSync('v2', path.join(coveredDir, 'current'));
      const service = setup([hostFile], [{ source: hostApps, destination: coveredDir }]);

      await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:9.9.9' });
      expect(helperCalls()).toHaveLength(0);
    });
  });

  it('does not follow a symlink into a sibling folder that shares the mount name as a prefix', async () => {
    const evil = path.join(siblingDir, 'x.yaml');
    fs.writeFileSync(evil, compose('saelix/sencho:9.9.9'));
    fs.symlinkSync(evil, coveredFile);
    hostFiles.set(coveredFile, compose('saelix/sencho:0.99.0'));
    const service = setup([coveredFile], [sameMount]);

    await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.0' });
    expect(helperCalls()).toHaveLength(1);
  });

  it('reads through a symlink that stays inside the mount, with no helper', async () => {
    fs.writeFileSync(path.join(coveredDir, 'real.yaml'), compose('saelix/sencho:0.99.0'));
    fs.symlinkSync('real.yaml', coveredFile);
    const service = setup([coveredFile], [sameMount]);

    await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.0' });
    expect(helperCalls()).toHaveLength(0);
  });

  it('does not latch onto the cache after one failed direct read on a fresh read', async () => {
    writeCovered('saelix/sencho:0.99.0');
    hostFiles.set(coveredFile, compose('saelix/sencho:0.99.1'));
    const service = setup([coveredFile], [sameMount]);
    vi.spyOn(fs.promises, 'open').mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }));

    await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.1' });
    expect(helperCalls()).toHaveLength(1);

    writeCovered('saelix/sencho:0.99.2');
    clock += FIVE_MIN;
    await expect(service.getPinInfo()).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.2' });
    expect(helperCalls()).toHaveLength(1);
  });

  it('retries a failing direct re-read once per cache lifetime, not on every tick', async () => {
    writeCovered('saelix/sencho:0.99.0');
    const service = setup([coveredFile], [sameMount]);
    await service.getPinInfo({ fresh: true });

    const open = vi.spyOn(fs.promises, 'open').mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    clock += FIVE_MIN;
    for (let tick = 0; tick < 5; tick++) {
      clock += TICK;
      await expect(service.getPinInfo()).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.0' });
    }
    expect(open).toHaveBeenCalledTimes(1);
    clock += FIVE_MIN;
    await service.getPinInfo();
    expect(open).toHaveBeenCalledTimes(2);
    expect(helperCalls()).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(coveredFile));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('EACCES'));
  });

  it('does not let a routine read that finishes late overwrite a newer fresh read', async () => {
    writeCovered('saelix/sencho:0.99.0');
    const service = setup([coveredFile], [sameMount]);
    await service.getPinInfo({ fresh: true });

    clock += FIVE_MIN;
    const real = fs.promises.open.bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    vi.spyOn(fs.promises, 'open').mockImplementation((async (...args: unknown[]) => {
      if (calls++ === 0) {
        await gate;
        return fakeHandle(compose('saelix/sencho:0.99.0'));
      }
      return real(...args);
    }) as unknown as typeof fs.promises.open);

    const late = service.getPinInfo();
    await vi.waitFor(() => expect(calls).toBe(1));
    clock += 1000;
    writeCovered('saelix/sencho:0.99.2');
    await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.2' });
    release();
    await late;

    await expect(service.getPinInfo({ cacheOnly: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.2' });
  });

  it('does not let a failing routine re-read make an in-flight fresh read look stale', async () => {
    writeCovered('saelix/sencho:0.99.0');
    const service = setup([coveredFile], [sameMount]);
    await service.getPinInfo({ fresh: true });

    clock += FIVE_MIN;
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(fs.promises, 'open').mockImplementation((async () => {
      if (calls++ === 0) {
        await gate;
        return fakeHandle(compose('saelix/sencho:0.99.2'));
      }
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    }) as unknown as typeof fs.promises.open);

    const fresh = service.getPinInfo({ fresh: true });
    await vi.waitFor(() => expect(calls).toBe(1));
    clock += 1000;
    await expect(service.getPinInfo()).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.0' });
    release();
    await fresh;

    await expect(service.getPinInfo({ cacheOnly: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.2' });
  });

  it('never moves the retry time backwards when a slow routine re-read fails after a newer read', async () => {
    writeCovered('saelix/sencho:0.99.0');
    const service = setup([coveredFile], [sameMount]);
    await service.getPinInfo({ fresh: true });

    clock += FIVE_MIN;
    const routineStart = clock;
    const real = fs.promises.open.bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (...args: unknown[]) => {
      if (calls++ === 0) {
        await gate;
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      }
      return real(...args);
    }) as unknown as typeof fs.promises.open);

    const slowRoutine = service.getPinInfo();
    await vi.waitFor(() => expect(calls).toBe(1));
    clock += 1000;
    await service.getPinInfo({ fresh: true });
    release();
    await slowRoutine;

    clock = routineStart + FIVE_MIN + 500;
    await service.getPinInfo();
    expect(calls).toBe(2);
  });

  it('returns a routine re-read that finds no image for the service, not the stale pin', async () => {
    writeCovered('saelix/sencho:0.99.0');
    const service = setup([coveredFile], [sameMount]);
    await service.getPinInfo({ fresh: true });

    fs.writeFileSync(coveredFile, 'services:\n  other:\n    image: busybox\n');
    clock += FIVE_MIN;
    await expect(service.getPinInfo()).resolves.toBeNull();
    await expect(service.getPinInfo()).resolves.toBeNull();
  });

  it('strips control characters from the path in the unreadable-file warning', async () => {
    const service = setup(['/srv/un\ncovered/compose.yaml'], []);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await service.getPinInfo({ fresh: true });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain('\n');
  });

  it('is treated as uncovered when the mapped path is not a regular file', async () => {
    fs.mkdirSync(coveredFile);
    hostFiles.set(coveredFile, compose('saelix/sencho:0.99.0'));
    const service = setup([coveredFile], [sameMount]);

    await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.0' });
    expect(helperCalls()).toHaveLength(1);
  });
});

describe('a Compose file no bind mount covers', () => {
  it('starts one labelled helper on the fresh warm-up read and none during a simulated hour of monitor ticks', async () => {
    hostFiles.set(uncoveredFile, compose('saelix/sencho:0.99.0'));
    const service = setup([uncoveredFile], []);

    await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ pinKind: 'semver' });
    expect(helperCalls()).toHaveLength(1);
    expect((helperCalls()[0][1] as string[]).join(' ')).toContain('--label io.sencho.helper=compose-read');

    for (let tick = 0; tick < 120; tick++) {
      clock += TICK;
      await expect(service.getPinInfo()).resolves.toMatchObject({ pinKind: 'semver', composeImageRef: 'saelix/sencho:0.99.0' });
    }
    expect(helperCalls()).toHaveLength(1);
  });

  it('refreshes the cache on a fresh read and on getResolvedComposeImageForUpdate', async () => {
    hostFiles.set(uncoveredFile, compose('saelix/sencho:0.99.0'));
    const service = setup([uncoveredFile], []);
    await service.getPinInfo({ fresh: true });

    hostFiles.set(uncoveredFile, compose('saelix/sencho:0.99.1'));
    clock += 10 * FIVE_MIN;
    await expect(service.getPinInfo()).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.0' });

    await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.1' });
    expect(helperCalls()).toHaveLength(2);
    await expect(service.getPinInfo()).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.1' });

    hostFiles.set(uncoveredFile, compose('saelix/sencho:0.99.2'));
    await expect(service.getResolvedComposeImageForUpdate()).resolves.toMatchObject({ imageRef: 'saelix/sencho:0.99.2' });
    expect(helperCalls()).toHaveLength(3);
    clock += 10 * FIVE_MIN;
    await expect(service.getPinInfo()).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.2' });
    expect(helperCalls()).toHaveLength(3);
  });

  it('keeps the last good classification when a later fresh read cannot read the file', async () => {
    hostFiles.set(uncoveredFile, compose('saelix/sencho:0.99.0'));
    const service = setup([uncoveredFile], []);
    await service.getPinInfo({ fresh: true });

    hostFiles.delete(uncoveredFile);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(service.getPinInfo({ fresh: true })).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(uncoveredFile));
    clock += 2 * FIVE_MIN;
    await expect(service.getPinInfo()).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.0' });
    expect(helperCalls()).toHaveLength(2);
  });

  it('lets a routine read wait for the read already in flight instead of starting its own', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    hostFiles.set(uncoveredFile, compose('saelix/sencho:0.99.0'));
    const service = setup([uncoveredFile], []);
    const base = mockExecFileAsync.getMockImplementation()!;
    mockExecFileAsync.mockImplementation(async (...args: unknown[]) => {
      await gate;
      return base(...(args as [string, string[]]));
    });

    const warmUp = service.getPinInfo({ fresh: true });
    const routine = service.getPinInfo();
    release();

    await expect(routine).resolves.toMatchObject({ pinKind: 'semver' });
    await expect(warmUp).resolves.toMatchObject({ pinKind: 'semver' });
    expect(helperCalls()).toHaveLength(1);
  });

  it('classifies through the startup detection path, so the first routine read is not empty', async () => {
    writeCovered('saelix/sencho:0.99.0');
    const service = setup([coveredFile], [sameMount]);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    (service as unknown as Internals).applyDetection(null);

    await expect(service.getPinInfo()).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.0' });
    expect(helperCalls()).toHaveLength(0);
  });
});

describe('a Compose file that cannot be read at all', () => {
  const warnSilently = () => vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  /** Routine reads every 30 seconds for `span`, returning the times (ms after the start) the helper ran. */
  async function runTicks(service: SelfUpdateService, span: number): Promise<number[]> {
    const times: number[] = [];
    let seen = helperCalls().length;
    for (let elapsed = TICK; elapsed <= span; elapsed += TICK) {
      clock = T0 + elapsed;
      await service.getPinInfo();
      await (service as unknown as Internals).pinInflight;
      const now = helperCalls().length;
      if (now > seen) times.push(elapsed);
      seen = now;
    }
    return times;
  }

  it('retries a transient startup failure within five minutes and then keeps the pin', async () => {
    warnSilently();
    const service = setup([uncoveredFile], []);
    await expect(service.getPinInfo({ fresh: true })).resolves.toBeNull();
    expect(helperCalls()).toHaveLength(1);

    clock = T0 + FIVE_MIN - TICK;
    await expect(service.getPinInfo()).resolves.toBeNull();
    expect(helperCalls()).toHaveLength(1);

    hostFiles.set(uncoveredFile, compose('saelix/sencho:0.99.0'));
    clock = T0 + FIVE_MIN;
    await expect(service.getPinInfo()).resolves.toMatchObject({ pinKind: 'semver' });
    expect(helperCalls()).toHaveLength(2);

    expect(await runTicks(service, 3 * HOUR)).toEqual([]);
    expect(helperCalls()).toHaveLength(2);
  });

  it('backs off: each retry waits twice as long as the last, up to a day, over two simulated days', async () => {
    warnSilently();
    const service = setup([uncoveredFile], []);
    await service.getPinInfo({ fresh: true });

    const times = [0, ...await runTicks(service, 2 * DAY)];
    const gaps = times.slice(1).map((time, i) => time - times[i]);

    expect(gaps[0]).toBeGreaterThanOrEqual(FIVE_MIN);
    gaps.forEach((gap, i) => {
      const expected = Math.min(FIVE_MIN * 2 ** i, DAY);
      expect(gap).toBeGreaterThanOrEqual(expected);
      expect(gap).toBeLessThanOrEqual(expected + TICK);
    });
    // Reads about 0, 5, 15, 35, 75, 155, 315, 635, 1275 and 2555 minutes in.
    expect(helperCalls()).toHaveLength(10);
  });

  it('settles at one helper read a day once the delay reaches its ceiling', async () => {
    warnSilently();
    const service = setup([uncoveredFile], []);
    await service.getPinInfo({ fresh: true });
    await runTicks(service, 3 * DAY);
    const before = helperCalls().length;

    const times: number[] = [];
    let seen = before;
    for (let elapsed = 3 * DAY + TICK; elapsed <= 6 * DAY; elapsed += 20 * TICK) {
      clock = T0 + elapsed;
      await service.getPinInfo();
      await (service as unknown as Internals).pinInflight;
      if (helperCalls().length > seen) times.push(elapsed);
      seen = helperCalls().length;
    }
    // One read a day: about 3.8, 4.8 and 5.8 days in.
    expect(times).toHaveLength(3);
  });

  it('keeps the classification of the files it did read, for routine callers and cacheOnly', async () => {
    warnSilently();
    writeCovered('saelix/sencho:0.99.0');
    const service = setup([coveredFile, uncoveredFile], [sameMount]);

    await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.0' });
    expect(helperCalls()).toHaveLength(1);

    await expect(service.getPinInfo()).resolves.toMatchObject({ pinKind: 'semver' });
    await expect(service.getPinInfo({ cacheOnly: true })).resolves.toMatchObject({ pinKind: 'semver' });
    expect(helperCalls()).toHaveLength(1);
  });

  it('starts no helper in a project with one unreadable file during a routine tick until the delay passes', async () => {
    warnSilently();
    writeCovered('saelix/sencho:0.99.0');
    const service = setup([coveredFile, uncoveredFile], [sameMount]);
    await service.getPinInfo({ fresh: true });

    const times = await runTicks(service, 3 * HOUR);
    // After waits of 5, 10, 20, 40 and 80 minutes (about 5, 15, 35, 75 and 155 minutes in), each to the next tick.
    expect(times).toHaveLength(5);
    expect(helperCalls()).toHaveLength(6);
  });

  it('keeps reading every file on a fresh read, whatever the delay', async () => {
    warnSilently();
    const service = setup([uncoveredFile], []);
    await service.getPinInfo({ fresh: true });
    await service.getPinInfo({ fresh: true });
    await service.getResolvedComposeImageForUpdate();
    expect(helperCalls()).toHaveLength(3);

    hostFiles.set(uncoveredFile, compose('saelix/sencho:0.99.4'));
    await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.4' });
  });

  it('does not let a partial read replace a complete classification', async () => {
    warnSilently();
    hostFiles.set(uncoveredFile, compose('saelix/sencho:0.99.0'));
    writeCovered('saelix/sencho:0.99.0');
    fs.writeFileSync(coveredFile, 'services:\n  other:\n    image: busybox\n');
    const service = setup([uncoveredFile, coveredFile], [sameMount]);
    await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.0' });

    hostFiles.delete(uncoveredFile);
    await expect(service.getPinInfo({ fresh: true })).resolves.toBeNull();

    clock += 10 * HOUR;
    await expect(service.getPinInfo()).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.0' });
    await expect(service.getPinInfo({ cacheOnly: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.0' });
    expect(helperCalls()).toHaveLength(2);
  });

  it('does not replace a partial classification with one that found no image', async () => {
    warnSilently();
    writeCovered('saelix/sencho:0.99.0');
    const service = setup([coveredFile, uncoveredFile], [sameMount]);
    await service.getPinInfo({ fresh: true });

    fs.writeFileSync(coveredFile, 'services:\n  other:\n    image: busybox\n');
    await expect(service.getPinInfo({ fresh: true })).resolves.toBeNull();

    await expect(service.getPinInfo({ cacheOnly: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.0' });
  });

  it('answers from a partial classification at once and reads again in the background, then shows what that read found', async () => {
    warnSilently();
    writeCovered('saelix/sencho:0.99.0');
    const service = setup([coveredFile, uncoveredFile], [sameMount]);
    await service.getPinInfo({ fresh: true });
    expect(helperCalls()).toHaveLength(1);
    clock = T0 + FIVE_MIN;

    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const base = mockExecFileAsync.getMockImplementation()!;
    mockExecFileAsync.mockImplementation(async (...args: unknown[]) => {
      await gate;
      return base(...(args as [string, string[]]));
    });
    writeCovered('saelix/sencho:0.99.7');

    // The helper read is held back; a caller that waited for it would never return.
    await expect(service.getPinInfo()).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.0' });
    await expect(service.getPinInfo()).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.0' });
    release();
    await (service as unknown as Internals).pinInflight;

    expect(helperCalls()).toHaveLength(2);
    await expect(service.getPinInfo({ cacheOnly: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.7' });
  });

  it('replaces a partial classification with a newer partial one that found a different image', async () => {
    warnSilently();
    writeCovered('saelix/sencho:0.99.0');
    const service = setup([coveredFile, uncoveredFile], [sameMount]);
    await service.getPinInfo({ fresh: true });

    writeCovered('saelix/sencho:0.99.1');
    await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.1' });

    await expect(service.getPinInfo({ cacheOnly: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.1' });
  });

  it('lets a complete read replace a partial entry that a later-started read wrote first', async () => {
    warnSilently();
    writeCovered('saelix/sencho:0.99.0');
    const service = setup([coveredFile, uncoveredFile], [sameMount]);
    const internals = service as unknown as Internals;
    await service.getPinInfo({ fresh: true });
    expect(internals.incompleteReads).toBe(1);
    clock = T0 + FIVE_MIN;

    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    mockExecFileAsync.mockImplementation(async () => {
      calls += 1;
      if (calls > 1) throw new Error('No such file');
      await gate;
      return { stdout: compose('saelix/sencho:0.99.0'), stderr: '' };
    });

    // The background read starts first and is held; a fresh read starts later, misses the file and finishes first.
    await expect(service.getPinInfo()).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.0' });
    const background = internals.pinInflight as Promise<unknown>;
    clock += 1000;
    await service.getPinInfo({ fresh: true });
    expect(internals.incompleteReads).toBe(2);
    release();
    await background;

    expect(internals.incompleteReads).toBe(0);
    expect(internals.pinCache).toMatchObject({ partial: false });
    await expect(service.getPinInfo({ cacheOnly: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.0' });
    const before = helperCalls().length;
    clock += DAY;
    await service.getPinInfo();
    expect(helperCalls()).toHaveLength(before);
  });

  it('does not let a partial read that finishes after a newer complete one rewind the retry count', async () => {
    warnSilently();
    const service = setup([uncoveredFile], []);
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let first = true;
    mockExecFileAsync.mockImplementation(async (_cmd: string, args: string[]) => {
      if (first) {
        first = false;
        await gate;
        throw new Error('No such file');
      }
      return { stdout: hostFiles.get(args[args.length - 1]) ?? '', stderr: '' };
    });
    hostFiles.set(uncoveredFile, compose('saelix/sencho:0.99.0'));

    const older = service.getPinInfo({ fresh: true });
    clock += 1000;
    await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ pinKind: 'semver' });
    release();
    await expect(older).resolves.toBeNull();

    expect((service as unknown as Internals).incompleteReads).toBe(0);
    await expect(service.getPinInfo({ cacheOnly: true })).resolves.toMatchObject({ pinKind: 'semver' });
  });

  it('starts counting again after a complete read, and after a new detection', async () => {
    warnSilently();
    const service = setup([uncoveredFile], []);
    await service.getPinInfo({ fresh: true });
    await service.getPinInfo({ fresh: true });
    expect((service as unknown as Internals).incompleteReads).toBe(2);

    hostFiles.set(uncoveredFile, compose('saelix/sencho:0.99.0'));
    await service.getPinInfo({ fresh: true });
    expect((service as unknown as Internals).incompleteReads).toBe(0);

    hostFiles.delete(uncoveredFile);
    (service as unknown as Internals).pinCache = null;
    await service.getPinInfo({ fresh: true });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    (service as unknown as Internals).applyDetection(null);
    expect((service as unknown as Internals).incompleteReads).toBe(0);
  });

  it('lets a routine read wait for the read in flight, not start a second one', async () => {
    warnSilently();
    const service = setup([uncoveredFile], []);
    await service.getPinInfo({ fresh: true });
    clock = T0 + FIVE_MIN;

    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const base = mockExecFileAsync.getMockImplementation()!;
    mockExecFileAsync.mockImplementation(async (...args: unknown[]) => {
      await gate;
      return base(...(args as [string, string[]]));
    });
    hostFiles.set(uncoveredFile, compose('saelix/sencho:0.99.0'));

    const first = service.getPinInfo();
    const second = service.getPinInfo();
    release();

    await expect(first).resolves.toMatchObject({ pinKind: 'semver' });
    await expect(second).resolves.toMatchObject({ pinKind: 'semver' });
    expect(helperCalls()).toHaveLength(2);
  });
});

describe('a Compose project split across a covered and an uncovered file', () => {
  it('reads one file directly and one through the helper, and later routine reads start no helper', async () => {
    writeCovered('saelix/sencho:0.99.0');
    hostFiles.set(overrideFile, 'services:\n  other:\n    image: busybox\n');
    const service = setup([coveredFile, overrideFile], [sameMount]);

    await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.0', filePath: coveredFile });
    expect(helperCalls()).toHaveLength(1);
    expect((helperCalls()[0][1] as string[]).at(-1)).toBe(overrideFile);

    for (let tick = 0; tick < 40; tick++) {
      clock += TICK * 4;
      await service.getPinInfo();
    }
    expect(helperCalls()).toHaveLength(1);
  });
});

describe('a new detection', () => {
  it('drops the classification the previous Compose context produced', async () => {
    hostFiles.set(uncoveredFile, compose('saelix/sencho:0.99.0'));
    const service = setup([uncoveredFile], []);
    await service.getPinInfo({ fresh: true });

    writeCovered('saelix/sencho:0.50.0');
    const internals = service as unknown as Internals;
    internals.composeContext = { ...internals.composeContext, configFiles: coveredFile, workingDir: coveredDir, hostBindMounts: [sameMount] };
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    internals.applyDetection(null);

    await expect(service.getPinInfo()).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.50.0' });
  });
});

describe('a Compose project whose base file is uncovered and override is covered', () => {
  it('reads the override directly and keeps its precedence', async () => {
    hostFiles.set(uncoveredFile, compose('saelix/sencho:0.99.0'));
    writeCovered('saelix/sencho:0.99.5');
    const service = setup([uncoveredFile, coveredFile], [sameMount]);

    await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.5', filePath: coveredFile });
    expect(helperCalls()).toHaveLength(1);
    expect((helperCalls()[0][1] as string[]).at(-1)).toBe(uncoveredFile);

    clock += 3 * FIVE_MIN;
    await service.getPinInfo();
    expect(helperCalls()).toHaveLength(1);
  });
});

describe('routine reads before any classification exists', () => {
  it('return null without reading anything', async () => {
    writeCovered('saelix/sencho:0.99.0');
    const service = setup([coveredFile], [sameMount]);
    const open = vi.spyOn(fs.promises, 'open');

    await expect(service.getPinInfo()).resolves.toBeNull();
    await expect(service.getPinInfo({ cacheOnly: true })).resolves.toBeNull();
    expect(open).not.toHaveBeenCalled();
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it('cacheOnly keeps serving the cached classification past the cache lifetime', async () => {
    hostFiles.set(uncoveredFile, compose('saelix/sencho:0.99.0'));
    const service = setup([uncoveredFile], []);
    await service.getPinInfo({ fresh: true });

    clock += 12 * 60 * 60 * 1000;
    await expect(service.getPinInfo({ cacheOnly: true })).resolves.toMatchObject({ pinKind: 'semver' });
    expect(helperCalls()).toHaveLength(1);
  });
});

describe('triggerUpdate repin', () => {
  it('patches the content it read directly and stages that, without a read helper', async () => {
    writeCovered('saelix/sencho:0.99.0');
    const service = setup([coveredFile], [sameMount]);

    await service.triggerUpdate({ targetVersion: '0.99.1' });

    expect(stagedWrites).toHaveLength(1);
    expect(stagedWrites[0]).toBe(patchComposeServiceImage(compose('saelix/sencho:0.99.0'), 'sencho', 'saelix/sencho:0.99.1'));
    expect(helperCalls()).toHaveLength(0);
    expect(mockExecFileAsync.mock.calls.some(call => (call[1] as string[])[0] === 'pull')).toBe(true);
  });
});
