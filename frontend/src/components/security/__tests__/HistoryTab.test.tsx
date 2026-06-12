/**
 * HistoryTab is the inline scan-history table that replaced the history sheet.
 * Locks: completed-scan fetch on mount with pagination params, Open -> inspect
 * on the vulns tab, two-scan compare capped at two with oldest-first baseline
 * ordering, search-by-image, and the load-failure error state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { VulnerabilityScan } from '@/types/security';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

const nodesState: { activeNode: { id: number } | null } = { activeNode: { id: 1 } };
vi.mock('@/context/NodeContext', () => ({ useNodes: () => nodesState }));

const compareProps: { baselineScanId: number | null; currentScanId: number | null }[] = [];
vi.mock('../../ScanComparisonSheet', () => ({
  ScanComparisonSheet: (props: { baselineScanId: number | null; currentScanId: number | null }) => {
    compareProps.push({ baselineScanId: props.baselineScanId, currentScanId: props.currentScanId });
    return null;
  },
}));
vi.mock('../../VulnerabilityScanSheet', () => ({
  SeverityChip: ({ severity }: { severity: string }) => <span>{severity}</span>,
}));

import { apiFetch } from '@/lib/api';
import { HistoryTab } from '../HistoryTab';

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

function listResponse(items: VulnerabilityScan[], total?: number): Response {
  return { ok: true, status: 200, json: async () => ({ items, total: total ?? items.length }) } as unknown as Response;
}

beforeEach(() => {
  mockedFetch.mockReset();
  compareProps.length = 0;
  nodesState.activeNode = { id: 1 };
});

afterEach(() => vi.clearAllMocks());

describe('HistoryTab', () => {
  it('fetches completed scans on mount with pagination params', async () => {
    mockedFetch.mockResolvedValue(listResponse([scan({ image_ref: 'alpine:3.19' })]));
    render(<HistoryTab onInspect={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('alpine:3.19')).toBeInTheDocument());
    const url = mockedFetch.mock.calls[0][0] as string;
    expect(url).toContain('/security/scans?');
    expect(url).toContain('status=completed');
    expect(url).toContain('limit=100');
    expect(url).toContain('offset=0');
  });

  it('opens the scan sheet on the vulns tab from Open', async () => {
    const onInspect = vi.fn();
    mockedFetch.mockResolvedValue(listResponse([scan({ id: 42, image_ref: 'nginx:1' })]));
    render(<HistoryTab onInspect={onInspect} />);
    await waitFor(() => expect(screen.getByText('nginx:1')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(onInspect).toHaveBeenCalledWith(42, 'vulns');
  });

  it('compares two scans with the older as baseline and newer as current', async () => {
    const older = scan({ id: 10, image_ref: 'a:1', scanned_at: 1000 });
    const newer = scan({ id: 20, image_ref: 'b:1', scanned_at: 2000 });
    mockedFetch.mockResolvedValue(listResponse([newer, older]));
    render(<HistoryTab onInspect={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('a:1')).toBeInTheDocument());
    const checks = screen.getAllByLabelText('Select scan to compare');
    await userEvent.click(checks[0]);
    await userEvent.click(checks[1]);
    await userEvent.click(screen.getByRole('button', { name: /Compare/ }));
    const last = compareProps[compareProps.length - 1];
    expect(last.baselineScanId).toBe(10);
    expect(last.currentScanId).toBe(20);
  });

  it('caps the compare selection at two', async () => {
    mockedFetch.mockResolvedValue(listResponse([
      scan({ id: 1, image_ref: 'a:1', scanned_at: 3000 }),
      scan({ id: 2, image_ref: 'b:1', scanned_at: 2000 }),
      scan({ id: 3, image_ref: 'c:1', scanned_at: 1000 }),
    ]));
    render(<HistoryTab onInspect={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('a:1')).toBeInTheDocument());
    const checks = screen.getAllByLabelText('Select scan to compare');
    await userEvent.click(checks[0]);
    await userEvent.click(checks[1]);
    await userEvent.click(checks[2]);
    expect(screen.getByRole('button', { name: /Compare \(2\/2\)/ })).toBeInTheDocument();
  });

  it('searches by image as you type (no Enter), adding imageRefLike to the request', async () => {
    mockedFetch.mockResolvedValue(listResponse([scan({ image_ref: 'alpine:3.19' })]));
    render(<HistoryTab onInspect={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('alpine:3.19')).toBeInTheDocument());
    await userEvent.type(screen.getByPlaceholderText('Search by image...'), 'redis');
    await waitFor(() => {
      const calls = mockedFetch.mock.calls.map((c) => c[0] as string);
      expect(calls.some((u) => u.includes('imageRefLike=redis'))).toBe(true);
    });
  });

  it('renders the error state when the load fails', async () => {
    mockedFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as unknown as Response);
    render(<HistoryTab onInspect={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/Couldn't load scan history/)).toBeInTheDocument());
  });

  it('treats a malformed 200 response (no items array) as an error, not an empty list', async () => {
    mockedFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ oops: true }) } as unknown as Response);
    render(<HistoryTab onInspect={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/Couldn't load scan history/)).toBeInTheDocument());
    expect(screen.queryByText(/No completed scans yet/)).not.toBeInTheDocument();
  });
});
