import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StackHealthTable } from '../StackHealthTable';
import { rowsFromStatuses, tableProps } from './stackHealthTableTestUtils';

describe('StackHealthTable load states', () => {
  it('does not show empty copy while loading', () => {
    render(
      <StackHealthTable
        {...tableProps({ view: 'loading', rows: [] })}
      />,
    );
    expect(screen.queryByText(/No stacks found/i)).toBeNull();
  });

  it('shows empty copy only after success', () => {
    render(
      <StackHealthTable
        {...tableProps({ view: 'empty', coverage: { k: 1, m: 1, n: 0 } })}
      />,
    );
    expect(screen.getByText(/No stacks found/i)).toBeInTheDocument();
  });

  it('shows retry on unavailable, not empty copy', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    render(
      <StackHealthTable
        {...tableProps({
          view: 'unavailable',
          viewError: 'Could not load stack health.',
          onRetry,
        })}
      />,
    );
    expect(screen.queryByText(/No stacks found/i)).toBeNull();
    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders a State column and networks compact form', () => {
    render(
      <StackHealthTable
        {...tableProps({
          rows: rowsFromStatuses({
            'web.yml': { status: 'partial', networks: ['arr_default', 'bridge'] },
          }),
          coverage: { k: 1, m: 1, n: 1 },
        })}
      />,
    );
    expect(screen.getByText('STATE')).toBeInTheDocument();
    expect(screen.getByText('partial')).toBeInTheDocument();
    expect(screen.getByText('arr_default')).toBeInTheDocument();
    expect(screen.getByText(/\+1/)).toBeInTheDocument();
  });
});
