/**
 * The severity badge was extracted from ResourcesView into a shared component so
 * Resources and the Security page render an identical pill. Lock its label
 * mapping (highest severity, or "Clean" when there are no findings).
 */
import { it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SeverityBadge } from '../SeverityBadge';
import type { ScanSummary } from '@/types/security';

function summary(overrides: Partial<ScanSummary>): ScanSummary {
  return {
    image_ref: 'nginx:1',
    highest_severity: 'CRITICAL',
    scanned_at: 1,
    scan_id: 1,
    total: 0,
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    unknown: 0,
    fixable: 0,
    secret_count: 0,
    misconfig_count: 0,
    ...overrides,
  };
}

it('renders the highest severity and fires onClick', async () => {
  const onClick = vi.fn();
  render(<SeverityBadge summary={summary({ highest_severity: 'CRITICAL', total: 5, critical: 5 })} onClick={onClick} />);
  const btn = screen.getByRole('button', { name: /CRITICAL/ });
  await userEvent.click(btn);
  expect(onClick).toHaveBeenCalledOnce();
});

it('renders "Clean" when there are no findings of any kind', () => {
  render(<SeverityBadge summary={summary({ highest_severity: null })} onClick={() => {}} />);
  expect(screen.getByRole('button', { name: /Clean/ })).toBeInTheDocument();
});

it('renders "Findings" (not "Clean") for a secret-only scan with no CVE severity', () => {
  render(<SeverityBadge summary={summary({ highest_severity: null, secret_count: 2 })} onClick={() => {}} />);
  expect(screen.getByRole('button', { name: /Findings/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Clean/ })).not.toBeInTheDocument();
});

it('renders "Findings" for a misconfig-only scan', () => {
  render(<SeverityBadge summary={summary({ highest_severity: null, misconfig_count: 3 })} onClick={() => {}} />);
  expect(screen.getByRole('button', { name: /Findings/ })).toBeInTheDocument();
});

it('renders the bare pill and fires onClick with tooltip disabled', async () => {
  const onClick = vi.fn();
  render(<SeverityBadge summary={summary({ highest_severity: 'HIGH', total: 1, high: 1 })} onClick={onClick} tooltip={false} />);
  const btn = screen.getByRole('button', { name: /HIGH/ });
  await userEvent.click(btn);
  expect(onClick).toHaveBeenCalledOnce();
});
