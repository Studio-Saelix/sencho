/**
 * ImagesTab is a prop-driven index over the node's image-scan summaries. It
 * filters out stack/config scans, supports search + a severity filter, opens
 * the scan sheet from the image name and the Findings cell, and exposes inline
 * scan actions only when the caller can scan.
 */
import { it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ImagesTab } from '../ImagesTab';
import type { ScanSummary } from '@/types/security';

function summary(o: Partial<ScanSummary> & { image_ref: string; scan_id: number }): ScanSummary {
  return {
    highest_severity: null,
    scanned_at: Date.now(),
    total: 0,
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    unknown: 0,
    fixable: 0,
    secret_count: 0,
    misconfig_count: 0,
    ...o,
  };
}

function asMap(...list: ScanSummary[]): Record<string, ScanSummary> {
  return Object.fromEntries(list.map((s) => [s.image_ref, s]));
}

const base = {
  loading: false,
  error: false,
  onInspect: vi.fn(),
  canScan: false,
  scanningRef: null as string | null,
  onScan: vi.fn(),
};

beforeEach(() => vi.clearAllMocks());

it('renders real images and excludes stack/config scans', () => {
  render(
    <ImagesTab
      {...base}
      summaries={asMap(
        summary({ image_ref: 'nginx:1', scan_id: 1, highest_severity: 'CRITICAL', total: 5, critical: 5 }),
        summary({ image_ref: 'stack:web', scan_id: 2, misconfig_count: 3 }),
      )}
    />,
  );
  expect(screen.getByText('nginx:1')).toBeInTheDocument();
  expect(screen.queryByText('stack:web')).not.toBeInTheDocument();
});

it('opens the scan sheet on the vulns tab from the image name', async () => {
  const onInspect = vi.fn();
  render(
    <ImagesTab
      {...base}
      onInspect={onInspect}
      summaries={asMap(summary({ image_ref: 'nginx:1', scan_id: 7, highest_severity: 'HIGH', total: 2, high: 2 }))}
    />,
  );
  await userEvent.click(screen.getByText('nginx:1'));
  expect(onInspect).toHaveBeenCalledWith(7, 'vulns');
});

it('opens the scan sheet on the vulns tab from the Findings cell', async () => {
  const onInspect = vi.fn();
  render(
    <ImagesTab
      {...base}
      onInspect={onInspect}
      summaries={asMap(summary({ image_ref: 'nginx:1', scan_id: 9 }))}
    />,
  );
  await userEvent.click(screen.getByText('clean'));
  expect(onInspect).toHaveBeenCalledWith(9, 'vulns');
});

it('narrows the list with the search box', async () => {
  render(
    <ImagesTab
      {...base}
      summaries={asMap(
        summary({ image_ref: 'nginx:1', scan_id: 1 }),
        summary({ image_ref: 'redis:7', scan_id: 2 }),
      )}
    />,
  );
  await userEvent.type(screen.getByPlaceholderText('Search images...'), 'redis');
  expect(screen.getByText('redis:7')).toBeInTheDocument();
  expect(screen.queryByText('nginx:1')).not.toBeInTheDocument();
});

it('narrows the list with the severity filter', async () => {
  render(
    <ImagesTab
      {...base}
      summaries={asMap(
        summary({ image_ref: 'crit:1', scan_id: 1, highest_severity: 'CRITICAL', total: 1, critical: 1 }),
        summary({ image_ref: 'low:1', scan_id: 2, highest_severity: 'LOW', total: 1, low: 1 }),
      )}
    />,
  );
  await userEvent.click(screen.getByText('All severities'));
  await userEvent.click(screen.getByText('Critical'));
  expect(screen.getByText('crit:1')).toBeInTheDocument();
  expect(screen.queryByText('low:1')).not.toBeInTheDocument();
});

it('applies initialFilter to show only the matching images on arrival', () => {
  render(
    <ImagesTab
      {...base}
      initialFilter="FIXABLE"
      summaries={asMap(
        summary({ image_ref: 'fix:1', scan_id: 1, highest_severity: 'HIGH', total: 2, high: 2, fixable: 2 }),
        summary({ image_ref: 'nofix:1', scan_id: 2, highest_severity: 'HIGH', total: 1, high: 1, fixable: 0 }),
      )}
    />,
  );
  expect(screen.getByText('fix:1')).toBeInTheDocument();
  expect(screen.queryByText('nofix:1')).not.toBeInTheDocument();
});

it('shows the scan action only when scanning is allowed', () => {
  const data = asMap(summary({ image_ref: 'nginx:1', scan_id: 1 }));
  const { rerender } = render(<ImagesTab {...base} canScan={false} summaries={data} />);
  expect(screen.queryByLabelText('Scan nginx:1')).not.toBeInTheDocument();
  rerender(<ImagesTab {...base} canScan={true} summaries={data} />);
  expect(screen.getByLabelText('Scan nginx:1')).toBeInTheDocument();
});
