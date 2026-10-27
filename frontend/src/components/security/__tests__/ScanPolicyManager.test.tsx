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
  vi.mocked(AuthContext.useAuth).mockReturnValue({ isAdmin: true, can: () => true } as unknown as ReturnType<typeof AuthContext.useAuth>);
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

it('renders a per-input badge for each active input (KEV/Package fix, no severity)', async () => {
  setup();
  mockedFetch.mockImplementation((url: string) =>
    Promise.resolve(url.startsWith('/fleet/role') ? jsonResponse(200, { role: 'control' }) : jsonResponse(200, [riskPolicy])),
  );
  render(<ScanPolicyManager />);
  await waitFor(() => expect(screen.getByText('risk-gate')).toBeInTheDocument());
  expect(screen.getByText('KEV')).toBeInTheDocument();
  expect(screen.getByText('Package fix')).toBeInTheDocument();
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
  fireEvent.click(within(dialog).getByRole('switch', { name: 'Package fix available (Critical/High)' })); // fixable off
  fireEvent.click(within(dialog).getByRole('switch', { name: 'Block on deploy' })); // block-on-deploy on
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));

  expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/at least one input/i));
  expect(mockedFetch.mock.calls.some(([url, opts]) => url === '/security/policies' && opts?.method === 'POST')).toBe(false);
});

const evidenceBody = (scannerUnavailable: string) => ({
  policy: { scannerUnavailable, scanFailure: 'block', candidateUnproven: 'block', isDefault: scannerUnavailable === 'allow' },
  defaults: { scannerUnavailable: 'allow', scanFailure: 'block', candidateUnproven: 'block', isDefault: true },
  outcomes: ['allow', 'warn', 'block'],
});

function useNode(node: { type: string; id: number; name: string }) {
  vi.mocked(NodeContext.useNodes).mockReturnValue({ activeNode: node } as unknown as ReturnType<typeof NodeContext.useNodes>);
}

it('shows the evidence policy on a remote node and reads it from that node, not the local one', async () => {
  setup();
  useNode({ type: 'remote', id: 12, name: 'pilot-12' });
  mockedFetch.mockImplementation((url: string) =>
    Promise.resolve(url === '/security/evidence-policy' ? jsonResponse(200, evidenceBody('block')) : jsonResponse(200, [])),
  );
  render(<ScanPolicyManager />);

  await waitFor(() => expect(screen.getByText('Evidence availability')).toBeInTheDocument());
  // Scan policies stay local-only: the remote banner shows and they are not fetched.
  expect(screen.getByText('Managed on the local instance')).toBeInTheDocument();
  expect(mockedFetch.mock.calls.some(([url]) => url === '/security/policies')).toBe(false);
  // The evidence read is pinned to the node on screen, never to the hub
  // (`localOnly` or a null node) and never left to follow shared storage.
  const call = mockedFetch.mock.calls.find(([url]) => url === '/security/evidence-policy');
  expect(call).toBeTruthy();
  expect(call![1] ?? {}).not.toHaveProperty('localOnly');
  expect(call![1]).toMatchObject({ nodeId: 12 });
  expect(within(screen.getByRole('radiogroup', { name: 'Scanner unavailable' })).getByRole('radio', { name: 'Block' }))
    .toHaveAttribute('aria-checked', 'true');
});

it('saves the evidence policy to the displayed remote node, not the hub and not whatever storage names', async () => {
  setup();
  useNode({ type: 'remote', id: 12, name: 'pilot-12' });
  mockedFetch.mockImplementation((url: string, opts?: { method?: string }) =>
    Promise.resolve(
      url === '/security/evidence-policy'
        ? jsonResponse(200, opts?.method === 'PUT' ? { policy: evidenceBody('block').policy } : evidenceBody('allow'))
        : jsonResponse(200, []),
    ),
  );
  render(<ScanPolicyManager />);
  await waitFor(() => expect(screen.getByText('Evidence availability')).toBeInTheDocument());

  fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Scanner unavailable' })).getByRole('radio', { name: 'Block' }));

  await waitFor(() => {
    const put = mockedFetch.mock.calls.find(([url, opts]) => url === '/security/evidence-policy' && opts?.method === 'PUT');
    expect(put).toBeTruthy();
    expect(put![1]).not.toHaveProperty('localOnly');
    expect(put![1]).toMatchObject({ nodeId: 12 });
    expect(JSON.parse(put![1].body)).toEqual({ scannerUnavailable: 'block' });
  });
});

it('renders no evidence panel, and sends no request for it, until a node is active', async () => {
  setup();
  vi.mocked(NodeContext.useNodes).mockReturnValue({ activeNode: null } as unknown as ReturnType<typeof NodeContext.useNodes>);
  render(<ScanPolicyManager />);
  await waitFor(() => expect(screen.getByText('Add policy')).toBeInTheDocument());
  expect(screen.queryByText('Evidence availability')).not.toBeInTheDocument();
  expect(mockedFetch.mock.calls.some(([url]) => url === '/security/evidence-policy')).toBe(false);
});

it('does not carry one node\'s evidence policy over to the next node selected', async () => {
  setup();
  useNode({ type: 'local', id: 1, name: 'local' });
  const byNode: Record<number, string> = { 1: 'block', 12: 'allow' };
  let current = 1;
  mockedFetch.mockImplementation((url: string) =>
    Promise.resolve(url === '/security/evidence-policy' ? jsonResponse(200, evidenceBody(byNode[current])) : jsonResponse(200, [])),
  );
  const { rerender } = render(<ScanPolicyManager />);
  await waitFor(() =>
    expect(within(screen.getByRole('radiogroup', { name: 'Scanner unavailable' })).getByRole('radio', { name: 'Block' }))
      .toHaveAttribute('aria-checked', 'true'),
  );

  current = 12;
  useNode({ type: 'remote', id: 12, name: 'pilot-12' });
  rerender(<ScanPolicyManager />);

  await waitFor(() =>
    expect(within(screen.getByRole('radiogroup', { name: 'Scanner unavailable' })).getByRole('radio', { name: 'Allow' }))
      .toHaveAttribute('aria-checked', 'true'),
  );
});

it('keeps the evidence policy read-only for a non-admin on a remote node', async () => {
  setup();
  vi.mocked(AuthContext.useAuth).mockReturnValue({ isAdmin: false, can: () => true } as unknown as ReturnType<typeof AuthContext.useAuth>);
  useNode({ type: 'remote', id: 12, name: 'pilot-12' });
  mockedFetch.mockImplementation((url: string) =>
    Promise.resolve(url === '/security/evidence-policy' ? jsonResponse(200, evidenceBody('allow')) : jsonResponse(200, [])),
  );
  render(<ScanPolicyManager />);
  await waitFor(() => expect(screen.getByText(/read-only for your role/)).toBeInTheDocument());

  const block = within(screen.getByRole('radiogroup', { name: 'Scanner unavailable' })).getByRole('radio', { name: 'Block' });
  expect(block).toBeDisabled();
  fireEvent.click(block);
  expect(mockedFetch.mock.calls.some(([, opts]) => opts?.method === 'PUT')).toBe(false);
});

it('shows a placeholder, not the previous node\'s values, while the next node is read', async () => {
  setup();
  useNode({ type: 'local', id: 1, name: 'local' });
  let resolveNodeB: (r: Response) => void = () => {};
  let phase: 'a' | 'b' = 'a';
  mockedFetch.mockImplementation((url: string) => {
    if (url !== '/security/evidence-policy') return Promise.resolve(jsonResponse(200, []));
    return phase === 'a'
      ? Promise.resolve(jsonResponse(200, evidenceBody('block')))
      : new Promise<Response>((resolve) => { resolveNodeB = resolve; });
  });
  const { rerender } = render(<ScanPolicyManager />);
  await waitFor(() => expect(screen.getByRole('radiogroup', { name: 'Scanner unavailable' })).toBeInTheDocument());

  phase = 'b';
  useNode({ type: 'remote', id: 12, name: 'pilot-12' });
  rerender(<ScanPolicyManager />);
  // Node 12's read is still pending: node 1's values must be gone.
  expect(screen.queryByRole('radiogroup', { name: 'Scanner unavailable' })).not.toBeInTheDocument();

  resolveNodeB(jsonResponse(200, evidenceBody('allow')));
  await waitFor(() =>
    expect(within(screen.getByRole('radiogroup', { name: 'Scanner unavailable' })).getByRole('radio', { name: 'Allow' }))
      .toHaveAttribute('aria-checked', 'true'),
  );
});

it('does not keep the previous node\'s values when the next node cannot be read', async () => {
  setup();
  useNode({ type: 'local', id: 1, name: 'local' });
  let failing = false;
  mockedFetch.mockImplementation((url: string) => {
    if (url !== '/security/evidence-policy') return Promise.resolve(jsonResponse(200, []));
    return Promise.resolve(failing ? jsonResponse(503, { error: 'Pilot agent is not connected' }) : jsonResponse(200, evidenceBody('block')));
  });
  const { rerender } = render(<ScanPolicyManager />);
  await waitFor(() => expect(screen.getByRole('radiogroup', { name: 'Scanner unavailable' })).toBeInTheDocument());

  failing = true;
  useNode({ type: 'remote', id: 12, name: 'pilot-12' });
  rerender(<ScanPolicyManager />);

  await waitFor(() => expect(screen.getByText(/could not be read/)).toBeInTheDocument());
  expect(screen.queryByRole('radiogroup', { name: 'Scanner unavailable' })).not.toBeInTheDocument();
});
