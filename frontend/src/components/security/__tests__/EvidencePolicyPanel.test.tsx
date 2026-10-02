/**
 * The evidence-availability panel. The guard that matters: the panel renders
 * the shipped default on every row, so an operator can always answer "why was
 * this allowed" from the screen, and a value that differs from the default says
 * so rather than looking like the only possible behavior.
 */
import { it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { toast } from '@/components/ui/toast-store';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/context/AuthContext');
vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn(), loading: vi.fn(() => 'id'), dismiss: vi.fn() },
}));

import { apiFetch } from '@/lib/api';
import * as AuthContext from '@/context/AuthContext';
import { EvidencePolicyPanel } from '../EvidencePolicyPanel';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const DEFAULTS = {
  scannerUnavailable: 'allow',
  scanFailure: 'block',
  candidateUnproven: 'block',
  isDefault: true,
};

function payload(overrides: Record<string, unknown> = {}) {
  return {
    policy: { ...DEFAULTS, ...overrides },
    defaults: DEFAULTS,
    outcomes: ['allow', 'warn', 'block'],
  };
}

function asAdmin() {
  vi.mocked(AuthContext.useAuth).mockReturnValue({
    isAdmin: true,
    can: () => true,
  } as unknown as ReturnType<typeof AuthContext.useAuth>);
}

/** One row's radio, scoped by the group's accessible name so a click cannot
 *  land on a sibling row's identically-labelled option. */
function radio(rowName: string, option: string): HTMLElement {
  return within(screen.getByRole('radiogroup', { name: rowName })).getByRole('radio', { name: option });
}

beforeEach(() => {
  vi.clearAllMocks();
  asAdmin();
  mockedFetch.mockResolvedValue(jsonResponse(200, payload()));
});

it('states the active setting and the shipped default on every row', async () => {
  render(<EvidencePolicyPanel />);
  await waitFor(() => expect(screen.getByText('Evidence availability')).toBeInTheDocument());
  // Every row's help text names the default, so it is never hidden.
  expect(screen.getAllByText(/Default: allow\./).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/Default: block\./).length).toBeGreaterThan(0);
});

it('marks a value that differs from the default', async () => {
  mockedFetch.mockResolvedValue(jsonResponse(200, payload({ scannerUnavailable: 'block', isDefault: false })));
  render(<EvidencePolicyPanel />);
  await waitFor(() => expect(screen.getByText(/Changed from the default \(allow\)/)).toBeInTheDocument());
});

it('does not claim a default change when the value matches', async () => {
  render(<EvidencePolicyPanel />);
  await waitFor(() => expect(screen.getByText('Evidence availability')).toBeInTheDocument());
  expect(screen.queryByText(/Changed from the default/)).not.toBeInTheDocument();
});

it('sends only the changed field', async () => {
  render(<EvidencePolicyPanel />);
  await waitFor(() => expect(screen.getByText('Evidence availability')).toBeInTheDocument());

  // The write answers with the resolved policy alone, no read envelope.
  mockedFetch.mockResolvedValue(jsonResponse(200, { policy: payload({ scanFailure: 'warn' }).policy }));
  fireEvent.click(radio('Scan failed', 'Warn'));

  await waitFor(() => {
    const call = mockedFetch.mock.calls.find(
      ([url, init]) => url === '/security/evidence-policy' && init?.method === 'PUT',
    );
    expect(call).toBeTruthy();
    expect(JSON.parse((call?.[1] as { body: string }).body)).toEqual({ scanFailure: 'warn' });
  });
});

it('shows a layout-matched placeholder while loading rather than a blank pane', async () => {
  // The panel sits inside a tab, so returning nothing would pop it into
  // existence and shift the tab when the policy arrived.
  let release: ((value: Response) => void) | undefined;
  mockedFetch.mockImplementation(
    () => new Promise<Response>((resolve) => { release = resolve; }),
  );
  const { container } = render(<EvidencePolicyPanel />);

  // Loading: a placeholder is present and no controls are.
  await waitFor(() => expect(container.querySelectorAll('[class*="animate-pulse"]').length).toBeGreaterThan(0));
  expect(screen.queryByRole('radiogroup', { name: 'Scanner unavailable' })).not.toBeInTheDocument();
  // Layout-matched, not a bare placeholder: it carries the same card material as
  // the loaded panel, so there is no shift when the real content arrives.
  expect(container.querySelector('[class*="shadow-card-bevel"]')).not.toBeNull();

  release?.(jsonResponse(200, payload()));
  // Loaded: the placeholder is gone and the controls are usable.
  await waitFor(() => expect(screen.getByRole('radiogroup', { name: 'Scanner unavailable' })).toBeInTheDocument());
  expect(container.querySelectorAll('[class*="animate-pulse"]').length).toBe(0);
});

it('surfaces a read failure and says the shipped default is in force', async () => {
  mockedFetch.mockResolvedValue(jsonResponse(500, {}));
  render(<EvidencePolicyPanel />);
  await waitFor(() => expect(screen.getByText(/could not be read/)).toBeInTheDocument());
  // The fallback copy has to describe all three defaults, not just the first.
  // It must not claim to know what the gate currently enforces: a failed read
  // says nothing about the stored values.
  expect(screen.getByText(/currently enforces is unknown/)).toBeInTheDocument();
  expect(screen.getByText(/a read failure falls back to the shipped defaults/)).toBeInTheDocument();
});

it('accepts the write response, which carries the policy without the read envelope', async () => {
  // Regression: the write answers `{ policy }` with no `defaults`. Parsing it
  // with the stricter read parser rejected every save, and the unit tests missed
  // it because they fed the read shape to the write path.
  render(<EvidencePolicyPanel />);
  await waitFor(() => expect(screen.getByText('Evidence availability')).toBeInTheDocument());

  mockedFetch.mockResolvedValue(
    jsonResponse(200, {
      policy: { scannerUnavailable: 'block', scanFailure: 'block', candidateUnproven: 'block', isDefault: false },
    }),
  );
  fireEvent.click(radio('Scanner unavailable', 'Block'));

  await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Evidence policy updated'));
  expect(toast.error).not.toHaveBeenCalled();
  // And the screen reflects the value the server resolved.
  await waitFor(() => expect(screen.getByText(/Changed from the default \(allow\)/)).toBeInTheDocument());
});

it('rejects a write response whose policy is malformed', async () => {
  render(<EvidencePolicyPanel />);
  await waitFor(() => expect(screen.getByText('Evidence availability')).toBeInTheDocument());

  mockedFetch.mockResolvedValue(jsonResponse(200, { policy: { scannerUnavailable: 'maybe' } }));
  fireEvent.click(radio('Scanner unavailable', 'Block'));

  await waitFor(() => expect(toast.error).toHaveBeenCalled());
  expect(toast.success).not.toHaveBeenCalled();
});

it('treats an unexpected payload as unreadable rather than rendering nonsense', async () => {
  // A node behind the proxy can answer with a shape this build does not know;
  // the panel must not take the Policies tab down with it.
  mockedFetch.mockResolvedValue(jsonResponse(200, { policy: { scannerUnavailable: 'nonsense' } }));
  render(<EvidencePolicyPanel />);
  await waitFor(() => expect(screen.getByText(/could not be read/)).toBeInTheDocument());
});

it('disables the controls for a non-admin', async () => {
  vi.mocked(AuthContext.useAuth).mockReturnValue({
    isAdmin: false,
    can: () => true,
  } as unknown as ReturnType<typeof AuthContext.useAuth>);
  render(<EvidencePolicyPanel />);
  await waitFor(() => expect(screen.getByText(/read-only for your role/)).toBeInTheDocument());
  expect(radio('Scanner unavailable', 'Block')).toBeDisabled();
  expect(radio('Candidate not evaluated', 'Allow')).toBeDisabled();
});

it('keeps showing the active values to a non-admin', async () => {
  vi.mocked(AuthContext.useAuth).mockReturnValue({
    isAdmin: false,
    can: () => true,
  } as unknown as ReturnType<typeof AuthContext.useAuth>);
  render(<EvidencePolicyPanel />);
  // Read-only must not mean opaque: the defaults still have to be visible.
  await waitFor(() => expect(screen.getAllByText(/Default: allow\./).length).toBeGreaterThan(0));
});

it('reports a rejected write without claiming success', async () => {
  render(<EvidencePolicyPanel />);
  await waitFor(() => expect(screen.getByText('Evidence availability')).toBeInTheDocument());

  mockedFetch.mockResolvedValue(jsonResponse(400, { error: 'scanFailure must be one of: allow, warn, block' }));
  fireEvent.click(radio('Scan failed', 'Warn'));

  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('scanFailure must be one of: allow, warn, block'));
  expect(toast.success).not.toHaveBeenCalled();
});
