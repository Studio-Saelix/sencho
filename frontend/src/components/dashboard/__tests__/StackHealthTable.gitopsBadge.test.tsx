import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StackHealthTable } from '../StackHealthTable';
import type { GitOpsSourceStateMap } from '../useGitOpsSourceStates';
import type { StackStatusEntry } from '../types';

const stackStatuses: Record<string, StackStatusEntry> = {
  'app.yml': { status: 'running', source: 'git' },
  'plain.yml': { status: 'running', source: 'local' },
};

function renderTable(gitopsSourceStates?: GitOpsSourceStateMap) {
  return render(
    <StackHealthTable
      stackStatuses={stackStatuses}
      stackStatusesLoadStatus="success"
      stackStatusesLoadError={null}
      metrics={[]}
      stackCpuSeries={{}}
      onNavigateToStack={vi.fn()}
      gitopsSourceStates={gitopsSourceStates}
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
    // The label is the short name; the title carries the whole sentence, so
    // the state survives a reader who cannot see the tone.
    expect(badge).toHaveTextContent('pending update blocked');
    expect(badge).toHaveAttribute(
      'title',
      'The change plan has local conflicts. Apply stays disabled until they are resolved.',
    );
  });

  it('renders no badge when the join is empty', () => {
    renderTable({});
    expect(screen.queryByTestId('gitops-badge')).toBeNull();
  });

  it('renders no badge when the caller passes nothing at all', () => {
    // The prop is optional so an older caller, or one on a surface with no
    // GitOps join, keeps rendering exactly as before.
    renderTable(undefined);
    expect(screen.queryByTestId('gitops-badge')).toBeNull();
  });

  it('keeps the source column reading Git or Local either way', () => {
    // The badge says what GitOps thinks; the column still says where the files
    // come from. Replacing one with the other would lose a fact.
    renderTable({ app: 'candidate_ready' });
    expect(screen.getByText('Git')).toBeInTheDocument();
    expect(screen.getByText('Local')).toBeInTheDocument();
  });
});
