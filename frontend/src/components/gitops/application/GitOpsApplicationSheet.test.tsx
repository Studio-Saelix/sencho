/**
 * The Blueprint application sheet: it shows the application over the list, a
 * Direct application's link hands off to its Git source instead of rendering a
 * read-only copy, and a failed read says so.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/api';
import { GITOPS_BLUEPRINT_EVENT, GITOPS_GIT_SOURCE_EVENT, type GitOpsBlueprintRequest, type GitOpsGitSourceTarget } from '../portfolio/portfolioNavigation';
import { blueprintDetailResponse, detailResponse } from './applicationFixtures';
import { GitOpsApplicationSheet } from './GitOpsApplicationSheet';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
const grants = { fleet: false };

vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ can: (action: string) => grants.fleet && action === 'node:read' }) }));
vi.mock('@/context/NodeContext', () => ({ useNodes: () => ({ hasCapability: () => grants.fleet, nodeMeta: new Map() }) }));

const mockFetch = vi.mocked(apiFetch);

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

afterEach(() => {
  grants.fleet = false;
  mockFetch.mockReset();
  window.history.replaceState({}, '', '/');
});

describe('GitOpsApplicationSheet', () => {
  it('shows a Blueprint application in a sheet', async () => {
    mockFetch.mockResolvedValue(ok(blueprintDetailResponse()));
    render(<GitOpsApplicationSheet id="bp:3" />);

    expect(await screen.findByTestId('gitops-application-detail')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('shop')).toBeInTheDocument();
  });

  it('hands a Direct application to its Git source instead of showing a second copy', async () => {
    const seen: GitOpsGitSourceTarget[] = [];
    const onEvent = (e: Event) => seen.push((e as CustomEvent<GitOpsGitSourceTarget>).detail);
    window.addEventListener(GITOPS_GIT_SOURCE_EVENT, onEvent);
    window.history.replaceState({}, '', '/nodes/local/gitops?application=1%3Aapp-1');
    mockFetch.mockResolvedValue(ok(detailResponse()));

    render(<GitOpsApplicationSheet id="1:app-1" />);

    await waitFor(() => expect(seen).toEqual([{ nodeId: 1, stackName: 'bookstack', applicationName: 'bookstack' }]));
    expect(screen.queryByTestId('gitops-application-detail')).toBeNull();
    expect(window.location.search).toBe('');
    window.removeEventListener(GITOPS_GIT_SOURCE_EVENT, onEvent);
  });

  it('says so when the application cannot be read', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'boom' }) } as unknown as Response);
    render(<GitOpsApplicationSheet id="bp:3" />);

    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByTestId('gitops-application-detail')).toBeNull();
  });

  it('opens a Blueprint application\'s Blueprint in place and hands the sheet over to it', async () => {
    grants.fleet = true;
    const seen: GitOpsBlueprintRequest[] = [];
    const onRequest = (e: Event) => {
      const request = (e as CustomEvent<GitOpsBlueprintRequest>).detail;
      request.handled = true;
      seen.push(request);
    };
    window.addEventListener(GITOPS_BLUEPRINT_EVENT, onRequest);
    window.history.replaceState({}, '', '/nodes/local/gitops?application=bp%3A3');
    mockFetch.mockResolvedValue(ok(blueprintDetailResponse()));

    render(<GitOpsApplicationSheet id="bp:3" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Blueprint' }));

    expect(seen.map(r => r.intent)).toEqual([{ kind: 'open', blueprintId: 3 }]);
    // The Blueprint's own sheet replaces this one, as a Direct application's Git source does.
    await waitFor(() => expect(window.location.search).toBe(''));
    window.removeEventListener(GITOPS_BLUEPRINT_EVENT, onRequest);
  });
});
