import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));
vi.mock('@/components/ui/toast-store', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { SealingKeySheet } from '../SealingKeySheet';
import { RESET_PIN_CONSEQUENCE } from '@/lib/sealingKeyStatus';
import type { NodeSealingKeyView } from '@/hooks/useNodeSealingKey';

function json(status: number, body: unknown) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
}

const PINNED = 'pinnedFingerprintAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const PRESENTED = 'presentedFingerprintBBBBBBBBBBBBBBBBBBBBBBBBB=';
const pin = { fingerprint: PINNED, registeredAt: Date.now() - 60_000, confidential: false, confirmedBy: null, confirmedAt: null };

const remoteNode = { id: 4, name: 'edge-01', type: 'remote' as const, mode: 'proxy' as const };
const localNode = { id: 1, name: 'Local', type: 'local' as const, mode: 'proxy' as const };

function renderSheet(view: NodeSealingKeyView | Promise<unknown>, opts: { isAdmin?: boolean; canManage?: boolean; node?: typeof remoteNode | typeof localNode } = {}) {
  apiFetchMock.mockReturnValueOnce(view instanceof Promise ? view : json(200, view));
  return render(
    <SealingKeySheet
      open
      onOpenChange={vi.fn()}
      node={opts.node ?? remoteNode}
      isAdmin={opts.isAdmin ?? true}
      canManage={opts.canManage ?? true}
    />,
  );
}

async function answer() {
  return screen.findByTestId('status-answer');
}

beforeEach(() => apiFetchMock.mockReset());

describe('SealingKeySheet', () => {
  it.each([
    ['ready', 'Ready for sealed delivery', { readiness: 'ready', pinned: { ...pin, confidential: true }, presented: { fingerprint: PINNED } }],
    ['pin_unconfirmed', 'Confirm this fingerprint', { readiness: 'pin_unconfirmed', pinned: pin, presented: { fingerprint: PINNED } }],
    ['key_mismatch', 'Key changed since it was pinned', { readiness: 'key_mismatch', pinned: pin, presented: { fingerprint: PRESENTED } }],
    ['unsupported', 'This node cannot receive sealed secrets', { readiness: 'unsupported', pinned: null, presented: null }],
    ['unreachable', 'Node unreachable', { readiness: 'unreachable', pinned: pin, presented: null }],
    ['key_invalid', 'Node answered without a usable key', { readiness: 'key_invalid', pinned: pin, presented: null }],
  ] as const)('answers the %s state in one line', async (state, title, rest) => {
    renderSheet({ kind: 'remote', ...rest } as NodeSealingKeyView);
    const el = await answer();
    expect(el).toHaveAttribute('data-state', state);
    expect(within(el).getByText(title)).toBeInTheDocument();
  });

  it('shows this instance\'s own fingerprint for the local node, with no verbs', async () => {
    renderSheet({ kind: 'local', fingerprint: PINNED }, { node: localNode });
    expect(within(await answer()).getByText('This instance\'s sealing key')).toBeInTheDocument();
    expect(screen.getByTestId('sealing-fp-local')).toHaveTextContent(PINNED);
    expect(screen.queryByRole('button', { name: 'Reset pin' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm fingerprint' })).not.toBeInTheDocument();
  });

  it('shows a matching pinned and presented key once', async () => {
    renderSheet({ kind: 'remote', readiness: 'pin_unconfirmed', pinned: pin, presented: { fingerprint: PINNED } });
    await answer();
    expect(screen.getAllByText(PINNED)).toHaveLength(1);
    expect(screen.queryByTestId('sealing-fp-presented')).not.toBeInTheDocument();
  });

  it('shows both fingerprints in full when they differ', async () => {
    renderSheet({ kind: 'remote', readiness: 'key_mismatch', pinned: pin, presented: { fingerprint: PRESENTED } });
    await answer();
    expect(screen.getByTestId('sealing-fp-pinned')).toHaveTextContent(PINNED);
    expect(screen.getByTestId('sealing-fp-presented')).toHaveTextContent(PRESENTED);
  });

  it('offers Confirm fingerprint to an Admin and sends the presented fingerprint', async () => {
    renderSheet({ kind: 'remote', readiness: 'pin_unconfirmed', pinned: null, presented: { fingerprint: PRESENTED } });
    const button = await screen.findByRole('button', { name: 'Confirm fingerprint' });
    apiFetchMock.mockReturnValueOnce(json(200, { kind: 'remote', readiness: 'ready', pinned: { ...pin, fingerprint: PRESENTED, confidential: true, confirmedBy: 'admin', confirmedAt: Date.now() }, presented: { fingerprint: PRESENTED } }));
    await userEvent.click(button);
    await waitFor(() => expect(screen.getByTestId('status-answer')).toHaveAttribute('data-state', 'ready'));
    expect(apiFetchMock.mock.calls[1][0]).toBe('/nodes/4/sealing-key/confirm');
    expect(JSON.parse(apiFetchMock.mock.calls[1][1].body)).toEqual({ fingerprint: PRESENTED });
    expect(screen.getByText(/Confirmed by admin/)).toBeInTheDocument();
  });

  it('hides Confirm fingerprint from a non-Admin and says an Admin must confirm', async () => {
    renderSheet({ kind: 'remote', readiness: 'pin_unconfirmed', pinned: null, presented: { fingerprint: PRESENTED } }, { isAdmin: false });
    const el = await answer();
    expect(el).toHaveTextContent(/until an Admin confirms it/);
    expect(screen.queryByRole('button', { name: 'Confirm fingerprint' })).not.toBeInTheDocument();
  });

  it('names the startup log as the place to compare the fingerprint', async () => {
    renderSheet({ kind: 'remote', readiness: 'pin_unconfirmed', pinned: null, presented: { fingerprint: PRESENTED } });
    expect(await answer()).toHaveTextContent(/startup log/);
  });

  it('puts the reset consequence in the visible dialog body before resetting', async () => {
    renderSheet({ kind: 'remote', readiness: 'ready', pinned: { ...pin, confidential: true }, presented: { fingerprint: PINNED } });
    await answer();
    await userEvent.click(screen.getByRole('button', { name: 'Reset pin' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByTestId('reset-pin-consequence')).toHaveTextContent(RESET_PIN_CONSEQUENCE);
    expect(RESET_PIN_CONSEQUENCE).toMatch(/private registry credentials and sealed secrets/);
    expect(RESET_PIN_CONSEQUENCE).toMatch(/next contact pins/);
    // Nothing is sent until the confirm.
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    apiFetchMock.mockReturnValueOnce(json(200, {})).mockReturnValueOnce(json(200, { kind: 'remote', readiness: 'pin_unconfirmed', pinned: null, presented: { fingerprint: PINNED } }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reset pin' }));
    await waitFor(() => expect(apiFetchMock.mock.calls[1]).toEqual(['/nodes/4/sealing-key', { method: 'DELETE', localOnly: true }]));
  });

  it('carries Reset pin on the Answer for a changed key, not in the toolbar too', async () => {
    renderSheet({ kind: 'remote', readiness: 'key_mismatch', pinned: pin, presented: { fingerprint: PRESENTED } });
    const el = await answer();
    expect(within(el).getByRole('button', { name: 'Reset pin' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Reset pin' })).toHaveLength(1);
  });

  it('hides Reset pin from a session that cannot manage the node', async () => {
    renderSheet({ kind: 'remote', readiness: 'key_mismatch', pinned: pin, presented: { fingerprint: PRESENTED } }, { canManage: false });
    await answer();
    expect(screen.queryByRole('button', { name: 'Reset pin' })).not.toBeInTheDocument();
  });

  it('holds the layout while the first read is in flight', async () => {
    renderSheet(new Promise(() => {}));
    expect(await screen.findByTestId('sealing-key-loading')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByTestId('status-answer')).not.toBeInTheDocument();
  });

  it('shows a failed read with Retry, and Retry reads again', async () => {
    renderSheet(json(503, { error: 'The node did not answer.' }) as Promise<unknown>);
    const el = await answer();
    expect(el).toHaveAttribute('data-state', 'load_failed');
    expect(el).toHaveTextContent('The node did not answer.');
    apiFetchMock.mockReturnValueOnce(json(200, { kind: 'remote', readiness: 'ready', pinned: { ...pin, confidential: true }, presented: { fingerprint: PINNED } }));
    await userEvent.click(within(el).getByRole('button', { name: /Retry/ }));
    await waitFor(() => expect(screen.getByTestId('status-answer')).toHaveAttribute('data-state', 'ready'));
  });

  it('offers Retry for a node that answered without a usable key', async () => {
    renderSheet({ kind: 'remote', readiness: 'key_invalid', pinned: pin, presented: null });
    const el = await answer();
    expect(within(el).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('offers Retry for an unreachable node', async () => {
    renderSheet({ kind: 'remote', readiness: 'unreachable', pinned: pin, presented: null });
    const el = await answer();
    apiFetchMock.mockReturnValueOnce(json(200, { kind: 'remote', readiness: 'ready', pinned: { ...pin, confidential: true }, presented: { fingerprint: PINNED } }));
    await userEvent.click(within(el).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByTestId('status-answer')).toHaveAttribute('data-state', 'ready'));
  });
});
