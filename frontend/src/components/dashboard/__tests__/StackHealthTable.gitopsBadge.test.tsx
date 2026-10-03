import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { StackHealthTable } from '../StackHealthTable';
import type { GitOpsSourceStateMap } from '../useGitOpsSourceStates';
import type { StackStatusEntry } from '../types';
import type { GitOpsSourceStatus } from '@/types/gitops';
import { rowsFromStatuses, tableProps } from './stackHealthTableTestUtils';

const stackStatuses: Record<string, StackStatusEntry> = {
  'app.yml': { status: 'running', source: 'git' },
  'plain.yml': { status: 'running', source: 'local' },
};

function renderTable(gitopsSourceStates?: GitOpsSourceStateMap) {
  const rows = rowsFromStatuses(stackStatuses, gitopsSourceStates ?? {});
  return render(
    <StackHealthTable
      {...tableProps({
        rows,
        coverage: { k: 1, m: 1, n: rows.length },
      })}
    />,
  );
}

describe('StackHealthTable GitOps badge', () => {
  it('badges only the stacks the model has state for', () => {
    renderTable({ app: 'candidate_ready' });

    const badges = screen.getAllByTestId('gitops-badge');
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveAttribute('data-state', 'candidate_ready');
  });

  it('states the condition in words, not only in colour', () => {
    renderTable({ app: 'source_conflict_blocker' });

    const badge = screen.getByTestId('gitops-badge');
    const visible = badge.querySelector(':scope > span:not(.sr-only)');
    expect(visible?.textContent).toBe('pending update blocked');
    expect(badge).toHaveAttribute(
      'title',
      'The change plan has local conflicts. Apply stays disabled until they are resolved.',
    );
  });

  it('renders nothing for a status this build does not know', () => {
    renderTable({ app: 'a_status_from_a_newer_build' as GitOpsSourceStatus });
    expect(screen.queryByTestId('gitops-badge')).toBeNull();
    expect(screen.getByText('app')).toBeInTheDocument();
  });

  it('renders no badge when the join is empty', () => {
    renderTable({});
    expect(screen.queryByTestId('gitops-badge')).toBeNull();
  });

  it('renders no badge when the caller passes nothing at all', () => {
    renderTable(undefined);
    expect(screen.queryByTestId('gitops-badge')).toBeNull();
  });

  it('keeps the source column reading Git or Local either way', () => {
    renderTable({ app: 'candidate_ready' });
    expect(screen.getByText('Git')).toBeInTheDocument();
    expect(screen.getByText('Local')).toBeInTheDocument();
  });

  describe('its own column', () => {
    /** The cells of one stack's row, in column order. */
    function cellsOf(stack: string): HTMLElement[] {
      const row = screen.getByText(stack).closest('li');
      if (!row) throw new Error(`no row for ${stack}`);
      return Array.from(row.children) as HTMLElement[];
    }
    const headers = () => Array.from(screen.getByText('STACK').closest('div')!.children).map(el => el.textContent);

    it('puts the GitOps state in a GITOPS column after SOURCE, not beside the stack name', () => {
      renderTable({ app: 'candidate_ready' });

      const columns = headers();
      const gitops = columns.indexOf('GITOPS');
      expect(gitops).toBe(columns.indexOf('SOURCE') + 1);
      const cells = cellsOf('app');
      expect(within(cells[gitops]!).getByTestId('gitops-badge')).toHaveAttribute('data-state', 'candidate_ready');
      expect(within(cells[0]!).queryByTestId('gitops-badge')).toBeNull();
    });

    it('keeps only the name button in the name cell', () => {
      renderTable({ app: 'candidate_ready' });
      // The only button left in the name cell is the name itself.
      expect(within(cellsOf('app')[0]!).getAllByRole('button')).toHaveLength(1);
    });

    it('reads -- instead of an empty button for a state this build cannot name, beside a known one', () => {
      renderTable({ app: 'candidate_ready', plain: 'a_status_from_a_newer_build' as GitOpsSourceStatus });

      const cell = cellsOf('plain')[headers().indexOf('GITOPS')]!;
      expect(cell).toHaveTextContent('--');
      expect(within(cell).queryByRole('button')).toBeNull();
    });

    it('reads -- for a stack the model has no state for, so the column never looks broken', () => {
      renderTable({ app: 'candidate_ready' });
      const gitops = headers().indexOf('GITOPS');
      expect(cellsOf('plain')[gitops]).toHaveTextContent('--');
    });

    it.each([
      ['no stack has GitOps state', {}],
      ['the only state is one this build does not know', { app: 'a_status_from_a_newer_build' as GitOpsSourceStatus }],
    ] as const)('hides the column entirely when %s', (_name, states) => {
      renderTable(states);

      expect(headers()).not.toContain('GITOPS');
      // No empty cell either: every row has exactly one cell per remaining header.
      expect(cellsOf('app')).toHaveLength(headers().length);
      expect(cellsOf('plain')).toHaveLength(headers().length);
    });

    it('shows the column as soon as one stack has state, even when it is not among the visible rows', () => {
      const many: Record<string, StackStatusEntry> = {};
      for (let i = 0; i < 12; i += 1) many[`stack-${String(i).padStart(2, '0')}.yml`] = { status: 'running', source: 'local' };
      const rows = rowsFromStatuses(many, { 'stack-11': 'candidate_ready' });
      render(<StackHealthTable {...tableProps({ rows, coverage: { k: 1, m: 1, n: rows.length } })} />);

      // The only stack with a state is collapsed behind "Show all", yet the column is there.
      expect(screen.queryByText('stack-11')).toBeNull();
      expect(headers()).toContain('GITOPS');
    });

    it('adds the GITOPS column after SOURCE in All nodes too, one cell per header', () => {
      const rows = rowsFromStatuses(stackStatuses, { app: 'candidate_ready' });
      render(<StackHealthTable {...tableProps({ rows, scope: 'all-nodes', coverage: { k: 1, m: 1, n: rows.length } })} />);

      const columns = headers();
      expect(columns).toContain('NODE');
      expect(columns.indexOf('GITOPS')).toBe(columns.indexOf('SOURCE') + 1);
      expect(cellsOf('app')).toHaveLength(columns.length);
      expect(cellsOf('plain')).toHaveLength(columns.length);
    });

    it.each([
      ['This node', 'this-node', 1162],
      ['All nodes', 'all-nodes', 1266],
    ] as const)('keeps a readable stack name in the %s minimum width', (_name, scope, expected) => {
      const rows = rowsFromStatuses(stackStatuses, { app: 'candidate_ready' });
      render(<StackHealthTable {...tableProps({ rows, scope, coverage: { k: 1, m: 1, n: rows.length } })} />);

      const header = screen.getByText('STACK').closest('div');
      if (!header) throw new Error('no stack health header');
      const minWidth = Number(/(?:^|\s)min-w-\[(\d+)px\]/.exec(header.className)?.[1]);
      const tracks = /grid-cols-\[([^\]]+)\]/.exec(header.className)?.[1].split('_') ?? [];
      const fixedPx = tracks.filter(t => t.endsWith('px')).reduce((sum, t) => sum + Number.parseFloat(t), 0);

      // The floor covers the fixed tracks, the gaps and the grid's own horizontal
      // padding (40px at comfortable density, folded into min-width by border-box)
      // before the stack-name track gets its share. Leaving out the padding once
      // crushed the name to 2px at 1280 wide.
      expect(minWidth).toBe(expected);
      expect(minWidth - fixedPx - (tracks.length - 1) * 16 - 40).toBeGreaterThanOrEqual(140);
      const row = screen.getByText('app').closest('li');
      if (!row) throw new Error('no row for app');
      expect(row.className).toContain(`min-w-[${expected}px]`);
    });

    it('sends the badge to the portfolio for that stack and node, without opening the stack', () => {
      const open = vi.fn();
      const seen: Array<{ view?: string }> = [];
      const onNavigate = (e: Event) => seen.push((e as CustomEvent<{ view?: string }>).detail);
      window.addEventListener('sencho-navigate', onNavigate);
      const rows = rowsFromStatuses(stackStatuses, { app: 'candidate_ready' });
      render(<StackHealthTable {...tableProps({ rows, coverage: { k: 1, m: 1, n: rows.length }, onNavigateToStack: open })} />);

      fireEvent.click(screen.getByRole('button', { name: 'Open this stack in the GitOps portfolio' }));

      expect(seen).toEqual([{ view: 'gitops' }]);
      expect(open).not.toHaveBeenCalled();
      window.removeEventListener('sencho-navigate', onNavigate);
    });

    it('still opens the stack from a click on the row itself', () => {
      const open = vi.fn();
      const rows = rowsFromStatuses(stackStatuses, { app: 'candidate_ready' });
      render(<StackHealthTable {...tableProps({ rows, coverage: { k: 1, m: 1, n: rows.length }, onNavigateToStack: open })} />);

      fireEvent.click(cellsOf('app')[0]!);

      expect(open).toHaveBeenCalledTimes(1);
    });
  });
});
