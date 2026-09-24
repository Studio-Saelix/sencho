import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { apiFetch } from '@/lib/api';
import { detailResponse } from '@/components/gitops/application/applicationFixtures';
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
});
