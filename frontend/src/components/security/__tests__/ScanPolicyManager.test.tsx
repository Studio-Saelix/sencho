/**
 * ScanPolicyManager is the deploy-enforcement surface on the Security Policies
 * tab. Key guard: a failed policy fetch surfaces an error state instead of a
 * false "No scan policies configured".
 */
import { it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { toast } from '@/components/ui/toast-store';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/context/AuthContext');
vi.mock('@/context/NodeContext');
vi.mock('@/hooks/useTrivyStatus');
vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn(), loading: vi.fn(() => 'id'), dismiss: vi.fn() },
}));

import { apiFetch } from '@/lib/api';
import * as AuthContext from '@/context/AuthContext';
import * as NodeContext from '@/context/NodeContext';
import * as TrivyStatus from '@/hooks/useTrivyStatus';
import { ScanPolicyManager } from '../ScanPolicyManager';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function setup() {
  vi.mocked(AuthContext.useAuth).mockReturnValue({ isAdmin: true } as unknown as ReturnType<typeof AuthContext.useAuth>);
  vi.mocked(NodeContext.useNodes).mockReturnValue({ activeNode: { type: 'local', id: 1, name: 'local' } } as unknown as ReturnType<typeof NodeContext.useNodes>);
  vi.mocked(TrivyStatus.useTrivyStatus).mockReturnValue({
    status: { available: true, version: '1', source: 'managed', autoUpdate: false, honorSuppressionsOnDeploy: false, preDeployScanAdvisory: false, cveIntelEnabled: true, busy: false },
    updateCheck: null,
    refresh: vi.fn().mockResolvedValue(undefined),
    refreshUpdateCheck: vi.fn().mockResolvedValue(undefined),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Fleet-role probe resolves to control by default; per-test override for policies.
  mockedFetch.mockImplementation((url: string) =>
    Promise.resolve(url.startsWith('/fleet/role') ? jsonResponse(200, { role: 'control' }) : jsonResponse(200, [])),
  );
});

it('surfaces an error state when the policies fetch fails (no false "no policies")', async () => {
  setup();
  mockedFetch.mockImplementation((url: string) =>
    Promise.resolve(url.startsWith('/fleet/role') ? jsonResponse(200, { role: 'control' }) : jsonResponse(500, {})),
  );
  render(<ScanPolicyManager />);
  await waitFor(() => expect(screen.getByText("Couldn't load scan policies")).toBeInTheDocument());
  expect(screen.queryByText('No scan policies configured')).not.toBeInTheDocument();
});

it('shows the empty state when there are genuinely no policies', async () => {
  setup();
  render(<ScanPolicyManager />);
  await waitFor(() => expect(screen.getByText('No scan policies configured')).toBeInTheDocument());
});

const riskPolicy = {
  id: 1, name: 'risk-gate', node_id: null, node_identity: '', stack_pattern: null,
  max_severity: 'CRITICAL', block_on_deploy: 1, enabled: 1,
  block_on_severity: 0, block_on_kev: 1, block_on_fixable: 1,
  replicated_from_control: 0, created_at: 1, updated_at: 1,
};

it('renders a per-input badge for each active input (KEV/Fixable, no severity)', async () => {
  setup();
  mockedFetch.mockImplementation((url: string) =>
    Promise.resolve(url.startsWith('/fleet/role') ? jsonResponse(200, { role: 'control' }) : jsonResponse(200, [riskPolicy])),
  );
  render(<ScanPolicyManager />);
  await waitFor(() => expect(screen.getByText('risk-gate')).toBeInTheDocument());
  expect(screen.getByText('KEV')).toBeInTheDocument();
  expect(screen.getByText('Fixable')).toBeInTheDocument();
  expect(screen.queryByText(/^max:/)).not.toBeInTheDocument();
});

it('sends the risk-first defaults (KEV + fixable on, severity off) when creating a policy', async () => {
  setup();
  render(<ScanPolicyManager />);
  await waitFor(() => expect(screen.getByText('Add policy')).toBeInTheDocument());
  fireEvent.click(screen.getByText('Add policy'));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'new-gate' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));

  await waitFor(() => {
    const call = mockedFetch.mock.calls.find(([url, opts]) => url === '/security/policies' && opts?.method === 'POST');
    expect(call).toBeTruthy();
    const body = JSON.parse((call![1] as { body: string }).body);
    expect(body).toMatchObject({ block_on_severity: 0, block_on_kev: 1, block_on_fixable: 1 });
  });
});

it('blocks a save that turns on block-on-deploy with no active input', async () => {
  setup();
  render(<ScanPolicyManager />);
  await waitFor(() => expect(screen.getByText('Add policy')).toBeInTheDocument());
  fireEvent.click(screen.getByText('Add policy'));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'empty-gate' } });

  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('switch', { name: 'Known-exploited (KEV)' })); // KEV off
  fireEvent.click(within(dialog).getByRole('switch', { name: 'Fixable Critical/High' })); // fixable off
  fireEvent.click(within(dialog).getByRole('switch', { name: 'Block on deploy' })); // block-on-deploy on
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));

  expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/at least one input/i));
  expect(mockedFetch.mock.calls.some(([url, opts]) => url === '/security/policies' && opts?.method === 'POST')).toBe(false);
});
