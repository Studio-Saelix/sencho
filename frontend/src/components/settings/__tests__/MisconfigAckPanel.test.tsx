/**
 * Coverage for MisconfigAckPanel load behavior.
 *
 * Mirrors the SuppressionsPanel regression: a non-ok acknowledgements response
 * must surface an error toast rather than presenting an empty list as if there
 * were no acknowledgements.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { MisconfigAcknowledgement } from '@/types/security';

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
import { MisconfigAckPanel } from '../MisconfigAckPanel';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;
const mockedToast = toast as unknown as { error: ReturnType<typeof vi.fn> };

function ack(overrides: Partial<MisconfigAcknowledgement> = {}): MisconfigAcknowledgement {
  return {
    id: 1,
    rule_id: 'DS026',
    stack_pattern: null,
    reason: 'reverse proxy needs root',
    created_by: 'admin',
    created_at: 1_700_000_000_000,
    expires_at: null,
    replicated_from_control: 0,
    active: true,
    ...overrides,
  };
}

describe('MisconfigAckPanel', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    mockedToast.error.mockReset();
  });

  it('surfaces an error toast when the acknowledgements load fails', async () => {
    mockedFetch.mockResolvedValue({ ok: false, json: async () => ({ error: 'boom' }) });

    render(<MisconfigAckPanel isReplica={false} />);

    await waitFor(() => expect(mockedToast.error).toHaveBeenCalledWith('Failed to load acknowledgements'));
  });

  it('renders acknowledgements and does not toast on a successful load', async () => {
    mockedFetch.mockResolvedValue({ ok: true, json: async () => [ack()] });

    render(<MisconfigAckPanel isReplica={false} />);

    await waitFor(() => expect(screen.getByText('DS026')).toBeInTheDocument());
    expect(mockedToast.error).not.toHaveBeenCalled();
  });
});
