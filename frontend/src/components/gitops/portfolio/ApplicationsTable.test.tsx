/**
 * The Rollout column reads each status through the rollout vocabulary, not
 * the runtime one: several names collide across the two facets with
 * different meaning, and the rest have no runtime entry at all.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { portfolioRow } from '../application/applicationFixtures';
import { ApplicationsTable } from './ApplicationsTable';
import { ROLLOUT_STATE, RUNTIME_STATE } from '@/lib/gitopsState';

function rolloutCell(rolloutStatus: string): HTMLElement {
  const row = portfolioRow({ rolloutStatus });
  render(
    <ApplicationsTable rows={[row]} nextCursor={null} onPrevPage={() => {}} onNextPage={() => {}} pageLoaded={1} portfolioEmpty={false} onDrillDown={() => {}} />,
  );
  const headers = screen.getAllByRole('columnheader');
  const index = headers.findIndex(h => h.textContent === 'Rollout');
  const cells = within(screen.getAllByRole('row')[1]).getAllByRole('cell');
  return cells[index];
}

describe('ApplicationsTable rollout column', () => {
  it('renders a colliding status with the rollout label and tone', () => {
    const cell = rolloutCell('recovery_required');
    const chip = within(cell).getByText(ROLLOUT_STATE.recovery_required.label);
    expect(ROLLOUT_STATE.recovery_required.label).not.toBe(RUNTIME_STATE.recovery_required.label);
    expect(chip).toHaveAttribute('title', ROLLOUT_STATE.recovery_required.line);
    expect(chip.className).toContain('text-warning');
    expect(chip.className).not.toContain('text-brand');
  });

  it('renders a rollout-only status with its label instead of raw text', () => {
    const cell = rolloutCell('canary_in_progress');
    const chip = within(cell).getByText('canary in progress');
    expect(chip).toHaveAttribute('title', ROLLOUT_STATE.canary_in_progress.line);
    expect(chip.className).toContain('text-brand');
  });
});

describe('ApplicationsTable target counts', () => {
  it('counts current Blueprint targets without tombstoned history', () => {
    const current = portfolioRow().targets[0];
    if (!current) throw new Error('expected target fixture');
    const row = portfolioRow({
      targetMode: 'blueprint',
      nodeId: null,
      blueprintId: 3,
      targets: [
        current,
        { ...current, nodeId: 2, tombstoned: true },
      ],
    });

    render(
      <ApplicationsTable rows={[row]} nextCursor={null} onPrevPage={() => {}} onNextPage={() => {}} pageLoaded={1} portfolioEmpty={false} onDrillDown={() => {}} />,
    );

    expect(screen.getByText('1 target')).toBeInTheDocument();
    expect(screen.queryByText('2 targets')).toBeNull();
  });
});

describe('ApplicationsTable row click', () => {
  function renderRow(onDrillDown: () => void) {
    render(
      <ApplicationsTable rows={[portfolioRow()]} nextCursor={null} onPrevPage={() => {}} onNextPage={() => {}} pageLoaded={1} portfolioEmpty={false} onDrillDown={onDrillDown} />,
    );
    return screen.getAllByRole('row')[1] as HTMLElement;
  }

  it('opens the application from any cell of the row, once', () => {
    const open = vi.fn();
    const row = renderRow(open);
    fireEvent.click(within(row).getAllByRole('cell')[3] as HTMLElement);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('opens it once from the name button, which bubbles to the row', () => {
    const open = vi.fn();
    renderRow(open);
    fireEvent.click(screen.getByRole('button', { name: 'bookstack' }));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('does not open the application when the actions menu is used', () => {
    const open = vi.fn();
    renderRow(open);
    const trigger = screen.getByRole('button', { name: 'Actions for bookstack' });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    expect(open).not.toHaveBeenCalled();
  });
});

describe('ApplicationsTable attention', () => {
  it('leaves attention to the queue and the row tint instead of repeating it in a column', () => {
    const row = portfolioRow({ attention: ['source_failed', 'drift'], posture: 'failed' });
    render(
      <ApplicationsTable rows={[row]} nextCursor={null} onPrevPage={() => {}} onNextPage={() => {}} pageLoaded={1} portfolioEmpty={false} onDrillDown={() => {}} />,
    );
    expect(screen.queryByRole('columnheader', { name: 'Attention' })).toBeNull();
    expect(screen.getAllByRole('row')[1]).toHaveClass('bg-destructive/[0.04]');
  });

  it('names the most urgent reason on the state dot, so a row past the queue cap is still explained', () => {
    const row = portfolioRow({ attention: ['source_review_pending', 'source_failed'], posture: 'failed' });
    render(
      <ApplicationsTable rows={[row]} nextCursor={null} onPrevPage={() => {}} onNextPage={() => {}} pageLoaded={1} portfolioEmpty={false} onDrillDown={() => {}} />,
    );
    expect(screen.getByRole('img', { name: 'source failed, 1 more' })).toHaveAttribute('title', 'source failed, 1 more');
  });

  it('leaves the dot decorative when nothing needs attention', () => {
    render(
      <ApplicationsTable rows={[portfolioRow()]} nextCursor={null} onPrevPage={() => {}} onNextPage={() => {}} pageLoaded={1} portfolioEmpty={false} onDrillDown={() => {}} />,
    );
    expect(screen.queryByRole('img')).toBeNull();
  });
});
