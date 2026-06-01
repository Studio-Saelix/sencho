/**
 * Coverage for SecurityHistoryView.
 *
 * Locks the scan history's selection and comparison-launch behavior: scans
 * fetched on mount, selection capped at two, oldest-first baseline ordering,
 * and selection reset on active-node change.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { VulnerabilityScan } from '@/types/security';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('@/components/ui/toast-store', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  },
}));

const licenseState = { isPaid: true };
vi.mock('@/context/LicenseContext', () => ({
  useLicense: () => licenseState,
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ isAdmin: true }),
}));

const nodesState: {
  activeNode: { id: number; name?: string } | null;
  hasCapability: (cap: string) => boolean;
  activeNodeMeta: { version: string | null; capabilities: string[]; fetchedAt: number } | null;
} = {
  activeNode: { id: 1 },
  hasCapability: () => true,
  activeNodeMeta: null,
};
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => nodesState,
}));

const compareProps: { baselineScanId: number | null; currentScanId: number | null }[] = [];
vi.mock('../ScanComparisonSheet', () => ({
  ScanComparisonSheet: (props: { baselineScanId: number | null; currentScanId: number | null }) => {
    compareProps.push({ baselineScanId: props.baselineScanId, currentScanId: props.currentScanId });
    return null;
  },
}));

vi.mock('../VulnerabilityScanSheet', () => ({
  SeverityChip: ({ severity }: { severity: string }) => <span>{severity}</span>,
  VulnerabilityScanSheet: () => null,
}));

import { apiFetch } from '@/lib/api';
import { SecurityHistoryView } from '../SecurityHistoryView';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

function scan(overrides: Partial<VulnerabilityScan> = {}): VulnerabilityScan {
  return {
    id: 1,
    node_id: 1,
    image_ref: 'alpine:3.19',
    image_digest: null,
    scanned_at: 1_700_000_000_000,
    total_vulnerabilities: 0,
    critical_count: 0,
    high_count: 0,
    medium_count: 0,
    low_count: 0,
    unknown_count: 0,
    fixable_count: 0,
    secret_count: 0,
    misconfig_count: 0,
    scanners_used: 'vuln',
    highest_severity: null,
    os_info: null,
    trivy_version: null,
    scan_duration_ms: null,
    triggered_by: 'manual',
    status: 'completed',
    error: null,
    stack_context: null,
    ...overrides,
  };
}

function listResponse(
  items: VulnerabilityScan[],
  opts: { total?: number; cappedImageRefs?: string[]; perImageLimit?: number } = {},
): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      items,
      total: opts.total ?? items.length,
      cappedImageRefs: opts.cappedImageRefs ?? [],
      perImageLimit: opts.perImageLimit ?? 50,
    }),
  } as unknown as Response;
}

beforeEach(() => {
  mockedFetch.mockReset();
  compareProps.length = 0;
  licenseState.isPaid = true;
  nodesState.activeNode = { id: 1 };
  nodesState.hasCapability = () => true;
  nodesState.activeNodeMeta = null;
});

afterEach(() => vi.clearAllMocks());

describe('SecurityHistoryView', () => {
  it('fetches completed scans on mount with server-driven pagination params', async () => {
    mockedFetch.mockResolvedValue(listResponse([scan()]));
    render(<SecurityHistoryView open onClose={vi.fn()} />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());
    const url = mockedFetch.mock.calls[0][0] as string;
    expect(url).toMatch(/^\/security\/scans\?/);
    expect(url).toContain('status=completed');
    expect(url).toContain('offset=0');
    expect(url).toMatch(/limit=\d+/);
  });

  it('shows a lock card and does not fetch when the node lacks vulnerability-scanning', async () => {
    nodesState.hasCapability = (cap: string) => cap !== 'vulnerability-scanning';
    nodesState.activeNodeMeta = { version: '0.80.0', capabilities: [], fetchedAt: 0 };
    mockedFetch.mockResolvedValue(listResponse([scan()]));

    render(<SecurityHistoryView open onClose={vi.fn()} />);

    expect(
      await screen.findByText('Vulnerability scanning is not available on this node'),
    ).toBeInTheDocument();
    expect(mockedFetch).not.toHaveBeenCalled();
    // The header actions are gone too, so there is no Refresh button that could
    // fire the gated fetch from behind the lock card.
    expect(screen.queryByRole('button', { name: /refresh/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /compare/i })).toBeNull();
  });

  it('advances offset when the user pages forward', async () => {
    mockedFetch.mockResolvedValue(listResponse([scan()], { total: 250 }));
    const user = userEvent.setup();
    render(<SecurityHistoryView open onClose={vi.fn()} />);

    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(1));

    const nextBtn = screen.getAllByRole('button').find(
      (b) => b.querySelector('.lucide-chevron-right'),
    );
    expect(nextBtn).toBeDefined();
    await user.click(nextBtn!);

    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(2));
    const secondUrl = mockedFetch.mock.calls[1][0] as string;
    expect(secondUrl).toContain('offset=100');
  });

  it('re-fetches when activeNode.id changes', async () => {
    mockedFetch.mockResolvedValue(listResponse([scan()]));
    const { rerender } = render(<SecurityHistoryView open onClose={vi.fn()} />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(1));

    nodesState.activeNode = { id: 2 };
    rerender(<SecurityHistoryView key="remount-signal" open onClose={vi.fn()} />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(2));
  });

  it('caps selection at two scans, evicting the oldest', async () => {
    mockedFetch.mockResolvedValue(
      listResponse([
        scan({ id: 1, scanned_at: 1000 }),
        scan({ id: 2, scanned_at: 2000 }),
        scan({ id: 3, scanned_at: 3000 }),
      ]),
    );
    const user = userEvent.setup();
    render(<SecurityHistoryView open onClose={vi.fn()} />);

    const checkboxes = await screen.findAllByRole('checkbox');
    expect(checkboxes).toHaveLength(3);

    await user.click(checkboxes[0]);
    await user.click(checkboxes[1]);
    await user.click(checkboxes[2]);

    expect(screen.getByRole('button', { name: /Compare \(2\/2\)/ })).toBeEnabled();
    expect(checkboxes[0].getAttribute('aria-checked')).toBe('false');
    expect(checkboxes[1].getAttribute('aria-checked')).toBe('true');
    expect(checkboxes[2].getAttribute('aria-checked')).toBe('true');
  });

  it('passes older scan as baseline and newer as current on compare', async () => {
    mockedFetch.mockResolvedValue(
      listResponse([
        scan({ id: 10, scanned_at: 3000 }),
        scan({ id: 20, scanned_at: 1000 }),
      ]),
    );
    const user = userEvent.setup();
    render(<SecurityHistoryView open onClose={vi.fn()} />);

    const checkboxes = await screen.findAllByRole('checkbox');
    await user.click(checkboxes[0]);
    await user.click(checkboxes[1]);

    await user.click(screen.getByRole('button', { name: /Compare \(2\/2\)/ }));

    const last = compareProps.at(-1);
    expect(last?.baselineScanId).toBe(20);
    expect(last?.currentScanId).toBe(10);
  });

  it('does not fetch when closed', async () => {
    mockedFetch.mockResolvedValue(listResponse([scan()]));
    render(<SecurityHistoryView open={false} onClose={vi.fn()} />);

    // Flush any microtasks; the fetch guard returns synchronously so no
    // timer delay is required.
    await Promise.resolve();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('fires onClose when Escape is pressed and does not fetch again', async () => {
    mockedFetch.mockResolvedValue(listResponse([scan()]));
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<SecurityHistoryView open onClose={onClose} />);

    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(1));
    await user.keyboard('{Escape}');

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('shows Compare button for community tier (scan compare is Community per PR #930)', async () => {
    licenseState.isPaid = false;
    mockedFetch.mockResolvedValue(
      listResponse([
        scan({ id: 1, scanned_at: 1000 }),
        scan({ id: 2, scanned_at: 2000 }),
      ]),
    );
    const user = userEvent.setup();
    render(<SecurityHistoryView open onClose={vi.fn()} />);

    const checkboxes = await screen.findAllByRole('checkbox');
    await user.click(checkboxes[0]);
    await user.click(checkboxes[1]);

    expect(screen.getByRole('button', { name: /Compare \(2\/2\)/ })).toBeEnabled();
  });

  it('renders the cap hint only for images flagged in cappedImageRefs', async () => {
    mockedFetch.mockResolvedValue(
      listResponse(
        [
          scan({ id: 1, image_ref: 'hot:latest', scanned_at: 1000 }),
          scan({ id: 2, image_ref: 'cool:latest', scanned_at: 2000 }),
        ],
        { cappedImageRefs: ['hot:latest'], perImageLimit: 50 },
      ),
    );
    render(<SecurityHistoryView open onClose={vi.fn()} />);

    const cappedHint = await screen.findByText(/Capped at 50 . older scans pruned/);
    expect(cappedHint).toBeInTheDocument();
    expect(screen.queryAllByText(/Capped at 50/)).toHaveLength(1);
  });
});
