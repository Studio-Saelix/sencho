/**
 * The one control for "who decides this".
 *
 * Three surfaces mount it and it is the only implementation of these values, so
 * what is pinned here is that the write goes to the domain's own endpoint, that a
 * session without the grant is not offered it at all, and that a value this build
 * does not recognize is named rather than silently replaced.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import GitOpsPolicyControl from './GitOpsPolicyControl';
import {
  setGitOpsPlacementPolicy,
  setGitOpsRolloutAuthorizationPolicy,
} from '@/lib/gitopsAuthorityApi';
import { toast } from '@/components/ui/toast-store';
import type { AuthorityPolicyRead } from '@/types/gitops';

vi.mock('@/lib/gitopsAuthorityApi', () => ({
  setGitOpsPlacementPolicy: vi.fn(),
  setGitOpsRolloutAuthorizationPolicy: vi.fn(),
}));

vi.mock('@/components/ui/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function read(overrides: Partial<AuthorityPolicyRead> = {}): AuthorityPolicyRead {
  return {
    domain: 'placement',
    configured: 'operator',
    effectiveFrozen: null,
    decision: 'awaiting_operator',
    reason: null,
    decidedBy: null,
    decidedAt: null,
    ...overrides,
  };
}

function renderControl(options: {
  domain?: 'placement' | 'rollout_authorization';
  read?: AuthorityPolicyRead;
  canWrite?: boolean;
  onChanged?: () => void;
} = {}) {
  const domain = options.domain ?? 'placement';
  return render(
    <GitOpsPolicyControl
      applicationId="bp:5"
      domain={domain}
      read={options.read ?? read({ domain })}
      onChanged={options.onChanged ?? (() => {})}
      canWrite={options.canWrite ?? true}
      trigger={(open) => (
        <button type="button" onClick={open} data-testid="trigger">Set policy</button>
      )}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(setGitOpsPlacementPolicy).mockResolvedValue(undefined);
  vi.mocked(setGitOpsRolloutAuthorizationPolicy).mockResolvedValue(undefined);
});

describe('GitOpsPolicyControl', () => {
  it('opens on the configured value rather than the last one selected', async () => {
    // A write that landed elsewhere, or a refresh from another surface, must be
    // reflected instead of silently overwritten by a stale selection.
    const user = userEvent.setup();
    renderControl({ read: read({ configured: 'bounded_auto' }) });
    await user.click(screen.getByTestId('trigger'));
    expect(screen.getByRole('radio', { name: 'Bounded auto' })).toHaveAttribute('aria-checked', 'true');
  });

  it('writes the placement policy to the placement endpoint', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    renderControl({ onChanged });
    await user.click(screen.getByTestId('trigger'));
    await user.click(screen.getByRole('radio', { name: 'Bounded auto' }));
    await user.click(screen.getByTestId('gitops-policy-confirm'));
    expect(setGitOpsPlacementPolicy).toHaveBeenCalledWith('bp:5', 'bounded_auto');
    expect(onChanged).toHaveBeenCalled();
  });

  it('writes the rollout authorization policy to its own endpoint', async () => {
    // The one control, two domains, two endpoints. If both writes went to the
    // same place the two policies would be indistinguishable and one of them
    // would be set on the other.
    const user = userEvent.setup();
    renderControl({
      domain: 'rollout_authorization',
      read: read({ domain: 'rollout_authorization', configured: 'manual' }),
    });
    await user.click(screen.getByTestId('trigger'));
    await user.click(screen.getByRole('radio', { name: 'Automatic' }));
    await user.click(screen.getByTestId('gitops-policy-confirm'));
    expect(setGitOpsRolloutAuthorizationPolicy).toHaveBeenCalledWith('bp:5', 'automatic');
    expect(setGitOpsPlacementPolicy).not.toHaveBeenCalled();
  });

  it('renders nothing at all for a session that may not write', () => {
    // Absent rather than disabled: a disabled control still invites the click,
    // and the refusal arrives as an error the operator did not cause.
    renderControl({ canWrite: false });
    expect(screen.queryByTestId('trigger')).toBeNull();
  });

  it('names a value this build does not recognize instead of snapping to one', async () => {
    // Silently selecting a segment would overwrite whatever the server is
    // enforcing, on a click the operator did not mean as a replacement.
    const user = userEvent.setup();
    renderControl({ read: read({ configured: 'adaptive' }) });
    await user.click(screen.getByTestId('trigger'));
    expect(screen.getByText(/does not recognize "adaptive"/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Operator' })).toHaveAttribute('aria-checked', 'false');
  });

  it('reports a refusal and keeps the dialog open', async () => {
    // The decision did not land, so the dialog must not close and imply it did.
    const user = userEvent.setup();
    vi.mocked(setGitOpsPlacementPolicy).mockRejectedValue(new Error('Permission denied for this application.'));
    renderControl();
    await user.click(screen.getByTestId('trigger'));
    await user.click(screen.getByRole('radio', { name: 'Bounded auto' }));
    await user.click(screen.getByTestId('gitops-policy-confirm'));
    expect(toast.error).toHaveBeenCalledWith('Permission denied for this application.');
    expect(screen.getByTestId('gitops-policy-confirm')).toBeInTheDocument();
  });

  it('does not write when the chosen value is the one already configured', async () => {
    // A save that changes nothing would still be a write, and would still consume
    // the operator's intent on a dialog they opened to look.
    const user = userEvent.setup();
    renderControl();
    await user.click(screen.getByTestId('trigger'));
    await user.click(screen.getByRole('radio', { name: 'Operator' }));
    expect(screen.getByTestId('gitops-policy-confirm')).toBeDisabled();
    expect(setGitOpsPlacementPolicy).not.toHaveBeenCalled();
  });
});
