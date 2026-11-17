import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { raiseGitOpsStateInvalidate, runSourceControllerAction } from './gitSourceControllerAction';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

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
  vi.mocked(toast.warning).mockReset();
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

  it('reports a retry that left the previous deployment intact as a warning', async () => {
    const seen = invalidations();
    mockFetch.mockResolvedValue(res(true, {
      outcome: 'failed_previous_intact',
      reason: 'The fetch stage failed (AUTH). The previously accepted generation is unchanged.',
      nextAction: 'retry',
    }));

    await expect(runSourceControllerAction('web', 1, 'retry')).resolves.toBe(true);

    expect(toast.warning).toHaveBeenCalledWith(
      'web: retry failed, the previous deployment was left as it was. The fetch stage failed (AUTH). The previously accepted generation is unchanged.',
    );
    expect(toast.success).not.toHaveBeenCalled();
    // The server may have recorded a new attempt, so the row still refreshes.
    expect(seen.count()).toBe(1);
    seen.stop();
  });

  it('keeps the server reason for a retry that only scheduled another attempt', async () => {
    mockFetch.mockResolvedValue(res(true, {
      outcome: 'retry_scheduled',
      reason: 'A previous attempt failed transiently; retry 2 is scheduled.',
      nextAction: 'none',
    }));

    await runSourceControllerAction('web', 1, 'retry');

    expect(toast.warning).toHaveBeenCalledWith('web: A previous attempt failed transiently; retry 2 is scheduled.');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('names the server refusal when a retry did not start', async () => {
    mockFetch.mockResolvedValue(res(true, {
      outcome: 'blocked',
      reason: 'Another operation (deploy) is already in progress for web.',
      nextAction: 'retry',
    }));

    await runSourceControllerAction('web', 1, 'retry');

    expect(toast.warning).toHaveBeenCalledWith('web: Another operation (deploy) is already in progress for web.');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('keeps the success line for a retry that settled', async () => {
    mockFetch.mockResolvedValue(res(true, {
      outcome: 'pending_review',
      reason: 'A candidate is staged and requires explicit review before acceptance.',
      nextAction: 'review',
    }));

    await runSourceControllerAction('web', 1, 'retry');

    expect(toast.success).toHaveBeenCalledWith('Retry started for web');
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('reports a resume that cleared suspension as a success', async () => {
    mockFetch.mockResolvedValue(res(true, {
      outcome: 'no_source_change',
      reason: 'The configured ref still resolves to the accepted generation.',
      nextAction: 'none',
    }));

    await runSourceControllerAction('web', 1, 'resume');

    expect(toast.success).toHaveBeenCalledWith('Reconciliation resumed for web');
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('reports a resume the source refused', async () => {
    mockFetch.mockResolvedValue(res(true, {
      outcome: 'suspended',
      reason: 'Reconciliation is suspended: paused for maintenance',
      nextAction: 'resume',
    }));

    await runSourceControllerAction('web', 1, 'resume');

    expect(toast.warning).toHaveBeenCalledWith(
      'web: the source did not resume. Reconciliation is suspended: paused for maintenance',
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('reports a resume that cleared suspension but left a failing source', async () => {
    mockFetch.mockResolvedValue(res(true, {
      outcome: 'failed_previous_intact',
      reason: 'The fetch stage failed (AUTH). The previously accepted generation is unchanged.',
      nextAction: 'retry',
    }));

    await runSourceControllerAction('web', 1, 'resume');

    expect(toast.warning).toHaveBeenCalledWith(
      'web: reconciliation resumed, but the source still needs attention. The fetch stage failed (AUTH). The previously accepted generation is unchanged.',
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('reports a suspend that took as a success', async () => {
    mockFetch.mockResolvedValue(res(true, {
      outcome: 'suspended',
      reason: 'Reconciliation is suspended.',
      nextAction: 'resume',
    }));

    await runSourceControllerAction('web', 1, 'suspend');

    expect(toast.success).toHaveBeenCalledWith('Reconciliation suspended for web');
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('reports a suspend that did not take', async () => {
    mockFetch.mockResolvedValue(res(true, {
      outcome: 'unknown',
      reason: 'No GitOps application exists for this stack.',
      nextAction: 'none',
    }));

    await runSourceControllerAction('web', 1, 'suspend');

    expect(toast.warning).toHaveBeenCalledWith(
      'web: the source was not suspended. No GitOps application exists for this stack.',
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('keeps the success line when a 2xx body cannot be read', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => { throw new Error('empty'); } } as unknown as Response);

    await expect(runSourceControllerAction('web', 1, 'retry')).resolves.toBe(true);

    expect(toast.success).toHaveBeenCalledWith('Retry started for web');
    expect(toast.warning).not.toHaveBeenCalled();
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
