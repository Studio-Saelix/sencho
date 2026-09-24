/**
 * The Rollout column reads each status through the rollout vocabulary, not
 * the runtime one: several names collide across the two facets with
 * different meaning, and the rest have no runtime entry at all.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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
