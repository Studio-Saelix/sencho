/**
 * How SelfUpdateService reads Sencho's own Compose files to classify the image
 * pin. Routine status and monitor reads must never create a throwaway container
 * once a classification exists; fresh reads (update decisions) stay
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
const T0 = 1_000_000;

const sameMount = { source: coveredDir, destination: coveredDir };

afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

function compose(image: string): string {
  return `services:\n  sencho:\n    image: ${image}\n`;
}

/** Contents the fake helper container serves for a host path. */
const hostFiles = new Map<string, string>();
let clock = T0;

type Mount = { source: string; destination: string };
type Internals = {
  composeContext: Record<string, unknown> | null;
  canSelfUpdate: boolean;
  pinCache: unknown;
  pinInflight: unknown;
  lastFullReadAt: number;
  applyDetection(code: null): void;
};

function setup(configFiles: string[], mounts: Mount[]): SelfUpdateService {
  const instance = SelfUpdateService.getInstance();
  const internals = instance as unknown as Internals;
  internals.composeContext = {
    workingDir: path.dirname(configFiles[0]),
    configFiles: configFiles.join(','),
    serviceName: 'sencho',
    imageName: 'saelix/sencho:0.99.0',
    dataDirHost: '/srv/data',
    hostBindMounts: mounts,
    project: 'stack',
    runningImageId: 'sha256:running',
  };
  internals.canSelfUpdate = true;
  internals.pinCache = null;
  internals.pinInflight = null;
  internals.lastFullReadAt = 0;
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
function fakeHandle(content: string): unknown {
  return { stat: async () => ({ isFile: () => true, size: content.length }), readFile: async () => content, close: async () => undefined };
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

  it('opens the file without following a symlink or waiting on a FIFO, then checks the open handle', async () => {
    writeCovered('saelix/sencho:0.99.0');
    const service = setup([coveredFile], [sameMount]);
    const open = vi.spyOn(fs.promises, 'open');

    await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.0' });

    const flags = open.mock.calls[0][1] as number;
    expect(flags & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW);
    expect(flags & fs.constants.O_NONBLOCK).toBe(fs.constants.O_NONBLOCK);
  });

  it('reads directly when the mount is the host root', async () => {
    writeCovered('saelix/sencho:0.99.0');
    const service = setup([coveredFile], [{ source: '/', destination: '/' }]);

    await expect(service.getPinInfo({ fresh: true })).resolves.toMatchObject({ composeImageRef: 'saelix/sencho:0.99.0' });
    expect(helperCalls()).toHaveLength(0);
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

  it('retries an unclassified pin at most once an hour, then keeps the classification it got', async () => {
    const service = setup([uncoveredFile], []);
    await expect(service.getPinInfo({ fresh: true })).resolves.toBeNull();
    expect(helperCalls()).toHaveLength(1);

    for (let elapsed = TICK; elapsed < HOUR; elapsed += TICK * 20) {
      clock = T0 + elapsed;
      await expect(service.getPinInfo()).resolves.toBeNull();
    }
    expect(helperCalls()).toHaveLength(1);

    hostFiles.set(uncoveredFile, compose('saelix/sencho:0.99.0'));
    clock = T0 + HOUR;
    await expect(service.getPinInfo()).resolves.toMatchObject({ pinKind: 'semver' });
    expect(helperCalls()).toHaveLength(2);

    for (let tick = 0; tick < 240; tick++) {
      clock += TICK;
      await service.getPinInfo();
    }
    expect(helperCalls()).toHaveLength(2);
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
