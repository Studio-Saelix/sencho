/**
 * The scan banner's Rescan verb: it starts the scan on the node that owns the
 * stack, follows it to the new result without a reload, never dismisses, and is
 * offered only to an account that can deploy the stack.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
const authBox: { canDeploy: boolean } = { canDeploy: true };
const canSpy = vi.fn((action: string) => action !== 'stack:deploy' || authBox.canDeploy);
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ can: canSpy }) }));

import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { ScanStatusBanner } from './ScanStatusBanner';

const json = (body: unknown, ok = true, status = ok ? 200 : 500) =>
  ({ ok, status, json: async () => body }) as Response;

/** Scan-status reads are served from a queue, the last one repeating. */
function serve(reads: unknown[], rescan: Response = json({ started: true, scanning: true }, true, 202)) {
  const queue = [...reads];
  vi.mocked(apiFetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/scan-status/rescan') && init?.method === 'POST') return rescan;
    if (url.endsWith('/scan-status')) return json(queue.length > 1 ? queue.shift() : queue[0]);
    throw new Error(`unexpected ${url}`);
  });
}

const failed = { status: 'failed', attemptedAt: 100, errorMessage: 'registry unreachable', scanning: false };
const rescanCalls = () =>
  vi.mocked(apiFetch).mock.calls.filter(([input]) => String(input).endsWith('/scan-status/rescan'));

beforeEach(() => {
  localStorage.clear();
  authBox.canDeploy = true;
  canSpy.mockClear();
  vi.mocked(apiFetch).mockReset();
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
  vi.mocked(toast.info).mockReset();
});

afterEach(() => { vi.useRealTimers(); });

async function renderBanner() {
  render(<ScanStatusBanner stackName="web" nodeId={1} />);
  await screen.findByRole('status');
}

describe('ScanStatusBanner', () => {
  it.each([
    ['a clean scan', { status: 'ok', attemptedAt: 1, errorMessage: null, scanning: false }],
    ['no scan yet', { status: null, scanning: false }],
  ])('shows nothing for %s', async (_label, body) => {
    serve([body]);
    render(<ScanStatusBanner stackName="web" nodeId={1} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows nothing when the read is refused or throws', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json({ error: 'nope' }, false, 500));
    const refused = render(<ScanStatusBanner stackName="web" nodeId={1} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('status')).toBeNull();
    refused.unmount();

    vi.mocked(apiFetch).mockRejectedValue(new Error('offline'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ScanStatusBanner stackName="web" nodeId={1} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('status')).toBeNull();
    spy.mockRestore();
  });

  it('offers Rescan to a deployer and not to anyone else', async () => {
    serve([failed]);
    await renderBanner();
    expect(screen.getByTestId('scan-rescan')).toBeDefined();
    // The grant is exact: this stack on this node, not any stack the account can deploy.
    expect(canSpy).toHaveBeenCalledWith('stack:deploy', 'stack', 'web', 1);
  });

  it('hides Rescan from an account that cannot deploy the stack', async () => {
    authBox.canDeploy = false;
    serve([failed]);
    await renderBanner();
    expect(screen.queryByTestId('scan-rescan')).toBeNull();
    expect(screen.getByLabelText('Dismiss')).toBeDefined();
  });

  it('starts the scan, follows it, and shows the new result without dismissing', async () => {
    serve([
      failed,
      { ...failed, scanning: true },
      { status: 'partial', attemptedAt: 200, errorMessage: 'one image', scanning: false },
    ]);
    await renderBanner();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    fireEvent.click(screen.getByTestId('scan-rescan'));
    await waitFor(() => expect(rescanCalls()).toHaveLength(1));
    expect(rescanCalls()[0][0]).toBe('/stacks/web/scan-status/rescan');
    await waitFor(() => expect((screen.getByTestId('scan-rescan') as HTMLButtonElement).disabled).toBe(true));

    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });

    expect(screen.getByRole('status').textContent).toContain('partially failed');
    expect(screen.getByRole('status').textContent).toContain('one image');
    expect((screen.getByTestId('scan-rescan') as HTMLButtonElement).disabled).toBe(false);
  });

  it('brings a dismissed banner back when a newer scan attempt lands', async () => {
    localStorage.setItem('sencho.scanBannerDismissed.web.1', 'failed:100');
    serve([
      { ...failed, scanning: true },
      { status: 'failed', attemptedAt: 300, errorMessage: 'still down', scanning: false },
    ]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<ScanStatusBanner stackName="web" nodeId={1} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.queryByRole('status')).toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });

    expect(screen.getByRole('status').textContent).toContain('still down');
  });

  it('follows a scan a deploy started without announcing it as a rescan', async () => {
    serve([
      { ...failed, scanning: true },
      { status: 'ok', attemptedAt: 400, errorMessage: null, scanning: false },
    ]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<ScanStatusBanner stackName="web" nodeId={1} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect((screen.getByTestId('scan-rescan') as HTMLButtonElement).disabled).toBe(true);

    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });

    expect(screen.queryByRole('status')).toBeNull();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('does not announce a rescan this click never started', async () => {
    serve(
      [failed, { ...failed, scanning: true }, { status: 'ok', attemptedAt: 400, errorMessage: null, scanning: false }],
      json({ started: false, scanning: true }, true, 202),
    );
    await renderBanner();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    fireEvent.click(screen.getByTestId('scan-rescan'));
    await waitFor(() => expect(rescanCalls()).toHaveLength(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });

    expect(toast.success).not.toHaveBeenCalled();
  });

  it('stays quiet when the rescan ends with a result that still needs attention', async () => {
    serve([
      failed,
      { ...failed, scanning: true },
      { status: 'partial', attemptedAt: 200, errorMessage: 'one image', scanning: false },
    ]);
    await renderBanner();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    fireEvent.click(screen.getByTestId('scan-rescan'));
    await waitFor(() => expect(rescanCalls()).toHaveLength(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });

    expect(toast.success).not.toHaveBeenCalled();
  });

  it('says so when the rescan finds nothing wrong, since the banner then goes away', async () => {
    serve([
      failed,
      { ...failed, scanning: true },
      { status: 'ok', attemptedAt: 200, errorMessage: null, scanning: false },
    ]);
    await renderBanner();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    fireEvent.click(screen.getByTestId('scan-rescan'));
    await waitFor(() => expect(rescanCalls()).toHaveLength(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });

    expect(screen.queryByRole('status')).toBeNull();
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('Rescan finished'));
  });

  it('surfaces a rescan that could not be sent and re-enables the button', async () => {
    serve([failed]);
    await renderBanner();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(apiFetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/rescan') && init?.method === 'POST') throw new Error('offline');
      return json(failed);
    });

    fireEvent.click(screen.getByTestId('scan-rescan'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not start the rescan.'));
    expect((screen.getByTestId('scan-rescan') as HTMLButtonElement).disabled).toBe(false);
    spy.mockRestore();
  });

  it('surfaces a refused rescan and leaves the banner in place', async () => {
    serve([failed], json({ error: 'Stack not found' }, false, 404));
    await renderBanner();

    fireEvent.click(screen.getByTestId('scan-rescan'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Stack not found'));
    expect(screen.getByRole('status')).toBeDefined();
    expect((screen.getByTestId('scan-rescan') as HTMLButtonElement).disabled).toBe(false);
  });
});
