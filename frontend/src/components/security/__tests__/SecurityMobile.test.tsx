/**
 * Mobile (<md) Security reflow pieces: the horizontal tab scroller and the
 * image-list row, plus the ImagesTab mobile list/chip rendering. These render
 * only on the phone branch; useIsMobile() is driven via a mocked matchMedia.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SecurityMobileTabs, ImageScanRow, SecuritySevStrip, type SecurityMobileTab } from '../SecurityMobile';
import { ImagesTab } from '../ImagesTab';
import type { ScanSummary, SecurityOverview } from '@/types/security';

function overview(o: Partial<SecurityOverview> = {}): SecurityOverview {
  return {
    scannedImages: 0,
    critical: 0,
    high: 0,
    fixable: 0,
    secrets: 0,
    misconfigs: 0,
    staleScans: 0,
    failedScans: 0,
    lastSuccessfulScanAt: null,
    scanner: { available: false, source: 'managed', version: null, autoUpdate: false },
    deployEnforcement: { eligibleBlockPolicies: 0, honorSuppressionsOnDeploy: false },
    ...o,
  };
}

function summary(o: Partial<ScanSummary> & { image_ref: string; scan_id: number }): ScanSummary {
  return {
    highest_severity: null,
    scanned_at: 1_700_000_000_000,
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

function installMatchMedia(matches: boolean) {
  window.matchMedia = vi.fn().mockReturnValue({
    matches,
    media: '',
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }) as unknown as typeof window.matchMedia;
}

const TABS: SecurityMobileTab[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'images', label: 'Images' },
  { value: 'scanner', label: 'Scanner setup' },
];

describe('SecurityMobileTabs', () => {
  it('renders every tab and marks the active one selected', () => {
    render(<SecurityMobileTabs tabs={TABS} active="images" onSelect={vi.fn()} />);
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(screen.getByRole('tab', { name: 'Images' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'false');
  });

  it('gives the active tab the cyan underline and brand ink', () => {
    render(<SecurityMobileTabs tabs={TABS} active="images" onSelect={vi.fn()} />);
    const active = screen.getByRole('tab', { name: 'Images' });
    expect(active.className).toContain('text-brand');
    expect(active.className).toContain('shadow-[inset_0_-2px_0_0_var(--brand)]');
  });

  it('calls onSelect with the tab value on click', async () => {
    const onSelect = vi.fn();
    render(<SecurityMobileTabs tabs={TABS} active="overview" onSelect={onSelect} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Scanner setup' }));
    expect(onSelect).toHaveBeenCalledWith('scanner');
  });
});

describe('ImageScanRow', () => {
  it('shows critical and high count tags', () => {
    render(<ImageScanRow summary={summary({ image_ref: 'nginx:1', scan_id: 1, critical: 5, high: 2 })} onInspect={vi.fn()} />);
    expect(screen.getByText('nginx:1')).toBeInTheDocument();
    expect(screen.getByText('5C')).toBeInTheDocument();
    expect(screen.getByText('2H')).toBeInTheDocument();
  });

  it('shows a clean tag when there are no findings', () => {
    render(<ImageScanRow summary={summary({ image_ref: 'caddy:2', scan_id: 2 })} onInspect={vi.fn()} />);
    expect(screen.getByText('clean')).toBeInTheDocument();
  });

  it('does not call a medium/low-only image clean', () => {
    // A medium-only image has no critical/high/secret/misconfig findings but is
    // not clean; the dot and tags must follow getSeverityKey, not an all-zero check.
    render(<ImageScanRow summary={summary({ image_ref: 'pg:16', scan_id: 3, highest_severity: 'MEDIUM', total: 4, medium: 4 })} onInspect={vi.fn()} />);
    expect(screen.queryByText('clean')).not.toBeInTheDocument();
  });

  it('opens the scan on the vulns tab when tapped', async () => {
    const onInspect = vi.fn();
    render(<ImageScanRow summary={summary({ image_ref: 'redis:7', scan_id: 9 })} onInspect={onInspect} />);
    await userEvent.click(screen.getByText('redis:7'));
    expect(onInspect).toHaveBeenCalledWith(9, 'vulns');
  });
});

describe('SecuritySevStrip', () => {
  it('tints critical and high by severity when nonzero', () => {
    render(<SecuritySevStrip overview={overview({ critical: 2, high: 4 })} />);
    expect(screen.getByText('2').className).toContain('text-destructive');
    expect(screen.getByText('4').className).toContain('text-warning');
  });

  it('keeps zero counts at the neutral value tone', () => {
    render(<SecuritySevStrip overview={overview({ critical: 0, high: 0 })} />);
    // Two cells read 0 (critical, high); both stay neutral, neither tinted.
    for (const cell of screen.getAllByText('0')) {
      expect(cell.className).toContain('text-stat-value');
      expect(cell.className).not.toContain('text-destructive');
    }
  });

  it('reads "never" when the node has no successful scan', () => {
    render(<SecuritySevStrip overview={overview({ lastSuccessfulScanAt: null })} />);
    expect(screen.getByText('never')).toBeInTheDocument();
  });
});

describe('ImagesTab (mobile)', () => {
  const original = window.matchMedia;
  afterEach(() => { window.matchMedia = original; vi.clearAllMocks(); });

  const base = {
    loading: false,
    error: false,
    onInspect: vi.fn(),
    canScan: false,
    scanningRef: null as string | null,
    onScan: vi.fn(),
  };

  it('renders the severity chips and a row list below the breakpoint', () => {
    installMatchMedia(true);
    render(
      <ImagesTab
        {...base}
        summaries={asMap(
          summary({ image_ref: 'nginx:1', scan_id: 1, highest_severity: 'CRITICAL', total: 5, critical: 5 }),
          summary({ image_ref: 'stack:web', scan_id: 2, misconfig_count: 3 }),
        )}
      />,
    );
    // Chips are present and the stack scan is excluded, like the desktop table.
    expect(screen.getByRole('button', { name: 'Fixable' })).toBeInTheDocument();
    expect(screen.getByText('nginx:1')).toBeInTheDocument();
    expect(screen.getByText('5C')).toBeInTheDocument();
    expect(screen.queryByText('stack:web')).not.toBeInTheDocument();
  });

  it('filters the list to fixable images via the chip', async () => {
    installMatchMedia(true);
    render(
      <ImagesTab
        {...base}
        summaries={asMap(
          summary({ image_ref: 'fix:1', scan_id: 1, highest_severity: 'HIGH', high: 2, fixable: 2 }),
          summary({ image_ref: 'nofix:1', scan_id: 2, highest_severity: 'HIGH', high: 1, fixable: 0 }),
        )}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Fixable' }));
    expect(screen.getByText('fix:1')).toBeInTheDocument();
    expect(screen.queryByText('nofix:1')).not.toBeInTheDocument();
  });
});
