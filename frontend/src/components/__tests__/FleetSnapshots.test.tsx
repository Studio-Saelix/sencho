import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
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

describe('FleetSnapshots restore destination binding', () => {
  const mappedDetail = () => ({
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
    mappingVersion: '42:1',
    nodes: [{
      nodeId: 42,
      nodeName: 'original-production',
      targetNodeId: 1,
      targetNodeName: 'Local',
      stacks: [{ stackName: 'web', files: [{ filename: 'compose.yaml', content: 'services: {}' }] }],
    }],
  });

  function mockApi(handler?: (path: string, options?: Parameters<typeof apiFetch>[1]) => Promise<Response | null>) {
    return async (path: string, options?: Parameters<typeof apiFetch>[1]) => {
      const handled = handler ? await handler(path, options) : null;
      if (handled) return handled;
      if (path === '/fleet/snapshots') {
        return { ok: true, json: async () => ({ snapshots: [{ ...mappedDetail(), nodes: undefined }], total: 1 }) } as unknown as Response;
      }
      if (path === '/fleet/snapshots/7') {
        return { ok: true, json: async () => mappedDetail() } as unknown as Response;
      }
      if (path === '/cloud-backup/config') {
        return { ok: true, json: async () => ({ provider: 'disabled' }) } as unknown as Response;
      }
      return { ok: true, json: async () => ({}) } as unknown as Response;
    };
  }

  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it('binds an individual restore to the confirmed destination and reloads on a stale mapping', async () => {
    let restoreBody: Record<string, unknown> | null = null;
    let detailLoads = 0;
    mockedFetch.mockImplementation(mockApi(async (path, options) => {
      if (path === '/fleet/snapshots/7' && options?.method !== 'POST') detailLoads += 1;
      if (path === '/fleet/snapshots/7/restore' && options?.method === 'POST') {
        restoreBody = JSON.parse(String(options.body)) as Record<string, unknown>;
        return {
          ok: false,
          status: 409,
          json: async () => ({
            error: 'The destination mapping for this snapshot is not the one this request confirmed. Reload the snapshot and confirm the destinations again.',
            code: 'SNAPSHOT_MAPPING_CHANGED',
          }),
        } as unknown as Response;
      }
      return null;
    }));

    render(<FleetSnapshots />);
    await waitFor(() => expect(screen.getByText('from-the-old-instance')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /View/i }));
    await waitFor(() => expect(screen.getByText(/came from another instance/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /original-production/i }));
    await waitFor(() => expect(screen.getByText('web')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Restore$/i }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));

    await waitFor(() => expect(restoreBody).not.toBeNull());
    expect(restoreBody).toEqual(expect.objectContaining({
      nodeId: 42,
      stackName: 'web',
      expectedTargetNodeId: 1,
    }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      'The destination mapping for this snapshot is not the one this request confirmed. Reload the snapshot and confirm the destinations again.',
    ));
    // The stale confirmation sends the operator back to the current mapping.
    await waitFor(() => expect(detailLoads).toBeGreaterThan(1));
  });

  it('sends the confirmed mapping fingerprint with Restore all', async () => {
    let restoreAllBody: Record<string, unknown> | null = null;
    mockedFetch.mockImplementation(mockApi(async (path, options) => {
      if (path === '/fleet/snapshots/7/restore-all' && options?.method === 'POST') {
        restoreAllBody = JSON.parse(String(options.body)) as Record<string, unknown>;
        return { ok: true, json: async () => ({ restored: 1, failed: 0, redeploy: false, results: [{ stackName: 'web', success: true }] }) } as unknown as Response;
      }
      return null;
    }));

    render(<FleetSnapshots />);
    await waitFor(() => expect(screen.getByText('from-the-old-instance')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /View/i }));
    await waitFor(() => expect(screen.getByText(/came from another instance/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Restore all/i }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore all' }));

    await waitFor(() => expect(restoreAllBody).not.toBeNull());
    expect(restoreAllBody).toEqual({
      redeploy: false,
      restoreNotes: false,
      expectedMappingVersion: '42:1',
    });
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

    await waitFor(() => expect(screen.getByRole('combobox')).not.toBeDisabled());
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

  it('shows the destination list as loading instead of offering an empty choice', async () => {
    let resolveNodes: (value: Response) => void = () => {};
    const nodesPending = new Promise<Response>(resolve => { resolveNodes = resolve; });
    mockedFetch.mockImplementation(async (path: string) => {
      if (path === '/fleet/snapshots') {
        return { ok: true, json: async () => ({ snapshots: [{ ...detail(false), nodes: undefined }], total: 1 }) } as unknown as Response;
      }
      if (path === '/fleet/snapshots/7') {
        return { ok: true, json: async () => detail(false) } as unknown as Response;
      }
      if (path === '/nodes') return nodesPending;
      if (path === '/cloud-backup/config') {
        return { ok: true, json: async () => ({ provider: 'disabled' }) } as unknown as Response;
      }
      return { ok: true, json: async () => ({}) } as unknown as Response;
    });
    render(<FleetSnapshots />);
    await waitFor(() => expect(screen.getByText('from-the-old-instance')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /View/i }));

    await waitFor(() => expect(screen.getByText(/came from another instance/i)).toBeInTheDocument());
    const combobox = screen.getByRole('combobox') as HTMLButtonElement;
    expect(combobox.disabled).toBe(true);
    expect(combobox).toHaveTextContent('Loading nodes...');
    expect(combobox).not.toHaveTextContent('Not mapped');

    resolveNodes({ ok: true, json: async () => [{ id: 1, name: 'Local' }] } as unknown as Response);
    await waitFor(() => expect(screen.getByRole('combobox')).not.toBeDisabled());
    expect(screen.getByRole('combobox')).toHaveTextContent('Not mapped');
    expect(screen.getByRole('combobox')).not.toHaveTextContent('Loading nodes...');
  });

  it('keeps a failed destination list visible and retries it', async () => {
    let attempts = 0;
    mockedFetch.mockImplementation(async (path: string) => {
      if (path === '/fleet/snapshots') {
        return { ok: true, json: async () => ({ snapshots: [{ ...detail(false), nodes: undefined }], total: 1 }) } as unknown as Response;
      }
      if (path === '/fleet/snapshots/7') {
        return { ok: true, json: async () => detail(false) } as unknown as Response;
      }
      if (path === '/nodes') {
        attempts += 1;
        if (attempts === 1) return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
        return { ok: true, json: async () => [{ id: 1, name: 'Local' }] } as unknown as Response;
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
    expect(screen.getByText(/Destination nodes could not be loaded/)).toBeInTheDocument();
    expect((screen.getByRole('combobox') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('combobox')).toHaveTextContent('Nodes unavailable');
    expect(screen.getByRole('combobox')).not.toHaveTextContent('Not mapped');

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByRole('combobox')).not.toBeDisabled());
    expect(screen.queryByText(/Destination nodes could not be loaded/)).toBeNull();
    fireEvent.click(screen.getByRole('combobox'));
    expect(screen.getByRole('button', { name: 'Local' })).toBeInTheDocument();
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

describe('FleetSnapshots list provenance and warning completeness', () => {
  const row = (overrides: Record<string, unknown>) => ({
    id: 7,
    description: 'snapshot',
    created_by: 'ada',
    node_count: 1,
    stack_count: 1,
    skipped_nodes: '[]',
    skipped_stacks: '[]',
    created_at: Date.now(),
    has_documentation: 0,
    ...overrides,
  });

  beforeEach(() => {
    mockedFetch.mockReset();
    mockedFetch.mockImplementation(async (path: string) => {
      if (path === '/fleet/snapshots') {
        return {
          ok: true,
          json: async () => ({
            snapshots: [
              row({ id: 7, description: 'legacy archive without warnings', warnings_known: 0, origin: 'imported' }),
              row({
                id: 9,
                description: 'legacy archive with a skipped node',
                warnings_known: 0,
                origin: 'imported',
                skipped_nodes: JSON.stringify([{ nodeId: 2, nodeName: 'edge', reason: 'offline' }]),
              }),
              row({ id: 8, description: 'modern local snapshot', warnings_known: 1, origin: 'local' }),
            ],
            total: 3,
          }),
        } as unknown as Response;
      }
      if (path === '/fleet/snapshots/7') {
        return {
          ok: true,
          json: async () => row({
            id: 7,
            description: 'legacy archive without warnings',
            warnings_known: 0,
            origin: 'imported',
            nodes: [],
          }),
        } as unknown as Response;
      }
      if (path === '/cloud-backup/config') {
        return { ok: true, json: async () => ({ provider: 'disabled' }) } as unknown as Response;
      }
      if (path === '/cloud-backup/snapshots') {
        return { ok: true, json: async () => [] } as unknown as Response;
      }
      return { ok: true, json: async () => ({}) } as unknown as Response;
    });
  });

  it('shows Unknown instead of None for a row whose warnings were never recorded', async () => {
    render(<FleetSnapshots />);
    const legacyRow = (await screen.findByText('legacy archive without warnings')).closest('tr');
    expect(legacyRow).not.toBeNull();
    expect(within(legacyRow as HTMLElement).getByText('Unknown')).toBeInTheDocument();
    expect(within(legacyRow as HTMLElement).queryByText('None')).toBeNull();

    // A recorded skipped node is still a known warning even when the archive
    // never recorded the skipped-stack side.
    const partialRow = screen.getByText('legacy archive with a skipped node').closest('tr');
    expect(partialRow).not.toBeNull();
    expect(within(partialRow as HTMLElement).getByText('1')).toBeInTheDocument();
    expect(within(partialRow as HTMLElement).queryByText('Unknown')).toBeNull();

    const localRow = screen.getByText('modern local snapshot').closest('tr');
    expect(localRow).not.toBeNull();
    expect(within(localRow as HTMLElement).getByText('None')).toBeInTheDocument();
  });

  it('marks an imported row in the list and in the detail header', async () => {
    render(<FleetSnapshots />);
    const importedRow = (await screen.findByText('legacy archive without warnings')).closest('tr');
    expect(within(importedRow as HTMLElement).getByText('Imported')).toBeInTheDocument();

    const localRow = screen.getByText('modern local snapshot').closest('tr');
    expect(within(localRow as HTMLElement).queryByText('Imported')).toBeNull();

    fireEvent.click(within(importedRow as HTMLElement).getByRole('button', { name: /View/i }));
    await waitFor(() => expect(
      screen.getByTitle('Imported from an archive rather than captured on this instance'),
    ).toBeInTheDocument());
  });
});
