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
  await userEvent.click(screen.getByLabelText('Search images'));
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

it('filters to posture targets and shows a clearable banner', async () => {
  const onClear = vi.fn();
  render(
    <ImagesTab
      {...base}
      onClearTargeting={onClear}
      targeting={{
        kind: 'public_exposure',
        label: 'Network-exposed affected images',
        imageRefs: ['exp:1'],
        targets: [{
          imageRef: 'exp:1',
          intentStatus: 'unset',
        }],
        token: 1,
      }}
      summaries={asMap(
        summary({ image_ref: 'exp:1', scan_id: 1, publicly_exposed: true }),
        summary({ image_ref: 'other:1', scan_id: 2 }),
      )}
    />,
  );
  expect(screen.getByText(/Network-exposed affected images · 1 affected image/)).toBeInTheDocument();
  expect(screen.getByText('exp:1')).toBeInTheDocument();
  expect(screen.queryByText('other:1')).not.toBeInTheDocument();
  expect(screen.getByText('Network exposed')).toBeInTheDocument();
  expect(screen.getByText('Intent: not classified')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
  expect(onClear).toHaveBeenCalled();
});

it('shows standing intent evidence without targeting', () => {
  render(
    <ImagesTab
      {...base}
      nodeId={7}
      summaries={asMap(summary({
        image_ref: 'exp:1',
        scan_id: 1,
        publicly_exposed: true,
        exposure_contexts: [{
          stackName: 'web',
          serviceName: 'api',
          exposureReason: 'published-port',
          intentStatus: 'set',
          exposureIntent: 'public',
        }],
        exposure_context_count: 1,
        exposure_context_summary: {
          hasConflict: false,
          hasUnclassified: false,
          hasUnavailable: false,
          allKnownIntentional: true,
        },
      }))}
    />,
  );
  expect(screen.getByText('Network exposed')).toBeInTheDocument();
  expect(screen.getByText('Intent: public')).toBeInTheDocument();
});

it('shows Network exposed only for mixed-version payloads without contexts', () => {
  render(
    <ImagesTab
      {...base}
      summaries={asMap(summary({
        image_ref: 'exp:1',
        scan_id: 1,
        publicly_exposed: true,
      }))}
    />,
  );
  expect(screen.getByText('Network exposed')).toBeInTheDocument();
  expect(screen.queryByText(/Intent:/)).not.toBeInTheDocument();
});

it('shows absolute intentional targeting banner with View networking only', () => {
  render(
    <ImagesTab
      {...base}
      nodeId={3}
      onClearTargeting={vi.fn()}
      targeting={{
        kind: 'public_exposure',
        label: 'Network-exposed affected images',
        imageRefs: ['exp:1'],
        targets: [{
          imageRef: 'exp:1',
          stackName: 'web',
          serviceName: 'api',
          intentStatus: 'set',
          exposureIntent: 'public',
        }],
        token: 1,
      }}
      summaries={asMap(summary({ image_ref: 'exp:1', scan_id: 1, publicly_exposed: true }))}
    />,
  );
  expect(screen.getByText('Exposure is intentional')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'View networking' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Review findings/i })).not.toBeInTheDocument();
  expect(screen.queryByText(/Network-exposed affected images ·/)).not.toBeInTheDocument();
});

it('shows partial intentional targeting banner copy', () => {
  render(
    <ImagesTab
      {...base}
      nodeId={3}
      onClearTargeting={vi.fn()}
      targeting={{
        kind: 'public_exposure',
        label: 'Network-exposed affected images',
        imageRefs: ['exp:1'],
        targets: [
          {
            imageRef: 'exp:1',
            stackName: 'web',
            serviceName: 'api',
            intentStatus: 'set',
            exposureIntent: 'lan',
          },
          {
            imageRef: 'exp:1',
            stackName: 'web',
            serviceName: 'worker',
            intentStatus: 'unavailable',
          },
        ],
        token: 1,
      }}
      summaries={asMap(summary({ image_ref: 'exp:1', scan_id: 1, publicly_exposed: true }))}
    />,
  );
  expect(screen.getByText('Known exposure is intentional')).toBeInTheDocument();
  expect(screen.getByText(/could not be verified for 1 service/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'View networking' })).toBeInTheDocument();
});

it('shows matched of total when a target has no summary', () => {
  render(
    <ImagesTab
      {...base}
      onClearTargeting={vi.fn()}
      targeting={{
        kind: 'public_exposure',
        label: 'Publicly exposed affected images',
        imageRefs: ['a:1', 'b:1', 'missing:1'],
        targets: ['a:1', 'b:1', 'missing:1'].map((imageRef) => ({ imageRef })),
        token: 1,
      }}
      summaries={asMap(
        summary({ image_ref: 'a:1', scan_id: 1 }),
        summary({ image_ref: 'b:1', scan_id: 2 }),
      )}
    />,
  );
  expect(screen.getByText(/2 of 3 affected images/)).toBeInTheDocument();
  expect(screen.getByText(/no scan summary on this node/i)).toBeInTheDocument();
});

it('does not change the banner count when searching within the targeted set', async () => {
  render(
    <ImagesTab
      {...base}
      onClearTargeting={vi.fn()}
      targeting={{
        kind: 'public_exposure',
        label: 'Publicly exposed affected images',
        imageRefs: ['a:1', 'b:1'],
        targets: ['a:1', 'b:1'].map((imageRef) => ({ imageRef })),
        token: 1,
      }}
      summaries={asMap(
        summary({ image_ref: 'a:1', scan_id: 1 }),
        summary({ image_ref: 'b:1', scan_id: 2 }),
      )}
    />,
  );
  expect(screen.getByText(/· 2 affected images/)).toBeInTheDocument();
  await userEvent.click(screen.getByLabelText('Search images'));
  await userEvent.type(screen.getByPlaceholderText('Search images...'), 'a:');
  expect(screen.getByText('a:1')).toBeInTheDocument();
  expect(screen.queryByText('b:1')).not.toBeInTheDocument();
  expect(screen.getByText(/· 2 affected images/)).toBeInTheDocument();
});

it('re-applies targeting when the token increments after Clear', () => {
  const data = asMap(
    summary({ image_ref: 'exp:1', scan_id: 1 }),
    summary({ image_ref: 'other:1', scan_id: 2 }),
  );
  const { rerender } = render(
    <ImagesTab
      {...base}
      targeting={{ kind: 'public_exposure', label: 'Public exposure', imageRefs: ['exp:1'], targets: [{ imageRef: 'exp:1' }], token: 1 }}
      onClearTargeting={vi.fn()}
      summaries={data}
    />,
  );
  expect(screen.queryByText('other:1')).not.toBeInTheDocument();
  rerender(
    <ImagesTab
      {...base}
      targeting={null}
      onClearTargeting={vi.fn()}
      summaries={data}
    />,
  );
  expect(screen.getByText('other:1')).toBeInTheDocument();
  rerender(
    <ImagesTab
      {...base}
      targeting={{ kind: 'public_exposure', label: 'Public exposure', imageRefs: ['exp:1'], targets: [{ imageRef: 'exp:1' }], token: 2 }}
      onClearTargeting={vi.fn()}
      summaries={data}
    />,
  );
  expect(screen.queryByText('other:1')).not.toBeInTheDocument();
  expect(screen.getByText('exp:1')).toBeInTheDocument();
});

it('resets a stale FIXABLE filter when targeting arrives without a filter', () => {
  const data = asMap(
    summary({ image_ref: 'exp:1', scan_id: 1, fixable: 0, highest_severity: 'HIGH', high: 1, total: 1 }),
    summary({ image_ref: 'fix:1', scan_id: 2, fixable: 2, highest_severity: 'HIGH', high: 2, total: 2 }),
  );
  const { rerender } = render(
    <ImagesTab {...base} initialFilter="FIXABLE" filterToken={1} summaries={data} />,
  );
  expect(screen.getByText('fix:1')).toBeInTheDocument();
  expect(screen.queryByText('exp:1')).not.toBeInTheDocument();
  rerender(
    <ImagesTab
      {...base}
      initialFilter={undefined}
      filterToken={2}
      targeting={{ kind: 'public_exposure', label: 'Public exposure', imageRefs: ['exp:1'], targets: [{ imageRef: 'exp:1' }], token: 1 }}
      onClearTargeting={vi.fn()}
      summaries={data}
    />,
  );
  expect(screen.getByText('exp:1')).toBeInTheDocument();
});

it('falls back without a banner when targets are missing', () => {
  render(
    <ImagesTab
      {...base}
      summaries={asMap(
        summary({ image_ref: 'a:1', scan_id: 1 }),
        summary({ image_ref: 'b:1', scan_id: 2 }),
      )}
    />,
  );
  expect(screen.queryByText(/affected image/)).not.toBeInTheDocument();
  expect(screen.getByText('a:1')).toBeInTheDocument();
  expect(screen.getByText('b:1')).toBeInTheDocument();
});

it('shows a clearable zero-match note and keeps the full list', () => {
  render(
    <ImagesTab
      {...base}
      onClearTargeting={vi.fn()}
      targeting={{
        kind: 'public_exposure',
        label: 'Publicly exposed affected images',
        imageRefs: ['missing:1'],
        targets: ['missing:1'].map((imageRef) => ({ imageRef })),
        token: 1,
      }}
      summaries={asMap(
        summary({ image_ref: 'a:1', scan_id: 1 }),
        summary({ image_ref: 'b:1', scan_id: 2 }),
      )}
    />,
  );
  expect(screen.getByText(/scan summary on this node/i)).toBeInTheDocument();
  expect(screen.getByText('a:1')).toBeInTheDocument();
  expect(screen.getByText('b:1')).toBeInTheDocument();
});
