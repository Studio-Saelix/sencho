import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import FleetSnapshots from '../FleetSnapshots';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';

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

describe('FleetSnapshots imported snapshot mapping', () => {
  let mapped = false;

  const detail = (mappedNow: boolean) => ({
    id: 7,
    description: 'from-the-old-instance',
    created_by: 'ada',
    node_count: 1,
    stack_count: 1,
    skipped_nodes: '[]',
    skipped_stacks: '[]',
    created_at: Date.now(),
    source_instance_id: 'old-instance',
    warnings_known: 1,
    requiresNodeMapping: true,
    nodes: [{
      nodeId: 1,
      nodeName: 'original-production',
      targetNodeId: mappedNow ? 1 : null,
      targetNodeName: mappedNow ? 'Local' : null,
      stacks: [{ stackName: 'web', files: [{ filename: 'compose.yaml', content: 'services: {}' }] }],
    }],
  });

  beforeEach(() => {
    mapped = false;
    mockedFetch.mockReset();
    mockedFetch.mockImplementation(async (path: string, options?: Parameters<typeof apiFetch>[1]) => {
      if (path === '/fleet/snapshots') {
        return { ok: true, json: async () => ({ snapshots: [{ ...detail(false), nodes: undefined }], total: 1 }) } as unknown as Response;
      }
      if (path === '/fleet/snapshots/7/node-mapping' && options?.method === 'PUT') {
        mapped = true;
        return { ok: true, json: async () => ({ mappings: [] }) } as unknown as Response;
      }
      if (path === '/fleet/snapshots/7') {
        return { ok: true, json: async () => detail(mapped) } as unknown as Response;
      }
      if (path === '/nodes') {
        return { ok: true, json: async () => [{ id: 1, name: 'Local' }] } as unknown as Response;
      }
      if (path === '/cloud-backup/config') {
        return { ok: true, json: async () => ({ provider: 'disabled' }) } as unknown as Response;
      }
      return { ok: true, json: async () => ({}) } as unknown as Response;
    });
  });

  it('blocks restore until the archived node is mapped, then shows the destination', async () => {
    render(<FleetSnapshots />);
    await waitFor(() => expect(screen.getByText('from-the-old-instance')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /View/i }));

    await waitFor(() => expect(screen.getByText(/came from another instance/i)).toBeInTheDocument());
    expect(screen.getAllByText('Not mapped').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: /original-production/i }));
    await waitFor(() => expect(screen.getByText('web')).toBeInTheDocument());
    const restore = screen.getByRole('button', { name: /^Restore$/i }) as HTMLButtonElement;
    expect(restore.disabled).toBe(true);
    expect(screen.getByRole('button', { name: /Restore all/i })).toBeDisabled();

    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(screen.getByRole('button', { name: 'Local' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save mapping' }));

    await waitFor(() => expect(mockedFetch).toHaveBeenCalledWith(
      '/fleet/snapshots/7/node-mapping',
      expect.objectContaining({ method: 'PUT', localOnly: true }),
    ));
    await waitFor(() => expect(screen.getByText('-> Local')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Restore all/i })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /original-production/i }));
    await waitFor(() => {
      const after = screen.getByRole('button', { name: /^Restore$/i }) as HTMLButtonElement;
      expect(after.disabled).toBe(false);
    });
  });

  it('surfaces a failure to load destination nodes for the mapping', async () => {
    mockedFetch.mockImplementation(async (path: string) => {
      if (path === '/fleet/snapshots') {
        return { ok: true, json: async () => ({ snapshots: [{ ...detail(false), nodes: undefined }], total: 1 }) } as unknown as Response;
      }
      if (path === '/fleet/snapshots/7') {
        return { ok: true, json: async () => detail(false) } as unknown as Response;
      }
      if (path === '/nodes') {
        return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
      }
      if (path === '/cloud-backup/config') {
        return { ok: true, json: async () => ({ provider: 'disabled' }) } as unknown as Response;
      }
      return { ok: true, json: async () => ({}) } as unknown as Response;
    });
    render(<FleetSnapshots />);
    await waitFor(() => expect(screen.getByText('from-the-old-instance')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /View/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to load nodes (500)'));
  });

  it('warns that a legacy archive did not record partial-capture warnings', async () => {
    mockedFetch.mockImplementation(async (path: string) => {
      if (path === '/fleet/snapshots') {
        return { ok: true, json: async () => ({ snapshots: [{ ...detail(false), warnings_known: 0, nodes: undefined }], total: 1 }) } as unknown as Response;
      }
      if (path === '/fleet/snapshots/7') {
        return { ok: true, json: async () => ({ ...detail(false), warnings_known: 0, requiresNodeMapping: false }) } as unknown as Response;
      }
      if (path === '/cloud-backup/config') {
        return { ok: true, json: async () => ({ provider: 'disabled' }) } as unknown as Response;
      }
      return { ok: true, json: async () => ({}) } as unknown as Response;
    });
    render(<FleetSnapshots />);
    await waitFor(() => expect(screen.getByText('from-the-old-instance')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /View/i }));
    await waitFor(() => expect(screen.getByText(/Partial-capture warnings were not recorded/i)).toBeInTheDocument());
  });
});
