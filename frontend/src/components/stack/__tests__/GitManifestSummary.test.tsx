import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { GitManifestSummary, type ManifestSummary } from '../GitManifestSummary';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/api';

const summary: ManifestSummary = {
  state: 'active',
  manifestVersion: 1,
  resolvedCommitSha: 'abc1234',
  managedCount: 2,
  unmanagedCount: 0,
  refusedCount: 0,
  refused: [],
  hasBuildContexts: false,
  generatedAt: Date.now(),
};

describe('GitManifestSummary', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('renders nothing without a summary', () => {
    const { container } = render(<GitManifestSummary stackName="web" summary={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('fetches the manifest once per expansion and renders the inventory', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          manifest: {
            manifestVersion: 1,
            state: 'active',
            inputs: [
              { path: 'compose.yaml', dependencyKind: 'explicit', ownership: 'managed', sensitivity: 'medium', state: 'present', note: null },
              { path: null, dependencyKind: 'secret', ownership: 'managed', sensitivity: 'high', state: 'present', note: null },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    render(<GitManifestSummary stackName="web" summary={summary} />);
    fireEvent.click(screen.getByRole('button', { name: /Managed project/ }));
    await waitFor(() => expect(screen.getByText('compose.yaml')).toBeInTheDocument());
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('does not refetch after a failed request (no retry loop)', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('down'));
    render(<GitManifestSummary stackName="web" summary={summary} />);
    fireEvent.click(screen.getByRole('button', { name: /Managed project/ }));
    await waitFor(() => expect(screen.getByText('Could not load the managed-project manifest.')).toBeInTheDocument());
    expect(apiFetch).toHaveBeenCalledTimes(1);
    // The pre-fix effect re-fired on the loading flip; give it a beat to prove
    // the failure does not restart the request.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('retries only through the explicit retry action', async () => {
    vi.mocked(apiFetch)
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ manifest: { manifestVersion: 1, state: 'active', inputs: [] } }),
          { status: 200 },
        ),
      );
    render(<GitManifestSummary stackName="web" summary={summary} />);
    fireEvent.click(screen.getByRole('button', { name: /Managed project/ }));
    await waitFor(() => expect(screen.getByText('Could not load the managed-project manifest.')).toBeInTheDocument());
    expect(apiFetch).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('Could not load the managed-project manifest.')).not.toBeInTheDocument());
  });
});
