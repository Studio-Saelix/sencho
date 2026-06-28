/**
 * Coverage for SuppressionsPanel load behavior.
 *
 * Locks the regression fix where a non-ok suppressions response was swallowed
 * silently: the panel must surface an error toast so a failed load is visible
 * rather than presenting an empty list as if there were no suppressions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { CveSuppression } from '@/types/security';

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

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ isAdmin: true }),
}));

import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { SuppressionsPanel } from '../SuppressionsPanel';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;
const mockedToast = toast as unknown as { error: ReturnType<typeof vi.fn> };

function suppression(overrides: Partial<CveSuppression> = {}): CveSuppression {
  return {
    id: 1,
    cve_id: 'CVE-2026-0001',
    pkg_name: null,
    image_pattern: null,
    reason: 'accepted after review',
    created_by: 'admin',
    created_at: 1_700_000_000_000,
    expires_at: null,
    replicated_from_control: 0,
    active: true,
    ...overrides,
  };
}

describe('SuppressionsPanel', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    mockedToast.error.mockReset();
  });

  it('surfaces an error toast when the suppressions load fails', async () => {
    mockedFetch.mockResolvedValue({ ok: false, json: async () => ({ error: 'boom' }) });

    render(<SuppressionsPanel isReplica={false} />);

    await waitFor(() => expect(mockedToast.error).toHaveBeenCalledWith('Failed to load suppressions'));
  });

  it('renders suppressions and does not toast on a successful load', async () => {
    mockedFetch.mockResolvedValue({ ok: true, json: async () => [suppression()] });

    render(<SuppressionsPanel isReplica={false} />);

    await waitFor(() => expect(screen.getByText('CVE-2026-0001')).toBeInTheDocument());
    expect(mockedToast.error).not.toHaveBeenCalled();
  });
});
