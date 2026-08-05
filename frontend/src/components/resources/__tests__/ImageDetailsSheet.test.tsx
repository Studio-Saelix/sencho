import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ImageDetailsSheet } from '../ImageDetailsSheet';

const apiFetch = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ isAdmin: true }) }));
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

  it('defaults the crumb to Resources › Images › name', async () => {
    render(<ImageDetailsSheet image={baseImage} onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByRole('navigation', { name: 'Sheet location' })).toHaveTextContent(
        'Resources›Images›postgres:16',
      );
    });
  });

  it('uses a custom crumb when provided', async () => {
    render(
      <ImageDetailsSheet
        image={baseImage}
        onClose={() => {}}
        crumb={['web', 'postgres:16']}
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole('navigation', { name: 'Sheet location' })).toHaveTextContent(
        'web›postgres:16',
      );
    });
  });

  it('omits size from meta when inspect fails and Size is unknown', async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 404 });
    const slimImage = {
      Id: 'sha256:abc123',
      RepoTags: ['nginx:latest'],
      usedByStacks: ['web'],
      nodeId: 1,
    };
    render(<ImageDetailsSheet image={slimImage} onClose={() => {}} crumb={['web', 'nginx:latest']} />);
    await waitFor(() => {
      expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    });
    expect(screen.queryByText(/0 Bytes/)).not.toBeInTheDocument();
  });

  it('renders Used by as a non-clickable badge when onOpenStack is omitted', async () => {
    render(
      <ImageDetailsSheet
        image={{ Id: 'sha256:abc', RepoTags: ['nginx:latest'], usedByStacks: ['web'], nodeId: 1 }}
        onClose={() => {}}
        crumb={['web', 'nginx:latest']}
      />,
    );
    const heading = await screen.findByRole('heading', { name: 'Used by' });
    const section = heading.closest('section');
    if (!section) throw new Error('expected Used by section');
    expect(within(section).getByText('web')).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: 'web' })).toBeNull();
  });
});
