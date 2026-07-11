/**
 * Coverage for ScanComparisonSheet.
 *
 * Locks the Sheet's data-path behavior: loading, error recovery, cross-image
 * warning, filter pills, pagination clamp, and empty states. Complements the
 * backend compare handler tests by guarding the frontend rendering contract.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

const toastError = vi.fn();
vi.mock('@/components/ui/toast-store', () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  },
}));

vi.mock('../VulnerabilityScanSheet', () => ({
  SeverityChip: ({ severity }: { severity: string }) => (
    <span data-testid="severity-chip">{severity}</span>
  ),
  VulnerabilityScanSheet: () => null,
}));

import { apiFetch } from '@/lib/api';
import { ScanComparisonSheet } from '../ScanComparisonSheet';
import type { ScanCompareResult, ScanCompareVulnerability } from '@/types/security';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

function vuln(overrides: Partial<ScanCompareVulnerability> = {}): ScanCompareVulnerability {
  return {
    vulnerability_id: 'CVE-2024-0001',
    pkg_name: 'openssl',
    severity: 'HIGH',
    suppressed: false,
    ...overrides,
  };
}

function result(overrides: Partial<ScanCompareResult> = {}): ScanCompareResult {
  return {
    scanA: { id: 1, image_ref: 'alpine:3.18', scanned_at: 1_700_000_000_000 },
    scanB: { id: 2, image_ref: 'alpine:3.18', scanned_at: 1_700_000_010_000 },
    added: [],
    removed: [],
    unchanged: [],
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  mockedFetch.mockReset();
  toastError.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('ScanComparisonSheet', () => {
  it('renders nothing when scan ids are null', () => {
    const { container } = render(
      <ScanComparisonSheet baselineScanId={null} currentScanId={null} onClose={() => {}} />,
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('shows cross-image warning when scan image refs differ', async () => {
    mockedFetch.mockResolvedValueOnce(
      jsonResponse(200, result({
        scanB: { id: 2, image_ref: 'alpine:3.19', scanned_at: 1_700_000_010_000 },
      })),
    );

    render(<ScanComparisonSheet baselineScanId={1} currentScanId={2} onClose={() => {}} />);

    await waitFor(() =>
      expect(screen.getByText(/different image identities/i)).toBeInTheDocument(),
    );
  });

  it('does not show cross-image warning for same image refs', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse(200, result()));

    render(<ScanComparisonSheet baselineScanId={1} currentScanId={2} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText(/Baseline/i)).toBeInTheDocument());
    expect(screen.queryByText(/different image identities/i)).toBeNull();
  });

  it('shows cross-image warning when digests differ for the same tag', async () => {
    mockedFetch.mockResolvedValueOnce(
      jsonResponse(200, result({
        scanA: { id: 1, image_ref: 'app:latest', scanned_at: 1, image_digest: 'sha256:aaa' },
        scanB: { id: 2, image_ref: 'app:latest', scanned_at: 2, image_digest: 'sha256:bbb' },
      })),
    );

    render(<ScanComparisonSheet baselineScanId={1} currentScanId={2} onClose={() => {}} />);

    await waitFor(() =>
      expect(screen.getByText(/different image identities/i)).toBeInTheDocument(),
    );
  });

  it('surfaces a toast and closes the sheet on fetch error', async () => {
    const onClose = vi.fn();
    mockedFetch.mockResolvedValueOnce(jsonResponse(500, { error: 'boom' }));

    render(<ScanComparisonSheet baselineScanId={1} currentScanId={2} onClose={onClose} />);

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('boom'));
    expect(onClose).toHaveBeenCalled();
  });

  it('switches the visible rows when a filter pill is clicked', async () => {
    mockedFetch.mockResolvedValueOnce(
      jsonResponse(200, result({
        added: [vuln({ vulnerability_id: 'CVE-A', pkg_name: 'pa' })],
        removed: [vuln({ vulnerability_id: 'CVE-R', pkg_name: 'pr' })],
        unchanged: [vuln({ vulnerability_id: 'CVE-U', pkg_name: 'pu' })],
      })),
    );

    const user = userEvent.setup();
    render(<ScanComparisonSheet baselineScanId={1} currentScanId={2} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText('CVE-A')).toBeInTheDocument());
    expect(screen.queryByText('CVE-R')).toBeNull();

    await user.click(screen.getByRole('button', { name: /Removed \(1\)/ }));
    expect(screen.getByText('CVE-R')).toBeInTheDocument();
    expect(screen.queryByText('CVE-A')).toBeNull();

    await user.click(screen.getByRole('button', { name: /Unchanged \(1\)/ }));
    expect(screen.getByText('CVE-U')).toBeInTheDocument();
  });

  it('renders a bucket-specific empty state message', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse(200, result()));

    render(<ScanComparisonSheet baselineScanId={1} currentScanId={2} onClose={() => {}} />);

    await waitFor(() =>
      expect(screen.getByText(/Nothing regressed between these scans/i)).toBeInTheDocument(),
    );
  });

  it('renders the truncation banner when the response flags truncated', async () => {
    mockedFetch.mockResolvedValueOnce(
      jsonResponse(200, result({ truncated: true, row_limit: 1000 })),
    );

    render(<ScanComparisonSheet baselineScanId={1} currentScanId={2} onClose={() => {}} />);

    await waitFor(() =>
      expect(screen.getByText(/first 1000 findings per scan/i)).toBeInTheDocument(),
    );
  });

  it('hides the truncation banner when truncated is false', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse(200, result({ truncated: false })));

    render(<ScanComparisonSheet baselineScanId={1} currentScanId={2} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText(/Baseline/i)).toBeInTheDocument());
    expect(screen.queryByText(/findings per scan/i)).toBeNull();
  });

  it('relabels the unchanged bucket as "Shared" for cross-image comparisons', async () => {
    mockedFetch.mockResolvedValueOnce(
      jsonResponse(200, result({
        scanB: { id: 2, image_ref: 'alpine:3.19', scanned_at: 1_700_000_010_000 },
        unchanged: [vuln({ vulnerability_id: 'CVE-U', pkg_name: 'pu' })],
      })),
    );

    const user = userEvent.setup();
    render(<ScanComparisonSheet baselineScanId={1} currentScanId={2} onClose={() => {}} />);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Shared \(1\)/ })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: /Unchanged/ })).toBeNull();

    await user.click(screen.getByRole('button', { name: /Shared \(1\)/ }));
    expect(screen.getByText('Shared')).toBeInTheDocument();
  });

  it('keeps the "Unchanged" label when both scans use the same image', async () => {
    mockedFetch.mockResolvedValueOnce(
      jsonResponse(200, result({
        unchanged: [vuln({ vulnerability_id: 'CVE-U', pkg_name: 'pu' })],
      })),
    );

    render(<ScanComparisonSheet baselineScanId={1} currentScanId={2} onClose={() => {}} />);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Unchanged \(1\)/ })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: /Shared/ })).toBeNull();
  });

  it('rewrites CVE primary_url to cve.org for CVE IDs', async () => {
    mockedFetch.mockResolvedValueOnce(
      jsonResponse(200, result({
        added: [vuln({
          vulnerability_id: 'CVE-2024-1234',
          primary_url: 'https://avd.aquasec.com/nvd/CVE-2024-1234',
        })],
      })),
    );

    render(<ScanComparisonSheet baselineScanId={1} currentScanId={2} onClose={() => {}} />);

    const link = await screen.findByRole('link', { name: 'CVE-2024-1234' });
    expect(link).toHaveAttribute(
      'href',
      'https://www.cve.org/CVERecord?id=CVE-2024-1234',
    );
  });

  it('tags CRITICAL net-positive delta chip with destructive tone', async () => {
    mockedFetch.mockResolvedValueOnce(
      jsonResponse(200, result({
        added: [vuln({ vulnerability_id: 'CVE-C', severity: 'CRITICAL' })],
      })),
    );

    render(<ScanComparisonSheet baselineScanId={1} currentScanId={2} onClose={() => {}} />);

    const chip = await screen.findByLabelText('CRITICAL delta +1');
    expect(chip).toHaveAttribute('data-tone', 'destructive');
  });

  it('tags HIGH net-positive delta chip with warning tone (not destructive)', async () => {
    mockedFetch.mockResolvedValueOnce(
      jsonResponse(200, result({
        added: [vuln({ vulnerability_id: 'CVE-H', severity: 'HIGH' })],
      })),
    );

    render(<ScanComparisonSheet baselineScanId={1} currentScanId={2} onClose={() => {}} />);

    const chip = await screen.findByLabelText('HIGH delta +1');
    expect(chip).toHaveAttribute('data-tone', 'warning');
  });

  it('reloads when the scan ids change', async () => {
    mockedFetch.mockResolvedValue(jsonResponse(200, result()));

    const { rerender } = render(
      <ScanComparisonSheet baselineScanId={1} currentScanId={2} onClose={() => {}} />,
    );

    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(1));

    await act(async () => {
      rerender(<ScanComparisonSheet baselineScanId={3} currentScanId={4} onClose={() => {}} />);
    });

    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(2));
    expect(mockedFetch).toHaveBeenLastCalledWith('/security/compare?scanId1=3&scanId2=4');
  });
});
