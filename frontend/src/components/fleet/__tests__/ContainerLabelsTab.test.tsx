import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContainerLabelsTab } from '../ContainerLabelsTab';
import { LABEL_DISAMBIGUATION_COPY } from '@/lib/labelInventory';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ isAdmin: true }),
}));

import { apiFetch } from '@/lib/api';

const NODE_LOCAL = [{ id: 1, name: 'Local' }];

/** Answers `/fleet/container-labels?nodeId=N` from a per-node body, or a failed read for a node with none. */
function answerWith(pieces: Record<number, unknown>): void {
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    const nodeId = Number(/nodeId=(\d+)/.exec(String(path))?.[1]);
    const body = pieces[nodeId];
    if (body === undefined) {
      return { ok: false, status: 503, json: async () => ({ error: 'unreachable' }) } as Response;
    }
    return { ok: true, json: async () => body } as Response;
  });
}

const mockFleet = {
  nodes: [
    {
      nodeId: 1,
      nodeName: 'Local',
      status: 'ok' as const,
      error: null,
      inventory: {
        nodeId: 1,
        partial: false,
        generatedAt: Date.now(),
        containers: [
          {
            id: 'c1',
            name: 'web-1',
            stack: 'demo',
            service: 'web',
            state: 'running',
            labels: [{ key: 'traefik.enable', value: 'true', source: 'runtime' as const }],
          },
        ],
        byLabel: [],
      },
    },
  ],
  aggregatedByLabel: [
    {
      key: 'traefik.enable',
      value: 'true',
      source: 'runtime' as const,
      containers: [{ id: 'c1', name: 'web-1', stack: 'demo', service: 'web', nodeId: 1, nodeName: 'Local' }],
    },
  ],
  nodeErrors: {},
  generatedAt: Date.now(),
};

// Two rows sharing the same key=value but distinct sources (image vs runtime).
const dupMock = {
  nodes: [{ nodeId: 1, nodeName: 'Local', status: 'ok' as const, error: null, inventory: { nodeId: 1, partial: false, generatedAt: Date.now(), containers: [], byLabel: [] } }],
  aggregatedByLabel: [
    { key: 'dup.label', value: 'v', source: 'image' as const, containers: [{ id: 'c1', name: 'a-1', stack: 's', service: 'a', nodeId: 1, nodeName: 'Local' }] },
    { key: 'dup.label', value: 'v', source: 'runtime' as const, containers: [{ id: 'c2', name: 'b-1', stack: 's', service: 'b', nodeId: 1, nodeName: 'Local' }] },
  ],
  nodeErrors: {},
  generatedAt: Date.now(),
};

describe('ContainerLabelsTab', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    answerWith({ 1: mockFleet });
  });

  it('renders audit sections and toggles view mode', async () => {
    const user = userEvent.setup();
    render(<ContainerLabelsTab onNavigateToNode={vi.fn()} nodes={NODE_LOCAL} />);
    expect(await screen.findByText(LABEL_DISAMBIGUATION_COPY)).toBeInTheDocument();
    expect(screen.getByText('Docker label audit')).toBeInTheDocument();
    expect(await screen.findByText('web-1')).toBeInTheDocument();

    await user.click(screen.getByText('By label'));
    expect(await screen.findByText('traefik.enable')).toBeInTheDocument();
  });

  it('keeps the same key=value distinct per source with its own badge', async () => {
    const user = userEvent.setup();
    answerWith({ 1: dupMock });
    render(<ContainerLabelsTab onNavigateToNode={vi.fn()} nodes={NODE_LOCAL} />);
    await user.click(await screen.findByText('By label'));
    expect(screen.getAllByText('dup.label')).toHaveLength(2);
    // The misleading "External automation label" marker on non-Compose keys was removed.
    expect(screen.queryByText(/External automation label/)).toBeNull();
  });

  it('filters the by-label list by search text', async () => {
    const user = userEvent.setup();
    render(<ContainerLabelsTab onNavigateToNode={vi.fn()} nodes={NODE_LOCAL} />);
    await user.click(await screen.findByText('By label'));
    expect(screen.getByText('traefik.enable')).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText(/Filter labels/), 'nope');
    expect(screen.queryByText('traefik.enable')).toBeNull();
    expect(screen.getByText('No labels match this filter.')).toBeInTheDocument();
  });

  it('filters the by-container list by search text', async () => {
    const user = userEvent.setup();
    render(<ContainerLabelsTab onNavigateToNode={vi.fn()} nodes={NODE_LOCAL} />);
    expect(await screen.findByText('web-1')).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText(/Filter labels/), 'nope');
    expect(screen.queryByText('web-1')).toBeNull();
    expect(screen.getByText('No containers match this filter.')).toBeInTheDocument();
  });

  it('exposes a facet in the Filters popover only for sources present, with exact labels', async () => {
    const user = userEvent.setup();
    render(<ContainerLabelsTab onNavigateToNode={vi.fn()} nodes={NODE_LOCAL} />);
    await user.click(await screen.findByText('By label'));
    await user.click(screen.getByRole('button', { name: /Filters/ }));
    // mockFleet has only a runtime source.
    expect(screen.getByRole('button', { name: 'Runtime' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Image' })).toBeNull();
  });

  it('filters the by-label list by source facet, hiding an unpressed source', async () => {
    const user = userEvent.setup();
    answerWith({ 1: dupMock });
    render(<ContainerLabelsTab onNavigateToNode={vi.fn()} nodes={NODE_LOCAL} />);
    await user.click(await screen.findByText('By label'));
    expect(screen.getAllByText('dup.label')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: /Filters/ }));
    const imageBtn = screen.getByRole('button', { name: 'Image' });
    expect(imageBtn).toHaveAttribute('aria-pressed', 'true');

    await user.click(imageBtn);
    expect(screen.getAllByText('dup.label')).toHaveLength(1);
    // The facet stays present (just unpressed) because facets derive from unfiltered data.
    expect(screen.getByRole('button', { name: 'Image' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows the empty state when every source facet is turned off', async () => {
    const user = userEvent.setup();
    answerWith({ 1: dupMock });
    render(<ContainerLabelsTab onNavigateToNode={vi.fn()} nodes={NODE_LOCAL} />);
    await user.click(await screen.findByText('By label'));
    await user.click(screen.getByRole('button', { name: /Filters/ }));
    await user.click(screen.getByRole('button', { name: 'Image' }));
    await user.click(screen.getByRole('button', { name: 'Runtime' }));
    expect(screen.getByText('No labels match this filter.')).toBeInTheDocument();
  });

  it('names unreachable and partial nodes in the warning', async () => {
    answerWith({
      1: {
        nodes: [
          { nodeId: 1, nodeName: 'Local', status: 'ok' as const, error: null, inventory: { nodeId: 1, partial: true, generatedAt: Date.now(), containers: [], byLabel: [] } },
        ],
        aggregatedByLabel: [],
        nodeErrors: {},
        generatedAt: Date.now(),
      },
    });
    render(<ContainerLabelsTab onNavigateToNode={vi.fn()} nodes={[{ id: 1, name: 'Local' }, { id: 2, name: 'Edge' }]} />);
    expect(await screen.findByText(/Could not read Edge \(unreachable\)/)).toBeInTheDocument();
    expect(screen.getByText(/could not be inspected on Local/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('keeps a node\'s rows when the hub reports it unreachable after a good answer', async () => {
    const user = userEvent.setup();
    let edgeDown = false;
    const edgePiece = {
      nodes: [{
        nodeId: 2,
        nodeName: 'Edge',
        status: 'ok' as const,
        error: null,
        inventory: {
          nodeId: 2,
          partial: false,
          generatedAt: Date.now(),
          containers: [{
            id: 'e1',
            name: 'edge-web',
            stack: 'demo',
            service: 'web',
            state: 'running',
            labels: [{ key: 'traefik.enable', value: 'true', source: 'runtime' as const }],
          }],
          byLabel: [],
        },
      }],
      aggregatedByLabel: [],
      nodeErrors: {},
      generatedAt: Date.now(),
    };
    const edgeError = {
      nodes: [{ nodeId: 2, nodeName: 'Edge', status: 'error' as const, inventory: null, error: 'Timed out after 5s' }],
      aggregatedByLabel: [],
      nodeErrors: { 2: 'Timed out after 5s' },
      generatedAt: Date.now(),
    };
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (String(path).includes('nodeId=2')) {
        return { ok: true, json: async () => (edgeDown ? edgeError : edgePiece) } as Response;
      }
      return { ok: true, json: async () => mockFleet } as Response;
    });
    render(<ContainerLabelsTab onNavigateToNode={vi.fn()} nodes={[{ id: 1, name: 'Local' }, { id: 2, name: 'Edge' }]} />);
    expect(await screen.findByText('edge-web')).toBeInTheDocument();

    edgeDown = true;
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText(/Could not read Edge \(Timed out after 5s, showing its last result\)/)).toBeInTheDocument();
    expect(screen.getByText('edge-web')).toBeInTheDocument();
    expect(screen.getByText(/Showing partial fleet data\./)).toBeInTheDocument();

    edgeDown = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText(/Could not read Edge/)).toBeNull());
    expect(screen.getByText('edge-web')).toBeInTheDocument();
  });

  it('says no fleet data could be read when the hub reports every node unreachable', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      const nodeId = Number(/nodeId=(\d+)/.exec(String(path))?.[1]);
      return {
        ok: true,
        json: async () => ({
          nodes: [{ nodeId, nodeName: nodeId === 1 ? 'Local' : 'Edge', status: 'error', inventory: null, error: 'Timed out after 5s' }],
          aggregatedByLabel: [],
          nodeErrors: { [nodeId]: 'Timed out after 5s' },
          generatedAt: Date.now(),
        }),
      } as Response;
    });
    render(<ContainerLabelsTab onNavigateToNode={vi.fn()} nodes={[{ id: 1, name: 'Local' }, { id: 2, name: 'Edge' }]} />);
    expect(await screen.findByText(/Could not read Local \(Timed out after 5s\)/)).toBeInTheDocument();
    expect(screen.getByText(/No fleet data could be read\./, { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByText('No fleet data could be read.', { selector: 'td' })).toBeInTheDocument();
    expect(screen.queryByText('No containers match this filter.')).toBeNull();
  });

  it('shows a loading state, not an empty audit, before the node list arrives', async () => {
    render(<ContainerLabelsTab onNavigateToNode={vi.fn()} nodes={[]} nodesLoading />);
    expect(await screen.findByText('Loading Docker label audit...')).toBeInTheDocument();
    expect(screen.queryByText('No containers match this filter.')).toBeNull();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('says no nodes could be listed when the registry is empty and settled', async () => {
    render(<ContainerLabelsTab onNavigateToNode={vi.fn()} nodes={[]} />);
    expect(await screen.findByText('No nodes could be listed. Reload the page to try again.')).toBeInTheDocument();
    expect(screen.queryByText('No containers match this filter.')).toBeNull();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('shows progress while one node is still pending', async () => {
    let releaseEdge: (r: Response) => void = () => {};
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (String(path).includes('nodeId=2')) {
        return new Promise<Response>((resolve) => { releaseEdge = resolve; });
      }
      return { ok: true, json: async () => mockFleet } as Response;
    });
    render(<ContainerLabelsTab onNavigateToNode={vi.fn()} nodes={[{ id: 1, name: 'Local' }, { id: 2, name: 'Edge' }]} />);
    expect(await screen.findByText('Checking 1 of 2 nodes...')).toBeInTheDocument();
    releaseEdge({ ok: true, json: async () => ({ nodes: [{ nodeId: 2, nodeName: 'Edge', status: 'ok', error: null, inventory: { nodeId: 2, partial: false, generatedAt: Date.now(), containers: [], byLabel: [] } }], aggregatedByLabel: [], nodeErrors: {}, generatedAt: Date.now() }) } as Response);
    await screen.findByText('web-1');
  });

  it('says no fleet data could be read when every node failed', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: 'unreachable' }) } as Response);
    render(<ContainerLabelsTab onNavigateToNode={vi.fn()} nodes={[{ id: 1, name: 'Local' }]} />);
    expect(await screen.findByText(/Could not read Local \(unreachable\)/)).toBeInTheDocument();
    expect(screen.getByText(/No fleet data could be read\./, { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByText('No fleet data could be read.', { selector: 'td' })).toBeInTheDocument();
    expect(screen.queryByText('No containers match this filter.')).toBeNull();
  });
});
