/**
 * Covers the interactive surface of the image-source menu: the deterministic
 * registry link, the lazy (and non-repeating) OCI label fetch, safe degradation
 * when the inspect fails, copy behavior, external-link safety attributes, and the
 * private-registry / absent-ref fallbacks.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/clipboard', () => ({ copyToClipboard: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/components/ui/toast-store', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { apiFetch } from '@/lib/api';
import { copyToClipboard } from '@/lib/clipboard';
import { toast } from '@/components/ui/toast-store';
import { ImageSourceMenu } from './ImageSourceMenu';

function inspectRes(labels: Record<string, string> | null, ok = true) {
  return {
    ok,
    status: ok ? 200 : 404,
    json: async () => ({ inspect: { Config: { Labels: labels } } }),
  } as unknown as Response;
}

const trigger = () => screen.getByRole('button', { name: 'Image source links' });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiFetch).mockResolvedValue(inspectRes({
    'org.opencontainers.image.source': 'https://github.com/owner/repo',
  }));
});

describe('ImageSourceMenu', () => {
  it('renders nothing when the image ref is absent', () => {
    const { container } = render(<ImageSourceMenu imageRef={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the deterministic registry link with safe external-link attributes', async () => {
    render(<ImageSourceMenu imageRef="ghcr.io/owner/app:1.2" />);
    await userEvent.click(trigger());
    const link = await screen.findByRole('menuitem', { name: /Open on GitHub Container Registry/ });
    expect(link).toHaveAttribute('href', 'https://github.com/owner');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('does not fetch labels when no imageId is provided', async () => {
    render(<ImageSourceMenu imageRef="ghcr.io/owner/app:1.2" />);
    await userEvent.click(trigger());
    await screen.findByRole('menuitem', { name: /Open on/ });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('fetches OCI labels once on first open and not again on reopen', async () => {
    render(<ImageSourceMenu imageRef="ghcr.io/owner/app:1.2" imageId="sha256:abc" />);
    await userEvent.click(trigger());
    expect(await screen.findByRole('menuitem', { name: 'Source repository' })).toHaveAttribute(
      'href', 'https://github.com/owner/repo',
    );
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(apiFetch).mock.calls[0][0]).toContain('/system/images/');

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: 'Source repository' })).toBeNull());
    await userEvent.click(trigger());
    await screen.findByRole('menuitem', { name: 'Source repository' });
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('re-fetches and clears stale labels when the image id changes', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(inspectRes({
      'org.opencontainers.image.source': 'https://github.com/owner/old',
    }));
    const { rerender } = render(<ImageSourceMenu imageRef="ghcr.io/owner/app:1" imageId="sha256:aaa" />);
    await userEvent.click(trigger());
    expect(await screen.findByRole('menuitem', { name: 'Source repository' })).toHaveAttribute(
      'href', 'https://github.com/owner/old',
    );
    await userEvent.keyboard('{Escape}');

    vi.mocked(apiFetch).mockResolvedValueOnce(inspectRes({
      'org.opencontainers.image.source': 'https://github.com/owner/new',
    }));
    rerender(<ImageSourceMenu imageRef="ghcr.io/owner/app:2" imageId="sha256:bbb" />);
    await userEvent.click(trigger());
    expect(await screen.findByRole('menuitem', { name: 'Source repository' })).toHaveAttribute(
      'href', 'https://github.com/owner/new',
    );
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('drops a late inspect response from a superseded image after the id changes', async () => {
    // First open: an inspect that stays in flight until we resolve it by hand.
    let resolveOld!: (v: Response) => void;
    vi.mocked(apiFetch).mockReturnValueOnce(new Promise<Response>((res) => { resolveOld = res; }));

    const { rerender } = render(<ImageSourceMenu imageRef="ghcr.io/owner/app:1" imageId="sha256:aaa" />);
    await userEvent.click(trigger());
    await screen.findByRole('menuitem', { name: /Loading source/ });

    // The image id changes while the old inspect is still pending (e.g. node switch).
    rerender(<ImageSourceMenu imageRef="ghcr.io/owner/app:2" imageId="sha256:bbb" />);

    // The stale response now resolves; the request-token guard must discard it.
    // Drain the full response chain (.then -> res.json() -> .then) inside act so a
    // missing guard would have written the OLD label before we assert.
    await act(async () => {
      resolveOld(inspectRes({ 'org.opencontainers.image.source': 'https://github.com/owner/OLD' }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(screen.queryByRole('menuitem', { name: 'Source repository' })).toBeNull();
  });

  it('surfaces a toast when the copy fails', async () => {
    vi.mocked(copyToClipboard).mockRejectedValueOnce(new Error('no clipboard'));
    render(<ImageSourceMenu imageRef="ghcr.io/owner/app:1.2" />);
    await userEvent.click(trigger());
    await userEvent.click(await screen.findByRole('menuitem', { name: /Copy image reference/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Copy failed.'));
  });

  it('still renders deterministic links when the inspect fetch fails', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('boom'));
    render(<ImageSourceMenu imageRef="ghcr.io/owner/app:1.2" imageId="sha256:abc" />);
    await userEvent.click(trigger());
    await screen.findByRole('menuitem', { name: /Open on GitHub Container Registry/ });
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(screen.queryByRole('menuitem', { name: 'Source repository' })).toBeNull();
  });

  it('copies the image reference on the copy action', async () => {
    render(<ImageSourceMenu imageRef="ghcr.io/owner/app:1.2" />);
    await userEvent.click(trigger());
    await userEvent.click(await screen.findByRole('menuitem', { name: /Copy image reference/ }));
    expect(copyToClipboard).toHaveBeenCalledWith('ghcr.io/owner/app:1.2');
  });

  it('shows the host with no Open link for an unknown private registry', async () => {
    render(<ImageSourceMenu imageRef="registry.example.com:5000/team/app:1.2" />);
    await userEvent.click(trigger());
    await screen.findByText(/Registry · registry.example.com:5000/);
    expect(screen.queryByRole('menuitem', { name: /Open on/ })).toBeNull();
  });
});
