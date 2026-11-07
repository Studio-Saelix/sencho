/**
 * Covers the Compose Doctor panel: the never-run empty state, the all-clear and
 * graded-findings summaries, the unrenderable banner, a load-failure retry
 * state, and running preflight on demand.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
let activeNodeId = 1;
vi.mock('@/context/NodeContext', () => ({ useNodes: () => ({ activeNode: { id: activeNodeId } }) }));

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
  location?: { file: string; path?: string; line: number; column: number; endLine: number; endColumn: number };
  remediation?: string;
  service?: string;
  acknowledged?: boolean;
  acknowledgementId?: number;
  acknowledgementReason?: string;
  acknowledgementExpiry?: string;
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
  coverage?: {
    state: 'complete' | 'partial' | 'unrecorded';
    evaluated: number;
    notApplicable: number;
    skipped: { ruleId: string; missing: string[]; affectsVerdict: boolean }[];
  };
}

function report(partial: Partial<Report>): Report {
  const base: Report = {
    stack: 'web', ranAt: 1000, ranBy: 'admin',
    renderable: true, renderError: null,
    status: 'pass', highestSeverity: null,
    activeStatus: 'pass', activeHighestSeverity: null,
    activeCount: 0, acknowledgedCount: 0,
    findings: [],
    coverage: { state: 'complete', evaluated: 42, notApplicable: 0, skipped: [] },
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

beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); activeNodeId = 1; });

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

  it('reads a clean run with skipped verdict checks as a partial check', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      coverage: {
        state: 'partial', evaluated: 37, notApplicable: 0,
        skipped: [
          { ruleId: 'port-conflict-node', missing: ['node-state'], affectsVerdict: true },
          { ruleId: 'new-network', missing: ['node-state'], affectsVerdict: true },
          { ruleId: 'compose-version-mismatch', missing: ['node-state', 'compose-version'], affectsVerdict: false },
        ],
      },
    })));
    render(<PreflightPanel stackName="web" />);
    const status = await screen.findByTestId('preflight-status');
    expect(status).toHaveTextContent('partial check');
    expect(status).not.toHaveTextContent(/all clear/i);
    expect(status).toHaveTextContent(
      'No issues in the checks that ran. 2 checks could not run: node state unavailable.',
    );
  });

  it('names the count alone when a skipped check reports an unknown evidence source', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      coverage: {
        state: 'partial', evaluated: 40, notApplicable: 0,
        skipped: [{ ruleId: 'some-future-rule', missing: ['a-source-this-build-does-not-know'], affectsVerdict: true }],
      },
    })));
    render(<PreflightPanel stackName="web" />);
    const status = await screen.findByTestId('preflight-status');
    expect(status).toHaveTextContent('partial check');
    expect(status).toHaveTextContent('No issues in the checks that ran. 1 check could not run.');
  });

  it('does not claim all clear on a partial run whose skipped list names no verdict check', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      coverage: { state: 'partial', evaluated: 40, notApplicable: 0, skipped: [] },
    })));
    render(<PreflightPanel stackName="web" />);
    const status = await screen.findByTestId('preflight-status');
    expect(status).toHaveTextContent('partial check');
    expect(status).toHaveTextContent('No issues in the checks that ran. 1 or more checks could not run.');
    expect(status).not.toHaveTextContent(/all clear/i);
  });

  it('does not claim all clear when coverage was not recorded', async () => {    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      coverage: { state: 'unrecorded', evaluated: 0, notApplicable: 0, skipped: [] },
    })));
    render(<PreflightPanel stackName="web" />);
    const status = await screen.findByTestId('preflight-status');
    expect(status).toHaveTextContent('pass · coverage not recorded');
    expect(status).toHaveTextContent('Run preflight again to confirm every check ran.');
    expect(status).not.toHaveTextContent(/all clear/i);
  });

  it('treats a report with no coverage field from an older node as unrecorded', async () => {
    const payload = report({ status: 'info', activeStatus: 'info' });
    delete payload.coverage;
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(payload));
    render(<PreflightPanel stackName="web" />);
    const status = await screen.findByTestId('preflight-status');
    expect(status).toHaveTextContent('info · coverage not recorded');
    expect(status).not.toHaveTextContent(/all clear/i);
  });

  it('keeps the severity summary on a partial run with active findings', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      status: 'high',
      highestSeverity: 'high',
      findings: [{ ruleId: 'privileged', severity: 'high', title: 'Privileged container', message: 'runs privileged', service: 'web' }],
      coverage: {
        state: 'partial', evaluated: 30, notApplicable: 0,
        skipped: [{ ruleId: 'port-conflict-node', missing: ['node-state'], affectsVerdict: true }],
      },
    })));
    render(<PreflightPanel stackName="web" />);
    const status = await screen.findByTestId('preflight-status');
    expect(status).toHaveAttribute('data-status', 'high');
    expect(status).toHaveTextContent('high risk');
    expect(status).not.toHaveTextContent(/partial check/i);
    expect(status).toHaveTextContent('1 high risk');
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

  it('renders a tunnel connector finding as a Note without acknowledgement and keeps All Clear', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      status: 'pass',
      activeStatus: 'pass',
      activeCount: 0,
      findings: [{
        ruleId: 'tunnel-exposure',
        severity: 'info',
        title: 'Cloudflare Tunnel connector "cloudflared" (public edge)',
        message: 'Service "cloudflared" runs a Cloudflare Tunnel connector (public edge).',
        service: 'cloudflared',
      }],
    })));
    render(<PreflightPanel stackName="web" canEdit />);
    const status = await screen.findByTestId('preflight-status');
    expect(status).toHaveAttribute('data-status', 'pass');
    expect(status).toHaveTextContent(/all clear/i);
    expect(screen.getByTestId('preflight-notes-section')).toHaveTextContent(/Cloudflare Tunnel connector/);
    expect(screen.queryByTestId('preflight-ack-btn-tunnel-exposure-cloudflared')).not.toBeInTheDocument();
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

  it('renders a Compose version mismatch as a Note without acknowledgement', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      status: 'pass',
      activeStatus: 'pass',
      activeCount: 0,
      findings: [{
        ruleId: 'compose-version-mismatch',
        severity: 'info',
        title: 'Created by another Docker Compose version',
        message: 'proxy was created by Docker Compose 2.38.1. This node deploys with Docker Compose 5.6.0, which can record a container\'s configuration or image differently, so the next deploy or update can recreate it even if nothing in the file changed.',
        remediation: 'Deploy this stack from one place.',
      }],
    })));
    render(<PreflightPanel stackName="web" canEdit />);
    const status = await screen.findByTestId('preflight-status');
    expect(status).toHaveAttribute('data-status', 'pass');
    expect(status).toHaveTextContent(/all clear/i);
    expect(screen.getByTestId('preflight-notes-section')).toHaveTextContent(/Created by another Docker Compose version/i);
    expect(screen.queryByTestId('preflight-ack-btn-compose-version-mismatch-web')).not.toBeInTheDocument();
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

  it('renders a location link in place of the sourcePath line and calls the handler', async () => {
    const onOpenLocation = vi.fn();
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      status: 'warning', highestSeverity: 'warning',
      findings: [{
        ruleId: 'image-latest', severity: 'warning', title: 'Image uses a moving tag', message: 'latest tag',
        service: 'web', sourcePath: 'web',
        location: { file: 'compose.override.yaml', path: 'services.web.image', line: 14, column: 12, endLine: 14, endColumn: 22 },
      }],
    })));
    render(<PreflightPanel stackName="web" onOpenLocation={onOpenLocation} />);
    const link = await screen.findByRole('button', { name: 'Open compose.override.yaml at line 14' });
    expect(link).toHaveTextContent('compose.override.yaml:14');
    // The service chip still says "web"; the old sourcePath line is gone.
    expect(screen.queryAllByText('web')).toHaveLength(1);
    fireEvent.click(link);
    await waitFor(() => {
      expect(onOpenLocation).toHaveBeenCalledWith(expect.objectContaining({ file: 'compose.override.yaml', line: 14 }));
    });
  });

  it('re-reads the report before opening a location and opens nothing when the fresh read dropped it', async () => {
    const onOpenLocation = vi.fn();
    const located = report({
      status: 'warning', highestSeverity: 'warning',
      findings: [{
        ruleId: 'image-latest', severity: 'warning', title: 'Image uses a moving tag', message: 'latest tag',
        service: 'web', sourcePath: 'web',
        location: { file: 'compose.override.yaml', path: 'services.web.image', line: 14, column: 12, endLine: 14, endColumn: 22 },
      }],
    });
    const dropped = report({
      status: 'warning', highestSeverity: 'warning',
      findings: [{
        ruleId: 'image-latest', severity: 'warning', title: 'Image uses a moving tag', message: 'latest tag',
        service: 'web', sourcePath: 'web',
      }],
    });
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(jsonRes(located))
      .mockResolvedValueOnce(jsonRes(dropped));
    render(<PreflightPanel stackName="web" onOpenLocation={onOpenLocation} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open compose.override.yaml at line 14' }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^Open / })).toBeNull();
    });
    expect(onOpenLocation).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalled();
  });

  it('opens the refreshed range when the file moved the finding', async () => {
    const onOpenLocation = vi.fn();
    const before = report({
      status: 'warning', highestSeverity: 'warning',
      findings: [{
        ruleId: 'image-latest', severity: 'warning', title: 'Image uses a moving tag', message: 'latest tag',
        service: 'web', sourcePath: 'web',
        location: { file: 'compose.override.yaml', path: 'services.web.image', line: 14, column: 12, endLine: 14, endColumn: 22 },
      }],
    });
    const after = report({
      status: 'warning', highestSeverity: 'warning',
      findings: [{
        ruleId: 'image-latest', severity: 'warning', title: 'Image uses a moving tag', message: 'latest tag',
        service: 'web', sourcePath: 'web',
        location: { file: 'compose.override.yaml', path: 'services.web.image', line: 17, column: 12, endLine: 17, endColumn: 22 },
      }],
    });
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(jsonRes(before))
      .mockResolvedValueOnce(jsonRes(after));
    render(<PreflightPanel stackName="web" onOpenLocation={onOpenLocation} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open compose.override.yaml at line 14' }));
    await waitFor(() => {
      expect(onOpenLocation).toHaveBeenCalledWith(expect.objectContaining({ file: 'compose.override.yaml', line: 17 }));
    });
    expect(onOpenLocation).not.toHaveBeenCalledWith(expect.objectContaining({ line: 14 }));
  });

  it('opens the clicked row when two findings share an identity', async () => {
    const onOpenLocation = vi.fn();
    const shared = {
      ruleId: 'bind-path-missing', severity: 'high' as const,
      title: 'Bind mount path is missing',
      message: 'The host path "/data" for service "web" does not exist.',
      service: 'web', sourcePath: '/data',
    };
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(jsonRes(report({
        status: 'high', highestSeverity: 'high',
        findings: [
          { ...shared, location: { file: 'compose.yaml', line: 4, column: 7, endLine: 4, endColumn: 18 } },
          { ...shared, location: { file: 'compose.yaml', line: 9, column: 7, endLine: 9, endColumn: 18 } },
        ],
      })))
      .mockResolvedValueOnce(jsonRes(report({
        status: 'high', highestSeverity: 'high',
        findings: [
          { ...shared, location: { file: 'compose.yaml', line: 12, column: 7, endLine: 12, endColumn: 18 } },
          { ...shared, location: { file: 'compose.yaml', line: 9, column: 7, endLine: 9, endColumn: 18 } },
        ],
      })));
    render(<PreflightPanel stackName="web" onOpenLocation={onOpenLocation} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open compose.yaml at line 9' }));
    await waitFor(() => {
      expect(onOpenLocation).toHaveBeenCalledWith(expect.objectContaining({ line: 9 }));
    });
    expect(onOpenLocation).not.toHaveBeenCalledWith(expect.objectContaining({ line: 12 }));
  });

  it('ignores a superseded click response that arrives after a later one', async () => {
    const onOpenLocation = vi.fn();
    const initial = report({
      status: 'high', highestSeverity: 'high',
      findings: [
        {
          ruleId: 'image-latest', severity: 'warning', title: 'First', message: 'first',
          service: 'web', location: { file: 'compose.yaml', line: 4, column: 7, endLine: 4, endColumn: 18 },
        },
        {
          ruleId: 'privileged', severity: 'high', title: 'Second', message: 'second',
          service: 'web', location: { file: 'compose.yaml', line: 9, column: 7, endLine: 9, endColumn: 18 },
        },
      ],
    });
    const afterFirst = report({
      status: 'high', highestSeverity: 'high',
      findings: [
        {
          ruleId: 'image-latest', severity: 'warning', title: 'First', message: 'first',
          service: 'web', location: { file: 'compose.yaml', line: 5, column: 7, endLine: 5, endColumn: 18 },
        },
        {
          ruleId: 'privileged', severity: 'high', title: 'Second', message: 'second',
          service: 'web', location: { file: 'compose.yaml', line: 9, column: 7, endLine: 9, endColumn: 18 },
        },
      ],
    });
    const afterSecond = report({
      status: 'high', highestSeverity: 'high',
      findings: [
        {
          ruleId: 'image-latest', severity: 'warning', title: 'First', message: 'first',
          service: 'web', location: { file: 'compose.yaml', line: 4, column: 7, endLine: 4, endColumn: 18 },
        },
        {
          ruleId: 'privileged', severity: 'high', title: 'Second', message: 'second',
          service: 'web', location: { file: 'compose.yaml', line: 12, column: 7, endLine: 12, endColumn: 18 },
        },
      ],
    });
    let resolveFirst!: (value: Response) => void;
    let resolveSecond!: (value: Response) => void;
    const firstPending = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    const secondPending = new Promise<Response>((resolve) => { resolveSecond = resolve; });
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(jsonRes(initial))
      .mockReturnValueOnce(firstPending)
      .mockReturnValueOnce(secondPending);
    render(<PreflightPanel stackName="web" onOpenLocation={onOpenLocation} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open compose.yaml at line 4' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open compose.yaml at line 9' }));
    resolveSecond(jsonRes(afterSecond));
    await waitFor(() => {
      expect(onOpenLocation).toHaveBeenCalledWith(expect.objectContaining({ line: 12 }));
    });
    resolveFirst(jsonRes(afterFirst));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(onOpenLocation).toHaveBeenCalledTimes(1);
  });

  it('drops a click response from a stack the panel no longer shows', async () => {
    const onOpenLocation = vi.fn();
    const web = report({
      status: 'warning', highestSeverity: 'warning',
      findings: [{
        ruleId: 'image-latest', severity: 'warning', title: 'Image uses a moving tag', message: 'latest tag',
        service: 'web', location: { file: 'compose.override.yaml', line: 14, column: 12, endLine: 14, endColumn: 22 },
      }],
    });
    const api = report({ stack: 'api', status: 'pass' });
    let resolvePending!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolvePending = resolve; });
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(jsonRes(web))
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce(jsonRes(api));
    const { rerender } = render(<PreflightPanel stackName="web" onOpenLocation={onOpenLocation} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open compose.override.yaml at line 14' }));
    rerender(<PreflightPanel stackName="api" onOpenLocation={onOpenLocation} />);
    expect(await screen.findByText('No issues found in the effective model.')).toBeInTheDocument();
    resolvePending(jsonRes(web));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(onOpenLocation).not.toHaveBeenCalled();
    expect(screen.queryByText('Image uses a moving tag')).toBeNull();
  });

  it('drops a click response from a node the panel no longer shows', async () => {
    const onOpenLocation = vi.fn();
    const firstNode = report({
      status: 'warning', highestSeverity: 'warning',
      findings: [{
        ruleId: 'image-latest', severity: 'warning', title: 'Image uses a moving tag', message: 'latest tag',
        service: 'web', location: { file: 'compose.override.yaml', line: 14, column: 12, endLine: 14, endColumn: 22 },
      }],
    });
    const secondNode = report({ status: 'pass' });
    let resolvePending!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolvePending = resolve; });
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(jsonRes(firstNode))
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce(jsonRes(secondNode));
    const { rerender } = render(<PreflightPanel stackName="web" onOpenLocation={onOpenLocation} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open compose.override.yaml at line 14' }));
    activeNodeId = 2;
    rerender(<PreflightPanel stackName="web" onOpenLocation={onOpenLocation} />);
    expect(await screen.findByText('No issues found in the effective model.')).toBeInTheDocument();
    resolvePending(jsonRes(firstNode));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(onOpenLocation).not.toHaveBeenCalled();
    expect(screen.queryByText('Image uses a moving tag')).toBeNull();
  });

  it('opens nothing when the panel unmounts before the read returns', async () => {
    const onOpenLocation = vi.fn();
    const located = report({
      status: 'warning', highestSeverity: 'warning',
      findings: [{
        ruleId: 'image-latest', severity: 'warning', title: 'Image uses a moving tag', message: 'latest tag',
        service: 'web', location: { file: 'compose.override.yaml', line: 14, column: 12, endLine: 14, endColumn: 22 },
      }],
    });
    let resolvePending!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolvePending = resolve; });
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(jsonRes(located))
      .mockReturnValueOnce(pending);
    const { unmount } = render(<PreflightPanel stackName="web" onOpenLocation={onOpenLocation} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open compose.override.yaml at line 14' }));
    unmount();
    resolvePending(jsonRes(located));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(onOpenLocation).not.toHaveBeenCalled();
  });

  it('opens nothing when the location cannot be confirmed', async () => {
    const onOpenLocation = vi.fn();
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(jsonRes(report({
        status: 'warning', highestSeverity: 'warning',
        findings: [{
          ruleId: 'image-latest', severity: 'warning', title: 'Image uses a moving tag', message: 'latest tag',
          service: 'web', sourcePath: 'web',
          location: { file: 'compose.override.yaml', path: 'services.web.image', line: 14, column: 12, endLine: 14, endColumn: 22 },
        }],
      })))
      .mockResolvedValueOnce(jsonRes(null, false));
    render(<PreflightPanel stackName="web" onOpenLocation={onOpenLocation} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open compose.override.yaml at line 14' }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Could not confirm this location is still current.');
    });
    expect(onOpenLocation).not.toHaveBeenCalled();
  });

  it('revalidates a note finding location on use', async () => {
    const onOpenLocation = vi.fn();
    const located = report({
      status: 'pass', activeCount: 0,
      findings: [{
        ruleId: 'healthcheck-inherited', severity: 'info', title: 'Healthcheck inherited from image',
        message: 'Service "web" does not declare a healthcheck in Compose.', service: 'web',
        location: { file: 'compose.yaml', line: 6, column: 5, endLine: 6, endColumn: 18 },
      }],
    });
    const dropped = report({
      status: 'pass', activeCount: 0,
      findings: [{
        ruleId: 'healthcheck-inherited', severity: 'info', title: 'Healthcheck inherited from image',
        message: 'Service "web" does not declare a healthcheck in Compose.', service: 'web',
      }],
    });
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(jsonRes(located))
      .mockResolvedValueOnce(jsonRes(dropped));
    render(<PreflightPanel stackName="web" onOpenLocation={onOpenLocation} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open compose.yaml at line 6' }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^Open / })).toBeNull();
    });
    expect(onOpenLocation).not.toHaveBeenCalled();
  });

  it('keeps the plain sourcePath line for a finding without a location', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      status: 'warning', highestSeverity: 'warning',
      findings: [{
        ruleId: 'image-latest', severity: 'warning', title: 'Image uses a moving tag', message: 'latest tag',
        sourcePath: 'networks.edge',
      }],
    })));
    render(<PreflightPanel stackName="web" onOpenLocation={vi.fn()} />);
    expect(await screen.findByText('networks.edge')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Open / })).toBeNull();
  });

  it('shows no location on an acknowledged row', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      status: 'warning', highestSeverity: 'warning', activeCount: 0, acknowledgedCount: 1,
      findings: [{
        ruleId: 'image-latest', severity: 'warning', title: 'Image uses a moving tag', message: 'latest tag',
        service: 'web', acknowledged: true, acknowledgementId: 7, acknowledgementReason: 'accepted',
        location: { file: 'compose.yaml', line: 3, column: 12, endLine: 3, endColumn: 20 },
      }],
    })));
    render(<PreflightPanel stackName="web" onOpenLocation={vi.fn()} />);
    const acknowledgedSection = await screen.findByTestId('preflight-acknowledged-section');
    fireEvent.click(within(acknowledgedSection).getByRole('button'));
    expect(await screen.findByText('accepted')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Open / })).toBeNull();
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
