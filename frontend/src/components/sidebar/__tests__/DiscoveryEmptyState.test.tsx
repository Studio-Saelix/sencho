import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { DiscoveryEmptyState } from '../DiscoveryEmptyState';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({ toast: { error: vi.fn() } }));

import { apiFetch } from '@/lib/api';

function discoveryRes(body: unknown) {
  return { ok: true, json: async () => body } as Response;
}

describe('DiscoveryEmptyState', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('fetches /stacks/discovery only, never diagnostics', async () => {
    vi.mocked(apiFetch).mockResolvedValue(discoveryRes({
      composeDir: '/opt/compose',
      readable: true,
      discovery: {
        composeDir: '/opt/compose',
        stackCount: 0,
        adoptCandidateCount: 0,
        adoptCandidatesTruncated: false,
      },
    }));

    render(<DiscoveryEmptyState canCreate onOpenCreate={vi.fn()} onScan={vi.fn()} />);

    await waitFor(() => expect(screen.getByText(/no compose projects yet/i)).toBeTruthy());
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith('/stacks/discovery');
    expect(apiFetch).not.toHaveBeenCalledWith('/diagnostics/environment', expect.anything());
  });

  it('shows unreadable copy with composeDir and error', async () => {
    vi.mocked(apiFetch).mockResolvedValue(discoveryRes({
      composeDir: '/missing/compose',
      readable: false,
      discovery: null,
      error: 'Compose directory does not exist.',
    }));

    render(<DiscoveryEmptyState />);

    await waitFor(() => expect(screen.getByText(/could not read compose directory/i)).toBeTruthy());
    expect(screen.getByText('/missing/compose')).toBeTruthy();
    expect(screen.getByText('Compose directory does not exist.')).toBeTruthy();
  });

  it('shows adopt CTA when candidates exist', async () => {
    const onOpenAdopt = vi.fn();
    vi.mocked(apiFetch).mockResolvedValue(discoveryRes({
      composeDir: '/opt/compose',
      readable: true,
      discovery: {
        composeDir: '/opt/compose',
        stackCount: 2,
        adoptCandidateCount: 3,
        adoptCandidatesTruncated: false,
      },
    }));

    render(<DiscoveryEmptyState onOpenAdopt={onOpenAdopt} />);

    await waitFor(() => expect(screen.getByRole('button', { name: /adopt existing files/i })).toBeTruthy());
    expect(screen.queryByText(/no compose projects yet/i)).toBeNull();
  });

  it('re-fetches when activeNodeId changes', async () => {
    vi.mocked(apiFetch).mockResolvedValue(discoveryRes({
      composeDir: '/opt/compose',
      readable: true,
      discovery: {
        composeDir: '/opt/compose',
        stackCount: 0,
        adoptCandidateCount: 0,
        adoptCandidatesTruncated: false,
      },
    }));

    const { rerender } = render(<DiscoveryEmptyState activeNodeId={1} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));

    rerender(<DiscoveryEmptyState activeNodeId={2} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
  });
});
