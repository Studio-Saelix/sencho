/**
 * Coverage for SuppressionsPanel load behavior.
 *
 * Locks the regression fix where a non-ok suppressions response was swallowed
 * silently: the panel must surface an error toast so a failed load is visible
 * rather than presenting an empty list as if there were no suppressions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  useAuth: () => ({ isAdmin: true, can: () => true }),
}));

import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { SuppressionsPanel } from '../SuppressionsPanel';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;
const mockedToast = toast as unknown as { error: ReturnType<typeof vi.fn> };

async function pickSelect(label: string, optionName: string) {
  await userEvent.click(screen.getByRole('combobox', { name: label }));
  await userEvent.click(await screen.findByRole('option', { name: optionName }));
}

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

  async function openCreateDialog() {
    render(<SuppressionsPanel isReplica={false} />);
    await waitFor(() => expect(screen.getByText('Add suppression')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Add suppression'));
  }

  function postCall() {
    return mockedFetch.mock.calls.find(
      ([url, opts]) => url === '/security/suppressions' && (opts as { method?: string } | undefined)?.method === 'POST',
    );
  }

  it('sends the triage status and justification when creating a suppression', async () => {
    mockedFetch.mockImplementation(async (_url: string, opts?: { method?: string }) =>
      opts?.method === 'POST' ? { ok: true, json: async () => ({}) } : { ok: true, json: async () => [] },
    );

    await openCreateDialog();
    await userEvent.type(screen.getByLabelText('CVE or advisory ID'), 'CVE-2026-0002');
    await userEvent.type(screen.getByLabelText('Reason'), 'Vendor confirmed the code path is unreachable.');
    await pickSelect('Triage decision', 'Not affected');
    await pickSelect('OpenVEX justification', 'Vulnerable code not present');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(postCall()).toBeTruthy());
    const body = JSON.parse((postCall()![1] as { body: string }).body);
    expect(body.status).toBe('not_affected');
    expect(body.justification).toBe('vulnerable_code_not_present');
  });

  it('requires an OpenVEX justification when the decision is not affected', async () => {
    mockedFetch.mockImplementation(async (_url: string, opts?: { method?: string }) =>
      opts?.method === 'POST' ? { ok: true, json: async () => ({}) } : { ok: true, json: async () => [] },
    );

    await openCreateDialog();
    await userEvent.type(screen.getByLabelText('CVE or advisory ID'), 'CVE-2026-0003');
    await userEvent.type(screen.getByLabelText('Reason'), 'Needs a justification before this can save.');
    await pickSelect('Triage decision', 'Not affected');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(mockedToast.error).toHaveBeenCalledWith('An OpenVEX justification is required for this triage decision.');
    expect(postCall()).toBeUndefined();
  });

  it('clears the justification when switching to a decision that does not require one', async () => {
    mockedFetch.mockResolvedValue({ ok: true, json: async () => [] });

    await openCreateDialog();
    await pickSelect('Triage decision', 'False positive');
    await pickSelect('OpenVEX justification', 'Component not present');
    expect(screen.getByRole('combobox', { name: 'OpenVEX justification' })).toHaveTextContent('Component not present');

    await pickSelect('Triage decision', 'Accepted risk');
    expect(screen.queryByRole('combobox', { name: 'OpenVEX justification' })).not.toBeInTheDocument();

    await pickSelect('Triage decision', 'Not affected');
    expect(screen.getByRole('combobox', { name: 'OpenVEX justification' })).toHaveTextContent(/Select a justification/i);
  });
});
