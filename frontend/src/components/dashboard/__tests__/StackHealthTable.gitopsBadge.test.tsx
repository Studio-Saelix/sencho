import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
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
});
