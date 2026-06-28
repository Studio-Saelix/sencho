/**
 * Covers the Compose Doctor panel: the never-run empty state, the all-clear and
 * graded-findings summaries, the unrenderable banner, a load-failure retry
 * state, and running preflight on demand.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/context/NodeContext', () => ({ useNodes: () => ({ activeNode: { id: 1 } }) }));

import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import PreflightPanel from './PreflightPanel';

interface Finding {
  ruleId: string;
  severity: 'blocker' | 'high' | 'warning' | 'info';
  title: string;
  message: string;
  sourcePath?: string;
  remediation?: string;
  service?: string;
}
interface Report {
  stack: string;
  ranAt: number | null;
  ranBy: string | null;
  renderable: boolean;
  renderError: string | null;
  status: string;
  highestSeverity: string | null;
  findings: Finding[];
}

function report(partial: Partial<Report>): Report {
  return { stack: 'web', ranAt: 1000, ranBy: 'admin', renderable: true, renderError: null, status: 'pass', highestSeverity: null, findings: [], ...partial };
}

function jsonRes(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body, text: async () => '' } as unknown as Response;
}

beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });

describe('PreflightPanel', () => {
  it('shows the never-run empty state', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({ status: 'never-run', ranAt: null })));
    render(<PreflightPanel stackName="web" />);
    expect(await screen.findByText(/Run preflight to render the effective model/i)).toBeInTheDocument();
  });

  it('renders the all-clear summary when there are no findings', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({ status: 'pass' })));
    render(<PreflightPanel stackName="web" />);
    const status = await screen.findByTestId('preflight-status');
    expect(status).toHaveAttribute('data-status', 'pass');
    expect(status).toHaveTextContent(/all clear/i);
  });

  it('groups findings and reflects the highest severity', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      status: 'high',
      highestSeverity: 'high',
      findings: [
        { ruleId: 'privileged', severity: 'high', title: 'Privileged container', message: 'runs privileged', service: 'web' },
        { ruleId: 'image-latest', severity: 'warning', title: 'Image uses a moving tag', message: 'latest tag', service: 'web' },
      ],
    })));
    render(<PreflightPanel stackName="web" />);
    const status = await screen.findByTestId('preflight-status');
    expect(status).toHaveAttribute('data-status', 'high');
    expect(screen.getByText('Privileged container')).toBeInTheDocument();
    expect(screen.getByText('Image uses a moving tag')).toBeInTheDocument();
  });

  it('dismisses only the result banner, keeping the finding rows', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      status: 'high', highestSeverity: 'high',
      findings: [{ ruleId: 'privileged', severity: 'high', title: 'Privileged container', message: 'runs privileged', service: 'web' }],
    })));
    render(<PreflightPanel stackName="web" />);
    expect(await screen.findByTestId('preflight-status')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('preflight-dismiss-btn'));
    expect(screen.queryByTestId('preflight-status')).not.toBeInTheDocument();
    // Only the summary banner is dismissed; the finding row remains.
    expect(screen.getByText('Privileged container')).toBeInTheDocument();
  });

  it('surfaces the unrenderable state with the render error', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      renderable: false, status: 'unrenderable', highestSeverity: 'blocker',
      renderError: 'Sencho could not render the effective Compose model.',
      findings: [{ ruleId: 'render-failed', severity: 'blocker', title: 'Compose model could not be rendered', message: 'Sencho could not render the effective Compose model.' }],
    })));
    render(<PreflightPanel stackName="web" />);
    const status = await screen.findByTestId('preflight-status');
    expect(status).toHaveAttribute('data-status', 'unrenderable');
    expect(status).toHaveTextContent(/cannot render/i);
  });

  it('shows a retry state and toasts when the load fails', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(null, false));
    render(<PreflightPanel stackName="web" />);
    expect(await screen.findByText(/Could not load the preflight report/i)).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalled();
  });

  it('runs preflight on demand and shows the new findings', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(jsonRes(report({ status: 'never-run', ranAt: null })))
      .mockResolvedValueOnce(jsonRes(report({
        status: 'blocker', highestSeverity: 'blocker',
        findings: [{ ruleId: 'port-conflict-node', severity: 'blocker', title: 'Host port 8080 is already in use', message: 'taken', service: 'web' }],
      })));
    render(<PreflightPanel stackName="web" />);
    fireEvent.click(await screen.findByTestId('preflight-run-btn'));
    expect(await screen.findByText('Host port 8080 is already in use')).toBeInTheDocument();
    await waitFor(() => {
      const calls = vi.mocked(apiFetch).mock.calls;
      expect(calls.some(([url, opts]) => String(url).includes('/preflight/run') && (opts as RequestInit | undefined)?.method === 'POST')).toBe(true);
    });
  });
});
