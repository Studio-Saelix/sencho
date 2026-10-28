import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { TriangleAlert } from 'lucide-react';

import { StatusPath, type StatusPathStage } from '../status-path';

const STAGES: StatusPathStage[] = [
  { id: 'source', label: 'source', tone: 'warning', word: 'review required' },
  { id: 'artifact', label: 'artifact', tone: 'success', word: 'exact' },
  { id: 'rollout', label: 'rollout', tone: 'warning', word: 'paused', line: 'The rollout is paused.' },
];

function renderPath(overrides: Partial<React.ComponentProps<typeof StatusPath>> = {}) {
  return render(
    <StatusPath
      answer={{ tone: 'warning', title: 'review required', line: 'A fetched commit is waiting.', icon: TriangleAlert }}
      stages={STAGES}
      {...overrides}
    />,
  );
}

describe('StatusPath', () => {
  it('states the answer once, with its tone and status', () => {
    renderPath({ answer: { tone: 'warning', title: 'review required', line: 'A fetched commit is waiting.', status: 'source_review_pending' } });
    const answer = screen.getByTestId('status-answer');
    expect(answer).toHaveAttribute('data-tone', 'warning');
    expect(answer).toHaveAttribute('data-state', 'source_review_pending');
    expect(answer).toHaveTextContent('A fetched commit is waiting.');
  });

  it('carries the resolving verb and the specifics inside the answer', () => {
    renderPath({
      answer: { tone: 'brand', title: 'pending update', line: 'A commit is ready.', detail: 'Commit a1b2c3d', action: <button type="button">Review</button> },
    });
    const answer = screen.getByTestId('status-answer');
    expect(within(answer).getByRole('button', { name: 'Review' })).toBeInTheDocument();
    expect(screen.getByTestId('status-answer-detail')).toHaveTextContent('Commit a1b2c3d');
  });

  it('qualifies an answer whose evidence is partial', () => {
    renderPath({ answer: { tone: 'warning', title: 'x', line: 'y', marker: 'evidence partial' } });
    expect(screen.getByTestId('status-marker')).toHaveTextContent('evidence partial');
  });

  it('lists the stages in order as a quiet row, each with its state', () => {
    renderPath();
    const items = within(screen.getByTestId('status-path')).getAllByRole('listitem');
    expect(items.map(li => li.getAttribute('data-testid'))).toEqual(['status-stage-source', 'status-stage-artifact', 'status-stage-rollout']);
    expect(items[0]).toHaveTextContent('review required');
  });

  it('speaks only for the stages the caller gave a line, and says nothing for the rest', () => {
    renderPath();
    expect(screen.getByTestId('status-stage-line-rollout')).toHaveTextContent('The rollout is paused.');
    expect(screen.queryByTestId('status-stage-line-source')).toBeNull();
    expect(screen.queryByTestId('status-stage-line-artifact')).toBeNull();
  });

  it('renders no path row when no stage applies', () => {
    renderPath({ stages: [] });
    expect(screen.queryByTestId('status-path')).toBeNull();
  });

  it('keeps the proof closed until it is opened, and reachable by keyboard', () => {
    renderPath({ proof: { label: 'Evidence', children: <p>the evidence</p> } });
    const toggle = screen.getByRole('button', { name: 'Evidence' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('the evidence')).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('the evidence')).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.queryByText('the evidence')).toBeNull();
  });

  it('has no proof control when there is no proof', () => {
    renderPath();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows exactly one toned block', () => {
    renderPath({ proof: { label: 'Evidence', children: <p>x</p> } });
    expect(document.querySelectorAll('[data-tone]').length).toBe(1 + STAGES.length);
    expect(document.querySelectorAll('[data-testid="status-answer"]')).toHaveLength(1);
  });
});
