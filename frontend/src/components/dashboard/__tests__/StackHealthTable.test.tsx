import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { classifyRow } from '../classifyRow';
import { StackHealthTable } from '../StackHealthTable';
import { LOCAL_NODE, rowsFromStatuses, tableProps } from './stackHealthTableTestUtils';
import type { StackStatusEntry } from '../types';

describe('classifyRow', () => {
  it('marks a partially-crashed stack as warn (degraded), not healthy', () => {
    expect(classifyRow('partial', 0)).toBe('warn');
  });

  it('marks an exited stack as error', () => {
    expect(classifyRow('exited', 0)).toBe('error');
  });

  it('marks a running stack with low CPU as healthy', () => {
    expect(classifyRow('running', 0)).toBe('healthy');
  });

  it('escalates a partial stack with critical CPU to error', () => {
    expect(classifyRow('partial', 95)).toBe('error');
  });
});

describe('StackHealthTable expansion and navigation', () => {
  it('collapses to eight rows and expands with Show all', async () => {
    const user = userEvent.setup();
    const statuses: Record<string, StackStatusEntry> = {};
    for (let i = 0; i < 9; i += 1) {
      statuses[`stack-${i}.yml`] = { status: 'running' };
    }
    const rows = rowsFromStatuses(statuses);
    render(
      <StackHealthTable
        {...tableProps({ rows, coverage: { k: 1, m: 1, n: 9 } })}
      />,
    );
    expect(screen.getAllByRole('button', { name: /^stack-/i })).toHaveLength(8);
    await user.click(screen.getByRole('button', { name: /Show all 9 stacks/i }));
    expect(screen.getAllByRole('button', { name: /^stack-/i })).toHaveLength(9);
    await user.click(screen.getByRole('button', { name: /Show less/i }));
    expect(screen.getAllByRole('button', { name: /^stack-/i })).toHaveLength(8);
  });

  it('navigates with node and file identity', async () => {
    const user = userEvent.setup();
    const onNavigateToStack = vi.fn();
    render(
      <StackHealthTable
        {...tableProps({
          rows: rowsFromStatuses({ 'web.yml': { status: 'running' } }),
          coverage: { k: 1, m: 1, n: 1 },
          onNavigateToStack,
        })}
      />,
    );
    await user.click(screen.getByText('web'));
    expect(onNavigateToStack).toHaveBeenCalledWith({ node: LOCAL_NODE, file: 'web.yml' });
  });

  it('renders -- for missing CPU and memory', () => {
    render(
      <StackHealthTable
        {...tableProps({
          rows: rowsFromStatuses({ 'web.yml': { status: 'running' } }),
          coverage: { k: 1, m: 1, n: 1 },
        })}
      />,
    );
    expect(screen.getAllByText('--').length).toBeGreaterThan(0);
  });
});
