import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StackHealthTable } from '../StackHealthTable';
import type { StackStatusEntry } from '../types';
import type { StackUpdateInfo } from '@/types/imageUpdates';

const stackStatuses: Record<string, StackStatusEntry> = {
  'app.yml': { status: 'running', source: 'local' },
};

function renderTable(stackUpdates: Record<string, StackUpdateInfo>) {
  return render(
    <StackHealthTable
      stackStatuses={stackStatuses}
      stackStatusesLoadStatus="success"
      stackStatusesLoadError={null}
      metrics={[]}
      stackCpuSeries={{}}
      onNavigateToStack={vi.fn()}
      stackUpdates={stackUpdates}
    />,
  );
}

describe('StackHealthTable update-available icon', () => {
  it('shows the icon with an accessible name naming the outdated service', () => {
    renderTable({
      'app.yml': { hasUpdate: true, checkStatus: 'ok', lastError: null, checkedAt: 0, services: [{ service: 'api', image: null, hasUpdate: true, checkStatus: 'ok', lastError: null }] },
    });
    const icon = screen.getByTitle('Update available: api').querySelector('svg');
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute('aria-label', 'Update available: api');
  });

  it('renders no icon when no update is available', () => {
    renderTable({
      'app.yml': { hasUpdate: false, checkStatus: 'ok', lastError: null, checkedAt: 0 },
    });
    expect(screen.queryByTitle(/Update available/i)).toBeNull();
  });
});
