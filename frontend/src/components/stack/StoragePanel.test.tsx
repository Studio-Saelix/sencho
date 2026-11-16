/**
 * Covers the Storage panel: the portability verdict + per-service mounts, the
 * unrenderable banner, a load-failure retry, the static snapshot caveat, and the
 * admin-only snapshot coverage merge (the warning, the recent-snapshot line, the
 * hub-local `/fleet/snapshots/coverage` path, and that non-admins never fetch it).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';

const auth = vi.hoisted(() => ({ isAdmin: false }));
vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/context/NodeContext', () => ({ useNodes: () => ({ activeNode: { id: 1 } }) }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ isAdmin: auth.isAdmin }) }));

import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import StoragePanel from './StoragePanel';

interface Mount { service: string; type: string; source?: string; target: string; readOnly: boolean; probe: unknown; externalNamed: boolean }
function mount(over: Partial<Mount> = {}): Mount {
  return { service: 'app', type: 'bind', target: '/data', readOnly: false, probe: null, externalNamed: false, ...over };
}
function inventory(over: Record<string, unknown> = {}) {
  return { stack: 'app', renderable: true, renderError: null, stateful: true, mounts: [], portability: { status: 'portable', reasons: [] }, ...over };
}
function jsonRes(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body, text: async () => '' } as unknown as Response;
}

/** Route apiFetch by URL: /storage vs /fleet/snapshots/coverage. */
function route(opts: { storage?: Response; coverage?: Response }) {
  vi.mocked(apiFetch).mockImplementation(((url: string) => {
    if (String(url).includes('/snapshots/coverage')) return Promise.resolve(opts.coverage ?? jsonRes({ latestAt: null }));
    return Promise.resolve(opts.storage ?? jsonRes(inventory()));
  }) as unknown as typeof apiFetch);
}

beforeEach(() => { vi.clearAllMocks(); auth.isAdmin = false; });

describe('StoragePanel', () => {
  it('renders the portability verdict and mounts grouped by service', async () => {
    route({ storage: jsonRes(inventory({
      portability: { status: 'node-bound', reasons: ['Binds host paths outside the stack directory.'] },
      mounts: [mount({ service: 'web', source: '/mnt/media', target: '/media' }), mount({ service: 'db', type: 'named', source: 'data', target: '/var/lib' })],
    })) });
    render(<StoragePanel stackName="app" />);
    const verdict = await screen.findByTestId('storage-portability');
    expect(verdict).toHaveAttribute('data-state', 'node-bound');
    expect(verdict).toHaveTextContent(/node-bound/i);
    expect(screen.getByTestId('storage-service-web')).toBeInTheDocument();
    expect(screen.getByTestId('storage-service-db')).toBeInTheDocument();
    expect(screen.getByText(/\/var\/lib/)).toBeInTheDocument();
  });

  it('names the first reason in the Answer and keeps every reason behind one disclosure', async () => {
    route({ storage: jsonRes(inventory({
      portability: { status: 'node-bound', reasons: ['bind /mnt/media', 'mounts the Docker socket', 'bind /srv/x'] },
    })) });
    render(<StoragePanel stackName="app" />);
    const verdict = await screen.findByTestId('storage-portability');
    expect(verdict).toHaveTextContent('bind /mnt/media');
    expect(verdict).toHaveTextContent('2 more reasons');
    expect(screen.queryByText(/mounts the Docker socket/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /all reasons/i }));
    expect(await screen.findByText(/mounts the Docker socket/)).toBeInTheDocument();
    // The first reason is stated once, in the Answer: the disclosure lists only the rest.
    expect(screen.getAllByText(/bind \/mnt\/media/)).toHaveLength(1);
    expect(screen.getAllByText(/bind \/srv\/x/)).toHaveLength(1);
  });

  it.each([
    ['portable', 'success', /stays inside the stack directory/],
    ['partially-portable', 'neutral', /volume holds data on this node/],
    ['node-bound', 'warning', /exist only on this node/],
    ['unknown', 'neutral', /could not work out/],
  ])('with no reasons, %s reads its own line and tone, with no disclosure', async (status, tone, line) => {
    route({ storage: jsonRes(inventory({ portability: { status, reasons: [] } })) });
    render(<StoragePanel stackName="app" />);
    const verdict = await screen.findByTestId('storage-portability');
    expect(verdict).toHaveAttribute('data-tone', tone);
    expect(verdict).toHaveTextContent(line);
    expect(screen.queryByRole('button', { name: /all reasons/i })).toBeNull();
  });

  it('a single reason has no count and no disclosure; two reasons say "1 more reason"', async () => {
    route({ storage: jsonRes(inventory({ portability: { status: 'node-bound', reasons: ['bind /mnt/media'] } })) });
    const { unmount } = render(<StoragePanel stackName="app" />);
    const one = await screen.findByTestId('storage-portability');
    expect(one).not.toHaveTextContent(/more reason/);
    expect(screen.queryByRole('button', { name: /all reasons/i })).toBeNull();
    unmount();
    route({ storage: jsonRes(inventory({ portability: { status: 'node-bound', reasons: ['a', 'b'] } })) });
    render(<StoragePanel stackName="app" />);
    expect(await screen.findByText('1 more reason')).toBeInTheDocument();
  });

  it('keeps the verdict the only toned block even when the snapshot gap shows', async () => {
    auth.isAdmin = true;
    route({ storage: jsonRes(inventory({ portability: { status: 'node-bound', reasons: ['bind /mnt/media'] } })), coverage: jsonRes({ latestAt: null }) });
    const { container } = render(<StoragePanel stackName="app" />);
    const warning = await screen.findByTestId('storage-snapshot-warning');
    expect(container.querySelectorAll('[data-tone]')).toHaveLength(1);
    expect(warning.className).not.toMatch(/\bborder\b|bg-warning/);
  });

  it('shows a layout-matched skeleton only after the delay gate', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(apiFetch).mockReturnValue(new Promise(() => {}));
      render(<StoragePanel stackName="app" />);
      expect(screen.queryByTestId('storage-skeleton')).toBeNull();
      await act(async () => { vi.advanceTimersByTime(400); });
      expect(screen.getByTestId('storage-skeleton')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the cannot-render banner with the render error', async () => {
    route({ storage: jsonRes(inventory({ renderable: false, renderError: 'bad compose', stateful: false, portability: { status: 'unknown', reasons: [] } })) });
    render(<StoragePanel stackName="app" />);
    expect(await screen.findByText(/cannot render/i)).toBeInTheDocument();
    expect(screen.getByText(/bad compose/)).toBeInTheDocument();
  });

  it('shows a retry state and toasts when the load fails', async () => {
    route({ storage: jsonRes(null, false) });
    render(<StoragePanel stackName="app" />);
    expect(await screen.findByText(/Could not load the storage inventory/i)).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalled();
    expect(screen.getByTestId('storage-retry-btn')).toBeInTheDocument();
  });

  it('always shows the snapshots-cover-config caveat', async () => {
    route({ storage: jsonRes(inventory()) });
    render(<StoragePanel stackName="app" />);
    expect(await screen.findByText(/capture Compose and env files, not the data/i)).toBeInTheDocument();
  });

  it('does not fetch snapshot coverage for a non-admin', async () => {
    route({ storage: jsonRes(inventory()) });
    render(<StoragePanel stackName="app" />);
    await screen.findByTestId('storage-portability');
    await waitFor(() => {
      const urls = vi.mocked(apiFetch).mock.calls.map(c => String(c[0]));
      expect(urls.some(u => u.includes('/storage'))).toBe(true);
      expect(urls.some(u => u.includes('/snapshots/coverage'))).toBe(false);
    });
    expect(screen.queryByTestId('storage-snapshot-warning')).not.toBeInTheDocument();
  });

  it('fetches coverage from the hub-local /fleet path and warns when an admin stack has no recent snapshot', async () => {
    auth.isAdmin = true;
    route({ storage: jsonRes(inventory({ stateful: true })), coverage: jsonRes({ latestAt: null }) });
    render(<StoragePanel stackName="app" />);
    expect(await screen.findByTestId('storage-snapshot-warning')).toBeInTheDocument();
    const coverageCall = vi.mocked(apiFetch).mock.calls.find(c => String(c[0]).includes('/snapshots/coverage'));
    expect(coverageCall).toBeDefined();
    // apiFetch prepends /api, so the call must NOT already carry it.
    expect(String(coverageCall![0]).startsWith('/fleet/snapshots/coverage')).toBe(true);
    expect(String(coverageCall![0]).startsWith('/api/')).toBe(false);
    expect((coverageCall![1] as { localOnly?: boolean }).localOnly).toBe(true);
  });

  it('hides the warning and shows the last-snapshot line when a recent snapshot exists', async () => {
    auth.isAdmin = true;
    route({ storage: jsonRes(inventory({ stateful: true })), coverage: jsonRes({ latestAt: Date.now() - 1000 }) });
    render(<StoragePanel stackName="app" />);
    expect(await screen.findByText(/Last fleet snapshot/i)).toBeInTheDocument();
    expect(screen.queryByTestId('storage-snapshot-warning')).not.toBeInTheDocument();
  });
});
