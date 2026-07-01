import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import ComposeLabelsPanel from '../ComposeLabelsPanel';
import { LABEL_DISAMBIGUATION_COPY } from '@/lib/labelInventory';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ isAdmin: true }),
}));

import { apiFetch } from '@/lib/api';

const mockInventory = {
  stackName: 'demo',
  renderable: true,
  generatedAt: Date.now(),
  services: [
    {
      service: 'web',
      declaredLabels: [{ key: 'traefik.enable', value: 'true', source: 'compose' as const }],
      replicas: [
        {
          id: 'c1',
          name: 'demo-web-1',
          state: 'running',
          runtimeLabels: [
            { key: 'traefik.enable', value: 'true', source: 'runtime' as const },
            { key: 'runtime.only', value: '1', source: 'runtime' as const },
          ],
          onlyInCompose: [],
          onlyOnContainer: ['runtime.only'],
          inBoth: ['traefik.enable'],
        },
      ],
    },
  ],
};

describe('ComposeLabelsPanel', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => mockInventory,
    } as Response);
  });

  it('shows disambiguation copy and service labels', async () => {
    render(<ComposeLabelsPanel stackName="demo" />);
    expect(await screen.findByText(LABEL_DISAMBIGUATION_COPY)).toBeInTheDocument();
    expect(await screen.findByText('web')).toBeInTheDocument();
    expect(screen.getAllByText('traefik.enable')).toHaveLength(2);
    expect(screen.getByTestId('mismatch-only-container')).toBeInTheDocument();
    expect(screen.getByTestId('mismatch-both')).toBeInTheDocument();
  });

  it('renders a value-changed badge when a label value drifted', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        stackName: 'demo', renderable: true, partial: false, generatedAt: Date.now(),
        services: [{
          service: 'web',
          declaredLabels: [{ key: 'watchtower.enable', value: 'true', source: 'compose' as const }],
          replicas: [{
            id: 'c1', name: 'demo-web-1', state: 'running',
            runtimeLabels: [{ key: 'watchtower.enable', value: 'false', source: 'runtime' as const }],
            onlyInCompose: [], onlyOnContainer: [], inBoth: [], changed: ['watchtower.enable'],
          }],
        }],
      }),
    } as Response);
    render(<ComposeLabelsPanel stackName="demo" />);
    expect(await screen.findByTestId('mismatch-changed')).toBeInTheDocument();
  });

  it('shows "Runtime labels unavailable" for a replica whose inspect failed', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        stackName: 'demo', renderable: true, partial: true, generatedAt: Date.now(),
        services: [{
          service: 'web',
          declaredLabels: [{ key: 'traefik.enable', value: 'true', source: 'compose' as const }],
          replicas: [{
            id: 'c1', name: 'demo-web-1', state: 'running',
            runtimeLabels: [], onlyInCompose: [], onlyOnContainer: [], inBoth: [], changed: [],
            inspectFailed: true,
          }],
        }],
      }),
    } as Response);
    render(<ComposeLabelsPanel stackName="demo" />);
    expect(await screen.findByText('Runtime labels unavailable for this container.')).toBeInTheDocument();
    expect(screen.getByText(/could not be inspected/i)).toBeInTheDocument();
  });
});
