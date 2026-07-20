import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import FleetSnapshots from '../FleetSnapshots';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
import { apiFetch } from '@/lib/api';

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { role: 'admin' }, isAdmin: true }),
}));
vi.mock('@/context/LicenseContext', () => ({
  useLicense: () => ({ isPaid: true }),
}));
vi.mock('@/components/ui/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

const mockedFetch = vi.mocked(apiFetch);

describe('FleetSnapshots unavailable files', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    mockedFetch.mockImplementation(async (path: string) => {
      if (path === '/fleet/snapshots') {
        return {
          ok: true,
          json: async () => ({
            snapshots: [{
              id: 7,
              description: 'fleet-snap-test',
              created_by: 'admin',
              node_count: 1,
              stack_count: 2,
              skipped_nodes: '[]',
              skipped_stacks: '[]',
              created_at: Date.now(),
              has_documentation: 0,
            }],
            total: 1,
          }),
        } as Response;
      }
      if (path === '/fleet/snapshots/7') {
        return {
          ok: true,
          json: async () => ({
            id: 7,
            description: 'fleet-snap-test',
            created_by: 'admin',
            node_count: 1,
            stack_count: 2,
            skipped_nodes: '[]',
            skipped_stacks: '[]',
            created_at: Date.now(),
            fileDecryptWarnings: [
              { nodeId: 1, nodeName: 'local', stackName: 'bad', filename: 'compose.yaml' },
            ],
            nodes: [{
              nodeId: 1,
              nodeName: 'local',
              stacks: [
                {
                  stackName: 'good',
                  files: [{ filename: '.env', content: '' }],
                },
                {
                  stackName: 'bad',
                  files: [{ filename: 'compose.yaml', unavailable: true }],
                },
              ],
            }],
          }),
        } as Response;
      }
      if (path === '/cloud-backup/config') {
        return { ok: true, json: async () => ({ provider: 'disabled' }) } as Response;
      }
      if (path === '/cloud-backup/snapshots') {
        return { ok: true, json: async () => [] } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });
  });

  it('shows a decrypt warning and disables restore only for unavailable stacks', async () => {
    render(<FleetSnapshots />);

    await waitFor(() => expect(screen.getByText('fleet-snap-test')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /View/i }));

    await waitFor(() =>
      expect(screen.getByText(/Some snapshot files could not be decrypted/i)).toBeInTheDocument(),
    );
    expect(screen.getByText('compose.yaml')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /local/i }));
    await waitFor(() => expect(screen.getByText('good')).toBeInTheDocument());

    const restoreButtons = screen.getAllByRole('button', { name: /^Restore$/i });
    expect(restoreButtons).toHaveLength(2);
    expect((restoreButtons[0] as HTMLButtonElement).disabled).toBe(false);
    expect((restoreButtons[1] as HTMLButtonElement).disabled).toBe(true);

    const stackButtons = screen.getAllByRole('button').filter(btn =>
      btn.textContent?.includes('good') && btn.textContent?.includes('file'),
    );
    fireEvent.click(stackButtons[0]);
    await waitFor(() => expect(screen.getByText('Preview')).toBeInTheDocument());
    expect(screen.getByText('Download')).toBeInTheDocument();

    const badStackButtons = screen.getAllByRole('button').filter(btn =>
      btn.textContent?.includes('bad') && btn.textContent?.includes('file'),
    );
    fireEvent.click(badStackButtons[0]);
    await waitFor(() => expect(screen.getByText('Unavailable')).toBeInTheDocument());
  });
});
