import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RegistryTagsPanel } from '../RegistryTagsPanel';

const apiFetch = vi.fn();
const toastError = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: (...args: unknown[]) => toastError(...args), success: vi.fn() },
}));

describe('RegistryTagsPanel', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    toastError.mockReset();
  });

  const panelProps = {
    repoTags: ['ghcr.io/acme/app:latest'],
    repoDigests: [] as string[],
    nodeId: 1,
    isAdmin: true as const,
  };

  it('surfaces registry list failures instead of a no-match message', async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'boom' }) });

    render(<RegistryTagsPanel {...panelProps} />);

    expect(await screen.findByText('Failed to load registries')).toBeInTheDocument();
    expect(screen.queryByText(/No configured registry matches/i)).toBeNull();
    expect(toastError).toHaveBeenCalled();
  });

  it('shows no-match copy when registries load but none match the host', async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ([{ id: 1, name: 'Hub', url: 'https://index.docker.io/v1/', type: 'dockerhub', has_secret: true }]),
    });

    render(<RegistryTagsPanel {...panelProps} />);

    expect(await screen.findByText(/No configured registry matches ghcr.io/i)).toBeInTheDocument();
  });
});