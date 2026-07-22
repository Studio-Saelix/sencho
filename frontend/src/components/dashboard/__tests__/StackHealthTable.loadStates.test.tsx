import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StackHealthTable } from '../StackHealthTable';

describe('StackHealthTable load states', () => {
  it('does not show empty copy while loading', () => {
    render(
      <StackHealthTable
        stackStatuses={{}}
        stackStatusesLoadStatus="loading"
        stackStatusesLoadError={null}
        metrics={[]}
        stackCpuSeries={{}}
        onNavigateToStack={vi.fn()}
      />,
    );
    expect(screen.queryByText(/No stacks found/i)).toBeNull();
  });

  it('shows empty copy only after success', () => {
    render(
      <StackHealthTable
        stackStatuses={{}}
        stackStatusesLoadStatus="success"
        stackStatusesLoadError={null}
        metrics={[]}
        stackCpuSeries={{}}
        onNavigateToStack={vi.fn()}
      />,
    );
    expect(screen.getByText(/No stacks found/i)).toBeInTheDocument();
  });

  it('shows retry on error', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    render(
      <StackHealthTable
        stackStatuses={{}}
        stackStatusesLoadStatus="error"
        stackStatusesLoadError="Could not load stack health."
        onRetryStackStatuses={onRetry}
        metrics={[]}
        stackCpuSeries={{}}
        onNavigateToStack={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
