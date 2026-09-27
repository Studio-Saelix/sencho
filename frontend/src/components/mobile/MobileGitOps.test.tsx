import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { apiFetch } from '@/lib/api';
import { detailResponse, portfolioRow } from '@/components/gitops/application/applicationFixtures';
import { MobileGitOps } from './MobileGitOps';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

// The application view reads the session's permissions for its authority
// actions; this suite drives the phone shell, not authorization.
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ can: () => false }),
}));

vi.mock('../gitops/portfolio/useWorkplaceCapabilities', () => ({
  useWorkplaceCapabilities: () => ({ canConnectStack: false, canCreateBlueprint: false, canOpenFleet: false }),
}));

const mockFetch = vi.mocked(apiFetch);

const emptyList = {
  schemaVersion: 1,
  generatedAt: 0,
  summary: {
    applications: 0, attentionRequired: 0, failed: 0, inProgress: 0, converged: 0,
    convergedQualified: 0, unknown: 0, drifted: 0, byReason: {},
  },
  coverage: [],
  attentionQueue: [],
  attentionQueueTruncated: false,
  applications: [],
  nextCursor: null,
  truncated: false,
};

afterEach(() => {
  mockFetch.mockReset();
  window.history.replaceState({}, '', '/');
});

describe('MobileGitOps', () => {
  it('shows the application view for a linked application, keeping the shell actions reachable', async () => {
    window.history.replaceState({}, '', '/nodes/local/gitops?application=1%3Aapp-1');
    mockFetch.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (url.startsWith('/gitops/applications/') ? detailResponse() : emptyList),
    }) as unknown as Response);

    render(<MobileGitOps headerActions={<button type="button">More</button>} />);

    expect(await screen.findByRole('heading', { name: 'bookstack' })).toBeInTheDocument();
    expect(screen.getByTestId('gitops-application-view')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More' })).toBeInTheDocument();
  });

  it('marks a truncated portfolio partial even when every node answered', async () => {
    mockFetch.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ...emptyList,
        summary: { ...emptyList.summary, applications: 1, unknown: 1 },
        coverage: [{ nodeId: 1, nodeName: 'local', state: 'ok' as const }],
        applications: [portfolioRow({
          id: '1:app-1',
          name: 'bookstack',
          posture: 'unknown',
          evidence: { partial: true, unreachableNodes: [], unknown: true },
        })],
        truncated: true,
      }),
    }) as unknown as Response);

    render(<MobileGitOps headerActions={null} />);

    // The count alone would read as a complete answer, so the omission has to
    // say itself wherever the other partial signals would have said it.
    expect(await screen.findByText(/partial/)).toBeInTheDocument();
  });
});
