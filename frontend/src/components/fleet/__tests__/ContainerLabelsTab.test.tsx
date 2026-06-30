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
});
