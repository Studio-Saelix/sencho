/**
 * Covers what the Drift tab lets an operator do about a finding: the verb each
 * kind carries and who sees it, the redeploy confirm, dismissing and restoring,
 * and that a dismissal never changes what the status says.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn(), fetchForNode: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
const authBox: { canDeploy: boolean; canEdit: boolean } = { canDeploy: true, canEdit: true };
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    can: (action: string) => {
      if (action === 'stack:deploy') return authBox.canDeploy;
      if (action === 'stack:edit') return authBox.canEdit;
      return true;
    },
  }),
}));
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({ activeNode: { id: 1 }, nodes: [{ id: 1, name: 'local' }] }),
}));

import { apiFetch, fetchForNode } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import DriftPanel from './DriftPanel';

function jsonRes(body: unknown, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: async () => body, text: async () => '' } as unknown as Response;
}

interface FindingFixture {
  kind: string;
  service: string;
  detail: string;
  expected?: string;
  actual?: string;
  imageAge?: string;
  id?: string;
  fingerprint?: string;
  severity?: string;
  count?: number;
  dismissPolicy?: string;
}

function finding(kind: string, service: string, extra: Partial<FindingFixture> = {}): FindingFixture {
  return {
    kind, service, detail: `${service} ${kind} detail`,
    id: `drift:${kind}:${service}`, fingerprint: `fp-${kind}-${service}`, severity: 'warning', count: 1,
    dismissPolicy: kind === 'managed-path-conflict' ? 'none' : 'any',
    ...extra,
  };
}

function dismissal(f: FindingFixture, overrides: Record<string, unknown> = {}) {
  return {
    id: 7, nodeId: 1, surface: 'drift', findingKey: f.id, fingerprint: f.fingerprint, severity: 'warning', count: 1,
    mode: 'until_change', expiresAt: null, createdBy: 'alice', createdAt: Date.now() - 60_000, ...overrides,
  };
}

function report(findings: FindingFixture[], extra: Record<string, unknown> = {}) {
  return {
    stack: 'web', status: 'drifted', hasComposeFile: true, hasContainers: true,
    findings, dismissals: [], ...extra,
  };
}

/** Answer the drift read, the recheck, and (optionally) the dismissal routes. */
function mockReads(initial: unknown, after: unknown = initial) {
  vi.mocked(apiFetch).mockImplementation(async (path: string, options?: RequestInit) => {
    const url = String(path);
    if (url.startsWith('/gitops/applications')) return jsonRes({ application: null });
    if (url.endsWith('/drift/recheck')) return jsonRes(after);
    if (url.includes('/drift/dismissals')) return jsonRes({}, true, 204);
    if (options?.method === undefined) return jsonRes(initial);
    return jsonRes({});
  });
}

const onRedeploy = vi.fn();
const onEditCompose = vi.fn();
const onOpenGitSource = vi.fn();

function renderPanel() {
  return render(<DriftPanel stackName="web" onRedeploy={onRedeploy} onEditCompose={onEditCompose} onOpenGitSource={onOpenGitSource} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  authBox.canDeploy = true;
  authBox.canEdit = true;
});

describe('DriftPanel verbs', () => {
  it('states the fix and leads with the verb for each finding', async () => {
    mockReads(report([finding('ports-mismatch', 'web', { expected: '8080/tcp', actual: '9090/tcp' }), finding('service-undeclared', 'old')]));
    renderPanel();
    const rows = await screen.findAllByTestId('drift-finding');
    expect(within(rows[0]).getByTestId('drift-verb-redeploy')).toHaveTextContent('Redeploy to match compose');
    expect(within(rows[0]).getByTestId('drift-remediation')).toHaveTextContent(/publishes the ports compose declares/);
    expect(within(rows[1]).getByTestId('drift-verb-open-editor')).toBeInTheDocument();
  });

  it('asks before redeploying, then deploys through the editor handler and re-checks', async () => {
    mockReads(report([finding('ports-mismatch', 'web')]));
    renderPanel();
    fireEvent.click(await screen.findByTestId('drift-verb-redeploy'));
    expect(onRedeploy).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Redeploy' }));
    await waitFor(() => expect(onRedeploy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/stacks/web/drift/recheck', { method: 'POST' }));
  });

  it('does not deploy when the confirm is cancelled', async () => {
    mockReads(report([finding('ports-mismatch', 'web')]));
    renderPanel();
    fireEvent.click(await screen.findByTestId('drift-verb-redeploy'));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(onRedeploy).not.toHaveBeenCalled();
  });

  it('starts a missing service in one click on the active node, then re-checks', async () => {
    mockReads(report([finding('service-missing', 'db')]));
    vi.mocked(fetchForNode).mockResolvedValue(jsonRes({ success: true }));
    renderPanel();
    fireEvent.click(await screen.findByTestId('drift-verb-start-service'));
    await waitFor(() => expect(vi.mocked(fetchForNode)).toHaveBeenCalledWith('/stacks/web/services/db/start', 1, { method: 'POST' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Started db.'));
  });

  it('points at a redeploy when the service has no container to start', async () => {
    mockReads(report([finding('service-missing', 'db')]));
    vi.mocked(fetchForNode).mockResolvedValue(jsonRes({ error: "Service 'db' not found in stack 'web'." }, false, 404));
    renderPanel();
    fireEvent.click(await screen.findByTestId('drift-verb-start-service'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/Redeploy the stack to create it/)));
  });

  it('opens the editor and the Git source from their verbs', async () => {
    mockReads(report([finding('service-undeclared', 'old')], {
      ledger: [{ service: '', kind: 'managed-path-conflict', message: 'conflict', detectedAt: Date.now() - 1000, resolvedAt: null }],
    }));
    renderPanel();
    fireEvent.click(await screen.findByTestId('drift-verb-open-editor'));
    expect(onEditCompose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('drift-verb-open-git-source'));
    expect(onOpenGitSource).toHaveBeenCalledTimes(1);
  });

  it('shows an account without deploy rights the editor, never a verb that would 403, and no Dismiss', async () => {
    authBox.canDeploy = false;
    mockReads(report([finding('ports-mismatch', 'web'), finding('service-missing', 'db')]));
    renderPanel();
    await screen.findAllByTestId('drift-finding');
    expect(screen.queryByTestId('drift-verb-redeploy')).not.toBeInTheDocument();
    expect(screen.queryByTestId('drift-verb-start-service')).not.toBeInTheDocument();
    expect(screen.getByTestId('drift-verb-open-editor')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Dismiss/ })).not.toBeInTheDocument();
  });
});

describe('DriftPanel verbs without edit authority', () => {
  it('keeps the deploy verbs but never offers an editor that would do nothing', async () => {
    authBox.canEdit = false;
    mockReads(report([finding('ports-mismatch', 'web'), finding('service-undeclared', 'old')]));
    renderPanel();
    const rows = await screen.findAllByTestId('drift-finding');
    expect(within(rows[0]).getByTestId('drift-verb-redeploy')).toBeInTheDocument();
    expect(screen.queryByTestId('drift-verb-open-editor')).not.toBeInTheDocument();
    expect(within(rows[1]).queryByRole('button', { name: /Open stack editor/ })).not.toBeInTheDocument();
  });
});

describe('DriftPanel when a request fails or the scope changes', () => {
  it('reports a redeploy that throws, closes the confirm, and still re-checks', async () => {
    mockReads(report([finding('ports-mismatch', 'web')]));
    onRedeploy.mockRejectedValueOnce(new Error('boom'));
    renderPanel();
    fireEvent.click(await screen.findByTestId('drift-verb-redeploy'));
    fireEvent.click(await screen.findByRole('button', { name: 'Redeploy' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not redeploy the stack.'));
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/stacks/web/drift/recheck', { method: 'POST' }));
    expect(screen.queryByRole('button', { name: 'Redeploy' })).not.toBeInTheDocument();
  });

  it('reads the list again when the finding changed under a dismiss, and says so', async () => {
    const f = finding('ports-mismatch', 'web');
    mockReads(report([f]));
    const base = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (path: string, options?: RequestInit) =>
      String(path) === '/stacks/web/drift/dismissals' && options?.method === 'POST'
        ? jsonRes({ error: 'changed', code: 'FINDING_CHANGED' }, false, 409)
        : base(path, options));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /^Dismiss: web ports/ }));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('That finding just changed, so it was not dismissed.'));
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/stacks/web/drift/recheck', { method: 'POST' }));
  });

  it('shows the server message and leaves the list alone when Docker cannot be read', async () => {
    const f = finding('ports-mismatch', 'web');
    mockReads(report([f]));
    const base = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (path: string, options?: RequestInit) =>
      String(path) === '/stacks/web/drift/dismissals' && options?.method === 'POST'
        ? jsonRes({ error: 'Docker is unreachable.', code: 'EVIDENCE_UNAVAILABLE' }, false, 503)
        : base(path, options));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /^Dismiss: web ports/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Docker is unreachable.'));
    expect(screen.getByTestId('drift-finding')).toBeInTheDocument();
    const rechecks = vi.mocked(apiFetch).mock.calls.filter(([path]) => path === '/stacks/web/drift/recheck');
    expect(rechecks).toHaveLength(0);
  });

  it('re-reads instead of guessing when a restore finds nothing there', async () => {
    const f = finding('ports-mismatch', 'web');
    mockReads(report([f], { dismissals: [dismissal(f)] }), report([f]));
    const base = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (path: string, options?: RequestInit) =>
      String(path) === '/stacks/web/drift/dismissals/7' && options?.method === 'DELETE'
        ? jsonRes({ error: 'Stack not found' }, false, 404)
        : base(path, options));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /1 dismissed/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/stacks/web/drift/recheck', { method: 'POST' }));
    await waitFor(() => expect(screen.getByTestId('drift-finding')).toBeInTheDocument());
  });

  it('ignores a re-check that finishes after the operator moved to another stack', async () => {
    const web = finding('ports-mismatch', 'web');
    const api = finding('service-undeclared', 'api-extra');
    let finishRecheck: (res: Response) => void = () => undefined;
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      const url = String(path);
      if (url.startsWith('/gitops/applications')) return jsonRes({ application: null });
      if (url === '/stacks/web/drift/recheck') return new Promise<Response>(resolve => { finishRecheck = resolve; });
      if (url === '/stacks/web/drift') return jsonRes(report([web]));
      if (url === '/stacks/api/drift') return jsonRes({ ...report([api]), stack: 'api' });
      return jsonRes({});
    });
    const view = render(<DriftPanel stackName="web" onRedeploy={onRedeploy} onEditCompose={onEditCompose} onOpenGitSource={onOpenGitSource} />);
    await screen.findByTestId('drift-finding');
    fireEvent.click(screen.getByTestId('drift-recheck-btn'));
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/stacks/web/drift/recheck', { method: 'POST' }));

    view.rerender(<DriftPanel stackName="api" onRedeploy={onRedeploy} onEditCompose={onEditCompose} onOpenGitSource={onOpenGitSource} />);
    await waitFor(() => expect(screen.getByTestId('drift-finding')).toHaveAttribute('data-kind', 'service-undeclared'));
    finishRecheck(jsonRes(report([web])));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(screen.getByTestId('drift-finding')).toHaveAttribute('data-kind', 'service-undeclared');
  });

  it('closes an open redeploy confirm when the stack changes', async () => {
    mockReads(report([finding('ports-mismatch', 'web')]));
    const view = renderPanel();
    fireEvent.click(await screen.findByTestId('drift-verb-redeploy'));
    await screen.findByRole('button', { name: 'Redeploy' });
    view.rerender(<DriftPanel stackName="other" onRedeploy={onRedeploy} onEditCompose={onEditCompose} onOpenGitSource={onOpenGitSource} />);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Redeploy' })).not.toBeInTheDocument());
  });
});

describe('DriftPanel dismissals', () => {
  it('dismisses until it changes on one click, against the stack route on the active node', async () => {
    const f = finding('ports-mismatch', 'web');
    mockReads(report([f]));
    vi.mocked(apiFetch).mockImplementation(async (path: string, options?: RequestInit) => {
      const url = String(path);
      if (url.startsWith('/gitops/applications')) return jsonRes({ application: null });
      if (url === '/stacks/web/drift/dismissals' && options?.method === 'POST') return jsonRes({ dismissal: dismissal(f), kept: false }, true, 201);
      return jsonRes(report([f]));
    });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /^Dismiss: web ports/ }));
    await waitFor(() => expect(screen.queryByTestId('drift-finding')).not.toBeInTheDocument());
    const post = vi.mocked(apiFetch).mock.calls.find(([path]) => path === '/stacks/web/drift/dismissals');
    expect(post?.[1]).toMatchObject({ method: 'POST', localOnly: false });
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ findingId: f.id, fingerprint: f.fingerprint, count: 1, mode: 'until_change' });
    expect(screen.getByTestId('dismissed-section')).toHaveTextContent('1 dismissed');
  });

  it('keeps counting a dismissed finding and leaves the verdict alone', async () => {
    const f = finding('ports-mismatch', 'web');
    mockReads(report([f], { dismissals: [dismissal(f)] }));
    renderPanel();
    const status = await screen.findByTestId('drift-status');
    expect(status).toHaveAttribute('data-status', 'drifted');
    expect(status).toHaveTextContent('1 dismissed');
    expect(status).not.toHaveTextContent('1 finding');
    expect(screen.queryByTestId('drift-finding')).not.toBeInTheDocument();
  });

  it('shows a finding again once it changed after an until-change dismissal', async () => {
    const f = finding('ports-mismatch', 'web', { fingerprint: 'fp-new' });
    mockReads(report([f], { dismissals: [dismissal(f, { fingerprint: 'fp-old' })] }));
    renderPanel();
    expect(await screen.findByTestId('drift-finding')).toBeInTheDocument();
    expect(screen.queryByTestId('dismissed-section')).not.toBeInTheDocument();
  });

  it('restores a dismissed finding through the stack route by id', async () => {
    const f = finding('ports-mismatch', 'web');
    mockReads(report([f], { dismissals: [dismissal(f)] }));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /1 dismissed/ }));
    expect(screen.getByText(/dismissed by alice/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(screen.getByTestId('drift-finding')).toBeInTheDocument());
    expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/stacks/web/drift/dismissals/7', { method: 'DELETE', localOnly: false });
  });

  it('offers no Dismiss on a managed-path conflict', async () => {
    mockReads(report([finding('managed-path-conflict', '')]));
    renderPanel();
    await screen.findByTestId('drift-finding');
    expect(screen.queryByRole('button', { name: /^Dismiss/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('drift-verb-open-git-source')).toBeInTheDocument();
  });

  it('offers no Dismiss for a report from an older node that cannot record one', async () => {
    const f = finding('ports-mismatch', 'web');
    const { dismissals: _omitted, ...older } = report([f]);
    void _omitted;
    mockReads(older);
    renderPanel();
    await screen.findByTestId('drift-finding');
    expect(screen.queryByRole('button', { name: /^Dismiss/ })).not.toBeInTheDocument();
  });

  it('offers no Dismiss for a finding an older node published without its facts', async () => {
    mockReads(report([{ kind: 'ports-mismatch', service: 'web', detail: 'd' }]));
    renderPanel();
    await screen.findByTestId('drift-finding');
    expect(screen.queryByRole('button', { name: /^Dismiss/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('drift-verb-redeploy')).toBeInTheDocument();
  });
});
