import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
    expect(await screen.findByText('traefik.enable')).toBeInTheDocument();
    expect(screen.getByTestId('mismatch-only-container')).toBeInTheDocument();
    expect(screen.getByTestId('mismatch-both')).toBeInTheDocument();
  });
});
