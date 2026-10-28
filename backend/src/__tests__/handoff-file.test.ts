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
  function recordingFs(): { ops: HandoffFileSystem; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      ops: {
        writeFile: async (path) => { calls.push(`write ${path}`); },
        chown: async (path, uid, gid) => { calls.push(`chown ${path} ${uid}:${gid}`); },
        rename: async (from, to) => { calls.push(`rename ${from} ${to}`); },
      },
    };
  }

  it('chowns the temporary file before the rename, for files written before and after app startup', async () => {
    const { ops, calls } = recordingFs();
    // The staging helper writes the rollback snapshot before Sencho restarts;
    // the detached helper writes the outcome after the new process is up.
    await writeHandoffJson('/app/data/endpoint-provider/op/rollback.json', { id: 1 }, { uid: 1000, gid: 1001 }, ops);
    await writeHandoffJson('/app/data/endpoint-provider/op/outcome.json', { ok: true }, { uid: 1000, gid: 1001 }, ops);

    expect(calls).toHaveLength(6);
    expect(calls[0]).toMatch(/^write .*rollback\.json\.\d+\.tmp$/);
    expect(calls[1]).toMatch(/^chown .*rollback\.json\.\d+\.tmp 1000:1001$/);
    expect(calls[2]).toMatch(/^rename .*rollback\.json\.\d+\.tmp .*rollback\.json$/);
    expect(calls[3]).toMatch(/^write .*outcome\.json\.\d+\.tmp$/);
    expect(calls[4]).toMatch(/^chown .*outcome\.json\.\d+\.tmp 1000:1001$/);
    expect(calls[5]).toMatch(/^rename .*outcome\.json\.\d+\.tmp .*outcome\.json$/);
  });

  it('keeps the file owner-only and skips chown when Sencho runs as root', async () => {
    const { ops, calls } = recordingFs();
    await writeHandoffJson('/app/data/endpoint-provider/op/outcome.json', { ok: true }, null, ops);
    expect(calls).toHaveLength(2);
    expect(calls.some(call => call.startsWith('chown '))).toBe(false);
  });
});
