import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { raiseGitOpsStateInvalidate, runSourceControllerAction } from './gitSourceControllerAction';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mockFetch = vi.mocked(apiFetch);

function res(ok: boolean, body: unknown = {}): Response {
  return { ok, status: ok ? 200 : 409, json: async () => body } as unknown as Response;
}

function invalidations(): { count: () => number; details: () => unknown[]; stop: () => void } {
  const seen: unknown[] = [];
  const on = (e: Event) => { seen.push((e as CustomEvent).detail); };
  window.addEventListener('sencho:state-invalidate', on);
  return { count: () => seen.length, details: () => seen, stop: () => window.removeEventListener('sencho:state-invalidate', on) };
}

afterEach(() => {
  mockFetch.mockReset();
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
});

describe('runSourceControllerAction', () => {
  it('posts to the stack on its own node, then reports and raises the refresh signal', async () => {
    const seen = invalidations();
    mockFetch.mockResolvedValue(res(true));

    await expect(runSourceControllerAction('my stack', 4, 'resume')).resolves.toBe(true);

    expect(mockFetch).toHaveBeenCalledWith('/stacks/my%20stack/git-source/resume', { nodeId: 4, method: 'POST', body: '{}' });
    expect(toast.success).toHaveBeenCalledWith('Reconciliation resumed for my stack');
    expect(seen.count()).toBe(1);
    // Scope and node are what the GitOps listeners filter on.
    expect(seen.details()).toEqual([{ scope: 'gitops', nodeId: 4 }]);
    seen.stop();
  });

  it('forwards a body when the action takes one', async () => {
    mockFetch.mockResolvedValue(res(true));
    await runSourceControllerAction('web', 1, 'suspend', { reason: 'maintenance' });
    expect(mockFetch).toHaveBeenCalledWith('/stacks/web/git-source/suspend', expect.objectContaining({ body: '{"reason":"maintenance"}' }));
  });

  it('reports a refusal with the server message and raises no refresh signal', async () => {
    const seen = invalidations();
    mockFetch.mockResolvedValue(res(false, { error: 'Not retryable' }));

    await expect(runSourceControllerAction('web', 1, 'retry')).resolves.toBe(false);

    expect(toast.error).toHaveBeenCalledWith('web: Not retryable');
    expect(toast.success).not.toHaveBeenCalled();
    expect(seen.count()).toBe(0);
    seen.stop();
  });

  it('names the action when a refusal carries no message', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: async () => { throw new Error('not json'); } } as unknown as Response);
    await expect(runSourceControllerAction('web', 1, 'retry')).resolves.toBe(false);
    expect(toast.error).toHaveBeenCalledWith('web: could not retry this Git source');
  });

  it('reports a network failure instead of throwing', async () => {
    const seen = invalidations();
    mockFetch.mockRejectedValue(new Error('offline'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runSourceControllerAction('web', 1, 'retry')).resolves.toBe(false);

    expect(toast.error).toHaveBeenCalledWith('web: offline');
    expect(seen.count()).toBe(0);
    seen.stop();
  });
});

describe('raiseGitOpsStateInvalidate', () => {
  it('announces a gitops change on the node it happened on', () => {
    const seen = invalidations();
    raiseGitOpsStateInvalidate(7);
    expect(seen.details()).toEqual([{ scope: 'gitops', nodeId: 7 }]);
    seen.stop();
  });

  it.each([undefined, null])('still announces on the gitops channel when the node is %s', (unknownNode) => {
    const seen = invalidations();
    raiseGitOpsStateInvalidate(unknownNode);
    expect(seen.details()).toEqual([{ scope: 'gitops' }]);
    seen.stop();
  });
});
