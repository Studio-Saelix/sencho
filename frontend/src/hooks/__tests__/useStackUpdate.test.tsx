import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { toast } from '@/components/ui/toast-store';
import { SENCHO_OPEN_STACK_EVENT } from '@/lib/events';

vi.mock('@/lib/stackUpdate', () => ({ postStackUpdate: vi.fn() }));
vi.mock('@/context/DeployFeedbackContext', () => ({
  useDeployFeedback: () => ({
    runWithLog: async (_p: unknown, run: (started: Promise<void>, id: string) => Promise<{ ok: boolean }>) =>
      run(Promise.resolve(), 'session'),
  }),
}));

import { postStackUpdate } from '@/lib/stackUpdate';
import { useStackUpdate } from '../useStackUpdate';

const update = () => renderHook(() => useStackUpdate()).result.current({ nodeId: 2, stackName: 'web' });

describe('useStackUpdate', () => {
  beforeEach(() => {
    vi.mocked(postStackUpdate).mockReset();
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('says it succeeded, or that health is being verified', async () => {
    const success = vi.spyOn(toast, 'success');
    const info = vi.spyOn(toast, 'info');
    vi.mocked(postStackUpdate).mockResolvedValueOnce({ kind: 'ok', healthGateId: null });
    expect(await update()).toEqual({ ok: true, recheckWarning: undefined });
    expect(success).toHaveBeenCalledWith('web updated successfully');
    vi.mocked(postStackUpdate).mockResolvedValueOnce({ kind: 'ok', healthGateId: 'g1' });
    await update();
    expect(info).toHaveBeenCalledWith('web updated. Verifying health...');
    expect(success).toHaveBeenCalledTimes(1);
  });

  it('shows a recheck warning instead of a second success line, and returns it', async () => {
    const success = vi.spyOn(toast, 'success');
    const info = vi.spyOn(toast, 'info');
    vi.mocked(postStackUpdate).mockResolvedValue({ kind: 'ok', healthGateId: null, recheckWarning: 'still detected' });
    expect(await update()).toEqual({ ok: true, recheckWarning: 'still detected' });
    expect(info).toHaveBeenCalledWith('still detected');
    expect(success).not.toHaveBeenCalled();
  });

  it('offers the editor when the update is blocked by policy', async () => {
    const error = vi.spyOn(toast, 'error');
    vi.mocked(postStackUpdate).mockResolvedValue({
      kind: 'policy-blocked',
      policyName: 'No criticals',
      payload: { error: 'x', policy: null, violations: [] },
    });
    const opened = vi.fn();
    window.addEventListener(SENCHO_OPEN_STACK_EVENT, opened);
    expect(await update()).toEqual({ ok: false });
    const options = error.mock.calls[0][1];
    expect(error.mock.calls[0][0]).toBe('Update blocked by policy "No criticals"');
    options?.action?.onClick();
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ nodeId: 2, stackName: 'web', destination: 'editor' });
    window.removeEventListener(SENCHO_OPEN_STACK_EVENT, opened);
  });

  it('tells the operator when a failed update was rolled back and what to do next', async () => {
    const error = vi.spyOn(toast, 'error');
    vi.mocked(postStackUpdate).mockResolvedValue({
      kind: 'failed',
      error: Object.assign(new Error('compose up failed'), {
        rolledBack: true,
        failure: { reason: 'docker', label: 'Docker error', suggestion: 'Check the daemon.' },
      }),
    });
    expect(await update()).toEqual({ ok: false });
    expect(error).toHaveBeenCalledWith(
      'compose up failed The stack was rolled back to its previous version. Docker error. Check the daemon.',
    );
  });

  it('reports a busy stack and a protected self stack without retrying', async () => {
    const error = vi.spyOn(toast, 'error');
    vi.mocked(postStackUpdate).mockResolvedValueOnce({ kind: 'busy', message: 'web is already updating.' });
    expect(await update()).toEqual({ ok: false });
    expect(error).toHaveBeenCalledWith('web is already updating.');
    vi.mocked(postStackUpdate).mockResolvedValueOnce({ kind: 'self-stack' });
    expect(await update()).toEqual({ ok: false });
    expect(error.mock.calls[1][0]).toContain('running Sencho instance');
  });

  it('says so when the request never gets an answer', async () => {
    const error = vi.spyOn(toast, 'error');
    vi.mocked(postStackUpdate).mockRejectedValue(new Error('Failed to fetch'));
    expect(await update()).toEqual({ ok: false });
    expect(error).toHaveBeenCalledWith('Failed to fetch');
  });
});
