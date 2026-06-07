/**
 * Covers the read-only drift panel: it renders each per-stack status, lists
 * findings with their expected/actual values, surfaces a parse error, shows a
 * retry state on load failure, and re-checks on demand.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/context/NodeContext', () => ({ useNodes: () => ({ activeNode: { id: 1 } }) }));

import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import DriftPanel from './DriftPanel';

interface DriftReport {
  stack: string;
  status: string;
  hasComposeFile: boolean;
  hasContainers: boolean;
  findings: Array<{ kind: string; service: string; detail: string; expected?: string; actual?: string }>;
  parseError?: string;
  temporal?: { hasBaseline: boolean; sourceChanged: boolean; renderedChanged: boolean };
  ledger?: Array<{ service: string; kind: string; message: string; detectedAt: number; resolvedAt: number | null }>;
}

function report(partial: Partial<DriftReport>): DriftReport {
  return { stack: 'web', status: 'in-sync', hasComposeFile: true, hasContainers: true, findings: [], ...partial };
}

function jsonRes(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body, text: async () => '' } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DriftPanel', () => {
  it('renders the in-sync status', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({ status: 'in-sync' })));
    render(<DriftPanel stackName="web" />);
    const status = await screen.findByTestId('drift-status');
    expect(status).toHaveAttribute('data-status', 'in-sync');
    expect(screen.getByText(/Runtime matches/i)).toBeInTheDocument();
    // A clean stack shows no findings section.
    expect(screen.queryByText(/findings/i)).not.toBeInTheDocument();
  });

  it('renders every finding kind with its label and expected/actual values', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      status: 'drifted',
      findings: [
        { kind: 'image-mismatch', service: 'web', detail: 'Service "web" runs a different image than compose declares.', expected: 'nginx:1.25', actual: 'nginx:1.24' },
        { kind: 'ports-mismatch', service: 'web', detail: 'Service "web" publishes different ports than compose declares.', expected: '8080/tcp', actual: '9090/tcp' },
        { kind: 'service-missing', service: 'db', detail: 'Service "db" is declared in compose but is not running.' },
        { kind: 'service-undeclared', service: 'sidecar', detail: 'Service "sidecar" is running but is not declared in compose.' },
      ],
    })));
    render(<DriftPanel stackName="web" />);
    const status = await screen.findByTestId('drift-status');
    expect(status).toHaveAttribute('data-status', 'drifted');
    expect(screen.getByText(/4 findings/)).toBeInTheDocument();
    // Finding-kind labels.
    expect(screen.getByText('image')).toBeInTheDocument();
    expect(screen.getByText('ports')).toBeInTheDocument();
    expect(screen.getByText('service missing')).toBeInTheDocument();
    expect(screen.getByText('undeclared')).toBeInTheDocument();
    // Comparison values for image and ports findings.
    expect(screen.getByText('nginx:1.25')).toBeInTheDocument();
    expect(screen.getByText('nginx:1.24')).toBeInTheDocument();
    expect(screen.getByText('8080/tcp')).toBeInTheDocument();
    expect(screen.getByText('9090/tcp')).toBeInTheDocument();
  });

  it('uses the singular noun for a single finding', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      status: 'drifted',
      findings: [{ kind: 'service-missing', service: 'db', detail: 'Service "db" is declared in compose but is not running.' }],
    })));
    render(<DriftPanel stackName="web" />);
    await screen.findByTestId('drift-status');
    expect(screen.getByText(/1 finding$/)).toBeInTheDocument();
  });

  it('renders the missing-runtime status', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({ status: 'missing-runtime', hasContainers: false })));
    render(<DriftPanel stackName="web" />);
    const status = await screen.findByTestId('drift-status');
    expect(status).toHaveAttribute('data-status', 'missing-runtime');
  });

  it('renders the unreachable status', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({ status: 'unreachable', hasContainers: false })));
    render(<DriftPanel stackName="web" />);
    const status = await screen.findByTestId('drift-status');
    expect(status).toHaveAttribute('data-status', 'unreachable');
    expect(screen.getByText(/Docker is unreachable/i)).toBeInTheDocument();
  });

  it('surfaces a compose parse error', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      status: 'drifted', hasComposeFile: false, parseError: 'Could not parse compose file: bad yaml',
    })));
    render(<DriftPanel stackName="web" />);
    await screen.findByTestId('drift-status');
    expect(screen.getByText(/Could not parse compose file/i)).toBeInTheDocument();
  });

  it('shows a retry state (not a status) when the load fails', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes({ error: 'down' }, false));
    render(<DriftPanel stackName="web" />);
    await screen.findByTestId('drift-retry-btn');
    expect(screen.queryByTestId('drift-status')).not.toBeInTheDocument();
    expect(toast.error).toHaveBeenCalled();
  });

  it('shows the retry state when the request throws', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('network'));
    render(<DriftPanel stackName="web" />);
    await screen.findByTestId('drift-retry-btn');
    expect(screen.queryByTestId('drift-status')).not.toBeInTheDocument();
    expect(toast.error).toHaveBeenCalled();
  });

  it('retry refetches and recovers to a status', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(jsonRes({ error: 'down' }, false))
      .mockResolvedValueOnce(jsonRes(report({ status: 'in-sync' })));
    render(<DriftPanel stackName="web" />);
    fireEvent.click(await screen.findByTestId('drift-retry-btn'));
    const status = await screen.findByTestId('drift-status');
    expect(status).toHaveAttribute('data-status', 'in-sync');
    expect(screen.queryByTestId('drift-retry-btn')).not.toBeInTheDocument();
  });

  it('re-checks on demand via the recheck endpoint (a POST), not the read GET', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({ status: 'in-sync' })));
    render(<DriftPanel stackName="web" />);
    await screen.findByTestId('drift-status');
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenLastCalledWith('/stacks/web/drift');
    fireEvent.click(screen.getByTestId('drift-recheck-btn'));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    expect(apiFetch).toHaveBeenLastCalledWith('/stacks/web/drift/recheck', { method: 'POST' });
  });

  it('shows "no deploy baseline" when the report has no temporal baseline', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      status: 'in-sync',
      temporal: { hasBaseline: false, sourceChanged: false, renderedChanged: false },
    })));
    render(<DriftPanel stackName="web" />);
    const temporal = await screen.findByTestId('drift-temporal');
    expect(temporal).toHaveAttribute('data-temporal', 'no-baseline');
  });

  it('flags a source change since the last deploy', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      status: 'in-sync',
      temporal: { hasBaseline: true, sourceChanged: true, renderedChanged: true },
    })));
    render(<DriftPanel stackName="web" />);
    const temporal = await screen.findByTestId('drift-temporal');
    expect(temporal).toHaveAttribute('data-temporal', 'source-changed');
    expect(screen.getByText(/changed since the last deploy/i)).toBeInTheDocument();
  });

  it('notes a formatting-only change when source changed but the model did not', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      status: 'in-sync',
      temporal: { hasBaseline: true, sourceChanged: true, renderedChanged: false },
    })));
    render(<DriftPanel stackName="web" />);
    const temporal = await screen.findByTestId('drift-temporal');
    expect(temporal).toHaveAttribute('data-temporal', 'source-changed');
    expect(screen.getByText(/formatting only/i)).toBeInTheDocument();
  });

  it('shows "matches last deploy" when the source is unchanged', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      status: 'in-sync',
      temporal: { hasBaseline: true, sourceChanged: false, renderedChanged: false },
    })));
    render(<DriftPanel stackName="web" />);
    const temporal = await screen.findByTestId('drift-temporal');
    expect(temporal).toHaveAttribute('data-temporal', 'matches');
  });

  it('renders the persisted drift history with open and resolved entries', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      status: 'drifted',
      findings: [{ kind: 'image-mismatch', service: 'web', detail: 'image differs' }],
      ledger: [
        { service: 'web', kind: 'image-mismatch', message: 'image differs', detectedAt: Date.now(), resolvedAt: null },
        { service: 'db', kind: 'service-missing', message: 'db not running', detectedAt: Date.now() - 1000, resolvedAt: Date.now() },
      ],
    })));
    render(<DriftPanel stackName="web" />);
    await screen.findByTestId('drift-status');
    expect(screen.getByText(/drift history/i)).toBeInTheDocument();
    expect(screen.getByText('open')).toBeInTheDocument();
    expect(screen.getByText('resolved')).toBeInTheDocument();
  });
});
