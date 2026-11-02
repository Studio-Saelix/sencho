/**
 * Bulk stacks count a policy skip separately from a failure: the operator
 * declared that the stack is not to be updated automatically, so "3 updated,
 * 1 skipped by update policy" is the whole truth.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { toast } from '@/components/ui/toast-store';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import { apiFetch } from '@/lib/api';
import { useBulkStackActions } from '../useBulkStackActions';

const json = (status: number, body: unknown): Response => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
}) as Response;

async function run(action: 'update' | 'restart', files: string[]) {
  const { result } = renderHook(() => useBulkStackActions());
  await act(async () => {
    await result.current.runBulk(action, files);
  });
}

describe('useBulkStackActions', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.warning).mockClear();
  });

  it('counts policy skips separately from updates', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(200, {
      action: 'update',
      results: [
        { stackName: 'web', ok: true },
        { stackName: 'api', ok: true },
        { stackName: 'cache', ok: true },
        {
          stackName: 'db',
          ok: false,
          code: 'update_policy_skipped',
          error: 'Skipped by io.sencho.update: "db" is set to disabled.',
        },
      ],
    }));
    await run('update', ['web.yml', 'api.yml', 'cache.yml', 'db.yml']);
    expect(toast.warning).toHaveBeenCalledWith('3 updated, 1 skipped by update policy');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('keeps skips out of the failed list when something else also failed', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(200, {
      action: 'update',
      results: [
        { stackName: 'web', ok: true },
        { stackName: 'db', ok: false, code: 'update_policy_skipped', error: 'Skipped by io.sencho.update.' },
        { stackName: 'api', ok: false, code: 'op_failed', error: 'compose up failed' },
      ],
    }));
    await run('update', ['web.yml', 'db.yml', 'api.yml']);
    expect(toast.error).toHaveBeenCalledWith(
      '1 of 3 updated; 1 skipped by update policy; 1 failed: api',
    );
  });

  it('still reports a plain success when nothing was skipped', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(200, {
      action: 'restart',
      results: [{ stackName: 'web', ok: true }, { stackName: 'api', ok: true }],
    }));
    await run('restart', ['web.yml', 'api.yml']);
    expect(toast.success).toHaveBeenCalledWith('2 stacks restarted');
  });

  it('uses the server sentence when the node predates the contract', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(400, {
      code: 'capability_unavailable',
      error: 'Bulk updates are not supported on this node.',
    }));
    await run('update', ['web.yml']);
    expect(toast.error).toHaveBeenCalledWith('Bulk updates are not supported on this node.');
  });

  it('uses the server sentence when the node is unreachable', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(503, {
      code: 'node_unreachable',
      error: 'The node did not answer.',
    }));
    await run('update', ['web.yml']);
    expect(toast.error).toHaveBeenCalledWith('The node did not answer.');
  });

  it('falls back to its own wording for a node refusal with no message', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(400, { code: 'capability_unavailable' }));
    await run('update', ['web.yml']);
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('does not support this bulk action'));
  });
});
