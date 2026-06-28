import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...a: unknown[]) => apiFetchMock(...a) }));
vi.mock('@/components/ui/toast-store', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { NodeUpdatesSheet } from '../NodeUpdatesSheet';
import { toast } from '@/components/ui/toast-store';
import type { NodeUpdateStatus } from '../types';

const STATUSES: NodeUpdateStatus[] = [
  { nodeId: 1, name: 'Local', type: 'local', version: '1.0.0', latestVersion: '1.1.0', updateAvailable: false, updateStatus: 'completed' },
  { nodeId: 2, name: 'Edge', type: 'remote', version: '1.0.0', latestVersion: '1.1.0', updateAvailable: true, updateStatus: null },
  { nodeId: 3, name: 'Db', type: 'remote', version: '1.0.0', latestVersion: '1.1.0', updateAvailable: false, updateStatus: 'failed', error: 'pull failed' },
];

function baseProps(overrides: Partial<React.ComponentProps<typeof NodeUpdatesSheet>> = {}) {
  return {
    open: true,
    onOpenChange: vi.fn(),
    checkingUpdates: false,
    updateStatuses: STATUSES,
    updatingNodeId: null,
    isAdmin: true,
    fetchUpdateStatus: vi.fn(async () => {}),
    triggerNodeUpdate: vi.fn(),
    retryNodeUpdate: vi.fn(),
    dismissNodeUpdate: vi.fn(),
    triggerUpdateAll: vi.fn(async () => {}),
    ...overrides,
  };
}

beforeEach(() => {
  apiFetchMock.mockReset();
  // Default: release-notes fetch returns empty notes (called by useEffect on mount).
  // Tests that need specific apiFetch responses override this.
  apiFetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ releaseNotes: null, htmlUrl: null }) });
});
afterEach(() => vi.clearAllMocks());

describe('NodeUpdatesSheet', () => {
  it('renders the per-node table rows', () => {
    render(<NodeUpdatesSheet {...baseProps()} />);
    expect(screen.getByText('Local')).toBeInTheDocument();
    expect(screen.getByText('Edge')).toBeInTheDocument();
    expect(screen.getByText('Db')).toBeInTheDocument();
  });

  it('renders the changelog release notes as formatted markdown, not raw text', async () => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        version: '1.1.0',
        releaseNotes: '## [0.92.0](https://example.com/compare) (2026-06-19)\n\n### Added\n\n* add a toggle ([#1363](https://example.com/issues/1363))\n',
        htmlUrl: 'https://example.com/releases/v0.92.0',
      }),
    });
    render(<NodeUpdatesSheet {...baseProps({ initialTab: 'changelog' })} />);
    // The "### Added" section becomes a real heading element, not literal text.
    const heading = await screen.findByRole('heading', { name: 'Added' });
    expect(heading.tagName).toBe('H3');
    // The issue reference becomes a link to GitHub, not raw "[#1363](...)".
    const link = screen.getByRole('link', { name: '#1363' });
    expect(link).toHaveAttribute('href', 'https://example.com/issues/1363');
    expect(link).toHaveAttribute('target', '_blank');
    // No markdown markers leak through as visible text.
    expect(screen.queryByText(/### Added/)).not.toBeInTheDocument();
    // Both external changelog links render.
    expect(screen.getByRole('link', { name: /View on GitHub/ })).toHaveAttribute('href', 'https://example.com/releases/v0.92.0');
    expect(screen.getByRole('link', { name: /View on Sencho/ })).toHaveAttribute('href', 'https://sencho.io/changelog');
  });

  it('settles on a graceful empty state with a Sencho link when no notes are returned', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => ({ releaseNotes: null, htmlUrl: null }) });
    render(<NodeUpdatesSheet {...baseProps({ initialTab: 'changelog' })} />);
    // The fetch settles (no perpetual spinner) and shows the empty message.
    expect(await screen.findByText('No release notes to show')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /View on Sencho/ })).toHaveAttribute('href', 'https://sencho.io/changelog');
  });

  it('fetches release notes once and does not refetch on re-render when notes are null', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => ({ releaseNotes: null, htmlUrl: null }) });
    const releaseCalls = () => apiFetchMock.mock.calls.filter(c => String(c[0]).includes('release-notes')).length;
    const { rerender } = render(<NodeUpdatesSheet {...baseProps({ initialTab: 'changelog' })} />);
    await screen.findByText('No release notes to show');
    expect(releaseCalls()).toBe(1);
    rerender(<NodeUpdatesSheet {...baseProps({ initialTab: 'changelog' })} />);
    // The loadedForVersion latch keeps a null result from re-triggering the fetch.
    await waitFor(() => expect(releaseCalls()).toBe(1));
  });

  it('binds the changelog to the release version and shows it', async () => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ version: '1.1.0', releaseNotes: '## What changed', htmlUrl: null }),
    });
    render(<NodeUpdatesSheet {...baseProps({ initialTab: 'changelog' })} />);
    await screen.findByRole('heading', { name: 'What changed' });
    // The notes are labelled with the version they belong to.
    expect(screen.getByText('Release v1.1.0')).toBeInTheDocument();
  });

  it('refetches release notes when the advertised latest version changes', async () => {
    apiFetchMock.mockImplementation((url: string) =>
      String(url).includes('release-notes')
        ? Promise.resolve({ ok: true, json: async () => ({ version: '1.1.0', releaseNotes: '## v1.1.0 notes', htmlUrl: null }) })
        : Promise.resolve({ ok: true, json: async () => ({}) }),
    );
    const releaseCalls = () => apiFetchMock.mock.calls.filter(c => String(c[0]).includes('release-notes')).length;
    const { rerender } = render(<NodeUpdatesSheet {...baseProps({ initialTab: 'changelog' })} />);
    await screen.findByRole('heading', { name: 'v1.1.0 notes' });
    expect(releaseCalls()).toBe(1);

    // A newer release surfaces while the sheet is open: the advertised latest
    // moves to 1.2.0 and the endpoint now returns its notes. The changelog must
    // refetch and show the new version, not the stale 1.1.0 notes.
    apiFetchMock.mockImplementation((url: string) =>
      String(url).includes('release-notes')
        ? Promise.resolve({ ok: true, json: async () => ({ version: '1.2.0', releaseNotes: '## v1.2.0 notes', htmlUrl: null }) })
        : Promise.resolve({ ok: true, json: async () => ({}) }),
    );
    const bumped = STATUSES.map(s => ({ ...s, latestVersion: '1.2.0' }));
    rerender(<NodeUpdatesSheet {...baseProps({ initialTab: 'changelog', updateStatuses: bumped })} />);

    await screen.findByRole('heading', { name: 'v1.2.0 notes' });
    expect(screen.getByText('Release v1.2.0')).toBeInTheDocument();
    // The stale notes are replaced, not appended alongside the new ones.
    expect(screen.queryByRole('heading', { name: 'v1.1.0 notes' })).not.toBeInTheDocument();
    await waitFor(() => expect(releaseCalls()).toBe(2));
  });

  it('clears stale notes when the refetch after a version change returns a non-OK response', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => ({ version: '1.1.0', releaseNotes: '## v1.1.0 notes', htmlUrl: 'https://example.com/v1.1.0' }) });
    const releaseCalls = () => apiFetchMock.mock.calls.filter(c => String(c[0]).includes('release-notes')).length;
    const { rerender } = render(<NodeUpdatesSheet {...baseProps({ initialTab: 'changelog' })} />);
    await screen.findByRole('heading', { name: 'v1.1.0 notes' });
    expect(releaseCalls()).toBe(1);

    // Advertised version moves to 1.2.0 but the refetch fails (HTTP 500). The
    // previously loaded 1.1.0 notes must not linger as the 1.2.0 changelog.
    apiFetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const bumped = STATUSES.map(s => ({ ...s, latestVersion: '1.2.0' }));
    rerender(<NodeUpdatesSheet {...baseProps({ initialTab: 'changelog', updateStatuses: bumped })} />);

    expect(await screen.findByText('No release notes to show')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'v1.1.0 notes' })).not.toBeInTheDocument();
    expect(screen.queryByText('Release v1.1.0')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /View on GitHub/ })).not.toBeInTheDocument();
    // The failed refetch settles without looping.
    await waitFor(() => expect(releaseCalls()).toBe(2));
  });

  it('clears stale notes when the refetch after a version change rejects', async () => {
    let calls = 0;
    apiFetchMock.mockImplementation(() => {
      calls += 1;
      return calls === 1
        ? Promise.resolve({ ok: true, json: async () => ({ version: '1.1.0', releaseNotes: '## v1.1.0 notes', htmlUrl: null }) })
        : Promise.reject(new Error('network down'));
    });
    const releaseCalls = () => apiFetchMock.mock.calls.filter(c => String(c[0]).includes('release-notes')).length;
    const { rerender } = render(<NodeUpdatesSheet {...baseProps({ initialTab: 'changelog' })} />);
    await screen.findByRole('heading', { name: 'v1.1.0 notes' });

    // A rejected (network/JSON) refetch after the version change must also clear
    // the stale notes rather than leave them mislabelled as the new version.
    const bumped = STATUSES.map(s => ({ ...s, latestVersion: '1.2.0' }));
    rerender(<NodeUpdatesSheet {...baseProps({ initialTab: 'changelog', updateStatuses: bumped })} />);

    expect(await screen.findByText('No release notes to show')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'v1.1.0 notes' })).not.toBeInTheDocument();
    await waitFor(() => expect(releaseCalls()).toBe(2));
  });

  it('does not refetch loaded notes on re-render when the version is unchanged', async () => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ version: '1.1.0', releaseNotes: '## v1.1.0 notes', htmlUrl: null }),
    });
    const releaseCalls = () => apiFetchMock.mock.calls.filter(c => String(c[0]).includes('release-notes')).length;
    const { rerender } = render(<NodeUpdatesSheet {...baseProps({ initialTab: 'changelog' })} />);
    await screen.findByRole('heading', { name: 'v1.1.0 notes' });
    expect(releaseCalls()).toBe(1);
    // Re-rendering with the same advertised latest version must not refetch: the
    // version-keyed guard short-circuits for an already-loaded changelog.
    rerender(<NodeUpdatesSheet {...baseProps({ initialTab: 'changelog' })} />);
    await waitFor(() => expect(releaseCalls()).toBe(1));
  });

  it('does not render notes whose version differs from the advertised update', async () => {
    // Realistic cache offset: the advertised latest is 1.2.0 but the release-notes
    // endpoint still returns 1.1.0 (the version lookup and notes lookup use
    // independent caches; version can come from Docker Hub while notes are
    // GitHub-only). The 1.1.0 notes must never render as the 1.2.0 changelog.
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ version: '1.1.0', releaseNotes: '## v1.1.0 notes', htmlUrl: 'https://example.com/v1.1.0' }),
    });
    const releaseCalls = () => apiFetchMock.mock.calls.filter(c => String(c[0]).includes('release-notes')).length;
    const advertised120 = STATUSES.map(s => ({ ...s, latestVersion: '1.2.0' }));
    render(<NodeUpdatesSheet {...baseProps({ initialTab: 'changelog', updateStatuses: advertised120 })} />);

    // The mismatched notes fall through to the empty state with the online link.
    expect(await screen.findByText('No release notes to show')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'v1.1.0 notes' })).not.toBeInTheDocument();
    expect(screen.queryByText('Release v1.1.0')).not.toBeInTheDocument();
    // The whole mismatched payload is discarded, including its GitHub link.
    expect(screen.queryByRole('link', { name: /View on GitHub/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /View on Sencho/ })).toHaveAttribute('href', 'https://sencho.io/changelog');
    // The settled mismatch does not loop the fetch.
    await waitFor(() => expect(releaseCalls()).toBe(1));
  });

  it('recovers via Recheck when the endpoint catches up to the advertised version', async () => {
    // Start mismatched (advertised 1.2.0, endpoint still 1.1.0): empty state.
    const advertised120 = STATUSES.map(s => ({ ...s, latestVersion: '1.2.0' }));
    apiFetchMock.mockImplementation((url: string) =>
      String(url).includes('release-notes')
        ? Promise.resolve({ ok: true, json: async () => ({ version: '1.1.0', releaseNotes: '## v1.1.0 notes', htmlUrl: null }) })
        : Promise.resolve({ ok: true, json: async () => ({ rechecked: true }) }),
    );
    render(<NodeUpdatesSheet {...baseProps({ initialTab: 'changelog', updateStatuses: advertised120 })} />);
    expect(await screen.findByText('No release notes to show')).toBeInTheDocument();

    // The recheck surfaces the matching 1.2.0 notes; clicking Recheck must
    // recover the previously-mismatched changelog rather than stay empty.
    apiFetchMock.mockImplementation((url: string) =>
      String(url).includes('release-notes')
        ? Promise.resolve({ ok: true, json: async () => ({ version: '1.2.0', releaseNotes: '## v1.2.0 notes', htmlUrl: null }) })
        : Promise.resolve({ ok: true, json: async () => ({ rechecked: true }) }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Recheck' }));
    expect(await screen.findByRole('heading', { name: 'v1.2.0 notes' })).toBeInTheDocument();
    expect(screen.getByText('Release v1.2.0')).toBeInTheDocument();
  });

  it('shows the empty state without looping when the advertised version is unknown', async () => {
    // Local node has no resolved latestVersion: advertisedLatest is null, so a
    // non-null endpoint version cannot match and the notes must not render. The
    // settle must still record null and not loop the fetch.
    const noLatest = STATUSES.map(s => ({ ...s, latestVersion: null }));
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ version: '1.1.0', releaseNotes: '## v1.1.0 notes', htmlUrl: null }),
    });
    const releaseCalls = () => apiFetchMock.mock.calls.filter(c => String(c[0]).includes('release-notes')).length;
    render(<NodeUpdatesSheet {...baseProps({ initialTab: 'changelog', updateStatuses: noLatest })} />);
    expect(await screen.findByText('No release notes to show')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'v1.1.0 notes' })).not.toBeInTheDocument();
    await waitFor(() => expect(releaseCalls()).toBe(1));
  });

  it('Recheck resets and refetches release notes with the recheck flag', async () => {
    apiFetchMock.mockImplementation((url: string) =>
      String(url).includes('release-notes')
        ? Promise.resolve({ ok: true, json: async () => ({ version: '1.1.0', releaseNotes: '## v1', htmlUrl: null }) })
        : Promise.resolve({ ok: true, json: async () => ({ rechecked: true }) }),
    );
    render(<NodeUpdatesSheet {...baseProps({ isAdmin: true, initialTab: 'changelog' })} />);
    await screen.findByRole('heading', { name: 'v1' });
    apiFetchMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Recheck' }));
    await waitFor(() => {
      const call = apiFetchMock.mock.calls.find(c => String(c[0]).includes('release-notes'));
      expect(call?.[0]).toBe('/fleet/update-status/release-notes?recheck=true');
    });
  });

  it('shows a checking spinner state', () => {
    render(<NodeUpdatesSheet {...baseProps({ checkingUpdates: true })} />);
    expect(screen.getByText('Checking for updates...')).toBeInTheDocument();
  });

  it('shows the empty state with no nodes', () => {
    render(<NodeUpdatesSheet {...baseProps({ updateStatuses: [] })} />);
    expect(screen.getByText('No nodes found.')).toBeInTheDocument();
  });

  it('triggers a per-node update from the Update button', () => {
    const triggerNodeUpdate = vi.fn();
    render(<NodeUpdatesSheet {...baseProps({ triggerNodeUpdate })} />);
    fireEvent.click(screen.getByRole('button', { name: /Update$/ }));
    expect(triggerNodeUpdate).toHaveBeenCalledWith(2);
  });

  it('filters the node table by the search box', () => {
    render(<NodeUpdatesSheet {...baseProps()} />);
    fireEvent.change(screen.getByPlaceholderText('Filter nodes...'), { target: { value: 'edge' } });
    expect(screen.getByText('Edge')).toBeInTheDocument();
    expect(screen.queryByText('Local')).not.toBeInTheDocument();
  });

  it('renders every mutating affordance for an admin', () => {
    render(<NodeUpdatesSheet {...baseProps({ isAdmin: true })} />);
    expect(screen.getByRole('button', { name: 'Recheck' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Update all/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Update$/ })).toBeInTheDocument();
    expect(screen.getByLabelText('Retry update')).toBeInTheDocument();
  });

  it('toasts when a recheck is throttled by the server (rechecked:false)', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => ({ rechecked: false }) });
    render(<NodeUpdatesSheet {...baseProps({ isAdmin: true })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Recheck' }));
    await waitFor(() => expect(toast.info).toHaveBeenCalled());
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/fleet/update-status?recheck=true',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('surfaces an error when the recheck fails (non-ok response, and by symmetry a thrown failure)', async () => {
    // apiFetch only throws on 401/network; HTTP errors land as res.ok === false.
    // Both the else branch (this case) and the catch branch raise the same
    // toast.error, so this exercises the user-facing failure toast. The thrown
    // path is not driven through the click here because this repo's test harness
    // re-surfaces a rejected Error flowing through a React event handler as a
    // test failure even when the handler catches it.
    apiFetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    render(<NodeUpdatesSheet {...baseProps({ isAdmin: true })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Recheck' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.info).not.toHaveBeenCalled();
  });

  it('does not toast when a recheck actually refreshed (rechecked:true)', async () => {
    const fetchUpdateStatus = vi.fn(async () => {});
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => ({ rechecked: true }) });
    render(<NodeUpdatesSheet {...baseProps({ isAdmin: true, fetchUpdateStatus })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Recheck' }));
    await waitFor(() => expect(fetchUpdateStatus).toHaveBeenCalled());
    expect(toast.info).not.toHaveBeenCalled();
  });

  it('hides every mutating affordance for a non-admin but keeps the read-only table', () => {
    render(<NodeUpdatesSheet {...baseProps({ isAdmin: false })} />);
    // Read-only status remains visible
    expect(screen.getByText('Local')).toBeInTheDocument();
    expect(screen.getByText('Edge')).toBeInTheDocument();
    expect(screen.getByText('Db')).toBeInTheDocument();
    // 'Available' appears once as the summary stat label; for a non-admin the
    // per-row read-only badge adds a second occurrence in place of the button.
    expect(screen.getAllByText('Available')).toHaveLength(2);
    // No mutate controls
    expect(screen.queryByRole('button', { name: 'Recheck' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Update all/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Update$/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Retry update')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Dismiss')).not.toBeInTheDocument();
  });
});
