import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

describe('ContainerLabelsTab', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => mockFleet,
    } as Response);
  });

  it('renders audit sections and toggles view mode', async () => {
    const onNavigate = vi.fn();
    render(<ContainerLabelsTab onNavigateToNode={onNavigate} />);
    expect(await screen.findByText(LABEL_DISAMBIGUATION_COPY)).toBeInTheDocument();
    expect(screen.getByText('Docker label audit')).toBeInTheDocument();
    expect(await screen.findByText('web-1')).toBeInTheDocument();

    fireEvent.click(screen.getByText('By label'));
    expect(await screen.findByText('traefik.enable')).toBeInTheDocument();
  });

  it('keeps the same key=value distinct per source with its own badge', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        nodes: [{ nodeId: 1, nodeName: 'Local', status: 'ok' as const, error: null, inventory: { nodeId: 1, partial: false, generatedAt: Date.now(), containers: [], byLabel: [] } }],
        aggregatedByLabel: [
          { key: 'dup.label', value: 'v', source: 'image' as const, containers: [{ id: 'c1', name: 'a-1', stack: 's', service: 'a', nodeId: 1, nodeName: 'Local' }] },
          { key: 'dup.label', value: 'v', source: 'runtime' as const, containers: [{ id: 'c2', name: 'b-1', stack: 's', service: 'b', nodeId: 1, nodeName: 'Local' }] },
        ],
        nodeErrors: {},
        generatedAt: Date.now(),
      }),
    } as Response);
    render(<ContainerLabelsTab onNavigateToNode={vi.fn()} />);
    fireEvent.click(await screen.findByText('By label'));
    expect(await screen.findByText('Image')).toBeInTheDocument();
    expect(screen.getByText('Present at runtime')).toBeInTheDocument();
    expect(screen.getAllByText('dup.label')).toHaveLength(2);
    // The misleading "External automation label" marker on non-Compose keys was removed.
    expect(screen.queryByText(/External automation label/)).toBeNull();
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
