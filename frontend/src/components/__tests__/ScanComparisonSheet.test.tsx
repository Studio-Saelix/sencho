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
import { DURATION_BASE_MS } from '@/hooks/useVisualBusy';
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
    expect(screen.getByText('CVE-U')).toBeInTheDocument();
    expect(screen.queryByText('Status')).toBeNull();
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

  describe('the Answer', () => {
    async function answer() {
      return screen.findByTestId('status-answer');
    }

    function show(res: ScanCompareResult) {
      mockedFetch.mockResolvedValueOnce(jsonResponse(200, res));
      return render(<ScanComparisonSheet baselineScanId={1} currentScanId={2} onClose={() => {}} />);
    }

    it('reads a net-new CRITICAL as destructive', async () => {
      show(result({ added: [vuln({ vulnerability_id: 'CVE-C', severity: 'CRITICAL' })] }));

      const el = await answer();
      expect(el).toHaveAttribute('data-tone', 'destructive');
      expect(el).toHaveTextContent('Regressed');
      expect(el).toHaveTextContent('Net change: +1 critical.');
    });

    it('judges CRITICAL by the net, not by what was added', async () => {
      show(result({
        added: [vuln({ vulnerability_id: 'CVE-C1', severity: 'CRITICAL' }), vuln({ vulnerability_id: 'CVE-H1', severity: 'HIGH' })],
        removed: [vuln({ vulnerability_id: 'CVE-C2', severity: 'CRITICAL' })],
      }));

      const el = await answer();
      expect(el).toHaveAttribute('data-tone', 'warning');
      expect(el).toHaveTextContent('Net change: +1 high. 1 new critical.');
    });

    it('stays destructive for a net-new CRITICAL even when a HIGH was resolved', async () => {
      show(result({
        added: [vuln({ vulnerability_id: 'CVE-C', severity: 'CRITICAL' })],
        removed: [vuln({ vulnerability_id: 'CVE-H', severity: 'HIGH' })],
      }));

      const el = await answer();
      expect(el).toHaveAttribute('data-tone', 'destructive');
      expect(el).toHaveTextContent('Net change: +1 critical, -1 high.');
    });

    it.each([
      ['HIGH', 'high'],
      ['MEDIUM', 'medium'],
      ['LOW', 'low'],
    ] as const)('reads a net increase of only %s as a warning', async (severity, word) => {
      show(result({ added: [vuln({ vulnerability_id: 'CVE-1', severity }), vuln({ vulnerability_id: 'CVE-2', severity })] }));

      const el = await answer();
      expect(el).toHaveAttribute('data-tone', 'warning');
      expect(el).toHaveTextContent(`Net change: +2 ${word}.`);
    });

    it('counts UNKNOWN findings, so a change in them is never reported as no change', async () => {
      show(result({ added: [vuln({ vulnerability_id: 'CVE-U', severity: 'UNKNOWN' })] }));

      const el = await answer();
      expect(el).toHaveAttribute('data-tone', 'warning');
      expect(el).toHaveTextContent('Net change: +1 unknown.');
    });

    it('lists every changed severity in CRITICAL to UNKNOWN order', async () => {
      show(result({
        added: [
          vuln({ vulnerability_id: 'CVE-U', severity: 'UNKNOWN' }),
          vuln({ vulnerability_id: 'CVE-L', severity: 'LOW' }),
          vuln({ vulnerability_id: 'CVE-M', severity: 'MEDIUM' }),
          vuln({ vulnerability_id: 'CVE-H', severity: 'HIGH' }),
          vuln({ vulnerability_id: 'CVE-C', severity: 'CRITICAL' }),
        ],
      }));

      expect(await answer()).toHaveTextContent('Net change: +1 critical, +1 high, +1 medium, +1 low, +1 unknown.');
    });

    it('reads resolved findings as an improvement', async () => {
      show(result({ removed: [vuln({ vulnerability_id: 'CVE-R', severity: 'HIGH' }), vuln({ vulnerability_id: 'CVE-R2', severity: 'HIGH' })] }));

      const el = await answer();
      expect(el).toHaveAttribute('data-tone', 'success');
      expect(el).toHaveTextContent('Improved');
      expect(el).toHaveTextContent('Net change: -2 high.');
    });

    it('reads a new CRITICAL inside an improving diff as mixed and names it', async () => {
      show(result({
        added: [vuln({ vulnerability_id: 'CVE-NEW', severity: 'CRITICAL' })],
        removed: [
          vuln({ vulnerability_id: 'CVE-OLD', severity: 'CRITICAL' }),
          vuln({ vulnerability_id: 'CVE-H1', severity: 'HIGH' }),
          vuln({ vulnerability_id: 'CVE-H2', severity: 'HIGH' }),
        ],
      }));

      const el = await screen.findByTestId('status-answer');
      expect(el).toHaveAttribute('data-tone', 'warning');
      expect(el).toHaveTextContent('Mixed');
      expect(el).toHaveTextContent('Net change: -2 high. 1 new critical.');
    });

    it('reads decreases across severities as an improvement', async () => {
      show(result({
        removed: [vuln({ vulnerability_id: 'CVE-C', severity: 'CRITICAL' }), vuln({ vulnerability_id: 'CVE-L1', severity: 'LOW' }), vuln({ vulnerability_id: 'CVE-L2', severity: 'LOW' })],
      }));

      const el = await answer();
      expect(el).toHaveAttribute('data-tone', 'success');
      expect(el).toHaveTextContent('Net change: -1 critical, -2 low.');
    });

    it('names a new HIGH hidden inside an improving diff and reads it as mixed', async () => {
      show(result({
        added: [vuln({ vulnerability_id: 'CVE-H1', severity: 'HIGH' }), vuln({ vulnerability_id: 'CVE-H2', severity: 'HIGH' })],
        removed: [
          vuln({ vulnerability_id: 'CVE-H3', severity: 'HIGH' }),
          vuln({ vulnerability_id: 'CVE-H4', severity: 'HIGH' }),
          vuln({ vulnerability_id: 'CVE-L', severity: 'LOW' }),
        ],
      }));

      const el = await answer();
      expect(el).toHaveAttribute('data-tone', 'warning');
      expect(el).toHaveTextContent('Mixed');
      expect(el).toHaveTextContent('Net change: -1 low. 2 new high.');
    });

    it('names a new CRITICAL that a larger resolved count hides while something else rises', async () => {
      show(result({
        added: [vuln({ vulnerability_id: 'CVE-C1', severity: 'CRITICAL' }), vuln({ vulnerability_id: 'CVE-C2', severity: 'CRITICAL' }), vuln({ vulnerability_id: 'CVE-L', severity: 'LOW' })],
        removed: [vuln({ vulnerability_id: 'CVE-C3', severity: 'CRITICAL' }), vuln({ vulnerability_id: 'CVE-C4', severity: 'CRITICAL' }), vuln({ vulnerability_id: 'CVE-C5', severity: 'CRITICAL' })],
      }));

      const el = await answer();
      expect(el).toHaveAttribute('data-tone', 'warning');
      expect(el).toHaveTextContent('Regressed');
      expect(el).toHaveTextContent('Net change: -1 critical, +1 low. 2 new critical.');
    });

    it('counts decreases in MEDIUM and UNKNOWN as an improvement', async () => {
      show(result({ removed: [vuln({ vulnerability_id: 'CVE-M', severity: 'MEDIUM' }), vuln({ vulnerability_id: 'CVE-U', severity: 'UNKNOWN' })] }));

      const el = await answer();
      expect(el).toHaveAttribute('data-tone', 'success');
      expect(el).toHaveTextContent('Net change: -1 medium, -1 unknown.');
    });

    it('lists only the severities that changed and keeps the worst tone when they mix', async () => {
      show(result({
        added: [vuln({ vulnerability_id: 'CVE-H', severity: 'HIGH' })],
        removed: [vuln({ vulnerability_id: 'CVE-L', severity: 'LOW' })],
      }));

      const el = await answer();
      expect(el).toHaveAttribute('data-tone', 'warning');
      expect(el).toHaveTextContent('Net change: +1 high, -1 low.');
      expect(el).not.toHaveTextContent(/medium|critical/i);
    });

    it('says how many came and went when the nets cancel, instead of claiming nothing changed', async () => {
      show(result({
        added: [vuln({ vulnerability_id: 'CVE-A', severity: 'MEDIUM' })],
        removed: [vuln({ vulnerability_id: 'CVE-B', severity: 'MEDIUM' })],
      }));

      const el = await answer();
      expect(el).toHaveAttribute('data-tone', 'neutral');
      expect(el).toHaveTextContent('No net change');
      expect(el).toHaveTextContent('1 added, 1 removed.');
      expect(el).not.toHaveTextContent('No findings changed');
    });

    it('warns when a swap brings in a new CRITICAL', async () => {
      show(result({
        added: [vuln({ vulnerability_id: 'CVE-A', severity: 'CRITICAL' })],
        removed: [vuln({ vulnerability_id: 'CVE-B', severity: 'CRITICAL' })],
      }));

      const el = await answer();
      expect(el).toHaveAttribute('data-tone', 'warning');
      expect(el).toHaveTextContent('1 added, 1 removed. 1 new critical.');
    });

    it('names a new HIGH that a larger resolved HIGH count hides, and reads it as mixed', async () => {
      show(result({
        added: [vuln({ vulnerability_id: 'CVE-H1', severity: 'HIGH' }), vuln({ vulnerability_id: 'CVE-H2', severity: 'HIGH' })],
        removed: [
          vuln({ vulnerability_id: 'CVE-H3', severity: 'HIGH' }),
          vuln({ vulnerability_id: 'CVE-H4', severity: 'HIGH' }),
          vuln({ vulnerability_id: 'CVE-H5', severity: 'HIGH' }),
          vuln({ vulnerability_id: 'CVE-L', severity: 'LOW' }),
        ],
      }));

      const el = await answer();
      expect(el).toHaveAttribute('data-tone', 'warning');
      expect(el).toHaveTextContent('Mixed');
      expect(el).toHaveTextContent('Net change: -1 high, -1 low. 2 new high.');
    });

    it('names a hidden HIGH even beside a net-new CRITICAL', async () => {
      show(result({
        added: [vuln({ vulnerability_id: 'CVE-C', severity: 'CRITICAL' }), vuln({ vulnerability_id: 'CVE-H1', severity: 'HIGH' })],
        removed: [vuln({ vulnerability_id: 'CVE-H2', severity: 'HIGH' })],
      }));

      const el = await answer();
      expect(el).toHaveAttribute('data-tone', 'destructive');
      expect(el).toHaveTextContent('Net change: +1 critical. 1 new high.');
    });

    it('counts an UNKNOWN swap as findings that came and went', async () => {
      show(result({
        added: [vuln({ vulnerability_id: 'CVE-U1', severity: 'UNKNOWN' })],
        removed: [vuln({ vulnerability_id: 'CVE-U2', severity: 'UNKNOWN' })],
      }));

      const el = await answer();
      expect(el).toHaveAttribute('data-tone', 'neutral');
      expect(el).toHaveTextContent('1 added, 1 removed.');
      expect(el).not.toHaveTextContent('No findings changed');
    });

    it('warns when a swap brings in a HIGH too', async () => {
      show(result({
        added: [vuln({ vulnerability_id: 'CVE-A', severity: 'HIGH' })],
        removed: [vuln({ vulnerability_id: 'CVE-B', severity: 'HIGH' })],
      }));

      const el = await answer();
      expect(el).toHaveAttribute('data-tone', 'warning');
      expect(el).toHaveTextContent('1 added, 1 removed. 1 new high.');
    });

    it('says plainly that nothing changed, with no tone', async () => {
      show(result());

      const el = await answer();
      expect(el).toHaveAttribute('data-tone', 'neutral');
      expect(el).toHaveTextContent('No net change');
      expect(el).toHaveTextContent('No findings changed.');
    });

    it('carries the cross-image caveat inside the Answer, once', async () => {
      show(result({ scanB: { id: 2, image_ref: 'alpine:3.19', scanned_at: 1_700_000_010_000 } }));

      expect(await screen.findByTestId('status-answer-detail')).toHaveTextContent(/two different image identities/i);
      expect(screen.getAllByTestId('status-answer')).toHaveLength(1);
      expect(screen.getAllByText(/two different image identities/i)).toHaveLength(1);
    });

    it('does not show the caveat for the same image', async () => {
      show(result());

      await answer();
      expect(screen.queryByTestId('status-answer-detail')).toBeNull();
    });

    it('flags a truncated comparison with a marker on the Answer, naming the limit, and not otherwise', async () => {
      const { unmount } = show(result({ truncated: true, row_limit: 500 }));

      expect(await screen.findByTestId('status-marker')).toHaveTextContent(/first 500 findings per scan/i);
      expect(screen.getByTestId('status-marker')).toHaveTextContent(/may be incomplete/i);
      unmount();

      show(result({ truncated: false }));
      await answer();
      expect(screen.queryByTestId('status-marker')).toBeNull();
    });

    it('falls back to the default row limit when the response omits it', async () => {
      show(result({ truncated: true }));

      expect(await screen.findByTestId('status-marker')).toHaveTextContent(/first 1000 findings per scan/i);
    });

    it('does not call a truncated comparison an improvement, in word or in tone', async () => {
      show(result({ truncated: true, row_limit: 1000, removed: [vuln({ vulnerability_id: 'CVE-R', severity: 'HIGH' })] }));

      const el = await answer();
      expect(el).toHaveTextContent('Fewer findings');
      expect(el).not.toHaveTextContent('Improved');
      expect(el).toHaveAttribute('data-tone', 'neutral');
      expect(el).toHaveTextContent('Net change: -1 high.');
    });

    it('does not claim nothing changed when the comparison was truncated, and names the limit', async () => {
      show(result({ truncated: true, row_limit: 750 }));

      const el = await answer();
      expect(el).toHaveAttribute('data-tone', 'neutral');
      expect(el).toHaveTextContent('No change in the first 750 findings.');
      expect(el).not.toHaveTextContent('No findings changed.');
    });

    it.each<[string, Partial<ScanCompareResult>, string]>([
      ['a net-new HIGH', { added: [vuln({ vulnerability_id: 'CVE-H', severity: 'HIGH' })] }, 'warning'],
      ['a swap that brings in a HIGH', {
        added: [vuln({ vulnerability_id: 'CVE-H1', severity: 'HIGH' })],
        removed: [vuln({ vulnerability_id: 'CVE-H2', severity: 'HIGH' })],
      }, 'warning'],
      ['a new CRITICAL inside an improvement', {
        added: [vuln({ vulnerability_id: 'CVE-C1', severity: 'CRITICAL' })],
        removed: [vuln({ vulnerability_id: 'CVE-C2', severity: 'CRITICAL' }), vuln({ vulnerability_id: 'CVE-L', severity: 'LOW' })],
      }, 'warning'],
      ['a swap of lower severities', {
        added: [vuln({ vulnerability_id: 'CVE-M1', severity: 'MEDIUM' })],
        removed: [vuln({ vulnerability_id: 'CVE-M2', severity: 'MEDIUM' })],
      }, 'neutral'],
    ])('keeps the tone for %s when the comparison is truncated', async (_name, over, tone) => {
      show(result({ truncated: true, row_limit: 1000, ...over }));

      expect(await answer()).toHaveAttribute('data-tone', tone);
    });

    it('keeps the Mixed reading, not just its tone, when the comparison is truncated', async () => {
      show(result({
        truncated: true,
        row_limit: 1000,
        added: [vuln({ vulnerability_id: 'CVE-C1', severity: 'CRITICAL' })],
        removed: [vuln({ vulnerability_id: 'CVE-C2', severity: 'CRITICAL' }), vuln({ vulnerability_id: 'CVE-L', severity: 'LOW' })],
      }));

      const el = await answer();
      expect(el).toHaveTextContent('Mixed');
      expect(el).not.toHaveTextContent('Fewer findings');
    });

    it('names the default row limit in the no-change reading when the response omits it', async () => {
      show(result({ truncated: true }));

      expect(await answer()).toHaveTextContent('No change in the first 1000 findings.');
    });

    it('announces a truncated comparison as an alert', async () => {
      const { unmount } = show(result({ truncated: true, row_limit: 1000 }));
      expect(await screen.findByRole('alert')).toHaveTextContent(/partial/i);
      unmount();

      show(result());
      await answer();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('keeps a regression loud when the comparison is truncated', async () => {
      show(result({ truncated: true, row_limit: 1000, added: [vuln({ vulnerability_id: 'CVE-C', severity: 'CRITICAL' })] }));

      expect(await answer()).toHaveAttribute('data-tone', 'destructive');
    });
  });

  describe('each fact once', () => {
    it('names the two scans once, keeps counts off the header, and drops the per-row status', async () => {
      mockedFetch.mockResolvedValueOnce(
        jsonResponse(200, result({
          scanA: { id: 7, image_ref: 'api:1.4.0', scanned_at: 1_700_000_000_000 },
          scanB: { id: 9, image_ref: 'api:1.5.0', scanned_at: 1_700_000_010_000 },
          added: [vuln({ vulnerability_id: 'CVE-A', severity: 'HIGH' })],
          removed: [vuln({ vulnerability_id: 'CVE-B', severity: 'LOW' })],
        })),
      );

      render(<ScanComparisonSheet baselineScanId={7} currentScanId={9} onClose={() => {}} />);

      await screen.findByText('CVE-A');
      expect(screen.getAllByText(/api:1\.4\.0/)).toHaveLength(1);
      expect(screen.getAllByText(/api:1\.5\.0/)).toHaveLength(1);
      expect(screen.getByText('#7 → #9')).toBeInTheDocument();
      expect(screen.queryByText(/\+1 −1/)).toBeNull();
      expect(screen.queryByText('Status')).toBeNull();
      expect(screen.queryByText(/Findings · added/i)).toBeNull();
      expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['CVE', 'Package', 'Severity']);
      expect(screen.getByText('Findings')).toBeInTheDocument();
    });
  });

  describe('loading', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('shows the loading skeleton only after the busy delay, with no spinner', async () => {
      vi.useFakeTimers();
      mockedFetch.mockReturnValueOnce(new Promise(() => {}));

      render(<ScanComparisonSheet baselineScanId={1} currentScanId={2} onClose={() => {}} />);
      expect(screen.queryByTestId('scan-diff-skeleton')).toBeNull();

      await act(async () => { vi.advanceTimersByTime(DURATION_BASE_MS + 50); });

      const skeleton = screen.getByTestId('scan-diff-skeleton');
      expect(skeleton).toHaveAttribute('aria-busy', 'true');
      expect(skeleton).toHaveAttribute('aria-label', 'Loading comparison');
      expect(document.querySelector('.animate-spin')).toBeNull();
    });

    it('never flashes the skeleton when the response is fast', async () => {
      vi.useFakeTimers();
      mockedFetch.mockResolvedValueOnce(jsonResponse(200, result()));

      render(<ScanComparisonSheet baselineScanId={1} currentScanId={2} onClose={() => {}} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(DURATION_BASE_MS - 40); });

      expect(screen.getByTestId('status-answer')).toBeInTheDocument();
      expect(screen.queryByTestId('scan-diff-skeleton')).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
      expect(screen.queryByTestId('scan-diff-skeleton')).toBeNull();
    });

    it('swaps the skeleton for the result once the response lands', async () => {
      vi.useFakeTimers();
      let resolve!: (r: Response) => void;
      mockedFetch.mockReturnValueOnce(new Promise<Response>((r) => { resolve = r; }));

      render(<ScanComparisonSheet baselineScanId={1} currentScanId={2} onClose={() => {}} />);
      await act(async () => { vi.advanceTimersByTime(DURATION_BASE_MS + 50); });
      expect(screen.getByTestId('scan-diff-skeleton')).toBeInTheDocument();

      await act(async () => { resolve(jsonResponse(200, result())); });

      expect(screen.getByTestId('status-answer')).toBeInTheDocument();
      expect(screen.queryByTestId('scan-diff-skeleton')).toBeNull();
    });

    it('clears the old result, shows the skeleton again and resets the filter when the scans change', async () => {
      vi.useFakeTimers();
      mockedFetch.mockResolvedValueOnce(jsonResponse(200, result({
        added: [vuln({ vulnerability_id: 'CVE-OLD-ADDED', severity: 'HIGH' })],
        removed: [vuln({ vulnerability_id: 'CVE-OLD-REMOVED', severity: 'HIGH' })],
      })));

      const { rerender } = render(<ScanComparisonSheet baselineScanId={1} currentScanId={2} onClose={() => {}} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      await act(async () => { screen.getByRole('button', { name: /Removed \(1\)/ }).click(); });
      expect(screen.getByText('CVE-OLD-REMOVED')).toBeInTheDocument();

      let resolve!: (r: Response) => void;
      mockedFetch.mockReturnValueOnce(new Promise<Response>((r) => { resolve = r; }));
      await act(async () => { rerender(<ScanComparisonSheet baselineScanId={3} currentScanId={4} onClose={() => {}} />); });

      expect(screen.queryByText('CVE-OLD-REMOVED')).toBeNull();
      expect(screen.queryByTestId('status-answer')).toBeNull();
      expect(screen.queryByText('#1 → #2')).toBeNull();
      expect(screen.getByText('Loading…')).toBeInTheDocument();
      await act(async () => { vi.advanceTimersByTime(DURATION_BASE_MS + 50); });
      expect(screen.getByTestId('scan-diff-skeleton')).toBeInTheDocument();

      await act(async () => { resolve(jsonResponse(200, result({ added: [vuln({ vulnerability_id: 'CVE-NEW-ADDED', severity: 'HIGH' })] }))); });
      expect(screen.getByText('CVE-NEW-ADDED')).toBeInTheDocument();
    });
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

  it('does not refetch when the parent re-renders with a new onClose identity', async () => {
    mockedFetch.mockResolvedValue(jsonResponse(200, result()));

    const { rerender } = render(
      <ScanComparisonSheet baselineScanId={1} currentScanId={2} onClose={() => {}} />,
    );
    await waitFor(() => expect(screen.getByText(/Baseline/i)).toBeInTheDocument());

    rerender(<ScanComparisonSheet baselineScanId={1} currentScanId={2} onClose={() => {}} />);
    rerender(<ScanComparisonSheet baselineScanId={1} currentScanId={2} onClose={() => {}} />);

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Baseline/i)).toBeInTheDocument();
  });
});
