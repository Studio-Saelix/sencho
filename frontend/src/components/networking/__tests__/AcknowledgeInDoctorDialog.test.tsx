import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AcknowledgeInDoctorDialog } from '../AcknowledgeInDoctorDialog';
import type { NetworkingFinding } from '@/types/networking';

const api = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api', () => ({ apiFetch: api.apiFetch }));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({ toast: toasts }));

const res = (ok: boolean, body: unknown = {}) => ({ ok, status: ok ? 201 : 400, json: async () => body }) as Response;
const entry = (ruleId: string, extra: Record<string, unknown> = {}) => ({
  ruleId, ranAt: new Date().toISOString(), title: 't', message: 'm', severity: 'high' as const, ...extra,
});

function finding(overrides: Partial<NetworkingFinding> = {}): NetworkingFinding {
  return {
    id: 'f', kind: 'sensitive-service-broad-exposure', severity: 'high', title: 't', message: 'm', stack: 'my stack',
    evidence: [], recommendedActions: [], sources: ['doctor'], fingerprint: 'fp', count: 1, dismissPolicy: 'none',
    doctorFindings: [entry('rule-a', { service: 'db' }), entry('rule-b'), entry('rule-done', { acknowledgement: { id: 9 } })],
    ...overrides,
  };
}

function setup(f: NetworkingFinding | null = finding()) {
  const onClose = vi.fn();
  const onDone = vi.fn();
  render(<AcknowledgeInDoctorDialog finding={f} nodeId={3} onClose={onClose} onDone={onDone} />);
  return { onClose, onDone };
}

beforeEach(() => {
  api.apiFetch.mockReset();
  Object.values(toasts).forEach(fn => fn.mockReset());
});

describe('AcknowledgeInDoctorDialog', () => {
  it('writes one acknowledgement per open occurrence, until the Compose file changes, and skips ones already acknowledged', async () => {
    api.apiFetch.mockResolvedValue(res(true));
    const { onClose, onDone } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.apiFetch).toHaveBeenCalledTimes(2);
    const [path, init] = api.apiFetch.mock.calls[0] as [string, RequestInit & { nodeId?: number }];
    expect(path).toBe('/stacks/my%20stack/preflight/acknowledgements');
    expect(init.nodeId).toBe(3);
    expect(JSON.parse(init.body as string)).toEqual({ ruleId: 'rule-a', service: 'db', expiryMode: 'until_compose_change' });
    expect(JSON.parse((api.apiFetch.mock.calls[1] as [string, RequestInit])[1].body as string)).toEqual({ ruleId: 'rule-b', expiryMode: 'until_compose_change' });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('names what changes: the rules and the stack readiness effect', () => {
    setup();
    expect(screen.getByText('rule-a')).toBeInTheDocument();
    expect(screen.getByText(/changes update readiness/)).toBeInTheDocument();
  });

  it('stays open and shows the server message when a write is refused, still refreshing after a partial write', async () => {
    api.apiFetch.mockResolvedValueOnce(res(true)).mockResolvedValueOnce(res(false, { error: 'Run Compose Doctor first' }));
    const { onClose, onDone } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('Acknowledged 1 of 2. Run Compose Doctor first'));
    expect(onClose).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('does not refresh when nothing was written', async () => {
    api.apiFetch.mockResolvedValueOnce(res(false, 'not json'));
    const { onClose, onDone } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('Failed to acknowledge the finding.'));
    expect(onClose).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('reports a thrown request and stays open', async () => {
    api.apiFetch.mockRejectedValueOnce(new Error('offline'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { onClose } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('Failed to acknowledge the finding.'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('cannot confirm when every occurrence is already acknowledged', () => {
    setup(finding({ doctorFindings: [entry('x', { acknowledgement: { id: 1 } })] }));
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeDisabled();
  });
});
