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
import { isPreflightNoteFinding } from '@/lib/preflightNotes';
import PreflightPanel from './PreflightPanel';

interface Finding {
  ruleId: string;
  severity: 'blocker' | 'high' | 'warning' | 'info';
  title: string;
  message: string;
  sourcePath?: string;
  remediation?: string;
  service?: string;
  acknowledged?: boolean;
}
interface Report {
  stack: string;
  ranAt: number | null;
  ranBy: string | null;
  renderable: boolean;
  renderError: string | null;
  status: string;
  highestSeverity: string | null;
  activeStatus: string;
  activeHighestSeverity: string | null;
  activeCount: number;
  acknowledgedCount: number;
  findings: Finding[];
}

function report(partial: Partial<Report>): Report {
  const base: Report = {
    stack: 'web', ranAt: 1000, ranBy: 'admin',
    renderable: true, renderError: null,
    status: 'pass', highestSeverity: null,
    activeStatus: 'pass', activeHighestSeverity: null,
    activeCount: 0, acknowledgedCount: 0,
    findings: [],
  };
  const merged = { ...base, ...partial };
  // Derive activeStatus/activeHighestSeverity/activeCount from the old
  // fields when the caller only set those (so existing tests work without
  // every call site listing the new field names).
  if (partial.status !== undefined && partial.activeStatus === undefined) merged.activeStatus = merged.status;
  if (partial.highestSeverity !== undefined && partial.activeHighestSeverity === undefined) merged.activeHighestSeverity = merged.highestSeverity;
  if (partial.findings !== undefined && partial.activeCount === undefined) {
    merged.activeCount = merged.findings.filter(
      f => !f.acknowledged && !isPreflightNoteFinding(f.ruleId),
    ).length;
  }
  return merged;
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
    expect(status).toHaveTextContent('all clear');
    expect(status).not.toHaveTextContent(/findings acknowledged/i);
    expect(status).toHaveTextContent('No issues found in the effective model.');
  });

  it('renders all-clear · findings acknowledged when every finding is acknowledged', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      status: 'pass',
      acknowledgedCount: 1,
      findings: [{
        ruleId: 'privileged',
        severity: 'high',
        title: 'Privileged container',
        message: 'runs privileged',
        service: 'web',
        acknowledged: true,
      }],
    })));
    render(<PreflightPanel stackName="web" />);
    const status = await screen.findByTestId('preflight-status');
    expect(status).toHaveAttribute('data-status', 'pass');
    expect(status).toHaveTextContent('all clear · findings acknowledged');
    expect(status).toHaveTextContent(
      'No active findings remain. One or more detected issues were reviewed and acknowledged by an authorized operator.',
    );
    expect(status.className).toContain('border-success/40');
    expect(status.className).toContain('bg-success/[0.06]');
    expect(status.className).toContain('text-success');
    expect(status.querySelector('svg.lucide-check')).not.toBeNull();
    expect(status.querySelector('svg.lucide-shield-check')).toBeNull();
    expect(screen.getByTestId('preflight-acknowledged-section')).toBeInTheDocument();
  });

  it('keeps the severity summary when active findings remain alongside acknowledgements', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      status: 'high',
      highestSeverity: 'high',
      acknowledgedCount: 1,
      findings: [
        { ruleId: 'privileged', severity: 'high', title: 'Privileged container', message: 'runs privileged', service: 'web' },
        {
          ruleId: 'image-latest',
          severity: 'warning',
          title: 'Image uses a moving tag',
          message: 'latest tag',
          service: 'web',
          acknowledged: true,
        },
      ],
    })));
    render(<PreflightPanel stackName="web" />);
    const status = await screen.findByTestId('preflight-status');
    expect(status).toHaveAttribute('data-status', 'high');
    expect(status).toHaveTextContent('high risk');
    expect(status).not.toHaveTextContent(/all clear/i);
    expect(status).toHaveTextContent('1 active');
    expect(status).toHaveTextContent('1 acknowledged');
    expect(screen.getByText('Privileged container')).toBeInTheDocument();
    expect(screen.getByTestId('preflight-acknowledged-section')).toBeInTheDocument();
  });

  it('keeps All Clear when only inherited-healthcheck notes remain', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      status: 'pass',
      activeStatus: 'pass',
      activeCount: 0,
      findings: [{
        ruleId: 'healthcheck-inherited',
        severity: 'info',
        title: 'Healthcheck inherited from image',
        message: 'Service "web" does not declare a healthcheck in Compose.',
        service: 'web',
      }],
    })));
    render(<PreflightPanel stackName="web" canEdit />);
    const status = await screen.findByTestId('preflight-status');
    expect(status).toHaveAttribute('data-status', 'pass');
    expect(status).toHaveTextContent(/all clear/i);
    expect(screen.getByTestId('preflight-notes-section')).toHaveTextContent(/Healthcheck inherited from image/i);
    expect(screen.queryByTestId('preflight-ack-btn-healthcheck-inherited-web')).not.toBeInTheDocument();
  });

  it('renders socket-proxy client findings as Notes without acknowledgement', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      status: 'pass',
      activeStatus: 'pass',
      activeCount: 0,
      findings: [{
        ruleId: 'docker-socket-proxy-client',
        severity: 'info',
        title: 'Docker API access routed through socket proxy',
        message: 'Service "app" does not mount docker.sock directly and appears to use a Docker socket proxy instead.',
        service: 'app',
      }],
    })));
    render(<PreflightPanel stackName="web" canEdit />);
    const status = await screen.findByTestId('preflight-status');
    expect(status).toHaveAttribute('data-status', 'pass');
    expect(status).toHaveTextContent(/all clear/i);
    expect(screen.getByTestId('preflight-notes-section')).toHaveTextContent(/Docker API access routed through socket proxy/i);
    expect(screen.queryByTestId('preflight-ack-btn-docker-socket-proxy-client-app')).not.toBeInTheDocument();
    expect(status).not.toHaveTextContent(/info/i);
  });

  it('excludes notes from the graded summary line when issue findings remain', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      status: 'warning',
      highestSeverity: 'warning',
      activeStatus: 'warning',
      activeHighestSeverity: 'warning',
      activeCount: 1,
      findings: [
        {
          ruleId: 'image-latest',
          severity: 'warning',
          title: 'Image uses a moving tag',
          message: 'latest tag',
          service: 'web',
        },
        {
          ruleId: 'healthcheck-inherited',
          severity: 'info',
          title: 'Healthcheck inherited from image',
          message: 'Service "web" does not declare a healthcheck in Compose.',
          service: 'web',
        },
      ],
    })));
    render(<PreflightPanel stackName="web" canEdit />);
    const status = await screen.findByTestId('preflight-status');
    expect(status).toHaveAttribute('data-status', 'warning');
    expect(status).toHaveTextContent(/1 warning/i);
    expect(status).not.toHaveTextContent(/info/i);
    expect(screen.getByTestId('preflight-notes-section')).toBeInTheDocument();
    expect(screen.queryByTestId('preflight-ack-btn-healthcheck-inherited-web')).not.toBeInTheDocument();
    expect(screen.getByTestId('preflight-ack-btn-image-latest-web')).toBeInTheDocument();
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
