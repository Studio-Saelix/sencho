import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ImageDetailsSheet } from '../ImageDetailsSheet';

const apiFetch = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const baseImage = {
  Id: 'sha256:abc123',
  RepoTags: ['postgres:16'],
  Size: 1000,
  Containers: 2,
  usedByStacks: ['alpha', 'zeta'],
  managedBy: 'alpha',
  managedStatus: 'managed' as const,
  isSencho: false,
  nodeId: 1,
};

describe('ImageDetailsSheet', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        inspect: {
          Id: 'sha256:abc123',
          RepoTags: ['postgres:16'],
          Created: '2026-01-01T00:00:00Z',
          Size: 1000,
          Architecture: 'amd64',
          Os: 'linux',
          Config: {},
        },
        history: [],
      }),
    });
  });

  it('renders Used by chips from the classified image prop', async () => {
    const onOpenStack = vi.fn();
    render(
      <ImageDetailsSheet image={baseImage} onClose={() => {}} onOpenStack={onOpenStack} />,
    );

    await waitFor(() => expect(screen.getByText('alpha')).toBeInTheDocument());
    expect(screen.getByText('zeta')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'alpha' }));
    expect(onOpenStack).toHaveBeenCalledWith('alpha');
  });

  it('stays closed when image is null', () => {
    const { container } = render(<ImageDetailsSheet image={null} onClose={() => {}} />);
    expect(container.querySelector('[data-state="open"]')).toBeNull();
  });
});
