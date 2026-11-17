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
    mockFetch.mockResolvedValue(res(true, {
      outcome: 'no_source_change',
      reason: 'The configured ref still resolves to the accepted generation.',
      nextAction: 'none',
    }));

    await expect(runSourceControllerAction('my stack', 4, 'resume')).resolves.toBe(true);

    expect(mockFetch).toHaveBeenCalledWith('/stacks/my%20stack/git-source/resume', { nodeId: 4, method: 'POST', body: '{}' });
    expect(toast.success).toHaveBeenCalledWith('Reconciliation resumed for my stack');
    expect(seen.count()).toBe(1);
    // Scope and node are what the GitOps listeners filter on.
    expect(seen.details()).toEqual([{ scope: 'gitops', nodeId: 4 }]);
    seen.stop();
  });

  it('forwards a body when the action takes one', async () => {
    mockFetch.mockResolvedValue(res(true, { outcome: 'suspended', reason: 'Reconciliation is suspended.', nextAction: 'resume' }));
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

    await expect(runSourceControllerAction('web', 1, 'retry')).resolves.toBe(false);

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

    await expect(runSourceControllerAction('web', 1, 'retry')).resolves.toBe(false);

    expect(toast.warning).toHaveBeenCalledWith('web: A previous attempt failed transiently; retry 2 is scheduled.');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('names the server refusal when a retry did not start', async () => {
    mockFetch.mockResolvedValue(res(true, {
      outcome: 'blocked',
      reason: 'Another operation (deploy) is already in progress for web.',
      nextAction: 'retry',
    }));

    await expect(runSourceControllerAction('web', 1, 'retry')).resolves.toBe(false);

    expect(toast.warning).toHaveBeenCalledWith('web: Another operation (deploy) is already in progress for web.');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('says the retry did not start when a refusal carries no readable reason', async () => {
    mockFetch.mockResolvedValue(res(true, { outcome: 'blocked', reason: '   ', nextAction: 'retry' }));

    await runSourceControllerAction('web', 1, 'retry');

    expect(toast.warning).toHaveBeenCalledWith('web: the retry did not start.');
  });

  it.each(['suspended', 'blocked', 'recovery_required', 'retry_scheduled', 'unknown'])(
    'does not report a retry that settled as %s as started',
    async (outcome) => {
      mockFetch.mockResolvedValue(res(true, { outcome, reason: `The retry settled as ${outcome}.`, nextAction: 'none' }));

      await expect(runSourceControllerAction('web', 1, 'retry')).resolves.toBe(false);

      expect(toast.warning).toHaveBeenCalledWith(`web: The retry settled as ${outcome}.`);
      expect(toast.success).not.toHaveBeenCalled();
    },
  );

  it.each(['converged', 'no_source_change', 'candidate_already_fetched', 'pending_review', 'superseded'])(
    'keeps the success line for a retry that settled as %s',
    async (outcome) => {
      mockFetch.mockResolvedValue(res(true, { outcome, reason: 'settled', nextAction: 'none' }));

      await expect(runSourceControllerAction('web', 1, 'retry')).resolves.toBe(true);

      expect(toast.success).toHaveBeenCalledWith('Retry started for web');
      expect(toast.warning).not.toHaveBeenCalled();
    },
  );

  // The fixture omits `suspensionCleared` on purpose: a settled outcome
  // establishes the resume on its own, which is the contract an older node
  // relies on. Adding the field here would erase the evidence for it.
  it.each(['converged', 'no_source_change', 'candidate_already_fetched', 'pending_review', 'superseded'])(
    'confirms a resume that settled as %s without the node evidence field',
    async (outcome) => {
      mockFetch.mockResolvedValue(res(true, { outcome, reason: 'settled', nextAction: 'none' }));

      await expect(runSourceControllerAction('web', 1, 'resume')).resolves.toBe(true);

      expect(toast.success).toHaveBeenCalledWith('Reconciliation resumed for web');
      expect(toast.warning).not.toHaveBeenCalled();
    },
  );

  it.each(['blocked', 'recovery_required', 'retry_scheduled'])(
    'does not report a resume that settled as %s as resumed',
    async (outcome) => {
      mockFetch.mockResolvedValue(res(true, {
        outcome,
        reason: `The resume settled as ${outcome}.`,
        nextAction: 'none',
        suspensionCleared: true,
      }));

      await expect(runSourceControllerAction('web', 1, 'resume')).resolves.toBe(false);

      expect(toast.warning).toHaveBeenCalledWith(
        `web: reconciliation resumed, but the source still needs attention. The resume settled as ${outcome}.`,
      );
      expect(toast.success).not.toHaveBeenCalled();
    },
  );

  it('reports a resume the source refused', async () => {
    const seen = invalidations();
    mockFetch.mockResolvedValue(res(true, {
      outcome: 'suspended',
      reason: 'Reconciliation is suspended: paused for maintenance',
      nextAction: 'resume',
    }));

    await expect(runSourceControllerAction('web', 1, 'resume')).resolves.toBe(false);

    expect(toast.warning).toHaveBeenCalledWith(
      'web: the source did not resume. Reconciliation is suspended: paused for maintenance',
    );
    expect(toast.success).not.toHaveBeenCalled();
    // A refusal still reports the row's current evidence.
    expect(seen.count()).toBe(1);
    seen.stop();
  });

  it('reports the real missing-application resume as unconfirmed and still refreshes', async () => {
    const seen = invalidations();
    mockFetch.mockResolvedValue(res(true, {
      outcome: 'unknown',
      reason: 'No GitOps application exists for this stack.',
      nextAction: 'none',
      suspensionCleared: false,
    }));

    await expect(runSourceControllerAction('web', 1, 'resume')).resolves.toBe(false);

    expect(toast.warning).toHaveBeenCalledWith(
      'web: could not confirm the source resumed. No GitOps application exists for this stack.',
    );
    expect(toast.success).not.toHaveBeenCalled();
    // A refusal still reports the row's current evidence.
    expect(seen.count()).toBe(1);
    seen.stop();
  });

  it('reports a resume whose re-evaluation is still pending as a success when the node cleared the suspension', async () => {
    mockFetch.mockResolvedValue(res(true, {
      outcome: 'unknown',
      reason: 'The source has advanced but reconciliation has not evaluated it yet.',
      nextAction: 'none',
      suspensionCleared: true,
    }));

    await expect(runSourceControllerAction('web', 1, 'resume')).resolves.toBe(true);

    expect(toast.success).toHaveBeenCalledWith('Reconciliation resumed for web');
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('does not assume a resume took when an older node omits the evidence for an unsettled outcome', async () => {
    mockFetch.mockResolvedValue(res(true, {
      outcome: 'unknown',
      reason: 'A reconcile operation is currently in flight; no settled result yet.',
      nextAction: 'none',
    }));

    await expect(runSourceControllerAction('web', 1, 'resume')).resolves.toBe(false);

    expect(toast.warning).toHaveBeenCalledWith(
      'web: could not confirm the source resumed. A reconcile operation is currently in flight; no settled result yet.',
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('reports a resume that cleared suspension but left a failing source', async () => {
    mockFetch.mockResolvedValue(res(true, {
      outcome: 'failed_previous_intact',
      reason: 'The fetch stage failed (AUTH). The previously accepted generation is unchanged.',
      nextAction: 'retry',
      suspensionCleared: true,
    }));

    await expect(runSourceControllerAction('web', 1, 'resume')).resolves.toBe(false);

    expect(toast.warning).toHaveBeenCalledWith(
      'web: reconciliation resumed, but the source still needs attention: the previous deployment was left as it was. The fetch stage failed (AUTH). The previously accepted generation is unchanged.',
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('does not report an unrecognized resume outcome as resumed even when the suspension cleared', async () => {
    mockFetch.mockResolvedValue(res(true, {
      outcome: 'a_new_outcome',
      reason: 'Something new happened.',
      nextAction: 'none',
      suspensionCleared: true,
    }));

    await expect(runSourceControllerAction('web', 1, 'resume')).resolves.toBe(false);

    expect(toast.warning).toHaveBeenCalledWith('web: could not confirm the source resumed. Something new happened.');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('reports a suspend that took as a success', async () => {
    mockFetch.mockResolvedValue(res(true, {
      outcome: 'suspended',
      reason: 'Reconciliation is suspended.',
      nextAction: 'resume',
    }));

    await expect(runSourceControllerAction('web', 1, 'suspend')).resolves.toBe(true);

    expect(toast.success).toHaveBeenCalledWith('Reconciliation suspended for web');
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('does not claim a suspend was refused when the projection outranks it', async () => {
    mockFetch.mockResolvedValue(res(true, {
      outcome: 'recovery_required',
      reason: 'Recovery from an earlier failed mutation is still outstanding.',
      nextAction: 'view_target_results',
    }));

    await expect(runSourceControllerAction('web', 1, 'suspend')).resolves.toBe(false);

    expect(toast.warning).toHaveBeenCalledWith(
      'web: the suspension could not be confirmed. Recovery from an earlier failed mutation is still outstanding.',
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('warns when a 2xx body cannot be read', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => { throw new Error('empty'); } } as unknown as Response);

    await expect(runSourceControllerAction('web', 1, 'retry')).resolves.toBe(false);

    expect(toast.warning).toHaveBeenCalledWith('web: could not confirm the retry started.');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('warns when a 2xx body carries no outcome', async () => {
    mockFetch.mockResolvedValue(res(true, {}));

    await expect(runSourceControllerAction('web', 1, 'suspend')).resolves.toBe(false);

    expect(toast.warning).toHaveBeenCalledWith('web: could not confirm the source was suspended.');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('warns when a 2xx outcome is not one this build knows', async () => {
    mockFetch.mockResolvedValue(res(true, {
      outcome: 'a_new_outcome',
      reason: 'Something new happened.',
      nextAction: 'none',
    }));

    await expect(runSourceControllerAction('web', 1, 'retry')).resolves.toBe(false);

    expect(toast.warning).toHaveBeenCalledWith('web: Something new happened.');
    expect(toast.success).not.toHaveBeenCalled();
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
