import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { PruneItemRows } from './PruneItemRows';
import { pruneItemKey, type PruneItemOutcome, type PrunePlanItem } from '@/lib/prunePlan';

const image: PrunePlanItem = {
  target: 'images', id: 'sha256:abcdef0123456789', name: 'app:1', managed: true, stackName: 'web', reason: 'unused',
  sizeBytes: 2048, image: { references: ['app:1', 'registry/app:1'], digest: 'registry/app@sha256:dd' },
};
const volume: PrunePlanItem = {
  target: 'volumes', id: 'data', name: 'data', managed: false, reason: 'dangling', volume: { driver: 'local' },
};

describe('PruneItemRows', () => {
  it('renders one flat line per item in summary mode, with the other references', () => {
    render(<PruneItemRows items={[image, volume]} detail="summary" />);
    const rows = within(screen.getByTestId('prune-item-rows')).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('images · app:1 · 2 KB');
    expect(screen.getByText('registry/app:1')).toBeInTheDocument();
    // Summary carries no ownership, id or reason.
    expect(screen.queryByText('managed')).not.toBeInTheDocument();
    expect(screen.queryByText('unused')).not.toBeInTheDocument();
  });

  it('adds ownership, short id, stack, metadata and reason in full mode, with no card per item', () => {
    render(<PruneItemRows items={[image, volume]} />);
    expect(screen.getByText('managed')).toBeInTheDocument();
    expect(screen.getByText('unmanaged')).toBeInTheDocument();
    expect(screen.getByText('abcdef012345 · stack web')).toBeInTheDocument();
    expect(screen.getByText('registry/app@sha256:dd')).toBeInTheDocument();
    expect(screen.getByText('driver local')).toBeInTheDocument();
    expect(screen.getByText('unused')).toBeInTheDocument();
    expect(screen.getByText('size unavailable')).toBeInTheDocument();
    for (const row of screen.getAllByRole('listitem')) {
      expect(row.className).not.toMatch(/\brounded\b|bg-card|border-card-border/);
    }
  });

  it('shows an outcome word and its reason instead of the plan reason', () => {
    const outcomes = new Map<string, PruneItemOutcome>([
      [pruneItemKey('images', image.id), { target: 'images', id: image.id, status: 'skipped', reason: 'Became active' }],
      [pruneItemKey('volumes', volume.id), { target: 'volumes', id: volume.id, status: 'failed', error: 'Docker refused removal' }],
    ]);
    render(<PruneItemRows items={[image, volume]} outcomes={outcomes} />);
    expect(screen.getByText('skipped')).toHaveClass('text-warning');
    expect(screen.getByText('failed')).toHaveClass('text-destructive');
    expect(screen.getByText('Became active')).toBeInTheDocument();
    expect(screen.getByText('Docker refused removal')).toBeInTheDocument();
    expect(screen.queryByText('unused')).not.toBeInTheDocument();
  });
});
