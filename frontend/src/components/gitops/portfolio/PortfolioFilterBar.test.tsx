/**
 * The portfolio filter row: one Filters popover with a count of what is in use.
 * Stack and Blueprint scopes show as chips, and filters only a deep link can set
 * (source, rollout, health) narrow the list without being counted.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { PortfolioFilterBar } from './PortfolioFilterBar';
import type { GitOpsPortfolioFilters } from '@/types/gitopsPortfolio';

function renderBar(filters: GitOpsPortfolioFilters = {}) {
  const onChange = vi.fn();
  const onClear = vi.fn();
  render(
    <PortfolioFilterBar
      filters={filters}
      nodes={[{ id: 1, name: 'Local' }]}
      onChange={onChange}
      onQueryChange={vi.fn()}
      onClear={onClear}
    />,
  );
  return { onChange, onClear };
}

const trigger = () => screen.getByRole('button', { name: /^Filters/ });

describe('PortfolioFilterBar', () => {
  it('shows no count and no clear action when nothing is filtered', () => {
    renderBar();
    expect(trigger()).toHaveTextContent(/^Filters$/);
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
  });

  it('counts the filters that live in the popover', () => {
    renderBar({ attention: '1', mode: 'direct', evidence: 'stale' });
    expect(trigger()).toHaveTextContent('3');
  });

  it('offers to clear, without counting, a filter only a deep link can set', () => {
    renderBar({ source: 'failed' });
    expect(trigger()).toHaveTextContent(/^Filters$/);
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument();
  });

  it('does not count a stack scope, which shows as its own chip', () => {
    renderBar({ stack: 'web' });
    expect(trigger()).toHaveTextContent(/^Filters$/);
    expect(screen.getByRole('button', { name: 'Remove stack filter' })).toBeInTheDocument();
  });

  it('sets a choice from its labelled group and drops the key on "All"', () => {
    const { onChange } = renderBar({ attention: '1' });
    fireEvent.click(trigger());

    const attention = screen.getByRole('group', { name: 'Attention' });
    expect(within(attention).getByRole('button', { name: 'Attention required' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(attention).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(within(attention).getByRole('button', { name: 'All' }));
    expect(onChange).toHaveBeenLastCalledWith({});

    fireEvent.click(within(screen.getByRole('group', { name: 'Target' })).getByRole('button', { name: 'Blueprint' }));
    expect(onChange).toHaveBeenLastCalledWith({ attention: '1', mode: 'blueprint' });
  });

  it('clears every filter through the shared handler', () => {
    const { onClear } = renderBar({ attention: '1' });
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
