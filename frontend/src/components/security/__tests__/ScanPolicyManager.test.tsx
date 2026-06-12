/**
 * ScanPolicyManager is the paid deploy-enforcement surface on the Security
 * Policies tab. Key guards: it renders nothing for Community, and a failed
 * policy fetch surfaces an error state instead of a false "No scan policies
 * configured".
 */
import { it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/context/LicenseContext');
vi.mock('@/context/AuthContext');
vi.mock('@/context/NodeContext');
vi.mock('@/hooks/useTrivyStatus');
vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn(), loading: vi.fn(() => 'id'), dismiss: vi.fn() },
}));

import { apiFetch } from '@/lib/api';
import * as LicenseContext from '@/context/LicenseContext';
import * as AuthContext from '@/context/AuthContext';
import * as NodeContext from '@/context/NodeContext';
import * as TrivyStatus from '@/hooks/useTrivyStatus';
import { ScanPolicyManager } from '../ScanPolicyManager';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function setup({ isPaid }: { isPaid: boolean }) {
  vi.mocked(LicenseContext.useLicense).mockReturnValue({ isPaid } as unknown as ReturnType<typeof LicenseContext.useLicense>);
  vi.mocked(AuthContext.useAuth).mockReturnValue({ isAdmin: true } as unknown as ReturnType<typeof AuthContext.useAuth>);
  vi.mocked(NodeContext.useNodes).mockReturnValue({ activeNode: { type: 'local', id: 1, name: 'local' } } as unknown as ReturnType<typeof NodeContext.useNodes>);
  vi.mocked(TrivyStatus.useTrivyStatus).mockReturnValue({
    status: { available: true, version: '1', source: 'managed', autoUpdate: false, honorSuppressionsOnDeploy: false, busy: false },
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

it('renders nothing for a Community operator (paid surface)', () => {
  setup({ isPaid: false });
  const { container } = render(<ScanPolicyManager />);
  expect(container).toBeEmptyDOMElement();
});

it('surfaces an error state when the policies fetch fails (no false "no policies")', async () => {
  setup({ isPaid: true });
  mockedFetch.mockImplementation((url: string) =>
    Promise.resolve(url.startsWith('/fleet/role') ? jsonResponse(200, { role: 'control' }) : jsonResponse(500, {})),
  );
  render(<ScanPolicyManager />);
  await waitFor(() => expect(screen.getByText("Couldn't load scan policies")).toBeInTheDocument());
  expect(screen.queryByText('No scan policies configured')).not.toBeInTheDocument();
});

it('shows the empty state when there are genuinely no policies', async () => {
  setup({ isPaid: true });
  render(<ScanPolicyManager />);
  await waitFor(() => expect(screen.getByText('No scan policies configured')).toBeInTheDocument());
});
