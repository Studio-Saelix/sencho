import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { RollbackReadinessSection } from '../RollbackReadinessSection';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));

const nodesState = {
  activeNode: { id: 1, type: 'local', name: 'local' },
  hasCapability: vi.fn().mockReturnValue(true),
};
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => nodesState,
}));

import { apiFetch } from '@/lib/api';

type Overall = 'ready' | 'partial' | 'not_ready';

const report = (overall: Overall) => ({
  stack: 'web',
  computedAt: Date.now(),
  overall,
  items: [
    { id: 'compose_source', state: 'ready', label: 'Previous compose file', detail: 'A backup is available to restore.' },
    { id: 'volume_data', state: 'not_covered', label: 'Application data', detail: 'Named volumes and bind-mounted data are not included in file backups.' },
  ],
});

describe('RollbackReadinessSection', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    nodesState.hasCapability.mockReturnValue(true);
  });

  it.each(['ready', 'partial', 'not_ready'] as const)('renders the %s overall chip', async (overall) => {
    vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify(report(overall)), { status: 200 }));
    render(<RollbackReadinessSection stackName="web" />);
    await waitFor(() => expect(screen.getByTestId('rollback-overall')).toHaveAttribute('data-overall', overall));
  });

  it('always shows the application-data non-coverage disclosure', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify(report('ready')), { status: 200 }));
    render(<RollbackReadinessSection stackName="web" />);
    await waitFor(() => expect(screen.getByText('Application data')).toBeInTheDocument());
    expect(screen.getByText(/not included in file backups/)).toBeInTheDocument();
  });

  it('renders nothing without the update-guard capability and never fetches', () => {
    nodesState.hasCapability.mockReturnValue(false);
    const { container } = render(<RollbackReadinessSection stackName="web" />);
    expect(container).toBeEmptyDOMElement();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('renders nothing when the fetch fails', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('down'));
    const { container } = render(<RollbackReadinessSection stackName="web" />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
