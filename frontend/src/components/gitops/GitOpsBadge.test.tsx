import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PLACEMENT_STATE, ROLLOUT_STATE, RUNTIME_STATE } from '@/lib/gitopsState';
import GitOpsBadge from './GitOpsBadge';

describe('GitOpsBadge', () => {
  it('renders a placement status from the placement vocabulary', () => {
    render(<GitOpsBadge facet="placement" status="placement_review_pending" />);
    const badge = screen.getByTestId('gitops-badge');
    expect(badge).toHaveAttribute('data-state', 'placement_review_pending');
    expect(badge).toHaveTextContent(PLACEMENT_STATE.placement_review_pending.label);
    expect(badge).toHaveAttribute('title', PLACEMENT_STATE.placement_review_pending.line);
  });

  it('renders a rollout status from the rollout vocabulary', () => {
    render(<GitOpsBadge facet="rollout" status="canary_in_progress" />);
    const badge = screen.getByTestId('gitops-badge');
    expect(badge).toHaveTextContent(ROLLOUT_STATE.canary_in_progress.label);
    expect(badge).toHaveAttribute('data-tone', ROLLOUT_STATE.canary_in_progress.tone);
  });

  // The rollout and runtime vocabularies share status names with different
  // meanings; the facet, not the name, decides which copy renders.
  it.each(['recovery_required', 'partially_rolled_out', 'completion_unknown'] as const)(
    'reads %s through the facet it was paired with',
    (status) => {
      const { unmount } = render(<GitOpsBadge facet="rollout" status={status} />);
      expect(screen.getByTestId('gitops-badge')).toHaveAttribute('title', ROLLOUT_STATE[status].line);
      unmount();
      render(<GitOpsBadge facet="runtime" status={status} />);
      expect(screen.getByTestId('gitops-badge')).toHaveAttribute('title', RUNTIME_STATE[status].line);
      expect(ROLLOUT_STATE[status].line).not.toBe(RUNTIME_STATE[status].line);
    },
  );

  it('renders nothing for a status this build does not know', () => {
    const status = 'from_a_newer_node' as unknown as 'rollout_queued';
    render(<GitOpsBadge facet="rollout" status={status} />);
    expect(screen.queryByTestId('gitops-badge')).toBeNull();
  });
});
