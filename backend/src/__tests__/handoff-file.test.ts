/**
 * Handoff files written by the root replacement helper must be readable by a
 * Sencho that runs as SENCHO_USER, while staying owner-only. The helper is
 * given the application uid/gid and chowns each file before its final rename.
 */
import { describe, expect, it } from 'vitest';
import { handoffOwner, writeHandoffJson, type HandoffFileSystem } from '../helpers/handoffFile';

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
    expect(calls[2]).toMatchObject({ call: 'chown', extra: '1000:1001' });
    expect(calls[3]).toMatchObject({ call: 'rename', extra: expect.stringMatching(/rollback\.json$/) });
    expect(calls[4]).toMatchObject({ call: 'write', extra: '600' });
    expect(calls[5]).toMatchObject({ call: 'chmod', extra: '600' });
    expect(calls[6]).toMatchObject({ call: 'chown', extra: '1000:1001' });
    expect(calls[7]).toMatchObject({ call: 'rename', extra: expect.stringMatching(/outcome\.json$/) });
  });

  it('stays owner-only and skips chown when no owner was passed', async () => {
    const { ops, calls } = recordingFs();
    await writeHandoffJson('/app/data/endpoint-provider/op/outcome.json', { ok: true }, null, ops);
    expect(calls.map(call => call.call)).toEqual(['write', 'chmod', 'rename']);
    expect(calls[0]).toMatchObject({ extra: '600' });
    expect(calls[1]).toMatchObject({ extra: '600' });
  });
});
