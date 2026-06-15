/**
 * ScanNodeLauncher: hidden unless the caller can scan; opens a three-type
 * selector; starting posts to /security/scan-node with the selected types, the
 * deploy session, and the node captured at launch (so the request and the
 * progress stream stay bound to the same node).
 */
import { it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiFetch = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  withDeploySession: (id: string, opts: Record<string, unknown>) => ({ ...opts, __session: id }),
}));

const runWithLog = vi.fn(
  (_params: unknown, run: (started: Promise<void>, sessionId: string) => Promise<unknown>) =>
    run(Promise.resolve(), 'sess-1'),
);
vi.mock('@/context/DeployFeedbackContext', () => ({ useDeployFeedback: () => ({ runWithLog }) }));
vi.mock('@/context/NodeContext', () => ({ useNodes: () => ({ activeNode: { id: 3, name: 'local' } }) }));
vi.mock('@/components/ui/toast-store', () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));

import { ScanNodeLauncher } from '../ScanNodeLauncher';
import { toast } from '@/components/ui/toast-store';

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
  runWithLog.mockClear();
  (toast.error as ReturnType<typeof vi.fn>).mockClear();
});

it('renders nothing when scanning is not allowed', () => {
  const { container } = render(<ScanNodeLauncher canScan={false} />);
  expect(container).toBeEmptyDOMElement();
});

it('shows the launcher button when scanning is allowed', () => {
  render(<ScanNodeLauncher canScan />);
  expect(screen.getByRole('button', { name: /Scan this node/i })).toBeInTheDocument();
});

it('opens a three-type selector and scans the captured node with the chosen types', async () => {
  const onComplete = vi.fn();
  render(<ScanNodeLauncher canScan onComplete={onComplete} />);

  await userEvent.click(screen.getByRole('button', { name: /Scan this node/i }));
  expect(screen.getByLabelText('Image vulnerabilities')).toBeInTheDocument();
  expect(screen.getByLabelText('Image secrets')).toBeInTheDocument();
  expect(screen.getByLabelText('Compose misconfigurations')).toBeInTheDocument();

  // Drop secrets, keep vulns + misconfig.
  await userEvent.click(screen.getByLabelText('Image secrets'));
  await userEvent.click(screen.getByRole('button', { name: /Start scan/i }));

  await waitFor(() => expect(apiFetch).toHaveBeenCalled());
  const [url, opts] = apiFetch.mock.calls[0] as [string, Record<string, unknown>];
  expect(url).toBe('/security/scan-node');
  expect(opts.method).toBe('POST');
  expect(opts.nodeId).toBe(3);
  expect(opts.__session).toBe('sess-1');
  expect(JSON.parse(opts.body as string)).toEqual({ vulns: true, secrets: false, misconfig: true });
  await waitFor(() => expect(onComplete).toHaveBeenCalled());
});

it('toasts the server error when the scan request fails and still refreshes', async () => {
  apiFetch.mockResolvedValue({ ok: false, json: async () => ({ error: 'Already scanning this node' }) });
  const onComplete = vi.fn();
  render(<ScanNodeLauncher canScan onComplete={onComplete} />);

  await userEvent.click(screen.getByRole('button', { name: /Scan this node/i }));
  await userEvent.click(screen.getByRole('button', { name: /Start scan/i }));

  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Already scanning this node'));
  await waitFor(() => expect(onComplete).toHaveBeenCalled());
});
