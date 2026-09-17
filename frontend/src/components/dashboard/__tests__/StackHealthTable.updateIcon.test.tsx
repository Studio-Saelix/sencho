import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StackHealthTable } from '../StackHealthTable';
import type { StackStatusEntry } from '../types';
import type { StackUpdateInfo } from '@/types/imageUpdates';
import { rowsFromStatuses, tableProps } from './stackHealthTableTestUtils';

const stackStatuses: Record<string, StackStatusEntry> = {
  'app.yml': { status: 'running', source: 'local' },
};

function renderTable(stackUpdates: Record<string, StackUpdateInfo>) {
  const rows = rowsFromStatuses(stackStatuses, {}, stackUpdates);
  return render(
    <StackHealthTable
      {...tableProps({
        rows,
        coverage: { k: 1, m: 1, n: rows.length },
      })}
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
