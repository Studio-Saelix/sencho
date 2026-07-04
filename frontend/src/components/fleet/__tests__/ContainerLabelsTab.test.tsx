import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => mockFleet,
    } as Response);
  });

  it('renders audit sections and toggles view mode', async () => {
    const user = userEvent.setup();
    render(<ContainerLabelsTab onNavigateToNode={vi.fn()} />);
    expect(await screen.findByText(LABEL_DISAMBIGUATION_COPY)).toBeInTheDocument();
    expect(screen.getByText('Docker label audit')).toBeInTheDocument();
    expect(await screen.findByText('web-1')).toBeInTheDocument();

    await user.click(screen.getByText('By label'));
    expect(await screen.findByText('traefik.enable')).toBeInTheDocument();
  });

  it('keeps the same key=value distinct per source with its own badge', async () => {
    const user = userEvent.setup();
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => dupMock } as Response);
    render(<ContainerLabelsTab onNavigateToNode={vi.fn()} />);
    await user.click(await screen.findByText('By label'));
    expect(screen.getAllByText('dup.label')).toHaveLength(2);
    // The misleading "External automation label" marker on non-Compose keys was removed.
    expect(screen.queryByText(/External automation label/)).toBeNull();
  });

  it('filters the by-label list by search text', async () => {
    const user = userEvent.setup();
    render(<ContainerLabelsTab onNavigateToNode={vi.fn()} />);
    await user.click(await screen.findByText('By label'));
    expect(screen.getByText('traefik.enable')).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText(/Filter labels/), 'nope');
    expect(screen.queryByText('traefik.enable')).toBeNull();
    expect(screen.getByText('No labels match this filter.')).toBeInTheDocument();
  });

  it('filters the by-container list by search text', async () => {
    const user = userEvent.setup();
    render(<ContainerLabelsTab onNavigateToNode={vi.fn()} />);
    expect(await screen.findByText('web-1')).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText(/Filter labels/), 'nope');
    expect(screen.queryByText('web-1')).toBeNull();
    expect(screen.getByText('No containers match this filter.')).toBeInTheDocument();
  });

  it('exposes a facet in the Filters popover only for sources present, with exact labels', async () => {
    const user = userEvent.setup();
    render(<ContainerLabelsTab onNavigateToNode={vi.fn()} />);
    await user.click(await screen.findByText('By label'));
    await user.click(screen.getByRole('button', { name: /Filters/ }));
    // mockFleet has only a runtime source.
    expect(screen.getByRole('button', { name: 'Runtime' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Image' })).toBeNull();
  });

  it('filters the by-label list by source facet, hiding an unpressed source', async () => {
    const user = userEvent.setup();
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => dupMock } as Response);
    render(<ContainerLabelsTab onNavigateToNode={vi.fn()} />);
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
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => dupMock } as Response);
    render(<ContainerLabelsTab onNavigateToNode={vi.fn()} />);
    await user.click(await screen.findByText('By label'));
    await user.click(screen.getByRole('button', { name: /Filters/ }));
    await user.click(screen.getByRole('button', { name: 'Image' }));
    await user.click(screen.getByRole('button', { name: 'Runtime' }));
    expect(screen.getByText('No labels match this filter.')).toBeInTheDocument();
  });

  it('names unreachable and partial nodes in the warning', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        nodes: [
          { nodeId: 1, nodeName: 'Local', status: 'ok' as const, error: null, inventory: { nodeId: 1, partial: true, generatedAt: Date.now(), containers: [], byLabel: [] } },
          { nodeId: 2, nodeName: 'Edge', status: 'error' as const, error: 'boom', inventory: null },
        ],
        aggregatedByLabel: [],
        nodeErrors: { 2: 'boom' },
        generatedAt: Date.now(),
      }),
    } as Response);
    render(<ContainerLabelsTab onNavigateToNode={vi.fn()} />);
    expect(await screen.findByText(/Could not reach Edge/)).toBeInTheDocument();
    expect(screen.getByText(/could not be inspected on Local/)).toBeInTheDocument();
  });
});
