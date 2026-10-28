/**
 * Handoff files written by the root replacement helper must be readable by a
 * Sencho that runs as SENCHO_USER, while staying owner-only. The helper is
 * given the application uid/gid and chowns each file before its final rename.
 */
import { describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { handoffOwner, writeHandoffJson, type HandoffFileSystem } from '../helpers/handoffFile';
import { buildDeps } from '../helpers/endpointProviderDeps';
import type { ProviderReplacePlan } from '../helpers/endpointProviderReplace';

describe('handoffOwner', () => {
  it('uses the application ids when the helper runs as root and both are present', () => {
    expect(handoffOwner({ SENCHO_HANDOFF_UID: '1000', SENCHO_HANDOFF_GID: '1001' }, 0)).toEqual({ uid: 1000, gid: 1001 });
  });

  it('does not chown when the helper is not root', () => {
    expect(handoffOwner({ SENCHO_HANDOFF_UID: '1000', SENCHO_HANDOFF_GID: '1001' }, 1000)).toBeNull();
  });

  it.each([
    [{}, 0],
    [{ SENCHO_HANDOFF_UID: '1000' }, 0],
    [{ SENCHO_HANDOFF_GID: '1000' }, 0],
    [{ SENCHO_HANDOFF_UID: '', SENCHO_HANDOFF_GID: '1000' }, 0],
    [{ SENCHO_HANDOFF_UID: '-1', SENCHO_HANDOFF_GID: '1000' }, 0],
    [{ SENCHO_HANDOFF_UID: 'root', SENCHO_HANDOFF_GID: '1000' }, 0],
    [{ SENCHO_HANDOFF_UID: '1000', SENCHO_HANDOFF_GID: '1.5' }, 0],
  ])('refuses unusable ids in %o', (env, helperUid) => {
    expect(handoffOwner(env, helperUid)).toBeNull();
  });
});

describe('writeHandoffJson', () => {
  interface RecordedCall {
    call: 'write' | 'chmod' | 'chown' | 'rename';
    path: string;
    extra?: string;
    data?: unknown;
  }

  function recordingFs(): { ops: HandoffFileSystem; calls: RecordedCall[] } {
    const calls: RecordedCall[] = [];
    return {
      calls,
      ops: {
        writeFile: async (path, data, options) => {
          calls.push({ call: 'write', path, extra: options.mode.toString(8), data });
        },
        chmod: async (path, mode) => { calls.push({ call: 'chmod', path, extra: mode.toString(8) }); },
        chown: async (path, uid, gid) => { calls.push({ call: 'chown', path, extra: `${uid}:${gid}` }); },
        rename: async (from, to) => { calls.push({ call: 'rename', path: from, extra: to }); },
      },
    };
  }

  it('writes owner-only, chmods a reused temporary file, and chowns before the rename', async () => {
    const { ops, calls } = recordingFs();
    // The staging helper writes the rollback snapshot before Sencho restarts;
    // the detached helper writes the outcome after the new process is up.
    await writeHandoffJson('/app/data/endpoint-provider/op/rollback.json', { id: 1 }, { uid: 1000, gid: 1001 }, ops);
    await writeHandoffJson('/app/data/endpoint-provider/op/outcome.json', { ok: true }, { uid: 1000, gid: 1001 }, ops);

    expect(calls).toHaveLength(8);
    expect(calls[0]).toMatchObject({ call: 'write', extra: '600', data: JSON.stringify({ id: 1 }) });
    expect(calls[0].path).toMatch(/rollback\.json\.\d+\.tmp$/);
    expect(calls[1]).toMatchObject({ call: 'chmod', extra: '600' });
    expect(calls[1].path).toMatch(/rollback\.json\.\d+\.tmp$/);
    expect(calls[2]).toMatchObject({ call: 'chown', extra: '1000:1001' });
    expect(calls[2].path).toMatch(/rollback\.json\.\d+\.tmp$/);
    expect(calls[3]).toMatchObject({ call: 'rename', extra: expect.stringMatching(/rollback\.json$/) });
    expect(calls[3].path).toMatch(/rollback\.json\.\d+\.tmp$/);
    expect(calls[4]).toMatchObject({ call: 'write', extra: '600' });
    expect(calls[5]).toMatchObject({ call: 'chmod', extra: '600' });
    expect(calls[5].path).toMatch(/outcome\.json\.\d+\.tmp$/);
    expect(calls[6]).toMatchObject({ call: 'chown', extra: '1000:1001' });
    expect(calls[6].path).toMatch(/outcome\.json\.\d+\.tmp$/);
    expect(calls[7]).toMatchObject({ call: 'rename', extra: expect.stringMatching(/outcome\.json$/) });
    expect(calls[7].path).toMatch(/outcome\.json\.\d+\.tmp$/);
  });

  it('stays owner-only and skips chown when no owner was passed', async () => {
    const { ops, calls } = recordingFs();
    await writeHandoffJson('/app/data/endpoint-provider/op/outcome.json', { ok: true }, null, ops);
    expect(calls.map(call => call.call)).toEqual(['write', 'chmod', 'rename']);
    expect(calls[0]).toMatchObject({ extra: '600' });
    expect(calls[1]).toMatchObject({ extra: '600' });
  });

  it('writes a real 0600 file atomically through the default filesystem', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sencho-handoff-'));
    try {
      const file = path.join(dir, 'outcome.json');
      // chown to the caller's own uid/gid is allowed without privileges, so the
      // default fs path (write, chmod, chown, rename) is exercised for real.
      const owner = typeof process.getuid === 'function' && typeof process.getgid === 'function'
        ? { uid: process.getuid(), gid: process.getgid() }
        : null;
      await writeHandoffJson(file, { ok: true }, owner);
      // Stat and read through one descriptor: a path-based stat followed by a
      // read is a time-of-check/time-of-use race and CodeQL rejects it.
      const handle = await fs.open(file, 'r');
      try {
        const info = await handle.stat();
        expect(info.mode & 0o777).toBe(0o600);
        expect(JSON.parse(await handle.readFile('utf8'))).toEqual({ ok: true });
      } finally {
        await handle.close();
      }
      expect(await fs.readdir(dir)).toEqual(['outcome.json']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('helper wiring', () => {
  const plan: ProviderReplacePlan = {
    schemaVersion: 1,
    operationId: '3f2b8c1e-5a4d-4e7f-9b2a-1c3d5e7f9a0b',
    mode: 'reapply',
    project: 'stack',
    workingDir: '/srv/stack',
    configFiles: ['/srv/stack/compose.yaml'],
    providerService: 'socket-proxy',
    senchoService: 'sencho',
    providerContainerId: 'proxy-id',
    composeCopy: null,
    pruneOnUpdate: false,
    providerReadySeconds: 60,
    ackSeconds: 180,
  };

  it('writes the helper handoff files through the application owner from the environment', async () => {
    vi.stubEnv('SENCHO_HANDOFF_UID', '1000');
    vi.stubEnv('SENCHO_HANDOFF_GID', '1001');
    const calls: string[] = [];
    const ops: HandoffFileSystem = {
      writeFile: async (path, _data, options) => { calls.push(`write ${path} ${options.mode.toString(8)}`); },
      chmod: async (path, mode) => { calls.push(`chmod ${path} ${mode.toString(8)}`); },
      chown: async (path, uid, gid) => { calls.push(`chown ${path} ${uid}:${gid}`); },
      rename: async (from, to) => { calls.push(`rename ${from} ${to}`); },
    };
    try {
      const deps = buildDeps(plan, null, ops, 0);
      await deps.writeJson('/app/data/endpoint-provider/op/outcome.json', { ok: true });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(calls.some(call => /^write .*\.tmp 600$/.test(call))).toBe(true);
    expect(calls.some(call => /^chmod .*\.tmp 600$/.test(call))).toBe(true);
    expect(calls.some(call => /^chown .*\.tmp 1000:1001$/.test(call))).toBe(true);
    expect(calls.some(call => /^rename .*\.tmp .*outcome\.json$/.test(call))).toBe(true);
  });
});
