/**
 * Rendering tests for the portfolio attention queue.
 *
 * What matters: one entry per application, failures sort ahead of pending
 * decisions, the *reason* words are inline (never tooltip-only), each entry
 * carries the verb that resolves it (run in place when the server offers it),
 * and an entry opens that application's own surface.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { GITOPS_SOURCE_CONTROLLER_CAPABILITY } from '@/lib/capabilities';
import { GITOPS_GIT_SOURCE_EVENT, applicationIdFromSearch } from './portfolioNavigation';
import { AttentionQueue } from './AttentionQueue';
import type { GitOpsPortfolioRow } from '@/types/gitopsPortfolio';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const session = vi.hoisted(() => ({
  can: vi.fn<(action: string, type?: string, id?: string, nodeId?: number | null) => boolean>(() => true),
  nodeMeta: new Map<number, { capabilities: string[] }>(),
}));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ can: session.can }) }));
vi.mock('@/context/NodeContext', () => ({ useNodes: () => ({ nodeMeta: session.nodeMeta }) }));

const mockFetch = vi.mocked(apiFetch);

afterEach(() => {
  session.can.mockImplementation(() => true);
  session.nodeMeta.clear();
  mockFetch.mockReset();
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
});

function row(overrides: Partial<GitOpsPortfolioRow>): GitOpsPortfolioRow {
  return {
    id: '1:app-x',
    targetMode: 'direct',
    name: 'web',
    stackName: 'web',
    blueprintId: null,
    nodeId: 1,
    nodeName: 'local',
    repository: {
      configuredRepoUrl: 'https://github.com/example/repo.git',
      host: 'github.com',
      pathname: '/example/repo.git',
      configuredRef: 'main',
    },
    desiredCommitSha: null,
    fetchedCommitSha: null,
    candidateGenerationId: null,
    acceptedGenerationId: null,
    sourceStatus: 'application_generation_accepted',
    artifactStatus: 'artifact_exact',
    artifactQualification: 'exact',
    placementStatus: 'unbound_direct',
    rolloutStatus: 'not_applicable',
    runtimeStatus: 'synced_and_healthy',
    healthStatus: 'passed',
    targets: [],
    drift: { count: 0, classes: [] },
    attention: [],
    posture: 'converged',
    availableActions: [],
    limitations: [],
    lastActivityAt: 1700000000000,
    evidence: { partial: false, unreachableNodes: [], unknown: false },
    ...overrides,
  };
}

describe('AttentionQueue', () => {
  it('renders nothing when no row carries an attention reason', () => {
    const { container } = render(<AttentionQueue rows={[row({})]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders one entry per application with its top reason inline and the rest counted', () => {
    render(<AttentionQueue rows={[row({
      attention: ['source_review_pending', 'target_unreachable'],
      name: 'review-web',
    })]} />);
    expect(screen.getAllByText('review-web')).toHaveLength(1);
    expect(screen.getByText(/required target could not be reached/)).toBeTruthy();
    expect(screen.getByText(/\+1 more/)).toBeTruthy();
  });

  it('orders failure-toned reasons before pending decisions', () => {
    render(<AttentionQueue rows={[
      row({ attention: ['source_review_pending'], name: 'pending-app', id: '1:a' }),
      row({ attention: ['source_failed'], name: 'failed-app', id: '1:b' }),
    ]} />);
    const items = screen.getAllByRole('listitem');
    expect(items[0]!.textContent).toContain('failed-app');
    expect(items[1]!.textContent).toContain('pending-app');
  });

  it('opens the application surface even for a row with no owning surface identity', () => {
    window.history.replaceState({}, '', '/nodes/local/gitops');
    render(<AttentionQueue rows={[row({ attention: ['source_failed'], nodeId: null, stackName: null })]} />);
    const open = screen.getByRole('button', { name: /web/ });
    expect(open).toBeEnabled();
    fireEvent.click(open);
    expect(applicationIdFromSearch(window.location.search)).toBe('1:app-x');
  });

  it('routes a drill-down to the override when one is given, leaving the URL alone', () => {
    window.history.replaceState({}, '', '/nodes/local/gitops');
    const onDrillDown = vi.fn();
    render(<AttentionQueue rows={[row({ attention: ['source_failed'] })]} onDrillDown={onDrillDown} />);
    fireEvent.click(screen.getByRole('button', { name: /web/ }));
    expect(onDrillDown).toHaveBeenCalledWith(expect.objectContaining({ id: '1:app-x' }));
    expect(window.location.search).toBe('');
  });

  it('retries a failed Direct source in place on the row\'s own node', async () => {
    const refreshed = vi.fn();
    window.addEventListener('sencho:state-invalidate', refreshed);
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as unknown as Response);
    render(<AttentionQueue rows={[row({ attention: ['source_failed'], availableActions: ['retry'], nodeId: 2 })]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(refreshed).toHaveBeenCalledTimes(1));
    expect(mockFetch).toHaveBeenCalledWith('/stacks/web/git-source/retry', expect.objectContaining({ method: 'POST', nodeId: 2 }));
    expect(window.location.search).toBe('');
    window.removeEventListener('sencho:state-invalidate', refreshed);
  });

  it('surfaces a refused Retry instead of looking done', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: 'Nothing to retry' }) } as unknown as Response);
    render(<AttentionQueue rows={[row({ attention: ['source_failed'], availableActions: ['retry'] })]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('web: Nothing to retry'));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('falls back to opening the Git source when the server does not offer the verb', () => {
    const seen: unknown[] = [];
    const onEvent = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener(GITOPS_GIT_SOURCE_EVENT, onEvent);
    render(<AttentionQueue rows={[row({ attention: ['source_failed'], availableActions: [] })]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open Git source' }));

    expect(mockFetch).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    window.removeEventListener(GITOPS_GIT_SOURCE_EVENT, onEvent);
  });

  it('checks the stack-edit permission on that stack and node, and falls back without it', () => {
    session.can.mockImplementation(() => false);
    render(<AttentionQueue rows={[row({ attention: ['source_failed'], availableActions: ['retry'], nodeId: 2, stackName: 'web' })]} />);

    expect(session.can).toHaveBeenCalledWith('stack:edit', 'stack', 'web', 2);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open Git source' })).toBeInTheDocument();
  });

  it('falls back when the owning node does not run the source controller', () => {
    session.nodeMeta.set(1, { capabilities: [] });
    render(<AttentionQueue rows={[row({ attention: ['source_failed'], availableActions: ['retry'] })]} />);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open Git source' })).toBeInTheDocument();
  });

  it('offers Retry when the node reports the source controller', () => {
    session.nodeMeta.set(1, { capabilities: [GITOPS_SOURCE_CONTROLLER_CAPABILITY] });
    render(<AttentionQueue rows={[row({ attention: ['source_failed'], availableActions: ['retry'] })]} />);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('resumes a suspended source in place', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as unknown as Response);
    render(<AttentionQueue rows={[row({ attention: ['source_suspended'], availableActions: ['resume'] })]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith('/stacks/web/git-source/resume', expect.objectContaining({ method: 'POST' })));
  });

  it('keeps each row busy on its own while its request is in flight', async () => {
    let finishFirst: (res: Response) => void = () => {};
    mockFetch
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finishFirst = resolve; }))
      .mockImplementationOnce(() => new Promise<Response>(() => {}));
    render(<AttentionQueue rows={[
      row({ id: '1:a', name: 'alpha', stackName: 'alpha', attention: ['source_failed'], availableActions: ['retry'] }),
      row({ id: '1:b', name: 'beta', stackName: 'beta', attention: ['source_failed'], availableActions: ['retry'] }),
    ]} />);
    const [first, second] = screen.getAllByRole('button', { name: 'Retry' });

    fireEvent.click(first!);
    fireEvent.click(second!);
    expect(first).toBeDisabled();
    expect(second).toBeDisabled();

    finishFirst({ ok: true, status: 200, json: async () => ({}) } as unknown as Response);
    await waitFor(() => expect(first).toBeEnabled());
    expect(second).toBeDisabled();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
