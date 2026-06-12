/**
 * FindingsTab is the shared index for Secrets and Compose risks. It filters the
 * lifted image summaries by kind and opens the scan sheet on the matching
 * detail tab (so a Secrets row lands on Secrets even when the scan has CVEs).
 */
import { it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FindingsTab } from '../FindingsTab';
import type { ScanSummary } from '@/types/security';

function summary(overrides: Partial<ScanSummary> & { image_ref: string; scan_id: number }): ScanSummary {
  return {
    highest_severity: 'HIGH',
    scanned_at: 1,
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

it('secret variant lists only images with secrets and opens the Secrets tab', async () => {
  const onInspect = vi.fn();
  const summaries = {
    'withsecret:1': summary({ image_ref: 'withsecret:1', scan_id: 10, secret_count: 2 }),
    'clean:1': summary({ image_ref: 'clean:1', scan_id: 11, secret_count: 0 }),
  };
  render(<FindingsTab kind="secret" summaries={summaries} loading={false} onInspect={onInspect} />);

  expect(screen.getByText('withsecret:1')).toBeInTheDocument();
  expect(screen.queryByText('clean:1')).not.toBeInTheDocument();

  await userEvent.click(screen.getByText('withsecret:1'));
  expect(onInspect).toHaveBeenCalledWith(10, 'secrets');
});

it('misconfig variant lists only stack scans and opens the Misconfigs tab', async () => {
  const onInspect = vi.fn();
  const summaries = {
    'stack:web': summary({ image_ref: 'stack:web', scan_id: 20, misconfig_count: 3 }),
    'nginx:1': summary({ image_ref: 'nginx:1', scan_id: 21, misconfig_count: 0 }),
  };
  render(<FindingsTab kind="misconfig" summaries={summaries} loading={false} onInspect={onInspect} />);

  // Stack name is shown without the "stack:" prefix.
  expect(screen.getByText('web')).toBeInTheDocument();
  expect(screen.queryByText('nginx:1')).not.toBeInTheDocument();

  await userEvent.click(screen.getByText('web'));
  expect(onInspect).toHaveBeenCalledWith(20, 'misconfigs');
});

it('shows an empty state when there are no findings of the kind', () => {
  render(<FindingsTab kind="secret" summaries={{}} loading={false} onInspect={vi.fn()} />);
  expect(screen.getByText('No secret findings')).toBeInTheDocument();
});
