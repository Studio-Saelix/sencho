/**
 * Which node the evidence-policy panel talks to, through the real `apiFetch`.
 *
 * The panel names a node and writes a security policy to it. The default
 * request targeting reads the active node from shared browser storage, which a
 * second tab can change while this tab stays mounted on the first node. These
 * tests move that storage after the panel has rendered and assert on the
 * headers that actually reach the network, so a request that follows the
 * storage instead of the panel fails here. `apiFetch` is deliberately not
 * mocked: a mock of it would accept whatever targeting the panel asked for.
 */
import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { toast } from '@/components/ui/toast-store';

vi.mock('@/context/AuthContext');
vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn(), loading: vi.fn(() => 'id'), dismiss: vi.fn() },
}));

import * as AuthContext from '@/context/AuthContext';
import { EvidencePolicyPanel } from '../EvidencePolicyPanel';

const ACTIVE_NODE_KEY = 'sencho-active-node';
const NODE_A = 1;
const NODE_B = 2;

const DEFAULTS = { scannerUnavailable: 'allow', scanFailure: 'block', candidateUnproven: 'block', isDefault: true };

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body, clone() { return this; } } as unknown as Response;
}

const readBody = (overrides: Record<string, unknown> = {}) => ({
  policy: { ...DEFAULTS, ...overrides },
  defaults: DEFAULTS,
  outcomes: ['allow', 'warn', 'block'],
});

type Seen = { method: string; node: string | undefined };
let seen: Seen[];
let fetchImpl: (method: string) => Response;

function radio(rowName: string, option: string): HTMLElement {
  return within(screen.getByRole('radiogroup', { name: rowName })).getByRole('radio', { name: option });
}

/** Another tab switched the active node: storage moves, this tab's React state does not. */
const otherTabSwitchesTo = (nodeId: number) => localStorage.setItem(ACTIVE_NODE_KEY, String(nodeId));

beforeEach(() => {
  vi.clearAllMocks();
  seen = [];
  fetchImpl = () => jsonResponse(200, readBody());
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    seen.push({ method, node: (init?.headers as Record<string, string> | undefined)?.['x-node-id'] });
    return fetchImpl(method);
  }));
  vi.mocked(AuthContext.useAuth).mockReturnValue({ isAdmin: true, can: () => true } as unknown as ReturnType<typeof AuthContext.useAuth>);
  localStorage.setItem(ACTIVE_NODE_KEY, String(NODE_A));
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.removeItem(ACTIVE_NODE_KEY);
});

it('reads from the node it displays even when the shared active node already names another', async () => {
  otherTabSwitchesTo(NODE_B);
  render(<EvidencePolicyPanel nodeId={NODE_A} nodeName="A" />);
  await waitFor(() => expect(screen.getByText('Evidence availability')).toBeInTheDocument());
  expect(seen).toEqual([{ method: 'GET', node: String(NODE_A) }]);
});

it.each([
  ['Scanner unavailable', 'Block', { scannerUnavailable: 'block' }],
  ['Scan failed', 'Warn', { scanFailure: 'warn' }],
  ['Candidate not evaluated', 'Allow', { candidateUnproven: 'allow' }],
])('writes the %s control to the displayed node after another tab switched nodes', async (row, option, expected) => {
  render(<EvidencePolicyPanel nodeId={NODE_A} nodeName="A" />);
  await waitFor(() => expect(screen.getByText('Evidence availability')).toBeInTheDocument());

  otherTabSwitchesTo(NODE_B);
  fetchImpl = (method) => jsonResponse(200, method === 'PUT' ? { policy: readBody(expected).policy } : readBody());
  fireEvent.click(radio(row, option));

  await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Evidence policy updated on A'));
  const puts = seen.filter((s) => s.method === 'PUT');
  expect(puts).toEqual([{ method: 'PUT', node: String(NODE_A) }]);
  // Nothing the panel sent ever followed the storage to the other node.
  expect(seen.every((s) => s.node === String(NODE_A))).toBe(true);
});

it('reads back from the displayed node when a save is accepted but its answer cannot be read', async () => {
  render(<EvidencePolicyPanel nodeId={NODE_A} nodeName="A" />);
  await waitFor(() => expect(screen.getByText('Evidence availability')).toBeInTheDocument());

  otherTabSwitchesTo(NODE_B);
  fetchImpl = (method) => (method === 'PUT'
    ? ({ ok: true, status: 200, headers: new Headers(), json: async () => { throw new SyntaxError('Unexpected token <'); }, clone() { return this; } } as unknown as Response)
    : jsonResponse(200, readBody({ scannerUnavailable: 'block', isDefault: false })));
  fireEvent.click(radio('Scanner unavailable', 'Block'));

  await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/did not confirm it/)));
  // The PUT and the GET that verifies it, both on the displayed node.
  expect(seen.slice(1)).toEqual([
    { method: 'PUT', node: String(NODE_A) },
    { method: 'GET', node: String(NODE_A) },
  ]);
  expect(toast.success).not.toHaveBeenCalled();
});

it('retries a failed read on the displayed node after another tab switched nodes', async () => {
  fetchImpl = () => jsonResponse(500, {});
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  render(<EvidencePolicyPanel nodeId={NODE_A} nodeName="A" />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument());

  otherTabSwitchesTo(NODE_B);
  fetchImpl = () => jsonResponse(200, readBody());
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

  await waitFor(() => expect(screen.getByText('Evidence availability')).toBeInTheDocument());
  expect(seen).toEqual([
    { method: 'GET', node: String(NODE_A) },
    { method: 'GET', node: String(NODE_A) },
  ]);
  consoleError.mockRestore();
});
